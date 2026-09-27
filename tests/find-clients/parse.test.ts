import { describe, expect, it } from "vitest";

import {
  emptyFilters,
  mergeFilters,
  parseNaturalLanguage,
  parsePage,
  parseStructuredFilters,
} from "@/lib/find-clients";

describe("Find Clients natural language", () => {
  it("turns the physiotherapy example into structured filters", () => {
    const parsed = parseNaturalLanguage(
      "Physiotherapy clinics in Chennai with website improvement opportunities.",
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters.industry).toBe("physiotherapy");
    expect(parsed.filters.location).toBe("chennai");
    expect(parsed.filters.serviceKey).toBe("WEBSITE_REDESIGN");
    expect(parsed.filters.serviceCategory).toBeNull();
  });

  it("treats an empty search as no extra filter", () => {
    expect(parseNaturalLanguage("   ")).toEqual({ ok: true, filters: emptyFilters() });
  });

  it("rejects unsupported searches instead of guessing", () => {
    for (const query of [
      "clinics in Chennai that need SEO",
      "find the decision maker in Chennai",
      "clinics with an email address",
      "clinics with revenue over 10",
      "write an email to clinics in Chennai",
    ]) {
      const parsed = parseNaturalLanguage(query);
      expect(parsed.ok, query).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason).toBe("unsupported");
      expect(parsed.unsupported.length).toBeGreaterThan(0);
    }
  });

  it("rejects unknown leftover words and invalid numbers", () => {
    const unknown = parseNaturalLanguage("clinics in Chennai web3");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe("unknown");

    const score = parseNaturalLanguage("clinics score over 101");
    expect(score.ok).toBe(false);
    if (!score.ok) expect(score.reason).toBe("invalid");
  });

  it("rejects two services rather than picking one", () => {
    const parsed = parseNaturalLanguage("website redesign and posters");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("contradictory");
  });

  it("does not turn the query into SQL or a URL", () => {
    const parsed = parseNaturalLanguage("Physiotherapy clinics in Chennai");
    expect(JSON.stringify(parsed)).not.toMatch(/select |insert |https?:/i);
  });
});

describe("Find Clients structured filters", () => {
  it("accepts a known catalog service and integer bounds", () => {
    const parsed = parseStructuredFilters({
      industry: "Physiotherapy",
      location: "Chennai",
      service: "WEBSITE_REDESIGN",
      signal: "WEBSITE_OUTDATED",
      minScore: "60",
      minConfidence: "70",
      website: "present",
      lead: "NONE",
      freshness: "fresh",
      source: "Directory",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters.serviceKey).toBe("WEBSITE_REDESIGN");
    expect(parsed.filters.location).toBe("chennai");
    expect(parsed.filters.minScore).toBe(60);
  });

  it("rejects wildcard characters, unknown services, and bad scores", () => {
    expect(parseStructuredFilters({ industry: "physio%" }).ok).toBe(false);
    expect(parseStructuredFilters({ location: "chennai_" }).ok).toBe(false);
    expect(parseStructuredFilters({ service: "SEO" }).ok).toBe(false);
    expect(parseStructuredFilters({ signal: "DECISION_MAKER" }).ok).toBe(false);
    expect(parseStructuredFilters({ minScore: "101" }).ok).toBe(false);
    expect(parseStructuredFilters({ minScore: "-1" }).ok).toBe(false);
    expect(parseStructuredFilters({ website: "maybe" }).ok).toBe(false);
    expect(parseStructuredFilters({ lead: "HOT" }).ok).toBe(false);
  });

  it("rejects a form and a sentence that disagree", () => {
    const form = parseStructuredFilters({ location: "Mumbai" });
    const natural = parseNaturalLanguage("clinics in Chennai");
    expect(form.ok && natural.ok).toBe(true);
    if (!form.ok || !natural.ok) return;
    const merged = mergeFilters(form.filters, natural.filters);
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.reason).toBe("contradictory");
  });

  it("rejects a page outside the cap", () => {
    const page = parsePage("41");
    expect(typeof page).not.toBe("number");
  });
});
