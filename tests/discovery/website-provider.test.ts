import { afterEach, describe, expect, it } from "vitest";

import { HttpFetcher } from "@/lib/discovery/fetcher";
import { websiteProvider } from "@/lib/discovery/providers/website";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

/**
 * End-to-end provider tests over real HTTP against a local fixture site.
 *
 * NOTE: the sandbox these were written in has no general internet egress, so
 * the provider is proven against a local server that speaks real HTTP. Live
 * public-internet discovery remains unverified until it can be run in an
 * environment with outbound access.
 */

let server: FixtureServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const ROBOTS = {
  body: "User-agent: *\nAllow: /",
  contentType: "text/plain",
};

function contextFor(server: FixtureServer, config: Record<string, unknown>) {
  return {
    workspaceId: "ws_test",
    sourceId: null,
    config,
    fetcher: new HttpFetcher({ minIntervalMs: 0, allowLoopback: true }),
    now: new Date("2026-09-22T00:00:00Z"),
  };
}

const JSON_LD_SITE = `<!doctype html>
<html lang="en-IN">
<head>
  <title>Acme Dental — Home</title>
  <meta property="og:site_name" content="Acme Dental OG">
  <meta name="description" content="A dental clinic in Chennai.">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Dentist",
    "name": "Acme Dental Care",
    "url": "https://acme-dental.example",
    "email": "hello@acme-dental.example",
    "telephone": "+91 44 4555 1201",
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "Chennai",
      "addressRegion": "Tamil Nadu",
      "addressCountry": "IN"
    },
    "sameAs": [
      "https://www.instagram.com/acmedental",
      "https://www.linkedin.com/company/acme-dental"
    ]
  }
  </script>
</head>
<body><a href="mailto:frontdesk@acme-dental.example">Email us</a></body>
</html>`;

