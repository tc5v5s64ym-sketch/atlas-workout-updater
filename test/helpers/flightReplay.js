'use strict';

// PR-23 — Flight-Recorder replay harness (docs/REMEDIATION_PLAN_V2.md).
//
// Takes a recorded Flight-Recorder session export (fixture JSON, shaped like the
// real event taxonomy in docs/FLIGHT_RECORDER_SPEC.md §2 — event_type, route,
// user_input, user_action, session_state, ui_snapshot) and re-drives the client
// session-state machine through the same sequence, returning the outcomes so the
// test can assert them against the fixture's `expected` block.
//
// Each fixture names a `scenario`; each scenario has exactly one adapter below
// that knows which real function(s) the scenario drives and how to pull its
// inputs out of the fixture's `events` array. Six scenarios exist, one per fixed
// PR10_REGRESSION_ADDENDUM.md case (ADD-1/2/4/5/6/7); ADD-3 has no adapter/fixture
// because it is not yet built (owner-reserved, pending Atlas Decision Desk #914 —
// see BACKLOG.md "ADD-3").
//
// Constraints (per the PR-23 brief): replay is read-only (no live Sheets access,
// no LLM calls — every input is either a pure function argument or a fixture
// literal); nothing here touches the write path, the preview→approve→write loop,
// or any Sheets tab.

const {
  buildRestoredSessionHarness,
  buildPlanMutationHarness,
  buildIdentityCorrectionHarness,
} = require('./appSliceHarness');

function eventsOfType(fixture, type) {
  return (fixture.events || []).filter(e => e && e.event_type === type);
}

function firstEventOfType(fixture, type) {
  return eventsOfType(fixture, type)[0] || null;
}

// ── ADD-1: restored-session-discard ─────────────────────────────────────────
async function replayRestoredSessionDiscard(fixture) {
  const screen = firstEventOfType(fixture, 'screen_rendered');
  const state = (screen && screen.session_state) || {};
  const uiSnapshot = (screen && screen.ui_snapshot) || {};
  const action = firstEventOfType(fixture, 'user_action');

  const h = buildRestoredSessionHarness({ noticeText: uiSnapshot.session_resume_notice_text });
  h.setSessionLog(state.sessionLog || []);
  h.setActivePlannedSession(state.activePlannedSession || null);

  if (action && action.user_action === 'tap:discard-restored-session') {
    h.discardRestoredSession();
  }

  return {
    session_resume_notice_hidden: h.isNoticeHidden(),
    session_log: h.getSessionLog(),
    active_planned_session: h.getActivePlannedSession(),
    session_id_cleared: h.sessionIdValue() === '',
    persisted_snapshot_cleared: h.isSnapshotCleared(),
    events_dispatched: h.getEvents().map(e => e.type),
  };
}

// ── ADD-2: plan-skip ─────────────────────────────────────────────────────────
async function replayPlanSkip(fixture) {
  const stateEvent = firstEventOfType(fixture, 'session_state_changed');
  const inputEvent = firstEventOfType(fixture, 'user_input');
  const state = (stateEvent && stateEvent.session_state) || {};

  const h = await buildPlanMutationHarness();
  h.setActivePlannedSession(state.activePlannedSession || null);

  const applied = inputEvent ? h.tryApplyPlanMutation(inputEvent.user_input) : false;
  const mutationEvent = h.getEvents().find(e => e.type === 'atlas:plan-mutated');

  return {
    mutation_applied: applied,
    remaining_plan_exercise_names: h.getExercises(),
    announced_summary: mutationEvent ? mutationEvent.detail.summary : null,
    events_dispatched: h.getEvents().map(e => e.type),
  };
}

// ── ADD-4: substitute-satisfies-slot ────────────────────────────────────────
let _activeSessionModule = null;
async function loadActiveSessionModule() {
  if (!_activeSessionModule) _activeSessionModule = await import('../../src/app/activeSession.js');
  return _activeSessionModule;
}

// Mirrors getCanonicalSession's reconciliation (test/activeSessionState.test.js
// canonical()/canonicalRecap() helpers) — builds a canonical session from planned
// exercise names, marks each completed name done (inserting it off-plan first if
// it isn't an existing slot), and returns the completed/remaining-before-reconciliation
// name lists.
function buildCanonicalSession(AS, planNames, completedNames) {
  let s = AS.createActiveSession({ exercises: (planNames || []).map(n => ({ name: n })) });
  for (const name of completedNames || []) {
    const after = AS.markCompleted(s, name);
    s = after !== s ? after : AS.markCompleted(AS.insertExercise(s, { name }), name);
  }
  const completed = AS.completedExercises(s).map(e => e.name).filter(Boolean);
  const remainingRaw = AS.remaining(s).map(e => e.name).filter(Boolean);
  return { completed, remainingRaw };
}

