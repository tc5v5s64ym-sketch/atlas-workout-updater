# Atlas Coach Voice Architecture Review — 2026-07-09

> **Status:** Active · Committed per `docs/SOUL_PLAN_V1.md` PR-A1. Every file:line citation spot-checked against the current tree (post-#925–#933 retest sweep). The analysis that follows is the foundation for the Part A and Part B Soul Plan PRs; do not re-litigate it inside those PRs.

---

## 1. Executive Summary

The Atlas coach voice has three independent layers. Two are durable; one is missing.

| Layer | State | Verdict |
|---|---|---|
| **Trust layer** — deterministic mode selection, whitelist grounding, degradation | Durable | Keep as-is; extend only |
| **Personality layer** — who the coach is, how it sounds | Fragmenting | Needs extraction (PR-A2) |
| **User-state layer** — the athlete's story (PRs, streaks, tenure) | Missing | Needs construction (PR-A7) |

The trust layer's architecture is sound and should not be restructured during the soul build. The personality and user-state gaps are the primary targets for Part A.

---

## 2. Trust Layer — Durable

**Mode selection** is deterministic and already tested. Three mechanisms work in concert:

- `coachNoteTier` (`services/coachNoteTier.js:129` — `classifyNoteTier`) decides whether a set is worth a note at all: `ack_only`, `brief`, `standard`, `elevated`, or `verbose`. Consumed by `services/batchNoteFacts.js:44`.
- `shouldReactToVerdict` (`services/coach.js:1395`) gates the set-reaction LLM fetch — returns `false` on clean-met, question-intent, suppressed, and no-verdict cases, so the model is never called when silence is the right answer. `test/coach-message-block.test.js:109–117` asserts this.
- `finalizeCoachVoice` (`routes/coachOps.js:332`) enforces a post-generation contradiction check: any response carrying a forbidden reason code is suppressed and replaced with the deterministic renderer's line. Called at lines 398, 477, and 482.

**Whitelist grounding** is enforced by two sanitizers:

- `sanitizeFacts` (`services/coach.js:87`) — strips the set-reaction context to a fixed allow-list before the model sees it. Field-level `numOrNull`/`strOrNull` throughout.
- `sanitizeChatContext` (`services/coach.js:820`) — equivalent for the chat route; handles `session_tally` (lines 951–966, extended by PR #933), `plan_state` (lines 915–923), `athlete_identity` (reserved slot, not yet forwarded).

**Degradation ladder** (`routes/coachOps.js`) is three-tier: LLM → `coachVoiceRenderer` deterministic line → `coachPolish` rewrite. Every tier degrades gracefully on error; no tier can produce a write or a fabricated number.

**Deterministic copy sources** (six, listed for the PR-A2/A6/B7 reconciliation pass):

| Source | File | Notes |
|---|---|---|
| Set-feedback voice | `services/coachVoiceRenderer.js` (~13 KB) | `renderSetVoice`, `renderSubstitutionVoice`; depends on `services/setEffortCopy.js` |
| Event renderer (dark — unwired) | `services/deterministicCoachRenderer.js` (~16 KB) | `renderCoachEvent` + `EVENT_TYPES`; comment at :1 marks it dark/deferred |
| Effort copy | `services/setEffortCopy.js` | `effortNote`, `rerouteNote`; required by `coachVoiceRenderer` |
| Client templates | `src/app/coachVoiceTemplates.js` (~10 KB) | 7 pure helpers (browser + Node UMD); `isBriefTier` at :152 |
| Verdict variants | `src/app/coach-conversation.js:1016–1042` | `VERDICT_VARIANTS` object (5 keys × 3 rotation variants); `coachOpener` at :1054 |
| Polish pass | `services/coachPolish.js` (~3 KB) | Optional Gemini rewrite; degrades to original; `numbersPreserved` guard |

These six sources carry copy that may contradict the persona core the Part A build establishes. A review-only pass is performed in PR-A2 (§4) and findings filed to `BACKLOG.md`; actual reconciliation is a later pass.

---

## 3. Personality Layer — Fragmenting

### 3.1 Two coaches in one file

`services/coach.js` contains two distinct persona definitions:

**Wired (active) — `:48`** inside `buildCoachSystemPrompt()`:
```
'You are Atlas, a sharp, encouraging strength coach talking to a lifter who just logged a set.'
```
This is what every user currently hears on set-reaction.

**Unwired (target) — `:1258`** inside `buildVerdictReactionSystemPrompt()`:
```
'Identity: you keep the logbook and you are not easily impressed. You speak only when there is something worth saying, and you say it straight — a direct training partner, never a hype man.'
```
This is the owner-ratified voice (`docs/ATLAS_VOICE_RATIFICATION_V1.md` §1a) that every governance document describes, but it has never been connected to a live path.

Every governance doc (`docs/COACH_PERSONALITY.md`, `docs/CONVERSATION_CONTRACT_V1.md`, `docs/DECISION_KERNEL.md`, `docs/ATLAS_VOICE_RATIFICATION_V1.md`) describes the `:1258` voice. The `:48` voice is a placeholder that predates the governance decisions.

### 3.2 Five prompt builders, persona copied five ways

Every prompt builder independently declares persona, iron rules, and shared constraints:

| Builder | Line | System prompt destination |
|---|---|---|
| `buildCoachSystemPrompt` | 43 | Set-reaction (wired, live) |
| `buildPlanSystemPrompt` | 446 | Plan narration (wired, live) |
| `buildChatSystemPrompt` | 619 | Coach chat (wired, live) |
| `buildCompileSystemPrompt` | 1196 | Compile/session summary (wired, live) |
| `buildVerdictReactionSystemPrompt` | 1255 | Verdict reaction (unwired — standing decision point) |

`services/coach.js` is 103 KB. The five inline prompt strings account for a large share of that bulk. Iron rules (IRON RULE on numbers, thin-history filler ban, anti-hype list, plain-text-only, never-writes) appear in some builders but not all — the set-reaction builder and chat builder carry the most complete rule sets; plan and compile are missing several.

Rules that are present only in some builders:
- **Anti-hype list** (no "beast mode", "crushing it", pet names, emoji, attendance praise) — present in set-reaction and chat; absent in plan and compile.
- **Thin-history filler ban** — present in chat; absent in set-reaction.
- **Never-writes rule** — present in chat and set-reaction; absent in plan and compile.

### 3.3 New RULE blocks (post-#925–#930 sweep)

The retest sweep added three inline RULE blocks to `buildChatSystemPrompt` — live evidence of the fragmentation pattern:

- **COMPLETION-CLAIM RULE** (`services/coach.js:632`) — prevents false session-complete claims unless `plan_state.isComplete` is true.
- **SESSION-IDENTITY RULE** (`services/coach.js:641`) — anchors answer scope to the current session.
- **SESSION-TALLY RULE** (`services/coach.js:642`) — mandates session-tally as the source for in-session count/weight questions.

These rules live only in the chat builder. If any future set-reaction or plan path needs equivalent protection, it would have to be copied again — the fragmentation would deepen.

### 3.4 Doc–code drift

`docs/COACH_PERSONALITY.md` and `docs/ATLAS_VOICE_RATIFICATION_V1.md` describe the ratified logbook-keeper persona with specific vocabulary, banned phrases, and register calibration. The `:48` wired identity ("sharp, encouraging") contradicts multiple ratification decisions (D2 buddy-direct, D4 earned relational). The code implements a persona the owner has explicitly superseded.

---

## 4. User-State Layer — Missing

**What's computed but not forwarded:**

- `detectRecentPrs` (`services/analytics.js:383`, exported at :2733) — per-lift PR history with dates and weights. Used in `routes/reads.js:514` (a read API) and `services/recommendationHistoryAdapter.js:48`. Never appears in `services/coach.js` or either sanitizer.
- `buildProgressSummary` (`services/analytics.js:2287`, exported at :2746) — session and volume trend summary. Wrapped in `services/trainingStore.js:37`. Never forwarded into any prompt builder or sanitizer context.

Neither `recent_prs` nor `progress_summary` nor any derivative key appears anywhere in `services/coach.js`.

**What this means in practice:** the coach has no access to "bench went from 185 in March to 225 today" or "you haven't missed a Monday in eight weeks." Every longitudinal claim in a coach reply is model improvisation over unlabeled history text — unverifiable, uncited, and potentially fabricated. The trust contract's cite-never-invent rule cannot be enforced until these facts are explicitly forwarded and whitelisted.

**Proposed fix:** `buildAthleteIdentity(logRows, { asOf })` in a new `services/athleteIdentity.js` — pure, fixture-tested, injected `asOf` (no `new Date()`), forwarded through `sanitizeFacts`/`sanitizeChatContext` as `athlete_identity`. See `docs/SOUL_PLAN_V1.md` PR-A7 for the full spec.

---

## 5. Recommended Sequence (cross-reference to Soul Plan)

| PR | Concern | Dependency |
|---|---|---|
| **PR-A2** | Extract `services/coachPersonaCore.js`; wire `:1258` identity into all five builders; delete `:48` placeholder | None (docs-only A1 is this doc) |
| **PR-A7** | `services/athleteIdentity.js` + sanitizer forwarding | PR-A2 (persona core carries the cite-never-invent rule for identity facts) |
| **PR-A4** | AC8(c) celebration-guard sweep | PR-A2 (tests reference the persona core) |
| **PR-A6** | Resolve the `buildVerdictReactionSystemPrompt` standing decision (fold or wire) | PR-A2 (persona core must exist before folding) |
| **PR-B1–B3** | Pure modules: mode enum, register permissions, celebration scarcity | PR-A2, PR-A7 |
| **PR-B4** | Wire mode + register into live paths | PR-A2, PR-A7, PR-B1, PR-B2, PR-B3, LT-007 PASS ✅ |

**Reconciliation pass (non-goals for PR-A2, filed to BACKLOG):** the six deterministic copy sources listed in §2 should be checked for persona conflicts after PR-A2 lands. Any copy that contradicts the core is a cosmetic finding for a later pass — not a blocker for the soul build.

---

## 6. Findings Committed to BACKLOG.md (this PR)

Per PR-A1 scope, the following items are filed as new backlog lines in the same PR:

1. **Persona-core extraction** (`[correctness]`) — authorized by `docs/SOUL_PLAN_V1.md` PR-A2 prompt.
2. **Persona doc–code drift reconciliation** (`[polish]`) — six deterministic copy sources vs ratified persona core; review-only pass after PR-A2.
3. **Athlete-identity facts object** (`[correctness]`) — `detectRecentPrs`/`buildProgressSummary` not forwarded to any prompt; authorized by `docs/SOUL_PLAN_V1.md` PR-A7 prompt.
4. **Engine-triggered challenge + reassurance modes** (`[correctness]`) — no tripwire in chat for drift patterns or discouragement language; authorized by `docs/SOUL_PLAN_V1.md` PR-B5a/B5b prompts.
5. **`generateVerdictReaction` / `buildVerdictReactionSystemPrompt` standing decision point** (`[correctness]`) — unwired since creation; fold-or-wire decision deferred to PR-A6.
