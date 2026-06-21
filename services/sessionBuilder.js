'use strict';

// Session builder — PR 4.2 capstone.
// Turns a pool of exercise recommendations into a structured, coherent session:
//   Anchor → Support → Balance
// with pairing-safety, de-duplication, per-muscle isolation cap, and warm-up ramps.
//
// Imports only pure-data services (movementPattern, liftCost, muscleCoverage) so
// there is no load-time cycle with analytics.js.

const { patternFor } = require('./movementPattern');
const { costFor } = require('./liftCost');
const { musclesFor } = require('./muscleCoverage');
const { classifyLiftRole } = require('./liftRole');

// Round to nearest 5 lb (standard plate increment).
function roundTo5(lb) {
  return Math.round(lb / 5) * 5;
}

// Build a warm-up ramp into a working weight.
// Returns 3 priming sets at 50 % / 70 % / 85 %, reps 8 / 5 / 3.
// All sets are flagged priming:true — they are NOT counted as working volume.
// Returns [] when workingWeight is missing or not finite-positive.
function buildWarmupRamp(workingWeight) {
  if (!Number.isFinite(workingWeight) || workingWeight <= 0) return [];
  return [
    { weight: Math.max(45, roundTo5(workingWeight * 0.50)), reps: 8, priming: true },
    { weight: Math.max(45, roundTo5(workingWeight * 0.70)), reps: 5, priming: true },
    { weight: Math.max(45, roundTo5(workingWeight * 0.85)), reps: 3, priming: true },
  ];
}

// Block a co-anchor pair when BOTH exercises share the same fine-grained movement
// pattern (from movementPattern.js) AND both are HIGH systemic cost.
//
// Blocks:  Deadlift + RDL           (hinge + hinge, both HIGH)
//          two heavy barbell rows   (horizontal_pull + horizontal_pull, both HIGH)
// Allows:  Back Squat + Deadlift   (squat ≠ hinge → always allowed)
//          Bench + Row             (horizontal_push ≠ horizontal_pull)
//
// Per owner decision in BACKLOG.md and SESSION_DESIGN.md Rule A.
function isBlockedPair(nameA, nameB) {
  if (!nameA || !nameB) return false;
  const pa = patternFor(nameA).pattern;
  const pb = patternFor(nameB).pattern;
  if (pa !== pb) return false;                    // different patterns → never blocked
  return costFor(nameA).cost === 'high' && costFor(nameB).cost === 'high';
}

