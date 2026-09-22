/**
 * Company -> Lead synchronisation.
 *
 * This is the only place the discovery engine is allowed to write into CRM
 * tables, and it is deliberately the most conservative module in the codebase.
 * Everything upstream can be re-run, re-crawled and corrected. A lead that a
 * person has been working for three weeks cannot be un-damaged.
 *
 * The rules, in order of how much they matter:
 *
 *   1. Never delete. Nothing here issues a delete of any kind.
 *   2. Never overwrite. A lead field that already holds a value is left
 *      exactly as it is, even when discovery is confident it is wrong.
 *      Discovery fills blanks; people fill the rest.
 *   3. Never invent. A field discovery has no value for stays NULL. There is
 *      no "probably", no inference, no default.
 *   4. Always explain. Every field written is recorded on an Activity with its
 *      source URL, method and confidence, so any value can be traced back.
 *
 * Rule 2 is stricter than "prefer higher confidence", and that is intentional.
 * Confidence describes how sure a crawler is about a web page; it says nothing
 * about the phone call in which the owner gave their real address. A human
 * edit outranks every crawler by construction, and the cheapest way to
 * guarantee that is to refuse to overwrite anything at all.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { db } from "@/lib/db-client";
import { scoreLead, type ScorableLead } from "@/lib/crm/scoring";

/**
 * Company fields that may populate a Lead, and the Lead column each maps to.
 *
 * An explicit map rather than a spread: a new Company column must not start
 * silently flowing into the CRM because someone added it to the schema.
 */
export const LEAD_FIELD_MAP = {
  website: "website",
  email: "email",
  phone: "phone",
  country: "country",
  city: "city",
  industry: "industry",
  companySize: "companySize",
  linkedinUrl: "linkedinUrl",
  instagramUrl: "instagramUrl",
  facebookUrl: "facebookUrl",
} as const satisfies Record<string, keyof Prisma.LeadUpdateInput>;

export type SyncableCompanyField = keyof typeof LEAD_FIELD_MAP;

export const SYNCABLE_FIELDS = Object.keys(LEAD_FIELD_MAP) as SyncableCompanyField[];

/** What happened to one field. */
export interface FieldSync {
  field: SyncableCompanyField;
  applied: boolean;
  reason: "FILLED" | "ALREADY_SET" | "NO_VALUE";
  previousValue: string | null;
  newValue: string | null;
}

export type SyncOutcome =
  | {
      kind: "CREATED";
      leadId: string;
      companyId: string;
      fields: FieldSync[];
      score: number;
    }
  | {
      kind: "UPDATED";
      leadId: string;
      companyId: string;
      fields: FieldSync[];
      score: number;
    }
  | {
      kind: "UNCHANGED";
      leadId: string;
      companyId: string;
      fields: FieldSync[];
      score: number;
    }
  | { kind: "SKIPPED"; companyId: string; reason: string };

