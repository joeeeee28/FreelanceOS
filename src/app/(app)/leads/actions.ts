"use server";

import { revalidatePath } from "next/cache";
import type { LeadStatus } from "@prisma/client";

import {
  addLeadNote,
  archiveLead,
  moveLead,
  restoreLead,
  updateLead,
  updateQualification,
} from "@/lib/crm/leads";
import { createContact, updateContact } from "@/lib/crm/contacts";
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
} from "@/lib/crm/follow-ups";
import { cancelTask, completeTask, createTask } from "@/lib/crm/tasks";
import { runAction, type ActionResult } from "@/lib/crm/action-result";

/**
 * Server actions for the lead workspace.
 *
 * Each one is a thin, safe boundary: it reads the form, delegates to the CRM
 * service (which performs authentication, workspace authorisation, validation,
 * the transaction and activity creation), then revalidates the affected pages.
 * No business rule lives here.
 */

/** Reads a trimmed string, or undefined when the field was left blank. */
function text(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** HTML checkboxes submit "on" when ticked and nothing when unticked. */
function checkbox(formData: FormData, key: string): boolean {
  return formData.get(key) === "on" || formData.get(key) === "true";
}

/** Tri-state select: "" (unknown) / "true" / "false". */
function triState(formData: FormData, key: string): boolean | null {
  const value = formData.get(key);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function refreshLead(leadId: string) {
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/pipeline");
  revalidatePath("/dashboard");
}

const LEAD_TEXT_FIELDS = [
  "companyName",
  "contactName",
  "source",
  "website",
  "email",
  "phone",
  "country",
  "city",
  "industry",
  "companySize",
  "linkedinUrl",
  "instagramUrl",
  "facebookUrl",
  "serviceInterest",
  "painPoint",
] as const;

export async function updateLeadAction(
  leadId: string,
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const patch: Record<string, unknown> = {};

  for (const field of LEAD_TEXT_FIELDS) {
    // Send every field so clearing one actually clears it, but use null
    // rather than "" so optional URL/email rules are not triggered by blanks.
    patch[field] = text(formData, field) ?? null;
  }

  // companyName is required; never null it out.
  if (patch.companyName === null) delete patch.companyName;

  const result = await runAction(
    "updateLead",
    () => updateLead(leadId, stripNulls(patch)),
    "Lead updated.",
  );

  if (result.status === "success") refreshLead(leadId);
  return result;
}

export async function updateQualificationAction(
  leadId: string,
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const result = await runAction(
    "updateQualification",
    () =>
      updateQualification(leadId, {
        decisionMakerIdentified: checkbox(formData, "decisionMakerIdentified"),
        websitePresent: triState(formData, "websitePresent"),
        websiteQuality: text(formData, "websiteQuality"),
        advertisingActivity: text(formData, "advertisingActivity"),
        contentActivity: text(formData, "contentActivity"),
        serviceInterest: text(formData, "serviceInterest"),
        painPoint: text(formData, "painPoint"),
        qualificationNotes: text(formData, "qualificationNotes"),
      }),
    "Qualification saved.",
  );

  if (result.status === "success") refreshLead(leadId);
  return result;
}

export async function moveLeadAction(
  leadId: string,
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const status = text(formData, "status");

  const result = await runAction(
    "moveLead",
    // The service validates the transition; an unknown value is rejected
    // there rather than trusted here.
    () => moveLead(leadId, status as LeadStatus),
    "Status updated.",
  );

  if (result.status === "success") refreshLead(leadId);
  return result;
}

export async function archiveLeadAction(
  leadId: string,
  _previous: ActionResult,
): Promise<ActionResult> {
  const result = await runAction("archiveLead", () => archiveLead(leadId), "Lead archived.");
  if (result.status === "success") refreshLead(leadId);
  return result;
}

export async function restoreLeadAction(
  leadId: string,
  _previous: ActionResult,
): Promise<ActionResult> {
  const result = await runAction("restoreLead", () => restoreLead(leadId), "Lead restored.");
  if (result.status === "success") refreshLead(leadId);
  return result;
}

export async function addNoteAction(
  leadId: string,
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const result = await runAction(
    "addLeadNote",
    () => addLeadNote(leadId, { body: formData.get("body") ?? "" }),
    "Note added.",
  );

  if (result.status === "success") refreshLead(leadId);
  return result;
}

export async function createContactAction(
  leadId: string,
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const result = await runAction(
    "createContact",
    () =>
      createContact({
        leadId,
        fullName: text(formData, "fullName") ?? "",
        firstName: text(formData, "firstName"),
        lastName: text(formData, "lastName"),
        jobTitle: text(formData, "jobTitle"),
        email: text(formData, "email"),
        phone: text(formData, "phone"),
        linkedinUrl: text(formData, "linkedinUrl"),
        isDecisionMaker: checkbox(formData, "isDecisionMaker"),
        isPrimary: checkbox(formData, "isPrimary"),
        notes: text(formData, "notes"),
      }),
    "Contact added.",
  );

  if (result.status === "success") refreshLead(leadId);
  return result;
}

export async function updateContactAction(
  leadId: string,
  contactId: string,
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const result = await runAction(
    "updateContact",
    () =>
      updateContact(contactId, {
        fullName: text(formData, "fullName") ?? "",
        firstName: text(formData, "firstName"),
        lastName: text(formData, "lastName"),
        jobTitle: text(formData, "jobTitle"),
        email: text(formData, "email"),
        phone: text(formData, "phone"),
        linkedinUrl: text(formData, "linkedinUrl"),
        isDecisionMaker: checkbox(formData, "isDecisionMaker"),
        isPrimary: checkbox(formData, "isPrimary"),
        notes: text(formData, "notes"),
      }),
    "Contact updated.",
  );

  if (result.status === "success") refreshLead(leadId);
  return result;
}

export async function createTaskAction(
  leadId: string | null,
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const dueAt = text(formData, "dueAt");

  const result = await runAction(
    "createTask",
    () =>
      createTask({
        title: text(formData, "title") ?? "",
        description: text(formData, "description"),
        priority: text(formData, "priority") ?? "MEDIUM",
        status: text(formData, "status") ?? "TODO",
        dueAt: dueAt ? new Date(dueAt) : null,
        leadId: leadId ?? text(formData, "leadId") ?? null,
        contactId: text(formData, "contactId") ?? null,
      }),
    "Task created.",
  );

  if (result.status === "success") {
    if (leadId) refreshLead(leadId);
    revalidatePath("/tasks");
    revalidatePath("/dashboard");
  }

  return result;
}

export async function completeTaskAction(
  taskId: string,
  _previous: ActionResult,
): Promise<ActionResult> {
  const result = await runAction("completeTask", () => completeTask(taskId), "Task completed.");

  if (result.status === "success") {
    revalidatePath("/tasks");
    revalidatePath("/dashboard");
    revalidatePath("/leads");
  }

  return result;
}

export async function cancelTaskAction(
  taskId: string,
  _previous: ActionResult,
): Promise<ActionResult> {
  const result = await runAction("cancelTask", () => cancelTask(taskId), "Task cancelled.");

  if (result.status === "success") {
    revalidatePath("/tasks");
    revalidatePath("/dashboard");
  }

  return result;
}

export async function createFollowUpAction(
  leadId: string,
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const scheduledAt = text(formData, "scheduledAt");

  const result = await runAction(
    "createFollowUp",
    () =>
      createFollowUp({
        leadId,
        contactId: text(formData, "contactId") ?? null,
        channel: text(formData, "channel") ?? "EMAIL",
        sequence: text(formData, "sequence") ?? "INITIAL",
        // datetime-local submits workspace-local wall time; the browser field
        // is rendered in the workspace zone, so this preserves the intent.
        scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
        message: text(formData, "message"),
      }),
    "Follow-up scheduled.",
  );

  if (result.status === "success") {
    refreshLead(leadId);
    revalidatePath("/follow-ups");
  }

  return result;
}

export async function completeFollowUpAction(
  followUpId: string,
  _previous: ActionResult,
): Promise<ActionResult> {
  const result = await runAction(
    "completeFollowUp",
    () => completeFollowUp(followUpId),
    "Follow-up completed.",
  );

  if (result.status === "success") {
    revalidatePath("/follow-ups");
    revalidatePath("/dashboard");
    revalidatePath("/leads");
  }

  return result;
}

export async function cancelFollowUpAction(
  followUpId: string,
  _previous: ActionResult,
): Promise<ActionResult> {
  const result = await runAction(
    "cancelFollowUp",
    () => cancelFollowUp(followUpId),
    "Follow-up cancelled.",
  );

  if (result.status === "success") {
    revalidatePath("/follow-ups");
    revalidatePath("/dashboard");
  }

  return result;
}

/** Drops null entries so a partial update only touches submitted fields. */
function stripNulls(patch: Record<string, unknown>) {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(patch)) {
    // null means "clear this field"; Prisma accepts null for nullable columns.
    result[key] = value === null ? null : value;
  }

  return result;
}
