/**
 * Classifying and summarising public resources.
 *
 * The knowledge engine remembers *about* things it reads: what a page was,
 * which topics it covered, which of our services it relates to. It does not
 * keep the thing itself. That is a copyright position as much as a storage
 * one — storing a capped, attributed excerpt alongside a link is fair; keeping
 * a full copy of someone's article in our database is not, however convenient
 * it would be for search.
 *
 * All classification is keyword-and-rule based. There is no model here, which
 * means the reason a resource was tagged "Meta Ads" is always a word that
 * actually appeared in it.
 */

import type { KnowledgeSourceType } from "@prisma/client";

import { SERVICE_KEYS } from "@/lib/taxonomy/services";

/** Hard cap on a stored excerpt. Attribution, not reproduction. */
export const MAX_EXCERPT_CHARS = 300;

/** Hard cap on our own generated summary. */
export const MAX_SUMMARY_CHARS = 500;

/** Topic keywords. Matching is whole-word and case-insensitive. */
const TOPIC_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "web-design": ["web design", "website design", "redesign", "ux", "ui", "wireframe"],
  "web-development": ["html", "css", "javascript", "wordpress", "webflow", "cms"],
  seo: ["seo", "search engine", "serp", "backlink", "keyword research"],
  "paid-advertising": ["ppc", "google ads", "meta ads", "facebook ads", "ad spend", "roas"],
  "social-media": ["instagram", "tiktok", "linkedin", "social media", "reels", "engagement rate"],
  "content-marketing": ["content marketing", "blogging", "copywriting", "newsletter"],
  branding: ["branding", "brand identity", "logo", "visual identity"],
  analytics: ["analytics", "conversion rate", "attribution", "ga4", "tracking"],
  video: ["youtube", "video editing", "thumbnail", "shorts"],
  ecommerce: ["ecommerce", "e-commerce", "shopify", "woocommerce", "checkout"],
  freelancing: ["freelance", "client acquisition", "retainer", "proposal", "invoicing"],
  "small-business": ["small business", "local business", "sme", "startup"],
};

/** Which services each topic is evidence of interest in. */
const TOPIC_SERVICES: Readonly<Record<string, readonly string[]>> = {
  "web-design": ["WEBSITE_CREATION", "WEBSITE_REDESIGN", "LANDING_PAGE"],
  "web-development": ["WEBSITE_CREATION", "WEBSITE_MAINTENANCE"],
  seo: ["DIGITAL_MARKETING_CONSULTING", "CONTENT_CREATION"],
  "paid-advertising": ["META_ADS", "DIGITAL_MARKETING_CONSULTING"],
  "social-media": ["SOCIAL_MEDIA_MANAGEMENT", "SOCIAL_CONTENT"],
  "content-marketing": ["CONTENT_CREATION", "SOCIAL_CONTENT"],
  branding: ["GRAPHICS_POSTERS"],
  analytics: ["DIGITAL_MARKETING_CONSULTING"],
  video: ["YOUTUBE_THUMBNAILS"],
  ecommerce: ["WEBSITE_CREATION", "LANDING_PAGE"],
  freelancing: [],
  "small-business": [],
};

/** URL and title patterns that identify a kind of resource. */
const SOURCE_TYPE_HINTS: ReadonlyArray<{
  type: KnowledgeSourceType;
  hosts?: readonly string[];
  pathParts?: readonly string[];
}> = [
  { type: "REPOSITORY", hosts: ["github.com", "gitlab.com", "codeberg.org"] },
  { type: "VIDEO", hosts: ["youtube.com", "youtu.be", "vimeo.com"] },
  { type: "COMMUNITY", hosts: ["reddit.com", "stackoverflow.com", "news.ycombinator.com"] },
  { type: "DOCUMENTATION", pathParts: ["/docs/", "/documentation/", "/reference/"] },
  { type: "BLOG", pathParts: ["/blog/", "/posts/", "/journal/"] },
  { type: "NEWS", pathParts: ["/news/", "/press/"] },
  { type: "TUTORIAL", pathParts: ["/tutorial", "/guide", "/how-to"] },
  { type: "RESEARCH", pathParts: ["/research/", "/study/", "/whitepaper"] },
  { type: "PODCAST", pathParts: ["/podcast", "/episode"] },
];

/**
 * Infers what kind of resource a URL points at.
 *
 * Returns OTHER when nothing matches, rather than guessing at the most common
 * type. A wrong label is worse than an honest "unclassified".
 */
export function classifySourceType(
  url: string,
  title?: string | null,
): KnowledgeSourceType {
  let host = "";
  let path = "";

  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    path = parsed.pathname.toLowerCase();
  } catch {
    return "OTHER";
  }

  for (const hint of SOURCE_TYPE_HINTS) {
    if (hint.hosts?.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) {
      return hint.type;
    }
  }

  for (const hint of SOURCE_TYPE_HINTS) {
    if (hint.pathParts?.some((part) => path.includes(part))) {
      return hint.type;
    }
  }

  const lowerTitle = (title ?? "").toLowerCase();
  if (/\b(how to|tutorial|step[- ]by[- ]step|guide)\b/.test(lowerTitle)) {
    return "TUTORIAL";
  }

  return "OTHER";
}

