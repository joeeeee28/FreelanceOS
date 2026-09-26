import { describe, expect, it } from "vitest";

import { SUPPORTED_ASPECTS } from "@/lib/research/aspects";
import {
  aggregateStatus,
  ASPECT_PRIORITY,
  BLOCKED_RECHECK_HOURS,
  decideAspect,
  FRESHNESS_HOURS,
  freshUntilFor,
  planResearch,
  researchCoverage,
  type AspectState,
} from "@/lib/research/freshness";
import {
  CATCH_UP_GRACE_HOURS,
  decideSchedule,
  describeSchedule,
  nextSlot,
  STALE_RUN_HOURS,
} from "@/lib/discovery/scheduler";

const NOW = new Date("2026-09-22T12:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);
const hoursAhead = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

function state(overrides: Partial<AspectState> = {}): AspectState {
  return {
    aspect: "WEBSITE",
    status: "RESEARCHED",
    freshUntil: hoursAhead(24),
    completedAt: hoursAgo(1),
    ...overrides,
  };
}

describe("freshness windows", () => {
  it("expires fast-moving aspects sooner than slow ones", () => {
    // A registered address changes every few years; hiring changes weekly.
    // One global window would get both wrong at once.
    expect(FRESHNESS_HOURS.HIRING).toBeLessThan(FRESHNESS_HOURS.GEOGRAPHY);
    expect(FRESHNESS_HOURS.SERVICE_OPPORTUNITIES).toBeLessThan(
      FRESHNESS_HOURS.COMPANY_INFO,
    );
  });

  it("gives every aspect a window", () => {
    for (const aspect of ASPECT_PRIORITY) {
      expect(FRESHNESS_HOURS[aspect]).toBeGreaterThan(0);
    }
  });

  it("computes an expiry from the aspect's own window", () => {
    const expiry = freshUntilFor("HIRING", NOW);
    const expected = NOW.getTime() + FRESHNESS_HOURS.HIRING * 3_600_000;

    expect(expiry.getTime()).toBe(expected);
  });
});

describe("decideAspect", () => {
  it("researches something never looked at", () => {
    expect(decideAspect(undefined, "WEBSITE", NOW)).toMatchObject({
      due: true,
      reason: "NEVER_RESEARCHED",
    });
  });

  it("leaves fresh data alone", () => {
    expect(decideAspect(state(), "WEBSITE", NOW)).toMatchObject({
      due: false,
      reason: "FRESH",
    });
  });

  it("re-researches expired data", () => {
    const decision = decideAspect(
      state({ freshUntil: hoursAgo(1) }),
      "WEBSITE",
      NOW,
    );

    expect(decision).toMatchObject({ due: true, reason: "EXPIRED" });
  });

  it("finishes partial research once its window lapses", () => {
    expect(
      decideAspect(state({ status: "PARTIAL", freshUntil: hoursAgo(1) }), "WEBSITE", NOW),
    ).toMatchObject({ due: true, reason: "PARTIAL_RETRY" });
  });

  it("does not rush partial research that is still fresh", () => {
    expect(
      decideAspect(state({ status: "PARTIAL", freshUntil: hoursAhead(5) }), "WEBSITE", NOW),
    ).toMatchObject({ due: false });
  });

  it("always re-researches an explicitly stale aspect", () => {
    expect(
      decideAspect(state({ status: "STALE", freshUntil: hoursAhead(100) }), "WEBSITE", NOW),
    ).toMatchObject({ due: true, reason: "EXPIRED" });
  });

  describe("blocked aspects", () => {
    it("waits a long time before re-checking a refusal", () => {
      const decision = decideAspect(
        state({ status: "BLOCKED", completedAt: hoursAgo(24) }),
        "WEBSITE",
        NOW,
      );

      // A site that refused us will still refuse us tomorrow; frequent retries
      // only look like an attack.
      expect(decision).toMatchObject({ due: false, reason: "BLOCKED_COOLING_DOWN" });
    });

    it("re-checks eventually, in case the policy changed", () => {
      const decision = decideAspect(
        state({ status: "BLOCKED", completedAt: hoursAgo(BLOCKED_RECHECK_HOURS + 1) }),
        "WEBSITE",
        NOW,
      );

      expect(decision).toMatchObject({ due: true, reason: "BLOCKED_RECHECK" });
    });
  });

  it("falls back to the aspect window when no expiry was recorded", () => {
    const fresh = decideAspect(
      state({ freshUntil: null, completedAt: hoursAgo(1) }),
      "WEBSITE",
      NOW,
    );
    const old = decideAspect(
      state({ freshUntil: null, completedAt: hoursAgo(FRESHNESS_HOURS.WEBSITE + 1) }),
      "WEBSITE",
      NOW,
    );

    expect(fresh.due).toBe(false);
    expect(old.due).toBe(true);
  });
});

describe("planResearch", () => {
  it("plans every aspect for a brand new company", () => {
    const plan = planResearch([], { now: NOW });

    expect(plan).toHaveLength(ASPECT_PRIORITY.length);
    expect(plan.every((entry) => entry.due)).toBe(true);
  });

  it("plans nothing when everything is fresh", () => {
    const states = ASPECT_PRIORITY.map((aspect) => state({ aspect }));

    expect(planResearch(states, { now: NOW })).toEqual([]);
  });

  it("returns aspects in priority order", () => {
    const plan = planResearch([], { now: NOW });
    const planned = plan.map((entry) => entry.aspect);

    expect(planned).toEqual(
      ASPECT_PRIORITY.filter((aspect) => planned.includes(aspect)),
    );
    expect(plan[0].aspect).toBe("WEBSITE");
  });

  it("caps how much one company may consume", () => {
    // Otherwise one company refreshing twelve aspects starves every other.
    expect(planResearch([], { now: NOW, maxAspects: 3 })).toHaveLength(3);
  });

  it("plans only the stale aspects of a partly fresh company", () => {
    const states = ASPECT_PRIORITY.map((aspect) =>
      state({ aspect, freshUntil: aspect === "HIRING" ? hoursAgo(1) : hoursAhead(48) }),
    );

    const plan = planResearch(states, { now: NOW });

    expect(plan).toHaveLength(1);
    expect(plan[0].aspect).toBe("HIRING");
  });
});

describe("aggregateStatus", () => {
  it("reports NEVER for a company never researched", () => {
    expect(aggregateStatus([], NOW)).toBe("NEVER");
  });

  it("reports RESEARCHED only when every aspect is fresh", () => {
    const states = ASPECT_PRIORITY.map((aspect) => state({ aspect }));
    expect(aggregateStatus(states, NOW)).toBe("RESEARCHED");
  });

  it("does not report a half-researched company as done", () => {
    const states = ASPECT_PRIORITY.map((aspect) =>
      state({ aspect, status: aspect === "HIRING" ? "PARTIAL" : "RESEARCHED" }),
    );

    // Reporting this as finished is how a user comes to trust an unfinished
    // record.
    expect(aggregateStatus(states, NOW)).not.toBe("RESEARCHED");
  });

  it("reports BLOCKED when every aspect was refused", () => {
    const states = ASPECT_PRIORITY.map((aspect) =>
      state({ aspect, status: "BLOCKED", completedAt: hoursAgo(1) }),
    );

    expect(aggregateStatus(states, NOW)).toBe("BLOCKED");
  });

  it("reports STALE when everything known has expired", () => {
    const states = ASPECT_PRIORITY.map((aspect) =>
      state({ aspect, status: "RESEARCHED", freshUntil: hoursAgo(1) }),
    );

    expect(aggregateStatus(states, NOW)).toBe("STALE");
  });
});

/**
 * The declared-coverage form, used by the research runner.
 *
 * Twelve aspects exist in the schema; five have a researcher in this build. The
 * aggregate has to be able to tell "not checked yet" from "cannot be checked
 * here", or every company is permanently STALE for aspects nothing will ever
 * look at — an expiration that never stops being true.
 */
describe("aggregateStatus with declared coverage", () => {
  const supported = SUPPORTED_ASPECTS;
  const freshSupported = () => supported.map((aspect) => state({ aspect }));

  it("covers five of the twelve aspects", () => {
    expect(supported).toHaveLength(5);
    expect(ASPECT_PRIORITY).toHaveLength(12);
  });

  it("does not report a company as stale because of aspects no researcher covers", () => {
    const status = aggregateStatus(freshSupported(), NOW, { supported });

    expect(status).not.toBe("STALE");
    expect(status).toBe("RESEARCHED");
  });

  it("is still stale when a supported aspect expires", () => {
    const states = freshSupported();
    states[0] = state({ aspect: "WEBSITE", status: "RESEARCHED", freshUntil: hoursAgo(1) });

    expect(aggregateStatus(states, NOW, { supported })).toBe("STALE");
  });

  it("is partial while some supported aspects have never been looked at", () => {
    const states = supported.slice(0, 3).map((aspect) => state({ aspect }));

    expect(aggregateStatus(states, NOW, { supported })).toBe("PARTIAL");
  });

  it("does not claim full research while it holds a fact this build cannot refresh", () => {
    // HIRING has no researcher here, so a hiring record could never be brought
    // up to date again. Holding one means the company is not fully researched.
    const states = [...freshSupported(), state({ aspect: "HIRING" })];

    expect(aggregateStatus(states, NOW, { supported })).toBe("PARTIAL");
  });

  it("keeps blocked distinct from unresearched", () => {
    const states = supported.map((aspect) =>
      state({ aspect, status: "BLOCKED", completedAt: hoursAgo(1) }),
    );

    expect(aggregateStatus(states, NOW, { supported })).toBe("BLOCKED");
  });

  it("states its coverage rather than implying all twelve were checked", () => {
    const coverage = researchCoverage(supported);

    expect(coverage.surface).toBe("5 of 12 aspects");
    expect(coverage.unsupported).toContain("HIRING");
    expect(coverage.unsupported).not.toContain("WEBSITE");
  });
});

describe("decideSchedule", () => {
  const idle = { lastStartedAt: null, lastCompletedAt: null, running: false };

  it("runs immediately the first time", () => {
    expect(decideSchedule({}, idle, NOW)).toMatchObject({
      action: "RUN",
      reason: "FIRST_RUN",
    });
  });

  it("does nothing when disabled", () => {
    expect(decideSchedule({ enabled: false }, idle, NOW)).toMatchObject({
      action: "WAIT",
      reason: "DISABLED",
    });
  });

  it("runs at a scheduled hour", () => {
    const decision = decideSchedule(
      { cycleHours: [12], timezone: "UTC" },
      { lastStartedAt: hoursAgo(20), lastCompletedAt: hoursAgo(19), running: false },
      NOW,
    );

    expect(decision).toMatchObject({ action: "RUN", reason: "SCHEDULED" });
  });

  it("does not run twice for the same slot", () => {
    const decision = decideSchedule(
      { cycleHours: [9], timezone: "UTC" },
      { lastStartedAt: hoursAgo(2), lastCompletedAt: hoursAgo(1), running: false },
      NOW,
    );

    expect(decision).toMatchObject({ action: "WAIT", reason: "ALREADY_RAN" });
  });

  it("waits before the day's first slot", () => {
    const early = new Date("2026-09-22T03:00:00Z");

    expect(
      decideSchedule(
        { cycleHours: [9, 21], timezone: "UTC" },
        { lastStartedAt: hoursAgo(30), lastCompletedAt: hoursAgo(29), running: false },
        early,
      ),
    ).toMatchObject({ action: "WAIT", reason: "NOT_DUE" });
  });

  describe("a worker that died", () => {
    it("waits while a run is genuinely in progress", () => {
      expect(
        decideSchedule(
          {},
          { lastStartedAt: hoursAgo(1), lastCompletedAt: null, running: true },
          NOW,
        ),
      ).toMatchObject({ action: "WAIT", reason: "ALREADY_RUNNING" });
    });

    it("resumes a run abandoned long ago", () => {
      const decision = decideSchedule(
        {},
        {
          lastStartedAt: hoursAgo(STALE_RUN_HOURS + 1),
          lastCompletedAt: null,
          running: true,
        },
        NOW,
      );

      // Without this the queue never moves again after a process is killed at
      // the wrong moment.
      expect(decision).toMatchObject({
        action: "RESUME",
        reason: "PREVIOUS_RUN_ABANDONED",
      });
    });
  });

  describe("a machine that was switched off", () => {
    it("catches up once, not once per missed day", () => {
      // Late enough that the 09:00 slot is past its grace period, and the last
      // run was a week ago. One catch-up run, not seven backlogged ones.
      const evening = new Date("2026-09-22T20:00:00Z");

      const decision = decideSchedule(
        { cycleHours: [9], timezone: "UTC" },
        {
          lastStartedAt: new Date("2026-09-15T09:00:00Z"),
          lastCompletedAt: new Date("2026-09-15T09:30:00Z"),
          running: false,
        },
        evening,
      );

      expect(decision).toMatchObject({ action: "RUN", reason: "CATCH_UP" });
    });

    it("skips a long-missed slot once today's run is done", () => {
      const evening = new Date("2026-09-22T20:00:00Z");

      const decision = decideSchedule(
        { cycleHours: [9], timezone: "UTC" },
        {
          lastStartedAt: new Date("2026-09-22T09:05:00Z"),
          lastCompletedAt: new Date("2026-09-22T09:40:00Z"),
          running: false,
        },
        evening,
      );

      expect(decision).toMatchObject({ action: "WAIT", reason: "ALREADY_RAN" });
    });

    it("does not re-run a slot it already covered today", () => {
      const decision = decideSchedule(
        { cycleHours: [1], timezone: "UTC" },
        {
          lastStartedAt: new Date("2026-09-22T01:30:00Z"),
          lastCompletedAt: new Date("2026-09-22T02:00:00Z"),
          running: false,
        },
        NOW,
      );

      expect(decision).toMatchObject({ action: "WAIT", reason: "ALREADY_RAN" });
    });

    it("treats a slot within the grace period as on time", () => {
      const decision = decideSchedule(
        { cycleHours: [10], timezone: "UTC" },
        { lastStartedAt: hoursAgo(26), lastCompletedAt: hoursAgo(25), running: false },
        NOW,
      );

      expect(CATCH_UP_GRACE_HOURS).toBeGreaterThan(2);
      expect(decision).toMatchObject({ action: "RUN", reason: "SCHEDULED" });
    });
  });

  describe("configuration robustness", () => {
    it("ignores nonsense hours instead of failing", () => {
      const decision = decideSchedule(
        { cycleHours: [-1, 99, 12.5], timezone: "UTC" },
        idle,
        NOW,
      );

      expect(decision.action).toBe("RUN");
    });

    it("survives an invalid timezone", () => {
      expect(() =>
        decideSchedule({ timezone: "Not/AZone" }, idle, NOW),
      ).not.toThrow();
    });

    it("supports a non-UTC timezone", () => {
      const decision = decideSchedule(
        { cycleHours: [17], timezone: "Asia/Kolkata" },
        { lastStartedAt: hoursAgo(20), lastCompletedAt: hoursAgo(19), running: false },
        NOW,
      );

      // 12:00 UTC is 17:30 in Kolkata, so the 17:00 slot has passed.
      expect(decision.action).toBe("RUN");
    });
  });
});

describe("nextSlot", () => {
  it("finds the next slot later today", () => {
    const next = nextSlot("UTC", NOW, [9, 21]);
    expect(next.getUTCHours()).toBe(21);
  });

  it("rolls over to tomorrow after the last slot", () => {
    const late = new Date("2026-09-22T23:00:00Z");
    const next = nextSlot("UTC", late, [9, 21]);

    expect(next.getUTCDate()).toBe(23);
    expect(next.getUTCHours()).toBe(9);
  });
});

describe("describeSchedule", () => {
  it("reads as a sentence, not a cron expression", () => {
    expect(describeSchedule({ cycleHours: [9, 21], timezone: "Europe/London" })).toBe(
      "Runs at 09:00 and 21:00 (Europe/London).",
    );
  });

  it("describes a single daily run", () => {
    expect(describeSchedule({ cycleHours: [6], timezone: "UTC" })).toContain("06:00");
  });

  it("says plainly when it is off", () => {
    expect(describeSchedule({ enabled: false })).toContain("turned off");
  });
});
