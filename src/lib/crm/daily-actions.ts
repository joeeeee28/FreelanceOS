import "server-only";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { todayRangeInZone } from "@/lib/time/zoned";

/**
 * Deterministic "what should I do today to generate revenue?" engine.
 *
 * Every action is derived from a real database row. Nothing is invented: if
 * the workspace has no records, the result is an empty list and the UI shows
 * an honest empty state.
 *
 * There is no AI and no randomness — given the same rows and the same instant,
 * the output is identical, which is what makes it testable.
 */

export type ActionPriority = "URGENT" | "HIGH" | "MEDIUM" | "LOW";

export type ActionType =
  | "OVERDUE_FOLLOW_UP"
  | "FOLLOW_UP_DUE_TODAY"
  | "DISCOVERY_CALL_TODAY"
  | "RESPONDED_LEAD_NEEDS_ACTION"
  | "PROPOSAL_STAGE_FOLLOW_UP"
  | "OVERDUE_TASK"
  | "HIGH_SCORE_UNCONTACTED_LEAD"
  | "NEW_QUALIFIED_LEAD";

export interface DailyAction {
  type: ActionType;
  priority: ActionPriority;
  title: string;
  description: string;
  leadId?: string;
  contactId?: string;
  taskId?: string;
  followUpId?: string;
  dueAt?: Date;
}

/**
 * Ordering weights.
 *
 * Rationale: a commitment already missed (overdue follow-up) outranks one due
 * now; live conversations (a prospect who replied, a call today) outrank cold
 * opportunities; and unworked leads come last because nobody is waiting on us.
 */
const PRIORITY_RANK: Record<ActionPriority, number> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

const TYPE_RANK: Record<ActionType, number> = {
  OVERDUE_FOLLOW_UP: 0,
  DISCOVERY_CALL_TODAY: 1,
  FOLLOW_UP_DUE_TODAY: 2,
  RESPONDED_LEAD_NEEDS_ACTION: 3,
  PROPOSAL_STAGE_FOLLOW_UP: 4,
  OVERDUE_TASK: 5,
  HIGH_SCORE_UNCONTACTED_LEAD: 6,
  NEW_QUALIFIED_LEAD: 7,
};

/** A lead at or above this score is worth chasing before the rest. */
export const HIGH_SCORE_THRESHOLD = 50;

/** Caps per category so one noisy bucket cannot bury everything else. */
const PER_CATEGORY_LIMIT = 10;

