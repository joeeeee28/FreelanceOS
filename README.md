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

## Project status

Phase 1 (bootstrap, authentication, workspace) and the Phase 2 read paths
(dashboard, leads, contacts, activities, tasks, follow-ups, pipeline) are
implemented. Lead creation is wired end to end.

Several Phase 2 write paths — editing leads, moving pipeline stages, and
creating contacts, tasks and follow-ups from the UI — have service-layer
implementations in `src/lib/crm/` that are not yet connected to forms. Money and
revenue tracking are not part of the current data model.
