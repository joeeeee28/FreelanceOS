import Link from "next/link";

import { requireUser } from "@/lib/auth/require-user";
import { getAutomationOverview, getWorkerLiveness } from "@/lib/discovery/automation";
import { SUPPORTED_ASPECTS } from "@/lib/research/aspects";
import { researchCoverage } from "@/lib/research/freshness";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui/primitives";
import { PageHeader, PageSections } from "@/components/ui/page";
import {
  FailuresPanel,
  QueuePanel,
  ResearchPanel,
  RunPanel,
  SchedulePanel,
  SourcesPanel,
  relative,
} from "@/components/crm/automation-panels";
import { RunDiscoveryNow } from "@/components/crm/automation-controls";

export const dynamic = "force-dynamic";

/**
 * Automation operations.
 *
 * The page answers one question: is the engine running, and if not, why not.
 * Everything on it is read from stored rows — see `@/lib/discovery/automation`
 * for the query behind each figure — and the schedule shown is the decision the
 * worker itself would make, computed with the same function.
 *
 * It is deliberately honest about absence: no worker, no runs and no sources
 * each say so in words rather than rendering zeroes that look like results.
 */
export default async function AutomationPage() {
  const now = new Date();
  const { workspaceId, workspace } = await requireUser();

  const [overview, worker] = await Promise.all([
    getAutomationOverview(workspaceId, {
      timezone: workspace.timezone || "UTC",
      now,
    }),
    getWorkerLiveness(now),
  ]);

  return (
    <>
      <PageHeader
        title="Automation"
        description="What discovery is doing, what it last did, and what is waiting. Every figure here is read from a stored row."
      />

      <PageSections>
        <QueuePanel queue={overview.queue} worker={worker} now={now} />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <RunDiscoveryNow />
          <p className="text-xs text-subtle-foreground">
            Scheduling lives in the worker process. The web app never runs background
            work on a request.
          </p>
        </div>

        <RunPanel
          title="Current run"
          description="The cycle in flight, with the counters it has recorded so far."
          run={overview.currentRun}
          now={now}
        />

        <RunPanel
          title="Last run"
          description="The most recent cycle, whether it finished or not."
          run={overview.lastRun}
          now={now}
        />

        <SchedulePanel overview={overview} now={now} />

        <ResearchPanel
          research={overview.research}
          coverage={researchCoverage(SUPPORTED_ASPECTS).surface}
        />

        <FailuresPanel failures={overview.recentFailures} now={now} />

        <SourcesPanel overview={overview} now={now} />

        <Card>
          <CardHeader
            title="Run history"
            description="Recent cycles. Open one to see its jobs, counters and failures."
          />
          <CardBody>
            {overview.recentRuns.length === 0 ? (
              <EmptyState
                title="No runs yet"
                description="No discovery cycle has been recorded for this workspace."
              />
            ) : (
              <ul className="divide-y divide-border">
                {overview.recentRuns.map((run) => (
                  <li key={run.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <Link
                        href={`/automation/runs/${run.id}`}
                        className="text-sm font-medium text-foreground underline-offset-2 hover:underline"
                      >
                        {run.status === "RUNNING" ? "Running" : run.status.toLowerCase()} run
                      </Link>
                      <span className="ml-2 text-xs text-subtle-foreground">
                        {relative(run.startedAt, now)} · {run.trigger.toLowerCase()} ·{" "}
                        {run.jobs.succeeded} done
                        {run.jobs.failed > 0 && `, ${run.jobs.failed} failed`}
                      </span>
                    </div>
                    <span className="tabular text-xs text-subtle-foreground">
                      {run.counters.pagesSucceeded} pages · {run.counters.companiesDiscovered}{" "}
                      companies · {run.counters.signalsDiscovered} signals ·{" "}
                      {run.counters.opportunitiesDiscovered} opportunities
                    </span>
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
