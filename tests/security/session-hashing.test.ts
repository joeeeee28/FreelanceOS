import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";

import { hashSessionToken, sessionTokenDigestsMatch } from "@/lib/auth/session-hash";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace } from "../helpers/fixtures";

beforeAll(async () => {
  await resetTestDatabase();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("session token hashing", () => {
  it("never stores the raw bearer token in the database", async () => {
    const session = await seedWorkspace("Alpha");

    const stored = await db.session.findUniqueOrThrow({
      where: { id: session.sessionId },
    });

    // The critical property: the persisted value is not the credential.
    expect(stored.tokenHash).not.toBe(session.rawToken);
    expect(stored.tokenHash).not.toContain(session.rawToken);

    // And it is specifically the SHA-256 digest of it.
    expect(stored.tokenHash).toBe(
      createHash("sha256").update(session.rawToken, "utf8").digest("hex"),
    );
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // A raw JWT has three dot-separated parts; the stored digest must not.
    expect(session.rawToken.split(".")).toHaveLength(3);
    expect(stored.tokenHash).not.toContain(".");
  });

  it("still authenticates the holder of the raw token", async () => {
    const session = await seedWorkspace("Beta");

    const found = await db.session.findUnique({
      where: { tokenHash: hashSessionToken(session.rawToken) },
      include: { user: true },
    });

    expect(found).not.toBeNull();
    expect(found?.userId).toBe(session.userId);
  });

  it("does not authenticate a token that was not issued", async () => {
    await seedWorkspace("Gamma");

    const forged = await db.session.findUnique({
      where: { tokenHash: hashSessionToken(`forged-${randomUUID()}`) },
    });

    expect(forged).toBeNull();
  });

  it("is deterministic and collision-distinct", () => {
    expect(hashSessionToken("token-a")).toBe(hashSessionToken("token-a"));
    expect(hashSessionToken("token-a")).not.toBe(hashSessionToken("token-b"));
  });

  it("compares digests safely", () => {
    const digest = hashSessionToken("value");

    expect(sessionTokenDigestsMatch(digest, digest)).toBe(true);
    expect(sessionTokenDigestsMatch(digest, hashSessionToken("other"))).toBe(false);
    // Length mismatch must not throw (timingSafeEqual would otherwise).
    expect(sessionTokenDigestsMatch(digest, "short")).toBe(false);
  });
});
