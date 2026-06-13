'use strict';

// Progression rules — pure functions over normalized log rows.
// Signature: (historyRows, liftCode, config) → decision
// historyRows are flat Log_Cleaned-shaped rows; config carries per-lift
// parameters with Dale's numbers as the defaults. Rule shapes generalize,
// the numbers stay config.

const { decision } = require('./ruleTypes');
const { groupBySession } = require('./safetyRules');

const DEFAULT_CONFIG = {
  target_reps: 6,
  min_rir: 2,
  required_sessions: 3,
  load_increment_upper: 5,
  load_increment_lower: 10,
};

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isLowerBodyGroup(muscleGroup) {
  return /leg|quad|hamstring|glute|calf|lower body|hip/i.test(muscleGroup || '');
}

// hold_until_clean: hold the current load until N sessions where every working
// set at that load hits target reps with RIR ≥ threshold. Then load.
// The "current load" is the heaviest weight used in the most recent session.
// Degrades safely on bad input (non-array, empty, malformed rows).
function holdUntilClean(historyRows, liftCode, config = {}) {
  if (!Array.isArray(historyRows) || historyRows.length === 0) {
    return decision({
      decision: 'no_data',
      rule_id: 'hold_until_clean',
      reasoning: 'No working-set history for this lift.',
      lift_code: String(liftCode || '').trim().toUpperCase(),
    });
  }
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const code = String(liftCode || '').trim().toUpperCase();
  const rows = historyRows.filter(r => {
    if (!r || typeof r !== 'object') return false;
    return String(r.lift_code || '').toUpperCase() === code && num(r.weight) > 0 && num(r.reps) > 0;
  });

  if (!rows.length) {
    return decision({
      decision: 'no_data',
      rule_id: 'hold_until_clean',
      reasoning: 'No working-set history for this lift.',
      lift_code: code,
    });
  }

  const sessions = groupBySession(rows);
  if (!sessions.length) {
    return decision({
      decision: 'no_data',
      rule_id: 'hold_until_clean',
      reasoning: 'No working-set history for this lift.',
      lift_code: code,
    });
  }
  const lastSession = sessions[sessions.length - 1];
  const load = Math.max(...lastSession.rows.map(r => num(r.weight) || 0).filter(v => v > 0));

  const muscleGroup = (lastSession.rows[0] && lastSession.rows[0].muscle_group) || '';
  const increment = isLowerBodyGroup(muscleGroup) ? cfg.load_increment_lower : cfg.load_increment_upper;

  // A session is clean when every set at the load hits target reps, and every
  // recorded RIR is ≥ min_rir. Sessions without RIR recorded count on reps alone.
  let cleanCount = 0;
  let sessionsAtLoad = 0;
  for (const session of sessions) {
    if (!session || !Array.isArray(session.rows)) continue;
    const atLoad = session.rows.filter(r => r && typeof r === 'object' && num(r.weight) === load);
    if (!atLoad.length) continue;
    sessionsAtLoad += 1;
    const allReps = atLoad.every(r => num(r.reps) >= cfg.target_reps);
    const rirs = atLoad.map(r => num(r.rir)).filter(v => v !== null);
    const allRir = rirs.length === 0 || rirs.every(v => v >= cfg.min_rir);
    if (allReps && allRir) cleanCount += 1;
  }

  const criterion = `${cfg.required_sessions} session(s) of ${cfg.target_reps}+ reps @ RIR ≥ ${cfg.min_rir} at ${load}`;
  const progress = `${cleanCount} of ${cfg.required_sessions} clean sessions at ${load}`;

  if (cleanCount >= cfg.required_sessions) {
    return decision({
      decision: 'load',
      rule_id: 'hold_until_clean',
      reasoning: `Standard met (${progress}). Load to ${load + increment}.`,
      criterion_progress: progress,
      lift_code: code,
    });
  }

  if (sessionsAtLoad === 0) {
    return decision({
      decision: 'no_data',
      rule_id: 'hold_until_clean',
      reasoning: `No sessions found at current load ${load}.`,
      lift_code: code,
    });
  }

  return decision({
    decision: 'hold',
    rule_id: 'hold_until_clean',
    reasoning: `Hold ${load}. Criterion: ${criterion}. Progress: ${progress}.`,
    criterion_progress: progress,
    lift_code: code,
  });
}

module.exports = { holdUntilClean, DEFAULT_CONFIG, isLowerBodyGroup };
