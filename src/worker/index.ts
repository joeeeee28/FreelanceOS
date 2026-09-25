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

import { decideSchedule, type ScheduleState } from "@/lib/discovery/scheduler";
import { reconcileDiscoveryRuns } from "@/lib/discovery/runs";
import { db } from "@/lib/db-client";
import { enqueueJob } from "@/lib/jobs/queue";
import { runWorker, type WorkerEvent } from "@/lib/jobs/worker";

const POLL_INTERVAL_MS = 60_000;

function log(message: string): void {
  // Timestamped and plain: this is read in a terminal or a log file, not a UI.
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function describe(event: WorkerEvent): string | null {
  switch (event.kind) {
    case "CLAIMED":
      return `claimed ${event.type} (${event.jobId})`;
    case "COMPLETED":
      return `done ${event.type}: ${event.summary}`;
    case "FAILED":
      return `FAILED ${event.type}: ${event.error}${event.willRetry ? " (will retry)" : ""}`;
    case "IDLE":
      // Logging every idle poll would bury everything else.
      return null;
  }
}

/**
 * Queues a discovery cycle for any workspace that is due one.
 *
 * Per workspace, because each has its own timezone and its own schedule; a
 * single global cron would run everyone's crawl at the owner's midnight.
 */
async function enqueueDueCycles(): Promise<number> {
  const workspaces = await db.workspace.findMany({
    select: { id: true, timezone: true },
  });

  let queued = 0;

  for (const workspace of workspaces) {
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

    const decision = decideSchedule(
      { timezone: workspace.timezone ?? "UTC" },
      state,
    );

    if (decision.action === "WAIT") continue;

    // The idempotency key is the slot, so several workers polling at once
    // cannot queue the same cycle twice.
    const slot = decision.scheduledFor.toISOString().slice(0, 13);

    await enqueueJob({
      workspaceId: workspace.id,
      type: "DISCOVERY_RUN",
      idempotencyKey: `cycle:${slot}`,
      priority: 50,
    });

    log(`queued discovery cycle for workspace ${workspace.id} (${decision.reason})`);
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
async function schedulerTick(): Promise<void> {
  const { settled } = await reconcileDiscoveryRuns();

  if (settled > 0) {
    log(`settled ${settled} finished discovery run(s)`);
  }

  await enqueueDueCycles();
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      // A second Ctrl-C means the operator wants out now.
      log(`${signal} again — exiting immediately`);
      process.exit(1);
    }

    shuttingDown = true;
    log(`${signal} received, finishing the current job then stopping`);
    controller.abort();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log("worker started");

  // Scheduling runs on its own timer so a long queue cannot delay it.
  const scheduler = setInterval(() => {
    void schedulerTick().catch((error: unknown) => {
      log(`scheduler error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, POLL_INTERVAL_MS);

  await schedulerTick().catch(() => undefined);

  const stats = await runWorker({
    signal: controller.signal,
    onEvent: (event) => {
      const message = describe(event);
      if (message !== null) log(message);
    },
  });

  clearInterval(scheduler);

  log(
    `worker stopped: ${stats.claimed} claimed, ${stats.completed} completed, ${stats.failed} failed`,
  );

  await db.$disconnect();
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
