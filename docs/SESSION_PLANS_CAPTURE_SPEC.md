# Session_Plans Live-Capture — Architecture & Implementation Spec (PR-D)

> **Governance layer:** Spec / design record. Subordinate to `docs/CONSTITUTION.md`, `docs/INVARIANTS.md`, and the trust contract. See `docs/GOVERNANCE.md` for the hierarchy.
>
> **Historical design record — superseded by S4.** Session plan events and plan-set revisions are now always-on Supabase workout authority. The former Sheets tabs, header probes, optional sidecar semantics, and `ATLAS_SESSION_PLANS_WRITE` gate are retired. Current authority is defined in `docs/ATLAS_SYSTEM_AUTHORITY.md` and `docs/SUPABASE_HOT_PATH_MIGRATION.md`.
>
> **Status:** Owner-authorized **Option A** (explicit lifecycle capture), 2026-07-10, following the STOP-&-REPORT finding that no authoritative server-side capture boundary exists. This is the **docs-only** first deliverable (**PR-D**). It writes **no production code**. **Owner-reviewed and APPROVED WITH AMENDMENTS (2026-07-10)** — the client-state contract, the three endpoint shapes, the capture-site classification, and the PR-E→PR-I split are approved; identity is **client-generated opaque UUIDs** (§4.4), acceptance is a distinct **"Start this plan"** plan-card button (§5), and plan-replacement capture is **deferred** (§5/§9). PR-E is authorized to proceed after this merges.
>
> **Standing flags (unchanged by this lane):** `ATLAS_SESSION_PLANS_WRITE` remains **OFF**. `ATLAS_COACH_PROFANITY` remains **OFF**. `skipped_pattern_streak` / `plan_deviation` drift kinds stay **unwired** until the PR-I canary passes.

---

## 0. Why this lane exists (the accepted premise)

The Session_Plans persistence modules — `services/sessionPlanEvents.js` (builders + idempotency), `services/sessionPlanStore.js` (idempotent append-only writer), `services/sessionPlanReader.js` (fold → `plannedVsCompleted`) — are **fully implemented and unwired** (staged in `config/wiring-allowlist.json`, `expires 2026-10-31`). The blocking finding (accepted by the owner):

> The server never receives an authoritative plan-lifecycle signal. The plan lifecycle is decided entirely in the **browser** (`src/app/app.js` + `src/app/store.js` + `src/app/activeSession.js`). The server only ever sees logged **sets** (`Log_Cleaned`/`Effort`), keyed by `session_id`, with **no `plan_version`** and **no per-item plan identity** at any write point. `plan_version` / `plan_item_id` do not exist as live data anywhere outside the unwired modules and the schema.

**Consequence:** capture cannot be "wired" to something that already exists — the plan-identity model and the explicit acceptance/outcome/closeout signals must be **introduced**. This spec defines that model and the narrow, explicit, feature-flagged protocol to carry it, with **no inference** anywhere.

### Non-negotiable invariants (inherited from the owner directive + the module contracts)

1. **Drafts are ephemeral.** A rendered plan, a coach recommendation, a preview, or an engaged Coach's Pick is **not** persisted. A plan becomes authoritative **only** through an explicit acceptance action.
2. **The acceptance request establishes persisted plan identity** (`plan_version` + per-item `plan_item_id`). Item outcomes and closeout events **carry that identity explicitly**.
3. **Never derive** plan identity or outcomes from logged sets, transcript/chat text, inactivity, browser close, navigation, server restart, or missing state.
4. **Sidecar only.** Session_Plans failures must **never** corrupt, duplicate, or block the normal workout write. Never touch `Log_Cleaned` / `Effort`. Never a `write_id`; never the preview→approve→write trust loop.
5. **No user-facing "plan remembered/saved" claim** unless the append actually succeeded.
6. **Canonical lift CODES only** (`planned_lift_code` / `performed_lift_code`) — never free-text lift identity as the contract. No loads/reps/RIR/progression data in this lane.

