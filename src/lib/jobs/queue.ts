/**
 * Note: this module intentionally carries no `server-only` marker.
 *
 * It is loaded by the standalone worker process as well as by the Next.js
 * app, and `server-only` throws anywhere outside a React Server Component
 * graph. The protection is not lost — this module reaches the browser only
 * via an import from a client component, which would fail to bundle Prisma
 * regardless. Application UI code must still import `@/lib/db`, which keeps
 * the guard.
 */

import { Prisma } from "@prisma/client";
import type { JobStatus, JobType } from "@prisma/client";

import { db } from "@/lib/db-client";
import { settleDiscoveryRun } from "@/lib/discovery/runs";
import { failureRecord, type JobErrorCategory } from "./execution";

/**
 * Postgres-backed job queue.
 *
 * Deliberately built on the database we already have rather than Redis or a
 * hosted queue: it costs nothing, it is transactional with the data the jobs
 * operate on, and it survives a restart.
 *
 * Correctness under concurrency comes from a single atomic claim statement
 * using `FOR UPDATE SKIP LOCKED`, which is the standard Postgres pattern for
 * this. Two workers racing for the same job cannot both win, because the row
 * lock is taken inside the same statement that marks the job RUNNING.
 *
 * Crashed workers are handled by leases rather than heartbeats: a claim sets
 * `lockedUntil`, and an expired lease makes the job claimable again, so a
 * worker that dies mid-job does not strand it.
 *
 * A lease alone is not enough, though, because the worker that lost it may
 * still be running. Every claim therefore produces an *ownership token* — the
 * worker id plus the attempt number that claim wrote. `attempts` increments on
 * every claim, so the pair identifies one claim uniquely. Completion, failure
 * and heartbeat all match against it, which is what stops a stalled worker from
 * overwriting the result of the worker that took the job over.
 */

/** How long a worker may hold a job before its lease expires. */
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

/**
 * How long after its lease expires a job on its final attempt is written off.
 *
 * The grace exists because a lease can expire on a worker that is still alive
 * and working — a database blip during a heartbeat, a suspended container. The
 * job is only declared FAILED once that window has passed as well, and until
 * then the worker that no longer holds a valid lease cannot write to the row.
 */
export const ABANDONED_LEASE_GRACE_MS = 5 * 60 * 1000;

/** Backoff schedule between attempts. */
export const BASE_RETRY_DELAY_MS = 30_000;
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

/**
 * Exponential backoff with a cap.
 *
 * Deterministic and pure so it can be asserted exactly; jitter is applied by
 * the caller if needed.
 */
