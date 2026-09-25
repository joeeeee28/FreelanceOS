import "server-only";
import { getEnv } from "@/lib/env";

/**
 * Fail-fast startup check.
 *
 * Importing this module no longer validates by itself — call `assertBootEnv()`
 * from a request path so `next build` (which has no production credentials)
 * can complete while a misconfigured *runtime* still fails on first request.
 */
export function assertBootEnv() {
  getEnv();
}
