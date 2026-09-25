import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { actAsFactory, requireUserMock } from "../helpers/act-as";
import { IDLE } from "@/lib/crm/action-result";

const currentUser = vi.hoisted(() => ({
  value: null as null | { userId: string; workspaceId: string },
}));

vi.mock("@/lib/auth/require-user", () => requireUserMock(currentUser));

// Cache revalidation is a Next.js runtime concern; the actions are exercised
// here for their data effects and returned state.
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

const actAs = actAsFactory(currentUser);

const actions = await import("@/app/(app)/leads/actions");
const { createLead } = await import("@/lib/crm/leads");

let alice: SeededWorkspace;
let bob: SeededWorkspace;
let leadId: string;

beforeAll(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await truncateAll();
  revalidatePath.mockClear();

  alice = await seedWorkspace("Alice");
  bob = await seedWorkspace("Bob");

  actAs(alice);
  leadId = (await createLead({ companyName: "Northwind Bakery" })).id;
});

/** Builds the FormData a browser would post. */
function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

describe("lead actions", () => {
  it("updates a lead from form input and revalidates", async () => {
    const result = await actions.updateLeadAction(
      leadId,
      IDLE,
      form({
        companyName: "Northwind Bakery Ltd",
        contactName: "Priya Raman",
        email: "priya@northwind.test",
        website: "https://northwind.test",
        city: "Chennai",
      }),
    );

    expect(result.status).toBe("success");

    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.companyName).toBe("Northwind Bakery Ltd");
    expect(lead.city).toBe("Chennai");

    expect(revalidatePath).toHaveBeenCalled();
  });

  it("treats a blank optional field as 'clear this value'", async () => {
    await actions.updateLeadAction(
      leadId,
      IDLE,
      form({ companyName: "Northwind Bakery", city: "Chennai" }),
    );
    await actions.updateLeadAction(
      leadId,
      IDLE,
      form({ companyName: "Northwind Bakery", city: "" }),
    );

    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: leadId } })).city,
    ).toBeNull();
  });

  it("returns field-level errors instead of throwing", async () => {
    const result = await actions.updateLeadAction(
      leadId,
      IDLE,
      form({ companyName: "Northwind Bakery", email: "not-an-email" }),
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.fieldErrors.email?.length).toBeGreaterThan(0);
    }
  });

  it("moves a lead through a valid transition", async () => {
    const result = await actions.moveLeadAction(
      leadId,
      IDLE,
      form({ status: "RESEARCHING" }),
    );

    expect(result.status).toBe("success");
    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: leadId } })).status,
    ).toBe("RESEARCHING");
  });

  it("reports an invalid transition safely", async () => {
    const result = await actions.moveLeadAction(leadId, IDLE, form({ status: "WON" }));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/cannot|not allowed|invalid/i);
      expect(result.message).not.toMatch(/prisma|sql/i);
    }

    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: leadId } })).status,
    ).toBe("NEW");
  });

  it("rejects a status that is not a real enum value", async () => {
    const result = await actions.moveLeadAction(
      leadId,
      IDLE,
      form({ status: "BECOME_ADMIN" }),
    );

    expect(result.status).toBe("error");
  });

  it("archives and restores from the form", async () => {
    expect((await actions.archiveLeadAction(leadId, IDLE)).status).toBe(
      "success",
    );
    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: leadId } })).deletedAt,
    ).not.toBeNull();

    expect((await actions.restoreLeadAction(leadId, IDLE)).status).toBe(
      "success",
    );
    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: leadId } })).deletedAt,
    ).toBeNull();
  });

  it("adds a note", async () => {
    const result = await actions.addNoteAction(
      leadId,
      IDLE,
      form({ body: "Met at the Chennai food expo." }),
    );

    expect(result.status).toBe("success");
    expect(
      await db.activity.count({ where: { leadId, type: "NOTE_ADDED" } }),
    ).toBe(1);
  });
});

describe("qualification action", () => {
  it("reads checkboxes, tri-state selects and text areas", async () => {
    const result = await actions.updateQualificationAction(
      leadId,
      IDLE,
      form({
        decisionMakerIdentified: "on",
        websitePresent: "false",
        websiteQuality: "",
        advertisingActivity: "Running Meta ads",
        serviceInterest: "Website rebuild",
        painPoint: "No online ordering",
        qualificationNotes: "Owner wants to launch before Diwali.",
      }),
    );

    expect(result.status).toBe("success");

    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.decisionMakerIdentified).toBe(true);
    expect(lead.websitePresent).toBe(false);
    expect(lead.websiteQuality).toBeNull();
    expect(lead.advertisingActivity).toBe("Running Meta ads");
    expect(lead.score).toBeGreaterThan(0);
  });

  it("treats an absent checkbox as false", async () => {
    await actions.updateQualificationAction(
      leadId,
      IDLE,
      form({ decisionMakerIdentified: "on" }),
    );
    await actions.updateQualificationAction(leadId, IDLE, form({}));

    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: leadId } }))
        .decisionMakerIdentified,
    ).toBe(false);
  });

  it("never accepts a score posted by the browser", async () => {
    const result = await actions.updateQualificationAction(
      leadId,
      IDLE,
      form({ decisionMakerIdentified: "on", score: "100" }),
    );

    // The extra field is simply not read from the form, and the score stays
    // server-computed.
    expect(result.status).toBe("success");

    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.score).toBeLessThan(100);
  });
});

