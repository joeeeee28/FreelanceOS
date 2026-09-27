/**
 * Evidence the interpreter is allowed to see, and the check that decides
 * whether a model reply may stand.
 *
 * A claim is kept only when its value is present in a cited evidence item the
 * caller supplied. The model does not get to name a company, a person, an
 * email, a phone number, a website, a problem, an opportunity, a statistic, a
 * credential, or a relationship that the evidence does not already contain.
 * Citing two items and stitching them together does not count: every cited
 * item must itself contain the value.
 *
 * Provenance on an accepted claim is copied from those items. A `sourceUrl`
 * the model adds to its JSON is ignored. Nothing here writes a row.
 */

import { stripTags } from "@/lib/discovery/extract";
import { clampConfidence } from "@/lib/discovery/provenance";

import type { AiConfig } from "./config";

export const EVIDENCE_KINDS = [
  "observation",
  "lead",
  "contact",
  "company",
  "signal",
  "opportunity",
  "knowledge",
  "activity",
  "note",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(EVIDENCE_KINDS);

export interface EvidenceItemInput {
  id: string;
  kind: string;
  field?: string | null;
  text?: string | null;
  value?: string | null;
  sourceUrl?: string | null;
  observedAt?: string | Date | null;
  method?: string | null;
  confidence?: number | null;
}

export interface PreparedEvidence {
  id: string;
  kind: EvidenceKind;
  field: string | null;
  corpus: string;
  sourceUrl: string | null;
  method: string | null;
  observedAt: string | null;
  confidence: number | null;
}

export interface EvidenceOmission {
  id: string;
  reason: "duplicate_id" | "empty" | "too_long" | "invalid_kind" | "over_limit";
}

export interface PreparedBundle {
  items: PreparedEvidence[];
  omitted: EvidenceOmission[];
  /** Ids that failed the charset check and are therefore not echoed. */
  droppedInvalid: number;
}

export interface EvidenceProvenance {
  id: string;
  kind: EvidenceKind;
  field: string | null;
  sourceUrl: string | null;
  method: string | null;
  observedAt: string | null;
  confidence: number | null;
}

export interface GroundedClaim {
  field: string;
  value: string;
  evidenceIds: string[];
  provenance: EvidenceProvenance[];
  /**
   * Always false. A grounded claim is an interpretation of supplied evidence,
   * not a CRM fact, and this layer never writes one.
   */
  trustedCrmFact: false;
}

export interface RejectedClaim {
  field: string | null;
  value: string | null;
  reason: string;
  evidenceIds: string[];
}

export interface ValidationSuccess {
  ok: true;
  summary: string | null;
  summaryEvidenceIds: string[];
  summaryDiscarded: boolean;
  accepted: GroundedClaim[];
  rejected: RejectedClaim[];
  unknownFields: string[];
}

export interface ValidationFailure {
  ok: false;
  reason: "malformed";
}

const ID_PATTERN = /^[A-Za-z0-9_:-]{1,80}$/;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const METHOD_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;
const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const CREDENTIAL_PATTERN =
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*\S{4,}|bearer\s+[a-z0-9._~+/-]{8,}|AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{8,}/i;

const CREDENTIAL_FIELDS = new Set([
  "password",
  "secret",
  "token",
  "api_key",
  "apikey",
  "credential",
  "credentials",
  "session",
  "authorization",
  "auth",
  "private_key",
]);

const EMAIL_FIELDS = new Set(["email", "email_address"]);
const PHONE_FIELDS = new Set(["phone", "telephone", "mobile"]);
const WEB_FIELDS = new Set([
  "website",
  "url",
  "domain",
  "linkedin_url",
  "instagram_url",
  "facebook_url",
  "youtube_url",
]);
const STAT_FIELDS = new Set([
  "statistic",
  "statistics",
  "count",
  "percentage",
  "revenue",
  "metric",
]);

const STOP_VALUES = new Set([
  "the",
  "a",
  "an",
  "company",
  "person",
  "unknown",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
]);

const MAX_SUMMARY_CHARS = 500;
const MAX_REJECTED_CHARS = 200;

function cleanText(value: string): string {
  return stripTags(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Contiguous, boundary-aware match.
 *
 * A value has to appear as its own token sequence. `ai` must not match inside
 * `email`, and `12` must not match inside `1234`. Short tokens (a country
 * code, a count) are allowed only with those boundaries — never as a free
 * substring, and never as a single character.
 */
export function phraseIn(haystack: string, phrase: string): boolean {
  const h = normalise(haystack);
  const p = normalise(phrase);
  if (p.length === 0 || h.length === 0) return false;
  if (h === p) return true;
  if (p.length < 2) return false;

  const boundary = (ch: string) => ch === "" || /[^a-z0-9]/i.test(ch);
  let from = 0;
  while (from <= h.length - p.length) {
    const idx = h.indexOf(p, from);
    if (idx < 0) return false;
    const before = idx === 0 ? "" : h[idx - 1];
    const after = idx + p.length >= h.length ? "" : h[idx + p.length];
    if (boundary(before) && boundary(after)) return true;
    from = idx + 1;
  }
  return false;
}

function httpUrlOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function observedAtOrNull(value: string | Date | null | undefined): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function fieldOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return FIELD_PATTERN.test(trimmed) ? trimmed : null;
}

function methodOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return METHOD_PATTERN.test(value.trim()) ? value.trim() : null;
}

/**
 * Drops anything that is not safe to send to a model or to cite afterwards.
 *
 * Over-long items are omitted rather than truncated. A truncated fact can
 * still match a phrase and mean something the original did not.
 */
export function prepareEvidence(
  input: readonly EvidenceItemInput[],
  limits: Pick<AiConfig, "maxEvidenceItems" | "maxEvidenceItemChars">,
): PreparedBundle {
  const items: PreparedEvidence[] = [];
  const omitted: EvidenceOmission[] = [];
  let droppedInvalid = 0;
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();

  const valid: EvidenceItemInput[] = [];
  for (const item of input) {
    if (typeof item.id !== "string" || !ID_PATTERN.test(item.id)) {
      droppedInvalid += 1;
      continue;
    }
    if (seen.has(item.id)) {
      duplicateIds.add(item.id);
      continue;
    }
    seen.add(item.id);
    valid.push(item);
  }

  for (const item of valid) {
    if (duplicateIds.has(item.id)) {
      omitted.push({ id: item.id, reason: "duplicate_id" });
      continue;
    }
    if (!KIND_SET.has(item.kind)) {
      omitted.push({ id: item.id, reason: "invalid_kind" });
      continue;
    }

    const text = typeof item.text === "string" ? cleanText(item.text) : "";
    const value = typeof item.value === "string" ? cleanText(item.value) : "";
    const sourceUrl = httpUrlOrNull(item.sourceUrl);
    const corpus = [value, text, sourceUrl].filter((part) => part !== null && part !== "").join("\n");

    if (corpus === "") {
      omitted.push({ id: item.id, reason: "empty" });
      continue;
    }
    if (corpus.length > limits.maxEvidenceItemChars) {
      omitted.push({ id: item.id, reason: "too_long" });
      continue;
    }
    if (items.length >= limits.maxEvidenceItems) {
      omitted.push({ id: item.id, reason: "over_limit" });
      continue;
    }

    items.push({
      id: item.id,
      kind: item.kind as EvidenceKind,
      field: fieldOrNull(item.field),
      corpus,
      sourceUrl,
      method: methodOrNull(item.method),
      observedAt: observedAtOrNull(item.observedAt),
      confidence:
        typeof item.confidence === "number" && Number.isFinite(item.confidence)
          ? clampConfidence(item.confidence)
          : null,
    });
  }

  return { items, omitted, droppedInvalid };
}

function present(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function itemFrom(
  id: string,
  kind: EvidenceKind,
  field: string,
  value: string | null,
  sourceUrl?: string | null,
): EvidenceItemInput | null {
  if (value === null) return null;
  return {
    id,
    kind,
    field,
    value,
    text: value,
    sourceUrl: sourceUrl ?? null,
  };
}

/**
 * One evidence item per non-null observation value. A null value with no
 * evidence note is absence, not a fact the model may fill in.
 */
export function evidenceFromObservation(row: {
  id: string;
  field: string;
  value: string | null;
  evidence?: string | null;
  sourceUrl?: string | null;
  method?: string | null;
  observedAt?: Date | string | null;
  confidence?: number | null;
}): EvidenceItemInput | null {
  const value = present(row.value);
  const note = present(row.evidence);
  if (value === null && note === null) return null;

  return {
    id: row.id,
    kind: "observation",
    field: row.field,
    value,
    text: note ?? value,
    sourceUrl: row.sourceUrl ?? null,
    method: row.method ?? null,
    observedAt: row.observedAt ?? null,
    confidence: row.confidence ?? null,
  };
}

function rowsFrom(
  id: string,
  kind: EvidenceKind,
  fields: ReadonlyArray<{
    field: string;
    value: string | null | undefined;
    sourceUrl?: string | null;
  }>,
): EvidenceItemInput[] {
  const items: EvidenceItemInput[] = [];
  for (const row of fields) {
    const value = present(row.value);
    const item = itemFrom(`${id}:${row.field}`, kind, row.field, value, row.sourceUrl);
    if (item !== null) items.push(item);
  }
  return items;
}

/** Non-null lead columns only. Missing columns are not emitted as empty facts. */
export function evidenceFromLead(lead: {
  id: string;
  companyName?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  industry?: string | null;
  city?: string | null;
  country?: string | null;
  painPoint?: string | null;
  serviceInterest?: string | null;
  qualificationNotes?: string | null;
}): EvidenceItemInput[] {
  return rowsFrom(lead.id, "lead", [
    { field: "companyName", value: lead.companyName },
    { field: "contactName", value: lead.contactName },
    { field: "email", value: lead.email },
    { field: "phone", value: lead.phone },
    { field: "website", value: lead.website, sourceUrl: lead.website },
    { field: "industry", value: lead.industry },
    { field: "city", value: lead.city },
    { field: "country", value: lead.country },
    { field: "painPoint", value: lead.painPoint },
    { field: "serviceInterest", value: lead.serviceInterest },
    { field: "qualificationNotes", value: lead.qualificationNotes },
  ]);
}

export function evidenceFromContact(contact: {
  id: string;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
}): EvidenceItemInput[] {
  return rowsFrom(contact.id, "contact", [
    { field: "fullName", value: contact.fullName },
    { field: "email", value: contact.email },
    { field: "phone", value: contact.phone },
    { field: "jobTitle", value: contact.jobTitle },
  ]);
}

export function evidenceFromCompany(company: {
  id: string;
  name?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  industry?: string | null;
  companySize?: string | null;
  description?: string | null;
}): EvidenceItemInput[] {
  return rowsFrom(company.id, "company", [
    { field: "name", value: company.name },
    { field: "website", value: company.website, sourceUrl: company.website },
    { field: "email", value: company.email },
    { field: "phone", value: company.phone },
    { field: "country", value: company.country },
    { field: "region", value: company.region },
    { field: "city", value: company.city },
    { field: "industry", value: company.industry },
    { field: "companySize", value: company.companySize },
    { field: "description", value: company.description },
  ]);
}

function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_PATTERN.test(value);
}

function redact(value: string): string {
  if (looksLikeCredential(value)) return "[redacted]";
  return value.length > MAX_REJECTED_CHARS ? `${value.slice(0, MAX_REJECTED_CHARS)}…` : value;
}

function normaliseField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const field = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(field)) return null;
  return field;
}

function readIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !ID_PATTERN.test(entry)) return null;
    ids.push(entry);
  }
  return ids;
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

function phoneGrounded(text: string, value: string): boolean {
  const wanted = digits(value);
  if (wanted.length < 7 || wanted.length > 15) return false;
  const runs = text.match(/\+?\d[\d\s().-]{6,}\d/g) ?? [];
  return runs.some((run) => digits(run) === wanted);
}

function hostOf(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    if (!host.includes(".")) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * Removes email addresses before a non-email claim is matched.
 *
 * `ada@acme.example` states an email. It does not state a person named Ada,
 * a company named Acme, or a website at acme.example. Those tokens only
 * exist inside the address, so they must not ground another kind of fact.
 * Quoting the address itself is handled separately.
 */
function withoutEmailAddresses(text: string): string {
  return text.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ");
}

function hostsIn(text: string): Set<string> {
  const hosts = new Set<string>();
  const matches =
    withoutEmailAddresses(text).match(/https?:\/\/[^\s<>"')]+|(?:[a-z0-9-]+\.)+[a-z]{2,}/gi) ?? [];
  for (const match of matches) {
    const host = hostOf(match.replace(/[),.;]+$/, ""));
    if (host !== null) hosts.add(host);
  }
  return hosts;
}

/**
 * A phrase grounds a non-email claim when it appears outside any email
 * address. The address itself may still be quoted: that is the email, not a
 * new person, company, or site.
 */
function phraseOutsideEmail(text: string, value: string): boolean {
  if (phraseIn(withoutEmailAddresses(text), value)) return true;
  return EMAIL_PATTERN.test(value) && phraseIn(text, value);
}

function numbersIn(text: string): string[] {
  return text.match(/\d+(?:\.\d+)?%?|\$\d[\d,]*(?:\.\d+)?/g) ?? [];
}

function supports(item: PreparedEvidence, field: string, value: string): boolean {
  if (EMAIL_FIELDS.has(field)) {
    return EMAIL_PATTERN.test(value) && phraseIn(item.corpus, value);
  }
  const visible = withoutEmailAddresses(item.corpus);
  if (PHONE_FIELDS.has(field)) return phoneGrounded(visible, value);
  if (WEB_FIELDS.has(field)) {
    const host = hostOf(value);
    return host !== null && hostsIn(item.corpus).has(host);
  }
  if (STAT_FIELDS.has(field)) {
    const numbers = numbersIn(value);
    if (numbers.length === 0) return false;
    if (!numbers.every((number) => phraseIn(visible, number))) return false;
    return phraseOutsideEmail(item.corpus, value);
  }
  return phraseOutsideEmail(item.corpus, value);
}

function provenanceOf(item: PreparedEvidence): EvidenceProvenance {
  return {
    id: item.id,
    kind: item.kind,
    field: item.field,
    sourceUrl: item.sourceUrl,
    method: item.method,
    observedAt: item.observedAt,
    confidence: item.confidence,
  };
}

function quotationSummary(
  summary: string,
  items: readonly PreparedEvidence[],
): { text: string; ids: string[] } | null {
  const cleaned = cleanText(summary);
  if (cleaned === "" || cleaned.length > MAX_SUMMARY_CHARS) return null;
  if (looksLikeCredential(cleaned)) return null;

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
  if (sentences.length === 0) return null;

  const ids = new Set<string>();
  for (const sentence of sentences) {
    // A trailing stop is punctuation the model adds, not a new fact. The
    // words themselves still have to appear in one evidence item.
    const words = sentence.replace(/[.!?]+$/, "").trim();
    const hit = items.find((item) => phraseIn(item.corpus, words));
    if (hit === undefined) return null;
    ids.add(hit.id);
  }

  return { text: cleaned, ids: [...ids] };
}

/**
 * Validates a parsed model payload against the evidence that was sent.
 *
 * A malformed envelope fails closed: no claim is salvaged from surrounding
 * prose. A well-formed envelope can still have every claim rejected. Rejected
 * values are bounded and credential-shaped values are redacted.
 */
export function validateModelOutput(
  payload: unknown,
  evidence: readonly PreparedEvidence[],
  limits: Pick<AiConfig, "maxClaims">,
): ValidationSuccess | ValidationFailure {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "malformed" };
  }

  const record = payload as { summary?: unknown; claims?: unknown };
  if (record.claims !== undefined && !Array.isArray(record.claims)) {
    return { ok: false, reason: "malformed" };
  }

  const byId = new Map(evidence.map((item) => [item.id, item]));
  const claims = Array.isArray(record.claims) ? record.claims.slice(0, 100) : [];
  const accepted: GroundedClaim[] = [];
  const rejected: RejectedClaim[] = [];
  const unknownFields: string[] = [];
  const seen = new Set<string>();

  for (const raw of claims) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      rejected.push({ field: null, value: null, reason: "malformed_claim", evidenceIds: [] });
      continue;
    }

    const claim = raw as {
      field?: unknown;
      value?: unknown;
      evidenceIds?: unknown;
      unknown?: unknown;
    };
    const field = normaliseField(claim.field);
    const value = typeof claim.value === "string" ? cleanText(claim.value) : null;
    const ids = readIds(claim.evidenceIds);
    const unknown = claim.unknown === true;

    if (field === null) {
      rejected.push({
        field: null,
        value: value === null ? null : redact(value),
        reason: "invalid_field",
        evidenceIds: [],
      });
      continue;
    }

    if (accepted.length >= limits.maxClaims) {
      rejected.push({
        field,
        value: value === null ? null : redact(value),
        reason: "limit_exceeded",
        evidenceIds: ids ?? [],
      });
      continue;
    }

    if (CREDENTIAL_FIELDS.has(field) || (value !== null && looksLikeCredential(value))) {
      rejected.push({ field, value: "[redacted]", reason: "credential", evidenceIds: ids ?? [] });
      continue;
    }

    if (unknown) {
      if (value !== null && value !== "") {
        rejected.push({ field, value: redact(value), reason: "contradictory", evidenceIds: ids ?? [] });
        continue;
      }
      if (!unknownFields.includes(field)) unknownFields.push(field);
      continue;
    }

    if (value === null || value === "") {
      rejected.push({ field, value: null, reason: "missing_value", evidenceIds: ids ?? [] });
      continue;
    }

    if (STOP_VALUES.has(normalise(value))) {
      rejected.push({ field, value: redact(value), reason: "unsupported", evidenceIds: ids ?? [] });
      continue;
    }

    if (ids === null) {
      rejected.push({ field, value: redact(value), reason: "invalid_evidence_id", evidenceIds: [] });
      continue;
    }
    if (ids.length === 0) {
      rejected.push({ field, value: redact(value), reason: "missing_evidence", evidenceIds: [] });
      continue;
    }

    const cited: PreparedEvidence[] = [];
    let unknownId = false;
    for (const id of ids) {
      const item = byId.get(id);
      if (item === undefined) {
        unknownId = true;
        break;
      }
      cited.push(item);
    }
    if (unknownId) {
      rejected.push({ field, value: redact(value), reason: "unknown_evidence", evidenceIds: ids });
      continue;
    }

    if (EMAIL_FIELDS.has(field) && !EMAIL_PATTERN.test(value)) {
      rejected.push({ field, value: redact(value), reason: "not_an_email", evidenceIds: ids });
      continue;
    }
    if (WEB_FIELDS.has(field) && hostOf(value) === null) {
      rejected.push({ field, value: redact(value), reason: "not_a_website", evidenceIds: ids });
      continue;
    }
    if (STAT_FIELDS.has(field) && numbersIn(value).length === 0) {
      rejected.push({ field, value: redact(value), reason: "not_a_statistic", evidenceIds: ids });
      continue;
    }

    const unsupported = cited.some((item) => !supports(item, field, value));
    if (unsupported) {
      rejected.push({
        field,
        value: redact(value),
        reason: "ungrounded",
        evidenceIds: ids,
      });
      continue;
    }

    const key = `${field}\0${normalise(value)}\0${[...ids].sort().join(",")}`;
    if (seen.has(key)) {
      rejected.push({ field, value: redact(value), reason: "duplicate", evidenceIds: ids });
      continue;
    }
    seen.add(key);

    accepted.push({
      field,
      value,
      evidenceIds: ids,
      provenance: cited.map(provenanceOf),
      trustedCrmFact: false,
    });
  }

  let summary: string | null = null;
  let summaryEvidenceIds: string[] = [];
  let summaryDiscarded = false;

  if (typeof record.summary === "string" && record.summary.trim() !== "") {
    const quoted = quotationSummary(record.summary, evidence);
    if (quoted === null) {
      summaryDiscarded = true;
    } else {
      summary = quoted.text;
      summaryEvidenceIds = quoted.ids;
    }
  } else if (record.summary !== undefined && record.summary !== null) {
    summaryDiscarded = true;
  }

  return {
    ok: true,
    summary,
    summaryEvidenceIds,
    summaryDiscarded,
    accepted,
    rejected,
    unknownFields,
  };
}

/** Null when the field was not accepted. Rejected and unknown values are not returned. */
export function claimValue(
  accepted: readonly GroundedClaim[],
  field: string,
): string | null {
  const wanted = normaliseField(field);
  if (wanted === null) return null;
  const found = accepted.find((claim) => claim.field === wanted);
  return found?.value ?? null;
}
