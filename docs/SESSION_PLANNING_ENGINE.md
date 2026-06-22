# Atlas Session Planning Engine

> **Governance layer:** Vision / Dream-serving **planning spec** — see [`docs/GOVERNANCE.md`](GOVERNANCE.md).
> **Status:** PLANNING ONLY. No production behavior, parser, write/logging path, or Sheet schema change here.
> **Activation:** owner-gated. Nothing here enters `docs/ACTIVE_ROADMAP.md` until the owner promotes it
> (`docs/OWNER_CHECKIN_RULES.md`). Filed in `BACKLOG.md` as deferred, not active.
> **Builds on:** [`docs/TRAINING_PROFILE_TAXONOMY.md`](TRAINING_PROFILE_TAXONOMY.md) (PR #474 — *who the
> user is*). This doc covers *what to train today*. It does **not** recreate or replace that spec.
> **Source material:** the "Atlas Training Intelligence System" research report (objective-scoring model
> below) + the *Deloading in Resistance Training* report (§10) + the taxonomy spec + Atlas's existing
> deterministic engine.

---

## 1. Purpose

The Session Planning Engine converts **profile-aware training intelligence into a daily session objective
and an ordered workout plan**. It is the layer that answers the core product question:

> Atlas should not ask only *"What workout is next?"*
> Atlas should ask: *"Given this user, this goal, this training profile, this equipment, this recent
> performance, this fatigue, this recovery state, and this available time — what is the **best session
> today**?"*

It is an **aggregation + selection** layer, not a new source of numbers. It reads facts the engine already
computes (recent sessions, readiness, fatigue, adherence, coverage gaps, deload triggers, load sanity) and
deterministically (a) picks today's **session objective** and (b) emits an **ordered plan** with effort
targets. The LLM only *words* the result; it never picks the objective or invents loads.

Relationship to today's code: this generalizes the existing intent path. `scoreIntents` in
`services/analytics.js` already scores training intents and `structureSession` in
`services/sessionBuilder.js` already orders/sizes a session (`isBlockedPair`, `buildWarmupRamp`,
`capSessionToProfile`). The Planning Engine is the **profile-aware front end** over that machinery, extended
to the cardio / bodyweight / circuit objectives the taxonomy introduced.

---

## 2. Inputs

The planner will eventually read these inputs. Each maps to an existing engine fact or a taxonomy concept —
**no input requires a new write path or schema**; all are derivable on read from `Log_Cleaned` / `Effort` /
`Constraints` / config / onboarding.

| Input | Source today / planned | Notes |
|---|---|---|
| **Profile scores** | Taxonomy §1 profile vector (derived from logs + onboarding) | strength / hypertrophy / general_fitness / cardio / bodyweight axes |
| **Primary & secondary goals** | `services/profileGoal.js` + `TRAINING_GOALS` (`services/trainingKnowledge.js`) | goal can be a blend; secondary breaks ties |
| **Equipment** | onboarding answer / config | gates exercise variant selection |
| **Available time** | session input / onboarding default | sizes the plan (number of exercises / sets) |
| **Recent logged performance** | `buildRecentSessions` (`services/analytics.js`), `Log_Cleaned` | per-set weight/reps/RIR |
| **RIR / RPE trends** | per-set `rir` in `Log_Cleaned`; cardio RPE in `Effort`/notes | drives progression vs hold |
| **Soreness / pain notes** | `Constraints` tab (typed) + notes scan (`pain_flag`) | pain → reroute / replace, never push load |
| **Sleep / recovery notes** | opt-in volunteered notes only (Someday guardrail: never interrogate) | lowers objective intensity when present |
| **Apple Watch effort / HR** | `Effort` tab (`duration`, `average_hr`, `peak_hr`, `active_calories`), `effortIntensityBySession()` | feeds recovery-fit & cardio zones |
| **Movement-pattern history** | `services/movementPattern.js`, recent logs | balance / blind-spot need |
| **Muscle-group history** | `services/muscleCoverage.js`, `services/underCoverage.js` | per-muscle volume & coverage gaps |
| **Cardio / circuit / bodyweight history** | `Effort` + (planned) modality-tagged logs | per-modality recency & load |
| **Adherence history** | session cadence; `buildSessionVolumeProfile` (`services/sessionVolumeProfile.js`) | consistency vs the user's own norm |
| **User preferences** | onboarding + (future) preference-learning from edits | favored/dropped lifts, variety vs consistency |
| **Readiness / fatigue** | readiness model + `computeFatigueStatus` (`services/analytics.js`), `assessLayoff` (`services/layoffGuard.js`) | per-pattern `recovering`/`fatigued`; global fatigue; layoff |
| **Deload state** | `services/deloadState.js` (`Deload_State` tab), `suggestDeloads`, `annotateStallsForDeload` | active deload forces the `deload` objective |
| **Load sanity bounds** | `services/loadSanity.js` | never plan an out-of-bounds load |

