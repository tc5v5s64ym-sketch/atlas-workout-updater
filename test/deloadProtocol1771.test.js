const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Stub sheets.js BEFORE requiring the modules under test, so no real Google Sheets
// call can ever happen (mirrors the require.cache injection in
// deload-state.test.js). confirmTabMissing is stubbed too, with a controllable
// answer, so the read-error matrix can drive both branches of the missing-tab
// proof without a live spreadsheet.
const sheetsPath = require.resolve('../sheets');
const HEADER = ['updated_at', 'training_state', 'deload_protocol', 'deload_reason', 'deload_start_date', 'deload_sessions_remaining', 'deload_exit_criteria'];
const fakeSheetsState = {
  rows: [HEADER],
  appendCalls: [],
  readError: null,            // when set, getSheetRows throws this
  confirmMissing: false,      // answer for confirmTabMissing
  confirmThrows: false        // when set, confirmTabMissing throws
};
const fakeSheets = {
  getSheetRows: async () => {
    if (fakeSheetsState.readError) throw fakeSheetsState.readError;
    if (fakeSheetsState.rows.length <= 1) return [];
    return fakeSheetsState.rows.slice(1).map(r => [...r]);
  },
  readRange: async () => (fakeSheetsState.rows.length ? [fakeSheetsState.rows[0]] : []),
  appendRows: async (tabName, rows) => {
    fakeSheetsState.appendCalls.push({ tabName, rows });
    for (const r of rows) fakeSheetsState.rows.push([...r]);
    return { data: { updates: { updatedRows: rows.length } } };
  },
  confirmTabMissing: async () => {
    if (fakeSheetsState.confirmThrows) throw new Error('metadata read failed');
    return fakeSheetsState.confirmMissing;
  }
};
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const {
  evaluateDeload, evaluateCurrentDeload,
  beginDeload, recordDeloadSession, resolvePostDeload
} = require('../services/deloadEngine');
const { rowToState, readCurrentDeloadState, appendDeloadState } = require('../services/deloadState');
const { STATES } = require('../services/deloadStateMachine');
const { STRENGTH_DELOAD_V1, computePrescription, isRecognizedProtocol } = require('../services/deloadProtocols');

beforeEach(() => {
  fakeSheetsState.rows = [HEADER];
  fakeSheetsState.appendCalls = [];
  fakeSheetsState.readError = null;
  fakeSheetsState.confirmMissing = false;
  fakeSheetsState.confirmThrows = false;
});

// C-02 (#1771): an active deload with an invalid protocol must FAIL CLOSED —
// never evaluate as if NORMAL and never emit { in_deload: true, protocol: null },
// which every consumer reads as "no deload" and fills with the full-load
// prescription (audit: protocol emptied -> target 185 lb RIR 3). Probe text
// re-expressed from the issue; the audit record lives with the coordinator.
const BAD_PROTOCOLS = [
  ['', 'empty'],
  ['strength_deload_v1', 'lowercase'],
  ['STRENGTH_DELOAD_V2', 'typo'],
  ['123', 'numeric string'],
  [123, 'number'],
  ['{"id":"STRENGTH_DELOAD_V1"}', 'JSON-shaped'],
  [null, 'null'],
  [undefined, 'missing']
];

for (const [bad, label] of BAD_PROTOCOLS) {
  test(`evaluateDeload throws on an active deload with a ${label} protocol (C-02)`, () => {
    assert.throws(
      () => evaluateDeload({ currentState: { training_state: STATES.DELOAD_ACTIVE, deload_protocol: bad, deload_sessions_remaining: 1 } }),
      /deload_protocol/
    );
  });
}

test('evaluateDeload holds a recognized protocol on an active deload, and the prescription is the deload cut (control)', () => {
  const out = evaluateDeload({
    currentState: { training_state: STATES.DELOAD_ACTIVE, deload_protocol: 'STRENGTH_DELOAD_V1', deload_sessions_remaining: 1 }
  });
  assert.equal(out.in_deload, true);
  assert.equal(out.protocol, STRENGTH_DELOAD_V1);
  // The audit's valid case: 185 lb working weight under STRENGTH_DELOAD_V1
  // (0.92x, RIR 5) prescribes 170 lb RIR 5 — never the full 185 / RIR 3.
  const pr = computePrescription(out.protocol, { working_weight: 185 });
  assert.equal(pr.weight, 170);
  assert.equal(pr.target_rir, 5);
});

test('isRecognizedProtocol accepts exactly the frozen protocol ids', () => {
  assert.equal(isRecognizedProtocol('STRENGTH_DELOAD_V1'), true);
  assert.equal(isRecognizedProtocol('HYPERTROPHY_DELOAD_V1'), true);
  assert.equal(isRecognizedProtocol('POWER_DELOAD_V1'), true);
  assert.equal(isRecognizedProtocol('ENDURANCE_DELOAD_V1'), true);
  for (const [bad] of BAD_PROTOCOLS) assert.equal(isRecognizedProtocol(bad), false);
  assert.equal(isRecognizedProtocol('toString'), false); // inherited, never a protocol
});

