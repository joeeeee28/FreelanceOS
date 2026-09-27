import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Fetcher, FetchedDocument } from "@/lib/discovery/provider";
import { emptyFilters } from "@/lib/find-clients/parse";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const { placesProvider } = await import("@/lib/discovery/providers/places");
const { providerRegistry } = await import("@/lib/discovery/providers");
const { classifyStatus } = await import("@/lib/discovery/provider");
const { HttpFetcher } = await import("@/lib/discovery/fetcher");
const { ingestDiscoveredEntity, manualFact } = await import("@/lib/discovery/ingest");
const {
  appendSourceNotice,
  displayDiscoveryStatus,
  getPublicDiscoveryBoard,
  parseDiscoveryRequest,
  publicSourceNotice,
  queuePublicDiscovery,
} = await import("@/lib/discovery/places");
const { runSource } = await import("@/lib/discovery/pipeline");
const { refreshCompanySignals } = await import("@/lib/discovery/signals/store");
const { searchFindClients } = await import("@/lib/find-clients/search");
const { enqueueJob } = await import("@/lib/jobs/queue");
const { runWorker } = await import("@/lib/jobs/worker");

const noSleep = async () => {};
let alice: SeededWorkspace;
let bob: SeededWorkspace;

beforeAll(async () => {
  await resetTestDatabase();
}, 120_000);

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("Alice");
  bob = await seedWorkspace("Bob");
});

afterAll(async () => {
  await disconnectTestPrisma();
});

const NOMINATIM = JSON.stringify([
  { boundingbox: ["12.9", "13.2", "80.1", "80.3"], display_name: "Chennai, Tamil Nadu, India" },
]);

const OVERPASS = JSON.stringify({
  elements: [
    {
      type: "node",
      id: 101,
      tags: {
        name: "Harbour Dental",
        amenity: "dentist",
        phone: "+914412345678",
        "addr:city": "Chennai",
        "addr:country": "India",
      },
    },
    { type: "node", id: 102, tags: { amenity: "dentist" } },
  ],
});

function pages(bodyFor: (url: string) => FetchedDocument | "THROW"): Fetcher {
  return {
    async fetch(url: string) {
      const host = new URL(url).hostname;
      if (host !== "nominatim.openstreetmap.org" && host !== "overpass-api.de") {
        throw new Error(`unexpected host ${host}`);
      }
      const document = bodyFor(url);
      if (document === "THROW") throw new Error("fetched");
      return document;
    },
  };
}

function success(url: string, body: string): FetchedDocument {
  return { url, outcome: "SUCCESS", statusCode: 200, body };
}

function place(id: number, tags: Record<string, string>) {
  return { type: "node", id, lat: 13.08, lon: 80.27, tags };
}

const MANY = JSON.stringify({
  elements: [
    place(201, {
      name: "Harbour Dental",
      amenity: "dentist",
      phone: "+914412345678",
      website: "https://harbour.example",
      "addr:city": "Chennai",
      "addr:state": "Tamil Nadu",
      "addr:country": "India",
    }),
    place(202, { name: "Bay Clinic", amenity: "dentist" }),
    place(203, { name: "North Dental", amenity: "dentist", phone: "+914400000001" }),
    place(201, { name: "Harbour Dental", amenity: "dentist", phone: "+914412345678" }),
    place(204, { amenity: "dentist" }),
    place(205, { name: "West Dental", amenity: "dentist", "addr:city": "Chennai" }),
  ],
});

function statusFetcher(status: number): Fetcher {
  return new HttpFetcher({
    respectRobots: false,
    minIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: async () => new Response("unavailable", { status }),
  });
}

async function runPlace(fetcher: Fetcher) {
  return placesProvider.run({
    workspaceId: "ws",
    sourceId: null,
    config: { placeKey: "dentist", location: "Chennai, India", maxCompanies: 5 },
    fetcher,
    now: new Date("2026-09-27T00:00:00.000Z"),
  });
}

