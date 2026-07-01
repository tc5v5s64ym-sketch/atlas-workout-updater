# SESSION_DESIGN.md — How Atlas builds a workout

> **Related session-building docs — which is canonical:** this is the older design of Atlas's current/legacy session-building logic. The **canonical Brain-native session engine is now** [`docs/COACHING_SESSION_GENERATOR_SPEC.md`](docs/COACHING_SESSION_GENERATOR_SPEC.md) (shipped — One-Brain keystone #2); the *future, owner-gated* profile-aware objective-selection layer is [`docs/SESSION_PLANNING_ENGINE.md`](docs/SESSION_PLANNING_ENGINE.md). Read this doc as background/legacy design; for the One-Brain build, defer to the Session Generator spec.

> Feeds the existing plan. It makes one previously-optional PR required, adds one small engine signal in Phase 3, and rewrites PR 4.2. Same discipline as everything else: tiny PRs, verify before changing, golden fixtures, engine owns the numbers / the coach only words them.

## What it is (plain terms)

The logic that turns "I want to train today" into a specific, balanced workout — a coach's judgment written as rules. Every training session is built in three moves, with two safety rules layered on top.

1. Anchor — one major compound the day is built around. Gets your freshest energy. Chosen by goal + what's recovered + what hasn't been trained lately.
1. Support — a few accessories that serve the anchor: same prime movers plus weak-point work, capped so the anchor's muscle isn't overcooked.
1. Balance — one or two lifts that fill what's been neglected this week, so you don't drift lopsided.

Rule A — pairing: never stack two heavy lifts that tax the same recovery system. Rule B — balance watch: keep push-vs-pull and front-vs-back volume from running away from each other, and nudge (never mandate) when they do.

---

## The three layers, concretely

### Anchor pool

Draw from main + strong-secondary compounds, grouped by movement pattern, freshest first:

- Squat: anchor Back Squat; fallback Leg Press family
- Hinge: anchors Deadlift, RDL
- Horizontal push: anchor Bench Press; fallback Incline DB Press, Dips
- Vertical push: anchor Overhead Press
- Horizontal pull: anchors Barbell / Bent-Over Row; fallback Seated Row
- Vertical pull: no true anchor; fallback Lat Pulldown

Anchor selection prefers the pattern least recently anchored (rotation), that is recovered (per-region fatigue), and that fits the goal (PR 4.0). At low frequency (~2x/week) a session carries two anchors (one lower + one upper); only fragment to a single deep-focus anchor when frequency supports it.

### Support

Pick accessories whose primary muscle (from muscleCoverage) matches the anchor's primaries/secondaries — e.g. Bench -> incline, dips, triceps; Squat -> leg press/extension, posterior chain.

- Cap: support must not push any single muscle past its weekly target in one session (no four-chest-exercise days).
- Support may share the anchor's muscles only if its systemic cost is low (see cost tiers). This is why Bench + Dips works but Deadlift + RDL does not — RDL is a high-cost hinge, so it behaves like a second anchor, not support.

### Balance

Reserve at least one slot (never optional) for the biggest current gap, fed by the balance signal below.

- For this athlete today: biases to upper-back / rear-delt volume, some vertical/overhead work, and treating squat as a weak-link anchor to prioritize (squat ~ bench, well below deadlift).

---

## Rule A — the pairing / competition check

A session has budgets — lower/posterior, push, pull, CNS — and each funds one peak lift.

- Two anchors must be different patterns AND must not both be HIGH-cost in a shared system.
- Hinge is protected hardest (slowest to recover, taxed by the most lifts): at most one heavy hinge per session, and don't pair a heavy hinge with a heavy back squat or heavy bent-over row (all draw on the lower back). Pair a hinge with an upper anchor instead.
- Redundant same-pattern compounds (Row x Row x Pulldown; Squat x Leg Press) -> keep one as anchor, demote the rest to support.

Systemic-cost tiers (this catalog):

- HIGH: Deadlift, Back Squat, RDL, heavy Barbell/Bent-Over Row
- MEDIUM: Bench, OHP, Seated Row, Lat Pulldown, Leg Press family, Incline DB Press, Weighted Dips
- LOW: all isolation / accessories

Blocked co-anchor pairs: Deadlift x RDL; Deadlift x Back Squat (unless an explicit "heavy day" override); Back Squat x Leg Press; two heavy pulls.
Favored pairs: Squat + Bench; Squat + OHP; Bench + Row (also = balance); Deadlift + OHP/Pulldown.

Open decision: Squat + Deadlift same day — block by default, allow as an opt-in "heavy day"? Default = separate.

---

## Rule B — the balance signal (extends Phase 3)

A small, read-only engine signal alongside the under-coverage signal. Works on volume ratios across antagonist pairs, not 1RM percentages.

Pairs to watch: horizontal push : horizontal pull, vertical push : vertical pull, anterior : posterior (overall), quad : hamstring.

For each pair return { pair, ratio, status, reason } where status is one of balanced | worth_a_nudge | real_gap, using wide bands (starting point, tune against real logs — do NOT ship as if precise):

- ~0.75-1.4 -> balanced
- outside that, mildly -> worth_a_nudge
- strongly skewed (e.g. push volume >= ~2x pull) -> real_gap

What this is NOT: a structural-balance percentage table ("triceps pushdown must be X% of bench"). Those depend on implement/leverage and aren't reliable — Atlas would flag noise. Strength-ratio checks, if any, stay as wide weak-link flags ("a main lift is lagging the pack"), never precise targets.