for (const [bad, label] of BAD_PROTOCOLS) {
  test(`rowToState throws on an active row with a ${label} protocol (C-02)`, () => {
    assert.throws(
      () => rowToState(['2026-06-16T00:00:00Z', STATES.DELOAD_ACTIVE, bad, '', '2026-06-16', '1', '']),
      /deload_protocol/
    );
  });
}

test('rowToState throws on a non-active row carrying an unrecognized protocol (C-02)', () => {
  assert.throws(
    () => rowToState(['2026-06-16T00:00:00Z', STATES.POST_DELOAD_EVALUATION, 'strength_deload_v1', '', '2026-06-16', '0', '']),
    /deload_protocol/
  );
});

test('evaluateCurrentDeload rejects when the persisted last row has a garbage protocol (C-02)', async () => {
  await beginDeload({ protocol: STRENGTH_DELOAD_V1, sessions_remaining: 2, currentState: { training_state: STATES.NORMAL } });
  const last = fakeSheetsState.rows[fakeSheetsState.rows.length - 1];
  last[HEADER.indexOf('deload_protocol')] = 'STRENGTH_DELOAD_V2';
  await assert.rejects(() => evaluateCurrentDeload({}), /deload_protocol/);
});

test('beginDeload rejects a garbage protocol and writes nothing (C-02)', async () => {
  await assert.rejects(
    () => beginDeload({ protocol: 'strength_deload_v1', currentState: { training_state: STATES.NORMAL } }),
    /deload_protocol/
  );
  await assert.rejects(
    () => beginDeload({ currentState: { training_state: STATES.NORMAL } }),
    /deload_protocol/
  );
  assert.equal(fakeSheetsState.appendCalls.length, 0);
});

test('appendDeloadState refuses to persist an active state with an unrecognized protocol (C-02)', async () => {
  await assert.rejects(
    () => appendDeloadState({ training_state: STATES.DELOAD_ACTIVE, deload_protocol: 'STRENGTH_DELOAD_V2' }),
    /deload_protocol/
  );
  await assert.rejects(
    () => appendDeloadState({ training_state: STATES.DELOAD_ACTIVE }),
    /deload_protocol/
  );
  assert.equal(fakeSheetsState.appendCalls.length, 0); // nothing written on a bad protocol
});

test('recordDeloadSession rejects when the current state carries a garbage protocol (C-02)', async () => {
  await assert.rejects(
    () => recordDeloadSession({
      currentState: { training_state: STATES.DELOAD_ACTIVE, deload_protocol: '123', deload_sessions_remaining: 1 }
    }),
    /deload_protocol/
  );
  assert.equal(fakeSheetsState.appendCalls.length, 0);
});

test('resolvePostDeload rejects when the row carries a garbage protocol (C-02)', async () => {
  await assert.rejects(
    () => resolvePostDeload({
      currentState: { training_state: STATES.POST_DELOAD_EVALUATION, deload_protocol: '{"id":"STRENGTH_DELOAD_V1"}' }
    }),
    /deload_protocol/
  );
  assert.equal(fakeSheetsState.appendCalls.length, 0);
});

/* ======================= counter matrix ======================= */

// C-02 acceptance: the counter matrix. A sessions_remaining cell that is not a
// finite non-negative integer is damaged persisted data — reading it as 0 would
// end the deload after one session and restore full load early. Fail closed.
for (const [raw, label] of [['n/a', 'non-numeric'], ['-1', 'negative'], ['1.5', 'fractional']]) {
  test(`rowToState throws on a ${label} sessions_remaining cell (C-02)`, () => {
    assert.throws(
      () => rowToState(['2026-06-16T00:00:00Z', STATES.DELOAD_ACTIVE, 'STRENGTH_DELOAD_V1', '', '2026-06-16', raw, '']),
      /deload_sessions_remaining/
    );
  });
}

test('rowToState still reads a valid counter, and an empty counter reads as 0 (control)', () => {
  assert.equal(rowToState(['2026-06-16T00:00:00Z', STATES.DELOAD_ACTIVE, 'STRENGTH_DELOAD_V1', '', '2026-06-16', '2', '']).deload_sessions_remaining, 2);
  assert.equal(rowToState(['2026-06-16T00:00:00Z', STATES.NORMAL, '', '', '', '', '']).deload_sessions_remaining, 0);
  // A padded protocol cell trims to a recognized id (cell() trims); a
  // definite integer in another spelling ('2.0') reads as that integer.
  assert.equal(rowToState(['2026-06-16T00:00:00Z', STATES.DELOAD_ACTIVE, ' STRENGTH_DELOAD_V1 ', '', '2026-06-16', '2.0', '']).deload_protocol, 'STRENGTH_DELOAD_V1');
  assert.equal(rowToState(['2026-06-16T00:00:00Z', STATES.DELOAD_ACTIVE, 'STRENGTH_DELOAD_V1', '', '2026-06-16', '2.0', '']).deload_sessions_remaining, 2);
});

