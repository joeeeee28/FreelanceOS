import "server-only";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { followUpSchema } from "./validation";

export async function listFollowUps() {
  const { workspaceId } = await requireUser();

  return db.followUp.findMany({
    where: { workspaceId },
    include: {
      lead: {
        select: {
          id: true,
          companyName: true,
        },
      },
      contact: true,
    },
    orderBy: { scheduledAt: "asc" },
  });
}

export async function createFollowUp(input: unknown) {
  const { workspaceId, userId } =
    await requireUser();

  const data = followUpSchema.parse(input);

  return db.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: {
        id: data.leadId,
        workspaceId,
        deletedAt: null,
      },
    });

    if (!lead) throw new Error("NOT_FOUND");

    if (data.contactId) {
      const contact = await tx.contact.findFirst({
        where: {
          id: data.contactId,
          workspaceId,
          leadId: lead.id,
        },
      });

      if (!contact) throw new Error("NOT_FOUND");
    }

    const followUp = await tx.followUp.create({
      data: {
        ...data,
        workspaceId,
      },
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        contactId: data.contactId,
        type: "FOLLOW_UP_SCHEDULED",
        title: "Follow-up scheduled",
        createdByUserId: userId,
      },
    });

    return followUp;
  });
}

export async function completeFollowUp(id: string) {
  const { workspaceId, userId } =
    await requireUser();

  return db.$transaction(async (tx) => {
    const existing = await tx.followUp.findFirst({
      where: {
        id,
        workspaceId,
      },
    });

    if (!existing) throw new Error("NOT_FOUND");

    const result = await tx.followUp.update({
      where: { id: existing.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: existing.leadId,
        contactId: existing.contactId,
        type: "FOLLOW_UP_COMPLETED",
        title: "Follow-up completed",
        createdByUserId: userId,
      },
    });

    return result;
  });
}
