import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { actAsFactory, requireUserMock } from "../helpers/act-as";
import { isCrmError } from "@/lib/crm/errors";
import { toActionError } from "@/lib/crm/action-result";

const currentUser = vi.hoisted(() => ({
  value: null as null | { userId: string; workspaceId: string },
}));

vi.mock("@/lib/auth/require-user", () => requireUserMock(currentUser));

const actAs = actAsFactory(currentUser);

const {
  archiveLead,
  addLeadNote,
  createLead,
  getLead,
  listLeads,
  moveLead,
  updateLead,
  updateQualification,
} = await import("@/lib/crm/leads");
const { createContact, updateContact } = await import("@/lib/crm/contacts");
const { createTask } = await import("@/lib/crm/tasks");
const { createFollowUp } = await import("@/lib/crm/follow-ups");
const { getDashboard } = await import("@/lib/crm/dashboard");

/**
 * End-to-end security regression against real database records.
 *
 * "User A" owns a fully populated lead; "User B" is a legitimate but separate
 * tenant who knows every id and tries to use them.
 */
let userA: SeededWorkspace;
let userB: SeededWorkspace;

let leadId: string;
let contactId: string;

beforeAll(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await truncateAll();

  userA = await seedWorkspace("UserA");
  userB = await seedWorkspace("UserB");

  actAs(userA);

  const lead = await createLead({ companyName: "Confidential Client" });
  leadId = lead.id;

  contactId = (
    await createContact({
      leadId,
      fullName: "Private Person",
      email: "private@example.test",
      isDecisionMaker: true,
    })
  ).id;

  actAs(userB);
});

describe("User B cannot read User A's data", () => {
  it("cannot fetch the lead by id", async () => {
    expect(await getLead(leadId)).toBeNull();
  });

  it("does not see it in any list", async () => {
    expect((await listLeads()).items).toHaveLength(0);
    expect((await listLeads({ search: "Confidential" })).total).toBe(0);
    expect((await listLeads({ includeArchived: true })).total).toBe(0);
    expect((await listLeads({ onlyArchived: true })).total).toBe(0);
  });

  it("does not see it in dashboard metrics", async () => {
    const dashboard = await getDashboard();

    expect(dashboard.metrics.totalLeads).toBe(0);
    expect(dashboard.actions).toEqual([]);
  });
});

describe("User B cannot modify User A's data", () => {
  it("cannot update the lead", async () => {
    await expect(updateLead(leadId, { companyName: "Stolen" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: leadId } })).companyName,
    ).toBe("Confidential Client");
  });

  it("cannot archive the lead", async () => {
    await expect(archiveLead(leadId)).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: leadId } })).deletedAt,
    ).toBeNull();
  });

  it("cannot move the lead through the pipeline", async () => {
    await expect(moveLead(leadId, "RESEARCHING")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    expect((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe(
      "NEW",
    );
  });

  it("cannot qualify the lead", async () => {
    await expect(
      updateQualification(leadId, { qualificationNotes: "injected" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: leadId } })).qualificationNotes,
    ).toBeNull();
  });

  it("cannot write to the lead's timeline", async () => {
    await expect(addLeadNote(leadId, { body: "injected" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("cannot edit the lead's contact", async () => {
    await expect(
      updateContact(contactId, { fullName: "Stolen Identity" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(
      (await db.contact.findUniqueOrThrow({ where: { id: contactId } })).fullName,
    ).toBe("Private Person");
  });
});

describe("User B cannot create records under User A's lead", () => {
  it("cannot attach a contact", async () => {
    await expect(
      createContact({ leadId, fullName: "Injected" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await db.contact.count({ where: { leadId } })).toBe(1);
  });

  it("cannot attach a task", async () => {
    await expect(
      createTask({ title: "Injected", leadId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await db.task.count({ where: { leadId } })).toBe(0);
  });

  it("cannot attach a task to User A's contact", async () => {
    await expect(
      createTask({ title: "Injected", contactId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await db.task.count({ where: { contactId } })).toBe(0);
  });

  it("cannot attach a follow-up", async () => {
    await expect(
      createFollowUp({
        leadId,
        channel: "EMAIL",
        sequence: "INITIAL",
        scheduledAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await db.followUp.count({ where: { leadId } })).toBe(0);
  });

  it("cannot write an activity onto User A's lead by any of these routes", async () => {
    expect(await db.activity.count({ where: { leadId, createdByUserId: userB.userId } })).toBe(
      0,
    );
  });
});

describe("score cannot be manipulated by the client", () => {
  it("rejects a score on create, update and qualification", async () => {
    actAs(userA);
    const lead = await createLead({ companyName: "Scoring Target" });

    await expect(
      createLead({ companyName: "Cheat", score: 100 }),
    ).rejects.toThrow();
    await expect(updateLead(lead.id, { score: 100 })).rejects.toThrow();
    await expect(updateQualification(lead.id, { score: 100 })).rejects.toThrow();

    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).score).toBe(0);
  });

  it("rejects an injected workspaceId instead of silently ignoring it", async () => {
    await expect(
      createLead({ companyName: "Planted", workspaceId: userA.workspaceId }),
    ).rejects.toThrow();

    expect(await db.lead.count({ where: { companyName: "Planted" } })).toBe(0);
  });
});

describe("error messages are safe", () => {
  it("does not reveal whether a record exists in another workspace", async () => {
    const realId = leadId;
    const fakeId = "clfakefakefakefakefakefake";

    const realError = await updateLead(realId, { city: "x" }).catch((error) => error);
    const fakeError = await updateLead(fakeId, { city: "x" }).catch((error) => error);

    expect(isCrmError(realError)).toBe(true);
    expect(isCrmError(fakeError)).toBe(true);
    expect(realError.message).toBe(fakeError.message);
    expect(realError.code).toBe(fakeError.code);
  });

  it("never leaks Prisma, SQL, stack or connection details to the client", async () => {
    const leaked = toActionError(
      new Error(
        "Invalid `prisma.lead.update()` invocation: connect ECONNREFUSED " +
          "postgresql://user:secret@10.0.0.1:5432/db",
      ),
      "updateLead",
    );

    expect(leaked.status).toBe("error");

    if (leaked.status === "error") {
      expect(leaked.message).not.toMatch(/prisma/i);
      expect(leaked.message).not.toMatch(/postgres/i);
      expect(leaked.message).not.toMatch(/secret/i);
      expect(leaked.message).not.toMatch(/10\.0\.0\.1/);
      expect(leaked.message).not.toMatch(/select|insert|update .* set/i);
    }
  });

  it("passes safe CRM messages through unchanged", async () => {
    const result = await updateLead(leadId, { city: "x" }).catch((error) =>
      toActionError(error, "updateLead"),
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Lead not found.");
    }
  });
});
