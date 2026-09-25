import Link from "next/link";

import { listContactCompanies, listContacts } from "@/lib/crm/contacts";
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
import { Avatar, Icon, humanise } from "@/components/ui/domain";
import { PageHeader } from "@/components/ui/page";
import { FilterBar, FilterInput, FilterSelect } from "@/components/crm/filter-bar";
import { Pagination } from "@/components/crm/pagination";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const now = new Date();
  const params = await searchParams;

  const decisionMakersOnly = params.decisionMakers === "1";

  const [result, companies, { formatDate }] = await Promise.all([
    listContacts({
      search: params.q,
      decisionMakersOnly,
      leadId: params.company || undefined,
      page: Number(params.page) || 1,
    }),
    listContactCompanies(),
    getWorkspaceTimeFormatters(),
  ]);

  const hasFilters = Boolean(params.q || params.company || decisionMakersOnly);

  const linkTo = (overrides: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, ...overrides })) {
      if (value !== undefined && value !== "") next.set(key, String(value));
    }
    const qs = next.toString();
    return qs ? `/contacts?${qs}` : "/contacts";
  };

  const columnClass = "px-3 py-2.5 text-left align-middle";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Contacts"
        description={
          result.total === 0
            ? "Every person you can reach at the companies in your pipeline."
            : `${result.total} contact${result.total === 1 ? "" : "s"}${
                hasFilters ? " matching your filters" : ""
              }. Primary contacts first.`
        }
        actions={
          <LinkButton href="/leads" variant="secondary">
            <Icon name="leads" size={14} />
            Go to leads
          </LinkButton>
        }
      />

      <FilterBar active={hasFilters} clearHref="/contacts">
        <FilterInput
          label="Search"
          name="q"
          type="search"
          defaultValue={params.q}
          placeholder="Name, email or job title"
          className="sm:col-span-2"
        />

        <FilterSelect
          label="Company"
          name="company"
          defaultValue={params.company}
          placeholder={
            companies.length === 0 ? "No companies yet" : "All companies"
          }
          options={companies.map((company) => ({
            value: company.id,
            label: company.companyName,
          }))}
        />

        <FilterSelect
          label="Decision maker"
          name="decisionMakers"
          defaultValue={decisionMakersOnly ? "1" : ""}
          placeholder="Everyone"
          options={[{ value: "1", label: "Decision makers only" }]}
        />
      </FilterBar>

      {result.items.length === 0 ? (
        <EmptyState
          icon={<Icon name="contacts" />}
          title={hasFilters ? "No contacts match these filters" : "No contacts yet"}
          description={
            hasFilters
              ? "Try a different company, clear the decision-maker filter, or broaden your search."
              : "Contacts are added from a lead's page, so every person stays tied to a real opportunity. Open a lead and use the Contacts tab."
          }
          action={
            hasFilters ? (
              <LinkButton href="/contacts" variant="secondary" size="sm">
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
        <>
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-muted text-2xs uppercase tracking-wide text-subtle-foreground">
                    <th scope="col" className={columnClass}>Name</th>
                    <th scope="col" className={columnClass}>Company</th>
                    <th scope="col" className={columnClass}>Role</th>
                    <th scope="col" className={columnClass}>Email</th>
                    <th scope="col" className={columnClass}>Phone</th>
                    <th scope="col" className={columnClass}>Decision maker</th>
                    <th scope="col" className={columnClass}>Last activity</th>
                    <th scope="col" className={columnClass}>Next action</th>
                  </tr>
                </thead>

                <tbody>
                  {result.items.map((contact) => {
                    const activity = contact.activities[0];
                    const followUp = contact.followUps[0];
                    const overdue = followUp
                      ? isOverdue(followUp.scheduledAt, now)
                      : false;

                    return (
                      <tr
                        key={contact.id}
                        className="border-b border-border last:border-0 hover:bg-muted/40"
                      >
                        <td className={columnClass}>
                          <span className="flex items-center gap-2.5">
                            <Avatar name={contact.fullName} size="sm" />
                            <span className="min-w-0">
                              <Link
                                href={`/leads/${contact.lead.id}?tab=contacts`}
                                className="font-medium text-foreground hover:text-accent"
                              >
                                {contact.fullName}
                              </Link>
                              {contact.isPrimary ? (
                                <span className="ml-1.5 align-middle">
                                  <Badge tone="accent" uppercase>
                                    Primary
                                  </Badge>
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </td>

                        <td className={columnClass}>
                          <Link
                            href={`/leads/${contact.lead.id}`}
                            className="text-muted-foreground hover:text-accent"
                          >
                            {contact.lead.companyName}
                          </Link>
                        </td>

                        <td className={columnClass}>
                          {contact.jobTitle ?? (
                            <span className="text-subtle-foreground">Unknown</span>
                          )}
                        </td>

                        <td className={columnClass}>
                          {contact.email ? (
                            <a
                              href={`mailto:${contact.email}`}
                              className="break-all text-accent hover:underline"
                            >
                              {contact.email}
                            </a>
                          ) : (
                            <span className="text-subtle-foreground">Unknown</span>
                          )}
                        </td>

                        <td className={columnClass}>
                          {contact.phone ? (
                            <a
                              href={`tel:${contact.phone}`}
                              className="text-accent hover:underline"
                            >
                              {contact.phone}
                            </a>
                          ) : (
                            <span className="text-subtle-foreground">Unknown</span>
                          )}
                        </td>

                        <td className={columnClass}>
                          {contact.isDecisionMaker ? (
                            <Badge tone="success">Yes</Badge>
                          ) : (
                            <span className="text-subtle-foreground">No</span>
                          )}
                        </td>

                        <td className={columnClass}>
                          {activity ? (
                            <>
                              <span className="text-foreground">
                                {relativeLabel(activity.createdAt, now)}
                              </span>
                              <p className="mt-0.5 text-2xs text-subtle-foreground">
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
                                {overdue
                                  ? "Overdue"
                                  : formatDate(followUp.scheduledAt)}
                              </span>
                              <p className="mt-0.5 text-2xs text-subtle-foreground">
                                {humanise(followUp.channel)}
                              </p>
                            </>
                          ) : (
                            <span className="text-subtle-foreground">
                              Nothing scheduled
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="space-y-2.5 md:hidden">
            {result.items.map((contact) => (
              <Link
                key={contact.id}
                href={`/leads/${contact.lead.id}?tab=contacts`}
                className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4 shadow-xs transition-colors hover:border-border-strong"
              >
                <Avatar name={contact.fullName} />

                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{contact.fullName}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {contact.jobTitle ? `${contact.jobTitle} · ` : ""}
                    {contact.lead.companyName}
                  </p>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {contact.isPrimary ? (
                      <Badge tone="accent" uppercase>
                        Primary
                      </Badge>
                    ) : null}
                    {contact.isDecisionMaker ? (
                      <Badge tone="success" uppercase>
                        Decision maker
                      </Badge>
                    ) : null}
                  </div>
                </div>
              </Link>
            ))}
          </div>

          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            totalPages={result.totalPages}
            linkTo={linkTo}
            noun="contact"
          />
        </>
      )}
    </div>
  );
}
