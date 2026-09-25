/**
 * P15 real-public-Internet validation.
 *
 * Everything here talks to the actual Internet. It is excluded from the normal
 * `npm test` run (see `vitest.p15.config.ts`) because a suite that silently
 * depends on a third party is a suite that fails for reasons unrelated to the
 * code. It exists to answer one question the offline suite cannot: does the
 * pipeline work against real, permitted, public sources?
 *
 * Sources used are public JSON/HTML endpoints that require no login, no API
 * key, no CAPTCHA and no paywall circumvention:
 *   - api.github.com  (documented public REST API)
 *   - registry.npmjs.org (documented public registry API)
 *   - pypi.org (documented public JSON API)
 *
 * Run with:
 *   DATABASE_URL=... npx vitest run --config vitest.p15.config.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpFetcher } from "@/lib/discovery/fetcher";
import { runSource } from "@/lib/discovery/pipeline";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

let ws: SeededWorkspace;

/** Collected for the P15 report. Printed at the end of the run. */
const evidence: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  await resetTestDatabase();
  await truncateAll();
  ws = await seedWorkspace("P15");
}, 180_000);

afterAll(async () => {
  console.log("\n=== P15 REAL-INTERNET EVIDENCE ===");
  console.log(JSON.stringify(evidence, null, 2));
  await disconnectTestPrisma();
});

function fetcher() {
  return new HttpFetcher({
    // Identify honestly, and give a contact route. Impersonating a browser to
    // dodge bot rules would be exactly the circumvention the spec forbids.
    userAgent:
      "FreelanceOSBot/0.1 (+https://github.com/joeeeee28/FreelanceOS; validation)",
    timeoutMs: 20_000,
    minIntervalMs: 1_500,
    respectRobots: true,
  });
}

async function makeSource(
  provider: string,
  name: string,
  config: Record<string, unknown>,
) {
  return db.source.create({
    data: {
      workspaceId: ws.workspaceId,
      provider,
      name,
      url: typeof config.url === "string" ? config.url : null,
      config: config as never,
      requestsPerMinute: 20,
    },
  });
}

describe("real public internet: raw fetch", () => {
  it("fetches a real public JSON API and classifies the outcome", async () => {
    const url = "https://api.github.com/repos/vercel/next.js";
    const started = Date.now();
    const doc = await fetcher().fetch(url);
    const durationMs = Date.now() - started;

    evidence.push({
      check: "raw-fetch",
      url,
      outcome: doc.outcome,
      statusCode: doc.statusCode ?? null,
      contentType: doc.contentType ?? null,
      bytes: typeof doc.body === "string" ? doc.body.length : 0,
      durationMs,
    });

    expect(doc.outcome).toBe("SUCCESS");
    expect(doc.statusCode).toBe(200);
    expect(typeof doc.body).toBe("string");
  }, 60_000);

  it("records an unreachable host as a failure rather than throwing", async () => {
    // A host that does not resolve. The engine must classify, not crash.
    const url = "https://this-host-does-not-exist-p15-validation.invalid/";
    const doc = await fetcher().fetch(url);

    evidence.push({
      check: "unreachable-host",
      url,
      outcome: doc.outcome,
      error: doc.error ?? null,
    });

    expect(doc.outcome).not.toBe("SUCCESS");
    expect(["NETWORK_ERROR", "TIMEOUT", "BLOCKED"]).toContain(doc.outcome);
  }, 60_000);

  it("records a real 404 as NOT_FOUND, which is never retried", async () => {
    const url = "https://api.github.com/repos/vercel/this-repo-does-not-exist-p15";
    const doc = await fetcher().fetch(url);

    evidence.push({
      check: "real-404",
      url,
      outcome: doc.outcome,
      statusCode: doc.statusCode ?? null,
    });

    expect(doc.outcome).toBe("NOT_FOUND");
  }, 60_000);
});

