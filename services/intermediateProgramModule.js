'use strict';

const path = require('path');
const fs   = require('fs');

const PROG_FILE = path.join(__dirname, '..', 'config', 'coaching', 'programs', '531-intermediate.json');

let _prog = null;

function _loadProgram() {
  if (_prog) return _prog;
  _prog = Object.freeze(JSON.parse(fs.readFileSync(PROG_FILE, 'utf8')));
  return _prog;
}

function _resetForTesting() { _prog = null; }

// Round to nearest 5 lb (standard plate increment for 5/3/1)
function _round5(value) {
  return Math.round(value / 5) * 5;
}

/**
 * Build the next 5/3/1 session prescription from the current state.
 *
 * state:
 *   sessionCount   number  — 0-based total sessions completed so far.
 *                            cyclePos = sessionCount % 16
 *   trainingMaxes  object  — training max (lb) per lift code.
 *                            Required keys: SQUAT, BENCH, DEADLIFT, OHP
 *                            TM is typically 90% of tested 1RM (see computeTrainingMax).
 *
 * Returns null for invalid input or a missing/invalid training max for the main lift.
 *
 * Return shape:
 *   programId       string
 *   sessionLabel    string  e.g. "Squat"
 *   weekLabel       string  e.g. "5s week"
 *   weekInCycle     number  1–4
 *   dayInWeek       number  1–4
 *   cyclePosition   number  0–15
 *   isDeload        boolean
 *   isCycleBoundary boolean — true when sessionCount > 0 and cyclePos === 0
 *                             (caller should increment trainingMaxes before the next call)
 *   mainLift        { exerciseId, liftCode, bodyRegion, trainingMax, sets[] }
 *   supplemental    { exerciseId, liftCode, bodyRegion, sets[] }
 *
 * mainLift.sets[]:  { weight(lb), reps, repsScheme }
 * supplemental.sets[]: { weight(lb)|null, reps, repsScheme: 'amrap' }
 */
function buildNextSession531(state) {
  if (!state || typeof state !== 'object') return null;

  const { sessionCount, trainingMaxes } = state;
  if (typeof sessionCount !== 'number' || !Number.isFinite(sessionCount) || sessionCount < 0) return null;
  if (!trainingMaxes || typeof trainingMaxes !== 'object') return null;

  const prog     = _loadProgram();
  const cyclePos = Math.floor(sessionCount) % prog.cycle_length;  // 0–15
  const weekIdx  = Math.floor(cyclePos / 4);                       // 0–3
  const dayIdx   = cyclePos % 4;                                   // 0–3

  const session  = prog.sessions[dayIdx];
  const waveWeek = prog.wave_weeks[weekIdx];
  const mainLift = session.main_lift;
  const liftCode = mainLift.lift_code;
  const tm       = trainingMaxes[liftCode];

  if (typeof tm !== 'number' || !Number.isFinite(tm) || tm <= 0) return null;

  const mainSets = waveWeek.main_sets.map(s => ({
    weight:     _round5(tm * s.percent_tm),
    reps:       s.reps,
    repsScheme: s.reps_scheme,
  }));

  const supp    = session.supplemental;
  const suppTm  = trainingMaxes[supp.lift_code];
  const suppW   = (typeof suppTm === 'number' && Number.isFinite(suppTm) && suppTm > 0)
    ? _round5(suppTm * supp.percent_tm)
    : null;

  const supplementalSets = Array.from({ length: supp.sets }, () => ({
    weight:     suppW,
    reps:       supp.reps,
    repsScheme: supp.reps_scheme || 'fixed',
  }));

  return {
    programId:       prog.id,
    sessionLabel:    session.label,
    weekLabel:       waveWeek.label,
    weekInCycle:     weekIdx + 1,
    dayInWeek:       dayIdx + 1,
    cyclePosition:   cyclePos,
    isDeload:        waveWeek.is_deload,
    isCycleBoundary: Math.floor(sessionCount) > 0 && cyclePos === 0,
    mainLift: {
      exerciseId: mainLift.exercise_id,
      liftCode:   mainLift.lift_code,
      bodyRegion: mainLift.body_region,
      trainingMax: tm,
      sets:       mainSets,
    },
    supplemental: {
      exerciseId: supp.exercise_id,
      liftCode:   supp.lift_code,
      bodyRegion: supp.body_region,
      sets:       supplementalSets,
    },
  };
}

/**
 * Compute suggested training maxes for the next cycle by applying
 * the standard Wendler increment (+5 lb upper body, +10 lb lower body).
 *
 * trainingMaxes: { [liftCode]: number }
 * Returns a new object with the incremented values, or null for invalid input.
 */
function suggestNextCycleMaxes(trainingMaxes) {
  if (!trainingMaxes || typeof trainingMaxes !== 'object') return null;
  const prog = _loadProgram();
  const inc  = prog.increment_lb;

  // Build region map from session config
  const regionByLift = {};
  for (const s of prog.sessions) {
    regionByLift[s.main_lift.lift_code]    = s.main_lift.body_region;
    regionByLift[s.supplemental.lift_code] = s.supplemental.body_region;
  }

  const result = {};
  for (const [code, tm] of Object.entries(trainingMaxes)) {
    if (typeof tm !== 'number' || !Number.isFinite(tm)) continue;
    const region   = regionByLift[code] ?? 'upper_body';
    result[code]   = tm + (region === 'lower_body' ? inc.lower_body : inc.upper_body);
  }
  return result;
}

/**
 * Compute a starting training max from a tested 1RM.
 * Standard Wendler: TM = 90% of tested 1RM, rounded to nearest 5 lb.
 * Returns null for invalid input.
 */
function computeTrainingMax(tested1RM) {
  if (typeof tested1RM !== 'number' || !Number.isFinite(tested1RM) || tested1RM <= 0) return null;
  const prog = _loadProgram();
  return _round5(tested1RM * prog.training_max_percent);
}

module.exports = {
  buildNextSession531,
  suggestNextCycleMaxes,
  computeTrainingMax,
  _resetForTesting,
};
