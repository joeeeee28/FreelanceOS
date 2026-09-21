import { afterEach, describe, expect, it } from "vitest";

import { HttpFetcher } from "@/lib/discovery/fetcher";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

/**
 * These tests run against a real HTTP server on loopback, so the fetcher is
 * exercised through actual sockets, status codes and redirects rather than a
 * mock that might diverge from real `fetch` behaviour.
 */

let server: FixtureServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** No artificial delay between requests, so tests stay fast. */
const fast = { minIntervalMs: 0 };

describe("HttpFetcher", () => {
  it("fetches an allowed page", async () => {
    server = await startFixtureServer({
      "/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
      "/about": { body: "<html><body>Acme Dental</body></html>" },
    });

    const result = await new HttpFetcher(fast).fetch(`${server.url}/about`);

    expect(result.outcome).toBe("SUCCESS");
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain("Acme Dental");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  describe("robots.txt is obeyed, not negotiated", () => {
    it("refuses a disallowed path and never requests it", async () => {
      server = await startFixtureServer({
        "/robots.txt": {
          body: "User-agent: *\nDisallow: /private",
          contentType: "text/plain",
        },
        "/private/data": { body: "secret" },
      });

      const result = await new HttpFetcher(fast).fetch(`${server.url}/private/data`);

      expect(result.outcome).toBe("BLOCKED");
      // The decisive assertion: the disallowed URL was never even requested.
      expect(server.hits.get("/private/data")).toBeUndefined();
    });

    it("fetches robots.txt only once per origin", async () => {
      server = await startFixtureServer({
        "/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
        "/a": { body: "a" },
        "/b": { body: "b" },
        "/c": { body: "c" },
      });

      const fetcher = new HttpFetcher(fast);
      await fetcher.fetch(`${server.url}/a`);
      await fetcher.fetch(`${server.url}/b`);
      await fetcher.fetch(`${server.url}/c`);

      expect(server.hits.get("/robots.txt")).toBe(1);
    });

    it("treats a gated robots.txt as a fully blocked site", async () => {
      server = await startFixtureServer({
        "/robots.txt": { status: 401, body: "Unauthorized" },
        "/page": { body: "content" },
      });

      const result = await new HttpFetcher(fast).fetch(`${server.url}/page`);

      expect(result.outcome).toBe("BLOCKED");
      expect(server.hits.get("/page")).toBeUndefined();
    });

    it("proceeds when robots.txt is simply absent", async () => {
      server = await startFixtureServer({ "/page": { body: "content" } });

      const result = await new HttpFetcher(fast).fetch(`${server.url}/page`);

      expect(result.outcome).toBe("SUCCESS");
    });

    it("will not follow a redirect into a disallowed path", async () => {
      server = await startFixtureServer({
        "/robots.txt": {
          body: "User-agent: *\nDisallow: /private",
          contentType: "text/plain",
        },
        "/open": { status: 302, headers: { location: "/private/data" } },
        "/private/data": { body: "secret" },
      });

      const result = await new HttpFetcher(fast).fetch(`${server.url}/open`);

      expect(result.outcome).toBe("BLOCKED");
      expect(server.hits.get("/private/data")).toBeUndefined();
    });
  });

  describe("status classification", () => {
    it("classifies an authentication wall as BLOCKED, not as an error", async () => {
      server = await startFixtureServer({
        "/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
        "/paywall": { status: 403, body: "Forbidden" },
      });

      const result = await new HttpFetcher(fast).fetch(`${server.url}/paywall`);
      expect(result.outcome).toBe("BLOCKED");
    });

    it("classifies missing, rate-limited and broken responses", async () => {
      server = await startFixtureServer({
        "/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
        "/missing": { status: 404 },
        "/slowdown": { status: 429 },
        "/broken": { status: 503 },
      });

      const fetcher = new HttpFetcher(fast);

      expect((await fetcher.fetch(`${server.url}/missing`)).outcome).toBe("NOT_FOUND");
      expect((await fetcher.fetch(`${server.url}/slowdown`)).outcome).toBe(
        "RATE_LIMITED",
      );
      expect((await fetcher.fetch(`${server.url}/broken`)).outcome).toBe("SERVER_ERROR");
    });
  });

  it("follows an ordinary redirect", async () => {
    server = await startFixtureServer({
      "/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
      "/old": { status: 301, headers: { location: "/new" } },
      "/new": { body: "moved here" },
    });

    const result = await new HttpFetcher(fast).fetch(`${server.url}/old`);

    expect(result.outcome).toBe("SUCCESS");
    expect(result.body).toBe("moved here");
  });

  it("gives up on a redirect loop instead of hanging", async () => {
    server = await startFixtureServer({
      "/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
      "/loop": { status: 302, headers: { location: "/loop" } },
    });

    const result = await new HttpFetcher(fast).fetch(`${server.url}/loop`);

    expect(result.outcome).toBe("NETWORK_ERROR");
    expect(result.error).toContain("redirects");
  });

  it("times out a slow response", async () => {
    server = await startFixtureServer({
      "/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
      "/slow": { body: "eventually", delayMs: 3000 },
    });

    const result = await new HttpFetcher({ ...fast, timeoutMs: 150 }).fetch(
      `${server.url}/slow`,
    );

    expect(result.outcome).toBe("TIMEOUT");
  });

  it("refuses non-http schemes", async () => {
    const fetcher = new HttpFetcher(fast);

    const result = await fetcher.fetch("file:///etc/passwd");
    expect(result.outcome).toBe("NETWORK_ERROR");
    expect(result.error).toContain("Unsupported scheme");
  });

  it("reports an unreachable host as a network error rather than throwing", async () => {
    // Port 1 on loopback refuses connections immediately.
    const result = await new HttpFetcher(fast).fetch("http://127.0.0.1:1/page");

    expect(["NETWORK_ERROR", "TIMEOUT"]).toContain(result.outcome);
  });

  it("caps an oversized response", async () => {
    server = await startFixtureServer({
      "/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
      "/huge": { body: "x".repeat(50_000) },
    });

    const result = await new HttpFetcher({ ...fast, maxBytes: 1000 }).fetch(
      `${server.url}/huge`,
    );

    // Either refused up front via content-length, or truncated on read.
    if (result.outcome === "SUCCESS") {
      expect(result.body!.length).toBeLessThanOrEqual(1000);
    } else {
      expect(result.outcome).toBe("NETWORK_ERROR");
    }
  });

  it("spaces out requests to one origin", async () => {
    server = await startFixtureServer({
      "/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
      "/a": { body: "a" },
      "/b": { body: "b" },
    });

    const slept: number[] = [];
    let clock = 0;

    const fetcher = new HttpFetcher({
      minIntervalMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    await fetcher.fetch(`${server.url}/a`);
    await fetcher.fetch(`${server.url}/b`);

    // The second request had to wait for the interval to elapse.
    expect(slept.some((ms) => ms > 0)).toBe(true);
  });

  it("honours a Crawl-delay longer than the default interval", async () => {
    server = await startFixtureServer({
      "/robots.txt": {
        body: "User-agent: *\nAllow: /\nCrawl-delay: 2",
        contentType: "text/plain",
      },
      "/a": { body: "a" },
      "/b": { body: "b" },
    });

    const slept: number[] = [];
    let clock = 0;

    const fetcher = new HttpFetcher({
      minIntervalMs: 10,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    await fetcher.fetch(`${server.url}/a`);
    await fetcher.fetch(`${server.url}/b`);

    expect(Math.max(...slept)).toBe(2000);
  });
});
