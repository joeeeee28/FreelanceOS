import "server-only";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { contactSchema, contactUpdateSchema } from "./validation";
import { scoreLead, scoreMetadata } from "./scoring";
import { notFound } from "./errors";
import { normalisePaging, type Paginated } from "./leads";

export async function listContacts(
  filters: {
    search?: string;
    decisionMakersOnly?: boolean;
    page?: number;
    pageSize?: number;
  } = {},
) {
  const { workspaceId } = await requireUser();
  const { page, pageSize, skip } = normalisePaging(filters.page, filters.pageSize);
  const search = filters.search?.trim();

  const where = {
    workspaceId,
    lead: { deletedAt: null },
    ...(filters.decisionMakersOnly ? { isDecisionMaker: true } : {}),
    ...(search
      ? {
          OR: [
            { fullName: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
            { jobTitle: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.contact.findMany({
      where,
      include: { lead: { select: { id: true, companyName: true } } },
      orderBy: [{ isPrimary: "desc" }, { fullName: "asc" }],
      skip,
      take: pageSize,
    }),
    db.contact.count({ where }),
  ]);

  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(Math.ceil(total / pageSize), 1),
  } satisfies Paginated<(typeof items)[number]>;
}

export async function createContact(input: unknown) {
  const { workspaceId, userId } = await requireUser();

  const data = contactSchema.parse(input);

  return db.$transaction(async (tx) => {
    // The lead is re-read inside the transaction and scoped to the caller's
    // workspace, so a contact can never be attached to another tenant's lead.
    const lead = await tx.lead.findFirst({
      where: { id: data.leadId, workspaceId, deletedAt: null },
    });

    if (!lead) throw notFound("Lead");

    // At most one primary contact per lead.
    if (data.isPrimary) {
      await tx.contact.updateMany({
        where: { workspaceId, leadId: lead.id, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const contact = await tx.contact.create({
      data: { ...data, workspaceId },
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        contactId: contact.id,
        type: "CONTACT_ADDED",
        title: `Contact added: ${contact.fullName}`,
        description: contact.jobTitle ?? undefined,
        createdByUserId: userId,
      },
    });

    // Adding a decision maker means the lead now has one. Keeping the lead
    // flag consistent here (transactionally) avoids the two records
    // disagreeing, and rescores the lead in the same breath.
    await syncDecisionMaker(tx, { workspaceId, userId, leadId: lead.id });

    return contact;
  });
}

export async function updateContact(id: string, input: unknown) {
  const { workspaceId, userId } = await requireUser();

  const data = contactUpdateSchema.parse(input);

  return db.$transaction(async (tx) => {
    const existing = await tx.contact.findFirst({
      where: { id, workspaceId },
    });

    if (!existing) throw notFound("Contact");

    if (data.isPrimary === true) {
      await tx.contact.updateMany({
        where: {
          workspaceId,
          leadId: existing.leadId,
          isPrimary: true,
          id: { not: existing.id },
        },
        data: { isPrimary: false },
      });
    }

    const contact = await tx.contact.update({
      where: { id: existing.id },
      data,
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: contact.leadId,
        contactId: contact.id,
        type: "CONTACT_ADDED",
        title: `Contact updated: ${contact.fullName}`,
        createdByUserId: userId,
      },
    });

    await syncDecisionMaker(tx, {
      workspaceId,
      userId,
      leadId: contact.leadId,
    });

    return contact;
  });
}

export async function getContact(id: string) {
  const { workspaceId } = await requireUser();

  return db.contact.findFirst({
    where: { id, workspaceId },
    include: { lead: { select: { id: true, companyName: true } } },
  });
}

/**
 * Keeps `Lead.decisionMakerIdentified` in step with its contacts and rescores.
 *
 * Runs inside the caller's transaction so the contact write and the lead
 * update either both land or both roll back.
 */
async function syncDecisionMaker(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  params: { workspaceId: string; userId: string; leadId: string },
) {
  const { workspaceId, userId, leadId } = params;

  const lead = await tx.lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) return;

  const decisionMakerCount = await tx.contact.count({
    where: { workspaceId, leadId, isDecisionMaker: true },
  });

  const identified = decisionMakerCount > 0;

  // Only ever promote the flag from a contact. Clearing it is left to the
  // qualification form, so removing one decision-maker contact does not
  // silently undo a manual assessment.
  const nextIdentified = lead.decisionMakerIdentified || identified;

  const scored = scoreLead({ ...lead, decisionMakerIdentified: nextIdentified });

  if (
    nextIdentified === lead.decisionMakerIdentified &&
    scored.score === lead.score
  ) {
    return;
  }

  await tx.lead.update({
    where: { id: lead.id },
    data: { decisionMakerIdentified: nextIdentified, score: scored.score },
  });

  if (nextIdentified !== lead.decisionMakerIdentified) {
    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        type: "RESEARCH_COMPLETED",
        title: "Decision maker identified",
        metadata: scoreMetadata(scored),
        createdByUserId: userId,
      },
    });
  }
}
