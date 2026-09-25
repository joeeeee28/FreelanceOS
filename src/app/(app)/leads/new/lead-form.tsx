"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { createLeadAction, type CreateLeadState } from "./actions";
import { Icon } from "@/components/ui/domain";
import { buttonClass } from "@/components/ui/primitives";

interface FieldSpec {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  /** Spans both columns on wider screens. */
  wide?: boolean;
  textarea?: boolean;
}

/**
 * The form is grouped the way a freelancer actually researches a lead:
 * who they are, how to reach them, what their digital presence looks like,
 * what work there might be, and how promising it is.
 */
const SECTIONS: Array<{
  id: string;
  title: string;
  description: string;
  fields: FieldSpec[];
}> = [
  {
    id: "company",
    title: "Company",
    description: "The business you might work with. Only the name is required.",
    fields: [
      {
        name: "companyName",
        label: "Company name",
        required: true,
        placeholder: "Acme Design Studio",
      },
      { name: "industry", label: "Industry", placeholder: "Healthcare" },
      { name: "companySize", label: "Company size", placeholder: "11-50" },
      {
        name: "source",
        label: "Source",
        placeholder: "Referral",
        hint: "Where this lead came from.",
      },
      { name: "city", label: "City", placeholder: "Chennai" },
      { name: "country", label: "Country", placeholder: "India" },
    ],
  },
  {
    id: "contact",
    title: "Contact",
    description:
      "How you reach them. You can add more people, and mark a decision maker, after saving.",
    fields: [
      { name: "contactName", label: "Contact name", placeholder: "Priya Raman" },
      {
        name: "email",
        label: "Email",
        type: "email",
        placeholder: "priya@example.com",
      },
      { name: "phone", label: "Phone", placeholder: "+91 98765 43210" },
    ],
  },
  {
    id: "presence",
    title: "Digital presence",
    description:
      "Leave anything you have not checked blank — it stays Unknown rather than being guessed.",
    fields: [
      {
        name: "website",
        label: "Website",
        type: "url",
        placeholder: "https://example.com",
        hint: "A missing or weak website is a strong opportunity signal.",
      },
      {
        name: "linkedinUrl",
        label: "LinkedIn",
        type: "url",
        placeholder: "https://linkedin.com/company/example",
      },
      {
        name: "instagramUrl",
        label: "Instagram",
        type: "url",
        placeholder: "https://instagram.com/example",
      },
      {
        name: "facebookUrl",
        label: "Facebook",
        type: "url",
        placeholder: "https://facebook.com/example",
      },
    ],
  },
  {
    id: "opportunity",
    title: "Service opportunity",
    description: "What you could sell them, and why they would buy.",
    fields: [
      {
        name: "serviceInterest",
        label: "Service interest",
        placeholder: "Website redesign and local SEO",
        wide: true,
      },
      {
        name: "painPoint",
        label: "Pain point",
        placeholder: "Their site is not mobile friendly, so they lose enquiries.",
        wide: true,
        textarea: true,
      },
    ],
  },
];

const INITIAL_STATE: CreateLeadState = { status: "idle" };

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending || undefined}
      className={buttonClass("primary", "md")}
    >
      {pending ? "Saving…" : "Create lead"}
    </button>
  );
}

const CONTROL =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground " +
  "placeholder:text-subtle-foreground transition-colors hover:border-border-strong";

export function LeadForm() {
  const [state, formAction] = useActionState(createLeadAction, INITIAL_STATE);

  const fieldErrors = state.status === "error" ? state.fieldErrors : {};
  const values = state.status === "error" ? state.values : {};

  return (
    <form action={formAction} noValidate>
      {state.status === "error" ? (
        <div
          role="alert"
          className="mb-5 flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger"
        >
          <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
          <span>{state.message}</span>
        </div>
      ) : null}

      <div className="space-y-5">
        {SECTIONS.map((section) => (
          <section
            key={section.id}
            className="rounded-xl border border-border bg-surface shadow-xs"
          >
            <div className="border-b border-border px-4 py-3.5 sm:px-5">
              <h2 className="text-sm font-semibold tracking-tight">
                {section.title}
              </h2>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {section.description}
              </p>
            </div>

            <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
              {section.fields.map((field) => {
                const errors = fieldErrors[field.name];
                const errorId = `${field.name}-error`;
                const value = values[field.name as keyof typeof values] ?? "";

                return (
                  <label
                    key={field.name}
                    className={field.wide ? "sm:col-span-2" : undefined}
                  >
                    <span className="mb-1 block text-xs font-medium">
                      {field.label}
                      {field.required ? (
                        <span className="ml-0.5 text-danger" aria-hidden>
                          *
                        </span>
                      ) : (
                        <span className="ml-1.5 font-normal text-subtle-foreground">
                          Optional
                        </span>
                      )}
                    </span>

                    {field.textarea ? (
                      <textarea
                        name={field.name}
                        rows={4}
                        placeholder={field.placeholder}
                        defaultValue={value}
                        aria-invalid={errors ? true : undefined}
                        aria-describedby={errors ? errorId : undefined}
                        className={`${CONTROL} resize-y leading-relaxed ${
                          errors ? "border-danger" : ""
                        }`}
                      />
                    ) : (
                      <input
                        name={field.name}
                        type={field.type ?? "text"}
                        required={field.required}
                        placeholder={field.placeholder}
                        defaultValue={value}
                        aria-invalid={errors ? true : undefined}
                        aria-describedby={errors ? errorId : undefined}
                        className={`${CONTROL} ${errors ? "border-danger" : ""}`}
                      />
                    )}

                    {field.hint ? (
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        {field.hint}
                      </span>
                    ) : null}

                    {errors ? (
                      <span
                        id={errorId}
                        className="mt-1 flex items-start gap-1 text-xs font-medium text-danger"
                      >
                        <Icon name="alert" size={12} className="mt-px shrink-0" />
                        {errors.join(" ")}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </section>
        ))}

        {/* Qualification is explained rather than asked for: the score is
            computed server-side, and the detailed questions live on the lead
            page where they can be researched over time. */}
        <section className="rounded-xl border border-border bg-surface-muted p-4 sm:p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Icon name="sparkle" size={14} className="text-accent" />
            Qualification
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            A lead score out of 100 is calculated on the server from what you
            record — never guessed, and never editable by hand. Filling in the
            service interest, pain point and a decision maker raises it most.
            You can complete the full qualification, including website quality
            and advertising activity, from the lead&rsquo;s Intelligence tab
            after saving.
          </p>
        </section>
      </div>

      {/* Sticky footer keeps the primary action reachable on a long form.
          `sticky` rather than `fixed` so it tracks the content column and
          stays correct whether the sidebar is expanded or collapsed. */}
      <div className="sticky bottom-0 z-30 mt-5 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <p className="text-xs text-muted-foreground">
          Only the company name is required.
        </p>

        <div className="flex items-center gap-2">
          <Link href="/leads" className={buttonClass("ghost", "md")}>
            Cancel
          </Link>
          <SubmitButton />
        </div>
      </div>
    </form>
  );
}
