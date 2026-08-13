'use strict';

// Session_Plans capture layer (PR-E) — the flag gate + exact-header validation +
// failure-isolated envelope over the existing idempotent writer. A fake sheets
// module is injected (require.cache) so no real Sheets I/O runs. Pins the owner's
// PR-E requirements: flag default OFF ⇒ zero Sheets access; exact valid header
// permits the sidecar; missing tab / wrong header order fail safely (no write);
// accept/outcome/closeout append via the existing builders; retry idempotency;
// revision collision fails closed; a writer failure returns a captured:false
// envelope and NEVER throws (main-save isolation); only Session_Plans is written;
// recorded_at is stamped non-empty.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionPlansColumns } = require('../config/columns');

// ── fake sheets (stateful; reset per test) ────────────────────────────────────
// The REAL read-failure classifier, loaded before the fake replaces the module. The
// fake must never carry its own copy: a second classifier in the test fixture would
// let the production one drift while these tests stayed green, which is the exact
// authority defect this layer was fixed to remove.
const { confirmTabMissing, classifySheetsReadError } = require('../sheets');

// Google answers a range read for an absent tab with this exact wording — and answers
// a MALFORMED A1 range with the same wording, which is why absence has to be confirmed
// against the tab list rather than read off the message. A transient backend failure
// is a gaxios error carrying an HTTP status and no such message.
const rangeParseError = () => new Error('Unable to parse range: Session_Plans!A1:M1');

const state = {
  tabs: ['Session_Plans'],
  rows: [],
  appends: [],
  header: [...sessionPlansColumns], // the exact, correct header by default
  readCalls: 0,
  throwOnAppend: false,
  readError: null, // when set, readRange rejects with it regardless of `tabs`
};
function _resetSheets({ tabs = ['Session_Plans'], rows = [], header = [...sessionPlansColumns], throwOnAppend = false, readError = null } = {}) {
  state.tabs = tabs; state.rows = rows.slice(); state.appends = [];
  state.header = header.slice(); state.readCalls = 0; state.throwOnAppend = throwOnAppend;
  state.readError = readError;
}
// One reset for both fixtures. The sheets fake still exists so this suite can prove
// what the capture layer does NOT touch; the plan events themselves live in the
// authority double, which has to be cleared with it.
function reset(opts) { _resetSheets(opts); resetWorkoutAuthorityStub(); }
const fakeSheets = {
  getSpreadsheetTabs: async () => { if (state.readError) throw state.readError; return state.tabs.slice(); },
  getSheetRows: async (tab) => { if (!state.tabs.includes(tab)) throw rangeParseError(); return state.rows.slice(); },
  appendRows: async (tab, rows) => {
    if (state.throwOnAppend) throw new Error('simulated Sheets append failure');
    state.appends.push({ tab, rows });
    if (tab === 'Session_Plans') state.rows.push(...rows);
  },
  readRange: async (range) => {
    state.readCalls += 1;
    if (state.readError) throw state.readError;
    // Real Sheets API rejects the RANGE when the tab does not exist — mirror the
    // real wording so the real classifier is what decides, not the fixture.
    if (!state.tabs.some(t => String(range).startsWith(t))) throw rangeParseError();
    return state.header.length ? [state.header.slice()] : [];
  },
  // The REAL confirmation, driven by this fixture's own tab list. Binding `listTabs`
  // rather than reimplementing the check is deliberate: a fixture copy of "is the tab
  // absent" could stay green while production drifted.
  confirmTabMissing: (e, tab) => confirmTabMissing(e, tab, {
    listTabs: async () => { if (state.readError) throw state.readError; return state.tabs.slice(); },
  }),
  classifySheetsReadError,
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

// The workout authority is Supabase since the S4 cutover, so stubbing sheets.js no
// longer controls the plan ledgers. sheetsFallback seeds this suite's existing
// fixture into the double, so no test's data changes.
const { installWorkoutAuthorityStub, resetWorkoutAuthorityStub, workoutAuthorityStore, failWorkoutAuthorityWrites } = require('./helpers/stubWorkoutAuthority');
installWorkoutAuthorityStub();
const capture = require('../services/sessionPlanCapture');
const IDX = Object.fromEntries(sessionPlansColumns.map((c, i) => [c, i]));

const SESSION = { session_id: 'S1', session_date: '2026-07-10', plan_version: 'pv_11111111-1111-4111-8111-111111111111' };
const ITEMS = [
  { plan_item_id: 'pi_aaaaaaaa', planned_order: 1, planned_lift_code: 'BEN01', movement_pattern: 'horizontal_push' },
  { plan_item_id: 'pi_bbbbbbbb', planned_order: 2, planned_lift_code: 'SQ01', movement_pattern: 'squat' },
];

function withFlag(value, fn) {
  const prev = process.env.ATLAS_SESSION_PLANS_WRITE;
  if (value == null) delete process.env.ATLAS_SESSION_PLANS_WRITE; else process.env.ATLAS_SESSION_PLANS_WRITE = value;
  return (async () => { try { return await fn(); } finally {
    if (prev == null) delete process.env.ATLAS_SESSION_PLANS_WRITE; else process.env.ATLAS_SESSION_PLANS_WRITE = prev;
  } })();
}

// ── flag gate (default OFF) ───────────────────────────────────────────────────

test('the retired flag cannot disable authoritative Supabase capture', async () => {
  reset();
  await withFlag('0', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.status, 'written');
    assert.equal(r.captured, true);
    assert.equal(r.plan_version, SESSION.plan_version);
    assert.equal(workoutAuthorityStore().planEvents.length, 2);
    assert.equal(state.readCalls, 0, 'capture never reads a Sheets header');
    assert.equal(state.appends.length, 0, 'capture never writes Sheets');
  });
});

