import Link from "next/link";
import type { LeadStatus } from "@prisma/client";

import { listLeadSources, listLeads, MAX_PAGE_SIZE } from "@/lib/crm/leads";
import { ALL_LEAD_STATUSES } from "@/lib/crm/pipeline";
import { getWorkspaceTimeFormatters } from "@/lib/time/workspace-time";

function humanise(value: string) {
  const lower = value.replaceAll("_", " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

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

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  const archiveMode = params.archived ?? "active";

  const filters = {
    search: params.q,
    status: parseStatus(params.status),
    source: params.source || undefined,
    minScore: parseNumber(params.minScore),
    page: parseNumber(params.page),
    pageSize: parseNumber(params.pageSize),
    onlyArchived: archiveMode === "only",
    includeArchived: archiveMode === "all",
  };

  const [result, sources, { formatDate }] = await Promise.all([
    listLeads(filters),
    listLeadSources(),
    getWorkspaceTimeFormatters(),
  ]);

  const hasFilters = Boolean(
    params.q || params.status || params.source || params.minScore,
  );

  /** Builds a querystring that preserves the current filters. */
  const linkTo = (overrides: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();

    const merged = {
      q: params.q,
      status: params.status,
      source: params.source,
      minScore: params.minScore,
      archived: params.archived,
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

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-muted-foreground">
            {result.total === 0
              ? "No leads yet."
              : `${result.total} lead${result.total === 1 ? "" : "s"}`}
          </p>
        </div>

        <Link
          href="/leads/new"
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          Add Lead
        </Link>
      </header>

      {/* Filters submit as a GET form so state lives in the URL and the
          filtering happens server-side. */}
      <form method="GET" className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2 lg:grid-cols-5">
        <label className="space-y-1">
          <span className="text-xs font-medium">Search</span>
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Company, contact, email, website"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium">Status</span>
          <select
            name="status"
            defaultValue={params.status ?? ""}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="">All statuses</option>
            {ALL_LEAD_STATUSES.map((status) => (
              <option key={status} value={status}>
                {humanise(status)}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium">Source</span>
          <select
            name="source"
            defaultValue={params.source ?? ""}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="">All sources</option>
            {sources.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium">Minimum score</span>
          <input
            name="minScore"
            type="number"
            min={0}
            max={100}
            defaultValue={params.minScore ?? ""}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium">Archived</span>
          <select
            name="archived"
            defaultValue={archiveMode}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="active">Active only</option>
            <option value="all">Include archived</option>
            <option value="only">Archived only</option>
          </select>
        </label>

        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
          <button className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
            Apply filters
          </button>
          {hasFilters ? (
            <Link href="/leads" className="rounded-md border px-4 py-2 text-sm hover:bg-muted">
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {result.items.length === 0 ? (
        <div className="rounded-xl border p-8 text-center">
          <p className="font-medium">
            {hasFilters ? "No leads match these filters." : "No leads yet."}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {hasFilters
              ? "Try widening your search."
              : "Add your first real lead to start building your pipeline."}
          </p>
        </div>
      ) : (
        <>
          {/* Table on wide screens, cards on small ones. */}
          <div className="hidden overflow-x-auto rounded-xl border md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left">
                  <th className="p-3">Company</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Score</th>
                  <th className="p-3">Contacts</th>
                  <th className="p-3">Source</th>
                  <th className="p-3">Next follow-up</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((lead) => (
                  <tr key={lead.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="p-3">
                      <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">
                        {lead.companyName}
                      </Link>
                      {lead.deletedAt ? (
                        <span className="ml-2 text-xs text-muted-foreground">Archived</span>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        {lead.contactName ?? "—"}
                      </p>
                    </td>
                    <td className="p-3">{humanise(lead.status)}</td>
                    <td className="p-3 font-medium">{lead.score}</td>
                    <td className="p-3">{lead._count.contacts}</td>
                    <td className="p-3">{lead.source ?? "—"}</td>
                    <td className="p-3">
                      {lead.followUps[0] ? formatDate(lead.followUps[0].scheduledAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 md:hidden">
            {result.items.map((lead) => (
              <Link
                key={lead.id}
                href={`/leads/${lead.id}`}
                className="block rounded-xl border p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{lead.companyName}</p>
                    <p className="text-sm text-muted-foreground">{humanise(lead.status)}</p>
                  </div>
                  <span className="text-lg font-semibold">{lead.score}</span>
                </div>
              </Link>
            ))}
          </div>

          <nav className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Page {result.page} of {result.totalPages} · {result.pageSize} per page
              {result.pageSize === MAX_PAGE_SIZE ? " (max)" : ""}
            </p>

            <div className="flex gap-2">
              {result.page > 1 ? (
                <Link
                  href={linkTo({ page: result.page - 1 })}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  Previous
                </Link>
              ) : null}

              {result.page < result.totalPages ? (
                <Link
                  href={linkTo({ page: result.page + 1 })}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  Next
                </Link>
              ) : null}
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
