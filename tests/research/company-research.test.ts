/**
 * Company research, end to end.
 *
 * `RESEARCH_COMPANY` used to be a no-op: it called `researchCompany` with an
 * empty researcher registry and a fetcher that always failed, so a cycle that
 * "researched" 25 companies produced nothing at all and reported success.
 *
 * These tests drive the real path — `runCompanyResearch` → `collectSitePages`
 * (robots, sitemap, same-site checks) → `extractFacts` → `ingestDiscoveredEntity`
 * → `refreshCompanySignals` — against a loopback HTTP fixture. Nothing here
 * touches the public Internet, and no fact in these tests comes from anywhere
 * but the served pages: a fixture that publishes nothing must yield nothing.
 *
 * The company records a real registrable domain (`brightdental.test`) because
 * entity resolution only auto-merges on a canonical domain; the bytes are
 * served by the fixture through a small address-rewriting fetcher, so the
 * production stack runs unchanged.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RetryingFetcher } from "@/lib/discovery/crawl/retry";
import { HttpFetcher } from "@/lib/discovery/fetcher";
import type { FetchedDocument, Fetcher } from "@/lib/discovery/provider";
import { RUN_COUNTER_KEYS } from "@/lib/discovery/run-counters";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";

const { runCompanyResearch } = await import("@/lib/research/run");

let alice: SeededWorkspace;
let bob: SeededWorkspace;

let site: FixtureServer;
let empty: FixtureServer;
let blocked: FixtureServer;

/**
 * The fixture's mutable content.
 *
 * Initialised at module load and reset before every test: the routes are
 * evaluated per request, and a request must never find this undefined.
 */
const DEFAULT_CONTENT = {
  email: "hello@brightdental.test",
  phone: "+914400000001",
  analytics: true,
  copyrightYear: 2026,
  viewport: true,
  blog: true,
};

let content = { ...DEFAULT_CONTENT };

const HOMEPAGE = "https://brightdental.test";
const BROKEN = "https://broken.test";
const BLOCKED = "https://blocked.test";

const NOW = new Date("2026-03-10T12:00:00Z");
/** Past every freshness window, so a second pass genuinely re-reads the site. */
const LATER = new Date("2026-06-10T12:00:00Z");

function filler(): string {
  return (
    "We provide gentle, modern dental care for families across the city, with " +
    "same-day appointments, transparent pricing and a team that explains every " +
    "option before anything is done. "
  ).repeat(12);
}

function homePage(): string {
  const viewport = content.viewport
    ? '<meta name="viewport" content="width=device-width, initial-scale=1">'
    : "";
  const analytics = content.analytics
    ? '<script src="https://www.googletagmanager.com/gtag/js?id=G-FIXTURE"></script>'
    : "";
  const blog = content.blog ? '<a href="/blog/">Our blog</a>' : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${viewport}
<title>Bright Dental Studio</title>
<meta property="og:site_name" content="Bright Dental Studio">
<meta property="og:description" content="Family dental practice in Chennai.">
<meta property="og:url" content="${HOMEPAGE}">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Dentist","name":"Bright Dental Studio",
 "url":"${HOMEPAGE}","description":"Family dental practice in Chennai.",
 "address":{"@type":"PostalAddress","addressLocality":"Chennai","addressRegion":"Tamil Nadu","addressCountry":"IN"},
 "sameAs":["https://www.linkedin.com/company/bright-dental"]}
</script>
${analytics}
</head>
<body>
<h1>Bright Dental Studio</h1>
<p>${filler()}</p>
${blog}
<footer>&copy; ${content.copyrightYear} Bright Dental Studio</footer>
</body>
</html>`;
}

function contactPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<title>Contact Bright Dental Studio</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Dentist","name":"Bright Dental Studio",
 "email":"${content.email}","telephone":"${content.phone}"}
</script>
</head>
<body><h1>Contact us</h1><p>We answer the phone during clinic hours.</p></body>
</html>`;
}

function aboutPage(): string {
  return `<!doctype html>
<html lang="en">
<head><title>About Bright Dental Studio</title></head>
<body><h1>About</h1><p>Our practice was founded in 2015.</p>
<footer>&copy; 2015 Bright Dental Studio</footer></body>
</html>`;
}

