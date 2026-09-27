import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FIND_CLIENT_INTERPRETATION_UNAVAILABLE,
  interpretFindClient,
  interpretationTimeoutMs,
  type FindClientDetail,
} from "@/lib/find-clients";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

let server: FixtureServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function detail(overrides: Partial<FindClientDetail> = {}): FindClientDetail {
  return {
    company: {
      id: "company_1",
      name: "Harbour Physio",
      industry: "Physiotherapy",
      city: "Chennai",
      region: null,
      country: "India",
      website: "https://harbour.example.test",
      lastResearchAt: "2026-03-01T00:00:00.000Z",
      researchStatus: "RESEARCHED",
    },
    opportunity: {
      id: "opp_1",
      serviceKey: "WEBSITE_REDESIGN",
      serviceLabel: "Website redesign",
      status: "OPEN",
      score: 70,
      summary: "Potential website conversion improvement.",
      recommendedAction: "Review the public site before offering a redesign.",
      detectedAt: "2026-03-01T00:00:00.000Z",
    },
    evidence: [
      {
        kind: "signal",
        id: "sig_1",
        label: "website outdated",
        text: "The homepage copyright says 2014.",
        sourceUrl: "https://harbour.example.test",
        sourceName: null,
        confidence: 80,
        observedAt: "2026-03-01T00:00:00.000Z",
      },
    ],
    observations: [],
    research: [],
    confidence: 80,
    scoreExplanation: ["Website redesign: 70/100 from stored opportunity rules."],
    lead: null,
    ...overrides,
  };
}

function chat(content: unknown) {
  return {
    body: JSON.stringify({
      done: true,
      message: { role: "assistant", content: JSON.stringify(content) },
    }),
    contentType: "application/json",
  };
}

describe("Find Clients interpretation", () => {
  it("caps the wait and does not lengthen a shorter configured timeout", () => {
    expect(interpretationTimeoutMs(15_000)).toBe(8_000);
    expect(interpretationTimeoutMs(50)).toBe(50);
  });

  it("says interpretation is unavailable when AI is disabled and does not invent text", async () => {
    let calls = 0;
    const result = await interpretFindClient(detail(), {
      env: { AI_ENABLED: "false" },
      fetchImpl: async () => {
        calls += 1;
        throw new Error("called");
      },
    });

    expect(calls).toBe(0);
    expect(result.available).toBe(false);
    expect(result.message).toBe(FIND_CLIENT_INTERPRETATION_UNAVAILABLE);
    expect(result.summary).toBeNull();
    expect(result.score).toBe(70);
    expect(JSON.stringify(result)).not.toMatch(/definitely|@|decision maker/i);
  });

  it("keeps the stored score when Ollama does not answer", async () => {
    server = await startFixtureServer({
      "/api/version": { status: 500, body: "down" },
      "/api/chat": chat({ summary: "Invented Co needs a new website.", claims: [] }),
    });

    const result = await interpretFindClient(detail(), {
      env: {
        AI_ENABLED: "true",
        AI_MODEL: "llama3.2",
        AI_ENDPOINT: server.url,
      },
    });

    expect(result.message).toBe(FIND_CLIENT_INTERPRETATION_UNAVAILABLE);
    expect(result.summary).toBeNull();
    expect(result.score).toBe(70);
    expect(server.hits.get("/api/chat")).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("Invented");
  });

  it("rejects a fabricated company, person, email, phone, website, and opportunity", async () => {
    server = await startFixtureServer({
      "/api/version": { body: JSON.stringify({ version: "0.5.4" }), contentType: "application/json" },
      "/api/tags": {
        body: JSON.stringify({ models: [{ name: "llama3.2" }] }),
        contentType: "application/json",
      },
      "/api/chat": chat({
        summary: "Call Ada at ada@evil.test about Northwind Clinic.",
        claims: [
          { field: "email", value: "ada@evil.test", evidenceIds: ["sig_1"], unknown: false },
          { field: "phone", value: "+91 90000 00000", evidenceIds: ["sig_1"], unknown: false },
          { field: "website", value: "https://northwind.example", evidenceIds: ["sig_1"], unknown: false },
          { field: "contactName", value: "Ada Lovelace", evidenceIds: ["sig_1"], unknown: false },
          { field: "companyName", value: "Northwind Clinic", evidenceIds: ["sig_1"], unknown: false },
          {
            field: "serviceInterest",
            value: "Definitely needs a new website",
            evidenceIds: ["sig_1"],
            unknown: false,
          },
        ],
      }),
    });

    const result = await interpretFindClient(detail(), {
      env: {
        AI_ENABLED: "true",
        AI_MODEL: "llama3.2",
        AI_ENDPOINT: server.url,
      },
    });

    expect(result.summary).toBeNull();
    expect(result.accepted).toEqual([]);
    expect(result.rejectedCount).toBeGreaterThan(0);
    expect(result.score).toBe(70);
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("ada@evil.test");
    expect(encoded).not.toContain("90000");
    expect(encoded).not.toContain("northwind");
    expect(encoded).not.toContain("Ada Lovelace");
    expect(encoded).not.toContain("Definitely needs");
  });

  it("does not call the model when no evidence is stored", async () => {
    let calls = 0;
    const result = await interpretFindClient(
      detail({ evidence: [], observations: [], confidence: null }),
      {
        env: { AI_ENABLED: "true", AI_MODEL: "llama3.2", AI_ENDPOINT: "http://127.0.0.1:9" },
        fetchImpl: async () => {
          calls += 1;
          throw new Error("called");
        },
      },
    );

    expect(calls).toBe(0);
    expect(result.summary).toBeNull();
    expect(result.message).toMatch(/No evidence/);
  });

  it("does not import the database or write an opportunity", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/find-clients/interpret.ts"), "utf8");
    expect(source).not.toContain("@/lib/db");
    expect(source).not.toContain("opportunity.update");
    expect(source).not.toContain("opportunity.create");
  });
});
