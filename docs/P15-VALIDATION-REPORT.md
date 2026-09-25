# P15 — Real-World Validation, Live Discovery & Production Hardening

**Validation date:** 2026-09-25 (Asia/Kolkata)

**Starting application revision:** `d868556006ab99633e6d13d1b3b368b8e7f77b94`

**Working branch:** `arena/01a0d9c1-freelanceos`

**Verdict:** **NOT PRODUCTION-READY. Do not deploy.**

This report supersedes earlier P15 narrative that described an adapter-backed
runtime as if it were the normal production Prisma runtime. That distinction is
material: the committed normal Prisma client could not be generated in this
environment, and database-backed application routes therefore fail at runtime.

Every result below is explicitly labelled as one of:

- **LOCAL FIXTURE / TEST-ADAPTER** — Vitest against a disposable PostgreSQL
  database using the test-only generated client and driver adapter.
- **LOCAL POSTGRESQL ARTIFACT** — native PostgreSQL schema/migration-artifact
  verification, but not a successful Prisma production migration command.
- **REAL PUBLIC SOURCE** — an actual unauthenticated, robots-aware request to
  the named public endpoint.
- **NOT VERIFIED / BLOCKED** — a gate that did not complete. It is not claimed
  as passed.

No production database, Supabase project, hosting service, scheduler, global
scan, automatic outreach mechanism, or customer data was touched.

---

## 1. Git, repository, and architecture audit

### Git state

- Work remained on `arena/01a0d9c1-freelanceos`; history was not reset,
  force-pushed, or rewritten.
- The starting parent of this validation work was `d868556` (`P15: validation
  report and production runbook (prepared, not deployed)`).
- `origin/main` remains at the supplied baseline lineage; no merge to `main`
  occurred during P15.
- `gh pr view` found no pull request for this Arena branch at audit time.
- No tracked `.env`/credential file was found or created. Generated build,
  dependency, and test-client output remains ignored.

### Implementation reviewed before remediation

The audit covered the Next.js App Router application, server actions and session
handling, Prisma schema and all four committed migrations, CRM/history logic,
discovery providers/pipeline/entity resolution, queue/worker, knowledge engine,
dashboard/statistics, SSRF/robots/fetching controls, Vitest configuration, and
production configuration/runbook.

Relevant architecture findings:

| Area | Observed implementation | P15 conclusion |
|---|---|---|
| Database | Prisma 6 schema plus four SQL migrations; normal app imports `@prisma/client` from `src/lib/db-client.ts` | Correct intended production architecture, but normal client generation is blocked here. |
| Discovery | Website, public repository, directory, feed, media, sitemap and CSV providers feed an additive ingestion pipeline | Proven extensively with local fixtures and partially with real public sources. |
| CRM preservation | Observations are append-only; precedence prevents weaker crawler facts from replacing manual/stronger facts | Proven in PostgreSQL-backed tests. |
| Queue/worker | Postgres-backed leased jobs with heartbeat/recovery and `SKIP LOCKED` claiming | Proven through the test client against PostgreSQL; normal worker runtime remains blocked with normal Prisma. |
| Knowledge | Attributed/excerpted resource ingestion; no full-document storage | Real-source ingestion succeeded. |
| UI/browser | Server-rendered routes and server actions exist | Browser UAT was not possible; normal DB-backed page rendering is currently blocked. |

---

## 2. Remediation performed during P15

P15 found two real data-quality problems in actual public-source evidence and
fixed them conservatively in source code rather than editing retained rows by
hand.

### 2.1 Website-provider ownership scoping

A real `https://pypi.org` run had previously attributed both of these to PyPI:

- `support@odoo-community.org`, found on an unrelated package subpage; and
- `https://about.facebook.com/meta/`, a PyPI sponsor link rather than PyPI's
  Facebook profile.

The cause was systemic: sitemap selection accepted any URL containing a broad
keyword such as `legal`, and generic extraction accepted the first matching
mailto/social URL anywhere in fetched markup.

The remediation:

1. `website.ts` now follows only the target host (or its conventional
   `www`/non-`www` equivalent), including sitemap-index entries and final
   redirect responses. It will not use a third-party redirect response as
   company evidence.
2. Sitemap candidates must be top-level information-page paths such as
   `/contact`, `/about-us`, `/legal`, `/team`, or an optional language-prefixed
   version. `/projects/partner-contact` no longer qualifies merely because its
   text contains `contact`.
3. `extract.ts` accepts markup social profiles only where the anchor explicitly
   identifies itself using a platform label in non-`href` attributes (for
   example, `aria-label`, `title`, class/data attributes) or `rel="me"`.
   A platform URL alone is not ownership evidence. Published Organization
   JSON-LD `sameAs` remains supported.
4. Regression coverage now proves that sponsor URLs are not promoted and that
   an explicit labelled social anchor still is.

**Result — REAL PUBLIC SOURCE:** the final PyPI evidence had exactly four
meta facts (`name`, `website`, `description`, `language`), no email, no phone,
and no social profile. The known Odoo email and Meta sponsor URL were absent.
No real PyPI signal/opportunity was manufactured from the crawl.

### 2.2 Repository-provider identity and shared-host safety

The bounded real-data audit exposed another systemic risk: a GitHub repository
owner was being used as the display name for every repository homepage. For
example, Vercel-owned repositories can advertise independent brands, package
registry pages, or hosted technical endpoints. Calling each one “vercel” is a
plausible but unsupported ownership claim.

The remediation:

1. `public-repository` now treats the advertised homepage domain as the
   candidate identity and does **not** infer a company name from `owner.login`
   or the repository name. A first-party source may add a name later with
   provenance.
2. Repository homepage discovery filters package-registry hosts (`npmjs.com`,
   `pypi.org`, `rubygems.org`, `crates.io`, `packagist.org`, `nuget.org`,
   `jsr.io`). Those paths prove package publication, not a customer business.
   Deliberate website/knowledge use of those domains is unaffected.
3. Canonical-domain handling now treats common multi-tenant hosting suffixes
   (`github.io`, `gitlab.io`, `bitbucket.io`, `vercel.app`, `vercel.sh`,
   `netlify.app`, `pages.dev`, `workers.dev`, `web.app`, `firebaseapp.com`,
   `surge.sh`, `fly.dev`, `onrender.com`) like multi-part suffixes. Thus,
   `avatar.vercel.sh` and `release-auth.vercel.sh` cannot merge into a shared
   `vercel.sh` company.
4. Regression tests pin both the no-owner-name rule and hosted-tenant domain
   separation.

These changes are additive/safety-oriented. They do not delete CRM data,
rewrite history, weaken assertions, disable robots, or add an outbound
messaging path.

