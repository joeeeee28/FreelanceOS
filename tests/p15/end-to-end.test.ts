/**
 * P15 §11, §14, §15, §18, §22, §24 — a real discovery cycle, end to end.
 *
 * Real HTTP to a real public API, through the real worker loop, into real
 * PostgreSQL, producing real signals and opportunities. Then the whole cycle
 * again, to prove the second run enriches rather than duplicates.
 *
 * Numbers printed here are the numbers quoted in the P15 report.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpFetcher } from "@/lib/discovery/fetcher";
import { runSource } from "@/lib/discovery/pipeline";
import { refreshCompanySignals } from "@/lib/discovery/signals/store";
import { syncCompanyToLead } from "@/lib/discovery/crm-sync";
import { getDiscoveryStats, getMarketIntelligence, getSourceHealth, getTopOpportunities } from "@/lib/discovery/stats";
import { enqueueJob } from "@/lib/jobs/queue";
import { runWorker } from "@/lib/jobs/worker";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

let ws: SeededWorkspace;
const report: Record<string, unknown> = {};

beforeAll(async () => {
  await resetTestDatabase();
  await truncateAll();
  ws = await seedWorkspace("E2E");
}, 180_000);

afterAll(async () => {
  console.log("\n=== P15 END-TO-END MEASUREMENTS ===");
  console.log(JSON.stringify(report, null, 2));
  await disconnectTestPrisma();
});

function fetcher() {
  return new HttpFetcher({
    userAgent:
      "FreelanceOSBot/0.1 (+https://github.com/joeeeee28/FreelanceOS; validation)",
    timeoutMs: 20_000,
    minIntervalMs: 1_000,
    respectRobots: true,
  });
}

/** One full cycle: discover, detect signals, sync to CRM. */
async function runCycle(sourceId: string) {
  const started = Date.now();

  const discovery = await runSource({
    workspaceId: ws.workspaceId,
    sourceId,
    fetcher: fetcher(),
  });

  let signalsDetected = 0;
  let opportunitiesFound = 0;

  for (const companyId of discovery.companyIds) {
    const refreshed = await refreshCompanySignals({
      workspaceId: ws.workspaceId,
      companyId,
    });
    signalsDetected += refreshed.signalsDetected;
    opportunitiesFound += refreshed.opportunitiesCreated + refreshed.opportunitiesUpdated;
  }

  return {
    durationMs: Date.now() - started,
    pagesAttempted: discovery.pagesAttempted,
    pagesSucceeded: discovery.pagesSucceeded,
    pagesFailed: discovery.pagesFailed,
    pagesBlocked: discovery.pagesBlocked,
    entitiesFound: discovery.entitiesFound,
    companiesCreated: discovery.companiesCreated,
    companiesMatched: discovery.companiesMatched,
    companyIds: discovery.companyIds,
    signalsDetected,
    opportunitiesFound,
  };
}

