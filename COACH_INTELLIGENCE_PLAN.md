# Coach Intelligence Plan

> Historical/reference-only. Do not execute this plan as the active roadmap.
> Use `BACKLOG.md` for priorities, `docs/ACTIVE_ROADMAP.md` for current execution, and `docs/AGENT_WORKFLOW.md` for process.

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

**Files shipped:** `index.js` (new `POST /api/suggest-substitute`, read-only), `config/routes.js`, `public/app.js` (`checkAndSuggestSubstitute` + submit-handler hook), `public/coach-conversation.js` (`handleSubstituteSuggested` + `atlas:substitute-suggested` listener), `test/api-smoke.test.js` (7 new smoke tests).

**Status:** ⏳ In progress (PR 344)

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

**Status:** ✅ Design complete (below)

---

### UI Audit — Current bubble inventory (post PR 344)

Six distinct Atlas surfaces exist in the conversation thread:

| Surface | Trigger | LLM? | Frequency |
|---|---|---|---|
| Suggested workout card | Tile click → `typeSuggestedWorkout` (cc.js:575) | Yes — plan voice | Once per session |
| Set readback + coaching | `atlas:set-logged` → `handleSetLogged` (cc.js:784) | Yes — set reaction | Per logged set |
| Substitution audit note | `renderSubstitutionNotes` (cc.js:921) inside set-logged or preview-ready | Yes — `voiceSubstitution` | Per detected substitution |
| End-of-session review | `atlas:preview-ready` → `handlePreviewReady` (cc.js:855) | No | Once per save |
| Substitute suggestion (PR 344) | `atlas:substitute-suggested` → `handleSubstituteSuggested` (cc.js:932) | No | Per constraint message |
| Coach chat reply | `atlas:chat-message` → `handleChatMessage` (cc.js:1221) | Yes — Gemini chat | Per chat turn |

### Friction points identified

**1. Suggestion → audit duplication (highest impact)**
Flow: User says "Platform busy" → substitute card appears ("Romanian Deadlift, Excellent match. Maintains hip hinge pattern."). User then logs RDL → audit appears ("Romanian Deadlift replaced Deadlift. Intent preserved."). The audit repeats what the suggestion card already said. Atlas sounds like two systems comparing notes rather than one coach following through.

**2. Two sequential LLM calls in one `handleSetLogged` bubble (latency + coherence)**
When a logged set includes a substitution, `handleSetLogged` fires `getInWorkoutNote` (set reaction → `/api/coach/message`) and then `renderSubstitutionNotes` → `voiceSubstitution` (substitution voicing → another `/api/coach/message`). Two round-trips produce two separately-voiced segments in one bubble — the set reaction and the substitution note can clash in tone. A single call with both facts would produce coherent prose and cut latency.

**3. Substitution concept rendered three ways (maintenance burden)**
- Pre-logging: deterministic `handleSubstituteSuggested` card
- Mid-session audit: `renderSubstitutionNotes` with optional Gemini voicing
- End-of-session audit: same `renderSubstitutionNotes` code, different context
Three code paths for one concept. The voicing inputs differ enough that full unification isn't warranted, but the framing could share a template.

### Keep / evaluate verdicts

- **Keep:** user message bubble, parsed workout trust card (preview/approve), end-of-session review, freestyle greeting, plan narration card (already one coherent structured block).
- **Evaluate for PR 345:** friction point 1 — suggestion acknowledgment in audit.
- **Evaluate for PR 346:** friction point 2 — collapse two LLM calls into one.
- **Defer:** friction point 3 — tri-path substitution rendering is a refactor, not a user-visible problem.

### Proposed architecture

**PR 345 — Substitute suggestion acknowledgment** (`public/coach-conversation.js` only)
Add a session-level variable `lastSuggestion = null` in coach-conversation.js. On `atlas:substitute-suggested`, store `{ prescribed, recommendation }`. In `handleSetLogged`, before passing the primary substitution to `getInWorkoutNote`, check whether both the logged exercise matches `lastSuggestion.recommendation` AND the prescribed exercise matches `lastSuggestion.prescribed`. If both match: omit the substitution from the LLM facts (clean set reaction only) and append a short deterministic ack ("Good call — you went with [logged]. Intent preserved.") after the note types out; clear `lastSuggestion`. Non-matching substitutions go through the normal LLM path unchanged. Note: `renderSubstitutionNotes` was removed by main's consolidation PR (PR #345 in the performance-intelligence series); the integration point shifted accordingly to `handleSetLogged`.

Scope: pure `coach-conversation.js`. No server changes, no trust loop, no schema change. One concern: `lastSuggestion` is session-scoped (in-memory), so a page reload clears it — acceptable; the suggestion card was only visible in that session anyway.

**PR 346 — Collapse set + substitution into one LLM call** (`coach-conversation.js` + minor `index.js` extension)
Extend the `/api/coach/message` `set` kind to accept an optional `substitution` field alongside `set` in `facts`. When both are present, the coach prompt produces a single voiced response covering the set reaction and the substitution acknowledgment. In `handleSetLogged`, detect whether substitutions are present and, if so, pass both to the combined call instead of making two separate requests.

Scope: `services/coach.js` (prompt extension), `index.js` (sanitizeSubstitution whitelist check — already whitelisted), `coach-conversation.js` (combined call logic). Does NOT touch the write path. Requires a new test in `test/coach.test.js` for the combined facts shape.

### Smallest safe PR sequence

1. **PR 345** — Suggestion acknowledgment. Pure client-side, lowest risk, directly addresses the most user-visible duplication. File: `public/coach-conversation.js`. **Status: ⏳ In progress.**
2. **PR 346** — Combined LLM call. Deferred — pay this complexity tax only if double-LLM latency is felt in practice.
3. **No PR for friction point 3** — the tri-path rendering is a refactor with no user-visible benefit today. Re-evaluate when a fourth substitution surface is added.
