# Onboarding + Working-Weight Discovery (B8) — Owner Review Pack #2

> **Status: DESIGN / REVIEW ONLY.** Not a roadmap promotion, not an implementation
> spec to execute. Produced by the Product / Voice / Fixture Lab for owner review.
> No production code, parser, write-path, schema, or prompt change is proposed here.
> Owner approval of this pack is the gate for any future onboarding build PR.
>
> **Engine-fact discipline (CLAUDE.md):** every number below traces to an engine
> function that already exists. Where a weight appears in an example it is either
> (a) **user-supplied** (the lifter stated it) or (b) **engine-derived** from a
> user-supplied reference via the named function. Atlas's voice layer invents no
> numbers; it only words what the engine computes.

Anchored engine facts (all already merged):

| Fact | Source | Value |
|---|---|---|
| Working-weight start hint | `buildWorkingWeightProtocol` (`services/analytics.js`) | `startHint = round(referenceWeight × 0.7 / 5) × 5`; null reference → "Start conservative" |
| Calibration protocol text | same | "work up in small steps until `targetReps` reps leaves you `targetRir` in reserve" (defaults reps 8, RIR 2) |
| Per-lift confidence ladder | `computeBenchmark` / `resolveWorkingWeight` (`services/exerciseBenchmark.js`) | 0 sessions → `none`; 1–2 → `low`; 3–4 → `medium`; ≥5 → `high` |
| Confidence factors object | PR 370 (`services/analytics.js`, `services/sessionBuilder.js`) | `{ sessions, data_age_days, trend, lift_confidence }` |
| Warm-up ramp | `buildWarmupRamp` (`services/sessionBuilder.js`) | 50% / 70% / 85% of working weight; reps 8 / 5 / 3 |
| Layoff / return guard | `assessLayoff` (`services/layoffGuard.js`) | volume_factor 1.0 / 0.8 / 0.66 / 0.5 by gap severity |
| Load sanity ceiling | `sanitizeLoad` (`services/loadSanity.js`) | rejects impossible prescriptions (per-lift cap; default ceiling 700) |
| Phantom-set floor | `classifyMessageIntent` (`services/messageIntent.js`) | unresolved lift → don't log; question → answer, log nothing; never celebrate an unlogged set |
| Tonal anchor | `docs/COACH_VOICE_VALIDATION.md` B8 | cold-start "I don't have your numbers yet" voice |

---

## 1. Why onboarding matters

### What Atlas loses when no historical data exists

Atlas's entire intelligence layer is a function of `Log_Cleaned` rows. With zero
history, every derived signal degrades to its `none` state:

- **No working weight.** `computeBenchmark` / `resolveWorkingWeight` return
  `{ weight: null, confidence: 'none', sampleSize: 0 }`. The recommender has no
  load to prescribe.
- **No trend / e1RM trajectory.** `detectTrend` → `insufficient_data`. Progression,
  trend-aware scoring (PR 368) and readiness dose (PR 369) have nothing to read.
- **No verdict context.** `computeExpectationVerdict` needs a prescribed load to
  compare against; with no baseline there is nothing to "beat" or "fall short" of.
- **No coverage / balance history.** `weeklyMuscleVolume`, `computeUnderCoverage`,
  `computeBalanceSignal` all read prior volume; empty → no gaps, no balance call.
- **No deload / fatigue signal.** Stalls and recovery are history-derived; absent.

The credibility risk: if Atlas *acts* confident with no data, it violates the trust
contract on day one. The phantom-set floor (AC8) and the B8 voice exist precisely so
Atlas does not fabricate authority it has not earned.

### Minimum information Atlas needs before recommendations are trustworthy

Recommendations become trustworthy **per lift**, not globally. The minimum is:

1. **A working weight for that lift** — one honestly-logged set at a known RIR.
   This moves the lift from `none` → `low` and gives the recommender a real anchor.
2. **Effort honesty (RIR).** A logged weight without RIR tells Atlas the load but not
   the headroom; the calibration protocol explicitly asks for "reps left in reserve."
3. **≥3 sessions for that lift** to reach `medium` confidence — the point at which
   `computeBenchmark` exposes a stable `workingWeight`, `repRange`, and `rirRange`.

Optional, accelerating (never required, never interrogated — Someday guardrail):

- A **user-stated reference** ("I usually bench around 185") → feeds
  `buildWorkingWeightProtocol`'s `referenceWeight` so the start hint is 70% of it
  instead of "Start conservative." Speeds discovery; does **not** raise confidence
  (confidence is session-count based — a stated number is not a logged set).
