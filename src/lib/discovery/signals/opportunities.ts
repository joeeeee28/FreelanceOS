/**
 * Signal -> service mapping.
 *
 * Turns "this business has no mobile site" into "they may want a website
 * redesign", with a score that can be explained line by line.
 *
 * The mapping is data, not code: a table of rules, so the set of services and
 * the reasons for recommending them can change without rewriting the engine.
 * Nothing here calls a model. A user who asks "why is this a 60?" gets the
 * arithmetic, not a shrug.
 */

import type { SignalType } from "@prisma/client";

import { isServiceKey, serviceLabel } from "@/lib/taxonomy/services";

export interface MappingRule {
  /** Stable key, persisted in the rationale. */
  key: string;
  signal: SignalType;
  serviceKey: string;
  /** Points contributed when this signal is present. */
  weight: number;
  /** Shown to the user as the reason. */
  reason: string;
  /** The concrete next step, if this becomes the leading opportunity. */
  action: string;
}

/**
 * The mapping table.
 *
 * Weights are relative, not probabilities. A missing website contributing 50
 * toward WEBSITE_CREATION means it is the single strongest indicator for that
 * service, not that there is a 50% chance of a sale.
 */
export const MAPPING_RULES: readonly MappingRule[] = [
  {
    key: "NO_SITE_TO_CREATION",
    signal: "WEBSITE_MISSING",
    serviceKey: "WEBSITE_CREATION",
    weight: 50,
    reason: "The business has no website but is contactable.",
    action: "Offer to build a first website.",
  },
  {
    key: "NO_SITE_TO_LANDING",
    signal: "WEBSITE_MISSING",
    serviceKey: "LANDING_PAGE",
    weight: 25,
    reason: "With no website, a single landing page is a low-commitment start.",
    action: "Propose a one-page site to test demand.",
  },
  {
    key: "OUTDATED_TO_REDESIGN",
    signal: "WEBSITE_OUTDATED",
    serviceKey: "WEBSITE_REDESIGN",
    weight: 40,
    reason: "The website appears not to have been updated for years.",
    action: "Offer a redesign, leading with the outdated content.",
  },
  {
    key: "QUALITY_TO_REDESIGN",
    signal: "WEBSITE_QUALITY_ISSUE",
    serviceKey: "WEBSITE_REDESIGN",
    weight: 35,
    reason: "The website has a visible quality problem.",
    action: "Offer a redesign addressing the specific issue found.",
  },
  {
    key: "QUALITY_TO_MAINTENANCE",
    signal: "WEBSITE_QUALITY_ISSUE",
    serviceKey: "WEBSITE_MAINTENANCE",
    weight: 20,
    reason: "A site with quality issues often has nobody maintaining it.",
    action: "Offer an ongoing maintenance arrangement.",
  },
  {
    key: "OUTDATED_TO_MAINTENANCE",
    signal: "WEBSITE_OUTDATED",
    serviceKey: "WEBSITE_MAINTENANCE",
    weight: 25,
    reason: "An unmaintained site suggests no current support arrangement.",
    action: "Offer to take over upkeep.",
  },
  {
    key: "NO_SOCIAL_TO_MANAGEMENT",
    signal: "SOCIAL_MEDIA_ABSENT",
    serviceKey: "SOCIAL_MEDIA_MANAGEMENT",
    weight: 35,
    reason: "No social presence was found.",
    action: "Offer to establish and run their social channels.",
  },
  {
    key: "NO_SOCIAL_TO_CONTENT",
    signal: "SOCIAL_MEDIA_ABSENT",
    serviceKey: "SOCIAL_CONTENT",
    weight: 20,
    reason: "Starting on social requires content to post.",
    action: "Offer an initial content package.",
  },
  {
    key: "SOCIAL_TO_CONTENT",
    signal: "SOCIAL_MEDIA_ACTIVITY",
    serviceKey: "SOCIAL_CONTENT",
    weight: 25,
    reason: "They already use social channels, so content has a home.",
    action: "Offer to supply regular posts.",
  },
  {
    key: "SOCIAL_TO_GRAPHICS",
    signal: "SOCIAL_MEDIA_ACTIVITY",
    serviceKey: "GRAPHICS_POSTERS",
    weight: 15,
    reason: "Active channels need a steady supply of graphics.",
    action: "Offer a graphics retainer.",
  },
  {
    key: "ADS_TO_META",
    signal: "ADVERTISING_ACTIVITY",
    serviceKey: "META_ADS",
    weight: 40,
    reason: "They already spend on measurable advertising.",
    action: "Offer to take over or improve paid campaigns.",
  },
  {
    key: "ADS_TO_CONSULTING",
    signal: "ADVERTISING_ACTIVITY",
    serviceKey: "DIGITAL_MARKETING_CONSULTING",
    weight: 20,
    reason: "An existing ad spend is worth reviewing.",
    action: "Offer a paid audit of current campaigns.",
  },
  {
    key: "LOW_CONTENT_TO_CREATION",
    signal: "LOW_CONTENT_ACTIVITY",
    serviceKey: "CONTENT_CREATION",
    weight: 30,
    reason: "The site has no blog or news section.",
    action: "Offer a content programme.",
  },
  {
    key: "HIRING_TO_CONSULTING",
    signal: "MARKETING_JOB",
    serviceKey: "DIGITAL_MARKETING_CONSULTING",
    weight: 45,
    reason: "They are recruiting for marketing, so there is budget and a need.",
    action: "Approach before the role is filled, offering to cover the gap.",
  },
  {
    key: "HIRING_TO_SOCIAL",
    signal: "MARKETING_JOB",
    serviceKey: "SOCIAL_MEDIA_MANAGEMENT",
    weight: 30,
    reason: "A marketing vacancy often includes social media duties.",
    action: "Offer to run social while the role is open.",
  },
  {
    key: "HIRING_TO_VIDEO",
    signal: "MARKETING_JOB",
    serviceKey: "YOUTUBE_THUMBNAILS",
    weight: 10,
    reason: "Marketing teams hiring for video need supporting artwork.",
    action: "Offer thumbnail and artwork support.",
  },
];

