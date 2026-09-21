import "server-only";
import type {
  FollowUpChannel,
  FollowUpSequence,
  FollowUpStatus,
  Prisma,
} from "@prisma/client";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { followUpSchema, followUpUpdateSchema } from "./validation";
import { notFound } from "./errors";
import { normalisePaging } from "./leads";
import { todayRangeInZone } from "@/lib/time/zoned";

export interface FollowUpFilters {
  status?: FollowUpStatus;
  channel?: FollowUpChannel;
  sequence?: FollowUpSequence;
  leadId?: string;
  due?: "overdue" | "today" | "upcoming";
  page?: number;
  pageSize?: number;
}

export async function listFollowUps(filters: FollowUpFilters = {}) {
  const { workspaceId, workspace } = await requireUser();
  const { page, pageSize, skip } = normalisePaging(filters.page, filters.pageSize);

  // Due buckets are evaluated against the workspace's calendar day.
  const { start, end } = todayRangeInZone(workspace.timezone);

  const dueFilter: Prisma.FollowUpWhereInput =
    filters.due === "overdue"
      ? { scheduledAt: { lt: start }, status: "SCHEDULED" }
      : filters.due === "today"
        ? { scheduledAt: { gte: start, lt: end } }
        : filters.due === "upcoming"
          ? { scheduledAt: { gte: end } }
          : {};

  const where: Prisma.FollowUpWhereInput = {
    workspaceId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.channel ? { channel: filters.channel } : {}),
    ...(filters.sequence ? { sequence: filters.sequence } : {}),
    ...(filters.leadId ? { leadId: filters.leadId } : {}),
    ...dueFilter,
  };

  const [items, total] = await Promise.all([
    db.followUp.findMany({
      where,
      include: {
        lead: { select: { id: true, companyName: true } },
        contact: { select: { id: true, fullName: true } },
      },
      orderBy: [{ status: "asc" }, { scheduledAt: "asc" }],
      skip,
      take: pageSize,
    }),
    db.followUp.count({ where }),
  ]);

  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(Math.ceil(total / pageSize), 1),
  };
}

export async function createFollowUp(input: unknown) {
  const { workspaceId, userId } = await requireUser();

  const data = followUpSchema.parse(input);

  return db.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id: data.leadId, workspaceId, deletedAt: null },
    });

    if (!lead) throw notFound("Lead");

    if (data.contactId) {
      const contact = await tx.contact.findFirst({
        where: { id: data.contactId, workspaceId, leadId: lead.id },
      });

      if (!contact) throw notFound("Contact");
    }

    const followUp = await tx.followUp.create({
      data: { ...data, workspaceId },
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        contactId: data.contactId,
        type: "FOLLOW_UP_SCHEDULED",
        title: `Follow-up scheduled (${followUp.sequence})`,
        description: `${followUp.channel}`,
        metadata: {
          channel: followUp.channel,
          sequence: followUp.sequence,
          scheduledAt: followUp.scheduledAt.toISOString(),
        },
        createdByUserId: userId,
      },
    });

    return followUp;
  });
}

/** Reschedules or edits a scheduled follow-up. */
export async function updateFollowUp(id: string, input: unknown) {
  const { workspaceId, userId } = await requireUser();

  const data = followUpUpdateSchema.parse(input);

  return db.$transaction(async (tx) => {
    const existing = await tx.followUp.findFirst({ where: { id, workspaceId } });
    if (!existing) throw notFound("Follow-up");

    if (data.contactId) {
      const contact = await tx.contact.findFirst({
        where: { id: data.contactId, workspaceId, leadId: existing.leadId },
      });
      if (!contact) throw notFound("Contact");
    }

    const followUp = await tx.followUp.update({
      where: { id: existing.id },
      data,
    });

    const rescheduled =
      data.scheduledAt !== undefined &&
      data.scheduledAt.getTime() !== existing.scheduledAt.getTime();

    if (rescheduled) {
      await tx.activity.create({
        data: {
          workspaceId,
          leadId: followUp.leadId,
          contactId: followUp.contactId,
          type: "FOLLOW_UP_SCHEDULED",
          title: "Follow-up rescheduled",
          metadata: {
            from: existing.scheduledAt.toISOString(),
            to: followUp.scheduledAt.toISOString(),
          },
          createdByUserId: userId,
        },
      });
    }

    return followUp;
  });
}

export async function completeFollowUp(id: string) {
  const { workspaceId, userId } = await requireUser();

  return db.$transaction(async (tx) => {
    const existing = await tx.followUp.findFirst({ where: { id, workspaceId } });
    if (!existing) throw notFound("Follow-up");

    if (existing.status === "COMPLETED") return existing;

    const result = await tx.followUp.update({
      where: { id: existing.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: existing.leadId,
        contactId: existing.contactId,
        type: "FOLLOW_UP_COMPLETED",
        title: `Follow-up completed (${existing.sequence})`,
        description: existing.channel,
        createdByUserId: userId,
      },
    });

    return result;
  });
}

export async function cancelFollowUp(id: string) {
  const { workspaceId, userId } = await requireUser();

  return db.$transaction(async (tx) => {
    const existing = await tx.followUp.findFirst({ where: { id, workspaceId } });
    if (!existing) throw notFound("Follow-up");

    if (existing.status === "CANCELLED") return existing;

    const result = await tx.followUp.update({
      where: { id: existing.id },
      data: { status: "CANCELLED", completedAt: null },
    });

    // The activity model has no dedicated cancellation type, so OTHER is used
    // with an explicit title rather than inventing an enum value.
    await tx.activity.create({
      data: {
        workspaceId,
        leadId: existing.leadId,
        contactId: existing.contactId,
        type: "OTHER",
        title: "Follow-up cancelled",
        description: `${existing.sequence} · ${existing.channel}`,
        createdByUserId: userId,
      },
    });

    return result;
  });
}
