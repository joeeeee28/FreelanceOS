/**
 * The discovery provider contract.
 *
 * Every way of finding businesses — a sitemap, an RSS feed, a public
 * directory, a CSV a user uploads — implements this one interface. The
 * pipeline knows nothing about any specific source, so new providers can be
 * added without touching the engine, and any provider can be tested in
 * isolation with a fake fetcher.
 *
 * No provider may require a paid API, credential or proxy. Optional
 * enrichment can be added later behind this same interface, but the system
 * must remain fully functional without it.
 */

import type { DiscoveredEntity } from "./ingest";

/** Why a fetch ended. Mirrors the FetchOutcome enum in the schema. */
export type FetchOutcome =
  | "SUCCESS"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "PARSE_ERROR"
  | "BLOCKED"
  | "RATE_LIMITED"
  | "SERVER_ERROR";

/**
 * Outcomes worth retrying. BLOCKED is deliberately absent: a block is a
 * decision by the site owner, and retrying it would be an attempt to
 * circumvent an access control.
 */
const RETRYABLE: ReadonlySet<FetchOutcome> = new Set<FetchOutcome>([
  "TIMEOUT",
  "NETWORK_ERROR",
  "RATE_LIMITED",
  "SERVER_ERROR",
]);

export function isRetryable(outcome: FetchOutcome): boolean {
  return RETRYABLE.has(outcome);
}

/**
 * Classifies a fetch result.
 *
 * 401/403/407 and 451 are treated as BLOCKED rather than as errors: the site
 * is telling us we may not have this content, and the correct response is to
 * record that and move on.
 */
export function classifyStatus(status: number): FetchOutcome {
  if (status >= 200 && status < 300) return "SUCCESS";
  if (status === 401 || status === 403 || status === 407 || status === 451) {
    return "BLOCKED";
  }
  if (status === 404 || status === 410) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_ERROR";
  return "NETWORK_ERROR";
}

/** Classifies a thrown fetch error. */
export function classifyError(error: unknown): FetchOutcome {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error);

  if (message.includes("timeout") || message.includes("aborted")) return "TIMEOUT";
  if (message.includes("parse") || message.includes("json")) return "PARSE_ERROR";
  return "NETWORK_ERROR";
}

/** A single fetched document, already classified. */
export interface FetchedDocument {
  url: string;
  outcome: FetchOutcome;
  statusCode?: number;
  contentType?: string | null;
  body?: string;
  error?: string;
  durationMs?: number;
}

/**
 * The HTTP access a provider is given.
 *
 * Providers never call fetch directly: they receive this, so rate limiting,
 * robots compliance, timeouts and logging are enforced by the engine rather
 * than reimplemented (and forgotten) per provider. Tests pass a fake.
 */
export interface Fetcher {
  fetch(url: string, init?: { timeoutMs?: number }): Promise<FetchedDocument>;
}

/** Everything a provider needs for one run. */
export interface DiscoveryContext {
  workspaceId: string;
  sourceId: string | null;
  /** Provider-specific settings from Source.config. */
  config: Record<string, unknown>;
  fetcher: Fetcher;
  /** Cooperative cancellation, so a run can be paused or stopped. */
  signal?: AbortSignal;
  now: Date;
}

/** What a provider produced. */
export interface DiscoveryResult {
  entities: DiscoveredEntity[];
  /** Pages touched, for honest statistics. */
  pagesAttempted: number;
  pagesSucceeded: number;
  pagesFailed: number;
  pagesBlocked: number;
  /** Non-fatal problems worth surfacing on the source-health screen. */
  warnings: string[];
}

export function emptyResult(): DiscoveryResult {
  return {
    entities: [],
    pagesAttempted: 0,
    pagesSucceeded: 0,
    pagesFailed: 0,
    pagesBlocked: 0,
    warnings: [],
  };
}

/**
 * Provider categories.
 *
 * Purely descriptive: used to group sources in the UI and to let an operator
 * enable or disable a whole class of source at once. The engine treats every
 * provider identically regardless of category.
 */
export const PROVIDER_CATEGORIES = [
  "PUBLIC_WEB",
  "WEBSITE",
  "SITEMAP",
  "FEED",
  "PUBLIC_JOBS",
  "CAREER_PAGE",
  "PUBLIC_DIRECTORY",
  "REPOSITORY",
  "PUBLIC_MEDIA",
  "MANUAL",
] as const;

export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

/**
 * Result of validating a normalised entity before it is stored.
 *
 * Validation is a distinct lifecycle step so a provider cannot push junk
 * straight into the database: anything that fails here is dropped with a
 * recorded reason rather than persisted.
 */
export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Validates a normalised entity.
 *
 * The bar is deliberately low but absolute: an entity must be identifiable
 * (a name or a domain) and every fact must declare how it was extracted.
 * Anything subtler is the resolver's job.
 */
export function validateEntity(entity: {
  identity: { name?: string | null; website?: string | null; domain?: string | null };
  facts: readonly { field: string; method: string }[];
}): ValidationResult {
  const hasName =
    typeof entity.identity.name === "string" && entity.identity.name.trim() !== "";
  const hasDomain =
    (typeof entity.identity.domain === "string" &&
      entity.identity.domain.trim() !== "") ||
    (typeof entity.identity.website === "string" &&
      entity.identity.website.trim() !== "");

  if (!hasName && !hasDomain) {
    return { valid: false, reason: "No usable company name or domain" };
  }

  for (const fact of entity.facts) {
    if (typeof fact.method !== "string" || fact.method === "") {
      return { valid: false, reason: `Fact "${fact.field}" has no extraction method` };
    }
  }

  return { valid: true };
}

/**
 * A source of businesses.
 *
 * `run` must be safe to call repeatedly: the ingest path deduplicates, so a
 * re-run after a crash re-reports what it already reported rather than
 * creating duplicates.
 */
export interface DiscoveryProvider {
  /** Stable machine key stored on Source.provider. */
  readonly key: string;
  readonly label: string;
  readonly category: ProviderCategory;
  /** False for providers that consume uploads instead of fetching. */
  readonly requiresNetwork: boolean;
  /** Human description shown when configuring a source. */
  readonly description?: string;
  run(context: DiscoveryContext): Promise<DiscoveryResult>;
}

/** Registry of available providers, keyed by `key`. */
export class ProviderRegistry {
  private readonly providers = new Map<string, DiscoveryProvider>();

  register(provider: DiscoveryProvider): this {
    if (this.providers.has(provider.key)) {
      throw new Error(`Duplicate discovery provider key: ${provider.key}`);
    }
    this.providers.set(provider.key, provider);
    return this;
  }

  get(key: string): DiscoveryProvider | undefined {
    return this.providers.get(key);
  }

  list(): DiscoveryProvider[] {
    return [...this.providers.values()];
  }

  keys(): string[] {
    return [...this.providers.keys()];
  }

  /** Providers in one category, for grouped configuration screens. */
  byCategory(category: ProviderCategory): DiscoveryProvider[] {
    return this.list().filter((provider) => provider.category === category);
  }

  has(key: string): boolean {
    return this.providers.has(key);
  }
}