- A **training goal** (`getProfileGoal` / goal classifier) → biases intent ranking
  once data exists. Cosmetic during calibration.

---

## 2. Calibration strategy

### How Atlas finds working weights

Per lift, via `buildWorkingWeightProtocol`:

- **With a user reference:** `startHint = round(reference × 0.7 / 5) × 5`. The 70%
  anchor is deliberately conservative — "always safer to step up than to miss a rep
  on an unfamiliar movement" (engine comment). Voice: *"Start around {startHint} lbs
  and work up in small steps until {reps} reps leaves you {rir} in reserve."*
- **Without a reference:** `startHint = null`, phrase = "Start conservative." Same
  work-up protocol; the user discovers the weight by feel against the RIR target.
- The **first set that meets the rep + RIR target becomes the logged working weight**
  for that lift — the seed data point.

### Number of sessions required & confidence after each (per lift)

Driven entirely by the `exerciseBenchmark.js` ladder — **this is the spine of the
whole pack**:

| Logged sessions for the lift | `confidence` / `lift_confidence` | What the engine can do | Atlas's stance |
|---|---|---|---|
| 0 | `none` | nothing — no `workingWeight` | "I don't have your numbers yet" (calibration) |
| 1 | `low` | a provisional anchor; high variance | "still dialing this in" |
| 2 | `low` | anchor + one confirmation | "still dialing this in" |
| 3 | `medium` | stable `workingWeight` + `repRange` + `rirRange` | "here's what I recommend" (graduated) |
| 4 | `medium` | as above, firmer | normal coaching |
| ≥5 | `high` | full trend / readiness / verdict stack | full-confidence coaching |

### When Atlas transitions from calibration mode to normal coaching

**Per lift, at `medium` (3rd logged session).** Calibration mode is therefore not a
global switch the user flips — it dissolves lift-by-lift as each movement crosses
into `medium`. A user can be "graduated" on bench while still "calibrating" on
deadlift. Session-level framing: roughly **the first three sessions feel like
calibration** because most lifts are still `none`/`low`; by session 3 the core
compounds reach `medium` and the tone flips for them. (See §7 for the exact rule.)

---

## 3. Session design — first three onboarding workouts

Design goal: **maximum confidence accrual per session across the major movement
patterns**, because confidence is per-lift and the ladder rewards repeated exposure.
Full-body calibration beats a split here — a split would need 6+ sessions to get any
lift to `medium`; full-body gets the core compounds to `medium` in 3.

Rep target **8 reps @ ~2 RIR** throughout — this is the `buildWorkingWeightProtocol`
default and the cleanest signal for a benchmark (moderate load, clear RIR read).
"Next weight" is chosen deterministically by the existing verdict→recommender path,
never by the voice:

> **Next-weight rule (deterministic, existing engine):** read the logged set's RIR
> vs the 2-RIR target via `computeExpectationVerdict`. `fell_short`/failed → repeat
> or step down; `met` (RIR ≈ 2) → repeat or tiny step up; `beat`/sandbag (RIR ≥ 4,
> the A6 "Below" case) → step up. `recommendNextSet` picks the actual number;
> `sanitizeLoad` caps anything impossible. The voice only words the result.

### Session 1 — "Map the big patterns"
| Slot | Pattern | Example lift | Target | Data collected |
|---|---|---|---|---|
| Anchor | Squat | Back/Goblet Squat | 2×8 @ 2 RIR | quad/squat working weight → `low` |
| Push | Horizontal push | Bench / Chest Press | 2×8 @ 2 RIR | push working weight → `low` |
| Pull | Horizontal pull | Row / Lat Pulldown | 2×8 @ 2 RIR | pull working weight → `low` |
| Hinge | Hinge | RDL (light) | 2×8 @ 2 RIR | hinge working weight → `low` |

- **Progression logic:** each lift uses `buildWorkingWeightProtocol` (start hint or
  "start conservative"), works up to the first 8 @ 2-RIR set; that set is the seed.
- **How next weight is chosen:** n/a within S1 (discovery by feel against RIR). The
  *seed* sets S2's start.
- **What Atlas is collecting:** one data point per major pattern → four lifts at
  `low`. No warm-up ramp yet (no established working weight to ramp from).

### Session 2 — "Confirm and nudge"
| Slot | Lift | Target | Next-weight source |
|---|---|---|---|
| Repeat core 4 | S1 lifts | 2×8 @ 2 RIR | deterministic rule above, from S1's logged RIR |
| Widen | Overhead press + one arm isolation (curl or pushdown) | 2×8 @ 2 RIR | start hint / conservative |

