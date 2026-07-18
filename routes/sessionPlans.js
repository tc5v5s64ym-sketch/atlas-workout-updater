'use strict';

// ── Session_Plans capture routes (Decision Desk #952 → Option A, PR-E) ────────
//
// The three explicit, authenticated, feature-flagged sidecar endpoints
// (docs/SESSION_PLANS_CAPTURE_SPEC.md §4). SERVER PROTOCOL ONLY — no client wiring
// yet (PR-F). Each validates the request shape (required fields + opaque pv_/pi_ ID
// shape + frozen vocabularies), then hands off to the capture layer
// (services/sessionPlanCapture.js), which owns the flag gate, exact-header
// validation, the idempotent writer, and failure isolation, and returns the proof
// envelope under `data.session_plans`.
//
// Auth (x-atlas-api-key) + rate limiting are GLOBAL `app.use('/api', …)` middleware
// in index.js and run before this router regardless of mount position — same as the
// other extracted routers — so no per-route auth middleware lives here. These routes
// are `writeCapable:true` in config/routes.js but write ONLY the Session_Plans
// sidecar: never Log_Cleaned/Effort, no write_id, never the trust loop.

const express = require('express');
const { success: standardSuccess, error: standardError } = require('../response');
const capture = require('../services/sessionPlanCapture');
const setsCapture = require('../services/sessionPlanSetsCapture');
const { deriveImplicitRecommendation } = require('../services/implicitRecommendation');
const { ITEM_OUTCOMES, CLOSEOUT_STATUSES } = require('../services/sessionPlanEvents');
const { CONFIDENCE, REVISION_SOURCES } = require('../services/sessionPlanLedger');

// Opaque, client-generated identity tokens (spec §4.4): a prefix + a non-empty
// body. The server validates SHAPE only (it never mints IDs); the builders enforce
// the deeper canonical-lift-code contract.
const PV_SHAPE = /^pv_.+/;
const PI_SHAPE = /^pi_.+/;
// A canonical lift code is a non-empty token with no whitespace — mirrors the
// builder's sessionPlanEvents._requireLiftCode so a whitespaced code is rejected
// at the route (400) instead of throwing in the builder and surfacing as a 200
// {status:'error'} envelope (PR-965 review).
const LIFT_CODE_SHAPE = /^\S+$/;

function _str(v) { return v == null ? '' : String(v).trim(); }

function _readSession(body) {
  return { session_id: _str(body.session_id), session_date: _str(body.session_date), plan_version: _str(body.plan_version) };
}

// Common required-field + ID-shape validation for the session envelope. Returns an
// error string or null.
function _sessionError(s) {
  if (!s.session_id) return 'session_id is required';
  if (!s.session_date) return 'session_date is required';
  if (!s.plan_version) return 'plan_version is required';
  if (!PV_SHAPE.test(s.plan_version)) return 'plan_version must be an opaque token (pv_…)';
  return null;
}

// A positive 1-based integer (target_set_count / set_index / plan_version).
function _isPosInt(v) { const n = Number(v); return Number.isInteger(n) && n >= 1; }

// Validate one Session_Plan_Sets ledger target item at the route (400) rather than
// letting a bad shape throw in the builder and surface as a 200 error envelope.
function _ledgerItemError(item, { requireRevision = false } = {}) {
  const it = item && typeof item === 'object' ? item : {};
  if (!PI_SHAPE.test(_str(it.plan_item_id))) return 'each item requires an opaque plan_item_id (pi_…)';
  if (!LIFT_CODE_SHAPE.test(_str(it.planned_lift_code))) return 'each item requires a canonical planned_lift_code (non-empty, no spaces)';
  if (!_isPosInt(it.target_set_count)) return 'each item requires a positive integer target_set_count';
  if (it.confidence != null && _str(it.confidence) && !CONFIDENCE.includes(_str(it.confidence))) {
    return `confidence must be one of ${CONFIDENCE.join('|')}`;
  }
  if (requireRevision) {
    if (!_isPosInt(it.set_index)) return 'a revision requires a positive integer set_index';
    if (!_isPosInt(it.plan_version) || Number(it.plan_version) < 2) return 'a revision requires plan_version ≥ 2';
    if (!REVISION_SOURCES.includes(_str(it.recommendation_source))) return `a revision recommendation_source must be one of ${REVISION_SOURCES.join('|')} (a performed value never revises)`;
    // supersedes_key is DERIVED server-side from the immediately-prior version (a
    // revision chain is linear), so the client need not send it; an explicit one is
    // still honored by the builder.
  }
  return null;
}

