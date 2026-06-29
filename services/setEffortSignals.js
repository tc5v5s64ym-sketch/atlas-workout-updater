'use strict';

// Set Effort Signals — deterministic per-set RIR/fatigue reading for the current
// weighted/RIR workflow (Training Intelligence Series, PR 477-A, engine slice).
//
// PURE. No I/O, no LLM, no writes, no Sheets. Given the parsed/logged sets for ONE
// exercise (in order) it classifies warmup/feeder vs work vs redline sets, derives
// session fatigue signals, and emits deterministic reason codes. A second helper
// reads the planned queue to flag a same-prime-mover conflict and suggest a reroute.
//
// This module is intentionally UNWIRED in this slice: nothing consumes it yet. The
// live coach/recommendation wiring + coach copy is a separate (PR 477-B) concern so
// the engine can be fixture-locked first (deterministic-first; the LLM only words
// these facts later, it never derives them).
//
// Scope guardrails (PR 477): current weighted/RIR workflow only. No parser change,
// no schema change, no write-path change. Cardio/bodyweight/circuit modalities and
// the full profile/deload engines are out of scope (later series slices).

const { patternFor } = require('./movementPattern');
const { musclesFor } = require('./muscleCoverage');
const { classifyLiftRole } = require('./liftRole');

// Owner-approved tuning (AskUserQuestion, 2026-06-22):
//  - warmup/feeder = early (before the top working load) + RIR >= 4 + clearly
//    lighter than the top working load (< 85%).
//  - isolation RIR 0 = caution-only (never blocks progression like a compound).
//  - routing = suggestion-only (this module never mutates a plan).
const WARMUP_MIN_RIR = 4;
const WARMUP_LOAD_FRACTION = 0.85; // a warmup set is under 85% of the top working load
const DEFAULT_TARGET_RIR = 2;
const UNDERDOSE_RIR_DELTA = 2; // a work set left >= 2 RIR above target is underdosed

const PRESSING_PATTERNS = new Set(['horizontal_push', 'vertical_push']);
const PULL_PATTERNS = new Set(['horizontal_pull', 'vertical_pull']);

// The deterministic reason-code vocabulary this slice introduces. (Registered into
// the central services/trainingKnowledge.js REASON_CODES registry by the wiring PR;
// defined here so the pure engine + its fixtures are self-contained.)
const EFFORT_REASON_CODES = Object.freeze({
  WARMUP_FEEDER_IGNORED: 'warmup_feeder_ignored',
  REDLINE_SET: 'redline_set',
  REP_DROP_AFTER_REDLINE: 'rep_drop_after_redline',
  PRESSING_READINESS_YELLOW: 'pressing_readiness_yellow',
  SAME_PRIME_MOVER_CONFLICT: 'same_prime_mover_conflict',
  REROUTE_PULL_FIRST: 'reroute_pull_first',
  CAP_NEXT_PRESS: 'cap_next_press',
  HIGH_RIR_WORKSET_UNDERDOSED: 'high_rir_workset_underdosed',
});

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Accept either parser objects {weight, reps, rir} or compact arrays [weight, reps, rir].
function normalizeSet(set) {
  if (Array.isArray(set)) {
    return { weight: toNum(set[0]), reps: toNum(set[1]), rir: toNum(set[2]) };
  }
  if (set && typeof set === 'object') {
    return { weight: toNum(set.weight), reps: toNum(set.reps), rir: toNum(set.rir) };
  }
  return { weight: null, reps: null, rir: null };
}

function exerciseNameOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    return String(item.name || item.canonicalName || item.exercise || item.canonical_exercise || '');
  }
  return '';
}

/**
 * Classify a single exercise's logged sets and derive its fatigue signals.
 *
 * @param {Array<object|Array>} sets - logged sets for ONE exercise, in order.
 * @param {object} [opts]
 * @param {string} [opts.exerciseName] - resolved/canonical lift name (for pattern/role).
 * @param {string} [opts.muscleGroup]  - muscle group (helps role classification).
 * @param {number} [opts.targetRir]    - prescribed work RIR (defaults to 2).
 * @returns {object|null} analysis, or null when there is nothing to analyze.
 */
