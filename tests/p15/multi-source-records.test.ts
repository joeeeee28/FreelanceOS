/**
 * P15.1 — bounded, real-public-source record-quality audit.
 *
 * This makes a small, rate-limited read of three unauthenticated public
 * sources. It is intentionally not a market crawl: two GitHub API payloads,
 * one first-party PyPI website inspection, and one npm-registry policy check.
 * The test requires at least twenty *persisted discovery candidates* with
 * individual provenance; registry packages are inspected as a source-control
 * check and are never turned into candidate companies or leads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpFetcher } from "@/lib/discovery/fetcher";
import { runSource } from "@/lib/discovery/pipeline";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

let ws: SeededWorkspace;
const report: Record<string, unknown> = {};

const GITHUB_SEARCH_URL =
  "https://api.github.com/search/repositories?q=stars:%3E50000&sort=stars&per_page=20";
const GITHUB_ORG_URL = "https://api.github.com/orgs/vercel/repos?per_page=30";
const PYPI_URL = "https://pypi.org";
const NPM_REGISTRY_URL = "https://registry.npmjs.org/-/v1/search?text=react&size=5";

function fetcher() {
  return new HttpFetcher({
    userAgent:
      "FreelanceOSBot/0.1 (+https://github.com/joeeeee28/FreelanceOS; validation)",
    timeoutMs: 20_000,
    minIntervalMs: 1_000,
    respectRobots: true,
  });
}

beforeAll(async () => {
  await resetTestDatabase();
  await truncateAll();
  ws = await seedWorkspace("P15.1 multi-source audit");
}, 180_000);

afterAll(async () => {
  console.log("\n=== P15.1 MULTI-SOURCE RECORD AUDIT ===");
  console.log(JSON.stringify(report, null, 2));
  await disconnectTestPrisma();
});

describe("P15.1 bounded real-public-source record audit", () => {
  it("stores at least twenty individually attributable candidates across controlled sources", async () => {
    const githubSearch = await db.source.create({
      data: {
        workspaceId: ws.workspaceId,
        provider: "public-repository",
        name: "GitHub popular repositories — P15.1 bounded audit",
        url: GITHUB_SEARCH_URL,
        config: { apiUrls: [GITHUB_SEARCH_URL], maxItems: 20 } as never,
      },
    });
    const githubOrg = await db.source.create({
      data: {
        workspaceId: ws.workspaceId,
        provider: "public-repository",
        name: "GitHub Vercel repositories — P15.1 bounded audit",
        url: GITHUB_ORG_URL,
        config: { apiUrls: [GITHUB_ORG_URL], maxItems: 30 } as never,
      },
    });
    const pypi = await db.source.create({
      data: {
        workspaceId: ws.workspaceId,
        provider: "website",
        name: "PyPI first-party site — P15.1 bounded audit",
        url: PYPI_URL,
        config: { urls: [PYPI_URL], maxPages: 3 } as never,
      },
    });

    const githubSearchRun = await runSource({
      workspaceId: ws.workspaceId,
      sourceId: githubSearch.id,
      fetcher: fetcher(),
    });
    const githubOrgRun = await runSource({
      workspaceId: ws.workspaceId,
      sourceId: githubOrg.id,
      fetcher: fetcher(),
    });
    const pypiRun = await runSource({
      workspaceId: ws.workspaceId,
      sourceId: pypi.id,
      fetcher: fetcher(),
    });

    // A controlled repeat confirms the same public API payload enriches
    // provenance history rather than duplicating canonical company records.
    const githubSearchRepeat = await runSource({
      workspaceId: ws.workspaceId,
      sourceId: githubSearch.id,
      fetcher: fetcher(),
    });

    const companies = await db.company.findMany({
      where: { workspaceId: ws.workspaceId },
      include: {
        observations: {
          include: { source: true },
          orderBy: { observedAt: "asc" },
        },
      },
      orderBy: { canonicalDomain: "asc" },
    });

    const complete = companies.filter((company) =>
      company.observations.some(
        (observation) =>
          observation.sourceUrl !== null &&
          observation.locator !== null &&
          observation.evidence !== null &&
          observation.confidence > 0 &&
          observation.observedAt !== null,
      ),
    );
    const repositoryObservations = companies.flatMap((company) =>
      company.observations
        .filter((observation) => observation.source?.provider === "public-repository")
        .map((observation) => ({ company, observation })),
    );

    report.runs = {
      githubSearch: {
        pagesSucceeded: githubSearchRun.pagesSucceeded,
        entitiesFound: githubSearchRun.entitiesFound,
        companiesCreated: githubSearchRun.companiesCreated,
        companiesMatched: githubSearchRun.companiesMatched,
        warnings: githubSearchRun.warnings,
      },
      githubVercel: {
        pagesSucceeded: githubOrgRun.pagesSucceeded,
        entitiesFound: githubOrgRun.entitiesFound,
        companiesCreated: githubOrgRun.companiesCreated,
        companiesMatched: githubOrgRun.companiesMatched,
        warnings: githubOrgRun.warnings,
      },
      pypiWebsite: {
        pagesAttempted: pypiRun.pagesAttempted,
        pagesSucceeded: pypiRun.pagesSucceeded,
        pagesFailed: pypiRun.pagesFailed,
        pagesBlocked: pypiRun.pagesBlocked,
        entitiesFound: pypiRun.entitiesFound,
        companiesCreated: pypiRun.companiesCreated,
        warnings: pypiRun.warnings,
      },
      githubSearchRepeat: {
        pagesSucceeded: githubSearchRepeat.pagesSucceeded,
        companiesCreated: githubSearchRepeat.companiesCreated,
        companiesMatched: githubSearchRepeat.companiesMatched,
      },
    };
    report.recordAudit = companies.map((company) => ({
      canonicalDomain: company.canonicalDomain,
      name: company.name,
      website: company.website,
      resolutionState: company.resolutionState,
      observations: company.observations.map((observation) => ({
        sourceProvider: observation.source?.provider ?? null,
        sourceUrl: observation.sourceUrl,
        locator: observation.locator,
        method: observation.method,
        confidence: observation.confidence,
      })),
      classification: company.observations.some(
        (observation) => observation.source?.provider === "public-repository",
      )
        ? "SOURCE_ATTRIBUTED_CANDIDATE_NOT_AUTOMATICALLY_PURSUED"
        : "FIRST_PARTY_FACTS_ONLY_NOT_AUTOMATICALLY_PURSUED",
    }));
    report.counts = {
      persistedCandidates: companies.length,
      completeProvenance: complete.length,
      repositoryObservations: repositoryObservations.length,
      leadsCreated: await db.lead.count({ where: { workspaceId: ws.workspaceId } }),
    };

    expect(githubSearchRun.pagesSucceeded).toBeGreaterThan(0);
    expect(githubOrgRun.pagesSucceeded).toBeGreaterThan(0);
    expect(pypiRun.pagesSucceeded).toBeGreaterThan(0);
    expect(githubSearchRepeat.companiesCreated).toBe(0);
    expect(githubSearchRepeat.companiesMatched).toBeGreaterThan(0);

    // This is the acceptance sample size: actual Company records persisted by
    // the real discovery pipeline, not imaginary prospects from a fixture.
    expect(companies.length).toBeGreaterThanOrEqual(20);
    expect(complete).toHaveLength(companies.length);
    expect(new Set(companies.map((company) => company.canonicalDomain)).size).toBe(
      companies.length,
    );

    // Repository metadata is evidence only for the advertised homepage. A
    // GitHub owner/repository name must not be asserted as ownership of that
    // independent domain, and package registries must remain filtered.
    expect(repositoryObservations.length).toBeGreaterThan(0);
    for (const { company, observation } of repositoryObservations) {
      expect(observation.locator).toBe("repo:homepage");
      expect(observation.sourceUrl).toMatch(/^https:\/\/api\.github\.com\//);
      expect(company.name).toBe(company.canonicalDomain);
      expect(company.canonicalDomain).not.toBe("npmjs.com");
      expect(company.canonicalDomain).not.toBe("pypi.org");
    }

    // Discovery is never consent to create a CRM lead.
    expect(await db.lead.count({ where: { workspaceId: ws.workspaceId } })).toBe(0);
  }, 300_000);

  it("inspects public npm metadata as a third source without misclassifying packages as prospects", async () => {
    const document = await fetcher().fetch(NPM_REGISTRY_URL);

    expect(document.outcome).toBe("SUCCESS");
    expect(typeof document.body).toBe("string");

    const parsed = JSON.parse(document.body!) as {
      objects?: Array<{
        package?: { name?: string; version?: string; date?: string; links?: { npm?: string } };
      }>;
    };
    const packages = (parsed.objects ?? [])
      .map((entry) => entry.package)
      .filter((pkg): pkg is NonNullable<typeof pkg> => typeof pkg?.name === "string")
      .slice(0, 5);

    report.npmRegistryControl = {
      url: NPM_REGISTRY_URL,
      outcome: document.outcome,
      statusCode: document.statusCode ?? null,
      packages: packages.map((pkg) => ({
        name: pkg.name,
        version: pkg.version ?? null,
        npmUrl: pkg.links?.npm ?? null,
      })),
      policy: "INSPECTED_ONLY_NOT_INGESTED_AS_COMPANY_OR_LEAD",
    };

    expect(packages).toHaveLength(5);
    for (const pkg of packages) {
      expect(pkg.name).toBeTruthy();
      expect(pkg.links?.npm).toMatch(/^https:\/\/www\.npmjs\.com\/package\//);
    }
    expect(await db.company.count({ where: { workspaceId: ws.workspaceId } })).toBeGreaterThanOrEqual(20);
    expect(await db.lead.count({ where: { workspaceId: ws.workspaceId } })).toBe(0);
  }, 120_000);
});
