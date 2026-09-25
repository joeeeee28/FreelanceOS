# FreelanceOS architecture audit

Read-only inspection performed at commit `0d47400` on branch
`arena/01a0c3a0-freelanceos`. No production code was modified while producing
this document.

Baseline re-verified before writing: `npm test` → **383 passed, 28 files**.

---

## 1. Current architecture map

### Database (`prisma/schema.prisma`, 793 lines, 3 migrations)

**CRM core (P0–P3, stable — do not rebuild):**

| Model | Purpose | Notes |
| --- | --- | --- |
| `AppInit` | One-row bootstrap guard | Prevents re-running setup |
| `Workspace` | Tenant root | `defaultCurrency`, `country`, `timezone` |
| `Setting` | Per-workspace settings | 1:1 with Workspace |
| `User` | Account | `passwordHash`, role |
| `Session` | Auth session | Stores `tokenHash`, never the raw token |
| `Lead` | The CRM lead | Flat: identity, contact, firmographics, qualification, `score`, `deletedAt`, now `companyId?` |
| `Contact` | Person at a lead | Has `isDecisionMaker`, `isPrimary` |
| `Activity` | Timeline entry | 19 `ActivityType` values; `createdByUserId` nullable since P4 |
| `Task` | To-do | Status/priority enums |
| `FollowUp` | Scheduled touch | Channel/sequence/status enums |

**Discovery layer (P4, new):**

| Model | Purpose |
| --- | --- |
| `Source` | A place we look; owns health counters and rate limits |
| `FetchLog` | One HTTP interaction; real numbers for source health |
| `Company` | Canonical business entity, with `canonicalDomain` unique per workspace |
| `Observation` | Append-only fact with provenance; `supersededAt` never deleted |
| `Signal` | Detected condition, unique per `(companyId, type)` |
| `Opportunity` | Sellable service, unique per `(companyId, serviceKey)` |
| `DiscoveryRun` | One pipeline execution with counted metrics |
| `Job` | Postgres queue row with leasing (`lockedBy`/`lockedUntil`) |

Enums added in P4: `ExtractionMethod`, `FetchOutcome`, `SourceStatus`,
`SignalType` (22 values), `SignalStatus`, `OpportunityStatus`,
`ResolutionState`, `JobStatus`, `JobType` (9 values), `RunStatus`.

### Authentication & authorization

- `src/lib/auth/require-user.ts` → `{ user, userId, workspaceId, workspace }`,
  redirects to `/login` when absent. **Every** data function calls this; the
  workspace is never accepted from the client.
- Sessions are JWT-signed (`jose`) with only a SHA-256 hash stored.
- `bcryptjs` for passwords, with a password policy module.
- Rate limiting in `src/lib/security/rate-limiter.ts` (in-memory, per process).

### Workspace isolation

Enforced by every query carrying `where: { workspaceId }` derived from the
session. Cross-workspace reads return `notFound()`, which deliberately
conflates "missing" and "not yours". Covered by
`tests/security/workspace-isolation.test.ts` and `crm-isolation.test.ts`.

### Server actions & API routes

- Two `"use server"` files: `leads/actions.ts` (15 actions) and
  `leads/new/actions.ts`.
- Five JSON API routes: `auth/login`, `auth/logout`, `health`, `init-status`,
  `setup`. **These are REST endpoints, not server actions.**

### UI

28 routes build. Live: dashboard, leads (+detail/new), pipeline, contacts,
tasks, follow-ups, activities. Placeholder (`ModulePlaceholder`, marked
"Soon"): outreach, clients, projects, content-calendar, proposals, invoices,
payments, expenses, analytics, settings.

### Scoring

`src/lib/crm/scoring.ts` — deterministic weights, `MAX_SCORE` 100, explainable
via `ScoreReason[]`. No AI involvement, and none may be introduced.

### Tests (28 files / 383 tests)

CRM (10 files), security (7), discovery (10), unit (1). Helpers:
`test-db.ts` (refuses non-local hosts, replays committed migrations),
`fixtures.ts` (`seedWorkspace` — structural records only, no business data),
`act-as.ts` (mocks only the identity boundary), `fixture-server.ts` (real
loopback HTTP for crawler tests).

### Packages

Runtime deps are deliberately few: `@prisma/client`, `@tanstack/react-query`,
`bcryptjs`, `jose`, `next`, `next-themes`, `react`, `server-only`, `zod`.
Dev: `prisma`, `vitest`, `pg`, `@prisma/adapter-pg`, `tailwindcss`,
`typescript`, `eslint`.

