import { describe, expect, it } from "vitest";

import {
  buildExcerpt,
  buildSummary,
  classifySourceType,
  classifyTopics,
  MAX_EXCERPT_CHARS,
  MAX_SUMMARY_CHARS,
  sanitiseText,
  scoreRelevance,
  servicesForTopics,
} from "@/lib/knowledge/classify";
import { isServiceKey } from "@/lib/taxonomy/services";

describe("classifySourceType", () => {
  it("recognises known hosts", () => {
    expect(classifySourceType("https://github.com/acme/repo")).toBe("REPOSITORY");
    expect(classifySourceType("https://www.youtube.com/watch?v=x")).toBe("VIDEO");
    expect(classifySourceType("https://reddit.com/r/web")).toBe("COMMUNITY");
  });

  it("recognises a subdomain of a known host", () => {
    expect(classifySourceType("https://gist.github.com/x")).toBe("REPOSITORY");
  });

  it("recognises path conventions", () => {
    expect(classifySourceType("https://acme.test/blog/a-post")).toBe("BLOG");
    expect(classifySourceType("https://acme.test/docs/getting-started")).toBe(
      "DOCUMENTATION",
    );
  });

  it("falls back to the title for a tutorial", () => {
    expect(classifySourceType("https://acme.test/x", "How to set up GA4")).toBe(
      "TUTORIAL",
    );
  });

  it("says OTHER rather than guessing", () => {
    // A wrong label is worse than an honest "unclassified".
    expect(classifySourceType("https://acme.test/some-page")).toBe("OTHER");
  });

  it("does not throw on a malformed URL", () => {
    expect(classifySourceType("not a url")).toBe("OTHER");
  });
});

describe("classifyTopics", () => {
  it("finds a topic from its keywords", () => {
    const topics = classifyTopics("A guide to Meta Ads and managing ad spend for ROAS.");

    expect(topics[0].slug).toBe("paid-advertising");
    expect(topics[0].matchedTerms.length).toBeGreaterThan(1);
  });

  it("justifies every match with the words that appeared", () => {
    const [topic] = classifyTopics("Improving your SERP position with keyword research.");

    // The matched terms are the entire justification for the tag.
    expect(topic.matchedTerms.every((term) => term.length > 0)).toBe(true);
    for (const term of topic.matchedTerms) {
      expect("improving your serp position with keyword research.").toContain(term);
    }
  });

  it("matches whole words only", () => {
    // "ui" must not match "building", "seo" must not match "Seoul".
    const topics = classifyTopics("Building offices in Seoul and Dubai.");
    expect(topics).toEqual([]);
  });

  it("rates a topic mentioned repeatedly above one mentioned once", () => {
    const passing = classifyTopics("We also mention seo briefly.");
    const thorough = classifyTopics(
      "An seo guide: search engine basics, backlink building and keyword research.",
    );

    expect(thorough[0].confidence).toBeGreaterThan(passing[0].confidence);
  });

  it("returns nothing for empty or irrelevant text", () => {
    expect(classifyTopics("")).toEqual([]);
    expect(classifyTopics("The weather today is mild and pleasant.")).toEqual([]);
  });

  it("limits how many topics it reports", () => {
    const text =
      "seo ppc instagram wordpress branding analytics youtube shopify freelance " +
      "small business content marketing web design";

    expect(classifyTopics(text, 3)).toHaveLength(3);
  });

  it("is deterministic", () => {
    const text = "A guide to Instagram reels and content marketing.";
    expect(classifyTopics(text)).toEqual(classifyTopics(text));
  });
});

describe("servicesForTopics", () => {
  it("maps topics to real services", () => {
    const services = servicesForTopics([
      { slug: "paid-advertising", confidence: 70, matchedTerms: ["ppc"] },
    ]);

    expect(services).toContain("META_ADS");
    for (const service of services) {
      expect(isServiceKey(service)).toBe(true);
    }
  });

  it("deduplicates services shared by several topics", () => {
    const services = servicesForTopics([
      { slug: "web-design", confidence: 70, matchedTerms: ["ux"] },
      { slug: "web-development", confidence: 70, matchedTerms: ["css"] },
    ]);

    expect(new Set(services).size).toBe(services.length);
  });

  it("returns nothing for topics with no service link", () => {
    expect(
      servicesForTopics([{ slug: "freelancing", confidence: 90, matchedTerms: ["freelance"] }]),
    ).toEqual([]);
  });
});

