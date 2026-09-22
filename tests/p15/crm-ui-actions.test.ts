/**
 * P15 §6 — CRM mutations through the real server actions, against real Postgres.
 *
 * These call the exact exported server actions the UI forms submit to, inside a
 * real authenticated session, then read PostgreSQL directly to confirm the
 * mutation actually persisted. Only the identity boundary (`requireUser`) is
 * mocked; validation, Prisma queries, transactions and activity writes all run
 * for real. The rendering half of the UI is verified separately by requesting
 * every route over HTTP against this same database.
 */
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

const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

const actAs = actAsFactory(currentUser);

const {
  updateLeadAction,
  updateQualificationAction,
  moveLeadAction,
  archiveLeadAction,
  restoreLeadAction,
  addNoteAction,
  createContactAction,
  updateContactAction,
  createTaskAction,
  completeTaskAction,
  cancelTaskAction,
  createFollowUpAction,
  rescheduleFollowUpAction,
  completeFollowUpAction,
  cancelFollowUpAction,
} = await import("@/app/(app)/leads/actions");
const { createLeadAction } = await import("@/app/(app)/leads/new/actions");

let ws: SeededWorkspace;
let other: SeededWorkspace;
const report: Record<string, unknown> = {};

beforeAll(async () => {
  await resetTestDatabase();
}, 180_000);

beforeEach(async () => {
  await truncateAll();
  ws = await seedWorkspace("CRM");
  other = await seedWorkspace("Other");
  actAs(ws);
});

afterAll(async () => {
  console.log("\n=== P15 CRM ACTION EVIDENCE ===");
  console.log(JSON.stringify(report, null, 2));
  await disconnectTestPrisma();
});

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return data;
}

describe("§6 leads", () => {
  it("creates, edits, qualifies, scores, moves, archives and restores", async () => {
    // --- create -------------------------------------------------------
    // On success `createLeadAction` calls Next's `redirect()`, which signals
    // by throwing NEXT_REDIRECT. That throw IS the success path, so a
    // non-redirect return would mean the create failed.
    let redirected = false;
    try {
      const createState = await createLeadAction(
        { status: "idle" },
        form({
          companyName: "Persisted Ltd",
          contactName: "Ada Human",
          email: "ada@persisted.test",
          website: "https://persisted.test",
          city: "Chennai",
          country: "India",
        }),
      );
      expect(createState.status).not.toBe("error");
    } catch (error) {
      if ((error as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) {
        redirected = true;
      } else {
        throw error;
      }
    }
    expect(redirected).toBe(true);

    const created = await db.lead.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId },
    });
    expect(created.companyName).toBe("Persisted Ltd");

    // --- edit ---------------------------------------------------------
    const edit = await updateLeadAction(
      created.id,
      IDLE,
      form({
        companyName: "Persisted Ltd",
        contactName: "Ada Lovelace",
        email: "ada@persisted.test",
        phone: "+914412345678",
      }),
    );
    expect(edit.status).toBe("success");
    const edited = await db.lead.findUniqueOrThrow({ where: { id: created.id } });
    expect(edited.contactName).toBe("Ada Lovelace");

    // --- qualify --------------------------------------------------------
    const qualify = await updateQualificationAction(
      created.id,
      IDLE,
      form({
        websiteQuality: "OUTDATED",
        serviceInterest: "WEBSITE_CREATION",
        painPoint: "No online presence",
        qualificationNotes: "Wants a rebuild before the new season.",
      }),
    );
    expect(qualify.status).toBe("success");
    const qualified = await db.lead.findUniqueOrThrow({ where: { id: created.id } });
    expect(qualified.qualificationNotes).toContain("rebuild");
    // Deterministic scoring: added qualification evidence must move the score.
    expect(qualified.score).toBeGreaterThan(created.score);

    // --- status transition ------------------------------------------------
    const moved = await moveLeadAction(created.id, IDLE, form({ status: "RESEARCHING" }));
    expect(moved.status).toBe("success");
    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: created.id } })).status,
    ).toBe("RESEARCHING");

    // --- archive / restore -------------------------------------------------
    expect((await archiveLeadAction(created.id, IDLE)).status).toBe("success");
    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: created.id } })).deletedAt,
    ).not.toBeNull();

    expect((await restoreLeadAction(created.id, IDLE)).status).toBe("success");
    const restored = await db.lead.findUniqueOrThrow({ where: { id: created.id } });
    expect(restored.deletedAt).toBeNull();

    report.lead = {
      id: restored.id,
      companyName: restored.companyName,
      status: restored.status,
      scoreBefore: created.score,
      scoreAfterQualification: qualified.score,
      archivedThenRestored: true,
    };
  }, 120_000);

  it("refuses to mutate a lead belonging to another workspace", async () => {
    const theirs = await db.lead.create({
      data: { workspaceId: other.workspaceId, companyName: "Theirs Ltd" },
    });

    const result = await moveLeadAction(theirs.id, IDLE, form({ status: "QUALIFIED" }));

    // Cross-workspace writes must fail safely and change nothing.
    expect(result.status).toBe("error");
    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: theirs.id } })).status,
    ).toBe("NEW");

    report.workspaceIsolation = {
      attempted: "moveLeadAction on foreign lead",
      result: result.status,
      targetUnchanged: true,
    };
  }, 60_000);
});

