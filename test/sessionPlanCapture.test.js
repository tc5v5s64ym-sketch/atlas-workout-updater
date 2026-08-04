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
const malformedRangeError = () => new Error('Unable to parse range: Session_Plans!A1:%%');
const transientError = () => Object.assign(new Error('The service is currently unavailable.'), { status: 503 });

const state = {
  tabs: ['Session_Plans'],
  rows: [],
  appends: [],
  header: [...sessionPlansColumns], // the exact, correct header by default
  readCalls: 0,
  throwOnAppend: false,
  readError: null, // when set, readRange rejects with it regardless of `tabs`
};
function reset({ tabs = ['Session_Plans'], rows = [], header = [...sessionPlansColumns], throwOnAppend = false, readError = null } = {}) {
  state.tabs = tabs; state.rows = rows.slice(); state.appends = [];
  state.header = header.slice(); state.readCalls = 0; state.throwOnAppend = throwOnAppend;
  state.readError = readError;
}
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

test('flag defaults OFF: isEnabled() is false when the env var is unset', async () => {
  await withFlag(null, () => { assert.equal(capture.isEnabled(), false); });
});

test('flag OFF ⇒ disabled envelope and ZERO Sheets access (no read, no write)', async () => {
  reset();
  await withFlag('0', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.status, 'disabled');
    assert.equal(r.captured, false);
    assert.equal(r.plan_version, SESSION.plan_version);
    assert.equal(state.readCalls, 0, 'flag OFF must not read the header');
    assert.equal(state.appends.length, 0, 'flag OFF must not write');
  });
});

test('flag ON accepts 1/true/on', async () => {
  for (const v of ['1', 'true', 'on']) {
    await withFlag(v, () => assert.equal(capture.isEnabled(), true));
  }
  for (const v of ['0', 'false', 'off', '', 'yes']) {
    await withFlag(v, () => assert.equal(capture.isEnabled(), false));
  }
});

// ── exact-header validation ───────────────────────────────────────────────────

test('exact valid header permits the sidecar write', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.status, 'written');
    assert.equal(r.captured, true);
    assert.equal(r.written, 2);
    assert.ok(state.appends.length > 0);
  });
});

test('missing tab fails safely: tab_missing, captured:false, no write', async () => {
  reset({ tabs: [] });
  await withFlag('1', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.status, 'tab_missing');
    assert.equal(r.captured, false);
    assert.equal(state.appends.length, 0);
  });
});

// BITE for the read-failure authority. Before it existed, `validateHeader` caught
// EVERY read error and answered `tab_missing` — so a 503 from Google told the owner
// the Session_Plans tab had been deleted and a schema migration was needed. Both
// outcomes refuse the write, so cardinality alone cannot tell them apart; the status
// is the only thing that carries the truth. Reverting validateHeader to a blanket
// `tab_missing` fails this test and leaves the one above passing.
test('a TRANSIENT read failure is error, never tab_missing — and still writes nothing', async () => {
  reset({ readError: transientError() });
  await withFlag('1', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.status, 'error', 'a 503 is an upstream failure, not evidence the tab is gone');
    assert.notEqual(r.status, 'tab_missing');
    assert.equal(r.captured, false);
    assert.equal(state.appends.length, 0, 'fails closed either way — no write on an unreadable header');
  });
});

// BITE — a MALFORMED RANGE is not evidence that the tab is absent, even though Google
// reports it with the identical "Unable to parse range" wording. The tab list here
// still contains Session_Plans, so absence is refuted. Inferring `tab_missing` from
// the message would let a caller bug (an unescaped tab name, a bad column letter)
// manufacture a durable schema fact — and in the sets capture, a verified-empty seal.
// Reverting confirmTabMissing to a message test fails this and leaves the two below
// passing, which is exactly the false green it exists to prevent.
test('a MALFORMED RANGE against an existing tab is error, never tab_missing', async () => {
  reset({ tabs: ['Session_Plans'], readError: malformedRangeError() });
  await withFlag('1', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.status, 'error', 'the tab is right there in the tab list — this is a bad range, not an absent tab');
    assert.notEqual(r.status, 'tab_missing');
    assert.equal(r.captured, false);
    assert.equal(state.appends.length, 0);
  });
});

// The metadata read is what establishes absence, so a metadata read that FAILS
// establishes nothing. Fail closed: never claim absence from a failure to look.
test('a range error whose METADATA CONFIRMATION also fails is error, never tab_missing', async () => {
  reset({ tabs: [] });
  // The header read rejects with the range wording; the confirming tab-list read then
  // fails too, so nothing was ever confirmed.
  state.readError = rangeParseError();
  const listFailure = Object.assign(new Error('Backend Error'), { status: 503 });
  const original = fakeSheets.confirmTabMissing;
  fakeSheets.confirmTabMissing = (e, tab) => confirmTabMissing(e, tab, {
    listTabs: async () => { throw listFailure; },
  });
  try {
    await withFlag('1', async () => {
      const r = await capture.captureAccept(SESSION, ITEMS);
      assert.equal(r.status, 'error', 'could not look ⇒ not evidence of absence');
      assert.notEqual(r.status, 'tab_missing');
      assert.equal(r.captured, false);
      assert.equal(state.appends.length, 0);
    });
  } finally {
    fakeSheets.confirmTabMissing = original;
  }
});

