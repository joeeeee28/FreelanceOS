/**
 * Find Clients search.
 *
 * Reads companies, opportunities, signals and observations that already
 * exist. It does not create prospects, does not call a model, and does not
 * write. Every query is scoped to one workspace. Filters are applied in
 * PostgreSQL before any row is returned, and the page is hard-capped.
 */

import type { Prisma, ResearchStatus, SignalType } from "@prisma/client";

import { db } from "@/lib/db";
import { SERVICE_KEYS, getService, serviceLabel } from "@/lib/taxonomy/services";

import {
  FIND_CLIENTS_MAX_PAGE,
  FIND_CLIENTS_PAGE_SIZE,
  type FindClientsFilters,
  type LeadPresence,
} from "./parse";

export interface FindClientEvidence {
  kind: "signal" | "observation" | "rationale";
  id: string;
  label: string;
  text: string | null;
  sourceUrl: string | null;
  sourceName: string | null;
  confidence: number | null;
  observedAt: string | null;
}

export interface FindClientRow {
  company: {
    id: string;
    name: string;
    industry: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    website: string | null;
    lastResearchAt: string | null;
    researchStatus: ResearchStatus;
  };
  opportunity: {
    id: string;
    serviceKey: string;
    serviceLabel: string;
    status: string;
    score: number;
    summary: string | null;
    recommendedAction: string | null;
    detectedAt: string;
  };
  evidence: FindClientEvidence[];
  /** Leading stored signal confidence. Null when no active signal is linked. */
  confidence: number | null;
  /** Sentences built from the stored score and rationale. Not model text. */
  scoreExplanation: string[];
  lead: { id: string; status: string; score: number } | null;
}

export interface FindClientsPage {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  results: FindClientRow[];
}

interface RationaleLine {
  ruleKey: string;
  signal: string;
  reason: string;
  points: number;
  evidence: string | null;
  sourceUrl: string | null;
}

function readRationale(value: unknown): RationaleLine[] {
  if (!Array.isArray(value)) return [];
  const lines: RationaleLine[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Partial<RationaleLine>;
    if (typeof row.reason !== "string" || typeof row.points !== "number") continue;
    if (!Number.isInteger(row.points) || row.points < 0 || row.points > 100) continue;
    if (typeof row.signal !== "string" || !/^[A-Z0-9_]{1,40}$/.test(row.signal)) continue;
    lines.push({
      ruleKey: typeof row.ruleKey === "string" ? row.ruleKey.slice(0, 80) : "stored",
      signal: row.signal,
      reason: row.reason.slice(0, 300),
      points: row.points,
      evidence: typeof row.evidence === "string" ? row.evidence.slice(0, 500) : null,
      sourceUrl: typeof row.sourceUrl === "string" ? row.sourceUrl.slice(0, 500) : null,
    });
  }
  return lines;
}

function companyWhere(
  workspaceId: string,
  filters: FindClientsFilters,
): Prisma.CompanyWhereInput {
  const and: Prisma.CompanyWhereInput[] = [
    { workspaceId, archivedAt: null, resolutionState: "RESOLVED" },
  ];

  if (filters.industry) {
    and.push({ industry: { contains: filters.industry, mode: "insensitive" } });
  }
  if (filters.businessType) {
    and.push({ industry: { contains: filters.businessType, mode: "insensitive" } });
  }
  if (filters.location) {
    and.push({
      OR: [
        { city: { equals: filters.location, mode: "insensitive" } },
        { region: { equals: filters.location, mode: "insensitive" } },
        { country: { equals: filters.location, mode: "insensitive" } },
      ],
    });
  }
  if (filters.websiteStatus === "present") {
    and.push({ website: { not: null } });
    and.push({ NOT: { website: "" } });
  }
  if (filters.websiteStatus === "missing") {
    and.push({ signals: { some: { type: "WEBSITE_MISSING", status: "ACTIVE" } } });
  }
  if (filters.websiteStatus === "unknown") {
    and.push({ OR: [{ website: null }, { website: "" }] });
    and.push({ signals: { none: { type: "WEBSITE_MISSING", status: "ACTIVE" } } });
    and.push({ observations: { none: { field: "website", supersededAt: null } } });
  }
  if (filters.freshness === "never") and.push({ researchStatus: "NEVER" });
  if (filters.freshness === "stale") and.push({ researchStatus: "STALE" });
  if (filters.freshness === "fresh") {
    and.push({ researchStatus: { in: ["RESEARCHED", "PARTIAL"] } });
  }
  if (filters.leadStatus === "NONE") {
    and.push({ leads: { none: { deletedAt: null } } });
  } else if (filters.leadStatus) {
    and.push({
      leads: { some: { status: filters.leadStatus, deletedAt: null } },
    });
  }
  if (filters.source) {
    and.push({
      observations: {
        some: {
          supersededAt: null,
          source: { name: { equals: filters.source, mode: "insensitive" } },
        },
      },
    });
  }

  return { AND: and };
}

