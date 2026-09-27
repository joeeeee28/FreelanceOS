import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { actAsFactory, requireUserMock } from "../helpers/act-as";

const currentUser = vi.hoisted(() => ({
  value: null as null | { userId: string; workspaceId: string },
}));

vi.mock("@/lib/auth/require-user", () => requireUserMock(currentUser));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const actAs = actAsFactory(currentUser);
const { createLeadFromFindClients } = await import("@/app/(app)/find-clients/actions");

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

async function company(workspaceId: string, name: string, email: string | null = null) {
  return db.company.create({
    data: {
      workspaceId,
      name,
      canonicalName: name.toLowerCase(),
      canonicalDomain: `${name.toLowerCase()}.example.test`,
      email,
    },
  });
}

describe("Find Clients lead action", () => {
  it("creates one lead and does not create a second on repeat", async () => {
    actAs(alice);
    const row = await company(alice.workspaceId, "harbour", "clinic@example.test");

    const first = await createLeadFromFindClients(row.id);
    const second = await createLeadFromFindClients(row.id);

    expect(first.ok && first.outcome.kind).toBe("CREATED");
    expect(second.ok && (second.outcome.kind === "UPDATED" || second.outcome.kind === "UNCHANGED")).toBe(
      true,
    );
    expect(await db.lead.count({ where: { workspaceId: alice.workspaceId, companyId: row.id } })).toBe(1);
  });

  it("does not overwrite a human-filled email or touch another workspace", async () => {
    actAs(alice);
    const row = await company(alice.workspaceId, "kept", "crawler@example.test");
    const lead = await db.lead.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: row.id,
        companyName: "Kept",
        email: "owner@example.test",
        status: "QUALIFIED",
        score: 12,
      },
    });
    const foreign = await company(bob.workspaceId, "foreign");

    const updated = await createLeadFromFindClients(row.id);
    const crossed = await createLeadFromFindClients(foreign.id);
    const invalid = await createLeadFromFindClients("not-an-id");

    expect(updated.ok && (updated.outcome.kind === "UPDATED" || updated.outcome.kind === "UNCHANGED")).toBe(
      true,
    );
    const stored = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(stored.email).toBe("owner@example.test");
    expect(stored.status).toBe("QUALIFIED");
    expect(crossed.ok && crossed.outcome.kind).toBe("SKIPPED");
    expect(await db.lead.count({ where: { workspaceId: bob.workspaceId } })).toBe(0);
    expect(invalid).toEqual({ ok: false, reason: "invalid" });
    expect(await db.lead.count()).toBe(1);
  });
});
