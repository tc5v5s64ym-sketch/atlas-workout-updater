# Atlas Coach — "Next-Level" Build Plan

> Future/reference-only. Do not execute ahead of `BACKLOG.md` or `docs/ACTIVE_ROADMAP.md`.
> Use `docs/AGENT_WORKFLOW.md` for the Dale + ChatGPT + Claude Code + CODEX Review + GitHub process.

A handoff for Claude Code. Six coaching upgrades, organized into **three model phases**
with **one model switch** (Sonnet → Opus at HOLD 1) and a **rebase/merge checkpoint**
at HOLD 2 (no model change — Phase 3 stays on Opus 4.8). Each task is its own PR.

This document was written as the roadmap for next-level coach work. It is now future/reference material unless `BACKLOG.md` or `docs/ACTIVE_ROADMAP.md` explicitly promotes a step.

---

## How to use this plan

- Work top to bottom. There is **one model switch**: Sonnet 4.6 (Phase 1) → Opus 4.8
  (Phases 2 & 3) at HOLD 1. HOLD 2 is a rebase/merge checkpoint only — no model change.
- Each task = one focused PR. **Plan mode first**, show the plan, get the diff reviewed,
  merge on green.
- The model on each task is a *suggestion*. **Claude Code: if you think a task warrants a
  different tier, say so in plan mode before running it.**

## Operating rules (apply to EVERY task — do not restate per task)

- **IRON RULE:** the deterministic engine owns every number; the LLM only *words* them.
  Never invent, change, or recalculate a number. If a fact is missing, drop that beat
  rather than fabricate it.
- **Trust loop untouched:** approve-before-save, no blind writes to the Sheet, undo intact.
  Any new persisted thing (a constraint, a goal) is *proposed and approved* before it saves.
- **New write paths are `write_id`-idempotent:** any task that adds a write route (e.g. the
  2.1 constraint store, the 4.1 goal model) must go through `beginWrite`/`completeWrite`/
  `failWrite` (`services/idempotency.js`) so a repeated `write_id` replays the original
  response instead of writing twice — same discipline as every existing write path.
- **New Sheets tabs need a pinned column contract:** any task that adds a tab (constraint
  store, goal model) must document its columns in `config/columns.js` /
  `config/sheetContract.js` and `CLAUDE.md`, the same way the 12-column `Log_Cleaned` and
  9-column `Effort` contracts are pinned. No undocumented schema.
- **Sanitize every new fact** fed to an LLM with a whitelist that mirrors the existing
  `sanitizeVerdict` / `sanitizeProgressionVerdict` / `sanitizeDeloadPhase` pattern — only
  known fields survive; unknown keys are dropped; a malformed fact returns null.
- **Test gates:** `coach.test.js` gates any prompt change. `unit.test.js` must stay fully
  green — a unit failure is a real regression, not environmental noise. The only suites that
  legitimately fail without API keys/network are `api-smoke`, `coach-ask-endpoint`,
  `recommendation-preview-endpoint`, and `vision`. Nothing else is pre-excused.
- **Cache discipline:** any change to a precached client/shell asset (`public/*.js`, or the
  `SHELL_ASSETS` list) requires bumping `CACHE_NAME` in `public/sw.js`, or the change won't
  reach the device.
- **Merge discipline:** these tasks share files (`services/analytics.js`, `services/coach.js`).
  **Rebase a branch on latest `main` before merging** so a stale branch can't clobber a prior
  one. Turn on GitHub's "require branches up to date before merging" to enforce it.

## Model tiers (why each)

- **Sonnet 4.6** — deterministic foundations, schema, sanitizers, plumbing, tests.
  Pattern-following work that mirrors what's already in the repo.
- **Opus 4.8** — hard engine algorithms that need real reasoning (substitution pricing,
  constraint-aware re-planning, goal projection, auto-regulation calibration) **and**
  coaching voice and judgment (verdict prompts, conversational game-planning behavior,
  the teaching voice). Fable 5 would be marginally stronger for voice work but is
  restricted on this account — Opus 4.8 covers both Phases 2 and 3.
