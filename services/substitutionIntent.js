'use strict';

// Substitution / Intent Classifier
//
// Deterministic. Pure function. No I/O, no persistence.
// Classifies a logged exercise against a prescribed one and decides whether
// the session's intent was preserved, changed, or abandoned.
//
// Spec: docs/SUBSTITUTION_SPEC.md
// Engine owns the decision. Voice layer may only word it.

const { patternFor } = require('./movementPattern');
const { musclesFor } = require('./muscleCoverage');
const { costFor } = require('./liftCost');
const { classifyLiftRole } = require('./liftRole');

// Fraction of prescribed primary muscles that must appear in logged primary muscles
// for the substitution to be considered a pattern+muscle match.
// Pinned here so golden fixtures are deterministic against this constant.
const OVERLAP_THRESHOLD = 0.5;

// Maps the 14 movement patterns to 7 broad training regions.
// 'other' is never treated as a shared region.
const BROAD_REGION = {
  squat:            'lower',
  hinge:            'lower',
  knee_isolation:   'lower',
  hip_isolation:    'lower',
  calf_isolation:   'lower',
  horizontal_push:  'push',
  vertical_push:    'push',
  horizontal_pull:  'pull',
  vertical_pull:    'pull',
  arm_isolation:    'arm',
  delt_isolation:   'delt',
  trunk:            'core',
  carry:            'other',
  other:            'other',
};

// What fraction of the prescribed primary muscles appear in the logged primaries.
// Returns 0 when prescribed primary is empty (can't assess overlap).
function computePrimaryMuscleOverlap(prescribedPrimary, loggedPrimary) {
  if (!Array.isArray(prescribedPrimary) || prescribedPrimary.length === 0) return 0;
  const loggedSet = new Set(Array.isArray(loggedPrimary) ? loggedPrimary : []);
  const covered = prescribedPrimary.filter(m => loggedSet.has(m)).length;
  return covered / prescribedPrimary.length;
}

// Returns true if any active constraint's target plausibly matches the prescribed lift.
// Matches by substring (case-insensitive, bidirectional) or by shared significant word
// (4+ chars) from the constraint target appearing in the prescribed name.
// v1: name-based only; equipment inference (e.g. "barbell" → "Back Squat") is not
// attempted — constraint targets should name the exercise or pattern explicitly.
function hasMatchingConstraint(prescribed, constraints) {
  if (!Array.isArray(constraints) || constraints.length === 0) return false;
  const prescribedLower = ((prescribed && prescribed.name) || '').toLowerCase();
  if (!prescribedLower) return false;
  return constraints.some(c => {
    if (!c || !c.target) return false;
    const targetLower = c.target.toLowerCase();
    if (prescribedLower.includes(targetLower) || targetLower.includes(prescribedLower)) return true;
    // Word-level: any word ≥4 chars in target appears in prescribed name
    const targetWords = targetLower.split(/\W+/).filter(w => w.length >= 4);
    return targetWords.some(w => prescribedLower.includes(w));
  });
}

function buildLiftInfo(lift, patternResult, muscleResult) {
  return {
    name:            (lift && lift.name) || '',
    lift_code:       (lift && lift.lift_code) || null,
    pattern:         patternResult.pattern,
    primary_muscles: muscleResult.primary,
  };
}

function buildEvidence({ prescribedInfo, loggedInfo, muscle_overlap, reason_code, painFlag, constraintMatched }) {
  const ev = [];
  ev.push(`prescribed: ${prescribedInfo.name} (${prescribedInfo.pattern}, [${prescribedInfo.primary_muscles.join(', ') || 'unknown'}])`);
  ev.push(`logged: ${loggedInfo.name} (${loggedInfo.pattern}, [${loggedInfo.primary_muscles.join(', ') || 'unknown'}])`);
  ev.push(`muscle_overlap: ${Math.round(muscle_overlap * 100)}%`);
  if (painFlag)          ev.push('pain signal: present');
  if (constraintMatched) ev.push('constraint: matched prescribed lift');
  ev.push(`reason: ${reason_code}`);
  return ev;
}

/**
 * Classify a substitution (logged lift vs prescribed lift).
 *
 * @param {Object} opts
 * @param {{ name: string, lift_code?: string }} opts.prescribed  - The exercise that was prescribed.
 * @param {{ name: string, lift_code?: string }} opts.logged      - The exercise actually logged.
 * @param {Array<{ kind, target, rule, note? }>} [opts.constraints] - Active constraints from the Constraints tab.
 * @param {boolean} [opts.painFlag]  - True if pain was detected in session notes (from safetyRules.painFlag).
 * @param {Array|any} [opts.history] - Prior log rows for the prescribed lift. Null/empty → baseline.
 *
 * @returns {{
 *   classification: 'preserved'|'changed'|'abandoned'|'baseline',
 *   decision:       'approve'|'warn',
 *   reason_code:    string,
 *   prescribed:     { name, lift_code, pattern, primary_muscles },
 *   logged:         { name, lift_code, pattern, primary_muscles },
 *   muscle_overlap: number,
 *   evidence:       string[]
 * }}
 */
