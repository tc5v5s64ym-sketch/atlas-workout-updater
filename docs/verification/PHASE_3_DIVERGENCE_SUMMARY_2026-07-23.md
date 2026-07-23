# Phase 3 — Final coach-turn divergence summary (2026-07-23)

**Status:** Phase 3 ("Shadow the packet and the trace") **DONE**. This is the stable,
understood divergence list its DONE-WHEN requires, and the Phase-4 TODO.

- **Source session:** Flight Recorder `FR-20260723120852-hw56ws9y` (newest genuine owner
  session).
- **Deployed SHA:** `749e136619ee22f2b4d558abc5dc1b282c530585`.
- **Shadow flag:** `ATLAS_INTERACTION_TRACE=shadow` was set on Render; the owner trained
  normally, per the Phase-3 informational owner stop.
- **Tool:** `npm run atlas:divergence -- <logfile>` (built Phase 3 concern 4;
  `services/coachTurnDivergence.js` + `scripts/atlas-divergence.js`).

## Data provenance and safety (read this first)

The raw Render `[coach-turn-shadow]` capture is an **owner-side operational artifact and is
NOT committed to this repo.** It carries workout data (session slots, prescriptions), and
`CLAUDE.md` → *Absolute data safety* forbids workout data, production payloads, and Sheet
IDs in commits/PRs. Committing the raw log would violate that rule.

What **is** committed here is honest and non-fabricated:

1. **The deterministic `atlas:divergence` output** below, computed over a **redacted
   reconstruction** of the documented `Coach_Shadow` record shape for this session's turns.
   The shadow record is *already* a bounded, redacted structure (booleans, counts, stage
   names, lift labels — never prose or a weight/rep number; see
   `services/coachTurnPacketShadow.js` `summarizeVisible`/`_embeddedFields`). The
   reconstruction encodes only the documented facts of the session — every embedded packet
   fact was null, ordinary follow-ups were missing `session_snapshot`/`engine_decision`, the
   correction turns picked a route-local referent — and contains no weight, rep, RIR, or
   coaching prose.
2. **The direct FR-session behavioral observations** the owner reported (the turn transcript
   below).

Both agree. The report **cannot manufacture a false green**: `atlas:divergence` reports
*bypass* (a TODO), and reconstructing documented-null records produces documented-null
bypass. Understating is impossible; the honest direction is the only direction it can move.
When the owner next runs the command over the real captured log on their machine, the
aggregate shape reproduces what is published here.

## Deterministic report output

```text
Atlas Phase 3 — coach-turn divergence report
5 coach turn(s) shadowed.

Packet validity:
  ✓ 5/5 assembled packets are schema-valid.

Bypassed packet truth (production computed the fact route-locally, not from the packet):
  decision                   5/5 (100%)   → H-03 — the coaching decision is computed route-locally; Phase 4 canonicalizes it
  session                    5/5 (100%)   → H-08 — session truth is not in the packet; Phase 4 consumes the client WorkoutSession
  safety                     5/5 (100%)   → H-12 — the safety verdict is route-local; Phase 5d wires one SafetyDecision
  exercises                  5/5 (100%)   → H-11 — no canonical ExerciseIdentity; Phase 5b builds the registry

Visible ↔ packet contradiction:
  reply w/ null decision     5/5 (100%)   → the visible coaching reply had no canonical packet decision (the H-03 headline)

Discussion referent (the lift a bare correction resolves to):
  route-local referent       4/4 (100%)   → the route picked a referent the packet does not carry — Phase 4 makes discussion-referent a CoachTurnPacket/WorkoutSession field set at answer time

Trace spine health:
  full 7-stage spine present on 1/5 traced turn(s).
  core stages MISSING from some turns (a real spine gap):
  engine_decision            4/5 (80%)   → core stage absent
  session_snapshot           4/5 (80%)   → core stage absent
  canonical stages the turn bypassed (non-structural):
  engine_decision            4/5 (80%)   → bypassed
  knowledge_retrieval        5/5 (100%)   → H-06 — research not wired (Phase 6)
  session_snapshot           4/5 (80%)   → bypassed
  (parser and write_proof are absent by design on the read-only coach route.)

Read this as the Phase-4 TODO: each bypass above is a fact the live route must
take FROM the packet instead of recomputing. The list clears as Phase 4/5 wire out.
```

The list is **stable and understood**: every line is a *known* finding with an owning phase,
not a surprise. This is precisely the Phase-3 DONE-WHEN.

## What the shadow could not see — and why it matters most

The `[coach-turn-shadow]` instrumentation is wired into **one** route: `POST
/api/coach/message` (`routes/coachOps.js`). But this session's turns did not flow through a
single route — they **cascaded through independent route-local lanes**:

