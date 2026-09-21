"use client";

import { useFormStatus } from "react-dom";

import type { ActionResult } from "@/lib/crm/action-result";

/** Shared input styling so every CRM form looks consistent. */
const BASE_INPUT =
  "w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60";

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

  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      {errors?.length ? (
        <span id={errorId} className="block text-xs text-destructive">
          {errors.join(" ")}
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
      className={`${BASE_INPUT} ${invalid ? "border-destructive" : ""}`}
    />
  );
}

export function TextArea({
  name,
  defaultValue,
  rows = 3,
  invalid,
}: {
  name: string;
  defaultValue?: string | null;
  rows?: number;
  invalid?: boolean;
}) {
  return (
    <textarea
      name={name}
      rows={rows}
      defaultValue={defaultValue ?? ""}
      aria-invalid={invalid || undefined}
      className={`${BASE_INPUT} ${invalid ? "border-destructive" : ""}`}
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
      className={`${BASE_INPUT} ${invalid ? "border-destructive" : ""}`}
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
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="h-4 w-4 rounded border"
      />
      {label}
    </label>
  );
}

export function SubmitButton({
  children = "Save",
  variant = "primary",
}: {
  children?: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
}) {
  const { pending } = useFormStatus();

  const styles = {
    primary: "bg-primary text-primary-foreground",
    secondary: "border hover:bg-muted",
    danger: "border border-destructive/50 text-destructive hover:bg-destructive/10",
  }[variant];

  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md px-4 py-2 text-sm transition-colors disabled:opacity-60 ${styles}`}
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
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {state.message}
      </p>
    );
  }

  if (state.status === "success" && state.message) {
    return (
      <p
        role="status"
        className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
      >
        {state.message}
      </p>
    );
  }

  return null;
}

export function fieldErrors(state: ActionResult, name: string): string[] | undefined {
  return state.status === "error" ? state.fieldErrors[name] : undefined;
}
