"use server";

import { redirect } from "next/navigation";
import { ZodError } from "zod";

import { createLead } from "@/lib/crm/leads";
import { fieldErrorsFrom, type FieldErrors } from "@/lib/validation/field-errors";

export type CreateLeadState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors: FieldErrors; values: LeadFormValues };

/** Field names the new-lead form posts. */
const TEXT_FIELDS = [
  "companyName",
  "contactName",
  "email",
  "phone",
  "website",
  "country",
  "city",
  "industry",
  "companySize",
  "linkedinUrl",
  "instagramUrl",
  "facebookUrl",
  "serviceInterest",
  "painPoint",
  "source",
] as const;

export type LeadFormValues = Partial<Record<(typeof TEXT_FIELDS)[number], string>>;

function readFormValues(formData: FormData): LeadFormValues {
  const values: LeadFormValues = {};

  for (const field of TEXT_FIELDS) {
    const raw = formData.get(field);
    if (typeof raw === "string" && raw.trim() !== "") {
      values[field] = raw.trim();
    }
  }

  return values;
}

export async function createLeadAction(
  _previousState: CreateLeadState,
  formData: FormData,
): Promise<CreateLeadState> {
  // Re-read the submitted values first so they can be echoed back to the user
  // on failure instead of wiping the form.
  const values = readFormValues(formData);
  let leadId: string;

  try {
    // Empty optional fields are omitted entirely (rather than sent as "") so
    // `.url()`/`.email()` only run against values the user actually filled in.
    const lead = await createLead(values);
    leadId = lead.id;
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        status: "error",
        message: "Please correct the highlighted fields.",
        fieldErrors: fieldErrorsFrom(error),
        values,
      };
    }

    // Anything else is a genuine server-side fault. It is logged without the
    // submitted payload and reported to the user without internals.
    console.error("[leads] create failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });

    return {
      status: "error",
      message: "We could not save this lead. Please try again.",
      fieldErrors: {},
      values,
    };
  }

  // redirect() signals via a thrown control-flow error, so it must run outside
  // the try block — otherwise the catch would swallow a successful navigation.
  redirect(`/leads/${leadId}`);
}
