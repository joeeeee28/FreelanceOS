/**
 * Aspect researchers: what company research actually looks at.
 *
 * Each researcher answers one question about a company from its own published
 * pages, and returns only what it saw, with the evidence attached. Nothing here
 * guesses: an aspect that finds nothing returns nothing, and an aspect that
 * cannot read the site says so instead of inventing a value.
 *
 * Page acquisition goes through `collectSitePages` — the same sitemap-guided,
 * cross-site-refusing, robots-respecting path the website provider uses. The
 * orchestrator hands every researcher one caching fetcher, so the site is read
 * once per research pass no matter how many aspects ask for it.
 *
 * Aspects with no researcher here are simply not investigated by this build
 * (hiring boards, ad libraries, technology fingerprinting). They stay
 * "never researched" rather than being marked done with nothing behind them.
 */

import { siteUrl, type CollectedPage, type SiteCollection } from "@/lib/discovery/providers/website";
import { collectSitePages } from "@/lib/discovery/providers/website";
import { extractFacts } from "@/lib/discovery/extract";
import type { ObservableField, ObservedFact } from "@/lib/discovery/ingest";
import type { PageSignals } from "@/lib/discovery/signals/rules";

import type { AspectFindings, AspectResearcher } from "./runner";
import { mergePageSignals, pageSignalsFrom } from "./page-signals";

/**
 * Aspects this build can actually investigate.
 *
 * Mirrors the Prisma `ResearchAspect` names as a string union rather than
 * importing the generated enum: this module must type-check in an environment
 * where the Prisma client has not been generated (see docs/P15-VALIDATION-REPORT).
 */
export type ResearchedAspect =
  | "WEBSITE"
  | "COMPANY_INFO"
  | "GEOGRAPHY"
  | "PUBLIC_CONTACTS"
  | "MARKETING";

/**
 * The aspects this build registers a researcher for.
 *
 * The single source of truth for coverage. `createWebsiteResearchers` builds
 * its registry by iterating this list, so the list and the registry cannot
 * disagree, and the aggregate research status can tell "not researched yet"
 * apart from "not implementable by this build".
 *
 * The remaining aspects of the Prisma enum — hiring boards, ad libraries,
 * technology fingerprinting, decision makers, industry, service opportunities
 * and content — have no researcher here. They are not stubbed with an empty
 * implementation: an aspect with nothing behind it stays "never researched"
 * rather than being marked done.
 */
export const SUPPORTED_ASPECTS = [
  "WEBSITE",
  "COMPANY_INFO",
  "GEOGRAPHY",
  "PUBLIC_CONTACTS",
  "MARKETING",
] as const satisfies readonly ResearchedAspect[];

/** Which fields each aspect is allowed to report. */
const ASPECT_FIELDS: Readonly<Record<ResearchedAspect, readonly ObservableField[]>> = {
  // The site itself, and what language it publishes in.
  WEBSITE: ["website", "language"],
  // What the business says it is.
  COMPANY_INFO: ["name", "description"],
  // Where it is, as published on its own contact or legal pages.
  GEOGRAPHY: ["country", "region", "city"],
  // Published ways to reach it.
  PUBLIC_CONTACTS: ["email", "phone"],
  // Public profiles it links to itself.
  MARKETING: ["linkedinUrl", "instagramUrl", "facebookUrl", "youtubeUrl"],
};

/** How many pages each aspect is willing to have read for it. */
const ASPECT_MAX_PAGES: Readonly<Record<ResearchedAspect, number>> = {
  // The homepage carries these.
  WEBSITE: 1,
  MARKETING: 1,
  // Contact details and addresses live on the information pages.
  COMPANY_INFO: 4,
  GEOGRAPHY: 4,
  PUBLIC_CONTACTS: 4,
};

/**
 * The origin to read, from what the record already holds.
 *
 * `canonicalDomain` first: it is the key entity resolution matched on, so it is
 * the address other records agree with. `website` is the fallback for records
 * that predate resolution.
 */
