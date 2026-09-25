import type { Lead, LeadStatus } from "@prisma/client";

/**
 * Deterministic, explainable lead scoring.
 *
 * Rules:
 *  - Pure function of the lead row. No randomness, no clock, no AI, no
 *    external calls, so the same input always yields the same score.
 *  - Only fields the user actually filled in contribute. Nothing is inferred
 *    or invented, and a blank lead scores 0.
 *  - The total is clamped to 0..100.
 *
 * The score answers one question: *how ready is this lead to generate
 * revenue?* Points therefore come from genuine buying signals (an identified
 * decision maker, a stated service interest, a known pain point) and from
 * pipeline progress, not from how much text has been typed.
 */

/** Fields the score depends on. Keeps the engine usable with partial rows. */
export type ScorableLead = Pick<
  Lead,
  | "status"
  | "websitePresent"
  | "websiteQuality"
  | "advertisingActivity"
  | "contentActivity"
  | "serviceInterest"
  | "painPoint"
  | "decisionMakerIdentified"
  | "qualificationNotes"
  | "email"
  | "phone"
  | "linkedinUrl"
  | "industry"
  | "companySize"
>;

export interface ScoreReason {
  /** Stable machine-readable key, safe to persist in activity metadata. */
  code: string;
  label: string;
  points: number;
}

export interface ScoreResult {
  score: number;
  reasons: ScoreReason[];
  /** Sum before clamping, retained so the rules stay auditable. */
  rawTotal: number;
}

export const MAX_SCORE = 100;
export const MIN_SCORE = 0;

/** Weight table. Kept in one place so the rules are reviewable at a glance. */
export const SCORE_WEIGHTS = {
  /** A named decision maker is the single strongest predictor of a deal. */
  DECISION_MAKER: 20,
  /** The prospect told us what they want to buy. */
  SERVICE_INTEREST: 15,
  /** A concrete problem we can sell against. */
  PAIN_POINT: 15,
  /** No website at all is a direct opening for web work. */
  WEBSITE_ABSENT: 12,
  /** A weak site is a smaller but real opening. */
  WEBSITE_WEAK: 8,
  /** Already spending on ads: budget exists. */
  ADVERTISING_ACTIVE: 10,
  /** Publishing content: marketing-aware, easier conversation. */
  CONTENT_ACTIVE: 5,
  /** Research has been written down. */
  QUALIFICATION_NOTES: 5,
  /** We can actually reach them. */
  REACHABLE: 8,
  /** Firmographics captured. */
  FIRMOGRAPHICS: 2,
} as const;

/**
 * Pipeline progress points. Later stages score higher because engagement is
 * itself evidence of revenue potential. Terminal states score 0 — a closed
 * lead needs no prioritising.
 */
export const STAGE_POINTS: Record<LeadStatus, number> = {
  NEW: 0,
  RESEARCHING: 2,
  QUALIFIED: 6,
  OUTREACH_READY: 8,
  CONTACTED: 10,
  RESPONDED: 14,
  DISCOVERY_CALL: 18,
  PROPOSAL: 20,
  NEGOTIATION: 20,
  WON: 0,
  LOST: 0,
  NURTURE: 2,
};

/** Values of `websiteQuality` treated as an opportunity signal. */
const WEAK_WEBSITE_VALUES = new Set([
  "poor",
  "weak",
  "outdated",
  "basic",
  "needs work",
]);

/** Values of advertising/content activity meaning "not doing it". */
const INACTIVE_VALUES = new Set(["", "none", "no", "inactive", "not running"]);

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isActive(value: string | null | undefined): boolean {
  return hasText(value) && !INACTIVE_VALUES.has(value!.trim().toLowerCase());
}

/**
 * Computes the score and the reasons behind it.
 *
 * Reasons are returned rather than stored in a new column: they are derived
 * data, and recording them in activity metadata (see `leads.ts`) keeps the
 * explanation without a schema change.
 */
export function scoreLead(lead: ScorableLead): ScoreResult {
  const reasons: ScoreReason[] = [];

  const add = (code: string, label: string, points: number) => {
    if (points !== 0) reasons.push({ code, label, points });
  };

  if (lead.decisionMakerIdentified) {
    add(
      "DECISION_MAKER",
      "Decision maker identified",
      SCORE_WEIGHTS.DECISION_MAKER,
    );
  }

  if (hasText(lead.serviceInterest)) {
    add(
      "SERVICE_INTEREST",
      "Service interest captured",
      SCORE_WEIGHTS.SERVICE_INTEREST,
    );
  }

  if (hasText(lead.painPoint)) {
    add("PAIN_POINT", "Pain point identified", SCORE_WEIGHTS.PAIN_POINT);
  }

  // Website opportunity. `websitePresent` is a nullable tri-state: null means
  // "not researched yet" and scores nothing either way.
  if (lead.websitePresent === false) {
    add("WEBSITE_ABSENT", "No website — direct opportunity", SCORE_WEIGHTS.WEBSITE_ABSENT);
  } else if (
    lead.websitePresent === true &&
    hasText(lead.websiteQuality) &&
    WEAK_WEBSITE_VALUES.has(lead.websiteQuality!.trim().toLowerCase())
  ) {
    add("WEBSITE_WEAK", "Website needs improvement", SCORE_WEIGHTS.WEBSITE_WEAK);
  }

  if (isActive(lead.advertisingActivity)) {
    add(
      "ADVERTISING_ACTIVE",
      "Actively advertising — budget exists",
      SCORE_WEIGHTS.ADVERTISING_ACTIVE,
    );
  }

  if (isActive(lead.contentActivity)) {
    add("CONTENT_ACTIVE", "Publishing content", SCORE_WEIGHTS.CONTENT_ACTIVE);
  }

  if (hasText(lead.qualificationNotes)) {
    add(
      "QUALIFICATION_NOTES",
      "Qualification research recorded",
      SCORE_WEIGHTS.QUALIFICATION_NOTES,
    );
  }

  if (hasText(lead.email) || hasText(lead.phone) || hasText(lead.linkedinUrl)) {
    add("REACHABLE", "Contact channel available", SCORE_WEIGHTS.REACHABLE);
  }

  if (hasText(lead.industry) && hasText(lead.companySize)) {
    add("FIRMOGRAPHICS", "Industry and size known", SCORE_WEIGHTS.FIRMOGRAPHICS);
  }

  const stagePoints = STAGE_POINTS[lead.status];
  if (stagePoints > 0) {
    add("PIPELINE_STAGE", `Pipeline stage: ${lead.status}`, stagePoints);
  }

  const rawTotal = reasons.reduce((total, reason) => total + reason.points, 0);

  return {
    score: Math.max(MIN_SCORE, Math.min(MAX_SCORE, rawTotal)),
    reasons,
    rawTotal,
  };
}

/** Compact form suitable for JSON activity metadata. */
export function scoreMetadata(result: ScoreResult) {
  return {
    score: result.score,
    reasons: result.reasons.map((reason) => ({
      code: reason.code,
      points: reason.points,
    })),
  };
}
