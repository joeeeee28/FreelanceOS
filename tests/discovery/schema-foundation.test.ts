import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

/**
 * Guards the structural promises of the P5 schema: workspace isolation,
 * deduplication, and the rule that CRM history is never destroyed by the
 * intelligence layer.
 */

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

async function makeCompany(workspaceId: string, domain: string | null = "acme.com") {
  return db.company.create({
    data: {
      workspaceId,
      name: "Acme Ltd",
      canonicalName: "acme",
      canonicalDomain: domain,
    },
  });
}

describe("ResearchRun", () => {
  it("starts every company as NEVER researched", async () => {
    const company = await makeCompany(alice.workspaceId);
    expect(company.researchStatus).toBe("NEVER");
  });

  it("keeps a full history rather than overwriting the last run", async () => {
    const company = await makeCompany(alice.workspaceId);

    await db.researchRun.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        aspect: "WEBSITE",
        status: "RESEARCHED",
        factsFound: 3,
        startedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await db.researchRun.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        aspect: "WEBSITE",
        status: "RESEARCHED",
        factsFound: 5,
        startedAt: new Date("2026-06-01T00:00:00Z"),
      },
    });

    const runs = await db.researchRun.findMany({
      where: { companyId: company.id, aspect: "WEBSITE" },
      orderBy: { startedAt: "asc" },
    });

    // Both passes survive: "what did we know, and when" stays answerable.
    expect(runs).toHaveLength(2);
    expect(runs[0].factsFound).toBe(3);
    expect(runs[1].factsFound).toBe(5);
  });

  it("tracks each aspect independently", async () => {
    const company = await makeCompany(alice.workspaceId);

    await db.researchRun.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        aspect: "WEBSITE",
        status: "RESEARCHED",
      },
    });
    await db.researchRun.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        aspect: "HIRING",
        status: "BLOCKED",
      },
    });

    const blocked = await db.researchRun.findMany({
      where: { companyId: company.id, status: "BLOCKED" },
    });

    // One blocked aspect does not mark the whole company blocked.
    expect(blocked).toHaveLength(1);
    expect(blocked[0].aspect).toBe("HIRING");
  });
});

describe("DiscoveredContact", () => {
  it("stages people outside the CRM Contact table", async () => {
    const company = await makeCompany(alice.workspaceId);

    await db.discoveredContact.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fullName: "Meera Iyer",
        canonicalName: "meera iyer",
        confidence: 60,
        method: "HTML_SELECTOR",
      },
    });

    // The user's real contact list is untouched by discovery.
    expect(await db.contact.count({ where: { workspaceId: alice.workspaceId } })).toBe(
      0,
    );
    expect(
      await db.discoveredContact.count({ where: { workspaceId: alice.workspaceId } }),
    ).toBe(1);
  });

  it("defaults to UNVERIFIED and unpromoted", async () => {
    const company = await makeCompany(alice.workspaceId);

    const contact = await db.discoveredContact.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fullName: "Anon",
        canonicalName: "anon",
        confidence: 25,
        method: "TEXT_HEURISTIC",
      },
    });

    expect(contact.verification).toBe("UNVERIFIED");
    expect(contact.isDecisionMaker).toBe(false);
    expect(contact.promotedContactId).toBeNull();
    expect(contact.promotedAt).toBeNull();
  });

  it("refuses to store the same person twice for one company", async () => {
    const company = await makeCompany(alice.workspaceId);

    const base = {
      workspaceId: alice.workspaceId,
      companyId: company.id,
      canonicalName: "meera iyer",
      confidence: 60,
      method: "HTML_SELECTOR" as const,
    };

    await db.discoveredContact.create({ data: { ...base, fullName: "Meera Iyer" } });

    await expect(
      db.discoveredContact.create({ data: { ...base, fullName: "Meera  Iyer" } }),
    ).rejects.toThrow();
  });

  it("allows the same person at two different companies", async () => {
    const one = await makeCompany(alice.workspaceId, "one.com");
    const two = await makeCompany(alice.workspaceId, "two.com");

    const base = {
      workspaceId: alice.workspaceId,
      fullName: "Meera Iyer",
      canonicalName: "meera iyer",
      confidence: 60,
      method: "HTML_SELECTOR" as const,
    };

    await db.discoveredContact.create({ data: { ...base, companyId: one.id } });
    await db.discoveredContact.create({ data: { ...base, companyId: two.id } });

    expect(await db.discoveredContact.count()).toBe(2);
  });
});