function classifySubstitution({ prescribed, logged, constraints, painFlag, history } = {}) {
  const prescribedName  = (prescribed && prescribed.name) || '';
  const loggedName      = (logged && logged.name) || '';

  const prescribedPatternResult = patternFor(prescribedName);
  const loggedPatternResult     = patternFor(loggedName);
  const prescribedMuscleResult  = musclesFor(prescribedName);
  const loggedMuscleResult      = musclesFor(loggedName);

  const prescribedInfo = buildLiftInfo(prescribed, prescribedPatternResult, prescribedMuscleResult);
  const loggedInfo     = buildLiftInfo(logged,     loggedPatternResult,     loggedMuscleResult);

  // --- Rule 1: baseline — no history means we cannot judge intent
  const hasHistory = Array.isArray(history) ? history.length > 0 : Boolean(history);
  if (!hasHistory) {
    return {
      classification: 'baseline',
      decision:       'approve',
      reason_code:    'no_history_calibration',
      prescribed:     prescribedInfo,
      logged:         loggedInfo,
      muscle_overlap: 0,
      evidence:       ['no prior history — calibration mode'],
    };
  }

  // --- Compute signals
  const muscle_overlap  = computePrimaryMuscleOverlap(prescribedMuscleResult.primary, loggedMuscleResult.primary);

  // Patterns match only when both resolve to the same known pattern (not 'other').
  const patternsMatch = (
    prescribedPatternResult.pattern === loggedPatternResult.pattern &&
    prescribedPatternResult.pattern !== 'other'
  );

  const prescribedRegion = BROAD_REGION[prescribedPatternResult.pattern] || 'other';
  const loggedRegion     = BROAD_REGION[loggedPatternResult.pattern]     || 'other';
  const sharedBroadRegion = prescribedRegion === loggedRegion && prescribedRegion !== 'other';

  const constraintMatched   = hasMatchingConstraint(prescribed, constraints);
  const hasPain             = Boolean(painFlag);
  const isJustified         = constraintMatched || hasPain;

  const evidenceArgs = { prescribedInfo, loggedInfo, muscle_overlap, painFlag: hasPain, constraintMatched };

  // --- Rule 2: preserved — pattern/region AND muscle match (equipment swap within intent)
  // Accepts either an exact sub-pattern match (squat→squat, hinge→hinge) OR a shared
  // broad region (vertical_pull + horizontal_pull both map to 'pull'), provided the
  // primary-muscle overlap meets the threshold. This handles pull/pull and push/push
  // cross-sub-pattern swaps that are valid substitutions.
  if ((patternsMatch || sharedBroadRegion) && muscle_overlap >= OVERLAP_THRESHOLD) {
    return {
      classification: 'preserved',
      decision:       'approve',
      reason_code:    'pattern_and_muscle_match',
      prescribed:     prescribedInfo,
      logged:         loggedInfo,
      muscle_overlap,
      evidence:       buildEvidence({ ...evidenceArgs, reason_code: 'pattern_and_muscle_match' }),
    };
  }

  // --- Rule 3: preserved — pain or equipment constraint justified the redirect
  // Override ordering: a matching constraint/pain can only upgrade toward preserved.
  // It cannot downgrade a genuine match (rule 2 is checked first) and cannot excuse
  // a non-justified abandon (isJustified must be true for this branch to fire).
  if (isJustified) {
    const reason_code = hasPain ? 'pain_redirect' : 'equipment_constraint_honored';
    return {
      classification: 'preserved',
      decision:       'approve',
      reason_code,
      prescribed:     prescribedInfo,
      logged:         loggedInfo,
      muscle_overlap,
      evidence:       buildEvidence({ ...evidenceArgs, reason_code }),
    };
  }

  // --- Rule 4: changed — related region, wrong muscle emphasis
  // Shares a broad region with the prescription but muscle overlap is below threshold.
  const hasRelatedRegion = sharedBroadRegion || muscle_overlap > 0;
  if (hasRelatedRegion && muscle_overlap < OVERLAP_THRESHOLD) {
    return {
      classification: 'changed',
      decision:       'warn',
      reason_code:    'wrong_muscle',
      prescribed:     prescribedInfo,
      logged:         loggedInfo,
      muscle_overlap,
      evidence:       buildEvidence({ ...evidenceArgs, reason_code: 'wrong_muscle' }),
    };
  }

  // --- Rule 5: abandoned — different stimulus, ~0 overlap, no justification,
  // AND the prescribed lift carried real training weight (medium/high systemic
  // cost OR a main role). Dropping a heavy main lift for an unrelated stimulus
  // leaves the session's objective untrained.
  const prescribedCost = costFor(prescribedName).cost;
  const prescribedRole = classifyLiftRole(prescribedName);
  const carriedRealWeight = prescribedCost === 'medium' || prescribedCost === 'high' || prescribedRole === 'main';

  if (carriedRealWeight) {
    return {
      classification: 'abandoned',
      decision:       'warn',
      reason_code:    'pattern_abandoned',
      prescribed:     prescribedInfo,
      logged:         loggedInfo,
      muscle_overlap,
      evidence:       buildEvidence({ ...evidenceArgs, reason_code: 'pattern_abandoned' }),
    };
  }

  // --- Rule 6: changed — different stimulus but the prescribed lift was a
  // low-cost accessory (not medium/high cost and not a main lift). Dropping
  // trivial accessory work warrants a soft flag, not an abandoned-objective
  // warning (spec: abandoned requires real training weight).
  return {
    classification: 'changed',
    decision:       'warn',
    reason_code:    'accessory_swap',
    prescribed:     prescribedInfo,
    logged:         loggedInfo,
    muscle_overlap,
    evidence:       buildEvidence({ ...evidenceArgs, reason_code: 'accessory_swap' }),
  };
}

module.exports = { classifySubstitution, OVERLAP_THRESHOLD };
