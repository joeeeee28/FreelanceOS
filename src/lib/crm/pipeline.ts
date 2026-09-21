import { LeadStatus } from "@prisma/client";

export const PIPELINE_STAGES = [
  "NEW",
  "QUALIFIED",
  "CONTACTED",
  "RESPONDED",
  "CALL",
  "PROPOSAL",
  "NEGOTIATION",
  "WON",
  "LOST",
] as const;

export type PipelineStage =
  (typeof PIPELINE_STAGES)[number];

export const stageStatus: Record<
  PipelineStage,
  LeadStatus
> = {
  NEW: LeadStatus.NEW,
  QUALIFIED: LeadStatus.QUALIFIED,
  CONTACTED: LeadStatus.CONTACTED,
  RESPONDED: LeadStatus.RESPONDED,
  CALL: LeadStatus.DISCOVERY_CALL,
  PROPOSAL: LeadStatus.PROPOSAL,
  NEGOTIATION: LeadStatus.NEGOTIATION,
  WON: LeadStatus.WON,
  LOST: LeadStatus.LOST,
};
