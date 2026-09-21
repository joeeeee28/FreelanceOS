# FreelanceOS

Personal freelance business operating system — a single-tenant CRM for tracking
real leads, contacts, activities, tasks and follow-ups through a sales pipeline.

The dashboard is built to answer one question: **what should I do today to move
the pipeline forward?**

FreelanceOS uses only real data you enter. There is no seed data, no demo
workspace, and no sample credentials. Empty states are genuine empty states, and
unknown values stay `NULL` rather than being invented.

---

## Architecture

| Layer     | Technology                              |
| --------- | --------------------------------------- |
| Framework | Next.js 15 (App Router, React 19)       |
| Language  | TypeScript (strict)                     |
| Database  | PostgreSQL (Supabase)                   |
| ORM       | Prisma 6                                |
| Styling   | Tailwind CSS 3                          |
| Auth      | Session cookie + `jose` JWT + `bcryptjs`|
| Validation| Zod 3                                   |

### Project layout

```text
prisma/
  schema.prisma          10 models, 7 enums
  migrations/            SQL migration history (committed)
src/
  app/                   App Router routes
    (app)/               Authenticated application shell
    api/                 Route handlers
    setup/  login/       Bootstrap + sign-in
  components/            Shell and providers
  lib/
    auth/                Sessions, bootstrap, password policy
    crm/                 Lead/contact/task/follow-up/dashboard services
    security/            Rate limiting
    db.ts  env.ts        Prisma client, validated environment
scripts/                 Maintenance / verification scripts
```

### Security model

Every CRM query is scoped to a workspace. `workspaceId` and `userId` are always
derived server-side from the authenticated session via `requireUser()` — they
are never accepted from the browser.

**Sessions.** The browser holds a signed JWT in an HTTP-only, SameSite=Lax
cookie (`secure` in production). The database stores only the **SHA-256 digest**
of that token in `Session.tokenHash`, never the token itself, so a read-only
disclosure of the table (leaked backup, replica, log) yields no usable
credentials. Authentication verifies the JWT signature, hashes the presented
token, looks the session up by digest, then compares digests in constant time
and checks expiry. Raw tokens, JWTs, cookies, passwords and authorization
headers are never logged.

**Environment.** `src/lib/env.ts` validates configuration on first use at
runtime, not at import. The production build therefore needs no live database
or secrets, while a misconfigured server still fails immediately and loudly.

**Errors.** `error.tsx` boundaries render a reference code only — never a
message, stack trace, SQL fragment or session detail.

---

## Local setup

### Prerequisites

- **Node.js 20 LTS** (see `.nvmrc`; run `nvm use`)
- A PostgreSQL database — Supabase, or any local PostgreSQL 14+

### 1. Clone and install

```bash
git clone https://github.com/joeeeee28/FreelanceOS.git
cd FreelanceOS
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Then fill in the four required variables:

| Variable       | What it is                                                             |
| -------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL` | **Pooled** Supabase connection (port `6543`, `?pgbouncer=true&connection_limit=1`). Used by the running app. |
| `DIRECT_URL`   | **Direct** Supabase connection (port `5432`). Used only by Prisma Migrate — migrations cannot run through the pooler. |
| `AUTH_SECRET`  | Random string, **minimum 32 characters**. Generate with `openssl rand -base64 48`. Rotating it invalidates all sessions. |
| `APP_URL`      | Absolute base URL including scheme, e.g. `http://localhost:3000`.      |

In the Supabase dashboard both connection strings live under
**Project Settings → Database → Connection string**: use *Transaction pooler*
for `DATABASE_URL` and *Direct connection* for `DIRECT_URL`.

> These variables are validated at startup by `src/lib/env.ts`. A missing or
> malformed value fails fast — including during `next build`.

### 3. Set up the database

```bash
npx prisma generate
npx prisma migrate dev
```

`migrate dev` applies the committed migration history in `prisma/migrations/`,
creating all 10 tables, 7 enums, indexes and foreign keys.

### 4. Run

```bash
npm run dev
```

Open **http://localhost:3000**.

On first run the app redirects to `/setup`, where you create your workspace and
owner account. Setup can only run once — it is guarded at the database level and
`/setup` redirects to `/login` afterwards. Passwords must be at least 12
characters with upper case, lower case, a digit and a symbol.

---

## Scripts

| Command                   | Purpose                                      |
| ------------------------- | -------------------------------------------- |
| `npm run dev`             | Start the development server                  |
| `npm run build`           | `prisma generate` then production build       |
| `npm start`               | Serve the production build                    |
| `npm run typecheck`       | `tsc --noEmit`                                |
| `npm run lint`            | ESLint (Next.js config)                       |
| `npm run prisma:generate` | Regenerate the Prisma client                  |
| `npm run prisma:validate` | Validate `schema.prisma`                      |
| `npm run prisma:migrate`  | Create/apply a development migration          |
| `npm test`                | Run the security + unit test suite (Vitest)   |
| `npm run test:watch`      | Vitest in watch mode                          |
| `npm run test:generate`   | Regenerate the test-only Prisma client        |

### Tests

