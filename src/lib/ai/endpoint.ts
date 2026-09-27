/**
 * Operator-endpoint guard for the local AI provider.
 *
 * The crawler's `checkTarget` refuses loopback and private addresses because
 * those URLs arrive from untrusted pages. Ollama is the opposite case: the
 * host is deployment configuration, and a local model almost always lives on
 * loopback or a private bridge. This module reuses the crawler classification
 * and then allows only that operator exception.
 *
 * It does not widen the crawler. Application code must not pass
 * `{ allowLoopback: true }` into `checkTarget` — that switch is test-only and
 * stays that way. Cloud metadata, link-local, and unspecified addresses stay
 * refused here too.
 *
 * The endpoint is never taken from evidence, from a request body, or from
 * model output. Callers pass the configured string. Redirects are not this
 * module's job; the HTTP client refuses them separately so a public host
 * cannot bounce the next request onto the metadata address.
 */

import { checkTarget, type BlockedReason } from "@/lib/discovery/net-guard";

import { endpointRejected, type AiError } from "./types";

export interface ResolvedEndpoint {
  /** `scheme://host:port` with no path, query, userinfo, or fragment. */
  origin: string;
  /** Host and port only, safe to show to an operator. */
  host: string;
}

export type EndpointAssessment =
  | { ok: true; endpoint: ResolvedEndpoint }
  | { ok: false; reason: string; error: AiError };

/**
 * Denial reasons the operator endpoint may override.
 *
 * `loopback` is a local Ollama. `private-network` is a container or LAN host.
 * Everything else the crawler refuses, this refuses as well.
 */
const OPERATOR_EXCEPTIONS: ReadonlySet<BlockedReason> = new Set([
  "loopback",
  "private-network",
]);

function fail(reason: string): EndpointAssessment {
  return { ok: false, reason, error: endpointRejected(reason) };
}

function isLocalhost(host: string): boolean {
  return host === "localhost";
}

/**
 * Rejects hostnames that embed a non-public IP literal (`127.0.0.1.nip.io`).
 *
 * DNS is not resolved here, for the same reason the crawler does not resolve
 * it: the name can change between the check and the connect. Embedding the
 * forbidden address in the label is a check that does not need DNS.
 */
function embedsBlockedAddress(host: string): string | null {
  const match = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(host);
  if (match === null || match[1] === host) return null;

  const inner = checkTarget(`http://${match[1]}/`);
  if (!inner.allowed && inner.reason !== undefined) return inner.reason;
  return null;
}

/**
 * Decides whether a configured AI base URL may be contacted.
 *
 * Only an origin is accepted. A path, query, or fragment would turn the client
 * into a general HTTP proxy aimed at whatever the string named.
 */
export function assessOperatorEndpoint(raw: string): EndpointAssessment {
  if (typeof raw !== "string" || raw.trim() === "") return fail("malformed-url");

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return fail("malformed-url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail("unsupported-scheme");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return fail("credentials-in-url");
  }

  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return fail("unexpected-path");
  }

  if (parsed.search !== "" || parsed.hash !== "") {
    return fail("unexpected-query");
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return fail("malformed-url");

  const embedded = embedsBlockedAddress(host);
  if (embedded !== null) return fail(embedded);

  const guard = checkTarget(parsed.origin);
  if (!guard.allowed) {
    const reason = guard.reason ?? "malformed-url";
    if (OPERATOR_EXCEPTIONS.has(reason)) {
      // Local model host. Not a crawled URL, and not the metadata service.
    } else if (reason === "non-public-hostname" && isLocalhost(host)) {
      // `localhost` is classified with the other single-label names. The
      // exception is the exact name, not `*.localhost` and not `*.local`.
    } else {
      return fail(reason);
    }
  }

  return {
    ok: true,
    endpoint: {
      origin: parsed.origin,
      host: parsed.host,
    },
  };
}

/**
 * Builds a URL on the resolved origin.
 *
 * The path is a union, not a string parameter, so a caller cannot aim this at
 * an arbitrary route. The origin is checked again after resolution in case a
 * future path ever contained `..`.
 */
export function endpointUrl(
  endpoint: ResolvedEndpoint,
  path: "/api/version" | "/api/tags" | "/api/chat",
): string {
  const url = new URL(path, endpoint.origin);
  if (url.origin !== endpoint.origin) {
    throw new Error("Refusing to build an AI URL outside the configured origin.");
  }
  return url.toString();
}
