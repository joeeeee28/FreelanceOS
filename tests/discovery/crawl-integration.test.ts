/**
 * The crawl stack against a real HTTP server.
 *
 * The unit tests use fake fetchers, which proves the logic but not that the
 * pieces compose over an actual socket. These tests run the real HttpFetcher,
 * with real robots.txt handling, real timeouts and real retries, against a
 * loopback fixture server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CachingFetcher } from "@/lib/discovery/crawl/cache";
import { CrawlQueue } from "@/lib/discovery/crawl/queue";
import { RetryingFetcher } from "@/lib/discovery/crawl/retry";
import { acquire } from "@/lib/discovery/crawl/strategy";
import { HttpFetcher } from "@/lib/discovery/fetcher";
import { startFixtureServer } from "../helpers/fixture-server";

let server: Awaited<ReturnType<typeof startFixtureServer>>;

/** Flaky endpoint state: fails the first N calls, then succeeds. */
let flakyCalls = 0;

beforeAll(async () => {
  server = await startFixtureServer({
    "/robots.txt": {
      body: "User-agent: *\nDisallow: /private\nAllow: /\n",
      contentType: "text/plain",
    },
    "/": { body: "<html><title>Home</title></html>", contentType: "text/html" },
    "/about": { body: "<html><title>About</title></html>", contentType: "text/html" },
    "/private/secret": { body: "should never be read", contentType: "text/html" },
    "/data.json": { body: '{"name":"Acme Ltd"}', contentType: "application/json" },
    "/flaky": () => {
      flakyCalls += 1;
      return flakyCalls < 3
        ? { body: "temporarily broken", contentType: "text/plain", status: 503 }
        : { body: "recovered", contentType: "text/plain" };
    },
    "/slow": async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { body: "eventually", contentType: "text/plain" };
    },
    "/gone": { body: "not here", contentType: "text/plain", status: 404 },
    "/forbidden": { body: "no", contentType: "text/plain", status: 403 },
  });
});

afterAll(async () => {
  await server.close();
});

function stack(options: { timeoutMs?: number; maxAttempts?: number } = {}) {
  return new CachingFetcher(
    new RetryingFetcher(
      new HttpFetcher({
        minIntervalMs: 0,
        timeoutMs: options.timeoutMs ?? 5_000,
      }),
      { maxAttempts: options.maxAttempts ?? 3, sleep: async () => {}, random: () => 0 },
    ),
  );
}

describe("crawl stack over HTTP", () => {
  it("fetches a real page", async () => {
    const result = await stack().fetch(`${server.url}/about`);

    expect(result.outcome).toBe("SUCCESS");
    expect(result.body).toContain("About");
  });

  it("obeys robots.txt against a live server", async () => {
    const result = await stack().fetch(`${server.url}/private/secret`);

    // The content exists and would have been served. We did not read it.
    expect(result.outcome).toBe("BLOCKED");
    expect(result.body).toBeUndefined();
  });

  it("recovers from a genuinely flaky endpoint", async () => {
    flakyCalls = 0;

    const result = await stack().fetch(`${server.url}/flaky`);

    expect(result.outcome).toBe("SUCCESS");
    expect(result.body).toBe("recovered");
    expect(flakyCalls).toBe(3);
  });

  it("times out a slow endpoint instead of hanging", async () => {
    const result = await stack({ timeoutMs: 50, maxAttempts: 1 }).fetch(
      `${server.url}/slow`,
    );

    expect(result.outcome).toBe("TIMEOUT");
  });

  it("does not retry a 403", async () => {
    const before = server.hits.get("/forbidden") ?? 0;

    const result = await stack().fetch(`${server.url}/forbidden`);

    // A refusal is an answer. Asking again would be rude and pointless.
    expect(result.outcome).toBe("BLOCKED");
    expect((server.hits.get("/forbidden") ?? 0) - before).toBe(1);
  });

  it("does not retry a 404", async () => {
    const before = server.hits.get("/gone") ?? 0;

    const result = await stack().fetch(`${server.url}/gone`);

    expect(result.outcome).toBe("NOT_FOUND");
    expect((server.hits.get("/gone") ?? 0) - before).toBe(1);
  });

  it("serves a repeat request from cache without touching the network", async () => {
    const fetcher = stack();

    await fetcher.fetch(`${server.url}/about`);
    const before = server.hits.get("/about") ?? 0;
    await fetcher.fetch(`${server.url}/about`);

    expect((server.hits.get("/about") ?? 0) - before).toBe(0);
  });

  it("walks the acquisition ladder over real requests", async () => {
    const fetcher = stack();

    const result = await acquire<string>(fetcher, [
      {
        layer: "STRUCTURED_SOURCE",
        url: `${server.url}/data.json`,
        parse: (d) => (JSON.parse(d.body ?? "{}") as { name?: string }).name ?? null,
      },
      { layer: "HTML_EXTRACTION", url: `${server.url}/`, parse: () => "fallback" },
    ]);

    expect(result.value).toBe("Acme Ltd");
    expect(result.layer).toBe("STRUCTURED_SOURCE");
  });

  it("falls back to HTML when the structured layer is missing", async () => {
    const fetcher = stack();

    const result = await acquire<string>(fetcher, [
      { layer: "STRUCTURED_SOURCE", url: `${server.url}/missing.json`, parse: () => "x" },
      {
        layer: "HTML_EXTRACTION",
        url: `${server.url}/about`,
        parse: (d) => (d.body?.includes("About") ? "About" : null),
      },
    ]);

    expect(result.value).toBe("About");
    expect(result.layer).toBe("HTML_EXTRACTION");
  });

  it("crawls a set of pages through the queue exactly once each", async () => {
    const fetcher = stack();
    const queue = new CrawlQueue({ concurrency: 2, maxRequests: 10 });
    const fetched: string[] = [];

    queue.addAll([
      `${server.url}/`,
      `${server.url}/about`,
      // Duplicate spellings of pages already queued.
      `${server.url}/about/`,
      `${server.url}/?utm_source=test`,
    ]);

    await queue.drain(async (request) => {
      const result = await fetcher.fetch(request.url);
      if (result.outcome === "SUCCESS") fetched.push(request.url);
    });

    expect(fetched).toHaveLength(2);
  });

  it("finishes a crawl in which one page is refused", async () => {
    const fetcher = stack();
    const queue = new CrawlQueue({ concurrency: 2 });
    const outcomes: string[] = [];

    queue.addAll([
      `${server.url}/`,
      `${server.url}/private/secret`,
      `${server.url}/about`,
    ]);

    await queue.drain(async (request) => {
      const result = await fetcher.fetch(request.url);
      outcomes.push(result.outcome);
    });

    // One refusal, two successes: the blocked page did not stop the crawl.
    expect(outcomes.filter((o) => o === "SUCCESS")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "BLOCKED")).toHaveLength(1);
  });
});
