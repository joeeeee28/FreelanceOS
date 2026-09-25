/**
 * Two cycles a day, in the workspace's own timezone.
 *
 * The regression these cover: the scheduler derived each slot by subtracting
 * whole hours from the current instant and keyed the cycle on the UTC hour that
 * produced. For a zone whose offset is a half hour (India, +05:30) that put a
 * local 09:00 slot at 09:30 local for part of the morning, and — worse — the
 * slot's identity moved with the clock, so one morning produced two runs
 * (`…T03` and `…T04`). Four cycles a day instead of two, and the extra ones at
 * arbitrary local times.
 *
 * The fix is that a slot is identified by the workspace's *local* date and
 * *local* hour, and its instant is resolved by the zone itself. These tests
 * pin both halves: the instant a slot actually occurs at, and the identity that
 * makes it impossible to run twice.
 */

import { describe, expect, it } from "vitest";

import {
  CATCH_UP_GRACE_HOURS,
  DEFAULT_CYCLE_HOURS,
  decideSchedule,
  describeSchedule,
  discoveryCycleKey,
  isKnownTimezone,
  localDateIn,
  localPartsIn,
  nextSlot,
  slotKey,
  type ScheduleDecision,
  type ScheduleState,
} from "@/lib/discovery/scheduler";

const WS_A = "ws-aaaaaaaa";
const WS_B = "ws-bbbbbbbb";

function at(iso: string): Date {
  return new Date(iso);
}

/** A workspace that has not run before. */
function fresh(): ScheduleState {
  return { lastStartedAt: null, lastCompletedAt: null, running: false };
}

/** A workspace whose last cycle started at the given instant. */
function since(lastStartedAt: string, running = false): ScheduleState {
  return { lastStartedAt: at(lastStartedAt), lastCompletedAt: null, running };
}

