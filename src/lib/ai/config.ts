/**
 * AI configuration.
 *
 * Deployment settings, read the same way the rest of FreelanceOS reads
 * operator configuration: from the environment, with safe defaults, and never
 * from a lead, a page, or a model reply. Nothing here is required. An absent
 * variable means AI is off, and a malformed variable must not take the process
 * down — scoring, discovery, and the worker do not read this module.
 *
 * A successful parse is not a health check. `healthy` on the resolution is a
 * literal `false` so a caller cannot treat "the endpoint string parsed" as
 * "the model is up".
 */

import { assessOperatorEndpoint, type ResolvedEndpoint } from "./endpoint";
import {
  aiError,
  invalidConfig,
  type AiError,
} from "./types";

export const AI_DEFAULTS = {
  enabled: false,
  provider: "ollama",
  model: "",
  endpoint: "http://127.0.0.1:11434",
  timeoutMs: 15_000,
  healthTimeoutMs: 2_000,
  maxResponseBytes: 256 * 1024,
  maxOutputTokens: 512,
  maxOutputChars: 8_000,
  maxPromptChars: 8_000,
  maxEvidenceItems: 20,
  maxEvidenceItemChars: 500,
  maxClaims: 20,
  maxRetries: 0,
} as const;

export const AI_LIMITS = {
  timeoutMs: { min: 50, max: 120_000 },
  healthTimeoutMs: { min: 50, max: 10_000 },
  maxResponseBytes: { min: 256, max: 1_048_576 },
  maxOutputTokens: { min: 16, max: 2_048 },
  maxOutputChars: { min: 64, max: 32_000 },
  maxPromptChars: { min: 256, max: 32_000 },
  maxEvidenceItems: { min: 1, max: 50 },
  maxEvidenceItemChars: { min: 32, max: 2_000 },
  maxClaims: { min: 1, max: 50 },
  maxRetries: { min: 0, max: 1 },
} as const;

export interface AiConfig {
  enabled: boolean;
  provider: string;
  model: string;
  endpoint: string;
  timeoutMs: number;
  healthTimeoutMs: number;
  maxResponseBytes: number;
  maxOutputTokens: number;
  maxOutputChars: number;
  maxPromptChars: number;
  maxEvidenceItems: number;
  maxEvidenceItemChars: number;
  maxClaims: number;
  maxRetries: number;
}

export type AiConfigurationStatus = "disabled" | "configured" | "invalid";

export interface AiConfigResolution {
  config: AiConfig;
  configuration: AiConfigurationStatus;
  /**
   * Always false. Configuration existing is not health. A live probe is the
   * only thing that may set a health report's `healthy` to true, and only
   * when the configured model is actually present.
   */
  healthy: false;
  problems: AiError[];
  endpoint: ResolvedEndpoint | null;
  /** Model name when it passed the charset check. Never the raw env value. */
  model: string | null;
}

export type EnvSource = Record<string, string | undefined>;

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENABLED = new Set(["1", "true", "yes", "on"]);

function readEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ENABLED.has(raw.trim().toLowerCase());
}

function readBoundedInt(
  raw: string | undefined,
  name: string,
  bounds: { min: number; max: number },
  fallback: number,
  problems: AiError[],
  enforce: boolean,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;

  const text = raw.trim();
  if (!/^[0-9]+$/.test(text)) {
    if (enforce) problems.push(invalidConfig(name));
    return fallback;
  }

  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    if (enforce) problems.push(invalidConfig(name));
    return fallback;
  }

  return value;
}

/**
 * Reads AI settings from an env-shaped record.
 *
 * Does not throw. Does not contact the network. Does not read `process.env`
 * unless the caller passes it — tests pass a record so they cannot leak into
 * each other through a module-level cache.
 */
