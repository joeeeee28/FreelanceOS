import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const {
  BASE_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  cancelJob,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  heartbeatJob,
  queueStats,
  retryDelayMs,
  retryJob,
} = await import("@/lib/jobs/queue");

let alice: SeededWorkspace;
let bob: SeededWorkspace;

beforeAll(async () => {
  await resetTestDatabase();
}, 120_000);

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("Alice");
  bob = await seedWorkspace("Bob");
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("retryDelayMs", () => {
  it("backs off exponentially", () => {
    expect(retryDelayMs(1)).toBe(BASE_RETRY_DELAY_MS);
    expect(retryDelayMs(2)).toBe(BASE_RETRY_DELAY_MS * 2);
    expect(retryDelayMs(3)).toBe(BASE_RETRY_DELAY_MS * 4);
  });

  it("is capped so a broken source cannot schedule work years away", () => {
    expect(retryDelayMs(50)).toBe(MAX_RETRY_DELAY_MS);
  });

  it("handles the zero case", () => {
    expect(retryDelayMs(0)).toBe(BASE_RETRY_DELAY_MS);
  });
});

describe("enqueueJob", () => {
  it("queues a job as PENDING", async () => {
    const job = await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      payload: { url: "https://example.test/sitemap.xml" },
    });

    expect(job.status).toBe("PENDING");
    expect(job.attempts).toBe(0);
  });

  it("deduplicates on an idempotency key", async () => {
    const key = "crawl:example.test";

    const first = await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      idempotencyKey: key,
    });
    const second = await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
    expect(await db.job.count({ where: { workspaceId: alice.workspaceId } })).toBe(1);
  });

  it("scopes idempotency keys per workspace", async () => {
    const key = "crawl:example.test";

    const a = await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      idempotencyKey: key,
    });
    const b = await enqueueJob({
      workspaceId: bob.workspaceId,
      type: "CRAWL_SOURCE",
      idempotencyKey: key,
    });

    expect(b.id).not.toBe(a.id);
  });
});

describe("claimNextJob", () => {
  it("claims a due job and marks it RUNNING", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "DISCOVERY_RUN" });

    const claimed = await claimNextJob("worker-1");
    expect(claimed).not.toBeNull();
    expect(claimed?.type).toBe("DISCOVERY_RUN");
    expect(claimed?.attempts).toBe(1);

    const stored = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(stored.status).toBe("RUNNING");
    expect(stored.lockedBy).toBe("worker-1");
    expect(stored.lockedUntil).not.toBeNull();
  });

  it("does not claim a job scheduled for the future", async () => {
    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "DISCOVERY_RUN",
      runAfter: new Date(Date.now() + 60_000),
    });

    expect(await claimNextJob("worker-1")).toBeNull();
  });

  it("returns null on an empty queue", async () => {
    expect(await claimNextJob("worker-1")).toBeNull();
  });

  /**
   * The central safety property: two workers must never run the same job.
   */
  it("never hands one job to two workers", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "CRAWL_SOURCE" });

    const [a, b] = await Promise.all([
      claimNextJob("worker-1"),
      claimNextJob("worker-2"),
    ]);

    const claimed = [a, b].filter((j) => j !== null);
    expect(claimed).toHaveLength(1);
  });

  it("distributes a backlog across concurrent workers without overlap", async () => {
    for (let i = 0; i < 8; i++) {
      await enqueueJob({
        workspaceId: alice.workspaceId,
        type: "CRAWL_SOURCE",
        payload: { i },
      });
    }

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimNextJob(`worker-${i}`)),
    );

    const ids = results.filter((j) => j !== null).map((j) => j!.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8); // no job claimed twice
  });

  it("respects priority, then age", async () => {
    const now = new Date();

    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      priority: 100,
      payload: { label: "normal" },
      runAfter: new Date(now.getTime() - 10_000),
    });
    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      priority: 10,
      payload: { label: "urgent" },
      runAfter: new Date(now.getTime() - 1_000),
    });

    const claimed = await claimNextJob("worker-1");
    expect((claimed?.payload as { label: string }).label).toBe("urgent");
  });

  it("can filter by job type", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "CRAWL_SOURCE" });
    await enqueueJob({ workspaceId: alice.workspaceId, type: "MARKET_ANALYSIS" });

    const claimed = await claimNextJob("worker-1", { types: ["MARKET_ANALYSIS"] });
    expect(claimed?.type).toBe("MARKET_ANALYSIS");
  });

  describe("crashed workers", () => {
    it("reclaims a job whose lease expired", async () => {
      await enqueueJob({ workspaceId: alice.workspaceId, type: "CRAWL_SOURCE" });

      // Worker 1 takes the job with a lease that has already run out.
      const first = await claimNextJob("worker-1", { leaseMs: -1000 });
      expect(first).not.toBeNull();

      // Worker 1 "dies". Worker 2 must be able to pick the job up.
      const second = await claimNextJob("worker-2");
      expect(second?.id).toBe(first!.id);
      expect(second?.attempts).toBe(2);
    });

    it("does not reclaim a job whose lease is still valid", async () => {
      await enqueueJob({ workspaceId: alice.workspaceId, type: "CRAWL_SOURCE" });

      await claimNextJob("worker-1", { leaseMs: 60_000 });
      expect(await claimNextJob("worker-2")).toBeNull();
    });

    it("stops reclaiming once attempts are exhausted", async () => {
      await enqueueJob({
        workspaceId: alice.workspaceId,
        type: "CRAWL_SOURCE",
        maxAttempts: 2,
      });

      expect(await claimNextJob("w1", { leaseMs: -1000 })).not.toBeNull();
      expect(await claimNextJob("w2", { leaseMs: -1000 })).not.toBeNull();
      // Third attempt would exceed maxAttempts.
      expect(await claimNextJob("w3", { leaseMs: -1000 })).toBeNull();
    });
  });
});

