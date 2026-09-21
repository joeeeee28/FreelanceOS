"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Icon } from "@/components/ui/domain";
import { Button, cn } from "@/components/ui/primitives";
import { findNavItem } from "@/lib/navigation";
import { SidebarNav } from "./sidebar-nav";
import { QuickCreate } from "./quick-create";
import { GlobalSearch } from "./global-search";
import { UserMenu } from "./user-menu";
import { ActionIndicator } from "./action-indicator";

const COLLAPSE_KEY = "freelanceos:sidebar-collapsed";

export function AppShell({
  userName,
  userEmail,
  workspaceName,
  dueActionCount,
  children,
}: {
  userName: string;
  userEmail: string;
  workspaceName: string;
  dueActionCount: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Restore the collapse preference after mount so the server render and the
  // first client render agree (no hydration mismatch).
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  function toggleCollapsed() {
    setCollapsed((previous) => {
      const next = !previous;
      window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  }

  // Close the mobile drawer on navigation.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Escape closes the drawer.
  useEffect(() => {
    if (!mobileOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  const current = findNavItem(pathname);
  const title = current?.label ?? "FreelanceOS";

  const sidebarWidth = collapsed ? "md:w-[4.25rem]" : "md:w-64";
  const mainOffset = collapsed ? "md:pl-[4.25rem]" : "md:pl-64";

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>

      {/* ------------------------------------------------ desktop sidebar */}
      <aside
        className={cn(
          "hidden border-r border-border bg-surface md:fixed md:inset-y-0 md:z-30 md:flex md:flex-col",
          sidebarWidth,
        )}
      >
        <div
          className={cn(
            "flex h-14 items-center border-b border-border px-3",
            collapsed ? "justify-center" : "gap-2",
          )}
        >
          <Link
            href="/dashboard"
            className="flex min-w-0 items-center gap-2"
            title={workspaceName}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
              F
            </span>
            {!collapsed ? (
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold leading-tight">
                  FreelanceOS
                </span>
                <span className="block truncate text-2xs leading-tight text-muted-foreground">
                  {workspaceName}
                </span>
              </span>
            ) : null}
          </Link>
        </div>

        <SidebarNav collapsed={collapsed} />

        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              collapsed && "justify-center",
            )}
          >
            <Icon name={collapsed ? "chevronRight" : "chevronLeft"} />
            {!collapsed ? <span>Collapse</span> : null}
          </button>

          <UserMenu
            userName={userName}
            userEmail={userEmail}
            collapsed={collapsed}
          />
        </div>
      </aside>

      {/* ------------------------------------------------- mobile drawer */}
      {mobileOpen ? (
        <div className="md:hidden">
          <div
            className="fixed inset-0 z-40 bg-foreground/30 backdrop-blur-[1px]"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="fixed inset-y-0 left-0 z-50 flex w-[17rem] flex-col border-r border-border bg-surface shadow-popover"
          >
            <div className="flex h-14 items-center justify-between border-b border-border px-3">
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">
                  FreelanceOS
                </span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {workspaceName}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation"
              >
                <Icon name="close" />
              </Button>
            </div>

            <SidebarNav onNavigate={() => setMobileOpen(false)} />

            <div className="border-t border-border p-2">
              <UserMenu userName={userName} userEmail={userEmail} />
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------------------------------------------------------- main */}
      <div className={cn("flex min-h-screen flex-col", mainOffset)}>
        <header className="sticky top-0 z-20 border-b border-border bg-surface/85 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
          <div className="flex h-14 items-center gap-2 px-3 sm:px-5">
            <Button
              variant="ghost"
              size="sm"
              className="md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
            >
              <Icon name="menu" />
            </Button>

            <div className="min-w-0 flex-1">
              <Breadcrumb title={title} pathname={pathname} />
            </div>

            <div className="hidden lg:block lg:w-72">
              <GlobalSearch />
            </div>

            <ActionIndicator count={dueActionCount} />
            <QuickCreate />
          </div>

          {/* Search drops below the title bar on narrow screens. */}
          <div className="border-t border-border px-3 py-2 lg:hidden">
            <GlobalSearch />
          </div>
        </header>

        <main id="main-content" className="flex-1">
          <div className="mx-auto w-full max-w-[90rem] p-4 sm:p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

/** Page title plus a contextual trail on nested routes. */
function Breadcrumb({ title, pathname }: { title: string; pathname: string }) {
  const parent = findNavItem(pathname);
  const isNested = parent ? pathname !== parent.href : false;

  const leafLabel = (() => {
    if (!isNested) return null;
    const last = pathname.split("/").filter(Boolean).pop() ?? "";
    // Record ids are opaque; label the segment by intent instead of exposing
    // the identifier in the chrome.
    if (last === "new") return "New";
    return "Detail";
  })();

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {isNested && parent ? (
        <>
          <Link
            href={parent.href}
            className="truncate text-sm text-muted-foreground hover:text-foreground"
          >
            {parent.label}
          </Link>
          <Icon name="chevronRight" size={12} className="shrink-0 text-subtle-foreground" />
          <span className="truncate text-sm font-semibold">{leafLabel}</span>
        </>
      ) : (
        <h1 className="truncate text-sm font-semibold">{title}</h1>
      )}
    </div>
  );
}
