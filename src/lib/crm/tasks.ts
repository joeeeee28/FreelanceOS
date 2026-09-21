import "server-only";
import type { Prisma, TaskPriority, TaskStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { taskSchema, taskUpdateSchema } from "./validation";
import { notFound } from "./errors";
import { normalisePaging } from "./leads";

export interface TaskFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
  leadId?: string;
  /** Relative due-date bucket, evaluated in the workspace timezone. */
  due?: "overdue" | "today" | "upcoming" | "none";
  page?: number;
  pageSize?: number;
}

export async function listTasks(filters: TaskFilters = {}) {
  const { workspaceId, workspace } = await requireUser();
  const { page, pageSize, skip } = normalisePaging(filters.page, filters.pageSize);

  // "Today" is the workspace's calendar day, never the server's.
  const { todayRangeInZone } = await import("@/lib/time/zoned");
  const { start, end } = todayRangeInZone(workspace.timezone);

  const dueFilter: Prisma.TaskWhereInput =
    filters.due === "overdue"
      ? { dueAt: { lt: start }, status: { in: ["TODO", "IN_PROGRESS"] } }
      : filters.due === "today"
        ? { dueAt: { gte: start, lt: end } }
        : filters.due === "upcoming"
          ? { dueAt: { gte: end } }
          : filters.due === "none"
            ? { dueAt: null }
            : {};

  const where: Prisma.TaskWhereInput = {
    workspaceId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.priority ? { priority: filters.priority } : {}),
    ...(filters.leadId ? { leadId: filters.leadId } : {}),
    ...dueFilter,
  };

  const [items, total] = await Promise.all([
    db.task.findMany({
      where,
      include: {
        lead: { select: { id: true, companyName: true } },
        contact: { select: { id: true, fullName: true } },
      },
      orderBy: [{ status: "asc" }, { dueAt: "asc" }, { priority: "desc" }],
      skip,
      take: pageSize,
    }),
    db.task.count({ where }),
  ]);

  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(Math.ceil(total / pageSize), 1),
  };
}

/** Verifies that any referenced lead/contact belongs to the caller. */
async function assertRelations(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  workspaceId: string,
  leadId?: string | null,
  contactId?: string | null,
) {
  if (leadId) {
    const lead = await tx.lead.findFirst({
      where: { id: leadId, workspaceId, deletedAt: null },
    });
    if (!lead) throw notFound("Lead");
  }

  if (contactId) {
    const contact = await tx.contact.findFirst({
      where: { id: contactId, workspaceId, ...(leadId ? { leadId } : {}) },
    });
    if (!contact) throw notFound("Contact");
  }
}

export async function createTask(input: unknown) {
  const { workspaceId, userId } = await requireUser();

  const data = taskSchema.parse(input);

  return db.$transaction(async (tx) => {
    await assertRelations(tx, workspaceId, data.leadId, data.contactId);

    const task = await tx.task.create({
      data: { ...data, workspaceId, createdByUserId: userId },
    });

    // Activities hang off a lead/contact, so a standalone task has nowhere to
    // record one.
    if (task.leadId) {
      await tx.activity.create({
        data: {
          workspaceId,
          leadId: task.leadId,
          contactId: task.contactId,
          type: "TASK_CREATED",
          title: "Task created",
          description: task.title,
          createdByUserId: userId,
        },
      });
    }

    return task;
  });
}

export async function updateTask(id: string, input: unknown) {
  const { workspaceId, userId } = await requireUser();

  const data = taskUpdateSchema.parse(input);

  return db.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({ where: { id, workspaceId } });
    if (!existing) throw notFound("Task");

    await assertRelations(
      tx,
      workspaceId,
      data.leadId ?? existing.leadId,
      data.contactId ?? existing.contactId,
    );

    // Keep completedAt consistent with any status change made here.
    const completedAt =
      data.status === undefined
        ? existing.completedAt
        : data.status === "DONE"
          ? (existing.completedAt ?? new Date())
          : null;

    const task = await tx.task.update({
      where: { id: existing.id },
      data: { ...data, completedAt },
    });

    if (task.leadId && data.status === "DONE" && existing.status !== "DONE") {
      await tx.activity.create({
        data: {
          workspaceId,
          leadId: task.leadId,
          contactId: task.contactId,
          type: "TASK_COMPLETED",
          title: "Task completed",
          description: task.title,
          createdByUserId: userId,
        },
      });
    }

    return task;
  });
}

/** Marks a task done and records the completion on the lead timeline. */
export async function completeTask(id: string) {
  const { workspaceId, userId } = await requireUser();

  return db.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({ where: { id, workspaceId } });
    if (!existing) throw notFound("Task");

    if (existing.status === "DONE") return existing;

    const task = await tx.task.update({
      where: { id: existing.id },
      data: { status: "DONE", completedAt: new Date() },
    });

    if (task.leadId) {
      await tx.activity.create({
        data: {
          workspaceId,
          leadId: task.leadId,
          contactId: task.contactId,
          type: "TASK_COMPLETED",
          title: "Task completed",
          description: task.title,
          createdByUserId: userId,
        },
      });
    }

    return task;
  });
}

export async function cancelTask(id: string) {
  const { workspaceId, userId } = await requireUser();

  return db.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({ where: { id, workspaceId } });
    if (!existing) throw notFound("Task");

    if (existing.status === "CANCELLED") return existing;

    const task = await tx.task.update({
      where: { id: existing.id },
      data: { status: "CANCELLED", completedAt: null },
    });

    if (task.leadId) {
      await tx.activity.create({
        data: {
          workspaceId,
          leadId: task.leadId,
          contactId: task.contactId,
          type: "OTHER",
          title: "Task cancelled",
          description: task.title,
          createdByUserId: userId,
        },
      });
    }

    return task;
  });
}