describe("public discovery request", () => {
  it("rejects an unsupported query, a URL location, and a catalog-unknown service", () => {
    const parsed = parseDiscoveryRequest({
      query: "John Smith",
      location: "https://evil.example",
      services: ["NOT_A_SERVICE"],
      maxCompanies: "0",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.fieldErrors.query?.[0]).toMatch(/not a supported/i);
      expect(parsed.fieldErrors.location?.[0]).toMatch(/URL is not a location/i);
      expect(parsed.fieldErrors.service?.[0]).toMatch(/catalog/i);
    }
  });

  it("accepts a dental clinic query without inventing a service", () => {
    const parsed = parseDiscoveryRequest({
      query: "dental clinics",
      location: "Chennai, India",
      services: ["WEBSITE_CREATION"],
      maxCompanies: "5",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.place.key).toBe("dentist");
      expect(parsed.request.serviceKeys).toEqual(["WEBSITE_CREATION"]);
      expect(parsed.request.maxCompanies).toBe(5);
    }
  });

  it("maps run states onto the existing lifecycle", () => {
    expect(displayDiscoveryStatus({ jobStatus: "PENDING", runStatus: null, failedJobs: 0, succeededJobs: 0 })).toBe("QUEUED");
    expect(displayDiscoveryStatus({ jobStatus: "RUNNING", runStatus: "RUNNING", failedJobs: 0, succeededJobs: 0 })).toBe("RUNNING");
    expect(displayDiscoveryStatus({ jobStatus: "SUCCEEDED", runStatus: "COMPLETED", failedJobs: 1, succeededJobs: 2 })).toBe("PARTIAL");
    expect(displayDiscoveryStatus({ jobStatus: "SUCCEEDED", runStatus: "COMPLETED", failedJobs: 0, succeededJobs: 2 })).toBe("SUCCEEDED");
    expect(displayDiscoveryStatus({ jobStatus: "FAILED", runStatus: "FAILED", failedJobs: 1, succeededJobs: 0 })).toBe("FAILED");
  });

  it("keeps a categorized source warning and drops internals", () => {
    const summary = appendSourceNotice("0 valid entities, 0 new, 0 blocked.", [
      "SOURCE_UNAVAILABLE: the public geocoder returned NETWORK_ERROR.",
    ]);
    expect(publicSourceNotice(summary)).toBe("SOURCE_UNAVAILABLE: the public geocoder returned NETWORK_ERROR.");
    expect(publicSourceNotice("0 valid entities, 0 new, 0 blocked.")).toBeNull();
    expect(publicSourceNotice("SOURCE_UNAVAILABLE: prisma password leaked.")).toBe("The run failed.");
  });
});