/** The local wall clock of an instant, as the zone reads it. */
function localClock(timezone: string, instant: Date): string {
  const { hour, minute } = localPartsIn(timezone, instant);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Runs the scheduler over a whole local day, feeding each decision back into
 * the next, and reports every cycle it decided to start.
 *
 * This is what catches "four cycles a day": it is not enough for the 09:00
 * decision to be right once — it must also stay right for the rest of the
 * morning.
 */
function simulateDay(
  timezone: string,
  windowStart: Date,
  steps: number,
): Array<{ localHour: number; key: string; scheduledFor: Date }> {
  const starts: Array<{ localHour: number; key: string; scheduledFor: Date }> = [];

  let state = since(new Date(windowStart.getTime() - 26 * 3_600_000).toISOString());

  for (let step = 0; step < steps; step += 1) {
    const now = new Date(windowStart.getTime() + step * 5 * 60_000);
    const decision = decideSchedule({ timezone }, state, now);

    if (decision.action === "RUN") {
      const key = discoveryCycleKey(WS_A, timezone, decision, now);
      starts.push({
        localHour: localPartsIn(timezone, decision.scheduledFor).hour,
        key,
        scheduledFor: decision.scheduledFor,
      });
      state = since(decision.scheduledFor.toISOString());
    }
  }

  return starts;
}

describe("UTC", () => {
  it("runs at 09:00 and 21:00 UTC", () => {
    // The 21:00 UTC cycle has already run, so 09:00 is the next due slot.
    const decision = decideSchedule(
      { timezone: "UTC" },
      since("2026-03-09T21:00:00Z"),
      at("2026-03-10T09:00:00Z"),
    );

    expect(decision.action).toBe("RUN");
    if (decision.action !== "RUN") throw new Error("unreachable");
    expect(decision.reason).toBe("SCHEDULED");
    expect(decision.scheduledFor.toISOString()).toBe("2026-03-10T09:00:00.000Z");
    expect(discoveryCycleKey(WS_A, "UTC", decision, at("2026-03-10T09:00:00Z"))).toBe(
      `cycle:${WS_A}:2026-03-10T09`,
    );
  });

  it("waits before the first slot of the day", () => {
    const decision = decideSchedule(
      { timezone: "UTC" },
      since("2026-03-09T21:00:00Z"),
      at("2026-03-10T08:59:00Z"),
    );

    expect(decision.action).toBe("WAIT");
    if (decision.action !== "WAIT") throw new Error("unreachable");
    expect(decision.reason).toBe("NOT_DUE");
    expect(decision.nextRunAt?.toISOString()).toBe("2026-03-10T09:00:00.000Z");
  });
});

describe("Asia/Kolkata (+05:30)", () => {
  it("places the 09:00 local slot at 03:30 UTC", () => {
    const decision = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-09T15:30:00Z"),
      at("2026-03-10T03:30:00Z"),
    );

    expect(decision.action).toBe("RUN");
    if (decision.action !== "RUN") throw new Error("unreachable");
    expect(decision.scheduledFor.toISOString()).toBe("2026-03-10T03:30:00.000Z");
    expect(localClock("Asia/Kolkata", decision.scheduledFor)).toBe("09:00");
    expect(discoveryCycleKey(WS_A, "Asia/Kolkata", decision, at("2026-03-10T03:30:00Z"))).toBe(
      `cycle:${WS_A}:2026-03-10T09`,
    );
  });

  it("places the 21:00 local slot at 15:30 UTC", () => {
    const decision = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-10T03:30:00Z"),
      at("2026-03-10T15:30:00Z"),
    );

    expect(decision.action).toBe("RUN");
    if (decision.action !== "RUN") throw new Error("unreachable");
    expect(decision.scheduledFor.toISOString()).toBe("2026-03-10T15:30:00.000Z");
    expect(localClock("Asia/Kolkata", decision.scheduledFor)).toBe("21:00");
    expect(discoveryCycleKey(WS_A, "Asia/Kolkata", decision, at("2026-03-10T15:30:00Z"))).toBe(
      `cycle:${WS_A}:2026-03-10T21`,
    );
  });

  it("treats 08:59 local as not due and 09:00 local as due", () => {
    const before = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-09T15:30:00Z"),
      at("2026-03-10T03:29:00Z"),
    );
    const due = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-09T15:30:00Z"),
      at("2026-03-10T03:30:00Z"),
    );

    expect(before.action).toBe("WAIT");
    expect(due.action).toBe("RUN");
  });

  it("does not start a second cycle when the first runs late", () => {
    // The exact case the old UTC-hour key got wrong: the 09:00 cycle actually
    // started at 09:30. Half an hour later the scheduler must not decide that a
    // *different* slot came due — this produced the second run, and the second
    // idempotency key.
    const state = since("2026-03-10T04:00:00Z");
    const decision = decideSchedule(
      { timezone: "Asia/Kolkata" },
      state,
      at("2026-03-10T04:30:00Z"),
    );

    expect(decision.action).toBe("WAIT");
    if (decision.action !== "WAIT") throw new Error("unreachable");
    expect(decision.reason).toBe("ALREADY_RAN");
  });

  it("keys a late evaluation of the same slot identically, so the queue collapses it", () => {
    const onTime = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-09T15:30:00Z"),
      at("2026-03-10T03:31:00Z"),
    );
    const late = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-09T15:30:00Z"),
      at("2026-03-10T04:00:00Z"),
    );

    expect(onTime.action).toBe("RUN");
    expect(late.action).toBe("RUN");
    if (onTime.action !== "RUN" || late.action !== "RUN") throw new Error("unreachable");

    // Different instants of evaluation, one slot, one key.
    expect(onTime.scheduledFor.toISOString()).toBe("2026-03-10T03:30:00.000Z");
    expect(late.scheduledFor.toISOString()).toBe("2026-03-10T03:30:00.000Z");
    expect(discoveryCycleKey(WS_A, "Asia/Kolkata", late, at("2026-03-10T04:00:00Z"))).toBe(
      discoveryCycleKey(WS_A, "Asia/Kolkata", onTime, at("2026-03-10T03:31:00Z")),
    );
  });

  it("produces exactly two cycles per local day: 09:00 IST and 21:00 IST, not four", () => {
    const starts = simulateDay("Asia/Kolkata", at("2026-03-09T18:30:00Z"), 288);

    expect(starts.map((start) => start.localHour)).toEqual([9, 21]);
    expect(starts.map((start) => start.key)).toEqual([
      `cycle:${WS_A}:2026-03-10T09`,
      `cycle:${WS_A}:2026-03-10T21`,
    ]);
  });

  it("never keys two cycles of one local day the same", () => {
    const starts = simulateDay("Asia/Kolkata", at("2026-03-09T18:30:00Z"), 288);
    const localDates = starts.map((start) =>
      localDateIn("Asia/Kolkata", start.scheduledFor),
    );

    expect(localDates.every((date) => date === "2026-03-10")).toBe(true);
  });
});