---

## 3. Daily objective scoring

The planner scores each candidate **session objective** (§4) and selects the highest. From the research
report, the initial deterministic model is:

```
objective_score =
    0.30 * profile_match
  + 0.15 * goal_match
  + 0.10 * equipment_fit
  + 0.10 * time_fit
  + 0.15 * recovery_fit
  + 0.10 * adherence_fit
  + 0.10 * movement_balance_need
  - 0.10 * pain_conflict
  - 0.10 * fatigue_conflict
```

Term meanings (each a normalized `0..1` deterministic sub-score):

- **profile_match** — how well the objective fits the user's profile-score vector (cardio objective scores
  high for a high-`cardio` user).
- **goal_match** — fit to primary (and secondary) `TRAINING_GOALS`.
- **equipment_fit** — can the objective be run with available equipment.
- **time_fit** — does the objective fit the available time budget.
- **recovery_fit** — are the patterns/systems this objective taxes currently recovered (readiness model).
- **adherence_fit** — does it keep the streak / match the user's logged cadence and norm.
- **movement_balance_need** — does it address an under-trained pattern/muscle (coverage gap).
- **pain_conflict** *(penalty)* — does it load a flagged pain area / `Constraints` avoid target.
- **fatigue_conflict** *(penalty)* — does it stack systemic/local fatigue that's already high.

**These weights are INITIAL deterministic defaults.** They MUST be **fixture-protected** (golden tests in
§8 pin objective selection for representative inputs) **before any behavior ships**, so a weight change is a
visible, test-gated decision — never a silent drift. The score is fully explainable: every objective choice
can be traced to its term contributions.

---

## 4. Supported session objectives

For each objective: *when Atlas should choose it · default exercise order rules · default effort targets ·
fatigue constraints · progression intent · coach-facing explanation example · example planned session ·
example fatigue-adjusted session.* Loads shown are **illustrative placeholders** — the real numbers come
from the engine (`recommendNextSet`, `buildWarmupRamp`, `computePrescription`, `loadSanity`), never invented
here.

### 4.1 `strength_progression`
- **Choose when:** high `strength` profile / `strength` goal; main compounds recovered; no active deload.
- **Order:** heavy main compound first (after ramp); back-offs; then supporting accessories.
- **Effort targets:** main RIR 1–3; load-driven progression; e1RM the progress signal.
- **Fatigue constraints:** RIR 0 on a heavy compound is high-CNS → caution, usually no PR push next.
- **Progression intent:** +load when the top set hits target RIR cleanly.
- **Coach example:** "Bench is the priority today — heavy first, then we build around it."
- **Planned:** Bench (ramp → 1 top @ RIR2 + 2 back-offs) · Row · Incline DB · Triceps.
- **Fatigue-adjusted:** if bench top set redlines (RIR 0), drop the incline press, keep row + triceps.

### 4.2 `hypertrophy_volume`
- **Choose when:** high `hypertrophy` profile/goal; target muscles recovered enough for quality volume.
- **Order:** moderate compound(s) first; isolations after; pump/accessory last.
- **Effort targets:** compounds RIR 1–2; isolations RIR 0–2 (failure OK on isolation); double progression.
- **Fatigue constraints:** stop a muscle when per-set reps decay sharply; cap per-pattern density on a
  recovering pattern (`capRecoveringPatternDensity`).
