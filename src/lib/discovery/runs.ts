/**
 * DiscoveryRun lifecycle.
 *
 * A run is not finished when its fan-out finishes. The `DISCOVERY_RUN` job
 * only queues work: the run is finished when every job that belongs to it —
 * the fan-out job itself, the per-source crawls it queued, and the signal and
 * CRM jobs those queued in turn — has reached a terminal state (`SUCCEEDED`,
 * `FAILED` or `CANCELLED`).
 *
 * Two mechanisms enforce that, deliberately:
 *
 *   1. `settleDiscoveryRun()` is called by the queue whenever a job reaches a
 *      terminal state. That is the normal path, and it closes the run in the
 *      same pass that finished the last job belonging to it.
 *   2. `reconcileDiscoveryRuns()` runs on the worker's scheduler tick. It is
 *      the backstop for the case where a worker died between marking its job
 *      finished and settling the run — without it, that run would stay RUNNING
 *      until the six-hour stale-run rule fired and the scheduler started
 *      queueing cycles it should not have.
 *
 * Both are idempotent and race-safe. The decision is a single guarded UPDATE
 * that only transitions a run which is still `RUNNING`, so two workers
 * finishing the last two jobs at the same moment cannot both write and cannot
 * corrupt the run. A run that has already ended is never rewritten: when it
 * ran, and how it ended, is history.
 */

import { db } from "@/lib/db-client";
import { totalRunCounters, type RunCounterTotals } from "./run-counters";

/** Mirror of the Prisma `JobStatus` enum, used for counting without importing it. */
type JobStatusName = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

/** Mirror of the Prisma `RunStatus` enum. */
export type DiscoveryRunStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

/** How a finished run is recorded. Never `RUNNING`. */
export type DiscoveryRunOutcome = Exclude<DiscoveryRunStatus, "RUNNING">;

