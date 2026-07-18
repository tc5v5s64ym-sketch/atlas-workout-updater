# Session_Plans Ledger — Design Contract (F10 / F10A)

**Status: APPROVED WITH AMENDMENTS (Dale, 2026-07-17).** The three owner amendments are incorporated below (changelog in §10). This is a **design-only** contract — no production `Session_Plans` change, no data migration, no mid-session production write, and no first real write is enabled by this document. It defines the contract, the schema, the durability + validation rules, the migration/back-compat handling, and how F10A–F10E divide into focused PRs. **The production `Session_Plan_Sets` tab creation and production-write enablement remain an explicit owner-reserved action, gated at F10D.**

**Owner amendments (2026-07-17), binding on this contract:**
1. **No automatic revision from a performed value.** A revision row is appended **only** when Atlas *explicitly* issues a new recommendation before the targeted future set. A performed set never auto-generates a revision. (Planned dips 65, performed 60 → the effective recommendation stays **65** unless Atlas explicitly recommends 60 for a *subsequent* set.)
2. **Durable idempotent checkpointing at creation — session state alone is insufficient.** The ledger must survive reloads, crashes, authentication loss, and a failed/rejected closeout. Once production writes are enabled (F10D), each accepted recommendation and each explicit revision is durably + idempotently checkpointed **when created** (a non-blocking sidecar write, like the existing `Session_Plans` item-event capture). Closeout may attach `closeout_write_id` and seal/link the records, but closeout is **not** their first durable persistence.
3. **`effectiveRecommendation()` validates the revision chain and fails closed.** Duplicate versions, forks, missing/mismatched `supersedes_key`, and cross-session/item/set references must fail closed as **`no_reliable_target` with diagnostics** — never silently resolved by selecting the maximum `plan_version`.

Author basis: the *actual* current model — `config/columns.js` (`sessionPlansColumns`, 13 cols), `src/app/planAcceptance.js` (`buildAcceptedItems`), `src/app/planOutcome.js` (`ITEM_OUTCOMES`, `plan_item_id`-only identity, fail-closed), `src/app/planCloseout.js` (`CLOSEOUT_STATUSES`), `services/sessionPlanExecutor.js` (`computePlanState`, name/liftCode matching), and `docs/SESSION_PLANS_CAPTURE_SPEC.md`.

---

## 0. The two truths (owner-approved product model, restated)

Atlas maintains **two separate, never-merged truths**:

1. **The recommendation ledger** — what Atlas prescribed, and how that prescription *evolved* (accepted → revised). Immutable per set once effective.
2. **Actual execution** — what the athlete performed. This already lives in `Log_Cleaned` / `Effort`; it is **not** copied into the ledger.

Non-negotiables this design enforces:

- **Never copy an actual result backward and label it the plan.** Performed values live only in `Log_Cleaned`. The ledger stores recommendations only.
- **A completed set's target is immutable.** A revision applies to *future* sets only.
- **Revisions are appended, never overwritten.** The full history (original + every revision) is reconstructable.
- **Insufficient evidence → "no reliable target available"** — never an invented target, never the actual restated as the plan.

---

## 1. Where the ledger lives — a companion `Session_Plan_Sets` tab (recommended)

The card allows *either* extending `Session_Plans` *or* a companion `Session_Plan_Sets` tab. **Recommendation: the companion tab.** Rationale:

| Criterion | Extend `Session_Plans` | Companion `Session_Plan_Sets` |
|---|---|---|
| Grain | `Session_Plans` is **item-event** grain (one row per plan-item event). Set-level targets are a **finer** grain → either explode columns (`set1_weight`, `set2_weight`, …) or overload item rows with nullable set fields (messy). | Native **set × revision** grain — one row per (plan item, set, version). Clean. |
| Migration risk | Adds columns to an **existing production tab with historical rows** → a real schema migration on live data. | **New optional tab** — existing tabs untouched; zero migration on `Session_Plans`/`Log_Cleaned`/`Effort`. |
| Back-compat | Historical `Session_Plans` rows gain trailing empty columns; readers must special-case. | Legacy sessions simply have **no** `Session_Plan_Sets` rows → cleanly read as "no stored plan." |
| Precedent | — | Mirrors the established **optional sibling-tab** pattern (`Modality_Log`, `Constraints`): `config/sheetContract.js` marks it optional; the write route returns **503 until the tab exists**. |

