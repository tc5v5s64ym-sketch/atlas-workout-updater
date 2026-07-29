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
// 'error'; everything deterministic is 'skipped'. parser/engine_decision/
// knowledge_retrieval/coaching_strategy/write_proof are never claimed — they surface as
// `missing`. Understating is safe; overstating is the disease being cured (H-05/H-15).
//
// PHASE 4 H-08A — the canonical session crosses the /api/coach/chat boundary here. When the
// request forwards the live client active-session snapshot (context.active_session), this
// boundary builds + validates the canonical WorkoutSession once, in routes/coachOps.js, and the
// shadow READS it from res.locals (Phase 4 criterion 3 — one builder per request)
// and embeds it in the shadow packet as packet.session, recording session_snapshot as a
// genuinely-present stage. This is gated by the Phase-4 ATLAS_TURN_PRECEDENCE flag (default
// inert): flag off ⇒ packet.session stays null and the trace is byte-identical to before.
// It records session_snapshot ONLY — it never claims engine_decision merely because session
// state exists (that spine stage is still route-local, H-03/Phase 4). Shadow-only and
// response-invisible throughout: the visible coach reply is unchanged in either flag state.

const interactionTraceShadow = require('./interactionTraceShadow');
const coachTurnPacketShadow = require('./coachTurnPacketShadow');
const coachResponseSheet = require('./coachResponseSheet');
const { getProfileGoal } = require('./profileGoal');
const { buildCoachingDecisionFromExplanation, buildRecoveryDecision } = require('./coachDecisionSnapshot');
const { isTurnPrecedenceEnabled } = require('./turnPrecedence');
const turnCorrelation = require('./turnCorrelation');

