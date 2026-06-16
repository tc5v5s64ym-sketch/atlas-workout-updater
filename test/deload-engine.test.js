const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Stub sheets.js BEFORE requiring the engine (which pulls in services/deloadState).
// The fake mirrors the REAL getSheetRows contract: it strips row 0 as the header
// (sheets.js slice(1)) and returns [] when only the header exists. So tests run
// against the true read behaviour, including the header-row dependency.
const sheetsPath = require.resolve('../sheets');
const HEADER = ['updated_at', 'training_state', 'deload_protocol', 'deload_reason', 'deload_start_date', 'deload_sessions_remaining', 'deload_exit_criteria'];
const fakeSheetsState = { rows: [HEADER], appendCalls: [] };
const fakeSheets = {
  getSheetRows: async () => {
    if (fakeSheetsState.rows.length <= 1) return [];
    return fakeSheetsState.rows.slice(1).map(r => [...r]);
  },
  appendRows: async (tabName, rows) => {
    fakeSheetsState.appendCalls.push({ tabName, rows });
    for (const r of rows) fakeSheetsState.rows.push([...r]);
    return { data: { updates: { updatedRows: rows.length } } };
  }
};
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const {
  buildExposureView, evaluateDeload, evaluateCurrentDeload,
  beginDeload, recordDeloadSession, resolvePostDeload
} = require('../services/deloadEngine');
const { STATES } = require('../services/deloadStateMachine');
const { STRENGTH_DELOAD_V1 } = require('../services/deloadProtocols');
const { ACTIONS } = require('../services/deloadEscalationLadder');

// Log_Cleaned row in array form: date, sid, exercise, canon, muscle, lift, set, weight, reps, rir, notes
const row = (date, sid, lift, set, weight, reps, rir) =>
  [date, sid, lift, lift, 'x', lift, String(set), String(weight), String(reps), String(rir), ''];

beforeEach(() => {
  fakeSheetsState.rows = [HEADER];
  fakeSheetsState.appendCalls = [];
});

/* ======================= adapter ======================= */

test('buildExposureView groups by lift, picks the top set per session, orders oldest→newest', () => {
  const logRows = [
    row('2026-06-01', 'S1', 'BEN01', 1, 225, 5, 2),
    row('2026-06-01', 'S1', 'BEN01', 2, 245, 3, 2), // heavier by e1RM → the session's exposure
    row('2026-06-05', 'S2', 'BEN01', 1, 250, 5, 1),
    row('2026-06-05', 'S2', 'SQ01', 1, 315, 3, 2)
  ];
  const view = buildExposureView(logRows, { focusByLift: { SQ01: 'strength' }, frequency_per_week: 4 });

  const bench = view.lifts.find(l => l.lift_code === 'BEN01');
  assert.deepEqual(bench.exposures, [
    { weight: 245, reps: 3, rir: 2 }, // S1 top set (245×3 > 225×5 by e1RM)
    { weight: 250, reps: 5, rir: 1 }
  ]);
  assert.equal(bench.focus, 'strength'); // default focus
  assert.equal(view.frequency_per_week, 4);
});

test('buildExposureView estimates frequency from the session date span when not given', () => {
  // 4 sessions across 21 days ≈ 3 weeks → ~1.3/week.
  const logRows = [
    row('2026-06-01', 'A', 'BEN01', 1, 200, 5, 2),
    row('2026-06-08', 'B', 'BEN01', 1, 200, 5, 2),
    row('2026-06-15', 'C', 'BEN01', 1, 200, 5, 2),
    row('2026-06-22', 'D', 'BEN01', 1, 200, 5, 2)
  ];
  const view = buildExposureView(logRows);
  assert.ok(view.frequency_per_week > 1 && view.frequency_per_week < 2);
});

/* ======================= decision (pure) ======================= */

test('an active deload holds the protocol and does not evaluate a new one', () => {
  const out = evaluateDeload({
    logRows: [row('2026-06-10', 'S', 'BEN01', 1, 225, 5, 0)],
    currentState: { training_state: STATES.DELOAD_ACTIVE, deload_protocol: 'STRENGTH_DELOAD_V1', deload_sessions_remaining: 1 }
  });
  assert.equal(out.in_deload, true);
  assert.equal(out.action, 'CONTINUE_DELOAD');
  assert.equal(out.protocol_id, 'STRENGTH_DELOAD_V1');
  assert.equal(out.protocol, STRENGTH_DELOAD_V1); // both keys always populated
  assert.equal(out.sessions_remaining, 1);
  assert.equal(out.score, undefined); // never re-scored while active
});

test('a healthy lifter (rising reps at fixed weight) gets normal coaching, score 0', () => {
  const out = evaluateDeload({
    frequency_per_week: 5,
    logRows: [
      row('2026-06-01', 'S1', 'BEN01', 1, 225, 5, 2),
      row('2026-06-03', 'S2', 'BEN01', 1, 225, 6, 2),
      row('2026-06-05', 'S3', 'BEN01', 1, 225, 7, 2)
    ]
  });
  assert.equal(out.in_deload, false);
  assert.equal(out.score, 0);
  assert.equal(out.action, ACTIONS.NORMAL_COACHING);
  assert.equal(out.suggested_state, STATES.NORMAL);
  assert.equal(out.protocol, null);
  assert.equal(out.protocol_id, null); // both keys present, both null off-deload
  assert.equal(out.sessions_remaining, null);
});

