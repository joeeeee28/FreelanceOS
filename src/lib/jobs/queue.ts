import "server-only";

import { Prisma } from "@prisma/client";
import type { JobStatus, JobType } from "@prisma/client";

import { db } from "@/lib/db";

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
 */

/** How long a worker may hold a job before its lease expires. */
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

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

export interface ClaimedJob {
  id: string;
  workspaceId: string;
  type: JobType;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
  discoveryRunId: string | null;
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

  return rows[0] ?? null;
}

/** Marks a claimed job finished. */
export async function completeJob(
  jobId: string,
  result?: Prisma.InputJsonValue,
  now: Date = new Date(),
) {
  return db.job.update({
    where: { id: jobId },
    data: {
      status: "SUCCEEDED",
      result: result ?? undefined,
      completedAt: now,
      lockedBy: null,
      lockedUntil: null,
      error: null,
    },
  });
}

/**
 * Records a failure, scheduling a retry if attempts remain.
 *
 * The error message is truncated and stored as plain text: it is shown in the
 * UI, and crawler-derived messages are untrusted.
 */
export async function failJob(
  jobId: string,
  error: unknown,
  options: { retryable?: boolean; now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const retryable = options.retryable ?? true;

  const message = (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 1000);

  const job = await db.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { attempts: true, maxAttempts: true },
  });

  const exhausted = !retryable || job.attempts >= job.maxAttempts;

  if (exhausted) {
    return db.job.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        error: message,
        completedAt: now,
        lockedBy: null,
        lockedUntil: null,
      },
    });
  }

  return db.job.update({
    where: { id: jobId },
    data: {
      status: "PENDING",
      error: message,
      runAfter: new Date(now.getTime() + retryDelayMs(job.attempts)),
      lockedBy: null,
      lockedUntil: null,
    },
  });
}

/** Extends the lease of a long-running job so it is not reclaimed. */
export async function heartbeatJob(
  jobId: string,
  workerId: string,
  leaseMs: number = DEFAULT_LEASE_MS,
  now: Date = new Date(),
) {
  const { count } = await db.job.updateMany({
    // Scoped to the holder, so a worker cannot extend someone else's lease.
    where: { id: jobId, lockedBy: workerId, status: "RUNNING" },
    data: { lockedUntil: new Date(now.getTime() + leaseMs) },
  });

  return count === 1;
}

/** Manual control: cancels a job that has not finished. */
export async function cancelJob(jobId: string, now: Date = new Date()) {
  const { count } = await db.job.updateMany({
    where: { id: jobId, status: { in: ["PENDING", "RUNNING"] } },
    data: {
      status: "CANCELLED",
      completedAt: now,
      lockedBy: null,
      lockedUntil: null,
    },
  });

  return count === 1;
}

/**
 * Manual control: requeues a failed job.
 *
 * Attempts are reset so "Retry failed" behaves the way an operator expects
 * rather than immediately re-failing on an exhausted counter.
 */
export async function retryJob(jobId: string, now: Date = new Date()) {
  const { count } = await db.job.updateMany({
    where: { id: jobId, status: "FAILED" },
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
