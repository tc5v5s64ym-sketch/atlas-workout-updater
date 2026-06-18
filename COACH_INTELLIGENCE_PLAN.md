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

## PR 343 — Coach-Generated Substitution Recommendations

**Goal:** Atlas recommends substitutions before the user decides.

**Example:**
```
User: "Platform busy."
Atlas: Suggested substitute: Romanian Deadlift
       Reason: Maintains hip hinge pattern and posterior-chain stimulus.
```

**Requirements:**
- Deterministic recommendation rules.
- Reuse substitution quality data from PR 342.
- No LLM-generated exercise selection.
- Atlas must explain why the recommendation was chosen.
- Do not change workout logging, write path, or approval flow.

**Required tests:**
1. Deadlift constraint → RDL recommendation.
2. Squat constraint → Leg Press recommendation.
3. Unknown constraint → no recommendation.
4. Existing substitution logic unchanged.

**Deliverables:** Recommendation data layer. Recommendation engine. Tests. Documentation.

**Status:** ⏳ In progress (PR 343)

---

## After PR 343 — Coach Conversation Consolidation (Design Only)

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

**Status:** Not started — awaiting PR 343 review.
