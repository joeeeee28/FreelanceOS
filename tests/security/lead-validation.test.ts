import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

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

// `redirect()` throws a control-flow error in Next.js. It is replaced with a
// recognisable throw so the action's success path can be asserted.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const { createLeadAction } = await import("@/app/(app)/leads/new/actions");

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    data.set(key, value);
  }
  return data;
}

let session: SeededWorkspace;

beforeAll(async () => {
  await resetTestDatabase();
});

beforeEach(async () => {
  await truncateAll();
  session = await seedWorkspace("Lead");
  currentUser.value = { userId: session.userId, workspaceId: session.workspaceId };
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("lead form validation", () => {
  it("returns a structured field error for an invalid website URL", async () => {
    const result = await createLeadAction(
      { status: "idle" },
      form({ companyName: "Acme Ltd", website: "not a url" }),
    );

    expect(result.status).toBe("error");

    if (result.status !== "error") throw new Error("expected an error result");

    expect(result.fieldErrors.website).toEqual([
      "Enter a valid URL beginning with http:// or https://",
    ]);

    // No lead may be created by a rejected submission.
    expect(await db.lead.count()).toBe(0);
  });

  it("does not leak Zod internals or stack traces", async () => {
    const result = await createLeadAction(
      { status: "idle" },
      form({ companyName: "Acme Ltd", website: "javascript:alert(1)" }),
    );

    const serialised = JSON.stringify(result);

    expect(serialised).not.toMatch(/ZodError|invalid_string|at Object|\.ts:\d+/);
    expect(serialised).not.toMatch(/prisma|postgres|select |insert /i);
  });

  it("reports several invalid fields at once and preserves input", async () => {
    const result = await createLeadAction(
      { status: "idle" },
      form({
        companyName: "Acme Ltd",
        website: "bad",
        linkedinUrl: "also-bad",
        email: "not-an-email",
      }),
    );

    if (result.status !== "error") throw new Error("expected an error result");

    expect(Object.keys(result.fieldErrors).sort()).toEqual([
      "email",
      "linkedinUrl",
      "website",
    ]);

    // The user's typed values come back so the form is not wiped.
    expect(result.values.companyName).toBe("Acme Ltd");
    expect(result.values.website).toBe("bad");
  });

  it("requires a company name", async () => {
    const result = await createLeadAction({ status: "idle" }, form({ website: "" }));

    if (result.status !== "error") throw new Error("expected an error result");
    expect(result.fieldErrors.companyName).toBeDefined();
  });

  it("creates the lead and an activity on valid input", async () => {
    await expect(
      createLeadAction(
        { status: "idle" },
        form({
          companyName: "Valid Client Ltd",
          website: "https://example.com",
          email: "hello@example.com",
        }),
      ),
      // Success ends in a redirect, which throws by design.
    ).rejects.toThrow(/^REDIRECT:\/leads\//);

    const lead = await db.lead.findFirstOrThrow();
    expect(lead.companyName).toBe("Valid Client Ltd");
    expect(lead.website).toBe("https://example.com");
    expect(lead.workspaceId).toBe(session.workspaceId);

    const activity = await db.activity.findFirstOrThrow();
    expect(activity.type).toBe("LEAD_CREATED");
    expect(activity.leadId).toBe(lead.id);
    expect(activity.workspaceId).toBe(session.workspaceId);
  });

  it("omits blank optional fields rather than failing validation", async () => {
    await expect(
      createLeadAction(
        { status: "idle" },
        form({ companyName: "Minimal Ltd", website: "", email: "", phone: "" }),
      ),
    ).rejects.toThrow(/^REDIRECT:/);

    const lead = await db.lead.findFirstOrThrow();
    expect(lead.website).toBeNull();
    expect(lead.email).toBeNull();
  });
});
