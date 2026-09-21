import { describe, expect, it } from "vitest";

import {
  isAutoMergeStrategy,
  isFreeEmailDomain,
  MATCH_STRATEGIES,
  resolutionKeys,
  resolveEntity,
  type ExistingEntity,
} from "@/lib/discovery/resolution";

const acme: ExistingEntity = {
  id: "co_acme",
  canonicalName: "acme dental",
  canonicalDomain: "acme-dental.com",
  email: "hello@acme-dental.com",
  phone: "+914445551201",
  country: "IN",
  city: "Chennai",
};

describe("resolutionKeys", () => {
  it("derives a domain from the website when none is given", () => {
    const keys = resolutionKeys({
      name: "Acme Dental Pvt. Ltd.",
      website: "https://www.Acme-Dental.com/contact",
    });

    expect(keys.canonicalDomain).toBe("acme-dental.com");
    expect(keys.canonicalName).toBe("acme dental");
  });

  it("splits the email domain out for provider checks", () => {
    const keys = resolutionKeys({ name: "Acme", email: "Hello@Acme-Dental.com" });

    expect(keys.canonicalEmail).toBe("hello@acme-dental.com");
    expect(keys.emailDomain).toBe("acme-dental.com");
  });

  it("leaves unknown fields null rather than guessing", () => {
    const keys = resolutionKeys({ name: "Acme" });

    expect(keys.canonicalDomain).toBeNull();
    expect(keys.canonicalEmail).toBeNull();
    expect(keys.canonicalPhone).toBeNull();
    expect(keys.country).toBeNull();
    expect(keys.city).toBeNull();
  });
});

describe("free email providers", () => {
  it("recognises shared providers", () => {
    expect(isFreeEmailDomain("gmail.com")).toBe(true);
    expect(isFreeEmailDomain("outlook.com")).toBe(true);
    expect(isFreeEmailDomain("acme-dental.com")).toBe(false);
    expect(isFreeEmailDomain(null)).toBe(false);
  });
});

describe("auto-merge policy", () => {
  it("only trusts domain and business email", () => {
    expect(isAutoMergeStrategy("CANONICAL_DOMAIN")).toBe(true);
    expect(isAutoMergeStrategy("VERIFIED_EMAIL")).toBe(true);
    expect(isAutoMergeStrategy("NAME_AND_LOCALITY")).toBe(false);
    expect(isAutoMergeStrategy("NAME_AND_PHONE")).toBe(false);
    expect(isAutoMergeStrategy("NAME_ONLY")).toBe(false);
  });

  /**
   * Guards the policy itself: if someone adds a new strategy they must make a
   * deliberate decision about whether it can merge without a human.
   */
  it("covers every declared strategy", () => {
    for (const strategy of MATCH_STRATEGIES) {
      expect(typeof isAutoMergeStrategy(strategy)).toBe("boolean");
    }
    expect(MATCH_STRATEGIES.filter(isAutoMergeStrategy)).toHaveLength(2);
  });
});

