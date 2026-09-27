import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const { addDiscoveredPersonToCrm } = await import("@/lib/decision-makers/promote");

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

async function person(workspaceId: string) {
  const company = await db.company.create({
    data: {
      workspaceId,
      name: "Harbour",
      canonicalName: "harbour",
      canonicalDomain: `${workspaceId}.example.test`,
    },
  });
  return db.discoveredContact.create({
    data: {
      workspaceId,
      companyId: company.id,
      fullName: "Ada Lovelace",
      canonicalName: "ada lovelace",
      jobTitle: "Head of Marketing",
      email: "ada@harbour.example.test",
      phone: "+914412345678",
      verification: "NAME_AND_ROLE",
      confidence: 60,
      method: "HTML_SELECTOR",
      sourceUrl: "https://harbour.example.test/about",
      evidence: "Ada Lovelace. Head of Marketing.",
    },
  });
}

describe("add discovered person to CRM", () => {
  it("does not create a lead when none exists", async () => {
    const row = await person(alice.workspaceId);
    const result = await addDiscoveredPersonToCrm({
      workspaceId: alice.workspaceId,
      userId: alice.userId,
      discoveredContactId: row.id,
    });
    expect(result).toEqual({ ok: false, reason: "no_lead" });
    expect(await db.contact.count()).toBe(0);
    expect(await db.lead.count()).toBe(0);
  });

  it("creates one contact and does not duplicate it", async () => {
    const row = await person(alice.workspaceId);
    await db.lead.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: row.companyId,
        companyName: "Harbour",
        status: "NEW",
      },
    });

    const first = await addDiscoveredPersonToCrm({
      workspaceId: alice.workspaceId,
      userId: alice.userId,
      discoveredContactId: row.id,
    });
    const second = await addDiscoveredPersonToCrm({
      workspaceId: alice.workspaceId,
      userId: alice.userId,
      discoveredContactId: row.id,
    });

    expect(first.ok && first.kind).toBe("CREATED");
    expect(second.ok && second.kind).toBe("UNCHANGED");
    expect(await db.contact.count({ where: { workspaceId: alice.workspaceId } })).toBe(1);
    const contact = await db.contact.findFirstOrThrow();
    expect(contact.isDecisionMaker).toBe(false);
    expect(contact.email).toBe("ada@harbour.example.test");
  });

  it("does not overwrite a human email and cannot reach another workspace", async () => {
    const row = await person(alice.workspaceId);
    const lead = await db.lead.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: row.companyId,
        companyName: "Harbour",
        email: "owner@example.test",
      },
    });
    const existing = await db.contact.create({
      data: {
        workspaceId: alice.workspaceId,
        leadId: lead.id,
        fullName: "Ada Lovelace",
        email: "owner@example.test",
        jobTitle: "Owner",
      },
    });

    const filled = await addDiscoveredPersonToCrm({
      workspaceId: alice.workspaceId,
      userId: alice.userId,
      discoveredContactId: row.id,
    });
    expect(filled.ok && filled.kind).toBe("FILLED");
    const stored = await db.contact.findUniqueOrThrow({ where: { id: existing.id } });
    expect(stored.email).toBe("owner@example.test");
    expect(stored.jobTitle).toBe("Owner");
    expect(stored.phone).toBe("+914412345678");

    const crossed = await addDiscoveredPersonToCrm({
      workspaceId: bob.workspaceId,
      userId: bob.userId,
      discoveredContactId: row.id,
    });
    expect(crossed).toEqual({ ok: false, reason: "not_found" });
    expect(await db.contact.count({ where: { workspaceId: bob.workspaceId } })).toBe(0);
  });
});
