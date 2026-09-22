/**
 * Network target guard (SSRF protection).
 *
 * The crawler fetches URLs that originate in untrusted remote content: a
 * sitemap entry, an HTML link, a JSON field on someone else's API. That is the
 * exact shape of a server-side request forgery primitive. Without a guard, a
 * page we discover can point this process at `127.0.0.1`, at a database on the
 * private network, or at `169.254.169.254` — the cloud instance-metadata
 * address, which on a default AWS/GCP/Azure instance will hand out
 * credentials.
 *
 * The rule here is deny-by-default on the *shape of the host*. Only a public,
 * routable, named or public-IP host over http(s) is allowed. Everything else
 * is refused before a socket is opened, and refused again on every redirect
 * hop, because a redirect is just a remote party choosing our next URL.
 *
 * This is deliberately a pure, synchronous, string/IP-level check. It does not
 * resolve DNS: resolution here would be security theatre, because the name
 * could resolve differently when the socket is actually opened (a DNS-rebinding
 * race). Hostnames that are *syntactically* internal are rejected; the
 * rebinding case is mitigated by network egress policy, which is documented
 * rather than pretended-to in code.
 *
 * `allowLoopback` exists for one reason: the test suite serves fixtures from
 * 127.0.0.1, and testing the crawler against a real HTTP server is worth more
 * than the purity of having no switch at all. It defaults to false, it is
 * never read from configuration or the environment, and application code never
 * sets it — so it cannot be turned on in production by a config change.
 */

/** Why a target was refused. Shown in logs and on the source-health screen. */
export type BlockedReason =
  | "unsupported-scheme"
  | "malformed-url"
  | "loopback"
  | "private-network"
  | "link-local"
  | "cloud-metadata"
  | "unspecified-address"
  | "non-public-hostname";

export interface GuardResult {
  allowed: boolean;
  reason?: BlockedReason;
  detail?: string;
}

const ALLOWED = { allowed: true } as const;

function deny(reason: BlockedReason, detail: string): GuardResult {
  return { allowed: false, reason, detail };
}

/**
 * Hostnames that never identify a public web server.
 *
 * `metadata.google.internal` is the GCP metadata name; the `.internal`,
 * `.local` and `.localhost` suffixes are reserved for internal use and must
 * never be fetched from a crawler.
 */
const FORBIDDEN_HOST_SUFFIXES = [
  ".internal",
  ".local",
  ".localhost",
  ".home.arpa",
];

const FORBIDDEN_HOST_NAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

/** Parses a dotted-quad IPv4 address. Returns null when not one. */
function parseIPv4(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return null;

  const octets = match.slice(1, 5).map((o) => Number(o));
  if (octets.some((o) => o > 255)) return null;
  return octets;
}

/**
 * Accepts the integer and shorthand IPv4 forms a naive parser would miss.
 *
 * `http://2130706433/` is 127.0.0.1 written as a single decimal, and browsers
 * and curl both honour it. A guard that only understands dotted quads is
 * trivially bypassed.
 */
