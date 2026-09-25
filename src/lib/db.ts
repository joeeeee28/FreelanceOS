/**
 * Database access for the Next.js application.
 *
 * The `server-only` import is the guard that stops a client component pulling
 * the database client into the browser bundle. It is kept here, on the path
 * the app uses, and deliberately not in db-client.ts, which the standalone
 * worker process needs.
 */

import "server-only";

export { db } from "./db-client";
