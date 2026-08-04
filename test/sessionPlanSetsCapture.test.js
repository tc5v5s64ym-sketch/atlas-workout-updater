'use strict';

// F10B — Session_Plan_Sets capture layer (failure-isolated envelope over the F10A
// checkpoint store). Pins: DRY-RUN by default returns captured:false/dry_run:true and
// touches no sheet; the LIVE path (owner-enabled at F10D) validates the exact header,
// writes idempotently, and NEVER throws at the call site (a revision collision / bad
// header / missing tab all become a captured:false envelope, never a rejection).

const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionPlanSetsColumns } = require('../config/columns');

// The REAL classifier, captured before the fake replaces the module — the fixture
// must never carry a second copy of it (see test/sessionPlanCapture.test.js).
const { isTabMissingError, classifySheetsReadError } = require('../sheets');

// Google's actual wording for a range read against an absent tab, vs a transient
// backend failure, which carries an HTTP status and no range-parse message.
const rangeParseError = () => new Error('Unable to parse range: Session_Plan_Sets!A1:P1');
const transientError = () => Object.assign(new Error('Backend Error'), { status: 503 });

const state = { tabs: ['Session_Plan_Sets'], rows: [], header: [[...sessionPlanSetsColumns]], calls: 0, appendThrows: null, appendShort: false, readError: null };
function reset(over = {}) {
  state.tabs = over.tabs || ['Session_Plan_Sets'];
  state.rows = over.rows ? over.rows.slice() : [];
  state.header = 'header' in over ? over.header : [[...sessionPlanSetsColumns]];
  state.calls = 0; state.appendThrows = over.appendThrows || null; state.appendShort = over.appendShort || false;
  state.readError = over.readError || null;
}
const fakeSheets = {
  getSpreadsheetTabs: async () => { state.calls += 1; if (state.readError) throw state.readError; return state.tabs.slice(); },
  getSheetRows: async (tab) => { state.calls += 1; if (state.readError) throw state.readError; if (!state.tabs.includes(tab)) throw rangeParseError(); return state.rows.slice(); },
  appendRows: async (tab, rows) => {
    state.calls += 1;
    if (state.appendThrows) throw new Error(state.appendThrows);
    if (state.tabs.includes(tab)) state.rows.push(...rows);
    // appendShort models a malformed / short Google response (no range, wrong count).
    if (state.appendShort) return { data: { updates: { updatedRange: null, updatedRows: 0 } } };
    return { data: { updates: { updatedRange: `${tab}!A2:P4`, updatedRows: rows.length } } };
  },
  readRange: async () => {
    state.calls += 1;
    if (state.readError) throw state.readError;
    if (!state.tabs.includes('Session_Plan_Sets')) throw rangeParseError();
    return state.header;
  },
  isTabMissingError,
  classifySheetsReadError,
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const storePath = require.resolve('../services/sessionPlanSetsStore');
const capturePath = require.resolve('../services/sessionPlanSetsCapture');
function loadCapture({ writeEnabled }) {
  delete require.cache[storePath];
  delete require.cache[capturePath];
  if (writeEnabled) process.env.SESSION_PLAN_SETS_WRITE_ENABLED = '1';
  else delete process.env.SESSION_PLAN_SETS_WRITE_ENABLED;
  return require('../services/sessionPlanSetsCapture');
}

const SESSION = { session_id: 'S1', session_date: '2026-07-16', plan_version: 'pv_abc' };
const ITEMS = [{ plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 3, target_weight: 65, target_reps: 5, target_rir: 2 }];

test('dry-run default: captured:false / dry_run:true and no sheet access', async () => {
  reset();
  const cap = loadCapture({ writeEnabled: false });
  const env = await cap.captureAcceptedPlan(SESSION, ITEMS);
  assert.equal(env.captured, false);
  assert.equal(env.dry_run, true);
  assert.equal(env.status, 'dry_run');
  assert.equal(state.calls, 0, 'a dry-run never reads or writes the sheet');
});

test('live: a valid header + append reports captured:true with the extracted range', async () => {
  reset();
  const cap = loadCapture({ writeEnabled: true });
  const env = await cap.captureAcceptedPlan(SESSION, ITEMS);
  assert.equal(env.captured, true);
  assert.equal(env.status, 'written');
  assert.equal(env.written, 3);
  assert.match(env.range, /^Session_Plan_Sets!/);
});

test('live: a mismatched header disables the write (header_mismatch), never guesses', async () => {
  reset({ header: [['idempotency_key', 'WRONG']] });
  const cap = loadCapture({ writeEnabled: true });
  const env = await cap.captureAcceptedPlan(SESSION, ITEMS);
  assert.equal(env.captured, false);
  assert.equal(env.status, 'header_mismatch');
});

test('live: a missing tab is tab_missing (owner creates it), no write', async () => {
  reset({ tabs: [] });
  const cap = loadCapture({ writeEnabled: true });
  const env = await cap.captureAcceptedPlan(SESSION, ITEMS);
  assert.equal(env.captured, false);
  assert.equal(env.status, 'tab_missing');
});

// BITE — the trust-critical half of the distinction above. `tab_missing` is a member
// of VERIFIED_EMPTY_SEAL_REASONS (services/turnWriteArtifact.js): it is one of only
// two reasons that let a closeout be read as a VERIFIED-empty ledger. So reporting a
// momentary Google outage as `tab_missing` does not merely mislabel a diagnostic — it
// can present an unverified closeout as verified while real rows sit unstamped.
// Reverting validateHeader to a blanket `tab_missing` fails this test.
test('live: a TRANSIENT read failure is error, NEVER tab_missing (it must not read as a verified-empty ledger)', async () => {
  reset({ readError: transientError() });
  const cap = loadCapture({ writeEnabled: true });
  const env = await cap.captureAcceptedPlan(SESSION, ITEMS);
  assert.equal(env.captured, false);
  assert.equal(env.status, 'error');
  assert.notEqual(env.status, 'tab_missing', 'a 503 is not evidence the ledger tab is absent');
});

test('live: an unconfirmed append (no range / short row count) FAILS CLOSED — never a false captured', async () => {
  reset({ appendShort: true });
  const cap = loadCapture({ writeEnabled: true });
  const env = await cap.captureAcceptedPlan(SESSION, ITEMS);
  assert.equal(env.captured, false, 'no captured claim without authoritative Sheets proof');
  assert.equal(env.status, 'unconfirmed');
});

test('live: a store failure NEVER throws at the call site — it becomes a captured:false envelope', async () => {
  reset({ appendThrows: 'boom' });
  const cap = loadCapture({ writeEnabled: true });
  const env = await cap.captureAcceptedPlan(SESSION, ITEMS);
  assert.equal(env.captured, false);
  assert.equal(env.status, 'error');
});
