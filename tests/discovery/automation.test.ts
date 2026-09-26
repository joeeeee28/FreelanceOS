/**
 * The operations page's queries.
 *
 * Every figure the automation dashboard shows has one authoritative query, and
 * these tests hold it to three properties:
 *
 *   1. It answers the question it claims to answer. A run metric comes from the
 *      run; a research count comes from the companies. Nothing is derived from
 *      a workspace total that happens to look similar, and nothing is rounded
 *      into looking healthier than the rows support.
 *   2. It is scoped to one workspace. Another tenant's rows are not counted,
 *      and their ids do not resolve.
 *   3. Absence is reported as absence: no worker, no runs, no failures.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getAutomationOverview,
  getJobDetail,
  getQueueSnapshot,
  getRecentFailures,
  getRecentRuns,
  getRunDetail,
  getScheduleFor,
  getWorkerLiveness,
} from "@/lib/discovery/automation";
import { JOB_HANDLERS } from "@/lib/jobs/handlers";
import { WORKER_STALE_AFTER_MS } from "@/lib/jobs/heartbeat";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";

let alice: SeededWorkspace;
let bob: SeededWorkspace;

const NOW = new Date("2026-09-22T12:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000);

async function makeJob(
  workspaceId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  return db.job.create({
    data: {
      workspaceId,
      type: "CRAWL_SOURCE",
      status: "PENDING",
      attempts: 0,
      maxAttempts: 3,
      runAfter: NOW,
      payload: {},
      ...overrides,
    },
    select: { id: true },
  });
}

async function makeRun(
  workspaceId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  return db.discoveryRun.create({
    data: {
      workspaceId,
      trigger: "SCHEDULED",
      status: "RUNNING",
      startedAt: NOW,
      ...overrides,
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  await resetTestDatabase();
});

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("alice");
  bob = await seedWorkspace("bob");
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("getQueueSnapshot", () => {
  it("counts nothing when the queue is empty", async () => {
    const snapshot = await getQueueSnapshot(alice.workspaceId, NOW);

    expect(snapshot).toEqual({
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      retrying: 0,
      scheduled: 0,
    });
  });

  it("separates a first attempt from a retry", async () => {
    await makeJob(alice.workspaceId, { attempts: 0 });
    await makeJob(alice.workspaceId, { attempts: 1, runAfter: new Date(NOW.getTime() + 60_000) });
    await makeJob(alice.workspaceId, { attempts: 2, status: "FAILED", completedAt: NOW });
    await makeJob(alice.workspaceId, { status: "RUNNING", attempts: 1, lockedBy: "worker-1" });
    await makeJob(alice.workspaceId, { status: "SUCCEEDED", attempts: 1, completedAt: NOW });
    await makeJob(alice.workspaceId, { status: "CANCELLED", attempts: 0, completedAt: NOW });

    const snapshot = await getQueueSnapshot(alice.workspaceId, NOW);

    expect(snapshot.pending).toBe(2);
    // One of those has already been attempted: that is a retry in waiting.
    expect(snapshot.retrying).toBe(1);
    // ...and only that one is waiting on a backoff.
    expect(snapshot.scheduled).toBe(1);
    expect(snapshot.running).toBe(1);
    expect(snapshot.failed).toBe(1);
    expect(snapshot.succeeded).toBe(1);
    expect(snapshot.cancelled).toBe(1);
  });

  it("does not count another workspace's queue", async () => {
    await makeJob(bob.workspaceId, { status: "RUNNING" });

    const snapshot = await getQueueSnapshot(alice.workspaceId, NOW);

    expect(snapshot.running).toBe(0);
  });
});

describe("getRecentFailures", () => {
  it("returns nothing when nothing failed", async () => {
    await makeJob(alice.workspaceId, { status: "SUCCEEDED", completedAt: NOW });

    expect(await getRecentFailures(alice.workspaceId)).toEqual([]);
  });

  it("returns failed jobs with their stored category and message", async () => {
    await makeJob(alice.workspaceId, {
      status: "FAILED",
      attempts: 3,
      maxAttempts: 3,
      completedAt: minutes(5),
      error: "No page could be read",
      result: {
        error: {
          category: "TIMEOUT",
          message: "No page could be read",
          attempt: 3,
          at: minutes(5).toISOString(),
        },
      },
    });

    const [failure] = await getRecentFailures(alice.workspaceId);

    expect(failure.type).toBe("CRAWL_SOURCE");
    expect(failure.status).toBe("FAILED");
    expect(failure.error).toBe("No page could be read");
    expect(failure.errorCategory).toBe("TIMEOUT");
    expect(failure.attempts).toBe(3);
    expect(failure.maxAttempts).toBe(3);
  });

  it("reports a job whose error predates structured failures without inventing a category", async () => {
    await makeJob(alice.workspaceId, {
      status: "FAILED",
      attempts: 1,
      completedAt: minutes(1),
      error: "legacy failure",
    });

    const [failure] = await getRecentFailures(alice.workspaceId);

    expect(failure.error).toBe("legacy failure");
    expect(failure.errorCategory).toBeNull();
  });

  it("does not surface another workspace's failures", async () => {
    await makeJob(bob.workspaceId, { status: "FAILED", completedAt: NOW, error: "bob's problem" });

    expect(await getRecentFailures(alice.workspaceId)).toEqual([]);
  });
});

describe("run detail", () => {
  it("reports the run's own counters and its own jobs", async () => {
    const run = await makeRun(alice.workspaceId, {
      status: "COMPLETED",
      completedAt: minutes(10),
      pagesAttempted: 9,
      pagesSucceeded: 7,
      pagesFailed: 2,
      pagesBlocked: 1,
      companiesDiscovered: 3,
      companiesMatched: 4,
      duplicatesPrevented: 1,
      signalsDiscovered: 5,
      opportunitiesDiscovered: 2,
      contactsDiscovered: 0,
      leadsCreated: 6,
      leadsUpdated: 1,
    });

    await makeJob(alice.workspaceId, {
      discoveryRunId: run.id,
      status: "SUCCEEDED",
      attempts: 1,
      completedAt: minutes(11),
    });
    await makeJob(alice.workspaceId, {
      discoveryRunId: run.id,
      status: "PENDING",
      attempts: 0,
    });

    const detail = await getRunDetail(alice.workspaceId, run.id);
    expect(detail).not.toBeNull();

    expect(detail?.run.counters.pagesSucceeded).toBe(7);
    expect(detail?.run.counters.companiesDiscovered).toBe(3);
    expect(detail?.run.counters.leadsCreated).toBe(6);
    // Contacts have no producer in this build; the counter is reported as the
    // zero it is rather than being filled from something adjacent.
    expect(detail?.run.counters.contactsDiscovered).toBe(0);
    expect(detail?.run.jobs).toEqual({
      total: 2,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      active: 1,
    });
    expect(detail?.jobs).toHaveLength(2);
  });

  it("does not resolve another workspace's run", async () => {
    const run = await makeRun(bob.workspaceId);

    expect(await getRunDetail(alice.workspaceId, run.id)).toBeNull();
  });

  it("does not resolve another workspace's job", async () => {
    const job = await makeJob(bob.workspaceId);

    expect(await getJobDetail(alice.workspaceId, job.id)).toBeNull();
  });

  it("returns a job's lease holder, so a stuck job is identifiable", async () => {
    const job = await makeJob(alice.workspaceId, {
      status: "RUNNING",
      attempts: 1,
      lockedBy: "worker-abc",
      lockedUntil: new Date(NOW.getTime() + 60_000),
    });

    const detail = await getJobDetail(alice.workspaceId, job.id);

    expect(detail?.lockedBy).toBe("worker-abc");
    expect(detail?.lockedUntil).toEqual(new Date(NOW.getTime() + 60_000));
  });
});

describe("getRecentRuns", () => {
  it("lists a workspace's runs newest first and nothing else", async () => {
    await makeRun(alice.workspaceId, { startedAt: minutes(30), status: "COMPLETED" });
    await makeRun(alice.workspaceId, { startedAt: minutes(5) });
    await makeRun(bob.workspaceId, { startedAt: minutes(1) });

    const runs = await getRecentRuns(alice.workspaceId);

    expect(runs).toHaveLength(2);
    expect(runs[0].startedAt).toEqual(minutes(5));
    expect(runs[1].startedAt).toEqual(minutes(30));
  });
});

describe("run provenance", () => {
  it("records a manually requested cycle as manual, not as scheduled", async () => {
    const job = await makeJob(alice.workspaceId, {
      type: "DISCOVERY_RUN",
      payload: { trigger: "MANUAL" },
    });

    await JOB_HANDLERS.DISCOVERY_RUN({
      workspaceId: alice.workspaceId,
      jobId: job.id,
      payload: { trigger: "MANUAL" },
      discoveryRunId: null,
    });

    const runs = await getRecentRuns(alice.workspaceId);

    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("MANUAL");
  });

  it("does not copy an unrecognised trigger value into the run", async () => {
    const job = await makeJob(alice.workspaceId, {
      type: "DISCOVERY_RUN",
      payload: { trigger: "ANYTHING_ELSE" },
    });

    await JOB_HANDLERS.DISCOVERY_RUN({
      workspaceId: alice.workspaceId,
      jobId: job.id,
      payload: { trigger: "ANYTHING_ELSE" },
      discoveryRunId: null,
    });

    const runs = await getRecentRuns(alice.workspaceId);

    expect(runs[0].trigger).toBe("SCHEDULED");
  });

  it("records a scheduled cycle as scheduled", async () => {
    const job = await makeJob(alice.workspaceId, { type: "DISCOVERY_RUN", payload: {} });

    await JOB_HANDLERS.DISCOVERY_RUN({
      workspaceId: alice.workspaceId,
      jobId: job.id,
      payload: {},
      discoveryRunId: null,
    });

    const runs = await getRecentRuns(alice.workspaceId);

    expect(runs[0].trigger).toBe("SCHEDULED");
  });
});

describe("getScheduleFor", () => {
  it("tells a workspace that has never run that its first cycle is due now", async () => {
    const { decision, timezone } = getScheduleFor(
      "Asia/Kolkata",
      { lastStartedAt: null, lastCompletedAt: null, running: false },
      NOW,
    );

    expect(timezone).toBe("Asia/Kolkata");
    expect(decision.action).toBe("RUN");
    expect(decision.reason).toBe("FIRST_RUN");
  });

  it("puts the next cycle at the workspace's own local hour", async () => {
    // 09:00 in Kolkata is 03:30Z; the day's second cycle is 21:00 local, 15:30Z.
    const { decision } = getScheduleFor(
      "Asia/Kolkata",
      { lastStartedAt: new Date("2026-09-22T03:30:00Z"), lastCompletedAt: null, running: false },
      NOW,
    );

    expect(decision.action).toBe("WAIT");
    if (decision.action !== "WAIT") throw new Error("expected a wait decision");

    expect(decision.reason).toBe("ALREADY_RAN");
    expect(decision.nextRunAt).toEqual(new Date("2026-09-22T15:30:00Z"));
  });

  it("does not schedule a second cycle while one is running", async () => {
    const { decision } = getScheduleFor(
      "Asia/Kolkata",
      { lastStartedAt: minutes(1), lastCompletedAt: null, running: true },
      NOW,
    );

    expect(decision.action).toBe("WAIT");
    expect(decision.reason).toBe("ALREADY_RUNNING");
  });
});

describe("getWorkerLiveness", () => {
  it("reports no worker when none has ever started", async () => {
    const liveness = await getWorkerLiveness(NOW);

    expect(liveness.count).toBe(0);
    expect(liveness.newest).toBeNull();
    expect(liveness.staleAfterMs).toBe(WORKER_STALE_AFTER_MS);
  });

  it("counts a worker that has heartbeat recently", async () => {
    await db.workerHeartbeat.create({
      data: { workerId: "worker-a", startedAt: minutes(20), lastSeenAt: minutes(1) },
    });

    const liveness = await getWorkerLiveness(NOW);

    expect(liveness.count).toBe(1);
    expect(liveness.newest?.workerId).toBe("worker-a");
  });

  it("reports a dead worker as dead rather than as running", async () => {
    await db.workerHeartbeat.create({
      data: {
        workerId: "worker-dead",
        startedAt: minutes(120),
        lastSeenAt: new Date(NOW.getTime() - WORKER_STALE_AFTER_MS - 1_000),
      },
    });

    const liveness = await getWorkerLiveness(NOW);

    expect(liveness.count).toBe(0);
    // Remembered, but not claimed to be alive.
    expect(liveness.newest?.workerId).toBe("worker-dead");
  });
});

describe("getAutomationOverview", () => {
  it("reports an empty workspace as empty", async () => {
    const overview = await getAutomationOverview(alice.workspaceId, {
      timezone: "Asia/Kolkata",
      now: NOW,
    });

    expect(overview.currentRun).toBeNull();
    expect(overview.lastRun).toBeNull();
    expect(overview.recentRuns).toEqual([]);
    expect(overview.recentFailures).toEqual([]);
    expect(overview.blockedFetches).toEqual([]);
    expect(overview.sources).toEqual({ enabled: 0, paused: 0, blockedLast30d: 0 });
    expect(overview.research).toEqual({
      researchedRecently: 0,
      needsReview: 0,
      blocked: 0,
      never: 0,
    });
  });

  it("prefers the running cycle for currentRun and the newest for lastRun", async () => {
    await makeRun(alice.workspaceId, {
      status: "COMPLETED",
      startedAt: minutes(600),
      completedAt: minutes(590),
    });
    const running = await makeRun(alice.workspaceId, { startedAt: minutes(3) });

    const overview = await getAutomationOverview(alice.workspaceId, {
      timezone: "Asia/Kolkata",
      now: NOW,
    });

    expect(overview.currentRun?.id).toBe(running.id);
    expect(overview.lastRun?.id).toBe(running.id);
  });

  it("counts research from the company records, not from run counters", async () => {
    await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Recent Ltd",
        canonicalName: "recent ltd",
        researchStatus: "RESEARCHED",
        lastResearchAt: minutes(60),
      },
    });
    await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Old Ltd",
        canonicalName: "old ltd",
        researchStatus: "STALE",
        lastResearchAt: new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000),
      },
    });
    await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Unreadable Ltd",
        canonicalName: "unreadable ltd",
        researchStatus: "NEEDS_REVIEW",
        lastResearchAt: minutes(30),
      },
    });
    await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Blocked Ltd",
        canonicalName: "blocked ltd",
        researchStatus: "BLOCKED",
        lastResearchAt: minutes(30),
      },
    });
    await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Unknown Ltd",
        canonicalName: "unknown ltd",
        researchStatus: "NEVER",
      },
    });

    const overview = await getAutomationOverview(alice.workspaceId, {
      timezone: "Asia/Kolkata",
      now: NOW,
    });

    expect(overview.research.researchedRecently).toBe(3);
    expect(overview.research.needsReview).toBe(1);
    expect(overview.research.blocked).toBe(1);
    expect(overview.research.never).toBe(1);
  });

  it("counts sources and shows recent refusals by URL", async () => {
    const source = await db.source.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Directory",
        provider: "sitemap",
        url: "https://directory.test/",
        enabled: true,
      },
      select: { id: true },
    });

    await db.source.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Paused",
        provider: "sitemap",
        url: "https://paused.test/",
        enabled: false,
      },
    });

    await db.fetchLog.create({
      data: {
        workspaceId: alice.workspaceId,
        sourceId: source.id,
        url: "https://directory.test/private",
        outcome: "BLOCKED",
        statusCode: 403,
        fetchedAt: minutes(10),
      },
    });

    await db.fetchLog.create({
      data: {
        workspaceId: alice.workspaceId,
        sourceId: null,
        url: "https://unreachable.test/",
        outcome: "TIMEOUT",
        fetchedAt: minutes(11),
      },
    });

    const overview = await getAutomationOverview(alice.workspaceId, {
      timezone: "Asia/Kolkata",
      now: NOW,
    });

    expect(overview.sources.enabled).toBe(1);
    expect(overview.sources.paused).toBe(1);
    // Only the refusal counts as blocked; a timeout is a different fact.
    expect(overview.sources.blockedLast30d).toBe(1);
    expect(overview.blockedFetches).toHaveLength(1);
    expect(overview.blockedFetches[0].url).toBe("https://directory.test/private");
    expect(overview.blockedFetches[0].sourceName).toBe("Directory");
  });

  it("reports the next cycle the worker would actually queue", async () => {
    await makeRun(alice.workspaceId, {
      status: "COMPLETED",
      startedAt: new Date("2026-09-22T03:30:00Z"),
      completedAt: new Date("2026-09-22T03:40:00Z"),
    });

    const overview = await getAutomationOverview(alice.workspaceId, {
      timezone: "Asia/Kolkata",
      now: NOW,
    });

    expect(overview.schedule.action).toBe("WAIT");
    expect(overview.nextRun?.at).toEqual(new Date("2026-09-22T15:30:00Z"));
    expect(overview.nextRun?.reason).toBe("ALREADY_RAN");
  });

  it("does not count another workspace's rows in any figure", async () => {
    await makeRun(bob.workspaceId);
    await makeJob(bob.workspaceId, { status: "FAILED", completedAt: NOW });
    await db.company.create({
      data: {
        workspaceId: bob.workspaceId,
        name: "Bob Ltd",
        canonicalName: "bob ltd",
        researchStatus: "NEEDS_REVIEW",
        lastResearchAt: minutes(5),
      },
    });
    await db.fetchLog.create({
      data: {
        workspaceId: bob.workspaceId,
        url: "https://bob.test/",
        outcome: "BLOCKED",
        fetchedAt: minutes(5),
      },
    });

    const overview = await getAutomationOverview(alice.workspaceId, {
      timezone: "Asia/Kolkata",
      now: NOW,
    });

    expect(overview.currentRun).toBeNull();
    expect(overview.lastRun).toBeNull();
    expect(overview.queue.failed).toBe(0);
    expect(overview.queue.succeeded).toBe(0);
    expect(overview.recentFailures).toEqual([]);
    expect(overview.research.researchedRecently).toBe(0);
    expect(overview.research.needsReview).toBe(0);
    expect(overview.sources.blockedLast30d).toBe(0);
    expect(overview.blockedFetches).toEqual([]);
  });
});
