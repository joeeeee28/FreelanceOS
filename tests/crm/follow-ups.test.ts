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
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  listFollowUps,
  updateFollowUp,
} = await import("@/lib/crm/follow-ups");
const { createLead } = await import("@/lib/crm/leads");

let alice: SeededWorkspace;
let bob: SeededWorkspace;
let aliceLeadId: string;

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
  aliceLeadId = (await createLead({ companyName: "Acme Studio" })).id;
});

const soon = () => new Date(Date.now() + 2 * 24 * 3600 * 1000);

describe("scheduling", () => {
  it("schedules a follow-up and logs FOLLOW_UP_SCHEDULED", async () => {
    const followUp = await createFollowUp({
      leadId: aliceLeadId,
      channel: "EMAIL",
      sequence: "INITIAL",
      scheduledAt: soon(),
    });

    expect(followUp.workspaceId).toBe(alice.workspaceId);
    expect(followUp.status).toBe("SCHEDULED");

    const activity = await db.activity.findFirst({
      where: { leadId: aliceLeadId, type: "FOLLOW_UP_SCHEDULED" },
    });
    expect(activity).not.toBeNull();
  });

  it("accepts every channel and sequence the schema allows", async () => {
    const channels = [
      "EMAIL",
      "LINKEDIN",
      "INSTAGRAM",
      "FACEBOOK",
      "WHATSAPP",
      "PHONE",
      "UPWORK",
      "FIVERR",
      "CONTRA",
      "COLD_EMAIL",
      "REFERRAL",
      "OTHER",
    ] as const;

    for (const channel of channels) {
      const followUp = await createFollowUp({
        leadId: aliceLeadId,
        channel,
        sequence: "INITIAL",
        scheduledAt: soon(),
      });
      expect(followUp.channel).toBe(channel);
    }

    for (const sequence of ["INITIAL", "FU1", "FU2", "FU3", "NURTURE"] as const) {
      const followUp = await createFollowUp({
        leadId: aliceLeadId,
        channel: "EMAIL",
        sequence,
        scheduledAt: soon(),
      });
      expect(followUp.sequence).toBe(sequence);
    }
  });

  it("rejects an unknown channel", async () => {
    await expect(
      createFollowUp({
        leadId: aliceLeadId,
        channel: "CARRIER_PIGEON",
        sequence: "INITIAL",
        scheduledAt: soon(),
      }),
    ).rejects.toThrow();
  });
});

describe("editing, completing and cancelling", () => {
  it("reschedules an existing follow-up", async () => {
    const followUp = await createFollowUp({
      leadId: aliceLeadId,
      channel: "EMAIL",
      sequence: "INITIAL",
      scheduledAt: soon(),
    });

    const later = new Date(Date.now() + 10 * 24 * 3600 * 1000);
    const updated = await updateFollowUp(followUp.id, {
      scheduledAt: later,
      channel: "PHONE",
    });

    expect(updated.channel).toBe("PHONE");
    expect(updated.scheduledAt.toISOString()).toBe(later.toISOString());
  });

  it("completes a follow-up and logs FOLLOW_UP_COMPLETED", async () => {
    const followUp = await createFollowUp({
      leadId: aliceLeadId,
      channel: "EMAIL",
      sequence: "INITIAL",
      scheduledAt: soon(),
    });

    const completed = await completeFollowUp(followUp.id);

    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt).not.toBeNull();

    expect(
      await db.activity.count({
        where: { leadId: aliceLeadId, type: "FOLLOW_UP_COMPLETED" },
      }),
    ).toBe(1);
  });

  it("cancels a follow-up and records it on the timeline", async () => {
    const followUp = await createFollowUp({
      leadId: aliceLeadId,
      channel: "EMAIL",
      sequence: "INITIAL",
      scheduledAt: soon(),
    });

    const cancelled = await cancelFollowUp(followUp.id);

    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.completedAt).toBeNull();

    const activity = await db.activity.findFirst({
      where: { leadId: aliceLeadId, type: "OTHER" },
    });
    expect(activity?.title).toMatch(/cancel/i);
  });
});

describe("workspace timezone handling", () => {
  it("uses the workspace calendar day, not the server's, for 'today'", async () => {
    // Kiritimati is UTC+14: a moment that is still "yesterday" in UTC is
    // already "today" there.
    await db.workspace.update({
      where: { id: alice.workspaceId },
      data: { timezone: "Pacific/Kiritimati" },
    });

    const now = new Date();

    // Build an instant that falls inside the Kiritimati calendar day.
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Pacific/Kiritimati",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);

    const get = (type: string) => parts.find((part) => part.type === type)!.value;

    // 06:00 Kiritimati time on the workspace's current day == 16:00 UTC the
    // previous day.
    const localMidday = new Date(
      `${get("year")}-${get("month")}-${get("day")}T06:00:00+14:00`,
    );

    await createFollowUp({
      leadId: aliceLeadId,
      channel: "EMAIL",
      sequence: "INITIAL",
      scheduledAt: localMidday,
    });

    const today = await listFollowUps({ due: "today" });
    expect(today.items).toHaveLength(1);

    // The same record must not also be reported as overdue.
    const overdue = await listFollowUps({ due: "overdue" });
    expect(overdue.items).toHaveLength(0);
  });

  it("classifies a past follow-up as overdue", async () => {
    await createFollowUp({
      leadId: aliceLeadId,
      channel: "EMAIL",
      sequence: "INITIAL",
      scheduledAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
    });

    expect((await listFollowUps({ due: "overdue" })).items).toHaveLength(1);
    expect((await listFollowUps({ due: "today" })).items).toHaveLength(0);
  });
});

describe("workspace isolation for follow-ups", () => {
  it("refuses to schedule against another workspace's lead", async () => {
    actAs(bob);

    await expect(
      createFollowUp({
        leadId: aliceLeadId,
        channel: "EMAIL",
        sequence: "INITIAL",
        scheduledAt: soon(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await db.followUp.count({ where: { leadId: aliceLeadId } })).toBe(0);
  });

  it("refuses to edit, complete or cancel another workspace's follow-up", async () => {
    const followUp = await createFollowUp({
      leadId: aliceLeadId,
      channel: "EMAIL",
      sequence: "INITIAL",
      scheduledAt: soon(),
    });

    actAs(bob);

    await expect(
      updateFollowUp(followUp.id, { channel: "PHONE" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(completeFollowUp(followUp.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(cancelFollowUp(followUp.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const untouched = await db.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    expect(untouched.status).toBe("SCHEDULED");
    expect(untouched.channel).toBe("EMAIL");
  });

  it("lists only the caller's own follow-ups", async () => {
    await createFollowUp({
      leadId: aliceLeadId,
      channel: "EMAIL",
      sequence: "INITIAL",
      scheduledAt: soon(),
    });

    actAs(bob);
    expect((await listFollowUps()).items).toHaveLength(0);
  });
});