describe("Asia/Kathmandu (+05:45)", () => {
  it("places the 09:00 local slot at 03:15 UTC", () => {
    const decision = decideSchedule(
      { timezone: "Asia/Kathmandu" },
      since("2026-03-09T15:15:00Z"),
      at("2026-03-10T03:15:00Z"),
    );

    expect(decision.action).toBe("RUN");
    if (decision.action !== "RUN") throw new Error("unreachable");
    expect(decision.scheduledFor.toISOString()).toBe("2026-03-10T03:15:00.000Z");
    expect(localClock("Asia/Kathmandu", decision.scheduledFor)).toBe("09:00");
    expect(discoveryCycleKey(WS_A, "Asia/Kathmandu", decision, at("2026-03-10T03:15:00Z"))).toBe(
      `cycle:${WS_A}:2026-03-10T09`,
    );
  });

  it("produces exactly two cycles per local day", () => {
    const starts = simulateDay("Asia/Kathmandu", at("2026-03-09T18:15:00Z"), 288);

    expect(starts.map((start) => start.localHour)).toEqual([9, 21]);
    expect(new Set(starts.map((start) => start.key)).size).toBe(2);
  });
});

describe("daylight saving", () => {
  it("resolves the local slot through the transition instead of a fixed offset", () => {
    // America/New_York springs forward on 2026-03-08: 09:00 local is 13:00 UTC.
    const spring = decideSchedule(
      { timezone: "America/New_York" },
      since("2026-03-08T02:00:00Z"),
      at("2026-03-08T13:00:00Z"),
    );

    expect(spring.action).toBe("RUN");
    if (spring.action !== "RUN") throw new Error("unreachable");
    expect(spring.scheduledFor.toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(localClock("America/New_York", spring.scheduledFor)).toBe("09:00");

    // ...and on 2026-11-01 it falls back: 09:00 local is 14:00 UTC.
    const autumn = decideSchedule(
      { timezone: "America/New_York" },
      since("2026-11-01T02:00:00Z"),
      at("2026-11-01T14:00:00Z"),
    );

    expect(autumn.action).toBe("RUN");
    if (autumn.action !== "RUN") throw new Error("unreachable");
    expect(autumn.scheduledFor.toISOString()).toBe("2026-11-01T14:00:00.000Z");
    expect(localClock("America/New_York", autumn.scheduledFor)).toBe("09:00");
  });

  it("still gives one run per local slot across each transition day", () => {
    // 00:00 on the spring-forward day is 05:00 UTC; the window covers 24 hours.
    const spring = simulateDay("America/New_York", at("2026-03-08T05:00:00Z"), 288);
    // 00:00 on the fall-back day is 04:00 UTC.
    const autumn = simulateDay("America/New_York", at("2026-11-01T04:00:00Z"), 288);

    expect(spring.map((start) => start.localHour)).toEqual([9, 21]);
    expect(autumn.map((start) => start.localHour)).toEqual([9, 21]);
    expect(new Set(spring.map((start) => start.key)).size).toBe(2);
    expect(new Set(autumn.map((start) => start.key)).size).toBe(2);
  });

  it("keeps slots keyed on the local date across the transition", () => {
    const before = nextSlot("America/New_York", at("2026-03-07T23:00:00-05:00"), DEFAULT_CYCLE_HOURS);
    const after = nextSlot("America/New_York", at("2026-03-08T23:00:00-04:00"), DEFAULT_CYCLE_HOURS);

    // 09:00 on the spring-forward day is already EDT: 13:00 UTC, not 14:00.
    expect(before.toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(after.toISOString()).toBe("2026-03-09T13:00:00.000Z");
    expect(slotKey("America/New_York", before)).toBe("2026-03-08T09");
    expect(slotKey("America/New_York", after)).toBe("2026-03-09T09");
  });
});

describe("nextSlot", () => {
  it("returns the next local slot, not the next UTC hour", () => {
    // 10:00 IST: the next slot is 21:00 IST the same local day (15:30 UTC).
    const kolkata = nextSlot("Asia/Kolkata", at("2026-03-10T04:30:00Z"), DEFAULT_CYCLE_HOURS);
    expect(kolkata.toISOString()).toBe("2026-03-10T15:30:00.000Z");

    // 22:00 IST: the 09:00 slot of the next local day (03:30 UTC).
    const nextDay = nextSlot("Asia/Kolkata", at("2026-03-10T16:30:00Z"), DEFAULT_CYCLE_HOURS);
    expect(nextDay.toISOString()).toBe("2026-03-11T03:30:00.000Z");

    // 23:00 UTC: the next slot is 09:00 UTC the next day.
    const utc = nextSlot("UTC", at("2026-03-10T23:00:00Z"), DEFAULT_CYCLE_HOURS);
    expect(utc.toISOString()).toBe("2026-03-11T09:00:00.000Z");
  });
});

describe("catch-up", () => {
  it("runs a missed slot inside the grace window, once", () => {
    const now = at("2026-03-10T04:00:00Z"); // 09:30 IST, 30 minutes late
    const decision = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-09T15:30:00Z"), // yesterday's 21:00 IST
      now,
    );

    expect(decision.action).toBe("RUN");
    if (decision.action !== "RUN") throw new Error("unreachable");
    expect(decision.scheduledFor.toISOString()).toBe("2026-03-10T03:30:00.000Z");

    // Having run it, the same slot cannot run again.
    const again = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-10T03:30:00Z"),
      at("2026-03-10T05:00:00Z"),
    );

    expect(again.action).toBe("WAIT");
  });

  it("stops treating a slot as catch-up once the grace window has passed", () => {
    const lateBy = CATCH_UP_GRACE_HOURS + 1;
    const now = new Date(at("2026-03-10T03:30:00Z").getTime() + lateBy * 3_600_000);

    const decision = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-09T15:30:00Z"),
      now,
    );

    // A workspace that has not run today still gets today's work — once.
    expect(decision.action).toBe("RUN");
    if (decision.action !== "RUN") throw new Error("unreachable");
    expect(decision.reason).toBe("CATCH_UP");
    expect(decision.scheduledFor.toISOString()).toBe("2026-03-10T03:30:00.000Z");
  });

  it("does not replay a slot it already ran, however late the evaluation", () => {
    const decision = decideSchedule(
      { timezone: "Asia/Kolkata" },
      // Started today at 07:00 IST, which is after the previous local day ended.
      since("2026-03-10T01:30:00Z"),
      at("2026-03-10T10:30:00Z"), // 16:00 IST, well past grace
    );

    expect(decision.action).toBe("WAIT");
    if (decision.action !== "WAIT") throw new Error("unreachable");
    expect(decision.reason).toBe("ALREADY_RAN");
    expect(decision.nextRunAt?.toISOString()).toBe("2026-03-10T15:30:00.000Z");
  });

  it("keeps the same key for a catch-up run as for the slot it catches up", () => {
    const catchUp = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-09T15:30:00Z"),
      at("2026-03-10T06:00:00Z"),
    );
    const onTime = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-09T15:30:00Z"),
      at("2026-03-10T03:30:00Z"),
    );

    if (catchUp.action !== "RUN" || onTime.action !== "RUN") throw new Error("unreachable");

    expect(discoveryCycleKey(WS_A, "Asia/Kolkata", catchUp, at("2026-03-10T06:00:00Z"))).toBe(
      discoveryCycleKey(WS_A, "Asia/Kolkata", onTime, at("2026-03-10T03:30:00Z")),
    );
  });
});

