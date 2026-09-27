import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { IDLE } from "@/lib/crm/action-result";
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
const { discoverBusinessesAction } = await import("@/app/(app)/find-clients/actions");

let alice: SeededWorkspace;

beforeAll(async () => {
  await resetTestDatabase();
}, 120_000);

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("Alice");
  currentUser.value = null;
});

afterAll(async () => {
  await disconnectTestPrisma();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("discover businesses action", () => {
  it("requires a session", async () => {
    await expect(discoverBusinessesAction(IDLE, form({ query: "dental clinic", location: "Chennai, India" }))).rejects.toThrow(
      "NOT_AUTHENTICATED",
    );
    expect(await db.job.count()).toBe(0);
  });

  it("queues only inside the signed-in workspace", async () => {
    actAs(alice);
    const result = await discoverBusinessesAction(
      IDLE,
      form({ query: "dental clinics", location: "Chennai, India", maxCompanies: "5", service: "WEBSITE_CREATION" }),
    );
    expect(result.status).toBe("success");
    expect(await db.source.count({ where: { workspaceId: alice.workspaceId, provider: "public-places" } })).toBe(1);
    expect(await db.company.count()).toBe(0);
    expect(await db.job.count({ where: { workspaceId: alice.workspaceId, type: "DISCOVERY_RUN" } })).toBe(1);
  });

  it("rejects an unsupported query before creating a job", async () => {
    actAs(alice);
    const result = await discoverBusinessesAction(IDLE, form({ query: "buy leads", location: "Chennai, India" }));
    expect(result.status).toBe("error");
    expect(await db.job.count()).toBe(0);
  });
});
