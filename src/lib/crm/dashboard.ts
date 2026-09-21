import "server-only";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { todayRangeInZone } from "@/lib/time/zoned";

export async function getDashboard() {
  const { workspaceId, workspace } = await requireUser();

  const now = new Date();

  // "Today" is the workspace's calendar day, not the server's. Previously
  // setHours(0,0,0,0) used the host timezone, so the dashboard showed the
  // wrong day's follow-ups whenever the host was not in the user's zone.
  const { start: todayStart, end: tomorrow } = todayRangeInZone(
    workspace.timezone,
    now,
  );

  const [
    totalLeads,
    qualified,
    active,
    followUpsDue,
    discoveryCalls,
    proposals,
    won,
    lost,
    todaysFollowUps,
    overdueTasks,
    recentLeads,
  ] = await Promise.all([
    db.lead.count({
      where: { workspaceId, deletedAt: null },
    }),

    db.lead.count({
      where: {
        workspaceId,
        deletedAt: null,
        status: "QUALIFIED",
      },
    }),

    db.lead.count({
      where: {
        workspaceId,
        deletedAt: null,
        status: {
          in: [
            "QUALIFIED",
            "OUTREACH_READY",
            "CONTACTED",
            "RESPONDED",
            "DISCOVERY_CALL",
            "PROPOSAL",
            "NEGOTIATION",
          ],
        },
      },
    }),

    db.followUp.count({
      where: {
        workspaceId,
        status: "SCHEDULED",
        scheduledAt: { lt: tomorrow },
      },
    }),

    db.lead.count({
      where: {
        workspaceId,
        deletedAt: null,
        status: "DISCOVERY_CALL",
      },
    }),

    db.lead.count({
      where: {
        workspaceId,
        deletedAt: null,
        status: "PROPOSAL",
      },
    }),

    db.lead.count({
      where: {
        workspaceId,
        deletedAt: null,
        status: "WON",
      },
    }),

    db.lead.count({
      where: {
        workspaceId,
        deletedAt: null,
        status: "LOST",
      },
    }),

    db.followUp.findMany({
      where: {
        workspaceId,
        status: "SCHEDULED",
        scheduledAt: {
          gte: todayStart,
          lt: tomorrow,
        },
      },
      include: { lead: true },
      orderBy: { scheduledAt: "asc" },
    }),

    db.task.findMany({
      where: {
        workspaceId,
        status: {
          in: ["TODO", "IN_PROGRESS"],
        },
        dueAt: {
          lt: now,
        },
      },
      include: { lead: true },
      orderBy: { dueAt: "asc" },
    }),

    db.lead.findMany({
      where: {
        workspaceId,
        deletedAt: null,
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
  ]);

  return {
    timezone: workspace.timezone,

    metrics: {
      totalLeads,
      qualified,
      active,
      followUpsDue,
      discoveryCalls,
      proposals,
      won,
      lost,
    },
    todaysFollowUps,
    overdueTasks,
    recentLeads,
  };
}