test('the production module contains no reader for ATLAS_SESSION_PLANS_WRITE', () => {
  const source = require('node:fs').readFileSync(require.resolve('../services/sessionPlanCapture'), 'utf8');
  assert.doesNotMatch(source, /ATLAS_SESSION_PLANS_WRITE/);
});

// ── THE EXACT-HEADER VALIDATION BLOCK RETIRED WITH THE TAB ───────────────────
//
// Nine tests lived here. Each asked a question about a Google Sheets tab a human
// can edit: is row 1 the exact column contract, is the tab there at all, and — the
// hard-won half — is an unreadable header ever allowed to READ AS an absent tab.
//
// The concept moved to a Supabase table the migration created. Its columns cannot
// be renamed, reordered or removed at runtime and the table cannot be absent, so
// there is nothing left for the probe to detect; keeping it would only mean a
// Google Sheets quota error could refuse a write to a tab the write never touches.
//
// THE GUARANTEE DID NOT GO WITH THE MECHANISM. Schema protection now lives where
// the schema does — the migration, and test-pg/constraints.pgproof.js, which drives
// the real constraints against a real database. And the fail-closed rule the
// tab_missing tests really protected — an unreadable ledger must never present as a
// verified-empty one — is asserted in test/sessionPlanSetsStore.test.js against the
// authority that can actually be unreadable.

test('the header check answers ok — there is no Sheets header left to validate', async () => {
  reset();
  const hv = await capture.validateHeader();
  assert.equal(hv.ok, true);
  assert.equal(state.readCalls, 0, 'and it reads no Sheets range to say so');
});

test('the live path writes the plan events and reports them captured', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.status, 'written');
    assert.equal(r.captured, true);
    assert.equal(r.written, 2);
    assert.equal(workoutAuthorityStore().planEvents.length, 2);
    assert.equal(state.appends.length, 0, 'and it appends to no Google Sheets tab');
  });
});

// ── accept / outcome / closeout append via the existing builders ──────────────

test('accepted plan appends one plan_accepted row per item; recorded_at is non-empty', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.written, 2);
    assert.equal(workoutAuthorityStore().planEvents.length, 2);
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.event_type], 'plan_accepted');
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.outcome], 'planned');
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.plan_item_id], 'pi_aaaaaaaa');
    assert.notEqual(String(workoutAuthorityStore().planEvents[0][IDX.recorded_at] || '').trim(), '', 'recorded_at must be stamped non-empty');
  });
});

