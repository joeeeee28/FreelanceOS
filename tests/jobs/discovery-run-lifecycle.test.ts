/**
 * DiscoveryRun lifecycle.
 *
 * The regression these cover: a run used to stay RUNNING forever as soon as it
 * queued real work. Only the "nothing to do" branch ever completed a run, so
 * every real cycle left a RUNNING row behind — which made the dashboard say
 * "Running" permanently and pushed the scheduler onto the six-hour stale-run
 * path, queueing extra crawls.
 *
 * A run is finished when every job belonging to it is terminal: SUCCEEDED,
 * FAILED or CANCELLED. PENDING and RUNNING jobs mean the run is still active.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";

const { cancelJob, claimNextJob, completeJob, enqueueJob, failJob } =
  await import("@/lib/jobs/queue");
const {
  reconcileDiscoveryRuns,
  settleDiscoveryRun,
  terminalStatusFor,
} = await import("@/lib/discovery/runs");
const { runWorker } = await import("@/lib/jobs/worker");
const { JOB_HANDLERS } = await import("@/lib/jobs/handlers");
const { decideSchedule } = await import("@/lib/discovery/scheduler");

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

const noSleep = async () => {};

/** A run as the DISCOVERY_RUN handler creates it. */
async function startRun() {
  return db.discoveryRun.create({
    data: {
      workspaceId: alice.workspaceId,
      status: "RUNNING",
      trigger: "SCHEDULED",
    },
  });
}

/** A job belonging to a run, as the fan-out handler queues it. */
async function enqueueChild(
  discoveryRunId: string,
  type = "CRAWL_SOURCE",
  extra: { maxAttempts?: number } = {},
) {
  return enqueueJob({
    workspaceId: alice.workspaceId,
    type,
    discoveryRunId,
    payload: { sourceId: "not-a-real-source" },
    ...extra,
  });
}

async function statusOf(discoveryRunId: string): Promise<string> {
  const run = await db.discoveryRun.findUniqueOrThrow({
    where: { id: discoveryRunId },
  });
  return run.status;
}

async function claimOne(workerId = "test-worker") {
  const claimed = await claimNextJob(workerId);
  if (claimed === null) throw new Error("expected a claimable job");
  return claimed;
}

/** The schedule state the worker builds from the newest run. */
async function scheduleState() {
  const lastRun = await db.discoveryRun.findFirst({
    where: { workspaceId: alice.workspaceId },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true, completedAt: true, status: true },
  });

  return {
    lastStartedAt: lastRun?.startedAt ?? null,
    lastCompletedAt: lastRun?.completedAt ?? null,
    running: lastRun?.status === "RUNNING",
  };
}

describe("terminalStatusFor", () => {
  const counts = (over: Partial<Record<string, number>>) => ({
    active: 0,
    total: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    ...over,
  });

  it("is COMPLETED when work succeeded", () => {
    expect(terminalStatusFor(counts({ total: 2, succeeded: 2 }))).toBe("COMPLETED");
  });

  it("is COMPLETED when there was nothing to do", () => {
    expect(terminalStatusFor(counts({}))).toBe("COMPLETED");
  });

  it("is not COMPLETED when nothing succeeded", () => {
    // A run that only failed must not read as success.
    expect(terminalStatusFor(counts({ total: 2, failed: 2 }))).toBe("FAILED");
    expect(terminalStatusFor(counts({ total: 1, cancelled: 1 }))).toBe("CANCELLED");
  });
});