Tone: outputs are nudges — "upper-back and rear-delt volume are trailing your pressing; worth a balance slot." Never mandates. Chasing exact ratios isn't itself protective; not chronically neglecting the antagonist is.

---

## Set progression — warm-up ramps

The working sets are only half a prescription. A heavy compound needs a climb into its working weight — flat sets (235x8 three times, cold) are wrong and unsafe for the first heavy lift of a pattern.

Rule: ramp into the working sets on a compound when the lifter isn't already warm for that movement; skip the ramp when they are.

- A ramp is ascending load, submaximal and easy on the way up (high RIR — these sets are priming, not working), reps tapering as load climbs, landing on the prescribed working sets. e.g. Bench -> 135x10, 185x8, then 225x5x3. Squat -> 125 -> 185 -> 205 -> working. Deadlift similar. You never walk up cold to a heavy single-pattern lift.
- "Already warm" = session order + pattern/muscle overlap with an earlier lift. Dips after Bench -> no ramp (same musculature already primed). This reuses the movement-pattern + muscle-coverage maps — the same overlap logic as the pairing rule, just pointed at warmth instead of fatigue.
- Ramp depth scales with working load and how cold the pattern is: first heavy hinge/squat/press of the day -> full ramp; a later compound sharing an already-warm pattern -> minimal or none; accessories -> none.
- Warm-up sets are flagged as priming and do NOT count as working volume — otherwise they inflate effective-set counts and skew the coverage/balance math.

Lands in PR 4.2: after anchor -> support -> balance are chosen and ordered, layer ramps onto each working lift based on its position and the warmth state.

---

## How it lands in the plan (build order, each a tiny PR)

1. PR 1.3 — movement-pattern map (was optional -> now required): the pairing rule needs patterns. Build services/movementPattern.js as specced.
1. PR (small) — systemic-cost tier: a tiny lookup (HIGH/MEDIUM/LOW by name pattern), either added to liftRole or its own services/liftCost.js. Pure data, tests only.
1. PR 3.x — balance signal: antagonist-ratio engine above, read-only, golden fixtures. Sibling to the under-coverage signal; nothing surfaces it yet.
1. PR 4.2 — session builder (the capstone, rewritten): anchor -> support -> balance, consuming muscleCoverage + muscleVolume + under-coverage + balance signal + movementPattern + cost tier + the pairing check. Verify existing builders first; enrich, don't replace. Every offered option must build a coherent, pairing-legal, balanced session for today, or be de-emphasized. Order the session (anchor first), then layer warm-up ramps per Set progression above (warm-ups flagged priming, not working volume). Golden fixtures per representative archetype (incl. a blocked-pair case, e.g. it never outputs Deadlift + RDL; and a ramp case, e.g. cold Deadlift gets a ramp but Dips-after-Bench does not).

Phase order is otherwise unchanged: still finish Phase 2 and Phase 3 before the PR 4.2 capstone. The model hold-points still apply.

---

## Acceptance cases — PR 4.2 must prove these

Drawn from a real "Fix Blind Spots — Pulling + Core" session the current (pre-4.2) builder produced on 2026-06-16. Each is a required golden fixture; the capstone must demonstrably fix it.

1. Brief must match the session (no empty promises). If the session's stated focus names a pattern/priority, the built session must contain at least one lift for it. Real bug: the brief said core was the top priority ("especially that long gap in core training") and the session contained zero core lifts. The engine owns selection; the narration may only describe what's actually in the session — never name a priority that isn't there.
1. No duplicate lifts. Each lift appears at most once per session. Real bug: Seated Row was programmed twice (190x11 and 190x10). De-dup before prescribing.
1. Cap per-muscle work (no overcooking). At most one direct isolation per muscle per session, and total work for a muscle respects its weekly ceiling including indirect credit. Real bug: Hammer Curls + Dumbbell Curl stacked on top of biceps already hit by the pulldown and both rows.
1. Anchor + ramp. A pattern-focused day is built around an anchor (e.g. a Barbell Row anchors a pull day), not a pile of machine/cable accessories; and the lead compound gets a warm-up ramp, not flat sets from set one. Real bug: no anchor, flat sets throughout.
1. Prescribed load must be physically plausible for the lift. Real bug (2026-06-16): Lateral Raises prescribed at 170 lbs (athlete's actual is ~15). Root cause: the "Lateral Raise" / "Lateral Raises" dual-naming meant the engine couldn't resolve real history and fell back to a bogus weight. Guard, two parts: (a) canonicalize duplicate lift names so history resolves; (b) a per-lift sanity check — if a prescribed load is wildly outside that lift's own logged history (or a sane ceiling for the movement class), never print it; fall back to the lifter's real working weight or ask. A lateral raise must never print 170.

Fixture form: feed a known state, assert the built session (a) includes every pattern its brief names, (b) repeats no lift, (c) has <=1 isolation per muscle and no muscle over ceiling, (d) is anchored and ramps its lead compound, (e) all prescribed loads fall within a plausible range for the lift and the lifter. A session that can't satisfy these is de-emphasized, not shipped.

---

## Guardrails (carry into every PR here)

- Engine owns the numbers; the coach only words them.
- Volume-first balance, wide bands, nudges not mandates, no precise structural-balance table.
- Pairing rule must block the unsafe stacks (golden-fixture them), not merely prefer against them.
- Reserve the balance slot — it is never dropped to fit more support.
- Single-concern PRs; update BACKLOG.md in the same PR.