---

## 3. Database and migration validation

### LOCAL POSTGRESQL ARTIFACT

A disposable, loopback-only native PostgreSQL **16.14** instance was used at
`127.0.0.1:55432`, database `freelanceos_p15`. It is not production data and
was outside the repository.

| Check | Result |
|---|---|
| Clean schema constructed by replaying committed migration SQL | Completed successfully (artifact verification only) |
| Schema objects observed | **24 tables, 110 indexes, 42 foreign keys, 21 enums** |
| `npm run prisma:parity` | Passed: `SCHEMA_MATCHES_MIGRATION ✓` |
| Fake/demo companies/leads seeded | No |

### Production migration path: BLOCKED

All of the following were attempted with the local `DATABASE_URL` and
`DIRECT_URL`, including a trusted OS CA bundle; all failed before substantive
Prisma work because Prisma could not retrieve its native schema engine:

```text
https://binaries.prisma.sh/.../debian-openssl-3.0.x/schema-engine.gz.sha256
Client network socket disconnected before secure TLS connection was established
```

| Command | Outcome |
|---|---|
| `npx prisma migrate deploy` | Failed before migration execution |
| `npm run prisma:generate` | Failed; normal `@prisma/client` remains ungenerated |
| `npm run prisma:validate` | Failed before validation |

Manual SQL replay and parity prove that committed artifacts agree; they do
**not** prove the production `prisma migrate deploy` path. No fake engine,
stub, WASM substitute, PGlite substitute, or production-architecture adapter
workaround was used to disguise this failure.

---

## 4. Normal application runtime and browser/UAT status

### Normal committed runtime: BLOCKED

The actual committed app was started with normal runtime environment variables
and `next dev --hostname 0.0.0.0`; the server itself became ready.

| Endpoint / route | Observed HTTP result |
|---|---|
| `/api/health` | **200** `{"status":"ok"}` |
| `/login` | **200** |
| `/api/init-status` | **500** |
| `/`, `/dashboard`, `/leads`, `/contacts`, `/tasks`, `/follow-ups`, `/pipeline`, `/settings` | **500** |

The server log identifies the cause for every database-backed route:

```text
@prisma/client did not initialize yet. Please run "prisma generate"
```

This is a mandatory production-runtime blocker. It is not hidden behind a
Vitest alias, and the report does not represent adapter-backed tests as normal
application verification.

### Browser UAT: NOT VERIFIED

No browser or browser-automation runtime was present in this sandbox.
Additionally, the DB/auth UI flow cannot work through normal Prisma while the
client is ungenerated. No claim is made for browser rendering, hydration,
interactive form behavior, responsive breakpoints, or an end-user login flow.

---

## 5. Quality gates

### LOCAL FIXTURE / TEST-ADAPTER

The two Vitest configs contain a narrowly scoped, test-only exact alias for
`@prisma/client` to `tests/.generated/client/index.js`. It exists because the
normal client cannot be generated in this environment. Production imports,
schema, migrations, and runtime architecture were not changed. This lets test
code use a generated driver-adapter client against the disposable native
PostgreSQL database; it is explicitly not production-runtime evidence.

| Command | Final result |
|---|---|
| `npm test` | **44 files, 798 tests passed** in **218.54 s** |
| `npm run lint` | **Passed**, no warnings/errors |
| `npm run prisma:parity` | **Passed** |
| `npm run typecheck` | **Failed** (157 errors cascading from ungenerated normal Prisma types) |
| `npm run prisma:generate` | **Failed** — network/schema-engine blocker above |
| `npm run prisma:validate` | **Failed** — network/schema-engine blocker above |
| `npm run build` | **Not run as a passing gate**; its mandatory initial `prisma generate` prerequisite is currently known to fail |

The current `typecheck` failure includes missing normal Prisma exports such as
`LeadStatus`, `TaskStatus`, and `Prisma.*WhereInput`; that missing type surface
also produces secondary implicit-`any` errors. The P15 remediation files were
checked against that output and introduced no reported TypeScript error, but
the quality gate is **not green** until a normal client can be generated and
full typecheck can run.

`npm audit --json` reported **7 vulnerabilities**: **3 moderate, 4 high,
0 critical**. No automatic semver-major dependency upgrade was applied during
this validation.

---

## 6. CRM, history, worker, dashboard, and knowledge

### LOCAL FIXTURE / TEST-ADAPTER, backed by native PostgreSQL

The following P15 contracts passed in the real database test harness:

- **CRM/actions:** 6 tests. Lead creation/edit/qualification/status/archive and
  restore, contacts, decision-maker flags, tasks, follow-ups, attributed
  activities, and cross-workspace refusal.
- **Permanent/additive CRM:** 7 tests. Discovery did not delete or replace
  human leads, contacts, notes, activities, or populated human values. It
  filled blank fields only, kept rejected observations, retained historical
  changes, and remained idempotent.
- **Worker recovery:** 8 tests. Concurrent claim distribution, lease expiry,
  heartbeat, retry exhaustion, non-retryable failure, and simulated total
  worker crash behavior were all exercised.
- **Dashboard/statistics:** fixture tests verify database-derived counts,
  source health, opportunity data, and small-sample honesty.
- **Security:** workspace isolation, session hashing/revocation, safe errors,
  SSRF guarding, and robots enforcement all remain covered. The P15 SSRF suite
  passed **13/13**; the general fixture suite includes **43** network-guard
  tests.

This is strong behavior evidence, but remains distinct from normal app/worker
runtime evidence because of the normal Prisma generation failure.

### REAL PUBLIC SOURCE — knowledge

Current P15 knowledge tests successfully fetched and ingested attributed,
excerpted resources from:

| URL | Result |
|---|---|
| `https://pypi.org` | Created attributed resource; 27,902 bytes fetched, excerpt stored rather than full page |
| `https://github.com/about` | Created attributed resource; approximately 294 KB source reduced to a bounded excerpt |
| `https://api.github.com/zen` | Later affected by the GitHub 401 environment failure; the suite still correctly retained only successful resources |

Knowledge tests passed **4/4** in the latest full P15 run. No CAPTCHA,
paywall, authentication, robots bypass, or wholesale page-content storage was
used.

---

## 7. Controlled real-public-source discovery

### Rules applied

All live requests were small and controlled, used a descriptive
`FreelanceOSBot/0.1` User-Agent, honored robots rules, were rate-limited, and
did not use tokens, login, CAPTCHA/payload bypasses, broad crawling, or
outbound messaging.

### PyPI website-provider regression run — REAL PUBLIC SOURCE

The final PyPI crawl completed with:

