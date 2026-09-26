/**
 * Generates a Prisma Client for the test suite.
 *
 * The application client uses Prisma's default binary query engine. The test
 * client is generated from the *same* prisma/schema.prisma with the driver
 * adapter engine enabled, so integration tests talk to the disposable test
 * database through node-postgres.
 *
 * The schema is derived at generate time rather than copied, so it can never
 * drift from the real one. The output lives in a git-ignored directory.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "prisma", "schema.prisma");
const outputDir = path.join(root, "tests", ".generated");
const derivedSchema = path.join(outputDir, "schema.prisma");
const clientOutput = path.join(outputDir, "client");

/**
 * Path to a harmless executable used only to satisfy Prisma's schema-engine
 * lookup during client generation (see the env note below).
 */
function schemaEngineStub() {
  return process.platform === "win32" ? "cmd" : "/usr/bin/true";
}

const original = readFileSync(source, "utf8");

const GENERATOR_PATTERN = /generator\s+client\s*\{[^}]*\}/;

if (!GENERATOR_PATTERN.test(original)) {
  throw new Error("Could not find the `generator client` block in prisma/schema.prisma");
}

const derived = original.replace(
  GENERATOR_PATTERN,
  [
    "generator client {",
    '  provider        = "prisma-client-js"',
    '  engineType      = "client"',
    `  output          = "${clientOutput.replace(/\\/g, "/")}"`,
    "}",
  ].join("\n"),
);

mkdirSync(outputDir, { recursive: true });
writeFileSync(derivedSchema, derived);

execFileSync(
  process.execPath,
  [path.join(root, "node_modules", "prisma", "build", "index.js"), "generate", `--schema=${derivedSchema}`],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      // Generation only needs the schema; no database connection is opened.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/test",
      DIRECT_URL: process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/test",
      // `prisma generate` tries to fetch the schema engine binary even though
      // client generation does not use it. The driver-adapter client contains
      // its own WebAssembly query engine, so the download is unnecessary and
      // is skipped here to keep generation working on machines (and CI images)
      // with no access to binaries.prisma.sh.
      PRISMA_SCHEMA_ENGINE_BINARY:
        process.env.PRISMA_SCHEMA_ENGINE_BINARY ?? schemaEngineStub(),
    },
  },
);

console.log("Test Prisma Client generated at tests/.generated/client");