function opportunityWhere(
  workspaceId: string,
  filters: FindClientsFilters,
): Prisma.OpportunityWhereInput {
  const serviceKeys = filters.serviceKey
    ? [filters.serviceKey]
    : filters.serviceCategory
      ? serviceKeysFor(filters.serviceCategory)
      : null;

  return {
    workspaceId,
    status: { in: ["OPEN", "PURSUED"] },
    ...(filters.minScore !== null ? { score: { gte: filters.minScore } } : {}),
    ...(serviceKeys ? { serviceKey: { in: serviceKeys } } : {}),
    company: companyWhere(workspaceId, filters),
    ...(filters.signalType !== null || filters.minConfidence !== null
      ? {
          signals: {
            some: {
              status: "ACTIVE",
              ...(filters.signalType ? { type: filters.signalType } : {}),
              ...(filters.minConfidence !== null
                ? { confidence: { gte: filters.minConfidence } }
                : {}),
            },
          },
        }
      : {}),
  };
}

function serviceKeysFor(category: NonNullable<FindClientsFilters["serviceCategory"]>): string[] {
  return SERVICE_KEYS.filter((key) => getService(key)?.category === category);
}

function toRow(opportunity: {
  id: string;
  serviceKey: string;
  status: string;
  score: number;
  summary: string | null;
  recommendedAction: string | null;
  detectedAt: Date;
  rationale: unknown;
  company: {
    id: string;
    name: string;
    industry: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    website: string | null;
    lastResearchAt: Date | null;
    researchStatus: ResearchStatus;
    leads: Array<{ id: string; status: string; score: number }>;
  };
  signals: Array<{
    id: string;
    type: SignalType;
    confidence: number;
    summary: string;
    evidence: string | null;
    sourceUrl: string | null;
    lastSeenAt: Date;
    status: string;
  }>;
}): FindClientRow {
  const rationale = readRationale(opportunity.rationale);
  const active = opportunity.signals.filter((signal) => signal.status === "ACTIVE");
  const confidence = active.reduce<number | null>(
    (best, signal) => (best === null || signal.confidence > best ? signal.confidence : best),
    null,
  );
  const label = serviceLabel(opportunity.serviceKey);
  const evidence: FindClientEvidence[] = [
    ...active.map((signal) => ({
      kind: "signal" as const,
      id: signal.id,
      label: signal.type.toLowerCase().replaceAll("_", " "),
      text: signal.evidence ?? signal.summary,
      sourceUrl: signal.sourceUrl,
      sourceName: null,
      confidence: signal.confidence,
      observedAt: signal.lastSeenAt.toISOString(),
    })),
    ...rationale.map((line, index) => ({
      kind: "rationale" as const,
      id: `${opportunity.id}:${line.ruleKey}:${index}`,
      label: line.reason,
      text: line.evidence,
      sourceUrl: line.sourceUrl,
      sourceName: null,
      confidence: null,
      observedAt: null,
    })),
  ];

  const lead = opportunity.company.leads[0] ?? null;

  return {
    company: {
      id: opportunity.company.id,
      name: opportunity.company.name,
      industry: opportunity.company.industry,
      city: opportunity.company.city,
      region: opportunity.company.region,
      country: opportunity.company.country,
      website: opportunity.company.website,
      lastResearchAt: opportunity.company.lastResearchAt?.toISOString() ?? null,
      researchStatus: opportunity.company.researchStatus,
    },
    opportunity: {
      id: opportunity.id,
      serviceKey: opportunity.serviceKey,
      serviceLabel: label,
      status: opportunity.status,
      score: opportunity.score,
      summary: opportunity.summary,
      recommendedAction: opportunity.recommendedAction,
      detectedAt: opportunity.detectedAt.toISOString(),
    },
    evidence,
    confidence,
    scoreExplanation: [
      `${label}: ${opportunity.score}/100 from stored opportunity rules.`,
      ...rationale.map((line) => `+${line.points} — ${line.reason}`),
    ],
    lead: lead ? { id: lead.id, status: lead.status, score: lead.score } : null,
  };
}