describe("public places provider", () => {
  it("keeps a named place and does not invent a website or a nameless record", async () => {
    const seen: string[] = [];
    const result = await placesProvider.run({
      workspaceId: "ws",
      sourceId: null,
      config: { placeKey: "dentist", location: "Chennai, India", maxCompanies: 5, urls: ["http://169.254.169.254/"] },
      fetcher: pages((url) => {
        seen.push(new URL(url).hostname);
        if (url.includes("nominatim")) return success(url, NOMINATIM);
        expect(url).not.toContain("Chennai");
        expect(url).toContain("amenity");
        expect(url).toContain("dentist");
        return success(url, OVERPASS);
      }),
      now: new Date("2026-09-27T00:00:00.000Z"),
    });

    expect(seen).toEqual(["nominatim.openstreetmap.org", "overpass-api.de"]);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      recordKey: "osm:node:101",
      identity: { name: "Harbour Dental", website: null, phone: "+914412345678", city: "Chennai" },
    });
  });

  it("does not fetch when the request is not a supported place", async () => {
    let calls = 0;
    const result = await placesProvider.run({
      workspaceId: "ws",
      sourceId: null,
      config: { urls: ["http://169.254.169.254/latest"] },
      fetcher: {
        async fetch() {
          calls += 1;
          throw new Error("fetched");
        },
      },
      now: new Date(),
    });
    expect(calls).toBe(0);
    expect(result.entities).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/INVALID_SOURCE/);
  });

  it("records a block and an empty geocoder without creating a place", async () => {
    const blocked = await placesProvider.run({
      workspaceId: "ws",
      sourceId: null,
      config: { placeKey: "dentist", location: "Chennai, India" },
      fetcher: pages(() => ({ url: "https://nominatim.openstreetmap.org/search", outcome: "BLOCKED", statusCode: 403 })),
      now: new Date(),
    });
    expect(blocked.entities).toEqual([]);
    expect(blocked.warnings.join(" ")).toMatch(/ACCESS_BLOCKED/);

    const empty = await placesProvider.run({
      workspaceId: "ws",
      sourceId: null,
      config: { placeKey: "dentist", location: "Chennai, India" },
      fetcher: pages((url) => success(url, "[]")),
      now: new Date(),
    });
    expect(empty.entities).toEqual([]);
    expect(empty.warnings.join(" ")).toMatch(/not found/i);

    const malformed = await placesProvider.run({
      workspaceId: "ws",
      sourceId: null,
      config: { placeKey: "dentist", location: "Chennai, India" },
      fetcher: pages((url) => success(url, url.includes("nominatim") ? NOMINATIM : "not-json")),
      now: new Date(),
    });
    expect(malformed.entities).toEqual([]);
    expect(malformed.warnings.join(" ")).toMatch(/PROVIDER_ERROR/);
  });

  it("keeps two to five named places and does not fill missing fields", async () => {
    const result = await runPlace(
      pages((url) => success(url, url.includes("nominatim") ? NOMINATIM : MANY)),
    );
    expect(result.entities.map((entity) => entity.identity.name)).toEqual([
      "Harbour Dental",
      "Bay Clinic",
      "North Dental",
      "West Dental",
    ]);
    expect(new Set(result.entities.map((entity) => entity.recordKey)).size).toBe(4);
    const bay = result.entities.find((entity) => entity.identity.name === "Bay Clinic");
    const north = result.entities.find((entity) => entity.identity.name === "North Dental");
    const west = result.entities.find((entity) => entity.identity.name === "West Dental");
    expect(bay?.identity).toMatchObject({ website: null, phone: null, city: null, country: null });
    expect(north?.identity).toMatchObject({ website: null, city: null, phone: "+914400000001" });
    expect(west?.identity).toMatchObject({ website: null, phone: null, city: "Chennai" });
    expect(result.warnings.join(" ")).not.toMatch(/SOURCE_UNAVAILABLE|ACCESS_BLOCKED|TIMEOUT/);
  });

  it("treats an empty place list as a successful search, not a source failure", async () => {
    const result = await runPlace(
      pages((url) => success(url, url.includes("nominatim") ? NOMINATIM : JSON.stringify({ elements: [] }))),
    );
    expect(result.entities).toEqual([]);
    expect(result.pagesFailed).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/No named places/);
    expect(publicSourceNotice(appendSourceNotice("0 valid entities, 0 new, 0 blocked.", result.warnings))).toBeNull();
  });

  it("keeps network, timeout, rate-limit, server, and malformed responses distinct", async () => {
    expect(classifyStatus(429)).toBe("RATE_LIMITED");
    expect(classifyStatus(500)).toBe("SERVER_ERROR");

    const cases: Array<[Fetcher, RegExp]> = [
      [pages(() => ({ url: "https://nominatim.openstreetmap.org/search", outcome: "NETWORK_ERROR" })), /SOURCE_UNAVAILABLE: the public geocoder returned NETWORK_ERROR/],
      [pages(() => ({ url: "https://nominatim.openstreetmap.org/search", outcome: "TIMEOUT" })), /TIMEOUT: the public geocoder did not answer/],
      [statusFetcher(429), /RATE_LIMITED: the public geocoder asked us to slow down/],
      [statusFetcher(500), /SOURCE_UNAVAILABLE: the public geocoder returned SERVER_ERROR/],
      [pages((url) => success(url, "{")), /PROVIDER_ERROR: the geocoder response was not valid JSON/],
    ];

    for (const [fetcher, warning] of cases) {
      const result = await runPlace(fetcher);
      expect(result.entities).toEqual([]);
      expect(result.warnings.join(" ")).toMatch(warning);
      expect(publicSourceNotice(appendSourceNotice("0 valid entities, 0 new, 0 blocked.", result.warnings))).toMatch(warning);
    }
  });
});

