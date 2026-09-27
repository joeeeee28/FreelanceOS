/**
 * Find Clients filters.
 *
 * Natural language is reduced to this closed set of filters, then the
 * database applies them. The text is never interpolated into SQL, and it
 * never becomes a URL. A phrase this layer does not understand is rejected
 * or reported as unknown — it is not guessed into a nearby filter.
 */

import type { LeadStatus, SignalType } from "@prisma/client";

import { MAPPING_RULES } from "@/lib/discovery/signals/opportunities";
import {
  SERVICES,
  SERVICE_KEYS,
  getService,
  isServiceKey,
  type ServiceCategory,
  type ServiceKey,
} from "@/lib/taxonomy/services";

export const WEBSITE_STATUSES = ["present", "missing", "unknown"] as const;
export type WebsiteStatus = (typeof WEBSITE_STATUSES)[number];

export const RESEARCH_FRESHNESS = ["fresh", "stale", "never"] as const;
export type ResearchFreshness = (typeof RESEARCH_FRESHNESS)[number];

export const FIND_CLIENTS_PAGE_SIZE = 25;
export const FIND_CLIENTS_MAX_PAGE = 40;
export const FIND_CLIENTS_QUERY_MAX = 200;

/** Signal types the existing opportunity mapper actually uses. */
export const FIND_CLIENT_SIGNAL_TYPES = [
  ...new Set(MAPPING_RULES.map((rule) => rule.signal)),
] as SignalType[];

const LEAD_STATUSES = [
  "NEW",
  "RESEARCHING",
  "QUALIFIED",
  "OUTREACH_READY",
  "CONTACTED",
  "RESPONDED",
  "DISCOVERY_CALL",
  "PROPOSAL",
  "NEGOTIATION",
  "WON",
  "LOST",
  "NURTURE",
] as const satisfies readonly LeadStatus[];

export type LeadPresence = LeadStatus | "NONE";

export interface FindClientsFilters {
  industry: string | null;
  location: string | null;
  businessType: string | null;
  serviceKey: ServiceKey | null;
  serviceCategory: ServiceCategory | null;
  signalType: SignalType | null;
  minConfidence: number | null;
  websiteStatus: WebsiteStatus | null;
  leadStatus: LeadPresence | null;
  minScore: number | null;
  freshness: ResearchFreshness | null;
  source: string | null;
}

export interface ParseSuccess {
  ok: true;
  filters: FindClientsFilters;
}

export interface ParseFailure {
  ok: false;
  reason: "unsupported" | "invalid" | "contradictory" | "unknown";
  message: string;
  unsupported: string[];
  unknown: string[];
}

export type ParseResult = ParseSuccess | ParseFailure;

export function emptyFilters(): FindClientsFilters {
  return {
    industry: null,
    location: null,
    businessType: null,
    serviceKey: null,
    serviceCategory: null,
    signalType: null,
    minConfidence: null,
    websiteStatus: null,
    leadStatus: null,
    minScore: null,
    freshness: null,
    source: null,
  };
}

const TEXT = /^[a-z0-9][a-z0-9 .,'-]{0,79}$/i;
const PLACE = /^[a-z][a-z .'-]{1,40}$/;

const UNSUPPORTED: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "seo", pattern: /\b(?:seo|search engine optimi[sz]ation)\b/i },
  {
    label: "decision_maker",
    pattern: /\b(?:decision[- ]?makers?|who owns|the owner|founder|ceo)\b/i,
  },
  {
    label: "contact_discovery",
    pattern:
      /\b(?:(?:find|their|with an?|missing) (?:e-?mail|phone|mobile)s?|e-?mail address|phone number)\b/i,
  },
  {
    label: "unsupported_attribute",
    pattern: /\b(?:revenue|turnover|funding|headcount|employees|tech stack|technology stack)\b/i,
  },
  {
    label: "outreach",
    pattern: /\b(?:cold e-?mail|outreach|write an e-?mail|follow-?up)\b/i,
  },
];