function analyzeSetSequence(sets, opts = {}) {
  if (!Array.isArray(sets) || sets.length === 0) return null;

  const exerciseName = String(opts.exerciseName || '');
  const muscleGroup = String(opts.muscleGroup || '');
  const targetRir = toNum(opts.targetRir) !== null ? toNum(opts.targetRir) : DEFAULT_TARGET_RIR;

  const norm = sets.map(normalizeSet);

  const pattern = patternFor(exerciseName).pattern;
  const muscles = musclesFor(exerciseName);
  const role = classifyLiftRole(exerciseName, muscleGroup); // 'main' | 'secondary' | 'accessory'
  const isCompound = role !== 'accessory';
  const isPressing = PRESSING_PATTERNS.has(pattern);

  // Top working load = the heaviest weight in the sequence. The first set that
  // reaches it marks the boundary: sets before it are warmup candidates.
  const weights = norm.map(s => s.weight).filter(w => w !== null);
  const topWeight = weights.length ? Math.max(...weights) : null;
  const firstTopIndex = topWeight === null
    ? -1
    : norm.findIndex(s => s.weight === topWeight);

  const setClasses = norm.map((s, i) => {
    const isWarmup =
      topWeight !== null &&
      firstTopIndex > 0 &&
      i < firstTopIndex &&
      s.rir !== null && s.rir >= WARMUP_MIN_RIR &&
      s.weight !== null && s.weight < WARMUP_LOAD_FRACTION * topWeight;
    if (isWarmup) return 'warmup_feeder';
    if (s.rir !== null && s.rir <= 0) return 'redline';
    return 'work';
  });

  const redlineIndices = setClasses.reduce((acc, c, i) => (c === 'redline' ? acc.concat(i) : acc), []);
  const redline_set = redlineIndices.length > 0;
  const repeated_redline = redlineIndices.length >= 2;

  // Rep drop after a redline: a later set at the SAME load with fewer reps.
  let rep_drop_after_redline = false;
  for (const i of redlineIndices) {
    const r = norm[i];
    if (r.weight === null || r.reps === null) continue;
    for (let j = i + 1; j < norm.length; j += 1) {
      const s = norm[j];
      if (s.weight === r.weight && s.reps !== null && s.reps < r.reps) {
        rep_drop_after_redline = true;
        break;
      }
    }
    if (rep_drop_after_redline) break;
  }

  // High-RIR underdosed: a work set AT the top working load left well above target.
  // (Warmups are excluded by class; this only flags genuine working-weight sets.)
  const high_rir_workset_underdosed = norm.some((s, i) =>
    setClasses[i] === 'work' &&
    topWeight !== null && s.weight === topWeight &&
    s.rir !== null && (s.rir - targetRir) >= UNDERDOSE_RIR_DELTA);

  // Pressing yellow is a COMPOUND pressing signal only (isolation failure does not
  // make the pressing system yellow — owner: isolation RIR 0 is caution-only).
  const pressing_readiness_yellow =
    isPressing && isCompound && (redline_set || rep_drop_after_redline);

  const blocks_progression = isCompound && (redline_set || rep_drop_after_redline);
  const caution_only_redline = !isCompound && redline_set;

  let progression_verdict = 'neutral';
  if (blocks_progression) progression_verdict = 'block';
  else if (caution_only_redline) progression_verdict = 'caution';
  else if (high_rir_workset_underdosed) progression_verdict = 'bump';

  const reason_codes = [];
  if (setClasses.includes('warmup_feeder')) reason_codes.push(EFFORT_REASON_CODES.WARMUP_FEEDER_IGNORED);
  if (redline_set) reason_codes.push(EFFORT_REASON_CODES.REDLINE_SET);
  if (rep_drop_after_redline) reason_codes.push(EFFORT_REASON_CODES.REP_DROP_AFTER_REDLINE);
  if (pressing_readiness_yellow) reason_codes.push(EFFORT_REASON_CODES.PRESSING_READINESS_YELLOW);
  if (high_rir_workset_underdosed) reason_codes.push(EFFORT_REASON_CODES.HIGH_RIR_WORKSET_UNDERDOSED);

  return {
    exercise: exerciseName,
    pattern,
    role,
    is_compound: isCompound,
    is_pressing: isPressing,
    muscles: { primary: muscles.primary || [], secondary: muscles.secondary || [] },
    target_rir: targetRir,
    top_weight: topWeight,
    set_classes: setClasses,
    signals: {
      redline_set,
      repeated_redline,
      rep_drop_after_redline,
      high_rir_workset_underdosed,
      pressing_readiness_yellow,
    },
    progression_verdict, // 'block' | 'caution' | 'bump' | 'neutral'
    blocks_progression,
    caution_only_redline,
    reason_codes,
  };
}

/**
 * Recovery/deload override for the under-dose 'bump' verdict (BUG-20260629-034034).
 *
 * On a deliberate recovery/deload session, a high-RIR working set is EXPECTED
 * (the load is intentionally light), so the 'bump' progression invite ("too much
 * left in the tank → add load") is wrong — it tells the lifter to fight their own
 * recovery prescription. When a recovery objective is active, neutralize ONLY the
 * 'bump' verdict (and its under-dose reason code/signal). 'block' / 'caution'
 * (back-off / don't-grind reads) are left intact — they align with recovery.
 *
 * Pure: returns a new analysis (or the original when there's nothing to suppress).
 *
 * @param {object|null} analysis - output of analyzeSetSequence.
 * @param {boolean} recoveryActive - a deload is active OR a recovery/recovery_reload
 *   selection is signaled for this session.
 * @returns {object|null}
 */
