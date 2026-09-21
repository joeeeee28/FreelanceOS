import { ZodError } from "zod";

import { fieldErrorsFrom, type FieldErrors } from "@/lib/validation/field-errors";
import { isCrmError } from "./errors";

/** Uniform result shape returned by every CRM server action. */
export type ActionResult<T = undefined> =
  | { status: "idle" }
  | { status: "success"; data?: T; message?: string }
  | { status: "error"; message: string; fieldErrors: FieldErrors };

export const IDLE: ActionResult<never> = { status: "idle" };

export function success<T>(data?: T, message?: string): ActionResult<T> {
  return { status: "success", data, message };
}

export function failure(
  message: string,
  fieldErrors: FieldErrors = {},
): ActionResult<never> {
  return { status: "error", message, fieldErrors };
}

/**
 * Converts a thrown error into a safe result.
 *
 * Zod issues become field errors; known CRM errors keep their (already
 * user-safe) message; anything else is logged without payload and reported
 * generically, so Prisma errors, SQL and stack traces never reach the browser.
 */
export function toActionError(error: unknown, context: string): ActionResult<never> {
  if (error instanceof ZodError) {
    return failure("Please correct the highlighted fields.", fieldErrorsFrom(error));
  }

  if (isCrmError(error)) {
    return failure(error.message);
  }

  console.error(`[crm] ${context} failed`, {
    name: error instanceof Error ? error.name : "UnknownError",
  });

  return failure("Something went wrong. Please try again.");
}

/** Wraps a mutation so callers never have to duplicate the try/catch. */
export async function runAction(
  context: string,
  operation: () => Promise<unknown>,
  message?: string,
): Promise<ActionResult> {
  try {
    await operation();
    // The mutated record is intentionally not returned to the client: the
    // page re-renders from the server after revalidation, so there is no need
    // to ship a full row (and its internal fields) to the browser.
    return { status: "success", message };
  } catch (error) {
    return toActionError(error, context);
  }
}
