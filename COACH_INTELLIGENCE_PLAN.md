# Coach Intelligence Plan

Phased build: planned-workout awareness → substitution quality scoring → coach-generated substitution recommendations → conversation consolidation design.

Operating rules for every PR: tiny single-concern PRs; verify before changing; reuse existing substitution infrastructure; golden fixtures hand-written; data before behavior; no write-path changes unless explicitly required; no sheet schema changes; no parser rewrites unless explicitly required; stop after opening each PR.

---

## PR 341 — Planned Workout Awareness

**Goal:** Atlas infers substitutions automatically from the planned workout, even when the user never explicitly says they made a substitution.

**Current behavior:** Substitutions are only detected when the user writes an explicit skip sentence ("Deadlift skipped - platform busy. Romanian Deadlift 245 7/2 x3").

**Target behavior:**

```
Planned:  Deadlift
Logged:   Romanian Deadlift 245 7/2 x3

→ Atlas detects: Deadlift → Romanian Deadlift
```

**Requirements:**
- Reuse existing substitution classification logic.
- Do not duplicate substitution rules.
- Determine the safest source of "prescribed" lifts from planned sessions.
- Preserve all existing explicit-substitution behavior.
- No UI changes.
- No coach wording changes.

**Required tests:**
1. Planned Deadlift + logged RDL → substitution detected.
2. Planned Squat + logged Leg Press → substitution detected.
3. Planned Bench + logged Bench → no substitution.
4. No active plan → existing behavior unchanged.

**Deliverables:** Failing tests first. Minimal implementation. Passing tests. Explanation of detection flow.

**Status:** ✅ Merged (PR 341)

---

## PR 342 — Substitution Quality Scoring

**Goal:** Atlas judges the quality of a substitution instead of merely detecting one.

**Examples:**
- Deadlift → Romanian Deadlift = excellent
- Back Squat → Leg Press = acceptable
- Bench Press → Pec Deck = poor

**Requirements:**
- Deterministic exercise knowledge only.
- Reuse existing movement-pattern and exercise-family data if available.
- No LLM reasoning. No invented classifications.
- Quality tiers: `excellent | acceptable | poor | unknown` (or equivalent if architecture suggests better naming).

**Required tests:**
1. Deadlift → RDL
2. Back Squat → Leg Press
3. Bench Press → Pec Deck
4. Unknown exercise pair
5. Existing substitution detection unchanged

**Deliverables:** Data layer first. Then scoring logic. Then tests.

**Status:** ✅ Merged (PR 342)

---

## PR 343 — Substitution Recommendation Service

**Goal (scoped):** Pure recommendation engine — `recommendSubstitute()` returns the best known alternative for a prescribed exercise, scored by `scoreSubstitutionQuality`. Includes a constraint-message detector (`isConstraintMessage`) for use by the visible integration in PR 344.

**Scope decision:** The visible integration (new API endpoint in `index.js` + constraint-detection + display wiring in `public/app.js`) touches two critical files and is larger than a single-concern PR. Deferred to PR 344.

**Deliverables shipped:**
- `services/substitutionRecommender.js` — curated catalog + quality-scored selection; catalog disciplined (no cross-pattern hinge→squat or compound→isolation entries).
- `services/constraintDetector.js` — pure keyword detector for unavailability messages.
- `test/substitutionRecommender.test.js` — 29 golden fixtures.
- `test/constraintDetector.test.js` — 24 fixtures covering required pipeline scenarios (all 6 from spec) + detector accuracy + quality floor.

**Status:** ⏳ In progress (PR 343)

---

## PR 344 — Visible Constraint Recommendation Integration

**Goal:** Atlas surfaces a substitute suggestion when the user types a constraint message ("Platform busy", "Rack unavailable") during an active planned session.

**Example:**
```
User: "Platform busy"
Atlas: Suggested substitute: Romanian Deadlift
       Reason: Maintains the hip hinge pattern and training stimulus.
```

**Requirements:**
- Use `isConstraintMessage` (PR 343) to detect constraint messages.
- Use `recommendSubstitute` (PR 343) to select the substitute.
- No LLM exercise selection.
- No write path changes. No sheet writes. No approval flow changes.
- If no active planned exercise, do not recommend.
- If `recommendSubstitute` returns null, do not invent a recommendation.
- Keep response concise.

**Files in scope:** `index.js` (new read-only endpoint), `config/routes.js`, `public/app.js` (constraint-detection path + display), `test/api-smoke.test.js` (new smoke tests).

**Status:** Not started — awaiting PR 343 review.

---

## After PR 344 — Coach Conversation Consolidation (Design Only)

**Goal:** Atlas feels like one coach speaking rather than multiple systems emitting separate cards.

**Keep:**
- User message
- Parsed workout trust card

**Evaluate:**
- Substitution card consolidation
- Coach narration consolidation
- Recommendation consolidation

**Deliverables:**
- UI audit
- Proposed architecture
- Smallest safe PR sequence

**No implementation. Plan only.**

**Status:** Not started — awaiting PR 344 review.
