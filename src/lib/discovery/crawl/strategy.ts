/**
 * Layered acquisition.
 *
 * The specification requires trying cheap, structured, explicitly-published
 * data before falling back to scraping. That ordering is not just politeness:
 * each rung down the ladder is less reliable and more likely to misread a
 * page, so the confidence attached to a fact drops with it. The layer that
 * produced a fact is recorded, which is what makes a stored value auditable
 * later.
 *
 * Browser rendering is deliberately absent. It is the last rung in the spec,
 * but it is not approved for this round, so it is declared as a known gap
 * rather than silently skipped.
 */

import type { ExtractionMethod } from "@prisma/client";

import type { FetchedDocument, Fetcher } from "../provider";

/** Acquisition layers, cheapest and most trustworthy first. */
export const CRAWL_LAYERS = [
  "STRUCTURED_SOURCE",
  "FEED",
  "SITEMAP",
  "HTTP_DOCUMENT",
  "HTML_EXTRACTION",
] as const;

export type CrawlLayer = (typeof CRAWL_LAYERS)[number];

/** The provenance method a layer's facts are recorded under. */
export const LAYER_METHOD: Readonly<Record<CrawlLayer, ExtractionMethod>> = {
  STRUCTURED_SOURCE: "STRUCTURED_DATA",
  FEED: "FEED",
  SITEMAP: "SITEMAP",
  HTTP_DOCUMENT: "META_TAG",
  HTML_EXTRACTION: "HTML_SELECTOR",
};

export interface LayerAttempt<T> {
  layer: CrawlLayer;
  /** Candidate URL, or null if this layer does not apply to this target. */
  url: string | null;
  /** Reads the document. Returning null means "nothing usable here". */
  parse: (document: FetchedDocument) => T | null;
}

export interface LayerResult<T> {
  /** The layer that produced the value, or null if none did. */
  layer: CrawlLayer | null;
  value: T | null;
  method: ExtractionMethod | null;
  /** Every layer tried, in order, with why it was abandoned. */
  trail: Array<{ layer: CrawlLayer; url: string; outcome: string }>;
  /** True if any layer was refused by the site. */
  blocked: boolean;
}

/**
 * Walks the ladder until a layer yields a value.
 *
 * Stops at the first success, so a site with good structured data costs one
 * request. A layer that is BLOCKED does not abort the walk — the next layer
 * may be a different URL the site is happy to serve — but the fact that
 * something was refused is reported, because a run made entirely of refusals
 * must not look like a run that found nothing.
 */
export async function acquire<T>(
  fetcher: Fetcher,
  attempts: Array<LayerAttempt<T>>,
): Promise<LayerResult<T>> {
  const trail: LayerResult<T>["trail"] = [];
  let blocked = false;

  for (const attempt of attempts) {
    if (attempt.url === null) continue;

    const document = await fetcher.fetch(attempt.url);

    if (document.outcome === "BLOCKED") {
      blocked = true;
      trail.push({ layer: attempt.layer, url: attempt.url, outcome: "BLOCKED" });
      continue;
    }

    if (document.outcome !== "SUCCESS" || typeof document.body !== "string") {
      trail.push({
        layer: attempt.layer,
        url: attempt.url,
        outcome: document.outcome,
      });
      continue;
    }

    let value: T | null = null;
    try {
      value = attempt.parse(document);
    } catch {
      // A parser that throws is a bug in that layer, not a reason to abandon
      // the target; the next layer still gets its turn.
      trail.push({ layer: attempt.layer, url: attempt.url, outcome: "PARSE_ERROR" });
      continue;
    }

    if (value === null) {
      trail.push({ layer: attempt.layer, url: attempt.url, outcome: "EMPTY" });
      continue;
    }

    trail.push({ layer: attempt.layer, url: attempt.url, outcome: "SUCCESS" });

    return {
      layer: attempt.layer,
      value,
      method: LAYER_METHOD[attempt.layer],
      trail,
      blocked,
    };
  }

  return { layer: null, value: null, method: null, trail, blocked };
}

/**
 * Layers not available in this build.
 *
 * Surfaced so the UI can say "this was not attempted" rather than implying the
 * data does not exist. Browser rendering needs Chromium, which is neither
 * approved nor installable here.
 */
export const UNAVAILABLE_LAYERS = [
  {
    layer: "BROWSER_RENDER",
    reason:
      "Headless browser rendering is not enabled in this build. Pages that " +
      "require JavaScript to display their content are not read.",
  },
] as const;
