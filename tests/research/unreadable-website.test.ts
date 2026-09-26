/**
 * A website that is listed but cannot be read.
 *
 * The honest outcome of asking and getting nothing back is "unreadable, try
 * again next cycle" — not a fabricated fact, and not a signal. This file holds
 * the engine to that in three places at once:
 *
 *   - the aspect is recorded NEEDS_REVIEW with no freshness window, so the next
 *     cycle retries rather than writing the company off for a fortnight;
 *   - no signal and no opportunity are produced, because the rules that speak
 *     about a site's quality are fed by pages that were actually read;
 *   - the attempt itself is recorded as a fetch outcome against the company's
 *     own URL, so "we asked" is evidence rather than an assumption.
 *
 * The fetcher is injected, so nothing here touches the network and the SSRF
 * guard runs unmodified.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { FetchedDocument, Fetcher } from "@/lib/discovery/provider";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";

const { runCompanyResearch } = await import("@/lib/research/run");

let alice: SeededWorkspace;

const NOW = new Date("2026-09-22T12:00:00Z");
const SITE = "https://quietdental.test";

/** A transport that accepts the request and never returns a usable page. */
function failing(outcome: FetchedDocument["outcome"], error: string): Fetcher {
  return {
    async fetch(url: string): Promise<FetchedDocument> {
      return { url, outcome, error, durationMs: 5 };
    },
  };
}

async function makeCompany(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
  return db.company.create({
    data: {
      workspaceId: alice.workspaceId,
      name: "Quiet Dental",
      canonicalName: "quiet dental",
      canonicalDomain: "quietdental.test",
      website: SITE,
      ...overrides,
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  await resetTestDatabase();
});

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("alice");
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("a listed website that never answers", () => {
  it("records the attempt as a fetch outcome against the company's own URL", async () => {
    const company = await makeCompany();

    await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: failing("TIMEOUT", "request timed out"),
      now: NOW,
    });

    const logs = await db.fetchLog.findMany({ where: { workspaceId: alice.workspaceId } });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((row) => row.outcome === "TIMEOUT")).toBe(true);
    expect(logs[0].url.startsWith(SITE)).toBe(true);
    // Not attributed to a source: nothing configured drives a research pass.
    expect(logs[0].sourceId).toBeNull();
  });

  it("leaves the company needing review rather than writing it off", async () => {
    const company = await makeCompany();

    await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: failing("TIMEOUT", "request timed out"),
      now: NOW,
    });

    const stored = await db.company.findUniqueOrThrow({ where: { id: company.id } });

    expect(stored.researchStatus).toBe("NEEDS_REVIEW");

    const runs = await db.researchRun.findMany({ where: { companyId: company.id } });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.status === "NEEDS_REVIEW")).toBe(true);
    // No freshness window means the next cycle tries again.
    expect(runs.every((run) => run.freshUntil === null)).toBe(true);
  });

  it("invents no signal and no opportunity from a page that was never read", async () => {
    const company = await makeCompany();

    await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: failing("SERVER_ERROR", "503 from origin"),
      now: NOW,
    });

    expect(await db.signal.count({ where: { companyId: company.id } })).toBe(0);
    expect(await db.opportunity.count({ where: { companyId: company.id } })).toBe(0);

    const stored = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    // An unreadable site is not evidence of a missing website.
    expect(stored.website).toBe(SITE);
  });

  it("reports counters that match what it actually did", async () => {
    const company = await makeCompany();

    const result = await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: failing("NETWORK_ERROR", "connection refused"),
      now: NOW,
    });

    expect(result.pages.succeeded).toBe(0);
    expect(result.pages.attempted).toBeGreaterThan(0);
    // Nothing was discovered, so nothing is claimed to have been.
    expect(result.counters.signalsDiscovered ?? 0).toBe(0);
    expect(result.counters.opportunitiesDiscovered ?? 0).toBe(0);
    expect(result.counters.leadsCreated ?? 0).toBe(0);
    expect(result.counters.contactsDiscovered ?? 0).toBe(0);
    expect(await db.observation.count({ where: { companyId: company.id } })).toBe(0);
  });

  it("separates a refusal from a silence", async () => {
    const company = await makeCompany({
      name: "Refusing Dental",
      canonicalName: "refusing dental",
      canonicalDomain: "refusingdental.test",
      website: "https://refusingdental.test",
    });

    await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      fetcher: failing("BLOCKED", "robots.txt disallows this agent"),
      now: NOW,
    });

    const stored = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(stored.researchStatus).toBe("BLOCKED");

    const log = await db.fetchLog.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId, outcome: "BLOCKED" },
    });
    expect(log.sourceId).toBeNull();
  });

  it("does not let one unreadable company disturb another", async () => {
    const broken = await makeCompany();
    const other = await makeCompany({
      name: "Bright Dental",
      canonicalName: "bright dental",
      canonicalDomain: "brightdental.test",
      website: "https://brightdental.test",
    });

    await runCompanyResearch({
      workspaceId: alice.workspaceId,
      companyId: broken.id,
      fetcher: failing("TIMEOUT", "request timed out"),
      now: NOW,
    });

    const untouched = await db.company.findUniqueOrThrow({ where: { id: other.id } });
    expect(untouched.researchStatus).toBe("NEVER");
    expect(untouched.lastResearchAt).toBeNull();
  });
});