describe("§6 contacts, tasks, follow-ups, activities", () => {
  it("creates and edits a contact, persisting decision-maker flags", async () => {
    const lead = await db.lead.create({
      data: { workspaceId: ws.workspaceId, companyName: "Contacts Ltd" },
    });

    const created = await createContactAction(
      lead.id,
      IDLE,
      form({
        fullName: "Grace Decider",
        email: "grace@contacts.test",
        jobTitle: "Owner",
        isPrimary: "on",
        isDecisionMaker: "on",
      }),
    );
    expect(created.status).toBe("success");

    const contact = await db.contact.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId },
    });
    expect(contact.fullName).toBe("Grace Decider");
    expect(contact.isDecisionMaker).toBe(true);
    expect(contact.isPrimary).toBe(true);

    const updated = await updateContactAction(
      lead.id,
      contact.id,
      IDLE,
      form({ fullName: "Grace Hopper", email: "grace@contacts.test", jobTitle: "Founder" }),
    );
    expect(updated.status).toBe("success");
    const after = await db.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.fullName).toBe("Grace Hopper");
    expect(after.jobTitle).toBe("Founder");

    report.contact = { id: contact.id, decisionMaker: true, renamedTo: after.fullName };
  }, 120_000);

  it("creates, completes and cancels tasks", async () => {
    const lead = await db.lead.create({
      data: { workspaceId: ws.workspaceId, companyName: "Tasks Ltd" },
    });

    expect(
      (
        await createTaskAction(
          lead.id,
          IDLE,
          form({ title: "Send proposal", priority: "HIGH", dueAt: "2026-10-01" }),
        )
      ).status,
    ).toBe("success");

    const task = await db.task.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId, title: "Send proposal" },
    });
    expect(task.dueAt).not.toBeNull();
    // Task.createdByUserId is required: a human action must be attributed.
    expect(task.createdByUserId).toBe(ws.userId);

    expect((await completeTaskAction(task.id, IDLE)).status).toBe("success");
    expect(
      (await db.task.findUniqueOrThrow({ where: { id: task.id } })).status,
    ).toBe("DONE");

    await createTaskAction(lead.id, IDLE, form({ title: "Obsolete", priority: "LOW" }));
    const second = await db.task.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId, title: "Obsolete" },
    });
    expect((await cancelTaskAction(second.id, IDLE)).status).toBe("success");
    expect(
      (await db.task.findUniqueOrThrow({ where: { id: second.id } })).status,
    ).toBe("CANCELLED");

    report.tasks = { completed: task.id, cancelled: second.id };
  }, 120_000);

  it("creates, reschedules, completes and cancels follow-ups", async () => {
    const lead = await db.lead.create({
      data: { workspaceId: ws.workspaceId, companyName: "FollowUps Ltd" },
    });

    expect(
      (
        await createFollowUpAction(
          lead.id,
          IDLE,
          form({ channel: "EMAIL", sequence: "INITIAL", scheduledAt: "2026-10-05" }),
        )
      ).status,
    ).toBe("success");

    const followUp = await db.followUp.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId, channel: "EMAIL" },
    });
    const originalDate = followUp.scheduledAt;

    expect(
      (
        await rescheduleFollowUpAction(
          followUp.id,
          IDLE,
          form({ scheduledAt: "2026-10-12" }),
        )
      ).status,
    ).toBe("success");
    const rescheduled = await db.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    expect(rescheduled.scheduledAt.getTime()).not.toBe(originalDate.getTime());

    expect((await completeFollowUpAction(followUp.id, IDLE)).status).toBe("success");
    expect(
      (await db.followUp.findUniqueOrThrow({ where: { id: followUp.id } })).status,
    ).toBe("COMPLETED");

    await createFollowUpAction(
      lead.id,
      IDLE,
      form({ channel: "PHONE", sequence: "FU1", scheduledAt: "2026-11-01" }),
    );
    const phone = await db.followUp.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId, channel: "PHONE" },
    });
    expect((await cancelFollowUpAction(phone.id, IDLE)).status).toBe("success");
    expect(
      (await db.followUp.findUniqueOrThrow({ where: { id: phone.id } })).status,
    ).toBe("CANCELLED");

    report.followUps = {
      rescheduledFrom: originalDate.toISOString(),
      rescheduledTo: rescheduled.scheduledAt.toISOString(),
      completed: followUp.id,
      cancelled: phone.id,
    };
  }, 120_000);

  it("records an attributed activity timeline for human mutations", async () => {
    const lead = await db.lead.create({
      data: { workspaceId: ws.workspaceId, companyName: "Timeline Ltd" },
    });

    expect(
      (await addNoteAction(lead.id, IDLE, form({ body: "Spoke to the owner today." })))
        .status,
    ).toBe("success");
    await moveLeadAction(lead.id, IDLE, form({ status: "RESEARCHING" }));

    const activities = await db.activity.findMany({
      where: { workspaceId: ws.workspaceId, leadId: lead.id },
      orderBy: { createdAt: "asc" },
    });

    expect(activities.length).toBeGreaterThanOrEqual(2);
    for (const a of activities) {
      expect(a.type).toBeTruthy();
      expect(a.title).toBeTruthy();
    }
    // Human-originated activities must be attributed to the acting user,
    // which is what distinguishes them from machine/discovery activities.
    expect(activities.every((a) => a.createdByUserId === ws.userId)).toBe(true);

    report.activities = activities.map((a) => ({
      type: a.type,
      title: a.title,
      attributedToHuman: a.createdByUserId === ws.userId,
    }));
  }, 120_000);
});