export function readAiConfig(env: EnvSource = process.env): AiConfigResolution {
  const enabled = readEnabled(env.AI_ENABLED);
  const problems: AiError[] = [];

  const providerRaw = env.AI_PROVIDER?.trim().toLowerCase() ?? "";
  const provider = providerRaw === "" ? AI_DEFAULTS.provider : providerRaw;
  if (enabled && provider !== "ollama") {
    problems.push(aiError("unsupported_provider"));
  }

  const modelRaw = env.AI_MODEL?.trim() ?? "";
  const model = modelRaw === "" ? null : MODEL_NAME.test(modelRaw) ? modelRaw : null;
  if (enabled && model === null) {
    problems.push(invalidConfig("AI_MODEL"));
  }

  const endpointRaw = env.AI_ENDPOINT?.trim() || AI_DEFAULTS.endpoint;
  const assessed = assessOperatorEndpoint(endpointRaw);
  if (enabled && !assessed.ok) {
    problems.push(assessed.error);
  }

  const timeoutMs = readBoundedInt(
    env.AI_TIMEOUT_MS,
    "AI_TIMEOUT_MS",
    AI_LIMITS.timeoutMs,
    AI_DEFAULTS.timeoutMs,
    problems,
    enabled,
  );
  let healthTimeoutMs = readBoundedInt(
    env.AI_HEALTH_TIMEOUT_MS,
    "AI_HEALTH_TIMEOUT_MS",
    AI_LIMITS.healthTimeoutMs,
    AI_DEFAULTS.healthTimeoutMs,
    problems,
    enabled,
  );
  if (healthTimeoutMs > timeoutMs) healthTimeoutMs = timeoutMs;

  const maxResponseBytes = readBoundedInt(
    env.AI_MAX_RESPONSE_BYTES,
    "AI_MAX_RESPONSE_BYTES",
    AI_LIMITS.maxResponseBytes,
    AI_DEFAULTS.maxResponseBytes,
    problems,
    enabled,
  );
  const maxOutputTokens = readBoundedInt(
    env.AI_MAX_OUTPUT_TOKENS,
    "AI_MAX_OUTPUT_TOKENS",
    AI_LIMITS.maxOutputTokens,
    AI_DEFAULTS.maxOutputTokens,
    problems,
    enabled,
  );
  const maxOutputChars = readBoundedInt(
    env.AI_MAX_OUTPUT_CHARS,
    "AI_MAX_OUTPUT_CHARS",
    AI_LIMITS.maxOutputChars,
    AI_DEFAULTS.maxOutputChars,
    problems,
    enabled,
  );
  const maxPromptChars = readBoundedInt(
    env.AI_MAX_PROMPT_CHARS,
    "AI_MAX_PROMPT_CHARS",
    AI_LIMITS.maxPromptChars,
    AI_DEFAULTS.maxPromptChars,
    problems,
    enabled,
  );
  const maxEvidenceItems = readBoundedInt(
    env.AI_MAX_EVIDENCE_ITEMS,
    "AI_MAX_EVIDENCE_ITEMS",
    AI_LIMITS.maxEvidenceItems,
    AI_DEFAULTS.maxEvidenceItems,
    problems,
    enabled,
  );
  const maxEvidenceItemChars = readBoundedInt(
    env.AI_MAX_EVIDENCE_ITEM_CHARS,
    "AI_MAX_EVIDENCE_ITEM_CHARS",
    AI_LIMITS.maxEvidenceItemChars,
    AI_DEFAULTS.maxEvidenceItemChars,
    problems,
    enabled,
  );
  const maxClaims = readBoundedInt(
    env.AI_MAX_CLAIMS,
    "AI_MAX_CLAIMS",
    AI_LIMITS.maxClaims,
    AI_DEFAULTS.maxClaims,
    problems,
    enabled,
  );
  const maxRetries = readBoundedInt(
    env.AI_MAX_RETRIES,
    "AI_MAX_RETRIES",
    AI_LIMITS.maxRetries,
    AI_DEFAULTS.maxRetries,
    problems,
    enabled,
  );

  const configuration: AiConfigurationStatus = !enabled
    ? "disabled"
    : problems.length > 0
      ? "invalid"
      : "configured";

  return {
    config: {
      enabled,
      provider,
      model: model ?? "",
      // Never retain a rejected URL. It can carry userinfo or a metadata path,
      // and echoing it into a log or a health payload would undo the guard.
      endpoint: assessed.ok ? assessed.endpoint.origin : "",
      timeoutMs,
      healthTimeoutMs,
      maxResponseBytes,
      maxOutputTokens,
      maxOutputChars,
      maxPromptChars,
      maxEvidenceItems,
      maxEvidenceItemChars,
      maxClaims,
      maxRetries,
    },
    configuration,
    healthy: false,
    problems: enabled ? problems : [],
    endpoint: assessed.ok ? assessed.endpoint : null,
    model,
  };
}
