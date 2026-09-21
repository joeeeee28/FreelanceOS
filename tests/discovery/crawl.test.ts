import { describe, expect, it, vi } from "vitest";

import { CachingFetcher } from "@/lib/discovery/crawl/cache";
import { classifyFailure, diagnose, REMEDIATION } from "@/lib/discovery/crawl/health";
import { CrawlQueue, requestKey } from "@/lib/discovery/crawl/queue";
import {
  backoffMs,
  MAX_BACKOFF_MS,
  RetryingFetcher,
  retryAfterMs,
} from "@/lib/discovery/crawl/retry";
import { acquire, CRAWL_LAYERS, LAYER_METHOD } from "@/lib/discovery/crawl/strategy";
import type { FetchedDocument, Fetcher } from "@/lib/discovery/provider";

/** A fetcher driven by a fixed script of responses per URL. */
function scriptedFetcher(script: Record<string, FetchedDocument[]>): Fetcher & {
  calls: string[];
} {
  const calls: string[] = [];

  return {
    calls,
    async fetch(url: string) {
      calls.push(url);
      const queue = script[url];
      if (queue === undefined || queue.length === 0) {
        return { url, outcome: "NOT_FOUND" as const };
      }
      return queue.length === 1 ? queue[0] : (queue.shift() as FetchedDocument);
    },
  };
}

const ok = (url: string, body = "<html></html>"): FetchedDocument => ({
  url,
  outcome: "SUCCESS",
  statusCode: 200,
  body,
});

const noSleep = async () => {};

describe("requestKey", () => {
  it("treats trivially different spellings of one URL as the same request", () => {
    const key = requestKey("https://acme.test/about");

    expect(requestKey("https://acme.test/about/")).toBe(key);
    expect(requestKey("https://www.acme.test/about")).toBe(key);
    expect(requestKey("https://ACME.test/about")).toBe(key);
    expect(requestKey("https://acme.test/about?utm_source=x")).toBe(key);
  });

  it("keeps genuinely different pages apart", () => {
    expect(requestKey("https://acme.test/a")).not.toBe(requestKey("https://acme.test/b"));
  });
});