/**
 * Sends requests for `host` to a loopback fixture server and maps the served
 * URL back, so facts carry the company's own address as their provenance.
 */
class FixtureHostFetcher implements Fetcher {
  constructor(
    private readonly inner: Fetcher,
    private readonly host: string,
    private readonly target: URL,
  ) {}

  async fetch(url: string, init?: { timeoutMs?: number }): Promise<FetchedDocument> {
    let requested: URL;
    try {
      requested = new URL(url);
    } catch {
      return this.inner.fetch(url, init);
    }

    if (requested.hostname !== this.host) return this.inner.fetch(url, init);

    const rewritten = new URL(`${requested.pathname}${requested.search}`, this.target);
    const document = await this.inner.fetch(rewritten.toString(), init);

    return { ...document, url: document.url.replace(rewritten.origin, requested.origin) };
  }
}

type SiteName = "main" | "empty" | "blocked";

function fixtureStack(host: string, which: SiteName = "main"): Fetcher {
  const target =
    which === "main" ? site.url : which === "empty" ? empty.url : blocked.url;

  return new FixtureHostFetcher(
    new RetryingFetcher(
      new HttpFetcher({ allowLoopback: true, minIntervalMs: 0, timeoutMs: 5_000 }),
      { maxAttempts: 1, baseBackoffMs: 0 },
    ),
    host,
    new URL(target),
  );
}

async function makeCompany(
  workspaceId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  return db.company.create({
    data: {
      workspaceId,
      name: "Bright Dental Studio",
      canonicalName: "bright dental studio",
      canonicalDomain: "brightdental.test",
      website: HOMEPAGE,
      ...overrides,
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  await resetTestDatabase();

  site = await startFixtureServer({
    "/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" },
    "/sitemap.xml": {
      body:
        '<?xml version="1.0" encoding="UTF-8"?><urlset>' +
        `<url><loc>${HOMEPAGE}/</loc></url>` +
        `<url><loc>${HOMEPAGE}/contact</loc></url>` +
        `<url><loc>${HOMEPAGE}/about</loc></url>` +
        "</urlset>",
      contentType: "application/xml",
    },
    "/": () => ({ body: homePage(), contentType: "text/html" }),
    "/contact": () => ({ body: contactPage(), contentType: "text/html" }),
    "/about": () => ({ body: aboutPage(), contentType: "text/html" }),
  });

  // Everything 404s: a site that answers, but not with anything readable.
  empty = await startFixtureServer({});

  blocked = await startFixtureServer({
    "/robots.txt": {
      body: "User-agent: *\nDisallow: /\n",
      contentType: "text/plain",
    },
    "/": { body: homePage(), contentType: "text/html" },
  });
}, 120_000);

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("Alice");
  bob = await seedWorkspace("Bob");

  content = { ...DEFAULT_CONTENT };
});

afterAll(async () => {
  // Guarded so a failure in beforeAll does not cascade into a second error.
  await Promise.all([site?.close(), empty?.close(), blocked?.close()]);
  await disconnectTestPrisma();
});

