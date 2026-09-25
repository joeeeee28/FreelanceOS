import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MAX_EXCERPT_CHARS } from "@/lib/knowledge/classify";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const { ingestKnowledgeResource, searchKnowledge } = await import(
  "@/lib/knowledge/ingest"
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

const ARTICLE = {
  url: "https://example.test/blog/meta-ads-guide",
  title: "A practical guide to Meta Ads",
  content:
    "Meta Ads can be daunting. This guide covers ad spend, ROAS and how to " +
    "structure campaigns. We also touch on Facebook ads for local business.",
  sourceName: "Example Blog",
  author: "J. Smith",
};

describe("ingestKnowledgeResource", () => {
  it("stores a classified resource", async () => {
    const result = await ingestKnowledgeResource({
      workspaceId: alice.workspaceId,
      input: ARTICLE,
    });

    expect(result.kind).toBe("CREATED");

    const resource = await db.knowledgeResource.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });

    expect(resource.title).toBe("A practical guide to Meta Ads");
    expect(resource.sourceType).toBe("BLOG");
    expect(resource.relevanceScore).toBeGreaterThan(0);
  });

  describe("what it deliberately does not keep", () => {
    it("has no column for the full content", async () => {
      await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: ARTICLE,
      });

      const resource = await db.knowledgeResource.findFirstOrThrow({
        where: { workspaceId: alice.workspaceId },
      });

      // Storing someone's whole article would be convenient for search and
      // wrong. The schema makes it impossible rather than merely discouraged.
      expect("content" in resource).toBe(false);
      expect("fullText" in resource).toBe(false);
      expect("body" in resource).toBe(false);
    });

    it("caps the excerpt it retains", async () => {
      await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: {
          url: "https://example.test/long",
          title: "Long piece on seo",
          content: "This is a sentence about search engine work. ".repeat(200),
        },
      });

      const resource = await db.knowledgeResource.findFirstOrThrow({
        where: { workspaceId: alice.workspaceId },
      });

      expect(resource.excerpt!.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS + 1);
    });

    it("keeps attribution alongside the excerpt", async () => {
      await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: ARTICLE,
      });

      const resource = await db.knowledgeResource.findFirstOrThrow({
        where: { workspaceId: alice.workspaceId },
      });

      // An excerpt without a link back is just copying.
      expect(resource.url).toBe(ARTICLE.url);
      expect(resource.sourceName).toBe("Example Blog");
      expect(resource.author).toBe("J. Smith");
    });
  });

  it("strips HTML before storing anything", async () => {
    await ingestKnowledgeResource({
      workspaceId: alice.workspaceId,
      input: {
        url: "https://example.test/html",
        title: "Instagram tips",
        content:
          "<p>Great <b>instagram</b> content.</p><script>alert('xss')</script>",
      },
    });

    const resource = await db.knowledgeResource.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });

    // Crawled markup is untrusted and never reaches storage intact.
    expect(resource.summary).not.toContain("<");
    expect(resource.summary).not.toContain("alert");
    expect(resource.excerpt ?? "").not.toContain("<script");
  });

  it("links the topics it identified", async () => {
    await ingestKnowledgeResource({
      workspaceId: alice.workspaceId,
      input: ARTICLE,
    });

    const resource = await db.knowledgeResource.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
      include: { topics: { include: { topic: true } } },
    });

    expect(resource.topics.length).toBeGreaterThan(0);
    expect(resource.topics[0].confidence).toBeGreaterThan(0);
    expect(resource.topics.map((t) => t.topic.slug)).toContain("paid-advertising");
  });

  it("records which services a resource is relevant to", async () => {
    await ingestKnowledgeResource({
      workspaceId: alice.workspaceId,
      input: ARTICLE,
    });

    const resource = await db.knowledgeResource.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });

    expect(resource.serviceRelevance).toContain("META_ADS");
  });

  it("explains its relevance score", async () => {
    await ingestKnowledgeResource({
      workspaceId: alice.workspaceId,
      input: ARTICLE,
    });

    const resource = await db.knowledgeResource.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });

    const rationale = resource.rationale as Array<{ code: string; points: number }>;
    expect(rationale.length).toBeGreaterThan(0);
    expect(rationale.every((line) => typeof line.code === "string")).toBe(true);
  });

  describe("deduplication", () => {
    it("updates rather than duplicating a known URL", async () => {
      await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: ARTICLE,
      });
      const second = await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: { ...ARTICLE, title: "A better title about Meta Ads" },
      });

      expect(second.kind).toBe("UPDATED");
      expect(await db.knowledgeResource.count()).toBe(1);

      const resource = await db.knowledgeResource.findFirstOrThrow({
        where: { workspaceId: alice.workspaceId },
      });
      expect(resource.title).toBe("A better title about Meta Ads");
    });

    it("treats equivalent URLs as one resource", async () => {
      await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: ARTICLE,
      });
      await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: { ...ARTICLE, url: `${ARTICLE.url}?utm_source=newsletter` },
      });

      expect(await db.knowledgeResource.count()).toBe(1);
    });

    it("keeps the original discoveredAt on update", async () => {
      const first = new Date("2026-01-01T00:00:00Z");

      await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: ARTICLE,
        now: first,
      });
      await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: ARTICLE,
        now: new Date("2026-06-01T00:00:00Z"),
      });

      const resource = await db.knowledgeResource.findFirstOrThrow({
        where: { workspaceId: alice.workspaceId },
      });
      expect(resource.discoveredAt.toISOString()).toBe(first.toISOString());
    });

    it("removes a topic tag that no longer applies", async () => {
      await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: ARTICLE,
      });

      await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: {
          ...ARTICLE,
          title: "Now about wordpress and css only",
          content: "This piece is about wordpress, css and html.",
        },
      });

      const resource = await db.knowledgeResource.findFirstOrThrow({
        where: { workspaceId: alice.workspaceId },
        include: { topics: { include: { topic: true } } },
      });

      // A stale tag is a wrong answer in search.
      expect(resource.topics.map((t) => t.topic.slug)).not.toContain(
        "paid-advertising",
      );
    });
  });

  describe("input it refuses", () => {
    it("rejects a non-http URL", async () => {
      for (const url of ["mailto:a@b.test", "javascript:alert(1)", "not a url"]) {
        const result = await ingestKnowledgeResource({
          workspaceId: alice.workspaceId,
          input: { url, title: "seo guide" },
        });
        expect(result.kind).toBe("SKIPPED");
      }

      expect(await db.knowledgeResource.count()).toBe(0);
    });

    it("rejects a resource with nothing to classify", async () => {
      const result = await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: { url: "https://example.test/empty", title: "", content: "" },
      });

      expect(result.kind).toBe("SKIPPED");
    });

    it("does not resurrect an archived resource", async () => {
      await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: ARTICLE,
      });
      await db.knowledgeResource.updateMany({
        where: { workspaceId: alice.workspaceId },
        data: { archivedAt: new Date() },
      });

      const result = await ingestKnowledgeResource({
        workspaceId: alice.workspaceId,
        input: ARTICLE,
      });

      expect(result.kind).toBe("SKIPPED");

      const resource = await db.knowledgeResource.findFirstOrThrow({
        where: { workspaceId: alice.workspaceId },
      });
      expect(resource.archivedAt).not.toBeNull();
    });
  });

  it("stores a resource with no recognisable topics without inventing any", async () => {
    await ingestKnowledgeResource({
      workspaceId: alice.workspaceId,
      input: {
        url: "https://example.test/weather",
        title: "The weather this week",
        content: "It will be mild and pleasant throughout.",
      },
    });

    const resource = await db.knowledgeResource.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
      include: { topics: true },
    });

    expect(resource.topics).toHaveLength(0);
    expect(resource.relevanceScore).toBe(0);
  });

  it("keeps workspaces separate", async () => {
    await ingestKnowledgeResource({
      workspaceId: alice.workspaceId,
      input: ARTICLE,
    });
    await ingestKnowledgeResource({
      workspaceId: bob.workspaceId,
      input: ARTICLE,
    });

    // The same URL is a separate resource in each workspace.
    expect(
      await db.knowledgeResource.count({ where: { workspaceId: alice.workspaceId } }),
    ).toBe(1);
    expect(
      await db.knowledgeResource.count({ where: { workspaceId: bob.workspaceId } }),
    ).toBe(1);
    expect(
      await db.knowledgeTopic.count({ where: { workspaceId: bob.workspaceId } }),
    ).toBeGreaterThan(0);
  });
});

