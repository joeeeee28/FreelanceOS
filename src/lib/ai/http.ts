/**
 * Bounded HTTP for the AI provider.
 *
 * This is not a general client. It does not follow redirects, it does not
 * attach credentials, and it stops reading once the byte cap is crossed. A
 * truncated body is a failure, not a partial success: a cut-off JSON document
 * must not be interpreted as the model's answer.
 */

import { aiError, httpError, type AiError } from "./types";

export type BoundedHttpResult =
  | { ok: true; status: number; text: string; durationMs: number }
  | { ok: false; error: AiError; durationMs: number };

export interface BoundedRequest {
  url: string;
  method: "GET" | "POST";
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function elapsed(started: number): number {
  return Math.max(0, Date.now() - started);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function codeOf(value: unknown, depth = 0): string | null {
  if (value === null || typeof value !== "object" || depth > 4) return null;
  const code = (value as { code?: unknown }).code;
  if (typeof code === "string") return code;
  if (value instanceof AggregateError) {
    for (const inner of value.errors) {
      const nested = codeOf(inner, depth + 1);
      if (nested !== null) return nested;
    }
  }
  const cause = (value as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== value) return codeOf(cause, depth + 1);
  return null;
}

/**
 * Classifies a thrown fetch error without copying its message.
 *
 * Node includes the requested URL in `error.message`. That URL is operator
 * configuration, but a mis-set value can carry userinfo. The message is
 * discarded; only the error name and the cause code are consulted.
 */
function classifyThrown(error: unknown, why: "timeout" | "cancelled" | null): AiError {
  if (why === "cancelled") return aiError("cancelled");
  if (why === "timeout" || isAbortError(error)) return aiError("timeout");

  const code = codeOf(error);
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH"
  ) {
    return aiError("unreachable");
  }

  return aiError("unreachable");
}

function linkSignals(
  timeoutMs: number,
  parent?: AbortSignal,
): {
  signal: AbortSignal;
  dispose: () => void;
  reason: () => "timeout" | "cancelled" | null;
} {
  const controller = new AbortController();
  let why: "timeout" | "cancelled" | null = null;

  const onParent = () => {
    why = "cancelled";
    controller.abort();
  };

  if (parent?.aborted) {
    why = "cancelled";
    controller.abort();
  } else {
    parent?.addEventListener("abort", onParent, { once: true });
  }

  const timer = setTimeout(() => {
    if (why === null) why = "timeout";
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    reason: () => why,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: "too_large" | "unreadable" }> {
  const declared = response.headers.get("content-length");
  if (declared !== null && declared.trim() !== "") {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "unreadable" };
    }
    if (size > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
  }

  if (response.body === null) return { ok: true, text: "" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
}

/**
 * One request. Redirects are not followed: a 3xx is returned as a failure
 * without the `Location` header being requested or included in the error.
 */
export async function boundedRequest(request: BoundedRequest): Promise<BoundedHttpResult> {
  const started = Date.now();
  const fetchImpl = request.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    return { ok: false, error: aiError("unreachable"), durationMs: elapsed(started) };
  }

  if (request.timeoutMs <= 0) {
    return { ok: false, error: aiError("timeout"), durationMs: elapsed(started) };
  }

  const linked = linkSignals(request.timeoutMs, request.signal);

  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: {
        accept: "application/json",
        "user-agent": "FreelanceOS-AI/0.1",
        ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: request.body,
      redirect: "manual",
      signal: linked.signal,
    });

    const status = response.status;
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        error: aiError("redirect_refused", status),
        durationMs: elapsed(started),
      };
    }

    if (status < 200 || status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        error: httpError(status),
        durationMs: elapsed(started),
      };
    }

    const body = await readBounded(response, request.maxBytes);
    if (!body.ok) {
      return {
        ok: false,
        error: aiError(body.reason === "too_large" ? "response_too_large" : "malformed_response"),
        durationMs: elapsed(started),
      };
    }

    return { ok: true, status, text: body.text, durationMs: elapsed(started) };
  } catch (error) {
    return {
      ok: false,
      error: classifyThrown(error, linked.reason()),
      durationMs: elapsed(started),
    };
  } finally {
    linked.dispose();
  }
}