export async function getDailyActions(now: Date = new Date()): Promise<DailyAction[]> {
  const { workspaceId, workspace } = await requireUser();
  const { start, end } = todayRangeInZone(workspace.timezone, now);

  const leadRef = { select: { id: true, companyName: true } };

  // One round trip per category, scoped and limited at the database rather
  // than fetching everything and filtering in JavaScript.
  const [
    overdueFollowUps,
    todaysFollowUps,
    discoveryCallsToday,
    respondedLeads,
    proposalLeads,
    overdueTasks,
    highScoreUncontacted,
    newlyQualified,
  ] = await Promise.all([
    db.followUp.findMany({
      where: { workspaceId, status: "SCHEDULED", scheduledAt: { lt: start } },
      include: { lead: leadRef },
      orderBy: { scheduledAt: "asc" },
      take: PER_CATEGORY_LIMIT,
    }),
    db.followUp.findMany({
      where: {
        workspaceId,
        status: "SCHEDULED",
        scheduledAt: { gte: start, lt: end },
      },
      include: { lead: leadRef },
      orderBy: { scheduledAt: "asc" },
      take: PER_CATEGORY_LIMIT,
    }),
    db.task.findMany({
      where: {
        workspaceId,
        status: { in: ["TODO", "IN_PROGRESS"] },
        dueAt: { gte: start, lt: end },
        lead: { status: "DISCOVERY_CALL", deletedAt: null },
      },
      include: { lead: leadRef },
      orderBy: { dueAt: "asc" },
      take: PER_CATEGORY_LIMIT,
    }),
    db.lead.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: "RESPONDED",
        // Nothing already scheduled to handle the reply.
        followUps: { none: { status: "SCHEDULED" } },
      },
      orderBy: { score: "desc" },
      take: PER_CATEGORY_LIMIT,
    }),
    db.lead.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: { in: ["PROPOSAL", "NEGOTIATION"] },
        followUps: { none: { status: "SCHEDULED" } },
      },
      orderBy: { score: "desc" },
      take: PER_CATEGORY_LIMIT,
    }),
    db.task.findMany({
      where: {
        workspaceId,
        status: { in: ["TODO", "IN_PROGRESS"] },
        dueAt: { lt: start },
      },
      include: { lead: leadRef },
      orderBy: { dueAt: "asc" },
      take: PER_CATEGORY_LIMIT,
    }),
    db.lead.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: { in: ["QUALIFIED", "OUTREACH_READY"] },
        score: { gte: HIGH_SCORE_THRESHOLD },
      },
      orderBy: { score: "desc" },
      take: PER_CATEGORY_LIMIT,
    }),
    db.lead.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: "QUALIFIED",
        score: { lt: HIGH_SCORE_THRESHOLD },
      },
      orderBy: { updatedAt: "desc" },
      take: PER_CATEGORY_LIMIT,
    }),
  ]);

  const actions: DailyAction[] = [];

  for (const followUp of overdueFollowUps) {
    actions.push({
      type: "OVERDUE_FOLLOW_UP",
      priority: "URGENT",
      title: `Overdue follow-up: ${followUp.lead.companyName}`,
      description: `${followUp.sequence} via ${followUp.channel} was due earlier.`,
      leadId: followUp.leadId,
      contactId: followUp.contactId ?? undefined,
      followUpId: followUp.id,
      dueAt: followUp.scheduledAt,
    });
  }

  for (const task of discoveryCallsToday) {
    actions.push({
      type: "DISCOVERY_CALL_TODAY",
      priority: "URGENT",
      title: `Discovery call today: ${task.lead?.companyName ?? "Lead"}`,
      description: task.title,
      leadId: task.leadId ?? undefined,
      taskId: task.id,
      dueAt: task.dueAt ?? undefined,
    });
  }

  for (const followUp of todaysFollowUps) {
    actions.push({
      type: "FOLLOW_UP_DUE_TODAY",
      priority: "HIGH",
      title: `Follow up today: ${followUp.lead.companyName}`,
      description: `${followUp.sequence} via ${followUp.channel}.`,
      leadId: followUp.leadId,
      contactId: followUp.contactId ?? undefined,
      followUpId: followUp.id,
      dueAt: followUp.scheduledAt,
    });
  }

  for (const lead of respondedLeads) {
    actions.push({
      type: "RESPONDED_LEAD_NEEDS_ACTION",
      priority: "HIGH",
      title: `${lead.companyName} replied — no next step booked`,
      description: "Schedule a follow-up or a discovery call while it is warm.",
      leadId: lead.id,
    });
  }

  for (const lead of proposalLeads) {
    actions.push({
      type: "PROPOSAL_STAGE_FOLLOW_UP",
      priority: "HIGH",
      title: `Chase ${lead.companyName}`,
      description: `At ${lead.status.toLowerCase()} stage with nothing scheduled.`,
      leadId: lead.id,
    });
  }

  for (const task of overdueTasks) {
    actions.push({
      type: "OVERDUE_TASK",
      priority: task.priority === "URGENT" ? "URGENT" : "MEDIUM",
      title: `Overdue task: ${task.title}`,
      description: task.lead?.companyName ?? "General task",
      leadId: task.leadId ?? undefined,
      taskId: task.id,
      dueAt: task.dueAt ?? undefined,
    });
  }

  for (const lead of highScoreUncontacted) {
    actions.push({
      type: "HIGH_SCORE_UNCONTACTED_LEAD",
      priority: "MEDIUM",
      title: `Reach out to ${lead.companyName}`,
      description: `Scores ${lead.score}/100 and has not been contacted yet.`,
      leadId: lead.id,
    });
  }

  for (const lead of newlyQualified) {
    actions.push({
      type: "NEW_QUALIFIED_LEAD",
      priority: "LOW",
      title: `Plan outreach for ${lead.companyName}`,
      description: "Qualified but not yet ready for outreach.",
      leadId: lead.id,
    });
  }

  return sortActions(actions);
}

/**
 * Stable deterministic ordering: priority, then category, then the earliest
 * due date, then lead id as a final tie-break so equal rows never reorder
 * between runs.
 */
export function sortActions(actions: DailyAction[]): DailyAction[] {
  return [...actions].sort((a, b) => {
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (byPriority !== 0) return byPriority;

    const byType = TYPE_RANK[a.type] - TYPE_RANK[b.type];
    if (byType !== 0) return byType;

    const aDue = a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bDue = b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (aDue !== bDue) return aDue - bDue;

    return (a.leadId ?? "").localeCompare(b.leadId ?? "");
  });
}
