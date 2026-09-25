import Link from "next/link";
import type {
  FollowUpChannel,
  FollowUpSequence,
  FollowUpStatus,
} from "@prisma/client";

import { listFollowUps } from "@/lib/crm/follow-ups";
import { getWorkspaceTimeFormatters } from "@/lib/time/workspace-time";
import { relativeLabel } from "@/lib/time/relative";
import { isOverdue, isTodayInZone, zonedInputValue } from "@/lib/time/zoned";
import { InlineAction } from "@/components/crm/lead-detail-panels";
import { RescheduleControl } from "@/components/crm/reschedule-control";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  LinkButton,
  cn,
} from "@/components/ui/primitives";
import { Icon, humanise } from "@/components/ui/domain";
import { PageHeader } from "@/components/ui/page";
import { FilterBar, FilterSelect } from "@/components/crm/filter-bar";
import { Pagination } from "@/components/crm/pagination";

const STATUSES: FollowUpStatus[] = ["SCHEDULED", "COMPLETED", "CANCELLED"];

const CHANNELS: FollowUpChannel[] = [
  "EMAIL",
  "LINKEDIN",
  "INSTAGRAM",
  "FACEBOOK",
  "WHATSAPP",
  "PHONE",
  "UPWORK",
  "FIVERR",
  "CONTRA",
  "COLD_EMAIL",
  "REFERRAL",
  "OTHER",
];

const SEQUENCES: FollowUpSequence[] = ["INITIAL", "FU1", "FU2", "FU3", "NURTURE"];

