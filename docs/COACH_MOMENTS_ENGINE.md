# Coach Moments Engine — Design Spec

> **Status:** DRAFT FOR OWNER REVIEW — produced with Fable, 2026-07-06 (final Fable session). **Design/planning doc only: no code, no runtime changes.** Implementation lands later as tiny PRs (§9).
> **Decision class:** Coaching philosophy + product vision (owner-reserved forks in §10).
> **Trigger:** Owner brief, 2026-07-05 (voice): *"It could tell me, yo Dale, you just crushed that bench workout… last week you were doing this, and now you're doing this. That shows a real progression in strength… it triggered some sort of dopamine release."* And: *"It's not teaching me anything… that's the soul, I think, of Atlas."*
> **What this doc is:** The buildable bridge between the soul docs and the engine. `07-the-feel-of-atlas.md` says *what* great coaching feels like; the analytics engine already computes the raw truth; **nothing specifies how true facts become moments worth saying.** This is that spec.
> **Governance grounding:** `COACHING_NOTE_VOICE.md` (IRON RULE: the engine owns every number and verdict), `CONVERSATION_CONTRACT_V1.md` (silence is a move; brevity tiers), doc 07 (praise economy, Principles 40/47/83/87), `COACH_VOICE_VALIDATION.md` (tonal anchor), `ATLAS_UI_NORTH_STAR.md` (moments arrive as thread messages — no confetti, no badges), `REMEDIATION_PLAN_V2.md` (PR-13 wiring rules), capability manifest contract ("orchestrator holds no coaching rule").
> **Architecture is fixed:** Signals → **Moment Detection (deterministic)** → **Selection & Budget (deterministic)** → **Voice (words one moment, invents nothing)**. The LLM never detects, ranks, or upgrades a moment. It words the card it is handed.

---

## 1. The one-line design

**The Brain slips the coach one index card per turn — a true, ranked, cooldown-checked moment with its evidence attached — and the coach either speaks that card in his own voice or says nothing.** The dopamine is real because the claim is real; the praise lands because it is rare; the teaching sticks because it is attached to what just happened.

## 2. Why this is cheap: the signals already exist

The engine already computes nearly every input a moments layer needs. This spec adds **composition, not computation**:

| Moment ingredient | Already computed by |
|---|---|
| All-time and rep PRs | `analytics.detectRecentPrs`, `historicalBestByLift`, `sessionBestByLift` |
| Load/rep progression vs. comparable sessions | `computeExerciseProgress`, `progressionVerdict`, `progressionBand` |
| Beat-the-expectation detection | `expectedPerformance.computeExpectedPerformance` |
| Effort quality (clean sets at prescribed RIR) | `setEffortSignals`, `coachNoteTier` |
| Stall state and stall exits | `detectStalls`, `coverageStalls` |
| Fatigue / readiness context (when NOT to cheer) | `computeFatigueStatus`, `buildMuscleGroupReadiness`, deload state |
| Return-after-gap posture | `shortGapRestartNote` (no-guilt restart, already specced) |
| Session-level fact assembly precedent | `batchNoteFacts.assembleBatchNoteFacts` |
| Exercise pairing/teaching knowledge | `config/coaching/exercises/*.json`, `evidenceTiersModule` (currently unwired — this spec is its wiring purpose, per Remediation PR-13 allowlist rules) |

## 3. The moment catalog (v1 — seven types, three tiers)

Every moment defines: **trigger** (pure function of engine signals), **evidence payload** (the exact numbers, with provenance), **tier**, **cooldown key**. IDs are permanent; append-only (same rule as scenario IDs).

**TIER 1 — rare, big (at most ~1–2 per week of training, by construction):**
- **M1 · PR.** Trigger: `detectRecentPrs` fires on today's logged set (all-time load PR, or rep PR at a load). Payload: lift, today's set, the previous best and its date. Cooldown: per lift, until a new PR. *Voice shape: name the number, name what it beat, one line, stop.*
- **M4 · Stall broken.** Trigger: a lift `detectStalls` had flagged (≥N sessions no progress) posts a `progressionVerdict` of progress. Payload: stall length, the set that broke it. Cooldown: per lift per stall episode. *This is the highest-emotion moment in lifting; it must never be missed and never faked.*

