const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// SUPABASE IS THE AUTHORITY (OWNER CORRECTION 2026-08-13), so the store under test
// is the workout-authority double rather than a fake `sheets.js`. Deload state is an
// input to a PRESCRIPTION — `/api/recommend/next` and the state assembler both read
// it — and the owner ruled that no prescription input may be a synchronous Google
// Sheets dependency.
const {
  installWorkoutAuthorityStub, resetWorkoutAuthorityStub, workoutAuthorityStore,
  failWorkoutAuthorityReads,
} = require('./helpers/stubWorkoutAuthority');
installWorkoutAuthorityStub();

const {
  DELOAD_STATE_TAB, defaultDeloadState, rowToState, stateToRow,
  readCurrentDeloadState, appendDeloadState
} = require('../services/deloadState');
const { STATES } = require('../services/deloadStateMachine');
const { deloadStateColumns } = require('../config/columns');

// The appends this suite observes, in the authority rather than in a Sheets fake.
const appendCalls = () => workoutAuthorityStore().calls.deloadState;

beforeEach(() => {
  resetWorkoutAuthorityStub();
});

// THE HEADER-PROVISIONING TEST RETIRED WITH THE TAB. It proved that the first state
// ever written was not swallowed as a header row, which was a real hazard: the read
// path stripped row 0, so a tab with no header lost its first record and the lifter
// read back as NORMAL while mid-deload. A table has columns, so there is no row 0 to
// mistake for a header and nothing to provision.
test('the first state ever written reads back — nothing is swallowed', async () => {
  await appendDeloadState({ training_state: STATES.DELOAD_ACTIVE, deload_protocol: 'STRENGTH_DELOAD_V1' });
  assert.equal(appendCalls().length, 1, 'one append, and no header row alongside it');
  const state = await readCurrentDeloadState();
  assert.equal(state.training_state, STATES.DELOAD_ACTIVE);
});

/* ===== default state ===== */

test('an empty store reads as the default NORMAL state', async () => {
  const state = await readCurrentDeloadState();
  assert.equal(state.training_state, STATES.NORMAL);
  assert.equal(state.deload_protocol, null);
  assert.equal(state.deload_sessions_remaining, 0);
  assert.equal(DELOAD_STATE_TAB, 'Deload_State', 'the concept keeps its name');
});

// ── AN UNREADABLE AUTHORITY IS NOT "NO DELOAD" ───────────────────────────────
//
// This test previously asserted the OPPOSITE: a read failure degraded to NORMAL,
// which was defensible while the store was an optional Google Sheets tab where
// absent and unreadable were genuinely hard to tell apart.
//
// OWNER CORRECTION 2026-08-13 rejected that for the migrated authority. The two
// cases are now perfectly distinguishable — a successful read returning no rows
// means the lifter has never deloaded, a failed read means Atlas DOES NOT KNOW —
// and answering NORMAL on "do not know" silently discards an ACTIVE deload and
// prescribes the athlete's full working load into a week the engine had cut.
test('an UNREADABLE authority throws — it is never reported as NORMAL', async () => {
  failWorkoutAuthorityReads('deload state unreadable');
  await assert.rejects(() => readCurrentDeloadState(), /unreadable/);
});

test('an empty SUCCESSFUL read still defaults — absence and failure stay distinct', async () => {
  const state = await readCurrentDeloadState();
  assert.equal(state.training_state, STATES.NORMAL,
    'no rows is a real answer: this lifter has never deloaded');
});

test('defaultDeloadState returns a fresh object each call (no shared mutation)', () => {
  const a = defaultDeloadState();
  a.training_state = STATES.DELOAD_ACTIVE;
  assert.equal(defaultDeloadState().training_state, STATES.NORMAL);
});

/* ===== read current = last row ===== */

