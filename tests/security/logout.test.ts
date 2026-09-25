import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace } from "../helpers/fixtures";

const jar = vi.hoisted(() => ({
  value: undefined as string | undefined,
  set: [] as Array<{ name: string; value: string; options: Record<string, unknown> }>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "freelanceos_session" && jar.value !== undefined
        ? { name, value: jar.value }
        : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.set.push({ name, value, options });
      jar.value = value === "" ? undefined : value;
    },
  }),
}));

const { POST: logout } = await import("@/app/api/auth/logout/route");
const { getSessionUser } = await import("@/lib/auth/server");

beforeAll(async () => {
  await resetTestDatabase();
});

beforeEach(async () => {
  await truncateAll();
  jar.value = undefined;
  jar.set.length = 0;
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("logout", () => {
  it("deletes the session row and clears the cookie", async () => {
    const session = await seedWorkspace("Logout");
    jar.value = session.rawToken;

    // Authenticated before logging out.
    expect((await getSessionUser())?.id).toBe(session.userId);

    const response = await logout();
    expect(response.status).toBe(200);

    // The session is gone from the database.
    expect(await db.session.count()).toBe(0);

    // The cookie is expired immediately and stays HTTP-only.
    const cleared = jar.set.find((entry) => entry.name === "freelanceos_session");
    expect(cleared?.value).toBe("");
    expect(cleared?.options.maxAge).toBe(0);
    expect(cleared?.options.httpOnly).toBe(true);
  });

  it("makes the old token unusable afterwards", async () => {
    const session = await seedWorkspace("Replay");
    jar.value = session.rawToken;

    await logout();

    // An attacker replaying the captured cookie must be rejected, even though
    // the JWT itself is still unexpired and correctly signed.
    jar.value = session.rawToken;
    expect(await getSessionUser()).toBeNull();
  });

  it("does not affect other users' sessions", async () => {
    const first = await seedWorkspace("First");
    const second = await seedWorkspace("Second");

    jar.value = first.rawToken;
    await logout();

    expect(await db.session.count()).toBe(1);

    jar.value = second.rawToken;
    expect((await getSessionUser())?.id).toBe(second.userId);
  });

  it("succeeds without a cookie and still clears it", async () => {
    const response = await logout();

    expect(response.status).toBe(200);
    expect(jar.set.some((entry) => entry.value === "")).toBe(true);
  });
});
