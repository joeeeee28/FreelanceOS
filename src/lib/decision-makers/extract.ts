/**
 * People published on a company's own page.
 *
 * A name in prose, an email local-part, an author byline, or a social link is
 * not employment. A person is kept only when the page itself links them to the
 * organisation: structured employee/founder data, or a team card that names
 * them and their title together. Contact details are kept only when they sit
 * on that same person, and only when they are already a real address.
 */

import { canonicalEmail, canonicalPersonName, canonicalPhone, canonicalUrl } from "@/lib/discovery/canonical";
import { extractJsonLd, stripTags } from "@/lib/discovery/extract";
import { sanitiseEvidence } from "@/lib/discovery/provenance";

export const PERSON_PAGE_MAX_CHARS = 2 * 1024 * 1024;
const CARD_MAX_CHARS = 4_000;
const MAX_PEOPLE_PER_PAGE = 20;

export type PersonMethod = "STRUCTURED_DATA" | "HTML_SELECTOR";
export type PersonVerification = "UNVERIFIED" | "NAME_AND_ROLE" | "CONTACTABLE" | "PUBLISHED";

export interface PersonCandidate {
  fullName: string;
  canonicalName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  method: PersonMethod;
  verification: PersonVerification;
  sourceUrl: string;
  evidence: string;
}

const ORG_TYPES = new Set([
  "organization",
  "localbusiness",
  "corporation",
  "medicalbusiness",
  "dentist",
  "professionalservice",
  "healthandbeautybusiness",
]);

const PERSON_CARD =
  /\b(?:team-member|person-card|staff-member|leadership-card)\b|data-person\b/i;

/** Two given-name words. A single token, or an email, is not a person name. */
export function acceptedPersonName(raw: string | null | undefined): {
  fullName: string;
  canonicalName: string;
} | null {
  if (typeof raw !== "string") return null;
  const visible = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (visible === "" || visible.includes("@") || visible.length > 80) return null;
  if (!/^[A-Za-z][A-Za-z .'-]{2,78}$/.test(visible)) return null;

  const canonicalName = canonicalPersonName(visible);
  if (canonicalName === null) return null;
  const words = canonicalName.split(" ");
  if (words.length < 2 || words.length > 4) return null;
  if (words.some((word) => word.length < 2 || !/^[a-z][a-z'-]{1,30}$/.test(word))) return null;

  return { fullName: visible, canonicalName };
}

function acceptedTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const title = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (title.length < 2 || title.length > 80) return null;
  if (title.includes("@") || /https?:\/\//i.test(title)) return null;
  if (!/^[A-Za-z][A-Za-z0-9 /&,'().-]{1,79}$/.test(title)) return null;
  return title;
}

function linkedInProfile(raw: string | null | undefined): string | null {
  const url = canonicalUrl(raw);
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== "linkedin.com" && host !== "www.linkedin.com") return null;
    if (!parsed.pathname.toLowerCase().startsWith("/in/")) return null;
    if (parsed.pathname === "/in/" || parsed.pathname === "/in") return null;
    return url;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function typesOf(node: Record<string, unknown>): string[] {
  const type = node["@type"];
  const values = Array.isArray(type) ? type : [type];
  return values.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.toLowerCase());
}

function isPersonNode(node: Record<string, unknown>): boolean {
  return typesOf(node).includes("person");
}

function isOrgNode(node: Record<string, unknown>): boolean {
  return typesOf(node).some((type) => ORG_TYPES.has(type));
}

function flatten(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => flatten(item, depth + 1));
  const node = value as Record<string, unknown>;
  const nodes = [node];
  if (Array.isArray(node["@graph"])) nodes.push(...flatten(node["@graph"], depth + 1));
  return nodes;
}

function personNodes(value: unknown): Record<string, unknown>[] {
  const values = Array.isArray(value) ? value : [value];
  const people: Record<string, unknown>[] = [];
  for (const entry of values) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const node = entry as Record<string, unknown>;
    if (isPersonNode(node)) people.push(node);
  }
  return people;
}

function worksForName(person: Record<string, unknown>): string | null {
  const worksFor = person.worksFor;
  if (typeof worksFor === "string") return worksFor;
  if (worksFor !== null && typeof worksFor === "object" && !Array.isArray(worksFor)) {
    return asString((worksFor as Record<string, unknown>).name);
  }
  return null;
}

function sameOrganisation(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return true;
  const a = canonicalPersonName(left) ?? left.toLowerCase();
  const b = canonicalPersonName(right) ?? right.toLowerCase();
  if (a === b) return true;
  const tokens = a.split(" ").filter((word) => word.length >= 4);
  return tokens.some((token) => b.includes(token));
}

function fromStructuredPerson(
  person: Record<string, unknown>,
  pageUrl: string,
  orgName: string | null,
): PersonCandidate | null {
  if (!sameOrganisation(orgName, worksForName(person))) return null;
  const named = acceptedPersonName(asString(person.name));
  if (named === null) return null;

  const jobTitle = acceptedTitle(asString(person.jobTitle));
  const email = canonicalEmail(asString(person.email));
  const phone = canonicalPhone(asString(person.telephone));
  const linkedinUrl = linkedInProfile(asString(person.url) ?? asString(person.sameAs));
  const evidence = sanitiseEvidence(
    [named.fullName, jobTitle, email, phone, linkedinUrl].filter(Boolean).join(" · "),
  );
  if (evidence === "") return null;

  return {
    ...named,
    jobTitle,
    email,
    phone,
    linkedinUrl,
    method: "STRUCTURED_DATA",
    verification: jobTitle === null ? "UNVERIFIED" : "PUBLISHED",
    sourceUrl: pageUrl,
    evidence,
  };
}

function structuredPeople(html: string, pageUrl: string): PersonCandidate[] {
  const people: PersonCandidate[] = [];
  for (const block of extractJsonLd(html)) {
    for (const node of flatten(block)) {
      if (!isOrgNode(node)) continue;
      const orgName = asString(node.name);
      const linked = [
        ...personNodes(node.employee),
        ...personNodes(node.employees),
        ...personNodes(node.founder),
        ...personNodes(node.founders),
        ...(isOrgNode(node) ? personNodes(node.member) : []),
        ...personNodes(node.members),
      ];
      for (const person of linked) {
        const candidate = fromStructuredPerson(person, pageUrl, orgName);
        if (candidate !== null) people.push(candidate);
      }
    }
  }
  return people;
}

function isPersonCard(attrs: string): boolean {
  return PERSON_CARD.test(attrs);
}

function findClose(html: string, tag: string, from: number): number | null {
  const token = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  token.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html)) !== null) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return null;
}

function cards(html: string): string[] {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const open = /<(article|div|li)\b([^>]*)>/gi;
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = open.exec(withoutScripts)) !== null) {
    if (!isPersonCard(match[2] ?? "")) continue;
    const start = match.index + match[0].length;
    const close = findClose(withoutScripts, match[1].toLowerCase(), start);
    if (close === null) continue;
    found.push(withoutScripts.slice(start, close).slice(0, CARD_MAX_CHARS));
    open.lastIndex = close;
    if (found.length >= MAX_PEOPLE_PER_PAGE) break;
  }
  return found;
}

