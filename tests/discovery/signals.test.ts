import { describe, expect, it } from "vitest";

import {
  detectSignals,
  SIGNAL_RULES,
  STALE_COPYRIGHT_YEARS,
  type CompanyFacts,
} from "@/lib/discovery/signals/rules";
import {
  explainOpportunity,
  mapSignalsToOpportunities,
  MAPPING_RULES,
  MIN_SIGNAL_CONFIDENCE,
} from "@/lib/discovery/signals/opportunities";
import { isServiceKey } from "@/lib/taxonomy/services";

const NOW = new Date("2026-09-22T00:00:00Z");

function facts(overrides: Partial<CompanyFacts> = {}): CompanyFacts {
  return {
    companyId: "c1",
    name: "Acme Dental",
    website: null,
    email: null,
    phone: null,
    instagramUrl: null,
    facebookUrl: null,
    linkedinUrl: null,
    youtubeUrl: null,
    industry: null,
    companySize: null,
    ...overrides,
  };
}

describe("signal detection", () => {
  describe("restraint", () => {
    it("finds nothing in an empty record", () => {
      // An empty company is an empty company, not a business without a website.
      expect(detectSignals(facts(), NOW)).toEqual([]);
    });

    it("does not claim a missing website for an uncontactable record", () => {
      const signals = detectSignals(facts({ website: null }), NOW);

      expect(signals.find((s) => s.type === "WEBSITE_MISSING")).toBeUndefined();
    });

    it("treats an unknown page property as unknown, not false", () => {
      // hasViewportMeta is absent, not false. Absent must never fire a rule.
      const signals = detectSignals(
        facts({ website: "https://acme.test", pageSignals: { reachable: true } }),
        NOW,
      );

      const quality = signals.filter((s) => s.type === "WEBSITE_QUALITY_ISSUE");
      expect(quality).toHaveLength(0);
    });

    it("does not claim absent social media without reading the site", () => {
      const signals = detectSignals(facts({ email: "a@b.test" }), NOW);

      // Not finding links on a page we never fetched proves nothing.
      expect(signals.find((s) => s.type === "SOCIAL_MEDIA_ABSENT")).toBeUndefined();
    });

    it("ignores a copyright year in the future", () => {
      const signals = detectSignals(
        facts({
          website: "https://acme.test",
          pageSignals: { reachable: true, copyrightYear: 2099 },
        }),
        NOW,
      );

      expect(signals.find((s) => s.type === "WEBSITE_OUTDATED")).toBeUndefined();
    });
  });

  it("detects a contactable business with no website", () => {
    const signals = detectSignals(facts({ phone: "+441234567890" }), NOW);
    const signal = signals.find((s) => s.type === "WEBSITE_MISSING");

    expect(signal).toBeDefined();
    expect(signal?.evidence).toContain("No website");
  });

  it("detects a site with no mobile viewport", () => {
    const signals = detectSignals(
      facts({
        website: "https://acme.test",
        pageSignals: { reachable: true, hasViewportMeta: false },
      }),
      NOW,
    );

    const signal = signals.find((s) => s.type === "WEBSITE_QUALITY_ISSUE");
    expect(signal?.metadata).toMatchObject({ issue: "NO_VIEWPORT" });
  });

  it("prefers the strongest issue when several apply to one type", () => {
    const signals = detectSignals(
      facts({
        website: "http://acme.test",
        pageSignals: {
          reachable: true,
          hasViewportMeta: false,
          isHttps: false,
          sizeBytes: 500,
        },
      }),
      NOW,
    );

    const quality = signals.filter((s) => s.type === "WEBSITE_QUALITY_ISSUE");

    // One signal per type: five variations on "the site is bad" is noise.
    expect(quality).toHaveLength(1);
    expect(quality[0].metadata).toMatchObject({ issue: "NO_HTTPS" });
  });

  it("detects a stale copyright year", () => {
    const year = NOW.getUTCFullYear() - STALE_COPYRIGHT_YEARS;
    const signals = detectSignals(
      facts({
        website: "https://acme.test",
        pageSignals: { reachable: true, copyrightYear: year },
      }),
      NOW,
    );

    const signal = signals.find((s) => s.type === "WEBSITE_OUTDATED");
    expect(signal).toBeDefined();
    expect(signal?.summary).toContain(String(year));
  });

  it("does not flag a recently updated site", () => {
    const signals = detectSignals(
      facts({
        website: "https://acme.test",
        pageSignals: { reachable: true, copyrightYear: NOW.getUTCFullYear() },
      }),
      NOW,
    );

    expect(signals.find((s) => s.type === "WEBSITE_OUTDATED")).toBeUndefined();
  });

  it("treats a public vacancy as the strongest signal available", () => {
    const signals = detectSignals(facts({ hiringAreas: ["MARKETING"] }), NOW);
    const hiring = signals.find((s) => s.type === "MARKETING_JOB");

    expect(hiring).toBeDefined();
    expect(hiring?.confidence).toBeGreaterThanOrEqual(80);
  });

  it("reports social profiles as present without claiming they are active", () => {
    const signals = detectSignals(
      facts({ instagramUrl: "https://instagram.com/acme" }),
      NOW,
    );

    const signal = signals.find((s) => s.type === "SOCIAL_MEDIA_ACTIVITY");
    expect(signal).toBeDefined();
    // A profile existing says nothing about whether anyone posts to it.
    expect(signal?.evidence).toContain("Public profiles discovered");
  });

  it("returns signals strongest first", () => {
    const signals = detectSignals(
      facts({
        phone: "+441234567890",
        hiringAreas: ["MARKETING"],
        instagramUrl: "https://instagram.com/acme",
      }),
      NOW,
    );

    const confidences = signals.map((s) => s.confidence);
    expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
  });

  it("gives every signal evidence", () => {
    const signals = detectSignals(
      facts({
        website: "http://acme.test",
        phone: "+44123",
        hiringAreas: ["CONTENT"],
        pageSignals: {
          reachable: true,
          isHttps: false,
          hasBlog: false,
          hasTrackingPixel: true,
        },
      }),
      NOW,
    );

    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal.evidence.length).toBeGreaterThan(10);
      expect(signal.confidence).toBeGreaterThan(0);
      expect(signal.confidence).toBeLessThanOrEqual(100);
    }
  });

  it("survives a rule that throws", () => {
    // A getter that throws, standing in for a malformed record. Defined on the
    // final object rather than via the helper, so it fires inside detection
    // rather than while the fixture is being built.
    const hostile = facts({ website: "https://acme.test", phone: "+44123" });
    Object.defineProperty(hostile, "hiringAreas", {
      get() {
        throw new Error("corrupt");
      },
    });

    expect(() => detectSignals(hostile, NOW)).not.toThrow();

    // The broken rule is skipped; every other rule still gets its turn.
    const signals = detectSignals(hostile, NOW);
    expect(signals.every((s) => s.type !== "MARKETING_JOB")).toBe(true);
  });

  it("uses a unique key per rule", () => {
    const keys = SIGNAL_RULES.map((rule) => rule.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("opportunity mapping", () => {
  it("maps a missing website to website creation", () => {
    const opportunities = mapSignalsToOpportunities([
      { type: "WEBSITE_MISSING", confidence: 70 },
    ]);

    const creation = opportunities.find((o) => o.serviceKey === "WEBSITE_CREATION");
    expect(creation).toBeDefined();
    expect(creation?.recommendedAction).toContain("first website");
  });

  it("scales a rule's points by the confidence of its signal", () => {
    const confident = mapSignalsToOpportunities([
      { type: "WEBSITE_MISSING", confidence: 100 },
    ]);
    const shaky = mapSignalsToOpportunities([
      { type: "WEBSITE_MISSING", confidence: 50 },
    ]);

    const a = confident.find((o) => o.serviceKey === "WEBSITE_CREATION")?.score ?? 0;
    const b = shaky.find((o) => o.serviceKey === "WEBSITE_CREATION")?.score ?? 0;

    // A shaky observation must not produce a confident recommendation.
    expect(a).toBeGreaterThan(b);
  });

  it("ignores signals below the confidence floor", () => {
    expect(
      mapSignalsToOpportunities([
        { type: "WEBSITE_MISSING", confidence: MIN_SIGNAL_CONFIDENCE - 1 },
      ]),
    ).toEqual([]);
  });

  it("accumulates several signals into one service", () => {
    const one = mapSignalsToOpportunities([
      { type: "WEBSITE_OUTDATED", confidence: 100 },
    ]);
    const two = mapSignalsToOpportunities([
      { type: "WEBSITE_OUTDATED", confidence: 100 },
      { type: "WEBSITE_QUALITY_ISSUE", confidence: 100 },
    ]);

    const a = one.find((o) => o.serviceKey === "WEBSITE_REDESIGN")?.score ?? 0;
    const b = two.find((o) => o.serviceKey === "WEBSITE_REDESIGN")?.score ?? 0;

    expect(b).toBeGreaterThan(a);
  });

  it("never exceeds 100", () => {
    const opportunities = mapSignalsToOpportunities([
      { type: "WEBSITE_MISSING", confidence: 100 },
      { type: "WEBSITE_OUTDATED", confidence: 100 },
      { type: "WEBSITE_QUALITY_ISSUE", confidence: 100 },
      { type: "MARKETING_JOB", confidence: 100 },
      { type: "SOCIAL_MEDIA_ABSENT", confidence: 100 },
      { type: "ADVERTISING_ACTIVITY", confidence: 100 },
    ]);

    for (const opportunity of opportunities) {
      expect(opportunity.score).toBeLessThanOrEqual(100);
      expect(opportunity.score).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns nothing for no signals", () => {
    expect(mapSignalsToOpportunities([])).toEqual([]);
  });

  it("drops opportunities too weak to be worth showing", () => {
    const opportunities = mapSignalsToOpportunities(
      [{ type: "SOCIAL_MEDIA_ACTIVITY", confidence: 45 }],
      { minScore: 90 },
    );

    expect(opportunities).toEqual([]);
  });

  it("orders strongest first and breaks ties stably", () => {
    const first = mapSignalsToOpportunities([
      { type: "MARKETING_JOB", confidence: 85 },
      { type: "WEBSITE_MISSING", confidence: 70 },
    ]);
    const second = mapSignalsToOpportunities([
      { type: "WEBSITE_MISSING", confidence: 70 },
      { type: "MARKETING_JOB", confidence: 85 },
    ]);

    expect(first.map((o) => o.serviceKey)).toEqual(second.map((o) => o.serviceKey));

    const scores = first.map((o) => o.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  describe("explainability", () => {
    it("attributes every point to a named rule", () => {
      const [opportunity] = mapSignalsToOpportunities([
        { type: "WEBSITE_MISSING", confidence: 100 },
      ]);

      const total = opportunity.rationale.reduce((sum, line) => sum + line.points, 0);

      // The score is the arithmetic, not a separate opinion about it.
      expect(total).toBe(opportunity.score);
      for (const line of opportunity.rationale) {
        expect(line.ruleKey).toBeTruthy();
        expect(line.reason.length).toBeGreaterThan(5);
      }
    });

    it("carries evidence and source through to the rationale", () => {
      const [opportunity] = mapSignalsToOpportunities([
        {
          type: "WEBSITE_OUTDATED",
          confidence: 80,
          evidence: "Footer says 2019.",
          sourceUrl: "https://acme.test",
        },
      ]);

      expect(opportunity.rationale[0].evidence).toBe("Footer says 2019.");
      expect(opportunity.rationale[0].sourceUrl).toBe("https://acme.test");
    });

    it("renders a human-readable explanation", () => {
      const [opportunity] = mapSignalsToOpportunities([
        { type: "MARKETING_JOB", confidence: 85 },
      ]);

      const lines = explainOpportunity(opportunity);

      expect(lines[0]).toContain("/100");
      expect(lines.slice(1).every((line) => line.startsWith("+"))).toBe(true);
    });
  });

  describe("the mapping table", () => {
    it("references only real services", () => {
      for (const rule of MAPPING_RULES) {
        expect(isServiceKey(rule.serviceKey)).toBe(true);
      }
    });

    it("uses unique rule keys", () => {
      const keys = MAPPING_RULES.map((rule) => rule.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("gives every rule a reason and an action", () => {
      for (const rule of MAPPING_RULES) {
        expect(rule.reason.length).toBeGreaterThan(10);
        expect(rule.action.length).toBeGreaterThan(5);
        expect(rule.weight).toBeGreaterThan(0);
      }
    });
  });

  it("works end to end from facts to opportunities", () => {
    const signals = detectSignals(
      facts({
        website: "http://acme.test",
        phone: "+441234567890",
        hiringAreas: ["SOCIAL_MEDIA"],
        pageSignals: { reachable: true, isHttps: false, hasBlog: false },
      }),
      NOW,
    );

    const opportunities = mapSignalsToOpportunities(signals);

    expect(opportunities.length).toBeGreaterThan(0);
    expect(opportunities[0].rationale.length).toBeGreaterThan(0);
    // Every recommendation traces back to a signal that traces to evidence.
    for (const opportunity of opportunities) {
      for (const line of opportunity.rationale) {
        expect(signals.some((s) => s.type === line.signal)).toBe(true);
      }
    }
  });
});