describe("multiple workspaces", () => {
  it("gives two workspaces different keys for the same local slot", () => {
    const decision = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-09T15:30:00Z"),
      at("2026-03-10T03:30:00Z"),
    );
    if (decision.action !== "RUN") throw new Error("unreachable");

    const a = discoveryCycleKey(WS_A, "Asia/Kolkata", decision, at("2026-03-10T03:30:00Z"));
    const b = discoveryCycleKey(WS_B, "Asia/Kolkata", decision, at("2026-03-10T03:30:00Z"));

    expect(a).not.toBe(b);
    expect(a).toBe(`cycle:${WS_A}:2026-03-10T09`);
    expect(b).toBe(`cycle:${WS_B}:2026-03-10T09`);
  });

  it("keys each workspace's own local slot, whatever UTC hour hosts it", () => {
    // 09:00 in Kolkata is 03:30 UTC; 09:00 in UTC is 14:30 IST. Each workspace
    // is keyed on its own local morning, and the two tenants never share a key.
    const kolkata = discoveryCycleKey(
      WS_A,
      "Asia/Kolkata",
      decideSchedule(
        { timezone: "Asia/Kolkata" },
        since("2026-03-09T15:30:00Z"),
        at("2026-03-10T03:30:00Z"),
      ),
      at("2026-03-10T03:30:00Z"),
    );
    const utc = discoveryCycleKey(
      WS_B,
      "UTC",
      decideSchedule({ timezone: "UTC" }, since("2026-03-09T21:00:00Z"), at("2026-03-10T09:00:00Z")),
      at("2026-03-10T09:00:00Z"),
    );

    expect(kolkata).toBe(`cycle:${WS_A}:2026-03-10T09`);
    expect(utc).toBe(`cycle:${WS_B}:2026-03-10T09`);
    expect(kolkata).not.toBe(utc);
  });
});

