/**
 * Persisting signals and opportunities.
 *
 * Detection is pure; this is the part that touches the database. It follows
 * the same additive discipline as the rest of discovery: re-detecting a signal
 * refreshes it rather than duplicating it, a signal that stops being detected
 * is marked resolved rather than deleted, and a human dismissal is never
 * undone by a later run.
 */

import type { Prisma, PrismaClient, SignalType } from "@prisma/client";

import { db } from "@/lib/db";
import {
  detectSignals,
  type CompanyFacts,
  type DetectedSignal,
} from "./rules";
import {
  mapSignalsToOpportunities,
  type MappedOpportunity,
} from "./opportunities";

export interface RefreshOptions {
  workspaceId: string;
  companyId: string;
  /** Extra facts the caller gathered that are not on the Company row. */
  facts?: Partial<CompanyFacts>;
  now?: Date;
  client?: PrismaClient | Prisma.TransactionClient;
}

export interface RefreshResult {
  companyId: string;
  signalsDetected: number;
  signalsCreated: number;
  signalsRefreshed: number;
  signalsResolved: number;
  opportunitiesCreated: number;
  opportunitiesUpdated: number;
  skipped?: string;
}

const EMPTY = (companyId: string, skipped: string): RefreshResult => ({
  companyId,
  signalsDetected: 0,
  signalsCreated: 0,
  signalsRefreshed: 0,
  signalsResolved: 0,
  opportunitiesCreated: 0,
  opportunitiesUpdated: 0,
  skipped,
});

/**
 * Re-runs detection for one company and stores the result.
 *
 * Idempotent: running it twice with unchanged facts produces no new rows.
 */
