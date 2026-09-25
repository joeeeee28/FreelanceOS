/**
 * Discovery and intelligence statistics.
 *
 * Every number here is counted from a stored row. Nothing is estimated,
 * extrapolated or smoothed, and where there is no data the answer is null
 * rather than zero — the two mean very different things to someone deciding
 * whether the engine is working.
 */

import type { SourceStatus } from "@prisma/client";

import { db } from "@/lib/db-client";
import { diagnose, type HealthReport } from "./crawl/health";

export interface SourceHealthRow {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  status: SourceStatus;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  lastError: string | null;
  successCount: number;
  failureCount: number;
  blockedCount: number;
  health: HealthReport;
}

/**
 * Per-source health, derived from recorded FetchLog rows.
 *
 * The stored counters on Source are running totals; the diagnosis uses the
 * actual log so a source that was broken last month but works now is not
 * reported as unhealthy forever.
 */
export async function getSourceHealth(
  workspaceId: string,
  options: { windowDays?: number } = {},
): Promise<SourceHealthRow[]> {
  const windowDays = options.windowDays ?? 30;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const sources = await db.source.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
  });

  if (sources.length === 0) return [];

  const grouped = await db.fetchLog.groupBy({
    by: ["sourceId", "outcome"],
    where: { workspaceId, fetchedAt: { gte: since } },
    _count: true,
  });

  return sources.map((source) => {
    const counts = grouped
      .filter((row) => row.sourceId === source.id)
      .map((row) => ({ outcome: row.outcome, count: row._count }));

    return {
      id: source.id,
      name: source.name,
      provider: source.provider,
      enabled: source.enabled,
      status: source.status,
      lastRunAt: source.lastRunAt,
      nextRunAt: source.nextRunAt,
      lastError: source.lastError,
      successCount: source.successCount,
      failureCount: source.failureCount,
      blockedCount: source.blockedCount,
      health: diagnose(counts),
    };
  });
}

export interface DiscoveryStats {
  companies: number;
  companiesNeedingReview: number;
  signalsActive: number;
  opportunitiesOpen: number;
  knowledgeResources: number;
  /** Null when no run has ever happened, which is not the same as zero. */
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  /** Counted over the trailing window. */
  companiesDiscoveredRecently: number;
  pagesBlockedRecently: number;
  jobsPending: number;
  jobsFailed: number;
}

/** Headline counts for the dashboard. All counted, never estimated. */
export async function getDiscoveryStats(
  workspaceId: string,
  options: { windowDays?: number } = {},
): Promise<DiscoveryStats> {
  const windowDays = options.windowDays ?? 7;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [
    companies,
    companiesNeedingReview,
    signalsActive,
    opportunitiesOpen,
    knowledgeResources,
    lastRun,
    companiesDiscoveredRecently,
    pagesBlockedRecently,
    jobsPending,
    jobsFailed,
  ] = await Promise.all([
    db.company.count({ where: { workspaceId, archivedAt: null } }),
    db.company.count({ where: { workspaceId, resolutionState: "NEEDS_REVIEW" } }),
    db.signal.count({ where: { workspaceId, status: "ACTIVE" } }),
    db.opportunity.count({ where: { workspaceId, status: "OPEN", dismissedAt: null } }),
    db.knowledgeResource.count({ where: { workspaceId, archivedAt: null } }),
    db.discoveryRun.findFirst({
      where: { workspaceId },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, status: true },
    }),
    db.company.count({ where: { workspaceId, firstSeenAt: { gte: since } } }),
    db.fetchLog.count({
      where: { workspaceId, outcome: "BLOCKED", fetchedAt: { gte: since } },
    }),
    db.job.count({ where: { workspaceId, status: "PENDING" } }),
    db.job.count({ where: { workspaceId, status: "FAILED" } }),
  ]);

  return {
    companies,
    companiesNeedingReview,
    signalsActive,
    opportunitiesOpen,
    knowledgeResources,
    lastRunAt: lastRun?.startedAt ?? null,
    lastRunStatus: lastRun?.status ?? null,
    companiesDiscoveredRecently,
    pagesBlockedRecently,
    jobsPending,
    jobsFailed,
  };
}

