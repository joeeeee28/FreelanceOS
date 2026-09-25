/**
 * Signal detection rules.
 *
 * A signal is an observable reason to believe a business might want something.
 * Every rule here is a pure function over facts the engine actually collected,
 * and every signal it emits carries the evidence that produced it. There is no
 * model, no inference and nothing probabilistic — if a rule cannot point at
 * something concrete, it does not fire.
 *
 * The bar for firing is deliberately high. A false signal is worse than a
 * missed one: it puts a business on the "worth contacting" list for a reason
 * that turns out not to exist, and the person making that call discovers the
 * mistake in front of the prospect.
 */

import type { SignalType } from "@prisma/client";

/** What a rule can see. Everything is optional, because most of it is unknown. */
export interface CompanyFacts {
  companyId: string;
  name: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  instagramUrl: string | null;
  facebookUrl: string | null;
  linkedinUrl: string | null;
  youtubeUrl: string | null;
  industry: string | null;
  companySize: string | null;
  /** Hiring areas discovered by the jobs provider, e.g. ["MARKETING"]. */
  hiringAreas?: readonly string[];
  /** Page signals gathered during research. */
  pageSignals?: PageSignals;
  /** When the company record was first created. */
  firstSeenAt?: Date;
}

/** Observations about a company's website, when it was read. */
export interface PageSignals {
  /** True only if a fetch genuinely succeeded. */
  reachable?: boolean;
  /** Page declares a mobile viewport. */
  hasViewportMeta?: boolean;
  /** Served over HTTPS. */
  isHttps?: boolean;
  /** A copyright year found in the footer. */
  copyrightYear?: number | null;
  /** Detected platform, e.g. "wordpress". */
  platform?: string | null;
  /** Bytes of the main document. */
  sizeBytes?: number | null;
  /** Page references an advertising or analytics pixel. */
  hasTrackingPixel?: boolean;
  /** A blog or news section was found. */
  hasBlog?: boolean;
}

export interface DetectedSignal {
  type: SignalType;
  /** 0-100, from the rule that fired. Never a guess. */
  confidence: number;
  summary: string;
  /** The concrete thing that justifies this signal. */
  evidence: string;
  sourceUrl: string | null;
  metadata?: Record<string, unknown>;
}

export interface SignalRule {
  /** Stable key, safe to persist and to show in an explanation. */
  key: string;
  type: SignalType;
  description: string;
  evaluate(facts: CompanyFacts, now: Date): DetectedSignal | null;
}

/** A website whose copyright year is this far behind looks unmaintained. */
export const STALE_COPYRIGHT_YEARS = 3;

/** Below this, a page is a placeholder rather than a site. */
export const THIN_PAGE_BYTES = 2_000;