| Measure | Result |
|---|---|
| Pages attempted / succeeded / failed / blocked | **5 / 3 / 2 / 0** |
| Company | `PyPI`, `pypi.org` |
| Retained facts | 4 (`META_TAG`, confidence 70) |
| Email / phone / social profiles | all `null` |
| Real signals / opportunities | 0 / 0 |

The previously contaminated Odoo email and Meta sponsor URL are expressly
regression-tested as absent. A separate **controlled fixture** still proves the
signal → `WEBSITE_CREATION` opportunity → explained action chain; it must not
be confused with a real PyPI business signal.

### GitHub repository discovery — REAL PUBLIC SOURCE when egress permitted

While GitHub's unauthenticated public API was reachable, the current
post-remediation `tests/p15/end-to-end.test.ts` completed **9/9** against
`https://api.github.com/orgs/vercel/repos?per_page=30`:

| Measure | Cycle 1 | Cycle 2 |
|---|---:|---:|
| Pages succeeded | 1 | 1 |
| Entities found | 6 | 6 |
| Companies created | 6 | 0 |
| Companies matched | 0 | 6 |
| Final observations | \- | 12 |

A direct raw GitHub API inspection established the source-to-homepage mapping
for the retained records listed in §8. The package-registry URLs present in the
same GitHub response were filtered rather than becoming candidates.

Earlier during P15, a separate real GitHub search run persisted 13 deduplicated
companies and then matched all 13 on the repeat run while observations grew
from 13 to 26. A real GitHub robots-disallowed URL was recorded as `BLOCKED`;
it was not bypassed.

### Latest full live-suite rerun: external egress regression, not masked

The final complete P15 invocation did **not** go green:

```text
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
TEST_DATABASE_URL=... npx vitest run --config vitest.p15.config.ts
```

It produced **6 passing files / 48 passing tests** and **2 failed files /
8 failed tests**. Every failure depended on the public GitHub API, which began
returning HTTP **401** with body `{"message":"Bad credentials"}` even for a
plain unauthenticated direct Node fetch. No GitHub credential was requested,
provided, disabled, or bypassed. The same run's PyPI, CRM, worker, SSRF, and
knowledge tests continued to pass.

A full P15 run had passed **8 files / 56 tests in 40.78 s** earlier in the
session after the PyPI fix. The current-source GitHub end-to-end test then
passed separately after the repository/canonical remediation. The final
all-suite result is nevertheless correctly recorded as **NOT GREEN**, because
current public egress is no longer usable for GitHub validation.

---

## 8. Bounded retained-record data-quality assessment

### REAL PUBLIC SOURCE / manual source-payload inspection

Seven retained records were assessed: one direct PyPI website record and six
records from the permitted public GitHub Vercel-org response. This is a bounded
sample, not a claim of market-wide accuracy.

| Retained identity | Raw source mapping inspected | Assessment |
|---|---|---|
| `pypi.org` / `PyPI` | Direct PyPI homepage | Correctly retains first-party meta facts only; known third-party email/sponsor-social contamination is absent. |
| `hyper.is` | `vercel/hyper`, `vercel/hyperpower`, `vercel/hyper-site` homepages | Source URL attribution verified. Retained as the observed domain, not falsely named Vercel. |
| `vercel.com` | `vercel/vercel` homepage | Source URL attribution verified; domain is a clear first-party brand candidate. |
| `nextjs.org` | `vercel/next.js` homepage | Source URL attribution verified; no unsupported Vercel name is written to the Next.js record. |
| `release-auth.vercel.sh` | `vercel/release-auth` homepage | Exact technical endpoint preserved as its own hosted-tenant identity; **human relevance review required** before pursuing. |
| `avatar.vercel.sh` | `vercel/avatar` homepage | Exact technical endpoint preserved as its own hosted-tenant identity; **human relevance review required** before pursuing. |
| `err.sh` | `vercel/err-sh` homepage | Source URL attribution verified; **human relevance review required** before pursuing. |

Results:

- **7/7** retained records have source URL, method, evidence/locator, timestamp,
  and nonzero confidence where applicable.
- **0** duplicate hosted tenants after the canonical-domain fix.
- **0** unsupported GitHub-owner display names after the repository-provider
  fix.
- **0** package-registry homepage candidates in the post-fix Vercel-org run.
- **3** technical endpoints remain deliberately unqualified prospects. The
  system created no lead automatically; an explicit human sync is still
  required.

This is materially stronger than marking records “correct” merely because they
have provenance. It does **not** satisfy a broad 20-record/multi-source market
quality sample, and should not be generalized beyond the recorded sources.

---

## 9. Production preparation, activation, and non-actions

`docs/PRODUCTION-RUNBOOK.md` is prepared and updated with the verified schema
object baseline. It documents required environment variables, direct versus
pooled database URLs, a forward-only migration procedure, health checks,
worker operation, recovery, and a pre-deploy checklist.

The checklist is intentionally **not satisfied** in this sandbox because normal
Prisma generate/validate/migrate/typecheck/build gates are blocked or failing.

The following remained OFF/not performed:

- deployment or hosted preview release;
- production Supabase/database connection or data access;
- migration against production;
- global/twice-daily discovery scheduling;
- unrestricted crawling;
- automated outbound messaging;
- force-push, history rewrite, or merge to `main`.

---

## 10. Mandatory unresolved gates

FreelanceOS must not be called production-ready until these are resolved in a
suitable environment:

1. **Normal Prisma production path:** resolve trusted access to Prisma's engine
   artifacts, then run `prisma generate`, `prisma validate`, `prisma migrate
   deploy` on a clean non-production database, `npm run typecheck`, `npm run
   build`, normal app smoke/UAT, and normal worker smoke.
2. **Actual database-backed app runtime:** rerun `/api/init-status`, setup,
   auth/session flow, dashboard, CRM, discovery, knowledge, and settings over
   the normal generated client. Current DB-dependent app routes are 500.
3. **Browser UAT:** use a real browser to test login, setup, responsive UI,
   client-side behavior, CRUD forms, error states, and logout.
4. **Full current live P15 re-run:** re-run the entire 56-test public suite
   after the GitHub API/environment no longer returns the observed 401. Do not
   weaken the test to treat unexpected authentication denial as success.
5. **Live-source breadth:** validate more permitted source types and more
   independently controlled public sources without broad crawling. Current
   results are GitHub/PyPI-centric.
6. **Data-quality breadth:** complete a documented 20-record or otherwise
   approved broader manual sample across sources; retain the distinction
   between source attribution and business/lead relevance.
7. **Dependency remediation:** triage and address the 3 moderate and 4 high
   `npm audit` findings with compatibility/security testing.