describe("sanitiseText", () => {
  it("strips control characters", () => {
    expect(sanitiseText("hello\u0000\u0007world")).toBe("hello world");
  });

  it("collapses whitespace", () => {
    expect(sanitiseText("  a \n\n b  \t c ")).toBe("a b c");
  });
});

describe("buildExcerpt", () => {
  it("keeps short text whole", () => {
    expect(buildExcerpt("A short sentence.")).toBe("A short sentence.");
  });

  it("caps long text", () => {
    const excerpt = buildExcerpt("word ".repeat(500));

    // The cap is what makes this quotation rather than copying.
    expect(excerpt).not.toBeNull();
    expect(excerpt!.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS + 1);
  });

  it("cuts at a word boundary rather than mid-word", () => {
    const source = "alpha bravo charlie delta ".repeat(40).trim();
    const excerpt = buildExcerpt(source);

    expect(excerpt).toMatch(/…$/);

    // The kept text must be a whole-word prefix of the original: every word
    // it ends on is complete, never a fragment like "char".
    const kept = excerpt!.slice(0, -1);
    expect(source.startsWith(kept)).toBe(true);
    expect(source[kept.length]).toBe(" ");
  });

  it("returns null for empty text", () => {
    expect(buildExcerpt("   ")).toBeNull();
  });
});

describe("buildSummary", () => {
  it("selects whole opening sentences", () => {
    const summary = buildSummary(
      "First sentence here. Second sentence here. Third sentence here.",
    );

    expect(summary).toContain("First sentence here.");
    // Extractive, so it cannot assert anything the source did not.
    expect(summary).not.toContain("In conclusion");
  });

  it("stays within the cap", () => {
    const summary = buildSummary("This is a sentence. ".repeat(200));

    expect(summary!.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
  });

  it("handles text with no sentence punctuation", () => {
    expect(buildSummary("just some words with no full stop")).toBeTruthy();
  });

  it("returns null for empty text", () => {
    expect(buildSummary("")).toBeNull();
  });
});

describe("scoreRelevance", () => {
  const topic = (slug: string, confidence: number) => ({
    slug,
    confidence,
    matchedTerms: ["x"],
  });

  it("rewards a service match", () => {
    const result = scoreRelevance({
      topics: [topic("paid-advertising", 70)],
      services: ["META_ADS"],
    });

    expect(result.score).toBeGreaterThan(0);
    expect(result.rationale.some((r) => r.code === "SERVICE_MATCH")).toBe(true);
  });

  it("rewards recency", () => {
    const now = new Date("2026-09-22T00:00:00Z");

    const fresh = scoreRelevance({
      topics: [topic("seo", 70)],
      services: [],
      publishedAt: new Date("2026-08-01T00:00:00Z"),
      now,
    });
    const old = scoreRelevance({
      topics: [topic("seo", 70)],
      services: [],
      publishedAt: new Date("2019-01-01T00:00:00Z"),
      now,
    });

    expect(fresh.score).toBeGreaterThan(old.score);
  });

  it("does not treat a missing date as recent", () => {
    const now = new Date("2026-09-22T00:00:00Z");

    const undated = scoreRelevance({ topics: [topic("seo", 70)], services: [], now });
    const fresh = scoreRelevance({
      topics: [topic("seo", 70)],
      services: [],
      publishedAt: new Date("2026-08-01T00:00:00Z"),
      now,
    });

    expect(undated.score).toBeLessThan(fresh.score);
    expect(undated.rationale.some((r) => r.code === "RECENT")).toBe(false);
  });

  it("treats a future date as bad metadata, not freshness", () => {
    const result = scoreRelevance({
      topics: [topic("seo", 70)],
      services: [],
      publishedAt: new Date("2099-01-01T00:00:00Z"),
      now: new Date("2026-09-22T00:00:00Z"),
    });

    expect(result.rationale.find((r) => r.code === "DATE_INVALID")?.points).toBe(0);
    expect(result.rationale.some((r) => r.code === "RECENT")).toBe(false);
  });

  it("scores an irrelevant resource at zero", () => {
    expect(scoreRelevance({ topics: [], services: [] }).score).toBe(0);
  });

  it("stays within 0-100 and sums to its rationale", () => {
    const result = scoreRelevance({
      topics: [topic("a", 100), topic("b", 100), topic("c", 100)],
      services: ["META_ADS", "SOCIAL_CONTENT", "WEBSITE_CREATION", "LANDING_PAGE"],
      publishedAt: new Date(),
    });

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);

    const total = result.rationale.reduce((sum, r) => sum + r.points, 0);
    expect(result.score).toBe(Math.min(100, total));
  });
});