// deps (F10C): getSheetRows + the Log_Cleaned/Effort tab names are injected so the
// /implicit route can derive the recommendation server-side over the full history (the
// only place that history lives). The other routes are pure checkpoint sinks and use no
// deps — so an older `registerSessionPlanRoutes()` call still works (deps default to {}).
module.exports = function registerSessionPlanRoutes(deps = {}) {
  const { getSheetRows, logSheetName = 'Log_Cleaned', effortSheetName = 'Effort' } = deps;
  const router = express.Router();

  // POST /api/session-plans/accept — establishes plan identity: one plan_accepted
  // row per accepted item.
  router.post('/api/session-plans/accept', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const session = _readSession(body);
    const sessionErr = _sessionError(session);
    if (sessionErr) return standardError(req, res, sessionErr, null, 400);
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items || items.length === 0) return standardError(req, res, 'items[] is required and must be non-empty', null, 400);
    for (const it of items) {
      const item = it && typeof it === 'object' ? it : {};
      if (!PI_SHAPE.test(_str(item.plan_item_id))) return standardError(req, res, 'each item requires an opaque plan_item_id (pi_…)', null, 400);
      if (!LIFT_CODE_SHAPE.test(_str(item.planned_lift_code))) return standardError(req, res, 'each item requires a canonical planned_lift_code (non-empty, no spaces)', null, 400);
    }
    const result = await capture.captureAccept(session, items);
    return standardSuccess(req, res, 'Session_Plans accept', { session_plans: result });
  });

  // POST /api/session-plans/outcome — one explicit item outcome
  // (completed | skipped | substituted).
  router.post('/api/session-plans/outcome', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const session = _readSession(body);
    const sessionErr = _sessionError(session);
    if (sessionErr) return standardError(req, res, sessionErr, null, 400);
    const item = body.item && typeof body.item === 'object' ? body.item : null;
    if (!item) return standardError(req, res, 'item is required', null, 400);
    if (!PI_SHAPE.test(_str(item.plan_item_id))) return standardError(req, res, 'item.plan_item_id must be an opaque token (pi_…)', null, 400);
    if (!LIFT_CODE_SHAPE.test(_str(item.planned_lift_code))) return standardError(req, res, 'item.planned_lift_code must be a canonical lift code (non-empty, no spaces)', null, 400);
    const outcome = _str(item.outcome);
    if (!ITEM_OUTCOMES.includes(outcome)) return standardError(req, res, `item.outcome must be one of ${ITEM_OUTCOMES.join('|')}`, null, 400);
    if (outcome === 'substituted' && !LIFT_CODE_SHAPE.test(_str(item.performed_lift_code))) {
      return standardError(req, res, 'a substituted outcome requires a canonical performed_lift_code (non-empty, no spaces)', null, 400);
    }
    const result = await capture.captureOutcome(session, item);
    return standardSuccess(req, res, 'Session_Plans outcome', { session_plans: result });
  });

  // POST /api/session-plans/closeout — one explicit session closeout
  // (finalized | abandoned).
  router.post('/api/session-plans/closeout', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const session = _readSession(body);
    const sessionErr = _sessionError(session);
    if (sessionErr) return standardError(req, res, sessionErr, null, 400);
    const closeoutStatus = _str(body.closeout_status);
    if (!CLOSEOUT_STATUSES.includes(closeoutStatus)) {
      return standardError(req, res, `closeout_status must be one of ${CLOSEOUT_STATUSES.join('|')}`, null, 400);
    }
    const result = await capture.captureCloseout(session, closeoutStatus);
    return standardSuccess(req, res, 'Session_Plans closeout', { session_plans: result });
  });

  // ── Session_Plan_Sets — set-level recommendation ledger (F10B) ─────────────────
  // The creation-time durable checkpoint (design amendment A2). DRY-RUN in F10B/F10C
  // (gated behind SESSION_PLAN_SETS_WRITE_ENABLED, off) → returns the no-write proof
  // and never touches the sheet; the production tab + live-write flag are the
  // owner-reserved F10D gate. Sidecar only — never Log_Cleaned/Effort, no write_id.

  // POST /api/session-plan-sets/accept — checkpoint the accepted plan as ledger v1
  // (one row per set of every planned item, with targets).
  router.post('/api/session-plan-sets/accept', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const session = _readSession(body);
    const sessionErr = _sessionError(session);
    if (sessionErr) return standardError(req, res, sessionErr, null, 400);
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items || items.length === 0) return standardError(req, res, 'items[] is required and must be non-empty', null, 400);
    for (const it of items) {
      const err = _ledgerItemError(it);
      if (err) return standardError(req, res, err, null, 400);
    }
    const result = await setsCapture.captureAcceptedPlan(session, items);
    return standardSuccess(req, res, 'Session_Plan_Sets accept', { session_plan_sets: result });
  });

  // POST /api/session-plan-sets/revision — checkpoint ONE explicit future-set
  // revision (a live_revision / user_endorsed Atlas recommendation for a not-yet-
  // performed set). A performed value never reaches this route (amendment 1).
  router.post('/api/session-plan-sets/revision', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const session = _readSession(body);
    const sessionErr = _sessionError(session);
    if (sessionErr) return standardError(req, res, sessionErr, null, 400);
    const revision = body.revision && typeof body.revision === 'object' ? body.revision : null;
    if (!revision) return standardError(req, res, 'revision is required', null, 400);
    const err = _ledgerItemError(revision, { requireRevision: true });
    if (err) return standardError(req, res, err, null, 400);
    const result = await setsCapture.captureRevision(session, revision);
    return standardSuccess(req, res, 'Session_Plan_Sets revision', { session_plan_sets: result });
  });

  // POST /api/session-plan-sets/implicit — derive + checkpoint the IMPLICIT recommendation
  // for an exercise the athlete logged WITHOUT asking (F10C, design §4A). The server
  // DERIVES the target from Log_Cleaned history EXCLUDING the current session (the leakage
  // guarantee — the just-logged set can never move its own target), then checkpoints only
  // a RELIABLE target; a no_reliable_target derivation appends NO row (rule 5). The
  // just-logged set is never read (it is not written to the sheet until closeout, and the
  // current session_id is excluded regardless). Dry-run until F10D. Sidecar only.
  router.post('/api/session-plan-sets/implicit', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const session = _readSession(body);
    const sessionErr = _sessionError(session);
    if (sessionErr) return standardError(req, res, sessionErr, null, 400);
    const item = body.item && typeof body.item === 'object' ? body.item : null;
    if (!item) return standardError(req, res, 'item is required', null, 400);
    if (!PI_SHAPE.test(_str(item.plan_item_id))) return standardError(req, res, 'item.plan_item_id must be an opaque token (pi_…)', null, 400);
    const liftCode = _str(item.planned_lift_code);
    if (!LIFT_CODE_SHAPE.test(liftCode)) return standardError(req, res, 'item.planned_lift_code must be a canonical lift code (non-empty, no spaces)', null, 400);
    if (typeof getSheetRows !== 'function') return standardError(req, res, 'implicit recommendation is unavailable (no history access)', null, 503);

    // Read the full Log_Cleaned (+ Effort) history; the derivation excludes the current
    // session itself, so a read failure degrades to no_reliable_target, never a guess.
    let logRows = [];
    let effortRows = [];
    try { logRows = await getSheetRows(logSheetName); } catch (_) { logRows = []; }
    if (effortSheetName) { try { effortRows = await getSheetRows(effortSheetName); } catch (_) { effortRows = []; } }

    const derivation = deriveImplicitRecommendation({
      logRows,
      effortRows,
      liftCode,
      exerciseName: _str(item.exercise_name),
      currentSessionId: session.session_id,
      currentSessionDate: session.session_date,
      today: _str(body.today) || undefined,
    });

    // Always route through the capture layer: a reliable target builds one implicit row;
    // a no_reliable_target item is SKIPPED by the builder (§4A rule 5) → an empty dry-run
    // (no phantom recommendation row). The client reads `derivation` for the outcome.
    const result = await setsCapture.captureImplicit(session, [{
      plan_item_id: _str(item.plan_item_id),
      planned_lift_code: liftCode,
      confidence: derivation.confidence,
      target_weight: derivation.target_weight,
      target_reps: derivation.target_reps,
      target_rir: derivation.target_rir,
    }]);
    return standardSuccess(req, res, 'Session_Plan_Sets implicit', { session_plan_sets: result, derivation });
  });

  return router;
};
