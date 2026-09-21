/**
 * Retry policy for crawling.
 *
 * Wraps any Fetcher and re-attempts failures that are plausibly transient. The
 * important half of this file is what it refuses to retry: a site that told us
 * "no" is never asked twice. Hammering a 403 is how a crawler gets an IP
 * banned and, more to the point, it ignores an explicit refusal.
 *
 * Implemented as a decorator so it composes with the caching and logging
 * fetchers without any of them knowing about the others.
 */

import { isRetryable, type FetchedDocument, type Fetcher } from "../provider";

/** First retry waits this long; each subsequent one doubles. */
export const BASE_BACKOFF_MS = 1_000;

/** Backoff never grows past this, however many attempts are configured. */
export const MAX_BACKOFF_MS = 30_000;

/** Total attempts, including the first. */
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface RetryOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Returns 0..1. Injected so tests are deterministic. */
  random?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delay before attempt n (1-based), with full jitter.
 *
 * Jitter is not decoration. Without it, a batch of requests that fail together
 * retries together, reproducing the burst that caused the failure.
 */
export function backoffMs(
  attempt: number,
  options: { baseBackoffMs?: number; maxBackoffMs?: number; random?: () => number } = {},
): number {
  const base = options.baseBackoffMs ?? BASE_BACKOFF_MS;
  const max = options.maxBackoffMs ?? MAX_BACKOFF_MS;
  const random = options.random ?? Math.random;

  const exponential = Math.min(base * 2 ** Math.max(0, attempt - 1), max);

  // Full jitter: anywhere in [0, exponential].
  return Math.round(exponential * random());
}

/**
 * Honours a Retry-After header when the server sent one.
 *
 * A server that names a wait is more authoritative than our own backoff curve,
 * so it wins — but only up to a ceiling, because an hour-long Retry-After must
 * not wedge a crawl run.
 */
export function retryAfterMs(
  document: FetchedDocument,
  ceilingMs: number = MAX_BACKOFF_MS,
): number | null {
  const header = document.headers?.["retry-after"];
  if (header === undefined) return null;

  const seconds = Number(header.trim());
  if (Number.isNaN(seconds)) {
    // The header also permits an HTTP date.
    const at = Date.parse(header);
    if (Number.isNaN(at)) return null;

    const delta = at - Date.now();
    if (delta <= 0) return 0;
    return Math.min(delta, ceilingMs);
  }

  if (seconds < 0) return null;
  return Math.min(seconds * 1000, ceilingMs);
}

/**
 * A Fetcher that retries transient failures.
 *
 * Retryable outcomes are defined once, in provider.ts: TIMEOUT, NETWORK_ERROR,
 * RATE_LIMITED and SERVER_ERROR. BLOCKED, NOT_FOUND and PARSE_ERROR are
 * answers, not accidents, and are returned immediately.
 */
export class RetryingFetcher implements Fetcher {
  private readonly inner: Fetcher;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  /** Attempts beyond the first, for reporting. */
  public retries = 0;

  constructor(inner: Fetcher, options: RetryOptions = {}) {
    this.inner = inner;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.baseBackoffMs = options.baseBackoffMs ?? BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  async fetch(
    url: string,
    init: { timeoutMs?: number } = {},
  ): Promise<FetchedDocument> {
    let last: FetchedDocument | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const result = await this.inner.fetch(url, init);
      last = result;

      if (result.outcome === "SUCCESS") return result;
      if (!isRetryable(result.outcome)) return result;
      if (attempt === this.maxAttempts) return result;

      const suggested = retryAfterMs(result, this.maxBackoffMs);
      const wait =
        suggested ??
        backoffMs(attempt, {
          baseBackoffMs: this.baseBackoffMs,
          maxBackoffMs: this.maxBackoffMs,
          random: this.random,
        });

      this.retries += 1;
      await this.sleep(wait);
    }

    // Unreachable: the loop always returns on its final attempt.
    return last ?? { url, outcome: "NETWORK_ERROR", error: "No attempt made" };
  }
}
