/**
 * Optional explanation of people already stored.
 *
 * Does not write, does not create a person, and does not replace a stored
 * title or contact field. If the model is absent, the stored rows remain.
 */

import { readAiConfig, type EnvSource } from "@/lib/ai/config";
import { executeAi } from "@/lib/ai/execute";
import type { EvidenceItemInput } from "@/lib/ai/evidence";

import type { StoredPerson } from "./store";

export const DECISION_MAKER_INTERPRETATION_UNAVAILABLE = "AI interpretation unavailable.";

export interface DecisionMakerInterpretation {
  available: boolean;
  message: string;
  summary: string | null;
  rejectedCount: number;
}

const INSTRUCTION = [
  "Explain only the people already named in the evidence.",
  "Do not invent a person, title, email, phone, website, or employer.",
  "If the evidence does not support a sentence, leave the summary null.",
].join(" ");

function evidenceOf(people: readonly StoredPerson[]): EvidenceItemInput[] {
  const items: EvidenceItemInput[] = [];
  for (const person of people) {
    const text = [person.fullName, person.jobTitle, person.evidence].filter(Boolean).join(". ");
    if (text.trim() === "") continue;
    items.push({
      id: person.id,
      kind: "contact",
      field: "note",
      value: text,
      text,
      sourceUrl: person.sourceUrl,
      confidence: person.confidence,
      observedAt: person.lastSeenAt,
    });
    if (items.length >= 8) break;
  }
  return items;
}

export async function interpretDecisionMakers(
  people: readonly StoredPerson[],
  options: { env?: EnvSource; fetchImpl?: typeof fetch } = {},
): Promise<DecisionMakerInterpretation> {
  const evidence = evidenceOf(people);
  if (evidence.length === 0) {
    return {
      available: false,
      message: "No evidenced person is stored, so nothing was interpreted.",
      summary: null,
      rejectedCount: 0,
    };
  }

  const source = options.env ?? process.env;
  const configured = readAiConfig(source);
  const timeoutMs = Math.min(configured.config.timeoutMs, 8_000);
  const result = await executeAi({
    instruction: INSTRUCTION,
    evidence,
    env: { ...source, AI_TIMEOUT_MS: String(timeoutMs) },
    fetchImpl: options.fetchImpl,
  });

  if (result.outcome === "disabled" || result.outcome === "unavailable") {
    return {
      available: false,
      message: DECISION_MAKER_INTERPRETATION_UNAVAILABLE,
      summary: null,
      rejectedCount: 0,
    };
  }

  if (result.summary === null) {
    return {
      available: true,
      message: "The model reply was discarded because it was not supported by the evidence.",
      summary: null,
      rejectedCount: result.rejected.length,
    };
  }

  return {
    available: true,
    message: "Interpretation only. This was not saved and it is not a CRM fact.",
    summary: result.summary,
    rejectedCount: result.rejected.length,
  };
}
