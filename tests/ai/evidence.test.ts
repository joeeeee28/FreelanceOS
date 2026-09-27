import { describe, expect, it } from "vitest";

import { AI_DEFAULTS } from "@/lib/ai/config";
import {
  claimValue,
  evidenceFromCompany,
  evidenceFromContact,
  evidenceFromLead,
  evidenceFromObservation,
  prepareEvidence,
  validateModelOutput,
  type EvidenceItemInput,
} from "@/lib/ai/evidence";

const limits = {
  maxEvidenceItems: AI_DEFAULTS.maxEvidenceItems,
  maxEvidenceItemChars: AI_DEFAULTS.maxEvidenceItemChars,
  maxClaims: AI_DEFAULTS.maxClaims,
};

function observation(extra: Partial<EvidenceItemInput> = {}): EvidenceItemInput {
  return {
    id: "obs_1",
    kind: "observation",
    field: "industry",
    value: "dental",
    text: "Acme Dental is a dental clinic.",
    sourceUrl: "https://acme.example/about",
    method: "MANUAL",
    observedAt: "2026-09-01T00:00:00.000Z",
    confidence: 90,
    ...extra,
  };
}

function claims(payload: unknown, items: EvidenceItemInput[] = [observation()]) {
  const prepared = prepareEvidence(items, limits);
  return {
    prepared,
    result: validateModelOutput(payload, prepared.items, limits),
  };
}

describe("evidence preparation", () => {
  it("maps present CRM fields and omits nulls", () => {
    expect(
      evidenceFromObservation({
        id: "obs_empty",
        field: "email",
        value: null,
        evidence: null,
      }),
    ).toBeNull();

    const noted = evidenceFromObservation({
      id: "obs_note",
      field: "website",
      value: null,
      evidence: "no website published",
      sourceUrl: "https://acme.example/",
      method: "TEXT_HEURISTIC",
      confidence: 40,
    });
    expect(noted?.text).toBe("no website published");
    expect(noted?.kind).toBe("observation");

    const lead = evidenceFromLead({
      id: "lead_1",
      companyName: "Acme Dental",
      email: null,
      phone: "   ",
      website: "https://acme.example",
    });
    expect(lead.map((item) => item.field)).toEqual(["companyName", "website"]);
    expect(lead.some((item) => item.field === "email")).toBe(false);

    expect(
      evidenceFromContact({ id: "c_1", fullName: "Ada Lovelace", email: null }).map(
        (item) => item.field,
      ),
    ).toEqual(["fullName"]);

    expect(
      evidenceFromCompany({ id: "co_1", name: "Acme Dental", email: null, industry: "dental" }).map(
        (item) => item.field,
      ),
    ).toEqual(["name", "industry"]);
  });

  it("omits duplicates, empty items, over-long items, and items past the cap", () => {
    const prepared = prepareEvidence(
      [
        observation({ id: "keep", sourceUrl: null }),
        observation({ id: "keep", value: "other", sourceUrl: null }),
        observation({ id: "blank", value: " ", text: "", sourceUrl: null }),
        observation({ id: "huge", text: "x".repeat(800), sourceUrl: null }),
        observation({ id: "second", value: "second fact", text: "second fact", sourceUrl: null }),
        observation({ id: "third", value: "third fact", text: "third fact", sourceUrl: null }),
        { id: "bad id", kind: "observation", text: "nope" },
        { id: "weird", kind: "rumor", text: "nope" },
      ],
      { maxEvidenceItems: 1, maxEvidenceItemChars: 500 },
    );

    // Both copies of a duplicate id are dropped: citing it would be ambiguous.
    expect(prepared.items.map((item) => item.id)).toEqual(["second"]);
    expect(prepared.omitted.map((item) => item.reason)).toEqual(
      expect.arrayContaining(["duplicate_id", "empty", "too_long", "invalid_kind", "over_limit"]),
    );
    expect(prepared.droppedInvalid).toBe(1);
    expect(JSON.stringify(prepared)).not.toContain("bad id");
  });
});