export default async function FollowUpsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const now = new Date();
  const params = await searchParams;

  const result = await listFollowUps({
    status: STATUSES.includes(params.status as FollowUpStatus)
      ? (params.status as FollowUpStatus)
      : undefined,
    channel: CHANNELS.includes(params.channel as FollowUpChannel)
      ? (params.channel as FollowUpChannel)
      : undefined,
    sequence: SEQUENCES.includes(params.sequence as FollowUpSequence)
      ? (params.sequence as FollowUpSequence)
      : undefined,
    due: (["overdue", "today", "upcoming"] as const).includes(
      params.due as "overdue" | "today" | "upcoming",
    )
      ? (params.due as "overdue" | "today" | "upcoming")
      : undefined,
    page: Number(params.page) || 1,
  });

  const { formatDateTime, timeZone } = await getWorkspaceTimeFormatters();

  const hasFilters = Boolean(
    params.status || params.channel || params.sequence || params.due,
  );

  const linkTo = (overrides: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, ...overrides })) {
      if (value !== undefined && value !== "") next.set(key, String(value));
    }
    const qs = next.toString();
    return qs ? `/follow-ups?${qs}` : "/follow-ups";
  };

  type Row = (typeof result.items)[number];

  /**
   * Groups the current page into Overdue / Due today / Upcoming / Completed.
   *
   * Grouping is presentation only — the rows are exactly what the server
   * returned for the active filters and page.
   */
  const groups: Array<{
    id: string;
    title: string;
    description: string;
    tone: "danger" | "warning" | "neutral";
    rows: Row[];
  }> = [
    {
      id: "overdue",
      title: "Overdue",
      description: "Past their scheduled time and still not sent.",
      tone: "danger",
      rows: [],
    },
    {
      id: "today",
      title: "Due today",
      description: "Scheduled for today in your workspace timezone.",
      tone: "warning",
      rows: [],
    },
    {
      id: "upcoming",
      title: "Upcoming",
      description: "Planned for a future date.",
      tone: "neutral",
      rows: [],
    },
    {
      id: "closed",
      title: "Completed and cancelled",
      description: "A record of outreach already dealt with.",
      tone: "neutral",
      rows: [],
    },
  ];

  const byId = Object.fromEntries(groups.map((group) => [group.id, group]));

  for (const row of result.items) {
    if (row.status !== "SCHEDULED") {
      byId.closed.rows.push(row);
    } else if (isOverdue(row.scheduledAt, now)) {
      byId.overdue.rows.push(row);
    } else if (isTodayInZone(row.scheduledAt, timeZone, now)) {
      byId.today.rows.push(row);
    } else {
      byId.upcoming.rows.push(row);
    }
  }

  const visibleGroups = groups.filter((group) => group.rows.length > 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Follow-ups"
        description={
          result.total === 0
            ? "Planned outreach, grouped by when it is due."
            : `${result.total} follow-up${result.total === 1 ? "" : "s"}${
                hasFilters ? " matching your filters" : ""
              }, grouped by when they are due.`
        }
        actions={
          <LinkButton href="/leads" variant="secondary">
            <Icon name="leads" size={14} />
            Schedule from a lead
          </LinkButton>
        }
      />

      <FilterBar active={hasFilters} clearHref="/follow-ups">
        <FilterSelect
          label="Status"
          name="status"
          defaultValue={params.status}
          placeholder="Any status"
          options={STATUSES.map((value) => ({ value, label: humanise(value) }))}
        />

        <FilterSelect
          label="Due"
          name="due"
          defaultValue={params.due}
          placeholder="Any time"
          options={[
            { value: "overdue", label: "Overdue" },
            { value: "today", label: "Today" },
            { value: "upcoming", label: "Upcoming" },
          ]}
        />

        <FilterSelect
          label="Channel"
          name="channel"
          defaultValue={params.channel}
          placeholder="Any channel"
          options={CHANNELS.map((value) => ({ value, label: humanise(value) }))}
        />

        <FilterSelect
          label="Sequence"
          name="sequence"
          defaultValue={params.sequence}
          placeholder="Any step"
          options={SEQUENCES.map((value) => ({ value, label: value }))}
        />
      </FilterBar>

      {result.items.length === 0 ? (
        <EmptyState
          icon={<Icon name="followups" />}
          title={
            hasFilters ? "No follow-ups match these filters" : "No follow-ups yet"
          }
          description={
            hasFilters
              ? "Try a different channel, sequence step or due window."
              : "Follow-ups are scheduled from a lead's page. Once scheduled, anything due or overdue is promoted into your daily revenue actions."
          }
          action={
            hasFilters ? (
              <LinkButton href="/follow-ups" variant="secondary" size="sm">
                Clear filters
              </LinkButton>
            ) : (
              <LinkButton href="/leads" variant="primary" size="sm">
                Go to leads
              </LinkButton>
            )
          }
        />
      ) : (
        <div className="space-y-5">
          {visibleGroups.map((group) => (
            <Card key={group.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    {group.title}
                    <Badge
                      tone={
                        group.tone === "danger"
                          ? "danger"
                          : group.tone === "warning"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {group.rows.length}
                    </Badge>
                  </span>
                }
                description={group.description}
              />

              <div className="divide-y divide-border">
                {group.rows.map((followUp) => {
                  const overdue =
                    followUp.status === "SCHEDULED" &&
                    isOverdue(followUp.scheduledAt, now);

                  return (
                    <div
                      key={followUp.id}
                      className="flex flex-wrap items-start justify-between gap-3 p-4"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {followUp.lead ? (
                            <Link
                              href={`/leads/${followUp.lead.id}?tab=follow-ups`}
                              className="text-sm font-medium text-foreground hover:text-accent"
                            >
                              {followUp.lead.companyName}
                            </Link>
                          ) : (
                            <span className="text-sm font-medium">
                              Unlinked follow-up
                            </span>
                          )}

                          <Badge tone="neutral">{humanise(followUp.channel)}</Badge>
                          <Badge tone="neutral">{followUp.sequence}</Badge>
                          <Badge
                            tone={
                              followUp.status === "COMPLETED"
                                ? "success"
                                : followUp.status === "CANCELLED"
                                  ? "neutral"
                                  : "info"
                            }
                          >
                            {humanise(followUp.status)}
                          </Badge>
                        </div>

                        <p className="mt-1 text-xs text-muted-foreground">
                          {followUp.contact ? (
                            <>
                              {followUp.contact.fullName}
                              <span aria-hidden> · </span>
                            </>
                          ) : (
                            <>
                              <span className="text-subtle-foreground">
                                No specific contact
                              </span>
                              <span aria-hidden> · </span>
                            </>
                          )}
                          <span
                            className={cn(
                              overdue && "font-medium text-danger",
                            )}
                          >
                            {overdue ? "Overdue " : ""}
                            {relativeLabel(followUp.scheduledAt, now)}
                          </span>
                          <span className="text-subtle-foreground">
                            {" "}
                            · {formatDateTime(followUp.scheduledAt)}
                          </span>
                        </p>

                        {followUp.message ? (
                          <p className="mt-2 whitespace-pre-line rounded-md border border-border bg-surface-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                            {followUp.message}
                          </p>
                        ) : (
                          <p className="mt-1.5 text-xs text-subtle-foreground">
                            No message drafted
                          </p>
                        )}

                        {followUp.completedAt ? (
                          <p className="mt-1.5 text-2xs text-subtle-foreground">
                            Completed {formatDateTime(followUp.completedAt)}
                          </p>
                        ) : null}
                      </div>

                      {followUp.status === "SCHEDULED" ? (
                        <div className="flex flex-wrap items-start gap-2">
                          <InlineAction
                            id={followUp.id}
                            kind="completeFollowUp"
                            label="Complete"
                          />
                          <RescheduleControl
                            followUpId={followUp.id}
                            defaultValue={zonedInputValue(
                              followUp.scheduledAt,
                              timeZone,
                            )}
                          />
                          <InlineAction
                            id={followUp.id}
                            kind="cancelFollowUp"
                            label="Cancel"
                            variant="danger"
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}

          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            totalPages={result.totalPages}
            linkTo={linkTo}
            noun="follow-up"
          />
        </div>
      )}
    </div>
  );
}
