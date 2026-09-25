/**
 * Verifies that the committed migration SQL reproduces prisma/schema.prisma
 * exactly: tables, columns, types, nullability, indexes and enum values.
 *
 * `prisma migrate diff` requires the schema engine binary, which needs network
 * access to download. This script is the offline equivalent: it replays the
 * committed migrations into a scratch database and compares the resulting
 * information_schema against the Prisma schema.
 *
 * Usage:
 *   node scripts/verify-migration-parity.mjs
 *
 * Requires DATABASE_URL to point at a disposable local Postgres. It creates
 * and drops a scratch database and never touches an existing one.
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGDIR = path.join(ROOT, 'prisma', 'migrations');

const BASE_URL = process.env.DATABASE_URL;
if (!BASE_URL) {
  console.error('DATABASE_URL is required (point it at a disposable local Postgres).');
  process.exit(1);
}

const parsed = new URL(BASE_URL);
if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
  console.error(`Refusing to run against non-local host "${parsed.hostname}".`);
  process.exit(1);
}

const SCRATCH = 'migration_parity_check';
const adminUrl = new URL(BASE_URL); adminUrl.pathname = '/postgres';
const scratchUrl = new URL(BASE_URL); scratchUrl.pathname = `/${SCRATCH}`;

// Replay every committed migration into a fresh scratch database.
{
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
  await admin.query(`CREATE DATABASE "${SCRATCH}"`);
  await admin.end();

  const c = new Client({ connectionString: scratchUrl.toString() });
  await c.connect();
  for (const d of readdirSync(MIGDIR).filter((d) => !d.endsWith('.toml')).sort()) {
    await c.query(readFileSync(path.join(MIGDIR, d, 'migration.sql'), 'utf8'));
  }
  await c.end();
}

// --- Parse prisma/schema.prisma ------------------------------------------
const src = readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');

const SCALAR = {
  String:'text', Int:'integer', Boolean:'boolean', DateTime:'timestamp without time zone',
  Json:'jsonb', Float:'double precision', BigInt:'bigint', Decimal:'numeric'
};
const enums = new Set();
for (const m of src.matchAll(/^enum\s+(\w+)\s*\{/gm)) enums.add(m[1]);
const models = new Set();
for (const m of src.matchAll(/^model\s+(\w+)\s*\{/gm)) models.add(m[1]);

const expected = {}; // model -> { col: {type, nullable} }
const expectedIdx = {}; // model -> Set of sorted column-lists
for (const block of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
  const name = block[1];
  const body = block[2];
  const cols = {};
  const idx = new Set();
  for (let line of body.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('//') || line.startsWith('///')) continue;
    if (line.startsWith('@@')) {
      const mm = /@@(unique|index|id)\(\s*\[([^\]]+)\]/.exec(line);
      if (mm) idx.add(mm[2].split(',').map(s=>s.trim()).join(','));
      continue;
    }
    const fm = /^(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);
    if (!fm) continue;
    const [, fname, ftype, list, opt] = fm;
    if (list) continue;                 // relation array, no column
    if (models.has(ftype)) continue;    // relation object, no column
    const pgType = enums.has(ftype) ? `USER-DEFINED:${ftype}` : SCALAR[ftype];
    if (!pgType) { console.log(`?? unknown type ${ftype} on ${name}.${fname}`); continue; }
    cols[fname] = { type: pgType, nullable: !!opt };
  }
  expected[name] = cols;
  expectedIdx[name] = idx;
}

// --- Read the DB built purely from migration SQL --------------------------
const c = new Client({ connectionString: scratchUrl.toString() });
await c.connect();

const colRows = (await c.query(`
  SELECT table_name, column_name, data_type, is_nullable, udt_name
  FROM information_schema.columns WHERE table_schema='public'`)).rows;

const actual = {};
for (const r of colRows) {
  (actual[r.table_name] ??= {})[r.column_name] = {
    type: r.data_type === 'USER-DEFINED' ? `USER-DEFINED:${r.udt_name}` : r.data_type,
    nullable: r.is_nullable === 'YES'
  };
}

const idxRows = (await c.query(`
  SELECT t.relname AS tbl, array_to_string(array_agg(a.attname ORDER BY k.ord),',') AS cols
  FROM pg_index i
  JOIN pg_class t ON t.oid=i.indrelid
  JOIN pg_namespace n ON n.oid=t.relnamespace AND n.nspname='public'
  JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord) ON true
  JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
  GROUP BY i.indexrelid, t.relname`)).rows;
const actualIdx = {};
for (const r of idxRows) (actualIdx[r.tbl] ??= new Set()).add(r.cols);

// --- Compare --------------------------------------------------------------
let problems = 0;
for (const model of Object.keys(expected)) {
  const exp = expected[model], act = actual[model];
  if (!act) { console.log(`MISSING TABLE: ${model}`); problems++; continue; }
  for (const [col, e] of Object.entries(exp)) {
    const a = act[col];
    if (!a) { console.log(`MISSING COLUMN: ${model}.${col}`); problems++; continue; }
    if (a.type !== e.type) { console.log(`TYPE MISMATCH: ${model}.${col} prisma=${e.type} db=${a.type}`); problems++; }
    if (a.nullable !== e.nullable) { console.log(`NULLABILITY MISMATCH: ${model}.${col} prisma.optional=${e.nullable} db.nullable=${a.nullable}`); problems++; }
  }
  for (const col of Object.keys(act)) {
    if (!(col in exp)) { console.log(`EXTRA COLUMN IN DB: ${model}.${col}`); problems++; }
  }
  for (const want of expectedIdx[model]) {
    if (!(actualIdx[model]?.has(want))) { console.log(`MISSING INDEX: ${model}(${want})`); problems++; }
  }
}
for (const tbl of Object.keys(actual)) {
  if (!(tbl in expected) && !tbl.startsWith('_')) { console.log(`EXTRA TABLE IN DB: ${tbl}`); problems++; }
}

// Enum value parity
for (const em of src.matchAll(/^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
  const name = em[1];
  const vals = em[2].split('\n').map(s=>s.trim()).filter(s=>s && !s.startsWith('//')).sort();
  const dbv = (await c.query(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname=$1`,[name])).rows.map(r=>r.enumlabel).sort();
  if (dbv.length===0) { console.log(`MISSING ENUM: ${name}`); problems++; continue; }
  if (JSON.stringify(vals)!==JSON.stringify(dbv)) {
    console.log(`ENUM MISMATCH ${name}: prisma-only=${vals.filter(v=>!dbv.includes(v))} db-only=${dbv.filter(v=>!vals.includes(v))}`);
    problems++;
  }
}

await c.end();

// Clean up the scratch database.
{
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
  await admin.end();
}

console.log(problems === 0
  ? '\nSCHEMA_MATCHES_MIGRATION ✓  (migration SQL reproduces schema.prisma exactly)'
  : `\n${problems} DISCREPANCIES`);
if (problems > 0) process.exit(1);
