/**
 * Incremental research.
 *
 * Walks a company's aspects, researches only what has gone stale, and records
 * each pass as an append-only ResearchRun. The append-only part matters: the
 * history of what was looked at and when is what lets a user tell "we checked
 * and found nothing" from "we never checked", and those two look identical in
 * a schema that only stores the latest result.
 */

import type { Prisma, PrismaClient, ResearchAspect } from "@prisma/client";

import { db } from "@/lib/db-client";
import { ingestDiscoveredEntity, type ObservedFact } from "@/lib/discovery/ingest";
import { refreshCompanySignals } from "@/lib/discovery/signals/store";
import type { Fetcher } from "@/lib/discovery/provider";
import {
  aggregateStatus,
  freshUntilFor,
  planResearch,
  type AspectState,
} from "./freshness";

/** What an aspect researcher returns. */
export interface AspectFindings {
  facts: ObservedFact[];
  sourceUrl?: string | null;
  /** True if the source refused access. Recorded, never bypassed. */
  blocked?: boolean;
  /** True if only some of the aspect could be established. */
  partial?: boolean;
}

export type AspectResearcher = (context: {
  company: { id: string; name: string; website: string | null; canonicalDomain: string | null };
  fetcher: Fetcher;
  signal?: AbortSignal;
}) => Promise<AspectFindings>;

export interface ResearchCompanyOptions {
  workspaceId: string;
  companyId: string;
  fetcher: Fetcher;
  /** Which aspects can actually be researched, and how. */
  researchers: Partial<Record<ResearchAspect, AspectResearcher>>;
  maxAspects?: number;
  now?: Date;
  signal?: AbortSignal;
  client?: PrismaClient;
}

export interface AspectResult {
  aspect: ResearchAspect;
  status: "RESEARCHED" | "PARTIAL" | "BLOCKED" | "NEEDS_REVIEW";
  factsFound: number;
  factsChanged: number;
  error?: string;
}

export interface ResearchCompanyResult {
  companyId: string;
  aspectsPlanned: number;
  aspectsRun: number;
  results: AspectResult[];
  skipped?: string;
}

/**
 * Researches one company incrementally.
 *
 * Never throws for an expected failure: an aspect that errors is recorded as
 * such and the remaining aspects still run, for the same reason a broken
 * source does not stop a crawl.
 */