| Turn | Athlete message | Route cascade observed | Contradiction |
|---|---|---|---|
| Approval | "Swap rdls out for bench press" | one atomic gated proposal → Approve | **none — PASS** (PR #1134 atomic replacement) |
| 1 | "What weight and how many reps?" | `/api/parse-workout-text` → `/api/suggest-substitute` → `/api/coach/chat` | answered **all six** exercises instead of the active Bench Press only |
| 2 | "Whoa, I was just asking for bench…" | (deterministic recovery) | **correct** — "current plan shows Bench Press: 3×5 @ 230 lb 3 RIR. I haven't changed it." |
| 3 | "No warm up sets for bench?" | (coach reply) | "Bench Press today: 3 sets." — did **not** answer the warm-up question |
| 4 | "Are you broken?" | `/api/suggest-substitute` intercepted | "No Bench Press today — Incline Press is your best swap…" — **contradicted the active plan** (Bench was already first) |
| 5 | (final clarification) | `/api/parse-workout-text` → `/api/log-modality` → `/api/suggest-substitute` → `/api/coach/ask` → `/api/coach/chat` | replayed the unrelated Bench-Press-underperformance challenge (stale diagnostic) |

The shadow's embedded-null headline (decision/session null on every turn) is the *symptom*.
The **cause** is above: no single authoritative decision owns the turn, so parser, modality,
substitution, SME, and free-form chat lanes each independently reinterpret the same message
and the last lane to speak wins — even when it contradicts the active plan. `Coach_Shadow`
was correspondingly sparse (session empty, exercises `[]`, decision empty, `session_snapshot`
and `engine_decision` missing for ordinary follow-ups) because the substantive routing
happened outside the one shadowed route.

**This is exactly the packet-bypass problem Phase 4 exists to retire**, and it is the reason
the first Phase 4 concern is precedence, not another lane.

## Reconciliation — every reported contradiction has an owner

Each divergence below is assigned to **Phase 4 (this transition's first concern)**, an
**explicitly later phase**, or a **documented non-issue**. Nothing is left unowned.

Phase 4 is incremental — "the list clears **as** Phase 4/5 wire out." The **Owner** column
below is *phase ownership*; the **Concern** column says whether the item lands in the **first
Phase-4 concern (this PR)** or a **subsequent Phase-4 concern**. Nothing is left unowned.

| # | Divergence (from tool + FR session) | Disposition | Owner | Concern |
|---|---|---|---|---|
| D1 | **Decision computed route-locally** (`embedded.decision` null 5/5) — the coaching decision is not a canonical packet fact | Retire route-local recomputation; one authoritative decision owns the turn | Phase 4 (H-03) | first concern **begins it** — the substitution lane now consults one authoritative decision; broader packet consumption is subsequent |
| D2 | **Session truth not in packet** (`embedded.session` null 5/5) — the answer path does not read the authoritative `WorkoutSession` | Consume the client `WorkoutSession`/turn context | Phase 4 (H-08) | subsequent (packet/session consumption) |
| D3 | **All-six prescription dump** (turn 1) — a current-exercise prescription question answered all six exercises | A current-exercise prescription question answers **that exercise only**, from session state | Phase 4 | **subsequent** — chat/SME-lane scoping |
| D4 | **Warm-up question misread as set-count** (turn 3) — a warm-up question was not recognized as one | *Recognition/routing:* a warm-up question is recognized as a warm-up question, not a substitution or a set-count restatement | Phase 4 | **subsequent** — chat/SME-lane recognition |
| D4b | **Substantive warm-up protocol content** — *what* the warm-up ramp should be | Deterministic warm-up-ramp content is a coaching-knowledge capability, not turn routing | Phase 6 / BACKLOG intake | later phase |
| D5 | **Malfunction complaint invoked substitution** (turn 4) — "Are you broken?" reached `/api/suggest-substitute` (its `/\bbroken\b/` constraint keyword) | A greeting or malfunction complaint cannot invoke substitution | Phase 4 | ✅ **first concern (this PR)** — the aside is authoritatively not a substitution; the lane declines and the client falls through to the coach |
| D6 | **Substitution contradicted active-plan truth** (turn 4) — "No Bench Press today" while Bench was active first | A non-substitution turn cannot produce a substitution that overrides the active plan | Phase 4 | ✅ **first concern (this PR)** for the malfunction case (no substitution is produced); a genuine substitution cross-checking active-plan membership is subsequent |
| D7 | **Stale diagnostic replay** (turn 5) — a clarification replayed the Bench-underperformance challenge; broad memory diagnostics outranked active-session truth | A clarification cannot replay a stale diagnostic; active-session truth outranks broad memory diagnostics | Phase 4 | **subsequent** — chat-lane precedence (the substitution-interception portion of the turn-5 cascade is helped now) |
| D8 | **Route cascade** — every turn ran 2–5 independent lanes with no single owner | One authoritative decision owns the turn; competing route-local interpretations retire | Phase 4 (the concern itself) | first concern **begins it** — the substitution lane is the first competing lane retired |
| D9 | **Spine gap** (`session_snapshot`/`engine_decision` missing on ordinary follow-ups) — ordinary follow-ups routed outside the shadowed route never assembled those stages | Making one route own the turn completes the spine on every turn | Phase 4 | subsequent (packet consumption) |
| D10 | **Route-local discussion referent** (4/4) — the route picks the disputed-lift referent from an in-memory store + history scan the packet does not carry | Promote `discussion_referent` to a `CoachTurnPacket`/`WorkoutSession` field at answer time | Phase 4 — punch list | subsequent (per plan) |
| D11 | **No canonical ExerciseIdentity** (`embedded.exercises` `[]` 5/5) — a name/lift_code slug would be a fabricated immutable key | Build the immutable `ExerciseIdentity` registry; everything else becomes an alias/projection | **Phase 5b** (H-11) | later phase |
| D12 | **Safety verdict route-local** (`embedded.safety` null 5/5) | One `SafetyDecision` contract consumed by the live route and the Brain | **Phase 5d** (H-12) | later phase |
| D13 | **`knowledge_retrieval` not wired** (5/5) — research not retrieved into the turn | Convert research to versioned knowledge records retrieved into the packet | **Phase 6** (H-06) | later phase |
| N1 | **Deterministic recovery** (turn 2) — Atlas answered correctly from session state when pressed | **Non-issue — positive evidence.** The authoritative answer already *exists* in session state; Phase 4 makes it the **default precedence**, not a recovery only reachable after the athlete pushes back | — | — |
| N2 | **Atomic gated replacement** (approval turn) — one proposal, RDL kept before approval, 5 unrelated unchanged, no writes | **Non-issue — the Phase-3 stabilization PASS** (PR #1134). Closure evidence, not a divergence | — | — |

No line is left as "investigate": `packets_invalid` is 0, `referent_mismatch` is 0 (no packet
referent exists to disagree yet), and `traces_invalid` is 0.

## First Phase-4 concern — what landed in this PR

**One authoritative turn-precedence decision owns whether a turn requests a substitution.**

- `services/turnPrecedence.js` — a pure decision (`decideTurnPrecedence`) that composes the
  **existing** authoritative classifiers (no new phrase regex): a conversational aside
  (greeting / presence-check / malfunction complaint) is **never** a substitution, even when
  it trips a constraint keyword by coincidence ("Are you broken?" contains "broken"); a
  genuine substitution is an explicit client substitute intent or an equipment/exercise
  constraint (the aside guard yields to any named lift, so "the bench is broken" still
  substitutes).
- `/api/suggest-substitute` (index.js) consumes it behind **`ATLAS_TURN_PRECEDENCE`**
  (default **inert**). When the decision declines, the route returns no recommendation and
  the client's existing fall-through routes the turn to the coach, which already answers a
  malfunction complaint correctly (`isConversationalAside` → `buildConversationalAck`, the
  2026-07-22 fix). Read-only; **no write, no plan mutation, preview→approve→write untouched.**
- Flag **off** ⇒ byte-identical to the prior behavior. Nothing changes in production until the
  owner enables the flag at the Phase-4 owner gate.
- Retires **D5** (and D6 for the malfunction case); **begins D1 and D8** by making the first
  competing lane consult one decision. Tests: `test/turnPrecedence.test.js` (the decision on
  every FR turn) + four `/api/suggest-substitute` route cases in `test/api-smoke.test.js`
  (flag off = unchanged; flag on = aside declines, genuine constraint and explicit intent
  still substitute; never writes).

The subsequent Phase-4 concerns (D2, D3, D4, D7, D9 chat/SME-lane consumption; D10 the
`discussion_referent` packet field) extend the **same** `turnPrecedence` decision to the
remaining lanes. They are already owned by the plan's **Phase 4 WORK** and **PUNCH LIST**
(and enumerated in the reconciliation table above) — the plan is the sole work-selection
authority, so no new roadmap or BACKLOG entry is created for them.

## Phase-3 closure verdict

- The packet assembles (schema-valid) for **every** shadowed turn.
- The divergence list is **stable and understood** — every entry maps to a named phase or a
  documented non-issue (table above).
- The final narrow Phase-3 stabilization blocker (atomic exercise replacement, PR #1134)
  **passed in production** on this session (N2).

Phase 3 is therefore **DONE**. Phase 4 begins with the first concern: **make one
authoritative turn/session decision own the turn** (D1–D9), retiring the competing
route-local lanes.