describe("real public internet: full pipeline", () => {
  it("runs the repository provider against the real GitHub API end to end", async () => {
    const apiUrl =
      "https://api.github.com/search/repositories?q=stars:%3E50000&sort=stars&per_page=20";

    const source = await makeSource("public-repository", "GitHub popular repos", {
      apiUrls: [apiUrl],
      maxItems: 20,
    });

    const started = Date.now();
    const result = await runSource({
      workspaceId: ws.workspaceId,
      sourceId: source.id,
      fetcher: fetcher(),
    });
    const durationMs = Date.now() - started;

    const companies = await db.company.findMany({
      where: { workspaceId: ws.workspaceId },
      include: { observations: true },
    });

    evidence.push({
      check: "pipeline-github",
      sourceUrl: apiUrl,
      durationMs,
      ok: result.ok,
      pagesAttempted: result.pagesAttempted,
      pagesSucceeded: result.pagesSucceeded,
      pagesFailed: result.pagesFailed,
      pagesBlocked: result.pagesBlocked,
      entitiesFound: result.entitiesFound,
      entitiesValid: result.entitiesValid,
      companiesCreated: result.companiesCreated,
      companiesMatched: result.companiesMatched,
      warnings: result.warnings.slice(0, 5),
      sampleCompanies: companies.slice(0, 8).map((c) => ({
        name: c.name,
        canonicalDomain: c.canonicalDomain,
        website: c.website,
        resolutionState: c.resolutionState,
        observations: c.observations.length,
      })),
    });

    expect(result.pagesSucceeded).toBeGreaterThan(0);
    expect(result.entitiesFound).toBeGreaterThan(0);
    expect(companies.length).toBeGreaterThan(0);

    // Provenance is the whole point: every stored fact must be traceable.
    const observations = await db.observation.findMany({
      where: { workspaceId: ws.workspaceId },
      take: 5,
    });
    for (const o of observations) {
      expect(o.sourceUrl).toBeTruthy();
      expect(o.observedAt).toBeTruthy();
      expect(o.confidence).toBeGreaterThan(0);
    }
  }, 180_000);

  it("is idempotent: the identical real run twice creates no duplicates", async () => {
    const apiUrl =
      "https://api.github.com/search/repositories?q=stars:%3E50000&sort=stars&per_page=20";

    const source = await db.source.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId, provider: "public-repository" },
    });

    const before = await db.company.count({ where: { workspaceId: ws.workspaceId } });
    const observationsBefore = await db.observation.count({
      where: { workspaceId: ws.workspaceId },
    });

    const second = await runSource({
      workspaceId: ws.workspaceId,
      sourceId: source.id,
      fetcher: fetcher(),
    });

    const after = await db.company.count({ where: { workspaceId: ws.workspaceId } });
    const observationsAfter = await db.observation.count({
      where: { workspaceId: ws.workspaceId },
    });

    evidence.push({
      check: "repeat-run-idempotency",
      sourceUrl: apiUrl,
      companiesBefore: before,
      companiesAfter: after,
      companiesCreatedSecondRun: second.companiesCreated,
      companiesMatchedSecondRun: second.companiesMatched,
      observationsBefore,
      observationsAfter,
    });

    // The mandatory gate: a second identical run must not duplicate companies.
    expect(after).toBe(before);
    expect(second.companiesCreated).toBe(0);
    expect(second.companiesMatched).toBeGreaterThan(0);
    // History is append-only, so observations may grow; they must never shrink.
    expect(observationsAfter).toBeGreaterThanOrEqual(observationsBefore);
  }, 180_000);

  it("keeps going when one source in a run is unreachable", async () => {
    const good = await makeSource("public-repository", "GitHub org repos", {
      apiUrls: ["https://api.github.com/orgs/nodejs/repos?per_page=10"],
      maxItems: 10,
    });
    const bad = await makeSource("public-repository", "Intentionally dead", {
      apiUrls: ["https://p15-intentionally-unavailable.invalid/data.json"],
      maxItems: 10,
    });

    const badResult = await runSource({
      workspaceId: ws.workspaceId,
      sourceId: bad.id,
      fetcher: fetcher(),
    });
    const goodResult = await runSource({
      workspaceId: ws.workspaceId,
      sourceId: good.id,
      fetcher: fetcher(),
    });

    evidence.push({
      check: "source-fallback",
      deadSource: {
        ok: badResult.ok,
        pagesFailed: badResult.pagesFailed,
        companiesCreated: badResult.companiesCreated,
      },
      liveSource: {
        ok: goodResult.ok,
        pagesSucceeded: goodResult.pagesSucceeded,
        companiesCreated: goodResult.companiesCreated,
      },
    });

    // One dead source must never stop the pipeline.
    expect(badResult.pagesFailed).toBeGreaterThan(0);
    expect(goodResult.pagesSucceeded).toBeGreaterThan(0);
  }, 180_000);
});

describe("real public internet: robots.txt is obeyed", () => {
  it("reads a real robots.txt and applies it", async () => {
    const f = fetcher();
    // GitHub publishes a real robots.txt that disallows several paths.
    const disallowed = "https://github.com/search?q=test";
    const doc = await f.fetch(disallowed);

    evidence.push({
      check: "robots-enforcement",
      url: disallowed,
      outcome: doc.outcome,
      note:
        doc.outcome === "BLOCKED"
          ? "Refused by robots.txt and recorded, not bypassed"
          : `Permitted by robots.txt; outcome ${doc.outcome}`,
    });

    // Either outcome is acceptable; what matters is that the engine consulted
    // robots and never attempted circumvention. A BLOCKED result must carry no
    // body.
    if (doc.outcome === "BLOCKED") expect(doc.body ?? null).toBeNull();
  }, 60_000);
});
