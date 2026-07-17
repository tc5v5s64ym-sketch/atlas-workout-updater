# Session_Plans Ledger — Design Proposal (F10 / F10A)

**Status: DESIGN-ONLY — awaiting owner approval. No production `Session_Plans` change, no data migration, no application code change is made by this document.** It defines the contract, the proposed schema, the migration/back-compat handling, and how F10A–F10E divide into focused PRs. Implementation stops here until Dale approves; the production tab creation remains an explicit owner-reserved action.

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
| 15 | `closeout_write_id` | The `write_id` of the owner-approved closeout that persisted this row (blank while the ledger is still pending in session state). Ties every written row to one approved closeout. | closeout / write identity |
| 16 | `recorded_at` | ISO timestamp the recommendation was formed (client clock; stamped when written at closeout). | audit / ordering |

**The "effective set boundary"** the card asks for is **encoded, not a separate column**, by `set_index` + `plan_version` + one invariant:

> A revision MUST NOT append a row for a `set_index` that is already performed (has a matching logged set in `Log_Cleaned`). The effective target for a set is the **highest `plan_version` row for that `(plan_item_id, set_index)`**. Because revisions never target an already-performed set, a performed set's target is **frozen** at whatever version was effective when it was performed.

---

## 3. The single selector — `effectiveRecommendation`

One authoritative selector (mirroring the F09F provenance principle: planned, revised, and performed are distinct and never conflated). Pure, DOM-free, testable:

- `effectiveRecommendation(ledgerRows, plan_item_id, set_index) → { target_weight, target_reps, target_rir, plan_version, recommendation_source, confidence } | { confidence: 'no_reliable_target' }`
  Folds the ledger to the **highest-`plan_version` row** for `(plan_item_id, set_index)`. This is the one target every surface reads.
- `effectivePlan(ledgerRows, plan_item_id) → orderedSets[]` — the per-set effective targets (the **final effective plan** for the item), plus the effective `target_set_count`.
- `planHistory(ledgerRows, plan_item_id) → versions[]` — the full original+revised chain, for audit and the F10D closeout diff.

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
   `(pv1, set_index 1, target_set_count 3, target_weight 65, target_reps 5, target_rir R, source accepted, supersedes ∅, confidence reliable)`, and identical rows for `set_index` 2 and 3. Kept in trusted session state (no mid-session Sheet write).
2. **Performance.** Athlete does 60 → a normal `Log_Cleaned` set (actual truth). **The ledger's 65 is never touched.**
3. **Optional revision (F10B).** If Atlas endorses staying at 60 for the remaining sets, it appends v2 rows for `set_index` 2 and 3 (`target_weight 60`, `source live_revision`, `supersedes` = the v1 set-2/set-3 keys). **No v2 row for set_index 1** (already performed) → set 1 stays 65.
4. **Selector.** `effectiveRecommendation(dip, set 1) → 65` (frozen); `set 2 → 60`. `effectivePlan(dip)` = the final effective plan (65, then 60, 60).
5. **Assessment (F10E).** Set 1: effective target **65** vs actual **60** → *"used less load — planned 65, did 60."* **Both truths retained.** Atlas never says the plan was 60, never rewrites 65 → 60, and (per F09J) never calls it "under/missed target" if there were no stored plan — but here there **is** a stored plan, so plan-aware wording is now truthful.

This is exactly the failure the ledger exists to prevent.

---

## 7. Migration & backward-compatibility