describe("searchKnowledge", () => {
  beforeEach(async () => {
    await ingestKnowledgeResource({
      workspaceId: alice.workspaceId,
      input: ARTICLE,
    });
    await ingestKnowledgeResource({
      workspaceId: alice.workspaceId,
      input: {
        url: "https://example.test/blog/instagram",
        title: "Growing on Instagram",
        content: "Instagram reels and engagement rate for social media growth.",
      },
    });
  });

  it("returns everything when unfiltered", async () => {
    const results = await searchKnowledge({ workspaceId: alice.workspaceId });
    expect(results).toHaveLength(2);
  });

  it("matches on title regardless of case", async () => {
    const results = await searchKnowledge({
      workspaceId: alice.workspaceId,
      query: "instagram",
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Growing on Instagram");
  });

  it("filters by topic", async () => {
    const results = await searchKnowledge({
      workspaceId: alice.workspaceId,
      topicSlug: "paid-advertising",
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("Meta Ads");
  });

  it("orders by relevance", async () => {
    const results = await searchKnowledge({ workspaceId: alice.workspaceId });
    const scores = results.map((r) => r.relevanceScore);

    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("hides archived resources", async () => {
    await db.knowledgeResource.updateMany({
      where: { workspaceId: alice.workspaceId },
      data: { archivedAt: new Date() },
    });

    expect(await searchKnowledge({ workspaceId: alice.workspaceId })).toEqual([]);
  });

  it("never returns another workspace's resources", async () => {
    expect(await searchKnowledge({ workspaceId: bob.workspaceId })).toEqual([]);
  });

  it("returns nothing for a query that matches nothing", async () => {
    expect(
      await searchKnowledge({ workspaceId: alice.workspaceId, query: "zzzz" }),
    ).toEqual([]);
  });
});
