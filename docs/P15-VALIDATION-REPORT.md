# P15 — Real-World Validation & Production Readiness Report

**Date:** 2026-09-22
**Branch:** `arena/01a0c3a0-freelanceos`
**HEAD at time of report:** `81e70cd`
**Verdict: FreelanceOS is NOT certified production-ready.** Required gates
remain unverified (§4 production engine path, browser-level §28, live
multi-service discovery breadth). Nothing has been deployed. Details in
§13 "Not verified".

Every claim below was produced by a command that actually ran. Each gate is
categorized per §30 as **VERIFIED OFFLINE**, **VERIFIED WITH LOCAL HTTP**,
**VERIFIED AGAINST REAL PUBLIC SOURCE**, or **NOT VERIFIED**. These categories
are never blurred.

---

## 1. Git and remote state

| Item | Value |
|---|---|
| Working branch | `arena/01a0c3a0-freelanceos` |
| HEAD | `81e70cd` — "P15 validation: real-Postgres and real-source evidence suites" |
| `origin/main` | `84dfb6e` |
| PR #1 | **OPEN, not merged** (`arena/01a0c3a0-freelanceos` → `main`) |

**P11–P14 are NOT on `origin/main`.** `main` still points at `84dfb6e`, the
commit this branch was cut from. Everything from P0 onward exists only on the
working branch and in the open PR.

Commit ancestry: `81e70cd`(P15 tests) ← `72780df`(P15 SSRF fix) ←
`43e9073`(P11–14) ← `070af4c`(P10) ← `2c52c82`(P9) ← `bfebba0`(P8) ←
`eb97703`(P7) ← `aa2f1f0`(P6) ← `8e78864`(P5) ← `0d47400`(P4) ← `f153cf8`(P3)
← `4bcfce0`(P2) ← `e24eb19`(P1) ← `28acf09`(P0) ← `84dfb6e`.

No force-push, no history rewrite, no merge to `main`. No `.env` file is
tracked; `node_modules`, `.env` and `.next` are all git-ignored.

> **Consequence for reviewers:** the SSRF vulnerability described in §9 exists
> in the tree that PR #1 currently proposes to merge, and is fixed by commits
> that came after it on the same branch.

---

## 2. Application

**Category: VERIFIED WITH LOCAL HTTP (against real PostgreSQL).**

`npm run dev` was run against a real local PostgreSQL 18.4 instance
(`p15_validation` database), and driven over real HTTP.

| Route | Status | Route | Status |
|---|---|---|---|
| `/api/health` | 200 | `/follow-ups` | 200 |
| `/api/init-status` | 200 `{"initialized":false}` → `true` after setup | `/activities` | 200 |
| `/login` | 200 | `/settings` | 200 |
| `/dashboard` | 200 | `/projects` | 200 |
| `/leads` | 200 | `/invoices` | 200 |
| `/pipeline` | 200 | `/outreach` | 200 |
| `/contacts` | 200 | `/analytics` | 200 |
| `/tasks` | 200 | | |

The dev server log across this entire session shows **zero runtime errors,
zero hydration errors and zero database errors**. Responsive layout classes
(`sm:`/`md:`/`lg:` breakpoints, `md:hidden`/`lg:block` navigation switches) are
present in the rendered markup and a viewport meta tag is emitted on every
page.

**Important qualification (§4).** The engine path used here is **not** the
production path. Prisma's native query engine for `debian-openssl-3.0.x` could
not be downloaded (`binaries.prisma.sh` is unreachable from this sandbox), so
the app was run via the `driverAdapters` + `queryCompiler` path. The schema and
`db-client.ts` were **restored to their production configuration** afterwards
(`git diff` on both files is empty) and the production build was re-verified.
The production engine path itself remains **NOT VERIFIED**.

---

## 3. Authentication and sessions (§5)

**Category: VERIFIED WITH LOCAL HTTP (real database).**

| Check | Result |
|---|---|
| Setup (`POST /api/setup`) | 200 `{"ok":true}` |
| Valid login | 200, session cookie issued |
| Wrong password | **401** `{"error":"Invalid credentials."}` |
| Unknown user | **401** — *identical message*, so no user enumeration |
| Session cookie | `HttpOnly` set |
| Unauthenticated `/dashboard` | redirect payload to `/login`, **no dashboard content in the response body** |
| Forged/garbage token | redirected to login, no data leaked |
| Logout | server-side row deleted: session count went **1 → 2 (login) → 1 (logout)** |
| Reused cookie after logout | rejected, redirected to login |