8. **Scale/load and scheduling:** no long-running production schedule, soak
   test, or broad concurrency/load test was performed by design.

---

## 11. Final conclusion

P15 produced valuable validated evidence and caught real, source-level
false-attribution risks. The resulting changes make discovery more conservative:
first-party page scoping is tighter, arbitrary social/sponsor links are not
claimed as owned profiles, repository owners are not assumed to own every
homepage, package registries are filtered in repository discovery, and hosted
tenants are not merged under shared platform domains.

Local PostgreSQL-backed fixture verification is strong (**798 tests passed**),
and controlled real PyPI/GitHub/knowledge evidence was actually obtained.
However, the normal production Prisma client cannot currently be generated,
the application’s DB-backed routes return 500, browser UAT did not occur, the
final full live suite is currently blocked by a real GitHub 401 environment
response, and dependency vulnerabilities remain. Therefore the only factual
P15 conclusion is:

> **FreelanceOS is not production-ready. P15 stops here; P16 has not begun.**

---

# P15.1 — Remediation and revalidation (2026-09-26, Asia/Kolkata)

> **P15.1 decision: NOT PRODUCTION-READY — DO NOT DEPLOY.**
>
> P15.1 was limited to closing and revalidating P15 gates. It did not begin
> P16, deploy an application, access Supabase or other production data, enable
> a scheduler, widen crawling, or enable outbound messaging.

## P15.1.1 Repository provenance and scope reconciliation

The reported short SHA `c6aba29` remains unavailable. It was checked in local
refs/reflogs/object storage, the configured remote, and GitHub's public commit
API; the API returned `422 No commit found for SHA: c6aba29`. It is therefore
**not** represented as an existing commit or fabricated into history.

The preserved 15-file P15 delta was archived before reconciliation
(`c6-working-tree-delta.tgz`, SHA-256
`74a00bbe8eab600ccb0d1320775286deadd9d014210d933b0414924196d0b6c5`), then the
Arena branch ref was fast-forwarded only from the supplied baseline lineage to
its legitimate descendant `d868556`. The unchanged preserved worktree delta
was committed transparently as:

```text
6ff49ed P15: restore preserved attribution hardening
parent: d868556 P15: validation report and production runbook (prepared, not deployed)
```

No reset, checkout overwrite, force-push, history rewrite, deployment, or
production connection was used. P15.1 changes are confined to validation,
documentation, and a compatible dependency security override; no product or
business feature was added.

## P15.1.2 Prisma, clean local PostgreSQL, and normal-runtime recheck

A clean disposable embedded PostgreSQL **16.14** cluster was started for this
revalidation at `127.0.0.1:55432`. It contains only validation data and lives
outside the repository. `npm run prisma:parity` replayed all committed migration
SQL into a fresh scratch database and passed:

```text
SCHEMA_MATCHES_MIGRATION ✓  (migration SQL reproduces schema.prisma exactly)
```

This is strong **LOCAL POSTGRESQL ARTIFACT** evidence, but it is not a claim
that Prisma's normal migration engine ran.

The exact normal, committed Prisma 6.19.3 commands were re-run against that
clean disposable database with valid `DATABASE_URL` and `DIRECT_URL`:

| Normal command | Result |
|---|---|
| `npx prisma validate` | **BLOCKED** before validation |
| `npx prisma generate` | **BLOCKED** before client generation |
| `npx prisma migrate deploy` | **BLOCKED** before database migration work |

Each failed while retrieving Prisma's required schema-engine artifact from the
same engine commit/target, before schema or database work. The final repeat
requested `schema-engine.sha256` for validate/generate and
`schema-engine.gz.sha256` for migrate deploy:

```text
https://binaries.prisma.sh/all_commits/c2990dca591cba766e3b7ef5d9e8a84796e47ab7/debian-openssl-3.0.x/schema-engine[.gz].sha256
Client network socket disconnected before secure TLS connection was established
```

DNS resolution, OS CA use, and IPv4-oriented checks had already been attempted;
the repeat confirms an **ENVIRONMENT / PRISMA ARTIFACT-EGRESS BLOCKER**, not a
schema, migration, credential, or local-PostgreSQL defect. No stubbed engine,
WASM replacement, adapter substitution, or fake success was used for these
normal commands.

A normal `next dev` process was also started against the clean local database.
`GET /api/health` returned **200**; `GET /api/init-status` and `GET /` returned
**500** because the normal client is still ungenerated:

```text
@prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.
```

`npm run worker` was also invoked normally and exited before job processing
with `Cannot find module '.prisma/client/default'` through `src/lib/db-client.ts`.
Thus authenticated CRM, normal persistence, normal worker, and normal
application-runtime smoke remain **BLOCKED**, not passed. The test-adapter
results below are deliberately labelled separately.

## P15.1.3 Database-backed integration, history, worker, and safety results

**LOCAL FIXTURE / TEST-ADAPTER, backed by the disposable native PostgreSQL
cluster:** `npm test` completed **44 files / 798 tests passed** in **195.75 s**.
The generated client derives from the committed schema and uses the existing
narrow test-only driver-adapter alias; it is not the normal application client.

The full live P15 config was then re-run against the same disposable database:

```text
npx vitest run --config vitest.p15.config.ts
10 files / 60 tests passed in 49.46 s
```

That re-run includes authenticated CRM server actions, workspace isolation,
additive discovery, two-cycle idempotency, historical-observation preservation,
queue leasing/recovery/heartbeat/crash handling, dashboard reads, robots,
SSRF, real-source validation, and the P15.1 suites below. It is valid SQL
integration evidence, but it does **not** remove the normal-Prisma runtime
blocker.

### Service-catalog evidence coverage — controlled SQL validation

`tests/p15/service-catalog-coverage.test.ts` uses explicit, controlled facts
rather than claiming fabricated live prospects. It persisted **11 signals** and
**6 opportunities** through the real signal-storage path, verified explained
rationales and linked signals, confirmed no automatic CRM lead, and simulated a
factual change. The old `WEBSITE_OUTDATED` signal was marked `RESOLVED` rather
than deleted; its `firstSeenAt` and row count were preserved.

All **11/11** catalog services have an evidence-bearing signal → mapping →
rationale path. Five services (`LANDING_PAGE`, `CONTENT_CREATION`,
`SOCIAL_CONTENT`, `GRAPHICS_POSTERS`, `YOUTUBE_THUMBNAILS`) fell below the
existing production 20-point anti-noise display threshold for the one concrete
signal supplied, so P15.1 did **not** manufacture or persist weak
opportunities merely to inflate coverage. Their explainable mapping coverage
was audited without lowering the production threshold.

