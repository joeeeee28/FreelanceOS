import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace } from "../helpers/fixtures";
import { hashSessionToken } from "@/lib/auth/session-hash";
import { signSessionToken } from "@/lib/auth/token";

/**
 * `getSessionUser()` reads the cookie via `next/headers`, which is only
 * available inside a request scope. The cookie jar is mocked so the real
 * authentication logic (JWT verification, hash lookup, expiry and workspace
 * checks) can be exercised end to end against the database.
 */
const cookieValue = vi.hoisted(() => ({ current: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "freelanceos_session" && cookieValue.current !== undefined
        ? { name, value: cookieValue.current }
        : undefined,
  }),
}));

const { getSessionUser } = await import("@/lib/auth/server");

beforeAll(async () => {
  await resetTestDatabase();
});

beforeEach(async () => {
  await truncateAll();
  cookieValue.current = undefined;
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("session validation", () => {
  it("authenticates a valid session", async () => {
    const session = await seedWorkspace("Valid");
    cookieValue.current = session.rawToken;

    const user = await getSessionUser();

    expect(user?.id).toBe(session.userId);
    expect(user?.workspaceId).toBe(session.workspaceId);
  });

  it("rejects a request with no cookie", async () => {
    await seedWorkspace("NoCookie");

    expect(await getSessionUser()).toBeNull();
  });

  it("rejects a malformed token", async () => {
    await seedWorkspace("Malformed");
    cookieValue.current = "not-a-jwt";

    expect(await getSessionUser()).toBeNull();
  });

  it("rejects a well-formed JWT signed with the wrong secret", async () => {
    const session = await seedWorkspace("WrongKey");

    // Same payload and algorithm, different signing key.
    const forged = await new SignJWT({
      sessionId: session.sessionId,
      userId: session.userId,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(
        new TextEncoder().encode(
          "a-completely-different-secret-value-0123456789",
        ),
      );

    cookieValue.current = forged;

    expect(await getSessionUser()).toBeNull();
  });

  it("rejects a session whose database row was deleted", async () => {
    const session = await seedWorkspace("Deleted");
    await db.session.delete({ where: { id: session.sessionId } });

    cookieValue.current = session.rawToken;

    expect(await getSessionUser()).toBeNull();
  });

  it("rejects an expired session", async () => {
    const session = await seedWorkspace("Expired", {
      expiresAt: new Date(Date.now() - 60_000),
    });

    cookieValue.current = session.rawToken;

    expect(await getSessionUser()).toBeNull();
  });

  it("rejects a token whose stored hash no longer matches", async () => {
    const session = await seedWorkspace("Rotated");

    // Simulates the stored digest being replaced (e.g. token rotation): the
    // old raw token must stop working immediately.
    await db.session.update({
      where: { id: session.sessionId },
      data: { tokenHash: hashSessionToken(`rotated-${randomUUID()}`) },
    });

    cookieValue.current = session.rawToken;

    expect(await getSessionUser()).toBeNull();
  });

  it("rejects a token whose userId does not match the session row", async () => {
    const owner = await seedWorkspace("Owner");
    const other = await seedWorkspace("Other");

    // A validly signed token that claims a different user for a real session.
    const mismatched = await signSessionToken({
      sessionId: owner.sessionId,
      userId: other.userId,
    });

    // Store the digest so only the userId check can reject it.
    await db.session.update({
      where: { id: owner.sessionId },
      data: { tokenHash: hashSessionToken(mismatched) },
    });

    cookieValue.current = mismatched;

    expect(await getSessionUser()).toBeNull();
  });
});
