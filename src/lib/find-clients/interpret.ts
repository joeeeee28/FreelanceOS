/**
 * Optional explanation of a Find Clients result.
 *
 * The score, the action and the opportunity already exist. This function
 * may quote the evidence that supports them. It does not write, it does not
 * change the score, and it does not invent a sentence when the model is
 * absent or the reply is unsupported.
 */

import { readAiConfig, type EnvSource } from "@/lib/ai/config";
import { executeAi, type AiExecutionResult } from "@/lib/ai/execute";
import type { EvidenceItemInput } from "@/lib/ai/evidence";

import type { FindClientDetail, FindClientEvidence } from "./search";

export const FIND_CLIENT_INTERPRETATION_UNAVAILABLE = "AI interpretation unavailable.";
export const FIND_CLIENT_INTERPRETATION_TIMEOUT_CAP_MS = 8_000;

/** Never waits longer than the configured timeout, and never longer than the cap. */
export function interpretationTimeoutMs(configuredMs: number): number {
  if (!Number.isFinite(configuredMs) || configuredMs < 0) return FIND_CLIENT_INTERPRETATION_TIMEOUT_CAP_MS;
  return Math.min(configuredMs, FIND_CLIENT_INTERPRETATION_TIMEOUT_CAP_MS);
}

export interface FindClientInterpretation {
  available: boolean;
  /** Closed message. Never a fabricated analysis. */
  message: string;
  summary: string | null;
  /** Stored score. Never replaced by model output. */
  score: number;
  accepted: AiExecutionResult["accepted"];
  rejectedCount: number;
}

const INSTRUCTION = [
  "Explain the opportunity already recorded in the evidence.",
  "Quote only what the evidence says.",
  "Do not invent a company, person, email, phone, website, problem, statistic, score, or a new opportunity.",
  "If the evidence does not support a sentence, leave the summary null.",
].join(" ");

function evidenceItems(detail: FindClientDetail): EvidenceItemInput[] {
  const rows: FindClientEvidence[] = [...detail.evidence, ...detail.observations];
  const items: EvidenceItemInput[] = [];
  for (const row of rows) {
    const text = row.text ?? row.label;
    if (text.trim() === "") continue;
    items.push({
      id: row.id.replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 80),
      kind: row.kind === "observation" ? "observation" : "signal",
      field: "note",
      value: text,
      text,
      sourceUrl: row.sourceUrl,
      confidence: row.confidence,
      observedAt: row.observedAt,
    });
    if (items.length >= 12) break;
  }
  return items;
}

function unavailable(score: number, message = FIND_CLIENT_INTERPRETATION_UNAVAILABLE): FindClientInterpretation {
  return {
    available: false,
    message,
    summary: null,
    score,
    accepted: [],
    rejectedCount: 0,
  };
}

/**
 * Interprets one already-loaded result. Callers must have loaded that result
 * inside the workspace. This function does not query or write.
 */
export async function interpretFindClient(
  detail: FindClientDetail,
  options: { env?: EnvSource; fetchImpl?: typeof fetch } = {},
): Promise<FindClientInterpretation> {
  const score = detail.opportunity.score;
  const evidence = evidenceItems(detail);
  if (evidence.length === 0) {
    return unavailable(score, "No evidence is stored, so nothing was interpreted.");
  }

  const source = options.env ?? process.env;
  const configured = readAiConfig(source);
  const timeoutMs = interpretationTimeoutMs(configured.config.timeoutMs);

  const result = await executeAi({
    instruction: INSTRUCTION,
    evidence,
    env: { ...source, AI_TIMEOUT_MS: String(timeoutMs) },
    fetchImpl: options.fetchImpl,
  });

  if (result.outcome === "disabled" || result.outcome === "unavailable") {
    return unavailable(score);
  }

  if (result.summary === null && result.accepted.length === 0) {
    return {
      available: true,
      message: "The model reply was discarded because it was not supported by the evidence.",
      summary: null,
      score,
      accepted: [],
      rejectedCount: result.rejected.length,
    };
  }

  return {
    available: true,
    message: "Interpretation only. This is not a CRM fact and it was not saved.",
    summary: result.summary,
    score,
    accepted: result.accepted,
    rejectedCount: result.rejected.length,
  };
}
