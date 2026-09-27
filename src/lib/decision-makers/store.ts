/**
 * Stores people already extracted from a company's own pages.
 *
 * Writes stay in DiscoveredContact and append-only Observation rows. Nothing
 * here creates a CRM contact, deletes a person, or clears a dismissal.
 */

import type { ContactVerification, ExtractionMethod } from "@prisma/client";

import { db } from "@/lib/db-client";
import { confidenceFor } from "@/lib/discovery/provenance";

import type { PersonCandidate } from "./extract";
import { readRole } from "./relevance";

const PERSON_FIELDS = ["person.name", "person.jobTitle", "person.email", "person.phone", "person.linkedinUrl"] as const;

export interface StoredPerson {
  id: string;
  fullName: string;
  canonicalName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  verification: ContactVerification;
  confidence: number;
  method: ExtractionMethod;
  sourceUrl: string | null;
  evidence: string | null;
  isDecisionMaker: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  promotedContactId: string | null;
  dismissed: boolean;
  roleCategory: string;
  roleReasons: string[];
  serviceKeys: string[];
}

export interface StorePeopleResult {
  created: number;
  updated: number;
  unchanged: number;
  skippedDismissed: number;
}

function methodRank(method: ExtractionMethod): number {
  return method === "STRUCTURED_DATA" ? 2 : method === "HTML_SELECTOR" ? 1 : 0;
}

function stronger(next: PersonCandidate, heldMethod: ExtractionMethod): boolean {
  return methodRank(next.method) >= methodRank(heldMethod);
}

async function remember(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  input: {
    workspaceId: string;
    companyId: string;
    contactId: string;
    field: (typeof PERSON_FIELDS)[number];
    value: string | null;
    method: ExtractionMethod;
    sourceUrl: string;
    evidence: string;
    now: Date;
  },
): Promise<void> {
  if (input.value === null || input.value.trim() === "") return;
  const current = await tx.observation.findFirst({
    where: {
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      field: input.field,
      locator: input.contactId,
      supersededAt: null,
    },
    orderBy: { observedAt: "desc" },
  });
  if (current?.value === input.value) return;

  if (current !== null) {
    await tx.observation.update({
      where: { id: current.id },
      data: { supersededAt: input.now },
    });
  }

  await tx.observation.create({
    data: {
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      field: input.field,
      locator: input.contactId,
      value: input.value,
      method: input.method,
      confidence: confidenceFor(input.method),
      sourceUrl: input.sourceUrl,
      evidence: input.evidence,
      observedAt: input.now,
    },
  });
}

/**
 * Upserts extracted people for one company. A weaker later sighting cannot
 * replace a stored title, email, phone, or profile.
 */
