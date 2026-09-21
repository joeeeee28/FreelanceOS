# Discovery & Intelligence Architecture

Status: **Phase 4 — data foundation.** This document describes the layer that
sits underneath the discovery engine. It is written before the crawlers so the
contracts are fixed first.

## Why a new layer at all

The CRM that exists today models a `Lead` as a single flat row holding company
identity, contact identity and research findings side by side. That is the right
shape for a human typing in a lead they already know about. It is the wrong
shape for machine discovery, for three reasons:

1. **No identity.** Two sources describing the same business produce two rows.
   There is nothing to resolve them against.
2. **No provenance.** `websitePresent = false` records *what* we believe but not
   *why*, *from where*, *when*, or *how sure we are*. An automated writer that
   cannot express confidence will eventually overwrite something a human
   verified.
3. **No history.** Updating a field destroys the previous value, so "what
   changed and when" — the actual intelligence — is unrecoverable.

Phase 4 adds the missing entities *around* the CRM rather than replacing it.
Every existing table, service function and test keeps working unchanged.

## Entity model

```
Source ──< Observation >── Company ──< Signal >── Opportunity
                              │                        │
                              └────────< Lead >────────┘
                                          │
                                       Contact
```

- **Company** — the canonical business. One row per real-world organisation,
  per workspace. Holds the *current best* value of each fact.
- **Observation** — append-only. One row per (fact, source, sighting). Never
  updated in place, never deleted. This is the audit trail that makes the
  Company row defensible.
- **Signal** — something noteworthy that was detected (`WEBSITE_MISSING`,
  `HIRING_MARKETING_ROLE`). Carries its own evidence and confidence.
- **Opportunity** — a service we could sell, derived from signals via a
  configurable mapping.
- **Lead** — unchanged. Now optionally linked to a Company. A Lead is a
  *pursued* Company; discovery can create Companies without ever creating Leads.
- **Source** — a place we look, plus its health.
- **DiscoveryRun / Job** — the execution record and the work queue.

`Lead.companyId` is **nullable**. Every lead that exists today keeps working
with a null company, and hand-entered leads never require one.

## The write path

Raw source output is never inserted into CRM tables. It passes through:

```
PROVIDER  →  RawObservation   (exactly what the source said)
          →  DiscoveredEntity (normalised to a common shape)
          →  RESOLUTION       (which Company is this?)
          →  Observation      (recorded with provenance)
          →  Company          (current best value, only if confidence warrants)
          →  Signal / Opportunity
          →  Activity         (so a human sees what changed)
```

Each arrow is a separate, independently testable function.

## Confidence and precedence

Confidence is an integer 0–100, never a float and never a word. It is assigned
by the extraction method, not guessed:

| Method | Confidence | Rationale |
| --- | --- | --- |
| `MANUAL` | 100 | A human typed it. |
| `STRUCTURED_DATA` | 90 | JSON-LD / microdata the site publishes about itself. |
| `HTTP_HEADER` | 85 | Server-reported fact. |
| `SITEMAP` | 80 | Machine-readable and authoritative for URLs. |
| `FEED` | 75 | RSS/Atom, authored but structured. |
| `META_TAG` | 70 | Author-controlled, occasionally stale. |
| `HTML_SELECTOR` | 60 | Position-dependent, brittle. |
| `TEXT_HEURISTIC` | 40 | Pattern matched out of prose. |
| `INFERRED` | 25 | Derived from other facts, not observed. |

A new observation only overwrites the Company's current value when its
confidence is **strictly greater**, or when it is equal *and* strictly newer.
Equal-confidence, equal-age observations leave the record alone. This is what
implements the spec's "never overwrite stronger verified data with weaker data".

A human edit is `MANUAL`/100 and therefore cannot be clobbered by any crawler.

## Never delete

Discovery has no delete path. The engine may only:

- insert an Observation,
- insert or update a Company/Signal/Opportunity,
- insert an Activity.

Superseding is recorded by stamping `supersededAt` on the old Observation. The
row stays. Deletion is a manual, explicitly confirmed user action, and lives in
the CRM UI — not in the pipeline.

