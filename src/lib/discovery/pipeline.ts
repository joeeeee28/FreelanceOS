/**
 * Note: this module intentionally carries no `server-only` marker.
 *
 * It is loaded by the standalone worker process as well as by the Next.js
 * app, and `server-only` throws anywhere outside a React Server Component
 * graph. The protection is not lost — this module reaches the browser only
 * via an import from a client component, which would fail to bundle Prisma
 * regardless. Application UI code must still import `@/lib/db`, which keeps
 * the guard.
 */

import type { FetchOutcome as PrismaFetchOutcome, Prisma } from "@prisma/client";

import { db } from "@/lib/db-client";

import { CachingFetcher } from "./crawl/cache";
import { RetryingFetcher } from "./crawl/retry";
import { HttpFetcher } from "./fetcher";
import { ingestDiscoveredEntity, type IngestResult } from "./ingest";
import {
  validateEntity,
  type DiscoveryContext,
  type DiscoveryProvider,
  type FetchedDocument,
  type Fetcher,
} from "./provider";
import { providerRegistry } from "./providers";
import type { ProviderRegistry } from "./provider";

/**
 * The provider lifecycle runner.
 *
 * DISCOVER → FETCH → NORMALIZE → VALIDATE → STORE OBSERVATION
 *
 * The provider owns discover/fetch/normalize. This module owns validate and
 * store, plus everything a provider must not be trusted to do for itself:
 * source-health accounting, fetch logging, metric counting and error
 * containment.
 *
 * Containment is the important part. A provider that throws, hangs or returns
 * nonsense degrades its own source and nothing else — one broken source must
 * never stop the pipeline.
 */

export interface RunSourceOptions {
  workspaceId: string;
  sourceId: string;
  /** Overridable for tests. */
  registry?: ProviderRegistry;
  fetcher?: Fetcher;
  now?: Date;
  signal?: AbortSignal;
  /** Links the work to a DiscoveryRun for reporting. */
  discoveryRunId?: string;
}

export interface RunSourceResult {
  sourceId: string;
  provider: string;
  ok: boolean;
  /** Present when the source could not run at all. */
  error?: string;
  pagesAttempted: number;
  pagesSucceeded: number;
  pagesFailed: number;
  pagesBlocked: number;
  entitiesFound: number;
  entitiesValid: number;
  entitiesRejected: number;
  companiesCreated: number;
  companiesMatched: number;
  needsReview: number;
  /**
   * Companies this run created or touched, so the caller can queue follow-up
   * work for exactly those rather than re-scanning the workspace.
   */
  companyIds: string[];
  warnings: string[];
}

/** Wraps a fetcher so every request is recorded against the source. */
class LoggingFetcher implements Fetcher {
  constructor(
    private readonly inner: Fetcher,
    private readonly workspaceId: string,
    private readonly sourceId: string,
  ) {}

  async fetch(
    url: string,
    init?: { timeoutMs?: number },
  ): Promise<FetchedDocument> {
    const document = await this.inner.fetch(url, init);

    // Logging must never break a crawl, so a failed insert is swallowed.
    try {
      await db.fetchLog.create({
        data: {
          workspaceId: this.workspaceId,
          sourceId: this.sourceId,
          url: document.url.slice(0, 2000),
          outcome: document.outcome as PrismaFetchOutcome,
          statusCode: document.statusCode ?? null,
          durationMs: document.durationMs ?? null,
          bytes: document.body?.length ?? null,
          error: document.error?.slice(0, 500) ?? null,
        },
      });
    } catch {
      // Intentionally ignored: observability must not break the pipeline.
    }

    return document;
  }
}

/**
 * Runs one source end to end.
 *
 * Never throws. Every failure mode is converted into a recorded result so the
 * caller can continue to the next source.
 */