`Session_Plans` stays the **item-level spine** (identity, outcome, closeout — unchanged). `Session_Plan_Sets` is the **set-level recommendation ledger**, joined to the spine by `(session_id, plan_version, plan_item_id)`. **No second database** — same Google Sheet, a sibling tab.

---

## 2. Proposed `Session_Plan_Sets` schema (16 columns, append-only)

Column order is a proposal for owner approval. Same rules as every other tab: **new columns are only ever appended at the end; never insert or reorder; add/remove/reorder requires a migration + owner approval.** Canonical lift **codes** only (never free-text identity), matching `Session_Plans`.

```text
idempotency_key | session_id | session_date | plan_version | plan_item_id |
planned_lift_code | set_index | target_set_count | target_weight | target_reps |
target_rir | recommendation_source | supersedes_key | confidence |
closeout_write_id | recorded_at
```

| # | Column | Meaning | Owner-requested element it satisfies |
|---|---|---|---|
| 1 | `idempotency_key` | Deterministic per-row key (server-derived from `session_id\|plan_version\|plan_item_id\|set_index`). Retry-safe; duplicates collapse last-wins — same discipline as `Session_Plans`. | deterministic IDs / idempotency; write identity |
| 2 | `session_id` | Owner session id. | session identity |
| 3 | `session_date` | Canonical **local** session date (via `localTodayIso`, per F09I). | session identity |
| 4 | `plan_version` | `1` = accepted plan; `2,3,…` = successive **revisions**. Monotonic per session. | plan version; original & revised history |
| 5 | `plan_item_id` | Joins to the `Session_Plans` item identity (the F10 completion spine). Identity is **only** ever this id — never lift-code/name/position. | plan item identity; stable completion identity |
| 6 | `planned_lift_code` | Canonical code the recommendation is for. | (identity, codes-only) |
| 7 | `set_index` | 1-based target set this row prescribes. | target set identity |
| 8 | `target_set_count` | Recommended number of working sets for the item **at this version** (so a "3 → 2 sets" revision is expressible, and "completed fewer/more sets" is assessable). | target set count |
| 9 | `target_weight` | Recommended load. Bodyweight uses the `Log_Cleaned` convention (`0`). Blank when `confidence = no_reliable_target`. | target weight |
| 10 | `target_reps` | Recommended reps. Blank when no reliable target. | target reps |
| 11 | `target_rir` | Recommended RIR. Blank when no reliable target. | target RIR |
| 12 | `recommendation_source` | One of `accepted` \| `engine` \| `live_revision` \| `user_endorsed` \| `implicit_unplanned` (see §4). | recommendation source |
| 13 | `supersedes_key` | The `idempotency_key` of the row this revision replaces (blank for `v1`). Makes the revision chain explicit — **the prior row is never mutated**. | replacement / supersession |
| 14 | `confidence` | `reliable` \| `no_reliable_target`. The engine-owned honesty flag (F10C). | confidence / no-reliable-target |
| 15 | `closeout_write_id` | The `write_id` of the owner-approved closeout that **sealed/linked** this row. The row is first persisted at *creation* (accept/revise, amendment 2); closeout only stamps this field to bind the row to the finalized session — it is **not** the row's first durable write. Blank until closeout seals it. | closeout / write identity |
| 16 | `recorded_at` | ISO timestamp the recommendation was formed (client clock; stamped when written at closeout). | audit / ordering |

**The "effective set boundary"** the card asks for is **encoded, not a separate column**, by `set_index` + `plan_version` + one invariant:

> A revision MUST NOT append a row for a `set_index` that is already performed (has a matching logged set in `Log_Cleaned`). The effective target for a set is the **highest `plan_version` row for that `(plan_item_id, set_index)`**. Because revisions never target an already-performed set, a performed set's target is **frozen** at whatever version was effective when it was performed.

---

## 3. The single selector — `effectiveRecommendation`

One authoritative selector (mirroring the F09F provenance principle: planned, revised, and performed are distinct and never conflated). Pure, DOM-free, testable:

- `effectiveRecommendation(ledgerRows, plan_item_id, set_index) → { target_weight, target_reps, target_rir, plan_version, recommendation_source, confidence } | { confidence: 'no_reliable_target', diagnostics }`
  **Validates the revision chain first (amendment 3), then** folds to the highest-`plan_version` row for `(plan_item_id, set_index)`. This is the one target every surface reads.