// Build a structured session from a pool of exercise recommendations.
//
// Layers:
//   1. Anchor — first HIGH- or MEDIUM-cost compound in the candidate pool.
//               Gets a warm-up ramp (50 % / 70 % / 85 % of working weight).
//   2. Support — remaining candidates that pass:
//               a) pairing check (not a blocked co-anchor)
//               b) isolation cap (≤ 1 isolation per primary muscle)
//               c) de-duplication (name and lift_code uniqueness)
//   3. Balance — one slot reserved for the most under-served muscle not yet
//               covered by the session; draws from ALL allRecs, not just the
//               filtered candidates. Never squeezed out by support lifts.
//
// Parameters:
//   patterns        — string[] — coarse patterns to draw candidates from
//                    (push / pull / lower / hinge / core)
//   allRecs         — array from scoreIntents — each entry has exercise_name,
//                    liftCode, pattern (coarse), next_target, recommendation
//   underCoverageData — array from computeUnderCoverage — { muscle, status }
//   maxExercises    — default 6
//
// Returns { exercises, anchor, coveredPatterns } where:
//   exercises      — ordered list (anchor first); each entry has is_anchor and,
//                   for the anchor, warmup_sets: [{weight, reps, priming}]
//   anchor         — exercise_name of the anchor, or null if only isolations found
//   coveredPatterns — Set of coarse patterns actually present in the session
//                    (used by callers to avoid claiming a pattern not scheduled)
function buildIntentSession({
  patterns = [],
  allRecs = [],
  underCoverageData = [],
  maxExercises = 6,
} = {}) {
  const underMuscles = underCoverageData
    .filter(m => m.status === 'under')
    .map(m => m.muscle);

  const candidates = allRecs.filter(
    r => r.exercise_name && r.next_target && patterns.includes(r.pattern)
  );

  const seen = new Set();           // lowercase exercise_name → de-dup by name
  const seenCodes = new Set();      // lift_code → de-dup by code
  const isoMusclesUsed = new Set(); // muscles already covered by an isolation

  const exercises = [];
  let anchor = null;

  // ── 1. Anchor ────────────────────────────────────────────────────────────────
  for (const rec of candidates) {
    if (costFor(rec.exercise_name).cost === 'low') continue; // isolation → skip
    anchor = rec.exercise_name;
    exercises.push({
      exercise: rec.exercise_name,
      lift_code: rec.liftCode,
      target_weight: rec.next_target.weight,
      target_reps: rec.next_target.reps,
      target_sets: rec.next_target.sets,
      reason: rec.recommendation,
      is_anchor: true,
      warmup_sets: buildWarmupRamp(rec.next_target.weight),
      confidence_factors: {
        sessions:        rec.sessions_analyzed,
        data_age_days:   rec.days_since_last_session,
        trend:           rec.e1rm_trend,
        lift_confidence: rec.confidence,
      },
    });
    seen.add(rec.exercise_name.toLowerCase());
    seenCodes.add(rec.liftCode);
    break;
  }

  // ── 2. Support ───────────────────────────────────────────────────────────────
  // Only reserve a balance slot when a lift that covers an under-served muscle
  // actually exists in allRecs — otherwise support fills to maxExercises and the
  // balance block below is a no-op (never wastes the reserved slot).
  const balancePossible = underMuscles.length > 0 && allRecs.some(r => {
    if (!r.exercise_name || !r.next_target) return false;
    const ms = musclesFor(r.exercise_name);
    return underMuscles.some(m => ms.primary.includes(m) || ms.secondary.includes(m));
  });
  const supportCap = balancePossible ? maxExercises - 1 : maxExercises;
  for (const rec of candidates) {
    if (exercises.length >= supportCap) break;
    const nameLower = rec.exercise_name.toLowerCase();
    if (seen.has(nameLower) || seenCodes.has(rec.liftCode)) continue;

    // Pairing check: block two HIGH-cost exercises sharing the same fine-grained pattern
    if (anchor && isBlockedPair(anchor, rec.exercise_name)) continue;

    // Isolation cap: at most one isolation per primary muscle
    if (costFor(rec.exercise_name).cost === 'low') {
      const primaries = musclesFor(rec.exercise_name).primary;
      if (primaries.some(m => isoMusclesUsed.has(m))) continue;
      primaries.forEach(m => isoMusclesUsed.add(m));
    }

    exercises.push({
      exercise: rec.exercise_name,
      lift_code: rec.liftCode,
      target_weight: rec.next_target.weight,
      target_reps: rec.next_target.reps,
      target_sets: rec.next_target.sets,
      reason: rec.recommendation,
      is_anchor: false,
      confidence_factors: {
        sessions:        rec.sessions_analyzed,
        data_age_days:   rec.days_since_last_session,
        trend:           rec.e1rm_trend,
        lift_confidence: rec.confidence,
      },
    });
    seen.add(nameLower);
    seenCodes.add(rec.liftCode);
  }

  // ── 3. Balance ───────────────────────────────────────────────────────────────
  // Draw from ALL allRecs (not just pattern-filtered) to fill the biggest gap.
  if (exercises.length < maxExercises && underMuscles.length > 0) {
    for (const muscle of underMuscles) {
      const balanceRec = allRecs.find(r => {
        if (!r.exercise_name || !r.next_target) return false;
        if (seen.has(r.exercise_name.toLowerCase()) || seenCodes.has(r.liftCode)) return false;
        const ms = musclesFor(r.exercise_name);
        return ms.primary.includes(muscle) || ms.secondary.includes(muscle);
      });
      if (balanceRec) {
        exercises.push({
          exercise: balanceRec.exercise_name,
          lift_code: balanceRec.liftCode,
          target_weight: balanceRec.next_target.weight,
          target_reps: balanceRec.next_target.reps,
          target_sets: balanceRec.next_target.sets,
          reason: `Balance — ${muscle} is under-served this week`,
          is_anchor: false,
          confidence_factors: {
            sessions:        balanceRec.sessions_analyzed,
            data_age_days:   balanceRec.days_since_last_session,
            trend:           balanceRec.e1rm_trend,
            lift_confidence: balanceRec.confidence,
          },
        });
        seen.add(balanceRec.exercise_name.toLowerCase());
        seenCodes.add(balanceRec.liftCode);
        break;
      }
    }
  }

  // Covered coarse patterns — callers use this to build accurate briefs (AC1).
  const coveredPatterns = new Set(
    exercises
      .map(e => allRecs.find(r => r.liftCode === e.lift_code)?.pattern)
      .filter(Boolean)
  );

  return { exercises, anchor, coveredPatterns };
}

