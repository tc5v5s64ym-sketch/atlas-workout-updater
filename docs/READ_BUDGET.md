# Save Path — Google Sheets Read Budget

**Status:** reference. Pins the number of Google Sheets **read** requests one Save
is allowed to issue, and the reasoning behind it. The regression guard lives in
`test/sheets-adapter-reads.test.js` (`READ BUDGET:` tests) — a change that adds a
redundant read fails CI.

---

## Why this exists

Google Sheets enforces per-user **read** and **write** quotas (60/min each). A gym
session fires a burst of Save-related requests in a short window. Every avoidable
read on the Save hot path eats into that minute's quota and, under load, risks a
`429 Quota exceeded` that turns a real Save into a 500. Telemetry-side quota
starvation was already fixed once (Flight Recorder buffering, `BACKLOG.md`
2026-07-07); this doc covers the *read* side of the same hot path.

## The two Save paths

| Path | Handler | Trigger |
|---|---|---|
| Manual text | `POST /api/log-workout` | slash-notation sets typed by the owner |
| Screenshot / effort | `POST /api/complete-workout` | Apple-Watch screenshot or manual effort |

Both are preview-then-write: the client sends a dry-run (`test_mode=true`) to
render the review card, then a live write on approval. Each is a **separate HTTP
request** with its own reads.

## Reads a single **live** Save performs

All Save reads are **whole-column or whole-tab** — none scales with the number of
logged sets. So a single exercise, a normal workout, and a large workout all cost
the **same** number of reads. The budget is **O(1) in workout size**.

| Read | sheets.js call | Purpose |
|---|---|---|
| `Exercise_Catalog!A:Z` | `getExerciseCatalog()` | enrich each row to canonical name / lift_code |
| `Effort!B:B` | `getEffortSessionIds()` | duplicate-session guard (effort row only); session-id allocator |
| `Log_Cleaned!B:G` | `getLogCompositeKeys()` | row-level dedup (session‖exercise‖set); session-id allocator |
| `Log_Cleaned!1:1` | `getHeaderRow(log)` | header-drift guard |
| `Effort!1:1` | `getHeaderRow(effort)` | header-drift guard (effort row only) |

## Root cause of the redundant reads

`getLogCompositeKeys()` needs three Log_Cleaned columns — session_id (B),
exercise (C), set_number (G). It used to fetch **each column in its own
`spreadsheets.values.get`**, so one logical lookup cost **three** API reads. B, C
and G all sit inside the contiguous `B:G` span, so a single ROWS-major range read
returns all three at once (index 0 = B, 1 = C, 5 = G). The composite keys computed
are identical — header rows and rows missing any of the three fields are still
skipped, keys are still lowercased.

## Session-id allocation reuses these reads

When a request carries a **blank** `session_id` the server allocates one, and it must
step over every record that proves a workout already exists — `Effort!B:B` **and**
`Log_Cleaned!B:G`. Reading Effort alone was the identity defect: an Effort row is
optional, so a workout logged without watch data was invisible to the allocator and the
next same-period workout silently merged into it.

Both write routes memoize these two reads per request, so the allocator and the guards
below it share **one** fetch each rather than repeating them. The net cost is at most
**one extra column read**, only on the request that actually allocates (the first preview
of a new session), and only where that path did not already read the column:

- an upload carrying workout rows already read `Log_Cleaned!B:G` for the row dedup → **+0**;
- an effort-only upload already read `Effort!B:B` → **+1** (`Log_Cleaned!B:G`);
- a JSON dry-run without an effort row already read `Log_Cleaned!B:G` → **+1** (`Effort!B:B`).

A request that supplies an established id never allocates and is byte-identical to before.
The memo is **per request** — it never caches across requests, so the "never cached"
contract below is intact: every write still dedups against the current sheet state.

`getExerciseCatalog()` is fetched **once** per Save (the enricher receives the
already-fetched catalog map on the `/api/complete-workout` path), so it is not a
duplicate. The duplicate-protection reads (`getEffortSessionIds`,
`getLogCompositeKeys`) are deliberately **never cached** — a live write must dedup
against the current sheet state, so caching them would break the trust contract.
Only the *internal* per-column fan-out of `getLogCompositeKeys` was wasteful.

