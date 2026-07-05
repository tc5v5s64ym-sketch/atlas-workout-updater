'use strict';

// Coach-engine SHADOW lane — server-side observability for ATLAS_COACH_ENGINE
// (owner-approved 2026-07-05, ring-only phase). Mirrors services/intentShadow.js:
// a capped in-memory ring + one console line, served read-only by the auth-gated
// GET /api/debug/coach-shadow. NO durable Sheets tab yet (owner decision deferred),
// NO write path, NO trust-loop touch. Diagnostics, not training data — the ring
// resets on deploy/restart, which is the right lifetime for a calibration log.
//
// Purpose: when ATLAS_COACH_ENGINE is `hybrid` (or `brian`), the three coach-engine
// route gates in index.js already compose a Brain decision. Before this module the
// only sink for that decision was the response `.brian` field, read manually by a
// dev-only localStorage compare card — so real owner traffic produced NO durable,
// aggregatable record of how Brian diverged from legacy. This module records each
// composed decision (as a SAFE SUMMARY — never the raw provenance/module internals)
// plus a legacy-vs-Brian divergence, so the owner can judge divergence over time
// via one auth-gated endpoint before any promotion decision.
//
// TOTAL by construction: observeBrianDecision never throws. Shadow observation must
// never surface an error to, or change, the served response.

const RING_MAX = 50;

let _ring = []; // newest first

function _isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function _round(n) { return Math.round(n * 100) / 100; }

function _push(entry) {
  _ring.unshift(entry);
  if (_ring.length > RING_MAX) _ring.length = RING_MAX;
}

// Project a validated CoachingDecision to a SAFE, flat summary. This is the shape
// attached to the wire response in hybrid mode (replacing the full decision) AND
// stored in the ring. It deliberately OMITS raw provenance/module lists,
// explanation_inputs, missing_info, confidence internals (score/caveats), safety
// flags, and per-block internals (scenario_id/source/warmup/pattern) — those are
// engine internals, not shadow-review signal. It keeps the decision type/status,
// the prescription the coach would surface (progression numbers OR the workout's
// block prescriptions — the owner's own training data), and the confidence/safety
// TIER/LEVEL. Returns null for a non-object (no decision to observe).
function summarizeBrianDecision(decision) {
  if (!_isObj(decision)) return null;
  const payload = _isObj(decision.payload) ? decision.payload : {};
  const confidence = _isObj(decision.confidence) ? decision.confidence : {};
  const safety = _isObj(decision.safety) ? decision.safety : {};
  const blocks = Array.isArray(payload.blocks)
    ? payload.blocks.filter(_isObj).map(b => ({
        lift_code: typeof b.lift_code === 'string' ? b.lift_code : null,
        exercise: typeof b.exercise === 'string' ? b.exercise : null,
        target_weight: typeof b.target_weight === 'number' ? b.target_weight : null,
        // session-generator blocks carry the rep target under `reps`; accept
        // `target_reps` too for forward-compatibility. Never invents a number.
        target_reps: typeof b.reps === 'number' ? b.reps
          : (typeof b.target_reps === 'number' ? b.target_reps : null),
      }))
    : null;
  return {
    decision_type: typeof decision.decision_type === 'string' ? decision.decision_type : null,
    status: typeof decision.status === 'string' ? decision.status : null,
    action: typeof payload.action === 'string' ? payload.action : null,
    target_weight: typeof payload.target_weight === 'number' ? payload.target_weight : null,
    target_reps: typeof payload.target_reps === 'number' ? payload.target_reps : null,
    rationale: typeof payload.rationale === 'string' ? payload.rationale : null,
    confidence_tier: typeof confidence.tier === 'string' ? confidence.tier : null,
    confidence_action: typeof confidence.action === 'string' ? confidence.action : null,
    safety_level: typeof safety.level === 'string' ? safety.level : null,
    block_count: blocks ? blocks.length : null,
    session_label: typeof payload.session_label === 'string' ? payload.session_label : null,
    blocks,
  };
}

// Progression-route legacy projection (analytics.js recommendation) — the fields a
// divergence check needs, mirroring the dev compare card's summarizeLegacy. Kept
// here so the route can record the LEGACY prescription BEFORE any brian override
// mutates it. Returns null for a non-object.
function summarizeLegacyRecommendation(recommendation) {
  if (!_isObj(recommendation)) return null;
  const nt = _isObj(recommendation.next_target) ? recommendation.next_target : null;
  return {
    verdict: typeof recommendation.recommendation === 'string' ? recommendation.recommendation : null,
    target_weight: nt && typeof nt.weight === 'number' ? nt.weight : null,
    target_reps: nt && typeof nt.reps === 'number' ? nt.reps : null,
    target_sets: nt && typeof nt.sets === 'number' ? nt.sets : null,
    target_rir: typeof recommendation.target_rir === 'number' ? recommendation.target_rir : null,
  };
}

