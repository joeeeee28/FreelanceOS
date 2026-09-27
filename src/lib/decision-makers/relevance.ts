/**
 * Why a stored person may be relevant.
 *
 * The reading is a closed table applied to the stored title. It is not a
 * score, and it is not a model opinion. A senior-sounding title with no
 * function is not treated as a decision maker.
 */

import { SERVICE_KEYS, getService, type ServiceKey } from "@/lib/taxonomy/services";

export const ROLE_CATEGORIES = [
  "founder",
  "leadership",
  "marketing",
  "content",
  "design",
  "technology",
  "operations",
  "unknown",
] as const;

export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

export interface RoleReading {
  category: RoleCategory;
  /** Catalog keys this title can relate to. Empty when the title has no function. */
  serviceKeys: ServiceKey[];
  /**
   * True only for a function match, or for founder/owner. A bare senior title
   * stays false.
   */
  decisionMaker: boolean;
  reasons: string[];
}

const RULES = ([
  { phrase: "co-founder", category: "founder", services: [] },
  { phrase: "cofounder", category: "founder", services: [] },
  { phrase: "founder", category: "founder", services: [] },
  { phrase: "proprietor", category: "founder", services: [] },
  { phrase: "owner", category: "founder", services: [] },
  { phrase: "head of marketing", category: "marketing", services: ["META_ADS", "SOCIAL_MEDIA_MANAGEMENT", "DIGITAL_MARKETING_CONSULTING"] },
  { phrase: "marketing director", category: "marketing", services: ["META_ADS", "SOCIAL_MEDIA_MANAGEMENT", "DIGITAL_MARKETING_CONSULTING"] },
  { phrase: "marketing manager", category: "marketing", services: ["META_ADS", "SOCIAL_MEDIA_MANAGEMENT", "DIGITAL_MARKETING_CONSULTING"] },
  { phrase: "digital marketing manager", category: "marketing", services: ["META_ADS", "DIGITAL_MARKETING_CONSULTING"] },
  { phrase: "growth manager", category: "marketing", services: ["META_ADS", "DIGITAL_MARKETING_CONSULTING"] },
  { phrase: "growth lead", category: "marketing", services: ["META_ADS", "DIGITAL_MARKETING_CONSULTING"] },
  { phrase: "brand manager", category: "marketing", services: ["SOCIAL_MEDIA_MANAGEMENT", "CONTENT_CREATION"] },
  { phrase: "social media manager", category: "marketing", services: ["SOCIAL_MEDIA_MANAGEMENT", "SOCIAL_CONTENT"] },
  { phrase: "e-commerce manager", category: "marketing", services: ["LANDING_PAGE", "WEBSITE_REDESIGN"] },
  { phrase: "ecommerce manager", category: "marketing", services: ["LANDING_PAGE", "WEBSITE_REDESIGN"] },
  { phrase: "content manager", category: "content", services: ["CONTENT_CREATION", "SOCIAL_CONTENT"] },
  { phrase: "content lead", category: "content", services: ["CONTENT_CREATION", "SOCIAL_CONTENT"] },
  { phrase: "head of design", category: "design", services: ["GRAPHICS_POSTERS", "YOUTUBE_THUMBNAILS"] },
  { phrase: "design director", category: "design", services: ["GRAPHICS_POSTERS", "YOUTUBE_THUMBNAILS"] },
  { phrase: "technology director", category: "technology", services: ["WEBSITE_CREATION", "WEBSITE_REDESIGN", "WEBSITE_MAINTENANCE"] },
  { phrase: "it manager", category: "technology", services: ["WEBSITE_MAINTENANCE", "WEBSITE_REDESIGN"] },
  { phrase: "head of technology", category: "technology", services: ["WEBSITE_CREATION", "WEBSITE_REDESIGN", "WEBSITE_MAINTENANCE"] },
  { phrase: "operations manager", category: "operations", services: ["WEBSITE_MAINTENANCE", "DIGITAL_MARKETING_CONSULTING"] },
  { phrase: "managing director", category: "leadership", services: [] },
  { phrase: "chief executive", category: "leadership", services: [] },
  { phrase: "ceo", category: "leadership", services: [] },
] satisfies ReadonlyArray<{ phrase: string; category: RoleCategory; services: ServiceKey[] }>).sort(
  (a, b) => b.phrase.length - a.phrase.length,
);

function knownServices(keys: ServiceKey[]): ServiceKey[] {
  return keys.filter((key) => SERVICE_KEYS.includes(key) && getService(key) !== undefined);
}

/** Reads a stored title. Unknown stays unknown. */
export function readRole(title: string | null | undefined): RoleReading {
  const text = typeof title === "string" ? title.toLowerCase() : "";
  const rule = RULES.find((entry) => text.includes(entry.phrase));
  if (rule === undefined) {
    return {
      category: "unknown",
      serviceKeys: [],
      decisionMaker: false,
      reasons: ["The stored title does not match a service role this page recognises."],
    };
  }

  const decisionMaker = rule.category !== "leadership";
  return {
    category: rule.category,
    serviceKeys: knownServices(rule.services),
    decisionMaker,
    reasons: [
      decisionMaker
        ? `Title matches ${rule.category}, which is a function, not seniority alone.`
        : "Title is senior, but seniority alone is not treated as a decision maker.",
    ],
  };
}

export type PersonDisplayState = "VERIFIED" | "LIKELY" | "UNVERIFIED" | "NO_CONTACT_DATA";

export function personDisplayState(person: {
  verification: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
}): PersonDisplayState {
  if (person.verification === "PUBLISHED") return "VERIFIED";
  if (person.verification === "NAME_AND_ROLE" || person.verification === "CONTACTABLE") return "LIKELY";
  if (person.email === null && person.phone === null && person.linkedinUrl === null) return "NO_CONTACT_DATA";
  return "UNVERIFIED";
}

export function contactLine(value: string | null): string {
  return value ?? "Not publicly verified";
}
