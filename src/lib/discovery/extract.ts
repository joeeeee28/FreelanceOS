/**
 * Fact extraction from fetched documents.
 *
 * Deliberately dependency-free and conservative. It reads the places where a
 * site deliberately publishes machine-readable information about itself —
 * JSON-LD, Open Graph, meta tags, mailto/tel links — and ignores the rest.
 *
 * It does not attempt to infer a business from prose. Guessing produces
 * plausible-looking wrong data, which is worse than no data, so anything not
 * explicitly published is simply not extracted.
 *
 * Extraction never evaluates anything. Script bodies are parsed as JSON only,
 * never executed.
 */

import type { ObservableField, ObservedFact } from "./ingest";
import type { ExtractionMethod } from "./provenance";

/** Upper bound on document size we will parse, to bound CPU and memory. */
const MAX_PARSE_LENGTH = 2 * 1024 * 1024;

/** Strips HTML tags and decodes the handful of entities that matter. */
export function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extracts the `<title>` text. */
export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) return null;
  const text = stripTags(match[1]);
  return text === "" ? null : text;
}

/**
 * Reads `<meta>` tags into a map keyed by lowercased name/property.
 *
 * Attribute order varies between sites, so both orders are handled.
 */
export function extractMetaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();

  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1];

    const key =
      /(?:name|property|itemprop)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? null;
    const value = /content\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? null;

    if (key !== null && value !== null && !tags.has(key.toLowerCase())) {
      tags.set(key.toLowerCase(), stripTags(value));
    }
  }

  return tags;
}

/**
 * Parses every JSON-LD block.
 *
 * Invalid JSON is skipped rather than throwing: one malformed block on a page
 * must not lose the valid ones.
 */
export function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];

  const pattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(pattern)) {
    const raw = match[1].trim();
    if (raw === "" || raw.length > MAX_PARSE_LENGTH) continue;

    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Malformed JSON-LD is common; ignore it.
    }
  }

  return blocks;
}

/** Flattens JSON-LD graphs and arrays into individual nodes. */
function flattenJsonLd(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || value === null || typeof value !== "object") return [];

  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenJsonLd(item, depth + 1));
  }

  const node = value as Record<string, unknown>;
  const nodes = [node];

  if (Array.isArray(node["@graph"])) {
    nodes.push(...flattenJsonLd(node["@graph"], depth + 1));
  }

  return nodes;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

/** Organisation-like JSON-LD types worth reading. */
const ORG_TYPES = new Set([
  "organization",
  "localbusiness",
  "corporation",
  "store",
  "restaurant",
  "medicalbusiness",
  "dentist",
  "professionalservice",
  "homeandconstructionbusiness",
  "legalservice",
  "financialservice",
  "educationalorganization",
  "ngo",
  "sportsactivitylocation",
  "healthandbeautybusiness",
  "foodestablishment",
  "lodgingbusiness",
  "automotivebusiness",
  "entertainmentbusiness",
]);

function isOrganisationNode(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];

  return types.some(
    (t) => typeof t === "string" && ORG_TYPES.has(t.toLowerCase()),
  );
}

/**
 * Finds a social profile only when the anchor explicitly declares that role.
 *
 * A URL alone is not ownership evidence: documentation, sponsorship banners,
 * and user content routinely link to Facebook, LinkedIn, and other platforms.
 * Requiring an aria/title/class/data label (or rel=me) deliberately trades a
 * little recall for avoiding false company-profile attribution.
 */
function extractDeclaredSocialLink(
  html: string,
  platform: string,
  expectedHost: string,
  requiredPath: string | null,
): string | null {
  const platformLabel = new RegExp(`\\b${platform}\\b`, "i");

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1];
    const href =
      /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim() ?? null;
    if (href === null) continue;

    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      continue;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;

    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname !== expectedHost &&
      !hostname.endsWith(`.${expectedHost}`)
    ) {
      continue;
    }

    if (
      requiredPath !== null &&
      !parsed.pathname.toLowerCase().startsWith(requiredPath)
    ) {
      continue;
    }

    // Do not let the platform name in the href satisfy the declaration check.
    const attributesWithoutHref = attrs.replace(
      /\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      "",
    );
    const isExplicitlyLabelled = platformLabel.test(attributesWithoutHref);
    const isIdentityLink =
      /\brel\s*=\s*["'][^"']*\bme\b[^"']*["']/i.test(attrs);

    if (!isExplicitlyLabelled && !isIdentityLink) continue;

    return parsed.toString();
  }

  return null;
}

export interface ExtractionInput {
  url: string;
  html: string;
}

/**
 * Extracts facts from a page.
 *
 * Each fact carries the method that produced it, which fixes its confidence,
 * so a value scraped from markup can never masquerade as a published one.
 */
