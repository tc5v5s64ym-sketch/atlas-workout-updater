'use strict';

// Brain (Coach-engine) ORCHESTRATOR shadow lane — the missing observability that
// must exist BEFORE ATLAS_COACH_ENGINE=hybrid can be safely flipped. Modeled on
// services/intentShadow.js (capped in-memory ring + one console line + best-effort
// append to an optional Sheets tab). This is the SINGLE coach-engine shadow
// recorder; services/coachDecisionSummary.js only projects the trimmed decision
// summary attached to the hybrid response (no ring, no endpoint).
//
// It records EVERY orchestration at the three coach-engine gates — a WIN (a composed
// decision that validated) AND the Brain's DECLINE (a clarification / invalid
// decision) or CRASH (a thrown runner). Those decline/crash paths would otherwise be
// silently swallowed by the empty catch blocks at the orchestrate() call sites, so
// without this there would be no record of how often the new engine backs off vs.
// answers — the owner can judge the Brain's real hit rate and failure rate on live
// traffic before any promotion decision.
//
// Per entry it captures the review signal named in the flip blocker: decision_type,
// status, confidence tier, which DECLARED capabilities were skipped
// (provenance.skipped), and the legacy-vs-brian target-number divergence.
//
// HARD CONTRACT — this lane is TOTAL and INERT to the response:
//   * Every public function is wrapped so it can NEVER throw at its call site.
//   * It is only ever invoked inside the already-gated hybrid|brian block; a mode
//     guard makes it a no-op otherwise, keeping legacy byte-identical.
//   * The Sheets mirror is fire-and-forget and self-swallowing — a missing tab or
//     absent creds is silently ignored. It touches NO workout tab and NO write path.
//   * It reads the served objects but never mutates them.
//
// The ring is in-memory ON PURPOSE (Atlas has no database; Sheets is the permanent
// record for TRAINING data, and shadow diagnostics are not training data — they
// reset on deploy/restart, the right lifetime for a calibration log). The optional
// Brain_Shadow tab is the only durable, aggregatable copy for offline owner review.

const { normalizeEvidenceClass, normalizeRequestOrigin, EVIDENCE_CLASSES, SYNTHETIC_ORIGINS } = require('./evidenceProvenance');

const RING_MAX = 50;

// Dedicated diagnostics tab (optional, declared in config/sheetContract.js). NOT a
// trust-contract tab and NOT training data — an offline owner/agent review surface,
// appended best-effort. Columns (append order):
//   captured_at | route | lift_code | mode | ok | reason | decision_type |
//   status | confidence_tier | skipped_json | comparable | diverged |
//   weight_delta | reps_delta | ms | app_version |
//   evidence_class | evidence_eligible | request_origin   ← PR-GATEA1 (appended)
// The three GATE-A provenance columns are appended to the END; the 16 existing
// columns are never reordered or reinterpreted. Old 16-column rows read back as
// evidence_class=unknown / evidence_eligible=FALSE (see services/evidenceProvenance.js).
const SHADOW_TAB = 'Brain_Shadow';

let _ring = [];      // newest first
let _append = null;  // injectable Sheets appendRows; lazy-required otherwise

function _isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function _round(n) { return Math.round(n * 100) / 100; }
function _isMode(m) { return m === 'hybrid' || m === 'brian'; }

// PR-GATEA1 — the evidence-provenance fields for one orchestration. The route
// classifies the request (services/evidenceProvenance.evidenceForRequest) and
// passes the verdict as `params.evidence`; here it is re-normalized and FAILS
// CLOSED: a missing / malformed / inconsistent verdict → unknown, ineligible.
// evidence_eligible is recomputed from the class so an injected `eligible:true`
// on a non-athlete_ui class is never trusted. request_origin is bounded to a safe
// token (no raw content can reach the row). Telemetry only — never a served field.
function _evidence(params) {
  const ev = _isObj(params && params.evidence) ? params.evidence : {};
  const evidence_class = normalizeEvidenceClass(ev.evidence_class);
  return {
    evidence_class,
    evidence_eligible: evidence_class === EVIDENCE_CLASSES.ATHLETE_UI,
    request_origin: normalizeRequestOrigin(ev.request_origin),
  };
}

function isBrainShadowEnabled() {
  return _isMode(process.env.ATLAS_COACH_ENGINE);
}

// The RING (debug endpoint) + console line are always live in hybrid|brian and are
// the reviewable record the flip needs. The DURABLE Brain_Shadow Sheets mirror is a
// SEPARATE, default-OFF opt-in (ATLAS_BRAIN_SHADOW_PERSIST). This keeps the three
// coach-engine READ routes append-free by default — no Sheets write, byte-identical,
// honoring the "do not touch write paths" contract — while still letting the owner
// turn on the durable, aggregatable mirror when they want offline review. Staged
// exactly like the rest of the coach-engine rollout: observability first, the
// durable write only on an explicit flag.
function isBrainShadowPersistEnabled() {
  const v = process.env.ATLAS_BRAIN_SHADOW_PERSIST;
  return v === '1' || v === 'true' || v === 'on';
}

