# SESSION_DESIGN.md — How Atlas builds a workout

> Feeds the existing plan. It makes one previously-optional PR required, adds one small engine signal in Phase 3, and rewrites PR 4.2. Same discipline as everything else: tiny PRs, verify before changing, golden fixtures, engine owns the numbers / the coach only words them.

---

## What it is (plain terms)

The logic that turns "I want to train today" into a specific, balanced workout — a coach's judgment written as rules. Every training session is built in three moves, with two safety rules layered on top.

**1. Anchor** — one major compound the day is built around. Gets your freshest energy. Chosen by goal + what's recovered + what hasn't been trained lately.

**2. Support** — a few accessories that *serve the anchor*: same prime movers plus weak-point work, capped so the anchor's muscle isn't overcooked.

**3. Balance** — one or two lifts that fill what's been neglected this week, so you don't drift lopsided.

**Rule A — pairing:** never stack two heavy lifts that tax the same recovery system. **Rule B — balance watch:** keep push-vs-pull and front-vs-back *volume* from running away from each other, and nudge (never mandate) when they do.

---

## The three layers, concretely

### Anchor pool
Draw from main + strong-secondary compounds, grouped by movement pattern, freshest first:

| Pattern | Anchor | Fallback (secondary compound) |
|---|---|---|
| Squat | Back Squat | Leg Press family |
| Hinge | Deadlift, RDL | — |
| Horizontal push | Bench Press | Incline DB Press, Dips |
| Vertical push | Overhead Press | — |
| Horizontal pull | Barbell / Bent-Over Row | Seated Row |
| Vertical pull | *(none true)* | Lat Pulldown |

Anchor selection prefers the pattern **least recently anchored** (rotation), that is **recovered** (per-region fatigue), and that fits the **goal** (PR 4.0). At low frequency (~2×/week) a session carries **two anchors** (e.g. one lower + one upper); only fragment to a single deep-focus anchor when frequency supports it.

### Support
Pick accessories whose **primary muscle** (from `muscleCoverage`) matches the anchor's primaries/secondaries — e.g. Bench → incline, dips, triceps; Squat → leg press/extension, posterior chain.
- **Cap:** support must not push any single muscle past its weekly target in one session (no four-chest-exercise days).
- Support may share the anchor's muscles **only if its systemic cost is low** (see cost tiers). This is why **Bench + Dips works** but **Deadlift + RDL does not** — RDL is a high-cost hinge, so it behaves like a second anchor, not support.

### Balance
Reserve **at least one slot** (never optional) for the biggest current gap, fed by the balance signal below.
- For this athlete today: biases to **upper-back / rear-delt volume**, some **vertical/overhead** work, and treating **squat as a weak-link anchor to prioritize** (squat ≈ bench, well below deadlift).

---

## Rule A — the pairing / competition check

A session has budgets — **lower/posterior, push, pull, CNS** — and each funds **one** peak lift.

- **Two anchors must be different patterns** AND must not both be HIGH-cost in a shared system.
- **Hinge is protected hardest** (slowest to recover, taxed by the most lifts): at most **one heavy hinge** per session, and don't pair a heavy hinge with a heavy back squat or heavy bent-over row (all draw on the lower back). Pair a hinge with an **upper** anchor instead.
- Redundant same-pattern compounds (Row × Row × Pulldown; Squat × Leg Press) → keep one as anchor, demote the rest to support.

**Systemic-cost tiers (this catalog):**
- **HIGH:** Deadlift, Back Squat, RDL, heavy Barbell/Bent-Over Row
- **MEDIUM:** Bench, OHP, Seated Row, Lat Pulldown, Leg Press family, Incline DB Press, Weighted Dips
- **LOW:** all isolation / accessories

**Blocked co-anchor pairs:** Deadlift × RDL · Deadlift × Back Squat *(unless an explicit "heavy day" override)* · Back Squat × Leg Press · two heavy pulls.
**Favored pairs:** Squat + Bench · Squat + OHP · Bench + Row (also = balance) · Deadlift + OHP/Pulldown.

> **Open decision:** Squat + Deadlift same day — block by default, allow as an opt-in "heavy day"? Default = separate.

---

## Rule B — the balance signal (extends Phase 3)

A small, **read-only** engine signal alongside the under-coverage signal. Works on **volume ratios across antagonist pairs**, not 1RM percentages.