test('duplicate accepted-plan retry is idempotent (skipped, captured:true, no new rows)', async () => {
  reset();
  await withFlag('1', async () => {
    await capture.captureAccept(SESSION, ITEMS);
    const before = workoutAuthorityStore().planEvents.length;
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.status, 'skipped');
    assert.equal(r.captured, true, 'an idempotent skip of an already-persisted event still counts as captured');
    assert.equal(r.written, 0);
    assert.equal(r.skipped, 2);
    assert.equal(workoutAuthorityStore().planEvents.length, before, 'append-only store unchanged by a retry');
  });
});

test('completed outcome appends exactly one item_outcome', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureOutcome(SESSION, { plan_item_id: 'pi_aaaaaaaa', planned_lift_code: 'BEN01', outcome: 'completed' });
    assert.equal(r.written, 1);
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.event_type], 'item_outcome');
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.outcome], 'completed');
  });
});

test('skipped outcome appends exactly one item_outcome', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureOutcome(SESSION, { plan_item_id: 'pi_aaaaaaaa', planned_lift_code: 'BEN01', outcome: 'skipped' });
    assert.equal(r.written, 1);
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.outcome], 'skipped');
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.performed_lift_code], '', 'skipped carries no performed code');
  });
});

test('substituted outcome preserves planned_lift_code and records performed_lift_code', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureOutcome(SESSION, { plan_item_id: 'pi_aaaaaaaa', planned_lift_code: 'BEN01', outcome: 'substituted', performed_lift_code: 'DBP01' });
    assert.equal(r.written, 1);
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.planned_lift_code], 'BEN01');
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.performed_lift_code], 'DBP01');
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.outcome], 'substituted');
  });
});

test('finalized closeout appends one session_closeout', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureCloseout(SESSION, 'finalized');
    assert.equal(r.written, 1);
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.event_type], 'session_closeout');
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.closeout_status], 'finalized');
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.plan_item_id], '', 'session-scoped, no item id');
  });
});

test('abandoned closeout appends one session_closeout', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureCloseout(SESSION, 'abandoned');
    assert.equal(r.written, 1);
    assert.equal(workoutAuthorityStore().planEvents[0][IDX.closeout_status], 'abandoned');
  });
});

// ── isolation + fail-closed ───────────────────────────────────────────────────

test('only the Session_Plans tab is ever written — never Log_Cleaned/Effort', async () => {
  reset();
  await withFlag('1', async () => {
    await capture.captureAccept(SESSION, ITEMS);
    await capture.captureOutcome(SESSION, { plan_item_id: 'pi_aaaaaaaa', planned_lift_code: 'BEN01', outcome: 'completed' });
    await capture.captureCloseout(SESSION, 'finalized');
    assert.ok(state.appends.every(a => a.tab === 'Session_Plans'), 'capture must never write another tab');
  });
});

test('revision collision fails closed (error/revision_collision), never throws', async () => {
  reset();
  await withFlag('1', async () => {
    await capture.captureAccept(SESSION, [ITEMS[0]]); // pi_aaaaaaaa = BEN01
    // Same session + plan_version + item id but a DIFFERENT planned lift → same key,
    // different content → the store throws; the capture layer must return an envelope.
    const r = await capture.captureAccept(SESSION, [{ ...ITEMS[0], planned_lift_code: 'INC01' }]);
    assert.equal(r.status, 'error');
    assert.equal(r.captured, false);
    assert.equal(r.reason, 'revision_collision');
  });
});

// MAIN-SAVE ISOLATION, unchanged in substance: the capture layer is a sidecar, so a
// failure of the ledger write must become an envelope and never a rejection that
// could take the athlete's Save down with it. Only the failing store moved — it was
// a Google Sheets append and it is a Supabase write.
test('a ledger write failure is isolated: captured:false envelope, NEVER a rejection', async () => {
  reset();
  failWorkoutAuthorityWrites('simulated ledger write failure');
  await withFlag('1', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS); // must not throw
    assert.equal(r.status, 'error');
    assert.equal(r.captured, false);
    assert.ok(r.reason, 'a diagnostic reason is surfaced');
  });
});
