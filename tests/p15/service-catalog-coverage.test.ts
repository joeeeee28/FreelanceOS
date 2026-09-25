/**
 * P15.1 — deterministic service-catalog evidence coverage.
 *
 * This is deliberately a controlled fixture suite, not a claim that these
 * companies are live prospects. Each scenario supplies only facts that the
 * signal rules explicitly understand, then uses the normal signal storage
 * path against disposable PostgreSQL. The purpose is to prove that every
 * sellable service has an evidence-bearing, explained mapping path without
 * lowering the production anti-noise display threshold, and that a factual
 * change remains historical rather than being deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mapSignalsToOpportunities } from "@/lib/discovery/signals/opportunities";
import { refreshCompanySignals, type RefreshOptions } from "@/lib/discovery/signals/store";
import { SERVICE_KEYS } from "@/lib/taxonomy/services";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

let ws: SeededWorkspace;
const NOW = new Date("2026-09-26T00:00:00.000Z");
const report: Record<string, unknown> = {};

type Scenario = {
  key: string;
  label: string;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  instagramUrl?: string | null;
  facts?: NonNullable<RefreshOptions["facts"]>;
};

const SCENARIOS: readonly Scenario[] = [
  {
    key: "no-site",
    label: "Contactable business without a site",
    email: "hello@no-site.fixture.test",
    phone: "+441234567890",
  },
  {
    key: "site-quality",
    label: "Published site with observable quality and maintenance facts",
    website: "http://site-quality.fixture.test",
    facts: {
      pageSignals: {
        reachable: true,
        isHttps: false,
        copyrightYear: 2020,
      },
    },
  },
  {
    key: "no-social",
    label: "Reachable site with an evidenced absent social presence",
    website: "https://no-social.fixture.test",
    facts: { pageSignals: { reachable: true } },
  },
  {
    key: "social",
    label: "Business with an explicitly published public social profile",
    website: "https://social.fixture.test",
    instagramUrl: "https://instagram.com/social-fixture",
  },
  {
    key: "advertising",
    label: "Site with an observed advertising or analytics pixel",
    website: "https://advertising.fixture.test",
    facts: { pageSignals: { reachable: true, hasTrackingPixel: true } },
  },
  {
    key: "content-gap",
    label: "Reachable site with no evidenced blog or news section",
    website: "https://content-gap.fixture.test",
    facts: { pageSignals: { reachable: true, hasBlog: false } },
  },
  {
    key: "marketing-hiring",
    label: "Business with a concrete marketing-area vacancy",
    website: "https://marketing-hiring.fixture.test",
    facts: { hiringAreas: ["MARKETING"] },
  },
];

beforeAll(async () => {
  await resetTestDatabase();
  await truncateAll();
  ws = await seedWorkspace("P15.1 service coverage");
}, 180_000);

afterAll(async () => {
  console.log("\n=== P15.1 SERVICE-CATALOG EVIDENCE ===");
  console.log(JSON.stringify(report, null, 2));
  await disconnectTestPrisma();
});

async function createScenario(scenario: Scenario) {
  const company = await db.company.create({
    data: {
      workspaceId: ws.workspaceId,
      name: scenario.label,
      canonicalName: scenario.key,
      canonicalDomain: `${scenario.key}.fixture.test`,
      website: scenario.website ?? null,
      email: scenario.email ?? null,
      phone: scenario.phone ?? null,
      instagramUrl: scenario.instagramUrl ?? null,
      resolutionState: "RESOLVED",
    },
  });

  const refreshOptions: RefreshOptions = {
    workspaceId: ws.workspaceId,
    companyId: company.id,
    facts: scenario.facts,
    now: NOW,
  };
  const result = await refreshCompanySignals(refreshOptions);

  return { company, refreshOptions, result };
}

describe("P15.1 service catalog", () => {
  it("audits a complete evidence-backed signal → service → rationale path for every catalog service", async () => {
    const created = [] as Awaited<ReturnType<typeof createScenario>>[];
    for (const scenario of SCENARIOS) created.push(await createScenario(scenario));

    const opportunities = await db.opportunity.findMany({
      where: { workspaceId: ws.workspaceId },
      include: { company: true, signals: true },
      orderBy: [{ serviceKey: "asc" }, { companyId: "asc" }],
    });
    const signals = await db.signal.findMany({
      where: { workspaceId: ws.workspaceId },
      orderBy: [{ companyId: "asc" }, { type: "asc" }],
    });

    // The persisted store intentionally applies the production safety floor of
    // 20 points. That protects users from weak one-observation suggestions,
    // but must not leave the service catalog untested. Re-map each company's
    // actually detected, evidence-bearing signals at a zero display threshold
    // solely to audit every declared mapping rule; this does not write any
    // extra Opportunity row or turn a weak recommendation into a lead.
    const evidenceMapped = created.flatMap(({ company }) => {
      const companySignals = signals.filter((signal) => signal.companyId === company.id);
      return mapSignalsToOpportunities(
        companySignals.map((signal) => ({
          type: signal.type,
          confidence: signal.confidence,
          evidence: signal.evidence,
          sourceUrl: signal.sourceUrl,
        })),
        { minScore: 0 },
      ).map((opportunity) => ({ company: company.canonicalDomain, ...opportunity }));
    });
    const evidenceCovered = new Set(evidenceMapped.map((opportunity) => opportunity.serviceKey));
    const persistedCovered = new Set(opportunities.map((opportunity) => opportunity.serviceKey));
    const missingEvidenceCoverage = SERVICE_KEYS.filter((key) => !evidenceCovered.has(key));
    const suppressedBySafetyFloor = SERVICE_KEYS.filter(
      (key) => evidenceCovered.has(key) && !persistedCovered.has(key),
    );

    report.refreshes = created.map(({ company, result }) => ({
      company: company.canonicalDomain,
      signalsDetected: result.signalsDetected,
      opportunitiesCreated: result.opportunitiesCreated,
    }));
    report.coverage = {
      servicesExpected: SERVICE_KEYS.length,
      evidenceMappedServices: [...evidenceCovered].sort(),
      missingEvidenceCoverage,
      persistedAtOrAboveSafetyFloor: [...persistedCovered].sort(),
      suppressedBySafetyFloor,
      storedSignals: signals.length,
      storedOpportunities: opportunities.length,
    };
    report.opportunities = opportunities.map((opportunity) => ({
      company: opportunity.company.canonicalDomain,
      serviceKey: opportunity.serviceKey,
      score: opportunity.score,
      signalTypes: opportunity.signals.map((signal) => signal.type),
      rationale: opportunity.rationale,
    }));

    expect(missingEvidenceCoverage).toEqual([]);
    expect(evidenceCovered.size).toBe(SERVICE_KEYS.length);
    expect(signals.length).toBeGreaterThan(0);
    expect(opportunities.length).toBeGreaterThan(0);

    // The safety floor is a deliberate anti-noise control, not absent catalog
    // coverage. The suppressed services remain explainable in the audit above
    // and were not written as weak real-world opportunities.
    expect(suppressedBySafetyFloor.length).toBeGreaterThan(0);

    for (const signal of signals) {
      expect(signal.confidence).toBeGreaterThan(0);
      expect(signal.confidence).toBeLessThanOrEqual(100);
      expect(signal.summary).toBeTruthy();
      expect(signal.evidence).toBeTruthy();
      expect(signal.firstSeenAt).toEqual(NOW);
      expect(signal.lastSeenAt).toEqual(NOW);
    }

    for (const opportunity of opportunities) {
      expect(SERVICE_KEYS).toContain(opportunity.serviceKey as (typeof SERVICE_KEYS)[number]);
      expect(opportunity.score).toBeGreaterThan(0);
      expect(opportunity.score).toBeLessThanOrEqual(100);
      expect(opportunity.recommendedAction).toBeTruthy();
      expect(opportunity.signals.length).toBeGreaterThan(0);
      expect(Array.isArray(opportunity.rationale)).toBe(true);

      const rationale = opportunity.rationale as Array<Record<string, unknown>>;
      expect(rationale.length).toBeGreaterThan(0);
      for (const line of rationale) {
        expect(typeof line.ruleKey).toBe("string");
        expect(typeof line.signal).toBe("string");
        expect(typeof line.reason).toBe("string");
        expect(typeof line.points).toBe("number");
        // Evidence can legitimately have no URL for a confirmed missing
        // website, but it can never be a made-up unexplained recommendation.
        expect(typeof line.evidence).toBe("string");
        expect((line.evidence as string).length).toBeGreaterThan(10);
      }
    }

    // Discovery/signal processing is intelligence, not an automatic decision
    // to pursue anyone. These controlled records must not become CRM leads.
    expect(await db.lead.count({ where: { workspaceId: ws.workspaceId } })).toBe(0);
  }, 180_000);

  it("refreshes the same evidence without duplicate rows and preserves a resolved historical signal", async () => {
    const quality = await db.company.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId, canonicalDomain: "site-quality.fixture.test" },
    });

    const beforeSignals = await db.signal.findMany({
      where: { companyId: quality.id },
      orderBy: { type: "asc" },
    });
    const outdatedBefore = beforeSignals.find((signal) => signal.type === "WEBSITE_OUTDATED");
    expect(outdatedBefore).toBeDefined();

    const repeat = await refreshCompanySignals({
      workspaceId: ws.workspaceId,
      companyId: quality.id,
      now: new Date("2026-09-27T00:00:00.000Z"),
      facts: {
        pageSignals: {
          reachable: true,
          isHttps: false,
          // The factual condition changed: the old footer no longer supports
          // the outdated-site signal, while the HTTP quality evidence remains.
          copyrightYear: 2026,
        },
      },
    });

    const afterSignals = await db.signal.findMany({
      where: { companyId: quality.id },
      orderBy: { type: "asc" },
    });
    const outdatedAfter = afterSignals.find((signal) => signal.type === "WEBSITE_OUTDATED");

    report.historicalChange = {
      signalsCreatedOnRefresh: repeat.signalsCreated,
      opportunitiesCreatedOnRefresh: repeat.opportunitiesCreated,
      signalsResolved: repeat.signalsResolved,
      beforeRows: beforeSignals.length,
      afterRows: afterSignals.length,
      outdatedStatus: outdatedAfter?.status ?? null,
      preservedFirstSeenAt: outdatedAfter?.firstSeenAt.toISOString() ?? null,
    };

    expect(repeat.signalsCreated).toBe(0);
    expect(repeat.opportunitiesCreated).toBe(0);
    expect(afterSignals).toHaveLength(beforeSignals.length);
    expect(outdatedAfter).toBeDefined();
    expect(outdatedAfter!.status).toBe("RESOLVED");
    expect(outdatedAfter!.resolvedAt).not.toBeNull();
    expect(outdatedAfter!.firstSeenAt).toEqual(outdatedBefore!.firstSeenAt);
  }, 120_000);
});
