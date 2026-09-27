import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { AI_DEFAULTS, type AiConfig } from "@/lib/ai/config";
import { assessOperatorEndpoint } from "@/lib/ai/endpoint";
import { OllamaProvider, modelIsAvailable } from "@/lib/ai/ollama";
import { checkTarget } from "@/lib/discovery/net-guard";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

let server: FixtureServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function config(endpoint: string, extra: Partial<AiConfig> = {}): AiConfig {
  return {
    ...AI_DEFAULTS,
    enabled: true,
    provider: "ollama",
    model: "llama3.2",
    endpoint,
    timeoutMs: 2_000,
    healthTimeoutMs: 2_000,
    ...extra,
  };
}

async function closedOrigin(): Promise<string> {
  const listening = createServer();
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  const { port } = listening.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    listening.close((error) => (error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${port}`;
}

describe("model availability", () => {
  it("matches the configured name or its :latest tag, and nothing else", () => {
    expect(modelIsAvailable("llama3.2", ["llama3.2:latest"])).toBe(true);
    expect(modelIsAvailable("llama3.2:latest", ["llama3.2:latest"])).toBe(true);
    expect(modelIsAvailable("llama3.2:7b", ["llama3.2:7b"])).toBe(true);
    expect(modelIsAvailable("llama3.2", ["llama3.2:7b"])).toBe(false);
    expect(modelIsAvailable("llama3.2", [])).toBe(false);
    expect(modelIsAvailable("", ["llama3.2:latest"])).toBe(false);
  });
});

describe("Ollama provider", () => {
  it("reports a successful connection only when the server and the model both answer", async () => {
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

    const result = await new OllamaProvider().probe(config(server.url), {
      timeoutMs: 2_000,
      checkModel: true,
    });

    expect(result.reachable).toBe(true);
    expect(result.modelAvailable).toBe(true);
    expect(result.version).toBe("0.5.4");
    expect(result.error).toBeNull();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(server.hits.get("/api/version")).toBe(1);
    expect(server.hits.get("/api/tags")).toBe(1);
  });

  it("does not treat a reachable server as having the model when the model is absent", async () => {
    server = await startFixtureServer({
      "/api/version": {
        body: JSON.stringify({ version: "0.5.4" }),
        contentType: "application/json",
      },
      "/api/tags": {
        body: JSON.stringify({ models: [{ name: "llama3.2:7b" }, { name: "mistral:latest" }] }),
        contentType: "application/json",
      },
    });

    const result = await new OllamaProvider().probe(config(server.url), {
      timeoutMs: 2_000,
      checkModel: true,
    });

    expect(result.reachable).toBe(true);
    expect(result.modelAvailable).toBe(false);
    expect(result.error?.code).toBe("model_unavailable");
  });

  it("reports an unavailable server without inventing a completion", async () => {
    const origin = await closedOrigin();
    const result = await new OllamaProvider().probe(config(origin, { timeoutMs: 500 }), {
      timeoutMs: 500,
      checkModel: true,
    });

    expect(result.reachable).toBe(false);
    expect(result.modelAvailable).toBeNull();
    expect(["unreachable", "timeout"]).toContain(result.error?.code);
    expect(JSON.stringify(result)).not.toMatch(/acme|invented|recommend/i);
  });

  it("times out a slow server and does not retry the probe", async () => {
    server = await startFixtureServer({
      "/api/version": {
        body: JSON.stringify({ version: "0.5.4" }),
        contentType: "application/json",
        delayMs: 400,
      },
    });

    const result = await new OllamaProvider().probe(
      config(server.url, { maxRetries: 1 }),
      { timeoutMs: 80, checkModel: true },
    );

    expect(result.reachable).toBe(false);
    expect(result.error?.code).toBe("timeout");
    expect(server.hits.get("/api/version")).toBe(1);
    expect(server.hits.get("/api/tags")).toBeUndefined();
  });

  it("rejects a malformed version body instead of guessing the server is healthy", async () => {
    server = await startFixtureServer({
      "/api/version": { body: "not-json", contentType: "text/plain" },
    });

    const result = await new OllamaProvider().probe(config(server.url), {
      timeoutMs: 2_000,
      checkModel: true,
    });

    expect(result.reachable).toBe(false);
    expect(result.modelAvailable).toBeNull();
    expect(result.error?.code).toBe("malformed_response");
    expect(server.hits.get("/api/tags")).toBeUndefined();
  });

  it("rejects an oversized body and does not return it as text", async () => {
    server = await startFixtureServer({
      "/api/version": {
        body: "x".repeat(2_000),
        contentType: "application/json",
      },
    });

    const result = await new OllamaProvider().probe(
      config(server.url, { maxResponseBytes: 256 }),
      { timeoutMs: 2_000, checkModel: false },
    );

    expect(result.error?.code).toBe("response_too_large");
    expect(JSON.stringify(result)).not.toContain("xxx");
  });

  it("does not follow a redirect", async () => {
    server = await startFixtureServer({
      "/api/version": {
        status: 302,
        headers: { location: "/stolen" },
        body: "",
      },
      "/stolen": { body: "should-not-be-read" },
    });

    const result = await new OllamaProvider().probe(config(server.url), {
      timeoutMs: 2_000,
      checkModel: true,
    });

    expect(result.reachable).toBe(false);
    expect(result.error?.code).toBe("redirect_refused");
    expect(server.hits.get("/api/version")).toBe(1);
    expect(server.hits.get("/stolen")).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("should-not-be-read");
  });

  it("does not request a redirect target on another host", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("169.254.169.254")) {
        throw new Error("followed redirect to metadata");
      }
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    };

    const result = await new OllamaProvider({ fetchImpl }).probe(config("http://127.0.0.1:11434"), {
      timeoutMs: 2_000,
      checkModel: true,
    });

    expect(result.error?.code).toBe("redirect_refused");
    expect(seen).toEqual(["http://127.0.0.1:11434/api/version"]);
  });

  it("retries a connection failure at most once, and does not retry a timeout or an HTTP error", async () => {
    let refused = 0;
    const refusing: typeof fetch = async () => {
      refused += 1;
      const error = new Error("fetch failed");
      (error as Error & { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
      throw error;
    };

    const retried = await new OllamaProvider({ fetchImpl: refusing }).complete(
      config("http://127.0.0.1:11434", { maxRetries: 1 }),
      { system: "s", prompt: "p", maxOutputTokens: 32 },
      { timeoutMs: 2_000 },
    );
    expect(retried.ok).toBe(false);
    expect(refused).toBe(2);

    refused = 0;
    await new OllamaProvider({ fetchImpl: refusing }).complete(
      config("http://127.0.0.1:11434", { maxRetries: 0 }),
      { system: "s", prompt: "p", maxOutputTokens: 32 },
      { timeoutMs: 2_000 },
    );
    expect(refused).toBe(1);

    // A hand-built retry count above the cap still stops at one extra attempt.
    refused = 0;
    await new OllamaProvider({ fetchImpl: refusing }).complete(
      config("http://127.0.0.1:11434", { maxRetries: 9 }),
      { system: "s", prompt: "p", maxOutputTokens: 32 },
      { timeoutMs: 2_000 },
    );
    expect(refused).toBe(2);

    let httpCalls = 0;
    const http500: typeof fetch = async () => {
      httpCalls += 1;
      return new Response("no", { status: 500 });
    };
    const httpResult = await new OllamaProvider({ fetchImpl: http500 }).complete(
      config("http://127.0.0.1:11434", { maxRetries: 1 }),
      { system: "s", prompt: "p", maxOutputTokens: 32 },
      { timeoutMs: 2_000 },
    );
    expect(httpResult.ok).toBe(false);
    if (!httpResult.ok) expect(httpResult.error.code).toBe("http_error");
    expect(httpCalls).toBe(1);

    server = await startFixtureServer({
      "/api/chat": {
        body: JSON.stringify({
          done: true,
          message: { role: "assistant", content: "{\"summary\":null,\"claims\":[]}" },
        }),
        contentType: "application/json",
        delayMs: 400,
      },
    });
    const timed = await new OllamaProvider().complete(
      config(server.url, { maxRetries: 1 }),
      { system: "s", prompt: "p", maxOutputTokens: 32 },
      { timeoutMs: 80 },
    );
    expect(timed.ok).toBe(false);
    if (!timed.ok) expect(timed.error.code).toBe("timeout");
    expect(server.hits.get("/api/chat")).toBe(1);
  });

  it("treats a missing chat model as model_unavailable and a truncated generation as unusable", async () => {
    server = await startFixtureServer({
      "/api/chat": { status: 404, body: JSON.stringify({ error: "model not found" }) },
    });

    const missing = await new OllamaProvider().complete(
      config(server.url),
      { system: "s", prompt: "p", maxOutputTokens: 32 },
      { timeoutMs: 2_000 },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("model_unavailable");

    await server.close();
    server = await startFixtureServer({
      "/api/chat": {
        body: JSON.stringify({
          done: false,
          message: { role: "assistant", content: "contact ada@evil.test immediately" },
        }),
        contentType: "application/json",
      },
    });

    const truncated = await new OllamaProvider().complete(
      config(server.url),
      { system: "s", prompt: "p", maxOutputTokens: 32 },
      { timeoutMs: 2_000 },
    );
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) expect(truncated.error.code).toBe("output_too_large");
    expect(JSON.stringify(truncated)).not.toContain("ada@evil.test");
  });

  it("rejects a chat envelope that is not JSON, and a completion that exceeds the output cap", async () => {
    server = await startFixtureServer({
      "/api/chat": { body: "sure thing", contentType: "text/plain" },
    });

    const malformed = await new OllamaProvider().complete(
      config(server.url),
      { system: "s", prompt: "p", maxOutputTokens: 32 },
      { timeoutMs: 2_000 },
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("malformed_response");

    await server.close();
    server = await startFixtureServer({
      "/api/chat": {
        body: JSON.stringify({
          done: true,
          message: { role: "assistant", content: "y".repeat(200) },
        }),
        contentType: "application/json",
      },
    });

    const huge = await new OllamaProvider().complete(
      config(server.url, { maxOutputChars: 64 }),
      { system: "s", prompt: "p", maxOutputTokens: 32 },
      { timeoutMs: 2_000 },
    );
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.error.code).toBe("output_too_large");
    expect(JSON.stringify(huge)).not.toContain("yyy");
  });

  it("does not contact an endpoint the guard rejected", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw new Error("should not be called");
    };
    const provider = new OllamaProvider({ fetchImpl });

    for (const endpoint of [
      "http://169.254.169.254/latest/meta-data/",
      "http://2852039166/",
      "http://user:s3cret@127.0.0.1:11434",
      "file:///etc/passwd",
      "http://127.0.0.1:11434/api/chat",
      "http://metadata.google.internal/",
    ]) {
      const result = await provider.probe(config(endpoint), {
        timeoutMs: 200,
        checkModel: true,
      });
      expect(result.reachable).toBe(false);
      expect(result.error?.code).toBe("endpoint_rejected");
      expect(JSON.stringify(result)).not.toContain("s3cret");
    }

    expect(calls).toBe(0);
  });
});

describe("operator endpoint guard", () => {
  it("allows a local Ollama host without widening the crawler guard", () => {
    expect(assessOperatorEndpoint("http://127.0.0.1:11434").ok).toBe(true);
    expect(assessOperatorEndpoint("http://localhost:11434").ok).toBe(true);
    expect(assessOperatorEndpoint("http://[::1]:11434").ok).toBe(true);
    expect(assessOperatorEndpoint("http://10.1.2.3:11434").ok).toBe(true);
    expect(assessOperatorEndpoint("https://ollama.example:11434").ok).toBe(true);

    expect(checkTarget("http://127.0.0.1:11434/").allowed).toBe(false);
    expect(checkTarget("http://10.1.2.3:11434/").allowed).toBe(false);
    expect(checkTarget("http://169.254.169.254/").allowed).toBe(false);
  });

  it("still refuses metadata, credentials, unexpected paths, and embedded loopback names", () => {
    const refused = [
      "http://169.254.169.254/",
      "http://2852039166/",
      "http://user:s3cret@127.0.0.1:11434",
      "file:///etc/passwd",
      "http://127.0.0.1:11434/api/chat",
      "http://127.0.0.1:11434/?next=http://169.254.169.254",
      "http://metadata.google.internal/",
      "http://127.0.0.1.nip.io:11434/",
      "http://foo.localhost:11434/",
    ];

    for (const url of refused) {
      const result = assessOperatorEndpoint(url);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).not.toContain("s3cret");
    }
  });
});