// Order an exercise list by lift role so main compounds come first, then
// secondary compounds, then accessories/isolations — per SESSION_DESIGN.md
// (a session is "built around an anchor … not a pile of machine/cable
// accessories") and the owner's lower-body ordering direction (primary →
// secondary → leg-press/unilateral → isolation last). Roles come from the
// existing deterministic `classifyLiftRole` (name-first); no new taxonomy.
//
// Pure + STABLE: relative order within a role tier is preserved (so the
// upstream recency order still breaks ties), and a `secondary`-defaulted lift
// keeps its place. Accessories never jump ahead of a compound, and a heavy
// compound is never buried after an isolation.
const ROLE_RANK = { main: 0, secondary: 1, accessory: 2 };
function orderByRole(exercises) {
  if (!Array.isArray(exercises) || exercises.length === 0) return exercises || [];
  // Decorate-sort-undecorate: classify each lift's role once, not per comparison.
  return exercises
    .map((ex, i) => ({ ex, i, rank: ROLE_RANK[classifyLiftRole(ex && ex.exercise || '', ex && ex.muscle_group || '')] ?? 1 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i) // stable within a tier
    .map(x => x.ex);
}

// Attach an engine-owned warm-up ramp to the MAIN compounds of an already-ordered
// exercise list, per SESSION_DESIGN.md "Set progression — warm-up ramps": the
// first heavy compound of each movement pattern climbs into its working sets
// (flat sets from set one are "wrong and unsafe"); later same-pattern compounds
// (already warm) and all secondary/accessory lifts stay flat.
//
// Generalizes #456's lead-compound-only ramp: the lead main compound still ramps
// (that behavior is preserved), AND a second main compound of a DIFFERENT pattern
// (e.g. Back Squat after Deadlift — squat vs hinge) now also ramps, since the
// lifter is not yet warm for that pattern. A second main of the SAME pattern
// (e.g. RDL after Deadlift — both hinge) stays flat; reduced-depth "already-warm"
// priming is a deferred follow-up rather than a fabricated partial ramp.
//
// Pure: returns new objects for the ramped compounds; working sets are unchanged
// (the ramp is ADDED before them). Safe by construction:
//   - Idempotent: if any entry already carries is_anchor / warmup_sets (a list a
//     structured builder already ramped), the list is returned untouched.
//   - Only `main`-role lifts ramp (via classifyLiftRole, name-first); secondary
//     and accessory/isolation lifts never ramp.
//   - buildWarmupRamp returns [] for a missing / non-finite working weight, so a
//     main lift with no known working weight gets no ramp (never a fabricated load).
function attachMainCompoundWarmups(exercises) {
  if (!Array.isArray(exercises) || exercises.length === 0) return exercises || [];
  // Already ramped by a builder that owns ramp selection — leave as-is.
  if (exercises.some(ex => ex && (ex.is_anchor || (Array.isArray(ex.warmup_sets) && ex.warmup_sets.length)))) {
    return exercises;
  }
  const warmedPatterns = new Set();
  return exercises.map(ex => {
    if (!ex || !ex.exercise) return ex;
    if (classifyLiftRole(ex.exercise, ex.muscle_group) !== 'main') return ex; // secondary/accessory stay flat
    const pattern = patternFor(ex.exercise).pattern || ex.exercise;
    if (warmedPatterns.has(pattern)) return ex; // already-warm same-pattern compound → flat (reduced depth deferred)
    const ramp = buildWarmupRamp(ex.target_weight);
    if (!ramp.length) return ex;                // unknown working weight → no fabricated ramp
    warmedPatterns.add(pattern);
    return { ...ex, is_anchor: true, warmup_sets: ramp };
  });
}

// Lower-body fine patterns (movementPattern.js): the two heavy compound patterns
// (squat, hinge) plus the leg isolations. Used to spot a double-heavy-leg day and
// the accessories that would over-stack it.
const LOWER_BODY_PATTERNS = new Set(['squat', 'hinge', 'knee_isolation', 'calf_isolation', 'hip_isolation']);
function isLowerBodyLift(ex) {
  return ex && ex.exercise && LOWER_BODY_PATTERNS.has(patternFor(ex.exercise).pattern);
}

// Lower-body session volume budget. When a strength session already contains TWO
// OR MORE main lower-body compounds (e.g. Deadlift + Back Squat), cap the number
// of lower-body ACCESSORIES so the day does not silently stack into an unintended
// high-volume leg session (the live "DL + Squat + leg press + leg ext + leg curl"
// overload). Per the owner's direction: with two heavy compounds present,
// accessories must be reduced.
//
// Pure + deterministic + conservative:
//   - Fires ONLY at ≥2 main lower-body compounds; a normal single-compound leg day
//     is never trimmed.
//   - Trims lower-body ACCESSORIES only (role accessory + lower-body pattern),
//     keeping the first `maxLowerAccessories` in their existing (already
//     role-ordered) order. Main + secondary compounds and ALL upper-body work are
//     untouched — the engine still owns what stays.
//   - Reduces volume by DROPPING surplus accessories (never fabricates or reweights
//     anything); planned-vs-logged and every number are unaffected.
function capLowerBodyAccessoriesForHeavyLegDay(exercises, { maxLowerAccessories = 1 } = {}) {
  if (!Array.isArray(exercises) || exercises.length === 0) return exercises || [];
  const mainLowerCompounds = exercises.filter(
    ex => ex && ex.exercise && classifyLiftRole(ex.exercise, ex.muscle_group) === 'main' && isLowerBodyLift(ex)
  ).length;
  if (mainLowerCompounds < 2) return exercises; // not a double-heavy-leg day → unchanged
  let keptLowerAccessories = 0;
  return exercises.filter(ex => {
    if (!ex || !ex.exercise) return true;
    const isLowerAccessory =
      classifyLiftRole(ex.exercise, ex.muscle_group) === 'accessory' && isLowerBodyLift(ex);
    if (!isLowerAccessory) return true; // mains, secondary, upper-body → always kept
    keptLowerAccessories += 1;
    return keptLowerAccessories <= maxLowerAccessories;
  });
}

module.exports = {
  buildWarmupRamp,
  isBlockedPair,
  buildIntentSession,
  orderByRole,
  attachMainCompoundWarmups,
  capLowerBodyAccessoriesForHeavyLegDay,
};