function _push(entry) {
  _ring.unshift(entry);
  if (_ring.length > RING_MAX) _ring.length = RING_MAX;
}

// Legacy-vs-brian divergence over ONLY the target numbers both sides supplied. A
// field either side left null is not a divergence — it simply isn't comparable.
// `comparable` is true when at least one shared numeric field existed; `diverged`
// is true only when a compared field actually differs. Never invents a number.
function _divergence(legacy, brianTargets) {
  const L = _isObj(legacy) ? legacy : {};
  const B = _isObj(brianTargets) ? brianTargets : {};
  let weight_delta = null;
  let reps_delta = null;
  if (typeof B.target_weight === 'number' && typeof L.target_weight === 'number') {
    weight_delta = _round(B.target_weight - L.target_weight);
  }
  if (typeof B.target_reps === 'number' && typeof L.target_reps === 'number') {
    reps_delta = _round(B.target_reps - L.target_reps);
  }
  const comparable = weight_delta !== null || reps_delta !== null;
  const diverged = (weight_delta !== null && weight_delta !== 0) || (reps_delta !== null && reps_delta !== 0);
  return { comparable, diverged, weight_delta, reps_delta };
}

// Record one entry: the in-memory ring (debug endpoint), a console line, and a
// BEST-EFFORT append to the Brain_Shadow tab. Returns the entry for test assertions.
function _record(entry, appVersion) {
  _push(entry);
  try { console.log(`[brain-shadow] ${JSON.stringify(entry)}`); } catch { /* log-only */ }
  if (isBrainShadowPersistEnabled()) _persistRow(entry, appVersion || '');
  return entry;
}

// Mirror one diagnostic entry to the Brain_Shadow tab. BEST-EFFORT and TOTAL:
// fire-and-forget, self-swallowing — a missing tab, absent Sheets creds, or a
// transient error is silently ignored so the caller (a coach-engine route gate) can
// NEVER be blocked or failed by shadow persistence. Touches no workout tab or write
// path; this is diagnostics, not a logged set.
function _persistRow(entry, appVersion) {
  // SYNTHETIC QUOTA CONTAINMENT (owner ruling 2026-07-31) — same rule as
  // services/intentShadow.js. Brain_Shadow was the dominant quota consumer in
  // live-retest run 30596164330: 126 of 150 Sheets quota-exceeded events, because a
  // single agent turn fans out one row per candidate lift and each append retries up
  // to three times against a per-minute write quota. `entry.request_origin` is already
  // the bounded token from _evidence(). Ring + console line are kept; only the Sheet
  // mirror is skipped. Owner traffic is unaffected.
  if (SYNTHETIC_ORIGINS.has(normalizeRequestOrigin(entry && entry.request_origin))) return;

  Promise.resolve()
    .then(() => {
      const append = _append || require('../sheets').appendRows;
      const d = _isObj(entry.divergence) ? entry.divergence : {};
      const row = [
        entry.at || '',
        entry.route || '',
        entry.lift_code || '',
        entry.mode || '',
        entry.ok === true ? 'TRUE' : 'FALSE',
        entry.reason || '',
        entry.decision_type || '',
        entry.status || '',
        entry.confidence_tier || '',
        JSON.stringify(entry.skipped || []),
        d.comparable === true ? 'TRUE' : 'FALSE',
        d.diverged === true ? 'TRUE' : 'FALSE',
        d.weight_delta != null ? d.weight_delta : '',
        d.reps_delta != null ? d.reps_delta : '',
        entry.ms != null ? entry.ms : '',
        appVersion || '',
        // PR-GATEA1 provenance — appended to the END; existing columns untouched.
        entry.evidence_class || EVIDENCE_CLASSES.UNKNOWN,
        entry.evidence_eligible === true ? 'TRUE' : 'FALSE',
        entry.request_origin || '',
      ];
      return append(SHADOW_TAB, [row]);
    })
    .catch(() => { /* best-effort: persistence failure must never surface */ });
}

