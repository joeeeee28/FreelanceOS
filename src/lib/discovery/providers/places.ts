/**
 * Public place discovery.
 *
 * Reads OpenStreetMap, which is a public geographic database, not a paid lead
 * service. The only hosts this provider will contact are Nominatim and
 * Overpass. A query, a location, or a config URL cannot change that.
 *
 * A place is kept only when the public record names it. A missing website,
 * phone, or email stays absent. Nothing here invents a business.
 */

import { checkTarget } from "../net-guard";
import {
  canonicalDomain,
  canonicalEmail,
  canonicalPhone,
  canonicalUrl,
} from "../canonical";
import type { DiscoveredEntity, ObservedFact } from "../ingest";
import { emptyResult, type DiscoveryContext, type DiscoveryProvider, type DiscoveryResult } from "../provider";
import { PLACE_TYPES, PUBLIC_PLACES_PROVIDER, type PlaceType } from "../places";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const MAX_BBOX_DEGREES = 2;
const MAX_COMPANIES = 25;

interface NominatimHit {
  boundingbox?: unknown;
}

interface OverpassElement {
  type?: unknown;
  id?: unknown;
  tags?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fixedHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "nominatim.openstreetmap.org" || host === "overpass-api.de";
  } catch {
    return false;
  }
}

function readPlace(config: Record<string, unknown>): PlaceType | null {
  const key = typeof config.placeKey === "string" ? config.placeKey : "";
  return PLACE_TYPES.find((place) => place.key === key) ?? null;
}

function readLimit(config: Record<string, unknown>): number {
  const value = config.maxCompanies;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return 5;
  return Math.min(parsed, MAX_COMPANIES);
}

function readLocation(config: Record<string, unknown>): string | null {
  if (typeof config.location !== "string") return null;
  const location = config.location.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (location.length < 2 || location.length > 80) return null;
  if (/https?:\/\//i.test(location) || location.includes("@")) return null;
  return location;
}

function boundingBox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const numbers = value.map((entry) => Number(entry));
  if (numbers.some((entry) => !Number.isFinite(entry))) return null;
  const [south, north, west, east] = numbers;
  if (south === undefined || north === undefined || west === undefined || east === undefined) return null;
  if (south < -90 || north > 90 || south >= north) return null;
  if (west < -180 || east > 180 || west >= east) return null;
  if (north - south > MAX_BBOX_DEGREES || east - west > MAX_BBOX_DEGREES) return null;
  return [south, west, north, east];
}

function tagText(tags: Record<string, unknown>, key: string): string | null {
  const value = tags[key];
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (text === "" || text.length > 160) return null;
  return text;
}

function acceptedWebsite(raw: string | null): string | null {
  const url = canonicalUrl(raw);
  if (url === null) return null;
  if (!checkTarget(url).allowed) return null;
  return url;
}

function elementUrl(type: string, id: number): string {
  return `https://www.openstreetmap.org/${type}/${id}`;
}

function recordKey(type: string, id: number): string {
  return `osm:${type}:${id}`;
}

function entityFromElement(
  element: OverpassElement,
  place: PlaceType,
  sourceId: string | null,
): DiscoveredEntity | null {
  if (element.type !== "node" && element.type !== "way" && element.type !== "relation") return null;
  if (typeof element.id !== "number" || !Number.isInteger(element.id) || element.id <= 0) return null;
  if (!isRecord(element.tags)) return null;

  const name = tagText(element.tags, "name");
  if (name === null) return null;

  const sourceUrl = elementUrl(element.type, element.id);
  const key = recordKey(element.type, element.id);
  const website = acceptedWebsite(
    tagText(element.tags, "website") ?? tagText(element.tags, "contact:website"),
  );
  const phone = canonicalPhone(
    tagText(element.tags, "phone") ?? tagText(element.tags, "contact:phone"),
  );
  const email = canonicalEmail(
    tagText(element.tags, "email") ?? tagText(element.tags, "contact:email"),
  );
  const city = tagText(element.tags, "addr:city");
  const region = tagText(element.tags, "addr:state");
  const country = tagText(element.tags, "addr:country");
  const publishedType = tagText(element.tags, place.osmKey);
  const industry = publishedType === place.osmValue ? place.label : null;

  const facts: ObservedFact[] = [
    {
      field: "name",
      value: name,
      method: "HTML_SELECTOR",
      sourceUrl,
      locator: key,
      evidence: `OpenStreetMap ${element.type} ${element.id} names this place "${name}".`,
    },
  ];

  const extra: Array<[ObservedFact["field"], string | null]> = [
    ["website", website],
    ["phone", phone],
    ["email", email],
    ["city", city],
    ["region", region],
    ["country", country],
    ["industry", industry],
  ];

  for (const [field, value] of extra) {
    if (value === null) continue;
    facts.push({
      field,
      value,
      method: "HTML_SELECTOR",
      sourceUrl,
      locator: key,
      evidence: `OpenStreetMap ${element.type} ${element.id} publishes ${field}.`,
    });
  }

  return {
    identity: {
      name,
      website,
      domain: canonicalDomain(website),
      email,
      phone,
      city,
      country,
    },
    facts,
    sourceId,
    recordKey: key,
  };
}