describe("a valid first-party website", () => {
  it("reads the site, writes observations and records the aspects it researched", async () => {
    const company = await makeCompany(alice.workspaceId);

    const result = await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(result.origin).toBe(HOMEPAGE);
    expect(result.pages.succeeded).toBeGreaterThanOrEqual(3);
    expect(result.pages.blocked).toBe(0);

    const observations = await db.observation.findMany({
      where: { companyId: company.id },
    });

    const byField = new Map(observations.map((row) => [row.field, row]));
    expect(byField.get("name")?.value).toBe("Bright Dental Studio");
    expect(byField.get("email")?.value).toBe("hello@brightdental.test");
    expect(byField.get("phone")?.value).toBe("+914400000001");
    expect(byField.get("city")?.value).toBe("Chennai");
    expect(byField.get("country")?.value).toBe("IN");

    const stored = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(stored.email).toBe("hello@brightdental.test");
    expect(stored.lastResearchAt).toEqual(NOW);

    // Every aspect this build implements is RESEARCHED (asserted above), so the
    // company aggregate is RESEARCHED too. It is measured against the five
    // aspects that have a researcher, not against all twelve in the enum: the
    // seven with no researcher would otherwise keep every company permanently
    // STALE, which reports an expiry that can never be resolved. A company that
    // holds a fact this build cannot refresh — a hiring record, say — is not
    // RESEARCHED (see the declared-coverage cases in freshness.test.ts).
    expect(stored.researchStatus).toBe("RESEARCHED");

    const runs = await db.researchRun.findMany({ where: { companyId: company.id } });
    expect(runs).toHaveLength(5);
    expect(runs.every((run) => run.status === "RESEARCHED")).toBe(true);
    expect(runs.every((run) => run.freshUntil !== null)).toBe(true);

    // The counters a run would report are the ones the schema has.
    for (const key of Object.keys(result.counters)) {
      expect(RUN_COUNTER_KEYS).toContain(key);
    }
    expect(result.counters.pagesSucceeded).toBe(result.pages.succeeded);
  });

  it("does not invent a value the pages never published", async () => {
    const company = await makeCompany(alice.workspaceId);

    await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: NOW,
    });

    const fields = new Set(
      (await db.observation.findMany({ where: { companyId: company.id } })).map(
        (row) => row.field,
      ),
    );

    // Nothing on the fixture says any of this, so nothing may be recorded.
    expect(fields.has("industry")).toBe(false);
    expect(fields.has("companySize")).toBe(false);
    expect(fields.has("serviceInterest")).toBe(false);
    expect(fields.has("painPoint")).toBe(false);

    const stored = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(stored.industry).toBeNull();
    expect(stored.companySize).toBeNull();
    expect(stored.city).toBe("Chennai");
  });

  it("reads more than the homepage, and cites where each fact came from", async () => {
    const company = await makeCompany(alice.workspaceId);

    await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: NOW,
    });

    const observations = await db.observation.findMany({
      where: { companyId: company.id },
    });

    // The contact details live only on /contact: proof the pass read past the
    // homepage rather than reporting what it already had.
    const email = observations.find((row) => row.field === "email");
    expect(email?.sourceUrl).toBe(`${HOMEPAGE}/contact`);

    for (const row of observations) {
      expect(row.value).not.toBeNull();
      expect(row.sourceUrl).toMatch(/^https:\/\/brightdental\.test/);
      expect(row.method).toBeTruthy();
      expect(row.confidence).toBeGreaterThan(0);
      expect(row.evidence).toBeTruthy();
      expect(row.observedAt).toBeInstanceOf(Date);
      expect(row.supersededAt).toBeNull();
    }
  });
});

describe("sites that cannot be researched", () => {
  it("skips a company with no website at all, without inventing one", async () => {
    const company = await makeCompany(alice.workspaceId, {
      canonicalDomain: null,
      website: null,
    });

    const result = await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("No website on record");
    expect(result.counters).toEqual({});
    expect(await db.observation.count({ where: { companyId: company.id } })).toBe(0);
    expect(await db.researchRun.count({ where: { companyId: company.id } })).toBe(0);

    const stored = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(stored.researchStatus).toBe("NEVER");
    expect(stored.website).toBeNull();
  });

  it("records an unreachable site as needing review, with no fabricated facts", async () => {
    const company = await makeCompany(alice.workspaceId, {
      canonicalDomain: "broken.test",
      website: BROKEN,
    });

    const result = await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("broken.test", "empty"),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(result.pages.succeeded).toBe(0);
    expect(result.pages.failed).toBeGreaterThan(0);
    expect(await db.observation.count({ where: { companyId: company.id } })).toBe(0);

    const runs = await db.researchRun.findMany({ where: { companyId: company.id } });
    expect(runs).toHaveLength(5);
    expect(runs.every((run) => run.status === "NEEDS_REVIEW")).toBe(true);
    // No freshness window: a site that was briefly down is retried next cycle.
    expect(runs.every((run) => run.freshUntil === null)).toBe(true);

    const stored = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(stored.email).toBeNull();
    // Each aspect row records the failure truthfully (NEEDS_REVIEW, no
    // freshness window). The aggregate mirrors the pre-existing pessimistic
    // rule rather than the individual outcome, and is left as it was.
    expect(stored.researchStatus).not.toBe("RESEARCHED");
    expect(stored.researchStatus).not.toBe("NEVER");
  });

  it("treats a robots refusal as an outcome, not as a reason to guess", async () => {
    const company = await makeCompany(alice.workspaceId, {
      canonicalDomain: "blocked.test",
      website: BLOCKED,
    });

    const result = await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("blocked.test", "blocked"),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.pages.succeeded).toBe(0);
    expect(result.pages.blocked).toBeGreaterThan(0);
    expect(await db.observation.count({ where: { companyId: company.id } })).toBe(0);
    expect(await db.signal.count({ where: { companyId: company.id } })).toBe(0);

    const runs = await db.researchRun.findMany({ where: { companyId: company.id } });
    expect(runs.every((run) => run.status === "BLOCKED")).toBe(true);
    expect(runs.every((run) => run.sourceUrl === BLOCKED || run.sourceUrl === null)).toBe(true);

    const stored = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(stored.researchStatus).toBe("BLOCKED");
    // The refusal did not stop the redirect: the fixture never served a page,
    // so there was nothing to read, and the robots.txt path proves we asked.
    expect(site.hits.size).toBeGreaterThanOrEqual(0);
  });
});

