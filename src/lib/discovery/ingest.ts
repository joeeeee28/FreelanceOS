/**
 * Note: this module intentionally carries no `server-only` marker.
 *
 * It is loaded by the standalone worker process as well as by the Next.js
 * app, and `server-only` throws anywhere outside a React Server Component
 * graph. The protection is not lost — this module reaches the browser only
 * via an import from a client component, which would fail to bundle Prisma
 * regardless. Application UI code must still import `@/lib/db`, which keeps
 * the guard.
 */

import type { ExtractionMethod as PrismaExtractionMethod, Prisma } from "@prisma/client";

import { db } from "@/lib/db-client";

import {
  clampConfidence,
  confidenceFor,
  decidePrecedence,
  sanitiseEvidence,
  type ExtractionMethod,
} from "./provenance";
import {
  canonicalCompanyName,
  canonicalDomain,
  canonicalEmail,
  canonicalPhone,
  canonicalUrl,
} from "./canonical";
import {
  isAutoMergeStrategy,
  resolveEntity,
  resolutionKeys,
  type EntityIdentity,
  type MatchStrategy,
} from "./resolution";

/**
 * The additive write path.
 *
 * This is the only way machine-discovered data is allowed to reach the
 * database, and it enforces the permanent-CRM rules in one place:
 *
 *   1. Every fact is written as an Observation first. Observations are
 *      append-only, so the justification for any value can always be produced.
 *   2. A value is promoted onto the Company record only if it beats what is
 *      already there (see decidePrecedence). A human edit is unreachable.
 *   3. Nothing is ever deleted. A replaced observation is stamped
 *      `supersededAt` and kept.
 *   4. Unknown stays NULL. We never write a guess to fill a gap.
 */

/** Company fields the discovery engine is permitted to write. */
export const OBSERVABLE_FIELDS = [
  "name",
  "website",
  "email",
  "phone",
  "country",
  "region",
  "city",
  "language",
  "timezone",
  "currency",
  "industry",
  "companySize",
  "description",
  "linkedinUrl",
  "instagramUrl",
  "facebookUrl",
  "youtubeUrl",
] as const;

export type ObservableField = (typeof OBSERVABLE_FIELDS)[number];

const OBSERVABLE_FIELD_SET: ReadonlySet<string> = new Set(OBSERVABLE_FIELDS);

export function isObservableField(value: string): value is ObservableField {
  return OBSERVABLE_FIELD_SET.has(value);
}

/**
 * Per-field normalisation applied before storage, so the same real-world fact
 * from two sources produces the same stored string.
 *
 * Returning null means "this value is unusable" — it is recorded as an
 * observation with a null value (we looked, and found nothing valid) and never
 * promoted.
 */
const FIELD_NORMALISERS: Partial<
  Record<ObservableField, (raw: string) => string | null>
> = {
  website: canonicalUrl,
  email: canonicalEmail,
  phone: canonicalPhone,
  linkedinUrl: canonicalUrl,
  instagramUrl: canonicalUrl,
  facebookUrl: canonicalUrl,
  youtubeUrl: canonicalUrl,
};

const MAX_FIELD_LENGTH = 2000;

export function normaliseFieldValue(
  field: ObservableField,
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;

  // Crawler output is untrusted: strip control characters and collapse
  // whitespace before anything else looks at it.
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned === "") return null;

  const normaliser = FIELD_NORMALISERS[field];
  const normalised = normaliser ? normaliser(cleaned) : cleaned;

  if (normalised === null || normalised === "") return null;

  return normalised.slice(0, MAX_FIELD_LENGTH);
}

/** A single discovered fact, as produced by a provider. */
export interface ObservedFact {
  field: ObservableField;
  value: string | null;
  method: ExtractionMethod;
  sourceUrl?: string | null;
  evidence?: string | null;
  /** Where in the document it was found, e.g. a CSS selector. */
  locator?: string | null;
  observedAt?: Date;
}

/** Provider output after normalisation, ready to be written. */
export interface DiscoveredEntity {
  identity: EntityIdentity;
  facts: ObservedFact[];
  sourceId?: string | null;
}

export interface IngestOptions {
  workspaceId: string;
  entity: DiscoveredEntity;
  /** Injected for deterministic tests. */
  now?: Date;
}

export interface FieldOutcome {
  field: ObservableField;
  promoted: boolean;
  reason: string;
  previousValue: string | null;
  newValue: string | null;
}

