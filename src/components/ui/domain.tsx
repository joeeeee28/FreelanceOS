import type { LeadStatus } from "@prisma/client";
import type { ReactNode } from "react";

import { Badge, cn, type BadgeTone } from "./primitives";

/* ------------------------------------------------------------------ labels */

/** SCREAMING_SNAKE enum → "Screaming snake". */
export function humanise(value: string) {
  const lower = value.replaceAll("_", " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/* ------------------------------------------------------------- lead status */

const STATUS_TONE: Record<LeadStatus, BadgeTone> = {
  NEW: "neutral",
  RESEARCHING: "neutral",
  QUALIFIED: "info",
  OUTREACH_READY: "info",
  CONTACTED: "accent",
  RESPONDED: "accent",
  DISCOVERY_CALL: "warning",
  PROPOSAL: "warning",
  NEGOTIATION: "warning",
  WON: "success",
  LOST: "danger",
  NURTURE: "neutral",
};

export function StatusBadge({ status }: { status: LeadStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} uppercase>
      {humanise(status)}
    </Badge>
  );
}

/* -------------------------------------------------------------- lead score */

/**
 * Score banding for display only.
 *
 * These thresholds label the score the server already computed — they never
 * alter it. HIGH matches the daily-action engine's HIGH_SCORE_THRESHOLD (50)
 * so the dashboard and the lead table tell the same story.
 */
export function scoreBand(score: number): {
  label: "HIGH" | "MEDIUM" | "LOW";
  tone: BadgeTone;
} {
  if (score >= 50) return { label: "HIGH", tone: "success" };
  if (score >= 25) return { label: "MEDIUM", tone: "warning" };
  return { label: "LOW", tone: "neutral" };
}

export function ScorePill({
  score,
  size = "sm",
  compact,
}: {
  score: number;
  size?: "sm" | "lg";
  /** Drops the HIGH/MEDIUM/LOW word where space is tight (board cards). */
  compact?: boolean;
}) {
  const band = scoreBand(score);

  const toneRing: Record<BadgeTone, string> = {
    neutral: "text-muted-foreground ring-border bg-muted",
    accent: "text-accent ring-accent/20 bg-accent-subtle",
    success: "text-success ring-success/20 bg-success-subtle",
    warning: "text-warning ring-warning/20 bg-warning-subtle",
    danger: "text-danger ring-danger/20 bg-danger-subtle",
    info: "text-info ring-info/20 bg-info-subtle",
  };

  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 rounded-md ring-1 ring-inset tabular",
        toneRing[band.tone],
        size === "lg" ? "px-2.5 py-1" : "px-1.5 py-0.5",
      )}
      title={`Lead score ${score} of 100 (${band.label.toLowerCase()})`}
    >
      <span className={size === "lg" ? "text-base font-semibold" : "text-xs font-semibold"}>
        {score}
      </span>
      <span
        className={cn(
          "text-2xs font-medium uppercase tracking-wide opacity-80",
          compact && "sr-only",
        )}
      >
        {band.label}
      </span>
    </span>
  );
}

