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
`test/sessionReadBudget.test.js`.

## Why a per-Save budget was not enough

F-SB4B qualifying session 1 (2026-08-05, run `fsb4b-s1-20260805T122822-04E1C5`)
exhausted its own read quota mid-session and died at closeout. Every individual Save
was inside the per-Save budget. The session was not:
`scripts/reconstruct-session-reads.js` over that run's server log measures **78 read
attempts, 0 of them retries, peak rolling-60s window 78** — the whole session inside one
minute against a 60/minute quota. Retry amplification was a consequence, not the cause.

A per-Save budget cannot express "a session must fit in a minute", and a guard that
counts `sheets.js` helper calls cannot see that one `batchGet` now carries what used to
be six requests. So the session budget is measured at the **googleapis boundary**:
every `values.get`, every `values.batchGet` **and** every `spreadsheets.get`.

All three are metered. `spreadsheets.get` is not a diagnostic detail — `getSpreadsheetTabs`
backs `closeoutFinality.isSessionFinalized`, `sessionPlanStore._tabExists` and
`sessionPlanSetsStore._probeTab`, and `confirmTabMissing` issues one per unresolved range.
Counting only the values methods reports a values-read total as if it were the read total.

## The budget

**Peak rolling-60s Sheets read requests, across a complete owner-pattern session: ≤ 50.**

Fifty, not sixty, so a session that drifts has room to be caught before it starts
failing in the gym.

## The two mechanisms

### 1. Request-scoped `values.batchGet` (primary)

`sheets.js` opens a read context per HTTP request (`runWithReadContext`). A route
declares the ranges it needs (`services/sessionReadBatch.js`), and the **first read the
handler actually performs** issues them as one `batchGet`. Repeat reads of the same range
inside the request are served from that one call.

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
second 60 s TTL cache in front of it; two caches in series do not give one TTL. A route
entry filled at t=59 from a 59-second-old sheets entry served the same source snapshot
until t≈119, past the approved bound, without attempting the refresh whose failure the
contract requires be surfaced. The loser was deleted; the routes now always call
`getExerciseCatalog()` and only transform its result.

Reference data the athlete's writes never touch, and the single most-read range of the
failed session (14 of 78). Server-owned; TTL ≤ 60 s; single-flight; expiry is explicit
(an expired entry is discarded where it expires); **no stale-after-expiry fallback** — a
failed refresh throws, carrying its `readWithRetry` class so the truthful 503 from
PR #1270 still applies; an empty result is never cached and `[]` is never synthesized
from an error.

No other range is cached across requests. Every one of them is write-sensitive evidence,
and a stale copy would corrupt a decision.

## Measured

Against the failed run's own request sequence, replayed through the real handlers:

| Configuration | Peak rolling-60s reads |
|---|---|
| batching + catalog cache (shipped) | **41** |
| batching only | 55 |
| catalog cache only | 88 |
| neither (pre-change) | 102 |

The 102 reproduces the original failure and then some — the live run measured 78 before
the quota it had already exhausted cut the session short. That is what makes the 41
meaningful.

## The guard

`test/sessionReadBudget.test.js` drives the complete owner-pattern sequence against the
real `sheets.js` and the real Express app, faking only `googleapis`, and asserts:

- peak rolling-60s reads **≤ 50**;
- `Exercise_Catalog` costs **exactly one** request for the window;
- **every** request answers 2xx **and every live Save really wrote** — a 4xx performs no
  reads, and a Save answering 200 as a duplicate skips its append and most of its reads.
  A stale on-disk idempotency store alone moved the reported budget from 53 to 27, so the
  harness redirects that store and asserts `sheet_write: 'success'` on every live Save;
- the **final closeout Save** carrying the production `closeout_context` is driven and
  must actually seal — that branch is what died live, and nothing else reaches
  `recordCloseoutEvent` / `sealCloseout`;
- restoring individual range requests **breaks** the budget;
- restoring per-request catalog reads **breaks** the budget;
- both disabled **reproduces** the original quota failure;
- a `Deload_State` change is visible to the next recommendation — the budget may never be
  bought with a cached training state;
- the catalog **route** never serves a snapshot older than one TTL, and a failed refresh
  reaches the route as a classified failure rather than stale data.

Two mutation bites keep the measurement honest, because both of these omissions were live
in an earlier head and neither turned the file red: dropping metadata reads from the count
must change the answer, and dropping the closeout Save must fail the guard.

The counterfactuals are the anti-false-green: if the sequence ever stops genuinely
exercising the read paths, they stop failing-as-required and the file goes red.
