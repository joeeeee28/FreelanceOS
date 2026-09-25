/**
 * Job handlers.
 *
 * One function per JobType, each doing a single well-defined piece of work and
 * enqueuing whatever should happen next. Chaining through the queue rather
 * than calling straight through means a crash loses one step, not a whole
 * pipeline, and any step can be retried on its own.
 *
 * Every handler must be idempotent. The queue guarantees at-least-once
 * delivery — a worker can die after finishing the work but before marking the
 * job done — so "runs twice" is a normal occurrence, not an edge case.
 */

import type { JobType, Prisma } from "@prisma/client";

import { db } from "@/lib/db-client";
import { syncCompanyToLead } from "@/lib/discovery/crm-sync";
import { runSource } from "@/lib/discovery/pipeline";
import { providerRegistry } from "@/lib/discovery/providers";
import { settleDiscoveryRun } from "@/lib/discovery/runs";
import { refreshCompanySignals } from "@/lib/discovery/signals/store";
import { ingestKnowledgeResource } from "@/lib/knowledge/ingest";
import { researchCompany } from "@/lib/research/runner";
import { selectCompaniesForResearch } from "@/lib/research/runner";
import { enqueueJob } from "./queue";

export interface HandlerContext {
  workspaceId: string;
  jobId: string;
  payload: Prisma.JsonValue;
  discoveryRunId: string | null;
  signal?: AbortSignal;
  now?: Date;
}

export interface HandlerResult {
  ok: boolean;
  /** Short, safe-to-store summary. */
  summary: string;
  /** Jobs this handler queued as follow-up work. */
  enqueued?: number;
}

export type JobHandler = (context: HandlerContext) => Promise<HandlerResult>;

function readString(payload: Prisma.JsonValue, key: string): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Starts a discovery cycle: queues one CRAWL_SOURCE per enabled source.
 *
 * Fans out rather than crawling inline, so a slow source cannot hold the cycle
 * open and each source can fail and retry independently.
 *
 * The run itself is *not* completed here. It stays RUNNING until every job
 * belonging to it has reached a terminal state, which is decided by
 * `settleDiscoveryRun()` when each of those jobs finishes (see
 * `@/lib/discovery/runs`). The job doing this fan-out counts as one of them, so
 * a second worker cannot close the run while children are still being queued.
 */
