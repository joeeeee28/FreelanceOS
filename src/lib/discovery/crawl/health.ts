/**
 * Source health.
 *
 * A crawler that quietly returns nothing is worse than one that fails loudly,
 * because the operator cannot tell "this source has no new businesses" from
 * "this source has been broken for a fortnight". These helpers turn raw fetch
 * outcomes into a diagnosis that can be shown to a human.
 *
 * Every number here is derived from recorded FetchLog rows. Nothing is
 * estimated, and a source with no history is reported as UNKNOWN rather than
 * being flattered with a default.
 */

import type { FetchOutcome, SourceStatus } from "@prisma/client";

/** Why a source is unhealthy, in the operator's language. */
export const FAILURE_CLASSES = [
  "NONE",
  "REFUSED",
  "UNREACHABLE",
  "THROTTLED",
  "SERVER_BROKEN",
  "MISSING",
  "UNREADABLE",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

const OUTCOME_CLASS: Readonly<Record<FetchOutcome, FailureClass>> = {
  SUCCESS: "NONE",
  BLOCKED: "REFUSED",
  NOT_FOUND: "MISSING",
  RATE_LIMITED: "THROTTLED",
  SERVER_ERROR: "SERVER_BROKEN",
  TIMEOUT: "UNREACHABLE",
  NETWORK_ERROR: "UNREACHABLE",
  PARSE_ERROR: "UNREADABLE",
};

export function classifyFailure(outcome: FetchOutcome): FailureClass {
  return OUTCOME_CLASS[outcome] ?? "UNREACHABLE";
}

/** Plain-language guidance for each failure class. */
export const REMEDIATION: Readonly<Record<FailureClass, string>> = {
  NONE: "Working normally.",
  REFUSED:
    "The site refuses automated access, or robots.txt disallows it. This is " +
    "respected and will not be retried. Use a different source, or import " +
    "the data manually.",
  UNREACHABLE:
    "The host did not answer. Usually temporary; check the URL is still " +
    "correct if it persists.",
  THROTTLED:
    "The site asked us to slow down. Lower the requests per minute for this " +
    "source.",
  SERVER_BROKEN: "The site is returning server errors. Usually temporary.",
  MISSING: "The URL no longer exists. Update or disable this source.",
  UNREADABLE:
    "The response downloaded but could not be parsed. The site's format may " +
    "have changed.",
};

export interface OutcomeCount {
  outcome: FetchOutcome;
  count: number;
}

export interface HealthReport {
  status: SourceStatus | "UNKNOWN";
  /** 0..1, or null when there is no history to compute it from. */
  successRate: number | null;
  totalRequests: number;
  dominantFailure: FailureClass;
  remediation: string;
  /** True when the only thing stopping this source is a refusal. */
  refusedOnly: boolean;
}

/**
 * Diagnoses a source from its recorded fetch outcomes.
 *
 * Returns UNKNOWN for a source that has never run. Reporting 0% success for a
 * source that has simply never been tried would be a lie of the worst kind:
 * numerically true, entirely misleading.
 */
export function diagnose(counts: readonly OutcomeCount[]): HealthReport {
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);

  if (total === 0) {
    return {
      status: "UNKNOWN",
      successRate: null,
      totalRequests: 0,
      dominantFailure: "NONE",
      remediation: "This source has not run yet.",
      refusedOnly: false,
    };
  }

  const successes =
    counts.find((entry) => entry.outcome === "SUCCESS")?.count ?? 0;
  const failures = counts.filter((entry) => entry.outcome !== "SUCCESS");

  const worst = failures.reduce<OutcomeCount | null>(
    (best, entry) => (best === null || entry.count > best.count ? entry : best),
    null,
  );

  const dominantFailure =
    worst === null ? "NONE" : classifyFailure(worst.outcome);

  const blocked = counts.find((entry) => entry.outcome === "BLOCKED")?.count ?? 0;
  const refusedOnly = successes === 0 && blocked > 0 && blocked === total;

  const successRate = successes / total;

  let status: SourceStatus;
  if (refusedOnly) {
    status = "BLOCKED";
  } else if (successes === 0) {
    status = "FAILING";
  } else if (successRate < 0.5) {
    // Degraded, but still producing. Worth a warning, not a shutdown.
    status = "FAILING";
  } else {
    status = "ACTIVE";
  }

  return {
    status,
    successRate,
    totalRequests: total,
    dominantFailure,
    remediation: REMEDIATION[dominantFailure],
    refusedOnly,
  };
}