describe("resolveEntity", () => {
  it("matches on canonical domain regardless of URL formatting", () => {
    const outcome = resolveEntity(
      { name: "Totally Different Name", website: "http://acme-dental.com/x?utm_source=q" },
      [acme],
    );

    expect(outcome).toEqual({
      kind: "MATCH",
      entityId: "co_acme",
      strategy: "CANONICAL_DOMAIN",
    });
  });

  it("matches on a business email address", () => {
    const outcome = resolveEntity({ name: "Acme", email: "HELLO@acme-dental.com" }, [
      acme,
    ]);

    expect(outcome).toEqual({
      kind: "MATCH",
      entityId: "co_acme",
      strategy: "VERIFIED_EMAIL",
    });
  });

  it("never matches on a shared free email provider", () => {
    const gmailCo: ExistingEntity = {
      id: "co_a",
      canonicalName: "alpha studio",
      canonicalDomain: null,
      email: "shared@gmail.com",
    };

    const outcome = resolveEntity(
      { name: "Beta Studio", email: "shared@gmail.com" },
      [gmailCo],
    );

    // Two unrelated businesses using one Gmail address must stay separate.
    expect(outcome).toEqual({ kind: "NEW" });
  });

  it("returns NEW when nothing is known about the name", () => {
    const outcome = resolveEntity(
      { name: "Brand New Co", website: "https://brand-new.com" },
      [acme],
    );

    expect(outcome).toEqual({ kind: "NEW" });
  });

  it("refuses to store an identity with neither name nor domain", () => {
    const outcome = resolveEntity({ phone: "+914445551201" }, [acme]);

    expect(outcome.kind).toBe("INSUFFICIENT_EVIDENCE");
  });

  describe("name-based candidates are never merged automatically", () => {
    it("sends same name + same city to review", () => {
      const outcome = resolveEntity(
        { name: "Acme Dental", country: "IN", city: "Chennai" },
        [acme],
      );

      expect(outcome.kind).toBe("REVIEW");
      if (outcome.kind !== "REVIEW") throw new Error("unreachable");
      expect(outcome.strategy).toBe("NAME_AND_LOCALITY");
      expect(outcome.candidateIds).toEqual(["co_acme"]);
    });

    it("sends same name + same phone to review", () => {
      const outcome = resolveEntity(
        // Same number, differently formatted.
        { name: "Acme Dental", phone: "+91 44 4555 1201" },
        [{ ...acme, country: null, city: null }],
      );

      expect(outcome.kind).toBe("REVIEW");
      if (outcome.kind !== "REVIEW") throw new Error("unreachable");
      expect(outcome.strategy).toBe("NAME_AND_PHONE");
    });

    it("does not treat a local number as equal to an international one", () => {
      // "044 4555 1201" and "+914445551201" may well be the same line, but
      // proving it needs country inference, which canonicalPhone refuses to
      // do. The result must degrade to the weaker strategy, never to a match.
      const outcome = resolveEntity(
        { name: "Acme Dental", phone: "044 4555 1201" },
        [{ ...acme, country: null, city: null }],
      );

      expect(outcome.kind).toBe("REVIEW");
      if (outcome.kind !== "REVIEW") throw new Error("unreachable");
      expect(outcome.strategy).toBe("NAME_ONLY");
    });

    it("sends a bare name match to review", () => {
      const outcome = resolveEntity({ name: "Acme Dental" }, [
        { ...acme, canonicalDomain: null },
      ]);

      expect(outcome.kind).toBe("REVIEW");
      if (outcome.kind !== "REVIEW") throw new Error("unreachable");
      expect(outcome.strategy).toBe("NAME_ONLY");
    });

    it("never returns MATCH for any name-only strategy", () => {
      const nameOnlyCases = [
        { name: "Acme Dental" },
        { name: "Acme Dental", country: "IN", city: "Chennai" },
        { name: "Acme Dental", phone: "+914445551201" },
      ];

      for (const identity of nameOnlyCases) {
        const outcome = resolveEntity(identity, [{ ...acme, canonicalDomain: null }]);
        expect(outcome.kind).not.toBe("MATCH");
      }
    });
  });

  it("treats a different known domain as proof of a different business", () => {
    // Same name, but the known company is on another domain: two real
    // businesses that happen to share a name.
    const outcome = resolveEntity(
      { name: "Acme Dental", website: "https://acme-dental.co.uk" },
      [acme],
    );

    expect(outcome).toEqual({ kind: "NEW" });
  });

  it("flags an ambiguous email shared by several records", () => {
    const outcome = resolveEntity({ name: "Acme", email: "hello@acme-dental.com" }, [
      acme,
      { ...acme, id: "co_acme2", canonicalDomain: null },
    ]);

    expect(outcome.kind).toBe("REVIEW");
    if (outcome.kind !== "REVIEW") throw new Error("unreachable");
    expect(outcome.candidateIds).toHaveLength(2);
  });

  it("prefers the strongest identifier when several apply", () => {
    const weak: ExistingEntity = {
      id: "co_weak",
      canonicalName: "acme dental",
      canonicalDomain: null,
      city: "Chennai",
      country: "IN",
    };

    // Both could match; the domain holder must win.
    const outcome = resolveEntity(
      {
        name: "Acme Dental",
        website: "https://acme-dental.com",
        city: "Chennai",
        country: "IN",
      },
      [weak, acme],
    );

    expect(outcome).toEqual({
      kind: "MATCH",
      entityId: "co_acme",
      strategy: "CANONICAL_DOMAIN",
    });
  });

  it("is order-independent", () => {
    const candidates = [acme, { ...acme, id: "co_b", canonicalDomain: "other.com" }];

    const forward = resolveEntity({ name: "X", website: "https://acme-dental.com" }, candidates);
    const backward = resolveEntity(
      { name: "X", website: "https://acme-dental.com" },
      [...candidates].reverse(),
    );

    expect(forward).toEqual(backward);
  });

  it("handles an empty candidate set", () => {
    expect(resolveEntity({ name: "Acme", website: "https://acme.com" }, [])).toEqual({
      kind: "NEW",
    });
  });
});
