/**
 * Automation operations panels.
 *
 * Presentational only: every figure arrives already read from the database by
 * `@/lib/discovery/automation`, and nothing here invents a number, a trend or a
 * percentage. Where a value is unknown the panel says so in words — a
 * dashboard that renders "0" for "we have never run" is worse than one that
 * renders nothing, because it looks like an answer.
 */

import { Badge, Card, CardBody, CardHeader, EmptyState } from "@/components/ui/primitives";
import type {
  AutomationOverview,
  JobSummary,
  RunSummary,
} from "@/lib/discovery/automation";
import type { WorkerLiveness } from "@/lib/jobs/heartbeat";

/** "3 minutes ago" / "just now" / "in 2 hours". */
export function relative(at: Date, now: Date): string {
  const deltaMs = at.getTime() - now.getTime();
  const past = deltaMs < 0;
  const seconds = Math.round(Math.abs(deltaMs) / 1000);

  if (seconds < 45) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return past ? `${minutes}m ago` : `in ${minutes}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return past ? `${hours}h ago` : `in ${hours}h`;

  const days = Math.round(hours / 24);
  return past ? `${days}d ago` : `in ${days}d`;
}

function tone(status: string): "neutral" | "success" | "warning" | "danger" {
  switch (status) {
    case "COMPLETED":
    case "SUCCEEDED":
      return "success";
    case "RUNNING":
    case "PENDING":
      return "warning";
    case "FAILED":
      return "danger";
    default:
      return "neutral";
  }
}

function humanise(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** One period of time between two instants, or "-" while it is still open. */
function duration(from: Date, to: Date | null, now: Date): string {
  if (to === null) return `running ${relative(from, now).replace(" ago", "")}`;

  const seconds = Math.round((to.getTime() - from.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/**
 * The queue, as it stands.
 *
 * "Retrying" is PENDING with attempts > 0: a job that has already failed once
 * and is waiting for its backoff. That is a different operational state from
 * "pending", which has never run.
 */
export function QueuePanel({
  queue,
  worker,
  now,
}: {
  queue: AutomationOverview["queue"];
  worker: WorkerLiveness;
  now: Date;
}) {
  const tiles = [
    { label: "Pending", value: queue.pending, hint: `${queue.scheduled} waiting on backoff` },
    { label: "Running", value: queue.running, hint: "Held by a worker now" },
    { label: "Retrying", value: queue.retrying, hint: "Failed at least once" },
    { label: "Failed", value: queue.failed, hint: "Terminal, needs a human" },
  ];

  return (
    <Card>
      <CardHeader
        title="Queue"
        description="Jobs the worker has been given, by state."
        action={
          <Badge tone={worker.count > 0 ? "success" : "warning"}>
            {worker.count > 0
              ? `${worker.count} worker${worker.count === 1 ? "" : "s"} alive`
              : "No worker reporting"}
          </Badge>
        }
      />
      <CardBody>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map((tile) => (
            <div
              key={tile.label}
              className="rounded-lg border border-border bg-surface px-3.5 py-3"
            >
              <p className="text-xs font-medium text-muted-foreground">{tile.label}</p>
              <p className="tabular mt-1.5 text-xl font-semibold leading-none text-foreground">
                {tile.value}
              </p>
              <p className="mt-1.5 text-xs text-subtle-foreground">{tile.hint}</p>
            </div>
          ))}
        </div>

        <p className="mt-3 text-xs text-subtle-foreground">
          {worker.count > 0 && worker.newest !== null
            ? `Last worker heartbeat ${relative(worker.newest.lastSeenAt, now)} (${worker.newest.workerId}). A worker counts as alive for ${Math.round(
                worker.staleAfterMs / 1000,
              )}s after its last heartbeat.`
            : "No worker process has reported in. Nothing in the queue will run until one starts — scheduling happens in the worker, not in the web app."}
        </p>
      </CardBody>
    </Card>
  );
}

/** The run in flight, or the last one, with its own counters. */
export function RunPanel({
  title,
  description,
  run,
  now,
}: {
  title: string;
  description: string;
  run: RunSummary | null;
  now: Date;
}) {
  if (run === null) {
    return (
      <Card>
        <CardHeader title={title} description={description} />
        <CardBody>
          <EmptyState
            title="Nothing here yet"
            description="This workspace has no discovery run recorded. It will appear here the first time the scheduler queues a cycle."
          />
        </CardBody>
      </Card>
    );
  }

  const counters: Array<[string, number]> = [
    ["Pages read", run.counters.pagesSucceeded],
    ["Pages attempted", run.counters.pagesAttempted],
    ["Pages blocked", run.counters.pagesBlocked],
    ["Companies found", run.counters.companiesDiscovered],
    ["Companies matched", run.counters.companiesMatched],
    ["Duplicates prevented", run.counters.duplicatesPrevented],
    ["Signals", run.counters.signalsDiscovered],
    ["Opportunities", run.counters.opportunitiesDiscovered],
    ["Leads created", run.counters.leadsCreated],
    ["Leads updated", run.counters.leadsUpdated],
  ];

  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        action={<Badge tone={tone(run.status)}>{humanise(run.status)}</Badge>}
      />
      <CardBody>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Started</dt>
            <dd className="text-foreground">
              {relative(run.startedAt, now)}
              <span className="text-subtle-foreground"> · {run.trigger.toLowerCase()}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Took</dt>
            <dd className="text-foreground">{duration(run.startedAt, run.completedAt, now)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Jobs</dt>
            <dd className="text-foreground">
              {run.jobs.succeeded} done
              {run.jobs.active > 0 && `, ${run.jobs.active} active`}
              {run.jobs.failed > 0 && `, ${run.jobs.failed} failed`}
              {run.jobs.cancelled > 0 && `, ${run.jobs.cancelled} cancelled`}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Counters</dt>
            <dd className="text-foreground">
              {run.counters.pagesSucceeded} read · {run.counters.companiesDiscovered} new ·{" "}
              {run.counters.opportunitiesDiscovered} opportunities
            </dd>
          </div>
        </dl>

        {run.error !== null && (
          <p className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            {run.error}
          </p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-3 text-xs sm:grid-cols-5">
          {counters.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-2">
              <span className="text-subtle-foreground">{label}</span>
              <span className="tabular font-medium text-foreground">{value}</span>
            </div>
          ))}
        </div>

        <p className="mt-3 text-xs text-subtle-foreground">
          Counters are aggregated from the structured results of this run&apos;s own jobs. A
          job that found nothing contributes nothing, and a job that failed contributes none
          of its partial work.
        </p>
      </CardBody>
    </Card>
  );
}

/** Recent failures, with the stored category and message. */
export function FailuresPanel({
  failures,
  now,
}: {
  failures: JobSummary[];
  now: Date;
}) {
  return (
    <Card>
      <CardHeader
        title="Recent failures"
        description="Every failed job keeps its own error. Nothing is retried past its attempt limit without a person asking."
      />
      <CardBody>
        {failures.length === 0 ? (
          <EmptyState
            title="No failed jobs"
            description="Nothing has failed in this workspace. A source that is blocked or empty is reported as a normal outcome on its source row, not here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {failures.map((job) => (
              <li key={job.id} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {humanise(job.type)}
                    {job.errorCategory !== null && (
                      <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[11px] font-normal text-subtle-foreground">
                        {job.errorCategory}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-subtle-foreground">
                    {job.completedAt === null ? "" : relative(job.completedAt, now)} ·{" "}
                    {job.attempts}/{job.maxAttempts} attempts
                  </span>
                </div>
                <p className="mt-1 text-xs text-subtle-foreground">{job.error ?? "No message"}</p>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/** What research has actually been done, and where it stands. */
export function ResearchPanel({
  research,
  coverage,
}: {
  research: AutomationOverview["research"];
  /**
   * Which aspects this build implements, phrased as "5 of 12 aspects".
   * Passed in rather than recomputed so the panel cannot drift from the
   * researchers that actually exist.
   */
  coverage: string;
}) {
  const rows: Array<[string, number, string]> = [
    [
      "Looked at in the last 30 days",
      research.researchedRecently,
      "Companies with a recorded research pass inside the window.",
    ],
    [
      "Needs review",
      research.needsReview,
      "The site could not be read. Retried next cycle rather than written off.",
    ],
    [
      "Blocked",
      research.blocked,
      "The site refused access. Re-checked occasionally, never worked around.",
    ],
    [
      "Never researched",
      research.never,
      "No website on record, or not yet reached by a research pass.",
    ],
  ];

  return (
    <Card>
      <CardHeader
        title="Research"
        description="What the engine has read, from the company records themselves."
        action={<Badge tone="neutral">{coverage}</Badge>}
      />
      <CardBody>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {rows.map(([label, value, hint]) => (
            <div key={label} className="rounded-lg border border-border bg-surface px-3.5 py-3">
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
              <p className="tabular mt-1.5 text-xl font-semibold leading-none text-foreground">
                {value}
              </p>
              <p className="mt-1.5 text-xs text-subtle-foreground">{hint}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-subtle-foreground">
          Research covers the aspects this build implements — the company&apos;s own website,
          its published contact details, its location and the profiles it links to. Aspects
          with no researcher (hiring boards, technology fingerprinting, industry and decision
          makers) stay &ldquo;never researched&rdquo; rather than being marked done with
          nothing behind them, and a company is never reported as fully researched while one
          of them could still change the answer.
        </p>
      </CardBody>
    </Card>
  );
}

/** The next cycle the scheduler would queue, from the scheduler itself. */
export function SchedulePanel({
  overview,
  now,
}: {
  overview: AutomationOverview;
  now: Date;
}) {
  const { schedule, nextRun } = overview;

  const reason =
    schedule.action === "WAIT"
      ? humanise(schedule.reason)
      : schedule.action === "RUN"
        ? `Due now (${humanise(schedule.reason)})`
        : "Recovering a stalled run";

  return (
    <Card>
      <CardHeader
        title="Schedule"
        description="Two cycles a day in the workspace's own timezone."
        action={<Badge tone="neutral">{schedule.timezone}</Badge>}
      />
      <CardBody>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Next cycle</dt>
            <dd className="text-foreground">
              {nextRun === null ? "No further cycles" : relative(nextRun.at, now)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">State</dt>
            <dd className="text-foreground">{reason}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Job idempotency</dt>
            <dd className="text-foreground">
              Keyed per workspace, per local slot — one run per slot, never two.
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-subtle-foreground">
          A machine that was off for days does today&apos;s work rather than a backlog, and a
          missed slot inside the catch-up window runs once — never twice.
        </p>
      </CardBody>
    </Card>
  );
}

/** Sources, and the refusals they recorded. */
export function SourcesPanel({ overview, now }: { overview: AutomationOverview; now: Date }) {
  return (
    <Card>
      <CardHeader
        title="Sources"
        description="Configured discovery sources, and refusals the fetcher recorded."
      />
      <CardBody>
        <div className="grid grid-cols-3 gap-3">
          {(
            [
              ["Enabled", overview.sources.enabled],
              ["Paused", overview.sources.paused],
              ["Blocked fetches (30d)", overview.sources.blockedLast30d],
            ] as Array<[string, number]>
          ).map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-surface px-3.5 py-3">
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
              <p className="tabular mt-1.5 text-xl font-semibold leading-none text-foreground">
                {value}
              </p>
            </div>
          ))}
        </div>

        {overview.blockedFetches.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-subtle-foreground">
            {overview.blockedFetches.map((fetch) => (
              <li key={`${fetch.url}-${fetch.fetchedAt.toISOString()}`} className="truncate">
                <span className="text-danger">Blocked</span> · {fetch.url}
                {fetch.sourceName !== null && ` · ${fetch.sourceName}`} ·{" "}
                {relative(fetch.fetchedAt, now)}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
