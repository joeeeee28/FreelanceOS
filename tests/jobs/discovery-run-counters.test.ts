/**
 * DiscoveryRun counters.
 *
 * These cover the requirement that a run's numbers describe *that run's* work:
 * every child job is linked to its run, and the counters are aggregated from
 * the structured results those jobs wrote — never from a workspace total, a
 * timestamp, or a guess about what a job probably did.
 *
 * The property that matters most here is idempotency. A queue is at-least-once,
 * a worker can be killed mid-cycle, a lease can be renewed, and two workers can
 * race for the final job of a run. Counting is therefore a *recomputation* from
 * the run's own committed job rows, which is what makes all of those cases
 * yield the same answer rather than an inflated one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";

const { completeJob, enqueueJob, failJob, claimNextJob } = await import("@/lib/jobs/queue");
const { reconcileDiscoveryRuns, settleDiscoveryRun } = await import("@/lib/discovery/runs");
const { totalRunCounters } = await import("@/lib/discovery/run-counters");
const { runWorker } = await import("@/lib/jobs/worker");
const { JOB_HANDLERS } = await import("@/lib/jobs/handlers");
const { decideSchedule, discoveryCycleKey } = await import("@/lib/discovery/scheduler");

const noSleep = async () => {};

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

/** A run as the DISCOVERY_RUN handler creates it. */
async function startRun(workspaceId = alice.workspaceId) {
  return db.discoveryRun.create({
    data: { workspaceId, status: "RUNNING", trigger: "SCHEDULED" },
  });
}

/** A child job of a run, as the fan-out handler queues it. */
async function enqueueChild(
  discoveryRunId: string,
  options: {
    workspaceId?: string;
    type?: "CRAWL_SOURCE" | "RESEARCH_COMPANY" | "EXTRACT_SIGNALS" | "UPDATE_CRM";
    key?: string;
    payload?: Record<string, unknown>;
  } = {},
) {
  return enqueueJob({
    workspaceId: options.workspaceId ?? alice.workspaceId,
    type: options.type ?? "CRAWL_SOURCE",
    discoveryRunId,
    idempotencyKey: options.key,
    payload: options.payload ?? {},
  });
}

/**
 * Finishes a job the way the worker does when a handler reported counters:
 * the numbers live on the job's own result.
 */
async function finishWith(
  discoveryRunId: string,
  counters: Record<string, number>,
  options: { workspaceId?: string } = {},
) {
  const job = await enqueueChild(discoveryRunId, options);
  await completeJob(job.id, { summary: "test", enqueued: 0, counters });
  return job;
}

async function countersOf(discoveryRunId: string) {
  const run = await db.discoveryRun.findUniqueOrThrow({
    where: { id: discoveryRunId },
    include: { jobs: { select: { status: true, result: true } } },
  });
  return run;
}

describe("single-source run", () => {
  it("reports exactly what the one job produced", async () => {
    const run = await startRun();

    await finishWith(run.id, {
      pagesAttempted: 4,
      pagesSucceeded: 3,
      pagesFailed: 1,
      pagesBlocked: 0,
      companiesDiscovered: 2,
      companiesMatched: 1,
      duplicatesPrevented: 5,
    });

    const settled = await countersOf(run.id);

    expect(settled.status).toBe("COMPLETED");
    expect(settled.pagesAttempted).toBe(4);
    expect(settled.pagesSucceeded).toBe(3);
    expect(settled.pagesFailed).toBe(1);
    expect(settled.companiesDiscovered).toBe(2);
    expect(settled.companiesMatched).toBe(1);
    expect(settled.duplicatesPrevented).toBe(5);
    // Counters with no producer in this job stay at their default.
    expect(settled.leadsCreated).toBe(0);
    expect(settled.signalsDiscovered).toBe(0);
  });
});

