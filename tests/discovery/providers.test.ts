import { afterEach, describe, expect, it } from "vitest";

import { HttpFetcher } from "@/lib/discovery/fetcher";
import {
  PROVIDER_CATEGORIES,
  ProviderRegistry,
  validateEntity,
  type DiscoveryProvider,
} from "@/lib/discovery/provider";
import {
  BUILT_IN_PROVIDERS,
  createProviderRegistry,
  directoryProvider,
  feedProvider,
  jobsProvider,
  manualCsvProvider,
  repositoryProvider,
  sitemapProvider,
} from "@/lib/discovery/providers";
import { classifyRole } from "@/lib/discovery/providers/jobs";
import { isIgnoredHost } from "@/lib/discovery/providers/directory";
import { mapHeaders, parseCsv } from "@/lib/discovery/providers/manual-csv";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

let server: FixtureServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const ROBOTS = { body: "User-agent: *\nAllow: /", contentType: "text/plain" };

function ctx(config: Record<string, unknown>, fixture?: FixtureServer) {
  return {
    workspaceId: "ws_test",
    sourceId: null,
    config,
    fetcher: new HttpFetcher({ minIntervalMs: 0, allowLoopback: true }),
    now: new Date("2026-09-22T00:00:00Z"),
    fixture,
  };
}

describe("provider registry", () => {
  it("registers every built-in provider under a unique key", () => {
    const registry = createProviderRegistry();

    expect(registry.list()).toHaveLength(BUILT_IN_PROVIDERS.length);
    expect(new Set(registry.keys()).size).toBe(BUILT_IN_PROVIDERS.length);
  });

  it("gives every provider a valid category", () => {
    for (const provider of BUILT_IN_PROVIDERS) {
      expect(PROVIDER_CATEGORIES).toContain(provider.category);
      expect(provider.label.trim()).not.toBe("");
    }
  });

  it("covers the required provider categories", () => {
    const categories = new Set(BUILT_IN_PROVIDERS.map((p) => p.category));

    for (const required of [
      "WEBSITE",
      "SITEMAP",
      "FEED",
      "PUBLIC_JOBS",
      "PUBLIC_DIRECTORY",
      "REPOSITORY",
      "PUBLIC_MEDIA",
      "MANUAL",
    ]) {
      expect(categories).toContain(required);
    }
  });

  it("offers at least one provider that needs no network at all", () => {
    // The zero-cost guarantee's backstop.
    expect(BUILT_IN_PROVIDERS.some((p) => !p.requiresNetwork)).toBe(true);
  });

  it("refuses a duplicate key", () => {
    const registry = new ProviderRegistry();
    const fake: DiscoveryProvider = {
      key: "dupe",
      label: "Dupe",
      category: "MANUAL",
      requiresNetwork: false,
      run: async () => ({
        entities: [],
        pagesAttempted: 0,
        pagesSucceeded: 0,
        pagesFailed: 0,
        pagesBlocked: 0,
        warnings: [],
      }),
    };

    registry.register(fake);
    expect(() => registry.register(fake)).toThrow(/Duplicate/);
  });

  it("filters by category", () => {
    const registry = createProviderRegistry();
    const manual = registry.byCategory("MANUAL");

    expect(manual.length).toBeGreaterThan(0);
    expect(manual.every((p) => p.category === "MANUAL")).toBe(true);
  });

  it("returns undefined for an unknown key", () => {
    expect(createProviderRegistry().get("nope")).toBeUndefined();
  });
});

describe("validateEntity", () => {
  it("accepts an entity with a name", () => {
    expect(validateEntity({ identity: { name: "Acme" }, facts: [] })).toEqual({
      valid: true,
    });
  });

  it("accepts an entity with only a domain", () => {
    expect(
      validateEntity({ identity: { domain: "acme.com" }, facts: [] }),
    ).toEqual({ valid: true });
  });

  it("rejects an unidentifiable entity", () => {
    const result = validateEntity({ identity: {}, facts: [] });

    expect(result.valid).toBe(false);
  });

  it("rejects a fact with no extraction method", () => {
    const result = validateEntity({
      identity: { name: "Acme" },
      facts: [{ field: "email", method: "" }],
    });

    expect(result.valid).toBe(false);
  });
});

