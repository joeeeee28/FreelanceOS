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

const { getDailyActions, HIGH_SCORE_THRESHOLD } = await import(
  "@/lib/crm/daily-actions"
);
const { createLead, moveLead, updateQualification } = await import("@/lib/crm/leads");
const { createFollowUp } = await import("@/lib/crm/follow-ups");
const { createTask } = await import("@/lib/crm/tasks");

let alice: SeededWorkspace;
let bob: SeededWorkspace;

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
});

const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 24 * 3600 * 1000);

describe("empty state", () => {
  it("returns nothing for an empty workspace", async () => {
    expect(await getDailyActions()).toEqual([]);
  });

  it("returns nothing when a lead exists but nothing is due", async () => {
    await createLead({ companyName: "Acme Studio" });

    expect(await getDailyActions()).toEqual([]);
  });
});

describe("action detection", () => {
  it("surfaces an overdue follow-up as URGENT", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });
    const followUp = await createFollowUp({
      leadId: lead.id,
      channel: "EMAIL",
      sequence: "FU1",
      scheduledAt: daysFromNow(-3),
    });

    const actions = await getDailyActions();
    const overdue = actions.find((action) => action.type === "OVERDUE_FOLLOW_UP");

    expect(overdue).toBeDefined();
    expect(overdue?.priority).toBe("URGENT");
    expect(overdue?.leadId).toBe(lead.id);
    expect(overdue?.followUpId).toBe(followUp.id);
    expect(overdue?.title).toContain("Acme Studio");
  });

  it("surfaces a follow-up due today as HIGH", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });
    await createFollowUp({
      leadId: lead.id,
      channel: "EMAIL",
      sequence: "INITIAL",
      // Midday in the workspace timezone (Asia/Kolkata) on the current day.
      scheduledAt: new Date(),
    });

    const actions = await getDailyActions();
    const today = actions.find((action) => action.type === "FOLLOW_UP_DUE_TODAY");

    expect(today).toBeDefined();
    expect(today?.priority).toBe("HIGH");
  });

  it("surfaces a high-score uncontacted lead", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    await updateQualification(lead.id, {
      decisionMakerIdentified: true,
      serviceInterest: "Website rebuild",
      painPoint: "No mobile site",
      websitePresent: false,
      advertisingActivity: "Meta ads",
      qualificationNotes: "Budget confirmed",
    });

    await moveLead(lead.id, "RESEARCHING");
    await moveLead(lead.id, "QUALIFIED");

    const scored = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(scored.score).toBeGreaterThanOrEqual(HIGH_SCORE_THRESHOLD);

    const actions = await getDailyActions();
    const chase = actions.find(
      (action) => action.type === "HIGH_SCORE_UNCONTACTED_LEAD",
    );

    expect(chase?.leadId).toBe(lead.id);
    expect(chase?.priority).toBe("MEDIUM");
  });

  it("surfaces an overdue task", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });
    const task = await createTask({
      title: "Send the case study",
      leadId: lead.id,
      dueAt: daysFromNow(-2),
    });

    const actions = await getDailyActions();
    const overdue = actions.find((action) => action.type === "OVERDUE_TASK");

    expect(overdue?.taskId).toBe(task.id);
    expect(overdue?.title).toContain("Send the case study");
  });

  it("escalates an overdue URGENT task above a normal one", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    await createTask({
      title: "Normal task",
      leadId: lead.id,
      dueAt: daysFromNow(-1),
      priority: "LOW",
    });
    await createTask({
      title: "Urgent task",
      leadId: lead.id,
      dueAt: daysFromNow(-1),
      priority: "URGENT",
    });

    const tasks = (await getDailyActions()).filter(
      (action) => action.type === "OVERDUE_TASK",
    );

    expect(tasks[0].title).toContain("Urgent task");
    expect(tasks[0].priority).toBe("URGENT");
  });

  it("flags a lead that replied but has nothing scheduled", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    for (const status of [
      "RESEARCHING",
      "QUALIFIED",
      "OUTREACH_READY",
      "CONTACTED",
      "RESPONDED",
    ] as const) {
      await moveLead(lead.id, status);
    }

    const actions = await getDailyActions();
    const responded = actions.find(
      (action) => action.type === "RESPONDED_LEAD_NEEDS_ACTION",
    );

    expect(responded?.leadId).toBe(lead.id);
    expect(responded?.priority).toBe("HIGH");
  });

  it("stops flagging a replied lead once a follow-up is booked", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    for (const status of [
      "RESEARCHING",
      "QUALIFIED",
      "OUTREACH_READY",
      "CONTACTED",
      "RESPONDED",
    ] as const) {
      await moveLead(lead.id, status);
    }

    await createFollowUp({
      leadId: lead.id,
      channel: "EMAIL",
      sequence: "FU1",
      scheduledAt: daysFromNow(3),
    });

    const actions = await getDailyActions();
    expect(
      actions.some((action) => action.type === "RESPONDED_LEAD_NEEDS_ACTION"),
    ).toBe(false);
  });
});

describe("ordering", () => {
  it("puts urgent work before high, medium and low", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    await createFollowUp({
      leadId: lead.id,
      channel: "EMAIL",
      sequence: "FU1",
      scheduledAt: daysFromNow(-4),
    });
    await createFollowUp({
      leadId: lead.id,
      channel: "PHONE",
      sequence: "FU2",
      scheduledAt: new Date(),
    });

    const actions = await getDailyActions();
    const ranks = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;

    for (let index = 1; index < actions.length; index += 1) {
      expect(ranks[actions[index].priority]).toBeGreaterThanOrEqual(
        ranks[actions[index - 1].priority],
      );
    }

    expect(actions[0].type).toBe("OVERDUE_FOLLOW_UP");
  });

  it("is deterministic across repeated runs", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    await createFollowUp({
      leadId: lead.id,
      channel: "EMAIL",
      sequence: "FU1",
      scheduledAt: daysFromNow(-4),
    });
    await createTask({
      title: "Overdue task",
      leadId: lead.id,
      dueAt: daysFromNow(-1),
    });

    const at = new Date();
    const first = await getDailyActions(at);
    const second = await getDailyActions(at);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("workspace isolation for daily actions", () => {
  it("never reports another workspace's work", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });
    await createFollowUp({
      leadId: lead.id,
      channel: "EMAIL",
      sequence: "FU1",
      scheduledAt: daysFromNow(-3),
    });
    await createTask({ title: "Alice task", leadId: lead.id, dueAt: daysFromNow(-1) });

    expect((await getDailyActions()).length).toBeGreaterThan(0);

    actAs(bob);
    expect(await getDailyActions()).toEqual([]);
  });
});
