import type {
  DiscoveryContext,
  DiscoveryProvider,
  DiscoveryResult,
} from "../provider";
import { emptyResult } from "../provider";
import { parseFeed } from "../feed";
import { canonicalDomain, entityKey } from "../canonical";
import type { DiscoveredEntity } from "../ingest";

/**
 * RSS/Atom feed provider.
 *
 * Feeds are the cheapest, most explicitly-published source there is: one
 * request returns structured, dated, attributed entries. This provider treats
 * the hosts linked from a feed as candidate businesses.
 *
 * Typical uses: a local business-news feed, an industry directory's "new
 * members" feed, a "recently funded" feed.
 */

export interface FeedProviderConfig {
  urls?: string[];
  /** Ignore entries older than this. Null means no limit. */
  maxAgeDays?: number | null;
  /** Only consider hosts other than the feed's own. */
  externalHostsOnly?: boolean;
}

export const DEFAULT_MAX_AGE_DAYS = 90;

export const feedProvider: DiscoveryProvider = {
  key: "feed",
  label: "RSS / Atom feed",
  category: "FEED",
  requiresNetwork: true,
  description:
    "Reads an RSS or Atom feed and treats the businesses it links to as candidates.",

  async run(context: DiscoveryContext): Promise<DiscoveryResult> {
    const config = context.config as FeedProviderConfig;
    const urls = Array.isArray(config.urls) ? config.urls : [];
    const maxAgeDays =
      config.maxAgeDays === null ? null : (config.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS);
    const externalOnly = config.externalHostsOnly !== false;

    const result = emptyResult();
    const seen = new Set<string>();

    const cutoff =
      maxAgeDays === null
        ? null
        : new Date(context.now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);

    for (const feedUrl of urls) {
      if (context.signal?.aborted) break;

      result.pagesAttempted += 1;
      const document = await context.fetcher.fetch(feedUrl);

      if (document.outcome === "BLOCKED") {
        result.pagesBlocked += 1;
        result.warnings.push(`Blocked: ${feedUrl}`);
        continue;
      }

      if (document.outcome !== "SUCCESS" || typeof document.body !== "string") {
        result.pagesFailed += 1;
        result.warnings.push(`Could not read feed: ${feedUrl} (${document.outcome})`);
        continue;
      }

      result.pagesSucceeded += 1;

      const feed = parseFeed(document.body);
      const feedKey = entityKey(feedUrl);

      for (const item of feed.items) {
        if (item.link === null) continue;

        // An entry with no date is kept: absence of a date is not evidence of
        // being old. Only a date we can read and that is too old is skipped.
        if (cutoff !== null && item.publishedAt !== null && item.publishedAt < cutoff) {
          continue;
        }

        const key = entityKey(item.link);
        if (key === null) continue;

        const domain = canonicalDomain(item.link);
        if (externalOnly && key === feedKey) continue;
        if (seen.has(key)) continue;

        seen.add(key);

        let origin: string;
        try {
          origin = new URL(item.link).origin;
        } catch {
          continue;
        }

        const entity: DiscoveredEntity = {
          identity: { name: item.title, website: origin, domain },
          facts: [
            {
              field: "website",
              value: origin,
              method: "FEED",
              sourceUrl: feedUrl,
              locator: "feed:link",
              evidence: item.title ?? `Linked from ${feedUrl}`,
              observedAt: item.publishedAt ?? context.now,
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
