import Link from "next/link";
import type { LeadStatus } from "@prisma/client";

import {
  listLeadFacets,
  listLeads,
  parseLeadSort,
  DEFAULT_LEAD_SORT,
} from "@/lib/crm/leads";
import { ALL_LEAD_STATUSES } from "@/lib/crm/pipeline";
import { getWorkspaceTimeFormatters } from "@/lib/time/workspace-time";
import { relativeLabel } from "@/lib/time/relative";
import { isOverdue } from "@/lib/time/zoned";
import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  cn,
} from "@/components/ui/primitives";
import {
  Icon,
  ScorePill,
  StatusBadge,
  humanise,
} from "@/components/ui/domain";
import { PageHeader } from "@/components/ui/page";
import { FilterBar, FilterInput, FilterSelect } from "@/components/crm/filter-bar";
import { Pagination } from "@/components/crm/pagination";

/** Parses a query value into a known LeadStatus, ignoring anything else. */
function parseStatus(value?: string): LeadStatus | undefined {
  return value && (ALL_LEAD_STATUSES as string[]).includes(value)
    ? (value as LeadStatus)
    : undefined;
}

function parseNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const SORT_OPTIONS = [
  { value: "score", label: "Highest score" },
  { value: "recent", label: "Recently updated" },
  { value: "oldest", label: "Oldest first" },
  { value: "company", label: "Company A–Z" },
];

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const now = new Date();
  const params = await searchParams;

  const archiveMode = params.archived ?? "active";
  const sort = parseLeadSort(params.sort);

  const filters = {
    search: params.q,
    status: parseStatus(params.status),
    source: params.source || undefined,
    industry: params.industry || undefined,
    serviceInterest: params.service || undefined,
    minScore: parseNumber(params.minScore),
    sort,
    page: parseNumber(params.page),
    pageSize: parseNumber(params.pageSize),
    onlyArchived: archiveMode === "only",
    includeArchived: archiveMode === "all",
  };

  const [result, facets, { formatDate }] = await Promise.all([
    listLeads(filters),
    listLeadFacets(),
    getWorkspaceTimeFormatters(),
  ]);

  const hasFilters = Boolean(
    params.q ||
      params.status ||
      params.source ||
      params.industry ||
      params.service ||
      params.minScore ||
      (params.archived && params.archived !== "active") ||
      (params.sort && params.sort !== DEFAULT_LEAD_SORT),
  );

  /** Builds a querystring that preserves the current filters. */
  const linkTo = (overrides: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();

    const merged = {
      q: params.q,
      status: params.status,
      source: params.source,
      industry: params.industry,
      service: params.service,
      minScore: params.minScore,
      archived: params.archived,
      sort: params.sort,
      pageSize: params.pageSize,
      page: params.page,
      ...overrides,
    };

    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== "") next.set(key, String(value));
    }

    const query = next.toString();
    return query ? `/leads?${query}` : "/leads";
  };

  const columnClass = "px-3 py-2.5 text-left align-middle";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Leads"
        description={
          result.total === 0
            ? "Companies you could be earning revenue from."
            : `${result.total} lead${result.total === 1 ? "" : "s"}${
                hasFilters ? " matching your filters" : ""
              }, highest opportunity first.`
        }
        actions={
          <LinkButton href="/leads/new" variant="primary">
            <Icon name="plus" size={14} />
            Add Lead
          </LinkButton>
        }
      />

      <FilterBar active={hasFilters} clearHref="/leads">
        <FilterInput
          label="Search"
          name="q"
          type="search"
          defaultValue={params.q}
          placeholder="Company, contact, email, website"
          className="sm:col-span-2"
        />

        <FilterSelect
          label="Stage"
          name="status"
          defaultValue={params.status}
          placeholder="All stages"
          options={ALL_LEAD_STATUSES.map((status) => ({
            value: status,
            label: humanise(status),
          }))}
        />

        <FilterSelect
          label="Source"
          name="source"
          defaultValue={params.source}
          placeholder={
            facets.sources.length === 0 ? "None recorded" : "All sources"
          }
          options={facets.sources.map((value) => ({ value, label: value }))}
        />

        <FilterSelect
          label="Industry"
          name="industry"
          defaultValue={params.industry}
          placeholder={
            facets.industries.length === 0 ? "None recorded" : "All industries"
          }
          options={facets.industries.map((value) => ({ value, label: value }))}
        />

        <FilterSelect
          label="Service interest"
          name="service"
          defaultValue={params.service}
          placeholder={
            facets.serviceInterests.length === 0
              ? "None recorded"
              : "All services"
          }
          options={facets.serviceInterests.map((value) => ({
            value,
            label: value,
          }))}
        />

        <FilterInput
          label="Min score"
          name="minScore"
          type="number"
          min={0}
          max={100}
          defaultValue={params.minScore}
          placeholder="0"
        />

        <FilterSelect
          label="Sort by"
          name="sort"
          defaultValue={sort}
          options={SORT_OPTIONS}
        />

        <FilterSelect
          label="Archived"
          name="archived"
          defaultValue={archiveMode}
          options={[
            { value: "active", label: "Active only" },
            { value: "all", label: "Include archived" },
            { value: "only", label: "Archived only" },
          ]}
        />
      </FilterBar>

      {result.items.length === 0 ? (
        <EmptyState
          icon={<Icon name="leads" />}
          title={hasFilters ? "No leads match these filters" : "No leads yet"}
          description={
            hasFilters
              ? "Try a broader search, a different stage, or a lower minimum score."
              : "Add the first company you want to win work from. Scores, follow-ups and daily revenue actions all build from here."
          }
          action={
            hasFilters ? (
              <LinkButton href="/leads" variant="secondary" size="sm">
                Clear filters
              </LinkButton>
            ) : (
              <LinkButton href="/leads/new" variant="primary" size="sm">
                <Icon name="plus" size={14} />
                Add your first lead
              </LinkButton>
            )
          }
        />
      ) : (
        <>
          {/* Dense table on wide screens. */}
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[60rem] text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-muted text-2xs uppercase tracking-wide text-subtle-foreground">
                    <th scope="col" className={columnClass}>Company</th>
                    <th scope="col" className={columnClass}>Contact</th>
                    <th scope="col" className={columnClass}>Service opportunity</th>
                    <th scope="col" className={columnClass}>Stage</th>
                    <th scope="col" className={columnClass}>Score</th>
                    <th scope="col" className={columnClass}>Decision maker</th>
                    <th scope="col" className={columnClass}>Last activity</th>
                    <th scope="col" className={columnClass}>Next action</th>
                  </tr>
                </thead>

                <tbody>
                  {result.items.map((lead) => {
                    const followUp = lead.followUps[0];
                    const activity = lead.activities[0];
                    const decisionMaker = lead.contacts[0];
                    const overdue = followUp
                      ? isOverdue(followUp.scheduledAt, now)
                      : false;

                    return (
                      <tr
                        key={lead.id}
                        className="border-b border-border last:border-0 hover:bg-muted/40"
                      >
                        <td className={columnClass}>
                          <Link
                            href={`/leads/${lead.id}`}
                            className="font-medium text-foreground hover:text-accent"
                          >
                            {lead.companyName}
                          </Link>

                          <p className="mt-0.5 flex items-center gap-1.5 text-2xs text-subtle-foreground">
                            {lead.industry ?? "Industry unknown"}
                            {lead.deletedAt ? (
                              <Badge tone="neutral">Archived</Badge>
                            ) : null}
                          </p>
                        </td>

                        <td className={columnClass}>
                          {lead.contactName ? (
                            <span className="text-foreground">{lead.contactName}</span>
                          ) : (
                            <span className="text-subtle-foreground">Unknown</span>
                          )}
                          <p className="mt-0.5 text-2xs text-subtle-foreground">
                            {lead._count.contacts}{" "}
                            {lead._count.contacts === 1 ? "contact" : "contacts"}
                          </p>
                        </td>

                        <td className={cn(columnClass, "max-w-[14rem]")}>
                          {lead.serviceInterest ? (
                            <span className="text-foreground">
                              {lead.serviceInterest}
                            </span>
                          ) : (
                            <span className="text-subtle-foreground">
                              Not identified
                            </span>
                          )}
                        </td>

                        <td className={columnClass}>
                          <StatusBadge status={lead.status} />
                        </td>

                        <td className={columnClass}>
                          <ScorePill score={lead.score} />
                        </td>

                        <td className={columnClass}>
                          {decisionMaker ? (
                            <>
                              <span className="text-foreground">
                                {decisionMaker.fullName}
                              </span>
                              {decisionMaker.jobTitle ? (
                                <p className="mt-0.5 text-2xs text-subtle-foreground">
                                  {decisionMaker.jobTitle}
                                </p>
                              ) : null}
                            </>
                          ) : lead.decisionMakerIdentified ? (
                            <span className="text-muted-foreground">
                              Identified
                            </span>
                          ) : (
                            <span className="text-subtle-foreground">
                              Not identified
                            </span>
                          )}
                        </td>

                        <td className={columnClass}>
                          {activity ? (
                            <>
                              <span
                                className="text-foreground"
                                title={activity.title}
                              >
                                {relativeLabel(activity.createdAt, now)}
                              </span>
                              <p className="mt-0.5 max-w-[10rem] truncate text-2xs text-subtle-foreground">
                                {humanise(activity.type)}
                              </p>
                            </>
                          ) : (
                            <span className="text-subtle-foreground">None</span>
                          )}
                        </td>

                        <td className={columnClass}>
                          {followUp ? (
                            <>
                              <span
                                className={cn(
                                  "font-medium",
                                  overdue ? "text-danger" : "text-foreground",
                                )}
                              >
                                {overdue ? "Overdue" : formatDate(followUp.scheduledAt)}
                              </span>
                              <p className="mt-0.5 text-2xs text-subtle-foreground">
                                {humanise(followUp.channel)}
                              </p>
                            </>
                          ) : (
                            <Link
                              href={`/leads/${lead.id}`}
                              className="text-2xs font-medium text-accent hover:underline"
                            >
                              Schedule follow-up
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Cards below the table breakpoint. */}
          <div className="space-y-2.5 md:hidden">
            {result.items.map((lead) => {
              const followUp = lead.followUps[0];
              const overdue = followUp
                ? isOverdue(followUp.scheduledAt, now)
                : false;

              return (
                <Link
                  key={lead.id}
                  href={`/leads/${lead.id}`}
                  className="block rounded-xl border border-border bg-surface p-4 shadow-xs transition-colors hover:border-border-strong"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{lead.companyName}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {lead.contactName ?? "No contact recorded"}
                      </p>
                    </div>
                    <ScorePill score={lead.score} />
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={lead.status} />
                    {lead.deletedAt ? <Badge tone="neutral">Archived</Badge> : null}
                    {followUp ? (
                      <Badge tone={overdue ? "danger" : "info"}>
                        {overdue
                          ? "Follow-up overdue"
                          : `Follow-up ${formatDate(followUp.scheduledAt)}`}
                      </Badge>
                    ) : null}
                  </div>

                  {lead.serviceInterest ? (
                    <p className="mt-2.5 text-xs text-muted-foreground">
                      {lead.serviceInterest}
                    </p>
                  ) : null}
                </Link>
              );
            })}
          </div>

          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            totalPages={result.totalPages}
            linkTo={linkTo}
            noun="lead"
          />
        </>
      )}
    </div>
  );
}
