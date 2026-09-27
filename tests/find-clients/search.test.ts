import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyFilters, type FindClientsFilters } from "@/lib/find-clients";
import { mapSignalsToOpportunities } from "@/lib/discovery/signals/opportunities";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const { getFindClientDetail, searchFindClients } = await import("@/lib/find-clients/search");

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

function filters(overrides: Partial<FindClientsFilters> = {}): FindClientsFilters {
  return { ...emptyFilters(), ...overrides };
}

async function company(
  workspaceId: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return db.company.create({
    data: {
      workspaceId,
      name,
      canonicalName: name.toLowerCase().replace(/\s+/g, "-"),
      canonicalDomain: `${name.toLowerCase().replace(/\s+/g, "-")}.example.test`,
      resolutionState: "RESOLVED",
      ...overrides,
    },
  });
}

describe("Find Clients search", () => {
  it("returns an empty page when the workspace has no opportunities", async () => {
    const page = await searchFindClients(alice.workspaceId, emptyFilters());
    expect(page.total).toBe(0);
    expect(page.results).toEqual([]);
  });

  it("filters stored rows and does not cross a workspace", async () => {
    const clinic = await company(alice.workspaceId, "Harbour Physio", {
      industry: "Physiotherapy clinic",
      city: "Chennai",
      website: "https://harbour.example.test",
      researchStatus: "RESEARCHED",
      lastResearchAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    const source = await db.source.create({
      data: {
        workspaceId: alice.workspaceId,
        provider: "manual",
        name: "Directory",
      },
    });
    await db.observation.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: clinic.id,
        sourceId: source.id,
        field: "industry",
        value: "Physiotherapy clinic",
        method: "MANUAL",
        confidence: 90,
        sourceUrl: "https://directory.example.test/harbour",
        evidence: "Listed as a physiotherapy clinic in Chennai.",
      },
    });
    const signal = await db.signal.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: clinic.id,
        type: "WEBSITE_OUTDATED",
        confidence: 80,
        summary: "Public pages look dated.",
        evidence: "The homepage copyright says 2014.",
        sourceUrl: "https://harbour.example.test",
      },
    });
    await db.opportunity.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: clinic.id,
        serviceKey: "WEBSITE_REDESIGN",
        score: 70,
        summary: "Potential website conversion improvement.",
        recommendedAction: "Review the public site before offering a redesign.",
        rationale: [
          {
            ruleKey: "DATED_SITE",
            signal: "WEBSITE_OUTDATED",
            reason: "Homepage copyright is 2014",
            points: 40,
            evidence: "The homepage copyright says 2014.",
            sourceUrl: "https://harbour.example.test",
          },
          { reason: "not a line" },
        ],
        signals: { connect: [{ id: signal.id }] },
      },
    });
    await db.lead.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: clinic.id,
        companyName: "Harbour Physio",
        status: "NEW",
        score: 10,
      },
    });

    const other = await company(alice.workspaceId, "Mumbai Dental", {
      industry: "Dental",
      city: "Mumbai",
      website: null,
      researchStatus: "NEVER",
    });
    const missing = await db.signal.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: other.id,
        type: "WEBSITE_MISSING",
        confidence: 60,
        summary: "No public website was found.",
        evidence: "Lookup returned no site.",
      },
    });
    await db.opportunity.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: other.id,
        serviceKey: "WEBSITE_CREATION",
        score: 40,
        summary: "A website may be absent.",
        signals: { connect: [{ id: missing.id }] },
      },
    });

    const unknown = await company(alice.workspaceId, "Quiet Studio", {
      industry: "Design",
      city: "Chennai",
      website: "",
      researchStatus: "STALE",
    });
    await db.opportunity.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: unknown.id,
        serviceKey: "CONTENT_CREATION",
        score: 20,
        status: "PURSUED",
      },
    });

    const archived = await company(alice.workspaceId, "Closed Physio", {
      industry: "Physiotherapy",
      city: "Chennai",
      archivedAt: new Date(),
    });
    await db.opportunity.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: archived.id,
        serviceKey: "WEBSITE_REDESIGN",
        score: 99,
      },
    });

    const unresolved = await company(alice.workspaceId, "Maybe Physio", {
      industry: "Physiotherapy",
      city: "Chennai",
      resolutionState: "NEEDS_REVIEW",
    });
    await db.opportunity.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: unresolved.id,
        serviceKey: "WEBSITE_REDESIGN",
        score: 99,
      },
    });

    const dismissed = await company(alice.workspaceId, "Dismissed Physio", {
      industry: "Physiotherapy",
      city: "Chennai",
      website: "https://dismissed.example.test",
    });
    await db.opportunity.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: dismissed.id,
        serviceKey: "WEBSITE_REDESIGN",
        score: 95,
        status: "DISMISSED",
      },
    });

    const foreign = await company(bob.workspaceId, "Other Physio", {
      industry: "Physiotherapy clinic",
      city: "Chennai",
      website: "https://other.example.test",
    });
    await db.opportunity.create({
      data: {
        workspaceId: bob.workspaceId,
        companyId: foreign.id,
        serviceKey: "WEBSITE_REDESIGN",
        score: 100,
        summary: "Must not leak.",
      },
    });

    const all = await searchFindClients(alice.workspaceId, emptyFilters());
    expect(all.results.map((row) => row.company.name)).toEqual([
      "Harbour Physio",
      "Mumbai Dental",
      "Quiet Studio",
    ]);
    expect(JSON.stringify(all)).not.toContain("Must not leak");
    expect(JSON.stringify(all)).not.toContain("Closed Physio");

    const harbour = all.results[0];
    expect(harbour.opportunity.score).toBe(70);
    expect(harbour.opportunity.summary).toBe("Potential website conversion improvement.");
    expect(harbour.scoreExplanation).toEqual([
      "Website redesign: 70/100 from stored opportunity rules.",
      "+40 — Homepage copyright is 2014",
    ]);
    expect(harbour.confidence).toBe(80);
    expect(harbour.evidence.some((item) => item.sourceUrl === "https://harbour.example.test")).toBe(
      true,
    );
    expect(harbour.lead?.status).toBe("NEW");

    const matched = await searchFindClients(
      alice.workspaceId,
      filters({
        industry: "physiotherapy",
        location: "chennai",
        serviceKey: "WEBSITE_REDESIGN",
        signalType: "WEBSITE_OUTDATED",
        minConfidence: 70,
        websiteStatus: "present",
        leadStatus: "NEW",
        minScore: 60,
        freshness: "fresh",
        source: "directory",
      }),
    );
    expect(matched.results.map((row) => row.company.id)).toEqual([clinic.id]);

    const missingOnly = await searchFindClients(
      alice.workspaceId,
      filters({ websiteStatus: "missing", leadStatus: "NONE", freshness: "never" }),
    );
    expect(missingOnly.results.map((row) => row.company.id)).toEqual([other.id]);

    const unknownOnly = await searchFindClients(
      alice.workspaceId,
      filters({ websiteStatus: "unknown", freshness: "stale" }),
    );
    expect(unknownOnly.results.map((row) => row.company.id)).toEqual([unknown.id]);

    const detail = await getFindClientDetail(
      alice.workspaceId,
      clinic.id,
      "WEBSITE_REDESIGN",
    );
    expect(detail?.observations[0]?.sourceName).toBe("Directory");
    expect(detail?.observations[0]?.sourceUrl).toBe("https://directory.example.test/harbour");
    expect(await getFindClientDetail(bob.workspaceId, clinic.id, "WEBSITE_REDESIGN")).toBeNull();
  });

  it("does not invent a score or an opportunity from a signal alone", async () => {
    const row = await company(alice.workspaceId, "Signal Only", {
      industry: "Physiotherapy",
      city: "Chennai",
    });
    await db.signal.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: row.id,
        type: "WEBSITE_MISSING",
        confidence: 90,
        summary: "No website.",
      },
    });

    const page = await searchFindClients(alice.workspaceId, emptyFilters());
    expect(page.total).toBe(0);

    const mapped = mapSignalsToOpportunities([
      { type: "WEBSITE_MISSING", confidence: 90, evidence: null, sourceUrl: null },
    ]);
    expect(mapped.some((item) => /definitely/i.test(item.summary ?? ""))).toBe(false);
    expect(readFileSync(path.join(process.cwd(), "src/lib/find-clients/search.ts"), "utf8")).not.toContain(
      "mapSignalsToOpportunities",
    );
  });

  it("pages at a fixed size and keeps the stored order", async () => {
    for (let index = 0; index < 26; index += 1) {
      const row = await company(alice.workspaceId, `Clinic ${String(index).padStart(2, "0")}`, {
        canonicalName: `clinic-${index}`,
        canonicalDomain: `clinic-${index}.example.test`,
      });
      await db.opportunity.create({
        data: {
          workspaceId: alice.workspaceId,
          companyId: row.id,
          serviceKey: "WEBSITE_REDESIGN",
          score: index,
        },
      });
    }

    const first = await searchFindClients(alice.workspaceId, emptyFilters(), 1);
    const second = await searchFindClients(alice.workspaceId, emptyFilters(), 2);
    expect(first.total).toBe(26);
    expect(first.results).toHaveLength(25);
    expect(first.results[0]?.opportunity.score).toBe(25);
    expect(second.results).toHaveLength(1);
    expect(second.results[0]?.opportunity.score).toBe(0);
  });
});