### Scripts

`dev`, `build`, `start`, `typecheck`, `lint`, `prisma:generate`,
`prisma:validate`, `prisma:migrate`, `prisma:parity`, `test`, `test:watch`,
`test:generate`.

### Git

Branch `arena/01a0c3a0-freelanceos`. Commits: `28acf09` (P0) → `e24eb19` (P1)
→ `4bcfce0` (P2) → `f153cf8` (P3) → `0d47400` (P4). `main` untouched at
`84dfb6e`.

---

## 2. Reusable components — reuse these, do not re-create

| Need | Existing component to reuse |
| --- | --- |
| Identity / tenancy | `requireUser()` |
| DB access | `src/lib/db.ts` (`db`), aliased to the test client in vitest |
| Lead writes | `createLead`, `updateLead`, `moveLead`, `addLeadNote` |
| Contact writes | `createContact`, `updateContact` |
| Activity timeline | `Activity` model + `ActivityType` |
| Deterministic scoring | `scoreLead`, `SCORE_WEIGHTS`, `scoreMetadata` |
| Stage rules | `canTransition`, `ALLOWED_TRANSITIONS`, `STATUS_STAGE` |
| Action plumbing | `runAction`, `success`, `failure`, `toActionError` |
| Validation | `src/lib/crm/validation.ts` zod schemas |
| Pagination | `normalisePaging`, `Paginated<T>` |
| Time / timezone | `src/lib/time/zoned.ts` |
| Provenance & confidence | `src/lib/discovery/provenance.ts` |
| Canonicalisation | `src/lib/discovery/canonical.ts` |
| Entity resolution | `src/lib/discovery/resolution.ts` |
| Additive writes | `src/lib/discovery/ingest.ts` |
| Crawl policy | `robots.ts`, `fetcher.ts` |
| Extraction | `extract.ts` |
| Provider contract | `provider.ts`, `ProviderRegistry` |
| Job queue | `src/lib/jobs/queue.ts` |
| Service taxonomy | `src/lib/taxonomy/services.ts` |
| UI kit | `components/ui/*`, `components/crm/*`, `KpiTile`, `PageHeader` |
| Test fixtures | `seedWorkspace`, `startFixtureServer`, `actAsFactory` |

---

## 3. Missing capabilities

| Area | Status | Gap |
| --- | --- | --- |
| DISCOVERY | Partial | Provider contract + one website provider exist. Missing: sitemap, RSS/Atom, job-signal, career-page, directory, GitHub, public-media, CSV/manual providers; no registry wiring; no `Source` CRUD. |
| INTELLIGENCE | Missing | No signal detection from observations. |
| OPPORTUNITIES | Missing | `Opportunity` table exists but nothing writes it; no signal→service mapping; no opportunity scoring. |
| KNOWLEDGE ENGINE | Missing | No models, no ingestion, no Knowledge Hub. |
| WORKERS | Missing | Queue exists; no worker entrypoint, no job handlers. |
| SCHEDULING | Missing | No two-cycles-per-day scheduler, no cycle config. |
| SOURCE HEALTH | Partial | `Source` counters and `FetchLog` exist; nothing writes or displays them. |
| MARKET INTELLIGENCE | Missing | No aggregation layer, no sample-size reporting. |
| RESEARCH | Missing | `lastResearchAt` exists; no freshness logic, no research status. |
| DECISION MAKERS | Partial | `Contact.isDecisionMaker` exists; no discovery path. |
| CRM SYNC | Partial | `ingest.ts` writes Company/Observation; does **not** yet create or enrich `Lead`, `Contact` or `Activity`. |

---

## 4. Database changes required

The P4 migration already covers Company, Source, Observation, Signal,
Opportunity, DiscoveryRun, Job and FetchLog. Still required:

1. **Research history** — `ResearchRun` per company+aspect with freshness
   windows and a `ResearchStatus` enum (`NEVER`/`PARTIAL`/`RESEARCHED`/
   `STALE`/`BLOCKED`/`NEEDS_REVIEW`).
2. **Decision-maker discovery** — `DiscoveredContact`, staged and provenance-
   bearing, promoted into `Contact` only when verified. Must not pollute the
   CRM `Contact` table with unverified guesses.