describe("queued public discovery", () => {
  it("creates one source and one job, and does not create a company", async () => {
    const parsed = parseDiscoveryRequest({ query: "dental clinics", location: "Chennai, India", maxCompanies: "5" });
    if (!parsed.ok) throw new Error("request");
    const first = await queuePublicDiscovery({
      workspaceId: alice.workspaceId,
      request: parsed.request,
      timezone: "Asia/Kolkata",
      now: new Date("2026-09-27T04:00:00.000Z"),
    });
    const second = await queuePublicDiscovery({
      workspaceId: alice.workspaceId,
      request: parsed.request,
      timezone: "Asia/Kolkata",
      now: new Date("2026-09-27T04:10:00.000Z"),
    });

    expect(second.reused).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    expect(await db.source.count({ where: { workspaceId: alice.workspaceId, provider: "public-places" } })).toBe(1);
    expect(await db.company.count()).toBe(0);
    expect(await db.discoveryRun.count()).toBe(0);
    const job = await db.job.findUniqueOrThrow({ where: { id: first.jobId } });
    expect(job.type).toBe("DISCOVERY_RUN");
    expect(job.payload).toMatchObject({ trigger: "MANUAL", sourceId: first.sourceId });
  });

  it("does not crawl another workspace when a source id is injected", async () => {
    const foreign = await db.source.create({
      data: { workspaceId: bob.workspaceId, provider: "public-places", name: "Bob places" },
    });
    await enqueueJob({
      workspaceId: alice.workspaceId,
      type: "DISCOVERY_RUN",
      payload: { trigger: "MANUAL", sourceId: foreign.id },
    });
    await runWorker({ maxJobs: 1, sleep: noSleep });

    expect(await db.job.count({ where: { type: "CRAWL_SOURCE" } })).toBe(0);
    const run = await db.discoveryRun.findFirstOrThrow({ where: { workspaceId: alice.workspaceId } });
    expect(run.trigger).toBe("MANUAL");
    expect(await db.company.count({ where: { workspaceId: bob.workspaceId } })).toBe(0);
  });

  it("links the crawl to the run and asks it to research what it finds", async () => {
    const parsed = parseDiscoveryRequest({ query: "dental clinic", location: "Chennai, India" });
    if (!parsed.ok) throw new Error("request");
    const queued = await queuePublicDiscovery({
      workspaceId: alice.workspaceId,
      request: parsed.request,
      now: new Date("2026-09-27T05:00:00.000Z"),
    });
    await runWorker({ maxJobs: 1, sleep: noSleep });

    const crawl = await db.job.findFirstOrThrow({ where: { type: "CRAWL_SOURCE" } });
    expect(crawl.discoveryRunId).not.toBeNull();
    expect(crawl.payload).toMatchObject({ sourceId: queued.sourceId, research: true });
    expect(providerRegistry.get("public-places")?.key).toBe("public-places");
  });

  it("stores a named place, refreshes it, and shows it in Find Clients", async () => {
    const parsed = parseDiscoveryRequest({ query: "dental clinics", location: "Chennai, India" });
    if (!parsed.ok) throw new Error("request");
    const queued = await queuePublicDiscovery({
      workspaceId: alice.workspaceId,
      request: parsed.request,
      now: new Date("2026-09-27T06:00:00.000Z"),
    });

    const first = await runSource({
      workspaceId: alice.workspaceId,
      sourceId: queued.sourceId,
      fetcher: pages((url) => success(url, url.includes("nominatim") ? NOMINATIM : OVERPASS)),
    });
    const second = await runSource({
      workspaceId: alice.workspaceId,
      sourceId: queued.sourceId,
      fetcher: pages((url) => success(url, url.includes("nominatim") ? NOMINATIM : OVERPASS)),
    });

    expect(first.companiesCreated).toBe(1);
    expect(second.companiesCreated).toBe(0);
    expect(second.companiesMatched).toBe(1);
    expect(await db.company.count({ where: { workspaceId: alice.workspaceId } })).toBe(1);
    const company = await db.company.findFirstOrThrow({ where: { workspaceId: alice.workspaceId } });
    expect(company.name).toBe("Harbour Dental");
    expect(company.website).toBeNull();
    expect(company.phone).toBe("+914412345678");

    const signals = await refreshCompanySignals({ workspaceId: alice.workspaceId, companyId: company.id });
    expect(signals.opportunitiesCreated).toBeGreaterThan(0);
    const page = await searchFindClients(alice.workspaceId, emptyFilters(), 1);
    expect(page.results.map((row) => row.company.name)).toContain("Harbour Dental");
    expect(await db.company.count({ where: { workspaceId: bob.workspaceId } })).toBe(0);
  });

  it("records a blocked source and stores nothing", async () => {
    const parsed = parseDiscoveryRequest({ query: "pharmacy", location: "Chennai, India" });
    if (!parsed.ok) throw new Error("request");
    const queued = await queuePublicDiscovery({
      workspaceId: alice.workspaceId,
      request: parsed.request,
      now: new Date("2026-09-27T07:00:00.000Z"),
    });
    const result = await runSource({
      workspaceId: alice.workspaceId,
      sourceId: queued.sourceId,
      fetcher: pages(() => ({ url: "https://nominatim.openstreetmap.org/search", outcome: "BLOCKED", statusCode: 403 })),
    });
    expect(result.companiesCreated).toBe(0);
    expect(await db.company.count()).toBe(0);
    const source = await db.source.findUniqueOrThrow({ where: { id: queued.sourceId } });
    expect(source.status).toBe("BLOCKED");
  });

  it("shows an unavailable source on the board without inventing companies", async () => {
    const parsed = parseDiscoveryRequest({ query: "dental clinic", location: "Chennai, India" });
    if (!parsed.ok) throw new Error("request");
    const queued = await queuePublicDiscovery({
      workspaceId: alice.workspaceId,
      request: parsed.request,
      now: new Date("2026-09-27T08:00:00.000Z"),
    });
    const run = await db.discoveryRun.create({
      data: {
        workspaceId: alice.workspaceId,
        trigger: "MANUAL",
        status: "COMPLETED",
        startedAt: new Date("2026-09-27T08:00:00.000Z"),
        completedAt: new Date("2026-09-27T08:01:00.000Z"),
      },
    });
    await db.job.update({
      where: { id: queued.jobId },
      data: { status: "SUCCEEDED", discoveryRunId: run.id },
    });
    await db.job.create({
      data: {
        workspaceId: alice.workspaceId,
        type: "CRAWL_SOURCE",
        status: "SUCCEEDED",
        attempts: 1,
        maxAttempts: 3,
        runAfter: new Date("2026-09-27T08:00:00.000Z"),
        payload: { sourceId: queued.sourceId },
        result: {
          summary: appendSourceNotice("0 valid entities, 0 new, 0 blocked.", [
            "SOURCE_UNAVAILABLE: the public geocoder returned NETWORK_ERROR.",
          ]),
        },
        discoveryRunId: run.id,
      },
    });

    const board = await getPublicDiscoveryBoard(alice.workspaceId);
    expect(board.status).toBe("SUCCEEDED");
    expect(board.message).toBe("SOURCE_UNAVAILABLE: the public geocoder returned NETWORK_ERROR.");
    expect(board.companies).toEqual([]);
    expect(await db.company.count()).toBe(0);
  });

  it("reuses the same company, keeps history, and shows a real signal in Find Clients", async () => {
    const parsed = parseDiscoveryRequest({ query: "dental clinic", location: "Chennai, India", maxCompanies: "5" });
    if (!parsed.ok) throw new Error("request");
    const queued = await queuePublicDiscovery({
      workspaceId: alice.workspaceId,
      request: parsed.request,
      now: new Date("2026-09-27T09:00:00.000Z"),
    });
    const body = (url: string) => success(url, url.includes("nominatim") ? NOMINATIM : MANY);
    const first = await runSource({
      workspaceId: alice.workspaceId,
      sourceId: queued.sourceId,
      fetcher: pages(body),
    });
    expect(first.companiesCreated).toBe(4);
    expect(await db.company.count({ where: { workspaceId: alice.workspaceId } })).toBe(4);
    expect(await db.company.count({ where: { workspaceId: bob.workspaceId } })).toBe(0);

    const harbour = await db.company.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId, name: "Harbour Dental" },
    });
    expect(harbour.website).toBe("https://harbour.example");
    const bay = await db.company.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId, name: "Bay Clinic" },
    });
    expect(bay.website).toBeNull();
    expect(bay.phone).toBeNull();
    expect(bay.city).toBeNull();

    const manual = await ingestDiscoveredEntity({
      workspaceId: alice.workspaceId,
      entity: {
        identity: { name: "Harbour Dental" },
        recordKey: "osm:node:201",
        facts: [manualFact("phone", "+914411111111", "Confirmed by the owner")],
      },
    });
    expect(manual.kind).toBe("INGESTED");
    if (manual.kind === "INGESTED") expect(manual.companyId).toBe(harbour.id);

    const before = await db.observation.count({ where: { companyId: harbour.id } });
    const changed = JSON.stringify({
      elements: [
        place(201, {
          name: "Harbour Dental",
          amenity: "dentist",
          phone: "+914499999999",
          website: "https://harbour.example",
          "addr:city": "Chennai",
          "addr:country": "India",
        }),
      ],
    });
    const second = await runSource({
      workspaceId: alice.workspaceId,
      sourceId: queued.sourceId,
      fetcher: pages((url) => success(url, url.includes("nominatim") ? NOMINATIM : changed)),
    });
    expect(second.companiesCreated).toBe(0);
    expect(second.companiesMatched).toBe(1);
    expect(await db.company.count({ where: { workspaceId: alice.workspaceId } })).toBe(4);
    const kept = await db.company.findUniqueOrThrow({ where: { id: harbour.id } });
    expect(kept.phone).toBe("+914411111111");
    const after = await db.observation.count({ where: { companyId: harbour.id } });
    expect(after).toBeGreaterThan(before);
    expect(await db.observation.count({ where: { companyId: harbour.id, value: "+914411111111" } })).toBe(1);

    const signals = await refreshCompanySignals({ workspaceId: alice.workspaceId, companyId: bay.id });
    expect(signals.opportunitiesCreated).toBe(0);
    const contactable = await db.company.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId, name: "North Dental" },
    });
    const created = await refreshCompanySignals({ workspaceId: alice.workspaceId, companyId: contactable.id });
    expect(created.opportunitiesCreated).toBeGreaterThan(0);
    const page = await searchFindClients(alice.workspaceId, emptyFilters(), 1);
    const row = page.results.find((entry) => entry.company.name === "North Dental");
    expect(row?.opportunity.score).toBeGreaterThan(0);
    expect(row?.evidence.length).toBeGreaterThan(0);
    expect(row?.company.researchStatus).toBeTruthy();
    expect(page.results.map((entry) => entry.company.name)).not.toContain("Bay Clinic");
  });

  it("records a mocked network failure through the worker without storing a company", async () => {
    const parsed = parseDiscoveryRequest({ query: "dental clinic", location: "Chennai, India" });
    if (!parsed.ok) throw new Error("request");
    const queued = await queuePublicDiscovery({
      workspaceId: alice.workspaceId,
      request: parsed.request,
      now: new Date("2026-09-27T10:00:00.000Z"),
    });
    await db.source.update({ where: { id: queued.sourceId }, data: { requestsPerMinute: 6000 } });
    await runWorker({ maxJobs: 1, sleep: noSleep });

    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      throw new TypeError("fetch failed");
    };
    try {
      await runWorker({ maxJobs: 1, sleep: async () => {} });
    } finally {
      globalThis.fetch = original;
    }

    expect(await db.company.count()).toBe(0);
    const crawl = await db.job.findFirstOrThrow({ where: { type: "CRAWL_SOURCE" } });
    expect(crawl.status).toBe("SUCCEEDED");
    expect(JSON.stringify(crawl.result)).toMatch(/SOURCE_UNAVAILABLE: the public geocoder returned NETWORK_ERROR/);
    const board = await getPublicDiscoveryBoard(alice.workspaceId);
    expect(board.status).toBe("SUCCEEDED");
    expect(board.message).toBe("SOURCE_UNAVAILABLE: the public geocoder returned NETWORK_ERROR.");
    expect(board.companies).toEqual([]);
  });
});
