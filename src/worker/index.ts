/**
 * Worker entry point.
 *
 * A separate process from the Next.js app, as the architecture requires: the
 * web process serves the UI and owns the session, and this one does the slow,
 * failure-prone work of crawling and research. Restarting either must not
 * disturb the other.
 *
 * Run with: npm run worker
 */

import {
  decideSchedule,
  discoveryCycleKey,
  type ScheduleState,
} from "@/lib/discovery/scheduler";
import { reconcileDiscoveryRuns } from "@/lib/discovery/runs";
import { db } from "@/lib/db-client";
import { enqueueJob } from "@/lib/jobs/queue";
import { WORKER_HEARTBEAT_INTERVAL_MS, heartbeatMetadata } from "@/lib/jobs/heartbeat";
import { DEFAULT_JOB_TIMEOUT_MS, runWorker, type WorkerEvent } from "@/lib/jobs/worker";

const POLL_INTERVAL_MS = 60_000;

/**
 * How long a shutdown waits for the in-flight job.
 *
 * An operator (or the platform) sending SIGTERM expects the process to stop.
 * The worker finishes the job it is holding if it can, but a crawl that has
 * wedged must not keep the container alive past the platform's own grace
 * period, so the wait is bounded and the lease is left to expire.
 */
const SHUTDOWN_GRACE_MS = 30_000;

const WORKER_ID = process.env.WORKER_ID?.trim() || `worker-${process.pid}`;

/**
 * One structured line per event.
 *
 * Written as `key=value` pairs rather than JSON because these are read in a
 * Render log stream by a human first and a machine second. Nothing sensitive is
 * ever included: no payloads, no page bodies, no credentials, no connection
 * strings. Job and run ids are opaque cuids.
 */
