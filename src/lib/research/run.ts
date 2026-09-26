/**
 * Running research for one company.
 *
 * This is the orchestration the RESEARCH_COMPANY job needs: resolve the site,
 * read a handful of the company's own pages through the shared acquisition
 * path, extract facts, write them as observations, refresh signals and
 * opportunities from what was found, and report what actually happened.
 *
 * It runs on the same fetcher stack as the crawl pipeline — caching, retry,
 * robots, throttling, SSRF guard — because those are properties of reading
 * somebody else's website, not of a particular caller. Nothing here bypasses
 * an access control, and a refusal is recorded as an outcome rather than
 * worked around.
 *
 * The job's counters come from this function's own tally of what was fetched
 * and what was stored. That is deliberate: a research job reports pages it
 * read, and signals it created, from its own work — never from a workspace
 * total or a timestamp.
 */

import { CachingFetcher } from "@/lib/discovery/crawl/cache";
import { RetryingFetcher } from "@/lib/discovery/crawl/retry";
import { LoggingFetcher } from "@/lib/discovery/fetch-log";
import { DEFAULT_MIN_INTERVAL_MS, HttpFetcher } from "@/lib/discovery/fetcher";
import type { FetchedDocument, Fetcher } from "@/lib/discovery/provider";
import { serialiseRunCounters, type RunCounters } from "@/lib/discovery/run-counters";
import { db } from "@/lib/db-client";

import { companyOrigin, createWebsiteResearchers } from "./aspects";
import { researchCompany, type AspectResult } from "./runner";

/** What one research pass did, in numbers. */
export interface CompanyResearchPages {
  attempted: number;
  succeeded: number;
  failed: number;
  blocked: number;
}

export interface CompanyResearchOutcome {
  /** False only when the job itself could not be attempted at all. */
  ok: boolean;
  /** One line, safe to store on the job. */
  summary: string;
  /** Set when there was nothing to research, with the reason. */
  skipped?: string;
  counters: RunCounters;
  pages: CompanyResearchPages;
  aspects: AspectResult[];
  origin: string | null;
  signals: { created: number; opportunitiesCreated: number };
}

export interface RunCompanyResearchOptions {
  workspaceId: string;
  companyId: string;
  /** Injected by tests. Application code gets the real stack. */
  fetcher?: Fetcher;
  maxPages?: number;
  now?: Date;
  signal?: AbortSignal;
}

/**
 * Counts what the network actually did.
 *
 * Sits *inside* the cache, so a page served from the run's cache is not
 * counted a second time: the tally is a record of requests made, which is what
 * "pages attempted" should mean when it appears on a run.
 */
class CountingFetcher implements Fetcher {
  readonly pages: CompanyResearchPages = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
  };

  constructor(private readonly inner: Fetcher) {}

  async fetch(url: string, init?: { timeoutMs?: number }): Promise<FetchedDocument> {
    this.pages.attempted += 1;

    const document = await this.inner.fetch(url, init);

    if (document.outcome === "SUCCESS") this.pages.succeeded += 1;
    else if (document.outcome === "BLOCKED") this.pages.blocked += 1;
    else this.pages.failed += 1;

    return document;
  }
}

/**
 * Researches one company end to end.
 *
 * Never throws for an expected outcome: a missing company, a company with no
 * website, a site that refuses access and a site that is down all return a
 * truthful result. The caller decides what a job failure is.
 */
