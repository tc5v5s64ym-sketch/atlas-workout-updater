# Atlas Training Profile Taxonomy

> **Governance layer:** Vision / Dream-serving **planning spec** — see [`docs/GOVERNANCE.md`](GOVERNANCE.md).
> **Status:** PLANNING ONLY. No production behavior, write path, parser, or Sheet schema changes here.
> **Activation:** owner-gated. Nothing in this doc enters the active roadmap until the owner promotes it
> (`docs/OWNER_CHECKIN_RULES.md`). It is filed in `BACKLOG.md` as deferred, not active.

---

## 0. Why this doc exists

Atlas today is shaped around **one lifter's style**: gym-based progressive overload expressed as
`weight × reps @ RIR`. That is the right way to *prove the coach feel* with a real user, but the Dream
([`docs/ATLAS_PRODUCT_VISION.md`](ATLAS_PRODUCT_VISION.md) → "The Dream") is a **training-intelligence
engine for fitness** — many users, many styles: strength, hypertrophy, general fitness, cardio/endurance,
bodyweight/calisthenics, and mixed.

**Core principle:** *Atlas adapts to the user's training style. It must not force every user into the
RIR-based barbell model.* RIR is excellent for resistance training and near-useless for steady-state
cardio. The engine must know which lens to apply, per exercise, per user.

This doc defines the first five training profiles, a deterministic model for representing a user's style
as **profile scores** (not one fixed label), and a phased, engine-first build plan. Every proposed verdict
must be **explainable** from logged data, the user's profile, the exercise's modality, recent history, or
onboarding answers — never an opaque AI call.

### Current-state verification (read before building any slice)

What already exists in the repo (the plan **extends** these — it does not reinvent them):

| Concept | Where it lives today | Gap this doc addresses |
|---|---|---|
| Training goals (`strength`, `hypertrophy`, `power`, `conditioning_fat_loss`, `muscular_endurance`, `general_health`, `recovery`, `mixed`), each with a `failurePolicy`, rep/load bias, exercise order | `services/trainingKnowledge.js` (`TRAINING_GOALS`) | Goals are **resistance-centric** and selected as a **single label**, not a multi-axis vector; there is **no cardio modality** and **no non-RIR effort metric**. |
| Single persisted goal label (env `ATLAS_PROFILE_GOAL` → `normalizeTrainingGoal`) | `services/profileGoal.js` | One label per install. No profile **scores**, no learning from logs, no onboarding classifier. |
| Exercise types (`compound`, `isolation`, `machine`, `bodyweight`, `power`, `unknown`) | `services/trainingKnowledge.js` (`EXERCISE_TYPES`) | No `load_type` / `fatigue_class` / `effort_metric` / `progression_metric` modality fields; no cardio/timed/interval/circuit types. |
| Movement pattern + muscle coverage | `services/movementPattern.js`, `services/muscleCoverage.js` | Reusable as-is for the modality schema. |
| Cardio-adjacent fields (`duration`, `active_calories`, `total_calories`, `average_hr`, `peak_hr`, `location`) | `Effort` tab, `config/columns.js` (`effortColumns`); `effortIntensityBySession()` in `services/analytics.js` | Effort rows exist but are **session-level Apple-Watch summaries**, not **per-exercise cardio logs** with pace/zone/intervals. |
| Slash notation `225 5/2` = 225 lb × 5 reps @ RIR 2; bodyweight rep parsing | `services/workoutTextParser.js` | Parser only understands the resistance grammar; no duration/distance/pace/zone/rounds tokens. **Owner-gated** (slash-notation contract, `docs/INVARIANTS.md`). |
| Readiness / recovery / fatigue by muscle + deload protocols | `services/analytics.js`, `services/coverageStalls.js`, `services/deloadProtocols.js`, `docs/DELOAD_SPEC.md` | Recovery model is resistance-only; no cardio-load or circuit-density fatigue routing. |

**Verdict: `STILL OPEN / NOT BUILT`.** No training-style taxonomy, profile-score model, modality schema,
onboarding classifier, or cardio-aware effort metric exists. This doc is the plan; no slice is built here.

### What this plan does **not** do (scope fence)

- It does **not** introduce **multi-user** support. It makes the **single-owner** engine *style-adaptive* —
  a stepping stone toward the Dream, consistent with the Vision guardrail "no multi-user or platform work is
  active until the owner explicitly directs it." Multi-style ≠ multi-user.
