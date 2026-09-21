import Link from "next/link";
import type { ReactNode } from "react";

import { Icon } from "@/components/ui/domain";
import { Button, cn } from "@/components/ui/primitives";

/**
 * Filters are a plain GET form.
 *
 * State lives in the URL, filtering happens on the server, and the page works
 * without JavaScript. No client-side filter state is kept anywhere.
 */
export function FilterBar({
  children,
  active,
  clearHref,
  className,
}: {
  children: ReactNode;
  /** True when at least one filter is applied, to show the Clear link. */
  active?: boolean;
  clearHref: string;
  className?: string;
}) {
  return (
    <form
      method="GET"
      className={cn(
        "rounded-xl border border-border bg-surface p-3 shadow-xs sm:p-4",
        className,
      )}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        {children}
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        <Button type="submit" variant="primary" size="sm">
          Apply
        </Button>

        {active ? (
          <Link
            href={clearHref}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Icon name="close" size={12} />
            Clear filters
          </Link>
        ) : null}
      </div>
    </form>
  );
}

const CONTROL =
  "h-9 w-full rounded-md border border-border bg-surface px-2.5 text-sm text-foreground " +
  "placeholder:text-subtle-foreground hover:border-border-strong";

/** Labelled text input inside a filter bar. */
export function FilterInput({
  label,
  name,
  defaultValue,
  placeholder,
  type = "text",
  min,
  max,
  className,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  type?: "text" | "number" | "search";
  min?: number;
  max?: number;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
        {label}
      </span>
      <input
        name={name}
        type={type}
        min={min}
        max={max}
        defaultValue={defaultValue ?? ""}
        placeholder={placeholder}
        className={CONTROL}
      />
    </label>
  );
}

/** Labelled select inside a filter bar. */
export function FilterSelect({
  label,
  name,
  defaultValue,
  options,
  placeholder,
  className,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  options: Array<{ value: string; label: string }>;
  /** Label for the empty "no filter" option. Omit to require a choice. */
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
        {label}
      </span>
      <select
        name={name}
        defaultValue={defaultValue ?? ""}
        className={cn(CONTROL, "pr-8")}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