`npm test` runs Vitest against a **disposable local PostgreSQL** database. It
drops and recreates the `public` schema and replays every committed migration,
so it must never point at production or Supabase — the helper refuses any
non-local host. Override the target with `TEST_DATABASE_URL`; it defaults to
`postgresql://devuser:devpass@127.0.0.1:55432/freelanceos_dev`.

The suite covers session-token hashing, session validation (invalid, tampered,
expired, deleted, logged-out), workspace isolation between two users, setup
input validation, lead URL/email validation, logout invalidation, and
timezone-aware date maths including DST transitions.

`scripts/setup-rollback-test.mjs` verifies that a failed setup transaction rolls
back completely. It writes to the database and asserts an empty starting state,
so run it **only** against a dedicated, empty test database.

---

## Production

Intended deployment topology:

```text
GitHub  →  Render (web service)  →  Supabase PostgreSQL
```

`render.yaml` in this repository defines the service:

- **Build:** `npm install && npx prisma generate && npx prisma migrate deploy && npm run build`
- **Start:** `npm start`
- **Health check:** `/api/health`
- **Environment:** set `DATABASE_URL`, `DIRECT_URL`, `AUTH_SECRET` and `APP_URL`
  in the Render dashboard (all are marked `sync: false`, so they are never
  stored in the repo).

Set the Render Node version to 20 to match `.nvmrc`.

> **Status:** this repository is configured for that topology, but it has **not**
> been deployed. Treat the above as the intended setup, not a completed release.

---

## CRM workflow

The app covers one loop end to end: **lead → research → qualification →
scoring → contact → outreach → follow-up → discovery call → proposal stage**.

Every mutation follows the same path:

```
UI form → server action → requireUser() → CRM service → Prisma transaction → Activity
```

Business rules live in `src/lib/crm/`, never in React components. The client
never supplies `workspaceId`, `createdByUserId` or `score`; the input schemas
are `.strict()`, so a request carrying one of those keys is rejected outright
rather than silently ignored.

### Lead scoring

`src/lib/crm/scoring.ts` is deterministic, explainable and bounded to 0–100.
There is no AI and no randomness: the same lead always produces the same score,
and every point awarded carries a reason code shown on the lead page.

| Signal | Points |
| --- | --- |
| Decision maker identified | 20 |
| Service interest captured | 15 |
| Pain point identified | 15 |
| No website (high need) | 12 |
| Weak website | 8 |
| Advertising actively | 10 |
| Publishing content | 5 |
| Qualification notes written | 5 |
| Reachable (email or phone) | 8 |
| Firmographics known | 2 |

Pipeline position adds further points (NEW 0 → PROPOSAL/NEGOTIATION 20). The
raw total is clamped to 100; a lead with no research scores 0. Scores are
recalculated server-side whenever qualification, the decision maker or the
status changes.

### Daily revenue engine

`src/lib/crm/daily-actions.ts` answers "what should I do today to generate
revenue?" from real rows only — an empty database produces an empty list, never
invented suggestions. Actions are ranked by priority
(URGENT → HIGH → MEDIUM → LOW), then by category, then by due date:

1. `OVERDUE_FOLLOW_UP` — a commitment already missed
2. `DISCOVERY_CALL_TODAY`
3. `FOLLOW_UP_DUE_TODAY`
4. `RESPONDED_LEAD_NEEDS_ACTION` — replied, nothing booked
5. `PROPOSAL_STAGE_FOLLOW_UP`
6. `OVERDUE_TASK`
7. `HIGH_SCORE_UNCONTACTED_LEAD` (score ≥ 50)
8. `NEW_QUALIFIED_LEAD`

"Today" is always the **workspace** calendar day, resolved through the
timezone helpers in `src/lib/time/`, never the server's local date.

### Pipeline transitions

All twelve statuses are reachable, but only through the validated map in
`src/lib/crm/pipeline.ts`:

```
NEW → RESEARCHING → QUALIFIED → OUTREACH_READY → CONTACTED
    → RESPONDED → DISCOVERY_CALL → PROPOSAL → NEGOTIATION → WON
```

`NURTURE` and `LOST` are reachable from any active stage and can re-enter the
pipeline; `WON` is terminal. Every accepted move writes a `STATUS_CHANGED`
activity carrying the old and new status, inside the same transaction as the
update.

### Archiving

Leads are soft-deleted with `deletedAt` plus an activity entry. Archived leads
disappear from active lists but remain reachable through the "Archived only"
filter and can be restored.

### Lists

Search (company, contact, email, website), status/source/score/archive filters
and pagination all run in SQL. Page size defaults to 25 and is hard-capped at
100, so no request can pull an unbounded result set.

---

## Project status

Phases 1 and 2 are complete: bootstrap, authentication and workspace setup,
plus the full CRM workflow described above — leads, qualification, scoring,
contacts, tasks, follow-ups, the interactive pipeline, activity timelines and
the daily revenue engine, all wired to forms and covered by tests.

Not implemented, and deliberately out of scope for now: external lead discovery
(no scraping, no third-party lead APIs), AI enrichment or AI scoring, outreach
automation, and anything involving money — proposals, invoices, payments and
revenue reporting are absent from the data model.