describe("DiscoveryRun completion", () => {
  it("completes a run that has no child jobs", async () => {
    const run = await startRun();

    const settlement = await settleDiscoveryRun(run.id);

    expect(settlement?.settled).toBe(true);
    expect(settlement?.status).toBe("COMPLETED");
    expect(settlement?.children).toBe(0);

    const after = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.completedAt).not.toBeNull();
  });

  it("completes when its only child job succeeds", async () => {
    const run = await startRun();
    const child = await enqueueChild(run.id);

    await completeJob((await claimOne()).id);

    expect(await statusOf(run.id)).toBe("COMPLETED");
    expect(
      (await db.job.findUniqueOrThrow({ where: { id: child.id } })).status,
    ).toBe("SUCCEEDED");
  });

  it("stays RUNNING while any child job is still PENDING", async () => {
    const run = await startRun();
    await enqueueChild(run.id);
    await enqueueChild(run.id);
    await enqueueChild(run.id);

    const settlement = await settleDiscoveryRun(run.id);
    expect(settlement?.settled).toBe(false);
    expect(settlement?.status).toBe("RUNNING");
    expect(settlement?.activeChildren).toBe(3);

    await completeJob((await claimOne("w-a")).id);

    const afterOne = await settleDiscoveryRun(run.id);
    expect(afterOne?.activeChildren).toBe(2);
    expect(await statusOf(run.id)).toBe("RUNNING");
  });

  it("stays RUNNING while any child job is RUNNING", async () => {
    const run = await startRun();
    await enqueueChild(run.id);
    await enqueueChild(run.id);

    const running = await claimOne("w-a");
    const finished = await claimOne("w-b");
    await completeJob(finished.id);

    const settlement = await settleDiscoveryRun(run.id);
    expect(settlement?.status).toBe("RUNNING");
    expect(settlement?.activeChildren).toBe(1);
    expect(await statusOf(run.id)).toBe("RUNNING");
    expect(running.id).not.toBe(finished.id);
  });

  it("completes once every child job has SUCCEEDED", async () => {
    const run = await startRun();
    await enqueueChild(run.id);
    await enqueueChild(run.id);
    await enqueueChild(run.id);

    const claimed = [
      await claimOne("w-a"),
      await claimOne("w-b"),
      await claimOne("w-c"),
    ];

    await completeJob(claimed[0].id);
    await completeJob(claimed[1].id);
    expect(await statusOf(run.id)).toBe("RUNNING");

    await completeJob(claimed[2].id);
    expect(await statusOf(run.id)).toBe("COMPLETED");

    const after = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.completedAt).not.toBeNull();
  });

  it("records FAILED, with a reason, when nothing in the run succeeded", async () => {
    const run = await startRun();
    const child = await enqueueChild(run.id, "CRAWL_SOURCE", { maxAttempts: 1 });

    const claimed = await claimOne();
    await failJob(claimed.id, new Error("source exploded"), { retryable: false });

    const after = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("FAILED");
    expect(after.completedAt).not.toBeNull();
    expect(after.error).toContain("No job in this run succeeded");

    // The failure is preserved in the job, never converted into a success.
    const job = await db.job.findUniqueOrThrow({ where: { id: child.id } });
    expect(job.status).toBe("FAILED");
    expect(job.error).toContain("source exploded");
  });

  it("still completes when some jobs failed, keeping the failure visible", async () => {
    const run = await startRun();
    await enqueueChild(run.id);
    await enqueueChild(run.id);

    const claimed = [await claimOne("w-a"), await claimOne("w-b")];

    await completeJob(claimed[0].id);
    // One job still RUNNING, so the run is not finished yet.
    expect(await statusOf(run.id)).toBe("RUNNING");

    await failJob(claimed[1].id, new Error("one source failed"), { retryable: false });

    expect(await statusOf(run.id)).toBe("COMPLETED");

    const failed = await db.job.findUniqueOrThrow({ where: { id: claimed[1].id } });
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toContain("one source failed");
  });

  it("reaches COMPLETED when a failure sits beside a success", async () => {
    const run = await startRun();
    const good = await enqueueChild(run.id);
    const bad = await enqueueChild(run.id, "CRAWL_SOURCE", { maxAttempts: 1 });

    const first = await claimOne("w-a");
    const second = await claimOne("w-b");

    for (const claimed of [first, second]) {
      if (claimed.id === bad.id) {
        await failJob(claimed.id, new Error("boom"), { retryable: false });
      } else {
        await completeJob(claimed.id);
      }
    }

    expect(await statusOf(run.id)).toBe("COMPLETED");
    expect((await db.job.findUniqueOrThrow({ where: { id: good.id } })).status).toBe(
      "SUCCEEDED",
    );
    expect((await db.job.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe(
      "FAILED",
    );
  });

  it("reaches CANCELLED when every job in the run was cancelled", async () => {
    const run = await startRun();
    await enqueueChild(run.id);
    await enqueueChild(run.id);

    const claimed = [await claimOne("w-a"), await claimOne("w-b")];

    await cancelJob(claimed[0].id);
    // The other job is still RUNNING, so the run is still active.
    expect(await statusOf(run.id)).toBe("RUNNING");

    await cancelJob(claimed[1].id);
    expect(await statusOf(run.id)).toBe("CANCELLED");

    const after = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.completedAt).not.toBeNull();
  });

  it("keeps the run open while its fan-out job is still running", async () => {
    // The job that queues the work belongs to the run: a second worker must not
    // be able to close the run while children are still being queued.
    await db.source.create({
      data: { workspaceId: alice.workspaceId, provider: "manual-csv", name: "A" },
    });

    const parent = await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "DISCOVERY_RUN",
    });
    const claimed = await claimOne();
    expect(claimed.id).toBe(parent.id);

    await JOB_HANDLERS.DISCOVERY_RUN({
      workspaceId: alice.workspaceId,
      jobId: claimed.id,
      payload: {},
      discoveryRunId: null,
    });

    const run = await db.discoveryRun.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });

    const linked = await db.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(linked.discoveryRunId).toBe(run.id);
    expect(run.status).toBe("RUNNING");

    // Finishing the fan-out job is not enough on its own.
    await completeJob(claimed.id);
    expect(await statusOf(run.id)).toBe("RUNNING");

    // Only the last child closes the run.
    const child = await claimOne();
    expect(child.type).toBe("CRAWL_SOURCE");
    await completeJob(child.id);
    expect(await statusOf(run.id)).toBe("COMPLETED");
  });

  it("closes a run that queued real work, through the worker", async () => {
    // The original bug in one test: this run used to stay RUNNING forever.
    await db.source.create({
      data: { workspaceId: alice.workspaceId, provider: "manual-csv", name: "A" },
    });

    await enqueueJob({ workspaceId: alice.workspaceId, type: "DISCOVERY_RUN" });
    const stats = await runWorker({ maxJobs: 2, sleep: noSleep });
    expect(stats.completed).toBe(2);

    const run = await db.discoveryRun.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });
    expect(run.status).toBe("COMPLETED");
    expect(run.completedAt).not.toBeNull();
  });

  it("closes a run that had nothing to do", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "DISCOVERY_RUN" });
    await runWorker({ maxJobs: 1, sleep: noSleep });

    const run = await db.discoveryRun.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });
    expect(run.status).toBe("COMPLETED");
    expect(run.completedAt).not.toBeNull();
  });

  it("never rewrites a run that has already finished", async () => {
    const run = await startRun();
    await enqueueChild(run.id);
    await completeJob((await claimOne()).id);

    const finished = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finished.status).toBe("COMPLETED");

    const again = await settleDiscoveryRun(run.id, new Date(Date.now() + 60_000));
    expect(again?.settled).toBe(false);
    expect(again?.status).toBe("COMPLETED");

    const after = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.completedAt?.toISOString()).toBe(finished.completedAt?.toISOString());
  });
});

