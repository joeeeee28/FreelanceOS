/**
 * A user-started public discovery request.
 *
 * Validates a closed set of place types and catalog services, then queues one
 * discovery cycle. It does not fetch, and it does not create a company.
 */

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db-client";
import { enqueueJob } from "@/lib/jobs/queue";
import { localPartsIn } from "@/lib/discovery/scheduler";
import { isServiceKey, SERVICES, type ServiceKey } from "@/lib/taxonomy/services";

export const PUBLIC_PLACES_PROVIDER = "public-places";

export interface PlaceType {
  key: string;
  label: string;
  phrases: readonly string[];
  osmKey: string;
  osmValue: string;
}

/**
 * Place types OpenStreetMap publishes as a stable tag.
 *
 * A free-text query is accepted only when it contains one of these phrases.
 * Anything else is rejected rather than turned into a search guess.
 */
export const PLACE_TYPES: readonly PlaceType[] = [
  { key: "dentist", label: "Dentist", phrases: ["dental clinic", "dental clinics", "dentist", "dentists"], osmKey: "amenity", osmValue: "dentist" },
  { key: "clinic", label: "Clinic", phrases: ["clinic", "clinics"], osmKey: "amenity", osmValue: "clinic" },
  { key: "hospital", label: "Hospital", phrases: ["hospital", "hospitals"], osmKey: "amenity", osmValue: "hospital" },
  { key: "pharmacy", label: "Pharmacy", phrases: ["pharmacy", "pharmacies", "chemist"], osmKey: "amenity", osmValue: "pharmacy" },
  { key: "physiotherapist", label: "Physiotherapy", phrases: ["physiotherapy", "physiotherapist", "physio"], osmKey: "healthcare", osmValue: "physiotherapist" },
  { key: "restaurant", label: "Restaurant", phrases: ["restaurant", "restaurants"], osmKey: "amenity", osmValue: "restaurant" },
  { key: "cafe", label: "Cafe", phrases: ["coffee shop", "cafe", "cafes"], osmKey: "amenity", osmValue: "cafe" },
  { key: "hotel", label: "Hotel", phrases: ["hotel", "hotels"], osmKey: "tourism", osmValue: "hotel" },
  { key: "gym", label: "Gym", phrases: ["fitness centre", "fitness center", "gym"], osmKey: "leisure", osmValue: "fitness_centre" },
  { key: "school", label: "School", phrases: ["school", "schools"], osmKey: "amenity", osmValue: "school" },
  { key: "lawyer", label: "Lawyer", phrases: ["law firm", "lawyer", "lawyers"], osmKey: "office", osmValue: "lawyer" },
  { key: "accountant", label: "Accountant", phrases: ["accountant", "accountants"], osmKey: "office", osmValue: "accountant" },
];

export const DEFAULT_DISCOVERY_COUNT = 5;
export const MAX_DISCOVERY_COUNT = 25;

export interface PublicDiscoveryRequest {
  query: string;
  location: string;
  place: PlaceType;
  industry: string | null;
  serviceKeys: ServiceKey[];
  maxCompanies: number;
}

export type DiscoveryDisplayStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED";

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export function matchPlaceType(query: string): PlaceType | null {
  const text = clean(query).toLowerCase();
  if (text === "") return null;
  const phrases = PLACE_TYPES.flatMap((place) => place.phrases.map((phrase) => ({ place, phrase })));
  phrases.sort((a, b) => b.phrase.length - a.phrase.length);
  return phrases.find((entry) => text.includes(entry.phrase))?.place ?? null;
}

