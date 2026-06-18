# Atlas Performance Intelligence — Execution Plan

Roadmap steps 345–355 (internal sequence numbers — GitHub PR numbers may differ). Start numbering at 345 because PR 344 already merged.

**Global rules**
- One PR at a time. Stop after every PR. Do not merge. Do not continue without owner approval.
- Default model: Sonnet. Stop for Opus decision when noted.
- No write-path changes unless explicitly stated.
- No sheet schema changes unless explicitly approved.
- Add tests before declaring complete.
- App-test hold point after every user-visible PR.

---

## PR 345 — Coach Conversation Cleanup
**Model:** Sonnet  
**Status:** ⏳ In progress

**Goal:** Fold substitution/recommendation cards into one coach-style response so Atlas feels like one coach talking.

**Problem:** After a set is logged, the conversation bubble stacks separate diagnostic boxes:
- `.nextp` card ("→ Next" prescription)
- `.sub-note.sub-ok/warn` (substitution verdict — a separate colored box)
- Proactive substitute recommendation (`atlas:substitute-suggested`) renders in a clinical header-body format

**Approach:**
1. Extract pure text-formatting functions to `public/coachVoiceTemplates.js` (UMD — testable in Node, usable in browser).
2. Pass `substitution` facts into the main LLM call so the coach addresses it in one voice (in-workout path). Fallback appends templated line after the opener.
3. Fold substitution text into the typed intro paragraph of the preview bubble (no separate box).
4. Rewrite `handleSubstituteSuggested` as coach-voice prose — not a structured header/body card.
5. Remove `renderSubstitutionNotes`, `voiceSubstitution`, `substitutionTone` (no longer needed).
6. Remove `.sub-note` CSS rules (no longer rendered).

**Files touched:** `public/coachVoiceTemplates.js` (new), `public/index.html`, `public/coach-conversation.js`, `public/styles.css`, `test/coachConversation.test.js` (new), `tests/e2e/app-smoke.spec.js`

**App test hold:** Substitution flow shows one clean coach response in the bubble body — no stacked diagnostic boxes.

---

## PR 346 — Exercise Benchmark Engine
**Model:** Sonnet
**Status:** ✅ Merged

**Goal:** Create deterministic per-exercise benchmarks from historical logs: working weight, recent best, rep range, RIR range, confidence.

**Approach:**
- New `services/exerciseBenchmark.js`: `computeBenchmark(liftCode, rows)` → `{ workingWeight, recentBest, repRange, rirRange, confidence, sampleSize }`.
- Uses the last N sessions of `Log_Cleaned` rows for the lift.
- Working weight: mode/median of top-set weights after excluding outliers (warm-ups identified by RIR ≥ 4 or weight < 60% of max).
- Confidence: `high` (≥5 sessions), `medium` (3–4), `low` (1–2), `none` (0).
- No write path, no LLM, no sheet schema change.

**Files touched:** `services/exerciseBenchmark.js` (new), `test/exerciseBenchmark.test.js` (new), wire into `/api/recommend/next` response.

**App test hold:** Bench history should identify 225×5 @2 as stronger benchmark than 185×8 @2.

---

