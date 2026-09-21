import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { getDashboard } from "@/lib/crm/dashboard";
import { formatInZone } from "@/lib/time/zoned";
import { Card, CardBody, CardHeader, EmptyState, LinkButton } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/domain";
import { PageHeader, PageSections } from "@/components/ui/page";
import { KpiTile } from "@/components/crm/kpi-tile";
import { ActionCard, actionKey } from "@/components/crm/action-card";
import { PipelineSnapshot } from "@/components/crm/pipeline-snapshot";
import { RevenueFunnel } from "@/components/crm/revenue-funnel";
import { ActivityTimeline } from "@/components/crm/activity-timeline";

/** Time-of-day greeting in the workspace's own timezone, not the server's. */
function greeting(timezone: string, now: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );

  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage() {
  const now = new Date();

  const [{ user, workspaceId }, data] = await Promise.all([
    requireUser(),
    getDashboard(),
  ]);

  // The recent-activity feed reuses the existing Activity table. Ten rows is
  // enough for a dashboard; the full history lives on /activities.
  const recentActivity = await db.activity.findMany({
    where: { workspaceId },
    select: {
      id: true,
      type: true,
      title: true,
      description: true,
      createdAt: true,
      leadId: true,
      lead: { select: { companyName: true } },
      contact: { select: { fullName: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const { metrics } = data;
  const firstName = (user.name ?? user.email.split("@")[0]).split(/\s+/)[0];
  const isEmptyWorkspace = metrics.totalLeads === 0;

  return (
    <PageSections>
      <PageHeader
        title={`${greeting(data.timezone, now)}, ${firstName}`}
        description="Here is what needs your attention today."
        meta={
          <p className="text-xs text-subtle-foreground">
            {formatInZone(now, data.timezone, { dateStyle: "full" })} ·{" "}
            {data.timezone}
          </p>
        }
        actions={
          <LinkButton href="/leads/new" variant="primary">
            <Icon name="plus" size={14} />
            Add Lead
          </LinkButton>
        }
      />

      {/* ------------------------------------------------------------ KPIs */}
      <section aria-label="Key metrics">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <KpiTile
            label="Pipeline value"
            notTracked
            notTrackedHint="Deal values are not part of the data model yet."
          />
          <KpiTile
            label="Qualified leads"
            value={metrics.qualified}
            hint={`${metrics.active} active in pipeline`}
            href="/leads?status=QUALIFIED"
            tone={metrics.qualified > 0 ? "accent" : "neutral"}
          />
          <KpiTile
            label="Follow-ups due"
            value={metrics.followUpsDue}
            hint={
              metrics.overdueFollowUps > 0
                ? `${metrics.overdueFollowUps} overdue`
                : "None overdue"
            }
            href="/follow-ups"
            tone={
              metrics.overdueFollowUps > 0
                ? "danger"
                : metrics.followUpsDue > 0
                  ? "warning"
                  : "neutral"
            }
          />
          <KpiTile
            label="Proposals"
            value={metrics.proposals}
            hint={`${metrics.negotiation} in negotiation`}
            href="/leads?status=PROPOSAL"
          />
          <KpiTile
            label="Revenue"
            notTracked
            notTrackedHint="Won deals are counted, not invoiced amounts."
          />
        </div>
      </section>

      {/* -------------------------------------------- today's revenue actions */}
      <section aria-labelledby="todays-actions">
        <Card>
          <CardHeader
            title={
              <span id="todays-actions" className="flex items-center gap-2">
                Today&rsquo;s revenue actions
                {data.actions.length > 0 ? (
                  <span className="tabular rounded-md bg-accent-subtle px-1.5 py-0.5 text-2xs font-semibold text-accent">
                    {data.actions.length}
                  </span>
                ) : null}
              </span>
            }
            description="Ranked by urgency and revenue impact, recalculated from your live records."
            action={
              <LinkButton href="/follow-ups" variant="ghost" size="sm">
                All follow-ups
                <Icon name="chevronRight" size={13} />
              </LinkButton>
            }
          />

          <CardBody className="space-y-2.5">
            {data.actions.length === 0 ? (
              <EmptyState
                icon={<Icon name="check" />}
                title={
                  isEmptyWorkspace
                    ? "No revenue actions yet"
                    : "You are all caught up"
                }
                description={
                  isEmptyWorkspace
                    ? "Add your first lead and this list will fill with the specific next steps most likely to win work."
                    : "No overdue follow-ups, no calls scheduled today, and no high-score leads waiting on first contact."
                }
                action={
                  isEmptyWorkspace ? (
                    <LinkButton href="/leads/new" variant="primary" size="sm">
                      <Icon name="plus" size={14} />
                      Add your first lead
                    </LinkButton>
                  ) : (
                    <LinkButton href="/pipeline" variant="secondary" size="sm">
                      Review the pipeline
                    </LinkButton>
                  )
                }
              />
            ) : (
              data.actions.map((action) => (
                <ActionCard
                  key={actionKey(action)}
                  action={action}
                  timezone={data.timezone}
                  now={now}
                />
              ))
            )}
          </CardBody>
        </Card>
      </section>

      {/* ----------------------------------------------- pipeline + funnel */}
      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader
            title="Pipeline snapshot"
            description="Lead count by stage. Select a stage to see those leads."
            action={
              <LinkButton href="/pipeline" variant="ghost" size="sm">
                Open board
                <Icon name="chevronRight" size={13} />
              </LinkButton>
            }
          />
          <CardBody>
            <PipelineSnapshot statusCounts={data.statusCounts} />

            <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-4">
              <div>
                <dt className="text-2xs uppercase tracking-wide text-subtle-foreground">
                  Total leads
                </dt>
                <dd className="tabular mt-0.5 text-lg font-semibold">
                  {metrics.totalLeads}
                </dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-wide text-subtle-foreground">
                  Average score
                </dt>
                <dd className="tabular mt-0.5 text-lg font-semibold">
                  {metrics.averageScore}
                </dd>
              </div>
              <div>
                <dt className="text-2xs uppercase tracking-wide text-subtle-foreground">
                  Top score
                </dt>
                <dd className="tabular mt-0.5 text-lg font-semibold">
                  {metrics.topScore}
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Conversion funnel"
            description="Leads that reached each stage."
          />
          <CardBody>
            {isEmptyWorkspace ? (
              <EmptyState
                compact
                icon={<Icon name="analytics" />}
                title="No funnel yet"
                description="Conversion rates appear once you have leads moving through the pipeline."
              />
            ) : (
              <RevenueFunnel statusCounts={data.statusCounts} />
            )}
          </CardBody>
        </Card>
      </div>

      {/* -------------------------------------------------- recent activity */}
      <Card>
        <CardHeader
          title="Recent activity"
          description="Everything logged across your workspace."
          action={
            <LinkButton href="/activities" variant="ghost" size="sm">
              View all
              <Icon name="chevronRight" size={13} />
            </LinkButton>
          }
        />
        <CardBody>
          {recentActivity.length === 0 ? (
            <EmptyState
              compact
              icon={<Icon name="clock" />}
              title="No activity yet"
              description="Creating leads, logging notes, sending follow-ups and completing tasks all appear here automatically."
            />
          ) : (
            <ActivityTimeline
              entries={recentActivity.map((entry) => ({
                id: entry.id,
                type: entry.type,
                title: entry.title,
                description: entry.description,
                createdAt: entry.createdAt,
                leadId: entry.leadId,
                leadName: entry.lead?.companyName ?? null,
                contactName: entry.contact?.fullName ?? null,
              }))}
              timezone={data.timezone}
              now={now}
            />
          )}
        </CardBody>
      </Card>
    </PageSections>
  );
}
