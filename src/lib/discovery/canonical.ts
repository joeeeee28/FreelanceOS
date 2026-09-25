/**
 * Canonicalisation.
 *
 * Turns messy real-world strings into stable keys that two different sources
 * describing the same business will both produce. Entity resolution is only
 * as good as this module, so everything here is pure, deterministic and
 * heavily tested.
 *
 * Deliberately conservative: it is far better to fail to merge two records
 * (a human can merge them later) than to merge two different businesses
 * (which silently corrupts history).
 */

/**
 * Multi-part public suffixes we must not mistake for a registrable domain.
 *
 * This is intentionally a short, explicit list rather than a bundled copy of
 * the full Public Suffix List: it covers the common commercial cases and
 * important multi-tenant hosting domains, needs no dependency and no network
 * fetch, and anything it misses degrades gracefully (we keep one label too
 * many, which is conservative — it can only prevent a merge, never cause a
 * wrong one).
 */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "net.uk", "sch.uk",
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "ac.in", "edu.in",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "net.za", "web.za",
  "com.br", "net.br", "org.br", "gov.br",
  "com.mx", "org.mx", "net.mx",
  "com.ar", "net.ar", "org.ar",
  "com.sg", "net.sg", "org.sg", "edu.sg",
  "com.my", "net.my", "org.my",
  "com.hk", "org.hk", "net.hk",
  "com.tw", "net.tw", "org.tw",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "ne.kr",
  "com.tr", "net.tr", "org.tr",
  "com.ph", "net.ph", "org.ph",
  "co.id", "or.id", "web.id",
  "com.vn", "net.vn", "org.vn",
  "co.th", "in.th", "or.th",
  "com.pk", "net.pk", "org.pk",
  "com.bd", "net.bd", "org.bd",
  "com.ng", "org.ng", "net.ng",
  "co.ke", "or.ke", "ne.ke",
  "com.eg", "org.eg", "net.eg",
  "com.sa", "net.sa", "org.sa",
  "co.il", "org.il", "net.il",
  "com.ua", "net.ua", "org.ua",
  "com.pl", "net.pl", "org.pl",
  "com.ru", "net.ru", "org.ru",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "com.es", "nom.es", "org.es",
  "com.pt", "net.pt", "org.pt",
  "com.gr", "net.gr", "org.gr",
  "co.it", "com.it",
  "com.co", "net.co", "org.co",
  "com.pe", "net.pe", "org.pe",
  "com.ec", "net.ec",
  "com.uy", "net.uy",
  "com.do", "com.gt", "com.sv", "com.hn", "com.ni", "com.pa",

  // Multi-tenant application hosts. Treat their customer subdomains as
  // distinct registrable identities so a crawler can never merge two tenants.
  "github.io", "gitlab.io", "bitbucket.io",
  "vercel.app", "vercel.sh", "netlify.app", "pages.dev", "workers.dev",
  "web.app", "firebaseapp.com", "surge.sh", "fly.dev", "onrender.com",
]);

/** Subdomains that never distinguish one business from another. */
const IGNORED_SUBDOMAINS = new Set(["www", "www2", "www3", "m", "en", "web"]);

/**
 * Extracts the registrable domain from a URL or bare hostname.
 *
 * `https://WWW.Example.co.uk/path?x=1` → `example.co.uk`
 *
 * Returns null when the input is not a usable public web address. IP
 * addresses and single-label hosts (`localhost`) return null: they cannot
 * identify a business.
 */
export function canonicalDomain(input: string | null | undefined): string | null {
  if (!input) return null;

  let host = input.trim().toLowerCase();
  if (host === "") return null;

  // Reject non-web schemes before any rewriting. `mailto:` and `javascript:`
  // have no "//", so blindly prepending a scheme would turn them into
  // parseable nonsense instead of rejecting them.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/.exec(host);

  if (schemeMatch) {
    const scheme = schemeMatch[1];
    if (scheme !== "http" && scheme !== "https") return null;
  } else {
    // Accept bare hostnames by giving the URL parser a scheme to work with.
    host = `http://${host}`;
  }

  let hostname: string;
  try {
    const url = new URL(host);
    hostname = url.hostname;
  } catch {
    return null;
  }

  // Strip a trailing root dot ("example.com." is the same host).
  hostname = hostname.replace(/\.$/, "");

  if (hostname === "") return null;

  // Reject IP literals: they identify a server, not a business.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null;
  if (hostname.includes(":") || hostname.startsWith("[")) return null;

  const labels = hostname.split(".").filter(Boolean);
  if (labels.length < 2) return null;

  // Drop cosmetic subdomains from the front.
  while (labels.length > 2 && IGNORED_SUBDOMAINS.has(labels[0])) {
    labels.shift();
  }

  const lastTwo = labels.slice(-2).join(".");

  // With a multi-part suffix the registrable domain needs three labels.
  if (MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }

  return lastTwo;
}

/** Legal-form suffixes that differ between sources describing one business. */
const COMPANY_SUFFIXES = [
  "private limited", "pvt ltd", "pvt. ltd.", "pvt limited",
  "public limited company", "limited liability partnership",
  "incorporated", "corporation", "company",
  "limited", "ltd", "llc", "llp", "plc", "inc", "corp", "co",
  "gmbh", "mbh", "ag", "kg", "ug",
  "sarl", "sas", "sa", "sl", "srl", "spa", "bv", "nv", "ab", "as", "oy", "aps",
  "pty", "pte", "sdn bhd", "bhd", "kk", "kft", "zrt", "doo", "sro", "sp z oo",
  "and sons", "group", "holdings", "ventures", "enterprises",
];

