import Link from "next/link";

import { requireUser } from "@/lib/auth/require-user";
import {
  mergeFilters,
  parseNaturalLanguage,
  parsePage,
  parseStructuredFilters,
  searchFindClients,
  serviceOptions,
  signalOptions,
  type ParseFailure,
} from "@/lib/find-clients";
import { relativeLabel } from "@/lib/time/relative";
import { FilterBar, FilterInput, FilterSelect } from "@/components/crm/filter-bar";
import { Pagination } from "@/components/crm/pagination";
import { Icon, ScorePill } from "@/components/ui/domain";
import { PageHeader } from "@/components/ui/page";
import { Badge, EmptyState, LinkButton } from "@/components/ui/primitives";

const LEAD_OPTIONS = [
  "NONE",
  "NEW",
  "RESEARCHING",
  "QUALIFIED",
  "OUTREACH_READY",
  "CONTACTED",
  "RESPONDED",
  "DISCOVERY_CALL",
  "PROPOSAL",
  "NEGOTIATION",
  "WON",
  "LOST",
  "NURTURE",
].map((value) => ({ value, label: value === "NONE" ? "No lead" : value.toLowerCase().replaceAll("_", " ") }));

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function notice(failure: ParseFailure): string {
  return failure.message;
}

export default async function FindClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await requireUser();
  const raw = await searchParams;
  const params = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, first(value)]),
  ) as Record<string, string | undefined>;

  const structured = parseStructuredFilters(params);
  const natural = parseNaturalLanguage(params.q ?? "");
  const page = parsePage(params.page);
  const merged = structured.ok && natural.ok ? mergeFilters(structured.filters, natural.filters) : null;
  const failure = !structured.ok
    ? structured
    : !natural.ok
      ? natural
      : typeof page !== "number"
        ? page
        : merged && !merged.ok
          ? merged
          : null;

  const result =
    failure === null && merged?.ok && typeof page === "number"
      ? await searchFindClients(workspaceId, merged.filters, page)
      : null;

  const active = Boolean(
    params.q ||
      params.industry ||
      params.location ||
      params.businessType ||
      params.service ||
      params.signal ||
      params.minConfidence ||
      params.website ||
      params.lead ||
      params.minScore ||
      params.freshness ||
      params.source,
  );

  const linkTo = (overrides: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    const mergedParams = { ...params, ...overrides };
    for (const [key, value] of Object.entries(mergedParams)) {
      if (value === undefined || value === "") continue;
      next.set(key, String(value));
    }
    const query = next.toString();
    return query === "" ? "/find-clients" : `/find-clients?${query}`;
  };

  return (
    <div>
      <PageHeader
        title="Find Clients"
        description="Businesses already researched in this workspace, ranked by the stored opportunity score. Search becomes filters. Nothing here is invented."
      />

      <FilterBar active={active} clearHref="/find-clients">
        <FilterInput
          label="Search"
          name="q"
          type="search"
          defaultValue={params.q}
          placeholder="Physiotherapy clinics in Chennai with website improvement"
          className="sm:col-span-2 lg:col-span-2"
        />
        <FilterInput label="Industry" name="industry" defaultValue={params.industry} />
        <FilterInput label="Location" name="location" defaultValue={params.location} />
        <FilterInput label="Business type" name="businessType" defaultValue={params.businessType} />
        <FilterSelect
          label="Service"
          name="service"
          defaultValue={params.service}
          placeholder="Any catalog service"
          options={serviceOptions()}
        />
        <FilterSelect
          label="Evidence"
          name="signal"
          defaultValue={params.signal}
          placeholder="Any mapped signal"
          options={signalOptions()}
        />
        <FilterInput
          label="Min score"
          name="minScore"
          type="number"
          min={0}
          max={100}
          defaultValue={params.minScore}
        />
        <FilterInput
          label="Min confidence"
          name="minConfidence"
          type="number"
          min={0}
          max={100}
          defaultValue={params.minConfidence}
        />
        <FilterSelect
          label="Website"
          name="website"
          defaultValue={params.website}
          placeholder="Any"
          options={[
            { value: "present", label: "Present" },
            { value: "missing", label: "Missing" },
            { value: "unknown", label: "Unknown" },
          ]}
        />
        <FilterSelect
          label="Lead status"
          name="lead"
          defaultValue={params.lead}
          placeholder="Any"
          options={LEAD_OPTIONS}
        />
        <FilterSelect
          label="Research"
          name="freshness"
          defaultValue={params.freshness}
          placeholder="Any"
          options={[
            { value: "fresh", label: "Fresh" },
            { value: "stale", label: "Stale" },
            { value: "never", label: "Never researched" },
          ]}
        />
        <FilterInput label="Source" name="source" defaultValue={params.source} />
      </FilterBar>

      {failure ? (
        <p className="mt-4 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-foreground" role="alert">
          {notice(failure)} Nothing was searched.
        </p>
      ) : null}

      {result && result.results.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Icon name="search" />}
            title="No matching businesses"
            description="Filters only match companies, signals and opportunities already stored in this workspace. An empty list is not a suggestion to invent one."
          />
        </div>
      ) : null}

      {result && result.results.length > 0 ? (
        <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-border text-2xs uppercase tracking-wide text-subtle-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Business</th>
                <th className="px-3 py-2 font-medium">Opportunity</th>
                <th className="px-3 py-2 font-medium">Evidence</th>
                <th className="px-3 py-2 font-medium">Score</th>
                <th className="px-3 py-2 font-medium">Confidence</th>
                <th className="px-3 py-2 font-medium">Last researched</th>
                <th className="px-3 py-2 font-medium">Recommended action</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((row) => (
                <tr key={row.opportunity.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-3 align-top">
                    <Link
                      href={`/find-clients/${row.company.id}?service=${row.opportunity.serviceKey}`}
                      className="font-medium text-foreground hover:underline"
                    >
                      {row.company.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {[row.company.industry, row.company.city, row.company.region]
                        .filter(Boolean)
                        .join(" · ") || "Industry and location unknown"}
                    </p>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <p>{row.opportunity.serviceLabel}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{row.opportunity.status.toLowerCase()}</p>
                  </td>
                  <td className="px-3 py-3 align-top text-xs text-muted-foreground">
                    {row.evidence[0]?.text ?? "No stored evidence"}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <ScorePill score={row.opportunity.score} />
                  </td>
                  <td className="px-3 py-3 align-top tabular-nums">
                    {row.confidence === null ? "—" : row.confidence}
                  </td>
                  <td className="px-3 py-3 align-top text-xs text-muted-foreground">
                    {row.company.lastResearchAt
                      ? relativeLabel(row.company.lastResearchAt)
                      : row.company.researchStatus.toLowerCase()}
                  </td>
                  <td className="px-3 py-3 align-top">
                    <p className="text-xs">{row.opportunity.recommendedAction ?? "No stored action"}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <LinkButton
                        href={`/find-clients/${row.company.id}?service=${row.opportunity.serviceKey}`}
                        size="sm"
                        variant="ghost"
                      >
                        Evidence
                      </LinkButton>
                      {row.lead ? (
                        <LinkButton href={`/leads/${row.lead.id}`} size="sm" variant="ghost">
                          Lead
                        </LinkButton>
                      ) : (
                        <Badge>No lead</Badge>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {result ? (
        <div className="mt-4">
          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            totalPages={result.totalPages}
            linkTo={linkTo}
            noun="business"
          />
        </div>
      ) : null}
    </div>
  );
}