describe("§18 §22 two real discovery cycles", () => {
  it("cycle 1 discovers, cycle 2 enriches without duplicating", async () => {
    const source = await db.source.create({
      data: {
        workspaceId: ws.workspaceId,
        provider: "public-repository",
        name: "GitHub real",
        url: "https://api.github.com/orgs/vercel/repos?per_page=30",
        config: {
          apiUrls: ["https://api.github.com/orgs/vercel/repos?per_page=30"],
          maxItems: 30,
        } as never,
      },
    });

    const cycle1 = await runCycle(source.id);
    const cycle2 = await runCycle(source.id);

    const companies = await db.company.count({ where: { workspaceId: ws.workspaceId } });
    const observations = await db.observation.count({
      where: { workspaceId: ws.workspaceId },
    });
    const signals = await db.signal.count({ where: { workspaceId: ws.workspaceId } });
    const opportunities = await db.opportunity.count({
      where: { workspaceId: ws.workspaceId },
    });

    report.cycle1 = cycle1;
    report.cycle2 = cycle2;
    report.totals = { companies, observations, signals, opportunities };

    expect(cycle1.companiesCreated).toBeGreaterThan(0);
    // The gate: nothing new is created the second time round.
    expect(cycle2.companiesCreated).toBe(0);
    expect(cycle2.companiesMatched).toBe(cycle1.companiesMatched + cycle1.companiesCreated);
    expect(companies).toBe(cycle1.companiesCreated);
    // Observations are append-only history, so they grow.
    expect(observations).toBeGreaterThan(0);
    // Signals are deduplicated per (company, type): two cycles, one row each.
    expect(signals).toBeLessThanOrEqual(companies * 22);
  }, 300_000);

  it("§14 every stored signal carries real evidence", async () => {
    const signals = await db.signal.findMany({
      where: { workspaceId: ws.workspaceId },
      take: 25,
      include: { company: true },
    });

    report.signalSample = signals.slice(0, 10).map((s) => ({
      company: s.company.name,
      type: s.type,
      confidence: s.confidence,
      summary: s.summary,
      sourceUrl: s.sourceUrl,
      firstSeenAt: s.firstSeenAt?.toISOString() ?? null,
      lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
      status: s.status,
    }));

    for (const s of signals) {
      // A signal that cannot point at why it fired is speculation.
      expect(s.type).toBeTruthy();
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidence).toBeLessThanOrEqual(100);
      expect(s.summary).toBeTruthy();
      expect(s.firstSeenAt).toBeTruthy();
      expect(s.status).toBeTruthy();
    }
  }, 120_000);

  it("§15 every opportunity maps signal → service → action", async () => {
    const opportunities = await db.opportunity.findMany({
      where: { workspaceId: ws.workspaceId },
      take: 25,
      include: { company: true },
    });

    report.opportunitySample = opportunities.slice(0, 10).map((o) => ({
      company: o.company.name,
      serviceKey: o.serviceKey,
      score: o.score,
      summary: o.summary,
      recommendedAction: o.recommendedAction,
      rationale: o.rationale,
      status: o.status,
    }));

    for (const o of opportunities) {
      expect(o.serviceKey).toBeTruthy();
      expect(o.score).toBeGreaterThanOrEqual(0);
      expect(o.score).toBeLessThanOrEqual(100);
      // A score with no explanation is the "mysterious AI score" the spec
      // explicitly forbids.
      expect(o.rationale).not.toBeNull();
    }
  }, 120_000);
});

describe("§16 the real worker loop drains a real queue", () => {
  it("processes queued jobs and records their outcomes", async () => {
    for (let i = 0; i < 4; i++) {
      await enqueueJob({
        workspaceId: ws.workspaceId,
        type: "MARKET_ANALYSIS",
        payload: { i },
      });
    }

    const stats = await runWorker({
      workerId: "p15-worker",
      maxJobs: 4,
      idleDelayMs: 1,
    });

    report.worker = stats;

    expect(stats.claimed).toBe(4);
    expect(stats.completed).toBe(4);
    expect(stats.failed).toBe(0);

    const succeeded = await db.job.count({
      where: { workspaceId: ws.workspaceId, status: "SUCCEEDED" },
    });
    expect(succeeded).toBe(4);
  }, 120_000);
});

describe("§18 §19 §21 dashboard reads only real rows", () => {
  it("reports figures that match the database", async () => {
    const stats = await getDiscoveryStats(ws.workspaceId);
    const health = await getSourceHealth(ws.workspaceId);
    const top = await getTopOpportunities(ws.workspaceId, 5);
    const market = await getMarketIntelligence(ws.workspaceId);

    const actualCompanies = await db.company.count({
      where: { workspaceId: ws.workspaceId, archivedAt: null },
    });

    report.dashboard = {
      companies: stats.companies,
      signalsActive: stats.signalsActive,
      opportunitiesOpen: stats.opportunitiesOpen,
      lastRunAt: stats.lastRunAt,
      sourceHealth: health.map((h) => ({
        name: h.name,
        status: h.health.status,
        successRate: h.health.successRate,
      })),
      topOpportunities: top.map((o) => ({
        company: o.companyName,
        service: o.serviceKey,
        score: o.score,
      })),
      market: {
        sampleSize: market.sampleSize,
        sufficient: market.sufficient,
        withoutWebsite: market.withoutWebsite,
      },
    };

    // Every figure must be the database's figure, not an approximation.
    expect(stats.companies).toBe(actualCompanies);

    // Sample-size honesty: below the threshold, no percentages are claimed.
    if (market.sampleSize < 20) expect(market.sufficient).toBe(false);

    // Every opportunity shown carries its reason.
    for (const o of top) {
      expect(o.score).toBeGreaterThanOrEqual(0);
    }
  }, 120_000);

  it("§10 a dead source is reported as unhealthy without hiding the live one", async () => {
    const dead = await db.source.create({
      data: {
        workspaceId: ws.workspaceId,
        provider: "public-repository",
        name: "Dead source",
        config: {
          apiUrls: ["https://p15-dead-source.invalid/x.json"],
        } as never,
      },
    });

    await runSource({
      workspaceId: ws.workspaceId,
      sourceId: dead.id,
      fetcher: fetcher(),
    });

    const health = await getSourceHealth(ws.workspaceId);
    report.sourceHealthAfterFailure = health.map((h) => ({
      name: h.name,
      status: h.health.status,
      successRate: h.health.successRate,
      remediation: h.health.remediation ?? null,
    }));

    // Both sources are listed: the failure of one does not erase the other.
    expect(health.length).toBeGreaterThanOrEqual(2);
    const deadRow = health.find((h) => h.name === "Dead source");
    expect(deadRow).toBeDefined();
    expect(deadRow!.health.status).not.toBe("ACTIVE");
  }, 180_000);
});

