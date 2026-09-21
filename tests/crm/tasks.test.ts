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

const { cancelTask, completeTask, createTask, listTasks, updateTask } = await import(
  "@/lib/crm/tasks"
);
const { createLead } = await import("@/lib/crm/leads");
const { createContact } = await import("@/lib/crm/contacts");

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

describe("task creation", () => {
  it("creates a task scoped to the caller's workspace", async () => {
    const task = await createTask({
      title: "Draft the outreach email",
      leadId: aliceLeadId,
    });

    expect(task.workspaceId).toBe(alice.workspaceId);
    expect(task.status).toBe("TODO");
    expect(task.priority).toBe("MEDIUM");
    expect(task.createdByUserId).toBe(alice.userId);
  });

  it("supports a task with no lead attached", async () => {
    const task = await createTask({ title: "Update the portfolio" });

    expect(task.leadId).toBeNull();
    expect(task.workspaceId).toBe(alice.workspaceId);
  });

  it("accepts all four priorities", async () => {
    for (const priority of ["LOW", "MEDIUM", "HIGH", "URGENT"] as const) {
      const task = await createTask({ title: `Task ${priority}`, priority });
      expect(task.priority).toBe(priority);
    }
  });

  it("rejects an empty title", async () => {
    await expect(createTask({ title: "  " })).rejects.toThrow();
  });
});

describe("task updates", () => {
  it("edits fields without changing status", async () => {
    const task = await createTask({ title: "Draft email", leadId: aliceLeadId });

    const updated = await updateTask(task.id, {
      title: "Draft the first outreach email",
      priority: "HIGH",
    });

    expect(updated.title).toBe("Draft the first outreach email");
    expect(updated.priority).toBe("HIGH");
    expect(updated.status).toBe("TODO");
    expect(updated.completedAt).toBeNull();
  });

  it("marks completedAt when the status is moved to DONE", async () => {
    const task = await createTask({ title: "Draft email", leadId: aliceLeadId });

    const updated = await updateTask(task.id, { status: "DONE" });

    expect(updated.status).toBe("DONE");
    expect(updated.completedAt).not.toBeNull();
  });

  it("clears completedAt when a completed task is reopened", async () => {
    const task = await createTask({ title: "Draft email", leadId: aliceLeadId });
    await updateTask(task.id, { status: "DONE" });

    const reopened = await updateTask(task.id, { status: "IN_PROGRESS" });

    expect(reopened.completedAt).toBeNull();
  });
});

describe("completing and cancelling", () => {
  it("completes a task and logs TASK_COMPLETED when a lead is attached", async () => {
    const task = await createTask({ title: "Call the founder", leadId: aliceLeadId });

    const done = await completeTask(task.id);

    expect(done.status).toBe("DONE");
    expect(done.completedAt).not.toBeNull();

    const activity = await db.activity.findFirst({
      where: { leadId: aliceLeadId, type: "TASK_COMPLETED" },
    });
    expect(activity?.description).toBe("Call the founder");
  });

  it("completes a lead-less task without writing an orphan activity", async () => {
    const before = await db.activity.count();
    const task = await createTask({ title: "Update the portfolio" });

    await completeTask(task.id);

    expect(await db.activity.count()).toBe(before);
  });

  it("cancels a task", async () => {
    const task = await createTask({ title: "Call the founder", leadId: aliceLeadId });

    const cancelled = await cancelTask(task.id);

    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.completedAt).toBeNull();
  });

  it("links the completion activity to the contact when one is set", async () => {
    const contact = await createContact({
      leadId: aliceLeadId,
      fullName: "Priya Raman",
    });

    const task = await createTask({
      title: "Call Priya",
      leadId: aliceLeadId,
      contactId: contact.id,
    });

    await completeTask(task.id);

    const activity = await db.activity.findFirstOrThrow({
      where: { leadId: aliceLeadId, type: "TASK_COMPLETED" },
    });
    expect(activity.contactId).toBe(contact.id);
  });
});

describe("task filters", () => {
  it("filters by status and priority", async () => {
    await createTask({ title: "A", priority: "URGENT" });
    const done = await createTask({ title: "B", priority: "LOW" });
    await completeTask(done.id);

    expect((await listTasks({ status: "TODO" })).items.map((task) => task.title)).toEqual(["A"]);
    expect((await listTasks({ status: "DONE" })).items.map((task) => task.title)).toEqual(["B"]);
    expect((await listTasks({ priority: "URGENT" })).items).toHaveLength(1);
  });

  it("separates overdue from upcoming work", async () => {
    await createTask({
      title: "Overdue",
      dueAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
    });
    await createTask({
      title: "Upcoming",
      dueAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    await createTask({ title: "No date" });

    expect((await listTasks({ due: "overdue" })).items.map((task) => task.title)).toEqual([
      "Overdue",
    ]);
    expect((await listTasks({ due: "upcoming" })).items.map((task) => task.title)).toEqual([
      "Upcoming",
    ]);
    expect((await listTasks({ due: "none" })).items.map((task) => task.title)).toEqual([
      "No date",
    ]);
  });
});

describe("workspace isolation for tasks", () => {
  it("refuses to create a task against another workspace's lead", async () => {
    actAs(bob);

    await expect(
      createTask({ title: "Intrusion", leadId: aliceLeadId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await db.task.count({ where: { leadId: aliceLeadId } })).toBe(0);
  });

  it("refuses to update, complete or cancel another workspace's task", async () => {
    const task = await createTask({ title: "Alice task", leadId: aliceLeadId });

    actAs(bob);

    await expect(updateTask(task.id, { title: "Hijacked" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(completeTask(task.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(cancelTask(task.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const untouched = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(untouched.title).toBe("Alice task");
    expect(untouched.status).toBe("TODO");
  });

  it("lists only the caller's own tasks", async () => {
    await createTask({ title: "Alice task", leadId: aliceLeadId });

    actAs(bob);
    expect((await listTasks()).items).toHaveLength(0);
  });
});
