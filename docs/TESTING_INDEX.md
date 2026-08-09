# Atlas — Testing Index

> **Purpose:** the one place that catalogues every test/CI/verification system Atlas has, how to run it, and — most importantly — **whether it can touch the real Google Sheet.** A fresh agent or the owner should not have to re-derive this. Current as of 2026-07-21.
>
> This index is a **map, not an authority.** It selects no work and authorizes no writes. Sequencing lives only in [`ATLAS_V1_EXECUTION_PLAN.md`](./ATLAS_V1_EXECUTION_PLAN.md); live-test tiers and production safeguards live in [`AGENT_LIVE_TESTING.md`](./AGENT_LIVE_TESTING.md).

## Write-safety headline (read this first)

- **Exactly one script in the repo can write the production Sheet: `scripts/catalog-maintenance.js`** — and only the `Exercise_Catalog` tab, **dry-run by default**, requiring an explicit `--confirm`.
- **No CI workflow can write a Sheet** — none carries Google write credentials.
- The **simulation harness** can write, but **only to the sandbox sheet** — it fails closed unless the running server confirms the sandbox sheet fingerprint.
- **TEMPORARY (sunset: F-SB4C):** the **F-SB4B rehearsal posture** of the gate server can also write, **only to the sandbox workbook** and only when a launcher explicitly sets `ATLAS_GATE_SANDBOX_LIVE=1` + `ATLAS_GATE_LEDGER_SANDBOX=1` on its own gate-server spawn with real credentials in that environment. `npm run test:e2e` can NEVER reach it: `playwright.config.js` scrubs the flag before any spec worker exists, so an exported flag in the invoking shell is inert for the whole default lane. Details in the Playwright section below.
- Everything else is **offline**, **read-only**, or **`test_mode` dry-run**.
- The structural guarantee: only `sheets.js` holds the read-write scope (`appendRows` / `deleteRowsByRange` / `batchUpdate`). Every read-only tool builds its own `spreadsheets.readonly` client and never imports those helpers.

## Master map