- *(Haiku 4.5 — optional for the most rote sub-tasks, e.g. pure test fixtures. Default to
  Sonnet to avoid an extra model switch.)*

## Dependency map (what blocks what)

- **#2 substitution** (P2) → feeds **#1 re-planning** (P2).
- **#1**: session-constraint state (P1) → re-planning (P2) → conversational voice (P3).
- **#3**: session-level reads + surface (P1) → summary verdict prompt (P3).
- **#4**: goal model (P1) → progress/projection (P2) → goal-framing voice (P3).
- **#5**: effort-drift signal (P1) → auto-regulation logic (P2) → proactive voice (P3).
- **#6**: reasoning-trace fact (P1) → "why" voice (P3).

Within a phase, tasks are independent unless a dependency is noted; build in listed order
where one exists. Each can be its own branch; rebase before merge.

---

# ═══ PHASE 1 — Sonnet 4.6 ═══
### Deterministic foundations, plumbing, and tests

### P1 · 2.1 — Structured constraint store · **Sonnet 4.6**
- **What:** extend the saved-notes path (`PROPOSE_NOTE`) from free-text into *typed,
  structured* constraints: `{ kind: injury | equipment | preference, target:
  movement/pattern/equipment, rule: avoid | limit | substitute }`. Add a read API the plan
  layer can query.
- **Files:** `services/coach.js` (note parse/propose), a new `services/constraints.js` or
  `services/analytics.js`, `index.js` (read/write route), a Google Sheets tab.
- **Tests:** schema validation; retrieval; malformed/ambiguous note rejected.
- **Note:** keep the existing free-text note behavior working; this adds structure on top.

