import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadStatus } from "@prisma/client";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { actAsFactory, requireUserMock } from "../helpers/act-as";
import {
  ALL_LEAD_STATUSES,
  PIPELINE_STAGES,
  STATUS_STAGE,
  canTransition,
  nextStatuses,
} from "@/lib/crm/pipeline";

const currentUser = vi.hoisted(() => ({
  value: null as null | { userId: string; workspaceId: string },
}));

vi.mock("@/lib/auth/require-user", () => requireUserMock(currentUser));

const actAs = actAsFactory(currentUser);

const { createLead, moveLead } = await import("@/lib/crm/leads");

let alice: SeededWorkspace;

beforeAll(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("Alice");
  actAs(alice);
});

describe("transition map", () => {
  it("covers all twelve lead statuses", () => {
    expect(ALL_LEAD_STATUSES).toHaveLength(12);
  });

  it("maps every status onto a visible pipeline stage", () => {
    for (const status of ALL_LEAD_STATUSES) {
      expect(PIPELINE_STAGES).toContain(STATUS_STAGE[status]);
    }
  });

  it("makes every status reachable from NEW through valid transitions", () => {
    const seen = new Set<LeadStatus>(["NEW"]);
    const queue: LeadStatus[] = ["NEW"];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of nextStatuses(current)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }

    expect([...seen].sort()).toEqual([...ALL_LEAD_STATUSES].sort());
  });

  it("treats WON as terminal and rejects nonsense jumps", () => {
    expect(nextStatuses("WON")).toHaveLength(0);
    expect(canTransition("NEW", "WON")).toBe(false);
    expect(canTransition("NEW", "NEW")).toBe(false);
    expect(canTransition("NEW", "RESEARCHING")).toBe(true);
  });
});

describe("moveLead", () => {
  it("applies a valid transition and records STATUS_CHANGED with both statuses", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    const moved = await moveLead(lead.id, "RESEARCHING");
    expect(moved.status).toBe("RESEARCHING");

    const activity = await db.activity.findFirstOrThrow({
      where: { leadId: lead.id, type: "STATUS_CHANGED" },
    });

    expect(activity.metadata).toMatchObject({
      from: "NEW",
      to: "RESEARCHING",
    });
  });

  it("rejects an invalid transition without touching the record", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    await expect(moveLead(lead.id, "WON")).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });

    const reread = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(reread.status).toBe("NEW");

    expect(
      await db.activity.count({ where: { leadId: lead.id, type: "STATUS_CHANGED" } }),
    ).toBe(0);
  });

  it("rejects an unknown status value", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });
    await expect(moveLead(lead.id, "TOTALLY_MADE_UP" as LeadStatus)).rejects.toThrow();
  });

  it("rescores the lead as it advances through the pipeline", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });
    const initial = lead.score;

    await moveLead(lead.id, "RESEARCHING");
    const researching = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });

    expect(researching.score).toBeGreaterThan(initial);
  });

  it("walks the full happy path to WON", async () => {
    const lead = await createLead({ companyName: "Acme Studio" });

    const path: LeadStatus[] = [
      "RESEARCHING",
      "QUALIFIED",
      "OUTREACH_READY",
      "CONTACTED",
      "RESPONDED",
      "DISCOVERY_CALL",
      "PROPOSAL",
      "NEGOTIATION",
      "WON",
    ];

    for (const status of path) {
      await moveLead(lead.id, status);
    }

    const finalLead = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(finalLead.status).toBe("WON");

    expect(
      await db.activity.count({ where: { leadId: lead.id, type: "STATUS_CHANGED" } }),
    ).toBe(path.length);
  });
});
