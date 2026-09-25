import { describe, expect, it } from "vitest";

import {
  clampConfidence,
  confidenceFor,
  decidePrecedence,
  MAX_EVIDENCE_LENGTH,
  METHOD_CONFIDENCE,
  PROMOTION_THRESHOLD,
  sanitiseEvidence,
  type ExtractionMethod,
} from "@/lib/discovery/provenance";

const OLD = new Date("2026-01-01T00:00:00Z");
const NEW = new Date("2026-06-01T00:00:00Z");

describe("confidence scale", () => {
  it("ranks a human edit above every automated method", () => {
    const manual = confidenceFor("MANUAL");

    for (const [method, value] of Object.entries(METHOD_CONFIDENCE)) {
      if (method === "MANUAL") continue;
      expect(value).toBeLessThan(manual);
    }
  });

  it("ranks machine-readable sources above scraped markup above prose", () => {
    expect(confidenceFor("STRUCTURED_DATA")).toBeGreaterThan(
      confidenceFor("HTML_SELECTOR"),
    );
    expect(confidenceFor("HTML_SELECTOR")).toBeGreaterThan(
      confidenceFor("TEXT_HEURISTIC"),
    );
    expect(confidenceFor("TEXT_HEURISTIC")).toBeGreaterThan(
      confidenceFor("INFERRED"),
    );
  });

  it("keeps every value inside 0..100", () => {
    for (const value of Object.values(METHOD_CONFIDENCE)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("clamps hostile input", () => {
    expect(clampConfidence(-5)).toBe(0);
    expect(clampConfidence(1000)).toBe(100);
    expect(clampConfidence(Number.NaN)).toBe(0);
    expect(clampConfidence(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampConfidence(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(clampConfidence(61.9)).toBe(61);
  });
});

describe("decidePrecedence", () => {
  it("promotes when there is no existing value", () => {
    const decision = decidePrecedence(null, {
      confidence: confidenceFor("HTML_SELECTOR"),
      observedAt: OLD,
    });

    expect(decision).toEqual({ promote: true, reason: "NO_EXISTING_VALUE" });
  });

  it("promotes strictly higher confidence", () => {
    const decision = decidePrecedence(
      { confidence: 60, observedAt: NEW },
      { confidence: 90, observedAt: OLD },
    );

    expect(decision.promote).toBe(true);
  });

  it("refuses lower confidence even when much newer", () => {
    const decision = decidePrecedence(
      { confidence: 90, observedAt: OLD },
      { confidence: 60, observedAt: NEW },
    );

    expect(decision).toEqual({ promote: false, reason: "LOWER_CONFIDENCE" });
  });

  it("refreshes an equally trusted but stale value", () => {
    const decision = decidePrecedence(
      { confidence: 75, observedAt: OLD },
      { confidence: 75, observedAt: NEW },
    );

    expect(decision).toEqual({ promote: true, reason: "SAME_CONFIDENCE_NEWER" });
  });

  it("does not flap between equally trusted, equally aged sources", () => {
    const decision = decidePrecedence(
      { confidence: 75, observedAt: NEW },
      { confidence: 75, observedAt: NEW },
    );

    expect(decision).toEqual({
      promote: false,
      reason: "SAME_CONFIDENCE_NOT_NEWER",
    });
  });

  it("never promotes below the threshold, even with nothing held", () => {
    const decision = decidePrecedence(null, {
      confidence: PROMOTION_THRESHOLD - 1,
      observedAt: NEW,
    });

    expect(decision).toEqual({ promote: false, reason: "BELOW_THRESHOLD" });
  });

  /**
   * The headline guarantee: no automated extraction method can overwrite a
   * value a human entered. This is the spec's "never overwrite stronger
   * verified data with weaker data", asserted exhaustively rather than by
   * example.
   */
  it("protects a manual value from every automated method", () => {
    const humanEdit = { confidence: confidenceFor("MANUAL"), observedAt: OLD };

    const automated = (Object.keys(METHOD_CONFIDENCE) as ExtractionMethod[])
      .filter((method) => method !== "MANUAL");

    for (const method of automated) {
      const decision = decidePrecedence(humanEdit, {
        confidence: confidenceFor(method),
        // Even a sighting from the far future must not win.
        observedAt: new Date("2099-01-01T00:00:00Z"),
      });

      expect(
        decision.promote,
        `${method} must not overwrite a manual value`,
      ).toBe(false);
    }
  });

  it("lets a human always override a machine value", () => {
    const machine = { confidence: confidenceFor("STRUCTURED_DATA"), observedAt: NEW };

    const decision = decidePrecedence(machine, {
      confidence: confidenceFor("MANUAL"),
      observedAt: OLD,
    });

    expect(decision.promote).toBe(true);
  });

  it("is deterministic", () => {
    const held = { confidence: 70, observedAt: OLD };
    const incoming = { confidence: 70, observedAt: NEW };

    const first = decidePrecedence(held, incoming);
    const second = decidePrecedence(held, incoming);

    expect(first).toEqual(second);
  });
});

describe("sanitiseEvidence", () => {
  it("collapses whitespace and newlines", () => {
    expect(sanitiseEvidence("  hello \n\n  world \t ")).toBe("hello world");
  });

  it("strips control characters from untrusted crawler output", () => {
    expect(sanitiseEvidence("bad\u0000value\u001fhere")).toBe("bad value here");
  });

  it("truncates overlong excerpts", () => {
    const result = sanitiseEvidence("x".repeat(5000));

    expect(result).toHaveLength(MAX_EVIDENCE_LENGTH);
    expect(result.endsWith("…")).toBe(true);
  });

  it("leaves ordinary text untouched", () => {
    const text = "No website found at the advertised domain.";
    expect(sanitiseEvidence(text)).toBe(text);
  });
});