**TIER 2 — the weekly bread and butter (the callbacks the owner described):**
- **M2 · Progression callback.** Trigger: today's top set beats the last *comparable* session on the same lift (same-load-more-reps, or more-load-same-reps, per `computeExerciseProgress` comparability rules), OR beats `computeExpectedPerformance`'s expectation band. Payload: both sets, both dates, the delta. Cooldown: per lift, 1 per session; suppressed if M1 fired on that lift (never stack praise on praise). *This is "same dumbbells as Thursday for one extra rep" — the exact dopamine loop from the brief.*
- **M3 · Quality streak.** Trigger: K consecutive sessions on a lift hitting all planned sets at prescribed RIR (from `setEffortSignals`), K≥3. Payload: the streak count and the sessions. Cooldown: re-arms at K+3. *Rewards consistency, not just peaks — doc 07's process-praise finding.*
- **M5 · Goal proximity.** Trigger: e1RM or top-set crosses a defined fraction of an owner-declared target (e.g. Bench/Squat 215×10@3 goal). Payload: current vs. target. Cooldown: per threshold crossed, once. **Owner fork F1 governs whether this fires unprompted.**

**TIER 3 — quiet value (teaching and context; capped hard):**
- **M6 · Teaching moment.** Trigger: today's session contains a lift or pairing with an attached knowledge card (from `config/coaching/exercises` + `evidenceTiersModule`), AND that card hasn't been taught in its cooldown window, AND no Tier 1/2 moment fired this turn. Payload: the card's claim + evidence tier. **Max one teach per session.** *Teaching is why the accessory is there ("dips already hit your triceps hard — that's why we don't chase isolation work"), stated once, tied to today, never a lecture.*
- **M7 · Comeback.** Trigger/behavior: exactly `shortGapRestartNote` — a gap is met with a plan, never an audit (Principle 87). Listed here only so the budget layer knows it exists; its spec lives in the opener doc.

## 4. The praise economy (budget rules — what makes it land)

1. **One moment per coach turn, maximum.** If several fire, the selector keeps the highest tier, then the most recent lift; the rest go to the ledger unspoken (a true moment unsaid today is still true tomorrow — but see rule 6).
2. **Silence is the default.** A normal set on a normal day gets the receipt and the coach's normal brevity-tier reply. Most sets are normal. That scarcity is the entire mechanism — praise inflation is the ChatGPT failure mode this engine exists to prevent (doc 07's information-to-praise ratio).
3. **Never cheer during a deload or an active safety/constraint lane.** Fatigue context (`computeFatigueStatus`, deload state) suppresses Tier 1/2 delivery; the moment is banked, mentioned when the block ends ("that deload paid for itself — look what bench did the week you came back").
4. **Never praise a set the safety rules flagged.** Pain flags, form-question lanes, and validation warnings mute the moments engine for that turn entirely.
5. **No stacking, no gamification chrome.** One moment = a few sentences in the thread. No badges, streper-fire animations, or counters (North Star §5; guilt/hype mechanics banned).
6. **Banked moments expire.** A moment older than its relevance window (default: the next session on that lift) is dropped, never delivered stale ("three sessions ago you…" is an archivist, not a coach).

## 5. Honesty rules (the iron rule, extended)

- **Every spoken claim maps to a payload number.** The voice layer receives the card's facts and a **claim ceiling** — the strongest sentence the evidence supports, pre-worded deterministically. The LLM may restyle it; it may never upgrade it ("solid jump" cannot become "incredible breakthrough") and never add a comparison the payload doesn't contain. Enforced the same way note-voice is: contract tests on the template layer + the existing whitelist pattern.
- **Provenance or silence.** No payload, no praise. The moments engine never reads the LLM's opinion of the workout.
- **Degrade honestly.** LLM down → the deterministic claim-ceiling sentence ships as-is (every moment type carries a terse template, same pattern as the opener floor).

## 6. Anti-repetition (why this coach won't go stale like ChatGPT did)