/** What a run's jobs currently look like. */
export interface DiscoveryRunJobCounts {
  /** Jobs still PENDING or RUNNING: the run is not finished while this is > 0. */
  active: number;
  /** Every job belonging to the run, whatever its status. */
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface DiscoveryRunSettlement {
  discoveryRunId: string;
  /** The run's status after this call. */
  status: DiscoveryRunStatus;
  /** True when this call was the one that wrote the terminal status. */
  settled: boolean;
  /** Jobs still PENDING or RUNNING. */
  activeChildren: number;
  /** Every job belonging to the run, whatever its status. */
  children: number;
  /**
   * What the run's jobs actually produced, aggregated from their structured
   * results. Reported whether or not this call wrote them.
   */
  counters: RunCounterTotals;
}

/**
 * The run's jobs, read once.
 *
 * One query serves both purposes: how many jobs are still outstanding, and
 * what the finished ones produced. Reading them together also means the
 * status and the tally can never disagree about which jobs they saw.
 */
async function readRunJobs(discoveryRunId: string): Promise<
  Array<{ status: JobStatusName; result: unknown }>
> {
  return db.job.findMany({
    where: { discoveryRunId },
    select: { status: true, result: true },
  });
}

function countJobs(rows: readonly { status: JobStatusName }[]): DiscoveryRunJobCounts {
  const counts: DiscoveryRunJobCounts = {
    active: 0,
    total: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const row of rows) {
    counts.total += 1;

    switch (row.status) {
      case "PENDING":
      case "RUNNING":
        counts.active += 1;
        break;
      case "SUCCEEDED":
        counts.succeeded += 1;
        break;
      case "FAILED":
        counts.failed += 1;
        break;
      case "CANCELLED":
        counts.cancelled += 1;
        break;
    }
  }

  return counts;
}

/**
 * How a settled run is recorded.
 *
 * A run with at least one successful job did its work; individual failures stay
 * in their own `Job` rows and are never rewritten. A run where nothing
 * succeeded is `FAILED`, not `COMPLETED` — a run that only failed must not read
 * as success. A run whose jobs were all cancelled is `CANCELLED`. A run with no
 * jobs at all (nothing was due) is `COMPLETED`: there was nothing to do, which
 * is not the same as something going wrong.
 */
export function terminalStatusFor(
  counts: DiscoveryRunJobCounts,
): DiscoveryRunOutcome {
  if (counts.succeeded > 0) return "COMPLETED";
  if (counts.failed > 0) return "FAILED";
  if (counts.cancelled > 0) return "CANCELLED";
  return "COMPLETED";
}

/**
 * Settles a run: records what its jobs produced, and closes it when they are
 * all finished.
 *
 * Counters are refreshed while the run is still going — a cycle that takes a
 * while should report progress rather than showing zeroes until it ends — and
 * they are written again, with the terminal status, by whichever caller
 * finishes the run.
 *
 * A no-op on a run that has already ended: its numbers, like its status, are
 * the record of what happened and are never rewritten. Returns null only when
 * the run does not exist.
 */
export async function settleDiscoveryRun(
  discoveryRunId: string,
  now: Date = new Date(),
): Promise<DiscoveryRunSettlement | null> {
  const run: { status: DiscoveryRunStatus } | null =
    await db.discoveryRun.findUnique({
      where: { id: discoveryRunId },
      select: { status: true },
    });

  if (run === null) return null;

  const jobs = await readRunJobs(discoveryRunId);
  const counts = countJobs(jobs);
  const counters = totalRunCounters(jobs);

  const base = {
    discoveryRunId,
    counters,
    activeChildren: counts.active,
    children: counts.total,
  };

  // Already ended: the row is history and is left exactly as it is.
  if (run.status !== "RUNNING") {
    return { ...base, status: run.status, settled: false };
  }

  // Work is still in flight. The next job to finish, or the reconciler, tries
  // again; until then the run correctly reads as RUNNING. The counters are
  // still refreshed, so an in-progress run reports the work done so far.
  if (counts.active > 0) {
    await db.discoveryRun.updateMany({
      where: { id: discoveryRunId, status: "RUNNING" },
      data: counters,
    });

    return { ...base, status: "RUNNING", settled: false };
  }

  const outcome = terminalStatusFor(counts);

  // The single decision point. `status: "RUNNING"` in the WHERE clause is what
  // makes this safe under concurrency: exactly one caller can move a run out of
  // RUNNING, so two workers finishing the last two jobs cannot both write.
  const { count } = await db.discoveryRun.updateMany({
    where: { id: discoveryRunId, status: "RUNNING" },
    data: {
      // The run's own record of what it produced, from its own jobs.
      ...counters,
      status: outcome,
      completedAt: now,
      // Failures are recorded, not swallowed: the run says why it failed, and
      // each Job row keeps its own error text.
      ...(outcome === "FAILED"
        ? {
            error:
              `No job in this run succeeded (${counts.failed} failed, ` +
              `${counts.cancelled} cancelled). Individual job records keep ` +
              "their own errors.",
          }
        : {}),
    },
  });

  if (count === 1) {
    return { ...base, status: outcome, settled: true };
  }

  // Someone else closed it first. Report what the row actually says.
  const after: { status: DiscoveryRunStatus } | null =
    await db.discoveryRun.findUnique({
      where: { id: discoveryRunId },
      select: { status: true },
    });

  return { ...base, status: after?.status ?? outcome, settled: false };
}

/** How many unfinished runs one reconciliation pass looks at. */
export const RECONCILE_BATCH_SIZE = 25;

/**
 * Backstop for the terminal-transition hook.
 *
 * Closes any run whose jobs have all finished but which is still marked
 * RUNNING, for example because a worker died between finishing the last job and
 * settling the run. Oldest first and bounded, so a tick can never become an
 * unbounded scan of the run history.
 */
export async function reconcileDiscoveryRuns(
  options: { limit?: number; now?: Date } = {},
): Promise<{ examined: number; settled: number }> {
  const limit = options.limit ?? RECONCILE_BATCH_SIZE;
  const now = options.now ?? new Date();

  const candidates: Array<{ id: string }> = await db.discoveryRun.findMany({
    where: { status: "RUNNING" },
    orderBy: { startedAt: "asc" },
    take: limit,
    select: { id: true },
  });

  let settled = 0;

  for (const candidate of candidates) {
    const result = await settleDiscoveryRun(candidate.id, now);
    if (result?.settled === true) settled += 1;
  }

  return { examined: candidates.length, settled };
}
