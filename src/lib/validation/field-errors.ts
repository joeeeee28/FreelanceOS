import type { ZodError } from "zod";

export type FieldErrors = Record<string, string[]>;

/**
 * Converts a ZodError into a flat `{ field: [messages] }` map suitable for
 * returning to a client.
 *
 * Only the issue `message` and `path` are copied. Zod errors stringify to a
 * payload containing the raw input values and a stack trace, so the error
 * object itself must never be serialised into a response.
 */
export function fieldErrorsFrom(error: ZodError): FieldErrors {
  const fieldErrors: FieldErrors = {};

  for (const issue of error.issues) {
    // Nested paths collapse to a dotted key; array indices are dropped so the
    // UI can key off a stable field name.
    const key =
      issue.path
        .filter((segment) => typeof segment === "string")
        .join(".") || "form";

    (fieldErrors[key] ??= []).push(issue.message);
  }

  return fieldErrors;
}