export async function runSource(
  options: RunSourceOptions,
): Promise<RunSourceResult> {
  const { workspaceId, sourceId } = options;
  const now = options.now ?? new Date();
  const registry = options.registry ?? providerRegistry;

  const source = await db.source.findFirst({
    where: { id: sourceId, workspaceId },
  });

  const base: RunSourceResult = {
    sourceId,
    provider: source?.provider ?? "unknown",
    ok: false,
    pagesAttempted: 0,
    pagesSucceeded: 0,
    pagesFailed: 0,
    pagesBlocked: 0,
    entitiesFound: 0,
    entitiesValid: 0,
    entitiesRejected: 0,
    companiesCreated: 0,
    companyIds: [],
    companiesMatched: 0,
    needsReview: 0,
    warnings: [],
  };

  if (source === null) {
    // Scoped by workspaceId above, so this also covers a cross-workspace id.
    return { ...base, error: "Source not found" };
  }

  if (!source.enabled || source.status === "PAUSED") {
    return { ...base, ok: true, warnings: ["Source is disabled or paused"] };
  }

  const provider: DiscoveryProvider | undefined = registry.get(source.provider);

  if (provider === undefined) {
    await recordSourceFailure(sourceId, `Unknown provider "${source.provider}"`, now);
    return { ...base, error: `Unknown provider "${source.provider}"` };
  }

  // The fetch stack, outermost first:
  //
  //   Caching   — one fetch per URL per run, and concurrent callers share it
  //   Logging   — every attempt recorded against the source for health
  //   Retrying  — transient failures re-attempted with jittered backoff
  //   Http      — robots, throttling, timeouts, size caps, redirect safety
  //
  // Retry sits *inside* logging on purpose: each individual attempt is
  // logged, so source health reflects what actually hit the network rather
  // than a retried failure masquerading as one request. Caching sits outside
  // logging so a cache hit is not recorded as a second request, which would
  // inflate the success rate.
  const transport =
    options.fetcher ??
    new RetryingFetcher(
      new HttpFetcher({ minIntervalMs: throttleFor(source.requestsPerMinute) }),
    );

  const fetcher = new CachingFetcher(
    new LoggingFetcher(transport, workspaceId, sourceId),
  );

  const context: DiscoveryContext = {
    workspaceId,
    sourceId,
    config: isRecord(source.config) ? source.config : {},
    fetcher,
    signal: options.signal,
    now,
  };

  let discovery;
  try {
    discovery = await provider.run(context);
  } catch (error) {
    // A provider that throws is a bug in that provider. Degrade the source,
    // keep the pipeline alive.
    const message = error instanceof Error ? error.message : String(error);
    await recordSourceFailure(sourceId, message, now);
    return { ...base, error: message };
  }

  const result: RunSourceResult = {
    ...base,
    pagesAttempted: discovery.pagesAttempted,
    pagesSucceeded: discovery.pagesSucceeded,
    pagesFailed: discovery.pagesFailed,
    pagesBlocked: discovery.pagesBlocked,
    entitiesFound: discovery.entities.length,
    warnings: [...discovery.warnings],
  };

  for (const entity of discovery.entities) {
    if (options.signal?.aborted) break;

    // VALIDATE: junk never reaches the database.
    const validation = validateEntity(entity);

    if (!validation.valid) {
      result.entitiesRejected += 1;
      result.warnings.push(`Rejected entity: ${validation.reason}`);
      continue;
    }

    result.entitiesValid += 1;

    // STORE: through the audited additive path, never a raw insert.
    let ingested: IngestResult;
    try {
      ingested = await ingestDiscoveredEntity({
        workspaceId,
        entity: { ...entity, sourceId },
        now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`Store failed: ${message}`);
      continue;
    }

    if (ingested.kind === "INGESTED") {
      if (ingested.created) result.companiesCreated += 1;
      else result.companiesMatched += 1;
      result.companyIds.push(ingested.companyId);
    } else if (ingested.kind === "NEEDS_REVIEW") {
      result.needsReview += 1;
      result.companiesCreated += 1;
    } else {
      result.entitiesRejected += 1;
      result.entitiesValid -= 1;
    }
  }

  // A source that only ever returns blocked pages is itself blocked.
  const blockedOnly =
    discovery.pagesAttempted > 0 &&
    discovery.pagesBlocked === discovery.pagesAttempted;

  await db.source.update({
    where: { id: sourceId },
    data: {
      lastRunAt: now,
      status: blockedOnly ? "BLOCKED" : "ACTIVE",
      successCount: { increment: discovery.pagesSucceeded },
      failureCount: { increment: discovery.pagesFailed },
      blockedCount: { increment: discovery.pagesBlocked },
      nextRunAt: new Date(now.getTime() + source.freshnessMinutes * 60 * 1000),
      ...(blockedOnly ? {} : { lastError: null }),
    },
  });

  result.ok = true;
  return result;
}

/** Marks a source as failing without throwing. */
async function recordSourceFailure(
  sourceId: string,
  message: string,
  now: Date,
): Promise<void> {
  try {
    await db.source.update({
      where: { id: sourceId },
      data: {
        status: "FAILING",
        lastRunAt: now,
        lastErrorAt: now,
        lastError: message.slice(0, 500),
        failureCount: { increment: 1 },
      },
    });
  } catch {
    // The source may have been deleted mid-run; nothing useful to do.
  }
}

/** Converts a per-minute budget into a minimum gap between requests. */
function throttleFor(requestsPerMinute: number): number {
  if (requestsPerMinute <= 0) return 60_000;
  return Math.ceil(60_000 / requestsPerMinute);
}

function isRecord(value: Prisma.JsonValue | null): value is Prisma.JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface RunAllSourcesOptions {
  workspaceId: string;
  registry?: ProviderRegistry;
  fetcher?: Fetcher;
  now?: Date;
  signal?: AbortSignal;
  discoveryRunId?: string;
  /** Only run sources whose nextRunAt has passed. */
  respectSchedule?: boolean;
}

/**
 * Runs every enabled source for a workspace.
 *
 * Sources run sequentially and independently: a failure in one is recorded and
 * the loop continues. This is the guarantee that a single broken source cannot
 * stop discovery.
 */
export async function runAllSources(
  options: RunAllSourcesOptions,
): Promise<RunSourceResult[]> {
  const now = options.now ?? new Date();

  const sources = await db.source.findMany({
    where: {
      workspaceId: options.workspaceId,
      enabled: true,
      status: { not: "PAUSED" },
      ...(options.respectSchedule
        ? { OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] }
        : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const results: RunSourceResult[] = [];

  for (const source of sources) {
    if (options.signal?.aborted) break;

    results.push(
      await runSource({
        workspaceId: options.workspaceId,
        sourceId: source.id,
        registry: options.registry,
        fetcher: options.fetcher,
        now,
        signal: options.signal,
        discoveryRunId: options.discoveryRunId,
      }),
    );
  }

  return results;
}
