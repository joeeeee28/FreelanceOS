import Link from "next/link";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { PIPELINE_STAGES, STATUS_STAGE, nextStatuses } from "@/lib/crm/pipeline";
import { StatusControl } from "@/components/crm/lead-detail-panels";
import { formatInZone, isOverdue } from "@/lib/time/zoned";
import { EmptyState, LinkButton, cn } from "@/components/ui/primitives";
import { Icon, ScorePill, StatusBadge, humanise } from "@/components/ui/domain";
import { PageHeader } from "@/components/ui/page";

/** Columns that mean the deal is closed, styled apart from live work. */
const CLOSED_STAGES = new Set(["WON", "LOST"]);

export default async function PipelinePage() {
  const now = new Date();
  const { workspaceId, workspace } = await requireUser();

  // Archived leads are excluded; the board is scoped to the caller's
  // workspace and joins only the single next scheduled follow-up per lead.
  const leads = await db.lead.findMany({
    where: { workspaceId, deletedAt: null },
    include: {
      followUps: {
        where: { status: "SCHEDULED" },
        orderBy: { scheduledAt: "asc" },
        take: 1,
      },
      contacts: {
        where: { isPrimary: true },
        select: { fullName: true, jobTitle: true },
        take: 1,
      },
    },
    orderBy: [{ score: "desc" }, { updatedAt: "desc" }],
  });

  const byStage = new Map(PIPELINE_STAGES.map((stage) => [stage, [] as typeof leads]));

  for (const lead of leads) {
    byStage.get(STATUS_STAGE[lead.status])!.push(lead);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pipeline"
        description={
          leads.length === 0
            ? "Every active lead, arranged by the stage it has reached."
            : `${leads.length} active lead${leads.length === 1 ? "" : "s"} across ${PIPELINE_STAGES.length} stages. Move a lead with the control on its card.`
        }
        actions={
          <>
            <LinkButton href="/leads" variant="secondary">
              Table view
            </LinkButton>
            <LinkButton href="/leads/new" variant="primary">
              <Icon name="plus" size={14} />
              Add Lead
            </LinkButton>
          </>
        }
      />

      {leads.length === 0 ? (
        <EmptyState
          icon={<Icon name="pipeline" />}
          title="Your pipeline is empty"
          description="Add a lead and it will appear here. As you qualify, contact and negotiate, the card moves across the board through validated stage transitions."
          action={
            <LinkButton href="/leads/new" variant="primary" size="sm">
              <Icon name="plus" size={14} />
              Add your first lead
            </LinkButton>
          }
        />
      ) : (
        <div className="no-scrollbar -mx-4 flex gap-4 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0">
          {PIPELINE_STAGES.map((stage) => {
            const items = byStage.get(stage)!;
            const closed = CLOSED_STAGES.has(stage);

            // Column-level intelligence that is real: how many, and the best
            // score in the column. No monetary value exists to total.
            const topScore = items.reduce(
              (best, lead) => Math.max(best, lead.score),
              0,
            );

            return (
              <section
                key={stage}
                aria-label={`${humanise(stage)} stage`}
                className="flex w-[19rem] shrink-0 flex-col rounded-xl border border-border bg-surface-muted"
              >
                <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                  <div className="min-w-0">
                    <h2
                      className={cn(
                        "truncate text-xs font-semibold uppercase tracking-wide",
                        closed ? "text-subtle-foreground" : "text-foreground",
                      )}
                    >
                      {humanise(stage)}
                    </h2>
                    <p className="mt-0.5 text-2xs text-subtle-foreground">
                      {items.length === 0
                        ? "Empty"
                        : `Top score ${topScore}`}
                    </p>
                  </div>

                  <span className="tabular shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground ring-1 ring-inset ring-border">
                    {items.length}
                  </span>
                </header>

                <div className="flex-1 space-y-2.5 p-2.5">
                  {items.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-2xs text-subtle-foreground">
                      No leads at this stage
                    </p>
                  ) : (
                    items.map((lead) => {
                      const followUp = lead.followUps[0];
                      const overdue = followUp
                        ? isOverdue(followUp.scheduledAt, now)
                        : false;
                      const contact = lead.contacts[0];

                      return (
                        <article
                          key={lead.id}
                          className="rounded-lg border border-border bg-surface p-3 shadow-xs"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <Link
                              href={`/leads/${lead.id}`}
                              className="min-w-0 text-sm font-medium leading-snug text-foreground hover:text-accent"
                            >
                              {lead.companyName}
                            </Link>
                            <ScorePill score={lead.score} compact />
                          </div>

                          {/* Grouped statuses keep their real label. */}
                          {lead.status !== stage ? (
                            <div className="mt-1.5">
                              <StatusBadge status={lead.status} />
                            </div>
                          ) : null}

                          {lead.serviceInterest ? (
                            <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                              {lead.serviceInterest}
                            </p>
                          ) : null}

                          <dl className="mt-2.5 space-y-1 text-2xs">
                            <div className="flex gap-1.5">
                              <dt className="text-subtle-foreground">Contact</dt>
                              <dd className="min-w-0 truncate text-muted-foreground">
                                {contact?.fullName ??
                                  lead.contactName ?? (
                                    <span className="text-subtle-foreground">
                                      Unknown
                                    </span>
                                  )}
                                {contact?.jobTitle ? ` · ${contact.jobTitle}` : ""}
                              </dd>
                            </div>

                            <div className="flex gap-1.5">
                              <dt className="text-subtle-foreground">Next</dt>
                              <dd
                                className={cn(
                                  "min-w-0 truncate",
                                  overdue
                                    ? "font-medium text-danger"
                                    : "text-muted-foreground",
                                )}
                              >
                                {followUp ? (
                                  <>
                                    {overdue ? "Overdue · " : ""}
                                    {humanise(followUp.channel)}{" "}
                                    {formatInZone(
                                      followUp.scheduledAt,
                                      workspace.timezone,
                                    )}
                                  </>
                                ) : (
                                  <span className="text-subtle-foreground">
                                    Nothing scheduled
                                  </span>
                                )}
                              </dd>
                            </div>
                          </dl>

                          <div className="mt-3 border-t border-border pt-2.5">
                            <StatusControl
                              leadId={lead.id}
                              current={lead.status}
                              allowed={[...nextStatuses(lead.status)]}
                              compact
                            />
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
