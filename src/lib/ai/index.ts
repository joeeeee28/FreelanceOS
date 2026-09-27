/**
 * Local AI layer.
 *
 * Import from here, or from the specific module, rather than from the Ollama
 * client. The rest of FreelanceOS must not depend on Ollama types or URLs.
 *
 * Scoring, discovery, and the worker do not import this barrel. Calling
 * `executeAi` is an explicit interpretation of evidence the caller already
 * holds. It does not search, enrich, or write.
 */

export { readAiConfig, AI_DEFAULTS, AI_LIMITS } from "./config";
export type { AiConfig, AiConfigResolution, AiConfigurationStatus } from "./config";

export { assessOperatorEndpoint } from "./endpoint";
export type { ResolvedEndpoint } from "./endpoint";

export { executeAi, interpretedValue, AI_SYSTEM_PROMPT, parseModelJson } from "./execute";
export type { AiExecutionResult, AiExecutionOutcome, ExecuteAiInput } from "./execute";

export {
  prepareEvidence,
  validateModelOutput,
  evidenceFromObservation,
  evidenceFromLead,
  evidenceFromContact,
  evidenceFromCompany,
  claimValue,
} from "./evidence";
export type {
  EvidenceItemInput,
  GroundedClaim,
  RejectedClaim,
  PreparedEvidence,
} from "./evidence";

export { getAiHealth, testAiConnection, toPublicAiHealth, deriveAiHealthState } from "./health";
export type { AiHealthReport, AiHealthOptions } from "./health";

export { createAiProvider } from "./registry";
export type { AiProvider } from "./provider";

export { isAiHealthy, AI_STATE_LABELS, AI_RUNTIME_STATES } from "./types";
export type { AiRuntimeState, AiError, AiErrorCode } from "./types";
