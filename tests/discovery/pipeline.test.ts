import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ProviderRegistry, type DiscoveryProvider } from "@/lib/discovery/provider";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

const { runAllSources, runSource } = await import("@/lib/discovery/pipeline");

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

/** A fetcher that must never be called. */
const unusedFetcher = {
  fetch: async () => {
    throw new Error("network should not be used in this test");
  },
};

function emptyRun() {
  return {
    entities: [],
    pagesAttempted: 0,
    pagesSucceeded: 0,
    pagesFailed: 0,
    pagesBlocked: 0,
    warnings: [],
  };
}

/** A provider that returns a fixed set of entities. */
function fakeProvider(
  key: string,
  entities: Array<{ name: string; website: string }>,
  overrides: Partial<DiscoveryProvider> = {},
): DiscoveryProvider {
  return {
    key,
    label: key,
    category: "MANUAL",
    requiresNetwork: false,
    async run() {
      return {
        ...emptyRun(),
        pagesAttempted: 1,
        pagesSucceeded: 1,
        entities: entities.map((e) => ({
          identity: { name: e.name, website: e.website },
          facts: [
            {
              field: "website" as const,
              value: e.website,
              method: "STRUCTURED_DATA" as const,
            },
          ],
        })),
      };
    },
    ...overrides,
  };
}

async function makeSource(
  workspaceId: string,
  provider: string,
  name = provider,
  extra: Record<string, unknown> = {},
) {
  return db.source.create({
    data: { workspaceId, provider, name, ...extra },
  });
}