export function extractFacts(input: ExtractionInput): ObservedFact[] {
  const { url, html } = input;

  if (html.length > MAX_PARSE_LENGTH) {
    return [];
  }

  const facts: ObservedFact[] = [];
  const seen = new Set<string>();

  const add = (
    field: ObservableField,
    value: string | null,
    method: ExtractionMethod,
    locator: string,
    evidence?: string,
  ) => {
    if (value === null || value.trim() === "") return;
    // Keep only the first (strongest) claim per field per page: extractors run
    // in descending order of trust.
    if (seen.has(field)) return;
    seen.add(field);
    facts.push({
      field,
      value,
      method,
      sourceUrl: url,
      locator,
      evidence: evidence ?? value.slice(0, 200),
    });
  };

  // 1. JSON-LD — the site publishing structured data about itself.
  for (const block of extractJsonLd(html)) {
    for (const node of flattenJsonLd(block)) {
      if (!isOrganisationNode(node)) continue;

      add("name", asString(node.name), "STRUCTURED_DATA", "jsonld:name");
      add("website", asString(node.url) ?? url, "STRUCTURED_DATA", "jsonld:url");
      add("email", asString(node.email), "STRUCTURED_DATA", "jsonld:email");
      add("phone", asString(node.telephone), "STRUCTURED_DATA", "jsonld:telephone");
      add(
        "description",
        asString(node.description),
        "STRUCTURED_DATA",
        "jsonld:description",
      );

      const address = node.address;
      if (address !== null && typeof address === "object" && !Array.isArray(address)) {
        const a = address as Record<string, unknown>;
        add("city", asString(a.addressLocality), "STRUCTURED_DATA", "jsonld:addressLocality");
        add("region", asString(a.addressRegion), "STRUCTURED_DATA", "jsonld:addressRegion");
        add("country", asString(a.addressCountry), "STRUCTURED_DATA", "jsonld:addressCountry");
      }

      // sameAs commonly lists the business's social profiles.
      const sameAs = node.sameAs;
      const links = Array.isArray(sameAs) ? sameAs : [sameAs];
      for (const link of links) {
        const href = asString(link);
        if (href === null) continue;
        const lower = href.toLowerCase();
        if (lower.includes("linkedin.com")) {
          add("linkedinUrl", href, "STRUCTURED_DATA", "jsonld:sameAs");
        } else if (lower.includes("instagram.com")) {
          add("instagramUrl", href, "STRUCTURED_DATA", "jsonld:sameAs");
        } else if (lower.includes("facebook.com")) {
          add("facebookUrl", href, "STRUCTURED_DATA", "jsonld:sameAs");
        } else if (lower.includes("youtube.com")) {
          add("youtubeUrl", href, "STRUCTURED_DATA", "jsonld:sameAs");
        }
      }
    }
  }

  // 2. Meta tags — also deliberately published, slightly less structured.
  const meta = extractMetaTags(html);

  add("name", meta.get("og:site_name") ?? null, "META_TAG", "meta:og:site_name");
  add(
    "description",
    meta.get("og:description") ?? meta.get("description") ?? null,
    "META_TAG",
    "meta:description",
  );
  add("website", meta.get("og:url") ?? null, "META_TAG", "meta:og:url");
  add("language", extractLanguage(html), "META_TAG", "html:lang");

  // 3. Explicit contact links — unambiguous, but chosen by us, not published
  //    as company metadata, so they rank below the above.
  const mailto = /href\s*=\s*["']mailto:([^"'?]+)/i.exec(html)?.[1] ?? null;
  add("email", mailto, "HTML_SELECTOR", "a[href^=mailto]");

  const tel = /href\s*=\s*["']tel:([^"']+)/i.exec(html)?.[1] ?? null;
  add("phone", tel, "HTML_SELECTOR", "a[href^=tel]");

  for (const [field, platform, host, requiredPath] of [
    ["linkedinUrl", "linkedin", "linkedin.com", "/company/"],
    ["instagramUrl", "instagram", "instagram.com", null],
    ["facebookUrl", "facebook", "facebook.com", null],
    ["youtubeUrl", "youtube", "youtube.com", null],
  ] as const) {
    const socialUrl = extractDeclaredSocialLink(
      html,
      platform,
      host,
      requiredPath,
    );
    if (socialUrl !== null) {
      add(field, socialUrl, "HTML_SELECTOR", `a[href*=${host}]`);
    }
  }

  // 4. Title, as a last resort for the company name.
  add("name", extractTitle(html), "HTML_SELECTOR", "title");

  return facts;
}

/** Reads the document language from `<html lang>`. */
export function extractLanguage(html: string): string | null {
  const match = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html);
  if (match === null) return null;
  const lang = match[1].trim().toLowerCase();
  return lang === "" ? null : lang;
}

/** Extracts `<loc>` URLs from a sitemap or sitemap index. */
export function extractSitemapUrls(xml: string): string[] {
  const urls: string[] = [];

  for (const match of xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)) {
    const value = stripTags(match[1]);
    if (value !== "") urls.push(value);
  }

  return urls;
}

/** True when the document is a sitemap index rather than a page list. */
export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex\b/i.test(xml);
}
