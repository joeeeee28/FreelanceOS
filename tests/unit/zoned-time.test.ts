import { describe, expect, it } from "vitest";

import {
  formatInZone,
  isOverdue,
  isTodayInZone,
  startOfDayAfterInZone,
  startOfDayInZone,
  todayRangeInZone,
  zonedParts,
  zonedTimeToUtc,
} from "@/lib/time/zoned";

describe("timezone-aware date maths", () => {
  it("resolves the start of the day in the workspace zone", () => {
    // 2026-03-15 02:00 UTC is already 07:30 on the 15th in Kolkata.
    const now = new Date("2026-03-15T02:00:00Z");

    // Kolkata is UTC+5:30, so the day started at 18:30 UTC the previous day.
    expect(startOfDayInZone("Asia/Kolkata", now).toISOString()).toBe(
      "2026-03-14T18:30:00.000Z",
    );

    // In UTC the same instant belongs to a day that started at midnight UTC.
    expect(startOfDayInZone("UTC", now).toISOString()).toBe(
      "2026-03-15T00:00:00.000Z",
    );
  });

  it("treats a late-evening instant as the correct local day", () => {
    // 21:00 UTC on the 14th is already 02:30 on the 15th in Kolkata.
    const now = new Date("2026-03-14T21:00:00Z");

    expect(zonedParts(now, "Asia/Kolkata")).toEqual({
      year: 2026,
      month: 3,
      day: 15,
    });

    // The same instant is still the 14th in UTC — the bug the old
    // setHours(0,0,0,0) logic produced.
    expect(zonedParts(now, "UTC")).toEqual({ year: 2026, month: 3, day: 14 });
  });

  it("produces a 24 hour window for a normal day", () => {
    const { start, end } = todayRangeInZone(
      "Asia/Kolkata",
      new Date("2026-06-10T09:00:00Z"),
    );

    expect(end.getTime() - start.getTime()).toBe(24 * 3600 * 1000);
  });

  it("handles a spring-forward DST day as 23 hours", () => {
    // US DST begins 2026-03-08; that local day is only 23 hours long.
    const { start, end } = todayRangeInZone(
      "America/New_York",
      new Date("2026-03-08T12:00:00Z"),
    );

    expect(end.getTime() - start.getTime()).toBe(23 * 3600 * 1000);
  });

  it("handles a fall-back DST day as 25 hours", () => {
    // US DST ends 2026-11-01; that local day is 25 hours long.
    const { start, end } = todayRangeInZone(
      "America/New_York",
      new Date("2026-11-01T12:00:00Z"),
    );

    expect(end.getTime() - start.getTime()).toBe(25 * 3600 * 1000);
  });

  it("rolls over month and year boundaries", () => {
    expect(
      startOfDayAfterInZone("Asia/Kolkata", 1, new Date("2026-12-31T10:00:00Z")),
    ).toEqual(zonedTimeToUtc("Asia/Kolkata", { year: 2027, month: 1, day: 1 }));

    expect(
      startOfDayAfterInZone("UTC", 1, new Date("2028-02-28T10:00:00Z")),
    ).toEqual(zonedTimeToUtc("UTC", { year: 2028, month: 2, day: 29 }));
  });

  it("classifies 'today' by the workspace zone, not the server zone", () => {
    const now = new Date("2026-03-14T21:00:00Z");

    // Scheduled 2026-03-15 09:00 Kolkata time.
    const followUp = zonedTimeToUtc("Asia/Kolkata", {
      year: 2026,
      month: 3,
      day: 15,
      hour: 9,
    });

    expect(isTodayInZone(followUp, "Asia/Kolkata", now)).toBe(true);
    // The very same follow-up is "tomorrow" if you wrongly evaluate in UTC.
    expect(isTodayInZone(followUp, "UTC", now)).toBe(false);
  });

  it("detects overdue items", () => {
    const now = new Date("2026-05-01T12:00:00Z");

    expect(isOverdue(new Date("2026-05-01T11:59:00Z"), now)).toBe(true);
    expect(isOverdue(new Date("2026-05-01T12:01:00Z"), now)).toBe(false);
    expect(isOverdue(null, now)).toBe(false);
  });

  it("formats dates in the workspace zone", () => {
    const instant = new Date("2026-03-14T21:00:00Z");

    expect(formatInZone(instant, "Asia/Kolkata")).toBe("15 Mar 2026");
    expect(formatInZone(instant, "UTC")).toBe("14 Mar 2026");
  });

  it("round-trips a wall-clock time through the zone", () => {
    const instant = zonedTimeToUtc("Asia/Kolkata", {
      year: 2026,
      month: 9,
      day: 21,
      hour: 14,
      minute: 30,
    });

    expect(instant.toISOString()).toBe("2026-09-21T09:00:00.000Z");
  });
});