export function retryDelayMs(attempt: number): number {
  if (attempt <= 0) return BASE_RETRY_DELAY_MS;
  const delay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

export interface EnqueueOptions {
  workspaceId: string;
  type: JobType;
  payload?: Prisma.InputJsonValue;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
  /**
   * Prevents duplicate work. Enqueuing the same key twice returns the existing
   * job instead of creating a second one.
   */
  idempotencyKey?: string;
  discoveryRunId?: string;
}

/**
 * Proof of one worker's claim on one job.
 *
 * Returned by every successful claim and required by every ownership-sensitive
 * transition. `attempt` is the attempt number produced by that claim; because
 * it increments on each claim, a token from a superseded claim can never match
 * the row, so a stale worker's write is rejected instead of applied.
 */
export interface JobOwnership {
  workerId: string;
  attempt: number;
}

export interface ClaimedJob {
  id: string;
  workspaceId: string;
  type: JobType;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
  discoveryRunId: string | null;
  /** Present on every claim. Pass it back to complete, fail or heartbeat. */
  ownership: JobOwnership;
}

/**
 * Adds a job, or returns the existing one when an idempotency key collides.
 *
 * The uniqueness guarantee is the database index, not a prior read, so two
 * workers enqueuing simultaneously still produce one job.
 */
export async function enqueueJob(options: EnqueueOptions) {
  const {
    workspaceId,
    type,
    payload,
    priority = 100,
    runAfter,
    maxAttempts = 3,
    idempotencyKey,
    discoveryRunId,
  } = options;

  const data = {
    workspaceId,
    type,
    payload: payload ?? undefined,
    priority,
    runAfter: runAfter ?? new Date(),
    maxAttempts,
    idempotencyKey: idempotencyKey ?? null,
    discoveryRunId: discoveryRunId ?? null,
  };

  if (idempotencyKey === undefined) {
    return db.job.create({ data });
  }

  // upsert on the unique (workspaceId, idempotencyKey) index: concurrent
  // callers converge on one row rather than racing.
  return db.job.upsert({
    where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    create: data,
    update: {},
  });
}

/**
 * Atomically claims the next runnable job.
 *
 * A job is runnable when it is PENDING and due, or when it is RUNNING but its
 * lease has expired (the worker holding it died). Ordering is by priority then
 * age, so urgent work overtakes a long backlog but nothing starves.
 *
 * Raw SQL is used because `FOR UPDATE SKIP LOCKED` has no Prisma equivalent,
 * and the claim must be one statement to be safe.
 */
export async function claimNextJob(
  workerId: string,
  options: { leaseMs?: number; types?: JobType[]; now?: Date } = {},
): Promise<ClaimedJob | null> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? new Date();
  const lockedUntil = new Date(now.getTime() + leaseMs);

  const typeFilter =
    options.types && options.types.length > 0
      ? Prisma.sql`AND "type"::text = ANY(${options.types.map(String)}::text[])`
      : Prisma.empty;

  const rows = await db.$queryRaw<
    Array<{
      id: string;
      workspaceId: string;
      type: JobType;
      payload: Prisma.JsonValue;
      attempts: number;
      maxAttempts: number;
      discoveryRunId: string | null;
    }>
  >(Prisma.sql`
    WITH next_job AS (
      SELECT "id"
      FROM "Job"
      WHERE (
              ("status" = 'PENDING' AND "runAfter" <= ${now})
              OR ("status" = 'RUNNING' AND "lockedUntil" IS NOT NULL AND "lockedUntil" < ${now})
            )
        AND "attempts" < "maxAttempts"
        ${typeFilter}
      ORDER BY "priority" ASC, "runAfter" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "Job" j
    SET "status"      = 'RUNNING',
        "lockedBy"    = ${workerId},
        "lockedUntil" = ${lockedUntil},
        "startedAt"   = COALESCE(j."startedAt", ${now}),
        "attempts"    = j."attempts" + 1,
        "updatedAt"   = ${now}
    FROM next_job
    WHERE j."id" = next_job."id"
    RETURNING j."id",
              j."workspaceId"    AS "workspaceId",
              j."type",
              j."payload",
              j."attempts",
              j."maxAttempts"    AS "maxAttempts",
              j."discoveryRunId" AS "discoveryRunId"
  `);

  const row = rows[0];
  if (row === undefined) return null;

  // The attempt number this claim just wrote is the lease version: no other
  // claim can produce the same pair, so it is what later transitions verify.
  return { ...row, ownership: { workerId, attempt: row.attempts } };
}

/**
 * The `where` clause that identifies a job still owned by one claim.
 *
 * Shared by every ownership-sensitive write so the rule cannot drift between
 * them: the row must still be RUNNING, still be locked by that worker, and
 * still be on the attempt that worker claimed.
 */
function ownedBy(jobId: string, ownership: JobOwnership) {
  return {
    id: jobId,
    status: "RUNNING" as const,
    lockedBy: ownership.workerId,
    attempts: ownership.attempt,
  };
}

/**
 * Marks a claimed job finished.
 *
 * Two call styles, deliberately:
 *
 *   - `completeJob(id, result, now, ownership)` is what the worker uses. It is
 *     a guarded UPDATE: if the claim has been superseded — the lease expired,
 *     another worker took the job over — the write matches no row, the job is
 *     returned as `null`, and the other worker's result stands.
 *   - `completeJob(id, result, now)` without a token is the unconditional form,
 *     used by tests and by admin tooling. It still refuses to move a job that
 *     has already reached a terminal state, so no path can produce two
 *     contradictory outcomes for one job.
 *
 * Returns the updated row, or `null` when the transition was refused.
 */
export async function completeJob(
  jobId: string,
  result?: Prisma.InputJsonValue,
  now: Date = new Date(),
  ownership?: JobOwnership,
) {
  const data: Prisma.JobUpdateManyMutationInput = {
    status: "SUCCEEDED",
    ...(result === undefined ? {} : { result }),
    completedAt: now,
    lockedBy: null,
    lockedUntil: null,
    error: null,
  };

  const where =
    ownership === undefined
      ? { id: jobId, status: { notIn: ["SUCCEEDED", "FAILED", "CANCELLED"] as JobStatus[] } }
      : ownedBy(jobId, ownership);

  const { count } = await db.job.updateMany({ where, data });

  if (count === 0) return null;

  const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });

  await settleOwningRun(job.discoveryRunId, now);

  return job;
}

