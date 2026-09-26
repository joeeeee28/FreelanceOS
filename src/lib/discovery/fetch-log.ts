/**
 * Recording what the network actually said.
 *
 * The crawl pipeline has always logged its fetches so source health reflects
 * reality rather than a provider's self-report. Research needs the same record:
 * when a company's website is listed but unreadable, the honest statement is
 * "we asked, and this is what came back" — which is exactly what a fetch log is
 * for, and better evidence than a derived guess about why the read failed.
 *
 * That is why this lives outside the pipeline: the research pass fetches a
 * company's own pages directly, with no configured source behind it, and it
 * must still leave a trace. `sourceId` is nullable in the schema precisely so a
 * fetch that is not driven by a source can be recorded as itself instead of
 * being attributed to a source it did not come from.
 *
 * This module deliberately carries no `server-only` marker: it is loaded by the
 * standalone worker process as well as by the Next.js app.
 */

import type { FetchOutcome as PrismaFetchOutcome } from "@prisma/client";

import { db } from "@/lib/db-client";

import type { FetchedDocument, Fetcher } from "./provider";

/** One recorded request, already trimmed for storage. */
export interface FetchRecord {
  workspaceId: string;
  /** Null when the fetch was not driven by a configured source. */
  sourceId: string | null;
  url: string;
  outcome: PrismaFetchOutcome;
  statusCode: number | null;
  durationMs: number | null;
  bytes: number | null;
  error: string | null;
}

/**
 * Where a fetch record goes.
 *
 * Injectable so a test can assert what was recorded without a database, and so
 * a caller can decide for itself that it does not want the record at all.
 */
export type FetchRecorder = (record: FetchRecord) => Promise<void> | void;

/** Longest URL and error fragment stored. Keeps a redirect chain from filling a row. */
const MAX_URL_LENGTH = 2_000;
const MAX_ERROR_LENGTH = 500;

/**
 * Writes the record. A failure here is swallowed by the caller: observability
 * must never break a crawl or a research pass.
 */
export const writeFetchRecord: FetchRecorder = async (record) => {
  await db.fetchLog.create({
    data: {
      workspaceId: record.workspaceId,
      sourceId: record.sourceId,
      url: record.url.slice(0, MAX_URL_LENGTH),
      outcome: record.outcome,
      statusCode: record.statusCode,
      durationMs: record.durationMs,
      bytes: record.bytes,
      error: record.error === null ? null : record.error.slice(0, MAX_ERROR_LENGTH),
    },
  });
};

/**
 * A Fetcher that records every request it makes.
 *
 * Wrap the transport, not the caller: retries, throttling, robots and the SSRF
 * guard all live inside, so one record means one request that actually left the
 * process.
 */
export class LoggingFetcher implements Fetcher {
  private readonly inner: Fetcher;
  private readonly workspaceId: string;
  private readonly sourceId: string | null;
  private readonly record: FetchRecorder;

  constructor(
    inner: Fetcher,
    workspaceId: string,
    sourceId: string | null,
    record: FetchRecorder = writeFetchRecord,
  ) {
    this.inner = inner;
    this.workspaceId = workspaceId;
    this.sourceId = sourceId;
    this.record = record;
  }

  async fetch(url: string, init: { timeoutMs?: number } = {}): Promise<FetchedDocument> {
    const document = await this.inner.fetch(url, init);

    try {
      await this.record({
        workspaceId: this.workspaceId,
        sourceId: this.sourceId,
        url: document.url,
        outcome: document.outcome as PrismaFetchOutcome,
        statusCode: document.statusCode ?? null,
        durationMs: document.durationMs ?? null,
        bytes: document.body?.length ?? null,
        error: document.error ?? null,
      });
    } catch {
      // Intentionally ignored: observability must not break the pipeline.
    }

    return document;
  }
}