Sessions are stored as digests only (`Session.tokenHash`); the raw token exists
solely in the user's cookie. No credentials, tokens or passwords appear in any
log output.

---

## 4. CRM (§6, §7)

**Category: VERIFIED (real PostgreSQL) — `tests/p15/crm-ui-actions.test.ts`, 6/6 passing.**

Every mutation was driven through the *actual exported server actions the UI
forms submit to*, then read back directly from PostgreSQL. Only `requireUser()`
is mocked; validation, Prisma queries, transactions and activity writes all run
for real.

| Mutation | Persisted result |
|---|---|
| Create lead | "Persisted Ltd" written; success path correctly signals via `redirect()` |
| Edit lead | `contactName` → "Ada Lovelace", phone normalized |
| Qualify | notes stored; **score moved 8 → 43** deterministically on real evidence |
| Status transition | `NEW` → `RESEARCHING` |
| Archive / restore | `deletedAt` set, then cleared (soft delete) |
| Contact | created with `isPrimary`/`isDecisionMaker` true; renamed to "Grace Hopper", `jobTitle` → "Founder" |
| Tasks | created (attributed to the acting user), completed → `DONE`, cancelled → `CANCELLED` |
| Follow-ups | created, rescheduled 2026-10-05 → 2026-10-12, completed, cancelled |
| Activity timeline | `NOTE_ADDED` + `STATUS_CHANGED`, both attributed to the human user |
| **Cross-workspace write** | **refused** — returned `error`, foreign lead unchanged at `NEW` |

### Permanent CRM rule (§7, §12, §13) — 7/7 passing, `tests/p15/permanence.test.ts`

Verified against real PostgreSQL:

- A human-created Company + Contact + Note all **survive** subsequent discovery.
- Discovery **only enriches**: a blank field gets filled; a populated human
  field is left untouched.
- Machine-written activities carry `createdByUserId === null`, cleanly
  distinguishing them from human actions.
- Double-ingest produces **one** company, not two.
- An unchanged re-sync writes **no** spurious activity.
- Changed information keeps **both** observations (OLD and NEW) with timestamp,
  source and evidence; the company reflects the latest.
- Weaker `TEXT_HEURISTIC` evidence **cannot overwrite** stronger
  `STRUCTURED_DATA`, yet is still recorded for audit.

---

## 5. Discovery against real public sources (§8–§13)

**Category: VERIFIED AGAINST REAL PUBLIC SOURCE.**

Outbound access in this sandbox is a **narrow allow-list, not the open
Internet**. Confirmed reachable and used: `api.github.com`, `github.com`,
`pypi.org`, `registry.npmjs.org`, `codeload.github.com`. Confirmed blocked
(curl exit 000): `react.dev`, `roadmap.sh`, `nextjs.org`, `vitejs.dev`,
`github.blog`. Crawling used a descriptive UA
(`FreelanceOSBot/0.1 (+https://github.com/joeeeee28/FreelanceOS; validation)`),
`respectRobots: true` and a 1000–1500 ms per-host interval. **No login,
CAPTCHA, paywall, robots rule or auth wall was bypassed at any point.**

### Repeated discovery (§12, mandatory gate) — `tests/p15/end-to-end.test.ts`, 9/9

Source: `https://api.github.com/orgs/vercel/repos?per_page=30`.

| | Cycle 1 | Cycle 2 |
|---|---|---|
| Duration | 1205 ms | 815 ms |
| Pages attempted / succeeded | 1 / 1 | 1 / 1 |
| Entities found | 6 | 6 |
| Companies **created** | **6** | **0** |
| Companies **matched** | 0 | **6** |

Totals after both cycles: **6 companies, 12 observations.** Running the same
real discovery twice produced **zero duplicate companies and zero duplicate
leads**; append-only history grew while the entity count did not. This is the
idempotency requirement met on real data.

### Second real source (§14, §15) — `tests/p15/signals-real.test.ts`, 2/2

A real `website`-provider crawl of `https://pypi.org`: **5/5 pages fetched in
4232 ms**, producing 1 company (`PyPI`, `pypi.org`) with 6 observations
(`META_TAG` conf 70, `HTML_SELECTOR` conf 60), each carrying a `sourceUrl`.

Signal produced: `SOCIAL_MEDIA_ACTIVITY`, confidence 70, summary *"1 social
profile found."*, evidence listing the profile URL, status `ACTIVE`.