describe("multi-source run", () => {
  it("sums the results of several successful jobs", async () => {
    const run = await startRun();

    // The fan-out queues every child before any of them finishes, which is
    // what keeps the run RUNNING (and its counters growing) until the last one
    // is done.
    const first = await enqueueChild(run.id, { key: `one:${run.id}` });
    const second = await enqueueChild(run.id, { key: `two:${run.id}` });
    const third = await enqueueChild(run.id, { key: `three:${run.id}` });

    await completeJob(first.id, {
      counters: { pagesAttempted: 3, pagesSucceeded: 3, companiesDiscovered: 1 },
    });

    const midway = await countersOf(run.id);
    expect(midway.status).toBe("RUNNING");
    expect(midway.pagesAttempted).toBe(3);

    await completeJob(second.id, {
      counters: { pagesAttempted: 2, pagesSucceeded: 1, pagesFailed: 1 },
    });
    await completeJob(third.id, {
      counters: {
        pagesAttempted: 5,
        pagesSucceeded: 4,
        pagesBlocked: 1,
        companiesMatched: 2,
        signalsDiscovered: 3,
        opportunitiesDiscovered: 1,
        contactsDiscovered: 4,
        leadsCreated: 2,
        leadsUpdated: 1,
      },
    });

    const run_ = await countersOf(run.id);

    expect(run_.status).toBe("COMPLETED");
    expect(run_.pagesAttempted).toBe(10);
    expect(run_.pagesSucceeded).toBe(8);
    expect(run_.pagesFailed).toBe(1);
    expect(run_.pagesBlocked).toBe(1);
    expect(run_.companiesDiscovered).toBe(1);
    expect(run_.companiesMatched).toBe(2);
    expect(run_.signalsDiscovered).toBe(3);
    expect(run_.opportunitiesDiscovered).toBe(1);
    expect(run_.contactsDiscovered).toBe(4);
    expect(run_.leadsCreated).toBe(2);
    expect(run_.leadsUpdated).toBe(1);
  });

  it("counts each job once however many times it is retried", async () => {
    const run = await startRun();
    await enqueueChild(run.id, { key: `retry:${run.id}` });

    // Attempt one: the handler fails after doing partial work.
    const first = await claimNextJob("w-a");
    if (first === null) throw new Error("expected a claimable job");
    await failJob(first.id, "temporary", { retryable: true });

    // The retry runs the same job: one row, one result. The claim is made at a
    // time past the retry backoff the failure scheduled.
    const second = await claimNextJob("w-a", {
      now: new Date(Date.now() + 60 * 60 * 1000),
    });
    if (second === null) throw new Error("expected the retry to be claimable");
    await completeJob(second.id, {
      summary: "second attempt",
      enqueued: 0,
      counters: { pagesAttempted: 3, pagesSucceeded: 3, companiesDiscovered: 2 },
    });

    const settled = await countersOf(run.id);
    const rows = await db.job.count({ where: { discoveryRunId: run.id } });

    expect(rows).toBe(1);
    expect(settled.status).toBe("COMPLETED");
    expect(settled.pagesAttempted).toBe(3);
    expect(settled.companiesDiscovered).toBe(2);
  });
});

