import "server-only";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { contactSchema } from "./validation";

export async function listContacts() {
  const { workspaceId } = await requireUser();

  return db.contact.findMany({
    where: {
      workspaceId,
      lead: { deletedAt: null },
    },
    include: {
      lead: {
        select: {
          id: true,
          companyName: true,
        },
      },
    },
    orderBy: { fullName: "asc" },
  });
}

export async function createContact(input: unknown) {
  const { workspaceId, userId } =
    await requireUser();

  const data = contactSchema.parse(input);

  return db.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: {
        id: data.leadId,
        workspaceId,
        deletedAt: null,
      },
    });

    if (!lead) throw new Error("NOT_FOUND");

    if (data.isPrimary) {
      await tx.contact.updateMany({
        where: {
          workspaceId,
          leadId: lead.id,
          isPrimary: true,
        },
        data: { isPrimary: false },
      });
    }

    const contact = await tx.contact.create({
      data: {
        ...data,
        workspaceId,
      },
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        contactId: contact.id,
        type: "CONTACT_ADDED",
        title: "Contact added",
        createdByUserId: userId,
      },
    });

    return contact;
  });
}