A small **moment-signature ledger** (same ring-buffer precedent as the opener's no-database ledger) records `{moment_id, lift, angle, date}` for the last N deliveries. On selection: a signature match forces either a *different true angle from the same payload* (the rep delta vs. the load delta vs. the e1RM read) or silence. Wording variety comes from the voice layer's normal seeded variation; **novelty never comes from inventing new claims.** Cooldowns in §3 are per-moment-class *and* per-lift, so "bench is moving" can't become a weekly catchphrase.

## 7. Pipeline and contracts (for the eventual builder)

1. **`services/momentsEngine.js`** (new, pure): `detectMoments(signals) → MomentCard[]` — no I/O, no LLM, fully unit-testable with fixture histories. Card shape: `{ id, tier, lift, facts[], claim_ceiling, cooldown_key, expires }`.
2. **Selector/budget** (pure, same module): applies §4 rules + ledger → `MomentCard | null`.
3. **Wiring:** a One-Brain **capability in the manifest** (post-promotion), feeding the existing voice/template layer exactly like `batchNoteFacts` feeds notes today. The orchestrator routes; it holds no moment rule (manifest contract).
4. **Shadow-first, like everything:** phase one logs would-have-said moments to the existing shadow ring; the owner reads a week of them before any moment is spoken live. The Brian pattern, reused.

## 8. What's genuinely new (build-cost honesty)

One new pure module (~small), manifest wiring, a handful of voice templates, ledger reuse, and contract tests. Zero new analytics, zero new endpoints' worth of computation, zero schema changes, zero trust-loop contact (moments are read-only speech). This also gives `evidenceTiersModule` (and possibly `missedLiftHistory`) their production wiring, converting PR-13 allowlist entries into shipped value instead of deletions.

## 9. Sequencing

After One-Brain promotion (Remediation PR-12A) so moments wire once, into the winning engine. Tiny-PR sketch: **MO1** `momentsEngine.js` + fixtures (pure, shadow-only) → **MO2** ledger + budget/selector → **MO3** voice templates + claim-ceiling contract tests → **MO4** manifest wiring, shadow mode, owner reads a week of would-be moments → **MO5** flip live. Each independently shippable; MO1–MO3 are buildable by Sonnet/Opus from this spec with no further design decisions.

## 10. Owner-reserved forks

- **F1 — Goal proximity (M5):** (a) coach mentions the 215 target unprompted at thresholds *(recommended — goals you declared are fair game)*; or (b) only when you ask.
- **F2 — Frequency dial default:** (a) budget as specced *(recommended)*; or (b) quieter (Tier 2 max every other session).
- **F3 — Teaching default:** (a) on, one per session max *(recommended — "it's not teaching me anything" was the complaint)*; or (b) only when asked.
- **F4 — Cross-lift narrative:** may the coach connect lifts in one moment ("bench and incline both moved — pressing as a whole is up")? (a) yes, when both payloads exist *(recommended)*; or (b) one lift per moment, always.

## 11. The gym test

Dale logs `205 6/2`. Receipt. The Brain checks the cards: no PR, but `computeExerciseProgress` says last comparable bench was 205×5@2, nine days ago. One Tier-2 card, no cooldown conflict, no deload, no safety flag. The coach: *"205 for 6 with two in reserve — nine days ago that was a 5. That's the third straight bench session moving. 215 is starting to look like a when, not an if."* One moment, three sentences, every number real. Next set is normal; the coach just receipts it. On Thursday, dips get the teach — once: why there's no tricep isolation in the plan. Saturday he breaks a six-week overhead press stall and the coach makes it feel as big as it is. **He wants to go back to the gym to see what it says.** That was the whole brief.

## 12. Doc disposition

Cites the soul docs; duplicates nothing; adds the one missing layer. On adoption: DOCS_INDEX → Active; `COACHING_NOTE_VOICE.md` and the Conversation Contract remain the governing voice law (this spec feeds them, never overrides them).

---

## Appendix — Owner's words this spec exists to satisfy (2026-07-05, verbatim)

> "You just crushed that bench workout… last week you were doing this, and now you're doing this. That shows a real progression in strength… it triggered some sort of dopamine release."

> "It would call me out. It would give me tips. It would teach me things."

> "I get excited and go to the gym so I can pump in a good set and see the feedback of why that's a good set."
