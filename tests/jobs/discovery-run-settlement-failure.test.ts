/**
 * A run-settlement problem must never damage the job that caused it.
 *
 * `settleDiscoveryRun()` is called after a job row has already been written as
 * finished. If that call fails (the database blips halfway through a cycle),
 * the job must keep the outcome it already earned and the queue must not
 * re-report work as failed — the run is reconciled on the next worker tick
 * instead. The failure is logged, not swallowed in silence.
 *
 * `@/lib/discovery/runs` is mocked here on purpose: this file is about the
 * queue's behaviour when settlement *fails*, which is not reproducible against
 * a healthy disposable database. The happy path is covered by
 * `discovery-run-lifecycle.test.ts` with no mocks at all.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";

const { settleDiscoveryRunMock } = vi.hoisted(() => ({
  settleDiscoveryRunMock: vi.fn(),
}));

vi.mock("@/lib/discovery/runs", () => ({
  settleDiscoveryRun: settleDiscoveryRunMock,
  reconcileDiscoveryRuns: vi.fn(),
}));

const { cancelJob, claimNextJob, completeJob, enqueueJob, failJob } =
  await import("@/lib/jobs/queue");

let alice: SeededWorkspace;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  await resetTestDatabase();
}, 120_000);

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("Alice");
  settleDiscoveryRunMock.mockReset();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

async function runWithJob(
  extra: { maxAttempts?: number } = {},
): Promise<{ runId: string; jobId: string }> {
  const run = await db.discoveryRun.create({
    data: {
      workspaceId: alice.workspaceId,
      status: "RUNNING",
      trigger: "SCHEDULED",
    },
  });

  const job = await enqueueJob({
    workspaceId: alice.workspaceId,
    type: "CRAWL_SOURCE",
    discoveryRunId: run.id,
    payload: { sourceId: "not-a-real-source" },
    ...extra,
  });

  return { runId: run.id, jobId: job.id };
}

describe("settlement failures do not damage the job", () => {
  it("keeps a succeeded job succeeded and logs the problem", async () => {
    const { runId, jobId } = await runWithJob();

    settleDiscoveryRunMock.mockRejectedValue(new Error("connection terminated"));

    const claimed = await claimNextJob("test-worker");
    expect(claimed?.id).toBe(jobId);

    // Must resolve: the job's outcome was already committed.
    await expect(completeJob(jobId)).resolves.toBeDefined();

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("SUCCEEDED");
    expect(job.error).toBeNull();
    expect(job.completedAt).not.toBeNull();

    expect(settleDiscoveryRunMock).toHaveBeenCalledWith(runId, expect.any(Date));
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain(runId);
    expect(String(consoleError.mock.calls[0][0])).toContain("connection terminated");
  });

  it("keeps an exhausted job failed and logs the problem", async () => {
    const { runId, jobId } = await runWithJob({ maxAttempts: 1 });

    settleDiscoveryRunMock.mockRejectedValue(new Error("connection terminated"));

    await claimNextJob("test-worker");
    await expect(
      failJob(jobId, new Error("crawl blew up"), { retryable: false }),
    ).resolves.toBeDefined();

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("FAILED");
    expect(job.error).toContain("crawl blew up");
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain(runId);
  });

  it("does not settle a job that is only being retried", async () => {
    const { jobId } = await runWithJob({ maxAttempts: 3 });

    await claimNextJob("test-worker");
    await failJob(jobId, new Error("transient"), { retryable: true });

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("PENDING");

    // The run is not touched: the job is not terminal, so it is not finished.
    expect(settleDiscoveryRunMock).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("still cancels a job when settlement fails", async () => {
    const { runId, jobId } = await runWithJob();

    settleDiscoveryRunMock.mockRejectedValue(new Error("connection terminated"));

    await expect(cancelJob(jobId)).resolves.toBe(true);

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("CANCELLED");
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain(runId);
  });

  it("does not settle anything for a job with no run", async () => {
    const job = await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "MARKET_ANALYSIS",
      payload: {},
    });

    await claimNextJob("test-worker");
    await completeJob(job.id);

    expect(settleDiscoveryRunMock).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
