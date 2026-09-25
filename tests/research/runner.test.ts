import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResearchAspect } from "@prisma/client";
import type { Fetcher } from "@/lib/discovery/provider";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const { researchCompany, selectCompaniesForResearch } = await import(
  "@/lib/research/runner"
);

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

/** Research is driven by injected researchers, so no network is needed. */
const noFetch: Fetcher = {
  async fetch() {
    throw new Error("no network in this test");
  },
};

async function makeCompany(
  workspaceId: string,
  overrides: Record<string, unknown> = {},
) {
  return db.company.create({
    data: {
      workspaceId,
      name: "Acme Dental",
      canonicalName: "acme dental",
      canonicalDomain: "acme.test",
      website: "https://acme.test",
      ...overrides,
    },
  });
}

const findsEmail = async () => ({
  facts: [
    {
      field: "email" as const,
      value: "hello@acme.test",
      method: "STRUCTURED_DATA" as const,
      sourceUrl: "https://acme.test/contact",
    },
  ],
  sourceUrl: "https://acme.test/contact",
});

describe("researchCompany", () => {
  it("researches a company and records what it found", async () => {
    const company = await makeCompany(alice.workspaceId);

    const result = await researchCompany({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: noFetch,
      researchers: { PUBLIC_CONTACTS: findsEmail },
    });

    expect(result.aspectsRun).toBe(1);
    expect(result.results[0]).toMatchObject({
      aspect: "PUBLIC_CONTACTS",
      status: "RESEARCHED",
      factsFound: 1,
    });

    const after = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(after.email).toBe("hello@acme.test");
  });

  it("writes an append-only run record", async () => {
    const company = await makeCompany(alice.workspaceId);

    await researchCompany({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: noFetch,
      researchers: { PUBLIC_CONTACTS: findsEmail },
    });

    const run = await db.researchRun.findFirstOrThrow({
      where: { companyId: company.id },
    });

    expect(run.status).toBe("RESEARCHED");
    expect(run.factsFound).toBe(1);
    expect(run.completedAt).not.toBeNull();
    expect(run.freshUntil).not.toBeNull();
  });

  describe("incrementality", () => {
    it("does not re-research something still fresh", async () => {
      const company = await makeCompany(alice.workspaceId);
      const researcher = vi.fn(findsEmail);

      await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: { PUBLIC_CONTACTS: researcher },
      });
      const second = await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: { PUBLIC_CONTACTS: researcher },
      });

      // The whole point of freshness windows: no second fetch.
      expect(researcher).toHaveBeenCalledTimes(1);
      expect(second.aspectsRun).toBe(0);
    });

    it("re-researches once the window has passed", async () => {
      const company = await makeCompany(alice.workspaceId);
      const researcher = vi.fn(findsEmail);
      const start = new Date("2026-01-01T00:00:00Z");

      await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: { PUBLIC_CONTACTS: researcher },
        now: start,
      });

      await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: { PUBLIC_CONTACTS: researcher },
        // Well past the PUBLIC_CONTACTS window.
        now: new Date("2026-06-01T00:00:00Z"),
      });

      expect(researcher).toHaveBeenCalledTimes(2);
      expect(await db.researchRun.count({ where: { companyId: company.id } })).toBe(2);
    });

    it("keeps the history of every pass", async () => {
      const company = await makeCompany(alice.workspaceId);

      await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: { PUBLIC_CONTACTS: findsEmail },
        now: new Date("2026-01-01T00:00:00Z"),
      });
      await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: { PUBLIC_CONTACTS: findsEmail },
        now: new Date("2026-06-01T00:00:00Z"),
      });

      // "We checked and found nothing" must stay distinguishable from
      // "we never checked", which needs the whole history, not the latest row.
      const runs = await db.researchRun.findMany({ where: { companyId: company.id } });
      expect(runs).toHaveLength(2);
    });

    it("respects the per-company aspect cap", async () => {
      const company = await makeCompany(alice.workspaceId);
      const researchers: Partial<Record<ResearchAspect, typeof findsEmail>> = {
        WEBSITE: findsEmail,
        HIRING: findsEmail,
        PUBLIC_CONTACTS: findsEmail,
        COMPANY_INFO: findsEmail,
      };

      const result = await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers,
        maxAspects: 2,
      });

      expect(result.aspectsRun).toBe(2);
    });
  });

  describe("failure handling", () => {
    it("records a researcher that throws and continues", async () => {
      const company = await makeCompany(alice.workspaceId);

      const result = await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: {
          WEBSITE: async () => {
            throw new Error("parser exploded");
          },
          PUBLIC_CONTACTS: findsEmail,
        },
      });

      const failed = result.results.find((r) => r.aspect === "WEBSITE");
      const succeeded = result.results.find((r) => r.aspect === "PUBLIC_CONTACTS");

      expect(failed?.status).toBe("NEEDS_REVIEW");
      // One broken aspect must not cost the company the others.
      expect(succeeded?.status).toBe("RESEARCHED");
    });

    it("does not suppress the next attempt after a failure", async () => {
      const company = await makeCompany(alice.workspaceId);

      await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: {
          WEBSITE: async () => {
            throw new Error("boom");
          },
        },
      });

      const run = await db.researchRun.findFirstOrThrow({
        where: { companyId: company.id, aspect: "WEBSITE" },
      });

      // A failed run gets no freshUntil, so it is due again immediately.
      expect(run.freshUntil).toBeNull();
    });

    it("records a refusal without retrying it", async () => {
      const company = await makeCompany(alice.workspaceId);
      const researcher = vi.fn(async () => ({
        facts: [],
        blocked: true,
        sourceUrl: "https://acme.test",
      }));

      await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: { WEBSITE: researcher },
      });
      await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: { WEBSITE: researcher },
      });

      const run = await db.researchRun.findFirstOrThrow({
        where: { companyId: company.id, aspect: "WEBSITE" },
      });
      expect(run.status).toBe("BLOCKED");

      // A refusal cools down for weeks; it is not retried on the next pass.
      expect(researcher).toHaveBeenCalledTimes(1);
    });

    it("skips aspects it has no researcher for", async () => {
      const company = await makeCompany(alice.workspaceId);

      const result = await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: {},
      });

      // Not a failure — simply nothing this build knows how to investigate.
      expect(result.aspectsRun).toBe(0);
      expect(await db.researchRun.count()).toBe(0);
    });
  });

  describe("records it will not touch", () => {
    it("skips an archived company", async () => {
      const company = await makeCompany(alice.workspaceId, { archivedAt: new Date() });

      const result = await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: { PUBLIC_CONTACTS: findsEmail },
      });

      expect(result.skipped).toBe("Company is archived");
    });

    it("cannot research another workspace's company", async () => {
      const company = await makeCompany(bob.workspaceId);

      const result = await researchCompany({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: noFetch,
        researchers: { PUBLIC_CONTACTS: findsEmail },
      });

      expect(result.skipped).toBe("Company not found");
      expect(await db.researchRun.count()).toBe(0);
    });
  });

  it("updates the company's aggregate research status", async () => {
    const company = await makeCompany(alice.workspaceId);

    await researchCompany({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: noFetch,
      researchers: { PUBLIC_CONTACTS: findsEmail },
    });

    const after = await db.company.findUniqueOrThrow({ where: { id: company.id } });

    // One aspect of twelve is not "researched".
    expect(after.researchStatus).not.toBe("RESEARCHED");
    expect(after.lastResearchAt).not.toBeNull();
  });

  it("re-detects signals when research changed something", async () => {
    const company = await makeCompany(alice.workspaceId, { website: null });

    await researchCompany({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: noFetch,
      researchers: {
        PUBLIC_CONTACTS: async () => ({
          facts: [
            {
              field: "phone" as const,
              value: "+441234567890",
              method: "STRUCTURED_DATA" as const,
            },
          ],
        }),
      },
    });

    // A contactable business with no website is a signal, and research just
    // made it contactable.
    const signal = await db.signal.findFirst({
      where: { companyId: company.id, type: "WEBSITE_MISSING" },
    });
    expect(signal).not.toBeNull();
  });

  it("stops early when aborted", async () => {
    const company = await makeCompany(alice.workspaceId);
    const controller = new AbortController();
    controller.abort();

    const result = await researchCompany({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: noFetch,
      researchers: { WEBSITE: findsEmail, PUBLIC_CONTACTS: findsEmail },
      signal: controller.signal,
    });

    expect(result.aspectsRun).toBe(0);
  });
});