describe("CrawlQueue", () => {
  it("fetches a URL once however many times it is offered", async () => {
    const queue = new CrawlQueue();
    const seen: string[] = [];

    queue.add("https://acme.test/about");
    queue.add("https://acme.test/about/");
    queue.add("https://acme.test/about?utm_campaign=spring");

    await queue.drain(async (request) => {
      seen.push(request.url);
    });

    expect(seen).toHaveLength(1);
    expect(queue.duplicatesRejected).toBe(2);
  });

  it("refuses work beyond the run budget", () => {
    const queue = new CrawlQueue({ maxRequests: 2 });

    expect(queue.add("https://a.test")).toBe(true);
    expect(queue.add("https://b.test")).toBe(true);
    expect(queue.add("https://c.test")).toBe(false);
    expect(queue.budgetRejected).toBe(1);
  });

  it("runs lower priority numbers first", async () => {
    const queue = new CrawlQueue({ concurrency: 1 });
    const order: string[] = [];

    queue.add({ url: "https://a.test/low", priority: 10 });
    queue.add({ url: "https://b.test/high", priority: 0 });
    queue.add({ url: "https://c.test/mid", priority: 5 });

    await queue.drain(async (request) => {
      order.push(request.url);
    });

    expect(order).toEqual([
      "https://b.test/high",
      "https://c.test/mid",
      "https://a.test/low",
    ]);
  });

  it("picks up links discovered while draining", async () => {
    const queue = new CrawlQueue();
    const seen: string[] = [];

    queue.add("https://acme.test/");

    await queue.drain(async (request) => {
      seen.push(request.url);
      if (request.url === "https://acme.test/") {
        queue.add("https://acme.test/about");
      }
    });

    expect(seen).toEqual(["https://acme.test/", "https://acme.test/about"]);
  });

  it("never exceeds the concurrency limit", async () => {
    const queue = new CrawlQueue({ concurrency: 3 });
    let running = 0;
    let peak = 0;

    for (let i = 0; i < 12; i++) queue.add(`https://host${i}.test/`);

    await queue.drain(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(queue.startedCount).toBe(12);
  });

  it("keeps one origin to a single request at a time", async () => {
    const queue = new CrawlQueue({ concurrency: 4 });
    let sameOriginRunning = 0;
    let sameOriginPeak = 0;

    for (let i = 0; i < 6; i++) queue.add(`https://one.test/page${i}`);

    await queue.drain(async () => {
      sameOriginRunning += 1;
      sameOriginPeak = Math.max(sameOriginPeak, sameOriginRunning);
      await new Promise((resolve) => setTimeout(resolve, 5));
      sameOriginRunning -= 1;
    });

    // Politeness must survive parallelism: concurrency applies across hosts,
    // never within one.
    expect(sameOriginPeak).toBe(1);
    expect(queue.startedCount).toBe(6);
  });

  it("finishes the remaining work when one handler throws", async () => {
    const queue = new CrawlQueue({ concurrency: 1 });
    const done: string[] = [];
    const errors: string[] = [];

    queue.add("https://a.test/");
    queue.add("https://b.test/");
    queue.add("https://c.test/");

    await queue.drain(
      async (request) => {
        if (request.url === "https://b.test/") throw new Error("bad page");
        done.push(request.url);
      },
      (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    );

    expect(done).toEqual(["https://a.test/", "https://c.test/"]);
    expect(errors).toEqual(["bad page"]);
  });

  it("returns immediately when there is nothing to do", async () => {
    const queue = new CrawlQueue();
    const handler = vi.fn();

    await queue.drain(handler);

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("backoff", () => {
  it("grows exponentially", () => {
    const full = () => 1;

    expect(backoffMs(1, { random: full })).toBe(1000);
    expect(backoffMs(2, { random: full })).toBe(2000);
    expect(backoffMs(3, { random: full })).toBe(4000);
  });

  it("stops growing at the ceiling", () => {
    expect(backoffMs(30, { random: () => 1 })).toBe(MAX_BACKOFF_MS);
  });

  it("applies jitter so failures do not retry in lockstep", () => {
    expect(backoffMs(3, { random: () => 0 })).toBe(0);
    expect(backoffMs(3, { random: () => 0.5 })).toBe(2000);
  });
});

describe("retryAfterMs", () => {
  it("reads a delay in seconds", () => {
    expect(
      retryAfterMs({ url: "u", outcome: "RATE_LIMITED", headers: { "retry-after": "5" } }),
    ).toBe(5000);
  });

  it("reads an HTTP date", () => {
    const at = new Date(Date.now() + 10_000).toUTCString();
    const result = retryAfterMs({
      url: "u",
      outcome: "RATE_LIMITED",
      headers: { "retry-after": at },
    });

    expect(result).toBeGreaterThan(5_000);
    expect(result).toBeLessThanOrEqual(30_000);
  });

  it("caps an unreasonably long wait", () => {
    expect(
      retryAfterMs({
        url: "u",
        outcome: "RATE_LIMITED",
        headers: { "retry-after": "86400" },
      }),
    ).toBe(MAX_BACKOFF_MS);
  });

  it("returns null when there is no usable header", () => {
    expect(retryAfterMs({ url: "u", outcome: "RATE_LIMITED" })).toBeNull();
    expect(
      retryAfterMs({ url: "u", outcome: "RATE_LIMITED", headers: { "retry-after": "soon" } }),
    ).toBeNull();
  });
});

describe("RetryingFetcher", () => {
  it("retries a timeout and returns the eventual success", async () => {
    const inner = scriptedFetcher({
      "https://a.test/": [
        { url: "https://a.test/", outcome: "TIMEOUT" },
        ok("https://a.test/"),
      ],
    });

    const fetcher = new RetryingFetcher(inner, { sleep: noSleep, random: () => 0 });
    const result = await fetcher.fetch("https://a.test/");

    expect(result.outcome).toBe("SUCCESS");
    expect(inner.calls).toHaveLength(2);
  });

  it("gives up after the attempt limit", async () => {
    const inner = scriptedFetcher({
      "https://a.test/": [{ url: "https://a.test/", outcome: "SERVER_ERROR" }],
    });

    const fetcher = new RetryingFetcher(inner, {
      maxAttempts: 3,
      sleep: noSleep,
      random: () => 0,
    });
    const result = await fetcher.fetch("https://a.test/");

    expect(result.outcome).toBe("SERVER_ERROR");
    expect(inner.calls).toHaveLength(3);
  });

  describe("refusals", () => {
    it("never retries a blocked URL", async () => {
      const inner = scriptedFetcher({
        "https://a.test/": [{ url: "https://a.test/", outcome: "BLOCKED" }],
      });

      const fetcher = new RetryingFetcher(inner, { sleep: noSleep });
      const result = await fetcher.fetch("https://a.test/");

      // Retrying a refusal would be both rude and pointless.
      expect(result.outcome).toBe("BLOCKED");
      expect(inner.calls).toHaveLength(1);
      expect(fetcher.retries).toBe(0);
    });

    it("never retries a 404", async () => {
      const inner = scriptedFetcher({
        "https://a.test/": [{ url: "https://a.test/", outcome: "NOT_FOUND" }],
      });

      await new RetryingFetcher(inner, { sleep: noSleep }).fetch("https://a.test/");

      expect(inner.calls).toHaveLength(1);
    });
  });

  it("waits as long as the server asked", async () => {
    const waits: number[] = [];
    const inner = scriptedFetcher({
      "https://a.test/": [
        {
          url: "https://a.test/",
          outcome: "RATE_LIMITED",
          headers: { "retry-after": "7" },
        },
        ok("https://a.test/"),
      ],
    });

    const fetcher = new RetryingFetcher(inner, {
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 0,
    });

    await fetcher.fetch("https://a.test/");

    // Server instruction beats our own backoff curve.
    expect(waits).toEqual([7000]);
  });
});

describe("CachingFetcher", () => {
  it("serves a repeated URL from memory", async () => {
    const inner = scriptedFetcher({ "https://a.test/": [ok("https://a.test/")] });
    const fetcher = new CachingFetcher(inner);

    await fetcher.fetch("https://a.test/");
    await fetcher.fetch("https://a.test/");

    expect(inner.calls).toHaveLength(1);
    expect(fetcher.hits).toBe(1);
  });

  it("treats equivalent URLs as one entry", async () => {
    const inner = scriptedFetcher({
      "https://a.test/page": [ok("https://a.test/page")],
      "https://a.test/page/": [ok("https://a.test/page/")],
    });
    const fetcher = new CachingFetcher(inner);

    await fetcher.fetch("https://a.test/page");
    await fetcher.fetch("https://a.test/page/");

    expect(inner.calls).toHaveLength(1);
  });

  it("coalesces simultaneous requests into one fetch", async () => {
    let calls = 0;
    const slow: Fetcher = {
      async fetch(url) {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return ok(url);
      },
    };

    const fetcher = new CachingFetcher(slow);

    await Promise.all([
      fetcher.fetch("https://a.test/"),
      fetcher.fetch("https://a.test/"),
      fetcher.fetch("https://a.test/"),
    ]);

    // The saving that matters during a concurrent crawl.
    expect(calls).toBe(1);
  });

  it("does not cache a transient failure", async () => {
    const inner = scriptedFetcher({
      "https://a.test/": [
        { url: "https://a.test/", outcome: "TIMEOUT" },
        ok("https://a.test/"),
      ],
    });
    const fetcher = new CachingFetcher(inner);

    const first = await fetcher.fetch("https://a.test/");
    const second = await fetcher.fetch("https://a.test/");

    // A blip must not become a run-long outage.
    expect(first.outcome).toBe("TIMEOUT");
    expect(second.outcome).toBe("SUCCESS");
  });

  it("caches a refusal, which will not change mid-run", async () => {
    const inner = scriptedFetcher({
      "https://a.test/": [{ url: "https://a.test/", outcome: "BLOCKED" }],
    });
    const fetcher = new CachingFetcher(inner);

    await fetcher.fetch("https://a.test/");
    await fetcher.fetch("https://a.test/");

    expect(inner.calls).toHaveLength(1);
  });

  it("evicts once full rather than growing without bound", async () => {
    const inner: Fetcher = { async fetch(url) { return ok(url); } };
    const fetcher = new CachingFetcher(inner, { maxEntries: 3 });

    for (let i = 0; i < 10; i++) await fetcher.fetch(`https://a.test/${i}`);

    expect(fetcher.size).toBeLessThanOrEqual(3);
  });
});

describe("layered acquisition", () => {
  it("stops at the first layer that yields data", async () => {
    const inner = scriptedFetcher({
      "https://a.test/data.json": [ok("https://a.test/data.json", '{"name":"Acme"}')],
      "https://a.test/": [ok("https://a.test/")],
    });

    const result = await acquire<string>(inner, [
      {
        layer: "STRUCTURED_SOURCE",
        url: "https://a.test/data.json",
        parse: (d) => (JSON.parse(d.body ?? "{}") as { name?: string }).name ?? null,
      },
      { layer: "HTML_EXTRACTION", url: "https://a.test/", parse: () => "from html" },
    ]);

    expect(result.value).toBe("Acme");
    expect(result.layer).toBe("STRUCTURED_SOURCE");
    expect(result.method).toBe("STRUCTURED_DATA");
    // The cheaper layer succeeded, so the expensive one was never requested.
    expect(inner.calls).toEqual(["https://a.test/data.json"]);
  });

  it("falls through to the next layer when one yields nothing", async () => {
    const inner = scriptedFetcher({
      "https://a.test/feed.xml": [ok("https://a.test/feed.xml", "")],
      "https://a.test/": [ok("https://a.test/", "<html>Acme</html>")],
    });

    const result = await acquire<string>(inner, [
      { layer: "FEED", url: "https://a.test/feed.xml", parse: () => null },
      { layer: "HTML_EXTRACTION", url: "https://a.test/", parse: () => "Acme" },
    ]);

    expect(result.value).toBe("Acme");
    expect(result.layer).toBe("HTML_EXTRACTION");
    expect(result.trail.map((t) => t.outcome)).toEqual(["EMPTY", "SUCCESS"]);
  });

  it("records a refusal and still tries the next layer", async () => {
    const inner = scriptedFetcher({
      "https://a.test/sitemap.xml": [
        { url: "https://a.test/sitemap.xml", outcome: "BLOCKED" },
      ],
      "https://a.test/": [ok("https://a.test/")],
    });

    const result = await acquire<string>(inner, [
      { layer: "SITEMAP", url: "https://a.test/sitemap.xml", parse: () => "x" },
      { layer: "HTML_EXTRACTION", url: "https://a.test/", parse: () => "Acme" },
    ]);

    expect(result.blocked).toBe(true);
    expect(result.value).toBe("Acme");
  });

  it("survives a parser that throws", async () => {
    const inner = scriptedFetcher({
      "https://a.test/data.json": [ok("https://a.test/data.json", "not json")],
      "https://a.test/": [ok("https://a.test/")],
    });

    const result = await acquire<string>(inner, [
      {
        layer: "STRUCTURED_SOURCE",
        url: "https://a.test/data.json",
        parse: (d) => JSON.parse(d.body ?? "") as string,
      },
      { layer: "HTML_EXTRACTION", url: "https://a.test/", parse: () => "Acme" },
    ]);

    expect(result.value).toBe("Acme");
    expect(result.trail[0].outcome).toBe("PARSE_ERROR");
  });

  it("reports nothing found rather than inventing a value", async () => {
    const inner = scriptedFetcher({});

    const result = await acquire<string>(inner, [
      { layer: "FEED", url: "https://a.test/feed.xml", parse: () => "x" },
    ]);

    expect(result.value).toBeNull();
    expect(result.layer).toBeNull();
    expect(result.method).toBeNull();
  });

  it("skips layers that do not apply", async () => {
    const inner = scriptedFetcher({ "https://a.test/": [ok("https://a.test/")] });

    await acquire<string>(inner, [
      { layer: "SITEMAP", url: null, parse: () => "x" },
      { layer: "HTML_EXTRACTION", url: "https://a.test/", parse: () => "Acme" },
    ]);

    expect(inner.calls).toEqual(["https://a.test/"]);
  });

  it("gives every layer a provenance method", () => {
    for (const layer of CRAWL_LAYERS) {
      expect(LAYER_METHOD[layer]).toBeTruthy();
    }
  });
});

describe("source health", () => {
  it("maps each outcome to an operator-readable class", () => {
    expect(classifyFailure("BLOCKED")).toBe("REFUSED");
    expect(classifyFailure("TIMEOUT")).toBe("UNREACHABLE");
    expect(classifyFailure("RATE_LIMITED")).toBe("THROTTLED");
    expect(classifyFailure("NOT_FOUND")).toBe("MISSING");
    expect(classifyFailure("SUCCESS")).toBe("NONE");
  });

  it("says UNKNOWN for a source that has never run", () => {
    const report = diagnose([]);

    // Reporting 0% for something never tried would be true and misleading.
    expect(report.status).toBe("UNKNOWN");
    expect(report.successRate).toBeNull();
    expect(report.totalRequests).toBe(0);
  });

  it("reports a healthy source", () => {
    const report = diagnose([
      { outcome: "SUCCESS", count: 9 },
      { outcome: "TIMEOUT", count: 1 },
    ]);

    expect(report.status).toBe("ACTIVE");
    expect(report.successRate).toBeCloseTo(0.9);
  });

  it("flags a mostly-failing source", () => {
    const report = diagnose([
      { outcome: "SUCCESS", count: 2 },
      { outcome: "SERVER_ERROR", count: 8 },
    ]);

    expect(report.status).toBe("FAILING");
    expect(report.dominantFailure).toBe("SERVER_BROKEN");
  });

  it("distinguishes a refused source from a broken one", () => {
    const report = diagnose([{ outcome: "BLOCKED", count: 5 }]);

    expect(report.status).toBe("BLOCKED");
    expect(report.refusedOnly).toBe(true);
    expect(report.remediation).toBe(REMEDIATION.REFUSED);
  });

  it("does not call a source refused when it also fails other ways", () => {
    const report = diagnose([
      { outcome: "BLOCKED", count: 3 },
      { outcome: "TIMEOUT", count: 3 },
    ]);

    expect(report.refusedOnly).toBe(false);
    expect(report.status).toBe("FAILING");
  });

  it("offers guidance for every failure class", () => {
    for (const outcome of ["BLOCKED", "TIMEOUT", "RATE_LIMITED", "NOT_FOUND"] as const) {
      expect(REMEDIATION[classifyFailure(outcome)].length).toBeGreaterThan(10);
    }
  });
});