- `effectivePlan(ledgerRows, plan_item_id) → orderedSets[]` — the per-set effective targets (the **final effective plan** for the item), plus the effective `target_set_count`.
- `planHistory(ledgerRows, plan_item_id) → versions[]` — the full original+revised chain, for audit and the F10D closeout diff.

**Chain validation — fail closed, never guess (amendment 3).** Before selecting any effective target, the selector validates the `(plan_item_id, set_index)` history and returns **`no_reliable_target` with structured `diagnostics`** (never the max-version row) on any of:

- **Duplicate versions** — two rows sharing the same `(plan_item_id, set_index, plan_version)`.
- **Forks** — two distinct rows whose `supersedes_key` points at the same predecessor (a version must have at most one successor).
- **Missing / mismatched `supersedes_key`** — any `plan_version > 1` row whose `supersedes_key` is blank, or points to a key that is absent, or points to a row that is not the immediately-prior version of the *same* `(plan_item_id, set_index)`.
- **Cross-session/item/set reference** — a `supersedes_key` resolving to a row with a different `session_id`, `plan_item_id`, or `set_index`.
- **Non-contiguous versions** — the version chain for a set is not `1 → 2 → 3 …` without gaps.

A clean chain is exactly one linear path `v1 → v2 → … → vN` per `(plan_item_id, set_index)`. Malformed history is a **trust failure surfaced honestly**, not silently resolved — the diagnostics identify the offending keys so F10D closeout and F11 proving packs can flag it.

Every consuming surface (visible plan card, next-up, per-lift recommendation, coach facts, recap, closeout, assessment) reads `effectiveRecommendation` — never re-derives a target from actuals, never reads a performed value as a plan. **Planned** (v1), **revised** (vN, `recommendation_source = live_revision`/`user_endorsed`), and **performed** (`Log_Cleaned`) stay three separate lookups.

---

## 4. Recommendation sources & the revision rule

`recommendation_source`:

- `accepted` — the athlete accepted Atlas's proposed session → **ledger v1** (F10B). Every planned set, ordering + `plan_item_id` preserved.
- `engine` — a raw `recommendNextSet` prescription Atlas formed (e.g. the first target for a lift), not yet athlete-accepted.
- `live_revision` — a post-set adjustment Atlas made mid-session (applies to **future** sets only).
- `user_endorsed` — a user-requested change that becomes Atlas's recommendation **only because Atlas explicitly endorsed/revised it** (never a silent adoption of the athlete's number).
- `implicit_unplanned` — an independent recommendation for an exercise the athlete simply logged without asking (F10C), snapshotted **before** that exercise's result is incorporated.

**Revision = append, never overwrite.** A revision writes a new row with `plan_version+1`, the same `plan_item_id`/`set_index`, `supersedes_key` = the superseded row's key, and `recommendation_source ∈ {live_revision, user_endorsed}`. The superseded row remains, verbatim, forever.

**A revision is only ever created by an EXPLICIT Atlas recommendation (amendment 1).** A performed value **never** auto-generates a revision. Logging a set that differs from the target changes nothing in the ledger — the effective recommendation is unchanged. A revision row exists only because Atlas *explicitly issued a new recommendation for a future set* (a coach-driven `live_revision`, or a `user_endorsed` change Atlas explicitly adopted), and it must be created **before** the targeted set is performed (a row may not target an already-performed `set_index`). This is the structural guarantee that actual execution can never masquerade as, or silently rewrite, the plan.

---

## 4A. The implicit recommendation for an unannounced exercise (F10C — owner decision, 2026-07-18)

When the athlete simply **logs** an exercise that Atlas never proposed and the athlete never announced, Atlas forms an *independent* recommendation for it and records it as an `implicit_unplanned` ledger row — the plan Atlas *would* have given, captured so target-vs-actual stays honest and never circular. The owner-binding rules (Dale, 2026-07-18), which the F10C implementation and its tests must satisfy exactly:

