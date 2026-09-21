import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { actAsFactory, requireUserMock } from "../helpers/act-as";

const currentUser = vi.hoisted(() => ({
  value: null as null | { userId: string; workspaceId: string },
}));

vi.mock("@/lib/auth/require-user", () => requireUserMock(currentUser));

const actAs = actAsFactory(currentUser);

const { createContact, getContact, listContacts, updateContact } = await import(
  "@/lib/crm/contacts"
);
const { createLead, updateQualification } = await import("@/lib/crm/leads");

let alice: SeededWorkspace;
let bob: SeededWorkspace;
let aliceLeadId: string;

beforeAll(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("Alice");
  bob = await seedWorkspace("Bob");

  actAs(alice);
  aliceLeadId = (await createLead({ companyName: "Acme Studio" })).id;
});

describe("contact creation", () => {
  it("creates a contact inside the caller's workspace", async () => {
    const contact = await createContact({
      leadId: aliceLeadId,
      fullName: "Priya Raman",
      jobTitle: "Founder",
    });

    expect(contact.workspaceId).toBe(alice.workspaceId);
    expect(contact.leadId).toBe(aliceLeadId);
  });

  it("logs the new contact on the lead timeline", async () => {
    await createContact({ leadId: aliceLeadId, fullName: "Priya Raman" });

    const activity = await db.activity.findFirst({
      where: { leadId: aliceLeadId, type: "CONTACT_ADDED" },
    });

    expect(activity).not.toBeNull();
    expect(activity?.createdByUserId).toBe(alice.userId);
  });

  it("rejects a contact without a name", async () => {
    await expect(
      createContact({ leadId: aliceLeadId, fullName: "" }),
    ).rejects.toThrow();
  });
});

describe("contact updates", () => {
  it("updates editable fields", async () => {
    const contact = await createContact({
      leadId: aliceLeadId,
      fullName: "Priya Raman",
    });

    const updated = await updateContact(contact.id, {
      jobTitle: "Managing Director",
      email: "priya@example.test",
    });

    expect(updated.jobTitle).toBe("Managing Director");
    expect(updated.email).toBe("priya@example.test");
  });

  it("clears a field when null is supplied", async () => {
    const contact = await createContact({
      leadId: aliceLeadId,
      fullName: "Priya Raman",
      jobTitle: "Founder",
    });

    expect((await updateContact(contact.id, { jobTitle: null })).jobTitle).toBeNull();
  });
});

describe("primary contact", () => {
  it("keeps at most one primary contact per lead", async () => {
    const first = await createContact({
      leadId: aliceLeadId,
      fullName: "Priya Raman",
      isPrimary: true,
    });

    const second = await createContact({
      leadId: aliceLeadId,
      fullName: "Arun Kumar",
      isPrimary: true,
    });

    const primaries = await db.contact.findMany({
      where: { leadId: aliceLeadId, isPrimary: true },
    });

    expect(primaries.map((contact) => contact.id)).toEqual([second.id]);
    expect((await getContact(first.id))?.isPrimary).toBe(false);
  });

  it("demotes the old primary when another is promoted by update", async () => {
    const first = await createContact({
      leadId: aliceLeadId,
      fullName: "Priya Raman",
      isPrimary: true,
    });
    const second = await createContact({
      leadId: aliceLeadId,
      fullName: "Arun Kumar",
    });

    await updateContact(second.id, { isPrimary: true });

    expect((await getContact(first.id))?.isPrimary).toBe(false);
    expect((await getContact(second.id))?.isPrimary).toBe(true);
  });
});

describe("decision maker sync", () => {
  it("marks the lead as having an identified decision maker", async () => {
    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: aliceLeadId } }))
        .decisionMakerIdentified,
    ).toBe(false);

    await createContact({
      leadId: aliceLeadId,
      fullName: "Priya Raman",
      isDecisionMaker: true,
    });

    const lead = await db.lead.findUniqueOrThrow({ where: { id: aliceLeadId } });
    expect(lead.decisionMakerIdentified).toBe(true);
    expect(lead.score).toBeGreaterThan(0);
  });

  it("promotes the flag when an existing contact is marked as decision maker", async () => {
    const contact = await createContact({
      leadId: aliceLeadId,
      fullName: "Priya Raman",
    });

    await updateContact(contact.id, { isDecisionMaker: true });

    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: aliceLeadId } }))
        .decisionMakerIdentified,
    ).toBe(true);
  });

  it("does not silently undo a manual qualification assessment", async () => {
    await updateQualification(aliceLeadId, { decisionMakerIdentified: true });

    // Adding a non-decision-maker contact must not clear the manual judgement.
    await createContact({ leadId: aliceLeadId, fullName: "Receptionist" });

    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: aliceLeadId } }))
        .decisionMakerIdentified,
    ).toBe(true);
  });
});

describe("workspace isolation for contacts", () => {
  it("refuses to attach a contact to another workspace's lead", async () => {
    actAs(bob);

    await expect(
      createContact({ leadId: aliceLeadId, fullName: "Intruder" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await db.contact.count({ where: { leadId: aliceLeadId } })).toBe(0);
  });

  it("refuses to read or update another workspace's contact", async () => {
    const contact = await createContact({
      leadId: aliceLeadId,
      fullName: "Priya Raman",
    });

    actAs(bob);

    expect(await getContact(contact.id)).toBeNull();
    await expect(
      updateContact(contact.id, { fullName: "Hijacked" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const untouched = await db.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(untouched.fullName).toBe("Priya Raman");
  });

  it("lists only the caller's own contacts", async () => {
    await createContact({ leadId: aliceLeadId, fullName: "Priya Raman" });

    actAs(bob);
    const bobLead = await createLead({ companyName: "Bob Client" });
    await createContact({ leadId: bobLead.id, fullName: "Bob Contact" });

    const bobContacts = await listContacts();
    expect(bobContacts.items.map((contact) => contact.fullName)).toEqual(["Bob Contact"]);

    actAs(alice);
    const aliceContacts = await listContacts();
    expect(aliceContacts.items.map((contact) => contact.fullName)).toEqual(["Priya Raman"]);
  });
});