- **Additive, optional tab.** `Session_Plan_Sets` is registered in `config/columns.js` + `config/sheetContract.js` as **optional** (like `Modality_Log`/`Constraints`). The write route returns **503 until the owner creates the tab** — so nothing breaks before the schema exists, and the tab creation is the single **owner-reserved** production action.
- **Zero migration on existing tabs.** `Session_Plans`, `Log_Cleaned`, `Effort` are untouched. Existing `Session_Plans` `plan_item_id` semantics remain authoritative.
- **Forward-only.** New columns are only ever appended at the end; historical rows never reflow (same rule as `Bug_Reports`/`Flight_Recorder`).
- **Legacy sessions.** No `Session_Plan_Sets` rows → readers treat the session as **no stored plan**: F10E gives benchmark/trend wording only, never fabricates or backfills a plan (per F09J + F10E rules).
- **Dry-run first.** All code, contracts, fixtures, and dry-run behavior build and merge against a **test/sandbox** tab name (env-overridable, as `SESSION_PLANS_TAB` already is). The real production write is gated at F10D behind owner authorization.

---

## 8. How F10A–F10E divide into focused PRs

Each is one concern; none forces a production schema change until F10D, and even then only with owner authorization.

- **F10A — contract + selector + dry-run (no production write).**
  `config/columns.js` `sessionPlanSetsColumns` + `config/sheetContract.js` optional-tab entry; a pure `services/sessionPlanLedger.js` (build v1 rows from an accepted plan, build a revision row, the `effectiveRecommendation`/`effectivePlan`/`planHistory` fold, deterministic `idempotency_key`); fixtures incl. the July 16 dips case; dry-run capture path returning `sheet_written:false`/`no_write_confirmed:true`. **This design doc is F10A's contract half.**
- **F10B — capture accepted plan + explicit revisions into session state.**
  On acceptance, build ledger v1 (every planned set, ordering + `plan_item_id`). Mid-session: explicit substitution/pivot forms a new recommendation *before* the substitute's work is evaluated; post-set adjustments append future-only revisions; a user change becomes a recommendation only when Atlas endorses it. Held in trusted session state; reload/resume retains it. **No background Sheet write.**
- **F10C — independent recommendation for an unannounced exercise.**
  Snapshot history + current-session context **before** incorporating the just-logged exercise; call the deterministic engine as if asked; record an `implicit_unplanned` ledger addition; record the actual separately; leakage tests prove changing the submitted result never changes its own derived target; insufficient history → `no_reliable_target`.
- **F10D — confirm & write planned-vs-actual together (owner-gated production write).**
  Extend the **existing** closeout (no second workflow). One confirmation shows the final effective plan, actual sets, substitutions/pivots, skipped/replaced work, target-vs-actual diffs, and no-reliable-target items; one owner approval writes `Log_Cleaned`/`Effort` **and** the `Session_Plan_Sets` ledger with the shared `closeout_write_id`; exact proof; idempotent retries; a ledger-write failure never yields a false "verified closeout." **The production tab creation + first real write is the owner-reserved gate.**
- **F10E — plan-aware historical assessment.**
  Deterministic planned-vs-actual using stored effective prescriptions; each actual set compared only to the recommendation effective for **that** set; replaced/skipped follow plan-outcome semantics; PRs from actual only; legacy sessions get benchmark/trend only; update challenge/reassure/progress wording to plan-aware where a stored plan exists (completing the F09J truthfulness arc).

**F10 (completion identity)** is the prerequisite already queued ahead of this ledger: it routes every completion surface (recap, next-up, pin, handoff, closeout, Workout Sheet, and `computePlanState`'s name-matching) through one `plan_item_id`-based selector, so the ledger's `plan_item_id` join is trustworthy and duplicate-name slots stay distinct.

---

## 9. Owner approval checklist

Please confirm, adjust, or reject:

1. **Companion `Session_Plan_Sets` tab** (vs extending `Session_Plans`). *(Recommended: companion tab.)*
2. **The 16-column schema** in §2 (names, order, codes-only, bodyweight `0`).
3. **The revision model** (append + `supersedes_key`, frozen performed sets) in §4/§2.
4. **Deferred persistence** (ledger in session state during the workout; single owner-approved write at closeout).
5. **The F10A–F10E PR division** in §8, and that F10A–F10C build/merge against a sandbox tab with the production tab creation + first real write held at F10D for your explicit authorization.

Nothing is implemented until these are approved.
