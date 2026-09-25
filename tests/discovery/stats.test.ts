import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MIN_MARKET_SAMPLE } from "@/lib/discovery/stats";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const {
  getDiscoveryStats,
  getMarketIntelligence,
  getSourceHealth,
  getTopOpportunities,
} = await import("@/lib/discovery/stats");

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

async function makeCompany(
  workspaceId: string,
  overrides: Record<string, unknown> = {},
) {
  return db.company.create({
    data: {
      workspaceId,
      name: "Acme",
      canonicalName: `acme-${Math.random()}`,
      canonicalDomain: `acme-${Math.random()}.test`,
      ...overrides,
    },
  });
}

describe("getDiscoveryStats", () => {
  it("reports an empty workspace honestly", async () => {
    const stats = await getDiscoveryStats(alice.workspaceId);

    expect(stats.companies).toBe(0);
    // Never run is not the same as ran and found nothing.
    expect(stats.lastRunAt).toBeNull();
    expect(stats.lastRunStatus).toBeNull();
  });

  it("counts real rows", async () => {
    const company = await makeCompany(alice.workspaceId, { phone: "+44123" });
    await db.signal.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        type: "WEBSITE_MISSING",
        confidence: 70,
        summary: "No website",
      },
    });
    await db.opportunity.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        serviceKey: "WEBSITE_CREATION",
        score: 50,
      },
    });

    const stats = await getDiscoveryStats(alice.workspaceId);

    expect(stats.companies).toBe(1);
    expect(stats.signalsActive).toBe(1);
    expect(stats.opportunitiesOpen).toBe(1);
  });

  it("excludes archived companies", async () => {
    await makeCompany(alice.workspaceId, { archivedAt: new Date() });

    expect((await getDiscoveryStats(alice.workspaceId)).companies).toBe(0);
  });

  it("reports the last run when there is one", async () => {
    await db.discoveryRun.create({
      data: { workspaceId: alice.workspaceId, status: "COMPLETED" },
    });

    const stats = await getDiscoveryStats(alice.workspaceId);

    expect(stats.lastRunAt).not.toBeNull();
    expect(stats.lastRunStatus).toBe("COMPLETED");
  });

  it("counts nothing from another workspace", async () => {
    await makeCompany(bob.workspaceId);

    expect((await getDiscoveryStats(alice.workspaceId)).companies).toBe(0);
  });
});

describe("getSourceHealth", () => {
  it("returns nothing when no sources exist", async () => {
    expect(await getSourceHealth(alice.workspaceId)).toEqual([]);
  });

  it("reports UNKNOWN for a source that has never run", async () => {
    await db.source.create({
      data: { workspaceId: alice.workspaceId, provider: "manual-csv", name: "A" },
    });

    const [health] = await getSourceHealth(alice.workspaceId);

    // Reporting 0% for something never tried would be numerically true and
    // completely misleading.
    expect(health.health.status).toBe("UNKNOWN");
    expect(health.health.successRate).toBeNull();
  });

  it("derives health from recorded fetches", async () => {
    const source = await db.source.create({
      data: { workspaceId: alice.workspaceId, provider: "manual-csv", name: "A" },
    });

    for (let i = 0; i < 9; i++) {
      await db.fetchLog.create({
        data: {
          workspaceId: alice.workspaceId,
          sourceId: source.id,
          url: `https://a.test/${i}`,
          outcome: "SUCCESS",
        },
      });
    }
    await db.fetchLog.create({
      data: {
        workspaceId: alice.workspaceId,
        sourceId: source.id,
        url: "https://a.test/x",
        outcome: "TIMEOUT",
      },
    });

    const [health] = await getSourceHealth(alice.workspaceId);

    expect(health.health.status).toBe("ACTIVE");
    expect(health.health.successRate).toBeCloseTo(0.9);
  });

  it("distinguishes a refused source and explains it", async () => {
    const source = await db.source.create({
      data: { workspaceId: alice.workspaceId, provider: "sitemap", name: "Blocked" },
    });

    for (let i = 0; i < 3; i++) {
      await db.fetchLog.create({
        data: {
          workspaceId: alice.workspaceId,
          sourceId: source.id,
          url: `https://b.test/${i}`,
          outcome: "BLOCKED",
        },
      });
    }

    const [health] = await getSourceHealth(alice.workspaceId);

    expect(health.health.status).toBe("BLOCKED");
    expect(health.health.refusedOnly).toBe(true);
    expect(health.health.remediation).toContain("refuses");
  });

  it("ignores fetches outside the window", async () => {
    const source = await db.source.create({
      data: { workspaceId: alice.workspaceId, provider: "manual-csv", name: "A" },
    });

    await db.fetchLog.create({
      data: {
        workspaceId: alice.workspaceId,
        sourceId: source.id,
        url: "https://a.test",
        outcome: "SERVER_ERROR",
        fetchedAt: new Date("2020-01-01T00:00:00Z"),
      },
    });

    const [health] = await getSourceHealth(alice.workspaceId, { windowDays: 7 });

    // A source broken two years ago is not broken now.
    expect(health.health.status).toBe("UNKNOWN");
  });

  it("never shows another workspace's sources", async () => {
    await db.source.create({
      data: { workspaceId: bob.workspaceId, provider: "manual-csv", name: "bob" },
    });

    expect(await getSourceHealth(alice.workspaceId)).toEqual([]);
  });
});

