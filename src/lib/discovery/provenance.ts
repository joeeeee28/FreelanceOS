/**
 * Provenance and confidence.
 *
 * Every machine-discovered fact carries where it came from and how much we
 * trust it. This module defines that vocabulary and the precedence rule that
 * decides whether a newly observed value is allowed to replace what the CRM
 * currently holds.
 *
 * The rule exists to satisfy one hard requirement: automated discovery must
 * never overwrite stronger, verified data with weaker data. A human edit is
 * MANUAL/100 and is therefore unreachable by any crawler.
 */

/**
 * How a value was obtained. The method determines the confidence, so callers
 * cannot invent a trust level to force a write.
 */
export type ExtractionMethod =
  | "MANUAL"
  | "STRUCTURED_DATA"
  | "HTTP_HEADER"
  | "SITEMAP"
  | "FEED"
  | "META_TAG"
  | "HTML_SELECTOR"
  | "TEXT_HEURISTIC"
  | "INFERRED";

/**
 * Confidence per extraction method, 0-100.
 *
 * Ordering rationale: a human beats everything; data a site publishes about
 * itself in a machine-readable format beats data we scraped out of its markup;
 * anything matched out of prose is weak; anything merely derived is weakest.
 */
export const METHOD_CONFIDENCE: Record<ExtractionMethod, number> = {
  MANUAL: 100,
  STRUCTURED_DATA: 90,
  HTTP_HEADER: 85,
  SITEMAP: 80,
  FEED: 75,
  META_TAG: 70,
  HTML_SELECTOR: 60,
  TEXT_HEURISTIC: 40,
  INFERRED: 25,
};

export const MIN_CONFIDENCE = 0;
export const MAX_CONFIDENCE = 100;

/**
 * Confidence below which a value is recorded as an observation but never
 * promoted onto the Company record. We still keep the sighting — knowing that
 * a weak signal was seen is useful — but it does not become "the truth".
 */
export const PROMOTION_THRESHOLD = 40;

export function confidenceFor(method: ExtractionMethod): number {
  return METHOD_CONFIDENCE[method];
}

/**
 * Clamps an externally supplied confidence into the valid range.
 *
 * NaN is the only value that cannot be ordered, so it floors to the minimum.
 * Infinities are ordered and therefore clamp to their respective bounds —
 * treating +Infinity as 0 would silently discard a maximally confident value.
 */
export function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return MIN_CONFIDENCE;
  if (value >= MAX_CONFIDENCE) return MAX_CONFIDENCE;
  if (value <= MIN_CONFIDENCE) return MIN_CONFIDENCE;
  return Math.trunc(value);
}

/** A fact as currently held, for precedence comparison. */
export interface HeldValue {
  confidence: number;
  observedAt: Date;
}

/** A fact as newly observed. */
export interface IncomingValue {
  confidence: number;
  observedAt: Date;
}

export type PrecedenceDecision =
  | { promote: true; reason: "NO_EXISTING_VALUE" | "HIGHER_CONFIDENCE" | "SAME_CONFIDENCE_NEWER" }
  | {
      promote: false;
      reason:
        | "BELOW_THRESHOLD"
        | "LOWER_CONFIDENCE"
        | "SAME_CONFIDENCE_NOT_NEWER";
    };

/**
 * Decides whether an incoming observation may replace the held value.
 *
 * Rules, in order:
 *  1. Anything below the promotion threshold is never promoted.
 *  2. With no existing value, promote.
 *  3. Strictly higher confidence wins.
 *  4. Equal confidence wins only if strictly newer (refreshes a stale fact
 *     without letting two equally-trusted sources flap back and forth on the
 *     same timestamp).
 *  5. Otherwise the existing value stands.
 *
 * Pure and deterministic: the same inputs always produce the same decision,
 * which is what makes the retention guarantee testable.
 */
export function decidePrecedence(
  held: HeldValue | null,
  incoming: IncomingValue,
): PrecedenceDecision {
  if (incoming.confidence < PROMOTION_THRESHOLD) {
    return { promote: false, reason: "BELOW_THRESHOLD" };
  }

  if (held === null) {
    return { promote: true, reason: "NO_EXISTING_VALUE" };
  }

  if (incoming.confidence > held.confidence) {
    return { promote: true, reason: "HIGHER_CONFIDENCE" };
  }

  if (incoming.confidence < held.confidence) {
    return { promote: false, reason: "LOWER_CONFIDENCE" };
  }

  return incoming.observedAt.getTime() > held.observedAt.getTime()
    ? { promote: true, reason: "SAME_CONFIDENCE_NEWER" }
    : { promote: false, reason: "SAME_CONFIDENCE_NOT_NEWER" };
}

/**
 * Evidence supporting an observation.
 *
 * `excerpt` is a short, sanitised snippet of the source proving the claim. It
 * is capped because crawler output is untrusted and must never be stored
 * wholesale.
 */
export const MAX_EVIDENCE_LENGTH = 500;

export interface Evidence {
  /** Short human-readable proof, e.g. the matched text. */
  excerpt: string;
  /** Where in the document it came from, e.g. a selector or "jsonld". */
  locator?: string;
}

/**
 * Normalises untrusted evidence text.
 *
 * Collapses whitespace, strips control characters and truncates. Crawled bytes
 * are hostile input: this is the only way evidence enters the database.
 */
export function sanitiseEvidence(raw: string): string {
  const collapsed = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return collapsed.length > MAX_EVIDENCE_LENGTH
    ? `${collapsed.slice(0, MAX_EVIDENCE_LENGTH - 1)}…`
    : collapsed;
}
