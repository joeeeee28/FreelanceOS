import { afterEach, describe, expect, it } from "vitest";

import { readAiConfig } from "@/lib/ai/config";
import { deriveAiHealthState, getAiHealth, toPublicAiHealth } from "@/lib/ai/health";
import { isAiHealthy } from "@/lib/ai/types";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

let server: FixtureServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const enabled = {
  AI_ENABLED: "true",
  AI_MODEL: "llama3.2",
  AI_ENDPOINT: "http://127.0.0.1:11434",
};

function throwingFetch(): typeof fetch {
  return async () => {
    throw new Error("network should not be contacted");
  };
}

describe("AI configuration", () => {
  it("is disabled, bounded, and not healthy when nothing is set", () => {
    const resolution = readAiConfig({});

    expect(resolution.configuration).toBe("disabled");
    expect(resolution.config.enabled).toBe(false);
    expect(resolution.config.provider).toBe("ollama");
    expect(resolution.config.timeoutMs).toBe(15_000);
    expect(resolution.config.maxRetries).toBe(0);
    expect(resolution.config.maxResponseBytes).toBe(256 * 1024);
    expect(resolution.healthy).toBe(false);
    expect(resolution.problems).toEqual([]);
  });

  it("does not throw or probe when disabled, even if other variables are garbage", async () => {
    const resolution = readAiConfig({
      AI_ENABLED: "false",
      AI_PROVIDER: "openai",
      AI_TIMEOUT_MS: "nope",
      AI_ENDPOINT: "http://169.254.169.254/",
    });
    expect(resolution.configuration).toBe("disabled");
    expect(resolution.healthy).toBe(false);

    let calls = 0;
    const report = await getAiHealth({
      env: { AI_ENABLED: "no", AI_TIMEOUT_MS: "nope" },
      fetchImpl: async () => {
        calls += 1;
        throw new Error("called");
      },
    });

    expect(calls).toBe(0);
    expect(report.state).toBe("disabled");
    expect(report.healthy).toBe(false);
    expect(report.probed).toBe(false);
    expect(report.endpointHost).toBeNull();
  });

  it("accepts an enabled local configuration without calling it healthy", async () => {
    const resolution = readAiConfig(enabled);
    expect(resolution.configuration).toBe("configured");
    expect(resolution.healthy).toBe(false);
    expect(resolution.endpoint?.host).toBe("127.0.0.1:11434");
    expect(resolution.model).toBe("llama3.2");

    let calls = 0;
    const report = await getAiHealth({
      env: enabled,
      probe: false,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("called");
      },
    });

    expect(calls).toBe(0);
    expect(report.state).toBe("configured");
    expect(report.configuration).toBe("configured");
    expect(report.healthy).toBe(false);
    expect(report.checks.configurationValid).toBe(true);
    expect(report.checks.probed).toBe(false);
    expect(report.checks.reachable).toBe(false);
    expect(report.checks.modelAvailable).toBe(false);
    expect(isAiHealthy(report.state)).toBe(false);
  });

  it("rejects an unknown provider, a missing model, and an out-of-range limit without probing", async () => {
    const cases = [
      { ...enabled, AI_PROVIDER: "openai" },
      { ...enabled, AI_MODEL: "" },
      { ...enabled, AI_TIMEOUT_MS: "10" },
      { ...enabled, AI_MAX_RETRIES: "9" },
      { ...enabled, AI_ENDPOINT: "http://169.254.169.254/" },
    ];

    for (const env of cases) {
      let calls = 0;
      const report = await getAiHealth({
        env,
        fetchImpl: async () => {
          calls += 1;
          throw new Error("called");
        },
      });
      expect(calls).toBe(0);
      expect(report.state).toBe("error");
      expect(report.healthy).toBe(false);
      expect(report.configuration).toBe("invalid");
    }

    const paid = await getAiHealth({
      env: { ...enabled, AI_PROVIDER: "openai" },
      fetchImpl: throwingFetch(),
    });
    expect(paid.error?.code).toBe("unsupported_provider");
    expect(paid.error?.message).not.toContain("openai");
  });

  it("does not keep a credential that was embedded in a rejected endpoint", () => {
    const resolution = readAiConfig({
      ...enabled,
      AI_ENDPOINT: "http://user:s3cret@127.0.0.1:11434",
    });

    expect(resolution.configuration).toBe("invalid");
    expect(resolution.endpoint).toBeNull();
    expect(resolution.config.endpoint).toBe("");
    expect(JSON.stringify(resolution)).not.toContain("s3cret");
  });

  it("uses the local default endpoint when enabled and the endpoint is unset", () => {
    const resolution = readAiConfig({ AI_ENABLED: "true", AI_MODEL: "llama3.2" });
    expect(resolution.configuration).toBe("configured");
    expect(resolution.endpoint?.origin).toBe("http://127.0.0.1:11434");
    expect(resolution.healthy).toBe(false);
  });
});

