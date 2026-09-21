import Link from "next/link";
import type { LeadStatus } from "@prisma/client";

import { cn } from "@/components/ui/primitives";

/**
 * Conversion funnel built from real status counts.
 *
 * Each step counts leads that have reached *at least* that stage, so the
 * series is monotonic and the conversion percentages mean what they say. A
 * lead currently sitting in PROPOSAL has necessarily been contacted, so it
 * counts towards the earlier steps too.
 */
const FUNNEL_STEPS: Array<{
  label: string;
  statuses: LeadStatus[];
  filter: string;
}> = [
  {
    label: "All leads",
    statuses: [
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
    ],
    filter: "/leads",
  },
  {
    label: "Qualified",
    statuses: [
      "QUALIFIED",
      "OUTREACH_READY",
      "CONTACTED",
      "RESPONDED",
      "DISCOVERY_CALL",
      "PROPOSAL",
      "NEGOTIATION",
      "WON",
    ],
    filter: "/leads?status=QUALIFIED",
  },
  {
    label: "Contacted",
    statuses: [
      "CONTACTED",
      "RESPONDED",
      "DISCOVERY_CALL",
      "PROPOSAL",
      "NEGOTIATION",
      "WON",
    ],
    filter: "/leads?status=CONTACTED",
  },
  {
    label: "In conversation",
    statuses: ["RESPONDED", "DISCOVERY_CALL", "PROPOSAL", "NEGOTIATION", "WON"],
    filter: "/leads?status=RESPONDED",
  },
  {
    label: "Proposal or later",
    statuses: ["PROPOSAL", "NEGOTIATION", "WON"],
    filter: "/leads?status=PROPOSAL",
  },
  {
    label: "Won",
    statuses: ["WON"],
    filter: "/leads?status=WON",
  },
];

export function RevenueFunnel({
  statusCounts,
}: {
  statusCounts: Record<LeadStatus, number>;
}) {
  const rows = FUNNEL_STEPS.map((step) => ({
    ...step,
    count: step.statuses.reduce(
      (total, status) => total + (statusCounts[status] ?? 0),
      0,
    ),
  }));

  const top = rows[0].count;

  return (
    <ol className="space-y-2.5">
      {rows.map((row, index) => {
        // Share of the whole funnel, and conversion from the previous step.
        const share = top === 0 ? 0 : Math.round((row.count / top) * 100);
        const previous = index === 0 ? null : rows[index - 1].count;
        const conversion =
          previous === null || previous === 0
            ? null
            : Math.round((row.count / previous) * 100);

        return (
          <li key={row.label}>
            <Link href={row.filter} className="group block">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium text-foreground group-hover:text-accent">
                  {row.label}
                </span>

                <span className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      "tabular font-semibold",
                      row.count === 0
                        ? "text-subtle-foreground"
                        : "text-foreground",
                    )}
                  >
                    {row.count}
                  </span>
                  {conversion !== null ? (
                    <span className="tabular text-2xs text-subtle-foreground">
                      {conversion}% of previous
                    </span>
                  ) : null}
                </span>
              </div>

              <div
                aria-hidden
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-accent/70 transition-[width]"
                  style={{ width: `${share}%` }}
                />
              </div>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