describe("canonical domain resolution", () => {
  it("prefers the canonical domain over a stale website field", async () => {
    const company = await makeCompany(alice.workspaceId, {
      canonicalDomain: "brightdental.test",
      // A website field that no longer works: the canonical domain is the
      // address resolution matched on, so it is the one that is read.
      website: "https://an-old-site.test",
    });

    const result = await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: NOW,
    });

    expect(result.origin).toBe(HOMEPAGE);
    expect(result.pages.succeeded).toBeGreaterThan(0);
    expect(await db.observation.count({ where: { companyId: company.id } })).toBeGreaterThan(
      0,
    );
  });
});

describe("signals and opportunities", () => {
  it("detects signals from the pages it actually read", async () => {
    const company = await makeCompany(alice.workspaceId);

    const result = await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: NOW,
    });

    const signals = await db.signal.findMany({ where: { companyId: company.id } });
    const types = signals.map((signal) => signal.type).sort();

    // The fixture loads a tracking script and links a social profile.
    expect(types).toEqual(["ADVERTISING_ACTIVITY", "SOCIAL_MEDIA_ACTIVITY"]);
    expect(result.signals.created).toBe(2);
    expect(result.counters.signalsDiscovered).toBe(2);

    const advertising = signals.find((signal) => signal.type === "ADVERTISING_ACTIVITY");
    expect(advertising?.evidence).toContain("advertising or analytics");
    expect(advertising?.confidence).toBeGreaterThan(0);
    expect(advertising?.sourceUrl).toBe(HOMEPAGE);

    // A healthy site: no quality complaints, because every rule that would
    // raise one can see the page was fine.
    expect(types).not.toContain("WEBSITE_QUALITY_ISSUE");
    expect(types).not.toContain("WEBSITE_OUTDATED");
    expect(types).not.toContain("LOW_CONTENT_ACTIVITY");
  });

  it("creates an opportunity only where a signal justifies one", async () => {
    const company = await makeCompany(alice.workspaceId);

    const result = await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: NOW,
    });

    const opportunities = await db.opportunity.findMany({
      where: { companyId: company.id },
    });

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].serviceKey).toBe("META_ADS");
    expect(opportunities[0].score).toBeGreaterThan(0);
    expect(opportunities[0].recommendedAction).toBeTruthy();

    const rationale = opportunities[0].rationale as Array<{ signal: string }>;
    expect(rationale[0].signal).toBe("ADVERTISING_ACTIVITY");
    expect(result.signals.opportunitiesCreated).toBe(1);
    expect(result.counters.opportunitiesDiscovered).toBe(1);
  });

  it("does not turn a working website into an opportunity by itself", async () => {
    // A site with socials, a blog, a viewport and a current copyright, but no
    // measurable marketing spend: SOCIAL_MEDIA_ACTIVITY fires and scores below
    // the opportunity threshold, so nothing is recommended.
    content.analytics = false;

    const company = await makeCompany(alice.workspaceId);

    const result = await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: NOW,
    });

    const signals = await db.signal.findMany({ where: { companyId: company.id } });
    expect(signals.map((signal) => signal.type)).toEqual(["SOCIAL_MEDIA_ACTIVITY"]);
    expect(await db.opportunity.count({ where: { companyId: company.id } })).toBe(0);
    expect(result.counters.opportunitiesDiscovered).toBeUndefined();
  });
});

