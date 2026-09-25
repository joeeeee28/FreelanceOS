import "server-only";
import type { LeadStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { todayRangeInZone } from "@/lib/time/zoned";
import { getDailyActions } from "./daily-actions";
import { ALL_LEAD_STATUSES } from "./pipeline";

/**
 * Dashboard figures.
 *
 * Counts are produced by database aggregates (`count`/`groupBy`) rather than
 * loading rows into JavaScript, so the dashboard cost does not grow with the
 * size of the workspace.
 */
export async function getDashboard() {
  const { workspaceId, workspace } = await requireUser();

  const now = new Date();

  // "Today" is the workspace's calendar day, not the server's.
  const { start: todayStart, end: tomorrow } = todayRangeInZone(
    workspace.timezone,
    now,
  );

  const activeStatuses: LeadStatus[] = [
    "QUALIFIED",
    "OUTREACH_READY",
    "CONTACTED",
    "RESPONDED",
    "DISCOVERY_CALL",
    "PROPOSAL",
    "NEGOTIATION",
  ];

  const [
    statusCounts,
    totalLeads,
    followUpsDue,
    overdueFollowUps,
    openTasks,
    scoreStats,
    actions,
  ] = await Promise.all([
    // One grouped query replaces the eight separate count queries this used
    // to run.
    db.lead.groupBy({
      by: ["status"],
      where: { workspaceId, deletedAt: null },
      _count: { _all: true },
    }),
    db.lead.count({ where: { workspaceId, deletedAt: null } }),
    db.followUp.count({
      where: { workspaceId, status: "SCHEDULED", scheduledAt: { lt: tomorrow } },
    }),
    db.followUp.count({
      where: { workspaceId, status: "SCHEDULED", scheduledAt: { lt: todayStart } },
    }),
    db.task.count({
      where: { workspaceId, status: { in: ["TODO", "IN_PROGRESS"] } },
    }),
    db.lead.aggregate({
      where: { workspaceId, deletedAt: null },
      _avg: { score: true },
      _max: { score: true },
    }),
    getDailyActions(now),
  ]);

  const byStatus = new Map<LeadStatus, number>(
    statusCounts.map((row) => [row.status, row._count._all]),
  );

  const countOf = (status: LeadStatus) => byStatus.get(status) ?? 0;

  return {
    timezone: workspace.timezone,

    /**
     * Per-status counts for every status, so the pipeline snapshot and the
     * conversion funnel can be rendered without extra queries. Statuses with
     * no leads are present with a zero rather than omitted, which keeps the
     * board shape stable on an empty workspace.
     */
    statusCounts: Object.fromEntries(
      ALL_LEAD_STATUSES.map((status) => [status, countOf(status)]),
    ) as Record<LeadStatus, number>,

    metrics: {
      totalLeads,
      qualified: countOf("QUALIFIED"),
      active: activeStatuses.reduce(
        (total, status) => total + countOf(status),
        0,
      ),
      followUpsDue,
      overdueFollowUps,
      discoveryCalls: countOf("DISCOVERY_CALL"),
      proposals: countOf("PROPOSAL"),
      negotiation: countOf("NEGOTIATION"),
      won: countOf("WON"),
      lost: countOf("LOST"),
      openTasks,
      averageScore: Math.round(scoreStats._avg.score ?? 0),
      topScore: scoreStats._max.score ?? 0,
    },

    actions,
  };
}
