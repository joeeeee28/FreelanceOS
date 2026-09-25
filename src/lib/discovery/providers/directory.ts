import type {
  DiscoveryContext,
  DiscoveryProvider,
  DiscoveryResult,
} from "../provider";
import { emptyResult } from "../provider";
import { extractFacts, stripTags } from "../extract";
import { canonicalDomain, entityKey } from "../canonical";
import type { DiscoveredEntity } from "../ingest";

/**
 * Public directory provider.
 *
 * Reads a listing page — an association's member list, a chamber-of-commerce
 * directory, a public "our clients" page — and treats each outbound link to a
 * distinct host as a candidate business.
 *
 * Only follows links the page publishes openly. Pagination is followed for a
 * bounded number of pages so a large directory cannot become an unbounded
 * crawl.
 */

export const DEFAULT_MAX_PAGES = 5;
export const DEFAULT_MAX_LINKS = 500;

/** Hosts that are never a customer business. */
const IGNORED_HOSTS = [
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "youtube.com",
  "pinterest.com",
  "tiktok.com",
  "wikipedia.org",
  "google.com",
  "goo.gl",
  "bit.ly",
  "apple.com",
  "play.google.com",
  "w3.org",
  "schema.org",
  "gravatar.com",
  "wordpress.org",
  "gstatic.com",
];

export function isIgnoredHost(domain: string): boolean {
  return IGNORED_HOSTS.some(
    (ignored) => domain === ignored || domain.endsWith(`.${ignored}`),
  );
}

export interface DirectoryProviderConfig {
  urls?: string[];
  maxPages?: number;
  maxLinks?: number;
  /**
   * Optional substring a link's href must contain to be considered, for
   * directories that mix member links with navigation.
   */
  linkFilter?: string;
}

export const directoryProvider: DiscoveryProvider = {
  key: "public-directory",
  label: "Public directory",
  category: "PUBLIC_DIRECTORY",
  requiresNetwork: true,
  description:
    "Reads a public listing page and treats the external businesses it links to as candidates.",

  async run(context: DiscoveryContext): Promise<DiscoveryResult> {
    const config = context.config as DirectoryProviderConfig;
    const urls = Array.isArray(config.urls) ? config.urls : [];
    const maxPages = Math.max(1, config.maxPages ?? DEFAULT_MAX_PAGES);
    const maxLinks = Math.max(1, config.maxLinks ?? DEFAULT_MAX_LINKS);
    const linkFilter =
      typeof config.linkFilter === "string" && config.linkFilter !== ""
        ? config.linkFilter.toLowerCase()
        : null;

    const result = emptyResult();
    const seen = new Set<string>();

    for (const directoryUrl of urls.slice(0, maxPages)) {
      if (context.signal?.aborted) break;
      if (seen.size >= maxLinks) break;

      result.pagesAttempted += 1;
      const document = await context.fetcher.fetch(directoryUrl);

      if (document.outcome === "BLOCKED") {
        result.pagesBlocked += 1;
        result.warnings.push(`Blocked: ${directoryUrl}`);
        continue;
      }

      if (document.outcome !== "SUCCESS" || typeof document.body !== "string") {
        result.pagesFailed += 1;
        result.warnings.push(
          `Could not read directory: ${directoryUrl} (${document.outcome})`,
        );
        continue;
      }

      result.pagesSucceeded += 1;

      const ownKey = entityKey(document.url);

      for (const match of document.body.matchAll(
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi,
      )) {
        if (seen.size >= maxLinks) break;

        const href = match[1];
        const text = stripTags(match[2]);

        if (linkFilter !== null && !href.toLowerCase().includes(linkFilter)) {
          continue;
        }

        let absolute: string;
        try {
          absolute = new URL(href, document.url).toString();
        } catch {
          continue;
        }

        const key = entityKey(absolute);
        if (key === null) continue;

        const domain = canonicalDomain(absolute);
        // Links back into the directory are navigation, not businesses.
        if (key === ownKey) continue;
        if (domain !== null && isIgnoredHost(domain)) continue;
        if (seen.has(key)) continue;

        seen.add(key);

        let origin: string;
        try {
          origin = new URL(absolute).origin;
        } catch {
          continue;
        }

        // Link text is usually the business name, but it is prose, so it is
        // recorded as a weak heuristic rather than a published fact.
        const name = text !== "" && text.length <= 120 ? text : null;

        const entity: DiscoveredEntity = {
          identity: { name, website: origin, domain },
          facts: [
            {
              field: "website",
              value: origin,
              method: "HTML_SELECTOR",
              sourceUrl: document.url,
              locator: "a[href]",
              evidence: name ?? `Listed on ${document.url}`,
            },
            ...(name !== null
              ? [
                  {
                    field: "name" as const,
                    value: name,
                    method: "TEXT_HEURISTIC" as const,
                    sourceUrl: document.url,
                    locator: "a[href] text",
                    evidence: name,
                  },
                ]
              : []),
          ],
          sourceId: context.sourceId,
        };

        result.entities.push(entity);
      }
    }

    return result;
  },
};