- **Progression intent:** add reps in range → then load; bias effective volume.
- **Coach example:** "Chest and back volume day — quality sets, take the isolations close to failure."
- **Planned:** Incline press · Row · Cable fly · Lat pulldown · Lateral raise.
- **Fatigue-adjusted:** chest sets decaying → cut the fly, keep back volume.

### 4.3 `general_fitness_balanced`
- **Choose when:** high `general_fitness` profile; goal is health/weight-loss; consistency the priority.
- **Order:** full-body, simple → safe; compound-ish movement, light cardio finisher optional.
- **Effort targets:** comfortable RIR 2–4 / RPE 5–7; reward completion over intensity.
- **Fatigue constraints:** never push to failure; if life-stress/missed-session signal, shrink not stack.
- **Progression intent:** frequency/consistency first, then gentle load/rep nudges.
- **Coach example:** "Solid full-body session — moderate effort, the win is showing up."
- **Planned:** Goblet squat · Push-up/DB press · Row · Carry · 10 min easy cardio.
- **Fatigue-adjusted:** short on time/energy → 3 movements + a brisk walk; keep the streak.

### 4.4 `cardio_base`
- **Choose when:** high `cardio` profile; aerobic base intent; legs not redlined from lifting.
- **Order:** the cardio piece **is** the session; any lifting is secondary/after.
- **Effort targets:** Zone 2 (60–70% HRR) / RPE 4–6; duration/distance the dose; **RIR N/A**.
- **Fatigue constraints:** keep easy days easy; cut zone/duration after hard leg work.
- **Progression intent:** volume before intensity (extend easy duration/distance first).
- **Coach example:** "Easy aerobic day — Zone 2, build the base. This is base work, not a race."
- **Planned:** 40 min easy run/bike/row @ Zone 2.
- **Fatigue-adjusted:** hard legs yesterday → 25 min Zone 2 only, lower target.

### 4.5 `cardio_intervals`
- **Choose when:** high `cardio` profile; intensity intent; **recovered** from the last quality session.
- **Order:** warm-up → intervals (the priority) → cool-down; no heavy lifting before.
- **Effort targets:** work bouts Zone 4–5 / RPE 8–9; defined work/rest; **RIR N/A**.
- **Fatigue constraints:** requires recovery clearance; blocked if recovery_fit low / recent hard quality.
- **Progression intent:** rounds → pace; same pace at lower HR = improvement.
- **Coach example:** "Interval day — hard work bouts, full rest between. We earned this with recovery."
- **Planned:** 8 × 400 m hard / 90 s easy.
- **Fatigue-adjusted:** poor recovery signal → **downgrade to `cardio_base`** (easy Zone 2) instead.

### 4.6 `bodyweight_strength`
- **Choose when:** high `bodyweight` profile or equipment-limited; relative-strength intent.
- **Order:** hardest strength progression first (weighted/strict), then volume work, holds last.
- **Effort targets:** strict reps + RIR 1–2 on strength sets; added-load / leverage as the difficulty axis.
- **Fatigue constraints:** strict-strength quality first; circuits/holds later so they don't pre-fatigue.
- **Progression intent:** leverage → added load → reps.
- **Coach example:** "Calisthenics strength — strict pull-ups first while you're fresh."
- **Planned:** Weighted pull-up · Dip · Push-up · Pistol/lunge · Hollow hold.
- **Fatigue-adjusted:** grip/pulling fried → swap a pull variation for a push/core block.

### 4.7 `circuit_conditioning`
- **Choose when:** conditioning/work-capacity intent (general_fitness/bodyweight blend); recovered enough.
- **Order:** the **circuit is the main event** (NOT a finisher); brief prep before, cool-down after.
- **Effort targets:** density/rounds + RPE 7–8; reps where countable; HR climbs (cardio component).
- **Fatigue constraints:** reduce rounds/density on **form breakdown** (objective signal only).
- **Progression intent:** more rounds / shorter time at equal quality (density).
- **Coach example:** "Conditioning is today's main event — chase rounds, keep form honest."
- **Planned:** AMRAP 12 min: push-ups 10 · air squats 15 · sit-ups 20.
- **Fatigue-adjusted:** rounds getting sloppy → cap rounds / lengthen rest, protect form.

### 4.8 `skill_practice`
- **Choose when:** a technical/skill goal (e.g. clean, pistol, handstand, muscle-up) is named; low residual
  fatigue desired so the nervous system is fresh.
