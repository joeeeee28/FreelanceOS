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

const {
  archiveLead,
  createLead,
  getLead,
  listLeads,
  moveLead,
  restoreLead,
  addLeadNote,
  updateLead,
  updateQualification,
} = await import("@/lib/crm/leads");

let alice: SeededWorkspace;
let bob: SeededWorkspace;

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
});

describe("lead creation", () => {
  it("creates a lead in the caller's workspace with a server-computed score", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    expect(lead.workspaceId).toBe(alice.workspaceId);
    expect(lead.status).toBe("NEW");
    expect(lead.score).toBe(0);
    expect(lead.deletedAt).toBeNull();
  });

  it("records a LEAD_CREATED activity", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    const activities = await db.activity.findMany({ where: { leadId: lead.id } });

    expect(activities).toHaveLength(1);
    expect(activities[0].type).toBe("LEAD_CREATED");
    expect(activities[0].workspaceId).toBe(alice.workspaceId);
    // Authorship is recorded on the activity (Lead itself has no author column).
    expect(activities[0].createdByUserId).toBe(alice.userId);
  });

  it("rejects a client-supplied score", async () => {
    await expect(
      createLead({ companyName: "Acme Studio", score: 99 }),
    ).rejects.toThrow();
  });

  it("rejects a client-supplied status", async () => {
    await expect(
      createLead({ companyName: "Acme Studio", status: "WON" }),
    ).rejects.toThrow();
  });
});

describe("lead updates", () => {
  it("updates editable fields and logs the change", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    const updated = await updateLead(lead.id, {
      companyName: "Acme Studio Ltd",
      city: "Chennai",
    });

    expect(updated.companyName).toBe("Acme Studio Ltd");
    expect(updated.city).toBe("Chennai");

    const types = (
      await db.activity.findMany({ where: { leadId: lead.id } })
    ).map((activity) => activity.type);

    expect(types).toContain("LEAD_UPDATED");
  });

  it("clears a field when null is supplied but leaves omitted fields alone", async () => {
    const lead = await createLead({
      companyName: "Acme Studio",
      city: "Chennai",
      industry: "Design",
    });

    const updated = await updateLead(lead.id, { city: null });

    expect(updated.city).toBeNull();
    expect(updated.industry).toBe("Design");
  });

  it("never lets the client set workspaceId", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    await expect(
      updateLead(lead.id, { workspaceId: bob.workspaceId }),
    ).rejects.toThrow();

    const reread = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(reread.workspaceId).toBe(alice.workspaceId);
  });
});

describe("lead archiving", () => {
  it("soft-deletes rather than removing the row", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    await archiveLead(lead.id);

    const reread = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(reread.deletedAt).not.toBeNull();
  });

  it("hides archived leads from the active list but can show them on request", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });
    await archiveLead(lead.id);

    expect((await listLeads()).items).toHaveLength(0);

    const archivedOnly = await listLeads({ onlyArchived: true });
    expect(archivedOnly.items.map((item) => item.id)).toEqual([lead.id]);
  });

  it("restores an archived lead", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });
    await archiveLead(lead.id);
    await restoreLead(lead.id);

    const reread = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(reread.deletedAt).toBeNull();
    expect((await listLeads()).items).toHaveLength(1);
  });

  it("logs archive and restore on the timeline", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });
    await archiveLead(lead.id);
    await restoreLead(lead.id);

    const titles = (
      await db.activity.findMany({
        where: { leadId: lead.id },
        orderBy: { createdAt: "asc" },
      })
    ).map((activity) => activity.title);

    expect(titles.some((title) => /archiv/i.test(title))).toBe(true);
    expect(titles.some((title) => /restor/i.test(title))).toBe(true);
  });
});

describe("lead notes", () => {
  it("adds a manual note as a NOTE_ADDED activity", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    await addLeadNote(lead.id, { body: "Spoke at a meetup." });

    const note = await db.activity.findFirst({
      where: { leadId: lead.id, type: "NOTE_ADDED" },
    });

    expect(note?.description).toBe("Spoke at a meetup.");
    expect(note?.createdByUserId).toBe(alice.userId);
  });

  it("rejects an empty note", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });
    await expect(addLeadNote(lead.id, { body: "   " })).rejects.toThrow();
  });
});

describe("workspace isolation for leads", () => {
  it("cannot read, update, archive or move another workspace's lead", async () => {
    const lead = await createLead({ companyName: "Alice Only" });

    actAs(bob);

    expect(await getLead(lead.id)).toBeNull();

    await expect(updateLead(lead.id, { city: "Nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(archiveLead(lead.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(moveLead(lead.id, "RESEARCHING")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      updateQualification(lead.id, { decisionMakerIdentified: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const untouched = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(untouched.companyName).toBe("Alice Only");
    expect(untouched.status).toBe("NEW");
    expect(untouched.deletedAt).toBeNull();
  });

  it("cannot add a note to another workspace's lead", async () => {
    const lead = await createLead({ companyName: "Alice Only" });

    actAs(bob);
    await expect(addLeadNote(lead.id, { body: "hi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    expect(await db.activity.count({ where: { leadId: lead.id, type: "NOTE_ADDED" } })).toBe(0);
  });
});
