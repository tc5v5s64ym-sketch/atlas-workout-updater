'use strict';

// Shared per-lift prescription helpers — the pure pipeline that turns a lift's
// logged history into a progression prescription. Used by the Session Generator;
// coachRunners' progression adapter carries an equivalent private copy today and
// is filed to migrate onto this shared helper (BACKLOG).
//
// Pure — no I/O, no LLM, no Sheets, no write. Consumes 12-col positional
// Log_Cleaned rows (as delivered by getLogRows / the State Assembly snapshot).
//
// Public API:
//   normRow(row)                              → object | null
//   deriveLiftState(rows, liftCode, asOf)     → userState liftState | null
//   derivePlateau(rows, liftCode, asOf)       → plateau object | null
//   lastWorkingSet(rows, liftCode, asOf)      → { currentWeight, currentReps, currentRIR, bodyRegion } | null
//   isOverperforming(rows, liftCode, asOf, set?) → boolean
//   prescribeLift(rows, liftCode, asOf, opts) → { scenario_id, action, lever, targetWeight, targetReps, rationale, ...set } | null

const { buildUserState }                          = require('./userStateModule');
const { detectLiftPlateaus, assessExpectedPerformance } = require('./expectedPerformanceModule');
const { classifyScenario }                        = require('./scenarioClassifier');
const { recommendProgression }                    = require('./progressionModule');

// 12-col: date_clean|session_id|exercise|canonical_exercise|muscle_group|lift_code|set_number|weight|reps|rir|notes|volume_calc
// Coerce a numeric cell, treating an empty/blank/missing cell as NaN rather than
// Number('') === 0. Critical for RIR: an unlogged RIR must NOT read as 0 ("went to
// failure"), which would suppress load increases; NaN is correctly rejected by the
// prescription guards (→ clarification, not a false at-failure read).
function _num(v) {
  if (v == null) return NaN;
  if (typeof v === 'string' && v.trim() === '') return NaN;
  return Number(v);
}

function normRow(r) {
  if (!Array.isArray(r)) return null;
  return {
    date_clean:         r[0],
    session_id:         r[1] == null ? '' : String(r[1]),
    canonical_exercise: typeof r[3] === 'string' ? r[3] : '',
    muscle_group:       typeof r[4] === 'string' ? r[4] : '',
    lift_code:          r[5] == null ? '' : String(r[5]),
    weight:             _num(r[7]),
    reps:               _num(r[8]),
    rir:                _num(r[9]),
    notes:              typeof r[10] === 'string' ? r[10] : '',
  };
}

function _isWarmup(note) { return typeof note === 'string' && /warm[\s-]?up/i.test(note); }

function _liftRows(rows, liftCode, asOf) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length || !liftCode || !asOf) return null;
  const normalized = list.map(normRow).filter(o => o && o.date_clean && o.canonical_exercise);
  const forLift = normalized.filter(o => o.lift_code.trim().toUpperCase() === liftCode);
  if (!forLift.length) return null;
  return { normalized, forLift, exerciseName: forLift[0].canonical_exercise.trim() };
}

function deriveLiftState(rows, liftCode, asOf) {
  const ctx = _liftRows(rows, liftCode, asOf);
  if (!ctx) return null;
  const us = buildUserState(ctx.normalized, { asOf });
  return us && us.liftStates ? (us.liftStates[ctx.exerciseName] || null) : null;
}

function derivePlateau(rows, liftCode, asOf) {
  const ctx = _liftRows(rows, liftCode, asOf);
  if (!ctx) return null;
  try {
    const stalls = detectLiftPlateaus(ctx.normalized, { minSessions: 3 });
    if (!Array.isArray(stalls)) return null;
    return stalls.find(s => s && String(s.liftCode || '').toUpperCase() === liftCode) || null;
  } catch { return null; }
}

function lastWorkingSet(rows, liftCode, asOf) {
  const ctx = _liftRows(rows, liftCode, asOf);
  if (!ctx) return null;
  const working = ctx.forLift.filter(o => !_isWarmup(o.notes));
  const pool = working.length ? working : ctx.forLift;
  // Do NOT trust sheet order — sort chronologically (date, session_id tie-break).
  const sorted = pool.slice().sort((a, b) => {
    if (a.date_clean !== b.date_clean) return a.date_clean < b.date_clean ? -1 : 1;
    return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
  });
  const last = sorted[sorted.length - 1];
  if (!last) return null;
  const lower = /leg|quad|hamstring|glute|calf|lower|hip|squat|deadlift/i.test(last.muscle_group || '')
    || /squat|deadlift|lunge|hinge/i.test(ctx.exerciseName);
  return {
    currentWeight: last.weight,
    currentReps:   last.reps,
    currentRIR:    last.rir,
    bodyRegion:    lower ? 'lower_body' : 'upper_body',
  };
}

// Overperforming = the last working set beat its expected reps at that load.
// Expected reps come from the lift's own history at ±10% of the set weight
// (expectedPerformanceModule needs ≥3 qualifying sessions, else there is no
// expected signal → false, the conservative default). Feeds classifyScenario's
// underloaded/increase_load branch, which is otherwise unreachable from data.
// Pure — read-only math, no I/O.
function isOverperforming(rows, liftCode, asOf, set) {
  const working = set || lastWorkingSet(rows, liftCode, asOf);
  if (!working || !(working.currentWeight > 0) || !Number.isInteger(working.currentReps)) return false;
  const ctx = _liftRows(rows, liftCode, asOf);
  if (!ctx) return false;
  let expected = null;
  try { expected = assessExpectedPerformance(liftCode, ctx.normalized, working.currentWeight); }
  catch { return false; }
  const expectedReps = expected ? Number(expected.expectedReps) : NaN;
  if (!Number.isFinite(expectedReps)) return false;
  return working.currentReps > expectedReps;
}

// Full per-lift prescription: history → scenario → recommendProgression.
// Returns null when there is not enough signal or a valid last working set.
function prescribeLift(rows, liftCode, asOf, opts) {
  const set = lastWorkingSet(rows, liftCode, asOf);
  if (!set || !(set.currentWeight > 0) || !Number.isInteger(set.currentReps) || set.currentReps < 1
      || !Number.isFinite(set.currentRIR) || set.currentRIR < 0) {
    return null;
  }

  const scenario = classifyScenario({
    liftState:      deriveLiftState(rows, liftCode, asOf),
    plateau:        derivePlateau(rows, liftCode, asOf),
    readiness:      (opts && opts.readiness) || null,
    injury:         (opts && opts.injury) || null,
    overperforming: isOverperforming(rows, liftCode, asOf, set),
  });
  if (!scenario) return null;

  const rec = recommendProgression(scenario.scenario_id, set);
  if (!rec) return null;

  return {
    scenario_id:  scenario.scenario_id,
    action:       rec.default_action,
    lever:        rec.lever,
    targetWeight: rec.targetWeight,
    targetReps:   rec.targetReps,
    rationale:    rec.rationale,
    currentWeight: set.currentWeight,
    currentReps:   set.currentReps,
    currentRIR:    set.currentRIR,
    bodyRegion:    set.bodyRegion,
  };
}

module.exports = { normRow, deriveLiftState, derivePlateau, lastWorkingSet, isOverperforming, prescribeLift };