describe("contact, task and follow-up actions", () => {
  it("creates and updates a contact", async () => {
    const created = await actions.createContactAction(
      leadId,
      IDLE,
      form({ fullName: "Priya Raman", jobTitle: "Owner", isDecisionMaker: "on" }),
    );
    expect(created.status).toBe("success");

    const contact = await db.contact.findFirstOrThrow({ where: { leadId } });
    expect(contact.isDecisionMaker).toBe(true);

    const updated = await actions.updateContactAction(
      leadId,
      contact.id,
      IDLE,
      form({ fullName: "Priya Raman", jobTitle: "Managing Director" }),
    );
    expect(updated.status).toBe("success");

    expect(
      (await db.contact.findUniqueOrThrow({ where: { id: contact.id } })).jobTitle,
    ).toBe("Managing Director");
  });

  it("creates, completes and cancels a task", async () => {
    expect(
      (
        await actions.createTaskAction(
          leadId,
          IDLE,
          form({ title: "Send the menu mockup", priority: "HIGH" }),
        )
      ).status,
    ).toBe("success");

    const task = await db.task.findFirstOrThrow({ where: { leadId } });
    expect(task.priority).toBe("HIGH");

    expect((await actions.completeTaskAction(task.id, IDLE)).status).toBe(
      "success",
    );
    expect(
      (await db.task.findUniqueOrThrow({ where: { id: task.id } })).status,
    ).toBe("DONE");

    const second = await actions.createTaskAction(
      leadId,
      IDLE,
      form({ title: "Follow up on pricing" }),
    );
    expect(second.status).toBe("success");

    const other = await db.task.findFirstOrThrow({
      where: { leadId, title: "Follow up on pricing" },
    });
    expect((await actions.cancelTaskAction(other.id, IDLE)).status).toBe(
      "success",
    );
  });

  it("schedules, completes and cancels a follow-up", async () => {
    const created = await actions.createFollowUpAction(
      leadId,
      IDLE,
      form({
        channel: "EMAIL",
        sequence: "INITIAL",
        // The form posts a local datetime string, as a browser would.
        scheduledAt: "2026-10-01T09:00",
        message: "Share the sample menu page.",
      }),
    );
    expect(created.status).toBe("success");

    const followUp = await db.followUp.findFirstOrThrow({ where: { leadId } });
    expect(followUp.channel).toBe("EMAIL");

    expect(
      (await actions.completeFollowUpAction(followUp.id, IDLE)).status,
    ).toBe("success");
    expect(
      (await db.followUp.findUniqueOrThrow({ where: { id: followUp.id } })).status,
    ).toBe("COMPLETED");

    const second = await actions.createFollowUpAction(
      leadId,
      IDLE,
      form({ channel: "PHONE", sequence: "FU1", scheduledAt: "2026-10-08T09:00" }),
    );
    expect(second.status).toBe("success");

    const toCancel = await db.followUp.findFirstOrThrow({
      where: { leadId, channel: "PHONE" },
    });
    expect(
      (await actions.cancelFollowUpAction(toCancel.id, IDLE)).status,
    ).toBe("success");
  });

  it("rejects a missing required field with a field error", async () => {
    const result = await actions.createContactAction(leadId, IDLE, form({ fullName: "" }));

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.fieldErrors.fullName?.length).toBeGreaterThan(0);
    }
  });
});

describe("actions enforce workspace ownership", () => {
  it("returns a safe error and changes nothing for another workspace's lead", async () => {
    actAs(bob);

    const results = await Promise.all([
      actions.updateLeadAction(leadId, IDLE, form({ companyName: "Stolen" })),
      actions.moveLeadAction(leadId, IDLE, form({ status: "RESEARCHING" })),
      actions.archiveLeadAction(leadId, IDLE),
      actions.addNoteAction(leadId, IDLE, form({ body: "injected" })),
      actions.createContactAction(leadId, IDLE, form({ fullName: "Injected" })),
      actions.createTaskAction(leadId, IDLE, form({ title: "Injected" })),
      actions.createFollowUpAction(
        leadId,
        IDLE,
        form({ channel: "EMAIL", sequence: "INITIAL", scheduledAt: "2026-10-01T09:00" }),
      ),
    ]);

    for (const result of results) {
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toBe("Lead not found.");
      }
    }

    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.companyName).toBe("Northwind Bakery");
    expect(lead.status).toBe("NEW");
    expect(lead.deletedAt).toBeNull();

    expect(await db.contact.count({ where: { leadId } })).toBe(0);
    expect(await db.task.count({ where: { leadId } })).toBe(0);
    expect(await db.followUp.count({ where: { leadId } })).toBe(0);
  });
});
