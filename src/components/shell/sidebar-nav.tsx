"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Icon } from "@/components/ui/domain";
import { cn } from "@/components/ui/primitives";
import { NAV_GROUPS } from "@/lib/navigation";

export function SidebarNav({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Main">
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          {/* When collapsed the group label would be unreadable, so it is
              replaced by a divider while staying available to screen readers. */}
          {collapsed ? (
            <div className="mx-auto mb-2 h-px w-6 bg-border" role="presentation" />
          ) : (
            <p className="mb-1.5 px-2 text-2xs font-semibold uppercase tracking-wider text-subtle-foreground">
              {group.label}
            </p>
          )}

          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const isActive =
                pathname === item.href || pathname.startsWith(`${item.href}/`);

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? "page" : undefined}
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      "group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                      collapsed && "justify-center px-0",
                      isActive
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                    )}
                  >
                    {/* Active rail */}
                    {isActive ? (
                      <span
                        aria-hidden
                        className="absolute -left-3 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-accent"
                      />
                    ) : null}

                    <Icon
                      name={item.icon}
                      className={cn(
                        "shrink-0",
                        isActive ? "text-accent" : "text-subtle-foreground",
                      )}
                    />

                    {!collapsed ? (
                      <>
                        <span className="truncate">{item.label}</span>

                        {item.status === "planned" ? (
                          <span className="ml-auto rounded bg-muted px-1 py-0.5 text-2xs font-medium uppercase tracking-wide text-subtle-foreground ring-1 ring-inset ring-border">
                            Soon
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="sr-only">
                        {item.label}
                        {item.status === "planned" ? " (coming soon)" : ""}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
