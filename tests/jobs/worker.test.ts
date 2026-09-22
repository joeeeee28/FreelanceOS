import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const { enqueueJob } = await import("@/lib/jobs/queue");
const { runWorker } = await import("@/lib/jobs/worker");
const { JOB_HANDLERS } = await import("@/lib/jobs/handlers");

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

const noSleep = async () => {};

describe("the handler table", () => {
  it("has an entry for every job type", async () => {
    // A missing handler would fill the queue with permanently failing jobs.
    const types = Object.keys(JOB_HANDLERS);
    expect(types).toContain("DISCOVERY_RUN");
    expect(types).toContain("CRAWL_SOURCE");
    expect(types).toContain("EXTRACT_SIGNALS");
    expect(types).toContain("UPDATE_CRM");
    expect(types).toContain("RESEARCH_COMPANY");
    expect(types).toContain("KNOWLEDGE_INGESTION");
    expect(types).toContain("RESOLVE_ENTITY");
    expect(types).toContain("KNOWLEDGE_PROCESSING");
    expect(types).toContain("MARKET_ANALYSIS");
  });

  it("reports an unimplemented type truthfully rather than throwing", async () => {
    const result = await JOB_HANDLERS.MARKET_ANALYSIS({
      workspaceId: alice.workspaceId,
      jobId: "j1",
      payload: {},
      discoveryRunId: null,
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("no handler");
  });
});

describe("runWorker", () => {
  it("claims and completes a job", async () => {
    const job = await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "MARKET_ANALYSIS",
    });

    const stats = await runWorker({ maxJobs: 1, sleep: noSleep });

    expect(stats.completed).toBe(1);

    const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("SUCCEEDED");
    expect(after.lockedBy).toBeNull();
  });

  it("stops when the queue is empty", async () => {
    const stats = await runWorker({ maxJobs: 5, sleep: noSleep });

    expect(stats.claimed).toBe(0);
  });

  it("processes several jobs in one pass", async () => {
    for (let i = 0; i < 3; i++) {
      await enqueueJob({ workspaceId: alice.workspaceId, type: "MARKET_ANALYSIS" });
    }

    const stats = await runWorker({ maxJobs: 3, sleep: noSleep });

    expect(stats.completed).toBe(3);
  });

  it("stops immediately when already aborted", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "MARKET_ANALYSIS" });

    const controller = new AbortController();
    controller.abort();

    const stats = await runWorker({ signal: controller.signal, sleep: noSleep });

    expect(stats.claimed).toBe(0);
  });

  describe("failure handling", () => {
    it("fails a job whose payload is unusable, and retries it", async () => {
      // CRAWL_SOURCE with no sourceId cannot proceed.
      const job = await enqueueJob({
        workspaceId: alice.workspaceId,
        type: "CRAWL_SOURCE",
        payload: {},
      });

      const stats = await runWorker({ maxJobs: 1, sleep: noSleep });

      expect(stats.failed).toBe(1);

      const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      // Attempts remain, so it goes back to PENDING rather than dying.
      expect(after.status).toBe("PENDING");
      expect(after.error).toContain("sourceId");
    });

    it("gives up after exhausting attempts", async () => {
      const job = await enqueueJob({
        workspaceId: alice.workspaceId,
        type: "CRAWL_SOURCE",
        payload: {},
        maxAttempts: 1,
      });

      await runWorker({ maxJobs: 1, sleep: noSleep });

      const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.status).toBe("FAILED");
    });

    it("keeps working after one job fails", async () => {
      await enqueueJob({
        workspaceId: alice.workspaceId,
        type: "CRAWL_SOURCE",
        payload: {},
        priority: 1,
      });
      await enqueueJob({
        workspaceId: alice.workspaceId,
        type: "MARKET_ANALYSIS",
        priority: 2,
      });

      const stats = await runWorker({ maxJobs: 2, sleep: noSleep });

      expect(stats.failed).toBe(1);
      expect(stats.completed).toBe(1);
    });
  });

  it("emits events for observability", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "MARKET_ANALYSIS" });

    const kinds: string[] = [];
    await runWorker({
      maxJobs: 1,
      sleep: noSleep,
      onEvent: (event) => kinds.push(event.kind),
    });

    expect(kinds).toContain("CLAIMED");
    expect(kinds).toContain("COMPLETED");
  });

  it("does not run two workers on the same job", async () => {
    for (let i = 0; i < 4; i++) {
      await enqueueJob({ workspaceId: alice.workspaceId, type: "MARKET_ANALYSIS" });
    }

    const [a, b] = await Promise.all([
      runWorker({ workerId: "w-a", maxJobs: 4, sleep: noSleep }),
      runWorker({ workerId: "w-b", maxJobs: 4, sleep: noSleep }),
    ]);

    // Between them they do exactly the available work, never double.
    expect(a.claimed + b.claimed).toBe(4);
    expect(await db.job.count({ where: { status: "SUCCEEDED" } })).toBe(4);
  });
});

