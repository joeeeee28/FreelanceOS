/**
 * Entity resolution.
 *
 * Decides whether a newly discovered business is one we already know about.
 * Getting this wrong in either direction is costly, but the two errors are not
 * equally costly:
 *
 *   - A false split creates a duplicate company. Annoying, visible, fixable by
 *     merging later.
 *   - A false merge silently fuses two real businesses into one record and
 *     destroys the provenance of both. It is very hard to notice and very hard
 *     to undo.
 *
 * So this module is deliberately conservative: it only merges automatically on
 * identifiers strong enough to be effectively unique, and routes anything
 * weaker to human review instead of guessing.
 */

import {
  canonicalCompanyName,
  canonicalDomain,
  canonicalEmail,
  canonicalPhone,
} from "./canonical";

/**
 * Identifier strengths, strongest first. The ordering is the whole point: we
 * try to match on the strongest available evidence and stop at the first hit.
 */
export const MATCH_STRATEGIES = [
  "CANONICAL_DOMAIN",
  "VERIFIED_EMAIL",
  "NAME_AND_LOCALITY",
  "NAME_AND_PHONE",
  "NAME_ONLY",
] as const;

export type MatchStrategy = (typeof MATCH_STRATEGIES)[number];

/**
 * Strategies that are safe to act on without a human.
 *
 * A registered domain is controlled by exactly one business, so it is a
 * reliable identity. An email address at a company domain is nearly as good.
 * Everything below that is a name comparison, and names are not unique —
 * "Sunrise Dental" exists in a hundred cities — so those become review
 * candidates instead.
 */
const AUTO_MERGE_STRATEGIES: ReadonlySet<MatchStrategy> = new Set([
  "CANONICAL_DOMAIN",
  "VERIFIED_EMAIL",
]);

export function isAutoMergeStrategy(strategy: MatchStrategy): boolean {
  return AUTO_MERGE_STRATEGIES.has(strategy);
}

/** Free email providers: an address here says nothing about company identity. */
const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.co.uk",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mail.com",
  "gmx.com",
  "gmx.de",
  "yandex.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "rediffmail.com",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
]);

export function isFreeEmailDomain(domain: string | null): boolean {
  return domain !== null && FREE_EMAIL_DOMAINS.has(domain);
}

/** The identifying fields of a candidate, before resolution. */
export interface EntityIdentity {
  name?: string | null;
  website?: string | null;
  domain?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  city?: string | null;
}

/** An existing company we might match against. */
export interface ExistingEntity {
  id: string;
  canonicalName: string | null;
  canonicalDomain: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  city?: string | null;
}

/** Identity reduced to comparable keys. */
export interface ResolutionKeys {
  canonicalName: string | null;
  canonicalDomain: string | null;
  canonicalEmail: string | null;
  emailDomain: string | null;
  canonicalPhone: string | null;
  country: string | null;
  city: string | null;
}

export type ResolutionOutcome =
  /** Confident match; write to the existing company. */
  | { kind: "MATCH"; entityId: string; strategy: MatchStrategy }
  /** Plausible match that a human must confirm. Never merged automatically. */
  | {
      kind: "REVIEW";
      candidateIds: string[];
      strategy: MatchStrategy;
      reason: string;
    }
  /** No match; this is a new company. */
  | { kind: "NEW" }
  /** Not enough identifying information to store anything meaningful. */
  | { kind: "INSUFFICIENT_EVIDENCE"; reason: string };