## P15.1.4 Revalidated real-public-source and data-quality evidence

Unauthenticated public GitHub access is available again. The exact previously
blocked P15 live suite was re-run rather than waived, and all live tests
passed. `api.github.com` returned successful public responses for `/zen`, a
repository read, a bounded repository search, and the Vercel organization
repository endpoint. GitHub is therefore no longer listed as a current
P15.1 external-source blocker.

`tests/p15/multi-source-records.test.ts` performed a small, descriptive,
robots-aware, rate-limited validation only:

| Public source/control | Result |
|---|---|
| GitHub public repository search, 20-item bounded payload | 13 attributed candidate Companies retained |
| GitHub Vercel-org repository payload, bounded to 30 items | 6 attributed candidate Companies retained |
| First-party `https://pypi.org` website-provider read | 1 Company with four first-party meta facts; 5 attempted / 3 succeeded / 2 failed pages |
| Repeat of GitHub search | 0 Companies created; 13 matched; observations remained append-only |
| npm registry public metadata control | 5 package records read and **not** ingested as Company/Lead records |

This produced **20 persisted candidate records**, each with nonzero confidence,
source URL, extraction method, locator, evidence, timestamp, and a unique
canonical domain. All repository-derived records retained only the advertised
homepage-domain identity (`name === canonicalDomain`) and `repo:homepage`
provenance; no GitHub owner/repository ownership inference was made. No
package-registry homepage entered repository discovery. **0 CRM leads** were
created automatically.

This is a bounded source-attribution assessment, not a claim that the 20
technical domains are verified businesses, decision makers, official social
profiles, or worthwhile prospects. Human relevance review remains required
before any explicit CRM sync or outreach.

## P15.1.5 Security review and dependency remediation

### Security review — PASS within the tested code scope

The review repeated the security-oriented suite and a targeted static audit:

- **43** discovery network-target/SSRF tests and **13** P15 SSRF tests passed.
  The crawler rejects loopback, private, link-local, cloud-metadata,
  non-public-hostname, malformed, unsupported-scheme, and redirect-hop targets;
  robots restrictions remain recorded rather than bypassed.
- Session hashing/revocation, malformed/tampered/expired-token handling,
  logout, setup/password validation, safe client-facing errors, workspace
  isolation, and CRM cross-workspace refusal are covered in the passing suite.
- No tracked secret/credential file was found; `.env`, `.env.local`, and the
  generated test client are ignored. The only string-pattern hit was an
  intentional test password fixture.
- No `eval`, dynamic `Function`, `dangerouslySetInnerHTML`,
  `$queryRawUnsafe`, or `$executeRawUnsafe` use was found. The sole application
  raw query is parameterised `Prisma.sql` for `FOR UPDATE SKIP LOCKED` queue
  claiming. `child_process` use is limited to test-client tooling.

Operational caveat: the current login/setup limiter is deliberately
in-memory/per-process. A multi-instance production deployment needs a shared
rate-limit store or a documented single-instance boundary; P15.1 did not add
infrastructure or weaken the existing controls.

### Dependency remediation — PARTIAL PASS

A compatible, reviewed override now deduplicates Next.js's nested vulnerable
PostCSS 8.4.31 to the exact `postcss@8.5.28`, retained as a production
dependency so a production-only install still satisfies Next.js's dependency:

```json
"overrides": { "postcss": "$postcss" }
```

`npm ci`, a clean `npm ci --omit=dev` dependency check (including Next.js's CSS
module), `npm ls postcss`, lint, the full fixture suite, and the full live P15
suite all passed after this change. `npm audit --json` fell from **7** findings
(3 moderate, 4 high) to **5** (2 moderate, 3 high), with no critical finding.
The remaining advisory paths are Prisma CLI/config → `deepmerge-ts` and
Vitest → `@vitest/mocker`; npm's offered fixes require incompatible/major (and
for Prisma, anomalous downgrade) changes. They were not applied blindly.

## P15.1.6 Quality gates and UAT status

| Gate | P15.1 result |
|---|---|
| `npm ci` | **PASS** |
| `npm run lint` | **PASS** |
| `npm test` | **PASS — 44 files / 798 tests** (test adapter / disposable PostgreSQL) |
| Full P15 live suite | **PASS — 10 files / 60 tests** (test adapter / disposable PostgreSQL plus real public sources) |
| `npm run prisma:parity` | **PASS** (migration artifact parity) |
| `npx prisma validate/generate/migrate deploy` | **BLOCKED** — Prisma artifact egress before substantive work |
| `npm run typecheck` | **BLOCKED** — 133 TypeScript diagnostic lines cascade from ungenerated normal Prisma types |
| `npm run build` | **BLOCKED** — mandatory initial `prisma generate` hits the same artifact egress failure |
| Normal DB-backed app/worker smoke | **BLOCKED** — normal client ungenerated; DB routes return 500 |
| Browser/UAT | **BLOCKED** — no Chromium/Chrome/Firefox or Playwright/Puppeteer available; normal DB/auth path is also blocked |

The production runbook was reviewed and requires no procedural change: it
already forbids the test-engine stub in production and makes a successful
normal Prisma engine download a deployment prerequisite. It was therefore not
edited merely to record a transient sandbox condition.

## P15.1.7 Remaining mandatory gates and final readiness decision

The following are genuine unresolved blockers; no other area is being claimed
as blocked:

1. **Prisma engine artifact access:** in an environment that can reach
   `binaries.prisma.sh`, run normal `prisma generate`, `prisma validate`, and
   `prisma migrate deploy` against a clean non-production database.
2. **Normal quality/runtime gates:** after normal generation, run typecheck and
   build, then normal-client authenticated CRM, persistence, worker, discovery,
   and two-cycle smoke tests. Current normal DB-backed routes are proven 500.
3. **Browser UAT:** provision a real browser and exercise login/setup, forms,
   responsive layouts, client-side interactions, error paths, logout, and
   session expiry using the normal generated client.
4. **Remaining dependency advisories:** explicitly assess compatible Prisma and
   Vitest upgrade paths; do not use a forced, breaking audit fix. Configure a
   shared limiter if deploying more than one application instance.

The prior GitHub/API, live-suite, 20-record controlled data-quality, service
mapping, local SQL, historical-change, worker, and security validation gates
were revalidated successfully within their stated scope. They do not outweigh
the normal Prisma/runtime/build/browser blockers.

> **FreelanceOS remains NOT PRODUCTION-READY. Do not deploy. P15.1 stops here;
> P16 has not begun.**

---

# P15.2 — Normal runtime, browser UAT and final validation (2026-09-25 UTC / 2026-09-26 Asia/Kolkata)