export function companyOrigin(company: {
  website: string | null;
  canonicalDomain: string | null;
}): string | null {
  const raw = company.canonicalDomain ?? company.website;
  if (raw === null || raw.trim() === "") return null;

  const trimmed = raw.trim();

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

type CollectionVerdict =
  | { kind: "BLOCKED" }
  | { kind: "UNREACHABLE" }
  | { kind: "READ"; partial: boolean; signals: PageSignals };

/**
 * Reads the tally of a page pass for what it means.
 *
 * All-blocked is a refusal and is reported as one. Nothing readable at all is
 * a failure worth retrying, which the runner records as NEEDS_REVIEW with no
 * freshness window — so the next cycle tries again rather than waiting a
 * fortnight. A partial read is still evidence, and says so.
 */
function judge(collection: SiteCollection, now: Date): CollectionVerdict {
  if (collection.pagesAttempted > 0 && collection.pagesBlocked === collection.pagesAttempted) {
    return { kind: "BLOCKED" };
  }

  if (collection.pagesSucceeded === 0) {
    return { kind: "UNREACHABLE" };
  }

  let signals: PageSignals = {};
  for (const page of collection.pages) {
    signals = mergePageSignals(
      signals,
      pageSignalsFrom(
        { url: page.document.url, outcome: page.document.outcome, html: page.document.body },
        now,
      ),
    );
  }

  return {
    kind: "READ",
    partial: collection.pagesFailed > 0 || collection.pagesBlocked > 0,
    signals,
  };
}

const METHOD_RANK: Record<string, number> = {
  MANUAL: 9,
  STRUCTURED_DATA: 8,
  HTTP_HEADER: 7,
  SITEMAP: 6,
  FEED: 5,
  META_TAG: 4,
  HTML_SELECTOR: 3,
  TEXT_HEURISTIC: 2,
  INFERRED: 1,
};

/**
 * The strongest claim per field, across everything that was read.
 *
 * Same rule as the website provider: a value published as structured data
 * beats one scraped out of markup, and a weaker claim never displaces it.
 */
export function bestFactsPerField(pages: readonly CollectedPage[]): ObservedFact[] {
  const best = new Map<string, ObservedFact>();

  for (const page of pages) {
    if (typeof page.document.body !== "string") continue;

    for (const fact of extractFacts({ url: page.document.url, html: page.document.body })) {
      const held = best.get(fact.field);

      if (held === undefined) {
        best.set(fact.field, fact);
        continue;
      }

      const incomingRank = METHOD_RANK[fact.method] ?? 0;
      const heldRank = METHOD_RANK[held.method] ?? 0;

      if (incomingRank > heldRank) best.set(fact.field, fact);
    }
  }

  return [...best.values()];
}

/** Builds one researcher for an aspect. */
function researcherFor(
  aspect: ResearchedAspect,
  now: () => Date,
): AspectResearcher {
  const allowed = new Set<string>(ASPECT_FIELDS[aspect]);
  const maxPages = ASPECT_MAX_PAGES[aspect];

  return async ({ company, fetcher, signal }): Promise<AspectFindings> => {
    const origin = companyOrigin(company);

    // Nothing to read. Not a failure — a record can legitimately have no
    // website, and the WEBSITE_MISSING rule is the thing that should speak to
    // that, not a fabricated fetch.
    if (origin === null) {
      return { facts: [], sourceUrl: null, partial: false };
    }

    const collection = await collectSitePages({
      origin,
      fetcher,
      maxPages,
      signal,
    });

    const verdict = judge(collection, now());

    if (verdict.kind === "BLOCKED") {
      return { facts: [], sourceUrl: origin, blocked: true };
    }

    if (verdict.kind === "UNREACHABLE") {
      // Thrown, not returned: the runner records NEEDS_REVIEW with no
      // freshness window, so a site that was briefly down is retried on the
      // next cycle instead of being written off for a fortnight.
      throw new Error(`No page could be read from ${origin}`);
    }

    const facts = bestFactsPerField(collection.pages).filter((fact) =>
      allowed.has(fact.field),
    );

    // Drop facts that came from a different host: a same-site fetch can still
    // be redirected to a CDN or login page, and its data is not the company's.
    const sameSite = facts.filter((fact) => {
      if (typeof fact.sourceUrl !== "string") return true;
      return siteUrl(fact.sourceUrl, origin) !== null;
    });

    return {
      facts: sameSite,
      sourceUrl: sameSite[0]?.sourceUrl ?? origin,
      partial: verdict.partial,
      pageSignals: verdict.signals,
    };
  };
}

/**
 * The researchers this build registers.
 *
 * Returned as a fresh object per call so two research passes cannot share
 * mutable state, and keyed by aspect name for the runner's planner.
 */
export function createWebsiteResearchers(
  options: { now?: () => Date } = {},
): Partial<Record<ResearchedAspect, AspectResearcher>> {
  const now = options.now ?? (() => new Date());

  const researchers: Partial<Record<ResearchedAspect, AspectResearcher>> = {};

  for (const aspect of SUPPORTED_ASPECTS) {
    researchers[aspect] = researcherFor(aspect, now);
  }

  return researchers;
}