export function parseDiscoveryRequest(input: {
  query?: string;
  location?: string;
  industry?: string;
  businessType?: string;
  services?: readonly string[];
  maxCompanies?: string;
}): { ok: true; request: PublicDiscoveryRequest } | { ok: false; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};
  const query = clean(input.query ?? "");
  const location = clean(input.location ?? "");
  const industry = clean(input.industry ?? "");
  const businessType = clean(input.businessType ?? "");
  const maxRaw = clean(input.maxCompanies ?? "");

  const fromQuery = query === "" ? null : matchPlaceType(query);
  const fromType = businessType === "" ? null : PLACE_TYPES.find((place) => place.key === businessType) ?? null;

  if (query === "" && fromType === null) {
    fieldErrors.query = ["Enter a supported public place type, such as dental clinic or pharmacy."];
  } else if (query !== "" && fromQuery === null) {
    fieldErrors.query = ["That query is not a supported public place type. Nothing was searched."];
  }
  if (businessType !== "" && fromType === null) {
    fieldErrors.businessType = ["That business type is not supported."];
  }
  if (fromQuery !== null && fromType !== null && fromQuery.key !== fromType.key) {
    fieldErrors.businessType = ["The business type does not match the query."];
  }

  if (location.length < 3 || location.length > 80 || /https?:\/\//i.test(location) || location.includes("@")) {
    fieldErrors.location = ["Enter a city and country, such as Chennai, India. A URL is not a location."];
  }

  if (industry !== "" && (industry.length > 60 || !/^[A-Za-z][A-Za-z ,.'-]{1,59}$/.test(industry))) {
    fieldErrors.industry = ["Industry must be plain text. It is stored as a request, not as a company fact."];
  }

  const serviceKeys: ServiceKey[] = [];
  for (const service of input.services ?? []) {
    if (!isServiceKey(service)) {
      fieldErrors.service = ["That service is not in the catalog."];
      break;
    }
    if (!serviceKeys.includes(service)) serviceKeys.push(service);
  }

  const maxCompanies = maxRaw === "" ? DEFAULT_DISCOVERY_COUNT : Number(maxRaw);
  if (!Number.isInteger(maxCompanies) || maxCompanies < 1 || maxCompanies > MAX_DISCOVERY_COUNT) {
    fieldErrors.maxCompanies = [`Choose between 1 and ${MAX_DISCOVERY_COUNT}.`];
  }

  const place = fromType ?? fromQuery;
  if (place === null || Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    request: {
      query: query === "" ? place.phrases[0] ?? place.label : query,
      location,
      place,
      industry: industry === "" ? null : industry,
      serviceKeys,
      maxCompanies,
    },
  };
}

export function discoveryServiceOptions(): Array<{ key: ServiceKey; label: string }> {
  return SERVICES.map((service) => ({ key: service.key, label: service.label }));
}

function sourceName(request: PublicDiscoveryRequest): string {
  return `OpenStreetMap: ${request.place.label} · ${request.location}`.slice(0, 160);
}

function hourKey(workspaceId: string, request: PublicDiscoveryRequest, timezone: string, now: Date): string {
  const local = localPartsIn(timezone || "UTC", now);
  const day = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  const hour = String(local.hour).padStart(2, "0");
  const place = request.place.key;
  const location = request.location.toLowerCase();
  return `places:${workspaceId}:${place}:${location}:${day}T${hour}`;
}

/**
 * Creates or reuses the public-places source and queues one discovery cycle.
 *
 * The HTTP request stops here. The worker creates the run and reads the source.
 */
export async function queuePublicDiscovery(input: {
  workspaceId: string;
  request: PublicDiscoveryRequest;
  timezone?: string;
  now?: Date;
}): Promise<{ sourceId: string; jobId: string; reused: boolean }> {
  const now = input.now ?? new Date();
  const name = sourceName(input.request);
  const config: Prisma.InputJsonValue = {
    placeKey: input.request.place.key,
    query: input.request.query,
    location: input.request.location,
    maxCompanies: input.request.maxCompanies,
    requestedIndustry: input.request.industry,
    requestedServices: input.request.serviceKeys,
  };

  const existing = await db.source.findFirst({
    where: { workspaceId: input.workspaceId, provider: PUBLIC_PLACES_PROVIDER, name },
    select: { id: true },
  });

  const source = existing
    ? await db.source.update({
        where: { id: existing.id },
        data: { config, enabled: true, status: "ACTIVE" },
        select: { id: true },
      })
    : await db.source.create({
        data: {
          workspaceId: input.workspaceId,
          provider: PUBLIC_PLACES_PROVIDER,
          name,
          url: "https://nominatim.openstreetmap.org",
          config,
        },
        select: { id: true },
      });

  const idempotencyKey = hourKey(input.workspaceId, input.request, input.timezone ?? "UTC", now);
  const pending = await db.job.findFirst({
    where: {
      workspaceId: input.workspaceId,
      idempotencyKey,
      status: { in: ["PENDING", "RUNNING"] },
    },
    select: { id: true },
  });
  if (pending !== null) {
    return { sourceId: source.id, jobId: pending.id, reused: true };
  }

  const job = await enqueueJob({
    workspaceId: input.workspaceId,
    type: "DISCOVERY_RUN",
    payload: { trigger: "MANUAL", sourceId: source.id },
    idempotencyKey,
    priority: 40,
  });

  return { sourceId: source.id, jobId: job.id, reused: false };
}

export function displayDiscoveryStatus(input: {
  jobStatus: string | null;
  runStatus: string | null;
  failedJobs: number;
  succeededJobs: number;
}): DiscoveryDisplayStatus {
  if (input.runStatus === "CANCELLED" || input.jobStatus === "CANCELLED") return "CANCELLED";
  if (input.runStatus === "FAILED" || input.jobStatus === "FAILED") return "FAILED";
  if (input.runStatus === "RUNNING" || input.jobStatus === "RUNNING") return "RUNNING";
  if (input.runStatus === "COMPLETED" && input.failedJobs > 0 && input.succeededJobs > 0) return "PARTIAL";
  if (input.runStatus === "COMPLETED") return "SUCCEEDED";
  return "QUEUED";
}

export function publicRunError(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  if (text.length > 180 || /prisma|sql|stack|secret|password/i.test(text)) return "The run failed.";
  return text;
}

const SOURCE_NOTICE =
  /(?:ACCESS_BLOCKED|TIMEOUT|RATE_LIMITED|SOURCE_UNAVAILABLE|PROVIDER_ERROR|INVALID_SOURCE): [^.]+\./;

/** Keeps a categorized source warning on the crawl summary. Other warnings stay out of it. */
export function appendSourceNotice(summary: string, warnings: readonly string[]): string {
  const notice = warnings.join(" ").match(SOURCE_NOTICE)?.[0] ?? null;
  return notice === null ? summary : `${summary} ${notice}`;
}

/** Pulls that same warning back out of a stored job summary. */
export function publicSourceNotice(summary: string | null | undefined): string | null {
  if (typeof summary !== "string") return null;
  return publicRunError(summary.match(SOURCE_NOTICE)?.[0] ?? null);
}

export interface PublicDiscoveryBoard {
  status: DiscoveryDisplayStatus | null;
  message: string | null;
  runId: string | null;
  jobId: string | null;
  companies: Array<{
    id: string;
    name: string;
    city: string | null;
    country: string | null;
    website: string | null;
    industry: string | null;
    researchStatus: string;
    sourceUrl: string | null;
    opportunityId: string | null;
    serviceKey: string | null;
  }>;
}

function resultSummary(result: Prisma.JsonValue | null | undefined): string | null {
  if (result === null || result === undefined || typeof result !== "object" || Array.isArray(result)) return null;
  const summary = (result as Record<string, unknown>).summary;
  return typeof summary === "string" ? summary : null;
}

function payloadSourceId(payload: Prisma.JsonValue): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).sourceId;
  return typeof value === "string" && value !== "" ? value : null;
}

