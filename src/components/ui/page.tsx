import type { ReactNode } from "react";

import { cn } from "./primitives";

/** Standard page header: title, supporting line, and primary actions. */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn("mb-6 flex flex-wrap items-start justify-between gap-4", className)}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
        {meta ? <div className="mt-2.5">{meta}</div> : null}
      </div>

      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

/** Consistent vertical rhythm between page sections. */
export function PageSections({ children }: { children: ReactNode }) {
  return <div className="space-y-6">{children}</div>;
}
