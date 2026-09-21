import { LeadStatus } from "@prisma/client";

/**
 * Pipeline board columns, in workflow order.
 *
 * These are the *visible* stages. Some lead statuses are working states that
 * do not get their own column (see STATUS_STAGE below) — they are grouped so
 * the board stays readable without hiding any record.
 */
export const PIPELINE_STAGES = [
  "NEW",
  "QUALIFIED",
  "CONTACTED",
  "RESPONDED",
  "DISCOVERY_CALL",
  "PROPOSAL",
  "NEGOTIATION",
  "WON",
  "LOST",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** The status a lead takes when dropped into a given column. */
export const stageStatus: Record<PipelineStage, LeadStatus> = {
  NEW: LeadStatus.NEW,
  QUALIFIED: LeadStatus.QUALIFIED,
  CONTACTED: LeadStatus.CONTACTED,
  RESPONDED: LeadStatus.RESPONDED,
  DISCOVERY_CALL: LeadStatus.DISCOVERY_CALL,
  PROPOSAL: LeadStatus.PROPOSAL,
  NEGOTIATION: LeadStatus.NEGOTIATION,
  WON: LeadStatus.WON,
  LOST: LeadStatus.LOST,
};

/**
 * Which column each status is displayed in.
 *
 * RESEARCHING/OUTREACH_READY/NURTURE are real working states but share a
 * column with their nearest milestone, so no lead ever disappears from the
 * board.
 */
export const STATUS_STAGE: Record<LeadStatus, PipelineStage> = {
  NEW: "NEW",
  RESEARCHING: "NEW",
  QUALIFIED: "QUALIFIED",
  OUTREACH_READY: "QUALIFIED",
  CONTACTED: "CONTACTED",
  RESPONDED: "RESPONDED",
  DISCOVERY_CALL: "DISCOVERY_CALL",
  PROPOSAL: "PROPOSAL",
  NEGOTIATION: "NEGOTIATION",
  WON: "WON",
  LOST: "LOST",
  NURTURE: "NEW",
};

/**
 * Allowed status transitions.
 *
 * Status is never set by arbitrary client input: a move is only applied when
 * the target appears in the current status's list. This keeps the pipeline a
 * real workflow rather than a free-form enum field, and makes every stage
 * reachable through a legitimate path.
 *
 * The happy path is
 *   NEW -> RESEARCHING -> QUALIFIED -> OUTREACH_READY -> CONTACTED ->
 *   RESPONDED -> DISCOVERY_CALL -> PROPOSAL -> NEGOTIATION -> WON
 * with NURTURE and LOST available as exits from any active stage, and a way
 * back into the pipeline from both.
 */
export const ALLOWED_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  NEW: ["RESEARCHING", "QUALIFIED", "NURTURE", "LOST"],
  RESEARCHING: ["QUALIFIED", "NURTURE", "LOST"],
  QUALIFIED: ["OUTREACH_READY", "CONTACTED", "NURTURE", "LOST"],
  OUTREACH_READY: ["CONTACTED", "NURTURE", "LOST"],
  CONTACTED: ["RESPONDED", "DISCOVERY_CALL", "NURTURE", "LOST"],
  RESPONDED: ["DISCOVERY_CALL", "PROPOSAL", "NURTURE", "LOST"],
  DISCOVERY_CALL: ["PROPOSAL", "NURTURE", "LOST"],
  PROPOSAL: ["NEGOTIATION", "WON", "LOST", "NURTURE"],
  NEGOTIATION: ["WON", "LOST", "NURTURE"],
  // WON is terminal: re-engagement belongs to a future repeat-business flow.
  WON: [],
  LOST: ["NURTURE", "RESEARCHING"],
  NURTURE: ["RESEARCHING", "QUALIFIED", "LOST"],
};

export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Valid next statuses, for rendering a status control. */
export function nextStatuses(from: LeadStatus): readonly LeadStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

export const ALL_LEAD_STATUSES = Object.keys(
  ALLOWED_TRANSITIONS,
) as LeadStatus[];
