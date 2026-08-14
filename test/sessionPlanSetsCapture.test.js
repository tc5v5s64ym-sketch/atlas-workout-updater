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
const { confirmTabMissing, classifySheetsReadError } = require('../sheets');

// Google's wording for a range read against an absent tab — and the IDENTICAL wording
// for a malformed A1 range, which is why absence is confirmed against the tab list
// instead of read off the message. A transient backend failure carries an HTTP status
// and no range-parse message.
const rangeParseError = () => new Error('Unable to parse range: Session_Plan_Sets!A1:P1');

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
  // The REAL confirmation bound to this fixture's tab list — never a fixture copy of
  // the absence check, which could stay green while production drifted.
  confirmTabMissing: (e, tab) => confirmTabMissing(e, tab, {
    listTabs: async () => { if (state.readError) throw state.readError; return state.tabs.slice(); },
  }),
  classifySheetsReadError,
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

// The workout authority is Supabase since the S4 cutover, so stubbing sheets.js no
// longer controls the plan-set ledger. sheetsFallback seeds this suite's existing
// fixture into the double, so no test's data changes — only where the store reads it
// from. Re-installed on every reload, because the double resets its rows with it.
const { installWorkoutAuthorityStub, resetWorkoutAuthorityStub, failWorkoutAuthorityWrites } = require('./helpers/stubWorkoutAuthority');
installWorkoutAuthorityStub();
const storePath = require.resolve('../services/sessionPlanSetsStore');
const capturePath = require.resolve('../services/sessionPlanSetsCapture');
function loadCapture({ writeEnabled }) {
  resetWorkoutAuthorityStub();
  delete require.cache[storePath];
  delete require.cache[capturePath];
  if (writeEnabled) process.env.SESSION_PLAN_SETS_WRITE_ENABLED = '1';
  else delete process.env.SESSION_PLAN_SETS_WRITE_ENABLED;
  return require('../services/sessionPlanSetsCapture');
}

const SESSION = { session_id: 'S1', session_date: '2026-07-16', plan_version: 'pv_abc' };
const ITEMS = [{ plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 3, target_weight: 65, target_reps: 5, target_rir: 2 }];

test('the retired flag cannot disable authoritative capture and no sheet is touched', async () => {
  reset();
  const cap = loadCapture({ writeEnabled: false });
  const env = await cap.captureAcceptedPlan(SESSION, ITEMS);
  assert.equal(env.captured, true);
  assert.equal(env.dry_run, false);
  assert.equal(env.status, 'written');
  assert.equal(env.written, 3);
  assert.equal(state.calls, 0, 'authoritative capture never reads or writes Sheets');
});

test('the production modules contain no reader for SESSION_PLAN_SETS_WRITE_ENABLED', () => {
  const fs = require('node:fs');
  assert.doesNotMatch(fs.readFileSync(require.resolve('../services/sessionPlanSetsCapture'), 'utf8'), /process\.env\.SESSION_PLAN_SETS_WRITE_ENABLED/);
  assert.doesNotMatch(fs.readFileSync(require.resolve('../services/sessionPlanSetsStore'), 'utf8'), /process\.env\.SESSION_PLAN_SETS_WRITE_ENABLED/);
});

test('live: a confirmed write reports captured:true with its row count', async () => {
  reset();
  const cap = loadCapture({ writeEnabled: true });
  const env = await cap.captureAcceptedPlan(SESSION, ITEMS);
  assert.equal(env.captured, true);
  assert.equal(env.status, 'written');
  assert.equal(env.written, 3);
  // No range: a range is a Sheets concept, and the checkpoint lands in Supabase.
  assert.equal(env.range == null, true);
});

// ── FOUR HEADER / TAB-ABSENCE TESTS RETIRED WITH THE TAB ─────────────────────
//
// They held one trust-critical line: `tab_missing` is a VERIFIED_EMPTY_SEAL_REASON
// (services/turnWriteArtifact.js), so a Google outage or a malformed range must never
// be reported as an absent tab — otherwise an unverified closeout reads as verified
// while real rows sit unstamped.
//
// The reason that whole class is gone is that the ledger is a Supabase table now. It
// cannot be absent, its columns cannot be reordered under a running process, and no
// Google Sheets failure can reach this path at all. The surviving half of the line —
// an UNREADABLE ledger is never a verified-empty one — is asserted directly against
// the authority in test/sessionPlanSetsStore.test.js, where the read can genuinely
// fail.

// FAIL CLOSED ON AN UNCONFIRMED WRITE, unchanged: the capture claims `captured` only
// when the authority's own row count equals what it asked to write. Only the source
// of that count moved — it was the Sheets append receipt and it is the transaction.
test('live: a row-count mismatch FAILS CLOSED — never a false captured', async () => {
  reset();
  const cap = loadCapture({ writeEnabled: true });
  // The store reports a count that disagrees with the rows it wrote.
  const storeModule = require('../services/sessionPlanSetsStore');
  const real = storeModule.checkpointAcceptedPlan;
  storeModule.checkpointAcceptedPlan = async (...args) => {
    const r = await real.apply(storeModule, args);
    return { ...r, rows_written: r.written - 1 };
  };
  try {
    const env = await cap.captureAcceptedPlan(SESSION, ITEMS);
    assert.equal(env.captured, false, 'no captured claim without authoritative proof');
    assert.equal(env.status, 'unconfirmed');
  } finally {
    storeModule.checkpointAcceptedPlan = real;
  }
});

test('live: a store failure NEVER throws at the call site — it becomes a captured:false envelope', async () => {
  reset();
  const cap = loadCapture({ writeEnabled: true });
  failWorkoutAuthorityWrites('boom');
  const env = await cap.captureAcceptedPlan(SESSION, ITEMS);
  assert.equal(env.captured, false);
  assert.equal(env.status, 'error');
});
