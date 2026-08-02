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
