"use client";

import Link from "next/link";

import { Icon } from "@/components/ui/domain";
import { cn } from "@/components/ui/primitives";

/**
 * Shows how many revenue actions are waiting today.
 *
 * The count comes from the existing daily-action engine on the server; this
 * component only renders it. Zero is shown as a calm, unbadged bell — never a
 * fabricated number.
 */
export function ActionIndicator({ count }: { count: number }) {
  const hasActions = count > 0;

  return (
    <Link
      href="/dashboard"
      title={
        hasActions
          ? `${count} revenue action${count === 1 ? "" : "s"} need attention`
          : "No actions due right now"
      }
      className={cn(
        "relative inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors",
        "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon name="bell" />

      {hasActions ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-2xs font-semibold text-destructive-foreground">
          {count > 9 ? "9+" : count}
        </span>
      ) : null}

      <span className="sr-only">
        {hasActions
          ? `${count} revenue actions need attention`
          : "No actions due right now"}
      </span>
    </Link>
  );
}
