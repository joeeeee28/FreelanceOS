"use client";

import { useActionState, useState } from "react";
import type { LeadStatus } from "@prisma/client";

import {
  addNoteAction,
  archiveLeadAction,
  cancelFollowUpAction,
  cancelTaskAction,
  completeFollowUpAction,
  completeTaskAction,
  createContactAction,
  createFollowUpAction,
  createTaskAction,
  moveLeadAction,
  restoreLeadAction,
  updateContactAction,
  updateLeadAction,
  updateQualificationAction,
} from "@/app/(app)/leads/actions";
import { IDLE, type ActionResult } from "@/lib/crm/action-result";
import {
  Checkbox,
  Field,
  FormStatus,
  Select,
  SubmitButton,
  TextArea,
  TextInput,
  fieldErrors,
} from "./form-controls";

function humanise(value: string) {
  const lower = value.replaceAll("_", " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Collapsible wrapper so the lead page is not a wall of forms. */
function Disclosure({
  label,
  children,
  open = false,
}: {
  label: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(open);

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        aria-expanded={isOpen}
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
      >
        {isOpen ? "Cancel" : label}
      </button>
      {isOpen ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ status */

export function StatusControl({
  leadId,
  current,
  allowed,
}: {
  leadId: string;
  current: LeadStatus;
  allowed: LeadStatus[];
}) {
  const [state, formAction] = useActionState(
    moveLeadAction.bind(null, leadId),
    IDLE as ActionResult,
  );

  if (allowed.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {humanise(current)} is a final stage.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <div className="min-w-[12rem] flex-1">
        <Field label="Move to" name="status">
          <Select
            name="status"
            defaultValue={allowed[0]}
            options={allowed.map((status) => ({
              value: status,
              label: humanise(status),
            }))}
          />
        </Field>
      </div>
      <SubmitButton>Update status</SubmitButton>
      <div className="w-full">
        <FormStatus state={state} />
      </div>
    </form>
  );
}

/* -------------------------------------------------------------- edit lead */

const EDIT_FIELDS: Array<{ name: string; label: string; type?: string }> = [
  { name: "companyName", label: "Company" },
  { name: "contactName", label: "Contact name" },
  { name: "email", label: "Email", type: "email" },
  { name: "phone", label: "Phone" },
  { name: "website", label: "Website", type: "url" },
  { name: "source", label: "Source" },
  { name: "country", label: "Country" },
  { name: "city", label: "City" },
  { name: "industry", label: "Industry" },
  { name: "companySize", label: "Company size" },
  { name: "linkedinUrl", label: "LinkedIn", type: "url" },
  { name: "instagramUrl", label: "Instagram", type: "url" },
  { name: "facebookUrl", label: "Facebook", type: "url" },
  { name: "serviceInterest", label: "Service interest" },
];

export function EditLeadPanel({
  leadId,
  lead,
}: {
  leadId: string;
  lead: Record<string, string | null>;
}) {
  const [state, formAction] = useActionState(
    updateLeadAction.bind(null, leadId),
    IDLE as ActionResult,
  );

  return (
    <Panel title="Lead details">
      <Disclosure label="Edit details">
        <form action={formAction} className="space-y-4" noValidate>
          <FormStatus state={state} />

          <div className="grid gap-4 sm:grid-cols-2">
            {EDIT_FIELDS.map((field) => (
              <Field
                key={field.name}
                label={field.label}
                name={field.name}
                errors={fieldErrors(state, field.name)}
              >
                <TextInput
                  name={field.name}
                  type={field.type}
                  required={field.name === "companyName"}
                  defaultValue={lead[field.name] ?? ""}
                  invalid={Boolean(fieldErrors(state, field.name))}
                />
              </Field>
            ))}
          </div>

          <Field label="Pain point" name="painPoint" errors={fieldErrors(state, "painPoint")}>
            <TextArea name="painPoint" defaultValue={lead.painPoint} rows={4} />
          </Field>

          <SubmitButton>Save changes</SubmitButton>
        </form>
      </Disclosure>
    </Panel>
  );
}

/* ----------------------------------------------------------- qualification */

const WEBSITE_QUALITY_OPTIONS = [
  { value: "", label: "Not assessed" },
  { value: "Poor", label: "Poor" },
  { value: "Basic", label: "Basic" },
  { value: "Needs work", label: "Needs work" },
  { value: "Good", label: "Good" },
  { value: "Excellent", label: "Excellent" },
];

export function QualificationPanel({
  leadId,
  lead,
  scoreReasons,
  score,
}: {
  leadId: string;
  lead: {
    decisionMakerIdentified: boolean;
    websitePresent: boolean | null;
    websiteQuality: string | null;
    advertisingActivity: string | null;
    contentActivity: string | null;
    serviceInterest: string | null;
    painPoint: string | null;
    qualificationNotes: string | null;
  };
  score: number;
  scoreReasons: Array<{ label: string; points: number }>;
}) {
  const [state, formAction] = useActionState(
    updateQualificationAction.bind(null, leadId),
    IDLE as ActionResult,
  );

  return (
    <Panel title="Qualification">
      <div className="mb-5 rounded-lg bg-muted/50 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">Lead score</span>
          <span className="text-2xl font-semibold">{score}/100</span>
        </div>

        {scoreReasons.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No scoring signals yet. Complete the qualification below to build a score.
          </p>
        ) : (
          <ul className="mt-3 space-y-1">
            {scoreReasons.map((reason) => (
              <li key={reason.label} className="flex justify-between text-sm">
                <span className="text-muted-foreground">{reason.label}</span>
                <span className="font-medium">+{reason.points}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form action={formAction} className="space-y-4" noValidate>
        <FormStatus state={state} />

        <Checkbox
          name="decisionMakerIdentified"
          label="Decision maker identified"
          defaultChecked={lead.decisionMakerIdentified}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Website present" name="websitePresent">
            <Select
              name="websitePresent"
              defaultValue={
                lead.websitePresent === null ? "" : String(lead.websitePresent)
              }
              options={[
                { value: "", label: "Not researched" },
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ]}
            />
          </Field>

          <Field label="Website quality" name="websiteQuality">
            <Select
              name="websiteQuality"
              defaultValue={lead.websiteQuality ?? ""}
              options={WEBSITE_QUALITY_OPTIONS}
            />
          </Field>

          <Field label="Advertising activity" name="advertisingActivity">
            <TextInput
              name="advertisingActivity"
              defaultValue={lead.advertisingActivity}
              placeholder="e.g. Running Meta ads"
            />
          </Field>

          <Field label="Content activity" name="contentActivity">
            <TextInput
              name="contentActivity"
              defaultValue={lead.contentActivity}
              placeholder="e.g. Weekly blog"
            />
          </Field>

          <Field
            label="Service interest"
            name="serviceInterest"
            errors={fieldErrors(state, "serviceInterest")}
          >
            <TextInput name="serviceInterest" defaultValue={lead.serviceInterest} />
          </Field>
        </div>

        <Field label="Pain point" name="painPoint">
          <TextArea name="painPoint" defaultValue={lead.painPoint} />
        </Field>

        <Field label="Qualification notes" name="qualificationNotes">
          <TextArea name="qualificationNotes" defaultValue={lead.qualificationNotes} rows={4} />
        </Field>

        <SubmitButton>Save qualification</SubmitButton>
      </form>
    </Panel>
  );
}

/* --------------------------------------------------------------- contacts */

export function ContactsPanel({
  leadId,
  contacts,
}: {
  leadId: string;
  contacts: Array<{
    id: string;
    fullName: string;
    jobTitle: string | null;
    email: string | null;
    phone: string | null;
    linkedinUrl: string | null;
    isDecisionMaker: boolean;
    isPrimary: boolean;
    notes: string | null;
  }>;
}) {
  const [state, formAction] = useActionState(
    createContactAction.bind(null, leadId),
    IDLE as ActionResult,
  );

  return (
    <Panel title={`Contacts (${contacts.length})`}>
      {contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No contacts yet. Add the person who can approve the work.
        </p>
      ) : (
        <ul className="mb-5 space-y-3">
          {contacts.map((contact) => (
            <li key={contact.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{contact.fullName}</span>
                {contact.isPrimary ? <Badge>Primary</Badge> : null}
                {contact.isDecisionMaker ? <Badge>Decision maker</Badge> : null}
              </div>

              <p className="mt-1 text-sm text-muted-foreground">
                {[contact.jobTitle, contact.email, contact.phone]
                  .filter(Boolean)
                  .join(" · ") || "No contact details"}
              </p>

              <div className="mt-3">
                <EditContactForm leadId={leadId} contact={contact} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <Disclosure label="Add contact">
        <form action={formAction} className="space-y-4" noValidate>
          <FormStatus state={state} />
          <ContactFields state={state} />
          <SubmitButton>Add contact</SubmitButton>
        </form>
      </Disclosure>
    </Panel>
  );
}

function EditContactForm({
  leadId,
  contact,
}: {
  leadId: string;
  contact: {
    id: string;
    fullName: string;
    jobTitle: string | null;
    email: string | null;
    phone: string | null;
    linkedinUrl: string | null;
    isDecisionMaker: boolean;
    isPrimary: boolean;
    notes: string | null;
  };
}) {
  const [state, formAction] = useActionState(
    updateContactAction.bind(null, leadId, contact.id),
    IDLE as ActionResult,
  );

  return (
    <Disclosure label="Edit">
      <form action={formAction} className="space-y-4" noValidate>
        <FormStatus state={state} />
        <ContactFields state={state} contact={contact} />
        <SubmitButton>Save contact</SubmitButton>
      </form>
    </Disclosure>
  );
}

function ContactFields({
  state,
  contact,
}: {
  state: ActionResult;
  contact?: {
    fullName: string;
    jobTitle: string | null;
    email: string | null;
    phone: string | null;
    linkedinUrl: string | null;
    isDecisionMaker: boolean;
    isPrimary: boolean;
    notes: string | null;
  };
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" name="fullName" errors={fieldErrors(state, "fullName")}>
          <TextInput
            name="fullName"
            required
            defaultValue={contact?.fullName}
            invalid={Boolean(fieldErrors(state, "fullName"))}
          />
        </Field>

        <Field label="Job title" name="jobTitle">
          <TextInput name="jobTitle" defaultValue={contact?.jobTitle} />
        </Field>

        <Field label="Email" name="email" errors={fieldErrors(state, "email")}>
          <TextInput
            name="email"
            type="email"
            defaultValue={contact?.email}
            invalid={Boolean(fieldErrors(state, "email"))}
          />
        </Field>

        <Field label="Phone" name="phone">
          <TextInput name="phone" defaultValue={contact?.phone} />
        </Field>

        <Field label="LinkedIn" name="linkedinUrl" errors={fieldErrors(state, "linkedinUrl")}>
          <TextInput
            name="linkedinUrl"
            type="url"
            defaultValue={contact?.linkedinUrl}
            invalid={Boolean(fieldErrors(state, "linkedinUrl"))}
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-4">
        <Checkbox
          name="isDecisionMaker"
          label="Decision maker"
          defaultChecked={contact?.isDecisionMaker}
        />
        <Checkbox name="isPrimary" label="Primary contact" defaultChecked={contact?.isPrimary} />
      </div>

      <Field label="Notes" name="notes">
        <TextArea name="notes" defaultValue={contact?.notes} />
      </Field>
    </>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
      {children}
    </span>
  );
}

/* ------------------------------------------------------------- follow-ups */

const CHANNELS = [
  "EMAIL",
  "LINKEDIN",
  "INSTAGRAM",
  "FACEBOOK",
  "WHATSAPP",
  "PHONE",
  "UPWORK",
  "FIVERR",
  "CONTRA",
  "COLD_EMAIL",
  "REFERRAL",
  "OTHER",
];

const SEQUENCES = ["INITIAL", "FU1", "FU2", "FU3", "NURTURE"];

export function FollowUpsPanel({
  leadId,
  followUps,
  contacts,
  formatDateTime,
  defaultScheduledAt,
}: {
  leadId: string;
  followUps: Array<{
    id: string;
    channel: string;
    sequence: string;
    status: string;
    scheduledAt: Date;
    message: string | null;
  }>;
  contacts: Array<{ id: string; fullName: string }>;
  formatDateTime: (value: Date) => string;
  defaultScheduledAt: string;
}) {
  const [state, formAction] = useActionState(
    createFollowUpAction.bind(null, leadId),
    IDLE as ActionResult,
  );

  return (
    <Panel title={`Follow-ups (${followUps.length})`}>
      {followUps.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing scheduled yet.</p>
      ) : (
        <ul className="mb-5 space-y-2">
          {followUps.map((followUp) => (
            <li
              key={followUp.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div>
                <p className="text-sm font-medium">
                  {humanise(followUp.sequence)} · {humanise(followUp.channel)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {formatDateTime(followUp.scheduledAt)} · {humanise(followUp.status)}
                </p>
              </div>

              {followUp.status === "SCHEDULED" ? (
                <FollowUpRowActions followUpId={followUp.id} />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Disclosure label="Schedule follow-up">
        <form action={formAction} className="space-y-4" noValidate>
          <FormStatus state={state} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Channel" name="channel">
              <Select
                name="channel"
                defaultValue="EMAIL"
                options={CHANNELS.map((value) => ({ value, label: humanise(value) }))}
              />
            </Field>

            <Field label="Sequence" name="sequence">
              <Select
                name="sequence"
                defaultValue="INITIAL"
                options={SEQUENCES.map((value) => ({ value, label: value }))}
              />
            </Field>

            <Field
              label="Scheduled for"
              name="scheduledAt"
              errors={fieldErrors(state, "scheduledAt")}
              hint="Interpreted in your workspace timezone."
            >
              <TextInput
                name="scheduledAt"
                type="datetime-local"
                defaultValue={defaultScheduledAt}
              />
            </Field>

            {contacts.length > 0 ? (
              <Field label="Contact (optional)" name="contactId">
                <Select
                  name="contactId"
                  defaultValue=""
                  options={[
                    { value: "", label: "No specific contact" },
                    ...contacts.map((contact) => ({
                      value: contact.id,
                      label: contact.fullName,
                    })),
                  ]}
                />
              </Field>
            ) : null}
          </div>

          <Field label="Message / plan" name="message">
            <TextArea name="message" />
          </Field>

          <SubmitButton>Schedule</SubmitButton>
        </form>
      </Disclosure>
    </Panel>
  );
}

function FollowUpRowActions({ followUpId }: { followUpId: string }) {
  return (
    <div className="flex gap-2">
      <InlineAction
        id={followUpId}
        kind="completeFollowUp"
        label="Complete"
        variant="secondary"
      />
      <InlineAction id={followUpId} kind="cancelFollowUp" label="Cancel" variant="danger" />
    </div>
  );
}

/* ------------------------------------------------------------------ tasks */

export function TasksPanel({
  leadId,
  tasks,
  contacts,
  formatDateTime,
}: {
  leadId: string;
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    dueAt: Date | null;
  }>;
  contacts: Array<{ id: string; fullName: string }>;
  formatDateTime: (value: Date) => string;
}) {
  const [state, formAction] = useActionState(
    createTaskAction.bind(null, leadId),
    IDLE as ActionResult,
  );

  return (
    <Panel title={`Tasks (${tasks.length})`}>
      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tasks for this lead.</p>
      ) : (
        <ul className="mb-5 space-y-2">
          {tasks.map((task) => (
            <li
              key={task.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div>
                <p className="text-sm font-medium">{task.title}</p>
                <p className="text-sm text-muted-foreground">
                  {humanise(task.priority)} · {humanise(task.status)}
                  {task.dueAt ? ` · due ${formatDateTime(task.dueAt)}` : ""}
                </p>
              </div>

              {task.status !== "DONE" && task.status !== "CANCELLED" ? (
                <div className="flex gap-2">
                  <InlineAction
                    id={task.id}
                    kind="completeTask"
                    label="Complete"
                    variant="secondary"
                  />
                  <InlineAction id={task.id} kind="cancelTask" label="Cancel" variant="danger" />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Disclosure label="Add task">
        <form action={formAction} className="space-y-4" noValidate>
          <FormStatus state={state} />

          <Field label="Title" name="title" errors={fieldErrors(state, "title")}>
            <TextInput name="title" required invalid={Boolean(fieldErrors(state, "title"))} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Priority" name="priority">
              <Select
                name="priority"
                defaultValue="MEDIUM"
                options={["LOW", "MEDIUM", "HIGH", "URGENT"].map((value) => ({
                  value,
                  label: humanise(value),
                }))}
              />
            </Field>

            <Field label="Due" name="dueAt" hint="Workspace timezone.">
              <TextInput name="dueAt" type="datetime-local" />
            </Field>

            {contacts.length > 0 ? (
              <Field label="Contact (optional)" name="contactId">
                <Select
                  name="contactId"
                  defaultValue=""
                  options={[
                    { value: "", label: "No specific contact" },
                    ...contacts.map((contact) => ({
                      value: contact.id,
                      label: contact.fullName,
                    })),
                  ]}
                />
              </Field>
            ) : null}
          </div>

          <Field label="Description" name="description">
            <TextArea name="description" />
          </Field>

          <SubmitButton>Add task</SubmitButton>
        </form>
      </Disclosure>
    </Panel>
  );
}

/* ------------------------------------------------------------------ notes */

export function AddNotePanel({ leadId }: { leadId: string }) {
  const [state, formAction] = useActionState(
    addNoteAction.bind(null, leadId),
    IDLE as ActionResult,
  );

  return (
    <form action={formAction} className="space-y-3" noValidate>
      <FormStatus state={state} />
      <Field label="Add a note" name="body" errors={fieldErrors(state, "body")}>
        <TextArea name="body" rows={3} invalid={Boolean(fieldErrors(state, "body"))} />
      </Field>
      <SubmitButton variant="secondary">Add note</SubmitButton>
    </form>
  );
}

/* --------------------------------------------------------------- archive */

export function ArchiveControl({
  leadId,
  archived,
}: {
  leadId: string;
  archived: boolean;
}) {
  const [state, formAction] = useActionState(
    archived
      ? restoreLeadAction.bind(null, leadId)
      : archiveLeadAction.bind(null, leadId),
    IDLE as ActionResult,
  );

  return (
    <form action={formAction} className="space-y-2">
      <SubmitButton variant={archived ? "secondary" : "danger"}>
        {archived ? "Restore lead" : "Archive lead"}
      </SubmitButton>
      <FormStatus state={state} />
    </form>
  );
}

/* ------------------------------------------------------ inline row buttons */

const INLINE_ACTIONS = {
  completeTask: completeTaskAction,
  cancelTask: cancelTaskAction,
  completeFollowUp: completeFollowUpAction,
  cancelFollowUp: cancelFollowUpAction,
} as const;

export function InlineAction({
  id,
  kind,
  label,
  variant = "secondary",
}: {
  id: string;
  kind: keyof typeof INLINE_ACTIONS;
  label: string;
  variant?: "primary" | "secondary" | "danger";
}) {
  const [state, formAction] = useActionState(
    INLINE_ACTIONS[kind].bind(null, id),
    IDLE as ActionResult,
  );

  return (
    <form action={formAction}>
      <SubmitButton variant={variant}>{label}</SubmitButton>
      {state.status === "error" ? (
        <span role="alert" className="ml-2 text-xs text-destructive">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
