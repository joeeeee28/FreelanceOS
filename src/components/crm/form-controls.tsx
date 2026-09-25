"use client";

import { useFormStatus } from "react-dom";

import type { ActionResult } from "@/lib/crm/action-result";
import { Icon } from "@/components/ui/domain";
import { buttonClass, cn } from "@/components/ui/primitives";

/**
 * Shared control styling so every CRM form looks consistent.
 *
 * The public API of this module is unchanged — only the presentation is.
 */
const BASE_INPUT =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground " +
  "placeholder:text-subtle-foreground transition-colors hover:border-border-strong " +
  "disabled:cursor-not-allowed disabled:opacity-60";

const INVALID_INPUT = "border-danger hover:border-danger";

export function Field({
  label,
  name,
  errors,
  children,
  hint,
}: {
  label: string;
  name: string;
  errors?: string[];
  children: React.ReactNode;
  hint?: string;
}) {
  const errorId = `${name}-error`;
  const hasErrors = Boolean(errors?.length);

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-foreground">
        {label}
      </span>

      {children}

      {/* Hint stays visible next to the error so the user keeps the guidance. */}
      {hint ? (
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {hint}
        </span>
      ) : null}

      {hasErrors ? (
        <span
          id={errorId}
          className="mt-1 flex items-start gap-1 text-xs font-medium text-danger"
        >
          <Icon name="alert" size={12} className="mt-px shrink-0" />
          {errors!.join(" ")}
        </span>
      ) : null}
    </label>
  );
}

export function TextInput({
  name,
  defaultValue,
  type = "text",
  required,
  placeholder,
  invalid,
}: {
  name: string;
  defaultValue?: string | null;
  type?: string;
  required?: boolean;
  placeholder?: string;
  invalid?: boolean;
}) {
  return (
    <input
      name={name}
      type={type}
      required={required}
      placeholder={placeholder}
      defaultValue={defaultValue ?? ""}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${name}-error` : undefined}
      className={cn(BASE_INPUT, invalid && INVALID_INPUT)}
    />
  );
}

export function TextArea({
  name,
  defaultValue,
  rows = 3,
  invalid,
  placeholder,
}: {
  name: string;
  defaultValue?: string | null;
  rows?: number;
  invalid?: boolean;
  placeholder?: string;
}) {
  return (
    <textarea
      name={name}
      rows={rows}
      placeholder={placeholder}
      defaultValue={defaultValue ?? ""}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${name}-error` : undefined}
      className={cn(BASE_INPUT, "resize-y leading-relaxed", invalid && INVALID_INPUT)}
    />
  );
}

export function Select({
  name,
  defaultValue,
  options,
  invalid,
}: {
  name: string;
  defaultValue?: string | null;
  options: Array<{ value: string; label: string }>;
  invalid?: boolean;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue ?? ""}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${name}-error` : undefined}
      className={cn(BASE_INPUT, "pr-8", invalid && INVALID_INPUT)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({
  name,
  label,
  defaultChecked,
  hint,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5 transition-colors hover:border-border-strong">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-[hsl(var(--accent))]"
      />
      <span>
        <span className="block text-sm text-foreground">{label}</span>
        {hint ? (
          <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}

export function SubmitButton({
  children = "Save",
  variant = "primary",
  size = "md",
}: {
  children?: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md";
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      // aria-busy tells assistive tech the control is working, since the
      // label change alone is not announced reliably.
      aria-busy={pending || undefined}
      className={buttonClass(variant, size)}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

/** Renders the success/error banner for an action result. */
export function FormStatus({ state }: { state: ActionResult }) {
  if (state.status === "error") {
    return (
      <p
        role="alert"
        className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger"
      >
        <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
        {state.message}
      </p>
    );
  }

  if (state.status === "success" && state.message) {
    return (
      <p
        role="status"
        className="flex items-start gap-2 rounded-md border border-success/30 bg-success-subtle px-3 py-2 text-sm text-success"
      >
        <Icon name="check" size={14} className="mt-0.5 shrink-0" />
        {state.message}
      </p>
    );
  }

  return null;
}

export function fieldErrors(state: ActionResult, name: string): string[] | undefined {
  return state.status === "error" ? state.fieldErrors[name] : undefined;
}
