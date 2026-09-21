/**
 * The HTTP client every provider must use.
 *
 * Centralising fetching is what makes the crawl policy enforceable rather than
 * aspirational. In one place this handles:
 *
 *   - robots.txt, fetched once per origin and cached
 *   - per-origin rate limiting and crawl-delay
 *   - timeouts, so one dead host cannot stall a run
 *   - response size limits, so a huge file cannot exhaust memory
 *   - redirect safety, so a redirect cannot smuggle us past robots
 *   - error classification into retryable vs blocked
 *
 * A provider cannot opt out of any of it, because a provider never sees the
 * network directly.
 */

import {
  classifyError,
  classifyStatus,
  type FetchedDocument,
  type Fetcher,
} from "./provider";
import {
  crawlDelayFor,
  isAllowed,
  parseRobots,
  robotsUnavailablePolicy,
  type RobotsPolicy,
} from "./robots";

export const DEFAULT_USER_AGENT =
  "FreelanceOS-Bot/1.0 (+https://github.com/joeeeee28/FreelanceOS)";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MIN_INTERVAL_MS = 1_000;
export const MAX_REDIRECTS = 5;

/** Injected so tests can drive time and network deterministically. */
export interface HttpFetcherOptions {
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Minimum gap between requests to one origin. */
  minIntervalMs?: number;
  /** Set false only for a local fixture server in tests. */
  respectRobots?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Response headers as a plain lower-cased record. */
function collectHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Polite HTTP fetcher.
 *
 * Not safe to share across workspaces if robots caching matters for
 * correctness — construct one per run, which is also what keeps rate-limit
 * state meaningful.
 */
export class HttpFetcher implements Fetcher {
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly minIntervalMs: number;
  private readonly respectRobots: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private readonly robotsCache = new Map<string, Promise<RobotsPolicy>>();
  private readonly lastRequestAt = new Map<string, number>();

  constructor(options: HttpFetcherOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.respectRobots = options.respectRobots ?? true;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
  }

  async fetch(
    url: string,
    init: { timeoutMs?: number } = {},
  ): Promise<FetchedDocument> {
    const origin = originOf(url);

    if (origin === null) {
      return { url, outcome: "NETWORK_ERROR", error: "Invalid URL" };
    }

    // Only http(s). Anything else (file:, data:) is not a web resource and
    // could be an attempt to read the local filesystem.
    const scheme = new URL(url).protocol;
    if (scheme !== "http:" && scheme !== "https:") {
      return { url, outcome: "NETWORK_ERROR", error: `Unsupported scheme ${scheme}` };
    }

    if (this.respectRobots) {
      const policy = await this.robotsFor(origin);

      if (!isAllowed(policy, url, this.userAgent)) {
        // Refused by the site owner. Recorded, never retried, never bypassed.
        return {
          url,
          outcome: "BLOCKED",
          error: "Disallowed by robots.txt",
        };
      }

      const delay = crawlDelayFor(policy, this.userAgent);
      if (delay !== null) {
        await this.throttle(origin, delay * 1000);
      } else {
        await this.throttle(origin, this.minIntervalMs);
      }
    } else {
      await this.throttle(origin, this.minIntervalMs);
    }

    return this.rawFetch(url, init.timeoutMs ?? this.timeoutMs);
  }

  /** Enforces a minimum gap between requests to the same origin. */
  private async throttle(origin: string, intervalMs: number): Promise<void> {
    if (intervalMs <= 0) return;

    const last = this.lastRequestAt.get(origin);
    const now = this.now();

    if (last !== undefined) {
      const wait = last + intervalMs - now;
      if (wait > 0) await this.sleep(wait);
    }

    this.lastRequestAt.set(origin, this.now());
  }

  /** Fetches and caches robots.txt for an origin. */
  private robotsFor(origin: string): Promise<RobotsPolicy> {
    const cached = this.robotsCache.get(origin);
    if (cached !== undefined) return cached;

    const promise = (async (): Promise<RobotsPolicy> => {
      const result = await this.rawFetch(`${origin}/robots.txt`, this.timeoutMs);

      if (result.outcome === "SUCCESS" && typeof result.body === "string") {
        return parseRobots(result.body);
      }

      // A robots.txt that is itself behind auth means the site is gated;
      // treat every path as disallowed rather than guessing.
      if (result.outcome === "BLOCKED") {
        return parseRobots("User-agent: *\nDisallow: /");
      }

      return robotsUnavailablePolicy();
    })();

    this.robotsCache.set(origin, promise);
    return promise;
  }

  /** One HTTP request, with timeout, size cap and manual redirect handling. */
  private async rawFetch(url: string, timeoutMs: number): Promise<FetchedDocument> {
    const started = this.now();
    let current = url;

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await this.fetchImpl(current, {
          headers: {
            "user-agent": this.userAgent,
            accept: "text/html,application/xhtml+xml,application/xml,text/plain,*/*",
          },
          // Redirects are followed manually so each hop can be re-checked
          // against robots rather than silently trusted.
          redirect: "manual",
          signal: controller.signal,
        });

        const status = response.status;

        if (status >= 300 && status < 400) {
          const location = response.headers.get("location");
          if (location === null) {
            return {
              url: current,
              outcome: "NETWORK_ERROR",
              statusCode: status,
              error: "Redirect without Location",
              durationMs: this.now() - started,
            };
          }

          const next = new URL(location, current).toString();

          if (this.respectRobots) {
            const nextOrigin = originOf(next);
            if (nextOrigin !== null) {
              const policy = await this.robotsFor(nextOrigin);
              if (!isAllowed(policy, next, this.userAgent)) {
                return {
                  url: next,
                  outcome: "BLOCKED",
                  statusCode: status,
                  error: "Redirect target disallowed by robots.txt",
                  durationMs: this.now() - started,
                };
              }
            }
          }

          current = next;
          continue;
        }

        const outcome = classifyStatus(status);

        if (outcome !== "SUCCESS") {
          return {
            url: current,
            outcome,
            statusCode: status,
            // Carried so the retry layer can honour Retry-After on a 429 or
            // a 503 instead of applying its own, blinder, backoff.
            headers: collectHeaders(response),
            durationMs: this.now() - started,
            error: `HTTP ${status}`,
          };
        }

        const body = await this.readCapped(response);

        return {
          url: current,
          outcome: "SUCCESS",
          statusCode: status,
          contentType: response.headers.get("content-type"),
          headers: collectHeaders(response),
          body,
          durationMs: this.now() - started,
        };
      } catch (error) {
        return {
          url: current,
          outcome: classifyError(error),
          error: error instanceof Error ? error.message : String(error),
          durationMs: this.now() - started,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      url: current,
      outcome: "NETWORK_ERROR",
      error: `Exceeded ${MAX_REDIRECTS} redirects`,
      durationMs: this.now() - started,
    };
  }

  /** Reads a body, refusing to buffer more than maxBytes. */
  private async readCapped(response: Response): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > this.maxBytes) {
      throw new Error(`Response larger than ${this.maxBytes} bytes`);
    }

    const text = await response.text();

    return text.length > this.maxBytes ? text.slice(0, this.maxBytes) : text;
  }
}