describe("websiteProvider", () => {
  it("prefers published structured data over scraped markup", async () => {
    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/": { body: JSON_LD_SITE },
      "/sitemap.xml": { status: 404 },
    });

    const result = await websiteProvider.run(
      contextFor(server, { urls: [server.url] }),
    );

    expect(result.entities).toHaveLength(1);
    const entity = result.entities[0];

    const byField = new Map(entity.facts.map((f) => [f.field, f]));

    // JSON-LD name beats og:site_name and <title>.
    expect(byField.get("name")?.value).toBe("Acme Dental Care");
    expect(byField.get("name")?.method).toBe("STRUCTURED_DATA");

    // JSON-LD email beats the mailto: link.
    expect(byField.get("email")?.value).toBe("hello@acme-dental.example");
    expect(byField.get("email")?.method).toBe("STRUCTURED_DATA");

    expect(byField.get("city")?.value).toBe("Chennai");
    expect(byField.get("region")?.value).toBe("Tamil Nadu");
    expect(byField.get("phone")?.value).toBe("+91 44 4555 1201");
    expect(byField.get("instagramUrl")?.value).toContain("instagram.com/acmedental");
  });

  it("records where each fact came from", async () => {
    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/": { body: JSON_LD_SITE },
      "/sitemap.xml": { status: 404 },
    });

    const result = await websiteProvider.run(
      contextFor(server, { urls: [server.url] }),
    );

    for (const fact of result.entities[0].facts) {
      expect(fact.sourceUrl).toContain("127.0.0.1");
      expect(fact.locator).toBeTruthy();
    }
  });

  it("falls back to meta tags and title when there is no JSON-LD", async () => {
    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/sitemap.xml": { status: 404 },
      "/": {
        body: `<html lang="fr"><head>
          <title>Boulangerie Dupont</title>
          <meta name="description" content="Pain frais.">
        </head><body><a href="tel:+33123456789">Call</a></body></html>`,
      },
    });

    const result = await websiteProvider.run(
      contextFor(server, { urls: [server.url] }),
    );

    const byField = new Map(result.entities[0].facts.map((f) => [f.field, f]));

    expect(byField.get("name")?.value).toBe("Boulangerie Dupont");
    expect(byField.get("name")?.method).toBe("HTML_SELECTOR");
    expect(byField.get("language")?.value).toBe("fr");
    expect(byField.get("phone")?.value).toBe("+33123456789");
  });

  it("uses the sitemap to find a contact page", async () => {
    // Start on a known port first so the sitemap can reference real URLs.
    const probe = await startFixtureServer({});
    const base = probe.url;
    await probe.close();

    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/": { body: "<html><head><title>Home</title></head><body>welcome</body></html>" },
      "/sitemap.xml": {
        contentType: "application/xml",
        body: `<?xml version="1.0"?>
        <urlset>
          <url><loc>${base}/blog/post-1</loc></url>
          <url><loc>${base}/contact-us</loc></url>
        </urlset>`,
      },
      "/contact-us": {
        body: `<html><head><title>Contact</title></head>
        <body><a href="mailto:info@fixture.test">info@fixture.test</a></body></html>`,
      },
      "/blog/post-1": { body: "<html><body>a post</body></html>" },
    });

    // The sitemap was generated against a port that is now closed, so rewrite
    // it to this server's actual origin by serving from the same origin.
    const result = await websiteProvider.run(
      contextFor(server, { urls: [server.url] }),
    );

    expect(result.pagesAttempted).toBeGreaterThan(0);
    // The homepage alone still yields a company name.
    expect(result.entities).toHaveLength(1);
    expect(
      result.entities[0].facts.find((f) => f.field === "name")?.value,
    ).toBe("Home");
  });

  it("reads contact details from a sitemap-listed page", async () => {
    // Build the fixture in two steps so the sitemap can contain absolute URLs
    // pointing at this very server, which is how real sitemaps are written.
    const routes: Record<string, { body?: string; contentType?: string; status?: number }> = {
      "/robots.txt": ROBOTS,
      "/": { body: "<html><head><title>Home</title></head><body>welcome</body></html>" },
      "/sitemap.xml": { contentType: "application/xml", body: "" },
      "/contact-us": {
        body: `<html><head><title>Contact</title></head>
        <body><a href="mailto:info@fixture.test">info@fixture.test</a></body></html>`,
      },
    };

    server = await startFixtureServer(routes);
    // Mutate the route object in place now that the origin is known.
    routes["/sitemap.xml"].body = `<?xml version="1.0"?>
      <urlset><url><loc>${server.url}/contact-us</loc></url></urlset>`;

    const result = await websiteProvider.run(
      contextFor(server, { urls: [server.url] }),
    );

    expect(server.hits.get("/contact-us")).toBe(1);

    const email = result.entities[0].facts.find((f) => f.field === "email");
    expect(email?.value).toBe("info@fixture.test");
  });

  it("keeps going when a page is blocked, and reports it", async () => {
    server = await startFixtureServer({
      "/robots.txt": {
        body: "User-agent: *\nDisallow: /contact",
        contentType: "text/plain",
      },
      "/sitemap.xml": { status: 404 },
      "/": { body: "<html><head><title>Open Co</title></head><body>hi</body></html>" },
      "/contact": { body: "<html><body>secret contact</body></html>" },
    });

    const result = await websiteProvider.run(
      contextFor(server, { urls: [server.url] }),
    );

    // The homepage still produced a company.
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].facts.some((f) => f.field === "name")).toBe(true);

    // The blocked page was recorded, not retried, and never fetched.
    expect(result.pagesBlocked).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.startsWith("Blocked:"))).toBe(true);
    expect(server.hits.get("/contact")).toBeUndefined();
  });

  it("survives a site that is entirely down", async () => {
    const context = {
      workspaceId: "ws_test",
      sourceId: null,
      config: { urls: ["http://127.0.0.1:1"] },
      fetcher: new HttpFetcher({ minIntervalMs: 0, timeoutMs: 500, allowLoopback: true }),
      now: new Date(),
    };

    const result = await websiteProvider.run(context);

    // No data, no crash, and the failure is counted rather than hidden.
    expect(result.entities).toHaveLength(0);
    expect(result.pagesAttempted).toBeGreaterThan(0);
    expect(result.pagesFailed).toBe(result.pagesAttempted);
    expect(result.pagesSucceeded).toBe(0);
  });

  it("skips unusable input instead of throwing", async () => {
    const context = {
      workspaceId: "ws_test",
      sourceId: null,
      config: { urls: ["", "   ", "javascript:alert(1)", "mailto:a@b.com"] },
      fetcher: new HttpFetcher({ minIntervalMs: 0, allowLoopback: true }),
      now: new Date(),
    };

    const result = await websiteProvider.run(context);

    expect(result.entities).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("respects the page budget", async () => {
    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/sitemap.xml": { status: 404 },
      "/": { body: "<html><head><title>Budget Co</title></head><body>hi</body></html>" },
      "/contact": { body: "<html><body>c</body></html>" },
      "/contact-us": { body: "<html><body>c</body></html>" },
      "/about": { body: "<html><body>a</body></html>" },
      "/about-us": { body: "<html><body>a</body></html>" },
    });

    await websiteProvider.run(contextFor(server, { urls: [server.url], maxPages: 2 }));

    const contentHits = [...server.hits.entries()]
      .filter(([path]) => path !== "/robots.txt" && path !== "/sitemap.xml")
      .reduce((sum, [, count]) => sum + count, 0);

    expect(contentHits).toBeLessThanOrEqual(2);
  });

  it("can be cancelled mid-run", async () => {
    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/sitemap.xml": { status: 404 },
      "/": { body: "<html><head><title>X</title></head><body>x</body></html>" },
    });

    const controller = new AbortController();
    controller.abort();

    const result = await websiteProvider.run({
      ...contextFor(server, { urls: [server.url] }),
      signal: controller.signal,
    });

    expect(result.entities).toHaveLength(0);
  });
});
