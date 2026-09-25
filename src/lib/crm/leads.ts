import "server-only";
import type { LeadStatus, Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import {
  leadSchema,
  leadUpdateSchema,
  noteSchema,
  qualificationSchema,
} from "./validation";
import { canTransition } from "./pipeline";
import { scoreLead, scoreMetadata, type ScorableLead } from "./scoring";
import { humanise, invalidTransition, notFound } from "./errors";

/** Page size bounds for every paginated CRM list. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Clamps caller-supplied paging so a client cannot request the whole table. */
export function normalisePaging(page?: number, pageSize?: number) {
  // Anything missing or nonsensical (zero, negative, NaN, fractional) falls
  // back to the default rather than erroring, and the size is hard-capped so
  // a crafted `pageSize=100000` cannot pull the whole table.
  const requestedSize = Math.trunc(pageSize ?? DEFAULT_PAGE_SIZE);
  const safeSize =
    Number.isFinite(requestedSize) && requestedSize > 0
      ? Math.min(requestedSize, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  const requestedPage = Math.trunc(page ?? 1);
  const safePage =
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  return { page: safePage, pageSize: safeSize, skip: (safePage - 1) * safeSize };
}

/**
 * Sort orders offered by the leads table.
 *
 * A fixed allow-list rather than a free-form `orderBy`: the URL can only ask
 * for one of these, so no caller can order by an arbitrary column.
 */
export const LEAD_SORTS = {
  score: [{ score: "desc" }, { updatedAt: "desc" }],
  recent: [{ updatedAt: "desc" }],
  oldest: [{ createdAt: "asc" }],
  company: [{ companyName: "asc" }],
} satisfies Record<string, Prisma.LeadOrderByWithRelationInput[]>;

export type LeadSort = keyof typeof LEAD_SORTS;

export const DEFAULT_LEAD_SORT: LeadSort = "score";

export function parseLeadSort(value?: string): LeadSort {
  return value && value in LEAD_SORTS ? (value as LeadSort) : DEFAULT_LEAD_SORT;
}

export interface LeadListFilters {
  search?: string;
  status?: LeadStatus;
  source?: string;
  industry?: string;
  serviceInterest?: string;
  minScore?: number;
  maxScore?: number;
  /** Archived leads are excluded unless this is true. */
  includeArchived?: boolean;
  onlyArchived?: boolean;
  sort?: LeadSort;
  page?: number;
  pageSize?: number;
}

function leadWhere(
  workspaceId: string,
  filters: LeadListFilters,
): Prisma.LeadWhereInput {
  const search = filters.search?.trim();

  const archived: Prisma.LeadWhereInput = filters.onlyArchived
    ? { deletedAt: { not: null } }
    : filters.includeArchived
      ? {}
      : { deletedAt: null };

  const score: Prisma.IntFilter = {};
  if (typeof filters.minScore === "number") score.gte = filters.minScore;
  if (typeof filters.maxScore === "number") score.lte = filters.maxScore;

  return {
    // workspaceId is always supplied by the caller from requireUser(),
    // never from request input.
    workspaceId,
    ...archived,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.industry ? { industry: filters.industry } : {}),
    ...(filters.serviceInterest
      ? { serviceInterest: filters.serviceInterest }
      : {}),
    ...(Object.keys(score).length > 0 ? { score } : {}),
    ...(search
      ? {
          OR: [
            { companyName: { contains: search, mode: "insensitive" } },
            { contactName: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { website: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

/**
 * Paginated, filtered lead list.
 *
 * Count and page are fetched in a single round trip, and only the newest
 * follow-up per lead is joined, so the list does not degrade into N+1 queries.
 */
export async function listLeads(filters: LeadListFilters = {}) {
  const { workspaceId } = await requireUser();
  const { page, pageSize, skip } = normalisePaging(filters.page, filters.pageSize);
  const where = leadWhere(workspaceId, filters);

  const [items, total] = await Promise.all([
    db.lead.findMany({
      where,
      include: {
        followUps: {
          where: { status: "SCHEDULED" },
          orderBy: { scheduledAt: "asc" },
          take: 1,
        },
        // Newest activity only, for the "Last activity" column. Bounded at one
        // row per lead so the list stays a fixed number of queries.
        activities: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, type: true, title: true, createdAt: true },
        },
        // The named decision maker, when one has been identified.
        contacts: {
          where: { isDecisionMaker: true },
          orderBy: [{ isPrimary: "desc" }, { fullName: "asc" }],
          take: 1,
          select: { id: true, fullName: true, jobTitle: true },
        },
        _count: { select: { contacts: true, tasks: true } },
      },
      orderBy: LEAD_SORTS[filters.sort ?? DEFAULT_LEAD_SORT],
      skip,
      take: pageSize,
    }),
    db.lead.count({ where }),
  ]);

  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(Math.ceil(total / pageSize), 1),
  };
}

/** Distinct non-empty sources in the workspace, for the filter control. */
export async function listLeadSources(): Promise<string[]> {
  const { workspaceId } = await requireUser();

  const rows = await db.lead.findMany({
    where: { workspaceId, source: { not: null } },
    distinct: ["source"],
    select: { source: true },
    orderBy: { source: "asc" },
  });

  return rows
    .map((row) => row.source)
    .filter((source): source is string => Boolean(source && source.trim()));
}

/**
 * Distinct industries and service interests actually present in the
 * workspace, so the filter dropdowns only ever offer values that exist. No
 * hardcoded taxonomy is imposed on the user.
 */
export async function listLeadFacets(): Promise<{
  sources: string[];
  industries: string[];
  serviceInterests: string[];
}> {
  const { workspaceId } = await requireUser();

  const clean = (values: Array<string | null>) =>
    values.filter((value): value is string => Boolean(value && value.trim()));

  const [sourceRows, industryRows, serviceRows] = await Promise.all([
    db.lead.findMany({
      where: { workspaceId, source: { not: null } },
      distinct: ["source"],
      select: { source: true },
      orderBy: { source: "asc" },
    }),
    db.lead.findMany({
      where: { workspaceId, industry: { not: null } },
      distinct: ["industry"],
      select: { industry: true },
      orderBy: { industry: "asc" },
    }),
    db.lead.findMany({
      where: { workspaceId, serviceInterest: { not: null } },
      distinct: ["serviceInterest"],
      select: { serviceInterest: true },
      orderBy: { serviceInterest: "asc" },
    }),
  ]);

  return {
    sources: clean(sourceRows.map((row) => row.source)),
    industries: clean(industryRows.map((row) => row.industry)),
    serviceInterests: clean(serviceRows.map((row) => row.serviceInterest)),
  };
}

/** Full lead detail. Archived leads remain viewable so they can be inspected. */
export async function getLead(id: string) {
  const { workspaceId } = await requireUser();

  return db.lead.findFirst({
    where: { id, workspaceId },
    include: {
      contacts: { orderBy: [{ isPrimary: "desc" }, { fullName: "asc" }] },
      activities: {
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { contact: { select: { fullName: true } } },
      },
      tasks: { orderBy: [{ status: "asc" }, { dueAt: "asc" }] },
      followUps: {
        orderBy: { scheduledAt: "asc" },
        include: { contact: { select: { fullName: true } } },
      },
    },
  });
}

export async function createLead(input: unknown) {
  const { workspaceId, userId } = await requireUser();

  const data = leadSchema.parse(input);

  // Score is computed here, never accepted from the caller. A brand new lead
  // always starts at status NEW.
  const scored = scoreLead({ ...blankScorable(), ...data, status: "NEW" });

  return db.$transaction(async (tx) => {
    const lead = await tx.lead.create({
      data: { ...data, workspaceId, status: "NEW", score: scored.score },
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        type: "LEAD_CREATED",
        title: "Lead created",
        metadata: scoreMetadata(scored),
        createdByUserId: userId,
      },
    });

    return lead;
  });
}

export async function updateLead(id: string, input: unknown) {
  const { workspaceId, userId } = await requireUser();

  const data = leadUpdateSchema.parse(input);

  return db.$transaction(async (tx) => {
    const existing = await tx.lead.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });

    if (!existing) throw notFound("Lead");

    // Rescore from the merged record so the score always reflects the row as
    // it will be stored.
    const scored = scoreLead({ ...existing, ...data });

    const lead = await tx.lead.update({
      where: { id: existing.id },
      data: { ...data, score: scored.score },
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        type: "LEAD_UPDATED",
        title: "Lead updated",
        description: describeChanges(existing, data),
        metadata: scoreMetadata(scored),
        createdByUserId: userId,
      },
    });

    return lead;
  });
}

/**
 * Saves the qualification block.
 *
 * Qualification is the main driver of the score, so this always rescores and
 * records the result in the activity metadata, giving an audit trail of how
 * the score evolved without adding a column.
 */
export async function updateQualification(id: string, input: unknown) {
  const { workspaceId, userId } = await requireUser();

  const data = qualificationSchema.parse(input);

  return db.$transaction(async (tx) => {
    const existing = await tx.lead.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });

    if (!existing) throw notFound("Lead");

    const scored = scoreLead({ ...existing, ...data });

    const lead = await tx.lead.update({
      where: { id: existing.id },
      data: { ...data, score: scored.score },
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        type: "RESEARCH_COMPLETED",
        title: "Qualification updated",
        description:
          existing.score === scored.score
            ? `Score unchanged at ${scored.score}.`
            : `Score ${existing.score} → ${scored.score}.`,
        metadata: scoreMetadata(scored),
        createdByUserId: userId,
      },
    });

    return lead;
  });
}