const include = {
  company: {
    select: {
      id: true,
      name: true,
      industry: true,
      city: true,
      region: true,
      country: true,
      website: true,
      lastResearchAt: true,
      researchStatus: true,
      leads: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" as const },
        take: 1,
        select: { id: true, status: true, score: true },
      },
    },
  },
  signals: {
    select: {
      id: true,
      type: true,
      confidence: true,
      summary: true,
      evidence: true,
      sourceUrl: true,
      lastSeenAt: true,
      status: true,
    },
  },
} satisfies Prisma.OpportunityInclude;

/**
 * One page of existing opportunities. Does not call AI and does not write.
 */
export async function searchFindClients(
  workspaceId: string,
  filters: FindClientsFilters,
  page = 1,
): Promise<FindClientsPage> {
  const safePage = Math.min(FIND_CLIENTS_MAX_PAGE, Math.max(1, page));
  const where = opportunityWhere(workspaceId, filters);
  const skip = (safePage - 1) * FIND_CLIENTS_PAGE_SIZE;

  const [total, rows] = await Promise.all([
    db.opportunity.count({ where }),
    db.opportunity.findMany({
      where,
      include,
      orderBy: [{ score: "desc" }, { company: { name: "asc" } }, { serviceKey: "asc" }],
      skip,
      take: FIND_CLIENTS_PAGE_SIZE,
    }),
  ]);

  return {
    total,
    page: safePage,
    pageSize: FIND_CLIENTS_PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / FIND_CLIENTS_PAGE_SIZE)),
    results: rows.map(toRow),
  };
}

export interface FindClientDetail extends FindClientRow {
  observations: FindClientEvidence[];
  research: Array<{
    id: string;
    aspect: string;
    status: string;
    sourceUrl: string | null;
    completedAt: string | null;
    factsFound: number;
  }>;
}

/**
 * One company and one of its opportunities, or null when it is not in this
 * workspace. Archived and unresolved companies are not offered as prospects.
 */
export async function getFindClientDetail(
  workspaceId: string,
  companyId: string,
  serviceKey?: string,
): Promise<FindClientDetail | null> {
  const opportunity = await db.opportunity.findFirst({
    where: {
      workspaceId,
      companyId,
      ...(serviceKey ? { serviceKey } : { status: { in: ["OPEN", "PURSUED"] } }),
      company: { workspaceId, archivedAt: null, resolutionState: "RESOLVED" },
    },
    orderBy: [{ score: "desc" }, { serviceKey: "asc" }],
    include,
  });
  if (opportunity === null) return null;

  const [observations, research] = await Promise.all([
    db.observation.findMany({
      where: { workspaceId, companyId, supersededAt: null },
      orderBy: { observedAt: "desc" },
      take: 20,
      include: { source: { select: { name: true } } },
    }),
    db.researchRun.findMany({
      where: { workspaceId, companyId },
      orderBy: { startedAt: "desc" },
      take: 12,
      select: {
        id: true,
        aspect: true,
        status: true,
        sourceUrl: true,
        completedAt: true,
        factsFound: true,
      },
    }),
  ]);

  const row = toRow(opportunity);
  return {
    ...row,
    observations: observations.map((observation) => ({
      kind: "observation",
      id: observation.id,
      label: observation.field,
      text: observation.evidence ?? observation.value,
      sourceUrl: observation.sourceUrl,
      sourceName: observation.source?.name ?? null,
      confidence: observation.confidence,
      observedAt: observation.observedAt.toISOString(),
    })),
    research: research.map((run) => ({
      id: run.id,
      aspect: run.aspect,
      status: run.status,
      sourceUrl: run.sourceUrl,
      completedAt: run.completedAt?.toISOString() ?? null,
      factsFound: run.factsFound,
    })),
  };
}

export type { LeadPresence };
