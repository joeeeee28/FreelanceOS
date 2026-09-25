import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

/**
 * Integration-test database helper.
 *
 * Tests run against a disposable PostgreSQL instance identified by
 * TEST_DATABASE_URL. Production/Supabase databases are never used: the helper
 * refuses to run against a non-local host, because it drops and recreates the
 * `public` schema on every run.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://devuser:devpass@127.0.0.1:55432/freelanceos_dev";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

function assertDisposable(url: string) {
  const { hostname } = new URL(url);

  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing to run destructive tests against non-local host "${hostname}". ` +
        "Point TEST_DATABASE_URL at a disposable local PostgreSQL instance.",
    );
  }
}

/** Applies every committed migration, in order, to a freshly emptied schema. */
export async function resetTestDatabase(): Promise<void> {
  assertDisposable(TEST_DATABASE_URL);

  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();

  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");

    const migrationsDir = path.join(process.cwd(), "prisma", "migrations");

    const directories = readdirSync(migrationsDir)
      .filter((entry) => existsSync(path.join(migrationsDir, entry, "migration.sql")))
      .sort();

    if (directories.length === 0) {
      throw new Error("No migrations found to apply.");
    }

    for (const directory of directories) {
      const sql = readFileSync(
        path.join(migrationsDir, directory, "migration.sql"),
        "utf8",
      );
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

/** Removes all rows between tests without re-running the migrations. */
export async function truncateAll(): Promise<void> {
  assertDisposable(TEST_DATABASE_URL);

  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );

    if (rows.length > 0) {
      const list = rows.map((row) => `"${row.tablename}"`).join(", ");
      await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await client.end();
  }
}

export function migrationSql(name: string): string {
  return readFileSync(
    path.join(process.cwd(), "prisma", "migrations", name, "migration.sql"),
    "utf8",
  );
}

export { execFileSync };
