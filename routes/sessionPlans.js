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
const { ITEM_OUTCOMES, CLOSEOUT_STATUSES } = require('../services/sessionPlanEvents');

// Opaque, client-generated identity tokens (spec §4.4): a prefix + a non-empty
// body. The server validates SHAPE only (it never mints IDs); the builders enforce
// the deeper canonical-lift-code contract.
const PV_SHAPE = /^pv_.+/;
const PI_SHAPE = /^pi_.+/;

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

module.exports = function registerSessionPlanRoutes() {
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
      if (!_str(item.planned_lift_code)) return standardError(req, res, 'each item requires a planned_lift_code', null, 400);
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
    if (!_str(item.planned_lift_code)) return standardError(req, res, 'item.planned_lift_code is required', null, 400);
    const outcome = _str(item.outcome);
    if (!ITEM_OUTCOMES.includes(outcome)) return standardError(req, res, `item.outcome must be one of ${ITEM_OUTCOMES.join('|')}`, null, 400);
    if (outcome === 'substituted' && !_str(item.performed_lift_code)) {
      return standardError(req, res, 'performed_lift_code is required when outcome is substituted', null, 400);
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

  return router;
};