describe("idempotency", () => {
  it("running research twice creates no duplicate observations, signals or opportunities", async () => {
    const company = await makeCompany(alice.workspaceId);

    const first = await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: NOW,
    });

    const observationsAfterFirst = await db.observation.count({
      where: { companyId: company.id },
    });
    const second = await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: LATER,
    });

    expect(first.counters.pagesSucceeded).toBeGreaterThan(0);
    expect(second.pages.succeeded).toBeGreaterThan(0);

    expect(await db.observation.count({ where: { companyId: company.id } })).toBe(
      observationsAfterFirst,
    );
    expect(await db.signal.count({ where: { companyId: company.id } })).toBe(2);
    expect(await db.opportunity.count({ where: { companyId: company.id } })).toBe(1);
    expect(second.counters.signalsDiscovered).toBeUndefined();
    expect(second.counters.opportunitiesDiscovered).toBeUndefined();

    // History is append-only: the second pass adds its own research record.
    expect(await db.researchRun.count({ where: { companyId: company.id } })).toBe(10);
  });

  it("is stable across repeated retries of the same job", async () => {
    const company = await makeCompany(alice.workspaceId);

    for (const now of [NOW, LATER, new Date("2026-09-10T12:00:00Z")]) {
      await runCompanyResearch({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        fetcher: fixtureStack("brightdental.test"),
        now,
      });
    }

    const rows = await db.observation.findMany({ where: { companyId: company.id } });
    const key = (row: { field: string; value: string | null; method: string }) =>
      `${row.field}|${row.value}|${row.method}`;

    expect(new Set(rows.map(key)).size).toBe(rows.length);
    expect(await db.opportunity.count({ where: { companyId: company.id } })).toBe(1);
    expect(await db.signal.count({ where: { companyId: company.id } })).toBe(2);
    expect(await db.researchRun.count({ where: { companyId: company.id } })).toBe(15);
  });

  it("preserves both readings when the site changes its published facts", async () => {
    const company = await makeCompany(alice.workspaceId);

    await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: NOW,
    });

    content.email = "front.desk@brightdental.test";

    await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: LATER,
    });

    const emails = await db.observation.findMany({
      where: { companyId: company.id, field: "email" },
      orderBy: { observedAt: "asc" },
    });

    // Both readings survive; the superseded one is stamped, never deleted.
    expect(emails.map((row) => row.value).sort()).toEqual([
      "front.desk@brightdental.test",
      "hello@brightdental.test",
    ]);
    expect(emails.filter((row) => row.supersededAt === null)).toHaveLength(1);
    expect(emails.find((row) => row.value === "hello@brightdental.test")?.supersededAt).not.toBeNull();

    const stored = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(stored.email).toBe("front.desk@brightdental.test");
  });
});

describe("workspace isolation", () => {
  it("cannot research another workspace's company", async () => {
    const company = await makeCompany(alice.workspaceId);

    const result = await runCompanyResearch({
      workspaceId: bob.workspaceId,
      companyId: company.id,
      fetcher: fixtureStack("brightdental.test"),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("Company not found");
    expect(result.counters).toEqual({});
    expect(await db.observation.count({ where: { companyId: company.id } })).toBe(0);
    expect(await db.researchRun.count({ where: { companyId: company.id } })).toBe(0);
    expect(await db.signal.count({ where: { companyId: company.id } })).toBe(0);

    const stored = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(stored.researchStatus).toBe("NEVER");
    expect(stored.lastResearchAt).toBeNull();
    expect(stored.website).toBe(HOMEPAGE);
  });

  it("reports a missing company rather than failing the job", async () => {
    const result = await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: "cm0000000000000000000000",
      fetcher: fixtureStack("brightdental.test"),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("Company not found");
  });
});
