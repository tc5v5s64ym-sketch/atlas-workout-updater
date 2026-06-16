// services/deloadEngine.js
//
// The deload orchestrator. It composes the pure decision pieces — the fatigue
// score, the escalation ladder, the protocols, the state machine — with the
// persisted Deload_State, and exposes the operations the request layer (PR 6b)
// will call. This is the one place that turns raw log rows into a deload
// decision and that advances the persisted training state.
//
// Division of labor (unchanged from the spec): this engine decides *whether* to
// surface a deload and drives the state lifecycle; the protocol module owns the
// *numbers*. The engine never invents a prescription.
//
// The decision function (evaluateDeload) is PURE — current state is passed in,
// no I/O — so it is exhaustively testable. The lifecycle functions
// (begin/record/resolve) read and append Deload_State via services/deloadState,
// which is stubbed in tests.

const { normalizeLogRow } = require('./analytics');
const { computeFatigueScore } = require('./deloadFatigueScore');
const { evaluate } = require('./deloadEscalationLadder');
const { PROTOCOLS } = require('./deloadProtocols');
const { STATES, isActiveDeload, transition } = require('./deloadStateMachine');
const {
  defaultDeloadState, readCurrentDeloadState, appendDeloadState
} = require('./deloadState');

/* ============================ adapter ============================ */

// The top set of a session for one lift: the heaviest effective set by estimated
// 1RM (load × reps), so a back-off set never masquerades as the day's exposure.
function topSetOfSession(rows) {
  let best = null;
  let bestE1rm = -Infinity;
  for (const r of rows) {
    const e1rm = r.weight * (1 + r.reps / 30);
    if (e1rm > bestE1rm) { bestE1rm = e1rm; best = r; }
  }
  return best;
}

// Estimate training frequency (sessions/week) from the spread of session dates.
// A caller that knows the real cadence should pass frequency_per_week instead.
function estimateFrequencyPerWeek(sessionCount, minDate, maxDate) {
  if (!sessionCount) return 0;
  const min = minDate ? Date.parse(minDate) : NaN;
  const max = maxDate ? Date.parse(maxDate) : NaN;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return sessionCount; // single day / unknown span → treat the count as one week
  }
  const spanDays = (max - min) / 86_400_000;
  const weeks = Math.max(1, spanDays / 7);
  return Math.round((sessionCount / weeks) * 10) / 10;
}

// Turn raw Log_Cleaned rows into the normalized view the fatigue score consumes:
//   { lifts: [{ lift_code, focus, exposures: [{ weight, reps, rir }] }],
//     frequency_per_week }
// One exposure per (lift, session) — the session's top set — ordered oldest→newest.
function buildExposureView(logRows, { focusByLift = {}, frequency_per_week } = {}) {
  const rows = (Array.isArray(logRows) ? logRows : [])
    .map(normalizeLogRow)
    .filter(r => r.lift_code &&
      Number.isFinite(r.weight) && r.weight > 0 &&
      Number.isFinite(r.reps) && r.reps > 0);

  const byLift = new Map();
  const sessionSet = new Set();
  let minDate = null;
  let maxDate = null;

  for (const r of rows) {
    if (!byLift.has(r.lift_code)) byLift.set(r.lift_code, new Map());
    const sid = r.session_id || `date:${r.date_clean}`;
    const sessions = byLift.get(r.lift_code);
    if (!sessions.has(sid)) sessions.set(sid, { date: r.date_clean || '', rows: [] });
    sessions.get(sid).rows.push(r);
    sessionSet.add(sid);
    if (r.date_clean) {
      if (minDate === null || r.date_clean < minDate) minDate = r.date_clean;
      if (maxDate === null || r.date_clean > maxDate) maxDate = r.date_clean;
    }
  }

  const lifts = [];
  for (const [lift_code, sessions] of byLift) {
    const ordered = [...sessions.entries()]
      .sort((a, b) => (a[1].date || '').localeCompare(b[1].date || '') || a[0].localeCompare(b[0]));
    const exposures = ordered.map(([, s]) => {
      const top = topSetOfSession(s.rows);
      return { weight: top.weight, reps: top.reps, rir: top.rir };
    });
    lifts.push({ lift_code, focus: focusByLift[lift_code] || 'strength', exposures });
  }

  const freq = Number.isFinite(frequency_per_week) && frequency_per_week > 0
    ? frequency_per_week
    : estimateFrequencyPerWeek(sessionSet.size, minDate, maxDate);

  return { lifts, frequency_per_week: freq };
}

/* ============================ decision (pure) ============================ */

function normalizeCurrentState(currentState) {
  const base = defaultDeloadState();
  if (!currentState || typeof currentState !== 'object') return base;
  return { ...base, ...currentState, training_state: currentState.training_state || base.training_state };
}

// The session focus that selects the protocol when a deload is offered: the focus
// of the worst-stalled lift, else null (the ladder then falls back to strength).
function dominantFocus(lifts, analyses) {
  const focusByLift = new Map(lifts.map(l => [l.lift_code, l.focus]));
  let worst = null;
  for (const a of analyses) {
    if (a.stalled && (!worst || a.stalledCount > worst.stalledCount)) worst = a;
  }
  return worst ? focusByLift.get(worst.lift_code) || null : null;
}