describe("KnowledgeResource", () => {
  it("deduplicates by canonical URL within a workspace", async () => {
    const base = {
      workspaceId: alice.workspaceId,
      title: "A useful article",
      url: "https://example.test/post",
      canonicalUrl: "https://example.test/post",
    };

    await db.knowledgeResource.create({ data: base });

    await expect(
      db.knowledgeResource.create({ data: { ...base, title: "Same page again" } }),
    ).rejects.toThrow();
  });

  it("lets two workspaces each keep their own copy", async () => {
    const base = {
      title: "A useful article",
      url: "https://example.test/post",
      canonicalUrl: "https://example.test/post",
    };

    await db.knowledgeResource.create({
      data: { ...base, workspaceId: alice.workspaceId },
    });
    await db.knowledgeResource.create({
      data: { ...base, workspaceId: bob.workspaceId },
    });

    expect(await db.knowledgeResource.count()).toBe(2);
  });

  it("links resources to topics with their own confidence", async () => {
    const resource = await db.knowledgeResource.create({
      data: {
        workspaceId: alice.workspaceId,
        title: "Local SEO in 2026",
        url: "https://example.test/seo",
        canonicalUrl: "https://example.test/seo",
        sourceType: "ARTICLE",
      },
    });

    const topic = await db.knowledgeTopic.create({
      data: { workspaceId: alice.workspaceId, name: "Local SEO", slug: "local-seo" },
    });

    await db.knowledgeResourceTopic.create({
      data: { resourceId: resource.id, topicId: topic.id, confidence: 80 },
    });

    const withTopics = await db.knowledgeResource.findUniqueOrThrow({
      where: { id: resource.id },
      include: { topics: { include: { topic: true } } },
    });

    expect(withTopics.topics).toHaveLength(1);
    expect(withTopics.topics[0].topic.name).toBe("Local SEO");
    expect(withTopics.topics[0].confidence).toBe(80);
  });

  it("stores attribution rather than wholesale content", async () => {
    const resource = await db.knowledgeResource.create({
      data: {
        workspaceId: alice.workspaceId,
        title: "Original research",
        url: "https://example.test/r",
        canonicalUrl: "https://example.test/r",
        author: "A. Writer",
        sourceName: "Example Journal",
        summary: "Our own one-paragraph summary.",
      },
    });

    // Attribution fields are present; there is no field holding full text.
    expect(resource.author).toBe("A. Writer");
    expect(resource.sourceName).toBe("Example Journal");
    expect(resource.url).toBe("https://example.test/r");
    expect(Object.keys(resource)).not.toContain("content");
    expect(Object.keys(resource)).not.toContain("fullText");
  });
});

describe("Opportunity", () => {
  it("carries a recommended action and detection time", async () => {
    const company = await makeCompany(alice.workspaceId);

    const opportunity = await db.opportunity.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        serviceKey: "WEBSITE_REDESIGN",
        score: 60,
        recommendedAction: "Offer a website rebuild",
      },
    });

    expect(opportunity.recommendedAction).toBe("Offer a website rebuild");
    expect(opportunity.detectedAt).toBeInstanceOf(Date);
  });
});

describe("workspace isolation across the new tables", () => {
  it("never leaks rows between workspaces", async () => {
    const aliceCo = await makeCompany(alice.workspaceId, "alice.com");
    const bobCo = await makeCompany(bob.workspaceId, "bob.com");

    await db.researchRun.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: aliceCo.id,
        aspect: "WEBSITE",
        status: "RESEARCHED",
      },
    });
    await db.discoveredContact.create({
      data: {
        workspaceId: bob.workspaceId,
        companyId: bobCo.id,
        fullName: "Bob Person",
        canonicalName: "bob person",
        confidence: 60,
        method: "HTML_SELECTOR",
      },
    });
    await db.knowledgeResource.create({
      data: {
        workspaceId: bob.workspaceId,
        title: "Bob's article",
        url: "https://b.test/a",
        canonicalUrl: "https://b.test/a",
      },
    });

    expect(
      await db.researchRun.count({ where: { workspaceId: bob.workspaceId } }),
    ).toBe(0);
    expect(
      await db.discoveredContact.count({ where: { workspaceId: alice.workspaceId } }),
    ).toBe(0);
    expect(
      await db.knowledgeResource.count({ where: { workspaceId: alice.workspaceId } }),
    ).toBe(0);
  });
});

describe("historical preservation", () => {
  it("keeps the lead when its company is deleted", async () => {
    const company = await makeCompany(alice.workspaceId);

    const lead = await db.lead.create({
      data: {
        workspaceId: alice.workspaceId,
        companyName: "Acme Ltd",
        status: "QUALIFIED",
        score: 71,
        companyId: company.id,
      },
    });

    await db.company.delete({ where: { id: company.id } });

    const survivor = await db.lead.findUnique({ where: { id: lead.id } });
    expect(survivor).not.toBeNull();
    expect(survivor!.score).toBe(71);
    expect(survivor!.companyId).toBeNull();
  });

  it("keeps activities when a company is deleted", async () => {
    const company = await makeCompany(alice.workspaceId);

    const lead = await db.lead.create({
      data: {
        workspaceId: alice.workspaceId,
        companyName: "Acme Ltd",
        companyId: company.id,
      },
    });

    await db.activity.create({
      data: {
        workspaceId: alice.workspaceId,
        leadId: lead.id,
        type: "LEAD_CREATED",
        title: "Lead created",
      },
    });

    await db.company.delete({ where: { id: company.id } });

    expect(
      await db.activity.count({ where: { workspaceId: alice.workspaceId } }),
    ).toBe(1);
  });
});