function suppressBumpForRecovery(analysis, recoveryActive) {
  if (!recoveryActive || !analysis || analysis.progression_verdict !== 'bump') return analysis;
  return {
    ...analysis,
    progression_verdict: 'neutral',
    recovery_suppressed_bump: true,
    signals: { ...(analysis.signals || {}), high_rir_workset_underdosed: false },
    reason_codes: (analysis.reason_codes || []).filter(c => c !== EFFORT_REASON_CODES.HIGH_RIR_WORKSET_UNDERDOSED),
  };
}

/**
 * Recovery/deload override for the Stimulus Governor grade (BUG-20260629-034034,
 * review follow-up). On a recovery/deload session the high-RIR working sets make
 * `gradeStimulus` return a "+load"/"+reps" progression_verdict ("room to add
 * stimulus") — an independent add-load steer the coach prompt would otherwise word.
 * When a recovery objective is active, downgrade that to 'hold' (which the prompt
 * already reads as "do NOT add load/push"), leaving effort_interpretation /
 * fatigue_signal intact. 'hold' / 'back_off' grades are left as-is.
 *
 * Pure: returns a new grade (or the original when there's nothing to suppress).
 *
 * @param {object|null} setGrade - the { profile, effort_interpretation, progression_verdict, fatigue_signal } fact.
 * @param {boolean} recoveryActive
 * @returns {object|null}
 */
function holdStimulusForRecovery(setGrade, recoveryActive) {
  if (!recoveryActive || !setGrade || (setGrade.progression_verdict !== '+load' && setGrade.progression_verdict !== '+reps')) {
    return setGrade;
  }
  return { ...setGrade, progression_verdict: 'hold', recovery_suppressed_load: true };
}

/**
 * Given the current exercise analysis and the REMAINING planned queue (exercises
 * after the current one), flag a same-prime-mover conflict and suggest a reroute.
 * Suggestion-only — never mutates the plan (owner-approved).
 *
 * @param {object} analysis - output of analyzeSetSequence for the just-logged lift.
 * @param {Array<string|object>} plannedQueue - remaining planned exercises, in order.
 * @returns {object} { conflict, next_exercise, reason_codes, suggestion }
 */
function assessNextMoveConflict(analysis, plannedQueue) {
  const empty = { conflict: false, next_exercise: null, reason_codes: [], suggestion: null };
  if (!analysis || !Array.isArray(plannedQueue) || plannedQueue.length === 0) return empty;

  // Only reroute when the just-finished pressing work went yellow. A single hard
  // (non-redline) set, or fatigue on a non-pressing lift, is not a conflict.
  if (!analysis.signals || !analysis.signals.pressing_readiness_yellow) return empty;

  const next = plannedQueue[0];
  const nextName = exerciseNameOf(next);
  const nextPattern = patternFor(nextName).pattern;

  // Conflict only when the next planned move loads the same (pressing) prime mover.
  if (!PRESSING_PATTERNS.has(nextPattern)) {
    return { conflict: false, next_exercise: nextName, reason_codes: [], suggestion: null };
  }

  const reason_codes = [EFFORT_REASON_CODES.SAME_PRIME_MOVER_CONFLICT];

  // Prefer moving an opposing pull movement up first, if one is queued.
  const pull = plannedQueue.find(item => PULL_PATTERNS.has(patternFor(exerciseNameOf(item)).pattern));

  let suggestion;
  if (pull) {
    reason_codes.push(EFFORT_REASON_CODES.REROUTE_PULL_FIRST);
    suggestion = {
      type: 'reroute_pull_first',
      pull_first: exerciseNameOf(pull),
      defer_press: nextName, // come back lighter / optional
    };
  } else {
    reason_codes.push(EFFORT_REASON_CODES.CAP_NEXT_PRESS);
    suggestion = { type: 'cap_next_press', press: nextName };
  }

  return { conflict: true, next_exercise: nextName, reason_codes, suggestion };
}

module.exports = {
  analyzeSetSequence,
  assessNextMoveConflict,
  suppressBumpForRecovery,
  holdStimulusForRecovery,
  EFFORT_REASON_CODES,
  // exported for fixtures / future wiring
  WARMUP_MIN_RIR,
  WARMUP_LOAD_FRACTION,
  DEFAULT_TARGET_RIR,
  UNDERDOSE_RIR_DELTA,
};