describe("getTopOpportunities", () => {
  async function makeOpportunity(
    workspaceId: string,
    score: number,
    overrides: Record<string, unknown> = {},
  ) {
    const company = await makeCompany(workspaceId);
    return db.opportunity.create({
      data: {
        workspaceId,
        companyId: company.id,
        serviceKey: "WEBSITE_CREATION",
        score,
        summary: "No website found.",
        recommendedAction: "Offer to build one.",
        ...overrides,
      },
    });
  }

  it("returns the strongest first", async () => {
    await makeOpportunity(alice.workspaceId, 30);
    await makeOpportunity(alice.workspaceId, 80);
    await makeOpportunity(alice.workspaceId, 55);

    const top = await getTopOpportunities(alice.workspaceId);

    expect(top.map((o) => o.score)).toEqual([80, 55, 30]);
  });

  it("always carries the reason alongside the score", async () => {
    await makeOpportunity(alice.workspaceId, 60);

    const [opportunity] = await getTopOpportunities(alice.workspaceId);

    // A score without its justification is exactly what this product must not
    // show.
    expect(opportunity.summary).toBeTruthy();
    expect(opportunity.recommendedAction).toBeTruthy();
  });

  it("hides dismissed opportunities", async () => {
    await makeOpportunity(alice.workspaceId, 90, {
      dismissedAt: new Date(),
      status: "DISMISSED",
    });

    expect(await getTopOpportunities(alice.workspaceId)).toEqual([]);
  });

  it("hides opportunities for archived companies", async () => {
    const company = await makeCompany(alice.workspaceId, { archivedAt: new Date() });
    await db.opportunity.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        serviceKey: "META_ADS",
        score: 90,
      },
    });

    expect(await getTopOpportunities(alice.workspaceId)).toEqual([]);
  });

  it("reports whether the company is already a lead", async () => {
    const opportunity = await makeOpportunity(alice.workspaceId, 70);
    const lead = await db.lead.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: opportunity.companyId,
        companyName: "Acme",
      },
    });

    const [top] = await getTopOpportunities(alice.workspaceId);
    expect(top.leadId).toBe(lead.id);
  });

  it("does not count an archived lead as being pursued", async () => {
    const opportunity = await makeOpportunity(alice.workspaceId, 70);
    await db.lead.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: opportunity.companyId,
        companyName: "Acme",
        deletedAt: new Date(),
      },
    });

    const [top] = await getTopOpportunities(alice.workspaceId);
    expect(top.leadId).toBeNull();
  });

  it("honours the limit", async () => {
    for (let i = 0; i < 8; i++) await makeOpportunity(alice.workspaceId, i * 10);

    expect(await getTopOpportunities(alice.workspaceId, 3)).toHaveLength(3);
  });

  it("never returns another workspace's opportunities", async () => {
    await makeOpportunity(bob.workspaceId, 90);

    expect(await getTopOpportunities(alice.workspaceId)).toEqual([]);
  });
});

describe("getMarketIntelligence", () => {
  it("reports an empty market as empty", async () => {
    const market = await getMarketIntelligence(alice.workspaceId);

    expect(market.sampleSize).toBe(0);
    expect(market.sufficient).toBe(false);
  });

  it("flags a sample too small to draw conclusions from", async () => {
    for (let i = 0; i < 3; i++) {
      await makeCompany(alice.workspaceId, { industry: "Dentistry" });
    }

    const market = await getMarketIntelligence(alice.workspaceId);

    // "67% have no website" out of three companies is noise with a percent
    // sign. The caller is told not to present it as fact.
    expect(market.sampleSize).toBe(3);
    expect(market.sufficient).toBe(false);
  });

  it("reports a sufficient sample", async () => {
    for (let i = 0; i < MIN_MARKET_SAMPLE; i++) {
      await makeCompany(alice.workspaceId, {
        industry: i % 2 === 0 ? "Dentistry" : "Retail",
        country: "GB",
      });
    }

    const market = await getMarketIntelligence(alice.workspaceId);

    expect(market.sampleSize).toBe(MIN_MARKET_SAMPLE);
    expect(market.sufficient).toBe(true);
    expect(market.byIndustry.length).toBe(2);
    expect(market.byCountry[0].label).toBe("GB");
  });

  it("computes shares against the whole sample", async () => {
    for (let i = 0; i < 10; i++) {
      await makeCompany(alice.workspaceId, {
        industry: "Dentistry",
        website: i < 4 ? "https://x.test" : null,
      });
    }

    const market = await getMarketIntelligence(alice.workspaceId);

    expect(market.withoutWebsite).toBe(6);
    expect(market.byIndustry[0].share).toBeCloseTo(1);
  });

  it("never produces NaN on an empty sample", async () => {
    const market = await getMarketIntelligence(alice.workspaceId);

    for (const segment of [...market.byIndustry, ...market.byCountry]) {
      expect(Number.isNaN(segment.share)).toBe(false);
    }
  });

  it("excludes archived companies from the sample", async () => {
    await makeCompany(alice.workspaceId, { archivedAt: new Date() });

    expect((await getMarketIntelligence(alice.workspaceId)).sampleSize).toBe(0);
  });

  it("never mixes workspaces", async () => {
    for (let i = 0; i < 5; i++) await makeCompany(bob.workspaceId);

    expect((await getMarketIntelligence(alice.workspaceId)).sampleSize).toBe(0);
  });
});
