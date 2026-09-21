/**
 * In-run request queue.
 *
 * This is the crawl-shaped counterpart to the durable Job queue in
 * src/lib/jobs/queue.ts. That one survives restarts and coordinates workers;
 * this one orders the URLs inside a single source run. They are deliberately
 * separate: making every page fetch a database row would cost far more than it
 * buys, and a half-finished page crawl is cheap to redo.
 *
 * What it guarantees:
 *   - a URL is fetched at most once per run, even if twenty pages link to it
 *   - requests run with bounded concurrency
 *   - only one request per origin is in flight, so politeness survives
 *     parallelism
 *   - a global budget caps the work one source can do
 */

import { canonicalUrl } from "../canonical";

export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_MAX_REQUESTS = 50;

export interface CrawlRequest {
  url: string;
  /** Lower runs first. */
  priority?: number;
  /** Arbitrary caller context, returned untouched. */
  meta?: Record<string, unknown>;
}

export interface QueueOptions {
  concurrency?: number;
  maxRequests?: number;
}

interface InternalRequest {
  url: string;
  key: string;
  origin: string;
  priority: number;
  sequence: number;
  meta?: Record<string, unknown>;
}

/**
 * The dedup key for a URL.
 *
 * Built on canonicalUrl, then loosened slightly: a trailing slash is dropped
 * from any path, not just the root.
 *
 * That extra step is deliberately NOT pushed into canonicalUrl. The two
 * answer different questions. canonicalUrl decides what a stored URL *is*,
 * and /about and /about/ are, strictly, two different resources. requestKey
 * only decides whether fetching both would return the same bytes — and in
 * practice it always does, so paying for a second request is waste. Keeping
 * the looser rule here means storage identity is unaffected.
 */
export function requestKey(url: string): string {
  const canonical = canonicalUrl(url);
  if (canonical === null) return url.trim().toLowerCase();

  try {
    const parsed = new URL(canonical);
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return canonical;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * A bounded, deduplicating, origin-serialised request queue.
 *
 * Not persistent and not shared between runs — construct one per source run.
 */
export class CrawlQueue {
  private readonly concurrency: number;
  private readonly maxRequests: number;

  private readonly pending: InternalRequest[] = [];
  private readonly seen = new Set<string>();
  private readonly busyOrigins = new Set<string>();

  private sequence = 0;
  private started = 0;

  constructor(options: QueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.maxRequests = Math.max(0, options.maxRequests ?? DEFAULT_MAX_REQUESTS);
  }

  /** URLs accepted but not yet handed out. */
  get size(): number {
    return this.pending.length;
  }

  /** URLs refused because they were already queued this run. */
  public duplicatesRejected = 0;

  /** URLs refused because the run's budget was already committed. */
  public budgetRejected = 0;

  /**
   * Offers a URL to the queue.
   *
   * Returns false if it was a duplicate or over budget. Callers may ignore the
   * result: refusing work is the normal case, not an error.
   */
  add(request: CrawlRequest | string): boolean {
    const normalised: CrawlRequest =
      typeof request === "string" ? { url: request } : request;

    const key = requestKey(normalised.url);
    if (key === "") return false;

    if (this.seen.has(key)) {
      this.duplicatesRejected += 1;
      return false;
    }

    // Budget counts everything ever accepted, not just what is pending, so a
    // long chain of discovered links cannot exceed it by draining first.
    if (this.seen.size >= this.maxRequests) {
      this.budgetRejected += 1;
      return false;
    }

    this.seen.add(key);
    this.pending.push({
      url: normalised.url,
      key,
      origin: originOf(normalised.url),
      priority: normalised.priority ?? 0,
      sequence: this.sequence++,
      meta: normalised.meta,
    });

    return true;
  }

  /** Offers many URLs, returning how many were accepted. */
  addAll(requests: Array<CrawlRequest | string>): number {
    let accepted = 0;
    for (const request of requests) {
      if (this.add(request)) accepted += 1;
    }
    return accepted;
  }

  /** True if this URL has already been offered this run. */
  hasSeen(url: string): boolean {
    return this.seen.has(requestKey(url));
  }

  /**
   * Takes the next request whose origin is not already busy.
   *
   * Returning null while the queue is non-empty is normal: it means everything
   * left belongs to an origin with a request in flight.
   */
  private takeNext(): InternalRequest | null {
    let bestIndex = -1;

    for (let i = 0; i < this.pending.length; i++) {
      const candidate = this.pending[i];
      if (this.busyOrigins.has(candidate.origin)) continue;

      const best = bestIndex === -1 ? null : this.pending[bestIndex];
      if (
        best === null ||
        candidate.priority < best.priority ||
        (candidate.priority === best.priority && candidate.sequence < best.sequence)
      ) {
        bestIndex = i;
      }
    }

    if (bestIndex === -1) return null;

    const [taken] = this.pending.splice(bestIndex, 1);
    return taken;
  }

  /**
   * Drains the queue, running `handler` for each request.
   *
   * The handler may call add() to enqueue links it discovers; those are picked
   * up in the same drain. A handler that throws does not stop the drain — the
   * error is passed to onError and the remaining requests still run, because
   * one bad page must not abandon a whole source.
   */
  async drain(
    handler: (request: CrawlRequest) => Promise<void>,
    onError?: (error: unknown, request: CrawlRequest) => void,
  ): Promise<void> {
    const inFlight = new Set<Promise<void>>();

    const launch = (request: InternalRequest): void => {
      this.busyOrigins.add(request.origin);
      this.started += 1;

      const task = (async () => {
        try {
          await handler({
            url: request.url,
            priority: request.priority,
            meta: request.meta,
          });
        } catch (error) {
          onError?.(error, { url: request.url, meta: request.meta });
        } finally {
          this.busyOrigins.delete(request.origin);
        }
      })();

      inFlight.add(task);
      void task.then(() => {
        inFlight.delete(task);
      });
    };

    while (true) {
      while (inFlight.size < this.concurrency) {
        const next = this.takeNext();
        if (next === null) break;
        launch(next);
      }

      if (inFlight.size === 0) {
        // Nothing running and nothing runnable: either the queue is empty, or
        // everything left is origin-blocked by a request that just finished.
        if (this.pending.length === 0) return;
        if (this.takeNextExists()) continue;
        return;
      }

      // Wait for any in-flight request to finish, then re-evaluate.
      await Promise.race(inFlight);
    }
  }

  private takeNextExists(): boolean {
    return this.pending.some((request) => !this.busyOrigins.has(request.origin));
  }

  /** How many requests were actually handed to a handler. */
  get startedCount(): number {
    return this.started;
  }
}