- It does **not** change `Log_Cleaned` (12 columns), `Effort` (9 columns), the preview→approve→write trust
  loop, `test_mode`/proof-field semantics, the slash-notation contract, or the undo flow. Any of those is a
  schema migration / high-risk change requiring **explicit owner approval** (`CLAUDE.md` "Critical
  behaviours"). Where a future slice would need one, it is flagged inline as **[owner-gated migration]**.
- It does **not** add nutrition, voice interface, a second database, or autonomous-agent mode
  (`CLAUDE.md` "What not to build").

---

# Part A — The five training profiles

Each profile below documents: target user · primary goal · common exercises · best effort/intensity
metrics · how fatigue appears · how RIR should/shouldn't be used · progression rules · deload/recovery
triggers · coach voice examples · example logs · test fixture ideas.

Mapping to today's `TRAINING_GOALS`: profiles 1–2 map cleanly to `strength` / `hypertrophy`; profile 3 maps
to `general_health` (+ `conditioning_fat_loss`); **profile 4 (cardio) has no engine home today** — it is the
biggest genuinely new modality; profile 5 (bodyweight/circuits) spans `general_health` / `muscular_endurance`
/ `hypertrophy` plus a new **load_type + density** dimension.

---

## Profile 1 — Strength / barbell performance

- **Target user:** powerlifting-leaning or strength-focused lifter; wants the big lifts to go up.
- **Primary goal:** maximal force production — raise 1–5RM on squat / bench / deadlift / press.
- **Common exercises:** back/front squat, competition + variation bench, conventional/sumo deadlift, overhead
  press, weighted dips, heavy rows, accessory hinge/lunge; low-rep, high-load.
- **Best effort/intensity metrics:** **load (% 1RM / absolute weight)** is primary; **RIR** as a secondary
  autoregulation signal; estimated 1RM trend (e1RM) as the progress signal. Top-set + back-off structure.
- **How fatigue appears:** central/CNS fatigue — bar speed drops, RIR estimates climb at the same load, top
  sets feel heavier day-to-day, technique degrades before reps are lost. Recovery between heavy compound
  exposures is days, not hours.
- **How RIR should be used:** **Conservatively.** Strength work lives at **RIR 1–3** on main compounds;
  **RIR 0 (failure) on heavy compounds is high-fatigue and should usually *block* progression** rather than
  earn it (grinding a max single is a fatigue event, not a green light). Evidence: strength gains are
  primarily **load-driven**, and training to failure offers little strength advantage while adding
  recovery cost (Refalo 2023; ACSM progression model). Failure is acceptable, occasionally, on light
  accessories — never as the default on the big lifts.
- **Progression rules:** progress **load first** when the top set is hit at the target RIR with clean
  technique; small jumps (≈2.5–5 lb upper, 5–10 lb lower). A clean top set at the prescribed RIR ⇒ +load
  next exposure; a grind (RIR 0, speed loss) ⇒ **hold** and clean it up; repeated grinds ⇒ back off / deload.
  This is exactly today's "earn the next step" rule, kept.
- **Deload / recovery triggers:** stall in e1RM across the protocol window, repeated RIR-0 grinds on a main
  lift, bar-speed loss at submax loads, accumulated heavy exposures. Use the **predefined deload protocols**
  (`docs/DELOAD_SPEC.md`) — load-cut, not invented numbers; AI decides *if*, the engine decides *what*.
- **Coach voice examples:**
  - "Clean triple at RIR 2. That earns weight — 235 next time."
  - "That last single was a grind. We hold here; grinding max singles is fatigue, not progress."
  - "Bar speed's down on your openers. We back off this week, then push."
- **Example logs (current grammar — already supported):**
  - `Squat 315 3/2 3/2 3/1` → 3 sets, weight 315, reps 3, RIR 2/2/1.
  - `Bench 225 5/2 245 3/1 245 2/0` → top + back-off; last set RIR 0 flagged as a grind.
- **Test fixture ideas:** clean top-set-at-target → `+load`; RIR-0 grind on a compound → `hold` + caution
  voice; e1RM flat across window → deload trigger fires; same input must **not** trigger on a progressing
  accessory.

---

## Profile 2 — Hypertrophy / bodybuilding

- **Target user:** physique-focused trainee; wants muscle size and symmetry.
- **Primary goal:** muscle growth via accumulated effective volume across rep ranges (≈6–20+).
- **Common exercises:** moderate compounds + lots of machines/isolation; presses, rows, leg press, hack
  squat, RDL, curls, extensions, lateral raises, calf work; cables and dumbbells dominate.
- **Best effort/intensity metrics:** **effective volume** (hard sets per muscle/week) and **proximity to
  failure (RIR)** are primary; load and reps both progress; total tonnage as a secondary trend. Volume
  landmarks (MEV/MAV/MRV, practitioner framework) are a useful lens.
- **How fatigue appears:** local/peripheral — target muscle pump and burn, rep drop-off within a set,
  soreness (DOMS) over 24–72h, performance decay across a muscle's weekly volume. Less CNS-dominant than
  heavy strength.
- **How RIR should be used:** **Centrally, and the contrast with strength matters.** Hypertrophy benefits
  from training **close to failure** (≈RIR 0–3); the hypertrophy advantage drops off meaningfully once sets
  stop **more than ~4–5 reps short of failure** (Refalo 2023). **RIR 0 is more acceptable on
  isolation/accessory work** (low systemic cost, easy to recover) **than on heavy compounds** (high cost,
  bleeds into the rest of the session/week). So: push isolations near/to failure freely; keep compounds at
  RIR 1–2 so they don't tax recovery.
- **Progression rules:** **double progression** — add reps within the target range at fixed load, then add
  load and reset reps; bias *volume* (more hard sets) within recoverable limits. Reward effective sets, not
  ego load.
- **Deload / recovery triggers:** per-muscle volume performance decay, persistent joint/connective ache,
  sleep/appetite disruption, soreness that doesn't clear before the next exposure. Volume-first deload
  (reduce sets) before load-cut.
- **Coach voice examples:**
  - "Three sets all at RIR 1 on curls — perfect, that's growth work. Add a rep next set."
  - "Bench at RIR 0 again. Take that one to RIR 2 — save the failure reps for the cable stuff."
  - "Chest volume's stacking up and quality's dropping. Lighter week, then we rebuild."
- **Example logs:**
  - `Curl 40 12/1 12/0 10/0` → isolation near/at failure (fine); double-progression eligible.
  - `Incline DB 70 10/2 70 9/2 70 8/3` → reps decaying across sets → fatigue within the muscle.
- **Test fixture ideas:** isolation RIR-0 → *not* penalized, double-progression credited; compound RIR-0 →
  caution; reps maxed at top of range at target RIR → `+load, reset reps`; per-muscle weekly volume decay →
  deload signal.

---

## Profile 3 — General fitness / health / weight loss

- **Target user:** the broad majority — wants to be healthier, leaner, stronger, consistent; not chasing a
  number on the bar or a marathon.
- **Primary goal:** sustainable health & body composition: hit the **physical-activity guidelines**, build a
  baseline of strength + conditioning, lose fat, keep the habit. **Consistency and safety beat maximal
  effort.**
- **Common exercises:** full-body machine/dumbbell circuits, light-moderate compounds, walking/incline
  treadmill, cycling, rowing, mobility; mix of resistance and easy cardio.
- **Best effort/intensity metrics:** **consistency/adherence** (sessions/week, weekly active minutes vs the
  guideline target), **RPE** (simple "how hard, 1–10"), moderate-vs-vigorous time, steps/active minutes;
  **HR optional**. Grounding: WHO 2020 / HHS 2018 — **150–300 min/wk moderate or 75–150 min/wk vigorous
  aerobic, plus muscle-strengthening ≥2 days/wk**.
- **How fatigue appears:** general tiredness and life stress more than CNS or local-muscle limits; the real
  failure mode is **missed sessions**, not under-reaching in a set.
- **How RIR should be used:** **Lightly.** Keep most resistance work at a comfortable **RIR 2–4**; RIR 0 is
  unnecessary and raises injury/soreness risk that hurts adherence. Atlas should **reward showing up** over
  pushing to failure. RPE is the friendlier metric here than RIR.
- **Progression rules:** progress **frequency/duration/consistency first**, then gentle load/rep increases
  when sessions are being completed comfortably. Small, safe steps. Volume guideline-anchored, not maximized.
- **Deload / recovery triggers:** missed sessions / life stress → reduce, don't pile on; soreness affecting
  daily life; **deload here often means "lighter, shorter, keep the streak"** rather than a structured
  load-cut block.
- **Coach voice examples:**
  - "Three sessions this week — that's the win. Same plan Thursday."
  - "This is base work, not a race. Keep it at a 6 out of 10."
  - "Busy week? Twenty easy minutes still counts. Don't break the chain."
- **Example logs:**
  - `Leg Press 180 12 12 12 RPE 6` → moderate effort, consistency-tracked.
  - `Walk 30 min` / `Treadmill 25 min incline 6 RPE 5` → counts toward weekly active minutes.
- **Test fixture ideas:** week with 3 completed sessions → adherence credited, no failure-chasing voice;
  RIR/RPE comfortably moderate → `+frequency or hold`, never "go to failure"; a logged easy-cardio session →
  counts toward weekly active-minute target.

---

## Profile 4 — Cardio / endurance

> **Biggest new modality. RIR is essentially irrelevant here.** This profile has **no engine home today**
> and is the clearest demonstration of "don't force the barbell model on everyone."

- **Target user:** runner, cyclist, rower, swimmer, or anyone whose main training is aerobic/anaerobic
  conditioning.
- **Primary goal:** cardiovascular capacity & performance — go longer, faster, recover better (VO₂max,
  lactate threshold, aerobic base, race times).
- **Common exercises:** running/walking, cycling, rowing/erg, swimming, elliptical, stair climber; steady
  state, tempo, and **intervals** (e.g. `8 × 400m`).
- **Best effort/intensity metrics:** **duration, distance, pace, heart rate, HR zone, and RPE** — *not* RIR.
  Zones (5-zone model, % HRmax or Karvonen **% heart-rate reserve**; ACSM favors HRR for very fit/unfit):
  **Z1 50–60% / Z2 60–70% (aerobic base, fat ox) / Z3 70–80% (tempo) / Z4 80–90% (threshold) /
  Z5 90–100% (VO₂max)**. HRmax estimate: **208 − 0.7 × age** (Tanaka, better than 220−age). RPE via Borg
  (6–20) or CR10 (0–10); the **talk test** distinguishes moderate (can talk, not sing) from vigorous (only a
  few words). Polarized norm: elite endurance ≈ **75–80% of time in Z1–Z2**, less in Z3.
- **How fatigue appears:** elevated resting/exercise HR for a given pace (**cardiac drift / decoupling**),
  pace falling at the same HR, longer HR recovery, heavy legs, lingering systemic tiredness; overreaching
  shows as suppressed HR or stalled pace.
- **How RIR should be used:** **It should not.** "Reps in reserve" has no meaning for a 5 km run. Use
  **duration / HR / zone / RPE / pace and recovery** instead. If a circuit-style conditioning piece has
  countable reps, reps/RPE can apply to that piece — but steady-state and interval cardio are governed by
  time, intensity zone, and recovery.
- **Progression rules:** progress **volume before intensity** — extend duration/distance at an easy zone
  first (build the aerobic base), then add intensity (faster intervals, more threshold time, higher zones).
  Improvement = **same pace at lower HR**, or **faster pace at the same HR/RPE**. Respect the easy/hard
  polarization; don't let every easy day creep into Z3.
- **Deload / recovery triggers:** HR/pace decoupling, elevated morning HR, poor HR recovery, accumulated
  high-zone time → insert easy weeks / cut volume; recovery after hard interval days is mandatory before the
  next quality session.
- **Coach voice examples:**
  - "5 km at 6:25/km, avg HR 151 — same pace, lower HR than last week. Aerobic base is building."
  - "That was a Zone 4 day. Tomorrow's easy — Zone 2 only, we protect the recovery."
  - "Your HR's drifting up at the same pace. We keep it easy this week."
- **Example logs (new grammar — parser is owner-gated):**
  - `Elliptical 30 min RPE 6 avg HR 142`
  - `Stairmaster 20 min level 7 RPE 8`
  - `Run 5 km 32:10 RPE 7 avg HR 151`
  - `Intervals 8 x 400m hard / 90 sec easy`
- **Test fixture ideas:** steady run → effort interpreted as duration/distance/pace/HR/zone, **RIR=N/A**;
  same pace at lower HR vs prior session → "aerobic base improving" / `+`; HR drift / elevated resting HR →
  easy-week trigger; interval session → rounds + work/rest parsed, intensity = Z4/Z5; a hard cardio day
  **must not** be read through the RIR/strength progression engine.

---

## Profile 5 — Bodyweight / calisthenics / circuits

- **Target user:** calisthenics / CrossFit-style / minimal-equipment trainee; trains with bodyweight,
  bands, and metabolic circuits.
- **Primary goal:** relative strength, skill progressions, work capacity, conditioning — often blended.
- **Common exercises:** push-ups, pull-ups, dips, rows, squats/pistols, lunges, **timed holds** (plank,
  L-sit, hollow), and **circuits** (AMRAP / EMOM / rounds-for-time); progressions via leverage, added load,
  or assistance.
- **Best effort/intensity metrics:** **mixed.** Reps + RIR/RPE when the movement is strength-like (weighted
  dips, hard pull-ups); **rounds, time/density, and RPE** for circuits; **duration** for holds; **assistance
  level / added load** as the difficulty axis. Density = work per unit time (e.g. rounds in 12 min).
- **How fatigue appears:** local muscular failure (can't get the next rep), **form/technique breakdown**
  under metabolic load, falling rounds/round-times across a circuit, grip and core giving out, elevated HR
  in dense circuits (a cardio component sneaks in).
- **How RIR should be used:** **When appropriate, but not exclusively.** Reps/RIR work for strength-style
  calisthenics (`Pullups BW 6/1`); but circuits/holds need **rounds, hold time, density, total time, and
  RPE** instead of — or alongside — RIR. Atlas must pick the right metric **per piece**, not blanket-apply
  RIR.
- **Progression rules:** progress along the available axis — **harder leverage** (incline→flat→decline
  push-up; assisted→strict→weighted pull-up), **+added load** (`Dips +25`), **more reps**, **more rounds**,
  **longer holds**, or **higher density** (same work, less time). For circuits, more rounds or shorter total
  time at equal quality is progress.
- **Deload / recovery triggers:** form breakdown under fatigue (objective only — never *inferred from rep
  counts alone*; needs a logged signal), falling round quality, joint stress from high-volume calisthenics;
  reduce rounds/density or regress leverage to recover.
- **Coach voice examples:**
  - "Strict pull-ups, 6/5/4 with a rep in the tank — clean. Add a rep or strap on weight next time."
  - "That circuit was spicy. We're not pretending shoulders are fresh now."
  - "Six rounds, last two got sloppy. We hold rounds and tighten form before adding."
- **Example logs (mixed grammar — circuit/hold tokens are owner-gated):**
  - `Pushups 20/2 x3` · `Situps 30/3 x3` · `Pullups BW 6/1 5/1 4/0` · `Dips +25 8/2 x3`
  - `Plank 60 sec RPE 7 x3`
  - `AMRAP 12 min: pushups 10, air squats 15, situps 20 - 6 rounds RPE 8`
- **Test fixture ideas:** `Dips +25 8/2` → added-load progression on the load axis; `Plank 60 sec` → effort
  = duration, **RIR=N/A**; AMRAP → rounds + per-round movements parsed, effort = density+RPE; `Pullups BW
  6/1 5/1 4/0` → strict reps with RIR, decay across sets noted; form-breakdown verdict **only** when an
  objective signal is present.

---

# Part B — Research grounding (source notes)

Evidence-based, not owner-preference. Source **categories** (the task's requirement), with the key findings
this taxonomy relies on. These are notes for the doc; do **not** overbuild citations into code.

1. **Physical-activity guidelines (general fitness / cardio volume floor).** WHO 2020 and HHS *Physical
   Activity Guidelines for Americans* (2nd ed., 2018) converge: adults should get **150–300 min/wk
   moderate** *or* **75–150 min/wk vigorous** aerobic activity (or an equivalent mix), **plus
   muscle-strengthening of all major muscle groups on ≥2 days/wk**. Anchors Profile 3's "consistency vs a
   weekly target" and Profile 4's volume framing.
2. **Resistance-training progression principles.** ACSM progression model (Ratamess et al., 2009 position
   stand) + the FITT-VP / progressive-overload framework: novices ≈8–12 reps; **strength** biases heavier
   loads / lower reps, **hypertrophy** moderate loads / moderate–high reps and volume, **local muscular
   endurance** lighter loads / higher reps. Progress via load, volume, frequency, and exercise variation.
   Anchors the per-profile progression rules.
3. **RIR / RPE usage.** Zourdos et al. (2016, *JSCR*) — the resistance-training **RIR-based RPE scale**
   (RPE 10 = 0 RIR / failure; inverse bar-velocity↔RPE relationship). Novices estimate RIR less accurately
   than experienced lifters (they over/undershoot), so Atlas should treat early RIR self-reports as noisy
   and lean on objective signals — directly relevant to onboarding confidence.
4. **Training-to-failure / proximity-to-failure findings.** Refalo et al. (2023, *Sports Medicine*),
   meta-analysis: only a **trivial hypertrophy advantage** to training to failure vs not, with a
   **meaningful hypertrophy drop-off once sets end >~4–5 reps short of failure**; **strength is more
   load-driven** and gains little from routine failure; RIR-1 work can carry **fatigue lasting up to ~48 h**.
   Grounds the **profile-aware** failure rules: failure is more justified on hypertrophy isolation than on
   heavy strength compounds.
5. **Cardio intensity / RPE / HR-zone concepts.** 5-zone model by **% HRmax** or **Karvonen % heart-rate
   reserve** (HRR = HRmax − HRrest; ACSM prefers HRR for very fit/unfit individuals); HRmax ≈ **208 − 0.7 ×
   age** (Tanaka). Borg RPE (6–20) and CR10 (0–10); the **talk test** for moderate vs vigorous. Endurance
   adaptation is largely built in **Z2** (aerobic base / fat oxidation), with VO₂max work in **Z5**; the
   polarized norm is **~75–80% easy (Z1–Z2)**. Grounds Profile 4 metrics and "volume before intensity."

> Source-note discipline: capture the *category + key finding* in this doc. The engine should encode the
> resulting **rules/numbers** (e.g. failure policy by profile, zone bands), not bibliographic citations.

---

# Part C — Implementation planning

## 1. Training Profile Model — scores, not one label

Atlas should represent a user's style as a **profile-score vector**, each axis `0.0–1.0`, **independent**
(they need not sum to 1 — a user can be both strength- and hypertrophy-oriented):

```
profile = {
  strength:        0.70,
  hypertrophy:     0.80,
  general_fitness: 0.60,
  cardio:          0.35,
  bodyweight:      0.20
}
```

**Why scores beat a single label:** real trainees are blends ("powerbuilder," "lifter who runs 5k twice a
week"). A single `ATLAS_PROFILE_GOAL` cannot express that. Scores let the engine **weight** behaviors rather
than switch hard between modes.

**Derivation (deterministic, two sources, with confidence):**
- **Seed** from the onboarding classifier (§2) — low confidence at first.
- **Update** from logged behavior over time: an exponentially-weighted moving average of the *observed
  modality mix* (what the user actually logs — share of strength vs hypertrophy vs cardio vs bodyweight
  sessions/volume). Logs **raise** confidence; the seed never overrides accumulated evidence. This mirrors
  the existing "learn structure from the lifter's data" principle (BACKLOG "data-driven session design").
- **Confidence** travels with the vector (reuse the spirit of `confidence_factors` /
  `exerciseBenchmark`'s `none/low/medium/high` ladder). Low confidence → conservative, ask/observe; high
  confidence → act on the learned mix.

**How the engine consumes it (read-only, deterministic):** the vector selects, per session and per exercise,
which **effort metric**, **failure policy**, **progression metric**, **volume target**, and **fatigue
routing** apply (see §5–§6). Blending rule of thumb: when resistance axes dominate, apply the **most
conservative** failure policy among the dominant axes; cardio behavior is gated by the `cardio` axis and the
exercise's modality, independent of the resistance axes.

**Storage:** profile scores are **derived state**, not logged sets. Keep them out of `Log_Cleaned`/`Effort`.
A persisted profile would be a small **append-only state tab** (same pattern as `Deload_State`) **or** an
env/config seed — **[owner-gated]** because it adds a tab. For early slices the vector can be computed
**on read** from logs + onboarding answers (no new storage, no schema change).

**Relationship to existing goals:** the vector maps onto `TRAINING_GOALS` weights rather than replacing them
— e.g. high `strength` → `strength` goal biases; high `hypertrophy` → `hypertrophy` biases; high `cardio`
introduces the **new** cardio behaviors that have no goal today. `mixed` / `conditioning_fat_loss` /
`general_health` remain valid blended targets.

## 2. Onboarding Classifier

First-use, **plain-language** questions. The classifier **asks, infers, then keeps updating from logs** — it
must **never rely only on the first answer** (see Zourdos: early self-reports are noisy). Honor the Someday
guardrail: *infer from data and behaviour; do not interrogate.* Onboarding is a short opt-in seed, not an
interrogation; everything is re-derivable from logs.

Questions (plain language):

1. **What are you here for?** (strength · muscle · general health / weight loss · cardio / endurance ·
   bodyweight / calisthenics · a mix)
2. **How do you like to train?** (heavy & low-rep · moderate & pump-focused · circuits / fast-paced ·
   running / cycling / rowing · bodyweight only · mix)
3. **What equipment do you have?** (full gym · home dumbbells/bands · barbell + rack · cardio machines ·
   bodyweight only)
4. **How many days/week?** (1–2 · 3–4 · 5–6 · 7)
5. **How long per session?** (≤30 min · 30–45 · 45–60 · 60+)
6. **How hard do you like sessions?** (easy & sustainable · moderate · hard · varies)
7. **Any injuries or movements to avoid?** (free text → routes to the existing `Constraints` typed
   vocabulary: `kind ∈ injury|equipment|preference`, `rule ∈ avoid|limit|substitute`).

**Deterministic scoring rubric (seed only — illustrative deltas, to be pinned in fixtures):**

| Answer | Profile-score effect |
|---|---|
| "here for: strength" | `strength += 0.4` |
| "here for: muscle" | `hypertrophy += 0.4` |
| "here for: general health / weight loss" | `general_fitness += 0.4` |
| "here for: cardio / endurance" | `cardio += 0.4` |
| "here for: bodyweight / calisthenics" | `bodyweight += 0.4` |
| "here for: a mix" | spread `+0.2` across the named axes |
| "train: heavy & low-rep" | `strength += 0.2` |
| "train: moderate & pump" | `hypertrophy += 0.2` |
| "train: circuits / fast" | `bodyweight += 0.15`, `general_fitness += 0.1`, `cardio += 0.1` |
| "train: running/cycling/rowing" | `cardio += 0.3` |
| "train: bodyweight only" | `bodyweight += 0.3` |
| equipment: bodyweight only | `bodyweight += 0.2`, cap external-load profiles |
| equipment: cardio machines | `cardio += 0.1` |
| hard sessions | nudge failure tolerance up *within the profile's policy* (never override safety) |
| easy & sustainable | bias `general_fitness`, lower failure tolerance |
| injuries/avoid (Q7) | write to `Constraints` (existing typed tab), not the profile vector |

Scores are clamped to `[0,1]`. **Seed confidence is low**; the first ~N logged sessions reweight the vector
toward observed behavior (§1). The classifier is **pure/deterministic** — it maps answers → score deltas; it
does not call the LLM to decide a style.

## 3. Exercise Modality Schema

Every exercise (catalog entry) carries modality fields so the engine knows which lens to use. Reuse existing
fields where they exist (`movement_pattern`, `primary/secondary_muscles`, `exercise_type`); add the new ones.

```
exercise_type        // EXTENDS existing EXERCISE_TYPES with cardio/timed/circuit kinds
load_type            // how resistance is applied (the new axis)
movement_pattern     // existing: squat | hinge | lunge | push_h | push_v | pull_h | pull_v | carry | core | locomotion | ...
primary_muscles      // existing (muscleCoverage.js)
secondary_muscles    // existing
fatigue_class        // dominant fatigue cost
effort_metric        // how effort is measured  → drives which "intensity" field the parser/engine reads
progression_metric   // what "progress" means for this exercise
```

**Proposed enums:**

- **`exercise_type`** (extends today's `compound | isolation | machine | bodyweight | power | unknown`):
  add `cardio_steady | cardio_interval | circuit | timed_hold | mobility`.
- **`load_type`** (the new dimension): `external_weight` · `bodyweight` · `added_load_bodyweight` (e.g.
  `Dips +25`) · `assisted_bodyweight` (band/machine assist) · `cardio_machine` · `locomotion`
  (running/walking) · `timed` (holds) · `none`.
- **`fatigue_class`:** `high_cns` (heavy compound) · `moderate_systemic` (hypertrophy compound) ·
  `local` (isolation/accessory) · `metabolic` (circuits/AMRAP/EMOM) · `aerobic` (Z1–Z2 steady) ·
  `anaerobic` (intervals / Z4–Z5).
- **`effort_metric`:** `rir` · `rpe` · `hr` · `hr_zone` · `pace` · `duration` · `distance` · `rounds` ·
  `completion`. (A given exercise may list a primary + acceptable alternates, e.g. running →
  `pace` primary, `hr_zone`/`rpe`/`duration` alternates.)
- **`progression_metric`:** `load` · `reps` · `total_volume` · `density` · `duration` · `distance` ·
  `pace` · `hr_at_pace` · `rounds` · `leverage` · `assistance`.

**Coverage required (minimum, per the task):**

| Modality | exercise_type | load_type | effort_metric (primary) | progression_metric |
|---|---|---|---|---|
| External weight lifting | compound/isolation/machine | external_weight | rir (or rpe) | load → reps |
| Bodyweight | bodyweight | bodyweight | reps + rir/rpe | reps → leverage |
| Added-load bodyweight | bodyweight | added_load_bodyweight | reps + rir | load → reps |
| Assisted bodyweight | bodyweight | assisted_bodyweight | reps + rir | assistance → reps |
| Cardio machine | cardio_steady | cardio_machine | hr_zone/rpe/duration | duration → pace/zone |
| Running / walking | cardio_steady/locomotion | locomotion | pace + hr_zone | distance/duration → pace |
| Timed holds | timed_hold | timed | duration + rpe | duration |
| Intervals | cardio_interval | locomotion/cardio_machine | hr_zone/pace + rounds | rounds → pace |
| Circuits (AMRAP/EMOM) | circuit | bodyweight/external | rounds + rpe (density) | rounds/density |

This is **pure data** (catalog annotation / a lookup module). It changes **no write path and no
`Log_Cleaned` schema** — it's metadata the engine reads to decide *how to interpret* a logged row.

## 4. Expanded Logging Formats

Documented target parses. **The current slash-notation contract is unchanged** (`225 5/2` = 225 × 5 @ RIR
2). New tokens (duration, distance, pace, zone, level, rounds, work/rest, `+load`, `sec`/`min`, `RPE`,
`avg HR`) are **owner-gated parser work** (`docs/INVARIANTS.md` slash-notation contract; `CLAUDE.md`
high-risk `workoutTextParser.js`). Listed here as the *target grammar*, not a built feature.

| Input | Target parse (modality → fields) |
|---|---|
| `Bench 135 10/5 185 10/2 235 6/2 6/0 4/1` | resistance: 5 sets, weights 135/185/235/235/235, reps 10/10/6/6/4, RIR 5/2/2/0/1 *(today's grammar)* |
| `Pushups 20/2 x3` | bodyweight: 3 sets × 20 reps @ RIR 2 |
| `Situps 30/3 x3` | bodyweight: 3 sets × 30 reps @ RIR 3 |
| `Pullups BW 6/1 5/1 4/0` | bodyweight: 3 sets, reps 6/5/4, RIR 1/1/0, load_type=bodyweight |
| `Dips +25 8/2 x3` | added-load bodyweight: 3 sets × 8 @ RIR 2, added_load=+25 |
| `Plank 60 sec RPE 7 x3` | timed_hold: 3 × 60s, effort=RPE 7, RIR=N/A |
| `Elliptical 30 min RPE 6 avg HR 142` | cardio_steady: duration=30 min, RPE 6, avg HR 142, RIR=N/A |
| `Stairmaster 20 min level 7 RPE 8` | cardio_steady: duration=20 min, machine level 7, RPE 8 |
| `Run 5 km 32:10 RPE 7 avg HR 151` | locomotion: distance=5 km, time=32:10 (→ pace 6:26/km), RPE 7, avg HR 151 |
| `Intervals 8 x 400m hard / 90 sec easy` | cardio_interval: 8 rounds, work=400m hard, rest=90s easy |
| `AMRAP 12 min: pushups 10, air squats 15, situps 20 - 6 rounds RPE 8` | circuit: cap=12 min, movements=[pushups 10, air squats 15, situps 20], rounds=6, RPE 8, effort=density |

**Storage implication (flag, not a decision):** several of these carry fields (`duration`, `distance`,
`pace`, `hr`, `zone`, `rounds`, `rpe`) that the 12-column `Log_Cleaned` doesn't hold. Options to weigh at
build time, **[owner-gated migration]**: (a) extend the `Effort` tab to per-exercise cardio rows; (b) add a
new typed tab for cardio/circuit logs; (c) map into `notes` short-term (lossy, not recommended for
analytics). **No schema change is proposed here** — this is the parsing/representation target only.

## 5. Profile-Aware Stimulus Governor

The governor decides whether logged effort **earns progression, holds, or signals fatigue**, using the
profile + the exercise's modality. **RIR/fatigue rules differ by profile** — this is the heart of "don't
force the barbell model." It **extends** the per-goal `failurePolicy` already in `TRAINING_GOALS`.

| Profile | RIR / effort rule | Failure (RIR 0) handling |
|---|---|---|
| **Strength** | Load is king; RIR 1–3 on compounds | RIR 0 on a **heavy compound** is high-fatigue → usually **blocks** progression (grind ≠ green light); occasional failure OK on light accessories |
| **Hypertrophy** | Train close to failure (RIR 0–3); drop-off if >~4–5 RIR | RIR 0 **acceptable on isolation/accessories**, **cautioned on heavy compounds** (recovery cost) |
| **General fitness** | Comfortable RIR 2–4; RPE-friendly | RIR 0 unnecessary; **reward consistency & safety over maximal effort** |
| **Cardio** | **RIR irrelevant** — use duration / HR / zone / RPE / pace + recovery | n/a; "too hard too often" is judged by **zone-time & HR drift**, not RIR |
| **Bodyweight / circuits** | reps/RIR **when appropriate**, plus rounds / holds / density / time / RPE | RIR 0 fine on strict-strength sets; circuits judged by **round quality & density**, not RIR |

**Deterministic outputs the governor emits** (engine facts the voice may word, never invent):
`effort_interpretation` (which metric was read), `progression_verdict` (`+load` / `+reps` / `+rounds` /
`+duration` / `hold` / `back_off`), and a `fatigue_signal`. All explainable from logged data + profile +
modality + recent history.

## 6. Live Fatigue Routing

How Atlas adjusts the **active session** based on logged fatigue. Extends the existing readiness/recovery
model (`services/analytics.js`, `coverageStalls.js`, deload protocols). Deterministic, explainable:

- **Same muscle group next:** after high fatigue on a muscle (RIR 0 grind, performance decay), the next
  same-muscle item may be **delayed, reduced (fewer sets / lower load), or made optional**.
- **Opposing muscle group can be moved up:** if the planned next item hammers a just-fatigued pattern,
  promote a **rested/antagonist** movement instead (reuses the recovery-aware density logic already in
  `scoreIntents`).
- **Repeated RIR 0 can block PR attempts:** accumulated failure on a lift suppresses a same-session/next-up
  PR suggestion until recovery shows.
- **Cardio intensity can be reduced after hard leg work:** a heavy lower-body block lowers the prescribed
  zone/duration for a following cardio piece ("Zone 2 only today").
- **Circuit density can be reduced after form/fatigue breakdown:** falling round quality → cut rounds /
  lower density rather than push through (form breakdown must come from an **objective logged signal**, never
  inferred from rep counts alone — consistent with the existing form-signal guardrail).

## 7. Coach Voice

Atlas explains decisions in concise, user-facing language; the LLM **words engine facts**, never invents
numbers or verdicts. Canonical lines (profile-tagged):

- "That counted, but it does not earn more weight." *(strength/hypertrophy — effort logged, progression
  withheld)*
- "Too much left in the tank. Bump coming." *(under-reached vs target RIR → progression)*
- "We are not quitting. We are rerouting." *(live fatigue routing → substitute/antagonist)*
- "This is base work, not a race." *(general fitness / cardio Z2 — effort framing)*
- "That circuit was spicy. We are not pretending shoulders are fresh now." *(bodyweight/circuit → fatigue
  routing)*

Voice obeys the existing spec (`docs/COACH_VOICE_VALIDATION.md`): conclusion-first, terse by default, never
celebrate a grind, never present planned work as completed, degrade gracefully when the LLM is down (the
deterministic governor still emits the verdict).

## 8. Test Matrix Proposal

Golden fixtures for **every profile**. Each fixture asserts six fields:
`parsed_log` · `effort_interpretation` · `fatigue_signal` · `progression_verdict` · `coach_response` ·
`next_action`. Deterministic engine output is asserted exactly; `coach_response` asserts shape/rules
(matching the existing coach-test rubric), not exact LLM prose.

| # | Profile | Input (fixture) | Key assertions |
|---|---|---|---|
| F1 | Strength | `Squat 315 3/2 3/2 3/2` | effort=RIR; verdict=`+load`; next=heavier top set |
| F2 | Strength | `Bench 245 2/0` (grind) | fatigue=high CNS; verdict=`hold`; voice cautions, no celebration |
| F3 | Hypertrophy | `Curl 40 12/0 12/0 10/0` | RIR-0 isolation **not** penalized; verdict=double-progression `+reps/+load` |
| F4 | Hypertrophy | `Bench 225 8/0 8/0` (compound failure) | verdict=`hold`+caution; fatigue=systemic |
| F5 | General fitness | week of 3 sessions @ RPE 6 | effort=RPE/adherence; verdict=`+frequency or hold`; never "go to failure" |
| F6 | Cardio | `Run 5 km 32:10 RPE 7 avg HR 151` | effort=pace/HR/zone; **RIR=N/A**; verdict by pace-at-HR vs history |
| F7 | Cardio | second run, same pace lower HR | fatigue=none; verdict=`+` "aerobic base improving" |
| F8 | Cardio | interval `8 x 400m hard / 90 sec easy` | rounds+work/rest parsed; intensity=Z4/Z5; not run through RIR engine |
| F9 | Bodyweight | `Pullups BW 6/1 5/1 4/0` | reps+RIR; decay across sets noted; verdict=`+reps` when clean |
| F10 | Bodyweight | `Dips +25 8/2 x3` | load_type=added_load; verdict=`+load` on the load axis |
| F11 | Bodyweight | `Plank 60 sec RPE 7 x3` | effort=duration+RPE; **RIR=N/A**; verdict=`+duration` |
| F12 | Bodyweight | `AMRAP 12 min … - 6 rounds RPE 8` | rounds+density parsed; verdict=`+rounds/density` |
| F13 | Routing | heavy legs → following cardio piece | cardio intensity reduced ("Z2 only") |
| F14 | Routing | repeated RIR 0 on a lift | PR attempt blocked until recovery |
| F15 | Profile model | logs shift toward cardio over weeks | profile vector `cardio` axis rises; confidence increases |

**Worked example fixture (cardio — proving the no-RIR path):**

```json
{
  "profile": { "cardio": 0.7, "general_fitness": 0.6, "strength": 0.2 },
  "input": "Run 5 km 32:10 RPE 7 avg HR 151",
  "expect": {
    "parsed_log": {
      "exercise": "Run", "exercise_type": "cardio_steady", "load_type": "locomotion",
      "distance_km": 5, "duration": "32:10", "pace_per_km": "6:26",
      "rpe": 7, "avg_hr": 151, "rir": null
    },
    "effort_interpretation": "pace + heart rate + zone (RIR not applicable)",
    "fatigue_signal": "compare pace-at-HR vs recent runs; none if improved",
    "progression_verdict": "+ (volume before intensity) — extend easy distance or hold pace",
    "coach_response": { "rule": "base-work framing, no RIR/failure language", "shape": "conclusion-first" },
    "next_action": "log next run; reweight profile.cardio from observed behavior"
  }
}
```

---

# Part D — Phased build sequence (engine-first, tiny PRs)

All slices are **owner-gated to promote**; each is one concern, deterministic-engine-first, voice-second.

1. **PR-T1 — this taxonomy doc** *(current PR; planning only)*.
2. **PR-T2 — modality schema as pure data** (`exercise_type` extension, `load_type`, `fatigue_class`,
   `effort_metric`, `progression_metric` lookup). No write path, no `Log_Cleaned` change. `[correctness]`
3. **PR-T3 — profile-score model engine** (pure: derive the vector from logs + onboarding seed; compute on
   read; confidence ladder). Read-only. `[correctness]`
4. **PR-T4 — onboarding classifier** (deterministic answer→score rubric; routes Q7 to `Constraints`).
   Read-only. `[correctness]`
5. **PR-T5 — profile-aware stimulus governor** (extend `failurePolicy` by profile×modality; emit
   `effort_interpretation` / `progression_verdict` / `fatigue_signal`). Engine. `[trust-critical]`
6. **PR-T6 — expanded logging grammar** *(owner-gated: slash-notation contract / `workoutTextParser.js`
   high-risk)* — duration/distance/pace/zone/rounds/`+load`/`sec`/`min`/`RPE`/`avg HR` tokens; plus the
   **[owner-gated migration]** decision for where non-RIR metrics persist (Effort extension vs new tab).
   `[trust-critical]`
7. **PR-T7 — live fatigue routing** (extend readiness/recovery to cross-modality routing). Engine.
   `[correctness]`
8. **PR-T8 — coach voice** (word the new engine facts; profile-tagged lines; LLM never invents numbers).
   `[polish]`

Each code PR ships its golden fixtures (Part C §8). Schema/parser/trust-loop touchpoints stay owner-gated
and are not bundled with engine slices.

---

# Part E — Hard guardrails (restate)

- **No production workout behavior changes in this PR.** Docs/fixtures-as-plans only.
- **No write/logging path changes**; the preview→approve→write trust loop, `test_mode`/proof fields, and
  undo flow are untouched and remain owner-gated.
- **No `Log_Cleaned`/`Effort` schema change**; any non-RIR-metric persistence is an **[owner-gated
  migration]** decided at build time, not here.
- **No vague AI-only decision rules where deterministic rules work.** Every verdict is explainable from
  logged data, user profile, exercise type, recent history, or onboarding answers.
- **Slash-notation contract unchanged**; expanded grammar is owner-gated parser work.
- **One small planning PR.** Do not merge without owner direction.

---

# Part F — Model recommendation gate

- **Recommended model:** **Opus 4.8.**
- **One-line reason:** owner standing instruction — the builder runs on Opus 4.8 for all work
  (`CLAUDE.md`); this is a cross-cutting strategic-planning doc where reasoning quality matters most.
- **Risk level:** **Low** — planning/docs + fixture *proposals* only; no production code, write path,
  parser, schema, or trust-loop change.

**Stop here.** No production behavior work proceeds until the owner promotes a slice from Part D into
`docs/ACTIVE_ROADMAP.md`.
