# P16.5 – P16.7: automation, reliability and operations

Scope: make the discovery engine survive being run for months without a person
watching it, make a stale worker unable to corrupt a newer result, and give the
operator a page that answers "is it running, and if not, why not" from the
database rather than from an assumption.

This document records what was built and, where a decision was a close call,
why the alternative was rejected. It is append-only alongside the P15 and
P16.0–P16.4 records.

---

## 1. Job reliability (P16.5)

**Bounded lifetime.** Every job carries a lease (`Job.lockedUntil`). The worker
claims with `FOR UPDATE SKIP LOCKED`, renews the lease on a timer while the
handler runs, and runs each handler inside `runWithDeadline`
(`src/lib/jobs/execution.ts`, default 10 minutes). A handler that ignores its
abort signal cannot hold a job RUNNING: the deadline fails the job and the
ownership guard rejects whatever the handler writes afterwards.

**Retries.** A failure is classified (`TIMEOUT`, `ABORTED`, `VALIDATION`,
`DATABASE`, `NETWORK`, `BLOCKED`, `UNKNOWN`); retryable failures return the job
to PENDING with exponential backoff (30 s → 1 h), non-retryable ones fail it
immediately. Attempts are capped by `maxAttempts` (default 3). There is no path
that retries forever: reaching the cap is terminal FAILED.

**One terminal state.** `completeJob`, `failJob` and `cancelJob` are guarded
UPDATEs: they only move a job that is in a status the transition is legal from,
and each returns `null`/`false` when refused. A job that reached SUCCEEDED
cannot later be FAILED by a straggler, and vice versa.

**Idempotency.** Counters are recomputed from the structured results of the
run's SUCCEEDED jobs rather than incremented (`@/lib/discovery/run-counters`),
observations are deduplicated by field+method+source+value, opportunity and
signal rows are unique per company, and enqueue is deduplicated by
`(workspaceId, idempotencyKey)`. A duplicated execution therefore adds no rows
it should not.

**Failure detail.** `failJob` writes `result.error = { category, message,
attempt, at }`. Nothing in that record is a credential, a payload dump or a
stack trace.

**Shutdown.** `src/worker/index.ts` handles SIGTERM/SIGINT by aborting the loop
(no new claims), finishing the in-flight job within a 30-second grace period,
deleting its heartbeat row, disconnecting Prisma and exiting — with a non-zero
exit if the grace period is exceeded, so a wedged process is restarted rather
than left holding a lease. `uncaughtException`/`unhandledRejection` are logged
and exit 1 rather than leaving a half-dead process.

---

## 2. Stale-worker ownership (P16.6)

A claim returns an ownership token `{ workerId, attempt }`. `attempt` is
incremented by the claim itself, so every claim of a job has a distinct token.
Every write a worker makes about a job — complete, fail, heartbeat, retry —
carries the token and is applied only if the stored token still matches.

The race this closes: A claims a job and stalls; the lease expires; B claims,
runs and completes it; A wakes up and tries to record its (now meaningless)
result. A's write is refused and reported as `LOST_LEASE`; B's result stands.
The same guard applies to heartbeats, so a worker that has lost its lease cannot
extend it and re-take the job.

`expireAbandonedJobs` writes off *final* attempts whose lease expired beyond a
5-minute grace period (a worker that died, with no worker left to fail the job
for it), and settles their runs. Retryable abandoned jobs are left to the normal
claim path.

---

## 3. Automation operations (P16.7)

`/automation` (workspace-scoped, session-authenticated) shows:

| Panel | Source of the number |
| --- | --- |
| Queue | `Job` grouped by status for this workspace; "retrying" = PENDING with `attempts > 0` |
| Current / last run | `DiscoveryRun` rows, plus their own counter columns |
| Run detail | one run + its jobs, counters, sources, failures |
| Schedule | `decideSchedule()` — the same function the worker calls |
| Research | `Company.researchStatus` and `Company.lastResearchAt` |
| Failures | FAILED `Job` rows with their stored category and message |
| Sources | `Source` counts and recent `FetchLog` BLOCKED rows |
| Worker | `WorkerHeartbeat` freshness (alive = seen within 90 s) |

No figure is derived from a workspace total where a run metric is meant, and no
figure is estimated. Where a thing has never happened the panel says so in
words rather than rendering a zero that looks like a result.

**Manual controls.** "Run discovery now", "Retry job" and "Cancel job" are
server actions under `src/app/(app)/automation/actions.ts`. They take the
workspace from the session, look the job up *within* that workspace (a foreign
id is indistinguishable from a missing one), and rebuild any payload
server-side — a browser cannot aim a crawl at a URL of its choosing. "Run
discovery now" enqueues the cycle under the same `(workspace, local slot)` key
the scheduler uses, so a double-click, or a click racing the scheduler, yields
one job. Retry is only offered for FAILED jobs and cancel only for PENDING or
RUNNING ones; a finished job is a record of what happened and is left alone.

