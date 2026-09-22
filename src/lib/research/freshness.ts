/**
 * Research freshness.
 *
 * Re-crawling a company that has not changed is the single easiest way to
 * waste a crawl budget and annoy a webmaster. This module decides what still
 * needs looking at.
 *
 * Different aspects go stale at different rates, and pretending otherwise is
 * what makes naive crawlers either wasteful or wrong. A company's registered
 * address changes every few years; whether they are hiring changes weekly. One
 * global "re-crawl every 30 days" gets both cases wrong at once.
 */

import type { ResearchAspect, ResearchStatus } from "@prisma/client";

/** How long each aspect stays trustworthy, in hours. */
export const FRESHNESS_HOURS: Readonly<Record<ResearchAspect, number>> = {
  // Slow-moving facts. Re-reading these weekly is pure waste.
  COMPANY_INFO: 24 * 30,
  GEOGRAPHY: 24 * 90,
  INDUSTRY: 24 * 90,

  // Moderate.
  WEBSITE: 24 * 14,
  TECHNOLOGY: 24 * 30,
  PUBLIC_CONTACTS: 24 * 30,
  DECISION_MAKERS: 24 * 30,

  // Fast-moving: these are the buying signals, and a stale one is worse than
  // none, because it sends someone into a conversation with wrong information.
  HIRING: 24 * 7,
  ADVERTISING: 24 * 14,
  MARKETING: 24 * 14,
  CONTENT: 24 * 14,
  SERVICE_OPPORTUNITIES: 24 * 7,
};

/** Aspects ordered by how much they contribute to a buying decision. */
export const ASPECT_PRIORITY: readonly ResearchAspect[] = [
  "WEBSITE",
  "HIRING",
  "SERVICE_OPPORTUNITIES",
  "PUBLIC_CONTACTS",
  "ADVERTISING",
  "CONTENT",
  "MARKETING",
  "COMPANY_INFO",
  "DECISION_MAKERS",
  "TECHNOLOGY",
  "INDUSTRY",
  "GEOGRAPHY",
];

/**
 * How long to wait before retrying a blocked aspect.
 *
 * Long, deliberately. A site that refused us will still refuse us tomorrow,
 * and the only thing frequent retries achieve is looking like an attack. This
 * is not a retry of a transient failure — it is an occasional re-check in case
 * the site's policy changed.
 */
export const BLOCKED_RECHECK_HOURS = 24 * 30;

export interface AspectState {
  aspect: ResearchAspect;
  status: ResearchStatus;
  freshUntil: Date | null;
  completedAt: Date | null;
}

export interface FreshnessDecision {
  aspect: ResearchAspect;
  due: boolean;
  reason:
    | "NEVER_RESEARCHED"
    | "EXPIRED"
    | "PARTIAL_RETRY"
    | "BLOCKED_RECHECK"
    | "FRESH"
    | "BLOCKED_COOLING_DOWN";
}

/** When a result gathered now should be considered stale. */
export function freshUntilFor(aspect: ResearchAspect, now: Date = new Date()): Date {
  return new Date(now.getTime() + FRESHNESS_HOURS[aspect] * 60 * 60 * 1000);
}

/**
 * Decides whether one aspect needs re-researching.
 *
 * Errs toward not fetching. If the engine cannot tell whether something is
 * stale, the cheap and polite answer is to leave it alone until it expires.
 */
export function decideAspect(
  state: AspectState | undefined,
  aspect: ResearchAspect,
  now: Date = new Date(),
): FreshnessDecision {
  if (state === undefined || state.status === "NEVER") {
    return { aspect, due: true, reason: "NEVER_RESEARCHED" };
  }

  if (state.status === "BLOCKED") {
    const last = state.completedAt;
    if (last === null) return { aspect, due: false, reason: "BLOCKED_COOLING_DOWN" };

    const elapsedHours = (now.getTime() - last.getTime()) / (60 * 60 * 1000);
    return elapsedHours >= BLOCKED_RECHECK_HOURS
      ? { aspect, due: true, reason: "BLOCKED_RECHECK" }
      : { aspect, due: false, reason: "BLOCKED_COOLING_DOWN" };
  }

  if (state.status === "PARTIAL") {
    // Incomplete data is worth finishing, but not urgently enough to ignore
    // its expiry window.
    if (state.freshUntil === null || state.freshUntil <= now) {
      return { aspect, due: true, reason: "PARTIAL_RETRY" };
    }
    return { aspect, due: false, reason: "FRESH" };
  }

  if (state.status === "STALE") {
    return { aspect, due: true, reason: "EXPIRED" };
  }

  if (state.freshUntil === null) {
    // No expiry recorded. Fall back to the aspect's own window.
    if (state.completedAt === null) {
      return { aspect, due: true, reason: "NEVER_RESEARCHED" };
    }
    const expiry = new Date(
      state.completedAt.getTime() + FRESHNESS_HOURS[aspect] * 60 * 60 * 1000,
    );
    return expiry <= now
      ? { aspect, due: true, reason: "EXPIRED" }
      : { aspect, due: false, reason: "FRESH" };
  }

  return state.freshUntil <= now
    ? { aspect, due: true, reason: "EXPIRED" }
    : { aspect, due: false, reason: "FRESH" };
}

/**
 * Works out the full research plan for a company.
 *
 * Returns due aspects in priority order, capped, so one company cannot consume
 * a whole run's budget refreshing twelve aspects while others go untouched.
 */
export function planResearch(
  states: readonly AspectState[],
  options: { now?: Date; maxAspects?: number } = {},
): FreshnessDecision[] {
  const now = options.now ?? new Date();
  const byAspect = new Map(states.map((state) => [state.aspect, state]));

  const decisions = ASPECT_PRIORITY.map((aspect) =>
    decideAspect(byAspect.get(aspect), aspect, now),
  );

  const due = decisions.filter((decision) => decision.due);

  return options.maxAspects === undefined ? due : due.slice(0, options.maxAspects);
}

/**
 * Summarises many aspect results into the company's overall status.
 *
 * The aggregate is the pessimistic one: a company is only RESEARCHED when
 * every aspect is. Reporting a half-researched company as done is how a user
 * ends up trusting a record that was never finished.
 */
export function aggregateStatus(
  states: readonly AspectState[],
  now: Date = new Date(),
): ResearchStatus {
  if (states.length === 0) return "NEVER";

  const known = states.filter((state) => state.status !== "NEVER");
  if (known.length === 0) return "NEVER";

  if (states.every((state) => state.status === "BLOCKED")) return "BLOCKED";

  const anyDue = ASPECT_PRIORITY.some((aspect) => {
    const state = states.find((entry) => entry.aspect === aspect);
    return decideAspect(state, aspect, now).due;
  });

  if (known.some((state) => state.status === "PARTIAL")) return "PARTIAL";
  if (anyDue) return known.length === states.length ? "STALE" : "PARTIAL";

  return "RESEARCHED";
}
