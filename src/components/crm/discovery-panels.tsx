import Link from "next/link";

import type { DiscoveryStats, MarketIntelligence, SourceHealthRow, TopOpportunity } from "@/lib/discovery/stats";
import { MIN_MARKET_SAMPLE } from "@/lib/discovery/stats";
import { serviceLabel } from "@/lib/taxonomy/services";
import { humanise } from "@/components/ui/domain";
import { Badge, cn, EmptyState } from "@/components/ui/primitives";

/**
 * Discovery, intelligence and source-health panels.
 *
 * The rule throughout: show what is known, say plainly what is not, and never
 * fill a gap with a plausible-looking number. An operator has to be able to
 * trust that a figure on this page came from a row in the database.
 */

/** Relative time, for "last run 3 hours ago". */
function ago(date: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.round(hours / 24)}d ago`;
}

/** Headline discovery counters. */
export function DiscoverySummary({
  stats,
  now,
}: {
  stats: DiscoveryStats;
  now: Date;
}) {
  const items: Array<{ label: string; value: string; hint?: string; tone?: string }> = [
    {
      label: "Companies",
      value: String(stats.companies),
      hint:
        stats.companiesDiscoveredRecently > 0
          ? `+${stats.companiesDiscoveredRecently} this week`
          : "None added this week",
    },
    {
      label: "Active signals",
      value: String(stats.signalsActive),
      hint: `${stats.opportunitiesOpen} open opportunities`,
    },
    {
      label: "Knowledge",
      value: String(stats.knowledgeResources),
      hint: "Public resources indexed",
    },
    {
      label: "Last run",
      // Null is not zero. A workspace that has never run says so.
      value: stats.lastRunAt === null ? "Never" : ago(stats.lastRunAt, now),
      hint:
        stats.lastRunStatus === null
          ? "Discovery has not run yet"
          : humanise(stats.lastRunStatus),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-lg border border-border bg-surface px-3.5 py-3"
        >
          <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
          <p className="tabular mt-1.5 text-xl font-semibold leading-none text-foreground">
            {item.value}
          </p>
          {item.hint !== undefined && (
            <p className="mt-1.5 text-xs text-subtle-foreground">{item.hint}</p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The strongest opportunities, each with its reason.
 *
 * A score is never shown without the sentence that justifies it; that is the
 * difference between this and a mysterious AI ranking.
 */
export function TopOpportunities({
  opportunities,
}: {
  opportunities: TopOpportunity[];
}) {
  if (opportunities.length === 0) {
    return (
      <EmptyState
        title="No opportunities yet"
        description="Opportunities appear once discovery has found signals for a company."
      />
    );
  }

  return (
    <ul className="divide-y divide-border">
      {opportunities.map((opportunity) => (
        <li key={opportunity.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
          <span
            className={cn(
              "tabular mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
              opportunity.score >= 50
                ? "bg-accent/10 text-accent"
                : "bg-muted text-muted-foreground",
            )}
            aria-label={`Score ${opportunity.score} out of 100`}
          >
            {opportunity.score}
          </span>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {opportunity.companyName}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {serviceLabel(opportunity.serviceKey)}
            </p>

            {/* The reason, always. */}
            {opportunity.summary !== null && (
              <p className="mt-1 text-xs text-subtle-foreground">{opportunity.summary}</p>
            )}
            {opportunity.recommendedAction !== null && (
              <p className="mt-1 text-xs text-foreground">
                Next: {opportunity.recommendedAction}
              </p>
            )}
          </div>

          {opportunity.leadId !== null ? (
            <Link
              href={`/leads/${opportunity.leadId}`}
              className="shrink-0 text-xs font-medium text-accent hover:underline"
            >
              View lead
            </Link>
          ) : (
            <Badge tone="neutral">Not a lead</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Per-source health with plain remediation text. */
export function SourceHealthTable({
  sources,
  now,
}: {
  sources: SourceHealthRow[];
  now: Date;
}) {
  if (sources.length === 0) {
    return (
      <EmptyState
        title="No sources configured"
        description="Add a discovery source to start finding companies automatically."
      />
    );
  }

  const tone = (status: string) =>
    status === "ACTIVE"
      ? "success"
      : status === "BLOCKED"
        ? "warning"
        : status === "FAILING"
          ? "danger"
          : "neutral";

  return (
    <ul className="divide-y divide-border">
      {sources.map((source) => (
        <li key={source.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {source.name}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {source.provider}
                {source.lastRunAt !== null && ` · ran ${ago(source.lastRunAt, now)}`}
                {!source.enabled && " · disabled"}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {/* A source that has never run says UNKNOWN, not 0%. */}
              {source.health.successRate !== null && (
                <span className="tabular text-xs text-muted-foreground">
                  {Math.round(source.health.successRate * 100)}%
                </span>
              )}
              <Badge tone={tone(source.health.status)}>
                {humanise(source.health.status)}
              </Badge>
            </div>
          </div>

          {source.health.status !== "ACTIVE" && (
            <p className="mt-1.5 text-xs text-subtle-foreground">
              {source.health.remediation}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Market aggregates, with the sample size always attached.
 *
 * Below the minimum sample the percentages are withheld entirely rather than
 * shown with a caveat nobody reads. "67% have no website" out of three
 * companies is noise with a percent sign.
 */
export function MarketPanel({ market }: { market: MarketIntelligence }) {
  if (market.sampleSize === 0) {
    return (
      <EmptyState
        title="No market data yet"
        description="Market figures appear once discovery has found companies."
      />
    );
  }

  if (!market.sufficient) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center">
        <p className="text-sm font-medium text-foreground">
          Not enough data yet
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Based on {market.sampleSize}{" "}
          {market.sampleSize === 1 ? "company" : "companies"}. At least{" "}
          {MIN_MARKET_SAMPLE} are needed before percentages mean anything.
        </p>
      </div>
    );
  }

  const percent = (value: number) => `${Math.round((value / market.sampleSize) * 100)}%`;

  return (
    <div className="space-y-4">
      <p className="text-xs text-subtle-foreground">
        Based on {market.sampleSize} companies.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border px-3.5 py-3">
          <p className="text-xs font-medium text-muted-foreground">No website</p>
          <p className="tabular mt-1 text-lg font-semibold text-foreground">
            {percent(market.withoutWebsite)}
          </p>
          <p className="mt-0.5 text-xs text-subtle-foreground">
            {market.withoutWebsite} of {market.sampleSize}
          </p>
        </div>

        <div className="rounded-lg border border-border px-3.5 py-3">
          <p className="text-xs font-medium text-muted-foreground">On social</p>
          <p className="tabular mt-1 text-lg font-semibold text-foreground">
            {percent(market.withSocialPresence)}
          </p>
          <p className="mt-0.5 text-xs text-subtle-foreground">
            {market.withSocialPresence} of {market.sampleSize}
          </p>
        </div>
      </div>

      {market.byIndustry.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Top industries</p>
          <ul className="mt-2 space-y-1.5">
            {market.byIndustry.slice(0, 5).map((segment) => (
              <li
                key={segment.label}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="truncate text-foreground">{segment.label}</span>
                <span className="tabular shrink-0 text-muted-foreground">
                  {segment.count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