/** Slim horizontal score meter, used where a pill would be too loud. */
export function ScoreMeter({ score }: { score: number }) {
  const band = scoreBand(score);

  const fill: Record<BadgeTone, string> = {
    neutral: "bg-muted-foreground/40",
    accent: "bg-accent",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    info: "bg-info",
  };

  return (
    <div className="flex items-center gap-2">
      <span className="tabular text-xs font-semibold">{score}</span>
      <div
        className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`Lead score ${score} of 100`}
      >
        <div
          className={cn("h-full rounded-full", fill[band.tone])}
          style={{ width: `${Math.max(score, 2)}%` }}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- priority */

export type PriorityLevel = "URGENT" | "HIGH" | "MEDIUM" | "LOW";

const PRIORITY_TONE: Record<PriorityLevel, BadgeTone> = {
  URGENT: "danger",
  HIGH: "warning",
  MEDIUM: "info",
  LOW: "neutral",
};

export function PriorityBadge({ priority }: { priority: string }) {
  const tone = PRIORITY_TONE[priority as PriorityLevel] ?? "neutral";

  return (
    <Badge tone={tone} uppercase>
      {priority}
    </Badge>
  );
}

/** A coloured vertical rule used to flag priority on list rows. */
export function PriorityRail({ priority }: { priority: string }) {
  const map: Record<string, string> = {
    URGENT: "bg-danger",
    HIGH: "bg-warning",
    MEDIUM: "bg-info",
    LOW: "bg-border-strong",
  };

  return (
    <span
      aria-hidden
      className={cn(
        "w-1 shrink-0 self-stretch rounded-full",
        map[priority] ?? "bg-border-strong",
      )}
    />
  );
}

/* -------------------------------------------------------- known / unknown */

/**
 * Renders a researched boolean honestly: true → positive, false → negative,
 * null/undefined → an explicit "Unknown". The UI must never imply we know
 * something we have not researched.
 */
export function KnownFlag({
  value,
  trueLabel,
  falseLabel,
  trueTone = "success",
  falseTone = "warning",
}: {
  value: boolean | null | undefined;
  trueLabel: string;
  falseLabel: string;
  trueTone?: BadgeTone;
  falseTone?: BadgeTone;
}) {
  if (value === null || value === undefined) {
    return <Badge tone="neutral">Unknown</Badge>;
  }

  return (
    <Badge tone={value ? trueTone : falseTone}>
      {value ? trueLabel : falseLabel}
    </Badge>
  );
}

/** Free-text intelligence value: shows the text, or an explicit Unknown. */
export function TextOrUnknown({ value }: { value?: string | null }) {
  if (!value || value.trim() === "") {
    return <span className="text-subtle-foreground">Unknown</span>;
  }
  return <span>{value}</span>;
}

/* ------------------------------------------------------------------ avatar */

/** Deterministic initials avatar — no image uploads exist in the data model. */
export function Avatar({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md";
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-muted font-medium text-muted-foreground",
        size === "sm" ? "h-6 w-6 text-2xs" : "h-8 w-8 text-xs",
      )}
    >
      {initials || "?"}
    </span>
  );
}

/* ------------------------------------------------------------------- icons */

/**
 * Inline SVG icon set (no icon dependency added).
 * 16px grid, 1.5 stroke, inherits currentColor.
 */
export type IconName =
  | "dashboard"
  | "leads"
  | "pipeline"
  | "contacts"
  | "outreach"
  | "followups"
  | "clients"
  | "projects"
  | "tasks"
  | "calendar"
  | "proposals"
  | "invoices"
  | "payments"
  | "expenses"
  | "analytics"
  | "settings"
  | "search"
  | "plus"
  | "bell"
  | "check"
  | "clock"
  | "alert"
  | "chevronRight"
  | "chevronLeft"
  | "chevronDown"
  | "menu"
  | "close"
  | "sparkle"
  | "building"
  | "archive"
  | "lock"
  | "automation"
  | "refresh";

