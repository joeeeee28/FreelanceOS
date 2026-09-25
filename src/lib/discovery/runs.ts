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
}

/**
 * Counts the jobs belonging to a run.
 *
 * One grouped query rather than several counts, so a run with hundreds of jobs
 * is still a single round trip.
 */
async function countRunJobs(
  discoveryRunId: string,
): Promise<DiscoveryRunJobCounts> {
  const grouped: Array<{ status: JobStatusName; _count: { _all: number } }> =
    await db.job.groupBy({
      by: ["status"],
      where: { discoveryRunId },
      _count: { _all: true },
    });

  const counts: DiscoveryRunJobCounts = {
    active: 0,
    total: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const row of grouped) {
    const howMany = row._count?._all ?? 0;
    counts.total += howMany;

    switch (row.status) {
      case "PENDING":
      case "RUNNING":
        counts.active += howMany;
        break;
      case "SUCCEEDED":
        counts.succeeded += howMany;
        break;
      case "FAILED":
        counts.failed += howMany;
        break;
      case "CANCELLED":
        counts.cancelled += howMany;
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
 * Closes a run whose jobs have all finished.
 *
 * A no-op while any job is still PENDING or RUNNING, and a no-op on a run that
 * has already ended. Returns null only when the run does not exist.
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

  const counts = await countRunJobs(discoveryRunId);

  const base = {
    discoveryRunId,
    activeChildren: counts.active,
    children: counts.total,
  };

  // Already ended: the row is history and is left exactly as it is.
  if (run.status !== "RUNNING") {
    return { ...base, status: run.status, settled: false };
  }

  // Work is still in flight. The next job to finish, or the reconciler, tries
  // again; until then the run correctly reads as RUNNING.
  if (counts.active > 0) {
    return { ...base, status: "RUNNING", settled: false };
  }

  const outcome = terminalStatusFor(counts);

  // The single decision point. `status: "RUNNING"` in the WHERE clause is what
  // makes this safe under concurrency: exactly one caller can move a run out of
  // RUNNING, so two workers finishing the last two jobs cannot both write.
  const { count } = await db.discoveryRun.updateMany({
    where: { id: discoveryRunId, status: "RUNNING" },
    data: {
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