export async function storeDiscoveredPeople(input: {
  workspaceId: string;
  companyId: string;
  people: readonly PersonCandidate[];
  now?: Date;
}): Promise<StorePeopleResult> {
  const now = input.now ?? new Date();
  const result: StorePeopleResult = { created: 0, updated: 0, unchanged: 0, skippedDismissed: 0 };

  for (const person of input.people) {
    const outcome = await db.$transaction(async (tx) => {
      const company = await tx.company.findFirst({
        where: { id: input.companyId, workspaceId: input.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (company === null) return "missing" as const;

      const existing = await tx.discoveredContact.findUnique({
        where: {
          companyId_canonicalName: {
            companyId: input.companyId,
            canonicalName: person.canonicalName,
          },
        },
      });

      if (existing !== null && existing.workspaceId !== input.workspaceId) return "missing" as const;
      if (existing?.dismissedAt !== null && existing !== null) return "dismissed" as const;

      const role = readRole(person.jobTitle);
      // A relevant function on the company's own page. The UI still labels a
      // team-card sighting LIKELY unless structured data was published.
      const isDecisionMaker = role.decisionMaker && person.verification !== "UNVERIFIED";

      if (existing === null) {
        const created = await tx.discoveredContact.create({
          data: {
            workspaceId: input.workspaceId,
            companyId: input.companyId,
            fullName: person.fullName,
            canonicalName: person.canonicalName,
            jobTitle: person.jobTitle,
            email: person.email,
            phone: person.phone,
            linkedinUrl: person.linkedinUrl,
            isDecisionMaker,
            verification: person.verification,
            confidence: confidenceFor(person.method),
            method: person.method,
            sourceUrl: person.sourceUrl,
            evidence: person.evidence,
            firstSeenAt: now,
            lastSeenAt: now,
          },
        });
        await remember(tx, { ...input, contactId: created.id, field: "person.name", value: person.fullName, method: person.method, sourceUrl: person.sourceUrl, evidence: person.evidence, now });
        await remember(tx, { ...input, contactId: created.id, field: "person.jobTitle", value: person.jobTitle, method: person.method, sourceUrl: person.sourceUrl, evidence: person.evidence, now });
        await remember(tx, { ...input, contactId: created.id, field: "person.email", value: person.email, method: person.method, sourceUrl: person.sourceUrl, evidence: person.evidence, now });
        await remember(tx, { ...input, contactId: created.id, field: "person.phone", value: person.phone, method: person.method, sourceUrl: person.sourceUrl, evidence: person.evidence, now });
        await remember(tx, { ...input, contactId: created.id, field: "person.linkedinUrl", value: person.linkedinUrl, method: person.method, sourceUrl: person.sourceUrl, evidence: person.evidence, now });
        return "created" as const;
      }

      const canReplace = stronger(person, existing.method);
      const nextTitle =
        person.jobTitle !== null && canReplace && person.jobTitle !== existing.jobTitle
          ? person.jobTitle
          : existing.jobTitle;
      const nextEmail = existing.email ?? person.email;
      const nextPhone = existing.phone ?? person.phone;
      const nextLinkedin = existing.linkedinUrl ?? person.linkedinUrl;
      const changed =
        nextTitle !== existing.jobTitle ||
        nextEmail !== existing.email ||
        nextPhone !== existing.phone ||
        nextLinkedin !== existing.linkedinUrl;

      await tx.discoveredContact.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: now,
          jobTitle: nextTitle,
          email: nextEmail,
          phone: nextPhone,
          linkedinUrl: nextLinkedin,
          isDecisionMaker: existing.isDecisionMaker || (isDecisionMaker && canReplace),
          verification: canReplace ? person.verification : existing.verification,
          confidence: canReplace ? confidenceFor(person.method) : existing.confidence,
          method: canReplace ? person.method : existing.method,
          sourceUrl: canReplace ? person.sourceUrl : existing.sourceUrl,
          evidence: canReplace ? person.evidence : existing.evidence,
        },
      });

      if (nextTitle !== existing.jobTitle) {
        await remember(tx, { ...input, contactId: existing.id, field: "person.jobTitle", value: nextTitle, method: person.method, sourceUrl: person.sourceUrl, evidence: person.evidence, now });
      }
      if (existing.email === null && nextEmail !== null) {
        await remember(tx, { ...input, contactId: existing.id, field: "person.email", value: nextEmail, method: person.method, sourceUrl: person.sourceUrl, evidence: person.evidence, now });
      }
      if (existing.phone === null && nextPhone !== null) {
        await remember(tx, { ...input, contactId: existing.id, field: "person.phone", value: nextPhone, method: person.method, sourceUrl: person.sourceUrl, evidence: person.evidence, now });
      }
      if (existing.linkedinUrl === null && nextLinkedin !== null) {
        await remember(tx, { ...input, contactId: existing.id, field: "person.linkedinUrl", value: nextLinkedin, method: person.method, sourceUrl: person.sourceUrl, evidence: person.evidence, now });
      }

      return changed ? ("updated" as const) : ("unchanged" as const);
    });

    if (outcome === "created") result.created += 1;
    else if (outcome === "updated") result.updated += 1;
    else if (outcome === "unchanged") result.unchanged += 1;
    else if (outcome === "dismissed") result.skippedDismissed += 1;
  }

  return result;
}

function toStored(row: {
  id: string;
  fullName: string;
  canonicalName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  verification: ContactVerification;
  confidence: number;
  method: ExtractionMethod;
  sourceUrl: string | null;
  evidence: string | null;
  isDecisionMaker: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  promotedContactId: string | null;
  dismissedAt: Date | null;
}): StoredPerson {
  const role = readRole(row.jobTitle);
  return {
    id: row.id,
    fullName: row.fullName,
    canonicalName: row.canonicalName,
    jobTitle: row.jobTitle,
    email: row.email,
    phone: row.phone,
    linkedinUrl: row.linkedinUrl,
    verification: row.verification,
    confidence: row.confidence,
    method: row.method,
    sourceUrl: row.sourceUrl,
    evidence: row.evidence,
    isDecisionMaker: row.isDecisionMaker,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    promotedContactId: row.promotedContactId,
    dismissed: row.dismissedAt !== null,
    roleCategory: role.category,
    roleReasons: role.reasons,
    serviceKeys: role.serviceKeys,
  };
}

/** People already stored for this company. Dismissed rows stay out of the list. */
export async function listDecisionMakers(
  workspaceId: string,
  companyId: string,
): Promise<StoredPerson[]> {
  const rows = await db.discoveredContact.findMany({
    where: { workspaceId, companyId, dismissedAt: null },
    orderBy: [{ isDecisionMaker: "desc" }, { confidence: "desc" }, { fullName: "asc" }],
    take: 40,
  });
  return rows.map(toStored);
}

export async function personHistory(
  workspaceId: string,
  companyId: string,
  contactId: string,
): Promise<Array<{ field: string; value: string | null; observedAt: string; sourceUrl: string | null; current: boolean }>> {
  const rows = await db.observation.findMany({
    where: {
      workspaceId,
      companyId,
      locator: contactId,
      field: { in: [...PERSON_FIELDS] },
    },
    orderBy: { observedAt: "desc" },
    take: 20,
  });
  return rows.map((row) => ({
    field: row.field,
    value: row.value,
    observedAt: row.observedAt.toISOString(),
    sourceUrl: row.sourceUrl,
    current: row.supersededAt === null,
  }));
}