/* ======================= variant sweep (beyond the listed set) ======================= */

// Fresh variants against the fix's general rule: anything that is not exactly
// a frozen protocol id, or not a definite non-negative integer counter, fails
// closed — including shapes the issue does not list.
test('variant: a padded protocol is refused in-memory (no trim outside the sheet read)', () => {
  assert.throws(
    () => evaluateDeload({ currentState: { training_state: STATES.DELOAD_ACTIVE, deload_protocol: ' STRENGTH_DELOAD_V1 ', deload_sessions_remaining: 1 } }),
    /deload_protocol/
  );
});

test('variant: a protocol array or String object is refused', () => {
  assert.throws(
    () => evaluateDeload({ currentState: { training_state: STATES.DELOAD_ACTIVE, deload_protocol: ['STRENGTH_DELOAD_V1'], deload_sessions_remaining: 1 } }),
    /deload_protocol/
  );
  assert.throws(
    () => evaluateDeload({ currentState: { training_state: STATES.DELOAD_ACTIVE, deload_protocol: new String('STRENGTH_DELOAD_V1'), deload_sessions_remaining: 1 } }),
    /deload_protocol/
  );
});

test('variant: an Infinity counter cell is refused', () => {
  assert.throws(
    () => rowToState(['2026-06-16T00:00:00Z', STATES.DELOAD_ACTIVE, 'STRENGTH_DELOAD_V1', '', '2026-06-16', 'Infinity', '']),
    /deload_sessions_remaining/
  );
});

test('variant: beginDeload refuses a protocol object with a garbage id, or a numeric protocol', async () => {
  await assert.rejects(
    () => beginDeload({ protocol: { id: 'typo' }, currentState: { training_state: STATES.NORMAL } }),
    /deload_protocol/
  );
  await assert.rejects(
    () => beginDeload({ protocol: 123, currentState: { training_state: STATES.NORMAL } }),
    /deload_protocol/
  );
  assert.equal(fakeSheetsState.appendCalls.length, 0);
});

test('appendDeloadState refuses a non-integer sessions_remaining (C-02)', async () => {
  await assert.rejects(
    () => appendDeloadState({ training_state: STATES.DELOAD_ACTIVE, deload_protocol: 'STRENGTH_DELOAD_V1', deload_sessions_remaining: 'n/a' }),
    /deload_sessions_remaining/
  );
  await assert.rejects(
    () => appendDeloadState({ training_state: STATES.DELOAD_ACTIVE, deload_protocol: 'STRENGTH_DELOAD_V1', deload_sessions_remaining: -1 }),
    /deload_sessions_remaining/
  );
  assert.equal(fakeSheetsState.appendCalls.length, 0);
});

/* ======================= read-error matrix ======================= */

// C-02 acceptance: the read-error matrix. A Deload_State read failure is
// unreadable state — it can never authorize a NORMAL read. Only a tab
// CONFIRMED missing (via metadata, never inferred from wording) reads as
// "never deloaded". Probe text re-expressed from the issue.
test('readCurrentDeloadState rejects on a read error the tab check cannot confirm missing (C-02)', async () => {
  fakeSheetsState.readError = new Error('sheets 500');
  fakeSheetsState.confirmMissing = false;
  await assert.rejects(() => readCurrentDeloadState(), /sheets 500/);
});

test('readCurrentDeloadState rejects on a range error for a tab that exists (C-02)', async () => {
  fakeSheetsState.readError = new Error('Unable to parse range: Deload_State!A:Z');
  fakeSheetsState.confirmMissing = false; // tab IS in the metadata
  await assert.rejects(() => readCurrentDeloadState(), /Unable to parse range/);
});

test('readCurrentDeloadState rejects when the missing-tab confirmation itself fails (C-02)', async () => {
  fakeSheetsState.readError = new Error('Unable to parse range: Deload_State!A:Z');
  fakeSheetsState.confirmThrows = true; // metadata unreadable: no proof of absence
  // Fail closed: the metadata error escapes (the original read error is not
  // silently converted to NORMAL either way).
  await assert.rejects(() => readCurrentDeloadState(), /metadata read failed/);
});

test('readCurrentDeloadState still reads NORMAL when the tab is confirmed missing (control)', async () => {
  fakeSheetsState.readError = new Error('Unable to parse range: Deload_State!A:Z');
  fakeSheetsState.confirmMissing = true;
  const state = await readCurrentDeloadState();
  assert.equal(state.training_state, STATES.NORMAL);
  assert.equal(state.deload_protocol, null);
});

test('evaluateCurrentDeload rejects when the state read fails unconfirmed (C-02)', async () => {
  fakeSheetsState.readError = new Error('sheets 500');
  fakeSheetsState.confirmMissing = false;
  await assert.rejects(() => evaluateCurrentDeload({}), /sheets 500/);
});