- **Progression logic:** repeated lifts step per the verdict of S1; new lifts seed at
  `low`.
- **What Atlas is collecting:** second data point on the core (still `low`, but now
  with a *consistency* read), first data point on two more lifts.

### Session 3 — "Cross into medium"
| Slot | Lift | Target | Effect |
|---|---|---|---|
| Repeat core 4 | S1/S2 lifts | 8 @ 2 RIR, now with warm-up ramp | **3rd session → `medium`** → graduates |
| Repeat widen | OHP + isolation | 2×8 @ 2 RIR | reaches `low`→ second point |

- **Progression logic:** core lifts now have a stable `workingWeight`; `buildWarmupRamp`
  (50/70/85%, reps 8/5/3) is available and used.
- **What Atlas is collecting:** the third data point that flips the core compounds to
  `medium` — calibration mode ends for them; normal recommendations begin.

---

## 4. User experience — example coach conversations

Communicating uncertainty **without sounding weak**: Atlas states plainly what it
does and doesn't have, frames calibration as *the process working*, and never
apologizes for lacking data it could not have. (Voice anchor: B8.)

### Beginner (no history, no reference)
> **User:** First time using this. Where do I start?
> **Atlas:** Honestly — I don't have your numbers yet, so today isn't about chasing
> anything. It's calibration. We'll find weights where 8 reps leaves you about 2 in
> reserve, you log them straight, and the coaching sharpens every session. Start
> conservative on the squat and work up in small steps. Three sessions in, I'll have
> real recommendations instead of guesses.

*Engine basis:* `confidence: none`; `buildWorkingWeightProtocol` with null reference
("Start conservative"); ladder graduation at session 3.

### Intermediate (gives a reference)
> **User:** I usually squat around 225 for reps.
> **Atlas:** Good — that gives me a starting point. I'll open at around 160 and we
> work up until 8 reps leaves you 2 in reserve; that lands your real working set for
> my records. I'm starting under your 225 on purpose — it's safer to add than to miss
> a rep while I'm still learning your numbers. One clean session and this stops being
> a guess.

*Engine basis:* `referenceWeight = 225` → `startHint = round(225×0.7/5)×5 = 160`.
Confidence stays `low` after one logged session (a stated number is not a logged set).

### Advanced (gives an exact recent working weight)
> **User:** My bench working sets are 275×5 at about 1 RIR.
> **Atlas:** Clean input — that speeds this up. I'll still open conservative at ~195
> and ramp, because I'm calibrating my own record of you, not testing what you can
> do. You'll be at your real working weight inside one session, and because your
> input is precise I'll lean on it fast. I won't call it a verdict until I've seen a
> few logged sessions, but I'm not going to insult you by pretending we're starting
> from zero.

*Engine basis:* `referenceWeight = 275` → `startHint = round(275×0.7/5)×5 = 195`.
Confidence is still session-count gated; the voice acknowledges input quality without
overclaiming a `medium`/`high` it hasn't earned.

**Uncertainty-without-weakness rules (locked):** state what's known vs estimated;
frame calibration as the system working, not a deficiency; never apologize for
absent data; never fabricate a number or a confidence level; one honest sentence
beats three hedging ones.

---

## 5. Failure modes

| Mode | Engine handling (exists) | Onboarding behavior |
|---|---|---|
| **User massively overestimates** (reference too high) | start hint = 70% of *their* number is already a hedge; failed reps → `computeExpectationVerdict: fell_short` → recommender steps down; `sanitizeLoad` caps impossible loads | Atlas drops the next target without drama (A7 "missing reps is data" register); never lets a fantasy 1RM drive load |
| **User massively underestimates** (sandbags) | RIR ≥ 4 logged → A6 "Below" verdict → recommender steps up; within-session "work up in small steps" self-corrects same day | Atlas nudges load up and names the sandbag plainly (A6 register) |
| **Missed sessions mid-calibration** | `assessLayoff` (gap severity → volume_factor); per-lift gap rule (>10 days → repeat weight, ≥7 → note) | Calibration **pauses, never resets** — logged data points persist; Atlas eases back in, doesn't restart the ladder |
| **Equipment limitations** | substitution literacy (B1/B2/B4); confidence is per-lift | Calibrate only the lifts the equipment supports; unsupported lifts simply stay `none` until trainable |
| **Incomplete workouts** | confidence accrues **per logged lift**, not per session | A partial session still advances the lifts that were logged; no all-or-nothing penalty |
| **Injury / pain flag** | pain stops load coaching (A5/B11/B17); redirect to pain-free work | Atlas suspends calibration on the painful pattern, keeps the day productive elsewhere, resumes when clear |
| **Home-gym users** | per-lift model + substitution; load sanity | Calibrate the available movements; dumbbell-only changes the *how* (B9) not the validity of the data |