function normaliseLocality(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

function emailDomainOf(email: string | null): string | null {
  if (email === null) return null;
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  return canonicalDomain(email.slice(at + 1));
}

/** Reduces raw identity fields to the canonical keys used for matching. */
export function resolutionKeys(identity: EntityIdentity): ResolutionKeys {
  const email = canonicalEmail(identity.email);

  // A domain may be stated directly or implied by the website URL.
  const domain =
    canonicalDomain(identity.domain) ?? canonicalDomain(identity.website);

  return {
    canonicalName: canonicalCompanyName(identity.name),
    canonicalDomain: domain,
    canonicalEmail: email,
    emailDomain: emailDomainOf(email),
    canonicalPhone: canonicalPhone(identity.phone),
    country: normaliseLocality(identity.country),
    city: normaliseLocality(identity.city),
  };
}

/**
 * Resolves an incoming identity against known companies.
 *
 * Pure and synchronous: the caller supplies the candidate set (normally
 * narrowed by a workspace-scoped query), so this logic is fully testable
 * without a database and cannot accidentally read across workspaces.
 */
export function resolveEntity(
  identity: EntityIdentity,
  candidates: readonly ExistingEntity[],
): ResolutionOutcome {
  const keys = resolutionKeys(identity);

  // Something that has neither a name nor a domain cannot be stored as a
  // business. Refusing beats inventing a placeholder record.
  if (keys.canonicalName === null && keys.canonicalDomain === null) {
    return {
      kind: "INSUFFICIENT_EVIDENCE",
      reason: "No usable company name or domain",
    };
  }

  // 1. Canonical domain — strongest available identifier.
  if (keys.canonicalDomain !== null) {
    const hit = candidates.find(
      (c) => c.canonicalDomain !== null && c.canonicalDomain === keys.canonicalDomain,
    );
    if (hit) {
      return { kind: "MATCH", entityId: hit.id, strategy: "CANONICAL_DOMAIN" };
    }
  }

  // 2. Exact business-email match, ignoring free providers. Two businesses
  //    sharing one Gmail address tells us nothing; sharing info@acme.com does.
  if (keys.canonicalEmail !== null && !isFreeEmailDomain(keys.emailDomain)) {
    const hits = candidates.filter(
      (c) => canonicalEmail(c.email ?? null) === keys.canonicalEmail,
    );
    if (hits.length === 1) {
      return { kind: "MATCH", entityId: hits[0].id, strategy: "VERIFIED_EMAIL" };
    }
    if (hits.length > 1) {
      return {
        kind: "REVIEW",
        candidateIds: hits.map((c) => c.id),
        strategy: "VERIFIED_EMAIL",
        reason: "Several companies already share this email address",
      };
    }
  }

  // Below here every strategy is name-based, so nothing merges automatically.
  if (keys.canonicalName === null) {
    return { kind: "NEW" };
  }

  const sameName = candidates.filter(
    (c) => c.canonicalName !== null && c.canonicalName === keys.canonicalName,
  );

  if (sameName.length === 0) {
    return { kind: "NEW" };
  }

  // A same-named company with a *different* known domain is strong evidence of
  // a genuinely different business, so drop those candidates entirely.
  const notContradicted = sameName.filter((c) => {
    if (keys.canonicalDomain === null || c.canonicalDomain === null) return true;
    return c.canonicalDomain === keys.canonicalDomain;
  });

  if (notContradicted.length === 0) {
    return { kind: "NEW" };
  }

  // 3. Name plus locality.
  if (keys.country !== null && keys.city !== null) {
    const localMatches = notContradicted.filter(
      (c) =>
        normaliseLocality(c.country) === keys.country &&
        normaliseLocality(c.city) === keys.city,
    );
    if (localMatches.length > 0) {
      return {
        kind: "REVIEW",
        candidateIds: localMatches.map((c) => c.id),
        strategy: "NAME_AND_LOCALITY",
        reason: "Same name in the same city, but no shared domain to confirm it",
      };
    }
  }

  // 4. Name plus phone number.
  if (keys.canonicalPhone !== null) {
    const phoneMatches = notContradicted.filter(
      (c) => canonicalPhone(c.phone ?? null) === keys.canonicalPhone,
    );
    if (phoneMatches.length > 0) {
      return {
        kind: "REVIEW",
        candidateIds: phoneMatches.map((c) => c.id),
        strategy: "NAME_AND_PHONE",
        reason: "Same name and phone number, but no shared domain to confirm it",
      };
    }
  }

  // 5. Name alone — the weakest signal we will even mention.
  return {
    kind: "REVIEW",
    candidateIds: notContradicted.map((c) => c.id),
    strategy: "NAME_ONLY",
    reason: "Same company name only; names are not unique",
  };
}