describe("failure handling", () => {
  it("keeps a failed source linked, keeps its error, and adds no counters", async () => {
    const run = await startRun();

    await finishWith(run.id, { pagesAttempted: 2, pagesSucceeded: 2 });
    const failing = await enqueueChild(run.id, { type: "CRAWL_SOURCE" });
    await failJob(failing.id, "site refused the connection", { retryable: false });

    const settled = await countersOf(run.id);
    const failed = await db.job.findUniqueOrThrow({ where: { id: failing.id } });

    expect(settled.status).toBe("COMPLETED");
    expect(settled.pagesAttempted).toBe(2);
    expect(failed.discoveryRunId).toBe(run.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toContain("refused");
  });

  it("records a run where every source failed as FAILED with zero counters", async () => {
    const run = await startRun();

    for (const key of ["a", "b"]) {
      const job = await enqueueChild(run.id, { key: `${key}:${run.id}` });
      await failJob(job.id, `boom ${key}`, { retryable: false });
    }

    const settled = await countersOf(run.id);

    expect(settled.status).toBe("FAILED");
    expect(settled.error).toContain("No job in this run succeeded");
    expect(settled.pagesAttempted).toBe(0);
    expect(settled.companiesDiscovered).toBe(0);
    expect(
      await db.job.count({ where: { discoveryRunId: run.id, status: "FAILED" } }),
    ).toBe(2);
  });

  it("reports zero results from a source that found nothing", async () => {
    const run = await startRun();

    await finishWith(run.id, {
      pagesAttempted: 2,
      pagesSucceeded: 2,
      companiesDiscovered: 0,
      companiesMatched: 0,
    });

    const settled = await countersOf(run.id);

    expect(settled.status).toBe("COMPLETED");
    expect(settled.pagesAttempted).toBe(2);
    expect(settled.companiesDiscovered).toBe(0);
    expect(await db.company.count({ where: { workspaceId: alice.workspaceId } })).toBe(0);
  });
});

describe("idempotency", () => {
  it("does not inflate counters when two workers finish the last jobs at once", async () => {
    const run = await startRun();

    const a = await enqueueChild(run.id, { key: `race-a:${run.id}` });
    const b = await enqueueChild(run.id, { key: `race-b:${run.id}` });

    await Promise.all([
      completeJob(a.id, { counters: { pagesAttempted: 2, companiesDiscovered: 1 } }),
      completeJob(b.id, { counters: { pagesAttempted: 3, companiesDiscovered: 2 } }),
    ]);

    const settled = await countersOf(run.id);

    expect(settled.status).toBe("COMPLETED");
    expect(settled.pagesAttempted).toBe(5);
    expect(settled.companiesDiscovered).toBe(3);
  });

  it("is unchanged by repeated settlement, reconciliation and duplicate execution", async () => {
    const run = await startRun();

    await finishWith(run.id, { pagesAttempted: 7, companiesDiscovered: 4, leadsCreated: 2 });

    const first = await countersOf(run.id);

    // Re-running the settle path — the reconciler, a restarted worker, a lease
    // renewal — must read the same rows and reach the same numbers.
    await settleDiscoveryRun(run.id);
    await settleDiscoveryRun(run.id);
    await reconcileDiscoveryRuns();
    await reconcileDiscoveryRuns();

    const after = await countersOf(run.id);

    expect(after.pagesAttempted).toBe(first.pagesAttempted);
    expect(after.companiesDiscovered).toBe(first.companiesDiscovered);
    expect(after.leadsCreated).toBe(first.leadsCreated);
    expect(after.completedAt?.getTime()).toBe(first.completedAt?.getTime());
    expect(after.status).toBe("COMPLETED");
  });

  it("never counts another run's results, even in the same workspace", async () => {
    const counted = await startRun();
    const other = await startRun();

    await finishWith(counted.id, { pagesAttempted: 2, companiesDiscovered: 1 });
    await finishWith(other.id, { pagesAttempted: 9, companiesDiscovered: 5, leadsCreated: 4 });

    const a = await countersOf(counted.id);
    const b = await countersOf(other.id);

    expect(a.pagesAttempted).toBe(2);
    expect(a.companiesDiscovered).toBe(1);
    expect(a.leadsCreated).toBe(0);
    expect(b.pagesAttempted).toBe(9);
    expect(b.companiesDiscovered).toBe(5);
  });

  it("ignores unlinked jobs and jobs from another workspace", async () => {
    const run = await startRun();

    await finishWith(run.id, { pagesAttempted: 1 });

    // A job with no run at all, and a job belonging to Bob's run: neither
    // belongs to this run and neither may contribute to it.
    const unlinked = await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "CRAWL_SOURCE",
      payload: {},
    });
    await completeJob(unlinked.id, { counters: { pagesAttempted: 50 } });

    const bobRun = await startRun(bob.workspaceId);
    await finishWith(bobRun.id, { pagesAttempted: 40, companiesDiscovered: 9 }, {
      workspaceId: bob.workspaceId,
    });

    const settled = await countersOf(run.id);

    expect(settled.pagesAttempted).toBe(1);
    expect(settled.companiesDiscovered).toBe(0);
  });

  it("keeps a run's counters as history once it has ended", async () => {
    const run = await startRun();
    await finishWith(run.id, { pagesAttempted: 2 });

    const finished = await countersOf(run.id);

    // A late job that somehow gets attached after settlement cannot rewrite the
    // record of what the run did.
    await db.job.create({
      data: {
        workspaceId: alice.workspaceId,
        type: "CRAWL_SOURCE",
        status: "SUCCEEDED",
        payload: {},
        result: { counters: { pagesAttempted: 500 } },
        discoveryRunId: run.id,
      },
    });

    await settleDiscoveryRun(run.id);

    const after = await countersOf(run.id);
    expect(after.pagesAttempted).toBe(finished.pagesAttempted);
    expect(after.status).toBe("COMPLETED");
  });
});