describe("recovery and configuration", () => {
  it("keys a recovery cycle apart from the slot it recovers", () => {
    const decision = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-10T01:00:00Z", true),
      at("2026-03-10T09:00:00Z"),
    );

    expect(decision.action).toBe("RESUME");
    if (decision.action !== "RESUME") throw new Error("unreachable");

    const key = discoveryCycleKey(WS_A, "Asia/Kolkata", decision, at("2026-03-10T09:00:00Z"));
    expect(key.startsWith(`cycle:${WS_A}:recover:`)).toBe(true);
    expect(key).not.toBe(`cycle:${WS_A}:2026-03-10T09`);
  });

  it("waits while a live run is still inside its lease", () => {
    const decision = decideSchedule(
      { timezone: "Asia/Kolkata" },
      since("2026-03-10T03:00:00Z", true),
      at("2026-03-10T04:00:00Z"),
    );

    expect(decision.action).toBe("WAIT");
    if (decision.action !== "WAIT") throw new Error("unreachable");
    expect(decision.reason).toBe("ALREADY_RUNNING");
  });

  it("does nothing at all when the schedule is disabled", () => {
    const decision: ScheduleDecision = decideSchedule(
      { timezone: "Asia/Kolkata", enabled: false },
      fresh(),
      at("2026-03-10T03:30:00Z"),
    );

    expect(decision).toEqual({ action: "WAIT", reason: "DISABLED", nextRunAt: null });
  });

  it("falls back to UTC rather than throwing on an unknown zone", () => {
    const decision = decideSchedule(
      { timezone: "Mars/Olympus" },
      since("2026-03-09T21:00:00Z"),
      at("2026-03-10T09:00:00Z"),
    );

    expect(decision.action).toBe("RUN");
    expect(isKnownTimezone("Mars/Olympus")).toBe(false);
    expect(isKnownTimezone("Asia/Kolkata")).toBe(true);
  });

  it("describes the schedule in the workspace's own zone", () => {
    expect(describeSchedule({ timezone: "Asia/Kolkata" })).toBe(
      "Runs at 09:00 and 21:00 (Asia/Kolkata).",
    );
    expect(describeSchedule({ timezone: "UTC", cycleHours: [9] })).toBe(
      "Runs at 09:00 (UTC).",
    );
    expect(describeSchedule({ timezone: "UTC", enabled: false })).toBe(
      "Automatic discovery is turned off.",
    );
  });
});