**Run provenance.** A run started by the manual control is stored with
`trigger = "MANUAL"` (the handler reads the payload as a fixed enum, so no
arbitrary value can be written there). Scheduled cycles stay `SCHEDULED`.

---

## 4. Research coverage: supported vs unsupported

Twelve aspects exist in the schema; five have a researcher in this build
(`SUPPORTED_ASPECTS` in `src/lib/research/aspects.ts`: WEBSITE, COMPANY_INFO,
GEOGRAPHY, PUBLIC_CONTACTS, MARKETING). The registry is built *from* that list,
so the two cannot disagree.

`aggregateStatus` takes the declared coverage. Measured against it:

- a company whose five supported aspects are fresh is `RESEARCHED` — not
  permanently `STALE` for aspects nothing will ever look at, which was the
  previous behaviour and reported an expiry that could never be resolved;
- a company that holds a stored fact for an aspect this build *cannot* refresh
  (a hiring record, say) is `PARTIAL`, never `RESEARCHED`, because that fact
  cannot be brought up to date again;
- `BLOCKED` and `NEEDS_REVIEW` keep their own meanings instead of collapsing
  into "stale".

`researchCoverage()` states the coverage in words — the Automation page shows
"5 of 12 aspects" — so the status is never read as a claim about the seven
aspects with no researcher. No researcher is invented for an unsupported
aspect, and no aspect is marked researched with nothing behind it.

---

## 5. Contact discovery: intentionally zero

`contactsDiscovered` has no producer. Nothing in the pipeline reads or writes
`DiscoveredContact`, and the schema's `Source.discoveredContacts` relation is
unused. Fabricating contacts — guessing an email pattern, harvesting a name
without a source — is exactly the behaviour the CRM's provenance rules exist to
prevent.

Decision: the counter stays honest at 0, the run detail page says why, and no
surface implies contact discovery happens. The counter is retained so that a
future, evidence-backed producer can report into it without a schema change.

---

## 6. A known website that cannot be read

An unreadable site leaves the aspect `NEEDS_REVIEW` with no freshness window, so
the next cycle retries it instead of writing the company off for a fortnight. No
signal and no opportunity are produced: `WEBSITE_UNREACHABLE` requires
`pageSignals.reachable === false`, and page signals only come from pages that
were actually read. Forcing one from a failed fetch would raise apparent coverage
with no evidence behind it, and a single transient timeout would create a
persistent quality signal.

What the model *can* represent is the request itself. `FetchLog.sourceId` is
nullable, so a research fetch is now logged with its URL, outcome, status code,
duration and error, and **no source** — the research pass is not driven by a
configured source and must not attribute its requests to one. The Automation
page shows those refusals. This is evidence of what happened, not a claim about
what it means.

---

## 7. Deployment topology

`render.yaml` now describes two services:

| Service | Type | Build | Start |
| --- | --- | --- | --- |
| `freelanceos` | web | `npm install && npx prisma generate && npx prisma migrate deploy && npm run build` | `npm start` |
| `freelanceos-worker` | worker | `npm install --include=dev && npx prisma generate` | `npm run worker` |

- Migrations run in exactly one place (the web build). Two deployers migrating
  concurrently is how a schema ends up half-applied.
- The worker never serves HTTP and the web service never runs a job or a
  schedule: a queue that only moves when somebody loads a page is not
  automation.
- **Background workers need a paid instance type on Render.** On a plan without
  one, the worker service cannot be created and nothing runs on a schedule. The
  web service will not silently take over.
- `WORKER_ID` gives the worker a stable identity for its heartbeat row and logs.
  Two worker instances must not share it.

Environment variables actually read by the code (see `.env.example`):
`NODE_ENV`, `DATABASE_URL` (pooled, 6543), `DIRECT_URL` (direct, 5432, used by
`prisma migrate deploy`), `AUTH_SECRET`, `APP_URL`, `TRUSTED_PROXY_HOPS`
(optional, default 1), `WORKER_ID` (optional, worker only). The worker needs the
two database URLs and `WORKER_ID`; it does not read `AUTH_SECRET` or `APP_URL`.

---

## 8. Migration set

Two migrations are added by this batch, both purely additive:

| Migration | Contents |
| --- | --- |
| `20260926090000_worker_heartbeat` | `WorkerHeartbeat` table + `lastSeenAt` index |
| `20260926093000_job_discovery_run_index` | `Job(discoveryRunId)` index, for the run detail and per-run job counts |

Neither touches an existing column, so neither needs a backfill. `npx prisma
migrate deploy` from the web build is the only path that applies them.