// The other half of the same distinction: a PERMANENT failure (revoked credentials,
// wrong spreadsheet id) is equally not evidence that this tab is absent.
test('a PERMANENT read failure is error, never tab_missing', async () => {
  reset({ readError: Object.assign(new Error('The caller does not have permission'), { status: 403 }) });
  await withFlag('1', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.status, 'error');
    assert.equal(r.captured, false);
    assert.equal(state.appends.length, 0);
  });
});

test('wrong header ORDER fails safely: header_mismatch, captured:false, no write', async () => {
  // Swap two columns → a position-by-position mismatch.
  const bad = [...sessionPlansColumns];
  [bad[1], bad[2]] = [bad[2], bad[1]];
  reset({ header: bad });
  await withFlag('1', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.status, 'header_mismatch');
    assert.equal(r.captured, false);
    assert.equal(state.appends.length, 0, 'a mismatched header must never be written to');
  });
});

test('a truncated/short header fails safely (header_mismatch)', async () => {
  reset({ header: sessionPlansColumns.slice(0, 5) });
  await withFlag('1', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.status, 'header_mismatch');
    assert.equal(state.appends.length, 0);
  });
});

// ── accept / outcome / closeout append via the existing builders ──────────────

test('accepted plan appends one plan_accepted row per item; recorded_at is non-empty', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.written, 2);
    assert.equal(state.rows.length, 2);
    assert.equal(state.rows[0][IDX.event_type], 'plan_accepted');
    assert.equal(state.rows[0][IDX.outcome], 'planned');
    assert.equal(state.rows[0][IDX.plan_item_id], 'pi_aaaaaaaa');
    assert.notEqual(String(state.rows[0][IDX.recorded_at] || '').trim(), '', 'recorded_at must be stamped non-empty');
  });
});

test('duplicate accepted-plan retry is idempotent (skipped, captured:true, no new rows)', async () => {
  reset();
  await withFlag('1', async () => {
    await capture.captureAccept(SESSION, ITEMS);
    const before = state.rows.length;
    const r = await capture.captureAccept(SESSION, ITEMS);
    assert.equal(r.status, 'skipped');
    assert.equal(r.captured, true, 'an idempotent skip of an already-persisted event still counts as captured');
    assert.equal(r.written, 0);
    assert.equal(r.skipped, 2);
    assert.equal(state.rows.length, before, 'append-only store unchanged by a retry');
  });
});

test('completed outcome appends exactly one item_outcome', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureOutcome(SESSION, { plan_item_id: 'pi_aaaaaaaa', planned_lift_code: 'BEN01', outcome: 'completed' });
    assert.equal(r.written, 1);
    assert.equal(state.rows[0][IDX.event_type], 'item_outcome');
    assert.equal(state.rows[0][IDX.outcome], 'completed');
  });
});

test('skipped outcome appends exactly one item_outcome', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureOutcome(SESSION, { plan_item_id: 'pi_aaaaaaaa', planned_lift_code: 'BEN01', outcome: 'skipped' });
    assert.equal(r.written, 1);
    assert.equal(state.rows[0][IDX.outcome], 'skipped');
    assert.equal(state.rows[0][IDX.performed_lift_code], '', 'skipped carries no performed code');
  });
});

test('substituted outcome preserves planned_lift_code and records performed_lift_code', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureOutcome(SESSION, { plan_item_id: 'pi_aaaaaaaa', planned_lift_code: 'BEN01', outcome: 'substituted', performed_lift_code: 'DBP01' });
    assert.equal(r.written, 1);
    assert.equal(state.rows[0][IDX.planned_lift_code], 'BEN01');
    assert.equal(state.rows[0][IDX.performed_lift_code], 'DBP01');
    assert.equal(state.rows[0][IDX.outcome], 'substituted');
  });
});

test('finalized closeout appends one session_closeout', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureCloseout(SESSION, 'finalized');
    assert.equal(r.written, 1);
    assert.equal(state.rows[0][IDX.event_type], 'session_closeout');
    assert.equal(state.rows[0][IDX.closeout_status], 'finalized');
    assert.equal(state.rows[0][IDX.plan_item_id], '', 'session-scoped, no item id');
  });
});

test('abandoned closeout appends one session_closeout', async () => {
  reset();
  await withFlag('1', async () => {
    const r = await capture.captureCloseout(SESSION, 'abandoned');
    assert.equal(r.written, 1);
    assert.equal(state.rows[0][IDX.closeout_status], 'abandoned');
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

test('a Sheets append failure is isolated: captured:false envelope, NEVER a rejection', async () => {
  reset({ throwOnAppend: true });
  await withFlag('1', async () => {
    const r = await capture.captureAccept(SESSION, ITEMS); // must not throw
    assert.equal(r.status, 'error');
    assert.equal(r.captured, false);
    assert.ok(r.reason, 'a diagnostic reason is surfaced');
  });
});

test('validateHeader is exposed and returns ok for the exact header', async () => {
  reset();
  const hv = await capture.validateHeader();
  assert.equal(hv.ok, true);
});
