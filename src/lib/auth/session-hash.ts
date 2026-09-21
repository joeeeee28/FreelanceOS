import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Session tokens are bearer credentials: anyone holding the raw value can
 * authenticate as the user. We therefore never persist the raw token.
 *
 * The browser holds the raw token (in an HTTP-only cookie) and the database
 * holds only a SHA-256 digest of it, so a read-only disclosure of the Session
 * table (leaked backup, replica, log, SQL injection elsewhere) does not yield
 * usable credentials.
 *
 * SHA-256 without a salt or key-stretching is the correct choice here — unlike
 * a password, the token is 256 bits of cryptographically random data, so it is
 * not guessable or rainbow-table-able. A per-row salt would also make lookup
 * by digest impossible.
 */
export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two session token digests, so that comparing a
 * presented token against a stored one cannot be attacked via response timing.
 */
export function sessionTokenDigestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}