test('stacked fatigue across two lifts + recovery + exposure offers a deload with a protocol', () => {
  // BEN01: stalls (A) and regresses 5.56% (B). SQ01: stalls. Two stalled lifts → D.
  // Three recovery reports → E. Fatigue exposure maxed → F. Score = 87 (offer band).
  const logRows = [
    row('2026-06-01', 'B1', 'BEN01', 1, 225, 6, 2),
    row('2026-06-03', 'B2', 'BEN01', 1, 225, 5, 2),
    row('2026-06-05', 'B3', 'BEN01', 1, 225, 4, 2),
    row('2026-06-07', 'B4', 'BEN01', 1, 225, 4, 2),
    row('2026-06-01', 'Q1', 'SQ01', 1, 315, 5, 2),
    row('2026-06-03', 'Q2', 'SQ01', 1, 315, 5, 2),
    row('2026-06-05', 'Q3', 'SQ01', 1, 315, 5, 2),
    row('2026-06-07', 'Q4', 'SQ01', 1, 315, 5, 2)
  ];
  const out = evaluateDeload({
    frequency_per_week: 5,
    logRows,
    recovery_reports: ['beat up', 'exhausted', 'sore'],
    fatigue_exposure: { hard_sets: 25, failure_sets: 6, block_length_sessions: 10 }
  });
  assert.equal(out.score, 87);
  assert.equal(out.action, ACTIONS.OFFER_DELOAD);
  assert.equal(out.suggested_state, STATES.DELOAD_RECOMMENDED);
  assert.equal(out.protocol, STRENGTH_DELOAD_V1); // dominant focus defaults to strength
  assert.equal(out.protocol_id, 'STRENGTH_DELOAD_V1');
});

/* ======================= lifecycle (persisted) ======================= */

test('beginDeload from NORMAL appends an active deload and reads back as current', async () => {
  const record = await beginDeload({
    protocol: STRENGTH_DELOAD_V1, reason: 'owner invoked', sessions_remaining: 1,
    currentState: { training_state: STATES.NORMAL }
  });
  assert.equal(record.training_state, STATES.DELOAD_ACTIVE);
  assert.equal(record.deload_protocol, 'STRENGTH_DELOAD_V1');
  assert.equal(fakeSheetsState.appendCalls[0].tabName, 'Deload_State');

  const current = await evaluateCurrentDeload({});
  assert.equal(current.in_deload, true);
  assert.equal(current.protocol_id, 'STRENGTH_DELOAD_V1');
});

test('beginDeload from POST_DELOAD_EVALUATION is rejected (illegal transition, nothing written)', async () => {
  await assert.rejects(
    () => beginDeload({ protocol: STRENGTH_DELOAD_V1, currentState: { training_state: STATES.POST_DELOAD_EVALUATION } }),
    /Illegal training-state transition: POST_DELOAD_EVALUATION → DELOAD_ACTIVE/
  );
  assert.equal(fakeSheetsState.appendCalls.length, 0);
});

test('recordDeloadSession decrements while sessions remain, then moves to POST_DELOAD_EVALUATION', async () => {
  const stillActive = await recordDeloadSession({
    currentState: { training_state: STATES.DELOAD_ACTIVE, deload_protocol: 'STRENGTH_DELOAD_V1', deload_sessions_remaining: 2 }
  });
  assert.equal(stillActive.training_state, STATES.DELOAD_ACTIVE); // stays active (no self-edge needed)
  assert.equal(stillActive.deload_sessions_remaining, 1);

  const done = await recordDeloadSession({
    currentState: { training_state: STATES.DELOAD_ACTIVE, deload_protocol: 'STRENGTH_DELOAD_V1', deload_sessions_remaining: 1 }
  });
  assert.equal(done.training_state, STATES.POST_DELOAD_EVALUATION);
  assert.equal(done.deload_sessions_remaining, 0);
});

test('recordDeloadSession outside an active deload throws', async () => {
  await assert.rejects(
    () => recordDeloadSession({ currentState: { training_state: STATES.NORMAL } }),
    /not in a deload/
  );
});

test('resolvePostDeload returns to NORMAL, and rejects from any other state', async () => {
  const back = await resolvePostDeload({ currentState: { training_state: STATES.POST_DELOAD_EVALUATION } });
  assert.equal(back.training_state, STATES.NORMAL);

  await assert.rejects(
    () => resolvePostDeload({ currentState: { training_state: STATES.DELOAD_ACTIVE } }),
    /not in POST_DELOAD_EVALUATION/
  );
});

/* ======================= read-contract fidelity ======================= */

test('a full begin → record → resolve cycle round-trips through the header-stripping read', async () => {
  await beginDeload({ protocol: STRENGTH_DELOAD_V1, sessions_remaining: 1, currentState: { training_state: STATES.NORMAL } });
  let cur = await evaluateCurrentDeload({});
  assert.equal(cur.in_deload, true);

  // Complete the single session → POST_DELOAD_EVALUATION (read from the sheet).
  await recordDeloadSession({});
  cur = await evaluateCurrentDeload({});
  assert.equal(cur.in_deload, false);
  assert.equal(cur.training_state, STATES.POST_DELOAD_EVALUATION);

  // Resolve back to NORMAL.
  await resolvePostDeload({});
  cur = await evaluateCurrentDeload({});
  assert.equal(cur.training_state, STATES.NORMAL);
});