/**
 * Finds named places in a public map extract.
 *
 * Returns no entities when the location cannot be resolved, the area is too
 * broad, or the public source refuses the request. It does not substitute a
 * guess.
 */
export const placesProvider: DiscoveryProvider = {
  key: PUBLIC_PLACES_PROVIDER,
  label: "Public places",
  category: "PUBLIC_DIRECTORY",
  requiresNetwork: true,
  description:
    "Reads named places from OpenStreetMap for one supported place type and one location. It does not accept a caller-supplied URL.",

  async run(context: DiscoveryContext): Promise<DiscoveryResult> {
    const result = emptyResult();
    const place = readPlace(context.config);
    const location = readLocation(context.config);

    if (place === null || location === null) {
      result.warnings.push("INVALID_SOURCE: a supported place type and location are required.");
      return result;
    }

    const nominatim = `${NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(location)}`;
    if (!fixedHost(nominatim)) {
      result.warnings.push("INVALID_SOURCE: the geocoder host is not permitted.");
      return result;
    }

    result.pagesAttempted += 1;
    const located = await context.fetcher.fetch(nominatim, { timeoutMs: 15_000 });
    if (located.outcome === "BLOCKED") {
      result.pagesBlocked += 1;
      result.warnings.push("ACCESS_BLOCKED: the public geocoder refused the request.");
      return result;
    }
    if (located.outcome === "TIMEOUT") {
      result.pagesFailed += 1;
      result.warnings.push("TIMEOUT: the public geocoder did not answer.");
      return result;
    }
    if (located.outcome === "RATE_LIMITED") {
      result.pagesFailed += 1;
      result.warnings.push("RATE_LIMITED: the public geocoder asked us to slow down.");
      return result;
    }
    if (located.outcome !== "SUCCESS" || typeof located.body !== "string") {
      result.pagesFailed += 1;
      result.warnings.push(`SOURCE_UNAVAILABLE: the public geocoder returned ${located.outcome}.`);
      return result;
    }

    result.pagesSucceeded += 1;
    let hits: unknown;
    try {
      hits = JSON.parse(located.body);
    } catch {
      result.pagesFailed += 1;
      result.warnings.push("PROVIDER_ERROR: the geocoder response was not valid JSON.");
      return result;
    }

    const first = Array.isArray(hits) ? (hits[0] as NominatimHit | undefined) : undefined;
    const box = boundingBox(first?.boundingbox);
    if (box === null) {
      result.warnings.push("INVALID_SOURCE: that location was not found as a small public area.");
      return result;
    }

    const [south, west, north, east] = box;
    const limit = readLimit(context.config);
    const query = [
      "[out:json][timeout:25];",
      "(",
      `node["${place.osmKey}"="${place.osmValue}"](${south},${west},${north},${east});`,
      `way["${place.osmKey}"="${place.osmValue}"](${south},${west},${north},${east});`,
      ");",
      `out center ${limit};`,
    ].join("");
    const overpass = `${OVERPASS}?data=${encodeURIComponent(query)}`;
    if (!fixedHost(overpass)) {
      result.warnings.push("INVALID_SOURCE: the place source host is not permitted.");
      return result;
    }

    result.pagesAttempted += 1;
    const listed = await context.fetcher.fetch(overpass, { timeoutMs: 25_000 });
    if (listed.outcome === "BLOCKED") {
      result.pagesBlocked += 1;
      result.warnings.push("ACCESS_BLOCKED: the public place source refused the request.");
      return result;
    }
    if (listed.outcome === "TIMEOUT") {
      result.pagesFailed += 1;
      result.warnings.push("TIMEOUT: the public place source did not answer.");
      return result;
    }
    if (listed.outcome === "RATE_LIMITED") {
      result.pagesFailed += 1;
      result.warnings.push("RATE_LIMITED: the public place source asked us to slow down.");
      return result;
    }
    if (listed.outcome !== "SUCCESS" || typeof listed.body !== "string") {
      result.pagesFailed += 1;
      result.warnings.push(`SOURCE_UNAVAILABLE: the public place source returned ${listed.outcome}.`);
      return result;
    }

    result.pagesSucceeded += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(listed.body);
    } catch {
      result.pagesFailed += 1;
      result.warnings.push("PROVIDER_ERROR: the place source response was not valid JSON.");
      return result;
    }

    const elements = isRecord(parsed) && Array.isArray(parsed.elements) ? parsed.elements : null;
    if (elements === null) {
      result.pagesFailed += 1;
      result.warnings.push("PROVIDER_ERROR: the place source response had no element list.");
      return result;
    }

    const seen = new Set<string>();
    for (const element of elements) {
      if (result.entities.length >= limit) break;
      if (!isRecord(element)) continue;
      const entity = entityFromElement(element, place, context.sourceId);
      if (entity?.recordKey == null || seen.has(entity.recordKey)) continue;
      seen.add(entity.recordKey);
      result.entities.push(entity);
    }

    if (result.entities.length === 0) {
      result.warnings.push("No named places were published for that search.");
    }

    return result;
  },
};