/**
 * Moves a lead to a new status.
 *
 * The transition is validated against the workflow map, so a crafted request
 * cannot jump a lead straight from NEW to WON.
 */
export async function moveLead(id: string, to: LeadStatus) {
  const { workspaceId, userId } = await requireUser();

  return db.$transaction(async (tx) => {
    const existing = await tx.lead.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });

    if (!existing) throw notFound("Lead");
    if (existing.status === to) return existing;

    if (!canTransition(existing.status, to)) {
      throw invalidTransition(existing.status, to);
    }

    // Pipeline position feeds the score, so moving a lead rescores it.
    const scored = scoreLead({ ...existing, status: to });

    const lead = await tx.lead.update({
      where: { id: existing.id },
      data: { status: to, score: scored.score },
    });

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        type: "STATUS_CHANGED",
        title: `Status: ${humanise(existing.status)} → ${humanise(to)}`,
        metadata: { from: existing.status, to, ...scoreMetadata(scored) },
        createdByUserId: userId,
      },
    });

    return lead;
  });
}

/** Soft-archives a lead. Records are never physically deleted from the UI. */
export async function archiveLead(id: string) {
  const { workspaceId, userId } = await requireUser();

  return db.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });

    if (!lead) throw notFound("Lead");

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
      data: { deletedAt: new Date() },
    });
  });
}

