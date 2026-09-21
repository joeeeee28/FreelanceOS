/**
 * Timezone-aware date arithmetic.
 *
 * Every workspace stores an IANA timezone, and all "today", "overdue" and
 * "due date" logic must be evaluated in that zone — not the server's local
 * zone (which is whatever the host happens to be set to) and not UTC.
 *
 * Implemented with `Intl` only: no date library is added, and no zone data is
 * hardcoded, so the rules stay correct across DST transitions.
 */

/** Offset (in minutes) of `instant` in `timeZone`, e.g. +330 for Asia/Kolkata. */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }

  // The same wall-clock reading interpreted as UTC; the difference from the
  // real instant is the zone's offset at that moment.
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    // Intl renders midnight as hour 24 in some locales/zones.
    parts.hour === 24 ? 0 : parts.hour,
    parts.minute,
    parts.second,
  );

  return (asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000;
}

/** The calendar parts of `instant` as seen in `timeZone`. */
export function zonedParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const [year, month, day] = formatter.format(instant).split("-").map(Number);
  return { year, month, day };
}

/**
 * The UTC instant corresponding to a wall-clock time in `timeZone`.
 *
 * The offset is resolved iteratively because the correct offset depends on the
 * instant being computed (it changes across a DST boundary).
 */
export function zonedTimeToUtc(
  timeZone: string,
  parts: { year: number; month: number; day: number; hour?: number; minute?: number },
): Date {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    0,
  );

  let instant = new Date(naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000);

  // One correction pass settles the ambiguity around DST changes.
  instant = new Date(naive - zoneOffsetMinutes(instant, timeZone) * 60_000);

  return instant;
}

/** Start of the current day (00:00 local) in `timeZone`, as a UTC instant. */
export function startOfDayInZone(timeZone: string, now: Date = new Date()): Date {
  return zonedTimeToUtc(timeZone, zonedParts(now, timeZone));
}

/** Start of the day `days` after the day containing `now`, in `timeZone`. */
export function startOfDayAfterInZone(
  timeZone: string,
  days = 1,
  now: Date = new Date(),
): Date {
  const { year, month, day } = zonedParts(now, timeZone);

  // Date.UTC normalises month/day overflow, so this is month- and year-safe.
  const shifted = new Date(Date.UTC(year, month - 1, day + days));

  return zonedTimeToUtc(timeZone, {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/** The half-open range [start, end) covering "today" in `timeZone`. */
export function todayRangeInZone(
  timeZone: string,
  now: Date = new Date(),
): { start: Date; end: Date } {
  return {
    start: startOfDayInZone(timeZone, now),
    end: startOfDayAfterInZone(timeZone, 1, now),
  };
}

/** True when `instant` falls on the current calendar day in `timeZone`. */
export function isTodayInZone(
  instant: Date,
  timeZone: string,
  now: Date = new Date(),
): boolean {
  const { start, end } = todayRangeInZone(timeZone, now);
  return instant >= start && instant < end;
}

/**
 * True when a scheduled instant is in the past relative to `now`.
 *
 * Overdue is an instant-vs-instant comparison, so it is zone independent — the
 * helper exists so call sites read consistently and do not reintroduce
 * local-time assumptions.
 */
export function isOverdue(scheduledAt: Date | null, now: Date = new Date()): boolean {
  return scheduledAt !== null && scheduledAt < now;
}

/** Formats an instant for display in the workspace timezone. */
export function formatInZone(
  instant: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).format(instant);
}

/** Date-and-time variant used in list views. */
export function formatDateTimeInZone(instant: Date, timeZone: string): string {
  return formatInZone(instant, timeZone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
