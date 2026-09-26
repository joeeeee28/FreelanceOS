/**
 * Job execution helpers.
 *
 * These are the parts of job reliability that are pure logic — the deadline,
 * the abort wiring and the classification of failures. They are tested on their
 * own because the interesting cases are timing ones: an operation that finishes
 * just inside its deadline, one that ignores the abort signal entirely, and one
 * that is still running when the caller stops waiting. None of those need a
 * database to exercise.
 */

import { describe, expect, it, vi } from "vitest";

import {
  JobTimeoutError,
  classifyError,
  failureRecord,
  runWithDeadline,
} from "@/lib/jobs/execution";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("runWithDeadline", () => {
  it("returns the value when the operation finishes in time", async () => {
    const outcome = await runWithDeadline(async () => "done", { timeoutMs: 1_000 });

    expect(outcome).toEqual({ kind: "COMPLETED", value: "done" });
  });

  it("reports a timeout when the operation outlives its deadline", async () => {
    const outcome = await runWithDeadline(
      async () => {
        await sleep(5_000);
        return "too late";
      },
      { timeoutMs: 20 },
    );

    expect(outcome.kind).toBe("TIMED_OUT");
  });

  it("does not wait for an operation that ignores the abort signal", async () => {
    let finished = false;

    const started = Date.now();
    const outcome = await runWithDeadline(
      async () => {
        // Deliberately ignores the signal: this is a handler that cannot be
        // stopped, and the caller must not be held hostage by it.
        await sleep(1_000);
        finished = true;
        return "never returned to the caller";
      },
      { timeoutMs: 20 },
    );
    const elapsed = Date.now() - started;

    expect(outcome.kind).toBe("TIMED_OUT");
    expect(elapsed).toBeLessThan(500);
    expect(finished).toBe(false);
  });

  it("aborts the signal it hands the operation", async () => {
    let sawAbort = false;

    await runWithDeadline(
      async (signal) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
        });
        await sleep(200);
        return null;
      },
      { timeoutMs: 20 },
    );

    expect(sawAbort).toBe(true);
  });

  it("follows an outer abort, so shutdown reaches the handler", async () => {
    const outer = new AbortController();
    let sawAbort = false;

    const running = runWithDeadline(
      async (signal) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
        });
        await sleep(200);
        return "finished";
      },
      { timeoutMs: 5_000, signal: outer.signal },
    );

    outer.abort();
    const outcome = await running;

    // The operation completed (it was not killed), but it was told to stop.
    expect(sawAbort).toBe(true);
    expect(outcome).toEqual({ kind: "COMPLETED", value: "finished" });
  });

  it("aborts immediately when the outer signal is already aborted", async () => {
    const outer = new AbortController();
    outer.abort();

    let sawAbort = false;

    await runWithDeadline(
      async (signal) => {
        sawAbort = signal.aborted;
        return "done";
      },
      { timeoutMs: 1_000, signal: outer.signal },
    );

    expect(sawAbort).toBe(true);
  });

  it("clears its timer, so a finished job leaves nothing pending", async () => {
    vi.useFakeTimers();
    try {
      const outcome = await runWithDeadline(async () => "quick", { timeoutMs: 60_000 });
      expect(outcome).toEqual({ kind: "COMPLETED", value: "quick" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("classifyError", () => {
  it("recognises its own timeout error", () => {
    expect(classifyError(new JobTimeoutError(1_000))).toBe("TIMEOUT");
  });

  it("recognises a Prisma error code", () => {
    expect(classifyError(Object.assign(new Error("boom"), { code: "P1001" }))).toBe(
      "DATABASE",
    );
  });

  it("recognises a refusal", () => {
    expect(classifyError(new Error("Disallowed by robots.txt"))).toBe("BLOCKED");
    expect(classifyError(new Error("403 Forbidden"))).toBe("BLOCKED");
  });

  it("recognises a transport failure", () => {
    expect(classifyError(new Error("fetch failed"))).toBe("NETWORK");
    expect(classifyError(new Error("connect ETIMEDOUT"))).toBe("NETWORK");
  });

  it("recognises a contract violation from a handler", () => {
    expect(classifyError(new Error("No sourceId in payload"))).toBe("VALIDATION");
    expect(classifyError(new Error("No companyId in payload"))).toBe("VALIDATION");
  });

  it("recognises an abort", () => {
    expect(classifyError(new Error("The operation was aborted"))).toBe("ABORTED");
  });

  it("falls back to UNKNOWN rather than guessing", () => {
    expect(classifyError(new Error("something odd"))).toBe("UNKNOWN");
    expect(classifyError(undefined)).toBe("UNKNOWN");
  });
});

describe("failureRecord", () => {
  it("keeps the category, attempt and time, and bounds the message", () => {
    const record = failureRecord(new Error("x".repeat(5_000)), {
      attempt: 2,
      now: new Date("2026-03-10T00:00:00Z"),
    });

    expect(record.attempt).toBe(2);
    expect(record.at).toBe("2026-03-10T00:00:00.000Z");
    expect(record.message.length).toBeLessThanOrEqual(500);
  });

  it("strips control characters so the message is safe to display", () => {
    const record = failureRecord(new Error("bad\u0000error\u001f"), {
      attempt: 1,
      now: new Date(),
    });

    expect(record.message).toBe("bad error");
  });

  it("never produces an empty message", () => {
    const record = failureRecord("", { attempt: 1, now: new Date() });
    expect(record.message).toBe("Unknown failure");
  });

  it("accepts a category when the caller already knows the cause", () => {
    const record = failureRecord(new Error("whatever"), {
      attempt: 1,
      now: new Date(),
      category: "TIMEOUT",
    });

    expect(record.category).toBe("TIMEOUT");
  });
});
