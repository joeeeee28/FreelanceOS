/**
 * Page-level evidence.
 *
 * The signal engine can tell that a site is insecure, not mobile-ready, stale,
 * thin, or missing a content programme — but only from a `PageSignals` object,
 * and until now nothing produced one. This module turns a document the crawler
 * actually fetched into exactly those observations, and nothing more.
 *
 * Every field is an observation of the served document: the protocol it was
 * served over, whether a viewport tag is present, the newest year in its
 * copyright notice, the scripts it loads, whether it links a blog. Where the
 * document does not say, the field stays absent — an unread page must never
 * turn into "no blog" or "no viewport", because the rules treat explicit
 * absence as evidence.
 */

import { extractMetaTags } from "@/lib/discovery/extract";
import type { FetchOutcome } from "@/lib/discovery/provider";
import type { PageSignals } from "@/lib/discovery/signals/rules";

/** Scripts and pixels that indicate measurable marketing spend. */
const TRACKING_PATTERN =
  /googletagmanager\.com|google-analytics\.com|gtag\(|connect\.facebook\.net|fbevents\.js|adsbygoogle|doubleclick\.net|hotjar|clarity\.ms|matomo|plausible\.io|segment\.(?:com|io)|hs-scripts\.com|snap\.licdn\.com/i;

const VIEWPORT_PATTERN = /<meta\b[^>]*\bname\s*=\s*["']?viewport["']?/i;

const BLOG_PATTERN =
  /href\s*=\s*["'][^"']*\/(?:blog|news|insights|articles|journal)(?:\/|["'?])/i;

/** Platform fingerprints, checked in order. */
const PLATFORM_HINTS: ReadonlyArray<{ platform: string; pattern: RegExp }> = [
  { platform: "wordpress", pattern: /wp-content|wp-includes|wordpress/i },
  { platform: "shopify", pattern: /cdn\.shopify|shopify\.com|myshopify/i },
  { platform: "wix", pattern: /wixstatic|wix\.com/i },
  { platform: "squarespace", pattern: /squarespace/i },
  { platform: "webflow", pattern: /webflow/i },
  { platform: "joomla", pattern: /joomla/i },
  { platform: "drupal", pattern: /drupal/i },
];

/**
 * The newest year a copyright notice claims.
 *
 * "© 2015–2021" is a claim about 2021, so the last year in the match wins. A
 * year in the future is somebody else's typo (or a cached page's), and the
 * rule ignores it, so it is dropped here too rather than reported as evidence.
 */
export function copyrightYearFrom(html: string, now: Date): number | null {
  const pattern = /(?:©|&copy;|copyright)[^0-9]{0,40}((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?/gi;

  const limit = now.getUTCFullYear() + 1;
  let newest: number | null = null;

  for (const match of html.matchAll(pattern)) {
    const years = [match[1], match[2]]
      .filter((value): value is string => typeof value === "string")
      .map((value) => Number.parseInt(value, 10))
      .filter((year) => Number.isFinite(year) && year >= 1990 && year <= limit);

    for (const year of years) {
      if (newest === null || year > newest) newest = year;
    }
  }

  return newest;
}

function platformFrom(html: string): string | null {
  const generator = extractMetaTags(html).get("generator") ?? "";

  const haystack = `${generator} ${html.slice(0, 20_000)}`;

  for (const hint of PLATFORM_HINTS) {
    if (hint.pattern.test(haystack)) return hint.platform;
  }

  return null;
}

export interface PageObservation {
  url: string;
  outcome: FetchOutcome;
  /** Present only when the fetch succeeded. */
  html?: string | null;
}

/**
 * Everything this document proves about the site it came from.
 *
 * A failed fetch proves exactly one thing — that the site did not answer — and
 * that is all that is recorded.
 */
export function pageSignalsFrom(observation: PageObservation, now: Date): PageSignals {
  const isHttps = observation.url.startsWith("https:");

  if (observation.outcome !== "SUCCESS" || typeof observation.html !== "string") {
    return { reachable: false, isHttps };
  }

  const html = observation.html;

  return {
    reachable: true,
    isHttps,
    hasViewportMeta: VIEWPORT_PATTERN.test(html),
    copyrightYear: copyrightYearFrom(html, now),
    platform: platformFrom(html),
    sizeBytes: Buffer.byteLength(html, "utf8"),
    hasTrackingPixel: TRACKING_PATTERN.test(html),
    hasBlog: BLOG_PATTERN.test(html),
  };
}

/**
 * Folds one page's evidence into another's.
 *
 * A site that answered once did answer: `reachable: true` is never overwritten
 * by a later failed page. Otherwise the first defined observation wins, so the
 * homepage — read first — decides the site's size and copyright year rather
 * than whichever contact page happened to be fetched last.
 */
export function mergePageSignals(
  target: PageSignals,
  incoming: PageSignals,
): PageSignals {
  const merged: PageSignals = { ...target };

  // A successful page outranks a failed one, whatever order they arrived in.
  if (merged.reachable !== true && incoming.reachable !== undefined) {
    merged.reachable = incoming.reachable;
  }

  if (incoming.hasViewportMeta !== undefined && merged.hasViewportMeta === undefined) {
    merged.hasViewportMeta = incoming.hasViewportMeta;
  }
  if (incoming.isHttps !== undefined && merged.isHttps === undefined) {
    merged.isHttps = incoming.isHttps;
  }
  if (incoming.copyrightYear !== undefined && merged.copyrightYear === undefined) {
    merged.copyrightYear = incoming.copyrightYear;
  }
  if (incoming.platform !== undefined && merged.platform === undefined) {
    merged.platform = incoming.platform;
  }
  if (incoming.sizeBytes !== undefined && merged.sizeBytes === undefined) {
    merged.sizeBytes = incoming.sizeBytes;
  }
  if (incoming.hasTrackingPixel !== undefined && merged.hasTrackingPixel === undefined) {
    merged.hasTrackingPixel = incoming.hasTrackingPixel;
  }
  if (incoming.hasBlog !== undefined && merged.hasBlog === undefined) {
    merged.hasBlog = incoming.hasBlog;
  }

  return merged;
}

/** True when at least one field carries real evidence. */
export function hasPageEvidence(signals: PageSignals): boolean {
  return (
    signals.reachable !== undefined ||
    signals.hasViewportMeta !== undefined ||
    signals.copyrightYear !== undefined ||
    signals.hasTrackingPixel !== undefined ||
    signals.hasBlog !== undefined ||
    signals.sizeBytes !== undefined
  );
}
