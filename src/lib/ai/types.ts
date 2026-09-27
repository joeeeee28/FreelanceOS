/**
 * Shared vocabulary for the local AI layer.
 *
 * AI is an interpreter of evidence FreelanceOS already holds. It is not a
 * source of truth, and nothing in this module is a permission to write a CRM
 * fact. Health states are named so "the settings parse" cannot be confused
 * with "the model answered".
 */

export const AI_RUNTIME_STATES = [
  "disabled",
  "configured",
  "reachable",
  "model_available",
  "unavailable",
  "error",
] as const;

export type AiRuntimeState = (typeof AI_RUNTIME_STATES)[number];

/** Operator-facing labels. `configured` is deliberately not "Healthy". */
export const AI_STATE_LABELS: Record<AiRuntimeState, string> = {
  disabled: "Disabled",
  configured: "Configured",
  reachable: "Reachable",
  model_available: "Model available",
  unavailable: "Unavailable",
  error: "Error",
};

/**
 * The only state that may be called healthy.
 *
 * Reachable-but-missing-model, and a config file that has not been probed,
 * are both not healthy. Callers that want a boolean must use this function
 * rather than inferring one from "we have an endpoint".
 */
export function isAiHealthy(state: AiRuntimeState): boolean {
  return state === "model_available";
}

export const AI_ERROR_CODES = [
  "disabled",
  "invalid_configuration",
  "unsupported_provider",
  "endpoint_rejected",
  "unreachable",
  "timeout",
  "cancelled",
  "redirect_refused",
  "http_error",
  "response_too_large",
  "malformed_response",
  "model_unavailable",
  "output_too_large",
  "output_rejected",
  "prompt_too_large",
  "instruction_required",
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/**
 * A failure a caller can branch on.
 *
 * `message` is written for an operator. It must never contain a URL credential,
 * a prompt, a model body, or a secret. `statusCode` is set only when the
 * server actually returned one.
 */
export interface AiError {
  code: AiErrorCode;
  message: string;
  statusCode?: number;
}

const ERROR_MESSAGES: Record<AiErrorCode, string> = {
  disabled: "AI is disabled.",
  invalid_configuration: "AI configuration is missing or out of range.",
  unsupported_provider: "Only the local Ollama provider is supported.",
  endpoint_rejected: "The AI endpoint was rejected by the network guard.",
  unreachable: "The AI server could not be reached.",
  timeout: "The AI server did not respond before the timeout.",
  cancelled: "The AI request was cancelled.",
  redirect_refused: "The AI server returned a redirect, which was not followed.",
  http_error: "The AI server returned an error response.",
  response_too_large: "The AI response exceeded the size limit.",
  malformed_response: "The AI server returned a response that could not be read.",
  model_unavailable: "The configured model is not available on the AI server.",
  output_too_large: "The model output exceeded the size limit.",
  output_rejected: "The model output was not usable and was discarded.",
  prompt_too_large: "The evidence prompt exceeded the size limit.",
  instruction_required: "An instruction is required.",
};

export function aiError(code: AiErrorCode, statusCode?: number): AiError {
  const error: AiError = { code, message: ERROR_MESSAGES[code] };
  if (statusCode !== undefined) error.statusCode = statusCode;
  return error;
}

/** Names a single env var in an invalid-configuration error. The name is checked. */
export function invalidConfig(name: string): AiError {
  const safe = /^[A-Z][A-Z0-9_]{0,39}$/.test(name) ? name : "configuration";
  return {
    code: "invalid_configuration",
    message: `${safe} is missing or out of range.`,
  };
}

/** Reason codes from the endpoint guard are a closed vocabulary, not raw URLs. */
export function endpointRejected(reason: string): AiError {
  const safe = /^[a-z0-9-]{1,40}$/.test(reason) ? reason : "invalid";
  return {
    code: "endpoint_rejected",
    message: `Endpoint rejected (${safe}).`,
  };
}

export function httpError(statusCode: number): AiError {
  const status = Number.isInteger(statusCode) ? statusCode : 0;
  return {
    code: "http_error",
    message: `The AI server returned HTTP ${status}.`,
    statusCode: status,
  };
}

/**
 * Hard ceiling on transport retries, regardless of what a caller passes.
 *
 * One extra attempt is the most this layer will ever make, and only for a
 * connection failure that produced no response. Timeouts are not retried.
 */
export const MAX_PROVIDER_RETRIES = 1;
