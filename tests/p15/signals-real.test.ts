/**
 * P15 §14, §15 — signals and opportunities from a really-fetched website.
 *
 * The GitHub-API cycle in end-to-end.test.ts correctly produces zero signals:
 * a repository's `homepage` field yields a URL and nothing else, and every
 * rule refuses to fire without evidence. That is the engine behaving properly,
 * but it means those gates would pass vacuously.
 *
 * This suite therefore points the website provider at a real site that this
 * environment can actually reach, so the rules run against a genuinely fetched
 * page, and then checks the signal → service → opportunity → action chain on
 * the resulting rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpFetcher } from "@/lib/discovery/fetcher";
import { runSource } from "@/lib/discovery/pipeline";
import { refreshCompanySignals } from "@/lib/discovery/signals/store";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

let ws: SeededWorkspace;
const report: Record<string, unknown> = {};

beforeAll(async () => {
  await resetTestDatabase();
  await truncateAll();
  ws = await seedWorkspace("Signals");
}, 180_000);

afterAll(async () => {
  console.log("\n=== P15 SIGNAL/OPPORTUNITY EVIDENCE ===");
  console.log(JSON.stringify(report, null, 2));
  await disconnectTestPrisma();
});

describe("signals from a really fetched page", () => {
  it("reads a real website and derives signals and opportunities", async () => {
    const source = await db.source.create({
      data: {
        workspaceId: ws.workspaceId,
        provider: "website",
        name: "Real site",
        url: "https://pypi.org",
        config: { urls: ["https://pypi.org"], maxPages: 3 } as never,
      },
    });

    const started = Date.now();
    const run = await runSource({
      workspaceId: ws.workspaceId,
      sourceId: source.id,
      fetcher: new HttpFetcher({
        userAgent:
          "FreelanceOSBot/0.1 (+https://github.com/joeeeee28/FreelanceOS; validation)",
        timeoutMs: 20_000,
        minIntervalMs: 1_000,
        respectRobots: true,
      }),
    });
    const fetchMs = Date.now() - started;

    const companies = await db.company.findMany({
      where: { workspaceId: ws.workspaceId },
      include: { observations: true },
    });

    let signalsDetected = 0;
    let opportunities = 0;
    for (const company of companies) {
      const refreshed = await refreshCompanySignals({
        workspaceId: ws.workspaceId,
        companyId: company.id,
      });
      signalsDetected += refreshed.signalsDetected;
      opportunities += refreshed.opportunitiesCreated;
    }

    const storedSignals = await db.signal.findMany({
      where: { workspaceId: ws.workspaceId },
      include: { company: true },
    });
    const storedOpportunities = await db.opportunity.findMany({
      where: { workspaceId: ws.workspaceId },
      include: { company: true },
    });

    report.run = {
      fetchMs,
      pagesAttempted: run.pagesAttempted,
      pagesSucceeded: run.pagesSucceeded,
      pagesFailed: run.pagesFailed,
      pagesBlocked: run.pagesBlocked,
      companiesCreated: run.companiesCreated,
      warnings: run.warnings,
    };
    report.companies = companies.map((c) => ({
      name: c.name,
      domain: c.canonicalDomain,
      website: c.website,
      email: c.email,
      phone: c.phone,
      instagramUrl: c.instagramUrl,
      facebookUrl: c.facebookUrl,
      linkedinUrl: c.linkedinUrl,
      observations: c.observations.map((o) => ({
        field: o.field,
        value: o.value,
        method: o.method,
        confidence: o.confidence,
        sourceUrl: o.sourceUrl,
      })),
    }));
    report.signalsDetected = signalsDetected;
    report.signals = storedSignals.map((s) => ({
      company: s.company.name,
      type: s.type,
      confidence: s.confidence,
      summary: s.summary,
      evidence: s.evidence,
      sourceUrl: s.sourceUrl,
      status: s.status,
      firstSeenAt: s.firstSeenAt?.toISOString() ?? null,
    }));
    report.opportunities = storedOpportunities.map((o) => ({
      company: o.company.name,
      serviceKey: o.serviceKey,
      score: o.score,
      summary: o.summary,
      recommendedAction: o.recommendedAction,
      rationale: o.rationale,
    }));
    report.opportunitiesCreated = opportunities;

    // The page must genuinely have been read; otherwise this proves nothing.
    expect(run.pagesSucceeded).toBeGreaterThan(0);
    expect(companies.length).toBeGreaterThan(0);

    // §14: any signal that did fire must carry complete evidence.
    for (const s of storedSignals) {
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.summary).toBeTruthy();
      expect(s.evidence).toBeTruthy();
      expect(s.firstSeenAt).toBeTruthy();
    }

    // §15: any opportunity must name a service and an action, and its score
    // must be explained rather than asserted.
    for (const o of storedOpportunities) {
      expect(o.serviceKey).toBeTruthy();
      expect(o.score).toBeGreaterThanOrEqual(0);
      expect(o.rationale).not.toBeNull();
      expect(o.recommendedAction).toBeTruthy();
    }
  }, 300_000);

  it("derives the full chain from a controlled company with known facts", async () => {
    // The reachable hosts in this environment are developer sites with no
    // phone number and no social links, so few rules fire on them. To exercise
    // signal → service → opportunity → action deterministically, this uses a
    // company whose facts are set explicitly. The facts are fixtures; the rule
    // engine, scoring and storage under test are the real ones.
    const company = await db.company.create({
      data: {
        workspaceId: ws.workspaceId,
        name: "Controlled Fixture Ltd",
        canonicalName: "controlled fixture",
        canonicalDomain: "controlled-fixture.test",
        website: null,
        email: "hello@controlled-fixture.test",
        phone: "+441234567890",
        resolutionState: "RESOLVED",
      },
    });

    const refreshed = await refreshCompanySignals({
      workspaceId: ws.workspaceId,
      companyId: company.id,
    });

    const signals = await db.signal.findMany({
      where: { workspaceId: ws.workspaceId, companyId: company.id },
    });
    const opportunities = await db.opportunity.findMany({
      where: { workspaceId: ws.workspaceId, companyId: company.id },
    });

    report.controlledChain = {
      signalsDetected: refreshed.signalsDetected,
      signals: signals.map((s) => ({
        type: s.type,
        confidence: s.confidence,
        summary: s.summary,
        evidence: s.evidence,
      })),
      opportunities: opportunities.map((o) => ({
        serviceKey: o.serviceKey,
        score: o.score,
        summary: o.summary,
        recommendedAction: o.recommendedAction,
        rationale: o.rationale,
      })),
    };

    // A contactable business with no website is the clearest website-creation
    // opportunity there is, so the chain must produce one.
    expect(signals.some((s) => s.type === "WEBSITE_MISSING")).toBe(true);
    expect(opportunities.length).toBeGreaterThan(0);

    const website = opportunities.find((o) => o.serviceKey === "WEBSITE_CREATION");
    expect(website).toBeDefined();
    expect(website!.score).toBeGreaterThan(0);
    expect(website!.recommendedAction).toBeTruthy();
    expect(website!.rationale).not.toBeNull();
  }, 120_000);
});
