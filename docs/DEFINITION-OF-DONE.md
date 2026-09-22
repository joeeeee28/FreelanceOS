# Definition of Done — verification record

This document records what was **actually executed** against the repository, and
what was **not**. It is deliberately written so that a reader can tell the
difference. Every "PASS" below corresponds to a command that ran and produced
the stated output. Anything that could not be executed in this environment is
recorded as UNVERIFIED with the reason, rather than being quietly omitted.

Audited at commit: `be7593c` (P13), branch `arena/01a0c3a0-freelanceos`.

---

## 1. Gate results (executed)

| Gate | Command | Result |
| --- | --- | --- |
| Tests | `npm test` | **PASS** — 43 files, 751 tests passed, 0 failed |
| Typecheck | `./node_modules/.bin/tsc --noEmit` | **PASS** — no output, exit 0 |
| Lint | `npm run lint` | **PASS** — 0 errors, 1 pre-existing warning |
| Schema validity | `npx prisma validate` | **PASS** — "The schema at prisma/schema.prisma is valid" |
| Migration parity | `npm run prisma:parity` | **PASS** — `SCHEMA_MATCHES_MIGRATION ✓` |
| App build | `npx next build` | **PASS** — "Compiled successfully", full route table emitted |
| Worker boot | `npm run worker` | **PASS** — starts, logs `worker started`, enters its poll loop |
| Fresh-DB migration | all 4 migrations replayed onto an empty database | **PASS** — 24 tables created, no errors |
| Empty-database rule | row count across all 24 tables of a fresh DB | **PASS** — **0 rows total** |

The single lint warning is `scripts/setup-rollback-test.mjs:33:12` (an unused
`e` in a catch block). It predates this work and is left alone rather than
touched purely to make a report look cleaner.

## 2. The "no demo data" requirement, actually checked

This was verified by construction rather than by assertion: a brand-new
database was created, the migrations were replayed onto it, and every table was
counted. The total was zero. The application was then started against that
empty database and served `/login` (200) and `/api/health` (200).

There is no seed script, no `prisma.seed` entry in `package.json`, and no
fabricated company, lead, contact, signal or revenue figure anywhere in `src/`.
The only matches for names like "Acme" are **form placeholders** in the new-lead
form and **explanatory comments** in the canonicalization code. Test fixtures
live in `tests/helpers/` and never run against a real database.

## 3. Security review (executed greps + reading)

- **Workspace isolation.** No route, page or action reads `workspaceId` from
  `searchParams`, `formData`, route params or a request body. Every query
  derives it from `requireUser()`. Checked by grep across `src/app`.
- **SQL injection.** Exactly one raw query exists in the codebase
  (`src/lib/jobs/queue.ts`, the atomic job claim). It is built with
  `Prisma.sql` and every interpolation is a bound parameter. The `FOR UPDATE
  SKIP LOCKED` statement is the one place raw SQL is genuinely necessary,
  because Prisma cannot express it.
- **No escape hatches.** Zero occurrences of `@ts-ignore` or `@ts-nocheck` in
  `src/` or `tests/`. The typecheck is real.
- **No code execution.** No `eval`, no `new Function`. Crawled content is
  treated as untrusted data and is never executed.
- **No hardcoded credentials.** No secret-shaped literals in `src/`. No `.env`
  file is tracked by git.

## 4. What is NOT verified, and why

These are environment limits of the sandbox, not defects in the code. They are
listed here because shipping to production without closing them would be
irresponsible.

1. **Live-internet discovery is UNVERIFIED.** The sandbox has no general
   network egress: `example.com`, `news.ycombinator.com` and
   `raw.githubusercontent.com` are all unreachable. Every provider, the fetcher,
   robots handling, retry/backoff and the full pipeline were therefore tested
   against a **local fixture HTTP server** (`tests/helpers/fixture-server.ts`).
   The logic is exercised end to end; what has never happened is a request to a
   real third-party website. **Before production, run one real discovery cycle
   against a small allow-list of live sources and inspect the results by hand.**

2. **Live UI rendering against a database is UNVERIFIED in this environment.**
   The Prisma **native query engine** cannot be downloaded offline, so any page
   that touches the database throws `PrismaClientInitializationError` at
   runtime. The application *compiles*, every route is emitted, and non-database
   routes (`/api/health`, `/login`) serve correctly. The database logic itself
   is covered by 751 tests running against a real PostgreSQL 17 instance — the
   tests use a driver adapter that does not need the native engine. On any
   normal machine `prisma generate` fetches the engine and this disappears.

3. **`npm run build` cannot run as-is offline**, because its `prisma generate`
   step tries to download that same engine. `npx next build` alone succeeds.

4. **No browser automation.** Chromium cannot be downloaded, so there are no
   screenshots and no end-to-end browser tests.

5. **Node version drift.** The sandbox runs Node 22; `.nvmrc` pins 20.

6. **The rate limiter is in-memory and per-process.** Fine for a single
   instance; it will not coordinate across replicas. If the app is ever scaled
   horizontally, this needs to move to the database or a shared store.

## 5. Deployment status

**NOT DEPLOYED, and deliberately so.** Nothing was pushed to Render, Supabase or
Vercel; no production environment was touched or modified. Items 1 and 2 in the
previous section must be closed in an environment with network access, and
deployment must be explicitly approved, before this goes anywhere near
production.