Pairs to watch: **horizontal push : horizontal pull**, **vertical push : vertical pull**, **anterior : posterior (overall)**, **quad : hamstring**.

For each pair return `{ pair, ratio, status, reason }` where status ∈ `balanced | worth_a_nudge | real_gap`, using **wide bands** (starting point, tune against real logs — do **not** ship as if precise):
- ~0.75–1.4 → balanced
- outside that, mildly → worth_a_nudge
- strongly skewed (e.g. push volume ≳ 2× pull) → real_gap

**What this is NOT:** a structural-balance percentage table ("triceps pushdown must be X% of bench"). Those depend on implement/leverage and aren't reliable — Atlas would flag noise. Strength-ratio checks, if any, stay as **wide weak-link flags** ("a main lift is lagging the pack"), never precise targets.

**Tone:** outputs are nudges — *"upper-back and rear-delt volume are trailing your pressing; worth a balance slot."* Never mandates. Chasing exact ratios isn't itself protective; not chronically neglecting the antagonist is.

---

## Set progression — warm-up ramps

The working sets are only half a prescription. A heavy compound needs a *climb* into its working weight — flat sets (235×8 three times, cold) are wrong and unsafe for the first heavy lift of a pattern.

**Rule:** ramp into the working sets on a compound **when the lifter isn't already warm for that movement**; skip the ramp when they are.

- A ramp is ascending load, **submaximal and easy on the way up** (high RIR — these sets are priming, not working), reps tapering as load climbs, landing on the prescribed working sets. e.g. Bench → 135×10, 185×8, then 225×5×3. Squat → 125 → 185 → 205 → working. Deadlift similar. You never walk up cold to a heavy single-pattern lift.
- **"Already warm" = session order + pattern/muscle overlap with an earlier lift.** Dips after Bench → no ramp (same musculature already primed). This reuses the **movement-pattern + muscle-coverage maps** — the *same* overlap logic as the pairing rule, just pointed at warmth instead of fatigue.
- Ramp depth scales with working load and how cold the pattern is: first heavy hinge/squat/press of the day → full ramp; a later compound sharing an already-warm pattern → minimal or none; accessories → none.
- **Warm-up sets are flagged as priming and do NOT count as working volume** — otherwise they inflate effective-set counts and skew the coverage/balance math.

Lands in PR 4.2: after anchor → support → balance are chosen *and ordered*, layer ramps onto each working lift based on its position and the warmth state.

---

## How it lands in the plan (build order, each a tiny PR)

1. **PR 1.3 — movement-pattern map** *(was optional → now required)*: the pairing rule needs patterns. Build `services/movementPattern.js` as specced.
2. **PR (small) — systemic-cost tier**: a tiny lookup (HIGH/MEDIUM/LOW by name pattern), either added to `liftRole` or its own `services/liftCost.js`. Pure data, tests only.
3. **PR 3.x — balance signal**: antagonist-ratio engine above, read-only, golden fixtures. Sibling to the under-coverage signal; nothing surfaces it yet.
4. **PR 4.2 — session builder** *(the capstone, rewritten)*: anchor → support → balance, consuming `muscleCoverage` + `muscleVolume` + under-coverage + balance signal + `movementPattern` + cost tier + the **pairing check**. Verify existing builders first; enrich, don't replace. Every offered option must build a coherent, pairing-legal, balanced session for today, or be de-emphasized. Order the session (anchor first), then layer warm-up ramps per **Set progression** above (warm-ups flagged priming, not working volume). Golden fixtures per representative archetype (incl. a blocked-pair case, e.g. it never outputs Deadlift + RDL; and a ramp case, e.g. cold Deadlift gets a ramp but Dips-after-Bench does not).

> Phase order is otherwise unchanged: still finish Phase 2 (coverage-aware stalls) and Phase 3 (under-coverage + this balance signal) before the PR 4.2 capstone. The model hold-points still apply.

---

## Guardrails (carry into every PR here)

- Engine owns the numbers; the coach only words them.
- Volume-first balance, wide bands, **nudges not mandates**, no precise structural-balance table.
- Pairing rule must **block** the unsafe stacks (golden-fixture them), not merely prefer against them.
- Reserve the balance slot — it is never dropped to fit more support.
- Single-concern PRs; update `BACKLOG.md` in the same PR.