export async function researchCompany(
  options: ResearchCompanyOptions,
): Promise<ResearchCompanyResult> {
  const { workspaceId, companyId } = options;
  const client = options.client ?? db;
  const now = options.now ?? new Date();

  const company = await client.company.findFirst({
    where: { id: companyId, workspaceId },
  });

  if (company === null) {
    return { companyId, aspectsPlanned: 0, aspectsRun: 0, results: [], skipped: "Company not found" };
  }

  if (company.archivedAt !== null) {
    return { companyId, aspectsPlanned: 0, aspectsRun: 0, results: [], skipped: "Company is archived" };
  }

  const states = await loadAspectStates(client, companyId);
  const plan = planResearch(states, { now, maxAspects: options.maxAspects });

  const results: AspectResult[] = [];

  for (const decision of plan) {
    if (options.signal?.aborted === true) break;

    const researcher = options.researchers[decision.aspect];
    // An aspect with no researcher is not a failure; it is simply not
    // something this build knows how to investigate.
    if (researcher === undefined) continue;

    const run = await client.researchRun.create({
      data: {
        workspaceId,
        companyId,
        aspect: decision.aspect,
        status: "PARTIAL",
        startedAt: now,
      },
    });

    let findings: AspectFindings | null = null;
    let error: string | null = null;

    try {
      findings = await researcher({
        company: {
          id: company.id,
          name: company.name,
          website: company.website,
          canonicalDomain: company.canonicalDomain,
        },
        fetcher: options.fetcher,
        signal: options.signal,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    if (findings === null) {
      await client.researchRun.update({
        where: { id: run.id },
        data: {
          status: "NEEDS_REVIEW",
          error: error?.slice(0, 500) ?? "Researcher failed",
          completedAt: new Date(),
          // No freshUntil: a failure must not suppress the next attempt.
        },
      });
      results.push({
        aspect: decision.aspect,
        status: "NEEDS_REVIEW",
        factsFound: 0,
        factsChanged: 0,
        error: error ?? undefined,
      });
      continue;
    }

    if (findings.blocked === true) {
      await client.researchRun.update({
        where: { id: run.id },
        data: {
          status: "BLOCKED",
          sourceUrl: findings.sourceUrl ?? null,
          completedAt: new Date(),
          error: "Access was refused by the source",
        },
      });
      results.push({ aspect: decision.aspect, status: "BLOCKED", factsFound: 0, factsChanged: 0 });
      continue;
    }

    let changed = 0;

    if (findings.facts.length > 0) {
      const ingestion = await ingestDiscoveredEntity({
        workspaceId,
        entity: {
          identity: {
            name: company.name,
            domain: company.canonicalDomain,
            website: company.website,
          },
          facts: findings.facts,
        },
        now,
      });

      if (ingestion.kind === "INGESTED") {
        changed = ingestion.fields.filter((field) => field.promoted).length;
      }
    }

    const status = findings.partial === true ? "PARTIAL" : "RESEARCHED";

    await client.researchRun.update({
      where: { id: run.id },
      data: {
        status,
        factsFound: findings.facts.length,
        factsChanged: changed,
        sourceUrl: findings.sourceUrl ?? null,
        completedAt: new Date(),
        freshUntil: freshUntilFor(decision.aspect, now),
      },
    });

    results.push({
      aspect: decision.aspect,
      status,
      factsFound: findings.facts.length,
      factsChanged: changed,
    });
  }

  // Refresh the company's denormalised research status from the new history.
  const updated = await loadAspectStates(client, companyId);
  await client.company.update({
    where: { id: companyId },
    data: {
      researchStatus: aggregateStatus(updated, now),
      lastResearchAt: results.length > 0 ? now : company.lastResearchAt,
    },
  });

  // New facts may imply new signals. Re-running detection here keeps the two
  // in step without a separate scheduled pass.
  if (results.some((result) => result.factsChanged > 0)) {
    await refreshCompanySignals({ workspaceId, companyId, now });
  }

  return {
    companyId,
    aspectsPlanned: plan.length,
    aspectsRun: results.length,
    results,
  };
}

/** Reads the latest run per aspect. */
async function loadAspectStates(
  client: PrismaClient | Prisma.TransactionClient,
  companyId: string,
): Promise<AspectState[]> {
  const runs = await client.researchRun.findMany({
    where: { companyId },
    orderBy: { startedAt: "desc" },
  });

  const latest = new Map<ResearchAspect, AspectState>();

  for (const run of runs) {
    // Runs are newest-first, so the first sighting of an aspect is its latest.
    if (latest.has(run.aspect)) continue;

    latest.set(run.aspect, {
      aspect: run.aspect,
      status: run.status,
      freshUntil: run.freshUntil,
      completedAt: run.completedAt,
    });
  }

  return [...latest.values()];
}

/**
 * Chooses which companies to research next.
 *
 * Least-recently-researched first, so attention spreads rather than pooling on
 * whichever company happens to sort first.
 */
export async function selectCompaniesForResearch(options: {
  workspaceId: string;
  limit?: number;
}): Promise<string[]> {
  const companies = await db.company.findMany({
    where: {
      workspaceId: options.workspaceId,
      archivedAt: null,
      resolutionState: { not: "NEEDS_REVIEW" },
    },
    select: { id: true },
    orderBy: [
      // Nulls first in Postgres ascending order: never-researched companies
      // are exactly the ones that most need attention.
      { lastResearchAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" },
    ],
    take: options.limit ?? 25,
  });

  return companies.map((company) => company.id);
}
