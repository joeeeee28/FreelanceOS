/**
 * P15 §23 — SSRF probes against the real fetcher.
 *
 * A crawler takes URLs derived from untrusted remote content and fetches them.
 * That is precisely the shape of a server-side request forgery primitive: if a
 * discovered page can point the crawler at 127.0.0.1 or at a cloud metadata
 * endpoint, the crawler becomes the attacker's HTTP client inside the trust
 * boundary.
 *
 * These tests run offline (no real egress needed) and assert the fetcher
 * refuses internal targets outright.
 */
import { describe, expect, it } from "vitest";

import { HttpFetcher } from "@/lib/discovery/fetcher";

function fetcher() {
  return new HttpFetcher({
    userAgent: "FreelanceOSBot/0.1 (validation)",
    timeoutMs: 5_000,
    minIntervalMs: 0,
    respectRobots: false,
  });
}

/**
 * Targets that must never be reachable through the crawler.
 *
 * 169.254.169.254 is the cloud instance-metadata address on AWS, GCP and
 * Azure; reaching it from a crawler is the classic credential-theft path.
 */
const FORBIDDEN = [
  ["loopback v4", "http://127.0.0.1:55432/"],
  ["loopback name", "http://localhost:3000/api/health"],
  ["loopback v6", "http://[::1]:3000/"],
  ["private 10/8", "http://10.0.0.1/"],
  ["private 172.16/12", "http://172.16.0.1/"],
  ["private 192.168/16", "http://192.168.1.1/"],
  ["link-local", "http://169.254.1.1/"],
  ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
  ["metadata hostname", "http://metadata.google.internal/"],
  ["internal hostname", "http://internal-service/"],
  ["0.0.0.0", "http://0.0.0.0:3000/"],
  ["decimal-encoded loopback", "http://2130706433/"],
] as const;

describe("SSRF: the crawler must not reach internal addresses", () => {
  for (const [label, url] of FORBIDDEN) {
    it(`refuses ${label}: ${url}`, async () => {
      const doc = await fetcher().fetch(url);

      // BLOCKED specifically, not merely "did not succeed". A connection
      // refused because nothing happened to be listening is luck, not a
      // control; the guard must refuse before a socket is opened.
      expect(doc.outcome).toBe("BLOCKED");
      expect(doc.body ?? null).toBeNull();
    }, 30_000);
  }

  it("refuses non-http schemes", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "gopher://example.com/",
    ]) {
      const doc = await fetcher().fetch(url);
      expect(doc.outcome).toBe("BLOCKED");
    }
  }, 30_000);
});
