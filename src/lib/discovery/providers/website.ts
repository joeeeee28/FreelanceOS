import type {
  DiscoveryContext,
  DiscoveryProvider,
  DiscoveryResult,
  FetchedDocument,
  Fetcher,
} from "../provider";
import { emptyResult } from "../provider";
import { extractFacts, extractSitemapUrls, isSitemapIndex } from "../extract";
import { canonicalDomain } from "../canonical";
import type { DiscoveredEntity } from "../ingest";

/**
 * Website reading.
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
 *
 * The page-acquisition half (`collectSitePages`) is exported because company
 * research needs exactly the same behaviour — same sitemap guidance, same
 * cross-site refusal, same access-control handling, same politeness. Two
 * implementations of "fetch a company's own pages" would eventually disagree
 * about what may be read, and that disagreement would be a privacy bug.
 */

/** Paths most likely to carry contact details, in priority order. */
const CANDIDATE_PATHS = [
  "/contact",
  "/contact-us",
  "/about",
  "/about-us",
] as const;

/**
 * Only top-level information pages are relevant to the owner of the site we
 * were asked to inspect. Matching a word anywhere in a sitemap URL is unsafe:
 * a marketplace can contain a third-party product named "contact" or "legal",
 * and its details must never become facts about the marketplace itself.
 */
const INFORMATION_PAGE_PATH =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:contact(?:-us)?|about(?:-us)?|impressum|legal|team)(?:\/|$)/i;

export const DEFAULT_MAX_PAGES = 5;

/**
 * Returns a URL only when it still belongs to the target business website.
 *
 * A registrable-domain comparison is too broad for this purpose: unrelated
 * tenants can share a public-suffix host (for example, on hosted platforms).
 * We accept the exact host and only the conventional www/non-www equivalent.
 * Protocol changes are allowed, but an explicitly supplied non-default port
 * must remain unchanged.
 */
export function siteUrl(raw: string, origin: string): URL | null {
  let candidate: URL;
  let target: URL;

  try {
    candidate = new URL(raw, origin);
    target = new URL(origin);
  } catch {
    return null;
  }

  const candidateHost = candidate.hostname.toLowerCase().replace(/\.$/, "");
  const targetHost = target.hostname.toLowerCase().replace(/\.$/, "");
  const sameHost =
    candidateHost === targetHost ||
    candidateHost === `www.${targetHost}` ||
    targetHost === `www.${candidateHost}`;

  if (!sameHost || candidate.port !== target.port) return null;

  return candidate;
}

function isInformationPage(url: URL): boolean {
  return INFORMATION_PAGE_PATH.test(url.pathname);
}

/** Honest tallies of what a page-acquisition pass actually did. */
export interface SiteTally {
  pagesAttempted: number;
  pagesSucceeded: number;
  pagesFailed: number;
  pagesBlocked: number;
  warnings: string[];
}

/** A page that was fetched successfully and still belongs to the site. */
export interface CollectedPage {
  url: string;
  document: FetchedDocument;
}

export interface SiteCollection extends SiteTally {
  pages: CollectedPage[];
}

export interface CollectSitePagesOptions {
  /** The site to read, as an origin such as `https://example.com`. */
  origin: string;
  fetcher: Fetcher;
  maxPages?: number;
  signal?: AbortSignal;
}

/**
 * Fetches the pages a business publishes about itself.
 *
 * Everything it returns is evidence: a page in `pages` was served by the site
 * itself and survived the same-site check. Blocked pages are counted and
 * named, never worked around — a refusal is an answer.
 */