> **P15.2 decision: NOT READY — VALIDATION BLOCKERS REMAIN. Do not deploy.**
>
> P15.2 began from the merged `main` revision `4633905` and was limited to
> verification. It did not begin P16, add a product feature, redesign the UI,
> deploy anything, connect to production Supabase, enable a scheduler or crawler
> campaign, or send outbound messaging. No gate was weakened, skipped, mocked or
> rewritten to obtain a PASS, and no Prisma engine/client artifact was
> fabricated, stubbed or substituted for the normal runtime.

## P15.2.1 Repository provenance and scope

| Item | Value |
|---|---|
| Branch worked | `arena/01a0da5b-freelanceos` (session branch cut from `main`) |
| HEAD at start | `4633905f082e363831ea709635199c1d85e79262` (`Merge pull request #2 …`) |
| Working tree | Clean (`git status` empty) before any change |
| P15/P15.1 commits | Present: `6ff49ed`, `15b06b9`, `0b20c35` (via `0ad063e` → `4633905`) |
| History operations | None destructive — no reset, rebase, force-push, branch deletion or rewrite |

The checkout was **shallow/grafted** on arrival (`git rev-list --count HEAD` = 1,
`.git/shallow` present), so the named P15.1 commits were not in the local object
store. A read-only `git fetch --unshallow origin` deepened the same branch to
its real 21-commit history; the P15.1 commits then resolved and `git status`
remained clean. No ref was moved.

## P15.2.2 Prisma connectivity and the normal commands — BLOCKED (environment)

Direct connectivity test before any Prisma command:

| Target | Result |
|---|---|
| `https://binaries.prisma.sh/` | **TCP connects, TLS handshake reset** (`SSL_ERROR_SYSCALL`, `unexpected eof while reading`); plain HTTP returns an empty reply |
| `https://binaries-failover.prisma.sh/` | Same TLS reset |
| `https://downloads.prisma.sh/` | Same TLS reset |
| GitHub API / npm registry / PyPI | Reachable (`200`) |

The normal, unmodified commands were then run against the disposable database.
All three fail **before any schema, migration or database work**, retrieving the
same native schema-engine artifact:

```text
Error: request to https://binaries.prisma.sh/all_commits/c2990dca591cba766e3b7ef5d9e8a84796e47ab7/debian-openssl-3.0.x/schema-engine.gz.sha256 failed,
reason: Client network socket disconnected before secure TLS connection was established
```

| Normal command | Exit | Class |
|---|---|---|
| `npx prisma validate` | **1** | BLOCKED — ENVIRONMENT |
| `npx prisma generate` | **1** | BLOCKED — ENVIRONMENT |
| `npx prisma migrate deploy` | **1** | BLOCKED — ENVIRONMENT |

No legitimate artifact source remains: the npm registry is reachable but does
not carry the native engines (`@prisma/engines` ships only `dist/` + a
`postinstall.js`; no `.so`/`.gz`/`schema-engine*` file exists anywhere in the
installed Prisma packages), and the public CDNs that could mirror them
(`unpkg.com`, `cdn.jsdelivr.net`) are equally blocked (TLS reset). No stub,
WASM replacement, adapter substitution, fabricated generated file or
`PRISMA_SCHEMA_ENGINE_BINARY` escape hatch was used for these commands — that
remains a **test-tooling-only** mechanism (see P15.2.7).

## P15.2.3 Disposable PostgreSQL, migration artifacts and parity

A disposable, loopback-only native PostgreSQL **16.14** cluster was created
outside the repository at `127.0.0.1:55432` (`freelanceos_dev`,
`freelanceos_p152`). It contains no production data; no Supabase or other remote
database was contacted.

`npx prisma migrate deploy` is blocked (P15.2.2), so migration evidence is
**LOCAL POSTGRESQL ARTIFACT** evidence, clearly separated from the blocked
normal production path. Replaying the four committed migrations, in order, into
a brand-new database:

| Migration | Bytes | Tables after |
|---|---|---|
| `20260921113000_init` | 11383 | 10 |
| `20260921140000_session_token_hash` | 709 | 10 |
| `20260922090000_discovery_foundation` | 14767 | 19 |
| `20260922120000_research_knowledge_foundation` | 8136 | 24 |