// Record ONE orchestration outcome — a WIN or a DECLINE/INVALID. TOTAL: swallows
// every error so a shadow failure can never surface to, or fail, the served
// request. No-op (returns undefined) outside hybrid|brian mode so legacy stays
// byte-identical. Returns the recorded entry (or undefined) for test assertions.
//
// params: { route, liftCode, mode, decision, validation, legacy, ms, appVersion }
//   - decision:   the orchestrator's return (a CoachingDecision, a { brain:false }
//                 route object, or null). Read defensively; never mutated.
//   - validation: validateCoachingDecision(decision) — { valid, errors }.
//   - legacy:     a route-specific legacy summary captured BEFORE any override,
//                 used only for the target-number divergence.
function observeBrainOrchestration(params) {
  try {
    const p = _isObj(params) ? params : {};
    if (!_isMode(p.mode)) return undefined;

    const decision = p.decision;
    const validation = _isObj(p.validation) ? p.validation : null;
    const legacy = _isObj(p.legacy) ? p.legacy : null;

    let ok = false;
    let reason = null;
    if (decision == null) {
      reason = 'null_decision';
    } else if (_isObj(decision) && decision.brain === false) {
      // Orchestrator routed a non-Brain intent (e.g. log_intent → trust loop).
      reason = 'non_brain_route';
    } else if (validation && validation.valid === true) {
      ok = true;
    } else {
      // A decision object exists but failed validation (or none was supplied) — the
      // Brain declined / produced something unsurfaceable. This is the FAILURE the
      // empty catch blocks used to swallow.
      reason = 'invalid_decision';
    }

    const dec = _isObj(decision) ? decision : {};
    const payload = _isObj(dec.payload) ? dec.payload : {};
    const confidence = _isObj(dec.confidence) ? dec.confidence : {};
    const provenance = _isObj(dec.provenance) ? dec.provenance : {};
    const brianTargets = (typeof payload.target_weight === 'number' || typeof payload.target_reps === 'number')
      ? {
          target_weight: typeof payload.target_weight === 'number' ? payload.target_weight : null,
          target_reps: typeof payload.target_reps === 'number' ? payload.target_reps : null,
        }
      : null;

    const entry = {
      at: new Date().toISOString(),
      route: typeof p.route === 'string' ? p.route : null,
      lift_code: typeof p.liftCode === 'string' ? p.liftCode
        : (typeof p.lift_code === 'string' ? p.lift_code : null),
      mode: p.mode,
      ok,
      reason,
      decision_type: typeof dec.decision_type === 'string' ? dec.decision_type : null,
      status: typeof dec.status === 'string' ? dec.status : null,
      confidence_tier: typeof confidence.tier === 'string' ? confidence.tier : null,
      skipped: Array.isArray(provenance.skipped) ? provenance.skipped.slice() : [],
      divergence: _divergence(legacy, brianTargets),
      ms: typeof p.ms === 'number' ? p.ms : null,
      ..._evidence(p),
    };
    return _record(entry, p.appVersion);
  } catch (_) {
    // TOTAL: observation must never surface an error to the caller.
    return undefined;
  }
}

// Record ONE orchestration that CRASHED — the thrown-error path the empty catch
// blocks used to swallow. TOTAL and mode-gated exactly like the win path. reason
// defaults to 'orchestrator_error'.
//
// params: { route, liftCode, mode, reason, ms, appVersion }
function observeBrainFailure(params) {
  try {
    const p = _isObj(params) ? params : {};
    if (!_isMode(p.mode)) return undefined;
    const entry = {
      at: new Date().toISOString(),
      route: typeof p.route === 'string' ? p.route : null,
      lift_code: typeof p.liftCode === 'string' ? p.liftCode
        : (typeof p.lift_code === 'string' ? p.lift_code : null),
      mode: p.mode,
      ok: false,
      reason: typeof p.reason === 'string' ? p.reason : 'orchestrator_error',
      decision_type: null,
      status: null,
      confidence_tier: null,
      skipped: [],
      divergence: _divergence(null, null),
      ms: typeof p.ms === 'number' ? p.ms : null,
      ..._evidence(p),
    };
    return _record(entry, p.appVersion);
  } catch (_) {
    return undefined;
  }
}

// Read-only snapshot for GET /api/debug/brain-shadow: the ring (newest first) plus
// basic aggregate counts (wins vs failures, by reason/route, divergence) so the
// owner can judge the Brain's hit/decline/crash rate at a glance.
function getBrainShadowLog() {
  const entries = _ring.slice();
  const aggregates = {
    total: entries.length,
    ok: 0,
    failed: 0,
    by_reason: {},
    by_route: {},
    comparable: 0,
    diverged: 0,
  };
  for (const e of entries) {
    if (e.ok) aggregates.ok += 1; else aggregates.failed += 1;
    if (e.reason) aggregates.by_reason[e.reason] = (aggregates.by_reason[e.reason] || 0) + 1;
    if (e.route) aggregates.by_route[e.route] = (aggregates.by_route[e.route] || 0) + 1;
    if (e.divergence && e.divergence.comparable) aggregates.comparable += 1;
    if (e.divergence && e.divergence.diverged) aggregates.diverged += 1;
  }
  return {
    enabled: isBrainShadowEnabled(),
    persist: isBrainShadowPersistEnabled(),
    ring_max: RING_MAX,
    count: entries.length,
    aggregates,
    entries,
  };
}

// Clear the ring (ops/tests).
function clearBrainShadowLog() { _ring = []; }

function _resetForTesting({ append } = {}) {
  _ring = [];
  _append = typeof append === 'function' ? append : null;
}

module.exports = {
  RING_MAX,
  SHADOW_TAB,
  isBrainShadowEnabled,
  isBrainShadowPersistEnabled,
  observeBrainOrchestration,
  observeBrainFailure,
  getBrainShadowLog,
  clearBrainShadowLog,
  _resetForTesting,
};