Full chain `SIGNAL → SERVICE → OPPORTUNITY → EVIDENCE → ACTION` (controlled
facts): `WEBSITE_MISSING` (conf 70) → opportunity `WEBSITE_CREATION`, score
**35**, recommended action *"Offer to build a first website."*, rationale
`[{points: 35, ruleKey: "NO_SITE_TO_CREATION", signal: "WEBSITE_MISSING", evidence: …}]`
— the rationale points sum exactly to the score, so scoring is deterministic
and explainable.

> **Honest finding — stated plainly.** The GitHub-API cycle produced
> **0 signals and 0 opportunities**. This is *correct behaviour*, not a
> failure: repo metadata yields a URL and nothing else, and every rule refuses
> to fire without evidence (`WEBSITE_MISSING` requires a contact route;
> `SOCIAL_MEDIA_ABSENT` requires `pageSignals.reachable === true`). That is the
> "absent ≠ false" discipline working. But it meant the first §14/§15 checks
> passed **vacuously over an empty collection**, which is why the pypi.org +
> controlled-facts suite was added. §14/§15 are proven by *that* suite, not by
> the GitHub cycle.

### Source fallback (§10)

An intentionally unavailable fixture (`p15-dead-source.invalid`) reports
`status: "FAILING"`, `successRate: 0` with the remediation *"The host did not
answer. Usually temporary; check the URL is still correct if it persists."*,
while the live GitHub source continues at `status: ACTIVE`,
`successRate: 1`. **Source A failing does not stop B and C**; both remain
listed and the run continues.

---

## 6. Worker (§16, §17)

**Category: VERIFIED (real PostgreSQL) — `tests/p15/worker-recovery.test.ts`, 8/8.**

| Scenario | Result |
|---|---|
| 12 concurrent claimants vs 12 jobs | 12 **unique** job ids — zero double-claims (genuine `FOR UPDATE SKIP LOCKED`) |
| 10 workers vs 3 jobs | exactly 3 claims, 7 correct `null`s |
| Worker dies mid-job | lease expires, another worker re-claims, `attempts` incremented, job completes — **no permanently lost job** |
| Heartbeat | holds the lease against premature steal |
| Retry exhaustion | terminal `FAILED` with error text retained |
| Non-retryable failure | correctly not retried |
| Total 5-worker crash | nothing lost |

The **real `runWorker` loop** drained a real queue: `{claimed: 4, completed: 4,
failed: 0}`, with 4 rows confirmed `SUCCEEDED` in Postgres.

`npm run worker` **starts and loops** as a standalone process, but cannot reach
the database in this sandbox because of the missing native engine (below). Its
graceful-shutdown and job-processing logic is therefore verified through the
WASM test client rather than through the production binary.

---

## 7. Dashboard and data honesty (§18, §19, §21)

**Category: VERIFIED (real data + real HTTP).**

- Dashboard `companies: 6` **equals the actual database row count exactly** —
  no fabricated numbers.
- Market intelligence reports `sampleSize: 6, sufficient: false` — it refuses
  to draw conclusions from a tiny sample rather than presenting a confident
  percentage.
- On a real empty database the UI renders **honest empty states**: "No revenue
  actions yet", "No opportunities yet", "No market data yet", "No funnel yet",
  "No activity yet". Missing data is shown as absent, never as a fake zero.

---

## 8. Knowledge engine (§20)

**Category: VERIFIED AGAINST REAL PUBLIC SOURCE — `tests/p15/knowledge-real.test.ts`, 4/4.**

| URL | HTTP | Fetch | Bytes | Outcome |
|---|---|---|---|---|
| `https://pypi.org` | SUCCESS | 95 ms | 27,902 | CREATED |
| `https://github.com/about` | SUCCESS | 448 ms | 294,527 | CREATED |
| `https://api.github.com/zen` | SUCCESS | 379 ms | 19 | CREATED |

Example stored record: title *"About GitHub · GitHub"*, `sourceName`
`github.com`, summary 499 chars, excerpt 293 chars, topics
`[Social Media, Branding, Content Marketing, Video]`, service relevance across
5 of the 11 services, with `discoveredAt` recorded.

294 KB of source HTML became a 293-character excerpt — **no wholesale copying
of copyrighted material**. Sanitisation leaves no `<script` or `<div` in stored
content. Hub search returns hits for a term drawn from a stored title.
Re-ingesting the same URL updates in place (count unchanged, `discoveredAt`
never rewritten). An empty page returns `SKIPPED` rather than a **fabricated**
summary.

---

## 9. Security (§23)

