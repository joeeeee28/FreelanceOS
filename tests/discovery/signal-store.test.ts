import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const { refreshAllSignals, refreshCompanySignals } = await import(
  "@/lib/discovery/signals/store"
);

let alice: SeededWorkspace;
let bob: SeededWorkspace;

beforeAll(async () => {
  await resetTestDatabase();
}, 120_000);

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("Alice");
  bob = await seedWorkspace("Bob");
});

afterAll(async () => {
  await disconnectTestPrisma();
});

async function makeCompany(
  workspaceId: string,
  overrides: Record<string, unknown> = {},
) {
  return db.company.create({
    data: {
      workspaceId,
      name: "Acme Dental",
      canonicalName: "acme dental",
      canonicalDomain: "acme.test",
      phone: "+441234567890",
      ...overrides,
    },
  });
}

describe("refreshCompanySignals", () => {
  it("stores detected signals and the opportunities they imply", async () => {
    const company = await makeCompany(alice.workspaceId);

    const result = await refreshCompanySignals({
      workspaceId: alice.workspaceId,
      companyId: company.id,
    });

    expect(result.signalsCreated).toBeGreaterThan(0);
    expect(result.opportunitiesCreated).toBeGreaterThan(0);

    const signal = await db.signal.findFirstOrThrow({
      where: { companyId: company.id, type: "WEBSITE_MISSING" },
    });
    expect(signal.evidence).toBeTruthy();
    expect(signal.confidence).toBeGreaterThan(0);
  });

  it("links an opportunity to the signals that justify it", async () => {
    const company = await makeCompany(alice.workspaceId);

    await refreshCompanySignals({
      workspaceId: alice.workspaceId,
      companyId: company.id,
    });

    const opportunity = await db.opportunity.findFirstOrThrow({
      where: { companyId: company.id },
      include: { signals: true },
    });

    expect(opportunity.signals.length).toBeGreaterThan(0);
    expect(opportunity.rationale).not.toBeNull();
    expect(opportunity.recommendedAction).toBeTruthy();
  });

  describe("idempotency", () => {
    it("creates nothing new on an unchanged re-run", async () => {
      const company = await makeCompany(alice.workspaceId);

      await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });
      const signalsAfterFirst = await db.signal.count();
      const oppsAfterFirst = await db.opportunity.count();

      const second = await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      expect(second.signalsCreated).toBe(0);
      expect(second.signalsRefreshed).toBeGreaterThan(0);
      expect(await db.signal.count()).toBe(signalsAfterFirst);
      expect(await db.opportunity.count()).toBe(oppsAfterFirst);
    });

    it("keeps the original firstSeenAt when refreshing", async () => {
      const company = await makeCompany(alice.workspaceId);
      const first = new Date("2026-01-01T00:00:00Z");
      const later = new Date("2026-06-01T00:00:00Z");

      await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        now: first,
      });
      await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        now: later,
      });

      const signal = await db.signal.findFirstOrThrow({
        where: { companyId: company.id, type: "WEBSITE_MISSING" },
      });

      // When we first noticed something is history and must not be rewritten.
      expect(signal.firstSeenAt.toISOString()).toBe(first.toISOString());
      expect(signal.lastSeenAt.toISOString()).toBe(later.toISOString());
    });
  });

  describe("signals that stop firing", () => {
    it("resolves rather than deletes", async () => {
      const company = await makeCompany(alice.workspaceId);

      await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });
      expect(
        await db.signal.count({ where: { companyId: company.id, type: "WEBSITE_MISSING" } }),
      ).toBe(1);

      // The business now has a website, so the signal no longer applies.
      await db.company.update({
        where: { id: company.id },
        data: { website: "https://acme.test" },
      });

      const result = await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      expect(result.signalsResolved).toBeGreaterThan(0);

      const signal = await db.signal.findFirstOrThrow({
        where: { companyId: company.id, type: "WEBSITE_MISSING" },
      });

      // "This used to be true" is information. The row survives.
      expect(signal.status).toBe("RESOLVED");
      expect(signal.resolvedAt).not.toBeNull();
      expect(signal.evidence).toBeTruthy();
    });

    it("revives a resolved signal if it becomes true again", async () => {
      const company = await makeCompany(alice.workspaceId, {
        website: "https://acme.test",
      });

      await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      await db.company.update({ where: { id: company.id }, data: { website: null } });
      await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      const signal = await db.signal.findFirstOrThrow({
        where: { companyId: company.id, type: "WEBSITE_MISSING" },
      });
      expect(signal.status).toBe("ACTIVE");
      expect(signal.resolvedAt).toBeNull();
    });
  });

  describe("human decisions", () => {
    it("does not undo a dismissed signal", async () => {
      const company = await makeCompany(alice.workspaceId);

      await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      const signal = await db.signal.findFirstOrThrow({
        where: { companyId: company.id, type: "WEBSITE_MISSING" },
      });
      await db.signal.update({
        where: { id: signal.id },
        data: { status: "DISMISSED", resolvedAt: new Date() },
      });

      await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      const after = await db.signal.findUniqueOrThrow({ where: { id: signal.id } });

      // A person said "not interested". The engine does not argue.
      expect(after.status).toBe("DISMISSED");
    });

    it("does not un-dismiss an opportunity", async () => {
      const company = await makeCompany(alice.workspaceId);

      await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      const opportunity = await db.opportunity.findFirstOrThrow({
        where: { companyId: company.id },
      });
      const dismissedAt = new Date();
      await db.opportunity.update({
        where: { id: opportunity.id },
        data: { dismissedAt, status: "DISMISSED" },
      });

      await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      const after = await db.opportunity.findUniqueOrThrow({
        where: { id: opportunity.id },
      });
      expect(after.dismissedAt).not.toBeNull();
    });
  });

  describe("records it will not touch", () => {
    it("skips an archived company", async () => {
      const company = await makeCompany(alice.workspaceId, {
        archivedAt: new Date(),
      });

      const result = await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      expect(result.skipped).toBe("Company is archived");
      expect(await db.signal.count()).toBe(0);
    });

    it("cannot reach another workspace's company", async () => {
      const company = await makeCompany(bob.workspaceId);

      const result = await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      expect(result.skipped).toBe("Company not found");
      expect(await db.signal.count()).toBe(0);
    });

    it("skips a company that does not exist", async () => {
      const result = await refreshCompanySignals({
        workspaceId: alice.workspaceId,
        companyId: "nope",
      });

      expect(result.skipped).toBe("Company not found");
    });
  });

  it("stores no signals for a company with nothing observable", async () => {
    const company = await db.company.create({
      data: {
        workspaceId: alice.workspaceId,
        name: "Empty Co",
        canonicalName: "empty co",
      },
    });

    const result = await refreshCompanySignals({
      workspaceId: alice.workspaceId,
      companyId: company.id,
    });

    // No invented signals for an empty record.
    expect(result.signalsDetected).toBe(0);
    expect(await db.opportunity.count()).toBe(0);
  });

  it("accepts extra facts the caller gathered", async () => {
    const company = await makeCompany(alice.workspaceId, {
      website: "https://acme.test",
    });

    await refreshCompanySignals({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      facts: { hiringAreas: ["MARKETING"] },
    });

    const signal = await db.signal.findFirst({
      where: { companyId: company.id, type: "MARKETING_JOB" },
    });
    expect(signal).not.toBeNull();
  });
});

describe("refreshAllSignals", () => {
  it("processes every active company", async () => {
    for (let i = 0; i < 3; i++) {
      await makeCompany(alice.workspaceId, {
        canonicalDomain: `c${i}.test`,
        canonicalName: `company ${i}`,
      });
    }

    const results = await refreshAllSignals({ workspaceId: alice.workspaceId });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.signalsCreated > 0)).toBe(true);
  });

  it("skips archived companies", async () => {
    await makeCompany(alice.workspaceId, {
      canonicalDomain: "a.test",
      archivedAt: new Date(),
    });
    await makeCompany(alice.workspaceId, { canonicalDomain: "b.test" });

    const results = await refreshAllSignals({ workspaceId: alice.workspaceId });

    expect(results).toHaveLength(1);
  });

  it("stays inside the caller's workspace", async () => {
    await makeCompany(alice.workspaceId, { canonicalDomain: "a.test" });
    await makeCompany(bob.workspaceId, { canonicalDomain: "b.test" });

    await refreshAllSignals({ workspaceId: alice.workspaceId });

    expect(await db.signal.count({ where: { workspaceId: bob.workspaceId } })).toBe(0);
  });
});