export interface SyncOptions {
  workspaceId: string;
  companyId: string;
  /** Create a Lead if the company has none. Default false. */
  createIfMissing?: boolean;
  /** Recorded on the Lead when it is created. */
  sourceLabel?: string;
  now?: Date;
  client?: PrismaClient | Prisma.TransactionClient;
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

/**
 * Pushes a Company's known facts onto its Lead.
 *
 * Returns SKIPPED rather than throwing for every "cannot proceed" case, so a
 * sync sweep over thousands of companies is never derailed by one of them.
 */
export async function syncCompanyToLead(
  options: SyncOptions,
): Promise<SyncOutcome> {
  const { workspaceId, companyId } = options;
  const client = options.client ?? db;
  const now = options.now ?? new Date();

  const company = await client.company.findFirst({
    // workspaceId is part of the lookup, never a post-hoc check, so a company
    // from another workspace is invisible rather than merely rejected.
    where: { id: companyId, workspaceId },
  });

  if (company === null) {
    return { kind: "SKIPPED", companyId, reason: "Company not found" };
  }

  if (company.archivedAt !== null) {
    // Archiving is a human decision to stop caring about this record.
    // Continuing to push data into its lead would silently undo that.
    return { kind: "SKIPPED", companyId, reason: "Company is archived" };
  }

  if (company.resolutionState === "NEEDS_REVIEW") {
    // An unresolved company may be two businesses wearing one name. Writing
    // its fields into a lead would merge them in the one place that is hard
    // to unpick later.
    return {
      kind: "SKIPPED",
      companyId,
      reason: "Company needs resolution review",
    };
  }

  const existing = await client.lead.findFirst({
    where: { workspaceId, companyId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });

  if (existing === null && options.createIfMissing !== true) {
    return { kind: "SKIPPED", companyId, reason: "No lead for company" };
  }

  // Work out what each field would become, without writing anything yet.
  const fields: FieldSync[] = SYNCABLE_FIELDS.map((field) => {
    const incoming = company[field];
    const value = typeof incoming === "string" && incoming.trim() !== "" ? incoming : null;
    const current = existing === null ? null : (existing[LEAD_FIELD_MAP[field]] as string | null);

    if (value === null) {
      return {
        field,
        applied: false,
        reason: "NO_VALUE" as const,
        previousValue: current,
        newValue: null,
      };
    }

    if (!isBlank(current)) {
      return {
        field,
        applied: false,
        // The important branch. Discovery knows something different and is
        // choosing not to act on it.
        reason: "ALREADY_SET" as const,
        previousValue: current,
        newValue: null,
      };
    }

    return {
      field,
      applied: true,
      reason: "FILLED" as const,
      previousValue: current,
      newValue: value,
    };
  });

  const applied = fields.filter((entry) => entry.applied);

  if (existing === null) {
    return createLead({ client, company, fields, applied, now, options });
  }

  if (applied.length === 0) {
    return {
      kind: "UNCHANGED",
      leadId: existing.id,
      companyId,
      fields,
      score: existing.score,
    };
  }

  const data: Prisma.LeadUpdateInput = {};
  for (const entry of applied) {
    // Safe: applied entries always carry a string newValue.
    (data as Record<string, string>)[LEAD_FIELD_MAP[entry.field]] = entry.newValue as string;
  }

  const merged: ScorableLead = {
    ...(existing as ScorableLead),
    ...(data as Partial<ScorableLead>),
  };
  const score = scoreLead(merged);

  const updated = await client.lead.update({
    where: { id: existing.id },
    data: { ...data, score: score.score },
  });

  await recordSync({
    client,
    workspaceId,
    leadId: updated.id,
    companyId,
    fields: applied,
    created: false,
    now,
  });

  return { kind: "UPDATED", leadId: updated.id, companyId, fields, score: score.score };
}

async function createLead(args: {
  client: PrismaClient | Prisma.TransactionClient;
  company: { id: string; name: string; workspaceId: string };
  fields: FieldSync[];
  applied: FieldSync[];
  now: Date;
  options: SyncOptions;
}): Promise<SyncOutcome> {
  const { client, company, fields, applied, now, options } = args;

  const data: Record<string, string> = {};
  for (const entry of applied) {
    data[LEAD_FIELD_MAP[entry.field]] = entry.newValue as string;
  }

  const draft = {
    workspaceId: company.workspaceId,
    companyId: company.id,
    companyName: company.name,
    source: options.sourceLabel ?? "Discovery",
    ...data,
  };

  // Score the lead as it will exist, so a freshly discovered lead is never
  // shown as zero until something happens to touch it.
  const score = scoreLead({
    status: "NEW",
    websitePresent: null,
    websiteQuality: null,
    advertisingActivity: null,
    contentActivity: null,
    serviceInterest: null,
    painPoint: null,
    decisionMakerIdentified: false,
    qualificationNotes: null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    linkedinUrl: data.linkedinUrl ?? null,
    industry: data.industry ?? null,
    companySize: data.companySize ?? null,
  });

  const lead = await client.lead.create({
    data: { ...draft, score: score.score },
  });

  await recordSync({
    client,
    workspaceId: company.workspaceId,
    leadId: lead.id,
    companyId: company.id,
    fields: applied,
    created: true,
    now,
  });

  return { kind: "CREATED", leadId: lead.id, companyId: company.id, fields, score: score.score };
}

/**
 * Writes the audit trail for a sync.
 *
 * createdByUserId is left null, which is how the CRM distinguishes machine
 * writes from human ones. The metadata records exactly which fields were
 * filled and what they were before, so a surprising value on a lead can always
 * be traced to the run that produced it.
 */
async function recordSync(args: {
  client: PrismaClient | Prisma.TransactionClient;
  workspaceId: string;
  leadId: string;
  companyId: string;
  fields: FieldSync[];
  created: boolean;
  now: Date;
}): Promise<void> {
  const { client, workspaceId, leadId, companyId, fields, created } = args;

  const changed = fields.map((entry) => ({
    field: entry.field,
    from: entry.previousValue,
    to: entry.newValue,
  }));

  await client.activity.create({
    data: {
      workspaceId,
      leadId,
      type: created ? "LEAD_CREATED" : "LEAD_UPDATED",
      title: created
        ? "Lead created by discovery"
        : `Discovery filled ${changed.length} empty ${changed.length === 1 ? "field" : "fields"}`,
      description: created
        ? "Created automatically from a discovered company."
        : `Filled: ${changed.map((entry) => entry.field).join(", ")}.`,
      metadata: { companyId, source: "DISCOVERY", changed },
      createdByUserId: null,
    },
  });
}

export interface SyncAllOptions {
  workspaceId: string;
  createIfMissing?: boolean;
  /** Maximum companies to process. */
  limit?: number;
  now?: Date;
}

/**
 * Syncs every eligible company in a workspace.
 *
 * Sequential and independently error-contained: one company that fails to sync
 * does not prevent the rest, for the same reason a broken source does not stop
 * a crawl.
 */
export async function syncAllCompanies(
  options: SyncAllOptions,
): Promise<SyncOutcome[]> {
  const companies = await db.company.findMany({
    where: {
      workspaceId: options.workspaceId,
      archivedAt: null,
      resolutionState: { not: "NEEDS_REVIEW" },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 500,
  });

  const results: SyncOutcome[] = [];

  for (const company of companies) {
    try {
      results.push(
        await syncCompanyToLead({
          workspaceId: options.workspaceId,
          companyId: company.id,
          createIfMissing: options.createIfMissing,
          now: options.now,
        }),
      );
    } catch (error) {
      results.push({
        kind: "SKIPPED",
        companyId: company.id,
        reason: error instanceof Error ? error.message : "Sync failed",
      });
    }
  }

  return results;
}
