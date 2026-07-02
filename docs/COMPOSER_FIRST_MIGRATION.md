# Composer-First Migration — Adopted Design & Phase Plan

> **Status:** OWNER-ADOPTED 2026-07-02 ("I like it, build it") — the composer-first surface migration is now an active, phased build lane.
> **Governance layer:** Execution plan under the Vision/Constitution direction already codified in [`CONVERSATION_FIRST_DESIGN_REVIEW.md`](./CONVERSATION_FIRST_DESIGN_REVIEW.md) (verdict: consolidation, not pivot) and [`CONVERSATION_CONTRACT_V1.md`](./CONVERSATION_CONTRACT_V1.md) (how the coach behaves). This doc captures the adopted *surface design* and the *phase sequence* so neither lives only in chat.
> **What remains owner-gated inside the adopted plan:** the **Phase C input-LLM provider/model decision** (a second runtime LLM touchpoint = runtime-model selection, `docs/OWNER_CHECKIN_RULES.md` criteria 2/3), and each **Phase B/C/D promotion moment** (the owner triggers each phase's start; within a phase, PRs proceed automation-first). The trust loop, proof fields, `test_mode` semantics, slash-notation contract, and undo are untouched by every phase — Constitution law regardless of interface.

---

## The one-line design

**Not "a blank composer like ChatGPT" — a coach who speaks first.** The home screen is the moment your coach noticed you walked in: a one-line glance strip, a state-driven opening message, two or three chips that are *sentences*, and the composer. No tiles, no modes, no navigation decision before speaking.

ChatGPT is explicitly the wrong model in three ways (research source 07): it opens with a void (a coach has context and a plan), it is stateless (a coach who forgets is not a coach), and it answers everything with paragraphs (a coach's unit of speech is short, dense, then silence). The target feel is **texting your coach**.

## The home screen (adopted)

```
┌─────────────────────────────────────────────┐
│  ● 12-day streak · recovered · push day      │  ← glance line (1 row, tap→artifact)
├─────────────────────────────────────────────┤
│  (yesterday's thread scrolls above)          │
│                                              │
│  ATLAS                                       │
│  Thursday. Push day — you finished Tuesday's │
│  pull strong, and bench is due. 245×6 was    │
│  your last top set. Ready when you are.      │
│                                              │
│  [ Start push day ] [ Something else ]       │  ← chips = sentences, ≤3, state-chosen
│  [ How's my bench moving? ]                  │
├─────────────────────────────────────────────┤
│  [+]  Log a set or ask anything…        [↑]  │  ← the composer, always
└─────────────────────────────────────────────┘
```

- **Glance line** — the deliberate glance affordance the design review preserved: streak / readiness / today's context in one row; tapping expands the status artifact. Not a dashboard: one line, never competes with the thread.
- **Opening message** — generated **deterministically from engine state** (day, plan state, last session, readiness, layoff/deload state), worded by the voice layer, degrading to a terse template when the LLM is down. Changes with state: mid-workout → current lift; missed week → the no-guilt return (Contract rule 12); rest day → two words.
- **Chips** — a chip is a sentence the coach expects next; tapping it is identical to typing it (**one code path** — chips emit composer text). ≤3, rotated by state. Chips are how discoverability survives the tiles' death.
- **Composer** — unchanged, `+` for attachments, always present.
- **During a workout** — a pinned **session header** (current lift · sets done · next up) is the one persistent UI; everything else is thread.

## Intent principles (adopted)

1. **Confidence gates action; stakes set the bar.** Infer freely when a wrong guess costs conversation; never guess into a write.
2. **The trust loop IS the confirmation layer.** Because nothing writes without preview→Save, the router can be brave upstream. Confirm-by-showing (the preview/readback card) beats confirm-by-asking.
3. **At most one question, only when the answer forks the action.** Otherwise assume and state the assumption in one clause.
4. **Silence is a move; receipts are never silent.** Verbosity throttles commentary, never the `✅ logged` receipt.
5. **Misread recovery is the product:** acknowledge in a few words, discard anything staged, answer the real thing. No apology loops.

Freestyle/guided is **inferred posture, never a mode** (source 07 Part 3): set-tokens = log; interrogatives without set payload = question; imperatives/swap verbs = plan change; "just logging" = boundary honored silently; safety breaks silence at every posture.

## Surface disposition (adopted end-state)

| Today | Verdict |
|---|---|
| Coach's-Pick-vs-freestyle mode fork | Disappears — intent decides |
| Today's Pick card (Progress) | Disappears as a home — one canonical pick, in-thread |
| Intent grid tiles | Become conversation ("give me a hypertrophy day") |
| `#suggestion-chips` (deprecated) | Deleted — replaced by state-driven chips |
| Progress as a peer tab | Demoted (Phase B/D): computation stays; trends/history render as in-thread artifacts + glance expansion |
| Readiness strip / pattern board / weekly card | Glance line + coach reasoning + on-request artifacts |
| Greeting hero | Upgraded into the coach opening message |
| Composer, thread, readback, preview→approve→write, ✅ Saved + Undo | **Unchanged** |
| Finish-session button, Edit rows, date picker, effort form | Stay — as chips/artifact affordances |
| Settings / Debug / Hybrid Compare / bug report | Stay in Settings/Debug |

## Attachments (adopted)

The `+` is the universal "show, don't tell" verb; classification is the Brain's job. Watch screenshots → effort flow (with the date plausibility guard); workout screenshots/blocks → parsed sets → the same preview gate; voice = dictation into the composer when opened (a true voice interface stays on the not-build list until the owner opens it); future wearables emit IntentEnvelopes with no UI at all. Three rules: instant receipt of what Atlas saw; anything that writes goes through the preview gate; a failed parse degrades to honesty, never silence.

## First-week experience (adopted)

No onboarding — the first workout is the tutorial. Day 1 opens honestly ("Tell me what you did today, any way you like — I get smarter about you every workout") with one chip; the first log teaches the whole loop (say it → receipt → preview → Save). Days 2–4 run the fully-guided posture with per-lift calibration framed as coaching ("first few sessions I'm learning your numbers"). The engineered magic moment: the first unprompted cross-session memory. Day 7: a short evidence-based rollup, not a report card. The user learns exactly one thing: *start talking.*

## Phase plan (adopted sequence — engine before surface; never remove a button until the router beats it)

**Phase 0 — load-bearing engine (pre-authorized / active lanes):**
1. Remaining One-Brain surface promotions (coach chat, coach message, set reaction) — existing lane.
2. `analytics.js` migration (One-Brain item 8).
3. **Constraint Resolver** (missing keystone; pure module first) — prerequisite for "I'm travelling" / "30 minutes".
4. **PR-4 of the prototype lane** (tier-aware brevity in `public/coachVoiceTemplates.js`) — **authorized by the 2026-07-02 adoption**.
5. **Cold-start resilience** — dry-run-only retry-once + "waking up" copy (from the 07-02 diagnosis); composer-first makes first-request latency a first-impression requirement.

**Phase A — the coach speaks first (authorized 2026-07-02; additions only, no removals, one tiny PR each):**
6. Deterministic state-driven **opening message** (greeting hero upgrade; template-first).
7. **State-driven chips** through the normal composer path; retire `#suggestion-chips` in the same stroke.
8. **Glance line** (one row, tap-to-expand artifact).
9. **Session header pin** during active workouts.

*After Phase A the coach surface is fully composer-first with nothing removed — live in it before any demolition.*

**Phase B — collapse duplicates (adopted in principle; owner triggers the phase start after living with Phase A):**
10. One canonical recommendation (Coach's Pick in-thread; Today's Pick becomes a link into it).
11. Progress artifacts render inline on request (existing read-only endpoints, new render location).
12. Demote the Progress tab to glance-expansion/artifact space; the tab control disappears last, evidence-first.

**Phase C — NL Intent Router, shadow-first (BLOCKED on the owner's input-LLM provider/model/cost decision):**
13. Deterministic pre-router: existing parser/classifiers keep everything they already handle; the NL router sees only the fall-through. `225 5/2` stays on the deterministic hot path forever.
14. **Shadow mode** (the Brian pattern): router logs would-be routing, routes nothing.
15. Promote per intent class, most-reversible first: reads → plan mutations (readback-confirmed) → log routing (preview-gated).
16. Promotion criterion: beats the deterministic fallback's misroute rate on the conversation acceptance suite (P-001–P-025 / N-001–N-040) and in shadow logs. Buttons are never removed — they become chips; only the *requirement* to use them dies.

**Phase D — home = the conversation.** Remove the surface toggle; one screen remains.

## Three-year risks filed with the adoption (so they're owned, not forgotten)

1. **The thread is a poor long-term memory surface** — memory must surface as coach knowledge (source 06), not scrollback; budget for period-summary artifacts and cross-session references before year one ends.
2. **Typing at the gym is a this-decade behavior** — the IntentEnvelope, not the composer, is what future-proofs Atlas; the Brain stays surface-blind (Dream Tenet 3).
3. **Feature pressure on silence** — every new capability will want to talk; the Conversation Contract needs enforcement tests (fail when the coach gets chattier), or model upgrades sand it away.
4. **Routing quality is the product** — hence the phase order; Phase A delivers most of the feel with zero routing risk.
