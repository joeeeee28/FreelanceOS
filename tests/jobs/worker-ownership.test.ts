/**
 * Job reliability and stale-worker ownership.
 *
 * The race these cover is the one a lease alone cannot prevent:
 *
 *   Worker A claims Job X
 *   → A stalls (paused container, blocked event loop, dropped connection)
 *   → X's lease expires
 *   → Worker B claims X and finishes it
 *   → A wakes up and reports its own outcome
 *
 * Without an ownership check A's write lands, and the job ends up describing
 * work that was thrown away — or worse, a DiscoveryRun's counters count a
 * result that was superseded. Every ownership-sensitive transition therefore
 * verifies the claim it belongs to: the worker id *and* the attempt number that
 * claim wrote, since `attempts` increments on every claim.
 *
 * Everything here runs against the disposable PostgreSQL queue, so the
 * guarantees are tested where they are actually enforced: in the UPDATE's WHERE
 * clause, not in a mock.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";

const {
  ABANDONED_LEASE_GRACE_MS,
  cancelJob,
  claimNextJob,
  completeJob,
  enqueueJob,
  expireAbandonedJobs,
  failJob,
  heartbeatJob,
  retryJob,
} = await import("@/lib/jobs/queue");
const { runWorker } = await import("@/lib/jobs/worker");
const { JOB_HANDLERS } = await import("@/lib/jobs/handlers");

let alice: SeededWorkspace;

beforeAll(async () => {
  await resetTestDatabase();
}, 120_000);

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("Alice");
});

afterAll(async () => {
  await disconnectTestPrisma();
});

function enqueue(
  // Taken from the queue module rather than restated, so the helper cannot
  // drift from the types the queue accepts.
  type: Parameters<typeof enqueueJob>[0]["type"] = "CRAWL_SOURCE",
  payload: Record<string, unknown> = {},
) {
  return enqueueJob({ workspaceId: alice.workspaceId, type, payload });
}

async function row(jobId: string) {
  return db.job.findUniqueOrThrow({ where: { id: jobId } });
}

const noSleep = async () => {};

describe("the stale worker race", () => {
  it("refuses a completion from a worker that lost the lease", async () => {
    const job = await enqueue();

    // A claims it, then stalls. The lease is short so it expires immediately.
    const a = await claimNextJob("worker-a", { leaseMs: -1_000 });
    expect(a?.ownership).toEqual({ workerId: "worker-a", attempt: 1 });

    // B takes the job over and finishes it. Its result is the real one.
    const b = await claimNextJob("worker-b");
    expect(b?.id).toBe(job.id);
    expect(b?.ownership).toEqual({ workerId: "worker-b", attempt: 2 });

    const completed = await completeJob(
      job.id,
      { summary: "worker B", enqueued: 0 },
      new Date(),
      b!.ownership,
    );
    expect(completed?.status).toBe("SUCCEEDED");

    // A wakes up and reports its own outcome. It must be rejected.
    const stale = await completeJob(
      job.id,
      { summary: "worker A", enqueued: 0 },
      new Date(),
      a!.ownership,
    );
    expect(stale).toBeNull();

    const after = await row(job.id);
    expect(after.status).toBe("SUCCEEDED");
    expect((after.result as { summary: string }).summary).toBe("worker B");
    expect(after.lockedBy).toBeNull();
  });

  it("refuses a failure from a worker that lost the lease", async () => {
    const job = await enqueue();

    const a = await claimNextJob("worker-a", { leaseMs: -1_000 });
    const b = await claimNextJob("worker-b");

    await completeJob(job.id, { summary: "worker B", enqueued: 0 }, new Date(), b!.ownership);

    // A's failure would otherwise turn a successful job into a retry.
    const stale = await failJob(job.id, new Error("worker A gave up"), {
      ownership: a!.ownership,
    });
    expect(stale).toBeNull();

    const after = await row(job.id);
    expect(after.status).toBe("SUCCEEDED");
    expect(after.error).toBeNull();
  });

  it("refuses a heartbeat from a worker that lost the lease", async () => {
    await enqueue();

    const a = await claimNextJob("worker-a", { leaseMs: -1_000 });
    const b = await claimNextJob("worker-b");

    // A's heartbeat must not extend a lease it no longer holds...
    expect(await heartbeatJob(a!.id, a!.ownership, 600_000)).toBe(false);
    // ...while B's does.
    expect(await heartbeatJob(b!.id, b!.ownership, 600_000)).toBe(true);
  });

  it("lets the current owner complete normally, and only once", async () => {
    const job = await enqueue();
    const claimed = await claimNextJob("worker-a");

    const first = await completeJob(job.id, { summary: "done", enqueued: 0 }, new Date(), claimed!.ownership);
    expect(first?.status).toBe("SUCCEEDED");

    // A second report from the same claim matches nothing: the row is no
    // longer RUNNING.
    const second = await completeJob(job.id, { summary: "again", enqueued: 0 }, new Date(), claimed!.ownership);
    expect(second).toBeNull();

    expect((await row(job.id)).status).toBe("SUCCEEDED");
  });

  it("refuses a completion from a worker whose attempt has moved on", async () => {
    const job = await enqueue();

    const a = await claimNextJob("worker-a", { leaseMs: -1_000 });
    // The same worker id reclaims the job. The attempt has moved on, so the
    // first claim's token is stale even though the worker is still "owner".
    const a2 = await claimNextJob("worker-a");

    expect(a2?.ownership.attempt).toBe(2);
    expect(
      await completeJob(job.id, { summary: "stale", enqueued: 0 }, new Date(), a!.ownership),
    ).toBeNull();

    expect(
      (await completeJob(job.id, { summary: "current", enqueued: 0 }, new Date(), a2!.ownership))
        ?.status,
    ).toBe("SUCCEEDED");

    expect((await row(job.id)).result).toEqual({ summary: "current", enqueued: 0 });
  });

  it("does not let an expired attempt overwrite a terminal state", async () => {
    const job = await enqueue("CRAWL_SOURCE", { i: 1 });
    const claimed = await claimNextJob("worker-a");

    await cancelJob(job.id);

    const stale = await completeJob(job.id, { summary: "late", enqueued: 0 }, new Date(), claimed!.ownership);
    expect(stale).toBeNull();
    expect((await row(job.id)).status).toBe("CANCELLED");
  });
});

describe("terminal states", () => {
  it("leaves a finished job alone when a late completion arrives", async () => {
    const job = await enqueue();
    const claimed = await claimNextJob("worker-a");
    await completeJob(job.id, { summary: "first", enqueued: 0 }, new Date(), claimed!.ownership);

    // No ownership token: the unconditional path used by admin tooling.
    const late = await completeJob(job.id, { summary: "second", enqueued: 0 });
    expect(late).toBeNull();
    expect((await row(job.id)).result).toEqual({ summary: "first", enqueued: 0 });
  });

  it("does not resurrect a failed job through the retryable-failure path", async () => {
    await enqueue();
    const claimed = await claimNextJob("worker-a");
    await failJob(claimed!.id, new Error("permanent"), { retryable: false });

    expect((await row(claimed!.id)).status).toBe("FAILED");

    // The same claim cannot now downgrade it back to PENDING.
    const again = await failJob(claimed!.id, new Error("planned"), {
      ownership: claimed!.ownership,
    });
    expect(again).toBeNull();
    expect((await row(claimed!.id)).status).toBe("FAILED");
  });

  it("never reports two terminal outcomes for one job under a race", async () => {
    const job = await enqueue();
    const claimed = await claimNextJob("worker-a");

    const [completed, failed] = await Promise.all([
      completeJob(job.id, { summary: "won", enqueued: 0 }, new Date(), claimed!.ownership),
      failJob(job.id, new Error("lost"), { ownership: claimed!.ownership }),
    ]);

    // Exactly one of the two wrote.
    expect([completed === null, failed === null].filter(Boolean)).toHaveLength(1);

    const after = await row(job.id);
    expect(["SUCCEEDED", "FAILED"]).toContain(after.status);
    expect(after.completedAt).not.toBeNull();
  });
});

describe("abandoned final attempts", () => {
  it("fails a job stuck RUNNING on its final attempt instead of stranding it", async () => {
    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      maxAttempts: 1,
    });

    // The only attempt is taken and its lease immediately expires: the worker
    // died holding the last chance this job had.
    const claimed = await claimNextJob("worker-a", { leaseMs: -1_000 });
    expect(claimed).not.toBeNull();
    expect((await row(claimed!.id)).status).toBe("RUNNING");

    const now = new Date(Date.now() + ABANDONED_LEASE_GRACE_MS + 1_000);
    const expired = await expireAbandonedJobs({ now });

    expect(expired.map((entry) => entry.id)).toEqual([claimed!.id]);

    const after = await row(claimed!.id);
    expect(after.status).toBe("FAILED");
    expect(after.error).toContain("Abandoned");
    expect(after.completedAt).not.toBeNull();
    expect(after.lockedBy).toBeNull();
    expect((after.result as { error: { category: string } }).error.category).toBe("ABANDONED");
  });

  it("leaves a live lease alone", async () => {
    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      maxAttempts: 1,
    });
    const claimed = await claimNextJob("worker-a", { leaseMs: 600_000 });

    const expired = await expireAbandonedJobs();

    expect(expired).toEqual([]);
    expect((await row(claimed!.id)).status).toBe("RUNNING");
  });

  it("leaves a job that still has attempts left for the next claim", async () => {
    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      maxAttempts: 3,
    });
    const claimed = await claimNextJob("worker-a", { leaseMs: -1_000 });

    const now = new Date(Date.now() + ABANDONED_LEASE_GRACE_MS + 1_000);
    expect(await expireAbandonedJobs({ now })).toEqual([]);

    // Reclaimable rather than dead: the retry budget is not exhausted.
    const next = await claimNextJob("worker-b", { now });
    expect(next?.id).toBe(claimed?.id);
    expect(next?.ownership.attempt).toBe(2);
  });

  it("settles the run that was waiting on the abandoned job", async () => {
    const run = await db.discoveryRun.create({
      data: { workspaceId: alice.workspaceId, status: "RUNNING", trigger: "SCHEDULED" },
    });

    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      maxAttempts: 1,
      discoveryRunId: run.id,
    });
    await claimNextJob("worker-a", { leaseMs: -1_000 });

    await expireAbandonedJobs({ now: new Date(Date.now() + ABANDONED_LEASE_GRACE_MS + 1_000) });

    const settled = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(settled.status).toBe("FAILED");
    expect(settled.completedAt).not.toBeNull();
  });

  it("is idempotent", async () => {
    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      maxAttempts: 1,
    });
    await claimNextJob("worker-a", { leaseMs: -1_000 });

    const now = new Date(Date.now() + ABANDONED_LEASE_GRACE_MS + 1_000);
    expect(await expireAbandonedJobs({ now })).toHaveLength(1);
    expect(await expireAbandonedJobs({ now })).toEqual([]);
  });
});

describe("the worker loop", () => {
  it("completes a job and records what it produced", async () => {
    await db.source.create({
      data: { workspaceId: alice.workspaceId, provider: "manual-csv", name: "Manual" },
    });
    const source = await db.source.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });

    await enqueue("CRAWL_SOURCE", { sourceId: source.id });

    const stats = await runWorker({ workerId: "w-loop", maxJobs: 1, sleep: noSleep });

    expect(stats.claimed).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.lostLease).toBe(0);

    const job = await db.job.findFirstOrThrow({ where: { workspaceId: alice.workspaceId } });
    expect(job.status).toBe("SUCCEEDED");
    expect(job.lockedBy).toBeNull();
    expect(job.result).toMatchObject({ enqueued: expect.any(Number) });
  });

  it("records a structured failure and retries it", async () => {
    // A payload the handler must reject: no sourceId.
    await enqueue("CRAWL_SOURCE", {});

    const stats = await runWorker({ workerId: "w-fail", maxJobs: 1, sleep: noSleep });

    expect(stats.failed).toBe(1);
    expect(stats.completed).toBe(0);

    const job = await db.job.findFirstOrThrow({ where: { workspaceId: alice.workspaceId } });
    // Retryable: attempts remain, so it is back in the queue with backoff.
    expect(job.status).toBe("PENDING");
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(job.error).toContain("sourceId");

    const record = (job.result as { error: { category: string; attempt: number } }).error;
    expect(record.category).toBe("VALIDATION");
    expect(record.attempt).toBe(1);
  });

  it("abandons a handler that exceeds its deadline and fails the job", async () => {
    const original = JOB_HANDLERS.MARKET_ANALYSIS;

    // A handler that never returns, and never looks at its signal: the worst
    // case, and the one a timeout exists for.
    (JOB_HANDLERS as Record<string, unknown>).MARKET_ANALYSIS = async () =>
      new Promise(() => {});

    try {
      await enqueue("MARKET_ANALYSIS", {});

      const started = Date.now();
      const stats = await runWorker({
        workerId: "w-timeout",
        maxJobs: 1,
        sleep: noSleep,
        jobTimeoutMs: 50,
      });
      const elapsed = Date.now() - started;

      expect(stats.failed).toBe(1);
      // The loop moved on rather than waiting for the handler.
      expect(elapsed).toBeLessThan(2_000);

      const job = await db.job.findFirstOrThrow({
        where: { workspaceId: alice.workspaceId },
      });
      expect(job.status).toBe("PENDING");
      expect(job.error).toContain("deadline");
      expect((job.result as { error: { category: string } }).error.category).toBe("TIMEOUT");
      expect(job.lockedBy).toBeNull();
    } finally {
      (JOB_HANDLERS as Record<string, unknown>).MARKET_ANALYSIS = original;
    }
  });

  it("reaps an abandoned final attempt while it runs", async () => {
    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      maxAttempts: 1,
    });

    // Abandoned well before this worker starts, so its lease and grace have
    // both passed.
    await claimNextJob("worker-dead", { leaseMs: -1_000 });
    await db.job.updateMany({
      where: { workspaceId: alice.workspaceId },
      data: { lockedUntil: new Date(Date.now() - ABANDONED_LEASE_GRACE_MS - 60_000) },
    });

    const stats = await runWorker({
      workerId: "w-reap",
      maxJobs: 1,
      sleep: noSleep,
      reapIntervalMs: 0,
    });

    expect(stats.reaped).toBe(1);

    const job = await db.job.findFirstOrThrow({ where: { workspaceId: alice.workspaceId } });
    expect(job.status).toBe("FAILED");
  });

  it("stops promptly when asked to shut down", async () => {
    const controller = new AbortController();

    const stats = await runWorker({
      workerId: "w-shutdown",
      signal: controller.signal,
      sleep: noSleep,
      idleDelayMs: 1,
      onEvent: (event) => {
        // Abort as soon as the loop reports it has nothing to do.
        if (event.kind === "IDLE") controller.abort();
      },
    });

    expect(stats.claimed).toBe(0);
  });
});

describe("manual controls stay workspace-safe", () => {
  it("retries a failed job and cancels a pending one", async () => {
    await enqueue("CRAWL_SOURCE", {});
    await runWorker({ workerId: "w-1", maxJobs: 1, sleep: noSleep });

    const failed = await db.job.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });
    await failJob(failed.id, new Error("permanent"), { retryable: false });
    expect((await row(failed.id)).status).toBe("FAILED");

    expect(await retryJob(failed.id)).toBe(true);
    const requeued = await row(failed.id);
    expect(requeued.status).toBe("PENDING");
    expect(requeued.attempts).toBe(0);

    expect(await cancelJob(failed.id)).toBe(true);
    expect((await row(failed.id)).status).toBe("CANCELLED");
  });
});
