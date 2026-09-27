/**
 * Local Ollama provider.
 *
 * Talks only to the configured origin, and only to the three routes Ollama
 * documents for this job: version, tags, and chat. No paid API, no fallback
 * model, and no invented completion when the server is down — a failure is a
 * structured error and the caller decides what "unknown" looks like.
 *
 * The endpoint is re-checked on every call. A hand-built config that points at
 * the metadata address must not be fetched just because it skipped the env
 * reader.
 */

import type { AiConfig } from "./config";
import { assessOperatorEndpoint, endpointUrl, type ResolvedEndpoint } from "./endpoint";
import { boundedRequest, type BoundedHttpResult } from "./http";
import type {
  AiCallOptions,
  AiCompletionRequest,
  AiCompletionResult,
  AiProbeResult,
  AiProvider,
} from "./provider";
import {
  aiError,
  MAX_PROVIDER_RETRIES,
  type AiError,
} from "./types";

const HARD_MAX_BYTES = 1_048_576;
const HARD_MAX_TOKENS = 2_048;
const HARD_MAX_TIMEOUT_MS = 120_000;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function safeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[0-9A-Za-z._-]{1,32}$/.test(value) ? value : null;
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `llama3.2` matches `llama3.2:latest` and nothing else. A different tag is a
 * different model; reporting it as available would be a guess.
 */
export function modelIsAvailable(configured: string, installed: readonly string[]): boolean {
  const wanted = configured.trim();
  if (wanted === "") return false;

  for (const name of installed) {
    if (name === wanted) return true;
    if (!wanted.includes(":") && name === `${wanted}:latest`) return true;
  }

  return false;
}

function installedModels(payload: unknown): string[] | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;

  const names: string[] = [];
  for (const entry of models) {
    if (names.length >= 200) break;
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; model?: unknown };
    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.model === "string"
          ? record.model
          : null;
    if (name !== null && /^[A-Za-z0-9._:/-]{1,128}$/.test(name)) names.push(name);
  }

  return names;
}

function resolveEndpoint(config: AiConfig): ResolvedEndpoint | AiError {
  const assessed = assessOperatorEndpoint(config.endpoint);
  if (!assessed.ok) return assessed.error;
  return assessed.endpoint;
}

function isEndpoint(value: ResolvedEndpoint | AiError): value is ResolvedEndpoint {
  return "origin" in value;
}

export interface OllamaProviderOptions {
  fetchImpl?: typeof fetch;
}

export class OllamaProvider implements AiProvider {
  readonly key = "ollama" as const;
  readonly label = "Ollama";
  readonly requiresNetwork = true as const;

  constructor(private readonly options: OllamaProviderOptions = {}) {}

  async probe(
    config: AiConfig,
    options: AiCallOptions & { checkModel: boolean },
  ): Promise<AiProbeResult> {
    const started = Date.now();
    const endpoint = resolveEndpoint(config);
    if (!isEndpoint(endpoint)) {
      return {
        reachable: false,
        modelAvailable: null,
        version: null,
        latencyMs: 0,
        error: endpoint,
      };
    }

    const version = await this.request(endpoint, "/api/version", "GET", undefined, config, options);
    if (!version.ok) {
      return {
        reachable: false,
        modelAvailable: null,
        version: null,
        latencyMs: Math.max(0, Date.now() - started),
        error: version.error,
      };
    }

    const versionPayload = parseJson(version.text);
    if (versionPayload === undefined || versionPayload === null || typeof versionPayload !== "object") {
      return {
        reachable: false,
        modelAvailable: null,
        version: null,
        latencyMs: Math.max(0, Date.now() - started),
        error: aiError("malformed_response"),
      };
    }

    if (!options.checkModel) {
      return {
        reachable: true,
        modelAvailable: null,
        version: safeVersion((versionPayload as { version?: unknown }).version),
        latencyMs: Math.max(0, Date.now() - started),
        error: null,
      };
    }

    const tags = await this.request(endpoint, "/api/tags", "GET", undefined, config, options);
    if (!tags.ok) {
      return {
        reachable: true,
        modelAvailable: false,
        version: safeVersion((versionPayload as { version?: unknown }).version),
        latencyMs: Math.max(0, Date.now() - started),
        error: tags.error,
      };
    }

    const names = installedModels(parseJson(tags.text));
    if (names === null) {
      return {
        reachable: true,
        modelAvailable: false,
        version: safeVersion((versionPayload as { version?: unknown }).version),
        latencyMs: Math.max(0, Date.now() - started),
        error: aiError("malformed_response"),
      };
    }

    const available = modelIsAvailable(config.model, names);
    return {
      reachable: true,
      modelAvailable: available,
      version: safeVersion((versionPayload as { version?: unknown }).version),
      latencyMs: Math.max(0, Date.now() - started),
      error: available ? null : aiError("model_unavailable"),
      };
  }