export async function restoreLead(id: string) {
  const { workspaceId, userId } = await requireUser();

  return db.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id, workspaceId, deletedAt: { not: null } },
    });

    if (!lead) throw notFound("Lead");

    await tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        type: "LEAD_UPDATED",
        title: "Lead restored",
        createdByUserId: userId,
      },
    });

    return tx.lead.update({
      where: { id: lead.id },
      data: { deletedAt: null },
    });
  });
}

/** Adds a manual note to the lead timeline. */
export async function addLeadNote(id: string, input: unknown) {
  const { workspaceId, userId } = await requireUser();

  const { body } = noteSchema.parse(input);

  return db.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });

    if (!lead) throw notFound("Lead");

    return tx.activity.create({
      data: {
        workspaceId,
        leadId: lead.id,
        type: "NOTE_ADDED",
        title: "Note added",
        description: body,
        createdByUserId: userId,
      },
    });
  });
}

/** Deprecated alias kept so existing callers/tests continue to work. */
export const deleteLead = archiveLead;

/** Neutral baseline used when scoring a not-yet-persisted lead. */
function blankScorable(): ScorableLead {
  return {
    status: "NEW",
    websitePresent: null,
    websiteQuality: null,
    advertisingActivity: null,
    contentActivity: null,
    serviceInterest: null,
    painPoint: null,
    decisionMakerIdentified: false,
    qualificationNotes: null,
    email: null,
    phone: null,
    linkedinUrl: null,
    industry: null,
    companySize: null,
  };
}

/** Human-readable summary of which fields changed, for the timeline. */
function describeChanges(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): string | undefined {
  const changed = Object.keys(patch).filter(
    (key) => patch[key] !== undefined && patch[key] !== existing[key],
  );

  if (changed.length === 0) return undefined;

  return `Updated: ${changed.map(humanise).join(", ")}`;
}