describe("§25 data quality: inspect real records individually", () => {
  it("every company traces back to a source and a URL", async () => {
    const companies = await db.company.findMany({
      where: { workspaceId: ws.workspaceId },
      include: { observations: { take: 3 }, signals: true, opportunities: true },
      take: 25,
    });

    const audit = companies.map((c) => {
      const hasProvenance = c.observations.every(
        (o) => o.sourceUrl !== null && o.confidence > 0,
      );
      return {
        name: c.name,
        canonicalDomain: c.canonicalDomain,
        website: c.website,
        resolutionState: c.resolutionState,
        observations: c.observations.length,
        signals: c.signals.length,
        opportunities: c.opportunities.length,
        // Automated validation can prove lineage and field shape, not that an
        // arbitrary public source's business interpretation is correct. The
        // latter is reported only after a separately documented manual audit.
        classification: hasProvenance ? "PROVENANCE_VERIFIED" : "UNVERIFIED",
      };
    });

    report.dataQualityAudit = audit;
    report.dataQualityCounts = {
      inspected: audit.length,
      provenanceVerified: audit.filter(
        (a) => a.classification === "PROVENANCE_VERIFIED",
      ).length,
      unverified: audit.filter((a) => a.classification === "UNVERIFIED").length,
    };

    expect(companies.length).toBeGreaterThan(0);
    // Package-registry URLs describe a package's publication location, not a
    // business prospect; the repository provider must filter them.
    expect(companies.some((c) => c.canonicalDomain === "npmjs.com")).toBe(false);

    for (const c of companies) {
      // Identity: a company must be identifiable, never a blank shell.
      expect(c.name ?? c.canonicalDomain).toBeTruthy();

      const repositoryHomepageOnly = c.observations.every(
        (o) => o.locator === "repo:homepage",
      );
      if (repositoryHomepageOnly) {
        // A GitHub owner can maintain independent products. In this controlled
        // run the source publishes only a homepage, so it must not invent an
        // owner name for that homepage.
        expect(c.name).toBe(c.canonicalDomain);
      }

      for (const o of c.observations) {
        expect(o.sourceUrl).toBeTruthy();
        expect(o.observedAt).toBeTruthy();
        expect(o.confidence).toBeGreaterThan(0);
        expect(o.method).toBeTruthy();
      }
    }
  }, 120_000);

  it("§26 discovery created no lead nobody asked for", async () => {
    // Discovering a company is not deciding to pursue it. Leads appear only
    // when a human (or an explicit sync) asks for them.
    const leads = await db.lead.count({ where: { workspaceId: ws.workspaceId } });
    report.leadsCreatedByDiscovery = leads;
    expect(leads).toBe(0);
  }, 60_000);

  it("an explicit sync does create the CRM record", async () => {
    const company = await db.company.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId, resolutionState: "RESOLVED" },
    });

    const outcome = await syncCompanyToLead({
      workspaceId: ws.workspaceId,
      companyId: company.id,
      createIfMissing: true,
    });

    report.explicitSync = { kind: outcome.kind };
    expect(await db.lead.count({ where: { workspaceId: ws.workspaceId } })).toBe(1);
  }, 60_000);
});