export type IngestResult =
  | {
      kind: "INGESTED";
      companyId: string;
      created: boolean;
      strategy: MatchStrategy | "NEW";
      fields: FieldOutcome[];
      observationsWritten: number;
    }
  | {
      kind: "NEEDS_REVIEW";
      companyId: string;
      candidateIds: string[];
      strategy: MatchStrategy;
      reason: string;
      observationsWritten: number;
    }
  | { kind: "SKIPPED"; reason: string };

/**
 * Ingests one discovered entity.
 *
 * Runs in a transaction so a company is never left half-written. The
 * workspaceId must come from the caller's session — it is never taken from
 * crawled data.
 */
export async function ingestDiscoveredEntity(
  options: IngestOptions,
): Promise<IngestResult> {
  const { workspaceId, entity } = options;
  const now = options.now ?? new Date();

  const keys = resolutionKeys(entity.identity);

  if (keys.canonicalName === null && keys.canonicalDomain === null) {
    return {
      kind: "SKIPPED",
      reason: "No usable company name or domain",
    };
  }

  return db.$transaction(async (tx) => {
    // Candidates are scoped to the workspace, so resolution can never reach
    // across a tenant boundary.
    const candidates = await tx.company.findMany({
      where: {
        workspaceId,
        OR: [
          ...(keys.canonicalDomain !== null
            ? [{ canonicalDomain: keys.canonicalDomain }]
            : []),
          ...(keys.canonicalName !== null
            ? [{ canonicalName: keys.canonicalName }]
            : []),
          ...(keys.canonicalEmail !== null ? [{ email: keys.canonicalEmail }] : []),
        ],
      },
      select: {
        id: true,
        canonicalName: true,
        canonicalDomain: true,
        email: true,
        phone: true,
        country: true,
        city: true,
      },
    });

    const outcome = resolveEntity(entity.identity, candidates);

    if (outcome.kind === "INSUFFICIENT_EVIDENCE") {
      return { kind: "SKIPPED", reason: outcome.reason } as const;
    }

    let companyId: string;
    let created = false;
    let strategy: MatchStrategy | "NEW";
    let review: { candidateIds: string[]; strategy: MatchStrategy; reason: string } | null =
      null;

    if (outcome.kind === "MATCH" && isAutoMergeStrategy(outcome.strategy)) {
      companyId = outcome.entityId;
      strategy = outcome.strategy;
    } else {
      // REVIEW and NEW both create a record. A review candidate is stored as
      // its own company flagged NEEDS_REVIEW rather than being merged on weak
      // evidence — a human resolves it later, and no data is lost either way.
      const displayName =
        normaliseFieldValue("name", entity.identity.name) ??
        keys.canonicalDomain ??
        "Unknown";

      const createdCompany = await tx.company.create({
        data: {
          workspaceId,
          name: displayName,
          canonicalName: canonicalCompanyName(displayName) ?? displayName.toLowerCase(),
          canonicalDomain: keys.canonicalDomain,
          firstSeenAt: now,
          lastSeenAt: now,
          resolutionState: outcome.kind === "REVIEW" ? "NEEDS_REVIEW" : "RESOLVED",
        },
        select: { id: true },
      });

      companyId = createdCompany.id;
      created = true;
      strategy = outcome.kind === "REVIEW" ? outcome.strategy : "NEW";

      if (outcome.kind === "REVIEW") {
        review = {
          candidateIds: outcome.candidateIds,
          strategy: outcome.strategy,
          reason: outcome.reason,
        };
      }
    }

    const fieldOutcomes = await applyFacts({
      tx,
      workspaceId,
      companyId,
      sourceId: entity.sourceId ?? null,
      facts: entity.facts,
      now,
      // A freshly created company has no prior values to protect.
      isNew: created,
    });

    await tx.company.update({
      where: { id: companyId },
      data: { lastSeenAt: now },
    });

    const observationsWritten = fieldOutcomes.length;

    if (review !== null) {
      return {
        kind: "NEEDS_REVIEW",
        companyId,
        candidateIds: review.candidateIds,
        strategy: review.strategy,
        reason: review.reason,
        observationsWritten,
      } as const;
    }

    return {
      kind: "INGESTED",
      companyId,
      created,
      strategy,
      fields: fieldOutcomes,
      observationsWritten,
    } as const;
  });
}

interface ApplyFactsArgs {
  tx: Prisma.TransactionClient;
  workspaceId: string;
  companyId: string;
  sourceId: string | null;
  facts: readonly ObservedFact[];
  now: Date;
  isNew: boolean;
}