Cross-cutting guard: the **phantom-set floor** (AC8 / `classifyMessageIntent`) — an
unresolved lift name is not logged, a pure question logs nothing, and Atlas never
celebrates a set that wasn't recorded. Onboarding must not weaken this to "seem
helpful" to a new user.

---

## 6. Trust contract (onboarding)

**What Atlas KNOWS** (facts, stated as facts):
- The exact sets logged to `Log_Cleaned` — weight, reps, RIR, date — and nothing
  about the lift beyond what was logged.

**What Atlas ESTIMATES** (always carries a confidence level; never stated as fact):
- Working weight, `repRange`, `rirRange` (`computeBenchmark` — `none`/`low`/`medium`/`high`).
- Trend / e1RM trajectory (`insufficient_data` until enough sessions).
- Readiness / fatigue dose (history-derived; quiet during calibration).
- The 70% start hint — explicitly a conservative *starting point*, not a prescription.

**What Atlas REFUSES TO ASSUME:**
- A working weight for a lift with **0 logged sessions** (`none` → no number offered).
- That a **user-stated max/working weight is real** until it's logged honestly (it
  seeds a start hint, never a confidence level).
- **Form / rep quality from rep counts** (B14 — no objective signal exists; never
  inferred).
- That a **missed or added set happened** (AC8 phantom-set floor).
- A **goal or readiness state from a feelings prompt** — Atlas never interrogates
  (Someday guardrail); it infers from logged behavior.

---

## 7. Graduation criteria — the exact switch

**Per lift, deterministic, session-count based** (`exerciseBenchmark.js` ladder):

```
lift_confidence ∈ { none, low }  →  Atlas says: "we're still learning / I don't have your numbers yet"
lift_confidence == medium  (≥3 logged sessions)  →  Atlas says: "here's what I recommend"
lift_confidence == high    (≥5 logged sessions)  →  full-confidence coaching (trend, readiness, verdicts)
```

- The switch fires the moment a lift records its **3rd logged session** — because
  that is exactly where `computeBenchmark` begins returning a stable
  `workingWeight` + `repRange` + `rirRange`.
- It is **per lift**: Atlas may recommend on bench (medium) while still calibrating
  deadlift (low) in the same conversation. No global "onboarding complete" flag is
  required by the engine.
- **No new threshold is invented.** Graduation is the existing `medium` boundary,
  surfaced as a copy/tone change — not a behavior change to the recommender.

Owner decision flagged for §"What needs owner approval": whether the *session-level*
copy ("you're in calibration") should additionally gate on "majority of today's lifts
are still `low`/`none`," or stay purely per-lift. Recommendation: **purely per-lift**,
with an optional session-level banner that reads the per-lift states — no new engine
signal needed.

---

## 8. Acceptance fixtures (deterministic — future PRs must satisfy)

These pin the **existing engine outputs** the onboarding wiring must respect. They are
expressed as input → exact output so an implementation PR's tests can assert them.
(The functions already behave this way; the fixtures lock the onboarding layer to
them so it can never drift into invented numbers or confidence.)

**F1 — start hint from a reference**
`buildWorkingWeightProtocol({ targetReps: 8, targetRir: 2, referenceWeight: 185 })`
→ `startHint === 130`, instruction begins `"Start around 130 lbs and work up..."`
(185 × 0.7 = 129.5 → round to 5 → 130.)

**F2 — start hint with no reference**
`buildWorkingWeightProtocol({ referenceWeight: null })`
→ `startHint === null`, instruction begins `"Start conservative and work up..."`

**F3 — reference rounding cases**
- `referenceWeight: 225` → `startHint === 160` (157.5 → 160)
- `referenceWeight: 275` → `startHint === 195` (192.5 → 195)
- `referenceWeight: 100` → `startHint === 70` (70 → 70)

**F4 — per-lift confidence ladder (graduation boundary)**
For a single lift's history through `computeBenchmark`:
- 0 sessions → `confidence === 'none'`, `weight === null`
- 1 session  → `confidence === 'low'`
- 2 sessions → `confidence === 'low'`
- 3 sessions → `confidence === 'medium'`  ← **graduation point**
- 5 sessions → `confidence === 'high'`