## Roadmap Step 347 — Expected Performance Engine (GitHub PR #348)
**Model:** Sonnet
**Status:** ⏳ In progress (GitHub PR #348)

**Goal:** Given today's weight/reps/RIR, estimate expected performance from recent history.

**Approach:**
- New `services/expectedPerformance.js`: `computeExpectedPerformance(liftCode, rows, todayWeight)` → `{ expectedReps, expectedRirRange, basis }`.
- Reads last 4–6 top sets at or near `todayWeight` (±10%).
- Returns null/`insufficient_data` when fewer than 3 data points.
- Pure function, no writes.

**Files touched:** `services/expectedPerformance.js` (new), `test/expectedPerformance.test.js` (new).

**App test hold:** Bench 185×8 @2 should know 185 historically expects closer to 10–12 reps @2 if data supports it.

---

## Roadmap Step 348 — Performance Deviation Detection (GitHub PR #349)
**Model:** Sonnet
**Status:** ⏳ In progress (GitHub PR #349)

**Goal:** Classify logged performance as above expectation, on target, below expectation, or insufficient data.

**Approach:**
- New `services/performanceDeviation.js`: `classifyDeviation(logged, expected)` → `{ verdict, delta, magnitude }`.
- `verdict` ∈ `above_expected | on_target | below_expected | insufficient_data`.
- Threshold: ≥2 reps above = above; ≤-2 reps = below; else on_target.
- Wire into `sanitizeFacts` / coach prompt so the LLM can reference it.

**Files touched:** `services/performanceDeviation.js` (new), `test/performanceDeviation.test.js` (new), wire into coach facts (`sanitizeFacts` + `sanitizeDeviation` in `services/coach.js`).

**App test hold:** Bench 185×8 @2 should flag below expected if history supports 185×10–12 @2.

---

## Roadmap Step 349 — Coaching Evidence Layer (GitHub PR #350)
**Model:** Sonnet
**Status:** ⏳ In progress (GitHub PR #350)

**Goal:** Coach remarks must cite the historical data used: recent sets, benchmark, date range, confidence.

**Approach:**
- Extend `sanitizeFacts` to include `evidence_context` with: `reference_sets[]`, `date_range`, `benchmark`, `confidence`.
- Extend coach system prompt: when evidence_context is present, coach MUST cite at least one reference ("Based on your last 4 bench sessions…").
- Evidence is engine-computed, never invented by the LLM.

**Files touched:** `services/coach.js` (`sanitizeEvidenceContext` + `sanitizeFacts` + system prompt), `test/coach.test.js` (15 new tests).

**App test hold:** Coach response includes "Based on your recent bench history…" with actual reference sets.

---

## Roadmap Step 350 — Working Weight Tracking (GitHub PR #351)
**Model:** Sonnet
**Status:** ⏳ In progress (GitHub PR #351)

**Goal:** Maintain current working weight and target rep/RIR range per lift.

**Approach:**
- Extend `services/exerciseBenchmark.js` (from PR 346) with a `resolveWorkingWeight(liftCode, rows)` function.
- Working weight anchors to the mode/median of the lifter's top-set weights from sessions where RIR was in the target zone (0–3).
- Falls back to all sessions when no in-zone RIR data exists (older logs without RIR recorded).
- Exposes as `working_weight` in `/api/recommend/next` and in coach facts.

**Files touched:** `services/exerciseBenchmark.js` (`resolveWorkingWeight` new function), `test/exerciseBenchmark.test.js` (new tests), `index.js` (wire into `/api/recommend/next` response), `services/coach.js` (`working_weight` added to `sanitizeFacts`, prompt updated).

**App test hold:** Bench working weight resolves around 225×5 @2, not the latest random test set.

---

## PR 351 — Trend Detection (GitHub PR #352)
**Model:** Sonnet
**Status:** ⏳ In progress

**Goal:** Detect improving, flat, declining, or noisy performance trends across recent exposures.

**Approach:**
- New `services/trendDetector.js`: `detectTrend(liftCode, rows)` → `{ trend, confidence, sessions_analyzed }`.
- `trend` ∈ `improving | flat | declining | noisy | insufficient_data`.
- Epley e1RM computed per session across working sets (same warm-up heuristic as exerciseBenchmark.js).
- Session window: last 8 sessions; minimum 4 required before emitting a trend verdict.
- `noisy` when coefficient of variation > 10 % (high variance, no clear direction).
- Direction: first-half mean vs second-half mean e1RM, threshold 2.5 % of overall mean.
- Wired into `GET /api/recommend/next` (`recommendation.trend`) and `sanitizeFacts` (`trend` field via `sanitizeTrend`).
- Coach system prompt updated: trend bullet instructs model to name the direction when present.

**Files touched:** `services/trendDetector.js` (new), `test/trendDetector.test.js` (new), `services/coach.js` (`sanitizeTrend` + `sanitizeFacts` + system prompt), `index.js` (read-only route), `test/coach.test.js`, `test/api-smoke.test.js`.

**App test hold:** Repeated lower-than-expected bench sessions show declining or fatigue trend only after enough data.

---

## PR 352 — Readiness Signals (GitHub PR #353)
**Model:** Sonnet
**Status:** ⏳ In progress

**Goal:** Infer possible fatigue/readiness issues from deviations without overreacting to one bad session.

**Approach:**
- New `services/readinessSignal.js`: `computeReadiness(trend, deviationHistory)` → `{ signal, confidence, note }`.
- `signal` ∈ `monitoring | possible_fatigue | likely_fatigue`. `note` ∈ `null | 'consecutive_below_expected' | 'sustained_declining_trend'`.
- streak 0 → monitoring/none. streak 1–2 → monitoring/low. streak 3+ → possible_fatigue/medium. streak 3+ + declining trend → likely_fatigue/high.
- `insufficient_data` entries break the streak (not enough info to count as below_expected).
- `sanitizeReadinessSignal` in coach.js whitelists vocab; monitoring/none collapses to null.
- Wired into `GET /api/recommend/next` (`recommendation.readiness_signal`) and `sanitizeFacts` via `rec.readiness_signal`.
- deviationHistory passed as empty array for now (no production deviation caller yet).

**Files touched:** `services/readinessSignal.js` (new), `test/readinessSignal.test.js` (new), `services/coach.js` (`sanitizeReadinessSignal` + `sanitizeFacts` + system prompt), `index.js` (read-only route), `test/coach.test.js`, `test/api-smoke.test.js`.

**App test hold:** One bad bench day says "monitoring," not "strength loss confirmed."

---

## PR 353 — Coach Memory
**Model:** Sonnet
**Status:** ⏳ In progress

**Goal:** Detect recurring patterns like repeated substitutions, missed lifts, or consistent underperformance.

**Approach:**
- New `services/coachMemory.js`: `detectPatterns(liftCode, rows)` → `{ patterns[] }`.
- Patterns: `repeated_substitution` (same swap ≥3 times in last 10 sessions), `consistent_underperformance` (below_expected ≥3 of last 5), `missed_lift` (planned but skipped ≥3 times).
- Returns empty array when no pattern — never noisy.
- Wire into coach chat context (not into the per-set note — this is a bigger picture signal).

**Files touched:** `services/coachMemory.js` (new), `test/coachMemory.test.js` (new), wire into `buildChatContext`.

**App test hold:** Repeated Deadlift platform substitutions noticed after multiple occurrences.

---

## PR 354 — Suggested Workout Engine
**Model:** STOP before implementation — ask whether to use Opus

**Goal:** Generate suggested workouts using recovery, recent training, benchmarks, trends, and program needs.

**Note:** This PR integrates PRs 346–353's signals into workout generation. The interaction between trend, readiness, memory, and program needs may require philosophical design decisions about how to weight competing signals. Stop and consult owner before writing any code.

**Scope to clarify before starting:**
- How to weight recovery vs. readiness vs. program need?
- What to do when trend=declining but program says increase?
- How to present uncertainty to the user?

**App test hold:** Suggested workout must explain why it chose the session.

---

## PR 355 — Coach Voice Polish
**Model:** Sonnet

**Goal:** Make final coach responses feel conversational, concise, and human while preserving evidence and deterministic logic.

**Approach:**
- Audit coach system prompt for any remaining clinical/robotic phrasing.
- Add rotating phrasings for common patterns (like the existing `VERDICT_VARIANTS` in coach-conversation.js).
- Ensure all new signals from PRs 349–353 are worded naturally when they appear.
- Add golden-output tests to the rubric.

**Files touched:** `services/coach.js`, `test/coach.test.js`.

**App test hold:** Atlas sounds like one coach, not a diagnostic report.

---

## Deferred / follow-up

Items discovered during implementation that don't belong in a specific PR above will be appended to `BACKLOG.md` in the same PR.