export interface TopOpportunity {
  id: string;
  companyId: string;
  companyName: string;
  serviceKey: string;
  score: number;
  summary: string | null;
  recommendedAction: string | null;
  /** Whether this company is already being pursued as a lead. */
  leadId: string | null;
}

/**
 * The strongest open opportunities.
 *
 * Ordered by score, which is itself fully explained by each opportunity's
 * stored rationale, so nothing here is a black box.
 */
export async function getTopOpportunities(
  workspaceId: string,
  limit = 5,
): Promise<TopOpportunity[]> {
  const opportunities = await db.opportunity.findMany({
    where: {
      workspaceId,
      status: "OPEN",
      dismissedAt: null,
      company: { archivedAt: null },
    },
    include: {
      company: {
        select: {
          id: true,
          name: true,
          leads: {
            where: { deletedAt: null },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
    orderBy: [{ score: "desc" }, { detectedAt: "desc" }],
    take: limit,
  });

  return opportunities.map((opportunity) => ({
    id: opportunity.id,
    companyId: opportunity.companyId,
    companyName: opportunity.company.name,
    serviceKey: opportunity.serviceKey,
    score: opportunity.score,
    summary: opportunity.summary,
    recommendedAction: opportunity.recommendedAction,
    leadId: opportunity.company.leads[0]?.id ?? null,
  }));
}

export interface MarketSegment {
  label: string;
  count: number;
  /** Share of the sample, 0-1. */
  share: number;
}

export interface MarketIntelligence {
  /** How many companies the figures are based on. */
  sampleSize: number;
  /** True when the sample is too small to draw conclusions from. */
  sufficient: boolean;
  byIndustry: MarketSegment[];
  byCountry: MarketSegment[];
  withoutWebsite: number;
  withSocialPresence: number;
}

/**
 * The minimum sample before percentages are worth showing.
 *
 * Below this, "67% of your market has no website" means two companies out of
 * three, which is not market intelligence — it is noise with a percent sign.
 */
export const MIN_MARKET_SAMPLE = 20;

/**
 * Aggregate market picture.
 *
 * Always reports its sample size, and flags explicitly when that sample is too
 * small. The caller is expected to hide or caveat the figures accordingly
 * rather than presenting them as fact.
 */
export async function getMarketIntelligence(
  workspaceId: string,
): Promise<MarketIntelligence> {
  const where = { workspaceId, archivedAt: null };

  const [sampleSize, industries, countries, withoutWebsite, withSocial] =
    await Promise.all([
      db.company.count({ where }),
      db.company.groupBy({
        by: ["industry"],
        where: { ...where, industry: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { industry: "desc" } },
        take: 8,
      }),
      db.company.groupBy({
        by: ["country"],
        where: { ...where, country: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { country: "desc" } },
        take: 8,
      }),
      db.company.count({ where: { ...where, website: null } }),
      db.company.count({
        where: {
          ...where,
          OR: [
            { instagramUrl: { not: null } },
            { facebookUrl: { not: null } },
            { linkedinUrl: { not: null } },
          ],
        },
      }),
    ]);

  const toSegments = (
    rows: Array<{ _count: { _all: number } } & Record<string, unknown>>,
    key: string,
  ): MarketSegment[] =>
    rows.map((row) => ({
      label: String(row[key] ?? "Unknown"),
      count: row._count._all,
      // Guarded: a zero sample would make this NaN, which renders as "NaN%".
      share: sampleSize === 0 ? 0 : row._count._all / sampleSize,
    }));

  return {
    sampleSize,
    sufficient: sampleSize >= MIN_MARKET_SAMPLE,
    byIndustry: toSegments(industries, "industry"),
    byCountry: toSegments(countries, "country"),
    withoutWebsite,
    withSocialPresence: withSocial,
  };
}