describe("concurrent finishes", () => {
  it("is not corrupted when two children finish at the same moment", async () => {
    const run = await startRun();
    await enqueueChild(run.id);
    await enqueueChild(run.id);

    const first = await claimOne("w-a");
    const second = await claimOne("w-b");

    await Promise.all([completeJob(first.id), completeJob(second.id)]);

    const after = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.completedAt).not.toBeNull();
    expect(
      await db.job.count({
        where: { discoveryRunId: run.id, status: { in: ["PENDING", "RUNNING"] } },
      }),
    ).toBe(0);
  });

  it("is not corrupted when two workers finish the last two children", async () => {
    const run = await startRun();
    await enqueueChild(run.id);
    await enqueueChild(run.id);

    const [a, b] = await Promise.all([
      runWorker({ workerId: "w-a", maxJobs: 1, sleep: noSleep }),
      runWorker({ workerId: "w-b", maxJobs: 1, sleep: noSleep }),
    ]);

    expect(a.claimed + b.claimed).toBe(2);
    expect(a.completed + b.completed).toBe(2);

    const after = await db.discoveryRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.completedAt).not.toBeNull();

    // Exactly one terminal status was written, and nothing is left active.
    expect(
      await db.job.count({
        where: { discoveryRunId: run.id, status: { in: ["PENDING", "RUNNING"] } },
      }),
    ).toBe(0);
  });
});

describe("the scheduler sees a live run, not a stale one", () => {
  it("waits while the run still has outstanding work", async () => {
    const run = await startRun();
    await enqueueChild(run.id);
    await claimOne("w-a");

    const decision = decideSchedule({ timezone: "UTC" }, await scheduleState());

    expect(decision.action).toBe("WAIT");
    expect(decision.reason).toBe("ALREADY_RUNNING");
    expect(await statusOf(run.id)).toBe("RUNNING");
  });

  it("stops reporting a running cycle once the work finishes", async () => {
    const run = await startRun();
    await enqueueChild(run.id);
    const claimed = await claimOne("w-a");

    await completeJob(claimed.id);

    const state = await scheduleState();
    expect(state.running).toBe(false);

    // The run is a finished record now, so the stale-run path is not taken.
    const decision = decideSchedule({ timezone: "UTC" }, state);
    expect(decision.action).toBe("WAIT");
    expect(["ALREADY_RAN", "NOT_DUE"]).toContain(decision.reason);
    expect(await statusOf(run.id)).toBe("COMPLETED");
  });
});

describe("reconciliation", () => {
  it("closes a run left behind when a worker died before settling", async () => {
    const run = await startRun();
    await enqueueChild(run.id);
    await enqueueChild(run.id);

    // The jobs finished, but the process died before the run was settled.
    await db.job.updateMany({
      where: { discoveryRunId: run.id },
      data: { status: "SUCCEEDED", completedAt: new Date() },
    });
    expect(await statusOf(run.id)).toBe("RUNNING");

    const result = await reconcileDiscoveryRuns();

    expect(result.examined).toBe(1);
    expect(result.settled).toBe(1);
    expect(await statusOf(run.id)).toBe("COMPLETED");
  });

  it("leaves a run that still has outstanding work alone", async () => {
    const run = await startRun();
    await enqueueChild(run.id);

    const result = await reconcileDiscoveryRuns();

    expect(result.examined).toBe(1);
    expect(result.settled).toBe(0);
    expect(await statusOf(run.id)).toBe("RUNNING");
  });

  it("only looks at the batch it was given", async () => {
    for (let i = 0; i < 3; i++) {
      const run = await startRun();
      await enqueueChild(run.id);
      await db.job.updateMany({
        where: { discoveryRunId: run.id },
        data: { status: "SUCCEEDED" },
      });
    }

    const result = await reconcileDiscoveryRuns({ limit: 2 });

    expect(result.examined).toBe(2);
    expect(result.settled).toBe(2);
    expect(await db.discoveryRun.count({ where: { status: "RUNNING" } })).toBe(1);
  });
});