export async function collectSitePages(
  options: CollectSitePagesOptions,
): Promise<SiteCollection> {
  const { origin, fetcher, signal } = options;
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);

  const collection: SiteCollection = {
    pages: [],
    pagesAttempted: 0,
    pagesSucceeded: 0,
    pagesFailed: 0,
    pagesBlocked: 0,
    warnings: [],
  };

  const pages = await selectPages(fetcher, origin, maxPages, collection, signal);

  for (const page of pages) {
    if (signal?.aborted === true) break;

    collection.pagesAttempted += 1;
    const document = await fetcher.fetch(page);

    if (document.outcome === "BLOCKED") {
      // Recorded and skipped. One blocked page must not stop the run.
      collection.pagesBlocked += 1;
      collection.warnings.push(`Blocked: ${page}`);
      continue;
    }

    if (document.outcome !== "SUCCESS" || typeof document.body !== "string") {
      collection.pagesFailed += 1;
      continue;
    }

    collection.pagesSucceeded += 1;

    // A same-site URL may redirect to a third-party login, checkout or CDN.
    // Reading it would attribute the third party's contact details to the
    // requested business, so retain the fetch log but reject it as evidence.
    if (siteUrl(document.url, origin) === null) {
      collection.warnings.push(`Skipped cross-site response while inspecting ${page}`);
      continue;
    }

    collection.pages.push({ url: document.url, document });
  }

  return collection;
}

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

  const collection = await collectSitePages({
    origin,
    fetcher: context.fetcher,
    maxPages,
    signal: context.signal,
  });

  result.pagesAttempted += collection.pagesAttempted;
  result.pagesSucceeded += collection.pagesSucceeded;
  result.pagesFailed += collection.pagesFailed;
  result.pagesBlocked += collection.pagesBlocked;
  result.warnings.push(...collection.warnings);

  const facts: DiscoveredEntity["facts"] = [];
  for (const page of collection.pages) {
    facts.push(
      ...extractFacts({ url: page.document.url, html: page.document.body ?? "" }),
    );
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
  fetcher: Fetcher,
  origin: string,
  maxPages: number,
  tally: SiteTally,
  signal?: AbortSignal,
): Promise<string[]> {
  const pages = [origin];

  tally.pagesAttempted += 1;
  const sitemap = await fetcher.fetch(`${origin}/sitemap.xml`);

  if (sitemap.outcome === "SUCCESS" && typeof sitemap.body === "string") {
    tally.pagesSucceeded += 1;

    // A sitemap index points at more sitemaps; read only the first to keep
    // the request budget small.
    let body = sitemap.body;
    if (isSitemapIndex(body)) {
      const first = extractSitemapUrls(body)[0];
      const nestedUrl = first === undefined ? null : siteUrl(first, origin);

      if (first !== undefined && nestedUrl === null) {
        tally.warnings.push("Skipped cross-site sitemap index entry");
        body = "";
      } else if (nestedUrl !== null) {
        tally.pagesAttempted += 1;
        const nested = await fetcher.fetch(nestedUrl.toString());
        if (nested.outcome === "SUCCESS" && typeof nested.body === "string") {
          tally.pagesSucceeded += 1;
          body = nested.body;
        } else {
          tally.pagesFailed += 1;
          body = "";
        }
      }
    }

    for (const rawUrl of extractSitemapUrls(body)) {
      if (pages.length >= maxPages) break;

      const candidate = siteUrl(rawUrl, origin);
      if (
        candidate !== null &&
        isInformationPage(candidate) &&
        !pages.includes(candidate.toString())
      ) {
        pages.push(candidate.toString());
      }
    }
  } else if (sitemap.outcome === "BLOCKED") {
    tally.pagesBlocked += 1;
  } else {
    tally.pagesFailed += 1;
  }

  // Fall back to conventional paths if the sitemap gave us nothing.
  if (pages.length === 1) {
    for (const path of CANDIDATE_PATHS) {
      if (pages.length >= maxPages) break;
      pages.push(`${origin}${path}`);
    }
  }

  // The signal is checked once more here because a slow sitemap fetch is the
  // most likely moment for a stop request to arrive.
  if (signal?.aborted === true) return pages.slice(0, 1);

  return pages.slice(0, maxPages);
}
