/**
 * The Prisma client instance.
 *
 * Deliberately free of the `server-only` marker so the worker process can use
 * it. `server-only` throws outside a React Server Component graph, which is
 * correct for the web app and wrong for a standalone Node process.
 *
 * Application code under src/app should import `@/lib/db` instead, which
 * re-exports this behind that guard. Importing this module directly from a
 * component would bypass a real protection, so don't.
 */

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