// Compute legacy-vs-Brian divergence over ONLY the fields Brian actually
// prescribed (non-null). This mirrors planBrianOverride's rule that a field Brian
// left null keeps the legacy value — so intentionally-null fields (e.g. sets,
// target_rir the progression payload never sets) never register as false
// divergence. `comparable` is true only when a shared numeric field existed on
// both sides; `diverged` is true only when a compared field actually differs.
function computeDivergence(legacy, brian) {
  const L = _isObj(legacy) ? legacy : {};
  const B = _isObj(brian) ? brian : {};
  const brian_fields = [];
  let weight_delta = null;
  let reps_delta = null;
  if (typeof B.target_weight === 'number') {
    brian_fields.push('target_weight');
    if (typeof L.target_weight === 'number') weight_delta = _round(B.target_weight - L.target_weight);
  }
  if (typeof B.target_reps === 'number') {
    brian_fields.push('target_reps');
    if (typeof L.target_reps === 'number') reps_delta = _round(B.target_reps - L.target_reps);
  }
  const comparable = weight_delta !== null || reps_delta !== null;
  const diverged = (weight_delta !== null && weight_delta !== 0) || (reps_delta !== null && reps_delta !== 0);
  return { comparable, diverged, weight_delta, reps_delta, brian_fields };
}

// Record one coach-engine shadow observation. TOTAL — swallows every error so a
// shadow failure can never surface to, or fail, the served request. Only observes
// a real decision (summary non-null) in hybrid|brian mode. Returns the recorded
// entry (or undefined when skipped/failed) for test assertions.
//
// params: { route, liftCode, mode, decision, legacy, driven_by, reason, ms }
//   - decision: the validated CoachingDecision (summarized here, never stored raw)
//   - legacy:   a pre-built legacy summary (route-specific), captured BEFORE any
//               brian override mutated the served object
//   - driven_by/reason: from engine_source (brian mode) — null in hybrid
//   - ms:       elapsed time of the Brain shadow work (orchestrate + validate)
function observeBrianDecision(params) {
  try {
    const p = _isObj(params) ? params : {};
    if (p.mode !== 'hybrid' && p.mode !== 'brian') return undefined;
    const brianSummary = summarizeBrianDecision(p.decision);
    if (!brianSummary) return undefined;
    const legacySummary = _isObj(p.legacy) ? p.legacy : null;
    const entry = {
      at: new Date().toISOString(),
      route: typeof p.route === 'string' ? p.route : null,
      lift_code: typeof p.liftCode === 'string' ? p.liftCode
        : (typeof p.lift_code === 'string' ? p.lift_code : null),
      mode: p.mode,
      driven_by: typeof p.driven_by === 'string' ? p.driven_by : null,
      reason: typeof p.reason === 'string' ? p.reason : null,
      ms: typeof p.ms === 'number' ? p.ms : null,
      legacy: legacySummary,
      brian: brianSummary,
      divergence: computeDivergence(legacySummary, brianSummary),
    };
    _push(entry);
    try { console.log(`[coach-shadow] ${JSON.stringify(entry)}`); } catch { /* log-only */ }
    return entry;
  } catch (_) {
    // TOTAL: observation must never surface an error to the caller.
    return undefined;
  }
}

// Read-only snapshot for GET /api/debug/coach-shadow: the ring (newest first) plus
// basic aggregate counts so the owner can judge divergence at a glance.
function getCoachShadowLog() {
  const entries = _ring.slice();
  const aggregates = {
    total: entries.length,
    by_route: {},
    by_mode: {},
    by_driven_by: {},
    comparable: 0,
    diverged: 0,
    avg_ms: null,
  };
  let msSum = 0;
  let msCount = 0;
  for (const e of entries) {
    if (e.route) aggregates.by_route[e.route] = (aggregates.by_route[e.route] || 0) + 1;
    if (e.mode) aggregates.by_mode[e.mode] = (aggregates.by_mode[e.mode] || 0) + 1;
    const d = e.driven_by || 'none';
    aggregates.by_driven_by[d] = (aggregates.by_driven_by[d] || 0) + 1;
    if (e.divergence && e.divergence.comparable) aggregates.comparable += 1;
    if (e.divergence && e.divergence.diverged) aggregates.diverged += 1;
    if (typeof e.ms === 'number') { msSum += e.ms; msCount += 1; }
  }
  if (msCount) aggregates.avg_ms = Math.round(msSum / msCount);
  return { ring_max: RING_MAX, count: entries.length, aggregates, entries };
}

// Clear the ring (ops/tests). Also the test reset hook.
function clearCoachShadowLog() { _ring = []; }
function _resetForTesting() { _ring = []; }

module.exports = {
  RING_MAX,
  summarizeBrianDecision,
  summarizeLegacyRecommendation,
  computeDivergence,
  observeBrianDecision,
  getCoachShadowLog,
  clearCoachShadowLog,
  _resetForTesting,
};
