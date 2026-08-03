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
