/**
 * Worker liveness.
 *
 * A worker writes one row while it runs and refreshes it on a timer. This
 * module holds the part that decides what "alive" means — pure, so the answer
 * is the same wherever it is asked, and testable without a database.
 *
 * It deliberately does not touch the database itself: the writer is the worker
 * process (which uses the unguarded client) and the reader is the operations
 * page (which uses the guarded one).
 */

/**
 * How long after its last heartbeat a worker stops counting as alive.
 *
 * Three missed beats at the worker's 30-second interval. Long enough that a
 * slow database or a busy event loop does not flap the status, short enough
 * that a worker which has genuinely stopped is reported as stopped within a
 * minute or two.
 */
export const WORKER_STALE_AFTER_MS = 90_000;

/** How often a running worker refreshes its row. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;

export interface WorkerLiveness {
  /** Workers heard from within the staleness window. */
  count: number;
  /** The one that reported most recently, alive or not. */
  newest: { workerId: string; startedAt: Date; lastSeenAt: Date } | null;
  /** The window, so the UI can explain what "recently" means. */
  staleAfterMs: number;
}

export function isWorkerAlive(lastSeenAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - lastSeenAt.getTime() <= WORKER_STALE_AFTER_MS;
}

/**
 * The context stored alongside a heartbeat.
 *
 * Bounded and non-sensitive by construction: a hostname and a pid. Credentials,
 * connection strings, tokens and payloads are never written here — this row is
 * readable by any operator looking at the automation page.
 */
export function heartbeatMetadata(
  env: Record<string, string | undefined> = process.env,
): { hostname: string | null; pid: number } {
  return {
    // Render sets HOSTNAME to the instance name; null elsewhere rather than a
    // guess.
    hostname: typeof env.HOSTNAME === "string" && env.HOSTNAME !== "" ? env.HOSTNAME : null,
    pid: typeof process.pid === "number" ? process.pid : 0,
  };
}