test('readCurrentDeloadState returns the LAST appended row', async () => {
  await appendDeloadState({ training_state: STATES.RECOVERY_CANDIDATE, deload_reason: 'fatigue rising' });
  await appendDeloadState({
    training_state: STATES.DELOAD_ACTIVE,
    deload_protocol: 'STRENGTH_DELOAD_V1',
    deload_sessions_remaining: 1
  });
  const state = await readCurrentDeloadState();
  assert.equal(state.training_state, STATES.DELOAD_ACTIVE);
  assert.equal(state.deload_protocol, 'STRENGTH_DELOAD_V1');
  assert.equal(state.deload_sessions_remaining, 1);
});

/* ===== append writes to the right tab, in column order, with a timestamp ===== */

test('appendDeloadState writes the record in column order and stamps updated_at', async () => {
  const record = await appendDeloadState({
    training_state: STATES.DELOAD_ACTIVE,
    deload_protocol: 'POWER_DELOAD_V1',
    deload_reason: 'grinding RIR for weeks',
    deload_start_date: '2026-06-16',
    deload_sessions_remaining: 1,
    deload_exit_criteria: 'return to working weight next session'
  });

  assert.equal(appendCalls().length, 1);
  const row = appendCalls()[0];
  assert.equal(row.length, deloadStateColumns.length);

  // updated_at stamped (ISO) and lands in the first column.
  assert.ok(record.updated_at && !Number.isNaN(Date.parse(record.updated_at)));
  assert.equal(row[deloadStateColumns.indexOf('updated_at')], record.updated_at);
  assert.equal(row[deloadStateColumns.indexOf('training_state')], STATES.DELOAD_ACTIVE);
  assert.equal(row[deloadStateColumns.indexOf('deload_protocol')], 'POWER_DELOAD_V1');
});

test('a caller-supplied updated_at is preserved, not overwritten', async () => {
  const ts = '2026-06-01T00:00:00.000Z';
  const record = await appendDeloadState({ training_state: STATES.NORMAL, updated_at: ts });
  assert.equal(record.updated_at, ts);
});

/* ===== validation: never persist an unknown state ===== */

test('appendDeloadState throws on an unknown training_state', async () => {
  await assert.rejects(
    () => appendDeloadState({ training_state: 'SLEEPING' }),
    /Cannot persist unknown training_state/
  );
  await assert.rejects(() => appendDeloadState({}), /Cannot persist unknown training_state/);
  assert.equal(appendCalls().length, 0); // nothing written on a bad state
});

/* ===== row <-> state normalization ===== */

test('rowToState maps columns, coerces sessions_remaining, and guards bad state', () => {
  const row = ['2026-06-16T00:00:00Z', STATES.DELOAD_ACTIVE, 'STRENGTH_DELOAD_V1', 'reason', '2026-06-16', '2', 'exit'];
  const s = rowToState(row);
  assert.equal(s.training_state, STATES.DELOAD_ACTIVE);
  assert.equal(s.deload_sessions_remaining, 2); // numeric, not the string '2'

  // Empty cells → null; unknown state → NORMAL; non-numeric sessions → 0.
  const sparse = rowToState(['', 'WAT', '', '', '', 'n/a', '']);
  assert.equal(sparse.training_state, STATES.NORMAL);
  assert.equal(sparse.deload_protocol, null);
  assert.equal(sparse.deload_sessions_remaining, 0);
});

test('stateToRow renders null/missing fields as empty cells in column order', () => {
  const row = stateToRow({ training_state: STATES.NORMAL });
  assert.equal(row.length, deloadStateColumns.length);
  assert.equal(row[deloadStateColumns.indexOf('training_state')], STATES.NORMAL);
  assert.equal(row[deloadStateColumns.indexOf('deload_protocol')], ''); // missing → ''
});

test('state survives a stateToRow → rowToState round trip', () => {
  const original = {
    updated_at: '2026-06-16T12:00:00.000Z',
    training_state: STATES.DELOAD_ACTIVE,
    deload_protocol: 'HYPERTROPHY_DELOAD_V1',
    deload_reason: 'multi-lift stall',
    deload_start_date: '2026-06-16',
    deload_sessions_remaining: 1,
    deload_exit_criteria: 'one session then re-evaluate'
  };
  assert.deepEqual(rowToState(stateToRow(original)), original);
});
