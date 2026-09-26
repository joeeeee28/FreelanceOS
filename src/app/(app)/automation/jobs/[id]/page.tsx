import Link from "next/link";
import { notFound } from "next/navigation";

import { requireUser } from "@/lib/auth/require-user";
import { getJobDetail } from "@/lib/discovery/automation";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui/primitives";
import { PageHeader, PageSections } from "@/components/ui/page";
import { relative } from "@/components/crm/automation-panels";
import { CancelJobButton, RetryJobButton } from "@/components/crm/automation-controls";

export const dynamic = "force-dynamic";

/**
 * One job, in full.
 *
 * The failure detail is the point: a job that failed keeps the message the
 * handler produced and the category it was filed under, and the operations page
 * links here rather than showing a bare count. The payload is summarised rather
 * than dumped — it names ids, and a wall of JSON helps nobody.
 */
export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const now = new Date();
  const { workspaceId } = await requireUser();

  const job = await getJobDetail(workspaceId, id);
  if (job === null) notFound();

  const tone =
    job.status === "SUCCEEDED"
      ? "success"
      : job.status === "RUNNING" || job.status === "PENDING"
        ? "warning"
        : job.status === "FAILED"
          ? "danger"
          : "neutral";

  return (
    <>
      <PageHeader
        title={job.type}
        description={`${job.status.toLowerCase()} · ${job.attempts} of ${job.maxAttempts} attempts used`}
        actions={
          <Link
            href={job.discoveryRunId === null ? "/automation" : `/automation/runs/${job.discoveryRunId}`}
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            {job.discoveryRunId === null ? "Back to automation" : "Back to the run"}
          </Link>
        }
      />

      <PageSections>
        <Card>
          <CardHeader title="State" action={<Badge tone={tone}>{job.status.toLowerCase()}</Badge>} />
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Queued for</dt>
                <dd className="text-foreground">
                  {job.runAfter.toISOString().replace("T", " ").slice(0, 19)} UTC
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Started</dt>
                <dd className="text-foreground">
                  {job.startedAt === null ? "Not yet" : relative(job.startedAt, now)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Finished</dt>
                <dd className="text-foreground">
                  {job.completedAt === null ? "Not yet" : relative(job.completedAt, now)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Lease</dt>
                <dd className="text-foreground">
                  {job.lockedBy === null
                    ? "Not held"
                    : `Held by ${job.lockedBy}${
                        job.lockedUntil === null ? "" : ` until ${relative(job.lockedUntil, now)}`
                      }`}
                </dd>
              </div>
            </dl>

            {job.summary !== null && (
              <p className="mt-3 rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground">
                {job.summary}
              </p>
            )}

            {job.error !== null && (
              <div className="mt-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
                <p className="text-xs font-medium text-danger">
                  {job.errorCategory ?? "Failure"}
                </p>
                <p className="mt-1 text-sm text-foreground">{job.error}</p>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {job.status === "FAILED" && <RetryJobButton jobId={job.id} />}
              {(job.status === "PENDING" || job.status === "RUNNING") && (
                <CancelJobButton jobId={job.id} />
              )}
              <span className="text-xs text-subtle-foreground">
                {job.status === "FAILED"
                  ? "Retrying resets the attempt counter and requeues the job."
                  : job.status === "PENDING" || job.status === "RUNNING"
                    ? "Cancelling is final for this job. The run it belongs to closes as soon as its other jobs finish."
                    : "A finished job is a record of what happened and cannot be changed."}
              </span>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Identifiers"
            description="The opaque ids carried by this job. Nothing here names a person or a credential."
          />
          <CardBody>
            <dl className="space-y-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <dt className="text-xs text-muted-foreground">Job</dt>
                <dd className="font-mono text-xs text-subtle-foreground">{job.id}</dd>
              </div>
              {job.discoveryRunId !== null && (
                <div className="flex flex-wrap items-baseline gap-2">
                  <dt className="text-xs text-muted-foreground">Discovery run</dt>
                  <dd>
                    <Link
                      href={`/automation/runs/${job.discoveryRunId}`}
                      className="font-mono text-xs text-foreground underline-offset-2 hover:underline"
                    >
                      {job.discoveryRunId}
                    </Link>
                  </dd>
                </div>
              )}
            </dl>
          </CardBody>
        </Card>
      </PageSections>
    </>
  );
}