/**
 * Best-effort close of the run this job belongs to.
 *
 * Called only once a job has actually reached a terminal status. The job's own
 * outcome is already committed by then, so a failure here is logged rather than
 * thrown: it must not turn a finished job into a failed one, or make the queue
 * re-report work that was completed. `reconcileDiscoveryRuns()` on the worker's
 * scheduler tick is the backstop that closes anything missed.
 */
async function settleOwningRun(
  discoveryRunId: string | null,
  now: Date,
): Promise<void> {
  if (discoveryRunId === null) return;

  try {
    await settleDiscoveryRun(discoveryRunId, now);
  } catch (error) {
    console.error(
      `[jobs] could not settle discovery run ${discoveryRunId}: ` +
        `${error instanceof Error ? error.message : String(error)} ` +
        "(the run is reconciled on the next scheduler tick)",
    );
  }
}

/**
 * Records a failure, scheduling a retry if attempts remain.
 *
 * The message is stored twice: as bounded plain text in `error` (which the UI
 * shows and which has always been the field operators read) and as a small
 * structured record in `result.error` carrying the category, the attempt and
 * the time, so a failure can be grouped and filtered without parsing prose.
 * Neither ever contains a credential, and crawler-derived text is capped.
 *
 * With an ownership token the write is refused when the claim has been
 * superseded, exactly as completion is. Returns the updated row, or `null`.
 */
export async function failJob(
  jobId: string,
  error: unknown,
  options: {
    retryable?: boolean;
    now?: Date;
    ownership?: JobOwnership;
    /** Overrides the classification, for failures whose cause is known here. */
    category?: JobErrorCategory;
  } = {},
) {
  const now = options.now ?? new Date();
  const retryable = options.retryable ?? true;
  const ownership = options.ownership;

  const message = (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 1000);

  const job = await db.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { attempts: true, maxAttempts: true, discoveryRunId: true, status: true },
  });

  if (!retryable && ownership !== undefined && job.status !== "RUNNING") {
    // Terminal already: nothing to record, and nothing to overwrite.
    return null;
  }

  const record = failureRecord(error, {
    attempt: job.attempts,
    now,
    ...(options.category === undefined ? {} : { category: options.category }),
  });

  const exhausted = !retryable || job.attempts >= job.maxAttempts;

  if (exhausted) {
    const { count } = await db.job.updateMany({
      where: ownership === undefined ? { id: jobId } : ownedBy(jobId, ownership),
      data: {
        status: "FAILED",
        error: message,
        result: { error: record } as unknown as Prisma.InputJsonValue,
        completedAt: now,
        lockedBy: null,
        lockedUntil: null,
      },
    });

    if (count === 0) return null;

    // Terminal: this may have been the last job the run was waiting for.
    await settleOwningRun(job.discoveryRunId, now);

    return db.job.findUniqueOrThrow({ where: { id: jobId } });
  }

  // Still retryable, so the job is not terminal and the run is not settled.
  const { count } = await db.job.updateMany({
    where: ownership === undefined ? { id: jobId } : ownedBy(jobId, ownership),
    data: {
      status: "PENDING",
      error: message,
      result: { error: record } as unknown as Prisma.InputJsonValue,
      runAfter: new Date(now.getTime() + retryDelayMs(job.attempts)),
      lockedBy: null,
      lockedUntil: null,
    },
  });

  if (count === 0) return null;

  return db.job.findUniqueOrThrow({ where: { id: jobId } });
}

/**
 * Extends the lease of a long-running job so it is not reclaimed.
 *
 * `holder` is either the worker id (extend whatever that worker currently
 * holds) or the full ownership token (extend only if this exact claim is still
 * the current one). The worker passes the token, so a superseded claim cannot
 * keep a lease alive that it no longer owns.
 */
export async function heartbeatJob(
  jobId: string,
  holder: string | JobOwnership,
  leaseMs: number = DEFAULT_LEASE_MS,
  now: Date = new Date(),
) {
  const where =
    typeof holder === "string"
      ? { id: jobId, lockedBy: holder, status: "RUNNING" as const }
      : ownedBy(jobId, holder);

  const { count } = await db.job.updateMany({
    where,
    data: { lockedUntil: new Date(now.getTime() + leaseMs) },
  });

  return count === 1;
}

