import Link from "next/link";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/auth/require-user";
import { getRunDetail } from "@/lib/discovery/automation";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@/components/ui/primitives";
import { PageHeader, PageSections } from "@/components/ui/page";
import { relative } from "@/components/crm/automation-panels";
import { JobControls } from "@/components/crm/automation-controls";

export const dynamic = "force-dynamic";

/**
 * One discovery run, in full.
 *
 * Answers "what actually happened in this cycle": when it started and finished,
 * how it ended, every job it owns with that job's own outcome, the counters it
 * recorded about itself, and the sources and research it touched.
 *
 * The lookup is workspace-scoped in the query, so another workspace's run id is
 * simply not found — there is no authorisation step to forget.
 */
export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const now = new Date();
  const { workspaceId } = await requireUser();

  const detail = await getRunDetail(workspaceId, id);
  if (detail === null) notFound();

  const { run, jobs } = detail;

  const counters: Array<[string, number]> = [
    ["Pages attempted", run.counters.pagesAttempted],
    ["Pages succeeded", run.counters.pagesSucceeded],
    ["Pages failed", run.counters.pagesFailed],
    ["Pages blocked", run.counters.pagesBlocked],
    ["Companies discovered", run.counters.companiesDiscovered],
    ["Companies matched", run.counters.companiesMatched],
    ["Duplicates prevented", run.counters.duplicatesPrevented],
    ["Signals discovered", run.counters.signalsDiscovered],
    ["Opportunities discovered", run.counters.opportunitiesDiscovered],
    ["Contacts discovered", run.counters.contactsDiscovered],
    ["Leads created", run.counters.leadsCreated],
    ["Leads updated", run.counters.leadsUpdated],
  ];

  const tone =
    run.status === "COMPLETED"
      ? "success"
      : run.status === "RUNNING"
        ? "warning"
        : run.status === "FAILED"
          ? "danger"
          : "neutral";

  return (
    <>
      <PageHeader
        title="Discovery run"
        description={`${run.trigger.toLowerCase()} · started ${relative(run.startedAt, now)}`}
        actions={
          <Link
            href="/automation"
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            Back to automation
          </Link>
        }
      />

      <PageSections>
        <Card>
          <CardHeader
            title="Outcome"
            action={<Badge tone={tone}>{run.status.toLowerCase()}</Badge>}
          />
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Started</dt>
                <dd className="text-foreground">
                  {run.startedAt.toISOString().replace("T", " ").slice(0, 19)} UTC
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Completed</dt>
                <dd className="text-foreground">
                  {run.completedAt === null
                    ? "Still running"
                    : run.completedAt.toISOString().replace("T", " ").slice(0, 19) + " UTC"}
                </dd>
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
                <dt className="text-xs text-muted-foreground">Run id</dt>
                <dd className="truncate font-mono text-xs text-subtle-foreground">{run.id}</dd>
              </div>
            </dl>

            {run.error !== null && (
              <p className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                {run.error}
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Counters"
            description="Aggregated from the structured results of this run's own succeeded jobs — never a workspace total, never a timestamp guess."
          />
          <CardBody>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              {counters.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-subtle-foreground">{label}</span>
                  <span className="tabular font-medium text-foreground">{value}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-subtle-foreground">
              Contacts discovered is reported by the schema but has no producer in this build:
              nothing in the pipeline creates a discovered contact, so it stays at zero rather
              than counting something adjacent.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Jobs"
            description="Every job belonging to this run, including the fan-out job that queued them."
          />
          <CardBody>
            {jobs.length === 0 ? (
              <EmptyState
                title="No jobs"
                description="This run queued nothing — there were no enabled sources and no companies due for research."
              />
            ) : (
              <ul className="divide-y divide-border">
                {jobs.map((job) => (
                  <li
                    key={job.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/automation/jobs/${job.id}`}
                        className="text-sm font-medium text-foreground underline-offset-2 hover:underline"
                      >
                        {job.type}
                      </Link>
                      <span className="ml-2 text-xs text-subtle-foreground">
                        {job.status.toLowerCase()} · {job.attempts}/{job.maxAttempts} attempts
                        {job.completedAt !== null && ` · ${relative(job.completedAt, now)}`}
                      </span>
                      {job.error !== null && (
                        <p className="mt-1 text-xs text-danger">{job.error}</p>
                      )}
                    </div>
                    <JobControls jobId={job.id} status={job.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </PageSections>
    </>
  );
}