describe("AI health states", () => {
  it("derives every state, and only model_available is healthy", () => {
    const cases: Array<[Parameters<typeof deriveAiHealthState>[0], string]> = [
      [{ enabled: false, configured: true, probed: true, reachable: true, modelAvailable: true, failure: "none" }, "disabled"],
      [{ enabled: true, configured: false, probed: false, reachable: false, modelAvailable: false, failure: "error" }, "error"],
      [{ enabled: true, configured: true, probed: false, reachable: false, modelAvailable: false, failure: "none" }, "configured"],
      [{ enabled: true, configured: true, probed: true, reachable: false, modelAvailable: false, failure: "network" }, "unavailable"],
      [{ enabled: true, configured: true, probed: true, reachable: false, modelAvailable: false, failure: "error" }, "error"],
      [{ enabled: true, configured: true, probed: true, reachable: true, modelAvailable: false, failure: "none" }, "reachable"],
      [{ enabled: true, configured: true, probed: true, reachable: true, modelAvailable: false, failure: "error" }, "error"],
      [{ enabled: true, configured: true, probed: true, reachable: true, modelAvailable: true, failure: "none" }, "model_available"],
      [{ enabled: true, configured: true, probed: true, reachable: true, modelAvailable: true, failure: "error" }, "error"],
    ];

    for (const [input, state] of cases) {
      const derived = deriveAiHealthState(input);
      expect(derived).toBe(state);
      expect(isAiHealthy(derived)).toBe(state === "model_available");
    }
  });

  it("reports model_available only after a live probe lists the model", async () => {
    server = await startFixtureServer({
      "/api/version": {
        body: JSON.stringify({ version: "0.5.4" }),
        contentType: "application/json",
      },
      "/api/tags": {
        body: JSON.stringify({ models: [{ name: "llama3.2:latest" }] }),
        contentType: "application/json",
      },
    });

    const now = new Date("2026-09-26T12:00:00.000Z");
    const report = await getAiHealth({
      env: { ...enabled, AI_ENDPOINT: server.url },
      now,
    });

    expect(report.state).toBe("model_available");
    expect(report.healthy).toBe(true);
    expect(report.configuration).toBe("configured");
    expect(report.probed).toBe(true);
    expect(report.reachable).toBe(true);
    expect(report.modelAvailable).toBe(true);
    expect(report.version).toBe("0.5.4");
    expect(report.checkedAt).toBe(now.toISOString());
    expect(report.endpointHost).toBe(new URL(server.url).host);
    expect(toPublicAiHealth(report)).not.toHaveProperty("endpoint");
    expect(JSON.stringify(toPublicAiHealth(report))).not.toContain(server.url);
  });

  it("stays reachable, not healthy, when the server is up and the model is not", async () => {
    server = await startFixtureServer({
      "/api/version": {
        body: JSON.stringify({ version: "0.5.4" }),
        contentType: "application/json",
      },
      "/api/tags": {
        body: JSON.stringify({ models: [] }),
        contentType: "application/json",
      },
    });

    const report = await getAiHealth({
      env: { ...enabled, AI_ENDPOINT: server.url },
    });

    expect(report.state).toBe("reachable");
    expect(report.healthy).toBe(false);
    expect(report.reachable).toBe(true);
    expect(report.modelAvailable).toBe(false);
    expect(report.error?.code).toBe("model_unavailable");
  });

  it("reports unavailable when Ollama cannot be reached, and error on a malformed body", async () => {
    server = await startFixtureServer({
      "/api/version": {
        body: JSON.stringify({ version: "0.5.4" }),
        contentType: "application/json",
        delayMs: 400,
      },
    });

    const slow = await getAiHealth({
      env: {
        ...enabled,
        AI_ENDPOINT: server.url,
        AI_HEALTH_TIMEOUT_MS: "80",
        AI_TIMEOUT_MS: "2000",
      },
    });
    expect(slow.state).toBe("unavailable");
    expect(slow.healthy).toBe(false);
    expect(slow.reachable).toBe(false);
    expect(slow.error?.code).toBe("timeout");
    expect(server.hits.get("/api/version")).toBe(1);

    await server.close();
    server = await startFixtureServer({
      "/api/version": { body: "hello", contentType: "text/plain" },
    });

    const malformed = await getAiHealth({
      env: { ...enabled, AI_ENDPOINT: server.url },
    });
    expect(malformed.state).toBe("error");
    expect(malformed.healthy).toBe(false);
    expect(malformed.error?.code).toBe("malformed_response");
  });

  it("does not probe a disabled deployment even when a probe is requested", async () => {
    let calls = 0;
    const report = await getAiHealth({
      env: {},
      probe: true,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("called");
      },
    });
    expect(calls).toBe(0);
    expect(report.state).toBe("disabled");
    expect(report.healthy).toBe(false);
  });
});