3. **Knowledge engine** — `KnowledgeResource` (title, source, url, author,
   publishedAt, discoveredAt, summary, sourceType, attribution),
   `KnowledgeTopic`, join table, plus service-relevance links.
4. **Market intelligence** — `MarketObservation` (or derive on read). Prefer
   deriving from existing tables where possible to avoid a duplicate source of
   truth; a snapshot table only if query cost demands it.
5. **Opportunity evidence** — `Opportunity` needs `recommendedAction` and a
   `detectedAt`; evidence is reachable via linked `Signal`s.
6. **Scheduling config** — `DiscoverySchedule` or settings-backed cycle times.

All additive. No existing column may be dropped or retyped.

---

## 5. New packages required

| Package | Verdict |
| --- | --- |
| `crawlee` | **Approved but not yet justified.** The current `HttpFetcher` already implements queueing, retries, backoff, per-origin throttling, timeouts and robots enforcement in ~300 tested lines. Adding Crawlee now would duplicate that and move robots handling out of the one place it is currently provable. Recommend deferring until a provider genuinely needs its request-queue persistence. |
| `playwright` | **Not approved this round** and not needed: no provider requires JS rendering yet. Chromium also cannot be downloaded in this sandbox. |
| `scrapy` | **Rejected** — Python; would add a second runtime to a Node project. |
| `fast-xml-parser` | **Likely needed** for robust RSS/Atom/sitemap parsing. Current regex extraction is adequate for `<loc>` but brittle for Atom. Small, zero-dependency, MIT. |
| `cheerio` | **Optional.** Current regex extraction is deliberately narrow and safe. Only add if selector-based extraction becomes necessary. |

Nothing paid. Nothing mandatory beyond what ships today.

---

## 6. Risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | **No internet egress in this sandbox** (npm + GitHub only). Live discovery cannot be validated here. | **High** | Build against the loopback fixture server; label live discovery UNVERIFIED in every report until run elsewhere. |
| R2 | Discovery writing junk into the CRM `Lead` table | High | Keep discovery in Company/Observation; promote to Lead only on explicit, tested rules; never overwrite human data (already enforced by `decidePrecedence`). |
| R3 | Unverified contacts polluting `Contact` | High | Stage in `DiscoveredContact`; promote only above a verification bar. |
| R4 | Knowledge engine storing copyrighted text wholesale | High | Store metadata + short summary + attribution only; cap stored excerpt length. |
| R5 | Scheduler double-running cycles across workers | Medium | Idempotency keys on `Job` + `FOR UPDATE SKIP LOCKED` leasing (already built and tested). |
| R6 | Market-intelligence conclusions from tiny samples | Medium | Always return `sampleSize`; suppress conclusions below a threshold. |
| R7 | Crawler output treated as trusted input | High | Already sanitised in `ingest.ts`/`provenance.ts`; keep every new path routed through them. |
| R8 | A blocked/failing source stalling the pipeline | Medium | Per-source isolation, `BLOCKED` recorded and never retried (already in `fetcher.ts`); job-level retry caps. |
| R9 | Native Prisma query engine unavailable offline | Medium | WASM schema engine + `prisma:parity` script already in place; runtime preview needs the local-only driver-adapter patch, reverted before commit. |
| R10 | Schema growth slowing existing CRM queries | Low | All new tables are separate; existing indexes untouched. |

---

## 7. Recommended implementation order

1. **P5 — Database foundation** (research history, discovered contacts,
   knowledge, market intelligence, opportunity fields). Additive migration,
   parity-verified.
2. **P6 — Provider abstraction + registry**, with sitemap/RSS/CSV providers and
   full lifecycle (discover → fetch → normalize → validate → store).
3. **P7 — Crawl engine hardening**: per-domain queue, crawl state, source
   health writes, resumability.
4. **P8 — CRM synchronisation**: company → lead/contact/activity with
   idempotency and isolation tests.
5. **P9 — Opportunity intelligence**: configurable signal→service mapping and
   explainable scoring.
6. **P10 — Research engine**: freshness windows and research status.
7. **P11 — Knowledge engine** + Knowledge Hub.
8. **P12 — Worker + scheduler** (two configurable cycles/day).
9. **P13 — Dashboard, source health, market intelligence** surfaces.
10. **P14 — Production-readiness audit** and gap report.

Rationale: each phase depends only on those before it, every phase ends at a
green test suite, and the CRM stays fully functional throughout.