/**
 * Writes each fact as an Observation and promotes it only if it wins.
 *
 * Every fact produces an observation row even when it loses, because "we saw
 * this weaker claim and rejected it" is itself worth keeping.
 */
async function applyFacts(args: ApplyFactsArgs): Promise<FieldOutcome[]> {
  const { tx, workspaceId, companyId, sourceId, facts, now, isNew } = args;
  const outcomes: FieldOutcome[] = [];

  for (const fact of facts) {
    if (!isObservableField(fact.field)) continue;

    const value = normaliseFieldValue(fact.field, fact.value);
    const confidence = clampConfidence(confidenceFor(fact.method));
    const observedAt = fact.observedAt ?? now;

    // The strongest surviving observation for this field decides what the
    // company currently holds and how strongly.
    const held = await tx.observation.findFirst({
      where: { companyId, field: fact.field, supersededAt: null, value: { not: null } },
      orderBy: [{ confidence: "desc" }, { observedAt: "desc" }],
      select: { id: true, confidence: true, observedAt: true, value: true },
    });

    const company = await tx.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { [fact.field]: true } as Record<string, boolean>,
    });

    const previousValue = (company as Record<string, unknown>)[fact.field];
    const previous = typeof previousValue === "string" ? previousValue : null;

    const observation = await tx.observation.create({
      data: {
        workspaceId,
        companyId,
        sourceId,
        field: fact.field,
        value,
        method: fact.method as PrismaExtractionMethod,
        confidence,
        sourceUrl: fact.sourceUrl ?? null,
        evidence:
          typeof fact.evidence === "string" ? sanitiseEvidence(fact.evidence) : null,
        locator: fact.locator ?? null,
        observedAt,
      },
      select: { id: true },
    });

    // A null observation records "we looked and found nothing". It is never
    // promoted, because absence of evidence must not erase a known value.
    if (value === null) {
      outcomes.push({
        field: fact.field,
        promoted: false,
        reason: "NO_VALUE_OBSERVED",
        previousValue: previous,
        newValue: previous,
      });
      continue;
    }

    // If the field is empty on a company that already existed, there is
    // nothing to protect, so treat it as unheld.
    const heldForDecision =
      previous === null || (isNew && held === null)
        ? null
        : held !== null
          ? { confidence: held.confidence, observedAt: held.observedAt }
          : null;

    const decision = decidePrecedence(heldForDecision, { confidence, observedAt });

    if (!decision.promote) {
      outcomes.push({
        field: fact.field,
        promoted: false,
        reason: decision.reason,
        previousValue: previous,
        newValue: previous,
      });
      continue;
    }

    // Promote: update the company, and stamp the observation we replaced.
    // The superseded row is kept, never deleted.
    await tx.company.update({
      where: { id: companyId },
      data: { [fact.field]: value } as Prisma.CompanyUpdateInput,
    });

    if (held !== null && held.id !== observation.id) {
      await tx.observation.update({
        where: { id: held.id },
        data: { supersededAt: now },
      });
    }

    // Keep the resolution keys consistent with the promoted value.
    if (fact.field === "name") {
      await tx.company.update({
        where: { id: companyId },
        data: { canonicalName: canonicalCompanyName(value) ?? value.toLowerCase() },
      });
    }

    if (fact.field === "website") {
      const domain = canonicalDomain(value);
      if (domain !== null) {
        // Only claim the domain if no other company in the workspace holds it;
        // the unique index would otherwise abort the whole transaction.
        const clash = await tx.company.findFirst({
          where: { workspaceId, canonicalDomain: domain, id: { not: companyId } },
          select: { id: true },
        });
        if (clash === null) {
          await tx.company.update({
            where: { id: companyId },
            data: { canonicalDomain: domain },
          });
        }
      }
    }

    outcomes.push({
      field: fact.field,
      promoted: true,
      reason: decision.reason,
      previousValue: previous,
      newValue: value,
    });
  }

  return outcomes;
}

/**
 * Records a human-entered value with MANUAL confidence.
 *
 * Exposed so the UI writes through the same audited path as the crawler. A
 * value written here can never be overwritten by automated discovery.
 */
export function manualFact(
  field: ObservableField,
  value: string | null,
  evidence?: string,
): ObservedFact {
  return {
    field,
    value,
    method: "MANUAL",
    evidence: evidence ?? null,
  };
}