- **Order:** skill/technique work **first while fresh and unfatigued**; light supporting work after.
- **Effort targets:** low fatigue, high quality — submaximal, crisp reps; stop on technique decay.
- **Fatigue constraints:** never under heavy systemic fatigue; quality over quantity; end before sloppy.
- **Progression intent:** complexity/consistency of the skill, not load.
- **Coach example:** "Skill day — fresh and technical. We stop the moment form slips."
- **Planned:** Technique drills (the skill) · easy reinforcing accessory · mobility.
- **Fatigue-adjusted:** if fatigued/sore → shorten to drills only, drop accessories.

### 4.9 `recovery_reload`
- **Choose when:** elevated fatigue/soreness, poor sleep, or stacked yellow flags **short of** a full
  deload; keep moving without adding stress. See §10 for the recovery→deload decision ladder.
- **Order:** easy full-body / mobility / Zone 1–2 movement; nothing heavy or near-failure.
- **Effort targets:** RPE ≤5 / Zone 1–2; low volume; no PRs.
- **Fatigue constraints:** explicitly *reduces* load/volume; antagonist/rested patterns only.
- **Progression intent:** none — restore readiness; protect the streak.
- **Coach example:** "Light reload today — easy movement, we let yesterday settle."
- **Planned:** Easy Zone 2 20 min · mobility · light pump set or two.
- **Fatigue-adjusted:** if still wrecked → mobility + walk only.

### 4.10 `deload`
- **Choose when:** the deterministic deload trigger fires / `Deload_State` is active (`docs/DELOAD_SPEC.md`). See §10 for convergence triggers + profile-aware deload styles.
- **Order:** same movements, reduced load/volume per the **predefined protocol** (not invented numbers).
- **Effort targets:** protocol-defined load cut / volume cut; high RIR; no failure.
- **Fatigue constraints:** the whole objective *is* fatigue management; AI decides *if*, engine decides
  *what* (`computePrescription`).
- **Progression intent:** dissipate fatigue, preserve pattern; exit on protocol criteria.
- **Coach example:** "Deload week — same lifts, lighter on purpose. We back off to come back stronger."
- **Planned:** Main lifts at protocol % · reduced sets.
- **Fatigue-adjusted:** deload already *is* the adjustment; if a session is still too much, drop to
  `recovery_reload`.

---

## 5. Deterministic exercise order rules

Order rules (extend the existing `isBlockedPair` / `structureSession` logic and per-goal `exerciseOrder`):

- **Priority movement early** — the objective's priority lift/piece goes first (after warm-up).
- **Technical / high-coordination movement before fatigue** — skill-demanding work while fresh.
- **Heavy strength work early when strength is the main goal.**
- **Large multi-joint before small single-joint** — unless intentionally overridden (see exceptions).
- **High systemic-fatigue work later** — unless it is the session priority.
- **Same prime-mover after fatigue** — may be **delayed, reduced, or made optional**.
- **Opposing muscle group may move up** — as a reroute when the next item hits a fatigued pattern.
- **Cardio after lifting when lifting quality is primary.**
- **Cardio first when cardio performance is primary.**
- **Circuits / finishers later** — unless conditioning is the primary objective.
- **Beginners prioritize technique simplicity and low fatigue interference** — simpler movements, more
  margin, less inter-exercise interference.

**Exceptions (the objective overrides the generic heuristic):**

- If **deadlift performance is the objective**, deadlift stays **early** even though it is fatiguing.
- If **delts are the hypertrophy priority**, lateral raises may go **early**.
- If a **circuit is the main objective**, it is **not** treated as a finisher.
- **Equipment availability can override perfect order** when the ideal slot's equipment is occupied
  (mirrors the live substitution path).

Every ordering decision emits an `exercise_order_reason` so the choice is explainable (and the coach can word
it).

---

## 6. Planning examples

Illustrative (engine owns real numbers). One per objective surface:

1. **Strength bench day** — Ramp → Bench top @ RIR2 + 2 back-offs → Barbell Row → Incline DB → Triceps.
   *Bench first because strength is the goal and it's the priority lift.*
