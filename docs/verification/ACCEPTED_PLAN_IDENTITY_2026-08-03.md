# Two accepted plans in one period — current-state proof (2026-08-03)

Owner instruction, run on clean `main` at `087ac87` (PR #1245 merged).

## Question

PR #1245 gave session-ID allocation one authority — the server allocator over the durable
union (Effort ∪ `Log_Cleaned`). It left one mint unexamined: `acceptDisplayedPlan`
(`src/app/app.js`) still derives an id when a plan is accepted with no session identity yet.
Does a second plan accepted in the same AM/PM period receive its own identity?

## Method

`tests/e2e/gate/two-accepted-plans-identity.spec.js` drives the REAL accepted-plan browser
path twice against the gate server (ledger-sandbox posture, in-memory tabs, no credentials):
displayed pick → a logged set (which silently auto-accepts and mints identity) → real effort
fields → "done" → the real Save. No identity is injected; `page.evaluate` only reads state
and fills real form fields.

## Result — VERDICT: STILL BROKEN

After session 1 closed out and sealed:

```
plan_accepted   × 5   all session_id = 20260803-AM-01
session_closeout × 1              20260803-AM-01
Session_Plan_Sets, Log_Cleaned, Effort  all 20260803-AM-01
```

After a SECOND plan was accepted in the same period:

```
plan_accepted   × 5 MORE   all session_id = 20260803-AM-01   ← the SAME identity
```

The second accepted plan re-used the first session's identity — and did so *after* that
session had been finalized and sealed under it. The second session's Save card never
appeared (`.rv-save` not found), so the collision also blocks the second closeout.

## Classification — AUTHORITY DEFECT

Two things still decide a session's identity:

- `acceptDisplayedPlan` derives `${date}-${AM|PM}-01`, hardcoded, consulting nothing — the
  same shape as the client mint PR #1245 removed from the write path;
- `services/sessionId.js` `nextAvailableSessionId`, server-side, which can see durable records.

The server allocator is the intended sole authority. The acceptance mint is the loser.

Note for the fix: the allocator's input must widen again. An accepted plan with no sets
logged yet leaves durable rows only in `Session_Plans`, so acceptance-time allocation must
read Effort ∪ `Log_Cleaned` ∪ `Session_Plans` — "the durable records that actually establish
a workout's existence" now genuinely includes an accepted plan.

## Consequence

No rehearsal pass counts until this is fixed and merged. The five-session streak stays 0/5.

## Fix (same day) — one winner, the loser removed

The client mint is gone: `acceptDisplayedPlan` passes only an ESTABLISHED identity (or
null) to `runAcceptance`, which then sends **no** `session_id`. `POST
/api/session-plans/accept` became the allocation point: it reuses
`services/sessionId.js` `nextAvailableSessionId` over the durable union
Effort ∪ `Log_Cleaned` ∪ `Session_Plans`, resolves a retry from the durable
`plan_accepted` rows for the same `pv_` plan_version (never a second allocation),
fails CLOSED (503, nothing written) when any occupancy source is unreadable, and
returns the identity it wrote under. The client adopts the returned identity as the
session's established one (store object, `#log-session-id`, persisted snapshot), so
Session_Plans, Session_Plan_Sets, Log_Cleaned, Effort, closeout, seal, undo,
readback and `atlas:review-live` all address one identity. The unestablished-path
ledger checkpoint now waits for the allocated identity; it never posts under a
guessed one. A local provisional id remains only for pre-acceptance
conversation/correlation and never reaches a durable write as authority.

## Proof

- `tests/e2e/gate/two-accepted-plans-identity.spec.js` — the reproduction above,
  unchanged, now PASSES: two same-period accepted plans, driven twice through the
  real browser path, receive distinct identities, every tab per session agrees on
  its identity, each session seals under its own closeout, and the ledger rows
  partition exactly across the two ids.
- `test/acceptedPlanIdentityAllocation.test.js` — the real route over an injected
  reader: first-slot allocation + returned identity; Session_Plans-ONLY occupancy
  steps the allocator (the first workout may exist only as an accepted plan);
  Effort and Log_Cleaned each step it; retry/replay reuse (incl. non-first slot;
  a non-accept row never satisfies reuse); three per-source fail-closed refusals;
  no-reader 503; invalid date 400; established id honored verbatim with zero
  occupancy reads (no fork).
- `test/planAcceptance.test.js` — unestablished acceptance sends NO session_id key;
  adoption into the live stored plan + adopt hook; checkpoint-waits-for-identity;
  no identity → no adoption, no checkpoint, workout still starts; established path
  byte-compatible (immediate checkpoint, no adoption).
- `test/planAcceptanceWiring.test.js` — the built shell's adapter derives nothing
  (`generateSessionId` absent from the acceptance block) and wires adoption.

## Mutation matrix (each restored defect, the exact bite)

| Restored defect | Biting failure |
|---|---|
| client acceptance mint (`existingId \|\| generateSessionId(...)`) | E2E: session 2's Save card never completes — `.review.done` count stays 1 (the exact production symptom); wiring: "the adapter never derives a session identity" |
| Session_Plans-blind occupancy (union without `spIds`) | route: "a Session_Plans row ALONE occupies the slot" — second acceptance re-allocated slot 01 |
| retry reallocation (`prior` lookup removed) | route: both retry-reuse tests — replay allocated the NEXT slot instead of the original |
| fail-open occupancy (`catch → []`) | route: all three "unreadable X occupancy fails CLOSED" tests — 200 + minted id instead of the 503 naming the unprovable source |
| response omits the identity | route: every allocation/echo test — `data.session_id` undefined |
| client never adopts | unit: adoption + checkpoint-wait tests; E2E: ledger checkpoint poll times out at 0 rows (no checkpoint may exist under an unnamed session) |

Mutations were applied to scratch-preserved working copies and byte-identical
restoration was verified (`cmp`) before the final green rerun.
