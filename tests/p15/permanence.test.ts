/**
 * P15 §7, §12, §13 — the permanent-CRM guarantee, against the real database.
 *
 * This is the promise the whole product rests on: a human's work is never
 * destroyed by an automated process. Discovery may add and enrich; it may
 * never delete, replace or downgrade. These tests assert that with real rows
 * in real PostgreSQL rather than by reading the code and trusting it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { syncCompanyToLead } from "@/lib/discovery/crm-sync";
import { ingestDiscoveredEntity } from "@/lib/discovery/ingest";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";

let ws: SeededWorkspace;

beforeAll(async () => {
  await resetTestDatabase();
}, 180_000);

beforeEach(async () => {
  await truncateAll();
  ws = await seedWorkspace("Permanence");
});

afterAll(async () => {
  await disconnectTestPrisma();
});


/**
 * Ingests a batch of entities one at a time and rolls the per-entity results
 * up into the aggregate shape these tests assert against.
 */
async function ingestOne(
  sourceId: string,
  entities: Array<Parameters<typeof ingestDiscoveredEntity>[0]["entity"]>,
) {
  let companiesCreated = 0;
  let companiesMatched = 0;
  const companyIds: string[] = [];

  for (const entity of entities) {
    const result = await ingestDiscoveredEntity({
      workspaceId: ws.workspaceId,
      entity: { ...entity, sourceId },
    });

    if (result.kind === "INGESTED") {
      if (result.created) companiesCreated += 1;
      else companiesMatched += 1;
      companyIds.push(result.companyId);
    } else if (result.kind === "NEEDS_REVIEW") {
      companyIds.push(result.companyId);
    }
  }

  return { companiesCreated, companiesMatched, companyIds };
}

async function makeSource(name = "p15-source") {
  return db.source.create({
    data: { workspaceId: ws.workspaceId, provider: "website", name },
  });
}