describe("sitemapProvider", () => {
  it("turns listed hosts into candidate businesses", async () => {
    const probe = await startFixtureServer({});
    const other = probe.url;
    await probe.close();

    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/sitemap.xml": {
        contentType: "application/xml",
        body: `<urlset>
          <url><loc>${other}/a</loc></url>
          <url><loc>${other}/b</loc></url>
        </urlset>`,
      },
    });

    const result = await sitemapProvider.run(
      ctx({ urls: [`${server.url}/sitemap.xml`] }),
    );

    // Two URLs on one host collapse to a single business.
    expect(result.entities).toHaveLength(1);
    expect(result.pagesSucceeded).toBe(1);
  });

  it("records a blocked sitemap and returns nothing", async () => {
    server = await startFixtureServer({
      "/robots.txt": { body: "User-agent: *\nDisallow: /", contentType: "text/plain" },
      "/sitemap.xml": { body: "<urlset></urlset>" },
    });

    const result = await sitemapProvider.run(
      ctx({ urls: [`${server.url}/sitemap.xml`] }),
    );

    expect(result.pagesBlocked).toBe(1);
    expect(result.entities).toHaveLength(0);
  });

  it("survives a missing sitemap", async () => {
    server = await startFixtureServer({ "/robots.txt": ROBOTS });

    const result = await sitemapProvider.run(
      ctx({ urls: [`${server.url}/sitemap.xml`] }),
    );

    expect(result.pagesFailed).toBe(1);
    expect(result.entities).toHaveLength(0);
  });
});