export async function refreshCompanySignals(
  options: RefreshOptions,
): Promise<RefreshResult> {
  const { workspaceId, companyId } = options;
  const client = options.client ?? db;
  const now = options.now ?? new Date();

  const company = await client.company.findFirst({
    where: { id: companyId, workspaceId },
  });

  if (company === null) return EMPTY(companyId, "Company not found");
  if (company.archivedAt !== null) return EMPTY(companyId, "Company is archived");

  const facts: CompanyFacts = {
    companyId,
    name: company.name,
    website: company.website,
    email: company.email,
    phone: company.phone,
    instagramUrl: company.instagramUrl,
    facebookUrl: company.facebookUrl,
    linkedinUrl: company.linkedinUrl,
    youtubeUrl: company.youtubeUrl,
    industry: company.industry,
    companySize: company.companySize,
    firstSeenAt: company.firstSeenAt,
    ...options.facts,
  };

  const detected = detectSignals(facts, now);

  const existing = await client.signal.findMany({ where: { companyId } });
  const existingByType = new Map(existing.map((signal) => [signal.type, signal]));

  let created = 0;
  let refreshed = 0;

  for (const signal of detected) {
    const prior = existingByType.get(signal.type);

    if (prior === undefined) {
      await client.signal.create({
        data: {
          workspaceId,
          companyId,
          type: signal.type,
          confidence: signal.confidence,
          summary: signal.summary,
          evidence: signal.evidence,
          sourceUrl: signal.sourceUrl,
          metadata: (signal.metadata ?? {}) as Prisma.InputJsonValue,
          firstSeenAt: now,
          lastSeenAt: now,
        },
      });
      created += 1;
      continue;
    }

    await client.signal.update({
      where: { id: prior.id },
      data: {
        confidence: signal.confidence,
        summary: signal.summary,
        evidence: signal.evidence,
        sourceUrl: signal.sourceUrl,
        metadata: (signal.metadata ?? {}) as Prisma.InputJsonValue,
        // firstSeenAt is never touched: when we first noticed is history.
        lastSeenAt: now,
        // Seeing it again revives it, unless a person dismissed it.
        status: prior.status === "DISMISSED" ? "DISMISSED" : "ACTIVE",
        resolvedAt: prior.status === "DISMISSED" ? prior.resolvedAt : null,
      },
    });
    refreshed += 1;
  }

  // Signals that no longer fire are resolved, not deleted. "This used to be
  // true" is information, and the evidence trail must survive.
  const detectedTypes = new Set<SignalType>(detected.map((signal) => signal.type));
  let resolved = 0;

  for (const prior of existing) {
    if (detectedTypes.has(prior.type)) continue;
    if (prior.status !== "ACTIVE") continue;

    await client.signal.update({
      where: { id: prior.id },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    resolved += 1;
  }

  const opportunities = await storeOpportunities({
    client,
    workspaceId,
    companyId,
    detected,
    now,
  });

  return {
    companyId,
    signalsDetected: detected.length,
    signalsCreated: created,
    signalsRefreshed: refreshed,
    signalsResolved: resolved,
    ...opportunities,
  };
}

async function storeOpportunities(args: {
  client: PrismaClient | Prisma.TransactionClient;
  workspaceId: string;
  companyId: string;
  detected: DetectedSignal[];
  now: Date;
}): Promise<{ opportunitiesCreated: number; opportunitiesUpdated: number }> {
  const { client, workspaceId, companyId, detected, now } = args;

  const mapped: MappedOpportunity[] = mapSignalsToOpportunities(
    detected.map((signal) => ({
      type: signal.type,
      confidence: signal.confidence,
      evidence: signal.evidence,
      sourceUrl: signal.sourceUrl,
    })),
  );

  // Link opportunities to the stored signals that justify them, so the UI can
  // show the evidence without recomputing anything.
  const stored = await client.signal.findMany({
    where: { companyId },
    select: { id: true, type: true },
  });
  const signalIdByType = new Map(stored.map((signal) => [signal.type, signal.id]));

  let createdCount = 0;
  let updatedCount = 0;

  for (const opportunity of mapped) {
    const existing = await client.opportunity.findUnique({
      where: { companyId_serviceKey: { companyId, serviceKey: opportunity.serviceKey } },
    });

    const signalIds = opportunity.signalTypes
      .map((type) => signalIdByType.get(type))
      .filter((id): id is string => id !== undefined);

    const shared = {
      score: opportunity.score,
      rationale: opportunity.rationale as unknown as Prisma.InputJsonValue,
      summary: opportunity.summary,
      recommendedAction: opportunity.recommendedAction,
      lastSeenAt: now,
    };

    if (existing === null) {
      await client.opportunity.create({
        data: {
          workspaceId,
          companyId,
          serviceKey: opportunity.serviceKey,
          detectedAt: now,
          firstSeenAt: now,
          ...shared,
          signals: { connect: signalIds.map((id) => ({ id })) },
        },
      });
      createdCount += 1;
      continue;
    }

    await client.opportunity.update({
      where: { id: existing.id },
      // dismissedAt is intentionally absent: a person who dismissed this
      // opportunity does not need the engine to raise it again next run.
      data: {
        ...shared,
        // `set` rather than `connect`: the justifying signals are replaced, so
        // a signal that no longer supports this opportunity stops being cited.
        signals: { set: signalIds.map((id) => ({ id })) },
      },
    });
    updatedCount += 1;
  }

  return { opportunitiesCreated: createdCount, opportunitiesUpdated: updatedCount };
}

/**
 * Refreshes every active company in a workspace.
 *
 * One company failing does not stop the sweep.
 */
export async function refreshAllSignals(options: {
  workspaceId: string;
  limit?: number;
  now?: Date;
}): Promise<RefreshResult[]> {
  const companies = await db.company.findMany({
    where: { workspaceId: options.workspaceId, archivedAt: null },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 500,
  });

  const results: RefreshResult[] = [];

  for (const company of companies) {
    try {
      results.push(
        await refreshCompanySignals({
          workspaceId: options.workspaceId,
          companyId: company.id,
          now: options.now,
        }),
      );
    } catch (error) {
      results.push(
        EMPTY(company.id, error instanceof Error ? error.message : "Refresh failed"),
      );
    }
  }

  return results;
}
