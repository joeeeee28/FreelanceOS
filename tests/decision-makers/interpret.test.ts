import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DECISION_MAKER_INTERPRETATION_UNAVAILABLE,
  interpretDecisionMakers,
  type StoredPerson,
} from "@/lib/decision-makers";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

let server: FixtureServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function person(): StoredPerson {
  return {
    id: "cmuit0mpe000bovnzpq5lo9n4",
    fullName: "Ada Lovelace",
    canonicalName: "ada lovelace",
    jobTitle: "Head of Marketing",
    email: null,
    phone: null,
    linkedinUrl: null,
    verification: "PUBLISHED",
    confidence: 90,
    method: "STRUCTURED_DATA",
    sourceUrl: "https://harbour.example.test/about",
    evidence: "Ada Lovelace. Head of Marketing.",
    isDecisionMaker: true,
    firstSeenAt: "2026-03-01T00:00:00.000Z",
    lastSeenAt: "2026-03-01T00:00:00.000Z",
    promotedContactId: null,
    dismissed: false,
    roleCategory: "marketing",
    roleReasons: ["Title matches marketing, which is a function, not seniority alone."],
    serviceKeys: ["META_ADS"],
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

describe("decision-maker interpretation", () => {
  it("says interpretation is unavailable when AI is disabled", async () => {
    let calls = 0;
    const result = await interpretDecisionMakers([person()], {
      env: { AI_ENABLED: "false" },
      fetchImpl: async () => {
        calls += 1;
        throw new Error("called");
      },
    });
    expect(calls).toBe(0);
    expect(result.message).toBe(DECISION_MAKER_INTERPRETATION_UNAVAILABLE);
    expect(result.summary).toBeNull();
  });

  it("rejects a fabricated email and person when the model invents them", async () => {
    server = await startFixtureServer({
      "/api/version": { body: JSON.stringify({ version: "0.5.4" }), contentType: "application/json" },
      "/api/chat": chat({
        summary: "Email Grace Hopper at grace@evil.test.",
        claims: [
          { field: "email", value: "grace@evil.test", evidenceIds: ["cmuit0mpe000bovnzpq5lo9n4"], unknown: false },
          { field: "contactName", value: "Grace Hopper", evidenceIds: ["cmuit0mpe000bovnzpq5lo9n4"], unknown: false },
        ],
      }),
    });

    const result = await interpretDecisionMakers([person()], {
      env: {
        AI_ENABLED: "true",
        AI_MODEL: "llama3.2",
        AI_ENDPOINT: server.url,
      },
    });

    expect(result.summary).toBeNull();
    expect(JSON.stringify(result)).not.toContain("grace@evil.test");
    expect(JSON.stringify(result)).not.toContain("Grace Hopper");
  });

  it("does not write and does not import outreach", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/decision-makers/interpret.ts"), "utf8");
    expect(source).not.toContain("@/lib/db");
    expect(source).not.toContain("discoveredContact.create");
    expect(readFileSync(path.join(process.cwd(), "src/lib/decision-makers/review.ts"), "utf8")).not.toMatch(
      /outreach|sendMail|whatsapp/i,
    );
  });
});
