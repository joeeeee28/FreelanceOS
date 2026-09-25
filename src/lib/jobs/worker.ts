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
  failJob,
  heartbeatJob,
  DEFAULT_LEASE_MS,
} from "./queue";

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
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  onEvent?: (event: WorkerEvent) => void;
}

export type WorkerEvent =
  | { kind: "CLAIMED"; jobId: string; type: JobType }
  | { kind: "COMPLETED"; jobId: string; type: JobType; summary: string }
  | { kind: "FAILED"; jobId: string; type: JobType; error: string; willRetry: boolean }
  | { kind: "IDLE" };

export interface WorkerStats {
  claimed: number;
  completed: number;
  failed: number;
}

export const DEFAULT_IDLE_DELAY_MS = 2_000;

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

  const stats: WorkerStats = { claimed: 0, completed: 0, failed: 0 };

  while (true) {
    if (options.signal?.aborted === true) break;
    if (options.maxJobs !== undefined && stats.claimed >= options.maxJobs) break;

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

    // Renew the lease while the handler works, so a long job is not stolen
    // by another worker mid-flight.
    const heartbeat = setInterval(() => {
      void heartbeatJob(job.id, workerId, leaseMs).catch(() => {
        // A failed heartbeat means the lease is gone. The handler keeps
        // running; idempotency is what makes a double-run safe.
      });
    }, Math.max(1_000, Math.floor(leaseMs / 3)));

    try {
      const handler = JOB_HANDLERS[job.type];
      const result = await handler({
        workspaceId: job.workspaceId,
        jobId: job.id,
        payload: job.payload,
        discoveryRunId: job.discoveryRunId,
        signal: options.signal,
      });

      if (result.ok) {
        await completeJob(job.id, {
          summary: result.summary,
          enqueued: result.enqueued ?? 0,
          // The job's own record of what it produced. DiscoveryRun counters
          // are aggregated from these, which is why they are stored on the
          // job rather than incremented onto the run as work happens.
          ...(result.counters === undefined
            ? {}
            : { counters: serialiseRunCounters(result.counters) }),
        });
        stats.completed += 1;
        options.onEvent?.({
          kind: "COMPLETED",
          jobId: job.id,
          type: job.type,
          summary: result.summary,
        });
      } else {
        const outcome = await failJob(job.id, result.summary);
        stats.failed += 1;
        options.onEvent?.({
          kind: "FAILED",
          jobId: job.id,
          type: job.type,
          error: result.summary,
          willRetry: outcome?.status === "PENDING",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      try {
        const outcome = await failJob(job.id, message);
        options.onEvent?.({
          kind: "FAILED",
          jobId: job.id,
          type: job.type,
          error: message,
          willRetry: outcome?.status === "PENDING",
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
