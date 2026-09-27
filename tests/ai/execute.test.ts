import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeAi, interpretedValue, parseModelJson, AI_SYSTEM_PROMPT } from "@/lib/ai/execute";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

let server: FixtureServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function source(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

const evidence = [
  {
    id: "obs_1",
    kind: "observation",
    field: "industry",
    value: "dental",
    text: "Acme Dental is a dental clinic.",
    sourceUrl: "https://acme.example/about",
  },
];

function chat(content: unknown, done = true) {
  return {
    body: JSON.stringify({
      done,
      message: {
        role: "assistant",
        content: typeof content === "string" ? content : JSON.stringify(content),
      },
    }),
    contentType: "application/json",
  };
}

describe("safe execution", () => {
  it("does not call the network when AI is disabled, and returns no invented text", async () => {
    let calls = 0;
    const result = await executeAi({
      instruction: "Summarise the company and invent an email if needed.",
      evidence,
      env: {},
      fetchImpl: async () => {
        calls += 1;
        throw new Error("called");
      },
    });

    expect(calls).toBe(0);
    expect(result.outcome).toBe("disabled");
    expect(result.fallback).toBe(true);
    expect(result.modelInvoked).toBe(false);
    expect(result.summary).toBeNull();
    expect(result.accepted).toEqual([]);
    expect(result.persisted).toBe(false);
    expect(result.trustedCrmFact).toBe(false);
    expect(result.unknown).toBe(true);
    expect(interpretedValue(result, "email")).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/@|recommend|opportunity/i);
  });

  it("returns unknown and does not call the model when no evidence was supplied", async () => {
    let calls = 0;
    const result = await executeAi({
      instruction: "Who should we contact?",
      evidence: [],
      env: {
        AI_ENABLED: "true",
        AI_MODEL: "llama3.2",
        AI_ENDPOINT: "http://127.0.0.1:11434",
      },
      fetchImpl: async () => {
        calls += 1;
        throw new Error("called");
      },
    });

    expect(calls).toBe(0);
    expect(result.outcome).toBe("unknown");
    expect(result.summary).toBeNull();
    expect(result.accepted).toEqual([]);
    expect(result.error).toBeNull();
    expect(result.persisted).toBe(false);
  });

  it("falls back without a fake analysis when Ollama is unavailable", async () => {
    server = await startFixtureServer({
      "/api/version": {
        body: JSON.stringify({ version: "0.5.4" }),
        contentType: "application/json",
        delayMs: 400,
      },
      "/api/chat": chat({ summary: "Invented Co needs a website.", claims: [] }),
    });

    const result = await executeAi({
      instruction: "Interpret the evidence.",
      evidence,
      env: {
        AI_ENABLED: "true",
        AI_MODEL: "llama3.2",
        AI_ENDPOINT: server.url,
        AI_TIMEOUT_MS: "80",
      },
    });

    expect(result.outcome).toBe("unavailable");
    expect(result.fallback).toBe(true);
    expect(result.modelInvoked).toBe(false);
    expect(result.summary).toBeNull();
    expect(result.accepted).toEqual([]);
    expect(result.error?.code).toBe("timeout");
    expect(result.evidenceIds).toEqual(["obs_1"]);
    expect(server.hits.get("/api/chat")).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("Invented");
    expect(result.persisted).toBe(false);
  });

  it("does not send evidence to a host that fails the version check", async () => {
    server = await startFixtureServer({
      "/api/version": { status: 500, body: "down" },
      "/api/chat": chat({
        summary: null,
        claims: [{ field: "email", value: "ada@evil.test", evidenceIds: ["obs_1"], unknown: false }],
      }),
    });

    const result = await executeAi({
      instruction: "Interpret the evidence.",
      evidence,
      env: {
        AI_ENABLED: "true",
        AI_MODEL: "llama3.2",
        AI_ENDPOINT: server.url,
      },
    });

    expect(result.outcome).toBe("unavailable");
    expect(result.accepted).toEqual([]);
    expect(server.hits.get("/api/version")).toBe(1);
    expect(server.hits.get("/api/chat")).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("ada@evil.test");
  });

  it("keeps a grounded claim and rejects a fabricated one from the same reply", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/api/version")) {
        return new Response(JSON.stringify({ version: "0.5.4" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/chat")) {
        const body = JSON.parse(String(init?.body));
        expect(body.stream).toBe(false);
        expect(body.tools).toBeUndefined();
        expect(body.options.temperature).toBe(0);
        expect(body.messages[0].content).toContain("not a source of truth");
        expect(body.messages[1].content).toContain("obs_1");
        expect(body.messages[1].content).not.toContain("169.254.169.254");
        return new Response(
          JSON.stringify({
            done: true,
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "They probably need a rebrand.",
                claims: [
                  { field: "industry", value: "dental", evidenceIds: ["obs_1"], unknown: false },
                  { field: "email", value: "ada@evil.test", evidenceIds: ["obs_1"], unknown: false },
                  { field: "phone", value: null, evidenceIds: [], unknown: true },
                ],
              }),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected ${url}`);
    };

    const result = await executeAi({
      instruction: "What industry is supported by the evidence?",
      evidence,
      env: {
        AI_ENABLED: "true",
        AI_MODEL: "llama3.2",
        AI_ENDPOINT: "http://127.0.0.1:11434",
      },
      fetchImpl,
    });

    expect(seen).toEqual([
      "http://127.0.0.1:11434/api/version",
      "http://127.0.0.1:11434/api/chat",
    ]);
    expect(result.outcome).toBe("interpreted");
    expect(result.fallback).toBe(false);
    expect(result.modelInvoked).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.trustedCrmFact).toBe(false);
    expect(result.summary).toBeNull();
    expect(interpretedValue(result, "industry")).toBe("dental");
    expect(interpretedValue(result, "email")).toBeNull();
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].trustedCrmFact).toBe(false);
    expect(result.accepted[0].provenance[0].sourceUrl).toBe("https://acme.example/about");
    expect(result.rejected.map((claim) => claim.field)).toContain("email");
    expect(result.unknownFields).toContain("phone");
    expect(result.evidenceIds).toEqual(["obs_1"]);
  });

  it("discards a malformed model reply instead of trusting prose", async () => {
    server = await startFixtureServer({
      "/api/version": {
        body: JSON.stringify({ version: "0.1.0" }),
        contentType: "application/json",
      },
      "/api/chat": chat("Sure — email ada@evil.test and call Initech."),
    });

    const result = await executeAi({
      instruction: "Interpret the evidence.",
      evidence,
      env: {
        AI_ENABLED: "true",
        AI_MODEL: "llama3.2",
        AI_ENDPOINT: server.url,
      },
    });

    expect(result.outcome).toBe("rejected");
    expect(result.modelInvoked).toBe(true);
    expect(result.fallback).toBe(true);
    expect(result.accepted).toEqual([]);
    expect(result.summary).toBeNull();
    expect(JSON.stringify(result)).not.toContain("ada@evil.test");
    expect(JSON.stringify(result)).not.toContain("Initech");
    expect(parseModelJson("Here is JSON: {\"claims\":[]}")).toBeUndefined();
  });

  it("does not let the rest of the application depend on Ollama", () => {
    const untouched = [
      "src/lib/crm/scoring.ts",
      "src/lib/crm/daily-actions.ts",
      "src/lib/jobs/handlers.ts",
      "src/lib/jobs/worker.ts",
      "src/worker/index.ts",
      "src/lib/discovery/pipeline.ts",
      "src/app/api/health/route.ts",
    ];

    for (const file of untouched) {
      const text = source(file);
      expect(text).not.toContain("@/lib/ai");
      expect(text).not.toContain("ollama");
    }

    expect(source("src/lib/ai/execute.ts")).not.toContain("@/lib/db");
    expect(source("src/lib/ai/execute.ts")).not.toContain("@prisma/client");
    expect(source("src/app/api/ai/health/route.ts")).not.toContain("executeAi");
    expect(source("src/app/api/ai/test-connection/route.ts")).not.toContain("executeAi");
    expect(AI_SYSTEM_PROMPT).not.toMatch(/find clients|write an outreach|follow up/i);
    expect(AI_SYSTEM_PROMPT).toContain("not a source of truth");
  });
});
