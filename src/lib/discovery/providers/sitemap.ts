import type {
  DiscoveryContext,
  DiscoveryProvider,
  DiscoveryResult,
} from "../provider";
import { emptyResult } from "../provider";
import { extractSitemapUrls, isSitemapIndex } from "../extract";
import { canonicalDomain, entityKey } from "../canonical";
import type { DiscoveredEntity } from "../ingest";

/**
 * Sitemap provider.
 *
 * Reads a sitemap (or sitemap index) and treats each distinct host it
 * advertises as a candidate business. Useful for directory-style sites that
 * publish their member list as a sitemap.
 *
 * It does NOT fetch the listed pages — that is the website provider's job.
 * This provider only turns a sitemap into a list of candidate domains, which
 * keeps the request cost of a large sitemap at exactly one page.
 */

export const DEFAULT_MAX_ENTRIES = 500;

export interface SitemapProviderConfig {
  /** Sitemap URLs to read. */
  urls?: string[];
  /** Cap on entries considered from one sitemap. */
  maxEntries?: number;
  /**
   * When true, only hosts different from the sitemap's own host are treated as
   * businesses. That is the directory case.
   */
  externalHostsOnly?: boolean;
}

export const sitemapProvider: DiscoveryProvider = {
  key: "sitemap",
  label: "Sitemap",
  category: "SITEMAP",
  requiresNetwork: true,
  description:
    "Reads a sitemap or sitemap index and treats the hosts it lists as candidate businesses.",

  async run(context: DiscoveryContext): Promise<DiscoveryResult> {
    const config = context.config as SitemapProviderConfig;
    const urls = Array.isArray(config.urls) ? config.urls : [];
    const maxEntries = Math.max(1, config.maxEntries ?? DEFAULT_MAX_ENTRIES);
    const externalOnly = config.externalHostsOnly === true;

    const result = emptyResult();
    const seenDomains = new Set<string>();

    for (const sitemapUrl of urls) {
      if (context.signal?.aborted) break;

      const ownDomain = canonicalDomain(sitemapUrl);
      const ownKey = entityKey(sitemapUrl);
      const locations = await readSitemap(context, sitemapUrl, maxEntries, result);

      for (const location of locations) {
        // Key on the registrable domain where there is one, otherwise the
        // origin, so IP-hosted sites are deduplicated rather than discarded.
        const key = entityKey(location);
        if (key === null) continue;

        const domain = canonicalDomain(location);
        if (externalOnly && key === (ownKey ?? ownDomain)) continue;
        if (seenDomains.has(key)) continue;

        seenDomains.add(key);

        let origin: string;
        try {
          origin = new URL(location).origin;
        } catch {
          continue;
        }

        const entity: DiscoveredEntity = {
          identity: { name: null, website: origin, domain },
          facts: [
            {
              field: "website",
              value: origin,
              // A sitemap is a machine-readable statement by the publisher,
              // but it asserts a URL, not a business, so it ranks below
              // structured data about the company itself.
              method: "SITEMAP",
              sourceUrl: sitemapUrl,
              locator: "sitemap:loc",
              evidence: `Listed in ${sitemapUrl}`,
            },
          ],
          sourceId: context.sourceId,
        };

        result.entities.push(entity);
      }
    }

    return result;
  },
};

/** Fetches one sitemap, following an index one level deep. */
async function readSitemap(
  context: DiscoveryContext,
  url: string,
  maxEntries: number,
  result: DiscoveryResult,
): Promise<string[]> {
  result.pagesAttempted += 1;
  const document = await context.fetcher.fetch(url);

  if (document.outcome === "BLOCKED") {
    result.pagesBlocked += 1;
    result.warnings.push(`Blocked: ${url}`);
    return [];
  }

  if (document.outcome !== "SUCCESS" || typeof document.body !== "string") {
    result.pagesFailed += 1;
    result.warnings.push(`Could not read sitemap: ${url} (${document.outcome})`);
    return [];
  }

  result.pagesSucceeded += 1;

  if (!isSitemapIndex(document.body)) {
    return extractSitemapUrls(document.body).slice(0, maxEntries);
  }

  // A sitemap index: read the child sitemaps, bounded so a huge index cannot
  // turn into thousands of requests.
  const children = extractSitemapUrls(document.body).slice(0, 5);
  const locations: string[] = [];

  for (const child of children) {
    if (context.signal?.aborted) break;
    if (locations.length >= maxEntries) break;

    result.pagesAttempted += 1;
    const nested = await context.fetcher.fetch(child);

    if (nested.outcome === "BLOCKED") {
      result.pagesBlocked += 1;
      continue;
    }
    if (nested.outcome !== "SUCCESS" || typeof nested.body !== "string") {
      result.pagesFailed += 1;
      continue;
    }

    result.pagesSucceeded += 1;
    locations.push(...extractSitemapUrls(nested.body));
  }

  return locations.slice(0, maxEntries);
}
