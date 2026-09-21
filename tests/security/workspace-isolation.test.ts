import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

/**
 * Workspace isolation is enforced by `requireUser()` supplying the workspace id
 * to every query. The identity is mocked here (not the data access), so the
 * real `src/lib/crm` queries run against real SQL.
 */
const currentUser = vi.hoisted(() => ({
  value: null as null | { userId: string; workspaceId: string },
}));

vi.mock("@/lib/auth/require-user", () => ({
  requireUser: async () => {
    if (!currentUser.value) throw new Error("NOT_AUTHENTICATED");

    const workspace = await db.workspace.findUniqueOrThrow({
      where: { id: currentUser.value.workspaceId },
    });

    return {
      user: { id: currentUser.value.userId, workspaceId: workspace.id },
      userId: currentUser.value.userId,
      workspaceId: workspace.id,
      workspace,
    };
  },
}));

const { listLeads, getLead, updateLead, deleteLead } = await import("@/lib/crm/leads");

function actAs(session: SeededWorkspace) {
  currentUser.value = { userId: session.userId, workspaceId: session.workspaceId };
}

let alice: SeededWorkspace;
let bob: SeededWorkspace;
let aliceLeadId: string;

beforeAll(async () => {
  await resetTestDatabase();
});

beforeEach(async () => {
  await truncateAll();

  alice = await seedWorkspace("Alice");
  bob = await seedWorkspace("Bob");

  const lead = await db.lead.create({
    data: {
      workspaceId: alice.workspaceId,
      companyName: "Alice Client Ltd",
      status: "NEW",
    },
  });

  aliceLeadId = lead.id;
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("workspace isolation", () => {
  it("lists only the caller's own leads", async () => {
    actAs(alice);
    const own = await listLeads();
    expect(own.items.map((lead) => lead.id)).toEqual([aliceLeadId]);
    expect(own.total).toBe(1);

    actAs(bob);
    const other = await listLeads();
    expect(other.items).toHaveLength(0);
    expect(other.total).toBe(0);
  });

  it("does not return another workspace's lead by direct id", async () => {
    actAs(bob);

    // Bob knows the id but must still not be able to read the record.
    expect(await getLead(aliceLeadId)).toBeNull();
  });

  it("does not allow updating another workspace's lead", async () => {
    actAs(bob);

    // The service reports a safe "not found" (it must not reveal that the
    // record exists in someone else's workspace).
    await expect(
      updateLead(aliceLeadId, { companyName: "Hijacked" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const untouched = await db.lead.findUniqueOrThrow({ where: { id: aliceLeadId } });
    expect(untouched.companyName).toBe("Alice Client Ltd");
  });

  it("does not allow deleting another workspace's lead", async () => {
    actAs(bob);

    await expect(deleteLead(aliceLeadId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const untouched = await db.lead.findUniqueOrThrow({ where: { id: aliceLeadId } });
    expect(untouched.deletedAt).toBeNull();
  });

  it("ignores a browser-supplied workspaceId and uses the session's", async () => {
    actAs(bob);

    const { createLead } = await import("@/lib/crm/leads");

    // A hostile client tries to plant a record in Alice's workspace. The
    // input schema is strict, so the extra key is rejected outright rather
    // than silently ignored.
    await expect(
      createLead({
        companyName: "Injected Co",
        workspaceId: alice.workspaceId,
      }),
    ).rejects.toThrow();

    // Nothing was written anywhere.
    expect(
      await db.lead.count({ where: { companyName: "Injected Co" } }),
    ).toBe(0);

    // The same lead without the injected key lands in Bob's own workspace.
    const created = await createLead({ companyName: "Bob Client Co" });
    expect(created.workspaceId).toBe(bob.workspaceId);
    expect(created.workspaceId).not.toBe(alice.workspaceId);
  });

  it("scopes the owner's own access correctly", async () => {
    actAs(alice);

    const lead = await getLead(aliceLeadId);
    expect(lead?.id).toBe(aliceLeadId);
  });
});
