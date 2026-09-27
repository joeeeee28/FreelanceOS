/**
 * Copies one discovered person onto an existing lead.
 *
 * Discovery never calls this. A blank CRM field may be filled. A value a
 * person already entered is left alone. No lead is created here.
 */

import { db } from "@/lib/db-client";
import { scoreLead, scoreMetadata } from "@/lib/crm/scoring";

import { readRole } from "./relevance";

export type PromoteResult =
  | {
      ok: true;
      kind: "CREATED" | "FILLED" | "UNCHANGED";
      contactId: string;
      leadId: string;
      companyId: string;
    }
  | { ok: false; reason: "not_found" | "dismissed" | "no_lead" | "archived" };

function splitName(fullName: string): { firstName: string | null; lastName: string | null } {
  const words = fullName.split(/\s+/).filter(Boolean);
  if (words.length < 2) return { firstName: null, lastName: null };
  return { firstName: words[0] ?? null, lastName: words.slice(1).join(" ") };
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

export async function addDiscoveredPersonToCrm(input: {
  workspaceId: string;
  userId: string;
  discoveredContactId: string;
  now?: Date;
}): Promise<PromoteResult> {
  const now = input.now ?? new Date();

  return db.$transaction(async (tx) => {
    const person = await tx.discoveredContact.findFirst({
      where: { id: input.discoveredContactId, workspaceId: input.workspaceId },
    });
    if (person === null) return { ok: false, reason: "not_found" };
    if (person.dismissedAt !== null) return { ok: false, reason: "dismissed" };

    const company = await tx.company.findFirst({
      where: { id: person.companyId, workspaceId: input.workspaceId },
    });
    if (company === null || company.archivedAt !== null) return { ok: false, reason: "archived" };

    const lead = await tx.lead.findFirst({
      where: { workspaceId: input.workspaceId, companyId: person.companyId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    if (lead === null) return { ok: false, reason: "no_lead" };

    const contacts = await tx.contact.findMany({
      where: { workspaceId: input.workspaceId, leadId: lead.id },
    });
    const existing = contacts.find(
      (contact) => contact.fullName.trim().toLowerCase() === person.fullName.trim().toLowerCase(),
    );

    const role = readRole(person.jobTitle);
    const markDecisionMaker = person.verification === "PUBLISHED" && role.decisionMaker;

    if (existing === undefined) {
      const names = splitName(person.fullName);
      const contact = await tx.contact.create({
        data: {
          workspaceId: input.workspaceId,
          leadId: lead.id,
          fullName: person.fullName,
          firstName: names.firstName,
          lastName: names.lastName,
          jobTitle: person.jobTitle,
          email: person.email,
          phone: person.phone,
          linkedinUrl: person.linkedinUrl,
          isDecisionMaker: markDecisionMaker,
          notes: person.sourceUrl ? `Public source: ${person.sourceUrl}` : null,
        },
      });
      await tx.activity.create({
        data: {
          workspaceId: input.workspaceId,
          leadId: lead.id,
          contactId: contact.id,
          type: "CONTACT_ADDED",
          title: `Contact added: ${contact.fullName}`,
          description: person.sourceUrl,
          createdByUserId: input.userId,
        },
      });
      if (markDecisionMaker && lead.decisionMakerIdentified !== true) {
        const scored = scoreLead({ ...lead, decisionMakerIdentified: true });
        await tx.lead.update({
          where: { id: lead.id },
          data: { decisionMakerIdentified: true, score: scored.score },
        });
        await tx.activity.create({
          data: {
            workspaceId: input.workspaceId,
            leadId: lead.id,
            type: "RESEARCH_COMPLETED",
            title: "Decision maker identified",
            metadata: scoreMetadata(scored),
            createdByUserId: input.userId,
          },
        });
      }
      await tx.discoveredContact.update({
        where: { id: person.id },
        data: { promotedContactId: contact.id, promotedAt: now },
      });
      return { ok: true, kind: "CREATED", contactId: contact.id, leadId: lead.id, companyId: person.companyId };
    }

    const data: {
      jobTitle?: string;
      email?: string;
      phone?: string;
      linkedinUrl?: string;
    } = {};
    if (blank(existing.jobTitle) && person.jobTitle) data.jobTitle = person.jobTitle;
    if (blank(existing.email) && person.email) data.email = person.email;
    if (blank(existing.phone) && person.phone) data.phone = person.phone;
    if (blank(existing.linkedinUrl) && person.linkedinUrl) data.linkedinUrl = person.linkedinUrl;

    if (Object.keys(data).length === 0) {
      if (person.promotedContactId === null) {
        await tx.discoveredContact.update({
          where: { id: person.id },
          data: { promotedContactId: existing.id, promotedAt: now },
        });
      }
      return { ok: true, kind: "UNCHANGED", contactId: existing.id, leadId: lead.id, companyId: person.companyId };
    }

    await tx.contact.update({ where: { id: existing.id }, data });
    await tx.activity.create({
      data: {
        workspaceId: input.workspaceId,
        leadId: lead.id,
        contactId: existing.id,
        type: "RESEARCH_COMPLETED",
        title: `Filled blank fields for ${existing.fullName}`,
        description: person.sourceUrl,
        createdByUserId: input.userId,
      },
    });
    await tx.discoveredContact.update({
      where: { id: person.id },
      data: { promotedContactId: existing.id, promotedAt: person.promotedAt ?? now },
    });
    return { ok: true, kind: "FILLED", contactId: existing.id, leadId: lead.id, companyId: person.companyId };
  });
}
