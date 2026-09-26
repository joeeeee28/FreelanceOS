"use client";

import { useActionState } from "react";

import {
  cancelJobAction,
  retryJobAction,
  runDiscoveryNowAction,
} from "@/app/(app)/automation/actions";
import { IDLE, type ActionResult } from "@/lib/crm/action-result";
import { Icon } from "@/components/ui/domain";
import { FormStatus, SubmitButton } from "./form-controls";

/**
 * Manual automation controls.
 *
 * Each one submits to a server action that re-derives the workspace from the
 * session and rebuilds any job payload from the database, so the browser never
 * supplies an identifier that could point at another tenant's work.
 */

/** Queues a discovery cycle for this workspace, in this local hour. */
export function RunDiscoveryNow() {
  const [state, formAction] = useActionState(
    runDiscoveryNowAction,
    IDLE as ActionResult,
  );

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <SubmitButton size="sm">
        <Icon name="refresh" size={13} />
        Run discovery now
      </SubmitButton>
      <span className="text-xs text-subtle-foreground">
        Queues one cycle. Clicking again inside the same local hour reuses it.
      </span>
      <FormStatus state={state} />
    </form>
  );
}

/** Requeues a failed job. */
export function RetryJobButton({ jobId }: { jobId: string }) {
  const [state, formAction] = useActionState(
    retryJobAction.bind(null, jobId),
    IDLE as ActionResult,
  );

  return (
    <form action={formAction}>
      <SubmitButton size="sm" variant="secondary">
        Retry
      </SubmitButton>
      <FormStatus state={state} />
    </form>
  );
}

/** Cancels a job that has not finished. */
export function CancelJobButton({ jobId }: { jobId: string }) {
  const [state, formAction] = useActionState(
    cancelJobAction.bind(null, jobId),
    IDLE as ActionResult,
  );

  return (
    <form action={formAction} className="flex items-end gap-1.5">
      <SubmitButton size="sm" variant="secondary">
        Cancel
      </SubmitButton>
      <FormStatus state={state} />
    </form>
  );
}

/** The cancel/retry pair for one row, rendered only where it applies. */
export function JobControls({
  jobId,
  status,
}: {
  jobId: string;
  status: string;
}) {
  if (status === "FAILED") return <RetryJobButton jobId={jobId} />;
  if (status === "PENDING" || status === "RUNNING") return <CancelJobButton jobId={jobId} />;
  return <span className="text-xs text-subtle-foreground">—</span>;
}
