/**
 * The worker loop.
 *
 * Claims jobs, runs them, and renews its lease while it works. Designed so
 * several workers can run against one database without coordinating: all the
 * mutual exclusion lives in the claim statement, which is a single atomic
 * UPDATE, so there is no lock to leak and no leader to elect.
 *
 * It is also designed to be killed. A worker that dies mid-job leaves the job
 * leased; the lease expires and another worker picks it up. That is why every
 * handler must be idempotent — at-least-once delivery is the contract.
 */

import { randomUUID } from "node:crypto";

import type { JobType } from "@prisma/client";

import { serialiseRunCounters } from "@/lib/discovery/run-counters";

import { JOB_HANDLERS } from "./handlers";
import {
  claimNextJob,
  completeJob,
  expireAbandonedJobs,
  failJob,
  heartbeatJob,
  DEFAULT_LEASE_MS,
} from "./queue";
import { JobTimeoutError, runWithDeadline } from "./execution";

export interface WorkerOptions {
  /** Identifies this worker in the lock column. Defaults to a random id. */
  workerId?: string;
  /** Only claim these types. Defaults to all. */
  types?: JobType[];
  leaseMs?: number;
  /** How long to sleep when the queue is empty. */
  idleDelayMs?: number;
  /** Stop after this many jobs. Used by tests and one-shot runs. */
  maxJobs?: number;
  /** Stop when this fires. */
  signal?: AbortSignal;
  /**
   * How long one job may run before it is abandoned and failed.
   *
   * A handler that respects its abort signal stops early; one that does not is
   * left running, and the ownership guard rejects whatever it tries to write
   * afterwards. Either way the job reaches a terminal state, so no lease can
   * hold a job RUNNING indefinitely.
   */
  jobTimeoutMs?: number;
  /** How often an idle worker writes off abandoned final attempts. */
  reapIntervalMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  onEvent?: (event: WorkerEvent) => void;
}

export type WorkerEvent =
  | { kind: "CLAIMED"; jobId: string; type: JobType }
  | { kind: "COMPLETED"; jobId: string; type: JobType; summary: string; durationMs: number }
  | {
      kind: "FAILED";
      jobId: string;
      type: JobType;
      error: string;
      willRetry: boolean;
      durationMs: number;
    }
  /** A write was refused because this worker no longer owns the job. */
  | { kind: "LOST_LEASE"; jobId: string; type: JobType; operation: string }
  /** Abandoned final attempts written off. */
  | { kind: "REAPED"; jobIds: string[] }
  | { kind: "IDLE" };

export interface WorkerStats {
  claimed: number;
  completed: number;
  failed: number;
  /** Jobs this worker stopped being the owner of mid-flight. */
  lostLease: number;
  /** Abandoned jobs written off while this worker ran. */
  reaped: number;
}

export const DEFAULT_IDLE_DELAY_MS = 2_000;

/** Ten minutes is generous for a crawl or a research pass, and still bounded. */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

/** Reaping is a sweep, not a hot path. */
export const DEFAULT_REAP_INTERVAL_MS = 60_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs jobs until stopped.
 *
 * Never throws for a job-level problem: a handler that explodes fails its own
 * job and the loop carries on. The only way out is the abort signal, the job
 * limit, or a database that has gone away entirely.
 */