/** Longest phrase first so "website improvement" is not read as a bare website. */
const SERVICE_PHRASES: ReadonlyArray<{ phrase: string; key: ServiceKey }> = [
  { phrase: "website improvement opportunities", key: "WEBSITE_REDESIGN" },
  { phrase: "website improvement", key: "WEBSITE_REDESIGN" },
  { phrase: "website redesign", key: "WEBSITE_REDESIGN" },
  { phrase: "website maintenance", key: "WEBSITE_MAINTENANCE" },
  { phrase: "website creation", key: "WEBSITE_CREATION" },
  { phrase: "new website", key: "WEBSITE_CREATION" },
  { phrase: "landing pages", key: "LANDING_PAGE" },
  { phrase: "landing page", key: "LANDING_PAGE" },
  { phrase: "facebook ads", key: "META_ADS" },
  { phrase: "instagram ads", key: "META_ADS" },
  { phrase: "meta ads", key: "META_ADS" },
  { phrase: "digital marketing consulting", key: "DIGITAL_MARKETING_CONSULTING" },
  { phrase: "marketing consulting", key: "DIGITAL_MARKETING_CONSULTING" },
  { phrase: "social media management", key: "SOCIAL_MEDIA_MANAGEMENT" },
  { phrase: "content creation", key: "CONTENT_CREATION" },
  { phrase: "instagram and facebook content", key: "SOCIAL_CONTENT" },
  { phrase: "instagram content", key: "SOCIAL_CONTENT" },
  { phrase: "facebook content", key: "SOCIAL_CONTENT" },
  { phrase: "youtube thumbnails", key: "YOUTUBE_THUMBNAILS" },
  { phrase: "posters and graphics", key: "GRAPHICS_POSTERS" },
  { phrase: "posters", key: "GRAPHICS_POSTERS" },
  { phrase: "graphics", key: "GRAPHICS_POSTERS" },
  { phrase: "thumbnails", key: "YOUTUBE_THUMBNAILS" },
].sort((a, b) => b.phrase.length - a.phrase.length) as ReadonlyArray<{
  phrase: string;
  key: ServiceKey;
}>;

const CATEGORY_PHRASES: ReadonlyArray<{ phrase: string; category: ServiceCategory }> = [
  { phrase: "website opportunities", category: "WEB" },
  { phrase: "marketing opportunities", category: "MARKETING" },
  { phrase: "content opportunities", category: "CONTENT" },
  { phrase: "design opportunities", category: "DESIGN" },
];

const SIGNAL_PHRASES: ReadonlyArray<{ phrase: string; type: SignalType }> = [
  { phrase: "outdated website", type: "WEBSITE_OUTDATED" },
  { phrase: "website quality", type: "WEBSITE_QUALITY_ISSUE" },
  { phrase: "missing website", type: "WEBSITE_MISSING" },
  { phrase: "no website", type: "WEBSITE_MISSING" },
  { phrase: "without a website", type: "WEBSITE_MISSING" },
  { phrase: "no social", type: "SOCIAL_MEDIA_ABSENT" },
  { phrase: "without social", type: "SOCIAL_MEDIA_ABSENT" },
  { phrase: "marketing job", type: "MARKETING_JOB" },
  { phrase: "low content", type: "LOW_CONTENT_ACTIVITY" },
];

const LEAD_PHRASES: ReadonlyArray<{ phrase: string; status: LeadPresence }> = [
  { phrase: "no lead", status: "NONE" },
  { phrase: "new leads", status: "NEW" },
  { phrase: "new lead", status: "NEW" },
  { phrase: "qualified", status: "QUALIFIED" },
  { phrase: "contacted", status: "CONTACTED" },
  { phrase: "proposal", status: "PROPOSAL" },
  { phrase: "negotiation", status: "NEGOTIATION" },
  { phrase: "won", status: "WON" },
  { phrase: "lost", status: "LOST" },
  { phrase: "nurture", status: "NURTURE" },
];

const STOP = new Set([
  "a",
  "an",
  "the",
  "with",
  "and",
  "or",
  "for",
  "of",
  "to",
  "in",
  "on",
  "at",
  "who",
  "that",
  "have",
  "has",
  "their",
  "today",
  "find",
  "clients",
  "client",
  "opportunities",
  "opportunity",
  "showing",
  "show",
  "me",
  "please",
  "looking",
  "approach",
]);

