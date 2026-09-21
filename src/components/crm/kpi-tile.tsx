import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/components/ui/primitives";

/**
 * A single KPI figure.
 *
 * `value` is always a real count from the database. When a metric cannot be
 * computed because the underlying data is not modelled yet (money, for
 * example), callers pass `notTracked` instead of inventing a number — the tile
 * then says so plainly.
 */
export function KpiTile({
  label,
  value,
  hint,
  href,
  tone = "neutral",
  notTracked,
  notTrackedHint,
}: {
  label: string;
  value?: ReactNode;
  hint?: ReactNode;
  href?: string;
  tone?: "neutral" | "accent" | "warning" | "danger" | "success";
  notTracked?: boolean;
  notTrackedHint?: string;
}) {
  const valueTone = {
    neutral: "text-foreground",
    accent: "text-accent",
    warning: "text-warning",
    danger: "text-danger",
    success: "text-success",
  }[tone];

  const body = (
    <>
      <p className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
        {label}
      </p>

      {notTracked ? (
        <>
          <p className="mt-2 text-sm font-medium text-subtle-foreground">
            Not tracked yet
          </p>
          {notTrackedHint ? (
            <p className="mt-1 text-xs leading-relaxed text-subtle-foreground">
              {notTrackedHint}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p
            className={cn(
              "tabular mt-1.5 text-2xl font-semibold tracking-tight",
              valueTone,
            )}
          >
            {value}
          </p>
          {hint ? (
            <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
          ) : null}
        </>
      )}
    </>
  );

  const shell =
    "rounded-xl border border-border bg-surface p-4 shadow-xs transition-colors";

  if (href && !notTracked) {
    return (
      <Link href={href} className={cn(shell, "block hover:border-border-strong hover:bg-muted/40")}>
        {body}
      </Link>
    );
  }

  return <div className={shell}>{body}</div>;
}
