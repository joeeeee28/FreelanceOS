import type {
  DiscoveryContext,
  DiscoveryProvider,
  DiscoveryResult,
} from "../provider";
import { emptyResult } from "../provider";
import { parseFeed } from "../feed";
import { extractFacts, stripTags } from "../extract";
import { canonicalDomain, entityKey } from "../canonical";
import type { DiscoveredEntity, ObservedFact } from "../ingest";

/**
 * Public job / career-page provider.
 *
 * A company advertising a marketing, social-media or web role is telling the
 * world it has work in that area and, often, not enough capacity to do it.
 * That is one of the strongest buying signals available from public data.
 *
 * This provider only reads job listings a company publishes openly — a feed
 * it offers, or its own careers page. It never touches a job board that
 * requires an account, and it never bypasses an access control.
 */

/**
 * Role keywords mapped to the hiring intent they imply.
 *
 * Deliberately a small, explicit table rather than fuzzy matching: a false
 * hiring signal sends the user to pitch a business that is not buying.
 */
export const ROLE_KEYWORDS = {
  SOCIAL_MEDIA: [
    "social media",
    "community manager",
    "instagram",
    "content creator",
  ],
  MARKETING: [
    "marketing manager",
    "marketing executive",
    "digital marketing",
    "growth marketer",
    "performance marketing",
    "seo specialist",
  ],
  CONTENT: ["content writer", "copywriter", "content strategist", "content marketing"],
  WEB: ["web developer", "web designer", "frontend developer", "webmaster"],
  DESIGN: ["graphic designer", "visual designer", "brand designer"],
  VIDEO: ["video editor", "videographer", "motion designer"],
} as const;

export type HiringArea = keyof typeof ROLE_KEYWORDS;

export const HIRING_AREAS = Object.keys(ROLE_KEYWORDS) as HiringArea[];

/**
 * Classifies a job title into hiring areas.
 *
 * Returns every area that matches, because "Social Media & Content Executive"
 * legitimately signals two areas.
 */
export function classifyRole(title: string): HiringArea[] {
  const text = title.toLowerCase();

  return HIRING_AREAS.filter((area) =>
    ROLE_KEYWORDS[area].some((keyword) => text.includes(keyword)),
  );
}

export interface JobsProviderConfig {
  /** Job feeds (RSS/Atom) to read. */
  feedUrls?: string[];
  /** Career pages to read directly. */
  careerPageUrls?: string[];
  maxAgeDays?: number | null;
}

export const DEFAULT_JOB_MAX_AGE_DAYS = 60;

export const jobsProvider: DiscoveryProvider = {
  key: "public-jobs",
  label: "Public job listings",
  category: "PUBLIC_JOBS",
  requiresNetwork: true,
  description:
    "Reads openly published job feeds and career pages, and records hiring in marketing, content, social and web roles as a buying signal.",

  async run(context: DiscoveryContext): Promise<DiscoveryResult> {
    const config = context.config as JobsProviderConfig;
    const feedUrls = Array.isArray(config.feedUrls) ? config.feedUrls : [];
    const careerUrls = Array.isArray(config.careerPageUrls)
      ? config.careerPageUrls
      : [];
    const maxAgeDays =
      config.maxAgeDays === null
        ? null
        : (config.maxAgeDays ?? DEFAULT_JOB_MAX_AGE_DAYS);

    const cutoff =
      maxAgeDays === null
        ? null
        : new Date(context.now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);

    const result = emptyResult();

    // Accumulate per-domain so several postings from one company produce one
    // entity carrying every hiring area, not one entity per advert.
    const byDomain = new Map<
      string,
      { origin: string; name: string | null; areas: Set<HiringArea>; titles: string[]; sourceUrl: string }
    >();

    for (const feedUrl of feedUrls) {
      if (context.signal?.aborted) break;
      await readJobFeed(context, feedUrl, cutoff, byDomain, result);
    }

    for (const pageUrl of careerUrls) {
      if (context.signal?.aborted) break;
      await readCareerPage(context, pageUrl, byDomain, result);
    }

    for (const [key, record] of byDomain) {
      if (record.areas.size === 0) continue;

      const facts: ObservedFact[] = [
        {
          field: "website",
          value: record.origin,
          method: "FEED",
          sourceUrl: record.sourceUrl,
          locator: "job:company-url",
          evidence: `Hiring: ${record.titles.slice(0, 3).join("; ")}`,
        },
      ];

      if (record.name !== null) {
        facts.push({
          field: "name",
          value: record.name,
          method: "TEXT_HEURISTIC",
          sourceUrl: record.sourceUrl,
          locator: "job:company-name",
          evidence: record.titles[0] ?? "",
        });
      }

      const entity: DiscoveredEntity = {
        identity: {
          name: record.name,
          website: record.origin,
          domain: canonicalDomain(record.origin),
        },
        facts,
        sourceId: context.sourceId,
      };

      result.entities.push(entity);

      // Hiring areas travel as a structured note for the signal detector,
      // which reads them from the run rather than re-parsing HTML.
      result.warnings.push(
        `hiring:${key}:${[...record.areas].sort().join(",")}`,
      );
    }

    return result;
  },
};