function parseIntegerIPv4(host: string): number[] | null {
  if (!/^\d+$/.test(host)) return null;

  const value = Number(host);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;

  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

/** Classifies an IPv4 address, or returns null when it is public. */
function classifyIPv4(octets: number[]): GuardResult | null {
  const [a, b] = octets;
  const text = octets.join(".");

  if (a === 0) return deny("unspecified-address", text);
  if (a === 127) return deny("loopback", text);
  if (a === 10) return deny("private-network", text);
  if (a === 172 && b >= 16 && b <= 31) return deny("private-network", text);
  if (a === 192 && b === 168) return deny("private-network", text);
  // Carrier-grade NAT: not the public Internet.
  if (a === 100 && b >= 64 && b <= 127) return deny("private-network", text);
  if (a === 169 && b === 254) {
    // The metadata address is the one that actually leaks credentials, so it
    // is reported distinctly from ordinary link-local noise.
    return text === "169.254.169.254"
      ? deny("cloud-metadata", text)
      : deny("link-local", text);
  }
  // 192.0.0.0/24, 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 are reserved
  // documentation/benchmark ranges; 224+ is multicast and reserved space.
  if (a === 192 && b === 0) return deny("private-network", text);
  if (a === 198 && (b === 18 || b === 19)) return deny("private-network", text);
  if (a >= 224) return deny("private-network", text);

  return null;
}

/** Classifies an IPv6 literal, or returns null when it is public. */
function classifyIPv6(raw: string): GuardResult | null {
  const host = raw.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "::1") return deny("loopback", host);
  if (host === "::" || host === "::0") return deny("unspecified-address", host);
  // Unique local addresses (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd]/.test(host)) return deny("private-network", host);
  if (/^fe[89ab]/.test(host)) return deny("link-local", host);

  // IPv4-mapped and IPv4-compatible forms must be judged by the embedded IPv4
  // address, not waved through as "some IPv6 address". Note that the URL
  // parser rewrites `::ffff:127.0.0.1` into the hex form `::ffff:7f00:1`, so
  // matching only the dotted spelling would miss every real case.
  const dotted = /(?:^::ffff:|^::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted !== null) {
    const octets = parseIPv4(dotted[1]);
    if (octets !== null) return classifyIPv4(octets);
  }

  const hex = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hex !== null) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    const octets = [
      (high >>> 8) & 0xff,
      high & 0xff,
      (low >>> 8) & 0xff,
      low & 0xff,
    ];
    // `::` followed by two groups is only an embedded IPv4 address when the
    // high half is non-zero nonsense-free; classifyIPv4 rejects what matters.
    const verdict = classifyIPv4(octets);
    if (verdict !== null) return verdict;
  }

  return null;
}

/**
 * Decides whether the crawler may open a connection to this URL.
 *
 * Called for the initial URL and for every redirect target.
 */
export interface GuardOptions {
  /**
   * Permit loopback targets (127.0.0.0/8, ::1, `localhost`).
   *
   * Test-only. Private, link-local and cloud-metadata addresses stay blocked
   * even when this is set: no test needs them, and an escape hatch wide enough
   * to reach the metadata service is not an escape hatch worth having.
   */
  allowLoopback?: boolean;
}

export function checkTarget(url: string, options: GuardOptions = {}): GuardResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny("malformed-url", url);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return deny("unsupported-scheme", parsed.protocol);
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");

  if (host === "") return deny("malformed-url", url);

  const loopbackOk = options.allowLoopback === true;

  if (host.startsWith("[") || host.includes(":")) {
    const verdict = classifyIPv6(host);
    if (verdict !== null) {
      if (loopbackOk && verdict.reason === "loopback") return ALLOWED;
      return verdict;
    }
    return ALLOWED;
  }

  const ipv4 = parseIPv4(host) ?? parseIntegerIPv4(host);
  if (ipv4 !== null) {
    const verdict = classifyIPv4(ipv4);
    if (verdict !== null) {
      if (loopbackOk && verdict.reason === "loopback") return ALLOWED;
      return verdict;
    }
    return ALLOWED;
  }

  if (host === "localhost" && loopbackOk) return ALLOWED;

  if (FORBIDDEN_HOST_NAMES.has(host)) return deny("non-public-hostname", host);
  if (FORBIDDEN_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return deny("non-public-hostname", host);
  }

  // A single-label host ("intranet", "internal-service") is by definition not
  // a public DNS name: reaching one means we are talking to something on the
  // local network.
  if (!host.includes(".")) return deny("non-public-hostname", host);

  return ALLOWED;
}

/** Human-readable explanation, for logs and the source-health screen. */
export function describeBlock(result: GuardResult): string {
  switch (result.reason) {
    case "cloud-metadata":
      return "Refused: cloud instance metadata address";
    case "loopback":
      return "Refused: loopback address";
    case "private-network":
      return "Refused: private or reserved network address";
    case "link-local":
      return "Refused: link-local address";
    case "unspecified-address":
      return "Refused: unspecified address";
    case "non-public-hostname":
      return "Refused: not a public hostname";
    case "unsupported-scheme":
      return `Refused: unsupported scheme ${result.detail ?? ""}`.trim();
    case "malformed-url":
      return "Refused: malformed URL";
    default:
      return "Refused";
  }
}