describe("feedProvider", () => {
  const FEED = (link: string) => `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Local business news</title>
      <item>
        <title>Acme Dental opens new clinic</title>
        <link>${link}/acme</link>
        <pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;

  it("treats linked businesses as candidates", async () => {
    const probe = await startFixtureServer({});
    const target = probe.url;
    await probe.close();

    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/feed.xml": { contentType: "application/rss+xml", body: FEED(target) },
    });

    const result = await feedProvider.run(ctx({ urls: [`${server.url}/feed.xml`] }));

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].facts[0].method).toBe("FEED");
  });

  it("skips entries older than the freshness window", async () => {
    const probe = await startFixtureServer({});
    const target = probe.url;
    await probe.close();

    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/feed.xml": {
        contentType: "application/rss+xml",
        body: `<rss><channel><item>
          <title>Ancient news</title>
          <link>${target}/old</link>
          <pubDate>Mon, 01 Jan 2020 10:00:00 GMT</pubDate>
        </item></channel></rss>`,
      },
    });

    const result = await feedProvider.run(
      ctx({ urls: [`${server.url}/feed.xml`], maxAgeDays: 30 }),
    );

    expect(result.entities).toHaveLength(0);
  });

  it("keeps entries that have no date at all", async () => {
    const probe = await startFixtureServer({});
    const target = probe.url;
    await probe.close();

    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/feed.xml": {
        contentType: "application/rss+xml",
        body: `<rss><channel><item>
          <title>Undated</title><link>${target}/x</link>
        </item></channel></rss>`,
      },
    });

    const result = await feedProvider.run(
      ctx({ urls: [`${server.url}/feed.xml`], maxAgeDays: 30 }),
    );

    // Missing date is not evidence of being old.
    expect(result.entities).toHaveLength(1);
  });
});

describe("jobsProvider", () => {
  describe("classifyRole", () => {
    it("recognises the roles that imply our services", () => {
      expect(classifyRole("Social Media Manager")).toContain("SOCIAL_MEDIA");
      expect(classifyRole("Digital Marketing Executive")).toContain("MARKETING");
      expect(classifyRole("Content Writer")).toContain("CONTENT");
      expect(classifyRole("Web Developer")).toContain("WEB");
      expect(classifyRole("Graphic Designer")).toContain("DESIGN");
      expect(classifyRole("Video Editor")).toContain("VIDEO");
    });

    it("returns every matching area for a combined role", () => {
      const areas = classifyRole("Social Media & Content Writer");
      expect(areas).toContain("SOCIAL_MEDIA");
      expect(areas).toContain("CONTENT");
    });

    it("ignores unrelated roles", () => {
      // A dental nurse vacancy is not a marketing buying signal.
      expect(classifyRole("Dental Nurse")).toEqual([]);
      expect(classifyRole("Warehouse Operative")).toEqual([]);
      expect(classifyRole("")).toEqual([]);
    });
  });

  it("records hiring from a career page", async () => {
    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/careers": {
        body: `<html><head><title>Acme Careers</title></head><body>
          <ul>
            <li>Social Media Manager</li>
            <li>Dental Nurse</li>
          </ul>
        </body></html>`,
      },
    });

    const result = await jobsProvider.run(
      ctx({ careerPageUrls: [`${server.url}/careers`] }),
    );

    expect(result.entities).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("SOCIAL_MEDIA"))).toBe(true);
  });

  it("produces nothing when no relevant roles are advertised", async () => {
    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/careers": {
        body: `<html><body><ul><li>Dental Nurse</li><li>Receptionist</li></ul></body></html>`,
      },
    });

    const result = await jobsProvider.run(
      ctx({ careerPageUrls: [`${server.url}/careers`] }),
    );

    expect(result.entities).toHaveLength(0);
  });
});

describe("directoryProvider", () => {
  it("collects external businesses and ignores navigation", async () => {
    const probe = await startFixtureServer({});
    const member = probe.url;
    await probe.close();

    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/members": {
        body: `<html><body>
          <a href="/about">About us</a>
          <a href="https://facebook.com/dir">Facebook</a>
          <a href="${member}">Acme Dental</a>
        </body></html>`,
      },
    });

    const result = await directoryProvider.run(
      ctx({ urls: [`${server.url}/members`] }),
    );

    // Internal link and social link are both excluded.
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].identity.name).toBe("Acme Dental");
  });

  it("knows which hosts are never businesses", () => {
    expect(isIgnoredHost("facebook.com")).toBe(true);
    expect(isIgnoredHost("linkedin.com")).toBe(true);
    expect(isIgnoredHost("acme-dental.com")).toBe(false);
  });
});

describe("repositoryProvider", () => {
  it("reads homepages from a public JSON API", async () => {
    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/repos": {
        contentType: "application/json",
        body: JSON.stringify([
          { full_name: "acme/site", homepage: "https://acme-agency.test", owner: { login: "acme" } },
          { full_name: "acme/none", homepage: "" },
          { full_name: "acme/social", homepage: "https://facebook.com/acme" },
          { full_name: "acme/package", homepage: "https://npmjs.com/package/acme" },
        ]),
      },
    });

    const result = await repositoryProvider.run(ctx({ apiUrls: [`${server.url}/repos`] }));

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].identity.domain).toBe("acme-agency.test");
    // The repository owner is not proof that it owns the advertised homepage.
    expect(result.entities[0].identity.name).toBeNull();
  });

  it("handles a search-style payload and invalid JSON", async () => {
    server = await startFixtureServer({
      "/robots.txt": ROBOTS,
      "/search": {
        contentType: "application/json",
        body: JSON.stringify({ items: [{ homepage: "https://found.test" }] }),
      },
      "/broken": { contentType: "application/json", body: "{not json" },
    });

    const ok = await repositoryProvider.run(ctx({ apiUrls: [`${server.url}/search`] }));
    expect(ok.entities).toHaveLength(1);

    const bad = await repositoryProvider.run(ctx({ apiUrls: [`${server.url}/broken`] }));
    expect(bad.entities).toHaveLength(0);
    expect(bad.warnings.some((w) => w.includes("JSON"))).toBe(true);
  });
});

describe("manualCsvProvider", () => {
  describe("parseCsv", () => {
    it("handles quotes, escaped quotes and embedded newlines", () => {
      const rows = parseCsv('name,notes\n"Acme, Ltd","He said ""hi""\nsecond line"');

      expect(rows).toHaveLength(2);
      expect(rows[1][0]).toBe("Acme, Ltd");
      expect(rows[1][1]).toBe('He said "hi"\nsecond line');
    });

    it("handles CRLF files", () => {
      expect(parseCsv("a,b\r\n1,2")).toEqual([
        ["a", "b"],
        ["1", "2"],
      ]);
    });

    it("skips blank lines", () => {
      expect(parseCsv("a,b\n\n1,2\n")).toHaveLength(2);
    });
  });

  it("maps header aliases and ignores unknown columns", () => {
    expect(mapHeaders(["Company Name", "URL", "Nonsense"])).toEqual([
      "name",
      "website",
      null,
    ]);
  });

  it("imports rows as MANUAL facts", async () => {
    const result = await manualCsvProvider.run(
      ctx({
        csv: "company,website,city\nAcme Dental,https://acme-dental.test,Chennai",
      }),
    );

    expect(result.entities).toHaveLength(1);

    const entity = result.entities[0];
    expect(entity.identity.name).toBe("Acme Dental");
    // Manual entry outranks every crawler.
    expect(entity.facts.every((f) => f.method === "MANUAL")).toBe(true);
  });

  it("needs no network", async () => {
    expect(manualCsvProvider.requiresNetwork).toBe(false);

    const result = await manualCsvProvider.run({
      workspaceId: "ws",
      sourceId: null,
      config: { csv: "name\nAcme" },
      // A fetcher that would fail loudly if touched.
      fetcher: {
        fetch: async () => {
          throw new Error("network must not be used");
        },
      },
      now: new Date(),
    });

    expect(result.entities).toHaveLength(1);
  });

  it("reports unusable input instead of importing junk", async () => {
    const noColumns = await manualCsvProvider.run(
      ctx({ csv: "colour,size\nred,large" }),
    );
    expect(noColumns.entities).toHaveLength(0);
    expect(noColumns.warnings.length).toBeGreaterThan(0);

    const empty = await manualCsvProvider.run(ctx({ csv: "" }));
    expect(empty.entities).toHaveLength(0);

    const headerOnly = await manualCsvProvider.run(ctx({ csv: "name,website" }));
    expect(headerOnly.entities).toHaveLength(0);
  });

  it("skips rows with neither name nor website", async () => {
    const result = await manualCsvProvider.run(
      ctx({ csv: "name,city\nAcme,Chennai\n,Mumbai" }),
    );

    expect(result.entities).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("Row 3"))).toBe(true);
  });
});

describe("every provider degrades safely", () => {
  it("returns an empty result rather than throwing on empty config", async () => {
    for (const provider of BUILT_IN_PROVIDERS) {
      const result = await provider.run(ctx({}));

      expect(Array.isArray(result.entities)).toBe(true);
      expect(result.entities).toHaveLength(0);
    }
  });

  it("returns an empty result when the network is unreachable", async () => {
    const networked = BUILT_IN_PROVIDERS.filter((p) => p.requiresNetwork);

    for (const provider of networked) {
      const dead = "http://127.0.0.1:1/x";
      const result = await provider.run({
        workspaceId: "ws",
        sourceId: null,
        config: {
          urls: [dead],
          apiUrls: [dead],
          feedUrls: [dead],
          careerPageUrls: [dead],
        },
        fetcher: new HttpFetcher({ minIntervalMs: 0, timeoutMs: 400, allowLoopback: true }),
        now: new Date(),
      });

      expect(result.entities).toHaveLength(0);
      expect(result.pagesAttempted).toBeGreaterThan(0);
    }
  });
});