**Category: VERIFIED OFFLINE (SSRF unit + integration) / VERIFIED WITH LOCAL HTTP (auth, isolation).**

### A real vulnerability was found and fixed

Before this phase the crawler **actually fetched** `http://localhost:3000/api/health`
and `http://0.0.0.0:3000/`. This was a genuine SSRF hole, not a theoretical
one. It is fixed in `72780df` by a new deny-by-default guard
(`src/lib/discovery/net-guard.ts`) that runs **before** robots/throttle checks
**and again on every redirect hop**.

Result: **13/13 SSRF probes BLOCKED in 6 ms**, plus **43/43 guard unit tests**.
Blocked: loopback, RFC1918 private ranges, CGNAT, link-local,
`169.254.169.254` (cloud metadata), `::`/`0.0.0.0`, `fd00::`/`fe80::`, decimal
`2130706433`, IPv6-embedded `::ffff:7f00:1`, `.internal`/`.local` suffixes,
single-label internal hostnames, and the `file:`/`ftp:`/`data:`/`javascript:`
schemes. Correctly still allowed: `172.32.0.1`, `11.0.0.1`, `8.8.8.8`.

*(Note: `new URL()` rewrites `::ffff:127.0.0.1` to `::ffff:7f00:1`, so a
dotted-quad-only regex would have let loopback straight through. The guard
handles the normalized form.)*

### Other security checks

| Area | Result |
|---|---|
| Authentication | invalid credentials rejected 401; no user enumeration |
| Workspace isolation | cross-workspace mutation refused, target unchanged; `workspaceId` always derived from `requireUser()`, never from the browser |
| Session handling | digest-only storage, server-side revocation on logout, forged tokens rejected |
| Robots | respected; blocked resources recorded as BLOCKED, never bypassed |
| Crawler output | sanitised before storage |
| Error leakage | server action failures log without payloads; no SQL or stack traces reach the browser |
| Secrets | none committed; no `.env` tracked; nothing logged |

---

## 10. Performance (§24)

**Category: VERIFIED AGAINST REAL PUBLIC SOURCE (small controlled runs).**

| Run | Pages | Success | Fail | Duration | Records | Companies | Signals | Opps |
|---|---|---|---|---|---|---|---|---|
| GitHub cycle 1 | 1 | 1 | 0 | 1205 ms | 6 | 6 created | 0 | 0 |
| GitHub cycle 2 | 1 | 1 | 0 | 815 ms | 6 | 6 matched | 0 | 0 |
| pypi.org crawl | 5 | 5 | 0 | 4232 ms | 6 obs | 1 | 1 | 0 |
| Knowledge ingest | 3 | 3 | 0 | 922 ms total | 3 resources | — | — | — |

Dominant cost is **network latency**, not computation: the pypi.org crawl
averaged ~846 ms/page, deliberately inflated by the 1000–1500 ms politeness
interval. Database work is negligible at this scale (cycle 2 was 32% faster
than cycle 1 because matching beats creating). The real bottleneck at scale
will be per-host rate limiting — which is a correctness and courtesy feature,
not a defect. No paid infrastructure was used anywhere.

---

## 11. Data quality and no-demo-data audits (§25, §26)

**Category: VERIFIED (real records inspected individually).**

**Data quality:** all 6 real discovered companies classified **CORRECT** — every
observation carries `sourceUrl`, `observedAt`, `method` and `confidence > 0`.
Zero WRONG, zero DUPLICATE, zero UNVERIFIED. (Sample size is 6, not the ≥20 the
gate asks for — see §13.)

**No demo data:** a fresh `p15_validation` database built purely by the real
migration path contains **24 tables, 111 indexes, 42 foreign keys, 21 enums and
0 business rows**. Discovery created **0 leads** on its own
(`leadsCreatedByDiscovery: 0`); an explicit `syncCompanyToLead({createIfMissing: true})`
then created exactly 1. No demo data, fake leads, mock revenue or sample
credentials exist anywhere in the system.

---

## 12. Tests, build and schema (§27)

**Category: VERIFIED OFFLINE.** All re-run at HEAD `81e70cd`:

| Check | Result |
|---|---|
| `npm test` | **44 files, 794 tests, all passing** (199.94 s) |
| P15 suites (`vitest.p15.config.ts`) | **6 files, 36 tests, all passing** |
| `npm run typecheck` | **exit 0** — genuine; no `--noResolve`, no `any` escapes, no `@ts-ignore` |
| `npm run lint` | **0 errors**, 1 pre-existing warning (`scripts/setup-rollback-test.mjs:33:12`) |
| `prisma validate` | **"The schema at prisma/schema.prisma is valid 🚀"** |
| `npm run prisma:parity` | **`SCHEMA_MATCHES_MIGRATION ✓`** |
| `npx next build` | **succeeds** |

