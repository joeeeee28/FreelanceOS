/**
 * Fetch logging.
 *
 * The log exists so that "the website could not be read" is a recorded fact
 * about a request that was actually made, rather than an inference drawn from
 * the absence of a result. These tests cover the recorder itself: what it
 * stores, what it trims, that a research fetch is recorded with no source, and
 * that a log failure never breaks the fetch that caused it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  LoggingFetcher,
  type FetchRecord,
  type FetchRecorder,
} from "@/lib/discovery/fetch-log";
import type { FetchedDocument, Fetcher } from "@/lib/discovery/provider";
import { seedWorkspace, type SeededWorkspace } from "../helpers/fixtures";
import { resetTestDatabase, truncateAll } from "../helpers/test-db";
import { db, disconnectTestPrisma } from "../helpers/test-prisma";

let alice: SeededWorkspace;
let bob: SeededWorkspace;

/** A transport that answers with whatever the test tells it to. */
function stubFetcher(document: Partial<FetchedDocument>): Fetcher {
  return {
    async fetch(url: string): Promise<FetchedDocument> {
      return {
        url,
        outcome: "SUCCESS",
        statusCode: 200,
        body: "<html></html>",
        durationMs: 12,
        ...document,
      };
    },
  };
}

function collecting(): { record: FetchRecorder; records: FetchRecord[] } {
  const records: FetchRecord[] = [];
  return { records, record: (entry) => void records.push(entry) };
}

beforeAll(async () => {
  await resetTestDatabase();
});

beforeEach(async () => {
  await truncateAll();
  alice = await seedWorkspace("alice");
  bob = await seedWorkspace("bob");
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe("LoggingFetcher", () => {
  it("passes the document through unchanged", async () => {
    const { record } = collecting();
    const fetcher = new LoggingFetcher(
      stubFetcher({ body: "<html>hello</html>" }),
      alice.workspaceId,
      null,
      record,
    );

    const document = await fetcher.fetch("https://example.test/");

    expect(document.outcome).toBe("SUCCESS");
    expect(document.body).toBe("<html>hello</html>");
  });

  it("records one entry per request, with what came back", async () => {
    const { record, records } = collecting();
    const fetcher = new LoggingFetcher(
      stubFetcher({ body: "abcde", statusCode: 200, durationMs: 7 }),
      alice.workspaceId,
      "source-1",
      record,
    );

    await fetcher.fetch("https://example.test/page");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspaceId: alice.workspaceId,
      sourceId: "source-1",
      url: "https://example.test/page",
      outcome: "SUCCESS",
      statusCode: 200,
      durationMs: 7,
      bytes: 5,
      error: null,
    });
  });

  it("records a refusal as itself rather than as a success", async () => {
    const { record, records } = collecting();
    const fetcher = new LoggingFetcher(
      stubFetcher({ outcome: "BLOCKED", statusCode: 403, body: undefined, error: "robots" }),
      alice.workspaceId,
      null,
      record,
    );

    await fetcher.fetch("https://example.test/private");

    expect(records[0].outcome).toBe("BLOCKED");
    expect(records[0].statusCode).toBe(403);
    expect(records[0].bytes).toBeNull();
    expect(records[0].error).toBe("robots");
  });

  it("records a research fetch with no source rather than blaming one", async () => {
    const { record, records } = collecting();
    const fetcher = new LoggingFetcher(
      stubFetcher({ outcome: "TIMEOUT", body: undefined, error: "timed out" }),
      bob.workspaceId,
      null,
      record,
    );

    await fetcher.fetch("https://quiet.test/");

    expect(records[0].sourceId).toBeNull();
    expect(records[0].workspaceId).toBe(bob.workspaceId);
    expect(records[0].outcome).toBe("TIMEOUT");
  });

  it("does not let a failing recorder break the fetch", async () => {
    const fetcher = new LoggingFetcher(
      stubFetcher({ body: "<html>ok</html>" }),
      alice.workspaceId,
      null,
      () => {
        throw new Error("log unavailable");
      },
    );

    const document = await fetcher.fetch("https://example.test/");

    expect(document.outcome).toBe("SUCCESS");
    expect(document.body).toBe("<html>ok</html>");
  });
});

describe("stored fetch records", () => {
  it("writes a row that names the URL, the outcome and the workspace", async () => {
    const fetcher = new LoggingFetcher(
      stubFetcher({ outcome: "SERVER_ERROR", statusCode: 503, body: undefined, durationMs: 250 }),
      alice.workspaceId,
      null,
    );

    await fetcher.fetch("https://broken.test/");

    const rows = await db.fetchLog.findMany({ where: { workspaceId: alice.workspaceId } });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: alice.workspaceId,
      sourceId: null,
      url: "https://broken.test/",
      outcome: "SERVER_ERROR",
      statusCode: 503,
      durationMs: 250,
    });
  });

  it("trims a very long URL and error so one row stays one row", async () => {
    const long = `https://example.test/${"x".repeat(4_000)}`;
    const fetcher = new LoggingFetcher(
      stubFetcher({ outcome: "NETWORK_ERROR", body: undefined, error: "e".repeat(2_000) }),
      alice.workspaceId,
      null,
    );

    await fetcher.fetch(long);

    const row = await db.fetchLog.findFirstOrThrow({ where: { workspaceId: alice.workspaceId } });

    expect(row.url).toHaveLength(2_000);
    expect(row.error).toHaveLength(500);
  });

  it("keeps workspaces apart", async () => {
    const fetcher = new LoggingFetcher(stubFetcher({}), alice.workspaceId, null);

    await fetcher.fetch("https://example.test/");

    const other = await db.fetchLog.count({ where: { workspaceId: bob.workspaceId } });
    expect(other).toBe(0);
  });
});