| System | Location | Command | Class | Writes real Sheet? | Status |
|---|---|---|---|---|---|
| Node unit/integration suite (~297 files) | `test/` | `npm test` | Offline | No (Sheets stubbed) | Current |
| Playwright browser E2E (+ F10 gate) | `tests/e2e/`, `tests/e2e/gate/` | `npm run test:e2e` (`:headed`) | Browser E2E (local, API mocked) | No — the config scrubs the temporary F-SB4B live flag, so this command cannot reach a workbook; the posture needs its own explicit launcher (see Playwright section) | Current |
| ~~Phase 4 Stage-A canary~~ (**removed**) | — | — | — | — | **Retired 2026-08-01** at Stage A 5/5 — see §2a |
| Simulation harness | `scripts/sim/` | `node scripts/sim/run.js --base-url <local>` | Local-integration | **Sandbox only** (fails closed) | Current |
| Flight Recorder replay | `test/helpers/flightReplay.js`, `test/fixtures/replays/` | `npm test` | Offline | No | Current (ADD-3 pending #914) |
| Voice corpus + Golden Session | `test/fixtures/voiceCorpusSetC.js`, `test/fixtures/goldenSession.js`, `test/helpers/voiceViolationDetectors.js` | `npm test` | Offline | No | Current |
| Live voice sampler (advisory) | `scripts/voice-validation-live.js` | `node scripts/voice-validation-live.js [--live]` | Offline (model-call w/ `--live`) | No | Current |
| Deployed smoke test | `scripts/smoke-test-render.js` | `npm run smoke:render` | Deployed read-only + dry-run | No | Current |
| Live-retest harness | `scripts/live-retest.js` | `node scripts/live-retest.js --scenario all` | Dry-run / deployed read-only (optional auth via `ATLAS_ACCESS_CODE`) | No | Partial (some scenarios MANUAL; not a gate) |
| `atlas:status` | `scripts/atlas-status.js` | `npm run atlas:status [-- --json]` | Deployed read-only → offline | No | Current |
| `atlas:review-live` | `scripts/atlas-review-live.js` | `npm run atlas:review-live [-- --json]` | Deployed read-only (Sheets) | No | Current |
| `atlas:divergence` | `scripts/atlas-divergence.js` | `npm run atlas:divergence -- <logfile>` | Offline | No | Current |
| `atlas:turn-write-artifact` | `scripts/atlas-turn-write-artifact.js` | `npm run atlas:turn-write-artifact -- <logfile> [--json]` | Offline | No | Current |
| `flight-review` / `gate-a-scorecard` | `scripts/flight-review.js`, `scripts/gate-a-scorecard.js` | `node scripts/flight-review.js` · `node scripts/gate-a-scorecard.js --env=production` | Deployed read-only (Sheets) | No | Current |
| **Supabase schema proof (from-empty Postgres)** | `test-pg/`, `scripts/run-pg-proof.js` | `ATLAS_PG_ADMIN_URL=… npm run test:pg` | Local-integration (real disposable Postgres) | No — never touches Sheets, and structurally cannot reach a hosted Supabase project | Current (PR S2) |
| **P8b hosted Supavisor checkpoint** (owner-run, out of band) | `scripts/atlas-p8b-checkpoint.js` | `npm run atlas:p8b` (`-- --json`), with the four role connection strings in the environment | Owner checkpoint against `Atlas Production` | No — read-only: applies no schema, writes no row, moves no read or write. Needs the owner's four credentials, so it cannot run in CI | Current (owner gate between S2 and S3) |
| **Supabase migration applier** | `scripts/apply-supabase-migrations.js` | `npm run supabase:migrate -- --url <disposable>` | Local-integration | No — refuses a hosted Supabase host and any non-empty target, with no override | Current (PR S2) |
| **Supabase reconciliation sweep / repair / catalog sync** | `scripts/atlas-migration-{sweep,repair}.js`, `scripts/atlas-catalog-sync.js` | `npm run atlas:sweep` · `npm run atlas:repair` · `npm run atlas:catalog-sync` | Deployed read-only (Sheets) + Supabase | No — Sheets is read-only to all three | Current (PR S2, TEMPORARY — sweep and repair are deleted at S4) |
| Drift guards (1–4, 6) | `scripts/check-*.js` | `npm run check:wiring\|authority\|banned\|allowlist\|paper-weight\|ladder` | Offline | No | Current |
| Secret scan | `scripts/check-changed-files-for-secrets.js` | `npm run scan:secrets` | Offline | No | Current |
| Sheets backup | `scripts/export-sheets-backup.js` | `npm run backup:sheets` | Deployed read-only (Sheets → local files) | No | Current |
| Catalog maintenance | `scripts/catalog-maintenance.js` | `node scripts/catalog-maintenance.js --file rows.json [--confirm]` | **Real-write (guarded)** | **Yes — `Exercise_Catalog` only, `--confirm`** | Current |
| CI workflows (7) | `.github/workflows/` | (triggers) | Mixed | No | Current |
| Owner live-test queue + playbook | `docs/TEST_QUEUE.md`, `docs/AGENT_LIVE_TESTING.md`, `docs/MOBILE_TEST_APP.md` | (human) | Via app, owner-gated | Current |

## Detail

### 1. Offline test suite — `npm test`

The bulk of coverage: ~297 `node --test` files under `test/`. Offline — `sheets.js` is stubbed via `require.cache` injection before Express loads (preserve that pattern). A `pretest` runs `npm run build`. No real credentials, cannot touch a live Sheet. Several sub-harnesses run *inside* it:

- **Canonical contract tests** — `athleteContext`, `workoutSession`, `exerciseIdentity`, `safetyDecision`, `interactionTrace`, `closeoutTransaction`, `coachTurnPacket`, plus `contracts-integrity.test.js` (the "one Brain" consistency guard).
- **Flight Recorder replay** — `test/helpers/flightReplay.js` (+ `appSliceHarness.js`, `storeShim.js`) replays recorded gym-session bugs (`test/fixtures/replays/add-1…add-7.json`, auto-discovered by `flightRecorderReplay.test.js`) through the real app.js paths. Add a fixture by trimming a real Flight Recorder export (see `test/fixtures/replays/README.md`). **ADD-3 is intentionally absent** — blocked on Decision-Desk issue #914.
- **Voice / coaching-quality corpus** — `test/fixtures/voiceCorpusSetC.js` (16 ratified "Set C" register scenarios) via `voiceCorpusHarness.test.js`; deterministic wording heuristics in `test/helpers/voiceViolationDetectors.js` (advisory, never a CI gate).
- **The Golden Session** — `test/fixtures/goldenSession.js` scored on *behavior* not wording, driven through the real `/api/coach/message` seam by `soulGoldenTranscripts.test.js`. Phase-1/4 gate + Phase-7 regression.
- **Shadow telemetry** — `interactionTraceShadow*`, `coachTurnPacketShadow*`, `coachTurnDivergence`, `brainShadow*`, `intentShadow*`, `driftShadow`, `evidenceProvenance` (real-vs-synthetic classification).
- **Parser incl. fuzz** — `parserFuzz`, `parser-golden`, `parserSmokeGrammar`, `parserStackedBoundary`, …
- **Write-path / trust-loop safety** — `trustLoopProof`, `idempotency*`, `fullConsumptionGate`, `closeout*`, `api-smoke`, `sheets-adapter*`.
- **Simulation-harness units** — `simulationHarness.test.js`, `simulationServerConfig.test.js` (assert read-only default + refusal to write a non-sandbox sheet).

### 2. Browser E2E — `npm run test:e2e`

Real Chromium + mobile-Chromium (iPhone 13) drives of the built app shell (`tests/e2e/*.spec.js`, ~22 specs) plus the **F10 gate suite** (`tests/e2e/gate/` with its own `gate-server.js`). Config: `playwright.config.js`. Fully local — static server on `127.0.0.1:3107`, service workers blocked, `**/api/**` mocked, so **no real backend and no Sheet write** in the default lane; the config scrubs `ATLAS_GATE_SANDBOX_LIVE` before any spec worker exists, so the temporary F-SB4B write-capable posture (below) is unreachable from `npm run test:e2e` even under a rehearsal-configured shell. `pretest:e2e` builds first. Chromium resolves from the pre-installed browser (`PLAYWRIGHT_BROWSERS_PATH`). Output: Playwright `list` reporter + traces on first retry.

#### 2a. Phase 4 Stage-A runner — **RETIRED 2026-08-01**

This section used to document `npm run atlas:stage-a-canary` and `npm run atlas:stage-a-session`: the one runner that drove a complete synthetic workout through the real browser, the real built client, the real local Express backend, the real production paths, **and the repository-declared sandbox Google Sheet**.

**Both commands are gone, and so is the sandbox-live posture they used.** They were temporary Phase 4 machinery with a sunset recorded in [`ATLAS_V1_EXECUTION_PLAN.md`](ATLAS_V1_EXECUTION_PLAN.md): delete them in the same PR that records Stage A at 5/5. Stage A reached 5/5 on 2026-08-01 and that PR executed the deletion. Nothing regenerates them, and **no command in this repository can now reach a real Google workbook from a test.**

If you came here looking for the command: it does not exist, and it should not be recreated. Its purpose is discharged. The five sessions it proved are recorded in `docs/verification/STAGE_A_SESSION_1..5_2026-08-01.md`, with SHA-256 hashes of each run's evidence; the raw artifacts stay local and git-ignored.

What was **retained**, because it was never Stage-A machinery, is in `npm test`:

- `test/gateHarnessPosture.test.js` — the gate harness serves an in-memory Sheets stub by default (an exported production workbook id is ignored rather than merely rejected), model-up is opt-in and never inferred from a key being present, and a harness that cannot prove its declared posture refuses to start. It also fails if the retired Stage-A files or operator commands reappear, and it permits the temporary F-SB4B live-workbook tokens ONLY while the execution plan records their authorization and F-SB4C sunset.
- **TEMPORARY (sunset: F-SB4C)** — the F-SB4B combined rehearsal posture (`ATLAS_GATE_SANDBOX_LIVE=1` + `ATLAS_GATE_LEDGER_SANDBOX=1`, both required together): the gate server loads the REAL Sheets adapter against the declared sandbox workbook only, behind a call-time guard (append allowlist `Log_Cleaned`/`Effort`/`Session_Plans`/`Session_Plan_Sets`; `ensureSheetTab` and `deleteRowsByRange` always refused; `updateColumnCells` limited to the `Session_Plan_Sets` seal column), a pre-listen sandbox preflight (declared-id, non-production fingerprint, tab presence, exact ledger headers), and a session-id-filtered read-only durable verifier on the harness port. **CAN write to the sandbox workbook; can never reach production** (the ambient `GOOGLE_SHEETS_ID` is never inherited). Safety net: `test/gateHarnessRehearsalPosture.test.js` (offline, fake credentials). Restored from the proven Stage A implementation under the owner resolution recorded in the execution plan (F-SB4B, 2026-08-03).
- `config/sandboxSheet.js` — the single declaration of the sandbox workbook id, consumed by `sheets.js` (`isSandboxSheet`) and `scripts/sim/harness.js` (whether write mode is legal).

The **simulation harness** below and the temporary F-SB4B rehearsal posture above are the only tooling in this catalogue that can write to the sandbox Sheet; each is unreachable without its own explicit multi-signal invocation, and the rehearsal posture leaves at F-SB4C.

### 3. Simulation harness — `scripts/sim/`

A single-user HTTP client that drives a **local** Atlas server through 7 read-only prompt scenarios (`scenarios.json`) and 6 workout session templates (push/pull/legs/upper/full_body/cardio_recovery). Read-only by default; sandbox writes require `--mode write --sandbox --enable-write-scenarios` **and** the server must confirm the sandbox sheet via `/api/debug/config` (refuses the production MASTER sheet). Env: `ATLAS_SIM_BASE_URL`, `ATLAS_API_KEY`, `ATLAS_SIM_SHEET_ID` (or `--sandbox`). Output: JSON + Markdown under `outputs/sim/`. Full instructions: `scripts/sim/README.md`. Tested by `test/simulationHarness.test.js` + `test/simulationServerConfig.test.js`.

> With `ATLAS_INTERACTION_TRACE=shadow` on a local/sandbox server, this harness *generates* `[coach-turn-shadow]` records synthetically — a way to exercise the Phase-3 divergence report without waiting for a week of real sessions.

### 4. Deployed / live checks (read-only or dry-run)

- **`smoke-test-render.js`** — `npm run smoke:render`. Deployed read-only; its only write-shaped call is a `test_mode:'true'` dry-run that *asserts* `no_write_confirmed:true, sheet_written:false`. Env: `ATLAS_BASE_URL`, `ATLAS_API_KEY`, `ATLAS_SMOKE_MODE` (default `full`; `basic` skips the dry-run). Marks itself `x-atlas-request-origin: smoke`. **Cannot write.**
- **`live-retest.js`** — `node scripts/live-retest.js --scenario all [--dry-run-only false]`. Describe-only by default; with `--dry-run-only false` launches Chromium against the deployed app and only ever previews (asserts Save stays disabled). Artifacts in `live-retest-artifacts/`. **Cannot write.** Partially built (some scenarios `MANUAL`); explicitly not a merge gate. Every browser request carries `x-atlas-request-origin: playwright`, so a run is always synthetic traffic and never genuine owner/gym evidence. **Optional authentication:** set `ATLAS_ACCESS_CODE` (environment only — never a CLI flag) and the harness exchanges it for a session cookie through the real `POST /api/session/login` route before loading the app. The credential is never printed, serialized, screenshotted, or written to an artifact, and every logged message is redacted. Absent that variable the run stays unauthenticated and unchanged — an expected reply that needs a session reads `INCONCLUSIVE`, never a false `PASS`. If the credential is supplied but rejected the run **stops** rather than continuing anonymously (exit 1, verdict `ERROR`): it never fails open. **Authenticated-content privacy (the repository is public):** whenever a credential is supplied, the run takes no screenshots, logs no thread/DOM text (lengths and booleans only), persists no `threadExcerpt`, classifies thrown errors without echoing them, and drops an `AUTHENTICATED_RUN` marker that makes the workflow skip artifact upload (fail closed); reports carry an explicit `authenticated_run: true|false` field. Unauthenticated runs keep screenshots/excerpts/artifacts unchanged. **Response-settle:** after clicking preview the harness waits for a genuinely settled reply (the `Thinking…` marker gone and a non-empty response that has stopped growing) rather than a fixed sleep, bounded by a timeout; a response that never settles yields `INCONCLUSIVE` with the exact timeout reason and never a false `PASS` while `Thinking…` remains. Tests: `test/live-retest-auth.test.js`, `test/live-retest-privacy.test.js`, `test/live-retest-settle.test.js`.

### 5. Read-only operational review tools

- **`atlas:status`** — `npm run atlas:status [-- --json]`. Health/campaign status from public `/.well-known/atlas-status.json` (offline local view if no `ATLAS_BASE_URL`). No creds. Never writes.
- **`atlas:review-live`** — `npm run atlas:review-live [-- --json | --session=<id> | --workout-session=<session_id> | --from-dir=<backup>]`. Reviews the newest real owner session (joins Flight_Recorder/Brain_Shadow/Intent_Shadow/Log/Effort/Session_Plans); PASS/FAIL/UNKNOWN per trust criterion. An explicit `--session` / `--workout-session` always wins over auto-selection; the local-date fallback reaches one day either side of the UTC window (so an evening workout correlates) and refuses outright when it cannot name one workout. Reads Sheets read-only (`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, a sheet id). May write a local `outputs/` report only.
- **`atlas:divergence`** — `npm run atlas:divergence -- <logfile>` (or pipe logs on stdin; `--json`). Offline parser of `[coach-turn-shadow]` records → the Phase-4 TODO list. No creds. Never writes.
- **`atlas:turn-write-artifact`** — `npm run atlas:turn-write-artifact -- <logfile> [--json]` (or pipe logs on stdin). Offline, closed-whitelist join of `[interaction-trace]` and `[turn-write-proof]` on canonical `turn_id`; complete exits 0, partial exits 1, and empty exits 2 so missing evidence is never a false green. No creds, network, or Sheet access. Contract: [`verification/ISSUE_1165_SLICE_3_ARTIFACT.md`](./verification/ISSUE_1165_SLICE_3_ARTIFACT.md).
- **`flight-review.js`** / **`gate-a-scorecard.js`** — read-only Sheets evidence extraction / GATE-A scorecard (`--env=production|sandbox`). Read-only; may emit local report files.

### 5a. Supabase hot-path migration proofs (PR S2)

**`npm run test:pg` is the from-empty Postgres proof suite** — `docs/SUPABASE_HOT_PATH_MIGRATION.md` §6.1 P2. Give it `ATLAS_PG_ADMIN_URL` (an admin connection to a throwaway Postgres server); it creates a uniquely named database, applies every file in `supabase/migrations/` from empty, grants the four scoped roles a per-run random login, runs `test-pg/*.pgproof.js`, and drops the database. It **fails loudly when no database is available and never skips** — a skipped proof reported as a pass is the false green the S2 gates exist to prevent.

Why the files live in `test-pg/` and end `.pgproof.js`: `npm test` runs a bare `node --test`, whose default glob matches `**/*.test.js` anywhere and treats every file under a directory named `test` as a test. Under either name, a suite needing a live database would fail `npm test` on every machine without one.

What it proves, as its own files: every constraint of §3.1–§3.9 by a rejected violating insert (`constraints`); least privilege executed **as the four real roles** (`leastPrivilege`); the parent-first atomic shadow transaction against an **empty** schema (`shadowWrite`); the receipt state machine including the advisory-lock liveness rule (`writeReceipts`); sweep detection and earned-only divergence closure (`sweepAndRepair`); the catalog mirror's fail-closed rule and its normal-edit case (`catalogMirror`); **process death in the exact window between the Sheets append and the shadow write** (`processDeath`); and byte-identical responses with the lane off and on (`shadowInert`).

**Nothing here can reach Google Sheets or a hosted Supabase project.** `sheets.js` is stubbed by the same `require.cache` seam the rest of the suite uses, and `scripts/apply-supabase-migrations.js` refuses a `*.supabase.co`/`.com` host outright — a refusal `npm run check:supabase-safety` fails CI for removing.

**Operator commands** (read-only against Sheets; they need a configured Supabase connection and report `NOT CONFIGURED` rather than a zero without one):

- **`atlas:sweep`** — `npm run atlas:sweep [-- --json] [-- --detect-only]`. The reconciliation sweep, which is the **completeness authority** for the shadow window. A run that could not read a concept reports `complete:false` and exits non-zero; a partial sweep is never a zero. TEMPORARY: deleted at S4.
- **`atlas:repair`** — `npm run atlas:repair [-- --json] [-- --limit N]`. Makes Supabase agree with Sheets, never the reverse. Closes a divergence **only** on a passing identity-and-content re-comparison, and leaves anything it holds no grant to repair OPEN as owner action required. TEMPORARY: deleted at S4.
- **`atlas:catalog-sync`** — `npm run atlas:catalog-sync [-- --json]`. Refreshes the `Exercise_Catalog` read mirror. PERMANENT. Run it well inside `ATLAS_CATALOG_MIRROR_MAX_AGE_SEC`; past that bound the S4 Save path fails **closed** rather than serving stale content.

### 6. CI governance guards + secret scan (offline; none can write)

`npm run check:wiring` (wired-or-deleted), `check:authority`, `check:banned`, `check:allowlist` (shrink-only ceiling), `check:paper-weight` (BACKLOG cap + auto-archive job), `check:ladder` (completion-ladder evidence), `check:packet-trace`, `check:backlog-intake`, **`check:supabase-safety`** (no GitHub-triggered path may apply schema to `Atlas Production` or hold a production Supabase credential — §6.1 P10, repository half), and `npm run scan:secrets` (which gained the Supabase connection-string, project-reference and key patterns in PR S2). Each has a self-testing `test/*.test.js`. The full drift-guard registry (and which phase built each) is in `CLAUDE.md` and the execution plan.

### 7. Data tools

- **`export-sheets-backup.js`** — `npm run backup:sheets`. Reads all tabs → timestamped JSON/CSV in `backups/<ts>/`. Read-only on Sheets.
- **`catalog-maintenance.js`** — **the only real-write script.** `node scripts/catalog-maintenance.js --file rows.json [--confirm]`. Dry-run without `--confirm`; a real append hits **only `Exercise_Catalog`** (hard-blocks protected data tabs), dedupes, reads back to verify. Env: `GOOGLE_SHEETS_ID` + service-account creds.

### 8. CI workflows (`.github/workflows/`)

| Workflow | Trigger | Runs | Sheet write? |
|---|---|---|---|
| `ci.yml` | PR, push→main, dispatch | build + lint + the drift guards + `check:supabase-safety` + `npm test`; **the Supabase schema proof against a plain `postgres:16` service container** (`npm run test:pg`); coverage (non-blocking); secret-scan; backlog-intake guard; Playwright e2e; render-smoke (dispatch/main) | No (smoke dry-run only; the Postgres container is created and destroyed with the job and cannot be `Atlas Production`) |
| `live-retest.yml` | manual dispatch | `live-retest.js`, dry-run default; optional `ATLAS_ACCESS_CODE` secret for an authenticated read-only run | No |
| `monitoring.yml` (Daily Mission Control) | daily cron + dispatch | `smoke-test-render.js` pinned `read-only`; opens alert issue on failure | No |
| `merge-card-check.yml` | PR | fails a PR missing the Atlas Merge Card | No |
| `risk-label-gate.yml` | `pull_request_target` | publishes `risk-label/primary` status from trusted default-branch code | No |
| `labeler.yml` / `labels.yml` | PR / push | auto-label + label sync | No |

### 9. Owner live-test system (human-in-the-loop)

- **`docs/AGENT_LIVE_TESTING.md`** — the tier playbook: Tier 1 read-only (pre-authorized), Tier 2 `test_mode` dry-run (pre-authorized), Tier 3 real write (per-test authorization only).
- **`docs/TEST_QUEUE.md`** — owner-only `LT-###` cards for what only a real device/gym/credential can prove.
- **`docs/MOBILE_TEST_APP.md`** — run Atlas as an iPhone home-screen PWA for gym testing.

### 10. The safety / provenance layer

- **`test_mode`** (request field): absent = live write (invariant W2); `"true"` = dry-run (`sheet_written:false, no_write_confirmed:true`); ambiguous values fail closed. **`test_mode` is NOT universal — do not assume it dry-runs an arbitrary write route.** Only the logged-set / effort / closeout write paths inspect it (`isTestModeEnabled` at `index.js:1228` `/api/log-workout`, `1806` approve→write, `2056` `/api/complete-workout`, `2769` closeout — plus `/api/log-modality`). Routes that do **NOT** read it and therefore write LIVE even with `test_mode:true` include **`/api/coaching-notes`** and **`/api/constraints`** (both call `appendRows` directly) and the undo route **`/api/log-workout/undo-last`** (calls `deleteRowsByRange`). Treat any endpoint you have not positively confirmed honors `test_mode` as Tier 3 / live-only (see [`AGENT_LIVE_TESTING.md`](./AGENT_LIVE_TESTING.md): "test_mode is not universal"). (`ATLAS_TEST_MODE` is a phantom token — no code references it; ignore any doc that cites it.)
- **`x-atlas-request-origin`** → `services/evidenceProvenance.js` classifies traffic as `athlete_ui` (eligible) vs `synthetic` (`smoke`/`sim`/`ci`/`playwright`/`canary`/`probe`) vs `unknown`. Synthetic/test traffic never counts toward GATE-A promotion or the five-session proving run.

## Synthetic-athlete / multi-persona simulation — status

A system that simulates ~10 synthetic gym-goers **does not exist as built code.** What exists is the single-user `scripts/sim/` harness (6 session templates, not personas). The multi-athlete concept — **"Persona Harness Lite"**, 8 named synthetic lifters (SIM-DALE, CHAOS, TERSE, RAMBLER / ROOKIE, GHOST, IRONCLAD, VOLUME-V) — lives **only** as a backlogged proposal in `docs/proposals/ATLAS_V1_PROPOSAL_PACKET.md`. The execution plan's Phase 7 lists "varied synthetic athletes" as future proving work (F11 is `QUEUED`) with the standing rule: reuse the existing simulation + Flight-Recorder replay + Playwright — do not build a fourth framework.

## Quick recipes (smallest safe test first)

- **"Is prod healthy?"** → `npm run atlas:status`
- **"Review my last real session"** → `npm run atlas:review-live`
- **"Where does prod bypass packet truth?"** → `npm run atlas:divergence -- <logfile>`
- **"Does the Supabase schema actually hold?"** → `ATLAS_PG_ADMIN_URL=… npm run test:pg` (from empty, real Postgres, never production)
- **"Has the mirror drifted from Sheets?"** → `npm run atlas:sweep` then `npm run atlas:repair` (Sheets read-only in both)
- **"Run everything offline"** → `npm test` (+ `npm run test:e2e` for the browser)
- **"Smoke the deployed app (no writes)"** → `npm run smoke:render`
- **"Exercise the coach route synthetically"** → `node scripts/sim/run.js --base-url http://127.0.0.1:3000` (local server; read-only)
- **"Back up the Sheet"** → `npm run backup:sheets`