const rules: SignalRule[] = [
  {
    key: "WEBSITE_MISSING",
    type: "WEBSITE_MISSING",
    description: "No website was found for the business.",
    evaluate(facts) {
      if (facts.website !== null) return null;

      // Only meaningful if we actually know how to reach them some other way;
      // otherwise this is an empty record, not a business without a website.
      const reachable =
        facts.email !== null ||
        facts.phone !== null ||
        facts.instagramUrl !== null ||
        facts.facebookUrl !== null;

      if (!reachable) return null;

      return {
        type: "WEBSITE_MISSING",
        confidence: 70,
        summary: "No website found, but the business is contactable.",
        evidence:
          "No website recorded on the company, while contact details were " +
          "discovered from public sources.",
        sourceUrl: null,
      };
    },
  },

  {
    key: "WEBSITE_UNREACHABLE",
    type: "WEBSITE_QUALITY_ISSUE",
    description: "A website is listed but did not respond.",
    evaluate(facts) {
      if (facts.website === null) return null;
      if (facts.pageSignals?.reachable !== false) return null;

      return {
        type: "WEBSITE_QUALITY_ISSUE",
        confidence: 60,
        summary: "The listed website did not respond.",
        evidence: `Fetching ${facts.website} did not return a usable page.`,
        sourceUrl: facts.website,
      };
    },
  },

  {
    key: "WEBSITE_NOT_MOBILE_READY",
    type: "WEBSITE_QUALITY_ISSUE",
    description: "The site declares no mobile viewport.",
    evaluate(facts) {
      const page = facts.pageSignals;
      if (page?.reachable !== true) return null;
      // Absent is unknown, not false. Only an explicit false counts.
      if (page.hasViewportMeta !== false) return null;

      return {
        type: "WEBSITE_QUALITY_ISSUE",
        confidence: 65,
        summary: "The website has no mobile viewport tag.",
        evidence:
          "The homepage HTML contains no <meta name=\"viewport\"> tag, so it " +
          "is unlikely to display correctly on phones.",
        sourceUrl: facts.website,
        metadata: { issue: "NO_VIEWPORT" },
      };
    },
  },

  {
    key: "WEBSITE_INSECURE",
    type: "WEBSITE_QUALITY_ISSUE",
    description: "The site is not served over HTTPS.",
    evaluate(facts) {
      const page = facts.pageSignals;
      if (page?.reachable !== true) return null;
      if (page.isHttps !== false) return null;

      return {
        type: "WEBSITE_QUALITY_ISSUE",
        confidence: 80,
        summary: "The website is not served over HTTPS.",
        evidence:
          "The site responded over plain HTTP. Browsers mark such pages as " +
          "insecure, which affects both trust and search ranking.",
        sourceUrl: facts.website,
        metadata: { issue: "NO_HTTPS" },
      };
    },
  },

  {
    key: "WEBSITE_STALE",
    type: "WEBSITE_OUTDATED",
    description: "The footer copyright year is several years old.",
    evaluate(facts, now) {
      const page = facts.pageSignals;
      if (page?.reachable !== true) return null;

      const year = page.copyrightYear;
      if (year === null || year === undefined) return null;

      const age = now.getUTCFullYear() - year;
      if (age < STALE_COPYRIGHT_YEARS) return null;

      // A year in the future is a typo on their side, not a signal.
      if (age < 0) return null;

      return {
        type: "WEBSITE_OUTDATED",
        confidence: 55,
        summary: `The website footer still says ${year}.`,
        evidence:
          `A copyright notice for ${year} was found on the homepage, ` +
          `${age} years behind the current year. This suggests the site has ` +
          "not been updated recently.",
        sourceUrl: facts.website,
        metadata: { copyrightYear: year, yearsBehind: age },
      };
    },
  },

  {
    key: "WEBSITE_THIN",
    type: "WEBSITE_QUALITY_ISSUE",
    description: "The homepage is barely a page.",
    evaluate(facts) {
      const page = facts.pageSignals;
      if (page?.reachable !== true) return null;

      const size = page.sizeBytes;
      if (size === null || size === undefined) return null;
      if (size >= THIN_PAGE_BYTES) return null;

      return {
        type: "WEBSITE_QUALITY_ISSUE",
        confidence: 50,
        summary: "The homepage contains very little content.",
        evidence:
          `The homepage document is only ${size} bytes, which is closer to a ` +
          "placeholder than a working site.",
        sourceUrl: facts.website,
        metadata: { issue: "THIN_CONTENT", sizeBytes: size },
      };
    },
  },

  {
    key: "NO_SOCIAL_PRESENCE",
    type: "SOCIAL_MEDIA_ABSENT",
    description: "No social profiles were discovered.",
    evaluate(facts) {
      const hasSocial =
        facts.instagramUrl !== null ||
        facts.facebookUrl !== null ||
        facts.linkedinUrl !== null ||
        facts.youtubeUrl !== null;

      if (hasSocial) return null;

      // Only claim absence where a site was actually read. Not finding links
      // on a page we never fetched is not evidence of anything.
      if (facts.pageSignals?.reachable !== true) return null;

      return {
        type: "SOCIAL_MEDIA_ABSENT",
        confidence: 45,
        summary: "No social media profiles were found.",
        evidence:
          "The website was read and no links to Instagram, Facebook, " +
          "LinkedIn or YouTube were present.",
        sourceUrl: facts.website,
      };
    },
  },

  {
    key: "SOCIAL_PRESENT",
    type: "SOCIAL_MEDIA_ACTIVITY",
    description: "Public social profiles exist.",
    evaluate(facts) {
      const profiles = [
        facts.instagramUrl,
        facts.facebookUrl,
        facts.linkedinUrl,
        facts.youtubeUrl,
      ].filter((url): url is string => url !== null);

      if (profiles.length === 0) return null;

      return {
        type: "SOCIAL_MEDIA_ACTIVITY",
        confidence: 70,
        summary: `${profiles.length} social profile${profiles.length === 1 ? "" : "s"} found.`,
        // Deliberately not called "active": a profile existing says nothing
        // about whether anyone has posted to it this year.
        evidence: `Public profiles discovered: ${profiles.join(", ")}.`,
        sourceUrl: profiles[0],
        metadata: { profileCount: profiles.length },
      };
    },
  },

  {
    key: "ADVERTISING_PIXEL",
    type: "ADVERTISING_ACTIVITY",
    description: "An advertising or analytics pixel is installed.",
    evaluate(facts) {
      const page = facts.pageSignals;
      if (page?.reachable !== true) return null;
      if (page.hasTrackingPixel !== true) return null;

      return {
        type: "ADVERTISING_ACTIVITY",
        confidence: 60,
        summary: "The site carries an advertising or analytics pixel.",
        evidence:
          "A known advertising or analytics script was found on the " +
          "homepage, which indicates the business already spends on " +
          "measurable marketing.",
        sourceUrl: facts.website,
      };
    },
  },

  {
    key: "NO_CONTENT_PROGRAMME",
    type: "LOW_CONTENT_ACTIVITY",
    description: "No blog or news section exists.",
    evaluate(facts) {
      const page = facts.pageSignals;
      if (page?.reachable !== true) return null;
      if (page.hasBlog !== false) return null;

      return {
        type: "LOW_CONTENT_ACTIVITY",
        confidence: 45,
        summary: "No blog or news section was found.",
        evidence:
          "The website was read and contained no blog, news or insights " +
          "section.",
        sourceUrl: facts.website,
      };
    },
  },

  {
    key: "HIRING_MARKETING",
    type: "MARKETING_JOB",
    description: "The business is hiring into a marketing-adjacent role.",
    evaluate(facts) {
      const areas = facts.hiringAreas ?? [];
      if (areas.length === 0) return null;

      return {
        type: "MARKETING_JOB",
        // A published vacancy is a strong, dated, self-reported statement of
        // intent — the most reliable signal the engine can obtain for free.
        confidence: 85,
        summary: `Hiring in ${areas.join(", ").toLowerCase().replace(/_/g, " ")}.`,
        evidence:
          `A public job posting was found for ${areas.join(", ")}. A business ` +
          "recruiting in this area has both budget and an acknowledged need.",
        sourceUrl: facts.website,
        metadata: { areas: [...areas] },
      };
    },
  },
];

export const SIGNAL_RULES: readonly SignalRule[] = rules;

/**
 * Runs every rule against one company.
 *
 * Several rules share a SignalType — there are many ways for a website to be
 * poor. Only the highest-confidence signal of each type is kept, because the
 * storage model holds one signal per type per company, and because five
 * variations on "the site is bad" is noise rather than five reasons.
 */
export function detectSignals(facts: CompanyFacts, now: Date = new Date()): DetectedSignal[] {
  const byType = new Map<SignalType, DetectedSignal>();

  for (const rule of SIGNAL_RULES) {
    let detected: DetectedSignal | null = null;

    try {
      detected = rule.evaluate(facts, now);
    } catch {
      // A rule that throws is a bug in that rule. It must not cost the company
      // every other signal.
      continue;
    }

    if (detected === null) continue;

    const existing = byType.get(detected.type);
    if (existing === undefined || detected.confidence > existing.confidence) {
      byType.set(detected.type, detected);
    }
  }

  return [...byType.values()].sort((a, b) => b.confidence - a.confidence);
}