2. **Hypertrophy chest/back day** — Incline press → Row → Cable fly → Lat pulldown → Lateral raise.
   *Compounds before isolations; isolations taken closer to failure.*
3. **General fitness full-body day** — Goblet squat → DB press → Row → Carry → 10 min easy cardio.
   *Simple, balanced, moderate effort; cardio finisher optional.*
4. **Cardio base day** — 40 min Zone 2 run/bike/row. *The cardio piece is the session; RIR N/A.*
5. **Cardio interval day** — Warm-up → 8 × 400 m hard / 90 s easy → cool-down. *Intervals are the priority;
   no heavy lifting first.*
6. **Bodyweight strength day** — Weighted pull-up → Dip → Push-up → Pistol → Hollow hold. *Hardest strict
   work first; holds last.*
7. **Circuit conditioning day** — AMRAP 12: push-ups 10 / air squats 15 / sit-ups 20. *Circuit is the main
   event, not a finisher.*
8. **Recovery reload day** — 20 min Zone 2 + mobility + 1–2 light pump sets. *No heavy or near-failure work.*
9. **Deload day** — Main lifts at protocol % with reduced sets. *Predefined protocol, not invented numbers.*

---

## 7. Fatigue-adjusted examples

How the planner re-plans the session when a logged signal lands (this is *planning-time* adjustment that
sets up the live router in §9):

- **Bench redline (RIR 0) before weighted dips or incline** → drop/defer the second pressing movement;
  keep pulling + arms.
- **Squat RIR 0 before lunges or leg press** → reduce or make the quad accessories optional; keep posterior
  chain / core.
- **Hard StairMaster before leg day** → lower leg-day volume/intensity (pre-fatigued legs), or reorder so
  the priority lift comes before any remaining conditioning.
- **Push-ups to failure before overhead pressing** → triceps/delts pre-fatigued → swap OHP for a pull or
  reduce its load/volume.
- **Pull-ups with elbow pain before rows/curls** → **pain override**: replace elbow-loading pulls with a
  pain-free pattern; never push through (`Constraints` avoid).
- **AMRAP RPE 9 before heavy compounds** → systemic fatigue high → downgrade the heavy compound block to a
  lighter/technique focus or move it to another day.
- **Beginner soreness before a full-body session** → reduce volume, simplify movements, raise RIR margin;
  protect adherence over stimulus.

---

## 8. Test matrix proposal

Golden fixtures gate objective selection, ordering, and adjustment **before any behavior ships** (§3). Each
case asserts: `user_profile` · `session_objective` · `recent_history` · `readiness_signal` ·
`planned_session` · `fatigue_adjusted_session` · `exercise_order_reason` · `target_effort` ·
`coach_explanation` · `next_action`. Deterministic fields assert exactly; `coach_explanation` asserts
shape/rules (matching the existing coach-test rubric), not exact LLM prose. **Deload / recovery fixtures**
(`single_bad_session_no_deload`, `repeated_rir0_main_lift_deload`, `taper_vs_deload_distinction`, …) are
listed in §10.7.

| Fixture | Asserts (objective → key adjustment) |
|---|---|
| `strength_progression_green` | strength obj; recovered; plan heavy-first; clean → `+load` next |
| `strength_progression_yellow_after_rir0` | strength obj; bench RIR0 logged → drop 2nd press, no PR push |
| `hypertrophy_volume_local_fatigue` | hypertrophy obj; chest reps decaying → cut fly, keep back volume |
| `general_fitness_low_time` | gen-fit obj; ≤30 min → 3 movements + walk; never failure |
| `cardio_base_after_hard_legs` | cardio_base; hard legs prior → Zone 2 only, reduced duration |
| `cardio_intervals_blocked_by_recovery` | intervals requested but low recovery_fit → downgrade to base |
| `bodyweight_strength_equipment_limited` | bodyweight obj; no barbell → bodyweight variants, order intact |
| `circuit_conditioning_main_event` | circuit obj; circuit ordered **first/main**, not a finisher |
| `recovery_reload_after_poor_sleep` | poor-sleep note → recovery_reload; RPE≤5; no PRs |
| `deload_after_stacked_flags` | stacked deload triggers → `deload`; protocol % via `computePrescription` |
| `pain_override_session_replan` | pain note on a pattern → replace loaded movement; explainable reason |

