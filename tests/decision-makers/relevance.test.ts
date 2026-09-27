import { describe, expect, it } from "vitest";

import { personDisplayState, readRole } from "@/lib/decision-makers/relevance";

describe("role relevance", () => {
  it("maps a function title onto catalog services and not a mystery score", () => {
    const role = readRole("Head of Marketing");
    expect(role.category).toBe("marketing");
    expect(role.decisionMaker).toBe(true);
    expect(role.serviceKeys).toContain("META_ADS");
    expect(role.serviceKeys.every((key) => /^[A-Z0-9_]+$/.test(key))).toBe(true);
    expect(JSON.stringify(role)).not.toMatch(/score|probability/i);
  });

  it("does not treat a senior title alone as a decision maker", () => {
    expect(readRole("Director").decisionMaker).toBe(false);
    expect(readRole("Director").category).toBe("unknown");
    expect(readRole("CEO").decisionMaker).toBe(false);
    expect(readRole("CEO").category).toBe("leadership");
    expect(readRole("Managing Director").reasons.join(" ")).toMatch(/seniority alone/i);
  });

  it("treats founder as a function of the business", () => {
    expect(readRole("Founder").decisionMaker).toBe(true);
    expect(readRole(null).decisionMaker).toBe(false);
  });

  it("does not present a likely role as verified", () => {
    expect(
      personDisplayState({
        verification: "NAME_AND_ROLE",
        email: null,
        phone: null,
        linkedinUrl: null,
      }),
    ).toBe("LIKELY");
    expect(
      personDisplayState({
        verification: "PUBLISHED",
        email: null,
        phone: null,
        linkedinUrl: null,
      }),
    ).toBe("VERIFIED");
    expect(
      personDisplayState({
        verification: "UNVERIFIED",
        email: null,
        phone: null,
        linkedinUrl: null,
      }),
    ).toBe("NO_CONTACT_DATA");
  });
});
