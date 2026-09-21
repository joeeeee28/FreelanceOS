"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { Avatar, Icon } from "@/components/ui/domain";
import { cn } from "@/components/ui/primitives";
import { ThemeToggle } from "./theme-toggle";

export function UserMenu({
  userName,
  userEmail,
  collapsed = false,
}: {
  userName: string;
  userEmail: string;
  collapsed?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Unchanged logout contract: POST /api/auth/logout, clear the query cache,
  // then replace + refresh so no authenticated view survives in the router
  // cache.
  async function handleLogout() {
    setFailed(false);

    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });

      if (!response.ok) {
        setFailed(true);
        return;
      }
    } catch {
      setFailed(true);
      return;
    }

    queryClient.clear();

    startTransition(() => {
      router.replace("/login");
      router.refresh();
    });
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={collapsed ? `${userName} (${userEmail})` : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors hover:bg-muted",
          collapsed && "justify-center",
        )}
      >
        <Avatar name={userName} />

        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{userName}</span>
              <span className="block truncate text-2xs text-muted-foreground">
                {userEmail}
              </span>
            </span>
            <Icon name="chevronDown" size={12} className="shrink-0 text-subtle-foreground" />
          </>
        ) : (
          <span className="sr-only">Account menu for {userName}</span>
        )}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className="absolute bottom-full left-0 z-50 mb-1.5 w-60 animate-fade-in rounded-lg border border-border bg-popover p-2 shadow-popover"
        >
          <div className="px-1 pb-2">
            <p className="truncate text-xs font-medium">{userName}</p>
            <p className="truncate text-2xs text-muted-foreground">{userEmail}</p>
          </div>

          <div className="border-t border-border pt-2">
            <p className="px-1 pb-1.5 text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
              Theme
            </p>
            <ThemeToggle />
          </div>

          {failed ? (
            <p role="alert" className="mt-2 px-1 text-2xs text-danger">
              Sign out failed. Please try again.
            </p>
          ) : null}

          <button
            role="menuitem"
            type="button"
            onClick={handleLogout}
            disabled={pending}
            className="mt-2 flex w-full items-center gap-2 rounded-md border-t border-border px-1 pt-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          >
            <Icon name="lock" className="shrink-0" />
            {pending ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