describe("the discovery cycle", () => {
  it("fans out one crawl job per enabled source", async () => {
    await db.source.create({
      data: { workspaceId: alice.workspaceId, provider: "manual-csv", name: "A" },
    });
    await db.source.create({
      data: { workspaceId: alice.workspaceId, provider: "manual-csv", name: "B" },
    });

    await enqueueJob({ workspaceId: alice.workspaceId, type: "DISCOVERY_RUN" });
    await runWorker({ maxJobs: 1, sleep: noSleep });

    const crawls = await db.job.findMany({ where: { type: "CRAWL_SOURCE" } });
    expect(crawls).toHaveLength(2);

    // A run record is created so the statistics are counted, not estimated.
    expect(await db.discoveryRun.count({ where: { workspaceId: alice.workspaceId } })).toBe(1);
  });

  it("ignores disabled and paused sources", async () => {
    await db.source.create({
      data: {
        workspaceId: alice.workspaceId,
        provider: "manual-csv",
        name: "off",
        enabled: false,
      },
    });
    await db.source.create({
      data: {
        workspaceId: alice.workspaceId,
        provider: "manual-csv",
        name: "paused",
        status: "PAUSED",
      },
    });

    await enqueueJob({ workspaceId: alice.workspaceId, type: "DISCOVERY_RUN" });
    await runWorker({ maxJobs: 1, sleep: noSleep });

    expect(await db.job.count({ where: { type: "CRAWL_SOURCE" } })).toBe(0);
  });

  it("queues research for known companies", async () => {
    await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Acme",
        canonicalName: "acme",
        canonicalDomain: "acme.test",
      },
    });

    await enqueueJob({ workspaceId: alice.workspaceId, type: "DISCOVERY_RUN" });
    await runWorker({ maxJobs: 1, sleep: noSleep });

    // Refreshing what we know matters as much as finding something new.
    expect(await db.job.count({ where: { type: "RESEARCH_COMPANY" } })).toBe(1);
  });

  it("completes a cycle with nothing to do", async () => {
    await enqueueJob({ workspaceId: alice.workspaceId, type: "DISCOVERY_RUN" });
    const stats = await runWorker({ maxJobs: 1, sleep: noSleep });

    expect(stats.completed).toBe(1);

    const run = await db.discoveryRun.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });
    expect(run.status).toBe("COMPLETED");
  });

  it("does not queue work across workspaces", async () => {
    await db.source.create({
      data: { workspaceId: bob.workspaceId, provider: "manual-csv", name: "bob" },
    });

    await enqueueJob({ workspaceId: alice.workspaceId, type: "DISCOVERY_RUN" });
    await runWorker({ maxJobs: 1, sleep: noSleep });

    expect(await db.job.count({ where: { type: "CRAWL_SOURCE" } })).toBe(0);
  });

  describe("idempotency", () => {
    it("does not duplicate crawl jobs within one cycle", async () => {
      const source = await db.source.create({
        data: { workspaceId: alice.workspaceId, provider: "manual-csv", name: "A" },
      });

      await enqueueJob({
        workspaceId: alice.workspaceId,
        type: "DISCOVERY_RUN",
        idempotencyKey: "cycle:test",
      });
      await enqueueJob({
        workspaceId: alice.workspaceId,
        type: "DISCOVERY_RUN",
        idempotencyKey: "cycle:test",
      });

      await runWorker({ maxJobs: 5, sleep: noSleep });

      // Two enqueues of one cycle produce one cycle, hence one crawl.
      expect(
        await db.job.count({
          where: { type: "CRAWL_SOURCE", payload: { equals: { sourceId: source.id } } },
        }),
      ).toBe(1);
    });
  });
});

describe("the pipeline end to end", () => {
  it("carries a discovered company through signals to the CRM", async () => {
    const company = await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Acme Dental",
        canonicalName: "acme dental",
        canonicalDomain: "acme.test",
        phone: "+441234567890",
        email: "hi@acme.test",
      },
    });

    // A lead already exists, as it would after someone decided to pursue it.
    const lead = await db.lead.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        companyName: "Acme Dental",
      },
    });

    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "EXTRACT_SIGNALS",
      payload: { companyId: company.id },
    });

    // EXTRACT_SIGNALS runs, queues UPDATE_CRM, which then runs.
    await runWorker({ maxJobs: 2, sleep: noSleep });

    expect(await db.signal.count({ where: { companyId: company.id } })).toBeGreaterThan(0);
    expect(await db.opportunity.count({ where: { companyId: company.id } })).toBeGreaterThan(0);

    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.phone).toBe("+441234567890");
    expect(after.score).toBeGreaterThan(0);
  });

  it("does not create a lead for a company nobody chose to pursue", async () => {
    const company = await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Acme Dental",
        canonicalName: "acme dental",
        canonicalDomain: "acme.test",
        phone: "+441234567890",
      },
    });

    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "EXTRACT_SIGNALS",
      payload: { companyId: company.id },
    });
    await runWorker({ maxJobs: 2, sleep: noSleep });

    // Filling the CRM with unvetted crawler output is exactly what the
    // permanent-CRM principle exists to prevent.
    expect(await db.lead.count({ where: { companyId: company.id } })).toBe(0);
  });
});