export interface TopicMatch {
  slug: string;
  /** 0-100 from how many distinct keywords matched. Never a guess. */
  confidence: number;
  /** The words that actually appeared. This is the whole justification. */
  matchedTerms: string[];
}

/** Escapes a term for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the topics a piece of text covers.
 *
 * Whole-word matching, so "ui" does not match "building" and "seo" does not
 * match "seoul". Confidence rises with the number of distinct terms found,
 * because one passing mention is much weaker evidence than five.
 */
export function classifyTopics(text: string, limit = 5): TopicMatch[] {
  if (text.trim() === "") return [];

  const haystack = text.toLowerCase();
  const matches: TopicMatch[] = [];

  for (const [slug, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const matched: string[] = [];

    for (const keyword of keywords) {
      const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(keyword)}([^a-z0-9]|$)`, "i");
      if (pattern.test(haystack)) matched.push(keyword);
    }

    if (matched.length === 0) continue;

    // One mention is weak, three is solid, more adds little.
    const confidence = Math.min(100, 30 + matched.length * 20);
    matches.push({ slug, confidence, matchedTerms: matched });
  }

  return matches
    .sort((a, b) => b.confidence - a.confidence || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

/**
 * Maps matched topics onto service taxonomy keys.
 *
 * Deduplicated and filtered against the real taxonomy, so a typo in the table
 * above cannot introduce a service that does not exist.
 */
export function servicesForTopics(topics: readonly TopicMatch[]): string[] {
  const services = new Set<string>();

  for (const topic of topics) {
    for (const service of TOPIC_SERVICES[topic.slug] ?? []) {
      if ((SERVICE_KEYS as readonly string[]).includes(service)) {
        services.add(service);
      }
    }
  }

  return [...services].sort();
}

/**
 * Removes control characters and collapses whitespace.
 *
 * Crawled text is untrusted input. It reaches a database, a JSON column and
 * eventually a browser, so it is cleaned once at the boundary.
 */
export function sanitiseText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds a short, attributed excerpt.
 *
 * Hard-capped and cut at a word boundary. This is the only place original text
 * is retained, and the cap is what keeps it quotation rather than copying.
 */
export function buildExcerpt(text: string, max = MAX_EXCERPT_CHARS): string | null {
  const clean = sanitiseText(text);
  if (clean === "") return null;
  if (clean.length <= max) return clean;

  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");

  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Produces our own one-or-two sentence summary.
 *
 * Extractive: it selects the opening sentences rather than generating new
 * text, so the summary cannot assert anything the source did not.
 */
export function buildSummary(text: string, max = MAX_SUMMARY_CHARS): string | null {
  const clean = sanitiseText(text);
  if (clean === "") return null;

  const sentences = clean.match(/[^.!?]+[.!?]+/g) ?? [clean];
  let summary = "";

  for (const sentence of sentences) {
    const candidate = `${summary}${sentence}`.trim();
    if (candidate.length > max) break;
    summary = `${candidate} `;
  }

  const result = summary.trim();
  if (result === "") return buildExcerpt(clean, max);

  return result;
}

export interface RelevanceResult {
  score: number;
  rationale: Array<{ code: string; label: string; points: number }>;
}

/**
 * Scores how useful a resource is to this business.
 *
 * Deterministic and explainable, matching the lead scorer's contract: a user
 * can always see which points came from where.
 */
export function scoreRelevance(input: {
  topics: readonly TopicMatch[];
  services: readonly string[];
  publishedAt?: Date | null;
  now?: Date;
}): RelevanceResult {
  const rationale: RelevanceResult["rationale"] = [];
  const now = input.now ?? new Date();

  if (input.services.length > 0) {
    const points = Math.min(40, input.services.length * 15);
    rationale.push({
      code: "SERVICE_MATCH",
      label: `Relevant to ${input.services.length} of your services`,
      points,
    });
  }

  const strong = input.topics.filter((topic) => topic.confidence >= 70);
  if (strong.length > 0) {
    rationale.push({
      code: "STRONG_TOPIC",
      label: `${strong.length} clearly identified topic${strong.length === 1 ? "" : "s"}`,
      points: Math.min(30, strong.length * 15),
    });
  } else if (input.topics.length > 0) {
    rationale.push({
      code: "WEAK_TOPIC",
      label: "Topics identified, but only in passing",
      points: 10,
    });
  }

  if (input.publishedAt != null) {
    const months =
      (now.getTime() - input.publishedAt.getTime()) / (1000 * 60 * 60 * 24 * 30);

    if (months < 0) {
      // A future publication date is bad metadata, not freshness.
      rationale.push({ code: "DATE_INVALID", label: "Publication date is in the future", points: 0 });
    } else if (months <= 6) {
      rationale.push({ code: "RECENT", label: "Published within six months", points: 20 });
    } else if (months <= 24) {
      rationale.push({ code: "FAIRLY_RECENT", label: "Published within two years", points: 10 });
    } else {
      rationale.push({ code: "DATED", label: "More than two years old", points: 0 });
    }
  }
  // No date means no points. It does not mean a penalty, and it is never
  // treated as "probably recent".

  const total = rationale.reduce((sum, entry) => sum + entry.points, 0);

  return { score: Math.max(0, Math.min(100, total)), rationale };
}