  async complete(
    config: AiConfig,
    request: AiCompletionRequest,
    options: AiCallOptions,
  ): Promise<AiCompletionResult> {
    const started = Date.now();
    const endpoint = resolveEndpoint(config);
    if (!isEndpoint(endpoint)) {
      return { ok: false, error: endpoint, durationMs: 0 };
    }

    const body = JSON.stringify({
      model: config.model,
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      options: {
        temperature: 0,
        seed: 0,
        num_predict: clamp(request.maxOutputTokens, 16, HARD_MAX_TOKENS),
      },
    });

    if (new TextEncoder().encode(body).byteLength > clamp(config.maxResponseBytes, 256, HARD_MAX_BYTES)) {
      return { ok: false, error: aiError("prompt_too_large"), durationMs: 0 };
    }

    const extra = clamp(config.maxRetries, 0, MAX_PROVIDER_RETRIES);
    let last: BoundedHttpResult | null = null;

    for (let attempt = 0; attempt <= extra; attempt++) {
      if (options.signal?.aborted) {
        return { ok: false, error: aiError("cancelled"), durationMs: Math.max(0, Date.now() - started) };
      }

      last = await this.request(endpoint, "/api/chat", "POST", body, config, options);
      const retry =
        !last.ok && last.error.code === "unreachable" && attempt < extra && !options.signal?.aborted;
      if (!retry) break;
    }

    const result = last ?? { ok: false as const, error: aiError("unreachable"), durationMs: 0 };
    if (!result.ok) {
      return {
        ok: false,
        error: chatFailure(result.error),
        durationMs: Math.max(0, Date.now() - started),
      };
    }

    return readChat(result.text, config, Math.max(0, Date.now() - started));
  }

  private request(
    endpoint: ResolvedEndpoint,
    path: "/api/version" | "/api/tags" | "/api/chat",
    method: "GET" | "POST",
    body: string | undefined,
    config: AiConfig,
    options: AiCallOptions,
  ): Promise<BoundedHttpResult> {
    return boundedRequest({
      url: endpointUrl(endpoint, path),
      method,
      body,
      timeoutMs: clamp(options.timeoutMs, 1, HARD_MAX_TIMEOUT_MS),
      maxBytes: clamp(config.maxResponseBytes, 256, HARD_MAX_BYTES),
      fetchImpl: this.options.fetchImpl,
      signal: options.signal,
    });
  }
}

/**
 * A 404 on the chat route is Ollama's "model not found", not a generic HTTP
 * failure. The body is not read — the status is enough, and the body can echo
 * the model name plus whatever else the server felt like including.
 */
function chatFailure(error: AiError): AiError {
  if (error.code === "http_error" && error.statusCode === 404) {
    return aiError("model_unavailable", 404);
  }
  return error;
}

function readChat(text: string, config: AiConfig, durationMs: number): AiCompletionResult {
  const payload = parseJson(text);
  if (payload === undefined || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: aiError("malformed_response"), durationMs };
  }

  const record = payload as { done?: unknown; error?: unknown; message?: unknown };
  if (typeof record.error === "string" && record.error !== "") {
    return { ok: false, error: aiError("malformed_response"), durationMs };
  }

  if (record.done === false) {
    return { ok: false, error: aiError("output_too_large"), durationMs };
  }

  if (record.message === null || typeof record.message !== "object") {
    return { ok: false, error: aiError("malformed_response"), durationMs };
  }

  const content = (record.message as { content?: unknown }).content;
  if (typeof content !== "string" || content.trim() === "") {
    return { ok: false, error: aiError("malformed_response"), durationMs };
  }

  if (content.length > clamp(config.maxOutputChars, 64, 32_000)) {
    return { ok: false, error: aiError("output_too_large"), durationMs };
  }

  return { ok: true, text: content, model: config.model, durationMs };
}

export const ollamaProvider = new OllamaProvider();
