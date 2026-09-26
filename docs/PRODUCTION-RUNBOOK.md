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
- Confirm the expected object counts (current baseline: 24 tables, 110
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

### Instance topology and rate limiting (single-instance constraint)

The web service's brute-force protection (`POST /api/auth/login`: 20 requests /
10 min per IP and 10 / 10 min per email; `POST /api/setup`: 5 / 10 min per IP)
is a **process-local in-memory limiter** (`src/lib/security/rate-limiter.ts`).
That is correct for a **single application instance**, which is what
`render.yaml` provisions — but it is not a global limit.

- Run **exactly one** web instance in this topology. With two or more
  instances each keeps its own counters, so an attacker's effective allowance
  multiplies by the instance count.
- Before scaling the web service horizontally, add a shared rate-limit store
  (Redis, or a database-backed counter) or deliberately pin the service to a
  single instance. Scaling out without it silently weakens login/setup
  throttling.
- A limiter entry is only replaced when the same key is used again, so a client
  presenting many distinct keys (IPs/emails) accumulates keys in memory for the
  life of the process. Acceptable for a single-user deployment; revisit before
  exposing the login route to broad untrusted traffic.
- Worker scaling is unaffected: job claiming is database-serialised
  (`FOR UPDATE SKIP LOCKED`), so multiple worker instances remain safe.

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
- [ ] Rate limiting: exactly one web instance is provisioned, or a shared
      rate-limit store is configured (§3)
- [ ] Migration parity verified against the production database
- [ ] Production scanning/scheduling remains disabled
- [ ] No `.env` file and no secret values committed
- [ ] Explicit approval recorded for deploying

---

## 9. P16.5 – P16.7 addendum: two services, one queue

> Appended for the P16.5–P16.7 batch. Nothing above is superseded; the deploy
> sequence in §1–§8 still applies, with the topology and gates below.

**Topology.** `render.yaml` now defines the web service **and** a background
worker. See `docs/P16-AUTOMATION-OPERATIONS.md` §7 for the exact build and start
commands and the environment each service needs. Two rules are load-bearing:

- migrations are applied only by the web build (`npx prisma migrate deploy`);
  the worker generates its client and connects, and never migrates;
- the web process never runs a job or a schedule. If no worker is running, the
  queue does not move — the Automation page says "No worker reporting" rather
  than pretending otherwise.

**Infrastructure prerequisite.** Render runs background workers only on paid
instance types. The worker service is declared at `plan: starter`; on a plan
that cannot host it, the service will not be created and automation will not
run. That is an infrastructure blocker, not an application defect.

**Additional pre-deployment gates for this batch.**

- [ ] `npm run prisma:parity` passes with both new migrations applied to a
      disposable database
- [ ] The worker service is created and shows a `WorkerHeartbeat` row on
      `/automation` within one interval (30 s)
- [ ] `/automation` reports the schedule and the queue from the database
- [ ] One controlled discovery cycle is triggered manually, with global
      scheduling still disabled
- [ ] A worker restart mid-cycle leaves no job RUNNING past its lease

**Staged activation.** Deploy the web service first (it applies the two additive
migrations), verify health and login, then start the worker and confirm the
heartbeat, then trigger one manual cycle and watch it settle. Do not enable
scheduled discovery during the first production test.