type DomainMap = Map<
  string,
  {
    origin: string;
    name: string | null;
    areas: Set<HiringArea>;
    titles: string[];
    sourceUrl: string;
  }
>;

function record(
  map: DomainMap,
  domain: string,
  origin: string,
  sourceUrl: string,
  name: string | null,
  title: string,
  areas: HiringArea[],
) {
  const existing = map.get(domain);

  if (existing === undefined) {
    map.set(domain, {
      origin,
      name,
      areas: new Set(areas),
      titles: [title],
      sourceUrl,
    });
    return;
  }

  for (const area of areas) existing.areas.add(area);
  if (existing.titles.length < 10) existing.titles.push(title);
  existing.name ??= name;
}

async function readJobFeed(
  context: DiscoveryContext,
  feedUrl: string,
  cutoff: Date | null,
  map: DomainMap,
  result: DiscoveryResult,
): Promise<void> {
  result.pagesAttempted += 1;
  const document = await context.fetcher.fetch(feedUrl);

  if (document.outcome === "BLOCKED") {
    result.pagesBlocked += 1;
    result.warnings.push(`Blocked: ${feedUrl}`);
    return;
  }

  if (document.outcome !== "SUCCESS" || typeof document.body !== "string") {
    result.pagesFailed += 1;
    return;
  }

  result.pagesSucceeded += 1;

  for (const item of parseFeed(document.body).items) {
    if (item.title === null || item.link === null) continue;
    if (cutoff !== null && item.publishedAt !== null && item.publishedAt < cutoff) {
      continue;
    }

    const areas = classifyRole(item.title);
    if (areas.length === 0) continue;

    const key = entityKey(item.link);
    if (key === null) continue;

    let origin: string;
    try {
      origin = new URL(item.link).origin;
    } catch {
      continue;
    }

    record(map, key, origin, feedUrl, item.author, item.title, areas);
  }
}

/** Reads a company's own careers page. */
async function readCareerPage(
  context: DiscoveryContext,
  pageUrl: string,
  map: DomainMap,
  result: DiscoveryResult,
): Promise<void> {
  result.pagesAttempted += 1;
  const document = await context.fetcher.fetch(pageUrl);

  if (document.outcome === "BLOCKED") {
    result.pagesBlocked += 1;
    result.warnings.push(`Blocked: ${pageUrl}`);
    return;
  }

  if (document.outcome !== "SUCCESS" || typeof document.body !== "string") {
    result.pagesFailed += 1;
    return;
  }

  result.pagesSucceeded += 1;

  const key = entityKey(document.url);
  if (key === null) return;

  let origin: string;
  try {
    origin = new URL(document.url).origin;
  } catch {
    return;
  }

  // Headings and list items are where job titles live on a careers page.
  const candidates = [
    ...document.body.matchAll(/<(h[1-4]|li|a)\b[^>]*>([\s\S]{0,200}?)<\/\1>/gi),
  ]
    .map((match) => stripTags(match[2]))
    .filter((text) => text.length > 0 && text.length <= 120);

  // The company name, if the page publishes it.
  const pageFacts = extractFacts({ url: document.url, html: document.body });
  const name = pageFacts.find((fact) => fact.field === "name")?.value ?? null;

  for (const title of candidates) {
    const areas = classifyRole(title);
    if (areas.length === 0) continue;

    record(map, key, origin, pageUrl, name, title, areas);
  }
}
