"use client";

import { useActionState, useState } from "react";

import { rescheduleFollowUpAction } from "@/app/(app)/leads/actions";
import { IDLE, type ActionResult } from "@/lib/crm/action-result";
import { Field, FormStatus, SubmitButton, TextInput } from "./form-controls";
import { Icon } from "@/components/ui/domain";
import { buttonClass } from "@/components/ui/primitives";

/**
 * Inline reschedule for a scheduled follow-up.
 *
 * The new time goes through the existing `updateFollowUp` service via a
 * server action, so validation, workspace scoping and activity logging are
 * unchanged. Collapsed by default so the list stays scannable.
 */
export function RescheduleControl({
  followUpId,
  defaultValue,
}: {
  followUpId: string;
  /** Current schedule as workspace-local `YYYY-MM-DDTHH:mm`. */
  defaultValue: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(
    rescheduleFollowUpAction.bind(null, followUpId),
    IDLE as ActionResult,
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass("secondary", "sm")}
      >
        <Icon name="clock" size={13} />
        Reschedule
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full space-y-2 sm:w-64">
      <Field
        label="New date and time"
        name={`scheduledAt-${followUpId}`}
        hint="Interpreted in your workspace timezone."
      >
        <TextInput
          name="scheduledAt"
          type="datetime-local"
          defaultValue={defaultValue}
        />
      </Field>

      <div className="flex gap-2">
        <SubmitButton size="sm">Save</SubmitButton>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={buttonClass("ghost", "sm")}
        >
          Cancel
        </button>
      </div>

      <FormStatus state={state} />
    </form>
  );
}
