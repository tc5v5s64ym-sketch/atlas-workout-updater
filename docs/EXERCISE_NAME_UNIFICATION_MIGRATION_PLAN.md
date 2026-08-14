# Exercise name / lift-code unification — migration plan (PLANNING ONLY)

**Status:** Planning / audit. **No code, behavior, write-path, sheet, or data change ships with this document.**
**Author:** Claude Code · **Owner:** Dale · **Depends on:** PR-06 (truth audit + allowlist), PR-14 (parser aliases → data), PR-15 (`--sync-sheet` dry-run).

This document scopes the parser ↔ enrichment ↔ catalog **name unification** deferred by PR-14 and PR-15. It exists so the *next* implementation PR can be **approved or rejected on evidence**. Nothing here is implemented; every step that would change a written value, a name, or the sheet is explicitly gated on owner approval.

> **The one-line summary:** history and every analytic join on **`lift_code`**, not on the display name. So if `lift_code` is treated as immutable, name unification becomes mostly a *display/label* change with a bounded, testable blast radius — **except** the handful of residuals that are genuine product decisions (which lift is which) or that would change `Log_Cleaned` columns 3/4 for future rows.

---

## 0. Hard constraints honored by this PR

- No parser behavior change. No enrichment behavior change. No `Log_Cleaned` write change.
- No sheet sync. No catalog canonical rename. No data migration. No owner-visible behavior change.
- Docs/audit only. (Historical note: the former Sheets reconciliation command was retired by the S4 owner correction. Current catalog maintenance uses the Supabase-only `npm run atlas:catalog` command.)

---

## 1. Current-state map

### 1.1 The five name sources (the "truth audit" A/B/C/D + the sheet)

| Src | What it is | Where it lives | Owns which written value |
|---|---|---|---|
| **A — Parser** | The lifter-facing canonical the parser resolves an alias to | `data/parser_aliases.v1.json` (PR-14) | **`Log_Cleaned` col 3 `Exercise`** (see 1.3) |
| **B — Catalog JSON** | The reconciled roster source of truth | `data/exercise_catalog.v1.json` (`name`, `exercise_id`, `primary_muscles`) | Nothing on the write path today (read models / coaching) |
| **C — Coaching JSON** | Per-exercise coaching config | `config/coaching/exercises/*.json` | Coaching engine only |
| **D — Enrichment/Sheet** | The name the write-path lookup resolves to | `Exercise_Catalog` sheet (`Canonical_Name`), via `services/exerciseEnrichment.js` | **`Log_Cleaned` col 4 `Canonical_Exercise`**, col 5 `Lift Code`, col 5 `Muscle_Group` |
| **Sheet** | The live `Exercise_Catalog` tab | Google Sheet | `Canonical_Name \| Muscle_Group \| Lift_Code \| Original_Variants` (`docs/SHEET_CONTRACT.md`) |

PR-06 reconciled **B ↔ C** to zero conflicts. The residual drift is **A vs B** (parser) and **D vs B** (enrichment/sheet) — the 32 entries in `docs/verification/EXERCISE_TRUTH_ALLOWLIST.json`.

### 1.2 `Log_Cleaned` 12-column contract (unchanged)

```
date_clean | session_id | exercise | canonical_exercise | muscle_group | lift_code | set_number | weight | reps | rir | notes | volume_calc
```

### 1.3 How the two name columns are populated (verified)

- **Col 3 `Exercise`** = `rowObj.exercise`, preserved verbatim by `enrichLogRow` (`{ ...rowObj, canonical_exercise: … }`). The client sends the **parser canonical** (`canonical_name`) here → **col 3 = source A**.
- **Col 4 `Canonical_Exercise`** = `enrichLogRow` output, resolved from the **sheet** `Exercise_Catalog` via `buildExerciseCatalogMap` → **col 4 = source D**.
- **Col 5 `Lift Code`** = `resolveOrGenerateLiftCode`: sheet code → row-supplied code → `knownLiftCodeOverrides` → generated (`generateLiftCode`).
- **Col 5 `Muscle_Group`** = the sheet row's `Muscle_Group` (or `Unknown`).

