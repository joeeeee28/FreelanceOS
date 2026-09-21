import "server-only";

/**
 * Number of reverse proxies in front of the application that append to
 * `x-forwarded-for`. On Render this is 1.
 *
 * `x-forwarded-for` is a client-supplied header: an attacker can prepend
 * arbitrary values to it. Only the entries appended by infrastructure we
 * control are trustworthy, and those are at the *end* of the list. Taking the
 * first entry (the previous behaviour) let an attacker defeat rate limiting
 * entirely by rotating the header.
 */
const TRUSTED_PROXY_HOPS = Number.parseInt(
  process.env.TRUSTED_PROXY_HOPS ?? "1",
  10,
);

export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");

  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length > 0) {
      const hops = Number.isFinite(TRUSTED_PROXY_HOPS)
        ? Math.max(TRUSTED_PROXY_HOPS, 1)
        : 1;

      // Walk back `hops` entries from the end; clamp so a short header (or a
      // direct connection) still yields the left-most value rather than undefined.
      const index = Math.max(parts.length - hops, 0);
      return parts[index];
    }
  }

  return headers.get("x-real-ip")?.trim() || "unknown";
}