No test was weakened, skipped or deleted to obtain a green result. The 794
pre-existing tests still pass; the 36 P15 tests are additive.

---

## 13. NOT VERIFIED — explicit list

These gates were **not** satisfied. This is the reason FreelanceOS is not
certified production-ready.

1. **§4 — Production database engine path.** Prisma's native query engine for
   `debian-openssl-3.0.x` cannot be downloaded here (`binaries.prisma.sh`,
   `prisma-builds.s3`, `objects.githubusercontent.com` all unreachable). The
   running app was validated through the `driverAdapters`/`queryCompiler` path
   instead. **The exact engine path production will use is unverified.**
   Third-party engine mirrors were deliberately rejected as untrusted.
2. **§28 — Real browser UAT.** No Chromium is available in the sandbox, so all
   UI verification was HTTP-level (status codes, rendered markup, responsive
   classes, absence of error strings) plus server-action-level persistence
   checks. **No page was actually loaded in a browser**, so client-side
   hydration, JavaScript interactivity and true mobile/tablet rendering are
   unverified.
3. **§15 — Service breadth.** Only **1 of the 11 services**
   (`WEBSITE_CREATION`) was exercised end-to-end, plus one
   `SOCIAL_MEDIA_ACTIVITY` signal from a real site. The other 10 services have
   unit coverage but **no real-data end-to-end proof**.
4. **§8/§9 — Internet breadth.** The gate asks for ~5–20 permitted public
   sources. Only **5 hosts are reachable** from this sandbox and 3 were used
   for discovery/knowledge. Most of the intended source *types* (RSS/Atom
   feeds, sitemaps, career pages, public directories) were **not** exercised
   against real live endpoints — only against local fixtures.
5. **§25 — Sample size.** 6 real records were inspected, not the **≥20** the
   gate requires. No systematic data-quality problem was found in those 6, but
   the sample is too small to generalise.
6. **§16 — Worker in production form.** `npm run worker` boots and loops but
   cannot reach the database without the native engine; its job processing was
   proven through the WASM test client, not the production binary.
7. **§21 — Market intelligence at scale.** Correctly *refuses* to draw
   conclusions at `sampleSize: 6`. Its behaviour with a statistically
   meaningful corpus is therefore unverified.
8. **§22 — Scheduler.** Two cycles were simulated locally, as instructed. The
   production twice-daily schedule was **not** enabled and remains untested by
   design.
9. **Load/scale.** No concurrency, soak or large-corpus testing was performed.
   All runs were single-user, ≤6 pages.

---

## 14. Production activation status (§31)

**All production activation remains OFF, as required:**

- No Render deploy. No deployment of any kind.
- No production Supabase access or modification. All work used a disposable
  local PostgreSQL 18.4 instance on `127.0.0.1:55432`.
- No twice-daily global scanning enabled.
- No unrestricted crawling — narrow allow-list, robots respected, rate limited.
- No automated outreach.
- No GitHub settings changed. No merge to `main`. No force-push.

§29 deliverables are **prepared but not executed**, documented in
`docs/PRODUCTION-RUNBOOK.md`: environment variable list, migration procedure,
start commands, scheduler configuration, health checks, logging and recovery
procedures — including the warning that `PRISMA_SCHEMA_ENGINE_BINARY` must
never be set in production, because with a stub it makes `prisma migrate
deploy` a **silent no-op that exits 0 without applying anything**.

---

## 15. Summary

What genuinely works, proven against real PostgreSQL and real public sources:
the additive-only CRM guarantee, idempotent repeated discovery, append-only
observation history with full provenance, deterministic and explainable
scoring, safe concurrent worker job claiming with crash recovery, evidence-
disciplined signal generation, honest empty states and sample-size refusals,
knowledge ingestion with attribution and no fabrication, and a crawler that now
refuses SSRF targets.

What this validation also did was find a **real SSRF vulnerability** and a
**vacuous-pass trap** in the validation itself — both are documented above
rather than smoothed over.

FreelanceOS behaves correctly on the evidence gathered, but **it is not
production-ready**: the production database engine path, real browser
behaviour, service breadth and data-quality sample size all remain unverified.
Per §32, no deployment has been performed and none should be until those gates
are closed.
