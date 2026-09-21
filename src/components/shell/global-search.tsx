"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { Icon } from "@/components/ui/domain";

/**
 * Global search.
 *
 * Submits to the existing server-side lead search (`/leads?q=`) rather than
 * introducing a new client-side index or an extra API round trip.
 */
export function GlobalSearch() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses search, the way keyboard-first tools behave.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
        return;
      }

      event.preventDefault();
      inputRef.current?.focus();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("q");
        const query = typeof value === "string" ? value.trim() : "";
        router.push(query ? `/leads?q=${encodeURIComponent(query)}` : "/leads");
      }}
      className="relative"
    >
      <label htmlFor="global-search" className="sr-only">
        Search leads
      </label>

      <Icon
        name="search"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle-foreground"
      />

      <input
        id="global-search"
        ref={inputRef}
        name="q"
        type="search"
        placeholder="Search leads…"
        autoComplete="off"
        className="h-9 w-full rounded-md border border-input bg-surface-muted pl-8 pr-9 text-sm placeholder:text-subtle-foreground focus:bg-surface"
      />

      <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 text-2xs text-subtle-foreground sm:block">
        /
      </kbd>
    </form>
  );
}