### P1 · 2.2 — Apply-constraints filter · **Sonnet 4.6**
- **What:** a deterministic function that, given the active constraints, flags or removes
  plan exercises that violate a rule (e.g. drop overhead pressing when "left shoulder — no
  overhead"). Plan generation consults it.
- **Files:** `services/analytics.js` (plan/intent layer), `services/liftRole.js` (pattern
  matching).
- **Tests:** an injury rule removes the right pattern; an equipment rule flags the right
  lifts; no constraints → no change.

### P1 · 1.1 — Session-constraint state + plumbing · **Sonnet 4.6**
- **What:** capture mid-session constraints ("rack's taken", "shoulder's tweaky") and thread
  them to the engine — same shape as the `intentId` thread already in `fetchReaction`.
- **Files:** `public/app.js` / `public/coach-conversation.js` (`activePlannedSession`),
  `index.js` (route param), `services/analytics.js` (accept the option).
- **Tests:** constraints ride along on the request; absent → behaves as today.
- **Cache:** client asset changes → bump `CACHE_NAME`.

### P1 · 3.1 — Session-level reads + big-picture fact · **Sonnet 4.6**
- **What:** server computes whole-session facts: each lift's effort/progression verdict
  aggregated across the session, plus a deterministic "big picture" (total volume vs
  baseline, the standout lift = furthest above/below its band, overall soft/hard read).
  Whitelist it via a new sanitizer.
- **Files:** `services/analytics.js` (reuse `recommendNextSet`/verdict computations per
  lift), `services/coach.js` (`sanitizeSessionSummary`).
- **Tests:** the standout lift is picked correctly; volume read matches fixtures; sanitizer
  drops unknown keys.

### P1 · 3.2 — Summary route + client surface · **Sonnet 4.6**
- **What:** a read-only endpoint that returns the session-summary facts, and a client surface
  to render the (later) narrated summary at session end.
- **Files:** `index.js` (route), `public/app.js` / `public/coach-conversation.js` (display).
- **Tests:** route returns the facts; renders without the LLM (templated fallback) so it
  never blocks. **Cache bump.**
- **Depends on:** 3.1.

### P1 · 4.1 — Goal model · **Sonnet 4.6**
- **What:** store the lifter's goal(s): `{ lift, target_weight, target_rir, target_reps,
  hold_condition }` (e.g. 215 @ RIR 3 for 10 clean). Set via a chat command or settings;
  read API for the plan/notes layers.
- **Files:** `index.js` (route), Sheets tab, `services/analytics.js` (read).
- **Tests:** set/read round-trips; one goal per lift; invalid goal rejected.
- **Trust loop:** setting a goal is proposed + approved before save.

### P1 · 5.1 — Effort-drift signal · **Sonnet 4.6**  *(→ Opus if the matching gets gnarly)*
- **What:** deterministic comparison of recent logged effort vs history *at matched loads* —
  is the same weight grinding harder than it used to? Emit readiness flags. Reuse
  `computeFatigueStatus`.
- **Files:** `services/analytics.js`.
- **Tests:** a clear harder-than-history pattern flags; stable history does not; thin history
  → null.

### P1 · 6.1 — Reasoning-trace "why" fact · **Sonnet 4.6**
- **What:** expose the engine's existing decision reasons for a recommendation as a
  structured `why` fact (the deterministic logic behind the call — the inputs and the rule
  that fired), whitelisted.
- **Files:** `services/analytics.js` (assemble from existing reason strings),
  `services/coach.js` (`sanitizeWhy`).
- **Tests:** the fact carries the real reasons; sanitizer drops extras.

> ## ▶▶ HOLD POINT 1 — switch Claude Code to **Opus 4.8**
> First: rebase + merge all Phase 1 PRs so Phase 2 builds on a clean `main`. Then change the
> model to Opus 4.8 and continue.

---

# ═══ PHASE 2 — Opus 4.8 ═══
### Hard engine algorithms (real reasoning), and tests

### P2 · 2.3 — Substitution intelligence · **Opus 4.8**
- **What:** map a lift to viable alternatives (by movement pattern / muscle / equipment), and
  **price the substitute from real history** — that lift's own logged history, or a
  deterministic ratio from a closely related lift. Never an invented load.
- **Files:** `services/analytics.js`, `services/liftRole.js`.
- **Tests:** barbell-bench-unavailable → DB bench priced from DB history; a ratio fallback is
  deterministic and bounded; no history → no fabricated number (degrade gracefully).
- **Guardrail:** the IRON RULE is the whole point here — every substitute weight traces to
  the lifter's data.

### P2 · 1.2 — Constraint-aware re-planning · **Opus 4.8**
- **What:** given the current session + active constraints + the substitution map,
  deterministically rebuild and re-sequence the session and re-prescribe loads from history.
  The engine owns every number; this is the orchestration.
- **Files:** `services/analytics.js`.
- **Tests:** "rack taken" reroutes to a rack-free session with engine-priced loads;
  re-sequencing respects fatigue/role; changing intent mid-session re-plans cleanly.
- **Depends on:** 2.3, 1.1.

### P2 · 4.2 — Progress-to-goal + projection · **Opus 4.8**
- **What:** compute where the lifter is vs the goal (using e1RM / working weight) and a sane
  rate-based projection (ETA), with a guardrail that caps silly extrapolation on thin or
  noisy data.
- **Files:** `services/analytics.js`.
- **Tests:** projection matches a known trend fixture; flat/declining history → no false ETA;
  extrapolation is capped.
- **Depends on:** 4.1.

### P2 · 5.2 — Auto-regulation logic · **Opus 4.8**
- **What:** turn the effort-drift signal + fatigue state into a *calibrated* proactive
  recommendation (when to surface a back-off / deload), tuned to avoid false alarms.
- **Files:** `services/analytics.js` (extends the existing deload trigger).
- **Tests:** two grinding sessions in a row trigger a proactive flag; a single hard day does
  not; fresh-but-stalled still routes to "push", not "deload".
- **Depends on:** 5.1.

> ## ▶▶ HOLD POINT 2 — rebase + merge checkpoint (no model change)
> Rebase + merge all Phase 2 PRs so Phase 3 builds on a clean `main`. Continue on
> **Opus 4.8** — no model switch needed.

---

# ═══ PHASE 3 — Opus 4.8 ═══
### Coaching voice & prompts (highest-judgment), and tests

### P3 · 3.3 — Session-summary verdict prompt · **Opus 4.8**
- **What:** a new LLM prompt (`buildSummarySystemPrompt`) that narrates the end-of-session
  verdict per `docs/COACHING_NOTE_VOICE.md` — per-lift verdicts, the big-picture read, the
  effort line, and a forward decision ("245×6 is the marker; next time repeat or nudge to
  255"). Engine-grounded; words only the 3.1 facts.
- **Files:** `services/coach.js` (prompt + generator), `test/coach.test.js`.
- **Tests:** narrates the standout lift, ends on a forward decision, cites only facts present,
  no invented numbers, no set restatement.
- **Depends on:** 3.1, 3.2.

### P3 · 1.3 — Game-planning conversational behavior · **Opus 4.8**  *(the marquee)*
- **What:** the chat behavior that negotiates constraints in real time — "rack's taken,
  shoulder's cranky, I'll do chest" rebuilds the session and explains it; "actually I'll do
  bench" re-plans on the spot. Conversation owns the *constraints*; the engine (1.2) owns
  every *number*.
- **Files:** `services/coach.js` (`buildChatSystemPrompt` + the constraint/re-plan handling),
  `test/coach.test.js`.
- **Tests:** prompt instructs constraint capture + hand-off to the engine for numbers; never
  invents a load; respects saved injury/equipment constraints (2.x).
- **Depends on:** 1.2, 2.x.

### P3 · 5.3 — Proactive readiness voice · **Opus 4.8**
- **What:** how the coach raises fatigue/readiness *first* without nagging — "second session
  your bench felt heavier than the numbers say; want to deload?" Words the 5.2 signal.
- **Files:** `services/coach.js`, `test/coach.test.js`.
- **Tests:** voices the flag as an offer, not an order; silent when no flag; never overrides
  the lifter's call.
- **Depends on:** 5.2.

### P3 · 4.3 — Goal-framing voice · **Opus 4.8**
- **What:** the day-opener and notes reference goal progress when present — "three clean
  sessions from 215 at this rate." Words the 4.2 projection; drops the beat if absent.
- **Files:** `services/coach.js` (`buildPlanSystemPrompt` + per-set note), `test/coach.test.js`.
- **Tests:** cites the projection only when present; never fabricates an ETA.
- **Depends on:** 4.2.

### P3 · 6.2 — "Why" explanation voice · **Opus 4.8**
- **What:** a "tell me why" behavior that teaches the principle behind a call from the 6.1
  reasoning fact — grounded in the engine's actual logic, not a generic article.
- **Files:** `services/coach.js`, `test/coach.test.js`.
- **Tests:** explanation maps to the real reasons in the fact; no invented rationale.
- **Depends on:** 6.1.

### P3 · DOC — Update the voice standard · **Opus 4.8**
- **What:** extend `docs/COACHING_NOTE_VOICE.md` to cover the new surfaces (session summary,
  game-planning, why-layer, proactive readiness) and record the precedence rules already in
  place (deload framing overrides the effort-verdict "add weight" steer; constraints
  override default plans).
- **Files:** `docs/COACHING_NOTE_VOICE.md`.

---

## Done = all three phases rebased, merged, and green.

## Alternative ordering (if you'd rather ship feature-by-feature)
The model-grouped order above **minimizes model switches** (one: Sonnet → Opus at HOLD 1),
at the cost of a feature only going end-to-end once its later-phase slice lands. If you'd
rather see one feature fully working before the next, reorder by feature instead — but you'll
switch models more often (each feature spans Sonnet → Opus). If you go that route, start
with **#3 (session summary)** for the fastest visible win and **#2 → #1 (game-planning)**
for the biggest capability jump.