export interface RationaleLine {
  ruleKey: string;
  signal: SignalType;
  reason: string;
  points: number;
  /** Evidence from the signal that triggered this line. */
  evidence: string | null;
  sourceUrl: string | null;
}

export interface MappedOpportunity {
  serviceKey: string;
  serviceLabel: string;
  /** 0-100, clamped. */
  score: number;
  summary: string;
  recommendedAction: string;
  /** Every contributing line, in descending order of weight. */
  rationale: RationaleLine[];
  /** Signals that fed this opportunity. */
  signalTypes: SignalType[];
}

/** The minimum a signal's own confidence must be to contribute. */
export const MIN_SIGNAL_CONFIDENCE = 40;

/** Below this an opportunity is too weak to be worth showing. */
export const MIN_OPPORTUNITY_SCORE = 20;

export interface ScoringSignal {
  type: SignalType;
  confidence: number;
  evidence?: string | null;
  sourceUrl?: string | null;
}

/**
 * Maps a company's signals onto scored opportunities.
 *
 * A rule's contribution is scaled by the confidence of the signal that
 * triggered it, so a shaky observation cannot produce a confident
 * recommendation. Scores are clamped to 0-100 and every point is attributable
 * to a named rule.
 */
export function mapSignalsToOpportunities(
  signals: readonly ScoringSignal[],
  options: { minScore?: number } = {},
): MappedOpportunity[] {
  const minScore = options.minScore ?? MIN_OPPORTUNITY_SCORE;

  const usable = signals.filter(
    (signal) => signal.confidence >= MIN_SIGNAL_CONFIDENCE,
  );

  if (usable.length === 0) return [];

  const byService = new Map<string, RationaleLine[]>();

  for (const rule of MAPPING_RULES) {
    // Defensive: a typo in the table must not create an opportunity for a
    // service that does not exist.
    if (!isServiceKey(rule.serviceKey)) continue;

    const signal = usable.find((entry) => entry.type === rule.signal);
    if (signal === undefined) continue;

    // Scale by confidence: a 50-point rule fired by a 60%-confidence signal
    // contributes 30, not 50.
    const points = Math.round(rule.weight * (signal.confidence / 100));
    if (points <= 0) continue;

    const lines = byService.get(rule.serviceKey) ?? [];
    lines.push({
      ruleKey: rule.key,
      signal: rule.signal,
      reason: rule.reason,
      points,
      evidence: signal.evidence ?? null,
      sourceUrl: signal.sourceUrl ?? null,
    });
    byService.set(rule.serviceKey, lines);
  }

  const opportunities: MappedOpportunity[] = [];

  for (const [serviceKey, lines] of byService) {
    lines.sort((a, b) => b.points - a.points);

    const total = lines.reduce((sum, line) => sum + line.points, 0);
    const score = Math.max(0, Math.min(100, total));

    if (score < minScore) continue;

    const leading = MAPPING_RULES.find((rule) => rule.key === lines[0].ruleKey);

    opportunities.push({
      serviceKey,
      serviceLabel: serviceLabel(serviceKey),
      score,
      summary: lines[0].reason,
      recommendedAction: leading?.action ?? "Review this opportunity.",
      rationale: lines,
      signalTypes: [...new Set(lines.map((line) => line.signal))],
    });
  }

  // Strongest first, then alphabetical so the order is stable between runs.
  return opportunities.sort(
    (a, b) => b.score - a.score || a.serviceKey.localeCompare(b.serviceKey),
  );
}

/**
 * Renders a score as plain sentences.
 *
 * The product promise is that a user never sees a number they cannot
 * interrogate, so the explanation is generated from the same data the score
 * was, not written separately.
 */
export function explainOpportunity(opportunity: MappedOpportunity): string[] {
  return [
    `${opportunity.serviceLabel}: ${opportunity.score}/100.`,
    ...opportunity.rationale.map(
      (line) => `+${line.points} — ${line.reason}`,
    ),
  ];
}
