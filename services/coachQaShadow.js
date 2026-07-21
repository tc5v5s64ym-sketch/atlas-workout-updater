'use strict';

// Q&A shadow coverage — extends the Phase-3 CoachTurnPacket shadow (Coach_Shadow) and the
// Coach_Response capture to the athlete-facing coach Q&A routes (/api/coach/chat and
// /api/coach/ask), which serve recommendation explanations, plan disputes, corrections,
// and session questions but minted NO turn_id before this change (proven production gap:
// 2026-07-21 explain_recommendation/correction turns produced no Coach row).
//
// It reuses the SAME architecture as /api/coach/message rather than a parallel system:
// one minted turn_id per completed turn (interactionTraceShadow.beginTurn), a truthful —
// deliberately missing-heavy — InteractionTrace, the sparse shadow CoachTurnPacket, and
// the durable Coach_Response record, all keyed by that one turn_id. Both routes are
// READ-ONLY (no Sheet writes; propose_* are consent-gated client proposals), so this stays
// purely observational: gated by ATLAS_INTERACTION_TRACE=shadow, best-effort, off the
// served path, and never alters, blocks, or writes on behalf of the response.
//
// TRUTHFULNESS: it claims only the stages it can prove from the served response — the
// model ran (model_response 'ok') and the register validator ran (validator_result 'ok')
// ONLY when the answer came back tagged source 'gemini'; an errored generation is
// 'error'; everything deterministic is 'skipped'. parser/session_snapshot/engine_decision/
// knowledge_retrieval/coaching_strategy/write_proof are never claimed — they surface as
// `missing`. Understating is safe; overstating is the disease being cured (H-05/H-15).

const interactionTraceShadow = require('./interactionTraceShadow');
const coachTurnPacketShadow = require('./coachTurnPacketShadow');
const coachResponseSheet = require('./coachResponseSheet');
const { getProfileGoal } = require('./profileGoal');

// The two Q&A routes carry the final visible answer in different fields: /api/coach/chat
// uses data.message, /api/coach/ask uses data.answer. Normalize to the Coach_Response /
// summarizeVisible shape (data.message) so one capture path serves both.
function _normalizeVisible(body) {
  const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : {};
  const text = typeof data.message === 'string' ? data.message
    : (typeof data.answer === 'string' ? data.answer : null);
  return { data: { message: text, source: data.source, kind: data.kind, configured: data.configured, error: data.error } };
}

// The LLM demonstrably produced the answer only when the route tagged it source 'gemini'.
// Every deterministic engine/SME lane (source 'engine'/'training_sme') or an empty/absent
// source means the model did not author the served line → 'skipped' (never overclaim).
function _deriveModelStatus(source) {
  return source === 'gemini' ? 'ok' : 'skipped';
}

// /api/coach/ask fires as an SME pre-check for many questions; a log_only / empty-answer
// result is IGNORED by the client (never shown to the athlete), and the turn then falls
// through to /api/coach/chat. Capture only the athlete-FACING SME answers, so a question
// yields exactly one correlated Coach_Shadow/Coach_Response pair, not a silent pre-check
// row plus the real /chat row.
function _askIsAthleteFacing(body) {
  const d = body && typeof body === 'object' ? body.data : null;
  return !!(d && d.depth !== 'log_only' && typeof d.answer === 'string' && d.answer.trim());
}

// Install the observational Q&A shadow on a coach Q&A route. Call ONCE at the top of the
// handler, after the empty-message guard and before any res.json. Inert (a no-op wrapper
// is not even installed) when ATLAS_INTERACTION_TRACE is not 'shadow'. Returns the trace
// recorder (mostly for symmetry/tests); the route never needs to touch it.
function observeQaTurn(req, res, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const route = typeof o.route === 'string' ? o.route : null;
  const source = typeof o.source === 'string' ? o.source : 'coach_chat';
  const intentType = typeof o.intentType === 'string' ? o.intentType : source;
  const captureWhen = typeof o.captureWhen === 'function' ? o.captureWhen : null;

  const turn = interactionTraceShadow.beginTurn({ intentType, source });
  turn.stage('intent', 'ok');
  if (!turn.enabled) return turn;

  let visibleBody = null;
  const _origJson = res.json.bind(res);
  res.json = (payload) => { try { visibleBody = payload; } catch (_) { /* best-effort */ } return _origJson(payload); };
  res.on('finish', () => {
    try {
      // Athlete-facing gate (e.g. /api/coach/ask log_only pre-checks are not captured).
      if (captureWhen && !captureWhen(visibleBody)) return;
      const visible = _normalizeVisible(visibleBody);
      const data = visible.data;
      const hasError = !!data.error;
      const modelStatus = hasError ? 'error' : _deriveModelStatus(data.source);
      const validatorRan = !hasError && data.source === 'gemini';
      turn.stage('model_response', modelStatus);
      turn.stage('validator_result', validatorRan ? 'ok' : 'skipped');
      turn.stage('rendered_output', res.statusCode >= 500 ? 'error' : 'ok', req.requestId || null);
      const traceRecord = turn.finish();
      const assembled = coachTurnPacketShadow.assembleShadowPacket({ turnId: turn.turnId, profileGoal: getProfileGoal() });
      coachTurnPacketShadow.observe({ trace: traceRecord, assembled, visible });
      const reqBody = req.body && typeof req.body === 'object' ? req.body : {};
      const ctx = reqBody.context && typeof reqBody.context === 'object' ? reqBody.context : {};
      coachResponseSheet.persist({
        turnId: turn.turnId,
        sessionId: reqBody.sessionId || reqBody.session_id || ctx.session_id || ctx.sessionId || null,
        route,
        intentType,
        visible,
        modelStatus,
        appVersion: reqBody.appVersion || reqBody.app_version || null,
      });
    } catch (_) { /* shadow must never affect the response */ }
  });
  return turn;
}

module.exports = {
  observeQaTurn,
  _normalizeVisible,
  _deriveModelStatus,
  _askIsAthleteFacing,
};