1. **One next set only.** An implicit recommendation for an unannounced exercise represents a single next set → `target_set_count = 1`. It never fabricates a multi-set prescription.
2. **No range→scalar collapse.** A rep or RIR *range* is never converted into a scalar target by midpoint, boundary, or default. A range is not an exact target.
3. **Exact scalars, from trustworthy history only.** An `implicit_unplanned` ledger row is created **only** when an exact `target_weight`, an exact `target_reps`, **and** an exact `target_rir` can all be derived from trustworthy **pre-session** history.
4. **Exclude the current session.** Every row from the current session is excluded from the evidence used to derive the recommendation (by `session_id`, with the session date as a fallback). The just-logged exercise result is part of that excluded set.
5. **Absent / ambiguous / range-only → `no_reliable_target`.** When the historical evidence is absent, incomplete, ambiguous, or yields only ranges, Atlas returns and displays `no_reliable_target` and appends **no** recommendation row. It never invents a target and never downgrades the actual into a plan.
6. **The submitted set cannot move its own target.** Changing the just-submitted first set must not change the derived recommendation — this follows structurally from rule 4 (the derivation reads only pre-session evidence). This is the leakage guarantee the F10C tests pin.
7. **A performed value never becomes the recommendation.** The performed value is never promoted into the recommendation automatically. A later target for the same exercise requires an **explicit** future-set revision (`live_revision` / `user_endorsed`, §4) — never the silent adoption of what was done.

**Mechanics.** The derivation calls the same deterministic engine an explicit ask would, over pre-session history with the current session excluded (rule 4); it accepts the engine's output as a target **only** if weight, reps, and RIR are each an exact scalar (rule 3) and neither reps nor RIR is a range (rule 2) — otherwise `no_reliable_target` (rule 5). The `implicit_unplanned` row (`target_set_count 1`, `supersedes_key` empty, `confidence` = `reliable` or `no_reliable_target`, blank targets when unreliable) is snapshotted **before** the just-logged result is incorporated; the actual sets are recorded separately in `Log_Cleaned` as always (rule 7). No performed value ever writes or revises this row.

---

## 5. Lifecycle states

**Session:** `proposed → accepted → in_progress → closed` (closed = `finalized` | `abandoned`, from the existing `CLOSEOUT_STATUSES`).

**Plan item** (unchanged from `ITEM_OUTCOMES`): `planned → { completed | skipped | substituted }`. Identity is `plan_item_id` only (existing `planOutcome.js` contract; F10 routes *every* completion surface through it).

**Target set** (new, ledger-derived): a set_index is `pending` (no matching logged set yet) or `performed` (a `Log_Cleaned` set matches by `plan_item_id` lineage); orthogonally its target is `reliable` or `no_reliable_target`. A `pending` set at closeout with no logged set is `unperformed`.

**Recommendation:** `accepted(v1) → revised(vN) → effective(current) | superseded`.

---

## 6. Test against the July 16 failure (dips 65 planned, 60 performed)

Plan: **Weighted Dip 65 × 5, 3 sets.** Athlete performs **60**.

1. **Acceptance (F10B).** Ledger v1 — three rows for the dip `plan_item_id`:
   `(pv1, set_index 1, target_set_count 3, target_weight 65, target_reps 5, target_rir R, source accepted, supersedes ∅, confidence reliable)`, and identical rows for `set_index` 2 and 3. **Durably + idempotently checkpointed the moment the plan is accepted** (amendment 2 — a non-blocking sidecar write once production is enabled at F10D; before that, the same path runs as a sandbox dry-run). Session state is a cache rebuilt from this durable ledger on reload.
2. **Performance.** Athlete does 60 → a normal `Log_Cleaned` set (actual truth). **The ledger's 65 is never touched, and this performed value generates NO revision (amendment 1).** `effectiveRecommendation(dip, set 1)` is still 65.
3. **Revision only if Atlas EXPLICITLY recommends it (amendments 1 + 2).** *Only* if Atlas explicitly issues "let's stay at 60 for the remaining sets" does it append v2 rows for `set_index` 2 and 3 (`target_weight 60`, `source live_revision`, `supersedes` = the v1 set-2/set-3 keys), **durably checkpointed at the moment Atlas issues it.** **No v2 row for set_index 1** (already performed) → set 1 stays 65. Absent an explicit Atlas recommendation, the effective plan for sets 2–3 also stays **65**.
4. **Selector.** `effectiveRecommendation(dip, set 1) → 65` (frozen). If Atlas revised: `set 2 → 60`; else `set 2 → 65`. The chain validates as clean `v1→v2` before selecting.
5. **Assessment (F10E).** Set 1: effective target **65** vs actual **60** → *"used less load — planned 65, did 60."* **Both truths retained.** Atlas never says the plan was 60, never rewrites 65 → 60, and (per F09J) never calls it "under/missed target" if there were no stored plan — but here there **is** a stored plan, so plan-aware wording is now truthful.
6. **Durability.** Because v1 (and any explicit revision) was checkpointed at creation, a reload / crash / auth-loss / rejected-closeout mid-session loses nothing: the ledger is reconstructed from the durable rows, not from volatile session state.

