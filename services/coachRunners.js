'use strict';

// Coach runner adapters — the module→decision-shape mapping the Orchestrator
// consumes. Each adapter reads a State Assembly snapshot + IntentEnvelope, calls
// an available Brian module, and returns an orchestrator decision fragment. All
// coaching computation lives in the Brian modules; these adapters only shape.
//
// Pure — no I/O, no LLM, no Sheets, no route. Each adapter is defensive (returns
// a safe fragment; the Orchestrator additionally skips a throwing runner).
//
// Wired today: safety (traffic-light) + confidence (ask-vs-act). Others follow as
// their modules/keystones land; buildRunners is the extensible registry.
//
// Spec: docs/COACHING_ENGINE_ARCHITECTURE.md (runners/adapters)

const { classifyTrafficLight } = require('./safetyClassifierModule');
const { scoreConfidence }       = require('./confidenceModule');
const { queryTrend }            = require('./memoryModule');

function _liftCode(envelope) {
  const c = envelope && envelope.constraints;
  const v = c && c.target_lift;
  return typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : null;
}

function _injury(envelope) {
  const c = envelope && envelope.constraints;
  return c && typeof c.injury === 'string' && c.injury.trim() ? c.injury.trim() : null;
}

// safety → { level, flags, blocking }
function safetyRunner(ctx) {
  const envelope = ctx && ctx.envelope;
  const injury = _injury(envelope);
  const signals = injury ? [injury] : [];
  const r = classifyTrafficLight(signals);
  const level = r && ['green', 'yellow', 'red'].includes(r.state) ? r.state : 'green';
  return { level, flags: injury ? [injury] : [], blocking: level === 'red' };
}

// confidence → { score, tier, action, caveats }
function confidenceRunner(ctx) {
  const snapshot = ctx && ctx.snapshot;
  const envelope = ctx && ctx.envelope;
  const liftCode = _liftCode(envelope);
  const rows = snapshot && Array.isArray(snapshot.log_history) ? snapshot.log_history : [];
  const trendResult = liftCode ? queryTrend(liftCode, rows) : null;
  const injury = _injury(envelope);
  const c = scoreConfidence({
    liftState:       null,             // per-lift state keyed by exercise name — wired when the name↔code map lands
    readinessResult: null,             // no check-in data on this path
    trendResult,
    safetyFlags:     { active: injury ? [injury] : [] },
    exerciseKnown:   !!liftCode,
  });
  if (!c) return { score: 0, tier: 'low', action: 'ask', caveats: [] };
  return {
    score:   c.confidenceScore,
    tier:    c.tier,
    action:  c.action,
    caveats: Array.isArray(c.caveats) ? c.caveats : [],
  };
}

// The adapter registry the Orchestrator consumes. Only capabilities with a wired
// adapter run; the Orchestrator skips the rest (recorded in provenance.skipped).
function buildRunners() {
  return {
    safety:     safetyRunner,
    confidence: confidenceRunner,
  };
}

module.exports = { buildRunners, safetyRunner, confidenceRunner };