export async function runWorker(options: WorkerOptions = {}): Promise<WorkerStats> {
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const idleDelayMs = options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());

  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;

  const stats: WorkerStats = { claimed: 0, completed: 0, failed: 0, lostLease: 0, reaped: 0 };

  let lastReapAt = 0;

  /** Writes off final attempts whose worker died. Never throws. */
  const reap = async (): Promise<void> => {
    const started = now().getTime();
    if (started - lastReapAt < reapIntervalMs) return;
    lastReapAt = started;

    try {
      const expired = await expireAbandonedJobs({ now: now() });
      if (expired.length === 0) return;

      stats.reaped += expired.length;
      options.onEvent?.({ kind: "REAPED", jobIds: expired.map((row) => row.id) });
    } catch {
      // Housekeeping only. The next tick tries again.
    }
  };

  while (true) {
    if (options.signal?.aborted === true) break;
    if (options.maxJobs !== undefined && stats.claimed >= options.maxJobs) break;

    await reap();

    let job;
    try {
      job = await claimNextJob(workerId, {
        leaseMs,
        types: options.types,
        now: now(),
      });
    } catch {
      // The database is unreachable. Back off rather than spinning: the
      // alternative is a tight loop that hammers a recovering database.
      await sleep(idleDelayMs);
      continue;
    }

    if (job === null) {
      options.onEvent?.({ kind: "IDLE" });
      if (options.maxJobs !== undefined) break;

      await sleep(idleDelayMs);
      continue;
    }

    stats.claimed += 1;
    options.onEvent?.({ kind: "CLAIMED", jobId: job.id, type: job.type });

    const startedAt = now().getTime();
    const ownership = job.ownership;

    // Renew the lease while the handler works, so a long job is not stolen by
    // another worker mid-flight. Issued against this claim only: if the lease
    // was lost and the job reclaimed, this worker can no longer extend it.
    const heartbeat = setInterval(() => {
      void heartbeatJob(job.id, ownership, leaseMs).catch(() => {
        // A failed heartbeat means the lease is gone. The handler keeps
        // running; idempotency is what makes a double-run safe.
      });
    }, Math.max(1_000, Math.floor(leaseMs / 3)));

    try {
      const handler = JOB_HANDLERS[job.type];

      const outcome = await runWithDeadline(
        (signal) =>
          handler({
            workspaceId: job.workspaceId,
            jobId: job.id,
            payload: job.payload,
            discoveryRunId: job.discoveryRunId,
            signal,
          }),
        {
          timeoutMs: jobTimeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );

      const durationMs = now().getTime() - startedAt;

      if (outcome.kind === "TIMED_OUT") {
        // The handler may still be running and cannot be stopped from here.
        // The job is failed now, and anything that handler later tries to
        // write is refused by the ownership check, so a timed-out attempt can
        // never overwrite the result of the retry that follows it.
        await failJob(job.id, new JobTimeoutError(jobTimeoutMs), {
          ownership,
          category: "TIMEOUT",
        });

        stats.failed += 1;
        options.onEvent?.({
          kind: "FAILED",
          jobId: job.id,
          type: job.type,
          error: `Timed out after ${jobTimeoutMs}ms`,
          willRetry: true,
          durationMs,
        });
        continue;
      }

      const result = outcome.value;

      if (result.ok) {
        const completed = await completeJob(
          job.id,
          {
            summary: result.summary,
            enqueued: result.enqueued ?? 0,
            // The job's own record of what it produced. DiscoveryRun counters
            // are aggregated from these, which is why they are stored on the
            // job rather than incremented onto the run as work happens.
            ...(result.counters === undefined
              ? {}
              : { counters: serialiseRunCounters(result.counters) }),
          },
          new Date(),
          ownership,
        );

        if (completed === null) {
          // Another worker owned this job by the time the handler finished.
          // Its outcome stands; this worker's is discarded.
          stats.lostLease += 1;
          options.onEvent?.({
            kind: "LOST_LEASE",
            jobId: job.id,
            type: job.type,
            operation: "complete",
          });
          continue;
        }

        stats.completed += 1;
        options.onEvent?.({
          kind: "COMPLETED",
          jobId: job.id,
          type: job.type,
          summary: result.summary,
          durationMs,
        });
      } else {
        const outcome2 = await failJob(job.id, result.summary, { ownership });

        if (outcome2 === null) {
          stats.lostLease += 1;
          options.onEvent?.({
            kind: "LOST_LEASE",
            jobId: job.id,
            type: job.type,
            operation: "fail",
          });
          continue;
        }

        stats.failed += 1;
        options.onEvent?.({
          kind: "FAILED",
          jobId: job.id,
          type: job.type,
          error: result.summary,
          willRetry: outcome2.status === "PENDING",
          durationMs,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = now().getTime() - startedAt;

      try {
        const outcome = await failJob(job.id, message, { ownership });

        if (outcome === null) {
          stats.lostLease += 1;
          options.onEvent?.({
            kind: "LOST_LEASE",
            jobId: job.id,
            type: job.type,
            operation: "fail",
          });
          continue;
        }

        options.onEvent?.({
          kind: "FAILED",
          jobId: job.id,
          type: job.type,
          error: message,
          willRetry: outcome.status === "PENDING",
          durationMs,
        });
      } catch {
        // Recording the failure failed too. Nothing more can be done here;
        // the lease will expire and the job will be retried.
      }

      stats.failed += 1;
    } finally {
      clearInterval(heartbeat);
    }
  }

  return stats;
}