describe("evidence validation", () => {
  it("accepts a value copied from cited evidence and copies provenance from that evidence", () => {
    const { result } = claims({
      summary: null,
      claims: [
        {
          field: "industry",
          value: "dental",
          evidenceIds: ["obs_1"],
          unknown: false,
          sourceUrl: "https://evil.example",
          confidence: 100,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].value).toBe("dental");
    expect(result.accepted[0].trustedCrmFact).toBe(false);
    expect(result.accepted[0].provenance[0]).toMatchObject({
      id: "obs_1",
      sourceUrl: "https://acme.example/about",
      method: "MANUAL",
      confidence: 90,
    });
    expect(result.accepted[0].provenance[0].sourceUrl).not.toBe("https://evil.example");
    expect(claimValue(result.accepted, "industry")).toBe("dental");
    expect(claimValue(result.accepted, "email")).toBeNull();
  });

  it("rejects fabricated companies, people, emails, phones, websites, problems, opportunities, and statistics", () => {
    const items = [
      observation(),
      observation({
        id: "obs_person",
        field: "contactName",
        value: "Ada Lovelace",
        text: "Ada Lovelace",
      }),
      observation({
        id: "obs_company",
        field: "companyName",
        value: "Acme Dental",
        text: "Acme Dental",
      }),
    ];

    const fabricated: Array<{ field: string; value: string }> = [
      { field: "company", value: "Initech" },
      { field: "person", value: "Grace Hopper" },
      { field: "email", value: "ada@evil.test" },
      { field: "phone", value: "+1 555 010 0199" },
      { field: "website", value: "https://evil.example" },
      { field: "pain_point", value: "needs a new website" },
      { field: "opportunity", value: "Offer a website rebuild" },
      { field: "statistic", value: "40%" },
    ];

    for (const claim of fabricated) {
      const { result } = claims(
        {
          summary: null,
          claims: [{ ...claim, evidenceIds: ["obs_1"], unknown: false }],
        },
        items,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.accepted).toEqual([]);
      expect(result.rejected[0]?.reason).not.toBe("");
      expect(claimValue(result.accepted, claim.field)).toBeNull();
    }
  });

  it("does not accept a relationship stitched out of two separate facts", () => {
    const items = [
      observation({ id: "obs_person", field: "contactName", value: "Ada Lovelace", text: "Ada Lovelace" }),
      observation({ id: "obs_company", field: "companyName", value: "Acme Dental", text: "Acme Dental" }),
    ];

    const stitched = claims(
      {
        summary: null,
        claims: [
          {
            field: "relationship",
            value: "Ada Lovelace works at Acme Dental",
            evidenceIds: ["obs_person", "obs_company"],
            unknown: false,
          },
        ],
      },
      items,
    );
    expect(stitched.result.ok).toBe(true);
    if (!stitched.result.ok) return;
    expect(stitched.result.accepted).toEqual([]);
    expect(stitched.result.rejected[0]?.reason).toBe("ungrounded");

    const stated = claims(
      {
        summary: null,
        claims: [
          {
            field: "relationship",
            value: "Ada Lovelace works at Acme Dental",
            evidenceIds: ["obs_rel"],
            unknown: false,
          },
        ],
      },
      [
        observation({
          id: "obs_rel",
          field: "note",
          value: null,
          text: "Ada Lovelace works at Acme Dental",
        }),
      ],
    );
    expect(stated.result.ok).toBe(true);
    if (!stated.result.ok) return;
    expect(stated.result.accepted).toHaveLength(1);
    expect(stated.result.accepted[0].trustedCrmFact).toBe(false);
    expect(stated.result.accepted[0].provenance[0].id).toBe("obs_rel");
  });

  it("rejects unknown evidence ids, missing citations, and contradictory unknowns", () => {
    const missing = claims({
      summary: null,
      claims: [{ field: "industry", value: "dental", evidenceIds: [], unknown: false }],
    });
    expect(missing.result.ok).toBe(true);
    if (missing.result.ok) expect(missing.result.rejected[0]?.reason).toBe("missing_evidence");

    const unknownId = claims({
      summary: null,
      claims: [{ field: "industry", value: "dental", evidenceIds: ["obs_missing"], unknown: false }],
    });
    expect(unknownId.result.ok).toBe(true);
    if (unknownId.result.ok) expect(unknownId.result.rejected[0]?.reason).toBe("unknown_evidence");

    const explicit = claims({
      summary: null,
      claims: [{ field: "email", value: null, evidenceIds: [], unknown: true }],
    });
    expect(explicit.result.ok).toBe(true);
    if (explicit.result.ok) {
      expect(explicit.result.accepted).toEqual([]);
      expect(explicit.result.unknownFields).toEqual(["email"]);
      expect(claimValue(explicit.result.accepted, "email")).toBeNull();
    }

    const contradictory = claims({
      summary: null,
      claims: [{ field: "email", value: "ada@acme.example", evidenceIds: ["obs_1"], unknown: true }],
    });
    expect(contradictory.result.ok).toBe(true);
    if (contradictory.result.ok) {
      expect(contradictory.result.accepted).toEqual([]);
      expect(contradictory.result.rejected[0]?.reason).toBe("contradictory");
    }
  });

  it("rejects credentials even when the evidence contains them", () => {
    const { result } = claims(
      {
        summary: null,
        claims: [
          {
            field: "notes",
            value: "api_key=abcd1234",
            evidenceIds: ["obs_secret"],
            unknown: false,
          },
        ],
      },
      [
        observation({
          id: "obs_secret",
          field: "notes",
          value: "api_key=abcd1234",
          text: "api_key=abcd1234",
        }),
      ],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ reason: "credential", value: "[redacted]" });
    expect(JSON.stringify(result.rejected)).not.toContain("abcd1234");
  });

  it("keeps a summary only when it quotes evidence, and discards a paraphrase", () => {
    const quoted = claims({
      summary: "Acme Dental is a dental clinic.",
      claims: [],
    });
    expect(quoted.result.ok).toBe(true);
    if (quoted.result.ok) {
      expect(quoted.result.summary).toBe("Acme Dental is a dental clinic.");
      expect(quoted.result.summaryEvidenceIds).toEqual(["obs_1"]);
    }

    const paraphrased = claims({
      summary: "The company seems to need a new website and a larger team.",
      claims: [],
    });
    expect(paraphrased.result.ok).toBe(true);
    if (paraphrased.result.ok) {
      expect(paraphrased.result.summary).toBeNull();
      expect(paraphrased.result.summaryDiscarded).toBe(true);
    }
  });

  it("rejects a malformed envelope instead of salvaging claims from prose", () => {
    expect(validateModelOutput("the email is ada@evil.test", [], limits)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(validateModelOutput({ claims: "dental" }, [], limits)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("does not treat a short token inside a longer word as evidence", () => {
    const { result } = claims(
      {
        summary: null,
        claims: [{ field: "industry", value: "ai", evidenceIds: ["obs_email"], unknown: false }],
      },
      [observation({ id: "obs_email", field: "email", value: "ada@acme.example", text: "email ada@acme.example" })],
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accepted).toEqual([]);
  });

  it("does not invent a person, company, or website from an email address", () => {
    const emailOnly = [
      observation({
        id: "obs_email",
        field: "email",
        value: "ada@acme.example",
        text: "email ada@acme.example",
        sourceUrl: null,
      }),
    ];
    const invented = claims(
      {
        summary: null,
        claims: [
          { field: "person", value: "Ada", evidenceIds: ["obs_email"], unknown: false },
          { field: "company", value: "Acme", evidenceIds: ["obs_email"], unknown: false },
          { field: "website", value: "https://www.acme.example", evidenceIds: ["obs_email"], unknown: false },
          { field: "email", value: "ada@acme.example", evidenceIds: ["obs_email"], unknown: false },
        ],
      },
      emailOnly,
    );
    expect(invented.result.ok).toBe(true);
    if (!invented.result.ok) return;
    expect(invented.result.accepted.map((claim) => claim.field)).toEqual(["email"]);
    expect(invented.result.accepted[0].value).toBe("ada@acme.example");
    expect(invented.result.rejected.map((claim) => claim.field).sort()).toEqual([
      "company",
      "person",
      "website",
    ]);

    const stated = claims(
      {
        summary: null,
        claims: [
          { field: "person", value: "Ada Lovelace", evidenceIds: ["obs_named"], unknown: false },
          { field: "website", value: "https://acme.example", evidenceIds: ["obs_named"], unknown: false },
        ],
      },
      [
        observation({
          id: "obs_named",
          field: "notes",
          value: null,
          text: "Ada Lovelace, email ada@acme.example, site https://acme.example/about",
          sourceUrl: null,
        }),
      ],
    );
    expect(stated.result.ok).toBe(true);
    if (stated.result.ok) {
      expect(stated.result.accepted.map((claim) => claim.field).sort()).toEqual(["person", "website"]);
    }
  });

  it("accepts a website and a phone only when those exact values are in the cited item", () => {
    const items = [
      observation({
        id: "obs_web",
        field: "website",
        value: "https://acme.example/about",
        text: "https://acme.example/about",
        sourceUrl: "https://acme.example/about",
      }),
      observation({
        id: "obs_phone",
        field: "phone",
        value: "555-010-0100",
        text: "Call 555-010-0100",
      }),
    ];

    const accepted = claims(
      {
        summary: null,
        claims: [
          { field: "website", value: "https://www.acme.example", evidenceIds: ["obs_web"], unknown: false },
          { field: "phone", value: "(555) 010-0100", evidenceIds: ["obs_phone"], unknown: false },
        ],
      },
      items,
    );
    expect(accepted.result.ok).toBe(true);
    if (accepted.result.ok) {
      expect(accepted.result.accepted.map((claim) => claim.field).sort()).toEqual(["phone", "website"]);
    }

    const fragment = claims(
      {
        summary: null,
        claims: [{ field: "phone", value: "555-010", evidenceIds: ["obs_phone"], unknown: false }],
      },
      items,
    );
    expect(fragment.result.ok).toBe(true);
    if (fragment.result.ok) expect(fragment.result.accepted).toEqual([]);
  });
});
