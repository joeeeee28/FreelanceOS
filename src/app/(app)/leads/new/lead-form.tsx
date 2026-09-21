"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { createLeadAction, type CreateLeadState } from "./actions";

const FIELDS: Array<{ name: string; label: string; type?: string; required?: boolean }> = [
  { name: "companyName", label: "Company", required: true },
  { name: "contactName", label: "Contact" },
  { name: "email", label: "Email", type: "email" },
  { name: "phone", label: "Phone" },
  { name: "website", label: "Website", type: "url" },
  { name: "country", label: "Country" },
  { name: "city", label: "City" },
  { name: "industry", label: "Industry" },
  { name: "companySize", label: "Company Size" },
  { name: "linkedinUrl", label: "LinkedIn", type: "url" },
  { name: "instagramUrl", label: "Instagram", type: "url" },
  { name: "facebookUrl", label: "Facebook", type: "url" },
  { name: "serviceInterest", label: "Service Interest" },
  { name: "source", label: "Source" },
];

const INITIAL_STATE: CreateLeadState = { status: "idle" };

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-60"
    >
      {pending ? "Saving…" : "Create Lead"}
    </button>
  );
}

export function LeadForm() {
  const [state, formAction] = useActionState(createLeadAction, INITIAL_STATE);

  const fieldErrors = state.status === "error" ? state.fieldErrors : {};
  const values = state.status === "error" ? state.values : {};

  return (
    <form action={formAction} className="mt-6 space-y-5" noValidate>
      {state.status === "error" ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {state.message}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((field) => {
          const errors = fieldErrors[field.name];
          const errorId = `${field.name}-error`;

          return (
            <label key={field.name} className="space-y-1">
              <span className="text-sm font-medium">
                {field.label}
                {field.required ? " *" : ""}
              </span>

              <input
                name={field.name}
                type={field.type ?? "text"}
                required={field.required}
                defaultValue={values[field.name as keyof typeof values] ?? ""}
                aria-invalid={errors ? true : undefined}
                aria-describedby={errors ? errorId : undefined}
                className={`w-full rounded-md border bg-background px-3 py-2 ${
                  errors ? "border-destructive" : ""
                }`}
              />

              {errors ? (
                <span id={errorId} className="block text-xs text-destructive">
                  {errors.join(" ")}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Pain Point</span>
        <textarea
          name="painPoint"
          rows={5}
          defaultValue={values.painPoint ?? ""}
          aria-invalid={fieldErrors.painPoint ? true : undefined}
          className={`w-full rounded-md border bg-background px-3 py-2 ${
            fieldErrors.painPoint ? "border-destructive" : ""
          }`}
        />
        {fieldErrors.painPoint ? (
          <span className="block text-xs text-destructive">
            {fieldErrors.painPoint.join(" ")}
          </span>
        ) : null}
      </label>

      <SubmitButton />
    </form>
  );
}
