/**
 * Job execution helpers.
 *
 * Deliberately free of the database and of `@prisma/client`, so the parts of
 * job reliability that are pure logic — the deadline, the abort wiring and the
 * error classification — can be tested exactly, without a queue, a worker or a
 * clock.
 */

/** Categories a job failure can be filed under. */
export const JOB_ERROR_CATEGORIES = [
  "TIMEOUT",
  "ABORTED",
  "VALIDATION",
  "DATABASE",
  "NETWORK",
  "BLOCKED",
  "UNKNOWN",
] as const;

export type JobErrorCategory = (typeof JOB_ERROR_CATEGORIES)[number];

/** Raised when a handler exceeds its deadline. */
export class JobTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Job exceeded its ${Math.round(timeoutMs / 1000)}s deadline`);
    this.name = "JobTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Files an error under a category.
 *
 * Classification is by shape and message, because that is all a caught error
 * reliably carries: a provider throws a string, Prisma throws a coded error,
 * and `fetch` throws a TypeError with the real cause nested. Anything that
 * cannot be placed is `UNKNOWN` rather than a guess.
 */
export function classifyError(error: unknown): JobErrorCategory {
  if (error instanceof JobTimeoutError) return "TIMEOUT";

  const name = error instanceof Error ? error.name : "";
  const message = (
    error instanceof Error ? error.message : typeof error === "string" ? error : ""
  ).toLowerCase();

  if (name === "AbortError" || message.includes("aborted") || message.includes("abort")) {
    return "ABORTED";
  }

  // Prisma codes: P1xxx connection/engine, P2xxx query and constraints.
  const code = String((error as { code?: unknown } | null)?.code ?? "").toLowerCase();
  if (/^p\d{4}$/.test(code)) {
    return "DATABASE";
  }
  if (
    message.includes("prisma") ||
    message.includes("database") ||
    message.includes("connection pool") ||
    message.includes("econnrefused")
  ) {
    return "DATABASE";
  }

  if (
    message.includes("robots") ||
    message.includes("blocked") ||
    message.includes("forbidden") ||
    message.includes("refused") ||
    message.includes("captcha")
  ) {
    return "BLOCKED";
  }

  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("socket")
  ) {
    return "NETWORK";
  }

  // Handler-level contract problems: a missing or unusable payload field.
  if (
    message.includes("payload") ||
    message.includes("no sourceid") ||
    message.includes("no companyid") ||
    message.includes("no url") ||
    message.includes("invalid") ||
    message.includes("required")
  ) {
    return "VALIDATION";
  }

  return "UNKNOWN";
}

export type DeadlineOutcome<T> =
  | { kind: "COMPLETED"; value: T }
  | { kind: "TIMED_OUT" };

export interface DeadlineOptions {
  /** How long the operation may run. */
  timeoutMs: number;
  /** Aborted when the process is shutting down; follows the deadline signal. */
  signal?: AbortSignal;
}

/**
 * Runs an operation under a deadline.
 *
 * On expiry the returned signal is aborted so a cooperative handler stops
 * early, and the caller is told the job timed out. The operation itself is not
 * forcibly killed — JavaScript cannot do that safely — so the caller must treat
 * the result as abandoned and let the ownership guard reject any late write
 * from it.
 */
export async function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions,
): Promise<DeadlineOutcome<T>> {
  const controller = new AbortController();

  const onOuterAbort = () => controller.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;

  const deadline = new Promise<DeadlineOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      // Stop the work if it can be stopped. A handler that ignores the signal
      // keeps running; the caller has already stopped waiting for it.
      controller.abort();
      resolve({ kind: "TIMED_OUT" });
    }, Math.max(1, options.timeoutMs));
  });

  try {
    const settled = await Promise.race([
      operation(controller.signal).then(
        (value): DeadlineOutcome<T> => ({ kind: "COMPLETED", value }),
      ),
      deadline,
    ]);

    return settled;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (options.signal !== undefined) {
      options.signal.removeEventListener("abort", onOuterAbort);
    }
    // Referenced so the flag is not dead weight: it is what tells a reader that
    // a late resolution after expiry is discarded by the race, not awaited.
    void expired;
  }
}

/**
 * Turns a job failure into the structured record stored on the job.
 *
 * Deliberately small and bounded: the failure is shown in the operations UI, so
 * it carries a category, a truncation-limited message and the attempt number,
 * and nothing crawled or fetched is copied into it.
 */
export interface JobFailureRecord {
  category: JobErrorCategory;
  message: string;
  attempt: number;
  at: string;
}

export function failureRecord(
  error: unknown,
  options: { attempt: number; now: Date; category?: JobErrorCategory },
): JobFailureRecord {
  const message = (error instanceof Error ? error.message : String(error))
    // Control characters would corrupt the UI and any log line reading it.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 500);

  return {
    category: options.category ?? classifyError(error),
    message: message === "" ? "Unknown failure" : message,
    attempt: options.attempt,
    at: options.now.toISOString(),
  };
}
