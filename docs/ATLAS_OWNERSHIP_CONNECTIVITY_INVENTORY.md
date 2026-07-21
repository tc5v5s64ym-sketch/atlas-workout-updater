# Atlas Ownership & Connectivity Inventory

**Current as of:** 2026-07-21 · **Owner:** Atlas Recovery Campaign (Issue #1073), Phase 2 Work item 1b · **Status:** living inventory, refreshed as surfaces change.

This is the single ownership/connectivity inventory the recovery campaign calls for: every **route, service, client module, flag, Sheet tab, and planning document**, each with a connectivity note and a provisional **disposition**. It is the human-judgement companion to the deterministic wiring guard (`scripts/check-wired-modules.js`), which as of Work item 1a proves *semantic* reachability (a module's binding is actually referenced) but cannot judge whether an output reaches a user-visible decision — that judgement lives here.

## How to read a disposition

| Tag | Meaning |
|---|---|
| **keep** | A live, single-owner surface the campaign retains substantially as-is. |
| **adapt** | Retained but slated for refactor under a named Phase 3–5 track — consume a Phase-2 contract / the CoachTurnPacket, consolidate under one owner, or extract. No deletion. |
| **retire** | A duplicate, superseded, temporary, or dark surface the campaign plans to delete, merge, or archive. |

**Dispositions are assessments, not authorizations.** Nothing in this file deletes code, changes a flag, archives a document, or alters the preview→approve→write trust loop. Every `retire`/`adapt` that touches product behavior, a module decision, exercise identity, deload, safety, One-Brain promotion, or live data executes only at its named campaign gate/track (Phase 5 Module Decision Day, Identity Ruling Day, etc.) or with explicit owner authorization. Where `docs/DOCS_INDEX.md` and `docs/GOVERNANCE.md` already classify a document, they remain authoritative and this inventory only mirrors them.

**Basis** columns cite the campaign finding (`H-01…H-23`) or Phase/track that governs the disposition, so each call is derivable from the plan rather than invented here.

---

## 1. HTTP routes

Express app is `index.js` (global chain: CORS → `express.json` → request context/logger → static `/app` → per-scope rate limiters → `requireApiKey` with public paths → Flight Recorder passthrough). Three routers under `routes/` are all mounted; **no route file is unmounted**. Routers declare absolute `/api/...` paths (no mount prefix).

### 1a. Routes defined in `index.js`

| Route | Purpose | Disposition · Basis |
|---|---|---|
| GET `/`, GET `/health`, GET `/version`, GET `/routes` | Liveness / health / deployed-SHA / route listing | **keep** — operational surface |
| GET `/.well-known/atlas-status.json` | Control Tower redacted read-only status (no API key) | **keep** — Operations Contract |
| POST `/api/session/login`, POST `/api/session/logout`, GET `/api/session/status` | Durable owner session cookie lifecycle | **keep** |
| GET `/api/pending-exercises` | In-memory unknown-exercise queue | **keep** |
| POST `/api/suggest-substitute` | Deterministic substitute rec (read-only) | **adapt** — SafetyDecision/substitution consolidation, Phase 5d/substitution spec |
| POST `/api/session/compile` | Gemini extracts logged sets from chat ("log it") | **keep** (coach/LLM boundary; read-only extract) |
| GET/POST `/api/coaching-notes` | Read/append Coaching_Notes | **keep** |
| GET/POST `/api/constraints` | Read/append structured Constraints | **adapt** — layered session-scoped constraints, Phase 5e (H-13) |
| POST `/api/log-modality` | Persist non-slash modality entry (503 until tab exists) | **keep** |
| GET `/api/plan/today`, GET `/api/plan/intent-recommendation` | Session/next-set recommendations | **adapt** — CoachTurnPacket consumption, Phase 3–4 (H-03, H-08) |
| GET `/api/recommendation/preview`, GET `/api/recommend/next/:liftCode` | Deterministic recommendation preview / next set | **adapt** — same packet track |
| GET `/api/session/:sessionId`, GET `/api/session/:sessionId/summary` | Session rows / summary | **keep** |
| POST `/api/bodyweight`, GET `/api/bodyweight/history` | Bodyweight append / history | **keep** |
| POST `/api/admin/preview-test-rows`, POST `/api/parse-workout-text` | Dry-run preview / text parse | **keep** — trust-loop preview surface |
| POST `/api/parse-workout-image`, POST `/api/complete-workout` | Vision parse / multipart closeout write | **keep** (closeout **adapt** — retire reconstruction lane once buffer capture proven, Phase 5g / H-17) |
| POST `/api/log-workout`, POST `/api/log-workout/undo-last`, GET `/api/log-workout/verify-range` | JSON write path / undo / read-back verify | **keep** — trust-loop core (never weakened without owner) |

### 1b. `routes/reads.js` — read/analytics (16 routes)

`/api/history/recent`, `/api/exercises/last-session`, `/api/exercises/:liftCode`(+`/progress`,`/detail`), `/api/volume/muscle-groups`, `/api/search/sessions`, `/api/catalog/exercises`, `/api/catalog/search`, `/api/sessions/recent`, `/api/sessions/:sessionId`, `/api/summary/weekly`, `/api/progress/summary`, `/api/report/weekly`, `/api/prs/recent`, `/api/stalls`.
**Disposition: keep** (read-only analytics surface). *Exception:* the exercise/catalog reads are **adapt** — name-keyed joins migrate to the immutable ExerciseIdentity registry (Phase 5b, H-11).

### 1c. `routes/coachOps.js` — coach / deload / debug (24 routes)

| Group | Routes | Disposition · Basis |
|---|---|---|
| Health | `/api/health/sheets`, `/api/health/openai`, `/api/health/gemini`, `/api/coach/health` | **keep** |
| Coach voice | POST `/api/coach/message`, `/api/coach/chat`, `/api/coach/ask` | **adapt** — consume CoachTurnPacket; one intelligence route (Phase 3–4, H-03/H-16); read-only, never writes |
| Deload | GET `/api/deload/status`, POST `/api/deload/begin`, `/api/deload/advance`, `/api/deload/resolve` | **adapt** — wire or delete under one DeloadLifecycle (Phase 5c, H-10; Issues #289/#291) |
| Shadow/debug | `/api/debug/intent-shadow`, `/api/debug/brain-shadow`, `/api/debug/intent-observe`, `/api/debug/config`, `/api/debug/exercise-match` | **retire** (after their phase) — no permanent shadow/legacy lanes (Phase 5f, H-14); keep only through Phase 3 shadow |
| Flight Recorder | GET `/api/flight/recent`, POST `/api/flight/ingest` | **keep** — telemetry spine feeding the InteractionTrace (Phase 3, H-14) |
| Bug report | POST/GET `/api/bug-report` | **keep** |
| Schema | `/api/schema/log`, `/api/schema/effort`, `/api/schema/complete-workout` | **keep** — schema contracts |
| Insights | `/api/coaching/insights` | **adapt** — packet/knowledge-record track (Phase 6) |

### 1d. `routes/sessionPlans.js` — Session_Plans capture (6 routes, flag-gated sidecar)

POST `/api/session-plans/{accept,outcome,closeout}` (gated by `ATLAS_SESSION_PLANS_WRITE`) and POST `/api/session-plan-sets/{accept,revision,implicit}` (dry-run until `SESSION_PLAN_SETS_WRITE_ENABLED`, F10D).
**Disposition: keep / adapt** — this is the planned-vs-actual capture the Phase 4 canonical proof consumes end-to-end (H-09); writes only Session_Plans / Session_Plan_Sets, never the logged-set trust loop.

---

## 2. Services (`services/*.js`)

**159 service modules; 186 files semantically reachable from 37 production roots; guard green** (`node scripts/check-wired-modules.js`, 2026-07-20). Per-module tagging of all 159 would fabricate confidence the evidence does not support, so services are dispositioned at the granularity that carries signal: (a) the 9 modules the guard flags as production-unreachable, each explicitly; (b) the named consolidation clusters the campaign already targets; (c) a grounded blanket for the remaining production-wired modules.

### 2a. Guard-flagged modules (8 staged + 1 test-only) — the Phase 5a Module Decision Day docket

| Module | What it is | Disposition · Basis |
|---|---|---|
| `services/objectiveScorer.js` | Pure Session Objective Scorer (nine sub-scores × ten objectives) | **adapt** or **retire** — Module Decision Day (Phase 5a); live-snapshot wiring not V1-selected |
| `services/objectiveScoring.js` | Frozen deterministic objective weights + select formula | **adapt** or **retire** — Phase 5a; awaits owner-approved planner campaign |
| `services/sessionCloseout.js` | Pure "is the planned session complete?" helper | **adapt** — Phase 5a; overlaps closeout/pin work (Phase 5g, H-17/H-19) |
| `services/deterministicCoachRenderer.js` | Dark pure engine slice (fallback/fast-path voice) | **adapt** or **retire** — Phase 5a; relates to the packet fallback route (Phase 4, H-18) |
| `services/autoregulationModule.js` | Dark e1RM/readiness load prescription; no consumer | **retire** or **adapt** — Phase 5a; One-Brain promotion is evidence/owner-gated (H-04) |
| `services/starterProgramModule.js` | Beginner program template runner (5×5 / GZCLP) | **retire** or **adapt** — Phase 5a; not V1 campaign work |
| `services/intermediateProgramModule.js` | 5/3/1 intermediate template runner | **retire** or **adapt** — Phase 5a; not V1 campaign work |
| `services/populationCapsModule.js` | Dark goal/population-policy layer | **retire** or **adapt** — Phase 5a; not V1 campaign work |
| `services/exerciseTruthAudit.js` | Exercise-truth audit tooling (test-only by design) | **keep** — correctly production-unreachable; powers a blocking test |

### 2b. Named consolidation clusters (production-wired, but multi-owner) — **adapt**

| Cluster (representative modules) | Basis |
|---|---|
| Deload — `deloadEngine`, `deloadStateMachine`, `deloadPolicy`, `deloadProtocols`, `deloadFatigueScore`, `deloadEscalationLadder`, `deloadState` | Consolidate to one DeloadLifecycle (Phase 5c, H-10) |
| Safety — the duplicate safety/constraint classifiers (`constraintDetector`, `constraintResolver`, and the coach-side safety pass) | One SafetyDecision contract consumed by route and Brain alike (Phase 5d, H-12) |
| Exercise identity — `athleteIdentity`/`entityResolutionModule` and the name-keyed resolvers, catalog joins | Immutable ExerciseIdentity registry; every other form an alias/projection (Phase 5b, H-11) |
| Coach voice/decision — `coachOrchestrator`, `coachRunners`, `coachPersonaCore`, `coachVoiceRenderer`, `coachPolish`, `coachDecisionSummary`, `coachExplanationPolicy` | Route intelligence through one CoachTurnPacket; engine owns numbers, LLM only words facts (Phase 3–4, H-03/H-16) |
| Shadow — `brainShadow`, `driftShadow`, `intentShadow`, `driftSignal`, `discouragementSignal` | Shadow the packet/trace (Phase 3); **retire** permanent shadow lanes at Phase 5f (H-14) |

### 2c. Remaining production-wired services — **keep**

Every other `services/*.js` is semantically reachable from a production root and owns a live concern (parsing, sheet I/O, recommendations, effort/duration, idempotency, catalog, vision, session state, status/operations). Blanket **keep**, subject to the single-owner consolidations in 2b as those tracks land. The wiring guard (grow-only) is the standing enforcement that this set never silently accretes dead modules.

---

## 3. Client modules (`src/app/`)

Entry `src/app/atlasEntry.js` (25 lines). **`src/app/app.js` is 7,824 lines** — the monolith. Frontend reads no `process.env` (all flags server-side).

| Module(s) | Disposition · Basis |
|---|---|
| `app.js` | **adapt** — app.js freeze (no new session-state logic) + finish the PR-09 extraction (Phase 2 Work item 4 / Phase 5g, H-21) |
| `legacyBridge.js` | **retire** — explicitly temporary Phase-1 bridge |
| `atlasEntry.js`, `api.js`, `dom.js`, `nav.js`, `store.js`, `drawer.js`, `chat.js`, `coach-conversation.js` | **keep** — shell/state/nav/api surface |
| `activeSession.js`, `sessionLedger.js`, `sessionTally.js`, `sessionQuestion.js`, `planSlotStatuses.js`, `planAcceptance.js`, `planOutcome.js`, `planCloseout.js`, `planCompletion.js`, `planMutationIntent.js`, `pendingClarification.js`, `identityCorrection.js`, `displayBlockNormalizer.js`, `workoutSheet.js`, `historyView.js`, `progressView.js`, `bugReport.js`, `settingsHealth.js`, `flightRecorder.js`, `coachVoiceTemplates.js`, `hybridCompare.js`, `signals-core.js` (vendored), `sw.js` | **keep** — extracted single-purpose modules; the target shape of the app.js extraction |

*Identity-correction and plan-slot-identity modules are **keep** but ride the Phase 5b ExerciseIdentity registry (H-11) for their name-keyed logic.*

---

## 4. Feature flags / environment variables

Server-side only. Grouped by kind; disposition notes the campaign relevance.

| Var | Gates | Disposition · Basis |
|---|---|---|
| `SESSION_PLAN_SETS_WRITE_ENABLED` | Session_Plan_Sets ledger live write (`=1`; default **0**) | **keep** — stays `0` until Phase 4 explicitly requires it (F10D) |
| `ATLAS_SESSION_PLANS_WRITE` | Session_Plans sidecar live write (default OFF) | **keep** — Phase 4 capture gate |
| `ATLAS_COACH_ENGINE` | One-Brain engine mode (`hybrid`/shadow); `brian`→`brain` rename pending | **adapt** — Phase 5g dual-accept rename (H-23); One-Brain owner-gated (H-04) |
| `ATLAS_INTENT_ROUTER` | Gemini intent-router shadow | **retire** (after Phase 3) — no permanent shadow lane (H-14) |
| `ATLAS_BRAIN_SHADOW_PERSIST`, `ATLAS_DRIFT_SHADOW` | Brain/drift shadow persistence | **retire** (after Phase 3/5f) — shadow-only |
| `ATLAS_INTERACTION_TRACE` | Phase 3 InteractionTrace shadow (`=shadow`; default off): mints the turn_id at the first trusted boundary and opens the trace spine, log-only | **keep** — the one turn_id/trace spine; graduates to live route consumption in Phase 4 (H-14/H-03) |
| `ATLAS_FLIGHT_RECORDER` | Flight Recorder capture (default OFF) | **keep** — trace spine (H-14) |
| `ATLAS_COACH_PROFANITY` | Coach profanity register (default off) | **keep** — voice setting; owner-controlled |
| `ATLAS_PROFILE_GOAL`, `ATLAS_TIMEZONE`, `ATLAS_LLM_PROVIDER`, `ATLAS_LLM_MODEL`, `GEMINI_COACH_MODEL`, `GEMINI_ROUTER_MODEL` | Profile/tz/provider/model selection | **keep** — provider/model selection is owner-reserved |
| `ATLAS_API_KEY`, `ATLAS_SESSION_SECRET`, `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | Credentials / connection | **keep** — secrets; never in repo |
| `LOG_SHEET_NAME`, `EFFORT_SHEET_NAME`, `DELOAD_STATE_SHEET_NAME`, `SESSION_PLANS_SHEET_NAME` | Sheet-tab name overrides | **keep** |
| Rate-limiter tuning (`ATLAS_*_RATE_LIMIT_*`, `JSON_BODY_LIMIT`) | Per-scope limiter windows/maxes | **keep** |
| `NODE_ENV`, `RENDER_GIT_COMMIT`, `CORS_ORIGIN`, `ATLAS_BASE_URL`, `ATLAS_VISION_TIMEOUT_MS`, `ATLAS_IDEMPOTENCY_FILE` | Infra / deploy | **keep** |

No `*_MODE` env vars exist (the only "mode" concept, `COACH_MODES`, is code-internal).

---

## 5. Sheet tabs / schemas

Contract in `config/sheetContract.js`; columns in `config/columns.js`. **No column may be added/removed/reordered without a migration and explicit owner approval** — every tab is **keep** (schema-locked). Connectivity only:

| Tab | Cols | R/W | Disposition · Basis |
|---|---|---|---|
| `Log_Cleaned` | 12 | R+W | **keep** — trust-loop write target (preview→approve→write, header-drift guarded) |
| `Effort` | 9 | R+W | **keep** — `average_hr`/`peak_hr` distinct |
| `Exercise_Catalog` | 4(+variants) | R | **keep** — identity source (name joins **adapt** to registry, Phase 5b) |
| `Coaching_Notes` | 2 | R+W | **keep** |
| `Constraints` | 5 | R+W | **keep** — layered constraints **adapt** (Phase 5e, H-13) |
| `Deload_State` | 7 | R+W | **keep** — append-only; DeloadLifecycle consumer consolidates (Phase 5c) |
| `Session_Plans` | 13 | R+W (gated) | **keep** — planned spine (Phase 4, H-09) |
| `Session_Plan_Sets` | 16 | R+W (dry-run) | **keep** — set-level ledger (F10) |
| `Modality_Log` | 12 | W(+R) | **keep** — 503 until tab exists |
| `Flight_Recorder` | 18 | W | **keep** — telemetry (H-14) |
| `Brain_Shadow`, `Intent_Shadow` | (json schema) | W | **keep** tab; **retire** the writing *lanes* post-shadow (Phase 5f, H-14) |
| `Bug_Reports` | append-only | R+W | **keep** |
| `Metadata`, `Logic`, `Session_Summary`, `Dashboard` | contract presence | — | **keep** — presence-checked; no app column-contract writes |

---

## 6. Planning documents

`docs/DOCS_INDEX.md` and `docs/GOVERNANCE.md` are the authority on document status; this inventory mirrors them and flags archival candidates for **Phase 2 Work item 4 (paper hygiene)** — it does not move or delete any file.

| Group | Documents | Disposition · Basis |
|---|---|---|
| Sole active queue | `docs/ATLAS_V1_EXECUTION_PLAN.md` (+ this campaign) | **keep** — the one work-selection authority |
| Governing product truth | `CLAUDE.md`, `docs/ATLAS_PRODUCT_VISION.md`, `CONSTITUTION.md`, `INVARIANTS.md`, `ARCHITECTURE.md`, `GOVERNANCE.md`, `DECISION_KERNEL.md`, `DOCS_INDEX.md` | **keep** |
| Active specs/contracts | `DELOAD_SPEC.md`, `SUBSTITUTION_SPEC.md`, `FLIGHT_RECORDER_SPEC.md`, `SESSION_PLANNING_ENGINE.md`, `SESSION_PLANS_CAPTURE_SPEC.md`, `SESSION_PLANS_LEDGER_DESIGN.md`, `COACHING_CONTRACTS_SPEC.md`, `COACHING_ENGINE_ARCHITECTURE.md`, `SHEET_CONTRACT.md`, `CONVERSATION_CONTRACT_V1.md`, `DECISION_ROUTING.md`, `RISK_LABELS.md`, `AUTOMATION_PROTOCOL.md`, `ATLAS_OPERATIONS_CONTRACT.md`, `AGENT_WORKFLOW.md`, `AGENT_LIVE_TESTING.md`, `SAFETY_RULES.md`, `NO_WRITE_SAFETY.md`, `EXERCISE_NAME_UNIFICATION_MIGRATION_PLAN.md`, `docs/reference/ATLAS_RECOVERY_CAMPAIGN_SPEC.md`, and the remaining `docs/*_SPEC.md`/design docs | **keep** (some **adapt** as their Phase-5 track ratifies the eight canonical contracts, Work item 2) |
| Competing roadmaps / superseded plans | `docs/ACTIVE_ROADMAP.md`, `docs/ROADMAP.md`, `docs/COACH_INTELLIGENCE_ROADMAP.md`, `docs/REMEDIATION_PLAN_V2.md`, `docs/POST_SOUL_V1_FINISHING_PLAN.md`, `docs/SOUL_PLAN_V1.md`, `docs/COMPOSER_FIRST_MIGRATION.md`, `docs/RECOMMENDATION_PIPELINE_V1_5.md`, root `ATLAS_PERFORMANCE_INTELLIGENCE_PLAN.md`, `COACH_INTELLIGENCE_PLAN.md`, `COACH_PLAN.md`, `FIX_PLAN.md`, `EXPANSION_SUMMARY.md`, `COMPLETION_CHECKLIST.md` | **retire** (archive) — the execution plan is the sole queue (H-01); confirm against DOCS_INDEX and archive under Work item 4. No file moved here. |
| Audit / investigation / historical (date-stamped) | `docs/AUDIT_2026-06-12.md`, `AUDIT_2026-07-07_DEEP_REVIEW.md`, `AUDIT_TRIAGE_2026-06-20.md`, `PLANNING_DOCS_AUDIT_2026-07-01.md`, `INVESTIGATION_2026-06-25*.md`, `SOUL_RECOVERY_AUDIT.md`, `QA_CAMPAIGN_*`, `UX_PLAYTEST_*`, `REMEDIATION_REVIEW_2026-07-08.md`, `PHASE1_MINEFIELD_MAP.md`, `PR10_REGRESSION_ADDENDUM.md`, `F10D_PRODUCTION_READINESS.md`, `FIRST_REAL_WRITE.md`, `BASELINE_POST_CUTOVER.md`, and peers | **retire** (archive with a historical banner) — point-in-time records; keep for provenance, mark non-current (Work item 4, H-20) |
| Reference / operations / runbooks | `ATLAS_CONTEXT.md`, `MISSION_CONTROL.md`, `WORKFLOW.md`, `OWNER_SESSION.md`, `OWNER_CHECKIN_RULES.md`, `RELEASE_CHECKLIST.md`, `BACKUP_ROLLBACK.md`, `TROUBLESHOOTING.md`, `SECRET_*`, `API_REFERENCE.md`, `DEPLOYMENT_GUIDE.md`, `README.md`, `QUICKSTART.md`, `CHANGELOG.md`, `AGENTS.md`, `CODEX.md`, `BACKLOG.md`, `BACKLOG_ARCHIVE.md` | **keep** — durable operational references |

Full file lists live in the enumeration above; the archival candidates are handed to Work item 4, which owns the banners, dates, and the BACKLOG archive.

---

## Maintenance

- The wiring guard (`scripts/check-wired-modules.js`) keeps §2 honest for services automatically (grow-only, fails CI on a new unreferenced module).
- Refresh the **current-as-of** date and the affected section whenever a route/service/module/flag/tab/doc is added, wired, retired, or reclassified.
- Dispositions here feed the Phase 5 owner-gate packs (Module Decision Day, Identity Ruling Day) and Work item 4 paper hygiene; they never authorize the change themselves.