describe("aggregation input", () => {
  it("only counts succeeded jobs, and only sane whole numbers", async () => {
    const run = await startRun();

    await finishWith(run.id, { pagesAttempted: 3, companiesDiscovered: 1 });
    await finishWith(run.id, { pagesAttempted: -4, companiesDiscovered: 1.5 });

    const failed = await enqueueChild(run.id);
    await failJob(failed.id, "nope", { retryable: false });

    const rows = await db.job.findMany({
      where: { discoveryRunId: run.id },
      select: { status: true, result: true },
    });

    const totals = totalRunCounters(rows);

    expect(totals.pagesAttempted).toBe(3);
    expect(totals.companiesDiscovered).toBe(2);
  });
});

describe("counters produced by the real handlers", () => {
  it("links every job the fan-out queues, research included", async () => {
    const source = await db.source.create({
      data: { workspaceId: alice.workspaceId, provider: "manual-csv", name: "Alice source" },
    });
    const company = await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Researchable Co",
        canonicalName: "researchable co",
        canonicalDomain: "researchable.test",
      },
    });

    const parent = await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "DISCOVERY_RUN",
      payload: {},
    });
    const claimed = await claimNextJob("w-fanout");
    if (claimed === null) throw new Error("expected the fan-out job");
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
    const jobs = await db.job.findMany({ where: { discoveryRunId: run.id } });

    // The crawl, the research pass, and the fan-out job that queued them.
    expect(new Set(jobs.map((job) => job.type))).toEqual(
      new Set(["DISCOVERY_RUN", "CRAWL_SOURCE", "RESEARCH_COMPANY"]),
    );
    expect(jobs.every((job) => job.discoveryRunId === run.id)).toBe(true);
    expect(jobs).toHaveLength(3);

    // Each child is keyed to its own run, so a re-run of the same cycle
    // collapses onto the same row instead of queueing the work twice.
    const keys = jobs
      .map((job) => job.idempotencyKey)
      .filter((key): key is string => key !== null)
      .sort();
    expect(keys).toEqual(
      [`crawl:${run.id}:${source.id}`, `research:${run.id}:${company.id}`].sort(),
    );

    const linked = await db.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(linked.discoveryRunId).toBe(run.id);
    expect(run.status).toBe("RUNNING");
  });

  it("counts what the signal and CRM handlers actually wrote", async () => {
    // Contactable but with no website: the rules fire WEBSITE_MISSING from
    // facts alone, which needs no network and no fixture.
    const company = await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Contactable Co",
        canonicalName: "contactable co",
        email: "hello@contactable.test",
      },
    });

    // A lead exists, so the CRM sync updates it instead of skipping.
    await db.lead.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        companyName: "Contactable Co",
      },
    });

    const run = await startRun();
    await enqueueChild(run.id, {
      type: "EXTRACT_SIGNALS",
      key: `signals:${run.id}`,
      payload: { companyId: company.id },
    });

    // The worker runs the signal pass, which queues the CRM sync, which the
    // same worker then runs: the real chain, with the real counters.
    await runWorker({ workerId: "w-real", maxJobs: 3, sleep: noSleep });

    const settled = await countersOf(run.id);
    const signals = await db.signal.count({ where: { companyId: company.id } });
    const opportunities = await db.opportunity.count({ where: { companyId: company.id } });
    const jobs = await db.job.findMany({ where: { discoveryRunId: run.id } });

    expect(jobs.map((job) => job.type).sort()).toEqual(["EXTRACT_SIGNALS", "UPDATE_CRM"]);
    expect(signals).toBeGreaterThan(0);
    expect(settled.signalsDiscovered).toBe(signals);
    expect(settled.opportunitiesDiscovered).toBe(opportunities);
    expect(settled.leadsCreated + settled.leadsUpdated).toBe(1);
    expect(settled.pagesAttempted).toBe(0);
  });

  it("does not count a re-run of the same work twice", async () => {
    const company = await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Stable Co",
        canonicalName: "stable co",
        email: "hello@stable.test",
      },
    });

    // Two runs, each with its own signal pass over the same company.
    const first = await startRun();
    await enqueueChild(first.id, {
      type: "EXTRACT_SIGNALS",
      key: `signals-a:${first.id}`,
      payload: { companyId: company.id },
    });
    await runWorker({ workerId: "w-1", maxJobs: 2, sleep: noSleep });

    const second = await startRun();
    await enqueueChild(second.id, {
      type: "EXTRACT_SIGNALS",
      key: `signals-b:${second.id}`,
      payload: { companyId: company.id },
    });
    await runWorker({ workerId: "w-2", maxJobs: 2, sleep: noSleep });

    const a = await countersOf(first.id);
    const b = await countersOf(second.id);

    // The signals already existed, so the second run discovered nothing.
    expect(a.signalsDiscovered).toBeGreaterThan(0);
    expect(b.signalsDiscovered).toBe(0);
    expect(b.opportunitiesDiscovered).toBe(0);
    expect(await db.signal.count({ where: { companyId: company.id } })).toBe(a.signalsDiscovered);
  });
});