**Worked fixture (cardio intervals blocked by recovery — proves the deterministic downgrade):**

```json
{
  "user_profile": { "cardio": 0.7, "general_fitness": 0.6, "strength": 0.3 },
  "inputs": {
    "requested_objective": "cardio_intervals",
    "available_time_min": 45,
    "recent_history": ["Run 5 km hard intervals (2 days ago)", "Long Zone 2 run (yesterday)"],
    "readiness_signal": { "recovery_fit": 0.25, "elevated_resting_hr": true }
  },
  "expect": {
    "session_objective": "cardio_base",
    "objective_reason": "intervals scored high on profile/goal but recovery_fit 0.25 + recent hard quality → fatigue_conflict penalty flips selection to cardio_base",
    "planned_session": { "piece": "Easy run", "duration_min": 35, "zone": "Z2", "rir": null },
    "fatigue_adjusted_session": { "duration_min": 25, "zone": "Z2" },
    "exercise_order_reason": "cardio is primary → cardio first; no quality intervals under poor recovery",
    "target_effort": "Zone 2 (60-70% HRR) / RPE 4-6; RIR N/A",
    "coach_explanation": { "rule": "explain the downgrade as recovery protection, base-work framing", "shape": "conclusion-first" },
    "next_action": "log the easy run; re-evaluate intervals once recovery_fit recovers"
  }
}
```

---

## 9. Relationship to other planned systems

Clear boundaries so each system owns one job:

- **Training Profile Taxonomy** ([`docs/TRAINING_PROFILE_TAXONOMY.md`](TRAINING_PROFILE_TAXONOMY.md)) —
  defines **who the user is** (profile scores, modality concepts).
- **Session Planning Engine** (this doc) — chooses **today's objective and the ordered plan** (pre-session).
- **Exercise Modality Schema** (taxonomy §3) — defines **what each exercise is** (`load_type`,
  `fatigue_class`, `effort_metric`, `progression_metric`); the planner reads it to order and target.
- **Stimulus Governor** (taxonomy §5) — evaluates **logged work** (did it earn progression / hold / signal
  fatigue), per profile + modality.
- **Live Fatigue Router** (taxonomy §6) — adjusts the **active session after logs** land (the planner sets
  the plan; the router mutates it mid-session).
- **Coach Voice Renderer** — **words** the deterministic decisions; never selects objectives or invents
  numbers (`docs/COACH_VOICE_VALIDATION.md`).
- **Recovery / Deload Engine** (`docs/DELOAD_SPEC.md`, `services/deloadState.js`, `suggestDeloads`) —
  aggregates **multi-session fatigue**; when it fires, it forces the `deload` objective in §4.10.

