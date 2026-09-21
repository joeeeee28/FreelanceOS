import type {
  DiscoveryContext,
  DiscoveryProvider,
  DiscoveryResult,
} from "../provider";
import { emptyResult } from "../provider";
import { extractFacts, extractSitemapUrls, isSitemapIndex } from "../extract";
import { canonicalDomain } from "../canonical";
import type { DiscoveredEntity } from "../ingest";

/**
 * Website provider.
 *
 * Given a business's own website, reads what the site publishes about itself.
 * It follows the layered priority the spec requires: try the structured,
 * cheap, explicitly-published sources first, and only fall back to parsing
 * pages when those are unavailable.
 *
 *   1. /robots.txt for declared sitemaps (handled by the fetcher)
 *   2. /sitemap.xml to find contact/about pages
 *   3. the homepage and a small number of likely contact pages
 *
 * It never crawls a whole site: a handful of pages carry essentially all the
 * identifying information, and more requests would be a cost to the site owner
 * with no benefit.
 */

/** Paths most likely to carry contact details, in priority order. */
const CANDIDATE_PATHS = [
  "/contact",
  "/contact-us",
  "/about",
  "/about-us",
] as const;

/** Sitemap entries matching these are worth reading. */
const INTERESTING = /(contact|about|impressum|legal|team)/i;

export const DEFAULT_MAX_PAGES = 5;

export interface WebsiteProviderConfig {
  /** Sites to inspect. */
  urls?: string[];
  maxPages?: number;
}

export const websiteProvider: DiscoveryProvider = {
  key: "website",
  label: "Business website",
  category: "WEBSITE",
  requiresNetwork: true,
  description:
    "Reads what a business publishes about itself on its own site, guided by its sitemap.",

  async run(context: DiscoveryContext): Promise<DiscoveryResult> {
    const config = context.config as WebsiteProviderConfig;
    const urls = Array.isArray(config.urls) ? config.urls : [];
    const maxPages = Math.max(1, config.maxPages ?? DEFAULT_MAX_PAGES);

    const result = emptyResult();

    for (const target of urls) {
      if (context.signal?.aborted) break;

      const entity = await inspectSite(context, target, maxPages, result);
      if (entity !== null) result.entities.push(entity);
    }

    return result;
  },
};

async function inspectSite(
  context: DiscoveryContext,
  target: string,
  maxPages: number,
  result: DiscoveryResult,
): Promise<DiscoveredEntity | null> {
  const trimmed = typeof target === "string" ? target.trim() : "";
  if (trimmed === "") {
    result.warnings.push("Skipped empty URL");
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    result.warnings.push(`Skipped unparseable URL: ${target}`);
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    result.warnings.push(`Skipped non-web URL: ${target}`);
    return null;
  }

  const origin = parsed.origin;

  // May be null for an IP-addressed or single-label host. That is not fatal:
  // the site can still publish a usable name, and entity resolution accepts
  // either a name or a domain. Dropping the site here would discard real data.
  const domain = canonicalDomain(origin);

  const pages = await selectPages(context, origin, maxPages, result);
  const facts: DiscoveredEntity["facts"] = [];

  for (const page of pages) {
    if (context.signal?.aborted) break;

    result.pagesAttempted += 1;
    const document = await context.fetcher.fetch(page);

    if (document.outcome === "BLOCKED") {
      // Recorded and skipped. One blocked page must not stop the run.
      result.pagesBlocked += 1;
      result.warnings.push(`Blocked: ${page}`);
      continue;
    }

    if (document.outcome !== "SUCCESS" || typeof document.body !== "string") {
      result.pagesFailed += 1;
      continue;
    }

    result.pagesSucceeded += 1;
    facts.push(...extractFacts({ url: document.url, html: document.body }));
  }

  if (facts.length === 0) return null;

  // Keep the strongest claim per field across all pages.
  const best = new Map<string, DiscoveredEntity["facts"][number]>();
  for (const fact of facts) {
    const held = best.get(fact.field);
    if (held === undefined) {
      best.set(fact.field, fact);
      continue;
    }
    if (methodRank(fact.method) > methodRank(held.method)) {
      best.set(fact.field, fact);
    }
  }

  const deduped = [...best.values()];
  const name = deduped.find((f) => f.field === "name")?.value ?? null;

  return {
    identity: {
      name,
      website: origin,
      domain,
      email: deduped.find((f) => f.field === "email")?.value ?? null,
      phone: deduped.find((f) => f.field === "phone")?.value ?? null,
      country: deduped.find((f) => f.field === "country")?.value ?? null,
      city: deduped.find((f) => f.field === "city")?.value ?? null,
    },
    facts: deduped,
    sourceId: context.sourceId,
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

function methodRank(method: string): number {
  return METHOD_RANK[method] ?? 0;
}

/**
 * Chooses which pages to fetch.
 *
 * Prefers URLs the site itself advertises in its sitemap; falls back to
 * conventional paths when there is no sitemap.
 */
async function selectPages(
  context: DiscoveryContext,
  origin: string,
  maxPages: number,
  result: DiscoveryResult,
): Promise<string[]> {
  const pages = [origin];

  result.pagesAttempted += 1;
  const sitemap = await context.fetcher.fetch(`${origin}/sitemap.xml`);

  if (sitemap.outcome === "SUCCESS" && typeof sitemap.body === "string") {
    result.pagesSucceeded += 1;

    // A sitemap index points at more sitemaps; read only the first to keep
    // the request budget small.
    let body = sitemap.body;
    if (isSitemapIndex(body)) {
      const first = extractSitemapUrls(body)[0];
      if (first !== undefined) {
        result.pagesAttempted += 1;
        const nested = await context.fetcher.fetch(first);
        if (nested.outcome === "SUCCESS" && typeof nested.body === "string") {
          result.pagesSucceeded += 1;
          body = nested.body;
        } else {
          result.pagesFailed += 1;
          body = "";
        }
      }
    }

    for (const url of extractSitemapUrls(body)) {
      if (pages.length >= maxPages) break;
      if (INTERESTING.test(url) && !pages.includes(url)) pages.push(url);
    }
  } else if (sitemap.outcome === "BLOCKED") {
    result.pagesBlocked += 1;
  } else {
    result.pagesFailed += 1;
  }

  // Fall back to conventional paths if the sitemap gave us nothing.
  if (pages.length === 1) {
    for (const path of CANDIDATE_PATHS) {
      if (pages.length >= maxPages) break;
      pages.push(`${origin}${path}`);
    }
  }

  return pages.slice(0, maxPages);
}
