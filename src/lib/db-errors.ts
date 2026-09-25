/**
 * Structural detection of Prisma known-request errors.
 *
 * `error instanceof Prisma.PrismaClientKnownRequestError` only holds when the
 * error was produced by the very same copy of @prisma/client that is doing the
 * checking. That assumption breaks with bundling, monorepo hoisting, or a
 * second generated client — and it fails *open*, turning an expected conflict
 * into a 500. Matching on the documented `code` property is equivalent and
 * does not depend on module identity.
 */
export function isPrismaErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** Unique constraint violation. */
export const UNIQUE_CONSTRAINT_VIOLATION = "P2002";
