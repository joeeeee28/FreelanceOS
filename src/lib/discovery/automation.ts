/**
 * Automation operations.
 *
 * What the discovery engine is doing right now, for the person who has to
 * decide whether to trust it. Every figure is read from a stored row and every
 * query is named here, so any number on the operations page can be traced to
 * the question that produced it:
 *
 *   - queue depth        → `Job` grouped by status, scoped to the workspace
 *   - retrying jobs      → `Job` PENDING with attempts > 0
 *   - recent failures    → `Job` FAILED, with their stored categories
 *   - current run        → `DiscoveryRun` RUNNING, newest first
 *   - last run           → `DiscoveryRun` newest by startedAt
 *   - next cycle         → the scheduler's own decision for this workspace
 *   - worker liveness    → `WorkerHeartbeat` seen within the last few minutes
 *
 * Counters on a run are the run's own aggregates — never workspace totals —
 * because they are the numbers the run recorded about itself when it settled.
 *
 * Nothing here is cached and nothing is estimated. Where there is no data the
 * field is null and the UI says so; a workspace that has never run must not
 * read as a workspace that ran and found nothing.
 */

import { db } from "@/lib/db-client";
import { decideSchedule, type ScheduleDecision } from "@/lib/discovery/scheduler";
import { isWorkerAlive, WORKER_STALE_AFTER_MS, type WorkerLiveness } from "@/lib/jobs/heartbeat";

/** Live queue depth for one workspace. */
export interface QueueSnapshot {
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  /** PENDING jobs that have already been attempted at least once. */
  retrying: number;
  /** PENDING jobs whose backoff has not elapsed yet. */
  scheduled: number;
}

export interface RunSummary {
  id: string;
  status: string;
  trigger: string;
  startedAt: Date;
  completedAt: Date | null;
  error: string | null;
  counters: {
    pagesAttempted: number;
    pagesSucceeded: number;
    pagesFailed: number;
    pagesBlocked: number;
    companiesDiscovered: number;
    companiesMatched: number;
    duplicatesPrevented: number;
    signalsDiscovered: number;
    opportunitiesDiscovered: number;
    contactsDiscovered: number;
    leadsCreated: number;
    leadsUpdated: number;
  };
  /** Jobs belonging to this run, by status. */
  jobs: { total: number; succeeded: number; failed: number; cancelled: number; active: number };
}

export interface JobSummary {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  priority: number;
  runAfter: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  lockedBy: string | null;
  lockedUntil: Date | null;
  error: string | null;
  /** The structured failure record, when the job stored one. */
  errorCategory: string | null;
  summary: string | null;
  discoveryRunId: string | null;
}

export interface AutomationOverview {
  queue: QueueSnapshot;
  currentRun: RunSummary | null;
  lastRun: RunSummary | null;
  nextRun: { at: Date; reason: string } | null;
  schedule: ScheduleDecision & { timezone: string };
  recentFailures: JobSummary[];
  recentRuns: RunSummary[];
  research: {
    /** Companies whose last research pass was within thirty days. */
    researchedRecently: number;
    needsReview: number;
    blocked: number;
    never: number;
  };
  sources: { enabled: number; paused: number; blockedLast30d: number };
  /** The most recent fetch refusals, so a blocked source is visible as itself. */
  blockedFetches: Array<{ url: string; sourceName: string | null; fetchedAt: Date }>;
}