## Unknown is null

No field is ever filled with a guess, a placeholder or a "probably". If a fact
was looked for and not found, that is recorded as an Observation with a null
value (so we know we looked, and when), while the Company field stays null.

## Zero-cost

Nothing here requires a paid API. Providers are interfaces; the only ones that
ship in this phase read local input. Networked providers are added later behind
the same interface and remain optional.

## Testing constraint (current environment)

The development sandbox permits outbound HTTP to the npm registry and GitHub
only; all other egress is blocked. Crawling providers are therefore exercised
against a local fixture HTTP server that serves realistic HTML, RSS, sitemaps,
redirects, timeouts and blocked responses. That covers every code path
deterministically, but it is **not** a substitute for live verification. Live
worldwide discovery must be re-verified in an egress-enabled environment before
anyone calls it done.

---

# Phase 4 delivery record

What was built and how it was verified. Everything below was executed, not
assumed.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/lib/taxonomy/services.ts` | The 11 services as data, not strings. Unknown keys degrade to the raw key. |
| `src/lib/discovery/provenance.ts` | Extraction methods, the confidence scale, and `decidePrecedence` — the rule that protects human data. |
| `src/lib/discovery/canonical.ts` | Domain/name/email/phone/URL/person canonicalisation for deduplication. |
| `src/lib/discovery/resolution.ts` | Layered entity matching. Only domain and business email auto-merge. |
| `src/lib/discovery/ingest.ts` | The single additive write path into the database. |
| `src/lib/discovery/robots.ts` | RFC 9309 robots.txt parsing and enforcement. |
| `src/lib/discovery/fetcher.ts` | The only network access providers get: robots, rate limits, timeouts, size caps, redirect re-checks. |
| `src/lib/discovery/extract.ts` | JSON-LD / meta / markup extraction. Parses, never evaluates. |
| `src/lib/discovery/provider.ts` | The `DiscoveryProvider` contract and error classification. |
| `src/lib/discovery/providers/website.ts` | First working provider: sitemap-guided inspection of a business's own site. |
| `src/lib/jobs/queue.ts` | Postgres job queue with `FOR UPDATE SKIP LOCKED` leasing. |

## Guarantees backed by tests

- **A crawler cannot overwrite a human edit.** Asserted exhaustively against
  every automated extraction method, including one dated in the year 2099.
- **Nothing is deleted.** A superseded observation is stamped and kept;
  rejected claims are kept too. Deleting a Company leaves its Leads intact.
- **Absence never erases.** A crawl that finds nothing records that it looked,
  and the existing value stands.
- **Weak matches never merge.** Same-name collisions become `NEEDS_REVIEW`
  records for a human; only a shared domain or business email merges.
- **robots.txt is obeyed.** Proven by asserting a disallowed URL was never
  requested — including through a redirect, and when robots.txt is itself
  behind auth.
- **Two workers never run one job.** Proven by concurrent claims against real
  Postgres; expired leases are reclaimed, live ones are not.
- **Tenants are isolated.** The same domain in two workspaces yields two
  records; resolution candidates are workspace-scoped.

## Verification performed

- `npm test` — **383 passed** (196 pre-existing + 187 new), 28 files.
- `tsc --noEmit` — clean.
- `npm run lint` — 0 errors (1 pre-existing warning).
- `prisma validate` — valid.
- `npm run build` — 28 routes.
- Migration applied to a **fresh** database and, separately, to a database
  **already holding rows**, confirming no data loss and no changed values.
- `npm run prisma:parity` — new script proving the hand-written migration SQL
  reproduces `schema.prisma` exactly (tables, columns, types, nullability,
  indexes, enum values). This replaces `prisma migrate diff`, which cannot run
  without network access.

## Not yet verified

**Live internet discovery.** This sandbox reaches only the npm registry and
GitHub; all other egress is blocked. Every crawl path is exercised against a
real local HTTP server over real sockets, which covers the logic, but the
system has never fetched a public website. That must be re-verified in an
egress-enabled environment before discovery is described as working.