describe("runSource", () => {
  it("runs a provider and stores the companies it found", async () => {
    const registry = new ProviderRegistry().register(
      fakeProvider("fake", [{ name: "Acme Dental", website: "https://acme.test" }]),
    );

    const source = await makeSource(alice.workspaceId, "fake");

    const result = await runSource({
      workspaceId: alice.workspaceId,
      sourceId: source.id,
      registry,
      fetcher: unusedFetcher,
    });

    expect(result.ok).toBe(true);
    expect(result.entitiesValid).toBe(1);
    expect(result.companiesCreated).toBe(1);

    const company = await db.company.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId },
    });
    expect(company.name).toBe("Acme Dental");
  });

  it("rejects an unidentifiable entity instead of storing it", async () => {
    const broken: DiscoveryProvider = {
      key: "broken",
      label: "broken",
      category: "MANUAL",
      requiresNetwork: false,
      async run() {
        return {
          ...emptyRun(),
          entities: [
            // No name, no website: nothing identifiable.
            { identity: {}, facts: [] },
          ],
        };
      },
    };

    const registry = new ProviderRegistry().register(broken);
    const source = await makeSource(alice.workspaceId, "broken");

    const result = await runSource({
      workspaceId: alice.workspaceId,
      sourceId: source.id,
      registry,
      fetcher: unusedFetcher,
    });

    expect(result.entitiesRejected).toBe(1);
    expect(await db.company.count()).toBe(0);
  });

  describe("failure containment", () => {
    it("records a provider that throws without propagating", async () => {
      const exploding: DiscoveryProvider = {
        key: "exploding",
        label: "exploding",
        category: "MANUAL",
        requiresNetwork: false,
        async run() {
          throw new Error("provider is broken");
        },
      };

      const registry = new ProviderRegistry().register(exploding);
      const source = await makeSource(alice.workspaceId, "exploding");

      // The decisive property: this resolves rather than rejecting.
      const result = await runSource({
        workspaceId: alice.workspaceId,
        sourceId: source.id,
        registry,
        fetcher: unusedFetcher,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("provider is broken");

      const stored = await db.source.findUniqueOrThrow({ where: { id: source.id } });
      expect(stored.status).toBe("FAILING");
      expect(stored.lastError).toContain("provider is broken");
      expect(stored.failureCount).toBe(1);
    });

    it("reports an unknown provider key rather than crashing", async () => {
      const source = await makeSource(alice.workspaceId, "does-not-exist");

      const result = await runSource({
        workspaceId: alice.workspaceId,
        sourceId: source.id,
        registry: new ProviderRegistry(),
        fetcher: unusedFetcher,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unknown provider");
    });

    it("marks a source BLOCKED when every page was refused", async () => {
      const blocked: DiscoveryProvider = {
        key: "blocked",
        label: "blocked",
        category: "WEBSITE",
        requiresNetwork: true,
        async run() {
          return { ...emptyRun(), pagesAttempted: 3, pagesBlocked: 3 };
        },
      };

      const registry = new ProviderRegistry().register(blocked);
      const source = await makeSource(alice.workspaceId, "blocked");

      const result = await runSource({
        workspaceId: alice.workspaceId,
        sourceId: source.id,
        registry,
        fetcher: unusedFetcher,
      });

      // The run itself succeeded — being blocked is information, not a crash.
      expect(result.ok).toBe(true);
      expect(result.pagesBlocked).toBe(3);

      const stored = await db.source.findUniqueOrThrow({ where: { id: source.id } });
      expect(stored.status).toBe("BLOCKED");
      expect(stored.blockedCount).toBe(3);
    });
  });

  it("skips a disabled source", async () => {
    const registry = new ProviderRegistry().register(
      fakeProvider("fake", [{ name: "Acme", website: "https://acme.test" }]),
    );

    const source = await makeSource(alice.workspaceId, "fake", "fake", {
      enabled: false,
    });

    const result = await runSource({
      workspaceId: alice.workspaceId,
      sourceId: source.id,
      registry,
      fetcher: unusedFetcher,
    });

    expect(result.ok).toBe(true);
    expect(await db.company.count()).toBe(0);
  });

  it("updates source health counters after a run", async () => {
    const registry = new ProviderRegistry().register(
      fakeProvider("fake", [{ name: "Acme", website: "https://acme.test" }]),
    );

    const source = await makeSource(alice.workspaceId, "fake");

    await runSource({
      workspaceId: alice.workspaceId,
      sourceId: source.id,
      registry,
      fetcher: unusedFetcher,
    });

    const stored = await db.source.findUniqueOrThrow({ where: { id: source.id } });
    expect(stored.successCount).toBe(1);
    expect(stored.lastRunAt).not.toBeNull();
    expect(stored.nextRunAt).not.toBeNull();
    expect(stored.status).toBe("ACTIVE");
  });

  describe("workspace isolation", () => {
    it("refuses a source belonging to another workspace", async () => {
      const registry = new ProviderRegistry().register(
        fakeProvider("fake", [{ name: "Acme", website: "https://acme.test" }]),
      );

      const bobSource = await makeSource(bob.workspaceId, "fake");

      const result = await runSource({
        // Alice tries to run Bob's source.
        workspaceId: alice.workspaceId,
        sourceId: bobSource.id,
        registry,
        fetcher: unusedFetcher,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Source not found");
      expect(await db.company.count()).toBe(0);
    });

    it("stores companies against the running workspace only", async () => {
      const registry = new ProviderRegistry().register(
        fakeProvider("fake", [{ name: "Acme", website: "https://acme.test" }]),
      );

      const source = await makeSource(bob.workspaceId, "fake");

      await runSource({
        workspaceId: bob.workspaceId,
        sourceId: source.id,
        registry,
        fetcher: unusedFetcher,
      });

      expect(
        await db.company.count({ where: { workspaceId: alice.workspaceId } }),
      ).toBe(0);
      expect(
        await db.company.count({ where: { workspaceId: bob.workspaceId } }),
      ).toBe(1);
    });
  });

  describe("idempotency", () => {
    it("re-running a source does not duplicate companies", async () => {
      const registry = new ProviderRegistry().register(
        fakeProvider("fake", [{ name: "Acme Dental", website: "https://acme.test" }]),
      );

      const source = await makeSource(alice.workspaceId, "fake");

      const first = await runSource({
        workspaceId: alice.workspaceId,
        sourceId: source.id,
        registry,
        fetcher: unusedFetcher,
      });
      const second = await runSource({
        workspaceId: alice.workspaceId,
        sourceId: source.id,
        registry,
        fetcher: unusedFetcher,
      });

      expect(first.companiesCreated).toBe(1);
      expect(second.companiesCreated).toBe(0);
      expect(second.companiesMatched).toBe(1);
      expect(await db.company.count()).toBe(1);
    });
  });
});

describe("runAllSources", () => {
  it("continues past a broken source and still runs the healthy ones", async () => {
    const exploding: DiscoveryProvider = {
      key: "exploding",
      label: "exploding",
      category: "MANUAL",
      requiresNetwork: false,
      async run() {
        throw new Error("boom");
      },
    };

    const registry = new ProviderRegistry()
      .register(exploding)
      .register(fakeProvider("good", [{ name: "Good Co", website: "https://good.test" }]));

    // The broken source is created first, so it runs first.
    await makeSource(alice.workspaceId, "exploding", "broken source");
    await makeSource(alice.workspaceId, "good", "good source");

    const results = await runAllSources({
      workspaceId: alice.workspaceId,
      registry,
      fetcher: unusedFetcher,
    });

    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);

    // The healthy source's work landed despite the earlier failure.
    expect(await db.company.count({ where: { workspaceId: alice.workspaceId } })).toBe(
      1,
    );
  });

  it("keeps going when a source is blocked", async () => {
    const blocked: DiscoveryProvider = {
      key: "blocked",
      label: "blocked",
      category: "WEBSITE",
      requiresNetwork: true,
      async run() {
        return { ...emptyRun(), pagesAttempted: 2, pagesBlocked: 2 };
      },
    };

    const registry = new ProviderRegistry()
      .register(blocked)
      .register(fakeProvider("good", [{ name: "Good Co", website: "https://good.test" }]));

    await makeSource(alice.workspaceId, "blocked", "blocked source");
    await makeSource(alice.workspaceId, "good", "good source");

    const results = await runAllSources({
      workspaceId: alice.workspaceId,
      registry,
      fetcher: unusedFetcher,
    });

    expect(results.every((r) => r.ok)).toBe(true);
    expect(await db.company.count()).toBe(1);
  });

  it("runs only the caller's sources", async () => {
    const registry = new ProviderRegistry().register(
      fakeProvider("fake", [{ name: "Acme", website: "https://acme.test" }]),
    );

    await makeSource(alice.workspaceId, "fake", "alice source");
    await makeSource(bob.workspaceId, "fake", "bob source");

    const results = await runAllSources({
      workspaceId: alice.workspaceId,
      registry,
      fetcher: unusedFetcher,
    });

    expect(results).toHaveLength(1);
    expect(
      await db.company.count({ where: { workspaceId: bob.workspaceId } }),
    ).toBe(0);
  });

  it("does nothing when a workspace has no sources", async () => {
    const results = await runAllSources({
      workspaceId: alice.workspaceId,
      registry: new ProviderRegistry(),
      fetcher: unusedFetcher,
    });

    expect(results).toEqual([]);
  });

  it("honours the schedule when asked to", async () => {
    const registry = new ProviderRegistry().register(
      fakeProvider("fake", [{ name: "Acme", website: "https://acme.test" }]),
    );

    await makeSource(alice.workspaceId, "fake", "future", {
      nextRunAt: new Date(Date.now() + 3_600_000),
    });

    const results = await runAllSources({
      workspaceId: alice.workspaceId,
      registry,
      fetcher: unusedFetcher,
      respectSchedule: true,
    });

    expect(results).toHaveLength(0);
  });
});
