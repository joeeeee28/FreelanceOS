import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Fetcher } from "@/lib/discovery/provider";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const { reviewCompanyPeople } = await import("@/lib/decision-makers/review");
const { storeDiscoveredPeople, personHistory } = await import("@/lib/decision-makers/store");

let alice: SeededWorkspace;
let bob: SeededWorkspace;

beforeAll(async () => {
  await resetTestDatabase();
}, 120_000);

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("Alice");
  bob = await seedWorkspace("Bob");
});

afterAll(async () => {
  await disconnectTestPrisma();
});

function pageFetcher(html: string, origin = "https://harbour.example.test"): Fetcher {
  return {
    async fetch(url: string) {
      if (url === origin || url === `${origin}/`) {
        return { url: origin, outcome: "SUCCESS", statusCode: 200, body: html };
      }
      return { url, outcome: "NOT_FOUND", statusCode: 404 };
    },
  };
}

async function company(
  workspaceId: string,
  website: string | null = "https://harbour.example.test",
  canonicalDomain: string | null = "harbour.example.test",
) {
  return db.company.create({
    data: {
      workspaceId,
      name: "Harbour Physio",
      canonicalName: "harbour physio",
      canonicalDomain,
      website,
    },
  });
}

const EMPLOYEE = `<script type="application/ld+json">${JSON.stringify({
  "@type": "Organization",
  name: "Harbour Physio",
  employee: { "@type": "Person", name: "Ada Lovelace", jobTitle: "Head of Marketing" },
})}</script>`;

