import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/** Joins class names, dropping falsy entries. */
export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ button */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "accent";
export type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium " +
  "transition-colors disabled:pointer-events-none disabled:opacity-50 " +
  "whitespace-nowrap";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs",
  accent: "bg-accent text-accent-foreground hover:bg-accent/90 shadow-xs",
  secondary:
    "border border-border bg-surface text-foreground hover:bg-muted shadow-xs",
  ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
  danger:
    "border border-danger/30 bg-surface text-danger hover:bg-danger-subtle shadow-xs",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-xs",
  md: "h-9 px-3.5 text-sm",
};

export function buttonClass(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  extra?: string,
) {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], extra);
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      {...props}
      className={buttonClass(variant, size, className)}
      // Defaulting to "button" avoids accidental form submits; callers that
      // want a submit pass type explicitly.
      type={props.type ?? "button"}
    />
  );
}

export function LinkButton({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return <Link {...props} className={buttonClass(variant, size, className)} />;
}

/* -------------------------------------------------------------------- card */

export function Card({
  className,
  children,
  as: Tag = "section",
}: {
  className?: string;
  children: ReactNode;
  as?: "section" | "div" | "article";
}) {
  return (
    <Tag
      className={cn(
        "rounded-xl border border-border bg-surface shadow-xs",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("p-4 sm:p-5", className)}>{children}</div>;
}

/* ------------------------------------------------------------------- badge */

export type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground ring-border",
  accent: "bg-accent-subtle text-accent ring-accent/20",
  success: "bg-success-subtle text-success ring-success/20",
  warning: "bg-warning-subtle text-warning ring-warning/20",
  danger: "bg-danger-subtle text-danger ring-danger/20",
  info: "bg-info-subtle text-info ring-info/20",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  uppercase,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  uppercase?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium ring-1 ring-inset",
        BADGE_TONES[tone],
        uppercase && "uppercase tracking-wide",
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------- empty state */

/**
 * Empty states are a first-class part of this product: an empty database must
 * look intentional, never broken or blank.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-muted text-center",
        compact ? "px-4 py-8" : "px-6 py-14",
      )}
    >
      {icon ? (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface text-muted-foreground">
          {icon}
        </div>
      ) : null}

      <p className="text-sm font-semibold text-foreground">{title}</p>

      {description ? (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}

      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- data bits */

/** A labelled value. Renders an explicit "Unknown" rather than a blank. */
export function Field({
  label,
  value,
  unknownLabel = "Unknown",
  className,
}: {
  label: string;
  value?: ReactNode;
  unknownLabel?: string;
  className?: string;
}) {
  const isEmpty =
    value === null ||
    value === undefined ||
    value === "" ||
    (typeof value === "string" && value.trim() === "");

  return (
    <div className={className}>
      <dt className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 break-words text-sm",
          isEmpty ? "text-subtle-foreground" : "text-foreground",
        )}
      >
        {isEmpty ? unknownLabel : value}
      </dd>
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/** Horizontal rule used between stacked rows inside a card. */
export function Divider() {
  return <div className="h-px bg-border" role="presentation" />;
}
