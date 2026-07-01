'use strict';

// Coach Orchestrator — layer ② of the One-Brain coaching engine (pure core).
//
// Turns one IntentEnvelope + one State Assembly snapshot into one CoachingDecision
// by resolving the capability plan, running the available capabilities in
// dependency order, and PACKAGING their outputs. It holds NO coaching rule: every
// number, verdict, confidence, and safety call comes from a capability runner
// (the Brain modules / their adapters). The orchestrator only resolves, runs,
// accounts provenance, and assembles — it decides nothing about training.
//
// Pure: no I/O, no LLM, no Sheets, no route. The snapshot is injected (built by
// State Assembly upstream); runners are injected (real module adapters wired
// incrementally; tests pass stubs).
//
// This is the PURE core only. The gated index.js hybrid attach is a separate PR
// (does not live here).
//
// Spec: docs/COACHING_CONTRACTS_SPEC.md §2 · docs/COACHING_ENGINE_ARCHITECTURE.md
//
// Public API:
//   orchestrate({ envelope, snapshot, runners }) → CoachingDecision | { brain:false, routed } | null
//
// runners: { [capabilityId]: ({ snapshot, envelope, results }) => fragment }
//   - runners.confidence → { score, tier, action, caveats }   (decision-shaped)
//   - runners.safety     → { level, flags, blocking }          (decision-shaped)
//   - a terminal runner  → { decision: { payload, explanation_inputs, missing_info? } }
//   (module → decision-shape mapping lives in the runner/adapter, never here.)

const manifest = require('./capabilityManifest');
const { buildCoachingDecision } = require('./coachingDecision');
const { knownKeys } = require('./stateAssembly');

const ENGINE_VERSION = '1.0.0';

function _isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

// Coerce a runner's confidence fragment into the decision shape, or null.
function _confShape(frag) {
  if (!_isObj(frag)) return null;
  if (typeof frag.score !== 'number' || typeof frag.action !== 'string') return null;
  return {
    score:   frag.score,
    tier:    frag.tier,
    action:  frag.action,
    caveats: Array.isArray(frag.caveats) ? frag.caveats : [],
  };
}

function _safetyShape(frag) {
  if (!_isObj(frag)) return null;
  if (typeof frag.level !== 'string') return null;
  return {
    level:    frag.level,
    flags:    Array.isArray(frag.flags) ? frag.flags : [],
    blocking: frag.blocking === true,
  };
}

// Build a minimal, valid missing_info for a clarification. Prefer an unmet
// required input key (a real data gap); otherwise name the first required input
// of a skipped capability. One entry — the minimum to satisfy the contract.
function _missingInfo(provided, resolved, snapshot, envelope, skipped) {
  if (Array.isArray(provided) && provided.length) return provided;

  const known = knownKeys(snapshot, envelope);
  for (const d of resolved.order) {
    for (const req of d.requires || []) {
      if (!known.has(req)) {
        return [{ field: req, required: true,
                  question: 'A bit more information would let me answer confidently.',
                  information_gain: 1 }];
      }
    }
  }
  // No unmet input — the gap is an unbuilt capability. Name its first required input.
  for (const id of skipped) {
    const cap = manifest.getCapability(id);
    const field = cap && Array.isArray(cap.requires) && cap.requires[0];
    if (field) {
      return [{ field, required: true,
                question: 'That coaching capability is still being built.',
                information_gain: 1 }];
    }
  }
  return [{ field: 'log_history', required: true,
            question: 'A bit more training history would help.',
            information_gain: 1 }];
}

/**
 * Orchestrate one intent into one CoachingDecision.
 * Returns null for unknown/invalid intent; { brain:false, routed } for non-Brain
 * intents (e.g. log_intent → trust loop); otherwise a validated-shape decision.
 */
function orchestrate(params) {
  const { envelope, snapshot, runners } = _isObj(params) ? params : {};
  if (!_isObj(envelope) || !envelope.type) return null;

  const resolved = manifest.resolve(envelope.type);
  if (!resolved) return null;
  if (!resolved.brain) return { intent: envelope.type, brain: false, routed: resolved.routes_to };

  const R = _isObj(runners) ? runners : {};
  const ran = [];
  const skipped = [];
  const results = {};

  // Run capabilities in dependency order: skip status:missing and those with no
  // runner; a throwing runner is skipped (degrade, never crash).
  for (const d of resolved.order) {
    if (d.status === 'missing' || typeof R[d.id] !== 'function') { skipped.push(d.id); continue; }
    try {
      results[d.id] = R[d.id]({ snapshot, envelope, results });
      ran.push(d.id);
    } catch {
      skipped.push(d.id);
    }
  }

  const confidence = _confShape(results.confidence) || { score: 0, tier: 'low', action: 'ask', caveats: [] };
  const safety = _safetyShape(results.safety) || { level: 'green', flags: [], blocking: false };

  // Terminal decision fragment: the last-running capability that supplied one.
  let frag = {};
  for (const d of resolved.order) {
    const out = results[d.id];
    if (out && _isObj(out.decision)) frag = out.decision;
  }

  const intent = { type: envelope.type, constraints: _isObj(envelope.constraints) ? envelope.constraints : {}, source: envelope.source };
  const provenance = { modules_run: ran, skipped, state_asOf: snapshot && snapshot.asOf ? snapshot.asOf : null, engine_version: ENGINE_VERSION };

  const hasPayload = _isObj(frag.payload);
  const canAnswer = hasPayload && confidence.action !== 'ask';

  if (canAnswer) {
    return buildCoachingDecision({
      intent,
      decision_type: resolved.decision_type,
      status: 'answered',
      confidence,
      safety,
      payload: frag.payload,
      missing_info: [],
      explanation_inputs: _isObj(frag.explanation_inputs) ? frag.explanation_inputs : {},
      provenance,
    });
  }

  // Cannot assemble a typed payload (or confidence says ask) → clarification.
  // This is a capability/confidence gap, not a coaching judgment: action is forced
  // to 'ask' to satisfy the four-way lockstep when no answer can be produced.
  return buildCoachingDecision({
    intent,
    decision_type: 'clarification_needed',
    status: 'needs_clarification',
    confidence: { ...confidence, action: 'ask' },
    safety,
    payload: { reason: 'insufficient_data' },
    missing_info: _missingInfo(frag.missing_info, resolved, snapshot, envelope, skipped),
    explanation_inputs: _isObj(frag.explanation_inputs) ? frag.explanation_inputs : {},
    provenance,
  });
}

module.exports = {
  orchestrate,
  ENGINE_VERSION,
};