const PATHS: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="2.5" y="2.5" width="5" height="5" rx="1.2" />
      <rect x="10.5" y="2.5" width="5" height="5" rx="1.2" />
      <rect x="2.5" y="10.5" width="5" height="5" rx="1.2" />
      <rect x="10.5" y="10.5" width="5" height="5" rx="1.2" />
    </>
  ),
  // A gear with a small dial: the engine that runs on its own.
  automation: (
    <>
      <circle cx="9" cy="9" r="2.6" />
      <path d="M9 1.6v2.1M9 14.3v2.1M1.6 9h2.1M14.3 9h2.1M3.8 3.8l1.5 1.5M12.7 12.7l1.5 1.5M14.2 3.8l-1.5 1.5M5.3 12.7l-1.5 1.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M15.2 8.2a6.4 6.4 0 0 1-11 3.5" />
      <path d="M2.8 9.8a6.4 6.4 0 0 1 11-3.5" />
      <path d="M13.8 2.6v3.7h-3.7M4.2 15.4v-3.7h3.7" />
    </>
  ),
  leads: (
    <>
      <path d="M2.5 14V6.5l5-3.5 5 3.5V14" />
      <path d="M1.5 14h15" />
      <path d="M6 14v-3h3v3" />
    </>
  ),
  pipeline: (
    <>
      <rect x="2" y="3" width="3.5" height="11" rx="1" />
      <rect x="6.75" y="3" width="3.5" height="7.5" rx="1" />
      <rect x="11.5" y="3" width="3.5" height="5" rx="1" />
    </>
  ),
  contacts: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c0-2.5 2.2-4 5-4s5 1.5 5 4" />
    </>
  ),
  outreach: (
    <>
      <path d="M2 4.5h12v8H2z" />
      <path d="m2 5 6 4.5L14 5" />
    </>
  ),
  followups: (
    <>
      <circle cx="8" cy="8.5" r="5.5" />
      <path d="M8 5.5v3.2l2 1.3" />
    </>
  ),
  clients: (
    <>
      <circle cx="6" cy="5.5" r="2.2" />
      <circle cx="11.5" cy="6.5" r="1.8" />
      <path d="M2 13.5c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5" />
      <path d="M10.5 13.5c0-1.6 1-2.6 2.5-2.6s2 .9 2 2.6" />
    </>
  ),
  projects: (
    <>
      <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h2.8l1.2 1.6h5A1.5 1.5 0 0 1 14 7.1v4.4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    </>
  ),
  tasks: (
    <>
      <path d="M5.5 4.5h8.5" />
      <path d="M5.5 8.5h8.5" />
      <path d="M5.5 12.5h8.5" />
      <path d="m1.8 4.4.9.9 1.6-1.7" />
      <path d="m1.8 8.4.9.9 1.6-1.7" />
      <path d="m1.8 12.4.9.9 1.6-1.7" />
    </>
  ),
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10.5" rx="1.5" />
      <path d="M2.5 6.5h11" />
      <path d="M5.5 2v2.5" />
      <path d="M10.5 2v2.5" />
    </>
  ),
  proposals: (
    <>
      <path d="M4 2.5h5.5L13 6v7.5A1 1 0 0 1 12 14.5H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
      <path d="M9.5 2.5V6H13" />
    </>
  ),
  invoices: (
    <>
      <path d="M3.5 2.5h9v12l-2-1.2-2 1.2-2-1.2-2 1.2z" />
      <path d="M6 6h4" />
      <path d="M6 9h4" />
    </>
  ),
  payments: (
    <>
      <rect x="1.8" y="4" width="12.4" height="8.5" rx="1.5" />
      <path d="M1.8 7h12.4" />
    </>
  ),
  expenses: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 5v6" />
      <path d="M6.2 6.6h3.2M6.2 9.4h3.6" />
    </>
  ),
  analytics: (
    <>
      <path d="M2.5 13.5V9" />
      <path d="M6.5 13.5V4.5" />
      <path d="M10.5 13.5v-6" />
      <path d="M14 13.5v-9" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" />
    </>
  ),
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="m10.6 10.6 3 3" />
    </>
  ),
  plus: (
    <>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </>
  ),
  bell: (
    <>
      <path d="M4.5 6.8a3.5 3.5 0 1 1 7 0c0 3 1 4.2 1 4.2h-9s1-1.2 1-4.2z" />
      <path d="M6.7 13.2a1.5 1.5 0 0 0 2.6 0" />
    </>
  ),
  check: (
    <>
      <path d="m3 8.5 3.2 3.2L13 5" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.6V8l2.2 1.4" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.6 14.2 13H1.8z" />
      <path d="M8 6.6v3M8 11.4h.01" />
    </>
  ),
  chevronRight: (
    <>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </>
  ),
  chevronLeft: (
    <>
      <path d="m10 3.5-4.5 4.5L10 12.5" />
    </>
  ),
  chevronDown: (
    <>
      <path d="m3.5 6 4.5 4.5L12.5 6" />
    </>
  ),
  menu: (
    <>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </>
  ),
  close: (
    <>
      <path d="m4 4 8 8M12 4l-8 8" />
    </>
  ),
  sparkle: (
    <>
      <path d="M8 2.2 9.4 6 13 7.4 9.4 8.8 8 12.6 6.6 8.8 3 7.4 6.6 6z" />
    </>
  ),
  building: (
    <>
      <rect x="3" y="2.5" width="10" height="11.5" rx="1.2" />
      <path d="M6 5.5h1.5M6 8h1.5M6 10.5h1.5M9.5 5.5H11M9.5 8H11M9.5 10.5H11" />
    </>
  ),
  archive: (
    <>
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3.2 6.5v6A1.5 1.5 0 0 0 4.7 14h6.6a1.5 1.5 0 0 0 1.5-1.5v-6" />
      <path d="M6.5 9h3" />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.3" />
      <path d="M5.8 7V5.3a2.2 2.2 0 0 1 4.4 0V7" />
    </>
  ),
};

export function Icon({
  name,
  className,
  size = 16,
}: {
  name: IconName;
  className?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