---

## 1. Current client lifecycle map (evidence)

Every path below was verified in the committed frontend. "Active plan" = the `_activePlannedSession` signal (`src/app/store.js:26`), mutated only via `setActivePlannedSession()` (`store.js:53`). Shape today: `{ label, intentId, exercises, index }`.

| # | Lifecycle path | Where | Trigger today |
|---|---|---|---|
| 1 | **Plan displayed** (Coach's Pick) | `coach-conversation.js:842` `typeSuggestedWorkout()` | renders plan; sets `coachSuggestionEngaged` only; says "Log your first sets when you're ready" |
| 2 | **Plan explicitly started** (alternative intents) | `app.js:2421` "Start Session" button → `startPlannedSession(intent)` (`app.js:1610`) | explicit button in the intent drawer ("Other training options") |
| 3 | **Plan materialized implicitly** (Coach's Pick main flow) | `ensureActivePlannedSession()` `app.js:1712`, called by `tryApplyPlanMutation` `app.js:1740` | first typed swap/skip promotes the engaged suggestion to a live session |
| 4 | **Plan replaced** | `applyProposedPlanEdit()` `replace_plan` `app.js:2190`; `ensureChatPlannedSession()` `app.js:2165` | auto-apply of a coach `atlas:plan-edit-proposed` event — no confirm step |
| 5 | **Exercise completed** | `setSessionCompleted`/`getSessionCompleted` `store.js:48`; matched by pure `computePlanState()` `services/sessionPlanExecutor.js:67` | logged-set names accumulate client-side; completion derived by name+`liftCode` match (read-only in coach chat) |
| 6 | **Exercise skipped** | `skipPlannedExercise(name)` `app.js:1680` | client splice of `activePlannedSession.exercises` |
| 7 | **Substitution accepted/performed** | `applySessionSubstitution()` `app.js:1561`; reconcile `activeSession.js:320` | client splice; keeps remaining list; mirrors pure `applySubstitution()` `sessionPlanExecutor.js:173` |
| 8 | **Session finalized** | `#finish-session-btn` `index.html:161` → `handleLogIt()` `app.js:3780`; banner "End session" `app.js:2040`; save via `#approve-btn` `index.html:130` → `app.js:6104` | explicit finish/save; the actual write posts to `/api/log-workout` / `/api/complete-workout` |
| 9 | **Session explicitly discarded** | `#start-over-btn` "Start over" `index.html:132` → `startOverWorkout()` `app.js:4815`; restore-banner trash → `discardRestoredSession()` `app.js:3950` | explicit reset; clears buffers + `clearSessionSnapshot()` |

Cross-reload persistence exists: `atlas_session_snapshot_v1` in `localStorage` (`store.js:115`), storing `{ v, ts, sessionLog, sessionCompleted, activePlannedSession, pendingSubstitution?, sessionId? }`; auto-restore only when a non-empty `sessionLog` is present within 12h (`store.js:154`).

`session_id` — `generateSessionId(dateValue)` (`app.js:3142`), format `YYYYMMDD-AM|PM-NN`, minted at preview/save time; cleared after a successful save so the **server** auto-increments the `-NN` suffix. Effectively **per-save/per-session**.

---

## 2. Call-site authority classification

| Path | Call site | Verdict | Rationale |
|---|---|---|---|
| Start (alt intents) | `startPlannedSession` behind `#…"Start Session"` `app.js:2421` | **AUTHORITATIVE** | A deliberate button press that activates a specific plan. Genuinely explicit. |
| Coach's Pick engaged | `coachSuggestionEngaged` `coach-conversation.js:851` | **NON-AUTHORITATIVE** | A "show me the brief" tap; sets a flag, activates nothing. |
| Coach's Pick → live | `ensureActivePlannedSession` `app.js:1720` | **NON-AUTHORITATIVE** | Implicit promotion on first mutation. Owner-forbidden as an acceptance signal. |
| Plan replaced | `applyProposedPlanEdit` replace/add `app.js:2190/2204` | **AMBIGUOUS** | Auto-applies a coach proposal with no user confirm. Must NOT be treated as acceptance without an explicit confirm. |
| Completed | client `sessionCompleted` + `computePlanState` | **NON-AUTHORITATIVE** | Derived from logged-set names; not an explicit per-item outcome. Server has no plan identity here. |
| Skipped | `skipPlannedExercise` `app.js:1680` | **AUTHORITATIVE (client action)** | A deliberate skip command/tap on a specific planned item. Explicit — but currently client-only. |
| Substituted | `applySessionSubstitution` `app.js:1561` | **AUTHORITATIVE (client action)** | A deliberate accepted substitution of a specific item. Explicit — but client-only. |
| Finalized | `#finish-session-btn` `app.js:3780`; "End session" `app.js:2040` | **AUTHORITATIVE** | Explicit finish affordances. |
| `endPlannedSession` auto paths | `app.js:2095/2101/2109/2158/6255` | **NON-AUTHORITATIVE** | Auto-end on last exercise / empty plan / post-save reset. Must be excluded from closeout capture. |
| Discarded | `#start-over-btn` `app.js:4845`; `discardRestoredSession` `app.js:3950` | **AUTHORITATIVE** | Explicit discard affordances. |
| Save write | `#approve-btn` `app.js:6104` | **AUTHORITATIVE (write, not closeout)** | Explicit preview→approve. Note: a save is **not** a closeout — completion is derived from item outcomes, not the save. |

**Headline gaps this lane must close:**
- **Acceptance for the primary Coach's Pick flow has no explicit affordance.** The only explicit "start" is the alternative-intent drawer. Per the owner ("if no genuinely explicit acceptance action exists, propose the smallest explicit acceptance interaction; do not silently redefine an existing ambiguous action"), §5 proposes one.
- **Skip / substitute are explicit but client-only** — they need an outcome POST added at the existing explicit handler (no new inference).
- **Completed has no explicit per-item signal today** — §5/§7 define an explicit per-item "completed" outcome tied to the accepted item, **never** an inference from an arbitrary logged set.

---

## 3. Client-held active-plan contract

The accepted plan is the single source of persisted identity. It **extends** today's `{ label, intentId, exercises, index }` — additive, no removals — and is written into the `localStorage` snapshot so a reload reuses the **same** identity (retry-safe).

```jsonc
// _activePlannedSession (accepted form)
{
  "session_id":   "20260710-AM-01",   // reuse the existing workout session_id (minted at accept time if absent)
  "session_date": "2026-07-10",       // YYYY-MM-DD, fixed at acceptance
  "plan_version": "pv_9f1c8e0a-…",    // opaque UUID-backed revision id, minted at acceptance (see §4.4)
  "accepted":     true,               // false/absent = draft (NEVER persisted to Session_Plans)

  "label":   "Recommended session",   // existing UI field, retained
  "intentId": "upper_a",              // existing UI field, retained

  "items": [                          // immutable accepted snapshot — reorder/exec does NOT rewrite this
    {
      "plan_item_id":     "pi_3b7d…", // opaque UUID-backed id, minted once at acceptance, immutable (§4.4)
      "planned_order":    1,          // fixed accepted order
      "planned_lift_code":"BEN01",    // canonical CODE, fixed at acceptance
      "movement_pattern": "horizontal_push",
      "outcome":          "planned",  // planned | completed | skipped | substituted (current state)
      "performed_lift_code": null     // set ONLY when outcome === "substituted"
    }
  ],

  "index": 0                          // execution cursor (existing). Advancing/reordering NEVER mutates items[].
}
```

Mapping from today's shape: each normalized `exercises[]` entry `{ name, canonicalName, liftCode, ... }` becomes an `items[]` entry — `liftCode → planned_lift_code`, position → `planned_order`, `movement_pattern` resolved via `services/movementPattern.js` at acceptance, plus the minted `plan_item_id`. The existing execution fields (`index`, per-exercise weights/reps for the logger) are **unchanged** and are **not** part of the persisted Session_Plans contract (no loads/reps in this lane).

**Rules enforced by this shape:**
- `items[]` is the **immutable accepted snapshot**. Substitution mutates only the live execution view; the accepted `plan_item_id` + `planned_lift_code` are retained and the substitution is recorded as an `item_outcome` carrying `performed_lift_code`.
- Reordering execution changes only `index`/execution view, never `items[]` or `planned_order`.
- **Extra/off-plan exercises never become planned items.** They are logged as sets (Log_Cleaned) as they are today, and are simply absent from `items[]` — the reader already ignores non-planned lifts.
- **Every explicit acceptance mints a new `plan_version`** (§4.4) — re-accepting an identical-looking plan, or a materially changed plan, is always a new revision. A **network retry** of the same acceptance reuses the **stored** IDs (never re-minted); IDs are never regenerated from the exercise array after acceptance.

---

## 4. Server protocol

Three narrow authenticated endpoints. All are **`writeCapable: true`** in `config/routes.js` **but write only the `Session_Plans` sidecar** — never `Log_Cleaned`/`Effort`. Registering them requires adding rows to `config/routes.js` (Invariant: new route ⇒ manifest entry).

### 4.0 Shared middleware / guards (every endpoint)
1. **Auth:** require the Atlas API key (`x-atlas-api-key`), same as all `/api/*`.
2. **Feature flag:** `ATLAS_SESSION_PLANS_WRITE` (accepts `1`/`true`/`on`; default **OFF**). OFF ⇒ **no Sheets access at all**, return `{ status: "disabled", captured: false }`. (Mirrors `isFlightRecorderEnabled()` `services/flightRecorder.js:81`.)
3. **Exact-header validation before any write:** read `Session_Plans!A1:M1`; if the tab is missing ⇒ `{ status: "tab_missing", captured: false }`; if the header differs **position-by-position** from `config/columns.js sessionPlansColumns` ⇒ `{ status: "header_mismatch", captured: false }` + a clear server log diagnostic. **Never guess column positions.**
4. **Builders + writer only:** construct rows via `sessionPlanEvents.js` builders; persist via `sessionPlanStore.js` (`writePlanAccepted` / `writeItemOutcome` / `writeSessionCloseout`). `recorded_at` is stamped non-empty by the writer (`_nowIso()`) — pinned by test.
5. **Sidecar isolation:** the entire capture is wrapped so it can **never throw to a caller**. These endpoints are **standalone** (the client calls them separately from the workout save), so a failure here is structurally incapable of affecting `/api/log-workout`. Response always carries explicit proof; a caught failure returns `{ status: "error", captured: false, reason }` (HTTP 200 with `ok:false`, never a 5xx that the client might mistake for a workout-save failure).
6. **Idempotency & collisions:** the writer's deterministic `idempotency_key` de-dups retries; a revision collision (same key, different content) **fails closed** (`{ status: "error", reason: "revision_collision" }`) — the client must bump `plan_version`.

**Shared response envelope:**
```jsonc
{
  "ok": true,
  "session_plans": {
    "status": "written" | "skipped" | "disabled" | "tab_missing" | "header_mismatch" | "error",
    "captured": true | false,        // true ONLY when an append actually succeeded OR was an idempotent skip of an already-persisted event
    "written": 0,                    // rows appended this call
    "skipped": 0,                    // idempotent duplicates collapsed
    "plan_version": "pv_9f1c8e0a-…",
    "reason": null                   // human-readable diagnostic when captured=false
  }
}
```
`captured` is the ONLY field the client may use to make a "plan remembered" claim. `disabled` / `tab_missing` / `header_mismatch` / `error` ⇒ `captured:false` ⇒ **no memory claim**, and plan-history-dependent detectors remain UNAVAILABLE.

### 4.1 `POST /api/session-plans/accept`  — establishes plan identity
```jsonc
// request
{
  "session_id":   "20260710-AM-01",
  "session_date": "2026-07-10",
  "plan_version": "pv_9f1c8e0a-4d2b-4f6a-9c11-7e5b2a0d1c33",
  "items": [
    { "plan_item_id": "pi_3b7d1e2f-…", "planned_order": 1, "planned_lift_code": "BEN01", "movement_pattern": "horizontal_push" },
    { "plan_item_id": "pi_a0c94d55-…", "planned_order": 2, "planned_lift_code": "SQ01",  "movement_pattern": "squat" }
  ]
}
```
→ `writePlanAccepted({session_id, session_date, plan_version}, items)` — one `plan_accepted` row per item (`outcome:'planned'`). Response envelope with `written` = item count on first accept, `skipped` = item count on an idempotent retry.

### 4.2 `POST /api/session-plans/outcome` — one explicit item outcome
```jsonc
// request
{
  "session_id": "20260710-AM-01", "session_date": "2026-07-10", "plan_version": "pv_9f1c8e0a-…",
  "item": {
    "plan_item_id": "pi_3b7d1e2f-…", "planned_order": 1, "planned_lift_code": "BEN01", "movement_pattern": "horizontal_push",
    "outcome": "substituted",              // completed | skipped | substituted
    "performed_lift_code": "DBP01"          // REQUIRED iff outcome === "substituted"; omit otherwise
  }
}
```
→ `writeItemOutcome({session_id, session_date, plan_version}, item)` — one `item_outcome` row. The builder enforces `performed_lift_code` present-iff-substituted and rejects unknown outcomes. `plan_item_id` is the **immutable** accepted id; substitution keeps it and adds `performed_lift_code`.

### 4.3 `POST /api/session-plans/closeout` — one explicit closeout
```jsonc
// request
{ "session_id": "20260710-AM-01", "session_date": "2026-07-10", "plan_version": "pv_9f1c8e0a-…", "closeout_status": "finalized" }
```
→ `writeSessionCloseout({session_id, session_date, plan_version}, closeout_status)` — one `session_closeout` row. `closeout_status ∈ finalized | abandoned` (builder-enforced). Completion is **derived from item outcomes**, never from this field.

### 4.4 Identity generation — **client-generated OPAQUE UUID-backed IDs** (owner decision, 2026-07-10)

Identity is **client-generated and opaque** — minted at the explicit acceptance action, **before** the acceptance request, and **never derived from the plan's contents**:

- **`plan_version`** = a fresh opaque token `pv_<uuid>`. It is the **opaque identity of one immutable accepted-plan revision** in v1 — NOT a numeric counter and NOT a hash of the plan. Every explicit acceptance mints a new `pv_<uuid>`, so re-accepting an identical-looking plan, or a materially changed plan, always yields a **new** `plan_version`.
- **`plan_item_id`** = one fresh opaque token `pi_<uuid>` per accepted item, minted at acceptance, **immutable** thereafter. Substitution keeps the original `plan_item_id` and records `performed_lift_code`; it is never regenerated.
- **Generation:** use the platform cryptographic UUID generator (`crypto.randomUUID()` where available; a crypto-backed fallback otherwise). **Never** use timestamps or `Math.random()` as identity.
- **Storage & reuse:** all IDs are written into active client-session state (and the `localStorage` snapshot) **before** the request is sent. **Network retries reuse the stored IDs.** A page reload/resume reuses the **persisted** active-session IDs. IDs are **never regenerated from the current exercise array** after acceptance.

**Why client-generated (not server-issued):** the plan must be usable immediately on acceptance, and — critically — when `ATLAS_SESSION_PLANS_WRITE` is **OFF** a server would issue nothing, leaving accepted plans with no identity and breaking the draft-vs-accepted distinction. Client-generated UUIDs make identity **independent of the flag**, so the sidecar stays truly optional; the workout starts whether or not capture is enabled.

**Why opaque UUID, not a content-derived hash (owner reason):** a content hash could (a) **collapse two distinct acceptances** of the same-looking plan into one identity, (b) **change when normalization changes** (coupling identity to representation), and (c) tie identity to plan content. Opaque UUIDs cleanly separate identity from content: two acceptances are always distinct revisions, and identity is stable regardless of how the plan is rendered or normalized.

**Retry-safety** is therefore provided by **stored-ID reuse** (retry/reload reuse the same persisted IDs), not by re-derivation. The endpoints **accept** the client IDs and validate their **shape** (`pv_`/`pi_` prefix + non-empty token; canonical lift codes via the existing builders, which throw on malformed identity); they do not mint IDs. Tamper surface is acceptable for this single-owner app — a forged id only mis-buckets that client's own fold and cannot corrupt a different session (the server re-derives `idempotency_key` from the event's semantic identity).

---

## 5. Acceptance semantics

**Definition:** a plan becomes authoritative the instant the athlete performs an **explicit accept/start action**, and only then. The acceptance request (§4.1) carries the freshly-minted identity.

**Qualifying (authoritative) today:**
- The intent-drawer **"Start Session"** button → `startPlannedSession(intent)` (`app.js:2421` → `app.js:1610`). This is a genuine explicit acceptance and is the authoritative capture site for alternative-intent plans. **PR-F** adds identity minting + the accept POST **inside `startPlannedSession`**.

**NOT qualifying (must never be treated as acceptance):**
- A plan merely **rendered** (Coach's Pick `typeSuggestedWorkout` `coach-conversation.js:842`).
- **`coachSuggestionEngaged`** being set (a "show the brief" tap).
- The **implicit promotion** `ensureActivePlannedSession` on first mutation (`app.js:1720`).
- A coach **`replace_plan` / `add_exercises`** auto-apply (`app.js:2190/2204`) with no user confirm.
- The **first logged set**, page navigation, or any **LLM-inferred** intent from chat text.

**Gap → the decided explicit affordance (owner decision, 2026-07-10; built in PR-F):** the **primary Coach's Pick** flow has no explicit accept affordance today, so PR-F adds a **distinct explicit control on the rendered plan card** labelled **"Start this plan"**. It is the **authoritative acceptance boundary for v1**. It must:
- **clearly refer to the displayed plan** (it acts on the plan the card shows, not a generic surface);
- **mint and store the accepted-plan identity** (`pv_`/`pi_` UUIDs, §4.4) into active session state + the snapshot **before** any request;
- **establish the immutable accepted snapshot locally** (`items[]`, §3);
- **call `/api/session-plans/accept`** when capture is enabled;
- **start the workout even when the sidecar flag is OFF or the sidecar request fails** (capture is a non-blocking sidecar — the session always starts);
- **never claim "remembered", "captured", or persisted** unless the endpoint returns `captured:true`.

Do **not** repurpose a generic "Start Session" control that currently only opens the coach/composer surface (`app.js:1428` `openCoachPickInThread`) — that stays as-is; the new "Start this plan" button is a distinct, deliberate acceptance affordance. A later PR may add deterministic *conversational* acceptance, but that is outside this lane.

**Plan replacement — DEFERRED (owner decision, 2026-07-10).** The current implicit `replace_plan` behavior (`app.js:2190`, auto-apply of a coach proposal) is **NOT** treated as a newly accepted revision. Until a separate explicit confirmation exists:
- **no new `plan_accepted` event** is written for an implicit replacement;
- the **existing accepted snapshot remains** the persisted plan identity — its item IDs and accepted rows are **not mutated**.
Filed as a later narrow UX item — *"Add explicit 'Replace current plan' confirmation"* (`BACKLOG.md`). When eventually built, the confirmation mints a new `plan_version` and a new immutable item set.

---

## 6. Closeout semantics

- **`finalized`** — written **only** from an explicit **Finish/Close Session** action: `#finish-session-btn` (`app.js:3780`) or the banner **"End session"** (`app.js:2040`). Emitted **once**, after the athlete deliberately ends the session.
- **`abandoned`** — written **only** from an explicit **Discard/Cancel Session** action: `#start-over-btn` "Start over" (`app.js:4845`) or the restore-banner discard `discardRestoredSession` (`app.js:3950`), **when an accepted plan exists**.
- **Clearing local state alone is NOT a closeout** unless it is the direct consequence of one of those explicit confirmed actions. The **implicit** `endPlannedSession` paths (auto-end on last exercise `app.js:2095/2101/2109`, empty-plan clamp `app.js:2158`, post-save reset `app.js:6255`) **must NOT** emit a closeout.
- **Never infer** either status from inactivity, timeout, browser close, navigation, server restart, or missing rows.
- A closeout is only meaningful for an **accepted** session (one with a `plan_version`); a freestyle session with no accepted plan emits nothing.

---

## 7. Rollout & PR slices

| PR | Scope | Gate |
|---|---|---|
| **PR-D** (this) | Docs/spec + exact capture-point map. **No code.** | Owner review; **stop for owner approval before PR-E.** |
| **PR-E** | Server protocol: 3 endpoints + `config/routes.js` entries + request schemas + flag (default OFF) + exact-header validation + envelope; **existing builders/store only**; **no client calls**; tests-first. | CI + review; flag OFF ⇒ zero writes proven. |
| **PR-F** | Accepted-plan identity in client state: one authoritative acceptance helper, mint/store opaque `pv_`/`pi_` UUIDs (§4.4), extend the snapshot shape, call `/accept`. Adds the distinct **"Start this plan"** plan-card button as the v1 acceptance boundary (§5). Drafts stay unpersisted; the session starts even with the flag OFF or a sidecar failure. | CI + review. |
| **PR-G** | Explicit item-outcome capture: `completed` / `skipped` / `substituted` at the existing explicit handlers (`skipPlannedExercise`, `applySessionSubstitution`, and an explicit per-accepted-item completed signal). Same immutable `plan_item_id`. **No inference from arbitrary logged sets.** | CI + review. |
| **PR-H** | Explicit closeout capture: `finalized` (finish/end) and `abandoned` (discard) at the explicit affordances only. No implicit-path emission. | CI + review. |
| **PR-I** | Canary + reader verification: flag stays **OFF** until owner confirmation → enable for **one** controlled real session → inspect raw rows → verify `readPlannedVsCompleted` output → **only then** consider wiring `skipped_pattern_streak` / `plan_deviation`. | Owner-run canary PASS. |

Wiring (PR-F…PR-H) progressively removes the three `sessionPlan*` entries from `config/wiring-allowlist.json` as each module gains a production call site, dropping the cap accordingly.

---

## 8. Threat / trust review

| Threat | Mitigation |
|---|---|
| **Duplicate clicks / network retries** | The client sends the **stored** `pv_`/`pi_` IDs, so a retried accept carries identical identity ⇒ the writer's deterministic `idempotency_key` (semantic identity, never timestamp) `skip`s the duplicate. A double-tap on "Start this plan" is guarded client-side (idempotent: if the active plan is already `accepted`, re-use its stored IDs / no re-mint). |
| **Stale client state** (old accepted plan) | A stale snapshot re-sends its stored IDs (idempotent skip). A genuinely new **explicit** acceptance mints a **new** `plan_version` (a new revision — new append; the reader folds per `plan_version`), so a new plan under the same `session_id` never overwrites the prior revision. |
| **Plan revision collision** (same key, different content) | Writer **fails closed** (`revision_collision`); the client must bump `plan_version`. Reader also marks a same-key-conflict session `status:'error'` and excludes it. |
| **Outcome sent before acceptance** | The reader folds an `item_outcome` for an item with no `plan_accepted` as an item with `planned_lift_code:null` unless the outcome carries it; per §4.2 the client always sends the accepted item metadata, but a genuinely orphan outcome contributes nothing to `planned[]` (drift ignores it). PR-G only fires outcomes for items in the **accepted** `items[]`, so an outcome without acceptance is unreachable by construction. |
| **Closeout sent twice** | `session_closeout` idempotency_key hashes `(session_id, plan_version, closeout_status)` ⇒ identical re-send is `skipped`; a *conflicting* closeout (finalized then abandoned) is last-wins in the reader (and a same-key/different-content case fails closed). |
| **New plan accepted under an existing session** | A new acceptance mints a new `plan_version`; the reader folds per `(session_id + plan_version + plan_item_id)`, so the two plans are distinct histories under the same `session_id`. The prior accepted snapshot is never mutated. |
| **Sidecar failure while the main workout save succeeds** | The three endpoints are **separate** from `/api/log-workout`; they never share a code path, so a Session_Plans failure is structurally incapable of affecting the workout write. Failure ⇒ `captured:false` ⇒ no memory claim; the workout save is untouched. |
| **Client tampering with lift codes / plan IDs** | Builders validate canonical codes (non-empty, no whitespace) and reject malformed identity. A forged id only mis-buckets that client's own fold (single-owner app); it cannot corrupt another session (server re-derives the key). No trust-contract tab is reachable. |
| **Page reload / resume** | The `localStorage` snapshot carries `activePlannedSession` **including its minted `pv_`/`pi_` IDs**, so a resumed session reuses the **persisted** identity (never re-mints from the exercise array). A reload never emits `abandoned` (that requires an explicit discard). |
| **Feature flag OFF** | No Sheets access, no rows, `{status:'disabled', captured:false}`; the app is byte-identical in behavior. Client identity still mints/stores (flag-independent) so turning the flag ON later is seamless. |

---

## 9. Owner decisions (resolved 2026-07-10)

1. **ID issuance — RESOLVED: client-generated OPAQUE UUID-backed IDs** (`pv_<uuid>` / `pi_<uuid>`), minted at acceptance, stored before the request, reused on retry/reload, a new `plan_version` per explicit acceptance, never derived from plan contents and never regenerated from the exercise array (§4.4). Content-derived hashes are explicitly rejected (they could collapse distinct acceptances and couple identity to representation).
2. **Coach's-Pick acceptance affordance — RESOLVED: a distinct "Start this plan" button on the rendered plan card** is the v1 authoritative acceptance boundary (§5). Do **not** repurpose the generic "Start Session" control that only opens the coach surface. The button starts the workout regardless of the flag/sidecar and never claims persistence unless `captured:true`.
3. **Coach `replace_plan` persistence — DEFERRED (owner):** the implicit replace stays a draft; no `plan_accepted` is written and the existing accepted snapshot is not mutated. Filed as *"Add explicit 'Replace current plan' confirmation"* in `BACKLOG.md` for a later narrow UX PR (when built, confirmation mints a new `plan_version` + new immutable item set).

---

## 10. Cross-references

- Data contract & builders: `services/sessionPlanEvents.js`; writer: `services/sessionPlanStore.js`; reader/fold: `services/sessionPlanReader.js`; schema: `config/columns.js` `sessionPlansColumns`; optional tab: `config/sheetContract.js`.
- Trust contract & tab rules: `CLAUDE.md` (12-col `Log_Cleaned`, 13-col `Session_Plans`), `docs/INVARIANTS.md`.
- Decision provenance: Decision Desk #952 (Option A), STOP-&-REPORT finding + owner Option-A authorization (2026-07-10), `BACKLOG.md` → "Session_Plans persistence lane".
