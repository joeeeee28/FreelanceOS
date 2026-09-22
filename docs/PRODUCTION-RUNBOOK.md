# FreelanceOS — Production Runbook (PREPARED, NOT DEPLOYED)

> **Status: NOT DEPLOYED.** This document is the preparation deliverable for
> P15 §29. Nothing described here has been executed against a production
> environment. No Render service, no production Supabase project and no
> scheduled scanning has been created, modified or enabled. Deployment
> requires explicit approval per the standing project rules.

---

## 1. Environment variables

Every variable the application actually reads. Values below are **descriptions,
never real secrets** — no production secret is stored in Git.

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | Next.js app, worker, Prisma | Postgres connection string. With Supabase use the **pooled** (pgBouncer, port 6543) URL for the app. |
| `DIRECT_URL` | yes | `prisma migrate deploy` | **Unpooled** (port 5432) URL. Migrations must not run through pgBouncer. Must never be empty — an empty value makes Prisma fail with `P1012`. |
| `AUTH_SECRET` | yes | Session signing | Random string, **minimum 32 characters**. A shorter value silently breaks session verification. Generate with `openssl rand -base64 48`. Rotating it invalidates all sessions. |
| `APP_URL` | yes | Absolute links, cookie scope | Public origin, e.g. `https://app.example.com`. No trailing slash. |
| `NODE_ENV` | yes | Framework | `production`. |
| `TRUSTED_PROXY_HOPS` | optional | Client-IP resolution | Number of proxies in front of the app. Set to the real hop count so `X-Forwarded-For` cannot be spoofed. Defaults to a safe value when unset. |
| `TEST_DATABASE_URL` | no | Test suite only | Never set in production. |
| `PRISMA_SCHEMA_ENGINE_BINARY` | no | Local tooling escape hatch only | **Must never be set in production.** Pointing it at a stub makes `prisma migrate deploy` a silent no-op that exits 0 without applying anything. |

Secrets are supplied through the platform's secret store or the service
dashboard's environment configuration — never committed, never logged. No
`.env` file is tracked (verified: `git ls-files | grep -E '(^|/)\.env($|\.local)'`
returns nothing, and `.env` is git-ignored).

---

## 2. Migration procedure

Run migrations **before** starting the new application version.

```bash
npm ci
npx prisma generate
DATABASE_URL="$DIRECT_URL" npx prisma migrate deploy   # unpooled connection
node scripts/verify-migration-parity.mjs               # schema == migrations
```

Checks and rules:

- `prisma migrate deploy` only applies pending migrations; it never resets.
- **Never** run `prisma migrate reset`, `DROP DATABASE`, `DROP SCHEMA` or
  `TRUNCATE` against production.
- Verify the result is `SCHEMA_MATCHES_MIGRATION ✓` before proceeding.
- Confirm the expected object counts (current baseline: 24 tables, 111
  indexes, 42 foreign keys, 21 enums).
- Migrations are forward-only. A bad migration is corrected by a **new**
  migration, not by editing an applied one.

Post-migration sanity check (should return 0 rows on a fresh install — the
product ships with no demo data):

```sql
SELECT (SELECT count(*) FROM "Lead")    AS leads,
       (SELECT count(*) FROM "Company") AS companies,
       (SELECT count(*) FROM "Signal")  AS signals;
```

---

## 3. Start commands

Two separate processes share one database.

**Web (Next.js)**

```bash
npm ci && npm run build      # runs `prisma generate && next build`
npm run start                # next start
```

**Worker (background jobs)**

```bash
npm ci
npx prisma generate
npm run worker               # tsx src/worker/index.ts
```

The worker is a long-running process, not a cron job. It polls for due work,
claims jobs under a lease and renews that lease with a heartbeat. Multiple
worker instances may run concurrently: job claiming uses
`SELECT ... FOR UPDATE SKIP LOCKED`, which has been verified under 12
simultaneous claimants to never hand the same job to two workers.

