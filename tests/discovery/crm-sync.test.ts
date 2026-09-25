import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const { syncAllCompanies, syncCompanyToLead, SYNCABLE_FIELDS } = await import(
  "@/lib/discovery/crm-sync"
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
      website: "https://acme.test",
      email: "hello@acme.test",
      phone: "+441234567890",
      city: "Leeds",
      country: "GB",
      industry: "Dentistry",
      ...overrides,
    },
  });
}

describe("syncCompanyToLead", () => {
  it("creates a lead from a discovered company when asked", async () => {
    const company = await makeCompany(alice.workspaceId);

    const result = await syncCompanyToLead({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      createIfMissing: true,
    });

    expect(result.kind).toBe("CREATED");

    const lead = await db.lead.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });
    expect(lead.companyName).toBe("Acme Dental");
    expect(lead.email).toBe("hello@acme.test");
    expect(lead.companyId).toBe(company.id);
  });

  it("does not create a lead unless explicitly asked", async () => {
    const company = await makeCompany(alice.workspaceId);

    const result = await syncCompanyToLead({
      workspaceId: alice.workspaceId,
      companyId: company.id,
    });

    // Discovering a company is not the same as deciding to pursue it.
    expect(result.kind).toBe("SKIPPED");
    expect(await db.lead.count()).toBe(0);
  });

  it("fills only the empty fields on an existing lead", async () => {
    const company = await makeCompany(alice.workspaceId);
    const lead = await db.lead.create({
      data: {
        workspaceId: alice.workspaceId,
        companyId: company.id,
        companyName: "Acme Dental",
        email: "owner@acme.test",
      },
    });

    const result = await syncCompanyToLead({
      workspaceId: alice.workspaceId,
      companyId: company.id,
    });

    expect(result.kind).toBe("UPDATED");

    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.phone).toBe("+441234567890");
    expect(after.city).toBe("Leeds");
  });

  describe("the permanent-CRM guarantee", () => {
    it("never overwrites a value a person already entered", async () => {
      const company = await makeCompany(alice.workspaceId, {
        email: "info@acme.test",
        phone: "+449999999999",
        city: "Manchester",
      });

      const lead = await db.lead.create({
        data: {
          workspaceId: alice.workspaceId,
          companyId: company.id,
          companyName: "Acme Dental",
          email: "owner-direct@acme.test",
          phone: "+441111111111",
          city: "Leeds",
        },
      });

      const result = await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });

      // The crawler is confident and still does not get to win. A phone call
      // beats a web page, and the engine cannot tell which is which.
      expect(after.email).toBe("owner-direct@acme.test");
      expect(after.phone).toBe("+441111111111");
      expect(after.city).toBe("Leeds");

      if (result.kind === "UPDATED" || result.kind === "UNCHANGED") {
        const emailSync = result.fields.find((f) => f.field === "email");
        expect(emailSync?.reason).toBe("ALREADY_SET");
        expect(emailSync?.applied).toBe(false);
      }
    });

    it("treats a whitespace-only lead value as empty", async () => {
      const company = await makeCompany(alice.workspaceId);
      const lead = await db.lead.create({
        data: {
          workspaceId: alice.workspaceId,
          companyId: company.id,
          companyName: "Acme Dental",
          email: "   ",
        },
      });

      await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(after.email).toBe("hello@acme.test");
    });

    it("leaves a field null rather than inventing a value", async () => {
      const company = await makeCompany(alice.workspaceId, {
        phone: null,
        industry: null,
      });

      await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        createIfMissing: true,
      });

      const lead = await db.lead.findFirstOrThrow({
        where: { workspaceId: alice.workspaceId },
      });
      expect(lead.phone).toBeNull();
      expect(lead.industry).toBeNull();
    });

    it("deletes nothing, ever", async () => {
      const company = await makeCompany(alice.workspaceId);
      const lead = await db.lead.create({
        data: {
          workspaceId: alice.workspaceId,
          companyId: company.id,
          companyName: "Acme Dental",
        },
      });

      await db.activity.create({
        data: {
          workspaceId: alice.workspaceId,
          leadId: lead.id,
          type: "NOTE_ADDED",
          title: "Spoke to the owner",
        },
      });
      await db.task.create({
        data: {
          workspaceId: alice.workspaceId,
          leadId: lead.id,
          title: "Send quote",
          // Tasks are always human-created; the column is required.
          createdByUserId: alice.userId,
        },
      });

      const activitiesBefore = await db.activity.count();
      await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      expect(await db.lead.count({ where: { deletedAt: null } })).toBe(1);
      expect(await db.task.count()).toBe(1);
      // Sync only ever adds to the activity trail.
      expect(await db.activity.count()).toBeGreaterThanOrEqual(activitiesBefore);
    });

    it("does not resurrect an archived lead", async () => {
      const company = await makeCompany(alice.workspaceId);
      await db.lead.create({
        data: {
          workspaceId: alice.workspaceId,
          companyId: company.id,
          companyName: "Acme Dental",
          deletedAt: new Date(),
        },
      });

      const result = await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      // Archiving is a decision. Sync must not quietly reverse it.
      expect(result.kind).toBe("SKIPPED");

      const leads = await db.lead.findMany();
      expect(leads).toHaveLength(1);
      expect(leads[0].deletedAt).not.toBeNull();
    });
  });

  describe("records it refuses to touch", () => {
    it("skips an archived company", async () => {
      const company = await makeCompany(alice.workspaceId, {
        archivedAt: new Date(),
      });

      const result = await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        createIfMissing: true,
      });

      expect(result.kind).toBe("SKIPPED");
      expect(await db.lead.count()).toBe(0);
    });

    it("skips a company awaiting resolution review", async () => {
      const company = await makeCompany(alice.workspaceId, {
        resolutionState: "NEEDS_REVIEW",
      });

      const result = await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        createIfMissing: true,
      });

      // It might be two businesses sharing a name. Merging them into one lead
      // is the hardest mistake to unpick later.
      expect(result.kind).toBe("SKIPPED");
      expect(await db.lead.count()).toBe(0);
    });

    it("skips a company that does not exist", async () => {
      const result = await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: "does-not-exist",
        createIfMissing: true,
      });

      expect(result.kind).toBe("SKIPPED");
    });
  });

  describe("workspace isolation", () => {
    it("cannot reach a company in another workspace", async () => {
      const company = await makeCompany(bob.workspaceId);

      const result = await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        createIfMissing: true,
      });

      expect(result.kind).toBe("SKIPPED");
      expect(await db.lead.count()).toBe(0);
    });

    it("creates the lead in the company's own workspace", async () => {
      const company = await makeCompany(bob.workspaceId);

      await syncCompanyToLead({
        workspaceId: bob.workspaceId,
        companyId: company.id,
        createIfMissing: true,
      });

      expect(await db.lead.count({ where: { workspaceId: alice.workspaceId } })).toBe(0);
      expect(await db.lead.count({ where: { workspaceId: bob.workspaceId } })).toBe(1);
    });
  });

  describe("audit trail", () => {
    it("records which fields it filled and what they were before", async () => {
      const company = await makeCompany(alice.workspaceId);
      const lead = await db.lead.create({
        data: {
          workspaceId: alice.workspaceId,
          companyId: company.id,
          companyName: "Acme Dental",
        },
      });

      await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      const activity = await db.activity.findFirstOrThrow({
        where: { leadId: lead.id, type: "LEAD_UPDATED" },
      });

      const metadata = activity.metadata as {
        source: string;
        companyId: string;
        changed: Array<{ field: string; from: string | null; to: string }>;
      };

      expect(metadata.source).toBe("DISCOVERY");
      expect(metadata.companyId).toBe(company.id);
      expect(metadata.changed.some((c) => c.field === "email")).toBe(true);
    });

    it("attributes machine writes to no user", async () => {
      const company = await makeCompany(alice.workspaceId);

      await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        createIfMissing: true,
      });

      const activity = await db.activity.findFirstOrThrow({
        where: { workspaceId: alice.workspaceId },
      });

      // Null author is how the CRM tells a crawler from a person.
      expect(activity.createdByUserId).toBeNull();
    });

    it("writes no activity when nothing changed", async () => {
      const company = await makeCompany(alice.workspaceId, {
        email: null,
        phone: null,
        website: null,
        city: null,
        country: null,
        industry: null,
      });
      const lead = await db.lead.create({
        data: {
          workspaceId: alice.workspaceId,
          companyId: company.id,
          companyName: "Acme Dental",
        },
      });

      const result = await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      expect(result.kind).toBe("UNCHANGED");
      // A no-op run must not pad the timeline with noise.
      expect(await db.activity.count({ where: { leadId: lead.id } })).toBe(0);
    });
  });

  describe("scoring", () => {
    it("scores a lead it creates", async () => {
      const company = await makeCompany(alice.workspaceId);

      const result = await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        createIfMissing: true,
      });

      if (result.kind !== "CREATED") throw new Error("expected CREATED");

      // Reachable + firmographics, per the deterministic model.
      expect(result.score).toBeGreaterThan(0);

      const lead = await db.lead.findUniqueOrThrow({ where: { id: result.leadId } });
      expect(lead.score).toBe(result.score);
    });

    it("rescores after filling fields", async () => {
      const company = await makeCompany(alice.workspaceId);
      const lead = await db.lead.create({
        data: {
          workspaceId: alice.workspaceId,
          companyId: company.id,
          companyName: "Acme Dental",
        },
      });

      expect(lead.score).toBe(0);

      await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
      });

      const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(after.score).toBeGreaterThan(0);
    });
  });

  describe("idempotency", () => {
    it("is a no-op the second time", async () => {
      const company = await makeCompany(alice.workspaceId);

      await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        createIfMissing: true,
      });
      const second = await syncCompanyToLead({
        workspaceId: alice.workspaceId,
        companyId: company.id,
        createIfMissing: true,
      });

      expect(second.kind).toBe("UNCHANGED");
      expect(await db.lead.count()).toBe(1);
    });

    it("does not create a duplicate lead for one company", async () => {
      const company = await makeCompany(alice.workspaceId);

      for (let i = 0; i < 3; i++) {
        await syncCompanyToLead({
          workspaceId: alice.workspaceId,
          companyId: company.id,
          createIfMissing: true,
        });
      }

      expect(await db.lead.count({ where: { companyId: company.id } })).toBe(1);
    });
  });

  it("maps every syncable field onto the lead", async () => {
    const company = await makeCompany(alice.workspaceId, {
      linkedinUrl: "https://linkedin.com/company/acme",
      instagramUrl: "https://instagram.com/acme",
      facebookUrl: "https://facebook.com/acme",
      companySize: "10-50",
    });

    await syncCompanyToLead({
      workspaceId: alice.workspaceId,
      companyId: company.id,
      createIfMissing: true,
    });

    const lead = await db.lead.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });

    for (const field of SYNCABLE_FIELDS) {
      expect(lead[field as keyof typeof lead]).not.toBeNull();
    }
  });
});

