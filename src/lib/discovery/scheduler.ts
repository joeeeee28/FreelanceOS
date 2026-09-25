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
 *
 * Time is handled in the workspace's own IANA zone and nowhere else. Slots are
 * built by asking the zone what instant a wall-clock time actually is (see
 * `@/lib/time/zoned`), never by adding a fixed offset to UTC — that shortcut is
 * wrong for every zone whose offset is not a whole number of hours (India is
 * +05:30, Nepal +05:45) and wrong twice a year in every zone that observes
 * daylight saving.
 */

import { zonedTimeToUtc } from "@/lib/time/zoned";

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

/** The calendar parts of an instant as its zone reads them. */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The same instant, one day later, as a local calendar date.
 *
 * `Date.UTC` normalises month and year overflow, so this is correct across
 * month ends and leap days without a date library.
 */
function addLocalDays(parts: LocalParts, days: number): LocalParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

/**
 * Reads the wall-clock time in a zone.
 *
 * `hourCycle: "h23"` rather than `hour12: false`: some locales render
 * midnight as hour 24 in the latter, which would place a 00:00 cycle on the
 * following day.
 */
export function localPartsIn(timezone: string, at: Date): LocalParts {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);

    const get = (type: Intl.DateTimeFormatPartTypes) =>
      Number.parseInt(parts.find((part) => part.type === type)?.value ?? "", 10);

    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour");
    const minute = get("minute");

    if ([year, month, day, hour, minute].some((value) => Number.isNaN(value))) {
      throw new RangeError("Could not read local time");
    }

    return { year, month, day, hour, minute };
  } catch {
    // An invalid or unsupported zone must never stop discovery. UTC parts are
    // a reasonable stand-in, and the config is validated at the edges.
    return {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
      hour: at.getUTCHours(),
      minute: at.getUTCMinutes(),
    };
  }
}

/** True when the zone is one `Intl` recognises. */
export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * The instant a local wall-clock time actually occurs.
 *
 * Delegates to the shared zone arithmetic, which resolves the offset for the
 * instant being computed rather than assuming it — the difference that makes
 * daylight-saving transitions come out right.
 *
 * A zone `Intl` does not recognise (a typo in workspace settings, a platform
 * without full tzdata) is treated as UTC rather than throwing: the scheduler
 * runs on a timer, and an exception here would stop every workspace's cycles.
 */
function slotInstant(timezone: string, date: LocalParts, hour: number): Date {
  const zone = isKnownTimezone(timezone) ? timezone : "UTC";

  try {
    return zonedTimeToUtc(zone, {
      year: date.year,
      month: date.month,
      day: date.day,
      hour,
      minute: 0,
    });
  } catch {
    // The shared helper refused the zone; build the instant directly so a
    // schedule is still produced.
    return new Date(Date.UTC(date.year, date.month - 1, date.day, hour, 0, 0, 0));
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
 * The scheduled slots that have already begun today, local time.
 *
 * A slot counts as begun at its exact local start, so at 09:00:00 the 09:00
 * slot is due; at 08:59 it is not. Nothing here depends on the offset being a
 * whole number of hours.
 */
function slotsToday(timezone: string, now: Date, hours: readonly number[]): Date[] {
  const local = localPartsIn(timezone, now);

  return hours
    .filter((hour) => hour <= local.hour)
    .map((hour) => slotInstant(timezone, local, hour));
}

/** The calendar date in a timezone, as YYYY-MM-DD. */
export function localDateIn(timezone: string, at: Date): string {
  const { year, month, day } = localPartsIn(timezone, at);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Identity of a scheduled slot: the workspace's local date and local hour.
 *
 * Deliberately not derived from the UTC hour. The same local slot is a
 * different UTC hour in every zone, and in zones with a half-hour offset the
 * UTC hour of a slot moves by thirty minutes twice a year — which is exactly
 * how a 09:00 cycle once produced two runs an hour apart. A local slot also
 * survives a daylight-saving shift, so "one run per slot" holds on the days
 * the clocks move.
 */
export function slotKey(timezone: string, slotInstantAt: Date): string {
  const { year, month, day, hour } = localPartsIn(timezone, slotInstantAt);
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}`;
}

/**
 * The idempotency key for one workspace's cycle.
 *
 * Local date, local slot and workspace together: two workspaces sharing a
 * slot never collide, and one workspace can never be given the same slot
 * twice however many workers are polling or however the offset shifts.
 *
 * A recovery cycle is keyed separately. It exists because a run is stuck, not
 * because a slot came due, and it must not be deduplicated against the slot
 * whose job already finished — that would leave the stuck run with nothing
 * behind it.
 */
export function discoveryCycleKey(
  workspaceId: string,
  timezone: string,
  decision: ScheduleDecision,
  now: Date,
): string {
  if (decision.action === "RESUME") {
    return `cycle:${workspaceId}:recover:${slotKey(timezone, now)}`;
  }

  const scheduledFor = decision.action === "RUN" ? decision.scheduledFor : now;
  return `cycle:${workspaceId}:${slotKey(timezone, scheduledFor)}`;
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
      localDateIn(timezone, state.lastStartedAt) === localDateIn(timezone, now);

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

/** The next slot strictly after `now`, in the zone's own wall-clock time. */
export function nextSlot(
  timezone: string,
  now: Date,
  hours: readonly number[],
): Date {
  const normalised = normaliseHours(hours);
  const local = localPartsIn(timezone, now);

  const upcoming = normalised.find((hour) => hour > local.hour);
  if (upcoming !== undefined) return slotInstant(timezone, local, upcoming);

  return slotInstant(timezone, addLocalDays(local, 1), normalised[0]);
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