const FORM_WORDS = new Set([
  "clinic",
  "clinics",
  "agency",
  "agencies",
  "practice",
  "practices",
  "studio",
  "studios",
  "shop",
  "shops",
  "firm",
  "firms",
  "center",
  "centre",
  "centers",
  "centres",
  "company",
  "companies",
  "business",
  "businesses",
]);

function fail(
  reason: ParseFailure["reason"],
  message: string,
  extra: { unsupported?: string[]; unknown?: string[] } = {},
): ParseFailure {
  return {
    ok: false,
    reason,
    message,
    unsupported: extra.unsupported ?? [],
    unknown: extra.unknown ?? [],
  };
}

function boundedInt(raw: string, max: number): number | null {
  if (!/^[0-9]{1,3}$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) return null;
  return value;
}

function textFilter(raw: string | undefined, label: string): string | ParseFailure {
  if (raw === undefined || raw.trim() === "") return "";
  const value = raw.trim().replace(/\s+/g, " ");
  if (!TEXT.test(value) || value.includes("%") || value.includes("_")) {
    return fail("invalid", `${label} contains characters this search will not accept.`);
  }
  return value;
}

export function parsePage(raw: string | undefined): number | ParseFailure {
  if (raw === undefined || raw.trim() === "") return 1;
  const value = boundedInt(raw.trim(), FIND_CLIENTS_MAX_PAGE);
  if (value === null || value < 1) {
    return fail("invalid", "Page is not a page this search will use.");
  }
  return value;
}

/**
 * Validates the GET form. Unknown keys are ignored. Known keys that are
 * malformed fail the whole query so a bad value cannot be dropped and the
 * rest quietly searched.
 */
export function parseStructuredFilters(
  input: Record<string, string | undefined>,
): ParseResult {
  const filters = emptyFilters();

  const industry = textFilter(input.industry, "Industry");
  if (typeof industry !== "string") return industry;
  filters.industry = industry === "" ? null : industry.toLowerCase();

  const businessType = textFilter(input.businessType, "Business type");
  if (typeof businessType !== "string") return businessType;
  filters.businessType = businessType === "" ? null : businessType.toLowerCase();

  const location = textFilter(input.location, "Location");
  if (typeof location !== "string") return location;
  if (location !== "" && !PLACE.test(location.toLowerCase())) {
    return fail("invalid", "Location is not a place name this search will use.");
  }
  filters.location = location === "" ? null : location.toLowerCase();

  const service = input.service?.trim() ?? "";
  if (service !== "") {
    if (!isServiceKey(service)) {
      return fail("invalid", "Service is not in the FreelanceOS catalog.");
    }
    filters.serviceKey = service;
  }

  const signal = input.signal?.trim() ?? "";
  if (signal !== "") {
    if (!(FIND_CLIENT_SIGNAL_TYPES as string[]).includes(signal)) {
      return fail("invalid", "Opportunity type is not one this search can filter on.");
    }
    filters.signalType = signal as SignalType;
  }

  const website = input.website?.trim() ?? "";
  if (website !== "") {
    if (!(WEBSITE_STATUSES as readonly string[]).includes(website)) {
      return fail("invalid", "Website status is not a known value.");
    }
    filters.websiteStatus = website as WebsiteStatus;
  }

  const freshness = input.freshness?.trim() ?? "";
  if (freshness !== "") {
    if (!(RESEARCH_FRESHNESS as readonly string[]).includes(freshness)) {
      return fail("invalid", "Research freshness is not a known value.");
    }
    filters.freshness = freshness as ResearchFreshness;
  }

  const lead = input.lead?.trim() ?? "";
  if (lead !== "") {
    if (lead !== "NONE" && !(LEAD_STATUSES as readonly string[]).includes(lead)) {
      return fail("invalid", "Lead status is not a known value.");
    }
    filters.leadStatus = lead as LeadPresence;
  }

  const score = input.minScore?.trim() ?? "";
  if (score !== "") {
    const value = boundedInt(score, 100);
    if (value === null) return fail("invalid", "Minimum score must be a whole number from 0 to 100.");
    filters.minScore = value;
  }

  const confidence = input.minConfidence?.trim() ?? "";
  if (confidence !== "") {
    const value = boundedInt(confidence, 100);
    if (value === null) {
      return fail("invalid", "Minimum confidence must be a whole number from 0 to 100.");
    }
    filters.minConfidence = value;
  }

  const source = textFilter(input.source, "Source");
  if (typeof source !== "string") return source;
  filters.source = source === "" ? null : source;

  return { ok: true, filters };
}