function hrefs(card: string, scheme: "mailto" | "tel"): string | null {
  const match = new RegExp(`href\\s*=\\s*["']${scheme}:([^"'?\\s]+)`, "i").exec(card);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function linkedInHref(card: string): string | null {
  for (const match of card.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const profile = linkedInProfile(match[1]);
    if (profile !== null) return profile;
  }
  return null;
}

function fromCard(card: string, pageUrl: string): PersonCandidate | null {
  const heading = /<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]>/i.exec(card);
  if (heading === null) return null;
  const named = acceptedPersonName(stripTags(heading[1] ?? ""));
  if (named === null) return null;

  const paragraphs = [...card.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) =>
    stripTags(match[1] ?? ""),
  );
  const jobTitle = acceptedTitle(paragraphs.find((text) => text !== "" && text !== named.fullName));
  if (jobTitle === null) return null;

  const email = canonicalEmail(hrefs(card, "mailto"));
  const phone = canonicalPhone(hrefs(card, "tel"));
  const linkedinUrl = linkedInHref(card);
  const evidence = sanitiseEvidence(`${named.fullName}. ${jobTitle}.`);
  if (evidence === "" || !evidence.toLowerCase().includes(named.canonicalName.split(" ")[0] ?? "")) {
    return null;
  }

  return {
    ...named,
    jobTitle,
    email,
    phone,
    linkedinUrl,
    method: "HTML_SELECTOR",
    verification: email !== null || phone !== null || linkedinUrl !== null ? "CONTACTABLE" : "NAME_AND_ROLE",
    sourceUrl: pageUrl,
    evidence,
  };
}

function rank(person: PersonCandidate): number {
  return person.method === "STRUCTURED_DATA" ? 2 : 1;
}

/**
 * Reads people from one already-fetched page. Does not fetch, and does not
 * turn leftover prose into a person.
 */
export function extractPeopleFromHtml(html: string, pageUrl: string): PersonCandidate[] {
  if (typeof html !== "string" || html.length === 0 || html.length > PERSON_PAGE_MAX_CHARS) return [];
  if (typeof pageUrl !== "string" || pageUrl.trim() === "") return [];

  const byName = new Map<string, PersonCandidate>();
  const found = [...structuredPeople(html, pageUrl), ...cards(html).map((card) => fromCard(card, pageUrl))];
  for (const person of found) {
    if (person === null) continue;
    const held = byName.get(person.canonicalName);
    if (held === undefined || rank(person) > rank(held)) byName.set(person.canonicalName, person);
    if (byName.size >= MAX_PEOPLE_PER_PAGE) break;
  }
  return [...byName.values()];
}