**F5 — confidence_factors shape on every suggested exercise**
Each exercise from `scoreIntents` / `buildIntentSession` carries
`confidence_factors: { sessions:Number, data_age_days:Number|null, trend:String, lift_confidence:'none'|'low'|'medium'|'high' }`.

**F6 — copy gate (onboarding voice, to be wired)**
- `lift_confidence ∈ {none, low}` → narration MUST NOT present a load as a
  recommendation/verdict; it may only present a calibration *start hint*.
- `lift_confidence ∈ {medium, high}` → narration MAY present a recommendation.
- No path emits a numeric load that did not come from `buildWorkingWeightProtocol`,
  `recommendNextSet`, or `computeBenchmark` (no voice-invented numbers).

**F7 — warm-up ramp availability**
`buildWarmupRamp(workingWeight)` → 3 sets at 50/70/85% (reps 8/5/3); MUST NOT be
offered when no working weight exists (lift at `none`).

**F8 — phantom-set floor holds during onboarding**
A new user's unresolved lift name ("zercher thrust 95 8/2") → `classifyMessageIntent`
`reason: 'unresolved_lift'`; a pure question logs nothing; no celebration of an
unlogged set. Onboarding must not relax AC8.

---

## Owner-approved decisions (2026-06-20)

The owner approved this pack **as-is** with these calls (locked — do not re-litigate
in a build PR; changing them is an owner decision):

1. **Full-body × 3 sessions** is the approved default cold-user onboarding shape.
2. **Graduation is per-lift at `medium` (3 logged sessions), copy-only.** Atlas must
   **not** imply the user is fully dialed in at graduation.
3. **The three example conversations** (beginner / intermediate / advanced, §4) are
   approved as the voice reference.
4. **Per-lift calibration state only — never majority-gated.** If squat is calibrated
   and deadlift is unknown, Atlas must say that clearly rather than averaging them
   into one session-level "we're still learning."
5. **A user-stated number seeds the start hint but never raises confidence.**
   Confidence comes only from logged sessions (the `exerciseBenchmark` ladder).

Routing: the approved implementation sequence (PR-O1 → PR-O4, intake/goals deferred)
is recorded in `BACKLOG.md` under "New-user onboarding + working-weight discovery
(B8)". Not promoted to `docs/ACTIVE_ROADMAP.md` — no roadmap reorder. Build only when
the owner promotes it.

## What needs owner approval

1. **Calibration = full-body × 3 sessions** (vs a split) as the default onboarding
   shape, on the rationale that the per-lift `medium` boundary is reached fastest
   this way.
2. **Graduation is per-lift at `medium` (3 sessions)**, surfaced as copy/tone only —
   no new engine threshold.
3. **The three example conversations** (beginner / intermediate / advanced) as the
   onboarding voice reference, incl. the "uncertainty without weakness" locked rules.
4. **Session-level calibration banner**: per-lift only (recommended) vs. additionally
   gated on the session's majority confidence state.
5. **Reference handling**: a user-stated number seeds the start hint but never raises
   confidence — confirm this is the intended trust stance.

## Recommended future implementation sequence (NOT to execute now)

Deterministic-engine-first, voice-second, tiny PRs — **only after owner approval**:

1. **PR-O1 (engine, pure):** `services/onboardingState.js` — derive a per-lift
   `calibration_status` (`calibrating` | `graduated`) purely from the existing
   `lift_confidence` ladder. No new data, no schema, no write path. Golden fixtures
   F4/F5.
2. **PR-O2 (engine, pure):** onboarding session template builder that emits the
   §3 full-body calibration plan from available equipment + optional reference,
   reusing `buildWorkingWeightProtocol` / `buildWarmupRamp`. Fixtures F1–F3, F7.
3. **PR-O3 (voice gate):** copy gating in the coach surface keyed off
   `calibration_status` — calibration phrasing for `none`/`low`, recommendation
   phrasing for `medium`/`high`. Fixtures F6; voice corpus from §4. Owner-gated
   (coach surface).
4. **PR-O4 (UX):** surface the calibration state to the user (banner / first-run
   flow). Frontend-only.
5. **Deferred to BACKLOG (not built):** pre-session reference/equipment intake UX
   (must honor the no-interrogation Someday guardrail); goal capture at onboarding.

Phantom-set floor (AC8) and load sanity are **preconditions**, already shipped — no
onboarding PR may weaken them.

---

*End of Owner Review Pack #2. No code, no PR, no merge — awaiting owner review.*
