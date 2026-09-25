import Link from "next/link";

import { cn } from "./primitives";

export interface TabItem {
  id: string;
  label: string;
  href: string;
  /** Optional count shown as a chip beside the label. */
  count?: number;
}

/**
 * Link-based tabs.
 *
 * Navigation is a real URL change rather than client state, so a tab can be
 * linked to, bookmarked and reloaded, and the page stays a server component.
 */
export function Tabs({
  items,
  active,
  label,
}: {
  items: TabItem[];
  active: string;
  label: string;
}) {
  return (
    <div className="border-b border-border">
      <nav
        aria-label={label}
        className="no-scrollbar -mb-px flex gap-1 overflow-x-auto"
      >
        {items.map((item) => {
          const isActive = item.id === active;

          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              scroll={false}
              className={cn(
                "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "border-accent text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border-strong hover:text-foreground",
              )}
            >
              {item.label}

              {item.count !== undefined ? (
                <span
                  className={cn(
                    "tabular rounded px-1.5 py-0.5 text-2xs font-semibold",
                    isActive
                      ? "bg-accent-subtle text-accent"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {item.count}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
