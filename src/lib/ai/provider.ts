/**
 * The AI provider contract.
 *
 * One interface. The execution and health layers depend on this, not on
 * Ollama. A second provider would implement the same methods; this phase
 * ships only the local one, and an unknown provider name is a configuration
 * error rather than a silent fall-through to a paid API.
 *
 * The discovery `Fetcher` is intentionally not this contract. That fetcher
 * enforces robots.txt and refuses loopback, which is correct for untrusted
 * pages and wrong for an operator-configured model host.
 */

import type { AiConfig } from "./config";
import type { AiError } from "./types";

export interface AiCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AiProbeResult {
  reachable: boolean;
  /**
   * `null` when the probe was not asked to list models. `null` is not
   * availability — callers must treat only `true` as the model being present.
   */
  modelAvailable: boolean | null;
  version: string | null;
  latencyMs: number;
  error: AiError | null;
}

export interface AiCompletionRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
}

export interface AiCompletionSuccess {
  ok: true;
  /** Raw model text. Not trusted. The validator decides what, if anything, stands. */
  text: string;
  model: string;
  durationMs: number;
}

export interface AiCompletionFailure {
  ok: false;
  error: AiError;
  durationMs: number;
}

export type AiCompletionResult = AiCompletionSuccess | AiCompletionFailure;

export interface AiProvider {
  /** Stable key stored in configuration. `ollama` is the only one shipped. */
  readonly key: "ollama";
  readonly label: string;
  readonly requiresNetwork: true;
  /**
   * Live check. `checkModel` lists installed models; a version probe alone
   * must leave `modelAvailable` null.
   */
  probe(
    config: AiConfig,
    options: AiCallOptions & { checkModel: boolean },
  ): Promise<AiProbeResult>;
  /**
   * One completion. Must not follow redirects, must not call any URL other
   * than the configured origin's chat route, and must not retry a timeout.
   */
  complete(
    config: AiConfig,
    request: AiCompletionRequest,
    options: AiCallOptions,
  ): Promise<AiCompletionResult>;
}