describe("the whole chain", () => {
  it("runs a scheduled cycle end to end and settles it with real counters", async () => {
    // A company pointing at a loopback address. The production fetch stack's
    // SSRF guard refuses it, which is the honest end of the chain for us to
    // exercise here: nothing is fetched, nothing is invented, and the refusal
    // is still reported as the pages the pass tried to read.
    const company = await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Unreachable Co",
        canonicalName: "unreachable co",
        website: "http://127.0.0.1:1",
      },
      select: { id: true },
    });

    const timezone = "Asia/Kolkata";
    const now = new Date("2026-03-10T03:30:00Z"); // 09:00 IST

    // What the worker's scheduler tick does: decide, then key the cycle on the
    // workspace's local slot.
    const decision = decideSchedule(
      { timezone },
      { lastStartedAt: null, lastCompletedAt: null, running: false },
      now,
    );
    expect(decision.action).toBe("RUN");
    if (decision.action !== "RUN") throw new Error("unreachable");

    const key = discoveryCycleKey(alice.workspaceId, timezone, decision, now);
    const first = await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "DISCOVERY_RUN",
      idempotencyKey: key,
      priority: 50,
      payload: {},
    });

    // A second poll in the same slot must collapse onto the same job.
    const again = await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "DISCOVERY_RUN",
      idempotencyKey: key,
      priority: 50,
      payload: {},
    });
    expect(again.id).toBe(first.id);
    expect(await db.job.count({ where: { type: "DISCOVERY_RUN" } })).toBe(1);

    await runWorker({ workerId: "w-chain", maxJobs: 4, sleep: noSleep });

    const run = await db.discoveryRun.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });
    const jobs = await db.job.findMany({ where: { discoveryRunId: run.id } });

    expect(run.status).toBe("COMPLETED");
    expect(run.completedAt).not.toBeNull();
    expect(new Set(jobs.map((job) => job.type))).toEqual(
      new Set(["DISCOVERY_RUN", "RESEARCH_COMPANY"]),
    );
    expect(jobs.every((job) => job.status === "SUCCEEDED")).toBe(true);
    expect(jobs.every((job) => job.discoveryRunId === run.id)).toBe(true);

    // The counters came from the research pass's own tally of what it tried.
    expect(run.pagesAttempted).toBeGreaterThan(0);
    expect(run.pagesBlocked).toBeGreaterThan(0);
    expect(run.pagesSucceeded).toBe(0);
    expect(run.pagesFailed + run.pagesBlocked).toBe(run.pagesAttempted);
    expect(run.companiesDiscovered).toBe(0);

    const researchJob = jobs.find((job) => job.type === "RESEARCH_COMPANY");
    expect(researchJob?.payload).toEqual({ companyId: company.id });

    // Nothing was invented for a site that never answered.
    expect(await db.observation.count({ where: { companyId: company.id } })).toBe(0);
    const stored = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(stored.email).toBeNull();
    expect(stored.lastResearchAt).not.toBeNull();
  });
});
