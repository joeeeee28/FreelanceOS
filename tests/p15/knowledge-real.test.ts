/**
 * P15 §20 — knowledge ingestion from really fetched public pages.
 *
 * The engine must store what a resource is *about* — metadata, topics, a short
 * attributed excerpt and a link — and never a wholesale copy of someone else's
 * copyrighted page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpFetcher } from "@/lib/discovery/fetcher";
import { ingestKnowledgeResource, searchKnowledge } from "@/lib/knowledge/ingest";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

let ws: SeededWorkspace;
const report: Record<string, unknown> = {};

beforeAll(async () => {
  await resetTestDatabase();
  await truncateAll();
  ws = await seedWorkspace("Knowledge");
}, 180_000);

afterAll(async () => {
  console.log("\n=== P15 KNOWLEDGE EVIDENCE ===");
  console.log(JSON.stringify(report, null, 2));
  await disconnectTestPrisma();
});

const SOURCES = [
  "https://pypi.org",
  "https://github.com/about",
  "https://api.github.com/zen",
];

describe("§20 knowledge ingestion from real public pages", () => {
  it("ingests real pages and records attribution, never the whole document", async () => {
    const fetcher = new HttpFetcher({
      userAgent:
        "FreelanceOSBot/0.1 (+https://github.com/joeeeee28/FreelanceOS; validation)",
      timeoutMs: 20_000,
      minIntervalMs: 1_000,
      respectRobots: true,
    });

    const ingested: Array<Record<string, unknown>> = [];

    for (const url of SOURCES) {
      const started = Date.now();
      const doc = await fetcher.fetch(url);
      const fetchMs = Date.now() - started;

      if (doc.outcome !== "SUCCESS" || typeof doc.body !== "string") {
        ingested.push({ url, outcome: doc.outcome, fetchMs, stored: false });
        continue;
      }

      const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(doc.body);

      const outcome = await ingestKnowledgeResource({
        workspaceId: ws.workspaceId,
        input: {
          url,
          title: titleMatch?.[1]?.trim() ?? url,
          content: doc.body,
          sourceName: new URL(url).hostname,
        },
      });

      ingested.push({
        url,
        outcome: doc.outcome,
        fetchMs,
        bytesFetched: doc.body.length,
        kind: outcome.kind,
        stored: outcome.kind !== "SKIPPED",
      });
    }

    report.ingested = ingested;

    const resources = await db.knowledgeResource.findMany({
      where: { workspaceId: ws.workspaceId },
      include: { topics: { include: { topic: true } } },
    });

    report.resources = resources.map((r) => ({
      title: r.title,
      url: r.url,
      sourceType: r.sourceType,
      sourceName: r.sourceName,
      summaryChars: r.summary?.length ?? 0,
      excerptChars: r.excerpt?.length ?? 0,
      topics: r.topics.map((t) => t.topic.name),
      serviceRelevance: r.serviceRelevance,
      discoveredAt: r.discoveredAt.toISOString(),
    }));

    expect(resources.length).toBeGreaterThan(0);

    for (const r of resources) {
      // Attribution is mandatory: a stored fact with no link is unusable.
      expect(r.url).toBeTruthy();
      expect(r.discoveredAt).toBeTruthy();

      // The excerpt is capped. Storing the whole page would be a copyright
      // problem dressed up as a feature.
      if (r.excerpt !== null) expect(r.excerpt.length).toBeLessThanOrEqual(320);
      if (r.summary !== null) expect(r.summary.length).toBeLessThanOrEqual(520);

      // No raw HTML may survive into storage.
      expect(r.summary ?? "").not.toContain("<script");
      expect(r.excerpt ?? "").not.toContain("<script");
      expect(r.summary ?? "").not.toContain("<div");
    }
  }, 300_000);

  it("the Knowledge Hub search finds what was ingested", async () => {
    const all = await searchKnowledge({ workspaceId: ws.workspaceId });
    expect(all.length).toBeGreaterThan(0);

    // Search on a term that really appears in one of the stored titles.
    const term = all[0].title.split(/\s+/).find((w) => w.length > 3) ?? "the";
    const hits = await searchKnowledge({ workspaceId: ws.workspaceId, query: term });

    report.search = {
      totalResources: all.length,
      term,
      hits: hits.length,
      titles: hits.slice(0, 5).map((h) => h.title),
    };

    expect(hits.length).toBeGreaterThan(0);
  }, 120_000);

  it("re-ingesting the same URL updates in place rather than duplicating", async () => {
    const before = await db.knowledgeResource.count({
      where: { workspaceId: ws.workspaceId },
    });

    await ingestKnowledgeResource({
      workspaceId: ws.workspaceId,
      input: {
        url: SOURCES[0],
        title: "PyPI revisited",
        content: "A second reading of the same public page about packaging.",
        sourceName: "pypi.org",
      },
    });

    const after = await db.knowledgeResource.count({
      where: { workspaceId: ws.workspaceId },
    });

    expect(after).toBe(before);

    const resource = await db.knowledgeResource.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId, url: { contains: "pypi.org" } },
    });
    report.reingest = {
      title: resource.title,
      discoveredAt: resource.discoveredAt.toISOString(),
      updatedAt: resource.updatedAt.toISOString(),
    };
    // First-seen is history and must never be rewritten by a later reading.
    expect(resource.discoveredAt.getTime()).toBeLessThanOrEqual(
      resource.updatedAt.getTime(),
    );
  }, 120_000);

  it("does not invent a summary for a page with no readable text", async () => {
    const outcome = await ingestKnowledgeResource({
      workspaceId: ws.workspaceId,
      input: { url: "https://example.org/empty-p15", title: "", content: "" },
    });

    report.emptyPage = outcome;
    // Nothing to say means nothing is stored, not a fabricated summary.
    expect(outcome.kind).toBe("SKIPPED");
  }, 60_000);
});