// Evaluate whether to surface a deload. PURE: pass currentState in.
// If a deload is already active, hold it — never evaluate a conflicting new one
// (spec: "Do not generate independent recommendations that conflict with the
// active deload"). Otherwise: log rows → fatigue score → escalation ladder.
function evaluateDeload({
  logRows = [], focusByLift = {}, focus,
  frequency_per_week, recovery_reports = [], fatigue_exposure = null,
  currentState = null
} = {}) {
  const state = normalizeCurrentState(currentState);

  if (isActiveDeload(state.training_state)) {
    const protocol_id = state.deload_protocol || null;
    return {
      in_deload: true,
      training_state: STATES.DELOAD_ACTIVE,
      action: 'CONTINUE_DELOAD',
      // Both protocol and protocol_id are always present (one may be null) so a
      // consumer never has to branch on in_deload to know which key to read.
      protocol: protocol_id ? (PROTOCOLS[protocol_id] || null) : null,
      protocol_id,
      sessions_remaining: state.deload_sessions_remaining,
      reason: 'A deload is active — holding the protocol and not evaluating a new one.'
    };
  }

  const view = buildExposureView(logRows, { focusByLift, frequency_per_week });
  const fatigue = computeFatigueScore({
    lifts: view.lifts,
    frequency_per_week: view.frequency_per_week,
    recovery_reports,
    fatigue_exposure
  });

  const sessionFocus = focus || dominantFocus(view.lifts, fatigue.lifts) || 'strength';
  const decision = evaluate(fatigue.score, { focus: sessionFocus });

  return {
    in_deload: false,
    training_state: state.training_state,
    score: fatigue.score,
    signals: fatigue.signals,
    action: decision.action,
    band: decision.band,
    suggested_state: decision.suggested_state,
    protocol: decision.protocol,
    protocol_id: decision.protocol ? decision.protocol.id : null,
    sessions_remaining: null,
    focus: sessionFocus,
    frequency_per_week: view.frequency_per_week,
    reason: decision.reason
  };
}

// Async convenience: read the persisted state, then evaluate.
async function evaluateCurrentDeload(args = {}) {
  const currentState = await readCurrentDeloadState();
  return evaluateDeload({ ...args, currentState });
}

/* ============================ lifecycle (persisted) ============================ */

// Carry the active deload's context forward onto the next audit row.
function carryDeloadFields(state) {
  return {
    deload_protocol: state.deload_protocol,
    deload_reason: state.deload_reason,
    deload_start_date: state.deload_start_date,
    deload_sessions_remaining: state.deload_sessions_remaining,
    deload_exit_criteria: state.deload_exit_criteria
  };
}

// Begin a deload (owner-invoked or accepted recommendation). Validates the
// transition to DELOAD_ACTIVE through the state machine — beginning from an
// illegal state (e.g. POST_DELOAD_EVALUATION) throws. Appends the new state.
async function beginDeload({
  protocol, reason = null, sessions_remaining = 1,
  exit_criteria = null, start_date = null, currentState = null
} = {}) {
  const state = currentState ? normalizeCurrentState(currentState) : await readCurrentDeloadState();
  transition(state.training_state, STATES.DELOAD_ACTIVE); // throws if illegal
  const protocol_id = typeof protocol === 'string' ? protocol : (protocol && protocol.id) || null;
  return appendDeloadState({
    training_state: STATES.DELOAD_ACTIVE,
    deload_protocol: protocol_id,
    deload_reason: reason,
    deload_start_date: start_date || new Date().toISOString().slice(0, 10),
    deload_sessions_remaining: sessions_remaining,
    deload_exit_criteria: exit_criteria
  });
}

// Record that a deload session was completed. Decrement sessions_remaining; while
// any remain the lifter STAYS DELOAD_ACTIVE (not a state transition — the machine
// has no self-edge); when they run out, transition to POST_DELOAD_EVALUATION.
async function recordDeloadSession({ currentState = null } = {}) {
  const state = currentState ? normalizeCurrentState(currentState) : await readCurrentDeloadState();
  if (!isActiveDeload(state.training_state)) {
    throw new Error(`recordDeloadSession called while not in a deload (state: ${state.training_state}).`);
  }
  const remaining = Math.max(0, (Number(state.deload_sessions_remaining) || 0) - 1);
  if (remaining > 0) {
    return appendDeloadState({
      ...carryDeloadFields(state),
      training_state: STATES.DELOAD_ACTIVE,
      deload_sessions_remaining: remaining
    });
  }
  transition(STATES.DELOAD_ACTIVE, STATES.POST_DELOAD_EVALUATION); // validate the edge
  return appendDeloadState({
    ...carryDeloadFields(state),
    training_state: STATES.POST_DELOAD_EVALUATION,
    deload_sessions_remaining: 0
  });
}

// Close out a deload after the post-deload evaluation: return to NORMAL. Per the
// spec, recovery is assessed here, but the machine only allows the move back to
// NORMAL — a fresh evaluation must start clean, never chaining another deload.
async function resolvePostDeload({ currentState = null } = {}) {
  const state = currentState ? normalizeCurrentState(currentState) : await readCurrentDeloadState();
  if (state.training_state !== STATES.POST_DELOAD_EVALUATION) {
    throw new Error(`resolvePostDeload called while not in POST_DELOAD_EVALUATION (state: ${state.training_state}).`);
  }
  transition(STATES.POST_DELOAD_EVALUATION, STATES.NORMAL); // validate the edge
  return appendDeloadState({ training_state: STATES.NORMAL });
}

module.exports = {
  buildExposureView,
  estimateFrequencyPerWeek,
  evaluateDeload,
  evaluateCurrentDeload,
  beginDeload,
  recordDeloadSession,
  resolvePostDeload
};
