import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const { ingestDiscoveredEntity, manualFact, normaliseFieldValue } = await import(
  "@/lib/discovery/ingest"
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

const AT = (iso: string) => new Date(iso);

describe("normaliseFieldValue", () => {
  it("strips control characters from hostile crawler output", () => {
    expect(normaliseFieldValue("industry", "Dental\u0000 Clinic\u001f")).toBe(
      "Dental Clinic",
    );
  });

  it("canonicalises structured fields", () => {
    expect(normaliseFieldValue("website", "https://WWW.Acme.com/?utm_source=x")).toBe(
      "https://acme.com",
    );
    expect(normaliseFieldValue("email", "  Hello@ACME.com ")).toBe("hello@acme.com");
  });

  it("returns null for unusable values rather than storing junk", () => {
    expect(normaliseFieldValue("email", "not-an-email")).toBeNull();
    expect(normaliseFieldValue("website", "javascript:alert(1)")).toBeNull();
    expect(normaliseFieldValue("industry", "   ")).toBeNull();
    expect(normaliseFieldValue("industry", null)).toBeNull();
  });
});

describe("ingestDiscoveredEntity", () => {
  it("creates a company and records provenance for every fact", async () => {
    const result = await ingestDiscoveredEntity({
      workspaceId: alice.workspaceId,
      entity: {
        identity: { name: "Acme Dental Pvt. Ltd.", website: "https://acme-dental.com" },
        facts: [
          {
            field: "website",
            value: "https://acme-dental.com",
            method: "STRUCTURED_DATA",
            sourceUrl: "https://acme-dental.com/",
            evidence: "schema.org Organization url",
          },
          { field: "city", value: "Chennai", method: "HTML_SELECTOR" },
        ],
      },
    });

    expect(result.kind).toBe("INGESTED");
    if (result.kind !== "INGESTED") throw new Error("unreachable");
    expect(result.created).toBe(true);

    const company = await db.company.findUniqueOrThrow({
      where: { id: result.companyId },
    });

    expect(company.name).toBe("Acme Dental Pvt. Ltd.");
    expect(company.canonicalName).toBe("acme dental");
    expect(company.canonicalDomain).toBe("acme-dental.com");
    expect(company.website).toBe("https://acme-dental.com");
    expect(company.city).toBe("Chennai");
    expect(company.workspaceId).toBe(alice.workspaceId);

    // Every promoted fact must be justifiable.
    const observations = await db.observation.findMany({
      where: { companyId: result.companyId },
    });
    expect(observations).toHaveLength(2);

    const websiteObs = observations.find((o) => o.field === "website");
    expect(websiteObs?.confidence).toBe(90);
    expect(websiteObs?.sourceUrl).toBe("https://acme-dental.com/");
    expect(websiteObs?.evidence).toBe("schema.org Organization url");
  });

  it("leaves unknown fields NULL instead of guessing", async () => {
    const result = await ingestDiscoveredEntity({
      workspaceId: alice.workspaceId,
      entity: {
        identity: { name: "Sparse Co", website: "https://sparse.com" },
        facts: [{ field: "city", value: "Chennai", method: "HTML_SELECTOR" }],
      },
    });

    if (result.kind !== "INGESTED") throw new Error("unreachable");
    const company = await db.company.findUniqueOrThrow({
      where: { id: result.companyId },
    });

    expect(company.email).toBeNull();
    expect(company.phone).toBeNull();
    expect(company.industry).toBeNull();
    expect(company.companySize).toBeNull();
  });

  it("matches an existing company by domain instead of duplicating it", async () => {
    const first = await ingestDiscoveredEntity({
      workspaceId: alice.workspaceId,
      entity: {
        identity: { name: "Acme Dental", website: "https://acme-dental.com" },
        facts: [{ field: "website", value: "https://acme-dental.com", method: "META_TAG" }],
      },
    });
    if (first.kind !== "INGESTED") throw new Error("unreachable");

    // A different source, different formatting, same business.
    const second = await ingestDiscoveredEntity({
      workspaceId: alice.workspaceId,
      entity: {
        identity: { name: "ACME DENTAL LIMITED", website: "http://www.acme-dental.com/x" },
        facts: [{ field: "city", value: "Chennai", method: "HTML_SELECTOR" }],
      },
    });

    expect(second.kind).toBe("INGESTED");
    if (second.kind !== "INGESTED") throw new Error("unreachable");
    expect(second.created).toBe(false);
    expect(second.companyId).toBe(first.companyId);
    expect(second.strategy).toBe("CANONICAL_DOMAIN");

    expect(await db.company.count({ where: { workspaceId: alice.workspaceId } })).toBe(1);
  });

  describe("the permanent-CRM guarantee", () => {
    it("never lets a crawler overwrite a human-entered value", async () => {
      const seeded = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity: {
          identity: { name: "Acme", website: "https://acme.com" },
          facts: [manualFact("phone", "+914445551201", "Confirmed on a call")],
        },
      });
      if (seeded.kind !== "INGESTED") throw new Error("unreachable");

      // The strongest automated method still must not win.
      const crawled = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity: {
          identity: { name: "Acme", website: "https://acme.com" },
          facts: [
            {
              field: "phone",
              value: "+919999999999",
              method: "STRUCTURED_DATA",
              observedAt: AT("2099-01-01T00:00:00Z"),
            },
          ],
        },
      });
      if (crawled.kind !== "INGESTED") throw new Error("unreachable");

      const company = await db.company.findUniqueOrThrow({
        where: { id: seeded.companyId },
      });
      expect(company.phone).toBe("+914445551201");

      const phoneField = crawled.fields.find((f) => f.field === "phone");
      expect(phoneField?.promoted).toBe(false);
      expect(phoneField?.reason).toBe("LOWER_CONFIDENCE");
    });

    it("keeps the rejected observation as evidence", async () => {
      const seeded = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity: {
          identity: { name: "Acme", website: "https://acme.com" },
          facts: [manualFact("phone", "+914445551201")],
        },
      });
      if (seeded.kind !== "INGESTED") throw new Error("unreachable");

      await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity: {
          identity: { name: "Acme", website: "https://acme.com" },
          facts: [{ field: "phone", value: "+919999999999", method: "TEXT_HEURISTIC" }],
        },
      });

      // Both the accepted and the rejected claim survive.
      const phoneObs = await db.observation.findMany({
        where: { companyId: seeded.companyId, field: "phone" },
        orderBy: { confidence: "desc" },
      });

      expect(phoneObs).toHaveLength(2);
      expect(phoneObs.map((o) => o.value)).toContain("+919999999999");
    });

    it("promotes a stronger value and supersedes the weaker one without deleting it", async () => {
      const seeded = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity: {
          identity: { name: "Acme", website: "https://acme.com" },
          facts: [
            {
              field: "email",
              value: "guess@acme.com",
              method: "TEXT_HEURISTIC",
              observedAt: AT("2026-01-01T00:00:00Z"),
            },
          ],
        },
      });
      if (seeded.kind !== "INGESTED") throw new Error("unreachable");

      const better = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity: {
          identity: { name: "Acme", website: "https://acme.com" },
          facts: [
            {
              field: "email",
              value: "hello@acme.com",
              method: "STRUCTURED_DATA",
              observedAt: AT("2026-02-01T00:00:00Z"),
            },
          ],
        },
      });
      if (better.kind !== "INGESTED") throw new Error("unreachable");

      const company = await db.company.findUniqueOrThrow({
        where: { id: seeded.companyId },
      });
      expect(company.email).toBe("hello@acme.com");

      const all = await db.observation.findMany({
        where: { companyId: seeded.companyId, field: "email" },
      });
      expect(all).toHaveLength(2);

      const superseded = all.filter((o) => o.supersededAt !== null);
      expect(superseded).toHaveLength(1);
      expect(superseded[0].value).toBe("guess@acme.com");
    });

    it("does not erase a known value when a later crawl finds nothing", async () => {
      const seeded = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity: {
          identity: { name: "Acme", website: "https://acme.com" },
          facts: [{ field: "email", value: "hello@acme.com", method: "STRUCTURED_DATA" }],
        },
      });
      if (seeded.kind !== "INGESTED") throw new Error("unreachable");

      const emptyCrawl = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity: {
          identity: { name: "Acme", website: "https://acme.com" },
          facts: [{ field: "email", value: null, method: "STRUCTURED_DATA" }],
        },
      });
      if (emptyCrawl.kind !== "INGESTED") throw new Error("unreachable");

      const company = await db.company.findUniqueOrThrow({
        where: { id: seeded.companyId },
      });
      expect(company.email).toBe("hello@acme.com");

      // But the fact that we looked and found nothing is still recorded.
      const nullObs = await db.observation.findFirst({
        where: { companyId: seeded.companyId, field: "email", value: null },
      });
      expect(nullObs).not.toBeNull();

      const outcome = emptyCrawl.fields.find((f) => f.field === "email");
      expect(outcome?.reason).toBe("NO_VALUE_OBSERVED");
    });

    it("refuses to promote a value below the confidence threshold", async () => {
      const result = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity: {
          identity: { name: "Acme", website: "https://acme.com" },
          // INFERRED = 25, below PROMOTION_THRESHOLD of 40.
          facts: [{ field: "industry", value: "Probably dentistry", method: "INFERRED" }],
        },
      });
      if (result.kind !== "INGESTED") throw new Error("unreachable");

      const company = await db.company.findUniqueOrThrow({
        where: { id: result.companyId },
      });
      expect(company.industry).toBeNull();

      // The weak sighting is still on record.
      const obs = await db.observation.findFirst({
        where: { companyId: result.companyId, field: "industry" },
      });
      expect(obs?.value).toBe("Probably dentistry");
      expect(obs?.confidence).toBe(25);
    });
  });

  describe("weak matches go to review, never to a merge", () => {
    it("creates a NEEDS_REVIEW company for a name-only collision", async () => {
      const first = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity: {
          identity: { name: "Sunrise Dental" },
          facts: [{ field: "city", value: "Chennai", method: "HTML_SELECTOR" }],
        },
      });
      if (first.kind !== "INGESTED") throw new Error("unreachable");

      const second = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity: {
          identity: { name: "Sunrise Dental" },
          facts: [{ field: "city", value: "Mumbai", method: "HTML_SELECTOR" }],
        },
      });

      expect(second.kind).toBe("NEEDS_REVIEW");
      if (second.kind !== "NEEDS_REVIEW") throw new Error("unreachable");
      expect(second.companyId).not.toBe(first.companyId);
      expect(second.candidateIds).toContain(first.companyId);

      const flagged = await db.company.findUniqueOrThrow({
        where: { id: second.companyId },
      });
      expect(flagged.resolutionState).toBe("NEEDS_REVIEW");

      // The original is untouched: a weak match must not mutate known data.
      const original = await db.company.findUniqueOrThrow({
        where: { id: first.companyId },
      });
      expect(original.city).toBe("Chennai");
      expect(original.resolutionState).toBe("RESOLVED");
    });
  });

  describe("workspace isolation", () => {
    it("never matches a company belonging to another workspace", async () => {
      const aliceCo = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity: {
          identity: { name: "Shared Name", website: "https://shared.com" },
          facts: [{ field: "city", value: "Chennai", method: "HTML_SELECTOR" }],
        },
      });
      if (aliceCo.kind !== "INGESTED") throw new Error("unreachable");

      const bobCo = await ingestDiscoveredEntity({
        workspaceId: bob.workspaceId,
        entity: {
          identity: { name: "Shared Name", website: "https://shared.com" },
          facts: [{ field: "city", value: "Mumbai", method: "HTML_SELECTOR" }],
        },
      });
      if (bobCo.kind !== "INGESTED") throw new Error("unreachable");

      // Same domain, two tenants: two separate records.
      expect(bobCo.companyId).not.toBe(aliceCo.companyId);
      expect(bobCo.created).toBe(true);

      const aliceRecord = await db.company.findUniqueOrThrow({
        where: { id: aliceCo.companyId },
      });
      expect(aliceRecord.city).toBe("Chennai");
      expect(aliceRecord.workspaceId).toBe(alice.workspaceId);
    });
  });

  describe("idempotency", () => {
    it("re-ingesting identical data does not duplicate the company", async () => {
      const entity = {
        identity: { name: "Acme Dental", website: "https://acme-dental.com" },
        facts: [
          {
            field: "email" as const,
            value: "hello@acme-dental.com",
            method: "STRUCTURED_DATA" as const,
            observedAt: AT("2026-03-01T00:00:00Z"),
          },
        ],
      };

      const first = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity,
      });
      const second = await ingestDiscoveredEntity({
        workspaceId: alice.workspaceId,
        entity,
      });

      if (first.kind !== "INGESTED" || second.kind !== "INGESTED") {
        throw new Error("unreachable");
      }
      expect(second.companyId).toBe(first.companyId);
      expect(await db.company.count({ where: { workspaceId: alice.workspaceId } })).toBe(
        1,
      );

      // Same confidence and not newer, so the value is left alone.
      const emailField = second.fields.find((f) => f.field === "email");
      expect(emailField?.promoted).toBe(false);
      expect(emailField?.reason).toBe("SAME_CONFIDENCE_NOT_NEWER");
    });
  });

  it("skips input that cannot identify a business", async () => {
    const result = await ingestDiscoveredEntity({
      workspaceId: alice.workspaceId,
      entity: { identity: { phone: "+914445551201" }, facts: [] },
    });

    expect(result.kind).toBe("SKIPPED");
    expect(await db.company.count()).toBe(0);
  });

  it("links a lead to a company without touching the lead's own data", async () => {
    const ingested = await ingestDiscoveredEntity({
      workspaceId: alice.workspaceId,
      entity: {
        identity: { name: "Acme Dental", website: "https://acme-dental.com" },
        facts: [{ field: "city", value: "Chennai", method: "HTML_SELECTOR" }],
      },
    });
    if (ingested.kind !== "INGESTED") throw new Error("unreachable");

    const lead = await db.lead.create({
      data: {
        workspaceId: alice.workspaceId,
        companyName: "Acme Dental",
        status: "QUALIFIED",
        score: 71,
        companyId: ingested.companyId,
      },
    });

    // Deleting the company must not remove the lead: CRM records are permanent.
    await db.company.delete({ where: { id: ingested.companyId } });

    const survivor = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(survivor.companyName).toBe("Acme Dental");
    expect(survivor.score).toBe(71);
    expect(survivor.companyId).toBeNull();
  });
});
