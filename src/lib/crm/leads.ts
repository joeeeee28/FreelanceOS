import "server-only";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { leadSchema } from "./validation";
import {
  PipelineStage,
  stageStatus,
} from "./pipeline";

export async function listLeads(search?: string) {
  const { workspaceId } = await requireUser();

  return db.lead.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(search
        ? {
            OR: [
              {
                companyName: {
                  contains: search,
                  mode: "insensitive",
                },
              },
              {
                contactName: {
                  contains: search,
                  mode: "insensitive",
                },
              },
              {
                email: {
                  contains: search,
                  mode: "insensitive",
                },
              },
            ],
          }
        : {}),
    },

    include: {
      activities: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      followUps: {
        where: { status: "SCHEDULED" },
        orderBy: { scheduledAt: "asc" },
        take: 1,
      },
    },

    orderBy: { updatedAt: "desc" },
  });
}

export async function getLead(id: string) {
  const { workspaceId } = await requireUser();

  return db.lead.findFirst({
    where: {
      id,
      workspaceId,
      deletedAt: null,
    },
    include: {
      contacts: true,
      activities: {
        orderBy: { createdAt: "desc" },
      },
      tasks: {
        orderBy: { createdAt: "desc" },
      },
      followUps: {
        orderBy: { scheduledAt: "asc" },
      },
    },
  });
}

export async function createLead(input: unknown) {
  const { workspaceId, userId } =
    await requireUser();

  const data = leadSchema.parse(input);

  return db.$transaction(async (tx) => {
    const lead = await tx.lead.create({
      data: {
        ...data,
        workspaceId,
      },
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        type: "LEAD_CREATED",
        title: "Lead created",
        createdByUserId: userId,
      },
    });

    return lead;
  });
}

export async function updateLead(
  id: string,
  input: unknown,
) {
  const { workspaceId, userId } =
    await requireUser();

  const data = leadSchema.partial().parse(input);

  return db.$transaction(async (tx) => {
    const existing = await tx.lead.findFirst({
      where: {
        id,
        workspaceId,
        deletedAt: null,
      },
    });

    if (!existing) {
      throw new Error("NOT_FOUND");
    }

    const lead = await tx.lead.update({
      where: { id: existing.id },
      data,
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        type: "LEAD_UPDATED",
        title: "Lead updated",
        createdByUserId: userId,
      },
    });

    return lead;
  });
}

export async function moveLead(
  id: string,
  stage: PipelineStage,
) {
  const { workspaceId, userId } =
    await requireUser();

  const status = stageStatus[stage];

  return db.$transaction(async (tx) => {
    const existing = await tx.lead.findFirst({
      where: {
        id,
        workspaceId,
        deletedAt: null,
      },
    });

    if (!existing) {
      throw new Error("NOT_FOUND");
    }

    if (existing.status === status) {
      return existing;
    }

    const lead = await tx.lead.update({
      where: { id: existing.id },
      data: { status },
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: id,
        type: "STATUS_CHANGED",
        title: "Lead status changed",
        description: `${existing.status} → ${status}`,
        metadata: {
          from: existing.status,
          to: status,
        },
        createdByUserId: userId,
      },
    });

    return lead;
  });
}

export async function deleteLead(id: string) {
  const { workspaceId, userId } =
    await requireUser();

  return db.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: {
        id,
        workspaceId,
        deletedAt: null,
      },
    });

    if (!lead) {
      throw new Error("NOT_FOUND");
    }

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        type: "LEAD_UPDATED",
        title: "Lead archived",
        createdByUserId: userId,
      },
    });

    return tx.lead.update({
      where: { id: lead.id },
      data: {
        deletedAt: new Date(),
      },
    });
  });
}
