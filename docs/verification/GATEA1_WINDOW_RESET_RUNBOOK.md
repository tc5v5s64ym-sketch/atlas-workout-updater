# PR-GATEA1 — Owner runbook: deploy provenance & reset the GATE-A evidence window

> **Status:** Owner runbook (post-merge). One-time, then the fresh window collects on its own.
> **Why:** the pre-GATEA1 One-Brain shadow window is contaminated — genuine athlete activity is mixed with automated probes, simulations, canaries, Playwright, and repeated smoke traffic, and only ~1 confirmed real logged workout occurred during it. The Brain's numbers passed tolerance (852/852 comparable progression decisions in band, zero errors), so the blocker is **evidence provenance, not engine quality**. PR-GATEA1 makes every future shadow event deterministically classifiable (`athlete_ui` / `synthetic` / `unknown`) and eligible-or-not, failing closed. This runbook deploys it and starts a clean, countable window.
> **Scope:** all steps are owner actions on Render / the Google workbook. **This PR changed no production Sheets and no Render config** — those are done here, by hand, after merge. No training-data tab (`Log_Cleaned` / `Effort` / `Constraints` / `Session_Plans`) is touched at any step.

---

## What the code change already did (merged in PR-GATEA1)

- New `services/evidenceProvenance.js` — the deterministic classifier + fail-closed rules.
- `Brain_Shadow` rows gained three appended columns (16 → 19): `evidence_class`, `evidence_eligible`, `request_origin`.
- `Intent_Shadow` rows gained the same three appended columns (13 → 16), after the two review columns.
- The real UI marks its requests (`x-atlas-request-origin: athlete_ui`, unconditional in `src/app/api.js`; on the intent-observe POST body). Smoke traffic marks itself `smoke`; the sim harness's existing `x-atlas-simulation` header is reused; a non-production runtime is synthetic by construction.
- Old rows (written before this deploy) have no provenance columns and read back as `evidence_class = unknown` → never eligible.

**A row counts toward the GATE-A 50-event floor only when `evidence_eligible = TRUE` and `evidence_class = athlete_ui`.**

---

## Steps

### 1. Deploy the new provenance fields
Merge PR-GATEA1 and let Render deploy `main`. Confirm the running shell is **v128** (Settings → "Running shell: v128"). No env-var change is required for classification itself; provenance is computed on every hybrid/brian orchestration and every intent-observe.

> Note: `ATLAS_BRAIN_SHADOW_PERSIST=1` and `ATLAS_INTENT_ROUTER=shadow` must already be on for durable rows to be written at all (unchanged by this PR). If they are on (they are, per the live window), no change is needed.

### 2. Append the new headers to the optional diagnostic tabs (safe, additive)
On the Google workbook, add the three header cells to the END of each tab's header row — **do not reorder or rename any existing column**:

- **`Brain_Shadow`** — after `app_version` (col P), add: `evidence_class` (Q), `evidence_eligible` (R), `request_origin` (S).
- **`Intent_Shadow`** — after `review_notes` (col M), add: `evidence_class` (N), `evidence_eligible` (O), `request_origin` (P).

These are append-only; the recorder already writes the extra cells, and the tabs are not positionally header-validated. If you skip this step nothing breaks — the appended cells simply land in unlabeled columns — but labeling them makes the review legible.

### 3. Archive the contaminated windows (keep as engineering evidence — do NOT delete)
The existing rows must remain readable as engineering evidence but must never count toward promotion. Preserve them, then start fresh:

- Duplicate the `Brain_Shadow` tab to **`Brain_Shadow_Archive_preGATEA1`** (right-click tab → Duplicate; rename). Do the same for `Intent_Shadow` → **`Intent_Shadow_Archive_preGATEA1`**.
- In the live `Brain_Shadow` / `Intent_Shadow` tabs, clear the data rows **below the header** (select row 2 to the last row → delete rows), leaving the header (with the new columns from step 2) in place.
- The archived tabs are optional/diagnostic; they are not read by the app and never counted (all their rows are pre-GATEA1 → `unknown`). Keeping them is for your own audit of the earlier window.

### 4. Start a fresh eligible evidence window
From now on, every orchestration is classified. Train normally. Per `docs/ONE_BRAIN_PROMOTION_CRITERIA.md` §3, the window needs **≥50 eligible (`athlete_ui`) events with variety** — multiple sessions, upper + lower lifts, in-workout and planning-time, the scenario spread. Only `evidence_eligible = TRUE` rows count; probes/sims/smoke/canary rows will accumulate as `synthetic`/`unknown` and are ignored.

### 5. Verify one genuine app action records `athlete_ui` / eligible
From the **real app** (not a script, not a direct API call), trigger a coach-engine recommendation — e.g. open a session so `/api/plan/today` runs, or ask for a lift recommendation. Then open `Brain_Shadow`: the new row must show `evidence_class = athlete_ui` and `evidence_eligible = TRUE`, `request_origin = athlete_ui`. (For Intent_Shadow, type a message in the composer and check its row.) If it shows `unknown`, the request did not carry the `x-atlas-request-origin` marker — confirm the shell is v128 and the browser fetched the new bundle (hard-refresh / reinstall the PWA).

### 6. Verify one test-mode / synthetic request records `synthetic` / ineligible
Run the production smoke script (`node scripts/smoke-test-render.js`, or a canary) against production. Its `/api/recommend/next/*` rows must show `evidence_class = synthetic`, `evidence_eligible = FALSE`, `request_origin = smoke` (a sim-harness run shows `request_origin = sim`). This proves synthetic traffic is excluded from the floor.

### 7. Confirm no training-sheet or athlete-visible behavior changed
- `Log_Cleaned`, `Effort`, `Constraints`, `Session_Plans` are byte-unchanged — PR-GATEA1 writes only the two diagnostic tabs.
- The served coach responses are byte-identical (classification is telemetry-only, test-pinned). No preview→approve→write, proof-field, undo, or parser behavior changed.
- Spot-check: a normal set logs and saves exactly as before; the coach's numbers are unchanged.

---

## After the window fills

When the fresh window has **≥50 eligible `athlete_ui` events** with the required variety, run the GATE-A §5 review (`docs/ONE_BRAIN_PROMOTION_CRITERIA.md`) on the eligible rows only. Reading the eligible-only scorecard from the tab is the job of **PR-GATEA2** (a read-only report generator — not built here). If progression clearly clears every §5 bar on the eligible window, promotion of **progression only** proceeds to PR-A5. `workout` stays behind its serve rail (its block-level divergence metric is unbuilt); intent routing is a separate promotion.

**Nothing in this runbook lowers a GATE-A bar. It only makes the 50-event floor countable by excluding traffic that was never a real athlete.**
