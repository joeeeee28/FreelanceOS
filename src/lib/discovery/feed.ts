/**
 * RSS 2.0 and Atom parsing.
 *
 * Written by hand rather than pulled from a dependency because the shape we
 * need is small and well defined, and because feed XML is hostile input: it
 * arrives from arbitrary servers and must never be able to read local files or
 * expand into a memory bomb. A regex reader cannot resolve an external entity,
 * which side-steps XXE and billion-laughs entirely.
 */

/** Upper bound on the document we will look at. */
const MAX_FEED_LENGTH = 4 * 1024 * 1024;

/** Upper bound on items returned from one feed. */
export const MAX_FEED_ITEMS = 200;

export interface FeedItem {
  title: string | null;
  link: string | null;
  summary: string | null;
  author: string | null;
  publishedAt: Date | null;
  /** Categories/tags the publisher assigned. */
  categories: string[];
}

export interface ParsedFeed {
  title: string | null;
  siteUrl: string | null;
  items: FeedItem[];
}

/** Decodes the XML entities that actually appear in feeds. */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code);
      // Ignore control characters and anything outside the BMP-safe range.
      return n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
    })
    // Ampersand last, so "&amp;lt;" does not become "<".
    .replace(/&amp;/g, "&");
}

/** Strips CDATA wrappers and tags, then collapses whitespace. */
function cleanText(raw: string | null): string | null {
  if (raw === null) return null;

  const text = decodeEntities(
    raw
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

  return text === "" ? null : text;
}

/** Reads the text content of the first matching element. */
function tagContent(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  return cleanText(pattern.exec(xml)?.[1] ?? null);
}

/** Reads an attribute from the first matching element. */
function tagAttribute(xml: string, tag: string, attribute: string): string | null {
  const element = new RegExp(`<${tag}\\b([^>]*)>`, "i").exec(xml);
  if (element === null) return null;

  const value = new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']*)["']`, "i").exec(
    element[1],
  );

  return value === null ? null : decodeEntities(value[1]).trim() || null;
}

/**
 * Parses a date from a feed.
 *
 * Feeds use RFC 822 (RSS) or ISO 8601 (Atom), and plenty use neither
 * correctly. An unparseable date becomes null rather than "now", because
 * pretending we know the publication date would corrupt freshness logic.
 */
export function parseFeedDate(raw: string | null): Date | null {
  if (raw === null) return null;

  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;

  // Reject absurd dates: a feed claiming the year 3000 is broken, not news.
  const year = parsed.getUTCFullYear();
  if (year < 1990 || year > 2200) return null;

  return parsed;
}

/** Finds the Atom link that points at the entry itself. */
function atomLink(entryXml: string): string | null {
  const links = [...entryXml.matchAll(/<link\b([^>]*)\/?>/gi)];

  let fallback: string | null = null;

  for (const match of links) {
    const attrs = match[1];
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (href === undefined) continue;

    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.toLowerCase();

    if (rel === undefined || rel === "alternate") {
      return decodeEntities(href).trim() || null;
    }
    fallback ??= decodeEntities(href).trim() || null;
  }

  return fallback;
}

function extractCategories(xml: string): string[] {
  const categories: string[] = [];

  // RSS puts the value in the element body, Atom in a "term" attribute.
  for (const match of xml.matchAll(/<category\b([^>]*)>([\s\S]*?)<\/category>/gi)) {
    const term = /\bterm\s*=\s*["']([^"']*)["']/i.exec(match[1])?.[1];
    const value = cleanText(term ?? match[2]);
    if (value !== null) categories.push(value);
  }

  for (const match of xml.matchAll(/<category\b([^>]*)\/>/gi)) {
    const term = /\bterm\s*=\s*["']([^"']*)["']/i.exec(match[1])?.[1];
    const value = cleanText(term ?? null);
    if (value !== null) categories.push(value);
  }

  return [...new Set(categories)];
}

/** True when the document looks like a feed we can read. */
export function isFeed(xml: string): boolean {
  return /<rss\b|<feed\b|<rdf:RDF\b/i.test(xml);
}

/**
 * Parses an RSS or Atom document.
 *
 * Never throws: a malformed feed yields whatever items could be read, because
 * one bad entry must not discard the rest.
 */
export function parseFeed(xml: string): ParsedFeed {
  const document = xml.slice(0, MAX_FEED_LENGTH);

  const isAtom = /<feed\b[^>]*xmlns\s*=\s*["'][^"']*atom/i.test(document) ||
    (/<feed\b/i.test(document) && /<entry\b/i.test(document));

  const itemPattern = isAtom
    ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi
    : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;

  // Channel-level metadata: read from the header, before the first item.
  const firstItem = document.search(isAtom ? /<entry\b/i : /<item\b/i);
  const header = firstItem === -1 ? document : document.slice(0, firstItem);

  const items: FeedItem[] = [];

  for (const match of document.matchAll(itemPattern)) {
    if (items.length >= MAX_FEED_ITEMS) break;

    const body = match[1];

    const link = isAtom
      ? atomLink(body)
      : tagContent(body, "link") ?? tagAttribute(body, "guid", "isPermaLink") === "true"
        ? tagContent(body, "link") ?? tagContent(body, "guid")
        : tagContent(body, "link");

    const published =
      parseFeedDate(tagContent(body, "pubDate")) ??
      parseFeedDate(tagContent(body, "published")) ??
      parseFeedDate(tagContent(body, "updated")) ??
      parseFeedDate(tagContent(body, "dc:date"));

    const author =
      tagContent(body, "author") ??
      tagContent(body, "dc:creator") ??
      tagContent(body, "name");

    items.push({
      title: tagContent(body, "title"),
      link,
      summary:
        tagContent(body, "description") ??
        tagContent(body, "summary") ??
        tagContent(body, "content"),
      author,
      publishedAt: published,
      categories: extractCategories(body),
    });
  }

  return {
    title: tagContent(header, "title"),
    siteUrl: isAtom ? atomLink(header) : tagContent(header, "link"),
    items,
  };
}
