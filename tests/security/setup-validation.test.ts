import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";

// The setup route sets a cookie; capture it instead of requiring a request scope.
const setCookies = vi.hoisted(() => [] as Array<{ name: string; value: string }>);

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string) => {
      setCookies.push({ name, value });
    },
  }),
}));

const { POST } = await import("@/app/api/setup/route");

const VALID_BODY = {
  name: "Test Owner",
  email: "owner@example.test",
  password: "Str0ng!Passphrase42",
  workspaceName: "Test Workspace",
  defaultCurrency: "INR",
  country: "India",
  timezone: "Asia/Kolkata",
};

function post(body: unknown, ip = "203.0.113.10") {
  return POST(
    new Request("http://127.0.0.1:3000/api/setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Unique per test so the rate limiter does not bleed across cases.
        "x-forwarded-for": ip,
      },
      body: JSON.stringify(body),
    }),
  );
}

let ipCounter = 0;
function uniqueIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

beforeAll(async () => {
  await resetTestDatabase();
});

beforeEach(async () => {
  await truncateAll();
  setCookies.length = 0;
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("setup validation", () => {
  it("rejects an unsupported currency with 400, not 500", async () => {
    const response = await post(
      { ...VALID_BODY, defaultCurrency: "XYZ" },
      uniqueIp(),
    );

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.fieldErrors.defaultCurrency).toBeDefined();
    expect(JSON.stringify(body)).not.toMatch(/UNSUPPORTED_CURRENCY|stack|prisma/i);
  });

  it("rejects an invalid timezone with 400, not 500", async () => {
    const response = await post(
      { ...VALID_BODY, timezone: "Mars/Olympus_Mons" },
      uniqueIp(),
    );

    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.fieldErrors.timezone).toBeDefined();
    expect(JSON.stringify(body)).not.toMatch(/INVALID_TIMEZONE|stack|RangeError/i);
  });

  it("rejects an invalid email with 400", async () => {
    const response = await post({ ...VALID_BODY, email: "not-an-email" }, uniqueIp());

    expect(response.status).toBe(400);
    expect((await response.json()).fieldErrors.email).toBeDefined();
  });

  it.each([
    ["too short", "Ab1!xyz"],
    ["no uppercase", "str0ng!passphrase"],
    ["no lowercase", "STR0NG!PASSPHRASE"],
    ["no number", "Strong!Passphrase"],
    ["no special character", "Str0ngPassphrase42"],
  ])("rejects a weak password (%s) with 400", async (_label, password) => {
    const response = await post({ ...VALID_BODY, password }, uniqueIp());

    expect(response.status).toBe(400);
    expect((await response.json()).fieldErrors.password).toBeDefined();
  });

  it("rejects an invalid workspace name with 400", async () => {
    const response = await post({ ...VALID_BODY, workspaceName: "A" }, uniqueIp());

    expect(response.status).toBe(400);
    expect((await response.json()).fieldErrors.workspaceName).toBeDefined();
  });

  it("rejects a malformed body with 400", async () => {
    const response = await POST(
      new Request("http://127.0.0.1:3000/api/setup", {
        method: "POST",
        headers: { "x-forwarded-for": uniqueIp() },
        body: "this is not json",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("does not create any records when validation fails", async () => {
    await post({ ...VALID_BODY, timezone: "Nowhere/Nothing" }, uniqueIp());

    expect(await db.workspace.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
    expect(await db.appInit.count()).toBe(0);
  });

  it("accepts valid input and stores only a hashed session token", async () => {
    const response = await post(VALID_BODY, uniqueIp());

    expect(response.status).toBe(200);

    const workspace = await db.workspace.findFirstOrThrow();
    expect(workspace.timezone).toBe("Asia/Kolkata");
    expect(workspace.defaultCurrency).toBe("INR");

    const cookie = setCookies.find((entry) => entry.name === "freelanceos_session");
    expect(cookie).toBeDefined();

    const session = await db.session.findFirstOrThrow();
    expect(session.tokenHash).not.toBe(cookie?.value);
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // The stored password must be a bcrypt hash, never the plaintext.
    const user = await db.user.findFirstOrThrow();
    expect(user.passwordHash).not.toBe(VALID_BODY.password);
    expect(user.passwordHash.startsWith("$2")).toBe(true);
  });

  it("returns 409 (not 500) when setup is attempted twice", async () => {
    expect((await post(VALID_BODY, uniqueIp())).status).toBe(200);

    const second = await post(
      { ...VALID_BODY, email: "second@example.test" },
      uniqueIp(),
    );

    expect(second.status).toBe(409);
    expect(await db.workspace.count()).toBe(1);
  });
});