function cut(text: string, phrase: string): string | null {
  const index = text.indexOf(phrase);
  if (index < 0) return null;
  return `${text.slice(0, index)} ${text.slice(index + phrase.length)}`.replace(/\s+/g, " ").trim();
}

/**
 * Converts a natural-language request into structured filters.
 *
 * An empty string is a valid "no extra filter". A request for something this
 * layer cannot represent fails closed and must not be searched.
 */
export function parseNaturalLanguage(query: string): ParseResult {
  const trimmed = query.trim().replace(/\s+/g, " ");
  if (trimmed === "") return { ok: true, filters: emptyFilters() };
  if (trimmed.length > FIND_CLIENTS_QUERY_MAX) {
    return fail("invalid", "Search text is longer than this page will accept.");
  }

  const unsupported = UNSUPPORTED.filter((entry) => entry.pattern.test(trimmed)).map(
    (entry) => entry.label,
  );
  if (unsupported.length > 0) {
    return fail(
      "unsupported",
      "That search asks for something Find Clients will not guess: " +
        unsupported.join(", ") +
        ".",
      { unsupported },
    );
  }

  let rest = trimmed.toLowerCase();
  const filters = emptyFilters();
  const services = new Set<ServiceKey>();

  for (const entry of SERVICE_PHRASES) {
    const next = cut(rest, entry.phrase);
    if (next === null) continue;
    services.add(entry.key);
    rest = next;
  }
  if (services.size > 1) {
    return fail("contradictory", "Name one service. This search will not pick between several.");
  }
  filters.serviceKey = [...services][0] ?? null;

  for (const entry of CATEGORY_PHRASES) {
    const next = cut(rest, entry.phrase);
    if (next === null) continue;
    if (filters.serviceCategory !== null && filters.serviceCategory !== entry.category) {
      return fail("contradictory", "Name one kind of opportunity.");
    }
    filters.serviceCategory = entry.category;
    rest = next;
  }
  if (filters.serviceKey !== null && filters.serviceCategory !== null) {
    const service = getService(filters.serviceKey);
    if (service !== undefined && service.category !== filters.serviceCategory) {
      return fail("contradictory", "The service and the opportunity kind do not match.");
    }
    filters.serviceCategory = null;
  }

  for (const entry of SIGNAL_PHRASES) {
    const next = cut(rest, entry.phrase);
    if (next === null) continue;
    if (filters.signalType !== null && filters.signalType !== entry.type) {
      return fail("contradictory", "Name one opportunity type.");
    }
    filters.signalType = entry.type;
    rest = next;
  }

  const location = /\bin ([a-z][a-z.' -]{1,40}?)(?= with | and | that | who |$)/.exec(rest);
  if (location !== null) {
    const place = location[1].trim().replace(/\s+/g, " ");
    if (!PLACE.test(place) || /^(?:the|a|an|their)\b/.test(place)) {
      return fail("invalid", "Location is not a place name this search will use.");
    }
    filters.location = place;
    rest = cut(rest, location[0]) ?? rest;
  }

  if (/\bunknown website\b/.test(rest)) {
    filters.websiteStatus = "unknown";
    rest = rest.replace(/\bunknown website\b/g, " ");
  } else if (/\b(?:no|missing|without a) website\b/.test(rest)) {
    filters.websiteStatus = "missing";
    rest = rest.replace(/\b(?:no|missing|without a) website\b/g, " ");
  } else if (/\b(?:with a|has a) website\b/.test(rest)) {
    filters.websiteStatus = "present";
    rest = rest.replace(/\b(?:with a|has a) website\b/g, " ");
  }

  if (/\b(?:fresh research|recently researched)\b/.test(rest)) {
    filters.freshness = "fresh";
    rest = rest.replace(/\b(?:fresh research|recently researched)\b/g, " ");
  } else if (/\bstale research\b/.test(rest)) {
    filters.freshness = "stale";
    rest = rest.replace(/\bstale research\b/g, " ");
  } else if (/\b(?:never researched|not researched)\b/.test(rest)) {
    filters.freshness = "never";
    rest = rest.replace(/\b(?:never researched|not researched)\b/g, " ");
  }

  const score = /\bscore (?:over|above|at least|>=)\s*(\d{1,3})\b/.exec(rest);
  if (score !== null) {
    const value = boundedInt(score[1], 100);
    if (value === null) return fail("invalid", "Minimum score must be a whole number from 0 to 100.");
    filters.minScore = value;
    rest = rest.replace(score[0], " ");
  }

  const confidence = /\bconfidence (?:over|above|at least|>=)\s*(\d{1,3})\b/.exec(rest);
  if (confidence !== null) {
    const value = boundedInt(confidence[1], 100);
    if (value === null) {
      return fail("invalid", "Minimum confidence must be a whole number from 0 to 100.");
    }
    filters.minConfidence = value;
    rest = rest.replace(confidence[0], " ");
  }

  for (const entry of LEAD_PHRASES) {
    if (!rest.includes(entry.phrase)) continue;
    if (filters.leadStatus !== null && filters.leadStatus !== entry.status) {
      return fail("contradictory", "Name one lead status.");
    }
    filters.leadStatus = entry.status;
    rest = rest.replaceAll(entry.phrase, " ");
  }

  const words = rest
    .replace(/[^a-z0-9 '-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word !== "" && !STOP.has(word) && !FORM_WORDS.has(word));

  const unknown = words.filter((word) => !/^[a-z][a-z'-]{1,30}$/.test(word));
  if (unknown.length > 0) {
    return fail("unknown", "Part of that search is not a filter this page understands.", {
      unknown,
    });
  }

  if (words.length > 0) {
    const industry = words.join(" ");
    if (industry.length > 60) {
      return fail("invalid", "Industry text is longer than this search will use.");
    }
    filters.industry = industry;
  }

  return { ok: true, filters };
}

function same<T>(left: T | null, right: T | null): boolean {
  return left === null || right === null || left === right;
}

/**
 * Form values and natural-language values are AND-ed. If both name a
 * different value for the same filter, the query is contradictory and is
 * not searched.
 */
export function mergeFilters(form: FindClientsFilters, natural: FindClientsFilters): ParseResult {
  const keys = Object.keys(form) as Array<keyof FindClientsFilters>;
  for (const key of keys) {
    if (!same(form[key], natural[key])) {
      return fail("contradictory", `The form and the search text disagree on ${key}.`);
    }
  }

  return {
    ok: true,
    filters: {
      industry: form.industry ?? natural.industry,
      location: form.location ?? natural.location,
      businessType: form.businessType ?? natural.businessType,
      serviceKey: form.serviceKey ?? natural.serviceKey,
      serviceCategory: form.serviceCategory ?? natural.serviceCategory,
      signalType: form.signalType ?? natural.signalType,
      minConfidence: form.minConfidence ?? natural.minConfidence,
      websiteStatus: form.websiteStatus ?? natural.websiteStatus,
      leadStatus: form.leadStatus ?? natural.leadStatus,
      minScore: form.minScore ?? natural.minScore,
      freshness: form.freshness ?? natural.freshness,
      source: form.source ?? natural.source,
    },
  };
}

export function serviceOptions(): Array<{ value: string; label: string }> {
  return SERVICES.map((service) => ({ value: service.key, label: service.label }));
}

export function signalOptions(): Array<{ value: string; label: string }> {
  return FIND_CLIENT_SIGNAL_TYPES.map((type) => ({
    value: type,
    label: type.toLowerCase().replaceAll("_", " "),
  }));
}

export { SERVICE_KEYS };
