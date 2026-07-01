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
const { classifyScenario }      = require('./scenarioClassifier');
const { recommendProgression }  = require('./progressionModule');
const { buildSession }          = require('./sessionGenerator');
// Shared per-lift prescription pipeline (the canonical home for these helpers).
const { deriveLiftState, derivePlateau, lastWorkingSet, isOverperforming } = require('./liftPrescription');

// ─── envelope helpers ─────────────────────────────────────────────────────────

function _isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

function _liftCode(envelope) {
  const c = envelope && envelope.constraints;
  const v = c && c.target_lift;
  return typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : null;
}

function _injury(envelope) {
  const c = envelope && envelope.constraints;
  return c && typeof c.injury === 'string' && c.injury.trim() ? c.injury.trim() : null;
}

function _rows(snapshot) { return snapshot && Array.isArray(snapshot.log_history) ? snapshot.log_history : []; }
function _asOf(snapshot) { return snapshot && typeof snapshot.asOf === 'string' ? snapshot.asOf : null; }

// The most-frequently-logged lift in the snapshot — used as the representative
// lift for whole-workout confidence when the intent names no single target_lift.
function _representativeLiftCode(snapshot) {
  const counts = new Map();
  for (const r of _rows(snapshot)) {
    if (!Array.isArray(r) || r[5] == null) continue;
    const lc = String(r[5]).trim().toUpperCase();
    if (lc) counts.set(lc, (counts.get(lc) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [lc, n] of counts) if (n > bestN) { best = lc; bestN = n; }
  return best;
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
  // For a per-lift intent use its target_lift; for a whole-workout intent (no
  // target_lift) fall back to the most-trained lift as the representative signal.
  const liftCode = _liftCode(envelope) || _representativeLiftCode(snapshot);
  const rows = _rows(snapshot);
  const injury = _injury(envelope);
  const c = scoreConfidence({
    liftState:       liftCode ? deriveLiftState(rows, liftCode, _asOf(snapshot)) : null,
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
  const rows = _rows(snapshot), asOf = _asOf(snapshot);
  return classifyScenario({
    liftState:      deriveLiftState(rows, liftCode, asOf),
    plateau:        derivePlateau(rows, liftCode, asOf),
    readiness:      null,
    injury:         _injury(envelope),
    overperforming: isOverperforming(rows, liftCode, asOf),
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

  const set = lastWorkingSet(_rows(snapshot), liftCode, _asOf(snapshot));
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

// session_generator → { decision: { payload, explanation_inputs } } | null
// Builds a full workout from the snapshot + envelope constraints.
function sessionGeneratorRunner(ctx) {
  const snapshot = ctx && ctx.snapshot;
  const envelope = ctx && ctx.envelope;
  const constraints = envelope && _isObj(envelope.constraints) ? envelope.constraints : {};
  const r = buildSession(snapshot, constraints);
  if (!r || !_isObj(r.payload)) return null;
  return { decision: { payload: r.payload, explanation_inputs: r.explanation_inputs } };
}

// The adapter registry the Orchestrator consumes. Only capabilities with a wired
// adapter run; the Orchestrator skips the rest (recorded in provenance.skipped).
function buildRunners() {
  return {
    safety:              safetyRunner,
    confidence:          confidenceRunner,
    scenario_classifier: scenarioClassifierRunner,
    progression:         progressionRunner,
    session_generator:   sessionGeneratorRunner,
  };
}

module.exports = {
  buildRunners,
  safetyRunner,
  confidenceRunner,
  scenarioClassifierRunner,
  progressionRunner,
  sessionGeneratorRunner,
};