const discoveryRun: JobHandler = async (context) => {
  const { workspaceId } = context;
  const now = context.now ?? new Date();

  const sources = await db.source.findMany({
    where: { workspaceId, enabled: true, status: { not: "PAUSED" } },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  const run = await db.discoveryRun.create({
    data: { workspaceId, status: "RUNNING", startedAt: now, trigger: "SCHEDULED" },
  });

  // Link the fan-out job to the run it created. `updateMany` rather than
  // `update`: handlers are also invoked directly (by tests, and by any future
  // one-shot run) where there is no real job row to update, and a no-op is the
  // correct outcome there.
  await db.job.updateMany({
    where: { id: context.jobId },
    data: { discoveryRunId: run.id },
  });

  let enqueued = 0;

  for (const source of sources) {
    await enqueueJob({
      workspaceId,
      type: "CRAWL_SOURCE",
      payload: { sourceId: source.id },
      discoveryRunId: run.id,
      // Scoped to the run, so tomorrow's cycle is not deduplicated against
      // today's while still collapsing double-queues within one cycle.
      idempotencyKey: `crawl:${run.id}:${source.id}`,
      priority: 100,
    });
    enqueued += 1;
  }

  // Research is queued alongside crawling: refreshing what we already know is
  // as valuable as finding something new.
  const companies = await selectCompaniesForResearch({ workspaceId, limit: 25 });

  for (const companyId of companies) {
    await enqueueJob({
      workspaceId,
      type: "RESEARCH_COMPANY",
      payload: { companyId },
      discoveryRunId: run.id,
      idempotencyKey: `research:${run.id}:${companyId}`,
      priority: 150,
    });
    enqueued += 1;
  }

  if (sources.length === 0 && companies.length === 0) {
    // Nothing was queued, so nothing is outstanding: the run is finished. (When
    // this handler ran as a real job, that job is still RUNNING and the run
    // closes the moment it is marked finished — the same rule as any other run.)
    await settleDiscoveryRun(run.id, now);

    return { ok: true, summary: "Nothing to do: no enabled sources or companies.", enqueued: 0 };
  }

  return {
    ok: true,
    summary: `Queued ${sources.length} source crawls and ${companies.length} research passes.`,
    enqueued,
  };
};

/** Crawls one source and queues signal detection for whatever it found. */
const crawlSource: JobHandler = async (context) => {
  const sourceId = readString(context.payload, "sourceId");
  if (sourceId === null) return { ok: false, summary: "No sourceId in payload" };

  const result = await runSource({
    workspaceId: context.workspaceId,
    sourceId,
    registry: providerRegistry,
    signal: context.signal,
    now: context.now,
  });

  if (!result.ok) {
    // runSource already recorded the failure against the source. Reporting it
    // as a job failure too would double-count in the health statistics.
    return { ok: true, summary: result.error ?? "Source run failed" };
  }

  let enqueued = 0;

  for (const companyId of result.companyIds) {
    await enqueueJob({
      workspaceId: context.workspaceId,
      type: "EXTRACT_SIGNALS",
      payload: { companyId },
      discoveryRunId: context.discoveryRunId ?? undefined,
      idempotencyKey: `signals:${context.jobId}:${companyId}`,
      priority: 200,
    });
    enqueued += 1;
  }

  return {
    ok: true,
    summary:
      `${result.entitiesValid} valid entities, ${result.companiesCreated} new, ` +
      `${result.pagesBlocked} blocked.`,
    enqueued,
  };
};

/** Detects signals for one company and queues a CRM sync. */
const extractSignals: JobHandler = async (context) => {
  const companyId = readString(context.payload, "companyId");
  if (companyId === null) return { ok: false, summary: "No companyId in payload" };

  const result = await refreshCompanySignals({
    workspaceId: context.workspaceId,
    companyId,
    now: context.now,
  });

  if (result.skipped !== undefined) {
    return { ok: true, summary: result.skipped };
  }

  await enqueueJob({
    workspaceId: context.workspaceId,
    type: "UPDATE_CRM",
    payload: { companyId },
    discoveryRunId: context.discoveryRunId ?? undefined,
    idempotencyKey: `crm:${context.jobId}:${companyId}`,
    priority: 250,
  });

  return {
    ok: true,
    summary: `${result.signalsDetected} signals, ${result.opportunitiesCreated} new opportunities.`,
    enqueued: 1,
  };
};

/**
 * Pushes discovered facts onto the company's lead.
 *
 * createIfMissing is false: discovering a company is not the same as deciding
 * to pursue it, and filling the CRM with unvetted crawler output is exactly
 * what the permanent-CRM principle exists to prevent.
 */
const updateCrm: JobHandler = async (context) => {
  const companyId = readString(context.payload, "companyId");
  if (companyId === null) return { ok: false, summary: "No companyId in payload" };

  const result = await syncCompanyToLead({
    workspaceId: context.workspaceId,
    companyId,
    createIfMissing: false,
    now: context.now,
  });

  return { ok: true, summary: `CRM sync: ${result.kind}.` };
};

/** Researches one company incrementally. */
const researchCompanyJob: JobHandler = async (context) => {
  const companyId = readString(context.payload, "companyId");
  if (companyId === null) return { ok: false, summary: "No companyId in payload" };

  // Researchers are registered by the worker that owns network access; with
  // none supplied this is a no-op rather than a failure.
  const result = await researchCompany({
    workspaceId: context.workspaceId,
    companyId,
    fetcher: { async fetch(url) { return { url, outcome: "NETWORK_ERROR", error: "No fetcher configured" }; } },
    researchers: {},
    signal: context.signal,
    now: context.now,
  });

  return {
    ok: true,
    summary: result.skipped ?? `${result.aspectsRun} of ${result.aspectsPlanned} aspects researched.`,
  };
};

/** Ingests one public resource into the knowledge hub. */
const knowledgeIngestion: JobHandler = async (context) => {
  const url = readString(context.payload, "url");
  if (url === null) return { ok: false, summary: "No url in payload" };

  const result = await ingestKnowledgeResource({
    workspaceId: context.workspaceId,
    input: {
      url,
      title: readString(context.payload, "title"),
      content: readString(context.payload, "content"),
      sourceName: readString(context.payload, "sourceName"),
    },
    now: context.now,
  });

  return { ok: true, summary: `Knowledge: ${result.kind}.` };
};

const notImplemented =
  (type: JobType): JobHandler =>
  async () => ({
    ok: true,
    summary: `${type} has no handler in this build; nothing was done.`,
  });

/**
 * The handler table.
 *
 * Every JobType has an entry. A type with no real implementation returns a
 * truthful no-op rather than throwing, so an unhandled type cannot fill the
 * queue with permanently failing jobs.
 */
export const JOB_HANDLERS: Readonly<Record<JobType, JobHandler>> = {
  DISCOVERY_RUN: discoveryRun,
  CRAWL_SOURCE: crawlSource,
  RESEARCH_COMPANY: researchCompanyJob,
  EXTRACT_SIGNALS: extractSignals,
  RESOLVE_ENTITY: notImplemented("RESOLVE_ENTITY"),
  UPDATE_CRM: updateCrm,
  KNOWLEDGE_INGESTION: knowledgeIngestion,
  KNOWLEDGE_PROCESSING: notImplemented("KNOWLEDGE_PROCESSING"),
  MARKET_ANALYSIS: notImplemented("MARKET_ANALYSIS"),
};