| Check | Result |
|---|---|
| Object inventory | **24 tables, 110 indexes, 42 foreign keys, 21 enums (166 enum values)** — identical to the runbook baseline |
| Unexpected tables (not in `schema.prisma`) | **None** (`_OpportunityToSignal` is Prisma's implicit m2m join table) |
| Views / extra schemas | None |
| `npm run prisma:parity` | **PASS** — `SCHEMA_MATCHES_MIGRATION ✓` |
| Schema drift | None detected (tables, columns, types, nullability, indexes and enum values all match) |
| Migration data-loss scan | One intentional statement: `DELETE FROM "Session"` in `20260921140000_session_token_hash`, documented in-file as a one-time sign-out so no raw bearer token survives; sessions only — **no business-data deletion**. No `DROP TABLE/COLUMN/SCHEMA`, `TRUNCATE`, or column-type narrowing anywhere. |

## P15.2.4 Normal application runtime — BLOCKED (environment)

The committed application was started normally (`next dev -H 0.0.0.0`) with
normal runtime variables (`DATABASE_URL`, `DIRECT_URL`, `AUTH_SECRET`, `APP_URL`)
pointing at the disposable database, and **without** the test adapter.

| Route | Result |
|---|---|
| `/api/health` | **200** `{"status":"ok"}` |
| `/login` | **200** (16537-byte page) |
| `/api/init-status` | **500** |
| `/` | **500** |
| `/dashboard`, `/leads`, `/leads/new`, `/contacts`, `/tasks`, `/follow-ups`, `/pipeline`, `/settings`, `/setup` | **500** |

Every database-backed route fails with the same server-side cause:

```text
⨯ Error: @prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.
    at eval (src/lib/db-client.ts:21:3)   ← new PrismaClient({ … })
```

**The required authenticated workflow was not performed.** Steps 1–15 (login →
dashboard → create/edit/qualify/score lead → contact → task → follow-up →
activity → reload → persistence → workspace isolation → logout → protected-route
check) cannot run on the normal client, and executing them through the test
adapter would be adapter-backed behaviour, not the normal runtime this phase
requires. No mocked or faked database response was used, and the workflow is
recorded as **BLOCKED — ENVIRONMENT**, not passed.

## P15.2.5 Normal worker — BLOCKED (environment)

`npm run worker` (the normal, unmodified entry point) exits **1** immediately at
module import, before the loop starts, before any claim, and before the
scheduler timer is installed:

```text
Error: @prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.
    at new PrismaClient (node_modules/.prisma/client/default.js:43:11)
    at <anonymous> (src/lib/db-client.ts:21:3)
```

Consequently **no job was enqueued, claimed, processed, completed, retried or
recovered through the normal worker**, and no scheduler or discovery cycle ran.
Worker semantics were instead re-verified at the test-adapter level in P15.2.7.

## P15.2.6 Typecheck, lint and production build — BLOCKED (environment)

Run after the normal generation attempt (which failed), as required — these
gates depend on the generated client.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **BLOCKED — ENVIRONMENT.** Exit 2 with 157 diagnostics (64×TS7006, 42×TS2305, 27×TS2694, 13×TS2339, 4×TS2345, 4×TS18047, 2×TS2344, 1×TS2347). Every one traces to the ungenerated placeholder client — missing enum exports (`LeadStatus`, `TaskStatus`, `FollowUpChannel`, …), missing `Prisma.sql`/`Prisma.empty`, and implicit-`any` on untyped query results. This is neither a real application type failure nor a pass; it stays unresolved until generation succeeds. |
| `npm run lint` | **PASS** — exit 0, no findings. |
| `npx next build` | **BLOCKED — ENVIRONMENT.** Exit 1: `✓ Compiled successfully in 10.4s`, then `Failed to compile` / `Type error: Parameter 'entry' implicitly has an 'any' type` at `src/app/(app)/activities/page.tsx:60:40` — the same Prisma-typed cause. |

No `@ts-ignore`, `@ts-nocheck`, `ignoreBuildErrors`, config change or error
suppression was added.

## P15.2.7 Test-adapter regression re-run — LOCAL FIXTURE / TEST-ADAPTER evidence

Clearly labelled as adapter-backed, **not** normal-runtime evidence:

| Suite | Result |
|---|---|
| `npm test` (full regression) | **PASS — 44 files / 798 tests**, 179.87 s |
| P15 live suite (`vitest.p15.config.ts`) | **PASS — 10 files / 60 tests**, 45.27 s |

The 60-test suite really did exercise the named external endpoints
(unauthenticated, robots-aware, bounded — one GitHub search page, PyPI JSON,
`robots.txt`; no campaign, no broad crawl). Excerpts from the run:

- GitHub repository pipeline: `pagesSucceeded: 1`, `entitiesFound: 13`,
  `entitiesValid: 13`, `companiesCreated: 13` (e.g. `codecrafters.io`,
  `aihero.dev`, `apilayer.com`), and a repeat run created 0 duplicates.
- Real outcomes classified correctly: `SUCCESS` (200), a real `NOT_FOUND`
  (404 — never retried), an unreachable host as `NETWORK_ERROR`, `robots.txt`
  enforcement obeyed.
- Worker semantics (§16/§17): *never hands the same job to two workers*,
  *hands out each job exactly once when workers outnumber jobs*, *re-leases a
  job whose worker died without completing it*, *keeps a job alive while its
  worker is heartbeating*, *retries a failed job, then gives up and records
  why*, *does not retry a job that failed for a non-retryable reason*,
  *loses no job across a simulated crash of every worker*.
- Security: 13 SSRF-guard tests and the workspace-isolation, session-validation,
  session-hashing and logout suites all passed.

**Environment note (recorded, not hidden).** The first live-suite run in this
sandbox produced 10 failures / 50 passes, all `NETWORK_ERROR`: this environment
TLS-intercepts `github.com`/`api.github.com` with an **“E2B Proxy CA”** that the
system trust store accepts (so `curl` works) but Node's bundled store rejects
(`unable to verify the first certificate`). Re-running with the standard
Node mechanism `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` —
environment configuration, **no test change** — produced **60/60**. Both runs
are recorded so the difference is auditable.

## P15.2.8 Browser UAT — ENVIRONMENT BLOCKED

| Probe | Result |
|---|---|
| `chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable`, `chrome`, `firefox`, `firefox-esr`, `msedge` on `PATH` | All **missing** |
| Playwright / Puppeteer / Selenium (repo `npm ls`, global npm, filesystem `ms-playwright` cache) | **None installed** |
| Installed browser packages / offline apt candidate | None |

No browser runtime exists, so **BROWSER UAT = ENVIRONMENT BLOCKED**. No browser
was installed to turn this gate green, and HTTP-level checks are explicitly
**not** counted as browser validation. Not verified: desktop, tablet and mobile
layouts; client-side hydration and interactions; forms, buttons and actions;
empty/loading/error/validation states; session expiry and unauthorized access;
refresh persistence. (Even with a browser present, the normal DB/auth path is
additionally blocked by P15.2.2–P15.2.4, so an end-user login flow could not be
exercised.)

## P15.2.9 Dependency audit — 5 findings, no safe compatible remediation exists

`npm ci` installs 475 packages and `npm audit` reports **5 findings (2 moderate,
3 high, 0 critical)** — unchanged from the P15.1 baseline. Per-finding triage:

| # | Package | Direct? | Chain | Severity | Fixed version | Compatible upgrade? | Production/runtime relevance |
|---|---|---|---|---|---|---|---|
| 1 | `deepmerge-ts` < 8.0.0 (GHSA-ggr8-5vv4-36mx, stack exhaustion on recursive graphs) | No | `prisma` → `@prisma/config` → `deepmerge-ts` | high | 8.0.0+ | **No.** `@prisma/config@6.19.3` hard-pins the *exact* version `"deepmerge-ts": "7.1.5"`; there is no in-range patch, and no Prisma release in the advisory range fixes it | **Build tooling only.** Ships with the `prisma` CLI (devDependency); not part of the app's runtime dependency graph. This repo has **no `prisma.config.ts`**, so the config-merge path is not even reached by project configuration |
| 2 | `@prisma/config` (via #1) | No | `prisma` → `@prisma/config` | high | — | **No** (same as #1) | Build tooling only |
| 3 | `prisma` (CLI, via #2) | Yes | direct | high | only ≥ 8.2.0-dev line | **No.** npm's suggested "fix" is an anomalous *downgrade* to `prisma@6.12.0` | Build tooling only |
| 4 | `@vitest/mocker` (GHSA-82fw-gwwq-j7x9, path traversal in redirect mocks) | No | `vitest` → `@vitest/mocker` | moderate | 4.1.11+ | **No.** The 3.x line has no patched release (3.2.7 is both installed and latest) | Test-time only; requires an attacker-controlled redirect mock *inside a test file* — not runtime-reachable |
| 5 | `vitest` (via #4) | Yes | direct | moderate | 4.1.11+ / 5.x | **No** — a major tooling upgrade (3.2.7 → 4.1.11+), `npm audit fix` cannot do it without `--force` | Test-time only |

**Remediation applied: none, deliberately.** No `npm audit fix` (with or without
`--force`), no forced exact-pin override, no blind major upgrade, and no
suppression/allow-list was introduced, because none of the five findings has a
safe, semver-compatible fix available today:

- Forcing `deepmerge-ts@8.0.2` over Prisma's exact pin would be an unsupported
  substitution whose effect on the Prisma CLI **cannot be validated here** (the
  CLI itself is environment-blocked), i.e. an unverifiable change to the
  production build path.
- Upgrading Vitest across a major version changes the test toolchain that
  produced the 798-test baseline; it must be done deliberately, with the full
  suite re-run, and not merely to clear an advisory that has no runtime exposure.

`package.json` and `package-lock.json` are therefore unchanged.

## P15.2.10 Rate-limit topology — REQUIRES PRODUCTION TOPOLOGY DECISION

`src/lib/security/rate-limiter.ts` is a process-local `Map`-based limiter, used
by `POST /api/auth/login` (20 / 10 min per IP **and** 10 / 10 min per email) and
`POST /api/setup` (5 / 10 min per IP).

| Deployment shape | Status |
|---|---|
| Single application instance | **Safe.** All requests in the process share the counters; a restart merely resets them, which is acceptable for brute-force throttling. |
| Multiple application instances | **Not safe as a global limit.** Each instance keeps its own counters, so the effective allowance multiplies by the instance count. Multi-instance deployment **requires a shared rate-limit store** (or deliberate sticky single-instance routing). A shared store is a *deployment prerequisite for horizontal scaling*, not a current defect: the prepared `render.yaml` is a single instance. |

No Redis or paid service was introduced. A secondary observation is recorded for
operators: expired entries are only overwritten when the same key is consumed
again, so an attacker sending many distinct keys accumulates keys in memory for
the process's lifetime. This is bounded for a single-user deployment but worth
knowing before exposing the login route widely. The production runbook now
documents both points.

## P15.2.11 Production side effects — none

| Check | Result |
|---|---|
| Production Supabase migration/DDL executed | **No** — every database command targeted `127.0.0.1:55432` (created and owned by the disposable cluster). `npx prisma migrate deploy` never reached any database. |
| Production data modified | **No** — no remote database was contacted; no `SUPABASE*` environment variable or production credential exists in this environment. |
| Production scheduler activated | **No** — the worker never started (P15.2.5); production scheduling remains off. |
| Broad crawler activated | **No** — the only external requests were the bounded, robots-aware live-test requests described in P15.2.7. |
| Outbound campaign/email sent | **No** — no email/CRM/marketing SDK exists in the codebase or dependencies. |
| Paid API or paid SaaS introduced | **No** — dependency list unchanged; no new service or account. |
| Credentials/secrets committed | **No** — no `.env*` tracked (only `.env.example`), no secret-pattern matches in tracked files, working tree clean. |
| Deployment performed | **No** — nothing was deployed; the app was only run locally, in dev mode, against the disposable database. |

## P15.2.12 P15.2 gate summary

| Gate | P15.2 result |
|---|---|
| Repository provenance / clean tree | **PASS** |
| Disposable PostgreSQL (local only) | **PASS** |
| Migration artifact replay, object inventory, drift & data-loss checks | **PASS** (LOCAL POSTGRESQL ARTIFACT) |
| `npm run prisma:parity` | **PASS** |
| `npx prisma validate` / `generate` / `migrate deploy` | **BLOCKED — ENVIRONMENT** |
| `/api/health`, `/login` | **PASS** (HTTP-level) |
| `/api/init-status`, `/` and all DB-backed routes | **BLOCKED — ENVIRONMENT** (500, ungenerated client) |
| Authenticated 15-step CRM workflow, persistence, workspace isolation | **BLOCKED — ENVIRONMENT** (not performed on the normal client) |
| Normal worker startup / job lifecycle | **BLOCKED — ENVIRONMENT** |
| `npx tsc --noEmit` | **BLOCKED — ENVIRONMENT** (157 cascading diagnostics) |
| `npm run lint` | **PASS** |
| `npx next build` | **BLOCKED — ENVIRONMENT** |
| `npm test` | **PASS** — 44 files / 798 tests (TEST-ADAPTER) |
| P15 live suite | **PASS** — 10 files / 60 tests (TEST-ADAPTER + real public sources) |
| Browser UAT (desktop / tablet / mobile, states, session behaviour) | **BLOCKED — ENVIRONMENT** (no browser runtime) |
| `npm audit` | 5 findings (2 moderate, 3 high, 0 critical) — **no safe compatible remediation available** |
| Rate-limit topology | **REQUIRES PRODUCTION TOPOLOGY DECISION** |
| Security regression | **PASS** within the tested scope (no regression) |
| Production side effects | **NONE** (verified) |

## P15.2.13 Remaining blockers

Only genuine blockers are listed; nothing else is claimed as blocked.

1. **Prisma engine artifact access (ENVIRONMENT).** `binaries.prisma.sh`
   (and its failover mirror) is unreachable from this sandbox, so normal
   `prisma validate`, `prisma generate` and `prisma migrate deploy` cannot run.
   Resolve by validating in an environment with trusted access to Prisma's
   engine artifacts.
2. **Normal-client application runtime (ENVIRONMENT).** Until generation
   succeeds, `@prisma/client` stays uninitialised, `/api/init-status` and every
   DB-backed route return 500, and the authenticated 15-step CRM workflow,
   persistence, workspace isolation and logout checks cannot be performed.
3. **Normal worker runtime (ENVIRONMENT).** `npm run worker` exits 1 at import;
   no claim, processing, retry or recovery can be exercised normally.
4. **Typecheck and production build (ENVIRONMENT).** Both fail solely on
   types that the ungenerated client would provide.
5. **Browser UAT (ENVIRONMENT).** No browser or browser-automation runtime
   exists in the sandbox; desktop/tablet/mobile, interaction and session-state
   validation remain unverified.
6. **Remaining dependency findings (NO COMPATIBLE FIX).** 5 advisories
   (3 high / 2 moderate) on build-time and test-time tooling only; each requires
   an upstream Prisma release or a deliberately approved major Vitest upgrade.
7. **Rate-limit topology (DECISION, not a defect).** Single-instance
   deployment is safe; horizontal scaling requires a shared limiter.

> **FreelanceOS is NOT READY — VALIDATION BLOCKERS REMAIN. Do not deploy.
> P15.2 stops here; P16 has not begun.**
