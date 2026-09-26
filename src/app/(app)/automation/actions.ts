"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/require-user";
import { runAction, type ActionResult } from "@/lib/crm/action-result";
import { db } from "@/lib/db";
import { localPartsIn } from "@/lib/discovery/scheduler";
import { cancelJob, enqueueJob, retryJob } from "@/lib/jobs/queue";

/**
 * Manual automation controls.
 *
 * Three rules they all follow:
 *
 *   1. The workspace comes from the session, never from the caller. A job id
 *      belonging to another workspace is simply not found, so there is nothing
 *      to authorise and nothing to leak.
 *   2. The payload is built here, from values read out of the database. A
 *      browser cannot inject a job payload, so it cannot aim a crawl at a URL
 *      of its choosing or research somebody else's company.
 *   3. They are idempotent in the same way the scheduler is: "run discovery"
 *      enqueues a cycle keyed on the workspace and the current local slot, so
 *      two clicks, or a click racing the scheduler, produce one job.
 */

/** Queue a discovery cycle now, keyed so a double-click cannot duplicate it. */
export async function runDiscoveryNowAction(): Promise<ActionResult> {
  const { workspaceId, workspace } = await requireUser();

  const result = await runAction(
    "runDiscoveryNow",
    async () => {
      const now = new Date();
      // Keyed on the workspace and the local calendar day plus hour of the
      // request: the same manual trigger inside one local hour is one job.
      const local = localPartsIn(workspace.timezone || "UTC", now);
      const hour = String(local.hour).padStart(2, "0");
      const day = `${local.year}-${String(local.month).padStart(2, "0")}-${String(
        local.day,
      ).padStart(2, "0")}`;

      await enqueueJob({
        workspaceId,
        type: "DISCOVERY_RUN",
        idempotencyKey: `cycle:${workspaceId}:manual:${day}T${hour}`,
        priority: 50,
        payload: { trigger: "MANUAL" },
      });
    },
    "Discovery cycle queued.",
  );

  if (result.status === "success") {
    revalidatePath("/automation");
    revalidatePath("/dashboard");
  }

  return result;
}

/**
 * Requeue a failed job.
 *
 * The job is looked up inside the caller's workspace first, so a cross-workspace
 * id fails the same way a non-existent one does. Only FAILED jobs can be
 * retried: a running job is somebody's work in progress, and a cancelled one
 * was cancelled deliberately.
 */
export async function retryJobAction(jobId: string): Promise<ActionResult> {
  const { workspaceId } = await requireUser();

  const result = await runAction(
    "retryJob",
    async () => {
      const job = await db.job.findFirst({
        where: { id: jobId, workspaceId },
        select: { id: true, status: true },
      });

      // Deliberately the same error for "not yours" and "does not exist".
      if (job === null) throw new Error("Job not found");
      if (job.status !== "FAILED") throw new Error("Only a failed job can be retried");

      await retryJob(job.id, { workspaceId });
    },
    "Job queued for another attempt.",
  );

  if (result.status === "success") {
    revalidatePath("/automation");
    revalidatePath(`/automation/jobs/${jobId}`);
  }

  return result;
}

/**
 * Cancel a job that has not finished.
 *
 * Refuses anything already terminal: cancelling a succeeded job would rewrite a
 * record of something that actually happened.
 */
export async function cancelJobAction(jobId: string): Promise<ActionResult> {
  const { workspaceId } = await requireUser();

  const result = await runAction(
    "cancelJob",
    async () => {
      const job = await db.job.findFirst({
        where: { id: jobId, workspaceId },
        select: { id: true, status: true },
      });

      if (job === null) throw new Error("Job not found");
      if (job.status !== "PENDING" && job.status !== "RUNNING") {
        throw new Error("Only a pending or running job can be cancelled");
      }

      await cancelJob(job.id, { workspaceId });
    },
    "Job cancelled.",
  );

  if (result.status === "success") {
    revalidatePath("/automation");
    revalidatePath(`/automation/jobs/${jobId}`);
  }

  return result;
}