// The session identity a coach request carries — delegated to the ONE shared definition in
// turnCorrelation so this site and /api/coach/message cannot drift apart (#1165).
function _requestSessionId(req) {
  return turnCorrelation.sessionIdFromRequestBody(req && req.body);
}

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
  // #1165 — publish the turn id to the client and register its session binding, so the write
  // this turn authorizes (a LATER request, on a different route) can be correlated back to it.
  // Header-only; the response body is untouched. Runs before the `turn.enabled` early return
  // because the id is minted regardless of the shadow flag — but the correlation RECORD is
  // still shadow-gated in recordWriteProof, so nothing is emitted with the shadow off.
  turnCorrelation.attachTurnToResponse(res, turn.turnId, _requestSessionId(req));
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
      // The model demonstrably authored the served text either when the response is tagged
      // source 'gemini' (/api/coach/chat) OR when the route flagged real model usage in
      // res.locals (e.g. an /api/coach/ask SME answer that Gemini polish actually rewrote).
      const modelRan = data.source === 'gemini' || !!(res.locals && res.locals.qaModelUsed);
      const modelStatus = hasError ? 'error' : (modelRan ? 'ok' : 'skipped');
      // The register validator runs only on the /chat gemini path.
      const validatorRan = !hasError && data.source === 'gemini';
      const reqBody = req.body && typeof req.body === 'object' ? req.body : {};
      const ctx = reqBody.context && typeof reqBody.context === 'object' ? reqBody.context : {};
      // The route stashes its chosen discussion referent on res.locals (the dispute resolver's /
      // discussed-lift pick, resolved AT ANSWER TIME). Read it up front so D10 can set it on the
      // canonical session below — carrying the referent on the packet instead of only in the
      // route-local in-memory store. Also forwarded to observe() for the route-vs-packet compare.
      const routeReferent = res.locals && typeof res.locals.coachTurnReferent === 'object' ? res.locals.coachTurnReferent : null;
      // Phase 4 H-08A — the canonical client WorkoutSession crosses the boundary here. Build
      // (+validate) it ONCE from the additive context.active_session snapshot, gated by the
      // ATLAS_TURN_PRECEDENCE flag: flag off ⇒ null ⇒ packet.session stays null and the trace
      // is byte-identical to before. null when the field is absent/invalid (old clients,
      // /api/coach/ask, or a malformed snapshot) — the honest missing-session result. D10: the
      // route's answer-time referent is set on the session (packet.session.discussion_referent),
      // so the divergence report's "route-local referent" signal clears as clients forward the
      // active session.
      // Phase 4 criterion 3 — READ the request-scoped canonical session the live turn already
      // used; never rebuild it here. The route builds it once (behind the same
      // ATLAS_TURN_PRECEDENCE flag) and stores it on res.locals, so `packet.session` and the
      // visible answer are the same workout truth by construction rather than by coincidence.
      //
      // Absent field ⇒ null: a route that never evaluated a canonical session has none to share,
      // and manufacturing one here would recreate exactly the second source this removes.
      const canonicalBase = (res.locals && Object.prototype.hasOwnProperty.call(res.locals, 'coachCanonicalSession'))
        ? res.locals.coachCanonicalSession
        : null;
      // D10 (criterion 4) is the ONE permitted post-response overlay: the referent is resolved at
      // ANSWER time, after the shared base was built, so attaching it needs an enriched COPY.
      // Only `discussion_referent` may differ from the base — every other field is the base's.
      // This is a copy, not a rebuild: no workout state is recomputed.
      const referent = routeReferent && routeReferent.route != null ? routeReferent.route : null;
      const canonicalSession = (canonicalBase && referent)
        ? { ...canonicalBase, discussion_referent: referent }
        : canonicalBase;
      // Recommendation-explanation grounding — the route stashes the trusted recommendation
      // snapshot on res.locals for a "why did the recommendation choose X" turn. When present
      // the route GENUINELY assembled a session/recommendation snapshot, consumed the engine's
      // recommendation decision, and applied the explain-recommendation coaching strategy for
      // this turn, so those spine stages are recorded HONESTLY (in canonical order, before
      // model_response) instead of surfacing as `missing`. Absent on every other turn — the
      // read-only route still bypasses packet truth there (the divergence report's headline).
      const grounding = res.locals && typeof res.locals.coachRecommendationGrounding === 'object'
        ? res.locals.coachRecommendationGrounding : null;
      // The route stashes a recovery-decision signal for a tiredness/recovery-routing turn.
      const recoverySignal = res.locals && typeof res.locals.coachRecoveryDecision === 'object'
        ? res.locals.coachRecoveryDecision : null;
      // Phase 4 H-03 (shadow-first) — canonicalize the route's route-local coaching decision into
      // a CoachingDecision for the packet, gated by the same ATLAS_TURN_PRECEDENCE flag: flag off
      // ⇒ null ⇒ packet.decision stays null (byte-identical shadow). An explain-recommendation
      // turn ⇒ progress_readout; a recovery-routing turn ⇒ recovery; else null. Shadow-only.
      let canonicalDecision = null;
      if (isTurnPrecedenceEnabled()) {
        if (grounding) canonicalDecision = buildCoachingDecisionFromExplanation(grounding);
        else if (recoverySignal) canonicalDecision = buildRecoveryDecision(recoverySignal);
      }
      // session_snapshot is genuinely present when a canonical WorkoutSession was assembled for
      // this turn (H-08A) OR a recommendation grounding was built. engine_decision is genuinely
      // present when the route made a coaching decision (a recommendation explanation OR recovery
      // routing) — now ALSO carried canonically in packet.decision (H-03). Do NOT mark
      // engine_decision from session state alone.
      if (canonicalSession || grounding) {
        turn.stage('session_snapshot', 'ok');
      }
      if (grounding || recoverySignal) {
        turn.stage('engine_decision', 'ok');
      }
      if (grounding) {
        turn.stage('coaching_strategy', 'ok');
      }
      turn.stage('model_response', modelStatus);
      turn.stage('validator_result', validatorRan ? 'ok' : 'skipped');
      turn.stage('rendered_output', res.statusCode >= 500 ? 'error' : 'ok', req.requestId || null);
      const traceRecord = turn.finish();
      const assembled = coachTurnPacketShadow.assembleShadowPacket({ turnId: turn.turnId, profileGoal: getProfileGoal(), session: canonicalSession, decision: canonicalDecision });
      // Forward the route's referent pick so the shadow record can compare it to the packet's
      // referent (now carried on the session, D10) — the Phase-4 divergence signal.
      coachTurnPacketShadow.observe({ trace: traceRecord, assembled, visible, routeReferent, grounding });
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
