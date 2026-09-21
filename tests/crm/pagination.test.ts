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

const { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, listLeads } = await import(
  "@/lib/crm/leads"
);

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

/**
 * Creates `count` leads directly via Prisma.
 *
 * These are structural test rows (numbered placeholders), not demo business
 * data: they exist only to exercise the paging arithmetic.
 */
async function seedLeads(workspaceId: string, count: number) {
  await db.lead.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      workspaceId,
      companyName: `Lead ${String(index + 1).padStart(3, "0")}`,
      status: "NEW" as const,
      createdAt: new Date(Date.now() - index * 60_000),
    })),
  });
}

describe("lead pagination", () => {
  it("defaults to 25 per page", async () => {
    await seedLeads(alice.workspaceId, 30);

    const page = await listLeads();

    expect(DEFAULT_PAGE_SIZE).toBe(25);
    expect(page.pageSize).toBe(25);
    expect(page.items).toHaveLength(25);
    expect(page.page).toBe(1);
    expect(page.total).toBe(30);
    expect(page.totalPages).toBe(2);
  });

  it("returns the remainder on page 2 with no overlap", async () => {
    await seedLeads(alice.workspaceId, 30);

    const first = await listLeads({ page: 1 });
    const second = await listLeads({ page: 2 });

    expect(second.items).toHaveLength(5);
    expect(second.page).toBe(2);

    const firstIds = new Set(first.items.map((lead) => lead.id));
    expect(second.items.some((lead) => firstIds.has(lead.id))).toBe(false);

    // Together the pages cover every record exactly once.
    expect(new Set([...firstIds, ...second.items.map((lead) => lead.id)]).size).toBe(30);
  });

  it("caps the page size at 100 however large a value is requested", async () => {
    await seedLeads(alice.workspaceId, 5);

    const huge = await listLeads({ pageSize: 100_000 });

    expect(MAX_PAGE_SIZE).toBe(100);
    expect(huge.pageSize).toBe(100);
    expect(huge.items).toHaveLength(5);
  });

  it("honours a smaller explicit page size", async () => {
    await seedLeads(alice.workspaceId, 10);

    const page = await listLeads({ pageSize: 4, page: 3 });

    expect(page.pageSize).toBe(4);
    expect(page.items).toHaveLength(2);
    expect(page.totalPages).toBe(3);
  });

  it("falls back to sane values for junk paging input", async () => {
    await seedLeads(alice.workspaceId, 3);

    for (const page of [0, -5, Number.NaN]) {
      expect((await listLeads({ page })).page).toBe(1);
    }

    for (const pageSize of [0, -10, Number.NaN]) {
      expect((await listLeads({ pageSize })).pageSize).toBe(DEFAULT_PAGE_SIZE);
    }
  });

  it("returns an honest empty page beyond the end of the data", async () => {
    await seedLeads(alice.workspaceId, 3);

    const page = await listLeads({ page: 99 });

    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(3);
    expect(page.page).toBe(99);
  });

  it("reports totalPages as 1 for an empty workspace", async () => {
    const page = await listLeads();

    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(0);
    expect(page.totalPages).toBe(1);
  });

  it("counts only the caller's own leads", async () => {
    await seedLeads(alice.workspaceId, 30);
    await seedLeads(bob.workspaceId, 7);

    const alicePage = await listLeads();
    expect(alicePage.total).toBe(30);

    actAs(bob);
    const bobPage = await listLeads();
    expect(bobPage.total).toBe(7);
    expect(bobPage.items.every((lead) => lead.workspaceId === bob.workspaceId)).toBe(true);
  });
});

describe("lead search and filtering", () => {
  beforeEach(async () => {
    await db.lead.createMany({
      data: [
        {
          workspaceId: alice.workspaceId,
          companyName: "Northwind Bakery",
          contactName: "Priya Raman",
          email: "priya@northwind.test",
          website: "https://northwind.test",
          source: "Referral",
          status: "NEW",
          score: 10,
        },
        {
          workspaceId: alice.workspaceId,
          companyName: "Southgate Dental",
          contactName: "Arun Kumar",
          email: "arun@southgate.test",
          website: "https://southgate.test",
          source: "Cold outreach",
          status: "QUALIFIED",
          score: 70,
        },
        {
          workspaceId: bob.workspaceId,
          companyName: "Northwind Rivals",
          status: "NEW",
          score: 90,
        },
      ],
    });
  });

  it("searches company name", async () => {
    const result = await listLeads({ search: "northwind" });

    expect(result.items.map((lead) => lead.companyName)).toEqual(["Northwind Bakery"]);
  });

  it("searches contact name, email and website", async () => {
    expect((await listLeads({ search: "Arun" })).items).toHaveLength(1);
    expect((await listLeads({ search: "priya@northwind" })).items).toHaveLength(1);
    expect((await listLeads({ search: "southgate.test" })).items).toHaveLength(1);
  });

  it("is case-insensitive", async () => {
    expect((await listLeads({ search: "NORTHWIND" })).items).toHaveLength(1);
    expect((await listLeads({ search: "northwind" })).items).toHaveLength(1);
  });

  it("filters by status, source and minimum score", async () => {
    expect((await listLeads({ status: "QUALIFIED" })).items).toHaveLength(1);
    expect((await listLeads({ source: "Referral" })).items).toHaveLength(1);
    expect((await listLeads({ minScore: 50 })).items).toHaveLength(1);
    expect((await listLeads({ minScore: 95 })).items).toHaveLength(0);
  });

  it("combines filters and reports a correct total", async () => {
    const result = await listLeads({ search: "north", status: "NEW", pageSize: 10 });

    expect(result.total).toBe(1);
    expect(result.items[0].companyName).toBe("Northwind Bakery");
  });

  it("never leaks another workspace's matches", async () => {
    // Bob owns a lead whose name also matches "northwind".
    const result = await listLeads({ search: "northwind" });

    expect(result.total).toBe(1);
    expect(result.items.every((lead) => lead.workspaceId === alice.workspaceId)).toBe(true);
  });

  it("lists the distinct sources actually used in the workspace", async () => {
    const { listLeadSources } = await import("@/lib/crm/leads");

    expect(await listLeadSources()).toEqual(["Cold outreach", "Referral"]);
  });
});
