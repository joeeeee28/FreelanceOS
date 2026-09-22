/**
 * P15 §16, §17 — worker concurrency and crash recovery, against real Postgres.
 *
 * The job queue's whole safety argument is one atomic SQL statement
 * (`FOR UPDATE SKIP LOCKED`). That argument cannot be validated by a mock: it
 * is a claim about what the database does under contention. These tests put
 * real concurrent claimants against a real server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  heartbeatJob,
} from "@/lib/jobs/queue";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

let ws: SeededWorkspace;

beforeAll(async () => {
  await resetTestDatabase();
}, 180_000);

beforeEach(async () => {
  await truncateAll();
  ws = await seedWorkspace("Worker");
});

afterAll(async () => {
  await disconnectTestPrisma();
});

async function enqueue(n: number) {
  for (let i = 0; i < n; i++) {
    await enqueueJob({
      workspaceId: ws.workspaceId,
      type: "CRAWL_SOURCE",
      payload: { index: i },
    });
  }
}

describe("§16 concurrency", () => {
  it("never hands the same job to two workers", async () => {
    await enqueue(12);

    // Twelve claimants racing for twelve jobs, started simultaneously.
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, i) => claimNextJob(`worker-${i}`)),
    );

    const ids = claims.filter((c) => c !== null).map((c) => c!.id);
    expect(ids.length).toBe(12);
    // The real assertion: no id appears twice.
    expect(new Set(ids).size).toBe(12);
  }, 60_000);

  it("hands out each job exactly once when workers outnumber jobs", async () => {
    await enqueue(3);

    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, i) => claimNextJob(`worker-${i}`)),
    );

    const claimed = claims.filter((c) => c !== null);
    expect(claimed.length).toBe(3);
    expect(new Set(claimed.map((c) => c!.id)).size).toBe(3);
    // The other seven get nothing rather than a duplicate or an error.
    expect(claims.filter((c) => c === null).length).toBe(7);
  }, 60_000);

  it("returns null on an empty queue rather than throwing", async () => {
    expect(await claimNextJob("idle-worker")).toBeNull();
  });
});

describe("§17 failure recovery", () => {
  it("re-leases a job whose worker died without completing it", async () => {
    await enqueue(1);

    // Worker A claims with a short lease, then "crashes": no complete, no
    // fail, no heartbeat. Nothing tells the system it is gone.
    const a = await claimNextJob("worker-a", { leaseMs: 1_000 });
    expect(a).not.toBeNull();

    // Before the lease expires the job is nobody else's to take.
    expect(await claimNextJob("worker-b", { leaseMs: 1_000 })).toBeNull();

    // After it expires, another worker picks it up. A crashed worker must not
    // strand work forever.
    const later = new Date(Date.now() + 5_000);
    const b = await claimNextJob("worker-b", { leaseMs: 60_000, now: later });

    expect(b).not.toBeNull();
    expect(b!.id).toBe(a!.id);
    // The attempt counter records that this is a second try.
    expect(b!.attempts).toBeGreaterThan(a!.attempts);

    await completeJob(b!.id);
    const finished = await db.job.findUniqueOrThrow({ where: { id: b!.id } });
    expect(finished.status).toBe("SUCCEEDED");
  }, 60_000);

  it("keeps a job alive while its worker is heartbeating", async () => {
    await enqueue(1);

    const a = await claimNextJob("worker-a", { leaseMs: 1_000 });
    expect(a).not.toBeNull();

    // A long-running job renews its lease rather than losing the work.
    await heartbeatJob(a!.id, "worker-a", 60_000);

    const later = new Date(Date.now() + 5_000);
    expect(await claimNextJob("worker-b", { now: later })).toBeNull();
  }, 60_000);

  it("retries a failed job, then gives up and records why", async () => {
    await enqueueJob({
      workspaceId: ws.workspaceId,
      type: "CRAWL_SOURCE",
      payload: {},
      maxAttempts: 2,
    });

    const first = await claimNextJob("worker-a");
    await failJob(first!.id, "connection reset", { retryable: true });

    const afterFirst = await db.job.findUniqueOrThrow({ where: { id: first!.id } });
    expect(afterFirst.status).toBe("PENDING");
    expect(afterFirst.error).toContain("connection reset");

    // Retry is scheduled into the future (backoff), so claim with a later now.
    const later = new Date(Date.now() + 10 * 60_000);
    const second = await claimNextJob("worker-a", { now: later });
    expect(second).not.toBeNull();

    await failJob(second!.id, "connection reset again", {
      retryable: true,
      now: later,
    });

    const exhausted = await db.job.findUniqueOrThrow({ where: { id: first!.id } });
    // Attempts are spent: the job stops rather than retrying forever.
    expect(exhausted.status).toBe("FAILED");
    expect(exhausted.error).toContain("connection reset again");
  }, 60_000);

  it("does not retry a job that failed for a non-retryable reason", async () => {
    await enqueueJob({
      workspaceId: ws.workspaceId,
      type: "CRAWL_SOURCE",
      payload: {},
      maxAttempts: 5,
    });

    const job = await claimNextJob("worker-a");
    await failJob(job!.id, "payload is malformed", { retryable: false });

    const after = await db.job.findUniqueOrThrow({ where: { id: job!.id } });
    // Retrying a malformed payload five times just fails five times.
    expect(after.status).toBe("FAILED");
  }, 60_000);

  it("loses no job across a simulated crash of every worker", async () => {
    await enqueue(5);

    // Five workers claim everything, then all die.
    const claimed = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        claimNextJob(`doomed-${i}`, { leaseMs: 500 }),
      ),
    );
    expect(claimed.filter((c) => c !== null).length).toBe(5);

    // A fresh worker arrives after the leases lapse and drains the queue.
    const later = new Date(Date.now() + 10_000);
    const recovered: string[] = [];
    for (let i = 0; i < 5; i++) {
      const job = await claimNextJob("survivor", { leaseMs: 60_000, now: later });
      if (job === null) break;
      recovered.push(job.id);
      await completeJob(job.id, {}, later);
    }

    expect(recovered.length).toBe(5);
    expect(
      await db.job.count({
        where: { workspaceId: ws.workspaceId, status: "SUCCEEDED" },
      }),
    ).toBe(5);
  }, 60_000);
});
