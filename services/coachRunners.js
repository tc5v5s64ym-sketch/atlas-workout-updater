'use strict';

// Coach runner adapters — the module→decision-shape mapping the Orchestrator
// consumes. Each adapter reads a State Assembly snapshot + IntentEnvelope, calls
// an available Brian module, and returns an orchestrator fragment. All coaching
// computation lives in the Brian modules; these adapters only shape and thread.
//
// Pure — no I/O, no LLM, no Sheets, no route. Each adapter is defensive (returns
// a safe fragment / null; the Orchestrator additionally skips a throwing runner).
//
// Wired: safety (traffic-light), confidence (ask-vs-act), scenario_classifier
// (facts→scenario), progression (scenario→prescription). progression reads the
// scenario the classifier stored in ctx.results, and emits a decision fragment
// whose numbers satisfy the KEY-AWARE trust contract (echoed under matching keys).
//
// Spec: docs/COACHING_ENGINE_ARCHITECTURE.md (runners/adapters)

const { classifyTrafficLight } = require('./safetyClassifierModule');
const { scoreConfidence }       = require('./confidenceModule');
const { queryTrend }            = require('./memoryModule');
const { buildUserState }        = require('./userStateModule');
const { detectLiftPlateaus }    = require('./expectedPerformanceModule');
const { classifyScenario }      = require('./scenarioClassifier');
const { recommendProgression }  = require('./progressionModule');

// ─── shared helpers ───────────────────────────────────────────────────────────

function _liftCode(envelope) {
  const c = envelope && envelope.constraints;
  const v = c && c.target_lift;
  return typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : null;
}

function _injury(envelope) {
  const c = envelope && envelope.constraints;
  return c && typeof c.injury === 'string' && c.injury.trim() ? c.injury.trim() : null;
}

// Normalize a 12-col positional Log_Cleaned row into the object shape the
// userState/plateau modules consume. Returns null for a non-array row.
function _normRow(r) {
  if (!Array.isArray(r)) return null;
  return {
    date_clean:         r[0],
    session_id:         r[1] == null ? '' : String(r[1]),
    canonical_exercise: typeof r[3] === 'string' ? r[3] : '',
    lift_code:          r[5] == null ? '' : String(r[5]),
    muscle_group:       typeof r[4] === 'string' ? r[4] : '',
    weight:             Number(r[7]),
    reps:               Number(r[8]),
    rir:                Number(r[9]),
    notes:              typeof r[10] === 'string' ? r[10] : '',
  };
}

function _isWarmup(note) { return typeof note === 'string' && /warm[\s-]?up/i.test(note); }

// Normalize + filter the snapshot's rows to the target lift; returns
// { normalized[], forLift[], exerciseName, asOf } or null when unusable.
function _liftRows(snapshot, liftCode) {
  const rows = snapshot && Array.isArray(snapshot.log_history) ? snapshot.log_history : [];
  const asOf = snapshot && typeof snapshot.asOf === 'string' ? snapshot.asOf : null;
  if (!rows.length || !liftCode || !asOf) return null;
  const normalized = rows.map(_normRow).filter(o => o && o.date_clean && o.canonical_exercise);
  const forLift = normalized.filter(o => o.lift_code.trim().toUpperCase() === liftCode);
  if (!forLift.length) return null;
  return { normalized, forLift, exerciseName: forLift[0].canonical_exercise.trim(), asOf };
}

// Derive the userState liftState (e1RM trend, PR, staleness) for the target lift.
function _deriveLiftState(snapshot, liftCode) {
  const ctx = _liftRows(snapshot, liftCode);
  if (!ctx) return null;
  const us = buildUserState(ctx.normalized, { asOf: ctx.asOf });
  return us && us.liftStates ? (us.liftStates[ctx.exerciseName] || null) : null;
}

// Plateau signal for the target lift (or null), defensive.
function _derivePlateau(snapshot, liftCode) {
  const ctx = _liftRows(snapshot, liftCode);
  if (!ctx) return null;
  try {
    const stalls = detectLiftPlateaus(ctx.normalized, { minSessions: 3 });
    if (!Array.isArray(stalls)) return null;
    return stalls.find(s => s && String(s.liftCode || '').toUpperCase() === liftCode) || null;
  } catch { return null; }
}

