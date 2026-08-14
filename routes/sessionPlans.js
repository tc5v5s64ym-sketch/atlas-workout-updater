'use strict';

// ── Session_Plans capture routes (Decision Desk #952 → Option A, PR-E) ────────
//
// The explicit authenticated endpoints for the Supabase-authoritative plan lifecycle.
// Each validates the request shape (required fields + opaque pv_/pi_ ID
// shape + frozen vocabularies), then hands off to the capture layer
// (services/sessionPlanCapture.js), which owns the idempotent writer and returns the proof
// envelope under `data.session_plans`.
//
// Auth (x-atlas-api-key) + rate limiting are GLOBAL `app.use('/api', …)` middleware
// in index.js and run before this router regardless of mount position — same as the
// other extracted routers — so no per-route auth middleware lives here. These routes
// are `writeCapable:true` in config/routes.js but write only the Supabase plan
// authority: never logged sets/Effort and never Google Sheets.

const express = require('express');
const { success: standardSuccess, error: standardError } = require('../response');
const workoutAuthority = require('../services/workoutAuthority');
const capture = require('../services/sessionPlanCapture');
const setsCapture = require('../services/sessionPlanSetsCapture');
const { deriveImplicitRecommendation } = require('../services/implicitRecommendation');
const { ITEM_OUTCOMES, CLOSEOUT_STATUSES } = require('../services/sessionPlanEvents');
const { CONFIDENCE, REVISION_SOURCES } = require('../services/sessionPlanLedger');
const { nextAvailableSessionId } = require('../services/sessionId');
const { sessionPlansColumns } = require('../config/columns');

// Column positions for the acceptance-time occupancy read (the layout is the
// authoritative config/columns.js contract, never guessed). The Log_Cleaned and
// Effort indices that used to sit here served `_durableSessionIds`, whose Sheets
// read the S4 cutover replaced with `workoutAuthority.occupiedSessionIds`.
const SP_SESSION_IDX = sessionPlansColumns.indexOf('session_id');
const SP_PLAN_VERSION_IDX = sessionPlansColumns.indexOf('plan_version');
const SP_EVENT_IDX = sessionPlansColumns.indexOf('event_type');

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

// These ledgers are authoritative after S4, not optional telemetry. A route must
// never acknowledge an accepted plan, outcome, revision, or closeout unless the
// authority confirms it is durable (including an idempotent replay).
function _captureRefusal(req, res, result, concept) {
  if (result && result.captured === true) return null;
  const status = _str(result && result.status) || 'error';
  const reason = _str(result && result.reason) || 'authoritative write was not confirmed';
  return standardError(req, res, `${concept} was not persisted. Retry the request.`, { status, reason }, 503);
}

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

