/**
 * Runtime health for the local AI provider.
 *
 * Configuration is reported separately from the probe. A parsed endpoint is
 * `configured`. It becomes `reachable` only after the version route answers,
 * and `model_available` only after the tags route lists the configured model.
 * Nothing in this file treats a present env var as health.
 *
 * The probe is skipped entirely when AI is disabled or the configuration is
 * invalid, so a bad endpoint is never contacted and a disabled deployment
 * does not depend on Ollama being installed.
 */

import { readAiConfig, type AiConfigResolution, type EnvSource } from "./config";
import { createAiProvider } from "./registry";
import {
  aiError,
  isAiHealthy,
  type AiError,
  type AiRuntimeState,
} from "./types";

export interface AiHealthChecks {
  enabled: boolean;
  configurationValid: boolean;
  probed: boolean;
  reachable: boolean;
  modelAvailable: boolean;
}

export interface AiHealthReport {
  configuration: AiConfigResolution["configuration"];
  state: AiRuntimeState;
  healthy: boolean;
  enabled: boolean;
  provider: string | null;
  model: string | null;
  /** Host and port only. Never a URL with userinfo, path, or query. */
  endpointHost: string | null;
  probed: boolean;
  reachable: boolean;
  modelAvailable: boolean;
  checkedAt: string;
  latencyMs: number | null;
  version: string | null;
  error: AiError | null;
  problems: AiError[];
  checks: AiHealthChecks;
}

export interface AiHealthOptions {
  env?: EnvSource;
  fetchImpl?: typeof fetch;
  now?: Date;
  /**
   * When false, do not contact the network. The report then stays at
   * `configured` (or `disabled` / `error`) and `healthy` is false.
   */
  probe?: boolean;
  signal?: AbortSignal;
}

export function deriveAiHealthState(input: {
  enabled: boolean;
  configured: boolean;
  probed: boolean;
  reachable: boolean;
  modelAvailable: boolean;
  failure: "none" | "network" | "error";
}): AiRuntimeState {
  if (!input.enabled) return "disabled";
  if (!input.configured) return "error";
  if (!input.probed) return "configured";
  if (!input.reachable) {
    return input.failure === "network" ? "unavailable" : "error";
  }
  if (input.failure === "error") return "error";
  if (input.modelAvailable && input.failure === "none") return "model_available";
  return "reachable";
}

function reportFrom(
  resolution: AiConfigResolution,
  now: Date,
  extra: Partial<AiHealthReport> & { state: AiRuntimeState },
): AiHealthReport {
  const state = extra.state;
  const reachable = extra.reachable ?? false;
  const modelAvailable = extra.modelAvailable ?? false;
  const probed = extra.probed ?? false;

  return {
    configuration: resolution.configuration,
    state,
    healthy: isAiHealthy(state),
    enabled: resolution.config.enabled,
    provider:
      extra.provider !== undefined
        ? extra.provider
        : resolution.configuration === "disabled"
          ? null
          : resolution.config.provider,
    model: extra.model !== undefined ? extra.model : resolution.model,
    endpointHost:
      extra.endpointHost !== undefined
        ? extra.endpointHost
        : (resolution.endpoint?.host ?? null),
    probed,
    reachable,
    modelAvailable,
    checkedAt: now.toISOString(),
    latencyMs: extra.latencyMs ?? null,
    version: extra.version ?? null,
    error: extra.error ?? null,
    problems: extra.problems ?? resolution.problems,
    checks: {
      enabled: resolution.config.enabled,
      configurationValid: resolution.configuration === "configured",
      probed,
      reachable,
      modelAvailable,
    },
  };
}

function failureKind(code: string | undefined): "none" | "network" | "error" {
  if (code === undefined) return "none";
  if (code === "unreachable" || code === "timeout" || code === "cancelled") return "network";
  return "error";
}

/**
 * Live health. Never throws: an unexpected failure becomes an error report
 * whose message does not include the thrown value.
 */
export async function getAiHealth(options: AiHealthOptions = {}): Promise<AiHealthReport> {
  const now = options.now ?? new Date();

  try {
    const resolution = readAiConfig(options.env);
    const shouldProbe = options.probe !== false && resolution.configuration === "configured";

    if (!shouldProbe) {
      const state = deriveAiHealthState({
        enabled: resolution.config.enabled,
        configured: resolution.configuration === "configured",
        probed: false,
        reachable: false,
        modelAvailable: false,
        failure: resolution.configuration === "invalid" ? "error" : "none",
      });
      const disabled = resolution.configuration === "disabled";
      return reportFrom(resolution, now, {
        state,
        error: disabled ? null : (resolution.problems[0] ?? null),
        // A disabled deployment has not selected a host. Showing the default
        // loopback address would look like a connection we are about to make.
        endpointHost: disabled ? null : (resolution.endpoint?.host ?? null),
        provider: disabled ? null : resolution.config.provider,
        model: disabled ? null : resolution.model,
      });
    }

    const provider = createAiProvider(resolution.config.provider, {
      fetchImpl: options.fetchImpl,
    });
    if (provider === null) {
      return reportFrom(resolution, now, {
        state: "error",
        error: aiError("unsupported_provider"),
        problems: [aiError("unsupported_provider")],
      });
    }

    const probe = await provider.probe(resolution.config, {
      timeoutMs: resolution.config.healthTimeoutMs,
      signal: options.signal,
      checkModel: true,
    });

    const failure = probe.error === null ? "none" : failureKind(probe.error.code);
    const modelAvailable = probe.modelAvailable === true;
    const state = deriveAiHealthState({
      enabled: true,
      configured: true,
      probed: true,
      reachable: probe.reachable,
      modelAvailable,
      failure: probe.reachable && !modelAvailable && probe.error?.code === "model_unavailable"
        ? "none"
        : failure,
    });

    return reportFrom(resolution, now, {
      state,
      probed: true,
      reachable: probe.reachable,
      modelAvailable,
      latencyMs: probe.latencyMs,
      version: probe.version,
      error: state === "model_available" ? null : probe.error,
    });
  } catch {
    return {
      configuration: "invalid",
      state: "error",
      healthy: false,
      enabled: false,
      provider: null,
      model: null,
      endpointHost: null,
      probed: false,
      reachable: false,
      modelAvailable: false,
      checkedAt: now.toISOString(),
      latencyMs: null,
      version: null,
      error: aiError("invalid_configuration"),
      problems: [aiError("invalid_configuration")],
      checks: {
        enabled: false,
        configurationValid: false,
        probed: false,
        reachable: false,
        modelAvailable: false,
      },
    };
  }
}

/**
 * The same probe the health report uses, named for the operator action.
 *
 * Disabled and invalid configurations are not contacted. A passing result is
 * exactly `healthy === true`, which requires the model to be listed.
 */
export async function testAiConnection(options: AiHealthOptions = {}): Promise<AiHealthReport> {
  return getAiHealth({ ...options, probe: true });
}

/** JSON shape for the authenticated health route. No raw endpoint URL. */
export function toPublicAiHealth(report: AiHealthReport) {
  return {
    configuration: report.configuration,
    state: report.state,
    healthy: report.healthy,
    enabled: report.enabled,
    provider: report.provider,
    model: report.model,
    endpointHost: report.endpointHost,
    probed: report.probed,
    reachable: report.reachable,
    modelAvailable: report.modelAvailable,
    checkedAt: report.checkedAt,
    latencyMs: report.latencyMs,
    version: report.version,
    error: report.error,
    problems: report.problems,
    checks: report.checks,
  };
}