This is exactly the failure the ledger exists to prevent.

---

## 7. Migration & backward-compatibility

- **Additive, optional tab.** `Session_Plan_Sets` is registered in `config/columns.js` + `config/sheetContract.js` as **optional** (like `Modality_Log`/`Constraints`). The write route returns **503 until the owner creates the tab** — so nothing breaks before the schema exists, and the tab creation is the single **owner-reserved** production action.
- **Zero migration on existing tabs.** `Session_Plans`, `Log_Cleaned`, `Effort` are untouched. Existing `Session_Plans` `plan_item_id` semantics remain authoritative.
- **Forward-only.** New columns are only ever appended at the end; historical rows never reflow (same rule as `Bug_Reports`/`Flight_Recorder`).
- **Legacy sessions.** No `Session_Plan_Sets` rows → readers treat the session as **no stored plan**: F10E gives benchmark/trend wording only, never fabricates or backfills a plan (per F09J + F10E rules).
- **Durable checkpoint at creation, not deferred to closeout (amendment 2).** Each accepted plan (v1) and each explicit revision is written to `Session_Plan_Sets` **when created**, via a **non-blocking, idempotent sidecar write** — the exact pattern the existing `Session_Plans` item-event capture already uses (a failed POST never blocks the workout; retries reuse the deterministic `idempotency_key`; last-wins fold). So the ledger survives reload / crash / auth-loss / rejected-closeout by reconstruction from the durable rows; session state is only a cache. Closeout (F10D) **seals** the records (stamps `closeout_write_id`, writes the actuals + `session_closeout`) — it is never the ledger's first persistence.
- **Dry-run first, live writes owner-gated at F10D.** All code, contracts, fixtures, and the creation-time checkpoint path build and merge against a **test/sandbox** tab name (env-overridable, as `SESSION_PLANS_TAB` already is) returning `sheet_written:false`/`no_write_confirmed:true`. The production tab creation and the flag that enables the live creation-time + closeout writes are the single **owner-reserved** action at F10D.

---

## 8. How F10A–F10E divide into focused PRs

Each is one concern; none forces a production schema change until F10D, and even then only with owner authorization.

- **F10A — contract + validating selector + durable-checkpoint path (dry-run).**
  `config/columns.js` `sessionPlanSetsColumns` + `config/sheetContract.js` optional-tab entry; a pure `services/sessionPlanLedger.js` (build v1 rows from an accepted plan, build an *explicit* revision row, the **chain-validating** `effectiveRecommendation`/`effectivePlan`/`planHistory` fold that fails closed to `no_reliable_target` on malformed history, deterministic `idempotency_key`); the **idempotent creation-time checkpoint** capture path (dry-run against the sandbox tab, `sheet_written:false`/`no_write_confirmed:true`); fixtures incl. the July 16 dips case and malformed-chain cases (duplicate/fork/missing-supersedes/cross-ref). **This design doc is F10A's contract half.**
- **F10B — capture accepted plan + explicit revisions, durably checkpointed at creation.**
  On acceptance, build ledger v1 (every planned set, ordering + `plan_item_id`) and **checkpoint it durably at that moment** (non-blocking sidecar; dry-run until F10D enables live writes). Mid-session: an *explicit* substitution/pivot forms a new recommendation *before* the substitute's work is evaluated; an *explicit* post-set Atlas recommendation appends a future-only revision (a performed value **never** does — amendment 1); a user change becomes a recommendation only when Atlas endorses it — each checkpointed at creation. Session state is a cache reconstructed from the durable ledger on reload/resume; nothing depends on volatile state surviving.
- **F10C — independent recommendation for an unannounced exercise.**
  Snapshot history + current-session context **before** incorporating the just-logged exercise; call the deterministic engine as if asked; record an `implicit_unplanned` ledger addition (**`target_set_count = 1`**, exact scalars only); record the actual separately; leakage tests prove changing the submitted result never changes its own derived target; insufficient/ambiguous/range-only history → `no_reliable_target`, no row. **Governed by the owner-binding 7-point contract in §4A (Dale, 2026-07-18).**