// NO INJECTED SHEETS DEPENDENCY REMAINS, and the parameter is gone rather than
// ignored (OWNER CORRECTION 2026-08-13).
//
// `getSheetRows` plus the Log_Cleaned/Effort tab names used to be injected here so
// the router could read history and plan occupancy — the only place they lived. All
// three concepts are Supabase-authoritative since the S4 cutover, so the injection
// had already decayed to ONE surviving caller: the accept route's Session_Plans
// occupancy read. That read was the last thing on any allocating workout-identity
// path that could be stopped by a Google Sheets quota, and it did not degrade — it
// answered 503 and refused to accept the plan at all.
//
// It now reads `atlas.session_plan_events` through the same authority every other
// route here uses. With that gone the dependency has no consumer, so it is deleted
// along with `_durableSessionIds` and the two column indices that served it, rather
// than left as a parameter no call site should pass.
module.exports = function registerSessionPlanRoutes() {
  const router = express.Router();

  // POST /api/session-plans/accept — establishes plan identity: one plan_accepted
  // row per accepted item.
  //
  // session_id is OPTIONAL here, unlike every other Session_Plans route: a plan
  // accepted before any set is logged has no established workout identity, and the
  // client no longer derives one (its hardcoded `${date}-{AM|PM}-01` mint re-used the
  // first same-period session's identity, merging two accepted workouts). When the
  // request carries no session_id the SERVER allocates one — the same
  // nextAvailableSessionId authority /api/log-workout uses — over the durable union
  // Effort ∪ Log_Cleaned ∪ Session_Plans, and reports the identity it wrote under.
  // Session_Plans is in the union because an accepted-but-not-yet-logged workout
  // exists ONLY there. A retry of the same acceptance (same pv_ plan_version) must
  // re-use the identity its durable rows already carry, never allocate a second one.
  router.post('/api/session-plans/accept', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const session = _readSession(body);
    if (!session.session_date) return standardError(req, res, 'session_date is required', null, 400);
    if (!session.plan_version) return standardError(req, res, 'plan_version is required', null, 400);
    if (!PV_SHAPE.test(session.plan_version)) return standardError(req, res, 'plan_version must be an opaque token (pv_…)', null, 400);
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items || items.length === 0) return standardError(req, res, 'items[] is required and must be non-empty', null, 400);
    for (const it of items) {
      const item = it && typeof it === 'object' ? it : {};
      if (!PI_SHAPE.test(_str(item.plan_item_id))) return standardError(req, res, 'each item requires an opaque plan_item_id (pi_…)', null, 400);
      if (!LIFT_CODE_SHAPE.test(_str(item.planned_lift_code))) return standardError(req, res, 'each item requires a canonical planned_lift_code (non-empty, no spaces)', null, 400);
    }

    if (!session.session_id) {
      // Durable retry evidence first: an acceptance that already wrote rows under
      // this plan_version owns its identity. Checking before the occupancy union is
      // load-bearing — after the first attempt the union CONTAINS the allocated id,
      // so a replay that skipped this check would allocate the next slot and fork
      // one accepted workout into two identities.
      //
      // FROM SUPABASE, the authority for the plan ledger since the S4 cutover. The
      // rows come back as `Session_Plans` cell rows in the owner-approved column
      // order, so the three column indices below are unchanged — only the store
      // answering them is. A Google Sheets quota can no longer refuse an acceptance.
      let planRows;
      try {
        planRows = await workoutAuthority.planEventRows();
      } catch (e) {
        console.error('❌ Plan ledger unreadable for acceptance session-id allocation:', e);
        return standardError(req, res, 'Cannot allocate a session id: plan-ledger occupancy is unreadable.', null, 503);
      }
      const spRows = Array.isArray(planRows) ? planRows : [];
      const prior = spRows.find(r => Array.isArray(r)
        && _str(r[SP_PLAN_VERSION_IDX]) === session.plan_version
        && _str(r[SP_EVENT_IDX]) === 'plan_accepted'
        && _str(r[SP_SESSION_IDX]) !== '');
      if (prior) {
        session.session_id = _str(prior[SP_SESSION_IDX]);
      } else {
        // Occupancy comes from Supabase, the authority for session identity since
        // the S4 cutover. `atlas.workout_sessions` is the parent every logged set
        // and Effort row hangs off, so ONE query answers what two whole-tab Sheets
        // reads used to — and a session logged without watch data still occupies
        // its slot, which is the defect that union existed to fix.
        //
        // FAIL CLOSED is unchanged and is the whole point: an unreadable occupancy
        // source means slot availability cannot be proven, so allocation refuses
        // rather than falling open onto an id that may already belong to a workout.
        let durableIds;
        try {
          durableIds = await workoutAuthority.occupiedSessionIds(session.session_date);
        } catch (e) {
          console.error('❌ Session identity unreadable for acceptance session-id allocation:', e);
          return standardError(req, res, 'Cannot allocate a session id: session occupancy is unreadable.', null, 503);
        }
        const spIds = spRows.map(r => (Array.isArray(r) ? _str(r[SP_SESSION_IDX]) : '')).filter(Boolean);
        try {
          session.session_id = nextAvailableSessionId(session.session_date, [...durableIds, ...spIds]);
        } catch (e) {
          // Exhaustion is a REFUSAL, never a reuse: the allocator fails closed when
          // every slot in the period is occupied, and this route must surface that
          // as unavailability — not mislabel it as a bad date.
          if (e && e.code === 'SESSION_SLOTS_EXHAUSTED') {
            return standardError(req, res, 'Cannot allocate a session id: every slot for this date and period is occupied.', null, 503);
          }
          return standardError(req, res, 'session_date must be a calendar date (YYYY-MM-DD).', null, 400);
        }
      }
    }

    const result = await capture.captureAccept(session, items);
    const refusal = _captureRefusal(req, res, result, 'Accepted plan');
    if (refusal) return refusal;
    // The identity the acceptance was written under, echoed verbatim — for an
    // allocating request this is the client's ONLY source of the session identity.
    return standardSuccess(req, res, 'Session_Plans accept', { session_plans: result, session_id: session.session_id });
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
    const refusal = _captureRefusal(req, res, result, 'Plan outcome');
    if (refusal) return refusal;
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
    const refusal = _captureRefusal(req, res, result, 'Plan closeout');
    if (refusal) return refusal;
    return standardSuccess(req, res, 'Session_Plans closeout', { session_plans: result });
  });

  // ── Session_Plan_Sets — set-level recommendation ledger (F10B) ─────────────────
  // The creation-time durable checkpoint (design amendment A2). DRY-RUN in F10B/F10C
  // writes to the Supabase recommendation ledger. Sidecar to the workout Save,
  // but authoritative for the accepted prescription; never Log_Cleaned/Effort.

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
    const refusal = _captureRefusal(req, res, result, 'Accepted plan-set prescription');
    if (refusal) return refusal;
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
    const refusal = _captureRefusal(req, res, result, 'Plan-set revision');
    if (refusal) return refusal;
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
    // Read the full logged-set (+ Effort) history from Supabase, the authority for
    // both concepts since the S4 cutover. The derivation excludes the current session
    // itself.
    //
    // AN UNREADABLE AUTHORITY REFUSES; IT DOES NOT DERIVE FROM EMPTY (OWNER
    // CORRECTION 2026-08-13). Both reads used to end in `catch (_) { rows = []; }`,
    // described as degrading to `no_reliable_target` rather than a guess. That
    // reasoning was wrong in a way worth naming: `no_reliable_target` is not a
    // neutral outcome, it is a RECORDED COACHING DECISION — the capture layer skips
    // the item and the ledger carries the absence — so a momentary read failure was
    // written down as "this lifter has no reliable history for this lift" and became
    // indistinguishable afterwards from the same verdict reached over the real
    // corpus. A refusal costs the athlete one retry; the silent version costs the
    // truth of the record.
    let logRows;
    let effortRows;
    try {
      [logRows, effortRows] = await Promise.all([
        workoutAuthority.loggedSetRows(),
        workoutAuthority.effortRows(),
      ]);
    } catch (e) {
      console.error('❌ History unreadable for implicit recommendation:', e);
      return standardError(req, res,
        'implicit recommendation is unavailable — the workout history is temporarily unreadable', {
          reason: 'authority_read_unavailable',
          retryable: true,
        }, 503);
    }

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
    if (derivation.confidence === 'reliable') {
      const refusal = _captureRefusal(req, res, result, 'Implicit plan-set prescription');
      if (refusal) return refusal;
    }
    return standardSuccess(req, res, 'Session_Plan_Sets implicit', { session_plan_sets: result, derivation });
  });

  return router;
};