describe("public people review", () => {
  it("stores a published employee and does not create a lead or CRM contact", async () => {
    const row = await company(alice.workspaceId);
    const review = await reviewCompanyPeople({
      workspaceId: alice.workspaceId,
      companyId: row.id,
      fetcher: pageFetcher(EMPLOYEE),
    });

    expect(review.outcome).toBe("stored");
    expect(await db.discoveredContact.count({ where: { companyId: row.id } })).toBe(1);
    expect(await db.contact.count()).toBe(0);
    expect(await db.lead.count()).toBe(0);
    const stored = await db.discoveredContact.findFirstOrThrow({ where: { companyId: row.id } });
    expect(stored.email).toBeNull();
    expect(stored.verification).toBe("PUBLISHED");
    expect(stored.isDecisionMaker).toBe(true);
  });

  it("does not store prose, and does not store a person from a blocked page", async () => {
    const row = await company(alice.workspaceId);
    const prose = await reviewCompanyPeople({
      workspaceId: alice.workspaceId,
      companyId: row.id,
      fetcher: pageFetcher("<p>Contact John at john.smith@company.com. John Smith — Head of Marketing — Harbour</p>"),
    });
    expect(prose.people).toBe(0);
    expect(await db.discoveredContact.count()).toBe(0);

    let reads = 0;
    const blocked = await reviewCompanyPeople({
      workspaceId: alice.workspaceId,
      companyId: row.id,
      fetcher: {
        async fetch(url: string) {
          reads += 1;
          return { url, outcome: "BLOCKED", statusCode: 403, body: EMPLOYEE };
        },
      },
    });
    expect(blocked.people).toBe(0);
    expect(reads).toBeGreaterThan(0);
    expect(await db.discoveredContact.count()).toBe(0);
  });

  it("refuses a metadata address without calling the fetcher", async () => {
    const row = await company(alice.workspaceId, "http://169.254.169.254/latest", null);
    let calls = 0;
    const review = await reviewCompanyPeople({
      workspaceId: alice.workspaceId,
      companyId: row.id,
      fetcher: {
        async fetch() {
          calls += 1;
          throw new Error("fetched");
        },
      },
    });
    expect(review.outcome).toBe("refused");
    expect(calls).toBe(0);
  });

  it("does not keep a cross-site response as this company's person", async () => {
    const row = await company(alice.workspaceId);
    const review = await reviewCompanyPeople({
      workspaceId: alice.workspaceId,
      companyId: row.id,
      fetcher: {
        async fetch() {
          return {
            url: "https://evil.example/team",
            outcome: "SUCCESS",
            statusCode: 200,
            body: EMPLOYEE,
          };
        },
      },
    });
    expect(review.people).toBe(0);
    expect(await db.discoveredContact.count()).toBe(0);
  });

  it("updates the same person, keeps an earlier title, and ignores another workspace", async () => {
    const row = await company(alice.workspaceId);
    const first = {
      fullName: "Ada Lovelace",
      canonicalName: "ada lovelace",
      jobTitle: "Marketing Manager",
      email: null,
      phone: null,
      linkedinUrl: null,
      method: "HTML_SELECTOR" as const,
      verification: "NAME_AND_ROLE" as const,
      sourceUrl: "https://harbour.example.test/about",
      evidence: "Ada Lovelace. Marketing Manager.",
    };
    await storeDiscoveredPeople({
      workspaceId: alice.workspaceId,
      companyId: row.id,
      people: [first],
      now: new Date("2026-03-01T00:00:00.000Z"),
    });
    await storeDiscoveredPeople({
      workspaceId: alice.workspaceId,
      companyId: row.id,
      people: [{ ...first, jobTitle: "Head of Marketing", evidence: "Ada Lovelace. Head of Marketing." }],
      now: new Date("2026-03-02T00:00:00.000Z"),
    });

    expect(await db.discoveredContact.count({ where: { companyId: row.id } })).toBe(1);
    const stored = await db.discoveredContact.findFirstOrThrow({ where: { companyId: row.id } });
    expect(stored.jobTitle).toBe("Head of Marketing");
    const history = await personHistory(alice.workspaceId, row.id, stored.id);
    expect(history.filter((item) => item.field === "person.jobTitle").map((item) => item.value)).toEqual([
      "Head of Marketing",
      "Marketing Manager",
    ]);
    expect(history.some((item) => item.current && item.value === "Marketing Manager")).toBe(false);

    const foreign = await reviewCompanyPeople({
      workspaceId: bob.workspaceId,
      companyId: row.id,
      fetcher: pageFetcher(EMPLOYEE),
    });
    expect(foreign.outcome).toBe("missing");
    expect(await db.discoveredContact.count({ where: { workspaceId: bob.workspaceId } })).toBe(0);
  });

  it("does not overwrite a stored email or revive a dismissed person", async () => {
    const row = await company(alice.workspaceId);
    const base = {
      fullName: "Ada Lovelace",
      canonicalName: "ada lovelace",
      jobTitle: "Founder",
      email: "ada@harbour.example.test",
      phone: null,
      linkedinUrl: null,
      method: "STRUCTURED_DATA" as const,
      verification: "PUBLISHED" as const,
      sourceUrl: "https://harbour.example.test",
      evidence: "Ada Lovelace. Founder.",
    };
    await storeDiscoveredPeople({ workspaceId: alice.workspaceId, companyId: row.id, people: [base] });
    await storeDiscoveredPeople({
      workspaceId: alice.workspaceId,
      companyId: row.id,
      people: [{ ...base, email: "other@harbour.example.test", method: "HTML_SELECTOR", verification: "CONTACTABLE" }],
    });
    const stored = await db.discoveredContact.findFirstOrThrow({ where: { companyId: row.id } });
    expect(stored.email).toBe("ada@harbour.example.test");

    await db.discoveredContact.update({ where: { id: stored.id }, data: { dismissedAt: new Date() } });
    const again = await storeDiscoveredPeople({
      workspaceId: alice.workspaceId,
      companyId: row.id,
      people: [{ ...base, jobTitle: "Owner" }],
    });
    expect(again.skippedDismissed).toBe(1);
    expect((await db.discoveredContact.findFirstOrThrow({ where: { id: stored.id } })).jobTitle).toBe("Founder");
    expect((await db.discoveredContact.findFirstOrThrow({ where: { id: stored.id } })).dismissedAt).not.toBeNull();
  });
});