function log(message: string, fields: Record<string, unknown> = {}): void {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`);

  const suffix = parts.length === 0 ? "" : ` ${parts.join(" ")}`;
  process.stdout.write(`[${new Date().toISOString()}] ${message}${suffix}\n`);
}

function describe(event: WorkerEvent): string | null {
  switch (event.kind) {
    case "CLAIMED":
      return `claimed ${event.type}`;
    case "COMPLETED":
      return `done ${event.type}`;
    case "FAILED":
      return `FAILED ${event.type}`;
    case "LOST_LEASE":
      return `lost the lease on ${event.type} before it could record the outcome`;
    case "REAPED":
      return `wrote off ${event.jobIds.length} abandoned job(s)`;
    case "IDLE":
      // Logging every idle poll would bury everything else.
      return null;
  }
}

/** The fields the log line for an event carries. */
function eventFields(event: WorkerEvent): Record<string, unknown> {
  switch (event.kind) {
    case "CLAIMED":
      return { job: event.jobId, type: event.type };
    case "COMPLETED":
      return { job: event.jobId, type: event.type, ms: event.durationMs };
    case "FAILED":
      return {
        job: event.jobId,
        type: event.type,
        retry: event.willRetry,
        ms: event.durationMs,
      };
    case "LOST_LEASE":
      return { job: event.jobId, type: event.type, op: event.operation };
    case "REAPED":
      return { jobs: event.jobIds.join(",") };
    case "IDLE":
      return {};
  }
}

/**
 * Records that this worker is running.
 *
 * Best effort: a failed write means the row goes stale and the automation page
 * stops claiming the worker is alive, which is the honest outcome. It must
 * never stop the worker from doing its job.
 */
async function recordHeartbeat(startedAt: Date): Promise<void> {
  try {
    const metadata = heartbeatMetadata();

    await db.workerHeartbeat.upsert({
      where: { workerId: WORKER_ID },
      create: { workerId: WORKER_ID, startedAt, lastSeenAt: new Date(), metadata },
      update: { lastSeenAt: new Date(), metadata },
    });
  } catch (error) {
    log("could not record worker heartbeat", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** Removes this worker's row. Best effort, and never fatal. */
async function clearHeartbeat(): Promise<void> {
  try {
    await db.workerHeartbeat.deleteMany({ where: { workerId: WORKER_ID } });
  } catch {
    // The row goes stale on its own; nothing to recover from.
  }
}

/**
 * Queues a discovery cycle for any workspace that is due one.
 *
 * Per workspace, because each has its own timezone and its own schedule; a
 * single global cron would run everyone's crawl at the owner's midnight.
 */
async function enqueueDueCycles(): Promise<number> {
  const now = new Date();

  const workspaces = await db.workspace.findMany({
    select: { id: true, timezone: true },
  });

  let queued = 0;

  for (const workspace of workspaces) {
    const timezone = workspace.timezone ?? "UTC";

    const lastRun = await db.discoveryRun.findFirst({
      where: { workspaceId: workspace.id },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, completedAt: true, status: true },
    });

    const state: ScheduleState = {
      lastStartedAt: lastRun?.startedAt ?? null,
      lastCompletedAt: lastRun?.completedAt ?? null,
      running: lastRun?.status === "RUNNING",
    };

    const decision = decideSchedule({ timezone }, state, now);

    if (decision.action === "WAIT") continue;

    // The idempotency key is the workspace's own local slot, so several
    // workers polling at once cannot queue the same cycle twice, two
    // workspaces in different zones cannot collide, and a half-hour offset
    // cannot produce two keys for one slot.
    const key = discoveryCycleKey(workspace.id, timezone, decision, now);

    await enqueueJob({
      workspaceId: workspace.id,
      type: "DISCOVERY_RUN",
      idempotencyKey: key,
      priority: 50,
    });

    log("queued discovery cycle", { key, reason: decision.reason });
    queued += 1;
  }

  return queued;
}

/**
 * One scheduler pass: close finished runs, then queue any cycles that are due.
 *
 * Reconciling first matters. A run whose jobs have all finished is closed here
 * even if the worker that finished the last one died before settling it, and
 * closing it before reading run state below means the decision is made on the
 * run's real status rather than a stale RUNNING row.
 */
let schedulerRunning = false;

async function schedulerTick(): Promise<void> {
  // A tick that overran its interval must not run concurrently with the next
  // one. The idempotency keys would collapse duplicate queue entries anyway,
  // but overlapping ticks would still double the database work and could read
  // run state mid-write. Skipping is the correct behaviour: the next tick is
  // seconds away and the decision is recomputed from the database then.
  if (schedulerRunning) {
    log("scheduler tick skipped: the previous tick is still running");
    return;
  }

  schedulerRunning = true;

  try {
    const { settled } = await reconcileDiscoveryRuns();

    if (settled > 0) {
      log("settled finished discovery runs", { count: settled });
    }

    await enqueueDueCycles();
  } finally {
    schedulerRunning = false;
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let shuttingDown = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;

  const startedAt = new Date();

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      // A second Ctrl-C means the operator wants out now.
      log(`${signal} again — exiting immediately`);
      process.exit(1);
    }

    shuttingDown = true;
    log(`${signal} received, finishing the current job then stopping`, {
      graceMs: SHUTDOWN_GRACE_MS,
    });

    controller.abort();

    // The bounded half of "graceful": if the in-flight job has not finished by
    // now it is not going to, and holding the container open past the
    // platform's own deadline would get it killed anyway — with less warning.
    // Exiting without releasing the lease is safe: it expires on its own and
    // another worker takes the job over.
    shutdownTimer = setTimeout(() => {
      log("shutdown grace expired; exiting with the current job still leased", {
        graceMs: SHUTDOWN_GRACE_MS,
      });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // A worker that dies silently is indistinguishable from one that is idle.
  // Both of these are logged with their stack and exit non-zero so the platform
  // restarts the service rather than leaving automation stopped.
  process.on("uncaughtException", (error) => {
    log(`uncaught exception: ${error.message}`, { stack: error.stack });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    log(`unhandled rejection: ${message}`);
    process.exit(1);
  });

  log("worker started", {
    worker: WORKER_ID,
    node: process.version,
    jobTimeoutMs: DEFAULT_JOB_TIMEOUT_MS,
  });

  // Say we are alive before doing anything else, and keep saying it. This is
  // what the automation page reads; without it an idle worker is invisible.
  await recordHeartbeat(startedAt);

  const heartbeat = setInterval(() => {
    void recordHeartbeat(startedAt);
  }, WORKER_HEARTBEAT_INTERVAL_MS);

  // Scheduling runs on its own timer so a long queue cannot delay it.
  const scheduler = setInterval(() => {
    void schedulerTick().catch((error: unknown) => {
      log("scheduler error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, POLL_INTERVAL_MS);

  await schedulerTick().catch(() => undefined);

  const stats = await runWorker({
    signal: controller.signal,
    onEvent: (event) => {
      const message = describe(event);
      if (message !== null) log(message, eventFields(event));
    },
  });

  clearInterval(scheduler);
  clearInterval(heartbeat);
  if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);

  log("worker stopped", {
    claimed: stats.claimed,
    completed: stats.completed,
    failed: stats.failed,
    lostLease: stats.lostLease,
    reaped: stats.reaped,
  });

  await clearHeartbeat();
  await db.$disconnect();
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