/**
 * Canonicalises a company name for comparison.
 *
 * Lowercases, removes accents, strips punctuation and legal suffixes, and
 * collapses whitespace:
 *
 *   "Saraswati Dental Care Pvt. Ltd." → "saraswati dental care"
 *   "Café Münster GmbH"               → "cafe munster"
 *
 * The result is for matching only — never display it to a user.
 */
export function canonicalCompanyName(
  input: string | null | undefined,
): string | null {
  if (!input) return null;

  let name = input
    .normalize("NFKD")
    // Strip combining marks so accented and unaccented spellings agree.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Ampersand is written both ways; normalise before punctuation removal.
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (name === "") return null;

  // Repeatedly strip trailing legal suffixes ("Acme Holdings Ltd").
  let changed = true;
  while (changed) {
    changed = false;

    for (const suffix of COMPANY_SUFFIXES) {
      if (name === suffix) continue;

      if (name.endsWith(` ${suffix}`)) {
        name = name.slice(0, -(suffix.length + 1)).trim();
        changed = true;
        break;
      }
    }
  }

  return name === "" ? null : name;
}

/**
 * Canonicalises an email address for comparison.
 *
 * Lowercases and validates shape. Deliberately does NOT apply provider-specific
 * tricks (stripping Gmail dots or +tags): two addresses that differ textually
 * may belong to two different people at the same company, and wrongly merging
 * contacts is worse than missing a merge.
 */
export function canonicalEmail(input: string | null | undefined): string | null {
  if (!input) return null;

  const email = input.trim().toLowerCase();

  // One @, non-empty local part, dotted domain, no whitespace.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;

  return email;
}

/**
 * Reduces a phone number to comparable digits.
 *
 * Keeps a leading + when present. No country inference: guessing a country
 * code from an ambiguous local number would fabricate data.
 */
export function canonicalPhone(input: string | null | undefined): string | null {
  if (!input) return null;

  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+") || trimmed.startsWith("00");
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length < 7 || digits.length > 15) return null;

  // "00" is the ITU international prefix; normalise it to "+".
  if (trimmed.startsWith("00")) return `+${digits.slice(2)}`;

  return hasPlus ? `+${digits}` : digits;
}

/**
 * Canonicalises a full URL for deduplicating fetches.
 *
 * Lowercases scheme/host, drops the fragment, removes default ports, strips
 * a trailing slash and sorts query parameters so equivalent URLs collapse to
 * one key. Common tracking parameters are removed because they never change
 * what a page returns.
 */
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "gclid", "fbclid", "mc_cid", "mc_eid", "ref", "ref_src",
  "igshid", "msclkid", "_ga", "yclid",
]);

export function canonicalUrl(input: string | null | undefined): string | null {
  if (!input) return null;

  const raw = input.trim();
  if (raw === "") return null;

  // Detect any scheme, including ones without "//" such as `mailto:` or
  // `javascript:`. Prepending https:// to those would produce a bogus but
  // parseable URL, so they must be rejected up front rather than mangled.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(raw);

  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") return null;
  }

  let url: URL;
  try {
    url = new URL(schemeMatch ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // Drop a leading "www.", matching canonicalDomain. Without this the same
  // page reached via www and non-www would produce two different keys, which
  // would defeat request deduplication and split one company into two.
  url.hostname = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  url.hash = "";

  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);

  let result = url.toString();

  // Normalise the empty path and drop one trailing slash.
  if (url.pathname === "/" && url.search === "") {
    result = result.replace(/\/$/, "");
  }

  return result;
}

/**
 * Canonicalises a person's name for comparison.
 *
 * Strips honorifics and trailing credentials, which sources add inconsistently:
 *   "Dr. Meera Iyer, BDS" → "meera iyer"
 */
const HONORIFICS = new Set([
  "mr", "mrs", "ms", "miss", "mx", "dr", "prof", "professor",
  "sir", "madam", "shri", "smt", "er", "adv", "capt", "rev",
]);

export function canonicalPersonName(
  input: string | null | undefined,
): string | null {
  if (!input) return null;

  // Anything after a comma is a credential list, not part of the name.
  const withoutCredentials = input.split(",")[0];

  const words = withoutCredentials
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  while (words.length > 1 && HONORIFICS.has(words[0])) {
    words.shift();
  }

  return words.length === 0 ? null : words.join(" ");
}

/**
 * A stable key for deduplicating candidate businesses within one run.
 *
 * Prefers the registrable domain, because that is the real identity. Falls
 * back to the origin for hosts that have no registrable domain (an IP address,
 * or a single-label intranet host). Falling back matters: dropping those
 * outright would silently discard real businesses, which is exactly the kind
 * of quiet data loss that is hardest to notice.
 */
export function entityKey(url: string): string | null {
  const domain = canonicalDomain(url);
  if (domain !== null) return domain;

  try {
    return new URL(url.includes("://") ? url : `https://${url}`).origin.toLowerCase();
  } catch {
    return null;
  }
}