describe("§7 human work survives discovery", () => {
  it("never deletes or replaces a human lead, contact, note or activity", async () => {
    // --- A human builds a record by hand. -------------------------------
    const lead = await db.lead.create({
      data: {
        workspaceId: ws.workspaceId,
        companyName: "Northwind Dental",
        website: "https://northwind-dental.example",
        contactName: "Dr. Alice Human",
        email: "alice@northwind-dental.example",
        phone: "+44 20 7946 0000",
        qualificationNotes: "Met at a conference. Prefers email. Budget approx 3k.",
        status: "QUALIFIED",
      },
    });

    const contact = await db.contact.create({
      data: {
        workspaceId: ws.workspaceId,
        leadId: lead.id,
        fullName: "Dr. Alice Human",
        email: "alice@northwind-dental.example",
        isPrimary: true,
        isDecisionMaker: true,
      },
    });

    const activity = await db.activity.create({
      data: {
        workspaceId: ws.workspaceId,
        leadId: lead.id,
        type: "NOTE_ADDED",
        title: "Discovery call booked",
        description: "Alice asked for a quote for a 5-page site.",
        createdByUserId: ws.userId,
      },
    });

    const task = await db.task.create({
      data: {
        workspaceId: ws.workspaceId,
        leadId: lead.id,
        title: "Send proposal",
        createdByUserId: ws.userId,
      },
    });

    // --- Discovery independently finds the same business. ----------------
    const source = await makeSource();
    const ingest = await ingestOne(source.id, [
        {
          identity: {
            name: "Northwind Dental Ltd",
            website: "https://northwind-dental.example",
            domain: "northwind-dental.example",
          },
          facts: [
            {
              field: "website",
              value: "https://northwind-dental.example",
              method: "STRUCTURED_DATA",
              sourceUrl: "https://northwind-dental.example/",
              evidence: "Homepage",
            },
            {
              // A weaker, generic address than the human's named contact.
              field: "email",
              value: "reception@northwind-dental.example",
              method: "TEXT_HEURISTIC",
              sourceUrl: "https://northwind-dental.example/contact",
              evidence: "Contact page mailto link",
            },
            {
              field: "industry",
              value: "Dentistry",
              method: "META_TAG",
              sourceUrl: "https://northwind-dental.example/",
              evidence: "meta description",
            },
          ],
        },
      ]);

    expect(ingest.companiesCreated).toBe(1);
    const companyId = ingest.companyIds[0];

    await syncCompanyToLead({ workspaceId: ws.workspaceId, companyId });

    // --- Nothing the human created may be gone. --------------------------
    const leadAfter = await db.lead.findUnique({ where: { id: lead.id } });
    expect(leadAfter).not.toBeNull();
    expect(leadAfter?.deletedAt).toBeNull();

    // Human-entered values outrank anything a crawler inferred. contactName is
    // not even in the crawler's field map: a machine never renames a person.
    expect(leadAfter?.contactName).toBe("Dr. Alice Human");
    expect(leadAfter?.qualificationNotes).toBe(
      "Met at a conference. Prefers email. Budget approx 3k.",
    );
    expect(leadAfter?.email).toBe("alice@northwind-dental.example");
    expect(leadAfter?.phone).toBe("+44 20 7946 0000");
    expect(leadAfter?.status).toBe("QUALIFIED");

    expect(await db.contact.findUnique({ where: { id: contact.id } })).not.toBeNull();
    expect(await db.activity.findUnique({ where: { id: activity.id } })).not.toBeNull();
    expect(await db.task.findUnique({ where: { id: task.id } })).not.toBeNull();

    // Counts must not have shrunk: no silent replacement.
    expect(await db.lead.count({ where: { workspaceId: ws.workspaceId } })).toBe(1);
    expect(await db.contact.count({ where: { workspaceId: ws.workspaceId } })).toBe(1);
  });

  it("fills a blank field but never overwrites a populated one", async () => {
    const lead = await db.lead.create({
      data: {
        workspaceId: ws.workspaceId,
        companyName: "Blank Fields Ltd",
        website: "https://blankfields.example",
        // industry deliberately left NULL; phone deliberately set by a human.
        phone: "+44 111 111 1111",
      },
    });

    const source = await makeSource();
    const ingest = await ingestOne(source.id, [
        {
          identity: {
            name: "Blank Fields Ltd",
            website: "https://blankfields.example",
            domain: "blankfields.example",
          },
          facts: [
            {
              field: "industry",
              value: "Landscaping",
              method: "STRUCTURED_DATA",
              sourceUrl: "https://blankfields.example/",
              evidence: "JSON-LD",
            },
            {
              field: "phone",
              value: "+44 999 999 9999",
              method: "STRUCTURED_DATA",
              sourceUrl: "https://blankfields.example/contact",
              evidence: "JSON-LD telephone",
            },
          ],
        },
      ]);

    // A lead is matched to a company by companyId. In the real flow that link
    // is made when the human's lead is recognised as the discovered business;
    // here it is set explicitly so the sync has something to enrich.
    await db.lead.update({
      where: { id: lead.id },
      data: { companyId: ingest.companyIds[0] },
    });

    await syncCompanyToLead({
      workspaceId: ws.workspaceId,
      companyId: ingest.companyIds[0],
    });

    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });

    // The empty field is enriched...
    expect(after.industry).toBe("Landscaping");
    // ...and the human's phone number is left exactly alone, even though the
    // crawler's value came from a higher-confidence method. A human edit is
    // not a data-quality problem to be corrected.
    expect(after.phone).toBe("+44 111 111 1111");
  });

  it("explains every change it makes, attributed to the machine", async () => {
    const lead = await db.lead.create({
      data: {
        workspaceId: ws.workspaceId,
        companyName: "Explainable Ltd",
        website: "https://explainable.example",
      },
    });

    const source = await makeSource();
    const ingest = await ingestOne(source.id, [
        {
          identity: {
            name: "Explainable Ltd",
            website: "https://explainable.example",
            domain: "explainable.example",
          },
          facts: [
            {
              field: "industry",
              value: "Bakery",
              method: "STRUCTURED_DATA",
              sourceUrl: "https://explainable.example/",
              evidence: "JSON-LD",
            },
          ],
        },
      ]);

    await db.lead.update({
      where: { id: lead.id },
      data: { companyId: ingest.companyIds[0] },
    });

    await syncCompanyToLead({
      workspaceId: ws.workspaceId,
      companyId: ingest.companyIds[0],
    });

    const activities = await db.activity.findMany({
      where: { workspaceId: ws.workspaceId },
    });
    expect(activities.length).toBeGreaterThan(0);

    const machine = activities.find((a) => a.createdByUserId === null);
    expect(machine).toBeDefined();
    // Attributed to no user: a human reading the timeline can tell at a glance
    // that they did not make this change.
    expect(machine?.createdByUserId).toBeNull();
  });
});

