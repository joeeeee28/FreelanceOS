import "server-only";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";

export async function getDashboard() {
  const { workspaceId } = await requireUser();

  const now = new Date();

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const tomorrow = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);

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
