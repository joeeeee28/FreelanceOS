"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Icon, type IconName } from "@/components/ui/domain";
import { Button, cn } from "@/components/ui/primitives";

/**
 * Quick-create menu.
 *
 * Contacts, tasks and follow-ups are always created against a lead (that is
 * how the data model and the server actions enforce workspace ownership), so
 * those entries route to the lead picker rather than opening a detached form
 * that could not be saved.
 */
const ITEMS: Array<{
  label: string;
  icon: IconName;
  href: string;
  hint?: string;
}> = [
  { label: "New Lead", icon: "leads", href: "/leads/new" },
  {
    label: "New Contact",
    icon: "contacts",
    href: "/leads?intent=contact",
    hint: "Pick a lead",
  },
  {
    label: "New Task",
    icon: "tasks",
    href: "/leads?intent=task",
    hint: "Pick a lead",
  },
  {
    label: "New Follow-up",
    icon: "followups",
    href: "/leads?intent=follow-up",
    hint: "Pick a lead",
  },
  {
    label: "New Proposal",
    icon: "proposals",
    href: "/proposals",
    hint: "Coming soon",
  },
];

export function QuickCreate() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

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
    firstItemRef.current?.focus();

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <Button
        variant="primary"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="plus" />
        <span className="hidden sm:inline">Create</span>
      </Button>

      {open ? (
        <div
          role="menu"
          aria-label="Quick create"
          className="absolute right-0 top-full z-50 mt-1.5 w-56 animate-fade-in overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-popover"
        >
          {ITEMS.map((item, index) => (
            <button
              key={item.label}
              ref={index === 0 ? firstItemRef : undefined}
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false);
                router.push(item.href);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
                "text-foreground transition-colors hover:bg-muted focus-visible:bg-muted",
              )}
            >
              <Icon name={item.icon} className="shrink-0 text-subtle-foreground" />
              <span className="flex-1">{item.label}</span>
              {item.hint ? (
                <span className="text-2xs text-subtle-foreground">{item.hint}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