describe("syncAllCompanies", () => {
  it("syncs every eligible company", async () => {
    for (let i = 0; i < 3; i++) {
      await db.company.create({
        data: {
          workspaceId: alice.workspaceId,
          name: `Company ${i}`,
          canonicalName: `company ${i}`,
          canonicalDomain: `c${i}.test`,
          email: `hi@c${i}.test`,
        },
      });
    }

    const results = await syncAllCompanies({
      workspaceId: alice.workspaceId,
      createIfMissing: true,
    });

    expect(results.filter((r) => r.kind === "CREATED")).toHaveLength(3);
    expect(await db.lead.count()).toBe(3);
  });

  it("leaves archived and unresolved companies alone", async () => {
    await makeCompany(alice.workspaceId, {
      canonicalDomain: "a.test",
      archivedAt: new Date(),
    });
    await makeCompany(alice.workspaceId, {
      canonicalDomain: "b.test",
      resolutionState: "NEEDS_REVIEW",
    });
    await makeCompany(alice.workspaceId, { canonicalDomain: "c.test" });

    const results = await syncAllCompanies({
      workspaceId: alice.workspaceId,
      createIfMissing: true,
    });

    expect(results).toHaveLength(1);
    expect(await db.lead.count()).toBe(1);
  });

  it("only touches the caller's workspace", async () => {
    await makeCompany(alice.workspaceId, { canonicalDomain: "a.test" });
    await makeCompany(bob.workspaceId, { canonicalDomain: "b.test" });

    await syncAllCompanies({
      workspaceId: alice.workspaceId,
      createIfMissing: true,
    });

    expect(await db.lead.count({ where: { workspaceId: bob.workspaceId } })).toBe(0);
  });

  it("returns an empty list for a workspace with no companies", async () => {
    expect(
      await syncAllCompanies({ workspaceId: alice.workspaceId, createIfMissing: true }),
    ).toEqual([]);
  });
});