- **F10D — confirm, seal, and write actuals together (owner-gated production enablement).**
  Extend the **existing** closeout (no second workflow). One confirmation shows the final effective plan (the already-durable ledger), actual sets, substitutions/pivots, skipped/replaced work, target-vs-actual diffs, and no-reliable-target items; one owner approval writes `Log_Cleaned`/`Effort` and **seals** the ledger rows (stamps the shared `closeout_write_id` + `session_closeout`) — closeout is the seal, **not** the ledger's first persistence (amendment 2). Exact proof; idempotent retries; a ledger seal/write failure never yields a false "verified closeout." **The production `Session_Plan_Sets` tab creation and the flag enabling live creation-time + closeout writes are the owner-reserved gate — the one place the campaign stops for Dale.**
- **F10E — plan-aware historical assessment.**
  Deterministic planned-vs-actual using stored effective prescriptions; each actual set compared only to the recommendation effective for **that** set; replaced/skipped follow plan-outcome semantics; PRs from actual only; legacy sessions get benchmark/trend only; update challenge/reassure/progress wording to plan-aware where a stored plan exists (completing the F09J truthfulness arc).

**F10 (completion identity)** is the prerequisite already queued ahead of this ledger: it routes every completion surface (recap, next-up, pin, handoff, closeout, Workout Sheet, and `computePlanState`'s name-matching) through one `plan_item_id`-based selector, so the ledger's `plan_item_id` join is trustworthy and duplicate-name slots stay distinct.

---

## 9. Approval record

**Approved by Dale (2026-07-17) with three amendments** (folded into this contract; see §10):

1. ✅ Companion `Session_Plan_Sets` tab (over extending `Session_Plans`).
2. ✅ The 16-column schema (§2).
3. ✅ Immutable accepted targets + append-only revisions; frozen targets for performed sets (§4/§2).
4. ✅ F10 → F10A–F10E sequencing (§8).
5. ✅ Production tab creation + production-write enablement remain owner-gated at F10D.

Implementation proceeds autonomously through **F10** and **F10A–F10C** (building/merging against a sandbox tab); it **stops** only at the F10D production-tab/write gate.

---

## 10. Amendment changelog (Dale, 2026-07-17)

- **A1 — No automatic revision from a performed value.** §0 amendments, §4 ("A revision is only ever created by an EXPLICIT Atlas recommendation"), §6 steps 2–3. A performed set changes nothing in the ledger; a revision exists only because Atlas explicitly issued a new recommendation for a not-yet-performed set.
- **A2 — Durable idempotent checkpoint at creation (session state is insufficient).** §0 amendments, §2 (`closeout_write_id` = seal, not first write), §6 steps 1/3/6, §7 (durable-checkpoint bullet), §8 (F10A/F10B/F10D). Each accepted plan and explicit revision is durably checkpointed when created (non-blocking sidecar, dry-run until F10D enables live writes), surviving reload/crash/auth-loss/rejected-closeout. Closeout seals, never first-persists. *(This supersedes the original proposal's "deferred persistence — ledger in session state until closeout"; that model was rejected as insufficiently durable.)*
- **A3 — `effectiveRecommendation()` validates the chain and fails closed.** §0 amendments, §3 ("Chain validation — fail closed, never guess"), §8 (F10A fixtures include malformed-chain cases). Duplicate versions, forks, missing/mismatched `supersedes_key`, cross-session/item/set references, and non-contiguous versions return `no_reliable_target` with diagnostics rather than silently selecting the max version.

## Amendment changelog (Dale, 2026-07-18)

- **A4 — The `implicit_unplanned` recommendation for an unannounced exercise (F10C contract).** New §4A; refines §8 (F10C). When the athlete logs an unannounced exercise, Atlas derives an independent recommendation for **one** next set (`target_set_count = 1`) from **pre-session** history only (current session excluded — the leakage guarantee), and records an `implicit_unplanned` row **only** when an exact `target_weight`, `target_reps`, **and** `target_rir` are all derivable; rep/RIR ranges are never collapsed to scalars; absent/incomplete/ambiguous/range-only evidence returns `no_reliable_target` and appends no row. The performed value never becomes the recommendation — a later target requires an explicit future-set revision. The seven binding rules are enumerated verbatim in §4A.