**Consequence:** a rename of A changes future col 3; a rename of D (sheet `Canonical_Name`) changes future col 4. `lift_code` (col 5) is independent of the display name and is the stable identity.

### 1.4 How reads/analytics group (verified — the linchpin)

`services/analytics.js` groups by **`lift_code`** (`best[row.lift_code]`, `row[5]`) for progression, PRs, stalls, volume, benchmarks. `services/liveIntelligence.js` `cleanLogForLift` uses `canonicalLiftCodeFor` to fold **name variants to one code** at read time. So:

- **History continuity depends on `lift_code`, not the display string.** Keep the code stable → history stays joined across a rename.
- The display name matters for: UI/history *labels*, any name-keyed matching (e.g. plan-completion name match, the parser's own `exercise → catalog entry` lookup), and the exact strings a test asserts.

### 1.5 Lift-code inventory (deterministic overrides, `knownLiftCodeOverrides`)

`bench/bench press/flat bench/barbell bench press → BEN01` · `back squat/squat → SQ01` · `deadlift → DL01` · `romanian deadlift/rdl → RDL01` · `elliptical → ELL01` · `seated row(s) → ROW01` · `lat pull(s)/lat pulldown(s) → LAT01` · `dip(s)/weighted dip(s) → DIP01` · `face pull(s) → FP01` · `lateral raise(s)/laterals → LRA01` · `hammer curl(s)/hammers → HC01` · `bicep/biceps curl(s)/curl(s) → BC01` · `knee raise(s) → KR01`. Everything else is sheet-supplied or generated (3-letter initialism + `01`, uniquified per batch).

### 1.6 The JSON catalog carries neither `lift_code` nor `Muscle_Group`

`data/exercise_catalog.v1.json` fields: `exercise_id, name, category, exercise_type, movement_pattern, primary_muscles[], secondary_muscles[], equipment[], difficulty, fatigue_score, skill_score, substitution_group, is_unilateral, is_bodyweight, is_machine, atlas_tags[]`. **No `lift_code`. No `muscle_group`.** `exercise_id` (`barbell_bench_press`) is a *distinct namespace* from `lift_code` (`BEN01`) — confirmed in `services/exerciseResolver.js` / `services/exerciseKbSchema.js`. This is why an enrichment inversion needs two bridges (§3, §4) built first.

---

## 2. Divergence table (all 32 allowlisted residuals)

Legend — **A** parser (col 3), **B** catalog JSON, **C** coaching JSON, **D** enrichment/sheet (col 4). **LC** = `lift_code` (stable join key). **Log?** = would unifying to the proposed name change a `Log_Cleaned` *future write* (col 3 if A moves, col 4 if D moves)? History rows keep old strings but re-join by LC. **Risk**: L(ow, lift-code-joined display change) / M(edium, name-keyed logic) / **OWNER** (genuine "which exercise is this" decision — do not auto-resolve).

| # | alias | A (parser) | B (catalog) | D (enrich/sheet) | LC | Log? | Proposed final canonical | Risk |
|---|---|---|---|---|---|---|---|---|
| 1 | barbell shrugs | Shrug | Barbell Shrug | — | (gen) | col3 | **OWNER**: keep generic `Shrug` or split by implement | OWNER |
| 2 | db shrugs | Shrug | Dumbbell Shrug | — | (gen) | col3 | **OWNER** (same shrug decision) | OWNER |
| 3 | dumbbell shrugs | Shrug | Dumbbell Shrug | — | (gen) | col3 | **OWNER** (same) | OWNER |
| 4 | cable row | Seated Row | Cable Row | Cable Row | ROW01 | col3 | **OWNER**: `Seated Row` vs `Cable Row` (same movement, LC ROW01) | OWNER |
| 5 | seated row | Seated Row | Cable Row | — | ROW01 | col3 | **OWNER** (same) | OWNER |
| 6 | seated rows | Seated Row | Cable Row | — | ROW01 | col3 | **OWNER** (same) | OWNER |
| 7 | machine row | Seated Row | Seated Machine Row | — | ROW01 | col3 | **OWNER**: is "machine row" its own lift or an alias of ROW01? | OWNER |
| 8 | deadlift | Deadlift | Conventional Deadlift | — | DL01 | col3 | `Conventional Deadlift` (B); keep DL01 | L |
| 9 | dl | Deadlift | Conventional Deadlift | Deadlift | DL01 | col3+4 | `Conventional Deadlift`; keep DL01 | L |
| 10 | rdl | RDL | Romanian Deadlift | Romanian Deadlift | RDL01 | col3 | `Romanian Deadlift` (B=D already); keep RDL01 | L |
| 11 | rdls | RDL | Romanian Deadlift | — | RDL01 | col3 | `Romanian Deadlift`; keep RDL01 | L |
| 12 | romanian deadlift | RDL | Romanian Deadlift | — | RDL01 | col3 | `Romanian Deadlift` | L |
| 13 | romanian deadlifts | RDL | Romanian Deadlift | — | RDL01 | col3 | `Romanian Deadlift` | L |
| 14 | sldl | — | Romanian Deadlift | Stiff Leg Deadlift | (gen) | col4 | **OWNER + likely CATALOG FIX**: catalog maps `sldl`→`Romanian Deadlift`, but SLDL ≠ RDL. Decide the real lift. | OWNER |
| 15 | dip | Dips (Weighted) | Dip | Dip | DIP01 | col3 | **OWNER**: `Dip` vs `Dips (Weighted)` — and weighted-vs-bodyweight is a real distinction (see `Dips`→`Dips` relabel in parser). Keep DIP01. | OWNER |
| 16 | dips | Dips (Weighted) | Dips | Dips Weighted | DIP01 | col3+4 | **OWNER** (same dip decision; 3 different strings today) | OWNER |
| 17 | weighted dips | Dips (Weighted) | Weighted Dip | — | DIP01 | col3 | **OWNER** (same) | OWNER |
| 18 | lateral raise | Lateral Raises | Lateral Raise | — | LRA01 | col3 | `Lateral Raise` (B, singular); keep LRA01 | L |
| 19 | lateral raises | Lateral Raises | Lateral Raise | — | LRA01 | col3 | `Lateral Raise`; keep LRA01 | L |
| 20 | laterals | Lateral Raises | Lateral Raise | Lateral Raises | LRA01 | col3+4 | `Lateral Raise`; keep LRA01 | L |
| 21 | side raises | Lateral Raises | Lateral Raise | — | LRA01 | col3 | `Lateral Raise` | L |
| 22 | hammers | Hammer Curl | Hammer Curl | Hammer Curls | HC01 | col4 | `Hammer Curl` (A=B; fix D plural); keep HC01 | L |
| 23 | hanging knee raises | Hanging Knee Raises | Hanging Leg Raise | — | KR01 | col3 | **OWNER**: knee-raise vs leg-raise is a different ROM; may be two lifts | OWNER |
| 24 | hkr | — | Hanging Leg Raise | Hanging Knee Raises | KR01 | col4 | **OWNER** (same knee/leg decision) | OWNER |
| 25 | incline db bench | Incline DB Press | Incline Dumbbell Bench Press | — | (gen) | col3 | `Incline Dumbbell Bench Press` (B) or a shorter agreed form | M |
| 26 | incline db press | Incline DB Press | Incline Dumbbell Bench Press | — | (gen) | col3 | (same) | M |
| 27 | incline dumbbell press | Incline DB Press | Incline Dumbbell Bench Press | — | (gen) | col3 | (same) | M |
| 28 | decline bench | Decline Bench Press | Barbell Decline Bench Press | — | (gen) | col3 | `Barbell Decline Bench Press` (B) | L |
| 29 | decline bench press | Decline Bench Press | Barbell Decline Bench Press | — | (gen) | col3 | (same) | L |
| 30 | cgbp | — | Barbell Close-Grip Bench Press | Close Grip Bench Press | (gen) | col4 | `Barbell Close-Grip Bench Press` (B) | L |
| 31 | tricep pushdown | Cable Tricep Pushdown | Tricep Pushdown | Tricep Pushdown | (gen) | col3 | **OWNER**: `Cable Tricep Pushdown` (A, more specific) vs `Tricep Pushdown` (B) | OWNER |
| 32 | tricep pushdowns | Cable Tricep Pushdown | Tricep Pushdown | — | (gen) | col3 | **OWNER** (same) | OWNER |

**Tally:** ~14 low-risk (plural/singular, verbose-form, D-plural fixes — display-only if LC held), a few medium (name-keyed lookups), and **~14 genuine OWNER decisions** across 6 lift families (Shrug, Row, Dip, Lateral, Hanging-knee/leg, Tricep-pushdown) + 2 likely catalog errors (`sldl`→RDL, the machine-row identity).

**Nothing in this table is decided here.** The "Proposed final canonical" column is a *starting recommendation* (default to catalog B where it's an obvious form change; flag OWNER where it's a product decision).

---

## 3. Muscle-group bridge proposal (do NOT apply)

The JSON catalog has **`primary_muscles[]`** in a **17-value fine taxonomy** (`abs, biceps, calves, chest, forearms, front_delts, glutes, hamstrings, lats, lower_back, obliques, quads, rear_delts, side_delts, traps, triceps, upper_back`). The sheet `Muscle_Group` uses **granular human labels** (`Chest, Biceps, Posterior Chain, Quads, Arms, …`). No mapping exists.

**Proposed bridge** (a pure data table `data/muscle_group_bridge.v1.json`, built and tested but **not wired**):

```
primary_muscles[0]  →  Muscle_Group label
chest               →  Chest
front_delts / side_delts / rear_delts → Shoulders   (or keep delt-specific — OWNER)
biceps / triceps / forearms → Arms
lats / upper_back   →  Back
lower_back / hamstrings / glutes → Posterior Chain    (matches the sheet's "Posterior Chain")
quads / calves      →  Legs (or Quads / Calves — OWNER)
abs / obliques      →  Core
traps               →  Back (or Traps — OWNER)
```

**Calibration requirement before it can ever be used:** dump the *current* distinct `Muscle_Group` values from the live sheet and the enrichment output, then define the map so **every currently-written value is reproduced** for the lifts in Dale's history. The bridge is only safe once "map(catalog primary_muscles) == current sheet Muscle_Group" for all in-use lifts. Until then it is a proposal only. **Muscle_Group is the highest-drift-risk field** — it is the reason the enrichment inversion cannot be a mechanical flip.

---

## 4. Lift-code bridge proposal (do NOT apply)

`exercise_id` (JSON, `barbell_bench_press`) and `lift_code` (`BEN01`) are **separate namespaces**. To ever source `lift_code` from the JSON we need an explicit, owner-reviewed bridge:

**Proposed bridge** (a pure data table `data/lift_code_bridge.v1.json`: `exercise_id → lift_code`), built by joining three known-good sources and **freezing** the result:
1. `knownLiftCodeOverrides` (§1.5) — the deterministic name→code map.
2. The live `Exercise_Catalog` sheet's `Canonical_Name → Lift_Code` (the authoritative in-use codes).
3. The historical `Log_Cleaned` `canonical_exercise → lift_code` pairs actually present in Dale's data (so no in-use code is missed).

**Immutability rule:** every `lift_code` already present in historical logged sets is frozen — the bridge may add new `exercise_id → code` links but must never remap an existing code, or it splits history. Under S4, codes without an `exercise_id` counterpart remain Supabase catalog data; none are Sheets-owned.

---

## 5. Catalog maintenance (superseded by S4)

This plan originally used a Sheets reconciliation command. That command and the Sheets editing authority were retired by the 2026-08-13 owner correction. Supabase is now the sole live `Exercise_Catalog` authority. The owner-controlled replacement is dry-run by default:

```
npm run atlas:catalog -- --file rows.json
npm run atlas:catalog -- --file rows.json --apply
```

Do not recreate a Sheets sync, freshness clock, or fallback from this historical plan.

**What sync would change in `Exercise_Catalog`:** only additions/label reconciliations the owner approves row-by-row — it is never automated. The catalog-canonical rename (renaming `Canonical_Name` cells) is what moves source **D** and therefore col 4 of future writes; it is owner-gated and belongs to §6 PR-D.

**This planning PR runs nothing against the sheet.**

---

## 6. Migration plan — the safe PR sequence

Each PR is independently revertible and ordered so that no behavior changes until the bridges + tests exist. **PR-0 is this document.**

| PR | Title | Changes behavior? | Gate |
|---|---|---|---|
| **A** | **Mapping data only** — add `data/muscle_group_bridge.v1.json` + `data/lift_code_bridge.v1.json` (§3, §4) as **unwired** data, with a calibration test asserting each reproduces every *currently-written* value for in-use lifts. | No (data + tests only; nothing imports them) | Reviewable now; approve the *bridges* before anything reads them |
| **B** | **Lift-code bridge read path** — teach enrichment/`canonicalLiftCodeFor` to consult the frozen `lift_code_bridge` as an *additional* resolver, proven to return the **identical** code for every existing name (shadow-parity test). Still no name change. | No (same codes out; wider coverage) | Bridge frozen + parity green |
| **C** | **Enrichment inversion behind a flag** — `exerciseEnrichment` resolves `canonical_exercise` + `muscle_group` from the JSON catalog + bridges, gated by `ATLAS_ENRICH_SOURCE=json` (default `sheet`). Under the flag, output must be **byte-identical** to today for the calibration corpus; drift is a test failure, not a silent write. | No by default; flag is off | Calibration + shadow-parity green under both modes |
| **D** | **Catalog reconciliation (superseded)** — the former owner-run Sheets sync no longer exists. Any future catalog change must target Supabase through the bounded owner command. | **Yes** | **OWNER** — current S4 authority rules apply |
| **E** | **Parser/catalog canonical unification** — regenerate the parser's canonicals from the catalog (moves source A / col 3 of future writes), for the residuals the owner accepted in §2. Golden corpus updated to the new canonicals; `EXERCISE_TRUTH_ALLOWLIST` shrinks. | **Yes (future col 3)** | **OWNER** — per-family decisions from §2 |
| **F** | **`Log_Cleaned` history migration (optional)** — only if the owner wants *historical* rows relabeled to the unified names (display consistency). A read-time relabel (safer) or a one-time backfill (irreversible). Analytics already join by `lift_code`, so this is **cosmetic**, not correctness. | **Yes (history)** | **OWNER** — destructive/irreversible; §8 |

**Recommended stopping point without further owner input:** PR-A (and optionally PR-B) — pure data + read-path parity, zero behavior change — leaving C/D/E/F for explicit approval.

---

## 7. Test plan (must exist before any behavior-changing PR)

1. **Bridge calibration (PR-A):** for every lift present in a fixture of Dale's `Log_Cleaned` history, `muscle_group_bridge(catalog.primary_muscles)` == the currently-written `Muscle_Group`, and `lift_code_bridge(exercise_id)` == the currently-written `lift_code`. Any mismatch fails.
2. **Lift-code immutability (PR-A/B):** no `lift_code` already in a `Log_Cleaned` fixture is remapped by the bridge (frozen-set assertion).
3. **Enrichment shadow-parity (PR-C):** run the full enrichment corpus under `sheet` and `json` modes; assert `{canonical_exercise, muscle_group, lift_code}` byte-identical per row. This is the go/no-go gate for the inversion.
4. **Parser golden + parity (PR-E):** the existing `test/parser-golden.test.js` + `test/parserAliasParity.test.js` updated so the new canonicals are the expected output; assert every historical alias still resolves (to the new name) and every `lift_code` is unchanged.
5. **Truth audit (all PRs):** `test/exerciseTruthAudit.test.js` stays green; `EXERCISE_TRUTH_ALLOWLIST` entries are removed only as their residual is genuinely resolved (the test already fails on stale allowlist entries).
6. **Analytics continuity:** a fixture with the OLD name + code and the NEW name + same code must produce ONE merged history in `computeExerciseProgress` / `detectStalls` / PRs (proves the lift-code join survives the rename).
7. **Write-path proof fields unchanged:** `test/trustLoopProof.test.js` + the log-workout dry-run/live tests stay byte-identical in shape.
8. **UI label spot-checks:** history/preview render the new label without breaking the G1/G2/FA interleave family.

---

## 8. Owner decision section — what requires Dale's explicit approval

**Before ANY implementation past PR-A/B:**

1. **The 6 OWNER lift-family decisions (§2)** — pick the single canonical for each, or confirm they are distinct lifts:
   - **Shrug**: one generic `Shrug`, or split `Barbell Shrug` / `Dumbbell Shrug`?
   - **Row**: `Seated Row` vs `Cable Row` (ROW01); is `machine row` the same lift or its own?
   - **Dip**: `Dip` vs `Dips (Weighted)` — and keep the weighted/bodyweight distinction the parser makes today?
   - **Lateral**: adopt singular `Lateral Raise`? (low-stakes)
   - **Hanging knee vs leg raise**: same lift (KR01) or two different movements?
   - **Tricep pushdown**: keep specific `Cable Tricep Pushdown` or generic `Tricep Pushdown`?
2. **Two likely catalog errors** to confirm/fix: `sldl` (Stiff-Leg Deadlift) is mapped to `Romanian Deadlift` in the catalog — SLDL ≠ RDL; and the `machine row` identity.
3. **Muscle-group label set (§3):** approve the coarse target labels (e.g. keep delt-specific `Shoulders` split? `Traps` its own group?) — because this defines what future col 5 `Muscle_Group` values become.
4. **PR-D — sheet catalog rename** (moves future col 4): approve running the owner-side sync and editing `Exercise_Catalog` canonical cells. Sheet edits are hard to unwind.
5. **PR-E — parser canonical rename** (moves future col 3): approve, per family.
6. **PR-F — historical `Log_Cleaned` relabel** (optional, destructive/irreversible): approve only if display consistency in *history* is wanted; correctness does not need it (analytics join by `lift_code`).

**Not owner-gated** (safe to build on PM authority once the above are settled): the mapping-data PR (A), the read-path parity PR (B), and all test scaffolding — none change a written value or a name.

---

## Appendix — provenance

- Divergence data: `docs/verification/EXERCISE_TRUTH_ALLOWLIST.json` (32 entries) + `docs/verification/EXERCISE_TRUTH_AUDIT.md` (regenerated by `test/exerciseTruthAudit.test.js`).
- Column population + grouping: verified in `services/exerciseEnrichment.js`, `services/analytics.js`, `services/liveIntelligence.js`, `config/columns.js`, `index.js` (`logRowObjectToArray`).
- Catalog fields / muscle taxonomy: `data/exercise_catalog.v1.json`, `services/exerciseKbSchema.js`, `services/muscleCoverage.js`.
- Historical Sheet shape and current Supabase catalog maintenance boundary: `docs/SHEET_CONTRACT.md`, `scripts/atlas-catalog-admin.js`.
- Prior scope notes: `BACKLOG.md` → PR-14 / PR-15 entries.