describe("selectCompaniesForResearch", () => {
  it("prefers companies never researched", async () => {
    const researched = await makeCompany(alice.workspaceId, {
      canonicalDomain: "old.test",
      canonicalName: "old",
      lastResearchAt: new Date("2026-01-01T00:00:00Z"),
    });
    const fresh = await makeCompany(alice.workspaceId, {
      canonicalDomain: "new.test",
      canonicalName: "new",
    });

    const selected = await selectCompaniesForResearch({
      workspaceId: alice.workspaceId,
    });

    // Never-researched companies most need attention.
    expect(selected[0]).toBe(fresh.id);
    expect(selected).toContain(researched.id);
  });

  it("spreads attention to the least recently researched", async () => {
    const older = await makeCompany(alice.workspaceId, {
      canonicalDomain: "a.test",
      canonicalName: "a",
      lastResearchAt: new Date("2026-01-01T00:00:00Z"),
    });
    await makeCompany(alice.workspaceId, {
      canonicalDomain: "b.test",
      canonicalName: "b",
      lastResearchAt: new Date("2026-08-01T00:00:00Z"),
    });

    const selected = await selectCompaniesForResearch({
      workspaceId: alice.workspaceId,
    });

    expect(selected[0]).toBe(older.id);
  });

  it("excludes archived and unresolved companies", async () => {
    await makeCompany(alice.workspaceId, {
      canonicalDomain: "a.test",
      archivedAt: new Date(),
    });
    await makeCompany(alice.workspaceId, {
      canonicalDomain: "b.test",
      resolutionState: "NEEDS_REVIEW",
    });
    const good = await makeCompany(alice.workspaceId, { canonicalDomain: "c.test" });

    expect(await selectCompaniesForResearch({ workspaceId: alice.workspaceId })).toEqual([
      good.id,
    ]);
  });

  it("never selects another workspace's companies", async () => {
    await makeCompany(bob.workspaceId);

    expect(await selectCompaniesForResearch({ workspaceId: alice.workspaceId })).toEqual(
      [],
    );
  });

  it("honours the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await makeCompany(alice.workspaceId, {
        canonicalDomain: `c${i}.test`,
        canonicalName: `c${i}`,
      });
    }

    expect(
      await selectCompaniesForResearch({ workspaceId: alice.workspaceId, limit: 2 }),
    ).toHaveLength(2);
  });
});
