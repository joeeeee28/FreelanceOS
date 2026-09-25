/**
 * DiscoveryRun counters.
 *
 * A run's counters answer "what did this cycle actually do", so every number
 * has to come from work that run performed. The authoritative record of that
 * work is the structured result each job writes when it finishes, attributed
 * to the run by `Job.discoveryRunId` — the only linkage the schema needs, and
 * the one the whole discovery path already carries.
 *
 * Counters are therefore *aggregated*, never incremented. A tally is
 * recomputed from the jobs' results whenever a run is settled, which makes it
 * idempotent by construction:
 *
 *   - a job that retries writes one result, so it contributes once;
 *   - a job executed twice by racing workers has one row, so it is counted
 *     once, whichever attempt wins;
 *   - a worker that dies mid-cycle leaves the numbers untouched, and the next
 *     settle recomputes them from whatever is committed;
 *   - reconciliation can run as often as it likes without inflating anything.
 *
 * The alternative — `increment` on every completion — cannot survive any of
 * those cases without a separate ledger of which jobs have already been
 * counted, which is exactly the duplicate tracking structure the schema
 * already avoids needing.
 *
 * Nothing here reads a workspace total, a timestamp, or a record that existed
 * before the run: the only input is the run's own jobs.
 */

/**
 * The counter columns on `DiscoveryRun`, in schema order.
 *
 * Everything outside this list is ignored when reading a job result, so a
 * handler cannot invent a counter that the database does not have.
 */
export const RUN_COUNTER_KEYS = [
  "pagesAttempted",
  "pagesSucceeded",
  "pagesFailed",
  "pagesBlocked",
  "companiesDiscovered",
  "companiesMatched",
  "duplicatesPrevented",
  "signalsDiscovered",
  "opportunitiesDiscovered",
  "contactsDiscovered",
  "leadsCreated",
  "leadsUpdated",
] as const;

export type RunCounterKey = (typeof RUN_COUNTER_KEYS)[number];

/** What one job contributed. Absent means zero. */
export type RunCounters = Partial<Record<RunCounterKey, number>>;

/** A run's totals: every counter present, defaults to zero. */
export type RunCounterTotals = Record<RunCounterKey, number>;

const KEY_SET: ReadonlySet<string> = new Set(RUN_COUNTER_KEYS);

export function emptyRunCounters(): RunCounterTotals {
  return {
    pagesAttempted: 0,
    pagesSucceeded: 0,
    pagesFailed: 0,
    pagesBlocked: 0,
    companiesDiscovered: 0,
    companiesMatched: 0,
    duplicatesPrevented: 0,
    signalsDiscovered: 0,
    opportunitiesDiscovered: 0,
    contactsDiscovered: 0,
    leadsCreated: 0,
    leadsUpdated: 0,
  };
}

/** Counts must be whole, non-negative and finite to be trusted. */
function saneCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const whole = Math.floor(value);
  return whole > 0 ? whole : null;
}

/**
 * Reads the counters out of one job result.
 *
 * Tolerant by design: a job result is JSON that may have been written by an
 * older build, so unknown keys are dropped rather than trusted, and anything
 * that is not a positive whole number counts as nothing.
 */
export function readRunCounters(result: unknown): RunCounters | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;

  const raw = (result as Record<string, unknown>)["counters"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

  const counters: RunCounters = {};
  let found = false;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY_SET.has(key)) continue;
    const count = saneCount(value);
    if (count === null) continue;

    counters[key as RunCounterKey] = count;
    found = true;
  }

  return found ? counters : null;
}

/**
 * One job row, as far as counting is concerned.
 *
 * `status` is a plain string rather than the generated enum: this module is
 * reached by the worker and by tests, and the generated client is not always
 * available to type-check against. Only the literal comparison below matters.
 */
export interface CountableJob {
  status: string;
  result: unknown;
}

/**
 * Totals the results of a run's jobs.
 *
 * Only succeeded jobs contribute. A failed or cancelled job's row is kept for
 * its error and its history, but it produced no results — counting a partial
 * attempt would report work that was never completed.
 */
export function totalRunCounters(jobs: readonly CountableJob[]): RunCounterTotals {
  const totals = emptyRunCounters();

  for (const job of jobs) {
    if (job.status !== "SUCCEEDED") continue;

    const contribution = readRunCounters(job.result);
    if (contribution === null) continue;

    for (const key of RUN_COUNTER_KEYS) {
      const value = contribution[key];
      if (value === undefined) continue;
      totals[key] += value;
    }
  }

  return totals;
}

/** Serialises a handler's contribution for storage on the job. */
export function serialiseRunCounters(counters: RunCounters): RunCounters {
  const clean: RunCounters = {};

  for (const [key, value] of Object.entries(counters) as [RunCounterKey, unknown][]) {
    if (!KEY_SET.has(key)) continue;
    const count = saneCount(value);
    if (count === null) continue;
    clean[key] = count;
  }

  return clean;
}
