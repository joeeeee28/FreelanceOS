import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { Card, CardBody, EmptyState, LinkButton } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/domain";
import { PageHeader } from "@/components/ui/page";
import { ActivityTimeline } from "@/components/crm/activity-timeline";

/** How many entries the feed shows. Matches the previous behaviour. */
const FEED_LIMIT = 100;

export default async function ActivitiesPage() {
  const now = new Date();
  const { workspaceId, workspace } = await requireUser();

  const activities = await db.activity.findMany({
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
    take: FEED_LIMIT,
  });

  return (
    <>
      <PageHeader
        title="Activity"
        description={
          activities.length === 0
            ? "A chronological record of everything that happens in your workspace."
            : `The ${activities.length === FEED_LIMIT ? `${FEED_LIMIT} most recent` : activities.length} ${
                activities.length === 1 ? "entry" : "entries"
              } across every lead, contact, task and follow-up.`
        }
      />

      <Card>
        <CardBody>
          {activities.length === 0 ? (
            <EmptyState
              icon={<Icon name="clock" />}
              title="No activity yet"
              description="Every lead created, note added, status change, follow-up and completed task is logged here automatically. Nothing is recorded until you start working a lead."
              action={
                <LinkButton href="/leads/new" variant="primary" size="sm">
                  <Icon name="plus" size={14} />
                  Add your first lead
                </LinkButton>
              }
            />
          ) : (
            <ActivityTimeline
              entries={activities.map((entry) => ({
                id: entry.id,
                type: entry.type,
                title: entry.title,
                description: entry.description,
                createdAt: entry.createdAt,
                leadId: entry.leadId,
                leadName: entry.lead?.companyName ?? null,
                contactName: entry.contact?.fullName ?? null,
              }))}
              timezone={workspace.timezone}
              now={now}
            />
          )}
        </CardBody>
      </Card>
    </>
  );
}