async function replaySubstituteSatisfiesSlot(fixture) {
  const stateEvent = firstEventOfType(fixture, 'session_state_changed');
  const state = (stateEvent && stateEvent.session_state) || {};
  const AS = await loadActiveSessionModule();

  const { completed, remainingRaw } = buildCanonicalSession(
    AS,
    state.plan_exercise_names,
    state.completed_exercise_names
  );
  const remainingReconciled = AS.reconcileSubstitutedRemaining(completed, remainingRaw);

  return {
    completed,
    remaining_before_reconciliation: remainingRaw,
    remaining_after_reconciliation: remainingReconciled,
  };
}

// ── ADD-5: identity-correction-guard ────────────────────────────────────────
async function replayIdentityCorrectionGuard(fixture) {
  const stateEvent = firstEventOfType(fixture, 'session_state_changed');
  const inputEvent = firstEventOfType(fixture, 'user_input');
  const state = (stateEvent && stateEvent.session_state) || {};

  const h = await buildIdentityCorrectionHarness(state.catalog_options || []);
  h.setSessionLog(state.sessionLog || []);
  h.setSessionCompleted(state.sessionCompleted || []);
  if (state.activePlannedSession) h.setActivePlannedSession(state.activePlannedSession);
  if (state.activeExercise) h.setActiveExercise(state.activeExercise);
  if (state.coachDiscussionSinceLog) h.setCoachDiscussionSinceLog(true);

  const handled = inputEvent ? h.tryApplyIdentityCorrection(inputEvent.user_input) : false;

  return {
    handled,
    session_log_exercises: h.getSessionLog().map(s => s.exercise),
    session_completed: h.getSessionCompleted(),
    events_dispatched: h.getEvents().map(e => e.type),
  };
}

// ── ADD-6: recap-reconciliation ─────────────────────────────────────────────
async function replayRecapReconciliation(fixture) {
  const stateEvent = firstEventOfType(fixture, 'session_state_changed');
  const state = (stateEvent && stateEvent.session_state) || {};
  const AS = await loadActiveSessionModule();

  const { completed, remainingRaw } = buildCanonicalSession(
    AS,
    state.plan_exercise_names,
    state.completed_exercise_names
  );
  const remaining = AS.reconcileSubstitutedRemaining(completed, remainingRaw);

  return { completed, remaining };
}

// ── ADD-7: coach-message-not-blank ──────────────────────────────────────────
let _flightRecorderClient = null;
async function loadFlightRecorderClient() {
  if (!_flightRecorderClient) _flightRecorderClient = await import('../../src/app/flightRecorder.js');
  return _flightRecorderClient;
}

function fakeCoachDoc({ bubbles, heroHidden, hasHero, opening }) {
  return {
    querySelectorAll(sel) {
      if (sel === '.chat-bubble-atlas .coach-msg') return (bubbles || []).map(t => ({ textContent: t }));
      return [];
    },
    getElementById(id) {
      if (id === 'coach-empty') return hasHero !== false ? { hasAttribute: n => n === 'hidden' && !!heroHidden } : null;
      if (id === 'coach-opening') return opening == null ? null : { textContent: opening };
      return null;
    }
  };
}

async function replayCoachMessageNotBlank(fixture) {
  const rendered = firstEventOfType(fixture, 'coach_message_rendered');
  const snapshot = (rendered && rendered.ui_snapshot) || {};
  const client = await loadFlightRecorderClient();

  const doc = fakeCoachDoc({
    bubbles: snapshot.coach_bubbles,
    heroHidden: snapshot.hero_hidden,
    hasHero: snapshot.has_hero,
    opening: snapshot.opening_message,
  });
  const prev = global.document;
  global.document = doc;
  let coachMessage;
  try {
    coachMessage = client.latestCoachMessage();
  } finally {
    if (prev === undefined) delete global.document; else global.document = prev;
  }

  return { coach_message: coachMessage };
}

const ADAPTERS = {
  'restored-session-discard': replayRestoredSessionDiscard,
  'plan-skip': replayPlanSkip,
  'substitute-satisfies-slot': replaySubstituteSatisfiesSlot,
  'identity-correction-guard': replayIdentityCorrectionGuard,
  'recap-reconciliation': replayRecapReconciliation,
  'coach-message-not-blank': replayCoachMessageNotBlank,
};

async function replayFixture(fixture) {
  const adapter = ADAPTERS[fixture.scenario];
  if (!adapter) {
    throw new Error(`flightReplay: no adapter registered for scenario "${fixture.scenario}"`);
  }
  return adapter(fixture);
}

module.exports = { replayFixture, ADAPTERS };