const COUNTER_KEYS = [
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

type CounterKey = (typeof COUNTER_KEYS)[number];

/** Pulls the twelve counters off a run row, in schema order. */
function runCounters(run: Record<CounterKey, number>): RunSummary["counters"] {
  const counters = {} as RunSummary["counters"];
  for (const key of COUNTER_KEYS) counters[key] = run[key];
  return counters;
}

/**
 * One run, with a summary of its jobs.
 *
 * The job counts come from a single grouped query rather than a per-run loop,
 * so listing twenty runs costs one extra query rather than twenty.
 */
async function toSummaries(
  runs: Array<Record<string, unknown> & { id: string }>,
): Promise<RunSummary[]> {
  if (runs.length === 0) return [];

  const grouped = await db.job.groupBy({
    by: ["discoveryRunId", "status"],
    where: { discoveryRunId: { in: runs.map((run) => run.id) } },
    _count: { _all: true },
  });

  return runs.map((run) => {
    const rows = grouped.filter(
      (row: { discoveryRunId: string | null; status: string }) => row.discoveryRunId === run.id,
    );
    const countOf = (status: string) =>
      rows.find((row: { status: string }) => row.status === status)?._count._all ?? 0;

    const succeeded = countOf("SUCCEEDED");
    const failed = countOf("FAILED");
    const cancelled = countOf("CANCELLED");
    const active = countOf("PENDING") + countOf("RUNNING");

    return {
      id: run.id,
      status: String(run.status),
      trigger: String(run.trigger),
      startedAt: run.startedAt as Date,
      completedAt: (run.completedAt as Date | null) ?? null,
      error: (run.error as string | null) ?? null,
      counters: runCounters(run as unknown as Record<CounterKey, number>),
      jobs: { total: succeeded + failed + cancelled + active, succeeded, failed, cancelled, active },
    };
  });
}

/** Live queue depth, from the Job table. */
export async function getQueueSnapshot(
  workspaceId: string,
  now: Date = new Date(),
): Promise<QueueSnapshot> {
  const [grouped, retrying, scheduled]: [
    Array<{ status: string; _count: { _all: number } }>,
    number,
    number,
  ] = await Promise.all([
    db.job.groupBy({
      by: ["status"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    db.job.count({ where: { workspaceId, status: "PENDING", attempts: { gt: 0 } } }),
    db.job.count({
      where: { workspaceId, status: "PENDING", runAfter: { gt: now } },
    }),
  ]);

  const countOf = (status: string) =>
    grouped.find((row: { status: string }) => row.status === status)?._count._all ?? 0;

  return {
    pending: countOf("PENDING"),
    running: countOf("RUNNING"),
    succeeded: countOf("SUCCEEDED"),
    failed: countOf("FAILED"),
    cancelled: countOf("CANCELLED"),
    retrying,
    scheduled,
  };
}

/** Recent failures, newest first, with their stored categories. */
export async function getRecentFailures(
  workspaceId: string,
  options: { limit?: number } = {},
): Promise<JobSummary[]> {
  const jobs = await db.job.findMany({
    where: { workspaceId, status: "FAILED" },
    orderBy: { completedAt: "desc" },
    take: Math.min(50, Math.max(1, options.limit ?? 10)),
  });

  return jobs.map(toJobSummary);
}

/** Maps a Job row into the shape the operations page renders. */
export function toJobSummary(job: {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  priority: number;
  runAfter: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  lockedBy: string | null;
  lockedUntil: Date | null;
  error: string | null;
  result: unknown;
  discoveryRunId: string | null;
}): JobSummary {
  const result = job.result as {
    summary?: unknown;
    error?: { category?: unknown };
  } | null;

  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    priority: job.priority,
    runAfter: job.runAfter,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    lockedBy: job.lockedBy,
    lockedUntil: job.lockedUntil,
    error: job.error,
    errorCategory:
      result !== null && typeof result?.error?.category === "string"
        ? result.error.category
        : null,
    summary: typeof result?.summary === "string" ? result.summary : null,
    discoveryRunId: job.discoveryRunId,
  };
}

/** The most recent runs, newest first. */
export async function getRecentRuns(
  workspaceId: string,
  options: { limit?: number } = {},
): Promise<RunSummary[]> {
  const runs = await db.discoveryRun.findMany({
    where: { workspaceId },
    orderBy: { startedAt: "desc" },
    take: Math.min(50, Math.max(1, options.limit ?? 10)),
  });

  return toSummaries(runs as unknown as Array<Record<string, unknown> & { id: string }>);
}

/**
 * One run, by id, scoped to the workspace.
 *
 * Returns null rather than throwing for a run belonging to somebody else —
 * a cross-workspace id is indistinguishable from one that does not exist, which
 * is the correct answer to give.
 */
export async function getRunDetail(
  workspaceId: string,
  runId: string,
): Promise<{ run: RunSummary; jobs: JobSummary[] } | null> {
  const run = await db.discoveryRun.findFirst({ where: { id: runId, workspaceId } });
  if (run === null) return null;

  const jobs = await db.job.findMany({
    where: { discoveryRunId: run.id },
    orderBy: [{ status: "asc" }, { priority: "asc" }, { createdAt: "asc" }],
  });

  const [summary] = await toSummaries([
    run as unknown as Record<string, unknown> & { id: string },
  ]);

  return {
    run: summary,
    jobs: jobs.map(toJobSummary),
  };
}

/** One job, by id, scoped to the workspace. */
export async function getJobDetail(
  workspaceId: string,
  jobId: string,
): Promise<JobSummary | null> {
  const job = await db.job.findFirst({ where: { id: jobId, workspaceId } });
  return job === null ? null : toJobSummary(job);
}

/**
 * The next cycle this workspace is due, from the scheduler itself.
 *
 * The decision is computed with the same function the worker uses, so the page
 * cannot drift from the behaviour it describes.
 */
export function getScheduleFor(
  timezone: string,
  state: { lastStartedAt: Date | null; lastCompletedAt: Date | null; running: boolean },
  now: Date = new Date(),
): { decision: ScheduleDecision; timezone: string } {
  return { decision: decideSchedule({ timezone }, state, now), timezone };
}

/** Whether any worker process has reported in recently. */
export async function getWorkerLiveness(
  now: Date = new Date(),
): Promise<WorkerLiveness> {
  const workers = await db.workerHeartbeat.findMany({
    orderBy: { lastSeenAt: "desc" },
    take: 10,
  });

  const alive = workers.filter((worker: { lastSeenAt: Date }) =>
    isWorkerAlive(worker.lastSeenAt, now),
  );
  const newest = workers[0];

  return {
    count: alive.length,
    newest:
      newest === undefined
        ? null
        : {
            workerId: newest.workerId,
            startedAt: newest.startedAt,
            lastSeenAt: newest.lastSeenAt,
          },
    staleAfterMs: WORKER_STALE_AFTER_MS,
  };
}

/** Everything the operations page shows, in one call. */
export async function getAutomationOverview(
  workspaceId: string,
  options: { timezone: string; now?: Date } = { timezone: "UTC" },
): Promise<AutomationOverview> {
  const now = options.now ?? new Date();

  const researchWindowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    queue,
    currentRunRow,
    lastRunRow,
    recentRuns,
    recentFailures,
    researchStates,
    researchedRecently,
    sources,
    blockedLast30d,
    blockedFetches,
  ] = await Promise.all([
    getQueueSnapshot(workspaceId, now),
    db.discoveryRun.findFirst({
      where: { workspaceId, status: "RUNNING" },
      orderBy: { startedAt: "desc" },
    }),
    db.discoveryRun.findFirst({
      where: { workspaceId },
      orderBy: { startedAt: "desc" },
    }),
    getRecentRuns(workspaceId, { limit: 10 }),
    getRecentFailures(workspaceId, { limit: 10 }),
    db.company.groupBy({
      by: ["researchStatus"],
      where: { workspaceId, archivedAt: null },
      _count: { _all: true },
    }),
    // Counted from the stored timestamp the research pass wrote, not from a
    // research-run join: this answers "how many companies have been looked at
    // lately", which is a property of the company record.
    db.company.count({
      where: { workspaceId, archivedAt: null, lastResearchAt: { gte: researchWindowStart } },
    }),
    db.source.groupBy({
      by: ["enabled"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    db.fetchLog.count({
      where: {
        workspaceId,
        outcome: "BLOCKED",
        fetchedAt: { gte: researchWindowStart },
      },
    }),
    db.fetchLog.findMany({
      where: { workspaceId, outcome: "BLOCKED" },
      orderBy: { fetchedAt: "desc" },
      take: 5,
      select: { url: true, fetchedAt: true, source: { select: { name: true } } },
    }),
  ]);

  const [currentRun] = await toSummaries(
    currentRunRow === null
      ? []
      : [currentRunRow as unknown as Record<string, unknown> & { id: string }],
  );
  const [lastRun] = await toSummaries(
    lastRunRow === null
      ? []
      : [lastRunRow as unknown as Record<string, unknown> & { id: string }],
  );

  const researchCountOf = (status: string) =>
    researchStates.find(
      (row: { researchStatus: string }) => row.researchStatus === status,
    )?._count._all ?? 0;

  const scheduleState = {
    lastStartedAt: lastRunRow?.startedAt ?? null,
    lastCompletedAt: lastRunRow?.completedAt ?? null,
    running: currentRunRow !== null,
  };

  const { decision } = getScheduleFor(options.timezone, scheduleState, now);

  return {
    queue,
    currentRun: currentRun ?? null,
    lastRun: lastRun ?? null,
    nextRun:
      decision.action === "WAIT" && decision.nextRunAt !== null
        ? { at: decision.nextRunAt, reason: decision.reason }
        : decision.action === "RUN" || decision.action === "RESUME"
          ? { at: decision.scheduledFor, reason: decision.reason }
          : null,
    schedule: { ...decision, timezone: options.timezone },
    recentFailures,
    recentRuns,
    research: {
      researchedRecently,
      needsReview: researchCountOf("NEEDS_REVIEW"),
      blocked: researchCountOf("BLOCKED"),
      never: researchCountOf("NEVER"),
    },
    sources: {
      enabled: sources.find((row: { enabled: boolean }) => row.enabled)?._count._all ?? 0,
      paused:
        sources.find((row: { enabled: boolean }) => row.enabled === false)?._count._all ?? 0,
      blockedLast30d,
    },
    blockedFetches: blockedFetches.map(
      (row: { url: string; fetchedAt: Date; source: { name: string } | null }) => ({
        url: row.url,
        sourceName: row.source?.name ?? null,
        fetchedAt: row.fetchedAt,
      }),
    ),
  };
}
