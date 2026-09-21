/**
 * Application-level CRM errors.
 *
 * Service functions throw these instead of leaking Prisma errors, SQL or stack
 * traces to callers. Server actions map them to structured, safe results.
 */
export type CrmErrorCode =
  | "NOT_FOUND"
  | "INVALID_TRANSITION"
  | "VALIDATION"
  | "CONFLICT";

export class CrmError extends Error {
  readonly code: CrmErrorCode;

  constructor(code: CrmErrorCode, message: string) {
    super(message);
    this.name = "CrmError";
    this.code = code;
  }
}

/**
 * Raised when a record does not exist *or* belongs to another workspace.
 *
 * The two cases are deliberately indistinguishable: telling a caller that a
 * record exists but is not theirs would leak the existence of other
 * workspaces' data.
 */
export function notFound(entity = "Record"): CrmError {
  return new CrmError("NOT_FOUND", `${entity} not found.`);
}

export function invalidTransition(from: string, to: string): CrmError {
  return new CrmError(
    "INVALID_TRANSITION",
    `A lead cannot move from ${humanise(from)} to ${humanise(to)}.`,
  );
}

export function isCrmError(error: unknown): error is CrmError {
  return error instanceof CrmError;
}

/** `DISCOVERY_CALL` -> `Discovery call`. Used in user-facing copy. */
export function humanise(value: string): string {
  const lower = value.replaceAll("_", " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
