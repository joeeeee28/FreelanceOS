import "server-only";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { taskSchema } from "./validation";

export async function listTasks() {
  const { workspaceId } = await requireUser();

  return db.task.findMany({
    where: { workspaceId },
    include: {
      lead: {
        select: {
          id: true,
          companyName: true,
        },
      },
    },
    orderBy: [
      { dueAt: "asc" },
      { priority: "desc" },
    ],
  });
}

export async function createTask(input: unknown) {
  const { workspaceId, userId } =
    await requireUser();

  const data = taskSchema.parse(input);

  return db.$transaction(async (tx) => {
    if (data.leadId) {
      const lead = await tx.lead.findFirst({
        where: {
          id: data.leadId,
          workspaceId,
          deletedAt: null,
        },
      });

      if (!lead) throw new Error("NOT_FOUND");
    }

    if (data.contactId) {
      const contact = await tx.contact.findFirst({
        where: {
          id: data.contactId,
          workspaceId,
          ...(data.leadId
            ? { leadId: data.leadId }
            : {}),
        },
      });

      if (!contact) throw new Error("NOT_FOUND");
    }

    const task = await tx.task.create({
      data: {
        ...data,
        workspaceId,
        createdByUserId: userId,
      },
    });

    if (data.leadId) {
      await tx.activity.create({
        data: {
          workspaceId,
          leadId: data.leadId,
          contactId: data.contactId,
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
