/**
 * Discovery scheduling.
 *
 * Decides what should run and when, without running anything itself. Keeping
 * the decision pure means the awkward cases — a cycle that overran, a worker
 * that died mid-run, clocks in a timezone the user did not choose — are
 * testable without a database or a clock.
 *
 * The specification asks for two configurable cycles a day. The interesting
 * part is not the timer; it is what happens when a cycle is missed, which is
 * the normal case for anything self-hosted on a machine that sleeps.
 */

export const DEFAULT_CYCLE_HOURS = [9, 21] as const;

/** A cycle that started longer ago than this is presumed dead. */
export const STALE_RUN_HOURS = 6;

/**
 * How late a cycle can start and still be worth running.
 *
 * Past this, the cycle is skipped rather than run at a strange hour. A machine
 * that was off for a week should not wake up and fire seven backlogged crawls
 * at once; it should do today's.
 */
export const CATCH_UP_GRACE_HOURS = 4;

export interface ScheduleConfig {
  /** Local hours, 0-23, at which cycles begin. */
  cycleHours?: readonly number[];
  /** IANA timezone the hours are expressed in. */
  timezone?: string;
  enabled?: boolean;
}

export interface ScheduleState {
  /** Start of the most recent cycle, whatever its outcome. */
  lastStartedAt: Date | null;
  /** Completion of the most recent finished cycle. */
  lastCompletedAt: Date | null;
  /** True if a cycle is currently marked running. */
  running: boolean;
}

export type ScheduleDecision =
  | { action: "RUN"; reason: "SCHEDULED" | "CATCH_UP" | "FIRST_RUN"; scheduledFor: Date }
  | { action: "RESUME"; reason: "PREVIOUS_RUN_ABANDONED"; scheduledFor: Date }
  | {
      action: "WAIT";
      reason: "DISABLED" | "ALREADY_RUNNING" | "NOT_DUE" | "ALREADY_RAN";
      nextRunAt: Date | null;
    };

/** Reads the hour in a given timezone without pulling in a date library. */
function hourIn(timezone: string, at: Date): number {
  try {
    const formatted = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(at);
    const hour = Number.parseInt(formatted, 10);
    return Number.isNaN(hour) ? at.getUTCHours() : hour % 24;
  } catch {
    // An invalid timezone must not stop discovery; fall back to UTC.
    return at.getUTCHours();
  }
}

/** The calendar date in a timezone, as YYYY-MM-DD. */
function dateIn(timezone: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

function normaliseHours(hours: readonly number[] | undefined): number[] {
  const source = hours === undefined || hours.length === 0 ? DEFAULT_CYCLE_HOURS : hours;

  const valid = [...new Set(source)]
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
    .sort((a, b) => a - b);

  return valid.length === 0 ? [...DEFAULT_CYCLE_HOURS] : valid;
}

/**
 * The most recent scheduled slot at or before `now`.
 *
 * Returns null when `now` precedes the day's first slot, in which case the
 * previous day's last slot is the relevant one.
 */
function slotsToday(timezone: string, now: Date, hours: readonly number[]): Date[] {
  const currentHour = hourIn(timezone, now);

  return hours
    .filter((hour) => hour <= currentHour)
    .map((hour) => {
      // Approximate the slot instant by rewinding from now. Precision beyond
      // the hour does not matter: this only decides whether a slot has passed.
      const diffHours = currentHour - hour;
      const minutes = now.getUTCMinutes();
      const seconds = now.getUTCSeconds();
      return new Date(
        now.getTime() -
          diffHours * 3_600_000 -
          minutes * 60_000 -
          seconds * 1_000 -
          now.getUTCMilliseconds(),
      );
    });
}

/**
 * Decides what the scheduler should do right now.
 *
 * Pure: every input is explicit, so every branch is testable.
 */
export function decideSchedule(
  config: ScheduleConfig,
  state: ScheduleState,
  now: Date = new Date(),
): ScheduleDecision {
  if (config.enabled === false) {
    return { action: "WAIT", reason: "DISABLED", nextRunAt: null };
  }

  const timezone = config.timezone ?? "UTC";
  const hours = normaliseHours(config.cycleHours);

  // A run marked running but started long ago means the worker died. Resuming
  // matters more than tidiness here: the alternative is a queue that never
  // moves again because a process was killed at the wrong moment.
  if (state.running) {
    const started = state.lastStartedAt;
    if (started === null) {
      return { action: "RESUME", reason: "PREVIOUS_RUN_ABANDONED", scheduledFor: now };
    }

    const ageHours = (now.getTime() - started.getTime()) / 3_600_000;
    if (ageHours >= STALE_RUN_HOURS) {
      return { action: "RESUME", reason: "PREVIOUS_RUN_ABANDONED", scheduledFor: now };
    }

    return { action: "WAIT", reason: "ALREADY_RUNNING", nextRunAt: null };
  }

  if (state.lastStartedAt === null) {
    return { action: "RUN", reason: "FIRST_RUN", scheduledFor: now };
  }

  const passed = slotsToday(timezone, now, hours);

  if (passed.length === 0) {
    return { action: "WAIT", reason: "NOT_DUE", nextRunAt: nextSlot(timezone, now, hours) };
  }

  const mostRecentSlot = passed[passed.length - 1];

  // Already ran for this slot?
  if (state.lastStartedAt >= mostRecentSlot) {
    return {
      action: "WAIT",
      reason: "ALREADY_RAN",
      nextRunAt: nextSlot(timezone, now, hours),
    };
  }

  const lateHours = (now.getTime() - mostRecentSlot.getTime()) / 3_600_000;

  if (lateHours > CATCH_UP_GRACE_HOURS) {
    // Too late to be this slot's run. A machine that was off for a week wakes
    // up and does today's work, not seven days of backlog at once.
    const sameDay =
      dateIn(timezone, state.lastStartedAt) === dateIn(timezone, now);

    if (!sameDay) {
      return { action: "RUN", reason: "CATCH_UP", scheduledFor: mostRecentSlot };
    }

    return {
      action: "WAIT",
      reason: "ALREADY_RAN",
      nextRunAt: nextSlot(timezone, now, hours),
    };
  }

  return { action: "RUN", reason: "SCHEDULED", scheduledFor: mostRecentSlot };
}

/** The next slot strictly after `now`. */
export function nextSlot(
  timezone: string,
  now: Date,
  hours: readonly number[],
): Date {
  const normalised = normaliseHours(hours);
  const currentHour = hourIn(timezone, now);

  const upcoming = normalised.find((hour) => hour > currentHour);

  const hoursAhead =
    upcoming === undefined
      ? 24 - currentHour + normalised[0]
      : upcoming - currentHour;

  const at = new Date(now.getTime() + hoursAhead * 3_600_000);
  at.setUTCMinutes(0, 0, 0);

  return at;
}

/**
 * Describes a schedule for display.
 *
 * Users configure this, so it needs to read as a sentence rather than a cron
 * expression.
 */
export function describeSchedule(config: ScheduleConfig): string {
  if (config.enabled === false) return "Automatic discovery is turned off.";

  const hours = normaliseHours(config.cycleHours);
  const timezone = config.timezone ?? "UTC";
  const times = hours.map((hour) => `${String(hour).padStart(2, "0")}:00`);

  const list =
    times.length === 1
      ? times[0]
      : `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;

  return `Runs at ${list} (${timezone}).`;
}
