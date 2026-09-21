/**
 * Request-level caching and coalescing.
 *
 * Two different savings, often confused:
 *
 *   - caching returns a document already fetched in this run
 *   - coalescing makes N simultaneous requests for one URL share a single
 *     fetch, rather than racing and fetching N times
 *
 * The second matters more during a concurrent crawl, and it is the one that is
 * easy to get wrong: storing the promise, not the result, is what makes it
 * work.
 *
 * Only successful reads are cached. A timeout is a fact about one moment, and
 * caching it would turn a blip into a run-long outage.
 */

import type { FetchedDocument, Fetcher } from "../provider";
import { requestKey } from "./queue";

export const DEFAULT_MAX_ENTRIES = 500;

export interface CachingFetcherOptions {
  maxEntries?: number;
  /** Cache BLOCKED too. Sensible: a refusal will not change mid-run. */
  cacheBlocked?: boolean;
}

/**
 * A Fetcher that serves repeats from memory.
 *
 * Scoped to one run. A long-lived cache would need invalidation rules and
 * would quietly serve stale pages; freshness across runs is handled properly
 * by the research layer's freshness windows instead.
 */
export class CachingFetcher implements Fetcher {
  private readonly inner: Fetcher;
  private readonly maxEntries: number;
  private readonly cacheBlocked: boolean;

  private readonly entries = new Map<string, Promise<FetchedDocument>>();

  public hits = 0;
  public misses = 0;

  constructor(inner: Fetcher, options: CachingFetcherOptions = {}) {
    this.inner = inner;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.cacheBlocked = options.cacheBlocked ?? true;
  }

  async fetch(
    url: string,
    init: { timeoutMs?: number } = {},
  ): Promise<FetchedDocument> {
    const key = requestKey(url);
    const existing = this.entries.get(key);

    if (existing !== undefined) {
      this.hits += 1;
      return existing;
    }

    this.misses += 1;

    // The promise goes in before it settles, so a concurrent caller for the
    // same URL joins this fetch instead of starting a second one.
    const promise = this.inner.fetch(url, init);
    this.remember(key, promise);

    const result = await promise;

    const keep =
      result.outcome === "SUCCESS" ||
      result.outcome === "NOT_FOUND" ||
      (this.cacheBlocked && result.outcome === "BLOCKED");

    if (!keep) {
      // Transient failure: forget it so a retry can genuinely retry.
      this.entries.delete(key);
    }

    return result;
  }

  private remember(key: string, promise: Promise<FetchedDocument>): void {
    if (this.entries.size >= this.maxEntries) {
      // Oldest-first eviction. Insertion order is Map's iteration order.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }

    this.entries.set(key, promise);
  }

  /** Cached URLs, for reporting. */
  get size(): number {
    return this.entries.size;
  }
}