Flow: *Taxonomy (who) → Planning Engine (today's objective + plan) → [session runs] → Stimulus Governor
(grade logs) + Live Fatigue Router (adjust live) → Recovery/Deload Engine (across sessions) → feeds back into
the next plan.* The Coach Voice Renderer narrates each step.

---

## 10. Recovery & deload model

> Grounded in the *Deloading in Resistance Training* research report + the existing
> [`docs/DELOAD_SPEC.md`](DELOAD_SPEC.md). **Planning-layer only.** This section documents *when* the planner
> selects `recovery_reload` / `deload` (vs normal training, micro-adjustment, taper, maintenance, complete
> rest) and *how a deload is styled by profile*. It does **not** change the deload prescription engine — the
> actual protocol numbers remain owned by `computePrescription` / `docs/DELOAD_SPEC.md` (AI decides *if*, the
> engine decides *what*). No deload behavior is implemented here.

### 10.1 Recovery / deload concepts (the boundary)

| Concept | What it is | Default use / trigger |
|---|---|---|
| **Normal fatigue routing** | In-session / next-session tweaks (taxonomy §6, this doc §7) | one or a single local signal; no phase change |
| **`recovery_reload`** | A *lighter adjustment* before a full deload is warranted | a few stacked fatigue signals across days |
| **`deload`** | A short period of *reduced training stress* to dissipate fatigue and restore readiness | convergence of fatigue + performance signals |
| **Taper** | A *competition/test peaking* strategy (cut volume, **keep intensity**, sharpen) — **not** a normal deload | a test / competition date is approaching |
| **Maintenance phase** | A *longer reduced-dose* period to **preserve adaptations** | an extended span where progress is paused on purpose (life/season) |
| **Complete rest** | *Training cessation* — **not** the default deload | illness / burnout / injury flare |

Boundary rules: a deload is **reduced stress, not stopping** (complete rest is rarer and different); a taper
is **peaking** (keep intensity, cut volume) — never conflate it with a fatigue-dissipation deload;
`recovery_reload` sits **below** deload (the lighter touch that may prevent a full one).

### 10.2 Deload trigger logic (deterministic, convergence-based)

**Atlas should not deload after one bad session. It looks for convergence of signals.** Trigger examples:

- repeated **RIR 0 / missed reps** on main lifts
- **performance decline** across repeated exposures (e1RM / reps-at-load trending down)
- high **soreness or joint aches**
- poor **sleep, mood, motivation, or readiness** (opt-in/volunteered or watch-derived)
- **normal loads feeling abnormally hard**
- **session RPE rising at unchanged workload** (effort drift)
- **multiple markers moving the wrong way together**

Concrete convergence thresholds (initial defaults — **fixture-protected before shipping**, like the §3
weights):

- **3 moderate warning signals within 7 days** → `recovery_reload` / `deload` review
- **2 consecutive sessions** with unplanned RIR 0 / missed reps on main lifts → `deload` candidate
- **readiness red for 3 planned training days** → `deload` candidate
- **pain warning major** → pivot/stop the affected pattern (a *pain override*, not by itself a deload)

These extend the existing deload-trigger machinery (`suggestDeloads`, `annotateStallsForDeload` in
`services/coverageStalls.js`, `detectStalls`) — which already triggers on *primary-lift* evidence and
ignores progressing accessories — with a multi-signal convergence view.

### 10.3 Default deload prescription (defaults; engine owns the numbers)

- usually **5–7 days**
- **reduce volume first**
- cut weekly sets roughly **30–60%**
- **reduce proximity to failure** (raise RIR)
- **keep key movement patterns** where possible
- **avoid brand-new exercises** that create new soreness
- **preserve technical rhythm** for strength/power users
- **remove first:** grinders, failure work, intensifiers, excessive accessories, high-density conditioning

The concrete load/volume math stays in `computePrescription` / `docs/DELOAD_SPEC.md` (predefined protocols,
not invented numbers).

### 10.4 Profile-aware deload styles

(extends taxonomy profiles 1–5; the deload is *styled* to the user)

- **Strength:** preserve main-lift exposure and bar feel; cut accessory volume first; reduce grinders /
  repeated hard sets; deadlift/hinge may need a **stronger** reduction than bench; keep some moderate/heavy
  technical work if pain-free.
- **Hypertrophy:** cut hard sets **30–50%**; avoid failure and intensifiers; keep familiar exercises; reduce
  redundant pump work; **volume reduction matters more than total rest**.
- **General fitness:** preserve routine and habit; reduce session length, effort, and complexity; use easy
  full-body / machines / walking / light cardio; **protect adherence**.
- **Cardio / endurance:** switch hard intervals to **base/easy** work; reduce high-zone volume; preserve
  easy aerobic rhythm; don't stack hard sessions when recovery markers are poor.
- **Bodyweight / circuit:** reduce density, rounds, hard progressions, and near-failure work; preserve skill
  patterns with **easier leverage**; reduce high-eccentric gymnastics / kipping / plyometric stress; use
  easier versions rather than novel soreness-inducing movements.

### 10.5 Session planning integration — the recovery decision ladder

How the planner chooses among **normal training · micro-adjustment · `recovery_reload` · `deload` · taper ·
complete rest**:

1. **one isolated bad signal** → adjust **today only** (normal fatigue routing).
2. **one local fatigue signal** → reduce or **reroute that muscle/pattern** (taxonomy §6).
3. **multiple fatigue signals across several days** → **`recovery_reload`**.
4. **repeated performance decline + subjective fatigue** → **`deload`**.
5. **pain warning major** → **pivot/stop the affected pattern** (pain override — not necessarily a deload).
6. **competition / test date approaching** → **taper**, not a generic deload.
7. **illness / burnout / injury flare** → **complete rest** may be recommended.

This ladder is the deterministic front of §3's objective scoring: a converged deload/recovery signal raises
the `recovery_fit` / `fatigue_conflict` terms and forces the corresponding objective; every choice is
explainable from the converged signals.

### 10.6 Coach voice examples

- "One bad day is not a deload. We adjust today and watch the trend."
- "Too many yellow flags stacked together. This is recovery work now."
- "We are cutting volume, not quitting."
- "Deload means reduce the stress, keep the rhythm."
- "No new weird exercises this week. The goal is to recover, not create fresh soreness."
- "This is not weakness. This is setting up the next push."
- "You do not get to turn deload week into slightly easier hard training."

### 10.7 Test matrix additions (deload / recovery)

Same assertion fields as §8 (`user_profile` … `next_action`):

| Fixture | Asserts |
|---|---|
| `single_bad_session_no_deload` | one bad session → adjust today only; **no deload** |
| `local_fatigue_micro_adjustment` | one local signal → reduce/reroute that pattern only |
| `repeated_rir0_main_lift_deload` | 2 consecutive RIR 0 on a main lift → `deload` candidate |
| `high_soreness_plus_poor_sleep_recovery_reload` | stacked soreness + poor sleep → `recovery_reload` |
| `strength_volume_led_deload` | strength deload preserves main-lift feel, cuts accessory volume first |
| `hypertrophy_failure_work_removed` | hypertrophy deload cuts hard sets 30–50%, removes failure/intensifiers |
| `cardio_intervals_to_base_deload` | cardio deload swaps intervals → easy base, cuts high-zone volume |
| `bodyweight_density_reduction` | bodyweight deload reduces density/rounds, easier leverage, no novel soreness |
| `pain_override_not_deload` | pain-major → pivot/stop affected pattern, **not** a blanket deload |
| `taper_vs_deload_distinction` | test date near → **taper** (keep intensity, cut volume), not a fatigue deload |
| `complete_rest_for_illness_or_burnout` | illness / burnout / injury flare → **complete rest** recommendation |

---

## 11. Guardrails

- **Deterministic-first.** The engine selects the objective and orders the plan from explainable facts; the
  LLM only words the result.
- **LLM only words engine facts.** No invented objectives, loads, verdicts, or rules.
- **No production behavior in this PR.** Docs / fixtures-as-proposals only.
- **No parser or write/logging-path changes.** Slash-notation contract, `test_mode`/proof fields, and the
  preview→approve→write trust loop are untouched and owner-gated.
- **No Sheet schema migration.** `Log_Cleaned` (12) / `Effort` (9) / `Constraints` (5) / `Deload_State` (7)
  unchanged; any new persistence is an **[owner-gated migration]** decided at build time, not here.
- **No vague AI-only planning decisions.** Every planned decision must be explainable from profile, goal,
  exercise type, recent logs, fatigue, readiness, equipment, time, or constraints.
- **Weights are fixture-protected before shipping** (§3) — no silent weight drift.
- **No deload implementation.** §10 documents planning-layer *selection* (when to pick `recovery_reload` /
  `deload` / taper / maintenance / complete rest) only; the deload prescription engine (`computePrescription`)
  and `docs/DELOAD_SPEC.md` protocols are unchanged. Every deload recommendation must be explainable from
  logged performance, fatigue signals, profile, modality, pain, or readiness history.
- **One small planning PR. Do not merge** without owner direction.

---

## Model recommendation gate

- **Recommended model:** **Sonnet** — sufficient for docs/planning-only work of this complexity.
- *Standing-instruction note:* per `CLAUDE.md` the builder runs on **Opus 4.8** for all work (no model
  check-in), so this PR was built on Opus 4.8 and the merge card records Opus 4.8. Sonnet is the
  recommendation *for this work class*; it does not override the standing instruction.
- **Risk level:** **Low** — planning/docs + fixture *proposals* only; no production code, parser, write
  path, schema, or trust-loop change.

**Stop here.** No production behavior work proceeds until the owner promotes a slice into
`docs/ACTIVE_ROADMAP.md`.