/** Manual control: cancels a job that has not finished. */
/** Cancels a job that has not finished. See `retryJob` for `workspaceId`. */
export async function cancelJob(
  jobId: string,
  options: { now?: Date; workspaceId?: string } = {},
) {
  const now = options.now ?? new Date();

  const existing = await db.job.findFirst({
    where: {
      id: jobId,
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    },
    select: { discoveryRunId: true },
  });

  const { count } = await db.job.updateMany({
    where: {
      id: jobId,
      status: { in: ["PENDING", "RUNNING"] },
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    },
    data: {
      status: "CANCELLED",
      completedAt: now,
      lockedBy: null,
      lockedUntil: null,
    },
  });

  // Cancelling is terminal for the job, so the run may now be able to close.
  if (count === 1) {
    await settleOwningRun(existing?.discoveryRunId ?? null, now);
  }

  return count === 1;
}

/**
 * Manual control: requeues a failed job.
 *
 * Attempts are reset so "Retry failed" behaves the way an operator expects
 * rather than immediately re-failing on an exhausted counter.
 */
/**
 * Puts a failed job back on the queue.
 *
 * `workspaceId` is optional because the worker has no tenant context, but a
 * caller serving a request should always pass it: the guard then lives in the
 * same statement as the write, so a job id that belongs to somebody else
 * cannot be requeued even if the caller's own check were bypassed.
 */
export async function retryJob(
  jobId: string,
  options: { now?: Date; workspaceId?: string } = {},
) {
  const now = options.now ?? new Date();

  const { count } = await db.job.updateMany({
    where: {
      id: jobId,
      status: "FAILED",
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    },
    data: {
      status: "PENDING",
      attempts: 0,
      error: null,
      runAfter: now,
      completedAt: null,
      lockedBy: null,
      lockedUntil: null,
    },
  });

  return count === 1;
}

/**
 * Fails jobs whose final attempt was abandoned by a dead worker.
 *
 * A job is reclaimed on its next claim while attempts remain, but the *last*
 * attempt has no next claim: without this it would sit RUNNING forever, holding
 * its discovery run open. It is written off only once both the lease and the
 * grace period have passed, because a lease can expire on a worker that is
 * still alive.
 *
 * Bounded and idempotent: one statement, ordered oldest-lease-first, and a
 * second call finds nothing left to do.
 */
export async function expireAbandonedJobs(
  options: { now?: Date; graceMs?: number; limit?: number } = {},
): Promise<Array<{ id: string; discoveryRunId: string | null }>> {
  const now = options.now ?? new Date();
  const graceMs = options.graceMs ?? ABANDONED_LEASE_GRACE_MS;
  const limit = Math.max(1, options.limit ?? 50);
  const cutoff = new Date(now.getTime() - graceMs);

  const rows = await db.$queryRaw<Array<{ id: string; discoveryRunId: string | null }>>(
    Prisma.sql`
      UPDATE "Job"
      SET "status"      = 'FAILED',
          "error"       = 'Abandoned: the worker holding the final attempt stopped renewing its lease',
          "result"      = jsonb_build_object(
                            'error',
                            jsonb_build_object(
                              'category', 'ABANDONED',
                              'message', 'The worker holding the final attempt stopped renewing its lease',
                              'attempt', "maxAttempts",
                              'at', ${now.toISOString()}::text
                            )
                          ),
          "completedAt" = ${now},
          "lockedBy"    = NULL,
          "lockedUntil" = NULL,
          "updatedAt"   = ${now}
      WHERE "id" IN (
        SELECT "id"
        FROM "Job"
        WHERE "status" = 'RUNNING'
          AND "attempts" >= "maxAttempts"
          AND ("lockedUntil" < ${cutoff} OR ("lockedUntil" IS NULL AND "updatedAt" < ${cutoff}))
        ORDER BY "lockedUntil" ASC NULLS FIRST
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "discoveryRunId"
    `,
  );

  // Each one may have been the last job its run was waiting for.
  for (const runId of new Set(
    (rows as Array<{ id: string; discoveryRunId: string | null }>).map(
      (row) => row.discoveryRunId,
    ),
  )) {
    if (runId !== null) await settleOwningRun(runId, now);
  }

  return rows;
}

/** Queue depth by status, for the operations dashboard. */
export async function queueStats(
  workspaceId: string,
): Promise<Record<JobStatus, number>> {
  const grouped = await db.job.groupBy({
    by: ["status"],
    where: { workspaceId },
    _count: { _all: true },
  });

  const stats: Record<JobStatus, number> = {
    PENDING: 0,
    RUNNING: 0,
    SUCCEEDED: 0,
    FAILED: 0,
    CANCELLED: 0,
  };

  for (const row of grouped) {
    stats[row.status] = row._count._all;
  }

  return stats;
}
