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
    });
    seen.add(rec.exercise_name.toLowerCase());
    seenCodes.add(rec.liftCode);
    break;
  }

  // ── 2. Support ───────────────────────────────────────────────────────────────
  // Reserve the last slot for the balance lift.
  const supportCap = maxExercises - 1;
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

module.exports = { buildWarmupRamp, isBlockedPair, buildIntentSession };
