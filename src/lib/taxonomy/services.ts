/**
 * Freelance service taxonomy.
 *
 * Services are referenced by stable machine keys everywhere in the codebase.
 * Display names live here and nowhere else, so renaming a service is a
 * one-line change that cannot drift between the UI, the scoring engine and
 * the opportunity mapper.
 *
 * Adding a service means adding one entry. Nothing else in the system
 * enumerates services by hand.
 *
 * Deliberately dependency-free and side-effect-free so it can be imported by
 * the worker, the web app and the tests alike.
 */

export const SERVICE_CATEGORIES = {
  WEB: "Web",
  MARKETING: "Marketing",
  CONTENT: "Content",
  DESIGN: "Design",
  ADVISORY: "Advisory",
} as const;

export type ServiceCategory = keyof typeof SERVICE_CATEGORIES;

export interface ServiceDefinition {
  /** Stable machine key. Persisted. Never rename without a migration. */
  key: string;
  label: string;
  category: ServiceCategory;
  /** One line a freelancer would actually say to describe the work. */
  summary: string;
  /**
   * Typical engagement shape. Used to sort opportunities by revenue
   * durability: retainers are worth more than one-off projects.
   */
  engagement: "PROJECT" | "RETAINER" | "EITHER";
}

/**
 * The services this operating system can detect opportunities for.
 *
 * Ordered roughly by how directly they convert to revenue for a solo
 * freelancer, which is also a sensible default display order.
 */
export const SERVICES = [
  {
    key: "WEBSITE_CREATION",
    label: "Website creation",
    category: "WEB",
    summary: "Build a first website for a business that has none.",
    engagement: "PROJECT",
  },
  {
    key: "WEBSITE_REDESIGN",
    label: "Website redesign",
    category: "WEB",
    summary: "Rebuild or modernise an existing site that is underperforming.",
    engagement: "PROJECT",
  },
  {
    key: "WEBSITE_MAINTENANCE",
    label: "Website maintenance",
    category: "WEB",
    summary: "Ongoing updates, fixes, security and performance work.",
    engagement: "RETAINER",
  },
  {
    key: "LANDING_PAGE",
    label: "Landing pages",
    category: "WEB",
    summary: "Focused conversion pages, usually behind a paid campaign.",
    engagement: "PROJECT",
  },
  {
    key: "META_ADS",
    label: "Meta Ads",
    category: "MARKETING",
    summary: "Plan, run and optimise Facebook and Instagram advertising.",
    engagement: "RETAINER",
  },
  {
    key: "DIGITAL_MARKETING_CONSULTING",
    label: "Digital marketing consulting",
    category: "ADVISORY",
    summary: "Advise on strategy, channels, measurement and budget.",
    engagement: "EITHER",
  },
  {
    key: "SOCIAL_MEDIA_MANAGEMENT",
    label: "Social media management",
    category: "MARKETING",
    summary: "Own the posting calendar, community and reporting.",
    engagement: "RETAINER",
  },
  {
    key: "CONTENT_CREATION",
    label: "Content creation",
    category: "CONTENT",
    summary: "Write and produce articles, copy and campaign material.",
    engagement: "EITHER",
  },
  {
    key: "SOCIAL_CONTENT",
    label: "Instagram and Facebook content",
    category: "CONTENT",
    summary: "Produce platform-native posts, stories and reels.",
    engagement: "RETAINER",
  },
  {
    key: "GRAPHICS_POSTERS",
    label: "Posters and graphics",
    category: "DESIGN",
    summary: "Standalone visual assets for print and digital use.",
    engagement: "PROJECT",
  },
  {
    key: "YOUTUBE_THUMBNAILS",
    label: "YouTube thumbnails",
    category: "DESIGN",
    summary: "Click-optimised thumbnail design for video channels.",
    engagement: "EITHER",
  },
] as const satisfies readonly ServiceDefinition[];

export type ServiceKey = (typeof SERVICES)[number]["key"];

/** Index for O(1) lookup. Built once at module load. */
const BY_KEY = new Map<string, ServiceDefinition>(
  SERVICES.map((service) => [service.key, service]),
);

export const SERVICE_KEYS = SERVICES.map((service) => service.key) as ServiceKey[];

export function isServiceKey(value: unknown): value is ServiceKey {
  return typeof value === "string" && BY_KEY.has(value);
}

/** Definition for a key, or undefined when the key is not in the taxonomy. */
export function getService(key: string): ServiceDefinition | undefined {
  return BY_KEY.get(key);
}

/**
 * Display label for a key.
 *
 * Falls back to the raw key rather than throwing: a key persisted by an older
 * version of the taxonomy must still render something truthful rather than
 * crashing a page or silently showing a blank.
 */
export function serviceLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}

export function servicesByCategory(
  category: ServiceCategory,
): ServiceDefinition[] {
  return SERVICES.filter((service) => service.category === category);
}
