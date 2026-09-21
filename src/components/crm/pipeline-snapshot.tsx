import Link from "next/link";
import type { LeadStatus } from "@prisma/client";

import { ALL_LEAD_STATUSES } from "@/lib/crm/pipeline";
import { humanise } from "@/components/ui/domain";
import { cn } from "@/components/ui/primitives";

/**
 * Counts per lead status, each linking to the filtered leads view.
 *
 * Every number is a real aggregate from the database. On an empty workspace
 * each stage shows 0 — the shape of the funnel is still useful, and zero is a
 * truthful value.
 */
export function PipelineSnapshot({
  statusCounts,
}: {
  statusCounts: Record<LeadStatus, number>;
}) {
  const max = Math.max(1, ...ALL_LEAD_STATUSES.map((s) => statusCounts[s] ?? 0));

  return (
    <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-4">
      {ALL_LEAD_STATUSES.map((status) => {
        const count = statusCounts[status] ?? 0;

        return (
          <li key={status}>
            <Link
              href={`/leads?status=${status}`}
              className="flex h-full flex-col justify-between gap-2 bg-surface px-3.5 py-3 transition-colors hover:bg-muted/50"
            >
              <span className="text-xs font-medium text-muted-foreground">
                {humanise(status)}
              </span>

              <span className="flex items-end justify-between gap-2">
                <span
                  className={cn(
                    "tabular text-xl font-semibold leading-none",
                    count === 0 ? "text-subtle-foreground" : "text-foreground",
                  )}
                >
                  {count}
                </span>

                {/* Proportional bar, scaled to the busiest stage. */}
                <span
                  aria-hidden
                  className="h-1 w-16 overflow-hidden rounded-full bg-muted"
                >
                  <span
                    className="block h-full rounded-full bg-accent/70"
                    style={{ width: `${Math.round((count / max) * 100)}%` }}
                  />
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