describe("heartbeatJob", () => {
  it("extends the lease of the holder", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "CRAWL_SOURCE" });
    const claimed = await claimNextJob("worker-1", { leaseMs: 1000 });

    const before = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(await heartbeatJob(claimed!.id, "worker-1", 600_000)).toBe(true);
    const after = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } });

    expect(after.lockedUntil!.getTime()).toBeGreaterThan(before.lockedUntil!.getTime());
  });

  it("refuses to extend a lease held by another worker", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "CRAWL_SOURCE" });
    const claimed = await claimNextJob("worker-1");

    expect(await heartbeatJob(claimed!.id, "worker-2")).toBe(false);
  });
});

describe("completing and failing", () => {
  it("marks a job SUCCEEDED and releases the lock", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "CRAWL_SOURCE" });
    const claimed = await claimNextJob("worker-1");

    await completeJob(claimed!.id, { pages: 3 });

    const stored = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(stored.status).toBe("SUCCEEDED");
    expect(stored.lockedBy).toBeNull();
    expect(stored.completedAt).not.toBeNull();
    expect(stored.result).toEqual({ pages: 3 });
  });

  it("reschedules a retryable failure with backoff", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "CRAWL_SOURCE" });
    const claimed = await claimNextJob("worker-1");

    const now = new Date();
    await failJob(claimed!.id, new Error("connection reset"), { now });

    const stored = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(stored.status).toBe("PENDING");
    expect(stored.error).toBe("connection reset");
    expect(stored.runAfter.getTime()).toBeGreaterThan(now.getTime());
    expect(stored.lockedBy).toBeNull();
  });

  it("gives up once attempts are exhausted", async () => {
    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      maxAttempts: 1,
    });
    const claimed = await claimNextJob("worker-1");

    await failJob(claimed!.id, new Error("still broken"));

    const stored = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(stored.status).toBe("FAILED");
  });

  it("does not retry a non-retryable failure", async () => {
    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      maxAttempts: 5,
    });
    const claimed = await claimNextJob("worker-1");

    // A blocked source must not be hammered: failing it is final.
    await failJob(claimed!.id, new Error("blocked by robots.txt"), {
      retryable: false,
    });

    const stored = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(stored.status).toBe("FAILED");
  });

  it("strips control characters from error text", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "CRAWL_SOURCE" });
    const claimed = await claimNextJob("worker-1");

    await failJob(claimed!.id, new Error("bad\u0000error\u001ftext"), {
      retryable: false,
    });

    const stored = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(stored.error).toBe("bad error text");
  });
});

describe("manual controls", () => {
  it("cancels a pending job", async () => {
    const job = await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
    });

    expect(await cancelJob(job.id)).toBe(true);
    expect(await claimNextJob("worker-1")).toBeNull();
  });

  it("does not cancel a finished job", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "CRAWL_SOURCE" });
    const claimed = await claimNextJob("worker-1");
    await completeJob(claimed!.id);

    expect(await cancelJob(claimed!.id)).toBe(false);
  });

  it("requeues a failed job with a clean attempt counter", async () => {
    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      maxAttempts: 1,
    });
    const claimed = await claimNextJob("worker-1");
    await failJob(claimed!.id, new Error("boom"));

    expect(await retryJob(claimed!.id)).toBe(true);

    const stored = await db.job.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(stored.status).toBe("PENDING");
    expect(stored.attempts).toBe(0);
    expect(stored.error).toBeNull();

    // And it is genuinely runnable again.
    expect(await claimNextJob("worker-2")).not.toBeNull();
  });
});

describe("queueStats", () => {
  it("counts only the caller's workspace", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "CRAWL_SOURCE" });
    await enqueueJob({ workspaceId: alice.workspaceId, type: "CRAWL_SOURCE" });
    await enqueueJob({ workspaceId: bob.workspaceId, type: "CRAWL_SOURCE" });

    const stats = await queueStats(alice.workspaceId);
    expect(stats.PENDING).toBe(2);
    expect(stats.SUCCEEDED).toBe(0);
  });
});