export async function runCompanyResearch(
  options: RunCompanyResearchOptions,
): Promise<CompanyResearchOutcome> {
  const { workspaceId, companyId } = options;
  const now = options.now ?? new Date();

  const empty: CompanyResearchPages = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
  };

  // Workspace-scoped lookup, never a post-hoc check: another workspace's
  // company is invisible here, so it can be neither read nor written.
  const company = await db.company.findFirst({
    where: { id: companyId, workspaceId },
    select: {
      id: true,
      name: true,
      website: true,
      canonicalDomain: true,
      archivedAt: true,
    },
  });

  if (company === null) {
    return {
      ok: true,
      summary: "Company not found in this workspace; nothing to research.",
      skipped: "Company not found",
      counters: {},
      pages: empty,
      aspects: [],
      origin: null,
      signals: { created: 0, opportunitiesCreated: 0 },
    };
  }

  if (company.archivedAt !== null) {
    return {
      ok: true,
      summary: "Company is archived; research skipped.",
      skipped: "Company is archived",
      counters: {},
      pages: empty,
      aspects: [],
      origin: null,
      signals: { created: 0, opportunitiesCreated: 0 },
    };
  }

  const origin = companyOrigin(company);

  if (origin === null) {
    // No address to read. Reporting this plainly is the whole point: the
    // alternative is inventing a website, or pretending research happened.
    return {
      ok: true,
      summary: "No website or canonical domain on record; nothing to read.",
      skipped: "No website on record",
      counters: {},
      pages: empty,
      aspects: [],
      origin: null,
      signals: { created: 0, opportunitiesCreated: 0 },
    };
  }

  // The transport is wrapped in a fetch log for the same reason the crawl
  // pipeline wraps its own: when a listed website cannot be read, "we asked and
  // this is what came back" is evidence, and it is stored against the company's
  // URL with no source id — the research pass is not driven by a source and
  // must not attribute its requests to one. The wrapper sits outside the
  // transport, exactly as in the pipeline, so an injected fetcher is logged the
  // same way the real one is.
  const counting = new CountingFetcher(
    new LoggingFetcher(
      options.fetcher ??
        new RetryingFetcher(new HttpFetcher({ minIntervalMs: DEFAULT_MIN_INTERVAL_MS })),
      workspaceId,
      null,
    ),
  );

  // One cache for the whole pass: five aspects asking for the same homepage
  // cost one request, and the robots decision is made once.
  const fetcher = new CachingFetcher(counting);

  const research = await researchCompany({
    workspaceId,
    companyId,
    fetcher,
    researchers: createWebsiteResearchers({ now: () => now }),
    maxAspects: 6,
    now,
    signal: options.signal,
  });

  if (research.skipped !== undefined) {
    return {
      ok: true,
      summary: `Research skipped: ${research.skipped}.`,
      skipped: research.skipped,
      counters: {},
      pages: counting.pages,
      aspects: [],
      origin,
      signals: { created: 0, opportunitiesCreated: 0 },
    };
  }

  const counters = serialiseRunCounters({
    pagesAttempted: counting.pages.attempted,
    pagesSucceeded: counting.pages.succeeded,
    pagesFailed: counting.pages.failed,
    pagesBlocked: counting.pages.blocked,
    // Only rows this pass created. A signal that was already known is
    // refreshed by the store, and a refresh is not a discovery.
    signalsDiscovered: research.signals?.signalsCreated ?? 0,
    opportunitiesDiscovered: research.signals?.opportunitiesCreated ?? 0,
  });

  return {
    ok: true,
    summary: describeResearch(origin, counting.pages, research.results, research.signals),
    counters,
    pages: counting.pages,
    aspects: research.results,
    origin,
    signals: {
      created: research.signals?.signalsCreated ?? 0,
      opportunitiesCreated: research.signals?.opportunitiesCreated ?? 0,
    },
  };
}

/** A sentence a human can read in the job list. */
function describeResearch(
  origin: string,
  pages: CompanyResearchPages,
  aspects: readonly AspectResult[],
  signals: { signalsCreated: number; opportunitiesCreated: number } | undefined,
): string {
  const researched = aspects.filter((aspect) => aspect.status !== "NEEDS_REVIEW").length;
  const blocked = aspects.filter((aspect) => aspect.status === "BLOCKED").length;
  const parts = [
    `${researched}/${aspects.length} aspects researched`,
    `${pages.succeeded}/${pages.attempted} pages read from ${origin}`,
  ];

  if (blocked > 0) parts.push(`${blocked} refused`);
  if (pages.blocked > 0) parts.push(`${pages.blocked} pages blocked`);
  if (signals !== undefined && signals.signalsCreated > 0) {
    parts.push(`${signals.signalsCreated} new signals`);
  }
  if (signals !== undefined && signals.opportunitiesCreated > 0) {
    parts.push(`${signals.opportunitiesCreated} new opportunities`);
  }

  return `${parts.join("; ")}.`;
}