/**
 * Public repository provider.
 *
 * Reads a public repository host's JSON API (GitHub's is open and unauthenticated
 * for public data) and treats the homepage a repository advertises as a
 * candidate business. Useful for finding agencies and product companies.
 *
 * No token is required for public endpoints, so this stays zero-cost. If the
 * host rate-limits us, that is recorded as RATE_LIMITED and retried later
 * rather than worked around.
 */
export interface RepositoryProviderConfig {
  /** Fully-formed public API URLs returning a JSON array of repositories. */
  apiUrls?: string[];
  maxItems?: number;
}

export const repositoryProvider: DiscoveryProvider = {
  key: "public-repository",
  label: "Public repositories",
  category: "REPOSITORY",
  requiresNetwork: true,
  description:
    "Reads public repository metadata and treats the homepages it advertises as candidate businesses.",

  async run(context: DiscoveryContext): Promise<DiscoveryResult> {
    const config = context.config as RepositoryProviderConfig;
    const urls = Array.isArray(config.apiUrls) ? config.apiUrls : [];
    const maxItems = Math.max(1, config.maxItems ?? 100);

    const result = emptyResult();
    const seen = new Set<string>();

    for (const apiUrl of urls) {
      if (context.signal?.aborted) break;

      result.pagesAttempted += 1;
      const document = await context.fetcher.fetch(apiUrl);

      if (document.outcome === "BLOCKED") {
        result.pagesBlocked += 1;
        result.warnings.push(`Blocked: ${apiUrl}`);
        continue;
      }

      if (document.outcome !== "SUCCESS" || typeof document.body !== "string") {
        result.pagesFailed += 1;
        continue;
      }

      result.pagesSucceeded += 1;

      let payload: unknown;
      try {
        payload = JSON.parse(document.body);
      } catch {
        result.warnings.push(`Not valid JSON: ${apiUrl}`);
        continue;
      }

      // Accept either a bare array or GitHub's { items: [...] } search shape.
      const items = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { items?: unknown }).items)
          ? ((payload as { items: unknown[] }).items)
          : [];

      for (const item of items.slice(0, maxItems)) {
        if (item === null || typeof item !== "object") continue;

        const repo = item as Record<string, unknown>;
        const homepage = typeof repo.homepage === "string" ? repo.homepage : null;
        if (homepage === null || homepage.trim() === "") continue;

        const key = entityKey(homepage);
        if (key === null) continue;

        const domain = canonicalDomain(homepage);
        if (domain !== null && isIgnoredHost(domain)) continue;
        if (seen.has(key)) continue;

        seen.add(key);

        let origin: string;
        try {
          origin = new URL(homepage).origin;
        } catch {
          continue;
        }

        const owner = repo.owner as Record<string, unknown> | undefined;
        const name =
          typeof owner?.login === "string"
            ? owner.login
            : typeof repo.name === "string"
              ? repo.name
              : null;

        const entity: DiscoveredEntity = {
          identity: { name, website: origin, domain: canonicalDomain(origin) },
          facts: [
            {
              field: "website",
              value: origin,
              // A JSON API is machine-readable and published by the host.
              method: "STRUCTURED_DATA",
              sourceUrl: apiUrl,
              locator: "repo:homepage",
              evidence:
                typeof repo.full_name === "string"
                  ? `Homepage of ${repo.full_name}`
                  : `Homepage from ${apiUrl}`,
            },
          ],
          sourceId: context.sourceId,
        };

        result.entities.push(entity);
      }
    }

    return result;
  },
};

/**
 * Public media provider.
 *
 * Reads openly published media metadata feeds (a podcast RSS feed, a channel's
 * public feed) and treats the linked sites as candidates. Implemented as a
 * thin wrapper over the same page-reading logic, because the useful part of a
 * media page is the business it links to.
 */
export interface PublicMediaConfig {
  urls?: string[];
  maxLinks?: number;
}

export const publicMediaProvider: DiscoveryProvider = {
  key: "public-media",
  label: "Public media",
  category: "PUBLIC_MEDIA",
  requiresNetwork: true,
  description:
    "Reads publicly available media pages and metadata, and records the businesses they reference.",

  async run(context: DiscoveryContext): Promise<DiscoveryResult> {
    const config = context.config as PublicMediaConfig;
    const urls = Array.isArray(config.urls) ? config.urls : [];
    const result = emptyResult();

    for (const url of urls) {
      if (context.signal?.aborted) break;

      result.pagesAttempted += 1;
      const document = await context.fetcher.fetch(url);

      if (document.outcome === "BLOCKED") {
        result.pagesBlocked += 1;
        result.warnings.push(`Blocked: ${url}`);
        continue;
      }

      if (document.outcome !== "SUCCESS" || typeof document.body !== "string") {
        result.pagesFailed += 1;
        continue;
      }

      result.pagesSucceeded += 1;

      // Media pages describe a business; read whatever it publishes about
      // itself rather than inventing an interpretation of the media content.
      const facts = extractFacts({ url: document.url, html: document.body });
      if (facts.length === 0) continue;

      const domain = canonicalDomain(document.url);
      const name = facts.find((fact) => fact.field === "name")?.value ?? null;

      if (name === null && domain === null) continue;

      result.entities.push({
        identity: { name, website: document.url, domain },
        facts,
        sourceId: context.sourceId,
      });
    }

    return result;
  },
};
