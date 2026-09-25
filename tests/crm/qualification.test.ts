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

const { createLead, getLead, updateQualification } = await import("@/lib/crm/leads");

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
  alice = await seedWorkspace("Alice");
  bob = await seedWorkspace("Bob");

  actAs(alice);
  leadId = (await createLead({ companyName: "Acme Studio" })).id;
});

describe("qualification fields", () => {
  it("persists every qualification field", async () => {
    await updateQualification(leadId, {
      decisionMakerIdentified: true,
      qualificationNotes: "Budget confirmed for Q3.",
      websitePresent: true,
      websiteQuality: "Poor",
      advertisingActivity: "Running Meta ads",
      contentActivity: "Monthly blog",
      serviceInterest: "Website rebuild",
      painPoint: "Site loses mobile visitors",
    });

    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });

    expect(lead.decisionMakerIdentified).toBe(true);
    expect(lead.qualificationNotes).toBe("Budget confirmed for Q3.");
    expect(lead.websitePresent).toBe(true);
    expect(lead.websiteQuality).toBe("Poor");
    expect(lead.advertisingActivity).toBe("Running Meta ads");
    expect(lead.contentActivity).toBe("Monthly blog");
    expect(lead.serviceInterest).toBe("Website rebuild");
    expect(lead.painPoint).toBe("Site loses mobile visitors");
  });

  it("leaves unresearched fields as NULL rather than inventing defaults", async () => {
    await updateQualification(leadId, { serviceInterest: "SEO" });

    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });

    expect(lead.websitePresent).toBeNull();
    expect(lead.websiteQuality).toBeNull();
    expect(lead.advertisingActivity).toBeNull();
    expect(lead.contentActivity).toBeNull();
    expect(lead.painPoint).toBeNull();
  });

  it("can clear a previously recorded assessment", async () => {
    await updateQualification(leadId, { websiteQuality: "Poor" });
    await updateQualification(leadId, { websiteQuality: null });

    expect(
      (await db.lead.findUniqueOrThrow({ where: { id: leadId } })).websiteQuality,
    ).toBeNull();
  });

  it("rejects an attempt to set the score directly", async () => {
    await expect(updateQualification(leadId, { score: 100 })).rejects.toThrow();

    expect((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).score).toBe(0);
  });
});

describe("qualification side effects", () => {
  it("recalculates the score server-side", async () => {
    expect((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).score).toBe(0);

    await updateQualification(leadId, {
      decisionMakerIdentified: true,
      serviceInterest: "Website rebuild",
      painPoint: "No mobile site",
    });

    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.score).toBeGreaterThan(0);
    expect(lead.score).toBeLessThanOrEqual(100);
  });

  it("writes an activity explaining the new score", async () => {
    await updateQualification(leadId, { decisionMakerIdentified: true });

    const activity = await db.activity.findFirstOrThrow({
      where: { leadId, type: "RESEARCH_COMPLETED" },
    });

    expect(activity.metadata).toMatchObject({ score: expect.any(Number) });
  });

  it("is idempotent: saving the same assessment twice gives the same score", async () => {
    const payload = {
      decisionMakerIdentified: true,
      serviceInterest: "Website rebuild",
      websitePresent: false,
    };

    const first = await updateQualification(leadId, payload);
    const second = await updateQualification(leadId, payload);

    expect(second.score).toBe(first.score);
  });
});

describe("qualification isolation", () => {
  it("cannot qualify another workspace's lead", async () => {
    actAs(bob);

    await expect(
      updateQualification(leadId, { decisionMakerIdentified: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const untouched = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(untouched.decisionMakerIdentified).toBe(false);
    expect(untouched.score).toBe(0);
    expect(await db.activity.count({ where: { leadId, type: "RESEARCH_COMPLETED" } })).toBe(0);
  });

  it("keeps the qualification visible to its owner", async () => {
    await updateQualification(leadId, { serviceInterest: "Branding" });

    const lead = await getLead(leadId);
    expect(lead?.serviceInterest).toBe("Branding");
  });
});