## Read budget — before vs after

| Save shape | Before | After |
|---|---|---|
| `getLogCompositeKeys()` alone | 3 reads | **1 read** |
| `/api/log-workout` live write, no effort | 5 reads | **3 reads** |
| `/api/log-workout` live write, with effort | 7 reads | **5 reads** |
| `/api/complete-workout` live write | 7 reads | **5 reads** |

`SAVE_READ_BUDGET = 5` (the with-effort live write). A dry-run preview reads a
subset (catalog + composite keys, plus a best-effort history read for the
safety flags) and stays under the same ceiling.

The saving repeats on **every** Save request in a session's burst, so the
per-minute read pressure drops by ~2 reads × (previews + writes).

## Acceptance-time allocation (sidecar, not the Save path)

`POST /api/session-plans/accept` allocates the session id when the client has no
established identity (the client's own `${date}-{AM|PM}-01` mint was removed —
it re-used the first same-period session's identity). The allocating request reads,
via the shared `getSheetRows` wrapper:

- `Session_Plans` (always, uncached) — retry evidence + occupancy; an accepted-but-
  not-yet-logged workout exists only here;
- `Effort` + `Log_Cleaned` (only when no retry evidence, 30 s TTL cache shared with
  the dashboard reads; every live write invalidates it) — the rest of the durable
  union.

That is at most **3 tab reads, once per newly accepted session** — not per set, not
per Save, and never on a request that carries an established id. The Save budget
above is unchanged; these reads happen on the acceptance sidecar request only.
An unreadable source fails the allocation closed (503) rather than minting an
identity whose availability cannot be proven.

## The guard

`test/sheets-adapter-reads.test.js` runs the real `sheets.js` read helpers against
an in-memory googleapis client and counts `values.get` calls:

- `getLogCompositeKeys` must cost **exactly one** read.
- The Save read *sequence* (the five helpers above, called in handler order) must
  stay **≤ 5** reads.

These assert the cost of the `sheets.js` read helpers directly — they do not drive
the `index.js` Save handler end-to-end, so they catch a regression *inside* a
helper (e.g. `getLogCompositeKeys` going back to per-column fetches: 1→3 trips the
budget). They do **not** catch a new redundant read added in the handler itself
(e.g. a second `getLogCompositeKeys` call) unless the read sequence here is updated
to match. Keep this list in sync with the handler's reads.

---

# Session Google Sheets Read Budget

**Status:** reference. The budget above is **per Save**. This section adds the budget
that Google's quota actually meters — reads per **rolling 60 seconds across a complete
session** — and records the mechanisms that hold it. The guard is
`test/liveSessionReadBudget.test.js`.

## Why a per-Save budget was not enough

F-SB4B qualifying session 1 (2026-08-05, run `fsb4b-s1-20260805T122822-04E1C5`)
exhausted its own read quota mid-session and died at closeout. Every individual Save
was inside the per-Save budget. The session was not.

A per-Save budget cannot express "a session must fit in a minute", and a guard that
counts `sheets.js` helper calls cannot see that one `batchGet` now carries what used to
be six requests. So the session budget is measured at the **googleapis boundary**:
every `values.get`, every `values.batchGet` **and** every `spreadsheets.get`.

All three are metered, and Google meters **attempts** — a retried read costs two.
`spreadsheets.get` is not a diagnostic detail either: `getSpreadsheetTabs` backs
`closeoutFinality.isSessionFinalized` and the ledger stores, and `confirmTabMissing` issues
one per unresolved range. Counting only the values methods, or only logical reads, reports a
smaller number as if it were the read total.

## The measurement authority — and the one it replaces

> **The 46-read acceptance figure PR #1271 merged on is INVALIDATED.** It was measured
> against a hand-authored `ownerPatternSequence` — a plausible reconstruction of a session,
> not the session. The mechanism it shipped worked; the sequence it was accepted against
> under-modelled production, so the number was never a measurement of the real client.

PR #1271 merged as `42ee7b3` and deployed. The authorized non-counting debug run against
that deployment then measured **116 observable read attempts with a rolling-60s peak of 87**,
and threw 429s. Both figures are **lower bounds**, not totals: the captured artifact does not
carry complete retry evidence, and the run was cut short by the quota it had already spent.

**Provenance, stated so the figures are not read as more than they are.** They were measured
from that run's server log during this corrective. The log is owner evidence and is not
committed, so the numbers cannot be re-derived from this repository — they are recorded here
as a measurement that was taken, not as a result this branch reproduces. What this branch
does reproduce is the request manifest below, which comes from the log's request lines and is
committed as a privacy-safe fixture.
`scripts/reconstruct-session-reads.js` now reports `total_is: lower_bound` and
`retry_attempts: null` rather than `0` when a log cannot prove otherwise — reporting "retry
attempts: 0" for evidence that simply was not captured is what made the earlier artifact
read as complete.

The archived 78-attempt figure from that run's server log is likewise a values-read lower
bound from the older logging surface, not a session total.

**The authority is now the exact deployed request manifest from that failed run**,
`test/fixtures/liveSessionManifest.json`: 113 `/api` requests over 70.9 s, in order, with
their real multiplicity, scrubbed of session ids and appended ranges. Repeated requests are
not compressed, no request is dropped, and no representative call stands in for several —
that compression is precisely what made the previous sequence wrong. The old
`ownerPatternSequence` survives in `test/sessionReadBudget.test.js` as a smaller unit
scenario and **authorizes nothing**.

## The budget

**Peak rolling-60s Sheets read requests, across a complete owner-pattern session: ≤ 50**,
measured as a **trace-derived lower bound**.

Fifty, not sixty, so a session that drifts has room to be caught before it starts failing in
the gym. Meeting the bound is a necessary condition, never a sufficient one: the harness
measures a floor, and only the post-deploy non-counting debug run can say what production
spends.

## The two server mechanisms

### 1. Request-scoped `values.batchGet` (primary)

`sheets.js` opens a read context per HTTP request (`runWithReadContext`). A route declares
the ranges it needs (`services/sessionReadBatch.js`), and the **first read the handler
actually performs** issues them as one `batchGet`. Repeat reads of the same range inside the
request are served from that one call. Spreadsheet **metadata** is request-scoped the same
way — a session asks "which tabs exist?" repeatedly inside one request, and each ask used to
be its own metered request.

Three properties make it safe:

- **The batch never outlives the request.** It is not a cross-request snapshot. Dedup
  keys, Effort session ids, `Deload_State`, header rows and the `Session_Plans` /
  `Session_Plan_Sets` ledger are still read fresh on every request that consumes them.
  Batching changes how many API calls carry a range, never how old the values are.
- **A write invalidates its tab** in the request context, so a read-after-write in the
  same request cannot be served a pre-write value.
- **It transports only.** Every existing helper still parses its own range.

The declaration is lazy on purpose. An eager prefetch charges a batch to a request that
then reads nothing — measured at +6 reads across one session — which is what makes a
declaration broader than one code path genuinely free.

Known limit: `batchGet` rejects the whole batch when a range names an absent tab. On a
spreadsheet missing an optional tab the batch fails `range_unresolved` and each range
falls back to its individual read — today's behaviour exactly, never worse, but the
budget is not achieved on such a sheet.

### 2. The `Exercise_Catalog` cache (the only approved cross-request cache)

There is exactly **one** catalog cache, in `sheets.js`. `routes/reads.js` used to own a
second 60 s TTL cache in front of it; two caches in series do not give one TTL. The loser
was deleted; the routes now always call `getExerciseCatalog()` and only transform its result.

Reference data the athlete's writes never touch, and the single most-read range of the
failed session. Server-owned; TTL ≤ 60 s; single-flight; expiry is explicit (an expired
entry is discarded where it expires); **no stale-after-expiry fallback** — a failed refresh
throws, carrying its `readWithRetry` class so the truthful 503 from PR #1270 still applies;
an empty result is never cached and `[]` is never synthesized from an error.

No other range is cached across requests by this read layer.

### The `Log_Cleaned` / `Effort` row cache — scope corrected

`index.js` has a separate, pre-existing 30-second full-row cache for those two tabs, which
every successful live write invalidates. Its lifetime is unchanged, and it is still
write-invalidated; what changed is **what it drops**. Every caller now names the tabs it
wrote, so a Save with no effort row leaves the cached Effort rows alone, and writes to tabs
this cache never holds (`Coaching_Notes`, `Constraints`, `Modality_Log`) stop clearing both.

The no-argument call still clears everything. The two directions are not symmetric:
under-eviction serves a stale read after a write and is a trust bug, while over-eviction
costs one read — so a caller that does not say what it wrote fails safe.

## The client must ask for less

Batching alone could not close the gap. A one-range `batchGet` still costs one quota
request, so the number of requests the real client causes is the primary term. Four
client-side corrections, each proved by a browser-level test that counts the requests
actually issued:

| # | What was removed | Why it cannot change an answer |
|---|---|---|
| C1 | *(nothing removed)* | `/api/debug/intent-observe` was already read-free; the twenty reads once attributed to it were an artefact of the reconstruction tool's next-completed-request heuristic. Its dead range declaration — latent amplification the day the route added a read — is gone, and a zero-read guard replaces it. |
| C2 | the second `/api/plan/intent-recommendation`, `/api/coaching/insights` and `/api/prs/recent` of each pair | Two surfaces asking the same question 0.4–0.9 s apart. The second now **joins the first in flight**; nothing is remembered once a response arrives, and any non-GET clears the in-flight map when it settles. |
| C3 | `GET /api/log-workout/verify-range` on the normal Save path | The append's own receipt is the write-verification authority now — see below. |
| C4 | the second `/api/recommend/next/{code}` of each lift's pair | Identical parameters (all in the URL), and the only tabs the engine also reads were untouched between the two asks. |

C4's rule is the one with a real proof obligation, and it is met before the reuse:
`currentInputsEpoch()` steps whenever the client did anything that might have changed
`Log_Cleaned`, `Deload_State` or `Constraints`. It is pessimistic — **every** non-GET steps
it, with two ways out: the response carries the W1–W3 dry-run proof (`no_write_confirmed`
and `sheet_written: false`), or the path is one of two observation-only writers.
`test/recommendationInputWrites.test.js` replays the whole captured session against the real
app and records, per request, every tab actually written; in that entire session exactly one
request wrote a tab a recommendation reads — the live Save. A `test_mode` preview writes
nothing at all, anywhere.

None of this suppresses a legitimate call after a newly written set: the live Save steps the
epoch, and the next set changes the URL.

## Write verification no longer costs a read

`GET /api/log-workout/verify-range` used to re-read the appended range after every
successful Save — one metered read at closeout, the exact minute the failed session ran out
of quota. It decided the same thing the append's own `updates` receipt already reported.

The receipt wins: it is produced by the operation that performed the write, contemporaneously
with it, and it establishes the exact appended range, the exact row count and session
ownership at no quota cost. `services/appendWriteProof.js` adjudicates it and
`POST /api/log-workout` publishes `log_write_verification`. The verdict is derived, never
asserted — a missing or self-contradicting receipt yields `verified: false` with an exact
reason, so the caller has no proof rather than a fabricated one.

`verify-range` survives only as a fallback, reached when the server published no verdict at
all (a deployment older than the field) and never when the verdict says false. Winner,
bridge and exact sunset condition are recorded in
[`docs/ATLAS_SYSTEM_AUTHORITY.md`](ATLAS_SYSTEM_AUTHORITY.md) as concept 11b.

## Measured

Against the failed run's own request manifest, replayed through the real handlers, in the
**qualifying ledger posture** — `ATLAS_SESSION_PLANS_WRITE=1` and
`SESSION_PLAN_SETS_WRITE_ENABLED=1`, the two flags the combined rehearsal sets
(`tests/e2e/gate/gate-server.js`). With them off the session has no plan capture, no
checkpoint writes and a dry-run seal — a materially cheaper session than the one that failed.

### The captured timing is replayed, not collapsed

The manifest records each request's `offset_ms`, and the harness now **replays them on a
virtual clock**: `Date.now()` reports the current request's captured offset, so the session's
real 70.945-second shape is preserved while the suite still finishes in about a second
because nothing actually waits. Two consequences, and both are the point:

- the rolling minute is the **session's** rolling minute, not an artefact of driving
  everything into one instant;
- the server's 30-second `Log_Cleaned`/`Effort` row cache **expires where it really would**
  — twice over a 71-second session — instead of staying warm throughout.

`test/liveSessionReadBudget.test.js` keeps the collapsed model runnable for exactly one
purpose: a guard proves that collapsing the timeline changes the answer and cannot satisfy
the acceptance figures. Removing the replay fails three tests.

| Client | Session total | **Peak rolling-60s** (trace-derived lower bound) |
|---|---|---|
| merged `main` (42ee7b3), captured manifest | 62 | **51 — over the 50 budget** |
| this branch's server, captured (pre-correction) client | 56 | 46 |
| this branch, **corrected** client (**shipped**) | 48 | **39** |

> **39 is a corrected trace-derived lower bound ≤ 50. The production budget is NOT yet
> proven.** The timing is now honest, so the one thing still missing is the live run's
> **retries** — Google meters them like any other request, and this harness does not model
> them at all. That omission only ever adds, which is what makes 39 a floor rather than a
> guess. The production verdict remains the post-deploy non-counting debug run. Campaign
> status stays 0/5 until that run passes.

**These figures replaced an earlier set, and the earlier set was wrong.** Under the collapsed
timeline this document previously published 60 / 55 / 46. Every one of those was measured
with all 113 requests inside a single rolling minute and with a row cache that never expired.
Replaying the captured timing moves each of them, and in both directions at once — totals
rise as the cache expires, peaks fall as the requests spread out.

### What replaying the timing retired: the fixture no longer reproduces the live failure

The old harness reported the captured client at a peak of 55 and the test asserted it "still
overruns the budget of 50". **Replayed, the captured client peaks at 46 — under the budget.**
The overrun was an artefact of the collapsed timeline.

So this fixture no longer reproduces the live failure, and it is not made to. The live run
measured 116 attempts with a peak of 87; the gap is the retries. Once the timeline is honest,
the captured client's *unretried* demand simply is not over Google's limit — the quota storm
was the retries compounding on top of it. What the captured client is still good for is the
**comparison**, which is what the guard now keeps: same requests, same timing, same server,
with and without the client corrections.

Merged `main` is the exception that still shows a breach: at 51 it is over the 50 budget
before a single retry, which is why the first retry tipped the live session over.

### The coach LLM is configured, and that is part of the measurement

`/api/coach/chat` branches on whether a Gemini key is configured. Configured, it grounds the
reply with one `batchGet` over `Coaching_Notes` + `Constraints` + `Log_Cleaned`;
unconfigured, it answers from client context and reads nothing at all. **Production runs
configured, and the captured session came from production**, so the configured branch is the
one this table measures — and it is the more expensive of the two, so the simulation
stresses the costlier branch rather than a cheaper one.

That branch is now pinned by the harness (`test/helpers/fakeCoachLlm.js`), which sets a fake
key in every environment and answers the model call from memory. Before that pinning the
branch was decided by whatever `GEMINI_API_KEY` happened to be in the runner's environment,
which made every figure here environment-dependent and made each local run place a real
network call to Gemini:

The configured branch costs exactly **one** extra read per session — the grounding
`batchGet`. Pinning it means the figures are reproducible off-network on any machine, and a
silent fall back to the cheaper unconfigured branch fails the suite instead of quietly
improving the budget by one read.

**The remaining gap to live demand is the retries, and it runs one way.** The live run
measured 116 attempts with a peak of 87. This harness does not model retries at all, and
Google meters them like any other request — so the live number can only be higher than this
one on that account. With the timing now replayed, retries are the whole of the modelling
gap; the collapsed-timeline distortion that used to cut the other way is gone.

One input is still chosen rather than captured, and it can over-count: the
`/api/suggest-substitute` body deliberately names a lift with a known substitute so the route
takes its history-reading branch. The manifest records no bodies, so the live branch is not
knowable, and this is a stress choice stated plainly rather than trace-derived evidence.

**What each correction is actually worth**, measured one at a time by disabling exactly one
and re-running:

| Correction disabled | Session total | Peak rolling-60s |
|---|---|---|
| C4 — repeated recommendation | 54 | **45** |
| C2 — intent-recommendation duplicate | 49 | 40 |
| C3 — verify-range retired | 49 | 39 |
| C2 — coaching/insights duplicate | 48 | 39 |
| C2 — prs/recent duplicate | 48 | 39 |
| *(none disabled — shipped)* | 48 | **39** |
| all five disabled (the captured client) | 56 | 46 |

**The earlier "C4 alone is load-bearing" claim is withdrawn.** Under the collapsed timeline
C4 measured 52 against a budget of 50, and this document said the session did not fit without
it. Replayed, C4 disabled peaks at 45 — still inside the budget. **No single correction is
load-bearing once the timing is honest**; the previous conclusion was an artefact of the same
collapse that inflated every other figure.

What the table does show is where the weight sits. C4 is worth 6 reads in the worst minute
and 6 across the session — far more than anything else. C2's intent-recommendation duplicate
is worth 1 in the peak. C3 and the other two C2 removals do not move the peak at all, and C3
still removes a real request from the session total; they buy total headroom and cache
pressure rather than peak headroom. All five together are worth 7 in the peak and 8 in the
total.

## The guard

`test/liveSessionReadBudget.test.js` is the session-budget authority. It drives the manifest
against the real `sheets.js` and the real Express app, faking only `googleapis`, and asserts:

- the **fixture still holds the captured session** — total request count, span and
  per-endpoint counts, transcribed as literals. A count derived from the manifest agrees
  with the manifest whatever it says, so only an independent expectation can catch a deleted
  request;
- the harness **replays** the manifest — nothing compressed, nothing dropped, thirteen
  previews and one twelve-row closeout write;
- the captured **timing** is replayed too: the corrected peak is pinned at 39 and its total at
  48, and the peak must be strictly below the total, which is only true of a session spread
  across more than one rolling minute;
- **collapsing the timeline changes the answer and cannot pass** — a guard runs the collapsed
  model deliberately and proves it disagrees (47 vs 39), that its peak equals its total, and
  that it cannot satisfy the pinned acceptance figures;
- the **captured** client costs measurably more than the corrected one under identical
  timing — 46 against 39 in the peak, 56 against 48 across the session;
- the **corrected** client fits 50, with all fourteen Saves answering 200 and twelve rows of
  the session genuinely on the sheet — a budget met by failing requests would be no
  achievement;
- **every client correction removes a request the captured manifest really contains** and
  names the test that proves the client no longer issues it. A correction matching nothing is
  a comment, not a reduction;
- the budget meters **attempts**: a read made to fail transiently once must appear twice;
- `/api/debug/intent-observe` performs **zero** reads, measured from a cold row cache — the
  boundary count cannot see a read the 30-second cache answered, so the guard primes a live
  Save first.

`test/sessionReadBudget.test.js` keeps the unit-level contracts the old sequence still proves
honestly — the catalog cache and route contracts, `Deload_State` freshness, the ledger
posture, and durable closeout settlement — and no longer budgets the session.

Six mutation bites keep all of this from passing for the wrong reason, each run and reverted:
making `intent-observe` read fails the zero-read guard; restoring the duplicate client
requests fails the budget at 54; globally invalidating `Effort` on a log-only write fails the
cache-invalidation test; restoring the per-Save verification read fails the
write-verification spec; metering logical reads instead of attempts fails both the retry
guard and the reproduction; and removing any request from the live manifest fails fixture
integrity.

Two of those bites found guards that could not fail, and both are fixed above: fixture
integrity was self-referential, and the zero-read guard was satisfiable from a warm cache.