> **Deployment prerequisite — currently unmet in the validation sandbox.**
> Prisma's native query engine for the target platform
> (`debian-openssl-3.0.x`) must be downloadable at install time from
> `binaries.prisma.sh`. That host is unreachable from the validation sandbox,
> so the production engine path could not be exercised here. Any real
> deployment must confirm `npm ci` fetches the engine successfully.

---

## 4. Scheduler configuration

**Production scheduling is intentionally OFF and must stay off until
explicitly approved.**

The intended shape when enabled: the worker's own loop enqueues due discovery
cycles per workspace; no external cron is required. Rate limits are enforced
in the crawler (`minIntervalMs` per host, `respectRobots: true`, a descriptive
bot user-agent). Enabling a twice-daily global scan is a deliberate,
separately approved action — not a side effect of deploying.

---

## 5. Health check

`GET /api/health` — liveness. Returns HTTP 200.

`GET /api/init-status` — readiness: returns `{"initialized": true|false}` and
requires a working database round-trip, so it is the better probe for
"can this instance actually serve traffic". Point the platform's health check
at `/api/health` and use `/api/init-status` for post-deploy verification.

Post-deploy smoke sequence:

```bash
curl -fsS "$APP_URL/api/health"
curl -fsS "$APP_URL/api/init-status"
curl -fsS -o /dev/null -w '%{http_code}\n' "$APP_URL/login"   # expect 200
```

---

## 6. Logging

- Application logs go to stdout/stderr for collection by the platform.
- Credentials, raw session tokens and password material are never logged;
  session tokens are stored only as digests (`Session.tokenHash`), and the raw
  token exists solely in the user's cookie.
- Server action failures are logged without payloads, so Prisma errors, SQL
  and stack traces are not exposed to the browser — users receive a generic
  message.
- Discovery keeps an auditable trail in the database rather than in log files:
  `FetchLog` (per request), `Observation` (append-only facts with source URL,
  method and timestamp) and `DiscoveryRun` (per cycle).

What to watch after a release: `/api/health` non-200, worker `FAILED` job
counts, `Source` rows whose health degrades to `FAILING`, and migration parity
drift.

---

## 7. Recovery procedures

**Bad release** — redeploy the previous image/commit. Schema changes are
forward-only, so verify the older code is compatible with the current schema
before rolling back; if not, roll forward with a corrective migration.

**Worker crash / stuck jobs** — no action normally required. A crashed
worker's in-flight job keeps its lease only until expiry; another worker then
re-claims it and its attempt counter increments. This was verified by killing
workers mid-job and by a total 5-worker crash, with no job permanently lost.
Jobs that exhaust `maxAttempts` end in `FAILED` with the error text retained
for inspection.

**Database outage** — the app surfaces errors rather than inventing data; the
worker backs off and retries claiming instead of spin-looping. Once the
database returns, no manual reconciliation is needed.

**Session compromise** — rotate `AUTH_SECRET` (invalidates every session), or
delete the specific `Session` rows.

**Data safety** — discovery is additive-only by design: it never deletes or
replaces human-entered leads, contacts, notes or activities, and weaker
scraped evidence cannot overwrite stronger human data. Restoring "lost" CRM
data is therefore not an expected recovery scenario; archived leads are
soft-deleted (`deletedAt`) and restorable through the UI.

---

## 8. Pre-deployment checklist

- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npm run prisma:validate`,
      `npm run prisma:parity`, `npm run build` all pass
- [ ] `AUTH_SECRET` is ≥32 random characters and newly generated for production
- [ ] `DIRECT_URL` is set and unpooled; `PRISMA_SCHEMA_ENGINE_BINARY` is unset
- [ ] Prisma native engine downloads successfully on the target platform
- [ ] Migration parity verified against the production database
- [ ] Production scanning/scheduling remains disabled
- [ ] No `.env` file and no secret values committed
- [ ] Explicit approval recorded for deploying