/** Latest queued public discovery and the companies it has already stored. */
export async function getPublicDiscoveryBoard(workspaceId: string): Promise<PublicDiscoveryBoard> {
  const jobs = await db.job.findMany({
    where: { workspaceId, type: "DISCOVERY_RUN" },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, status: true, payload: true, error: true, discoveryRunId: true },
  });
  const job = jobs.find((entry) => payloadSourceId(entry.payload) !== null) ?? null;

  const run = job?.discoveryRunId
    ? await db.discoveryRun.findFirst({
        where: { id: job.discoveryRunId, workspaceId },
        select: { id: true, status: true, error: true },
      })
    : null;

  const children = run
    ? await db.job.groupBy({
        by: ["status"],
        where: { workspaceId, discoveryRunId: run.id },
        _count: { _all: true },
      })
    : [];
  const countOf = (status: string) => children.find((row) => row.status === status)?._count._all ?? 0;
  const crawl = run
    ? await db.job.findFirst({
        where: { workspaceId, discoveryRunId: run.id, type: "CRAWL_SOURCE" },
        orderBy: { createdAt: "desc" },
        select: { result: true },
      })
    : null;

  const observations = await db.observation.findMany({
    where: {
      workspaceId,
      locator: { startsWith: "osm:" },
      source: { provider: PUBLIC_PLACES_PROVIDER },
      company: { workspaceId, archivedAt: null, resolutionState: "RESOLVED" },
    },
    orderBy: { observedAt: "desc" },
    take: 40,
    select: {
      sourceUrl: true,
      company: {
        select: {
          id: true,
          name: true,
          city: true,
          country: true,
          website: true,
          industry: true,
          researchStatus: true,
          opportunities: {
            where: { status: { in: ["OPEN", "PURSUED"] } },
            orderBy: { score: "desc" },
            take: 1,
            select: { id: true, serviceKey: true },
          },
        },
      },
    },
  });

  const seen = new Set<string>();
  const companies: PublicDiscoveryBoard["companies"] = [];
  for (const observation of observations) {
    if (seen.has(observation.company.id)) continue;
    seen.add(observation.company.id);
    const opportunity = observation.company.opportunities[0] ?? null;
    companies.push({
      id: observation.company.id,
      name: observation.company.name,
      city: observation.company.city,
      country: observation.company.country,
      website: observation.company.website,
      industry: observation.company.industry,
      researchStatus: observation.company.researchStatus,
      sourceUrl: observation.sourceUrl,
      opportunityId: opportunity?.id ?? null,
      serviceKey: opportunity?.serviceKey ?? null,
    });
    if (companies.length >= 25) break;
  }

  if (job === null) {
    return { status: null, message: null, runId: null, jobId: null, companies };
  }

  const status = displayDiscoveryStatus({
    jobStatus: job.status,
    runStatus: run?.status ?? null,
    failedJobs: countOf("FAILED"),
    succeededJobs: countOf("SUCCEEDED"),
  });

  return {
    status,
    message: publicRunError(run?.error ?? job.error) ?? publicSourceNotice(resultSummary(crawl?.result)),
    runId: run?.id ?? null,
    jobId: job.id,
    companies,
  };
}