describe("§12 repeated discovery is idempotent", () => {
  it("ingesting the identical payload twice creates one company", async () => {
    const source = await makeSource();
    const entity = {
      identity: {
        name: "Repeat Ltd",
        website: "https://repeat.example",
        domain: "repeat.example",
      },
      facts: [
        {
          field: "website" as const,
          value: "https://repeat.example",
          method: "STRUCTURED_DATA" as const,
          sourceUrl: "https://repeat.example/",
          evidence: "Homepage",
        },
      ],
    };

    const first = await ingestOne(source.id, [entity]);
    const second = await ingestOne(source.id, [entity]);

    expect(first.companiesCreated).toBe(1);
    expect(second.companiesCreated).toBe(0);
    expect(second.companiesMatched).toBe(1);
    expect(await db.company.count({ where: { workspaceId: ws.workspaceId } })).toBe(1);

    // Syncing twice must not produce two leads for one company.
    await syncCompanyToLead({
      workspaceId: ws.workspaceId,
      companyId: first.companyIds[0],
      createIfMissing: true,
    });
    await syncCompanyToLead({
      workspaceId: ws.workspaceId,
      companyId: first.companyIds[0],
      createIfMissing: true,
    });
    expect(await db.lead.count({ where: { workspaceId: ws.workspaceId } })).toBe(1);
  });

  it("a second unchanged sync writes no new activity", async () => {
    const source = await makeSource();
    const ingest = await ingestOne(source.id, [
        {
          identity: {
            name: "Quiet Ltd",
            website: "https://quiet.example",
            domain: "quiet.example",
          },
          facts: [
            {
              field: "industry",
              value: "Cafe",
              method: "STRUCTURED_DATA",
              sourceUrl: "https://quiet.example/",
              evidence: "JSON-LD",
            },
          ],
        },
      ]);

    await syncCompanyToLead({
      workspaceId: ws.workspaceId,
      companyId: ingest.companyIds[0],
      createIfMissing: true,
    });
    const afterFirst = await db.activity.count({ where: { workspaceId: ws.workspaceId } });

    await syncCompanyToLead({
      workspaceId: ws.workspaceId,
      companyId: ingest.companyIds[0],
      createIfMissing: true,
    });
    const afterSecond = await db.activity.count({ where: { workspaceId: ws.workspaceId } });

    // A no-op sync that still logged "I changed nothing" would make the
    // timeline useless within a week.
    expect(afterSecond).toBe(afterFirst);
  });
});

describe("§13 changed information keeps its history", () => {
  it("keeps the old observation alongside the new one", async () => {
    const source = await makeSource();

    const first = await ingestOne(source.id, [
        {
          identity: {
            name: "Changing Ltd",
            website: "https://changing.example",
            domain: "changing.example",
          },
          facts: [
            {
              field: "phone",
              value: "+44 100 000 0001",
              method: "STRUCTURED_DATA",
              sourceUrl: "https://changing.example/contact",
              evidence: "JSON-LD telephone (January)",
            },
          ],
        },
      ]);

    const companyId = first.companyIds[0];

    await ingestOne(source.id, [
        {
          identity: {
            name: "Changing Ltd",
            website: "https://changing.example",
            domain: "changing.example",
          },
          facts: [
            {
              field: "phone",
              value: "+44 200 000 0002",
              method: "STRUCTURED_DATA",
              sourceUrl: "https://changing.example/contact",
              evidence: "JSON-LD telephone (February)",
            },
          ],
        },
      ]);

    const observations = await db.observation.findMany({
      where: { workspaceId: ws.workspaceId, companyId, field: "phone" },
      orderBy: { observedAt: "asc" },
    });

    // Both readings survive. Overwriting would destroy the ability to answer
    // "when did this change, and what did it used to be?"
    expect(observations.length).toBe(2);
    // Stored normalised (spaces stripped): the engine canonicalises a phone
    // number so that two spellings of one number are recognised as equal.
    expect(observations.map((o) => o.value)).toEqual([
      "+441000000001",
      "+442000000002",
    ]);

    for (const o of observations) {
      expect(o.sourceUrl).toBeTruthy();
      expect(o.observedAt).toBeTruthy();
      expect(o.confidence).toBeGreaterThan(0);
      expect(o.evidence).toBeTruthy();
    }

    // The company carries the current value.
    const company = await db.company.findUniqueOrThrow({ where: { id: companyId } });
    expect(company.phone).toBe("+442000000002");
  });

  it("does not let a weaker method overwrite a stronger stored value", async () => {
    const source = await makeSource();

    const first = await ingestOne(source.id, [
        {
          identity: {
            name: "Strong Ltd",
            website: "https://strong.example",
            domain: "strong.example",
          },
          facts: [
            {
              field: "industry",
              value: "Veterinary",
              method: "STRUCTURED_DATA",
              sourceUrl: "https://strong.example/",
              evidence: "JSON-LD",
            },
          ],
        },
      ]);

    await ingestOne(source.id, [
        {
          identity: {
            name: "Strong Ltd",
            website: "https://strong.example",
            domain: "strong.example",
          },
          facts: [
            {
              field: "industry",
              value: "Probably pets",
              method: "TEXT_HEURISTIC",
              sourceUrl: "https://strong.example/about",
              evidence: "Guessed from prose",
            },
          ],
        },
      ]);

    const company = await db.company.findUniqueOrThrow({
      where: { id: first.companyIds[0] },
    });
    expect(company.industry).toBe("Veterinary");

    // The weaker reading is still recorded as history, just not promoted.
    const all = await db.observation.findMany({
      where: { workspaceId: ws.workspaceId, field: "industry" },
    });
    expect(all.length).toBe(2);
  });
});
