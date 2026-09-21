import { describe, expect, it } from "vitest";
import type { LeadStatus } from "@prisma/client";

import { SCORE_WEIGHTS, scoreLead, type ScorableLead } from "@/lib/crm/scoring";
import { ALL_LEAD_STATUSES } from "@/lib/crm/pipeline";

/** A lead with no research done yet. */
function blank(overrides: Partial<ScorableLead> = {}): ScorableLead {
  return {
    status: "NEW",
    email: null,
    phone: null,
    linkedinUrl: null,
    industry: null,
    companySize: null,
    websitePresent: null,
    websiteQuality: null,
    advertisingActivity: null,
    contentActivity: null,
    serviceInterest: null,
    painPoint: null,
    qualificationNotes: null,
    decisionMakerIdentified: false,
    ...overrides,
  };
}

describe("scoreLead", () => {
  it("scores an empty lead at zero", () => {
    const result = scoreLead(blank());

    expect(result.score).toBe(0);
    expect(result.reasons).toHaveLength(0);
  });

  it("is deterministic: the same input always yields the same score", () => {
    const lead = blank({
      status: "QUALIFIED",
      decisionMakerIdentified: true,
      serviceInterest: "Website redesign",
      painPoint: "Losing leads from a slow site",
      email: "owner@example.test",
    });

    const runs = Array.from({ length: 10 }, () => scoreLead(lead).score);

    expect(new Set(runs).size).toBe(1);
  });

  it("stays within 0 and 100 even when every signal is maxed out", () => {
    const maxed = blank({
      status: "PROPOSAL",
      decisionMakerIdentified: true,
      serviceInterest: "Full rebrand",
      painPoint: "No online presence at all",
      websitePresent: false,
      advertisingActivity: "Meta and Google ads",
      contentActivity: "Weekly newsletter",
      qualificationNotes: "Budget approved for next quarter",
      email: "owner@example.test",
      phone: "+91 90000 00000",
      industry: "Hospitality",
      companySize: "11-50",
    });

    const result = scoreLead(maxed);

    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThan(0);
    // The raw total is allowed to exceed 100; the exposed score is clamped.
    expect(result.rawTotal).toBeGreaterThanOrEqual(result.score);
  });

  it("never returns a score below zero for any status", () => {
    for (const status of ALL_LEAD_STATUSES as LeadStatus[]) {
      const result = scoreLead(blank({ status }));
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  it("increases when qualifying information is added", () => {
    const before = scoreLead(blank()).score;

    const afterDecisionMaker = scoreLead(
      blank({ decisionMakerIdentified: true }),
    ).score;
    const afterServiceInterest = scoreLead(
      blank({ decisionMakerIdentified: true, serviceInterest: "SEO" }),
    ).score;
    const afterPainPoint = scoreLead(
      blank({
        decisionMakerIdentified: true,
        serviceInterest: "SEO",
        painPoint: "Invisible on search",
      }),
    ).score;

    expect(afterDecisionMaker).toBeGreaterThan(before);
    expect(afterServiceInterest).toBeGreaterThan(afterDecisionMaker);
    expect(afterPainPoint).toBeGreaterThan(afterServiceInterest);
  });

  it("rewards a missing website more than a weak one", () => {
    const absent = scoreLead(blank({ websitePresent: false })).score;
    const weak = scoreLead(
      blank({ websitePresent: true, websiteQuality: "Poor" }),
    ).score;
    const good = scoreLead(
      blank({ websitePresent: true, websiteQuality: "Excellent" }),
    ).score;

    expect(absent).toBeGreaterThan(weak);
    expect(weak).toBeGreaterThan(good);
  });

  it("explains every point it awards", () => {
    const result = scoreLead(
      blank({ decisionMakerIdentified: true, serviceInterest: "Landing page" }),
    );

    const explained = result.reasons.reduce(
      (total, reason) => total + reason.points,
      0,
    );

    expect(explained).toBe(result.rawTotal);
    expect(result.reasons.map((reason) => reason.code)).toContain("DECISION_MAKER");
  });

  it("ignores any score the caller tries to smuggle into the input", () => {
    const hostile = { ...blank(), score: 100 } as ScorableLead & { score: number };

    expect(scoreLead(hostile).score).toBe(0);
  });

  it("publishes stable, positive weights", () => {
    for (const [code, points] of Object.entries(SCORE_WEIGHTS)) {
      expect(points, code).toBeGreaterThan(0);
    }
  });
});