// Most recent non-warmup working set for the target lift → progression context.
function _lastWorkingSet(snapshot, liftCode) {
  const ctx = _liftRows(snapshot, liftCode);
  if (!ctx) return null;
  const working = ctx.forLift.filter(o => !_isWarmup(o.notes));
  const pool = working.length ? working : ctx.forLift;
  // Do NOT trust sheet order (getLogRows returns raw order; a backfilled/edited row
  // could be out of place). Sort chronologically (date, session_id tie-break) and
  // take the most recent — matching userStateModule / expectedPerformanceModule.
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

// ─── adapters ─────────────────────────────────────────────────────────────────

// safety → { level, flags, blocking }
function safetyRunner(ctx) {
  const injury = _injury(ctx && ctx.envelope);
  const r = classifyTrafficLight(injury ? [injury] : []);
  const level = r && ['green', 'yellow', 'red'].includes(r.state) ? r.state : 'green';
  return { level, flags: injury ? [injury] : [], blocking: level === 'red' };
}

// confidence → { score, tier, action, caveats }
function confidenceRunner(ctx) {
  const snapshot = ctx && ctx.snapshot;
  const envelope = ctx && ctx.envelope;
  const liftCode = _liftCode(envelope);
  const rows = snapshot && Array.isArray(snapshot.log_history) ? snapshot.log_history : [];
  const injury = _injury(envelope);
  const c = scoreConfidence({
    liftState:       liftCode ? _deriveLiftState(snapshot, liftCode) : null,
    readinessResult: null,             // no check-in data on this path yet
    trendResult:     liftCode ? queryTrend(liftCode, rows) : null,
    safetyFlags:     { active: injury ? [injury] : [] },
    exerciseKnown:   !!liftCode,
  });
  if (!c) return { score: 0, tier: 'low', action: 'ask', caveats: [] };
  return { score: c.confidenceScore, tier: c.tier, action: c.action, caveats: Array.isArray(c.caveats) ? c.caveats : [] };
}

// scenario_classifier → { scenario_id, rationale } | null (stored in ctx.results)
function scenarioClassifierRunner(ctx) {
  const snapshot = ctx && ctx.snapshot;
  const envelope = ctx && ctx.envelope;
  const liftCode = _liftCode(envelope);
  if (!liftCode) return null;
  return classifyScenario({
    liftState:  _deriveLiftState(snapshot, liftCode),
    plateau:    _derivePlateau(snapshot, liftCode),
    readiness:  null,
    injury:     _injury(envelope),
  });
}

// progression → { decision: { payload, explanation_inputs } } | null
// Reads the scenario the classifier stored in ctx.results, prescribes via the
// engine, and echoes every prescribed number under its own explanation key.
function progressionRunner(ctx) {
  const snapshot = ctx && ctx.snapshot;
  const envelope = ctx && ctx.envelope;
  const results  = ctx && ctx.results;
  const liftCode = _liftCode(envelope);
  const scenario = results && results.scenario_classifier;
  const scenarioId = scenario && scenario.scenario_id;
  if (!liftCode || !scenarioId) return null;

  const set = _lastWorkingSet(snapshot, liftCode);
  if (!set || !(set.currentWeight > 0) || !Number.isInteger(set.currentReps) || set.currentReps < 1
      || !Number.isFinite(set.currentRIR) || set.currentRIR < 0) {
    return null;
  }

  const rec = recommendProgression(scenarioId, set);
  if (!rec) return null;

  const payload = { lift_code: liftCode, action: rec.default_action, lever: rec.lever };
  const explanation_inputs = { scenario_id: scenarioId };
  if (typeof rec.targetWeight === 'number') { payload.target_weight = rec.targetWeight; explanation_inputs.target_weight = rec.targetWeight; }
  if (typeof rec.targetReps === 'number')   { payload.target_reps = rec.targetReps;     explanation_inputs.target_reps = rec.targetReps; }
  if (typeof rec.rationale === 'string')    { payload.rationale = rec.rationale; }

  return { decision: { payload, explanation_inputs } };
}

// The adapter registry the Orchestrator consumes. Only capabilities with a wired
// adapter run; the Orchestrator skips the rest (recorded in provenance.skipped).
function buildRunners() {
  return {
    safety:              safetyRunner,
    confidence:          confidenceRunner,
    scenario_classifier: scenarioClassifierRunner,
    progression:         progressionRunner,
  };
}

module.exports = {
  buildRunners,
  safetyRunner,
  confidenceRunner,
  scenarioClassifierRunner,
  progressionRunner,
};
