'use strict';

// ── Accepted-plan session-identity allocation (authority fix, 2026-08-03) ────────
//
// PR #1245 made services/sessionId.js nextAvailableSessionId the ONE session-id
// allocation authority for /api/log-workout. The accepted-plan path still had a
// second authority: the client's acceptDisplayedPlan derived `${date}-{AM|PM}-01`,
// hardcoded, consulting nothing — so a second plan accepted in the same AM/PM
// period re-used the first session's identity after that session was finalized and
// sealed (reproduced in tests/e2e/gate/two-accepted-plans-identity.spec.js).
//
// The fix removes the client mint: an acceptance with NO established identity sends
// no session_id, and POST /api/session-plans/accept allocates via the SAME
// nextAvailableSessionId over the durable union Effort ∪ Log_Cleaned ∪
// Session_Plans, then returns the identity it wrote under. These tests drive the
// real route over an injected sheet reader and pin every allocation property:
//   - two acceptances in one period receive DISTINCT identities;
//   - a Session_Plans row ALONE occupies a slot (no Log/Effort row needed);
//   - Effort and Log_Cleaned rows each occupy a slot (the union is complete);
//   - a retry/replay of the same acceptance (same pv_ plan_version) re-uses the
//     identity its durable rows carry — never a second allocation;
//   - each unreadable occupancy source fails CLOSED (503, nothing written);
//   - the response names the allocated identity;
//   - an established (client-sent) identity is honored verbatim with no occupancy
//     reads, so a continuing session can never fork.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { sessionPlansColumns, logCleanedColumns, effortColumns } = require('../config/columns');
const { formatDateForSessionId, formatAmPmSuffix } = require('../services/sessionId');

// The capture layer is stubbed (require.cache, same seam as sessionPlansRoutes.test.js)
// so the tests see exactly which session identity each acceptance was written under.
const captureCalls = [];
const fakeCapture = {
  SESSION_PLANS_TAB: 'Session_Plans',
  isEnabled: () => true,
  validateHeader: async () => ({ ok: true }),
  captureAccept: async (session, items) => {
    captureCalls.push({ session: { ...session }, items });
    return { status: 'written', captured: true, written: items.length, skipped: 0, plan_version: session.plan_version, reason: null };
  },
  captureOutcome: async () => ({ status: 'written', captured: true }),
  captureCloseout: async () => ({ status: 'written', captured: true }),
};
const capturePath = require.resolve('../services/sessionPlanCapture');
require.cache[capturePath] = { id: capturePath, filename: capturePath, loaded: true, exports: fakeCapture };

// Hermetic: the catalog reads Supabase (OWNER CORRECTION 2026-08-13). This stub also
// blanks the ATLAS_SUPABASE_* roles, so no test can open a database connection.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
// The workout authority is Supabase since the S4 cutover, so stubbing `sheets.js`
// no longer controls the logged sets, the Effort row, the plan ledgers or the write
// receipts. `sheetsFallback` seeds this suite's existing fixture into the double, so
// no test's data changes — only where the route reads it from.
const {
  installWorkoutAuthorityStub, resetWorkoutAuthorityStub, workoutAuthorityStore,
  failWorkoutAuthorityReads,
} = require('./helpers/stubWorkoutAuthority');
installWorkoutAuthorityStub();
const registerSessionPlanRoutes = require('../routes/sessionPlans');

// ── in-memory durable records ────────────────────────────────────────────────────
//
// Still keyed by tab NAME, because the fixtures are rows in the owner-approved column
// order of each tab and that is what the authority returns. There is no sheets reader
// here any more: the route's last Sheets read — the acceptance retry-reuse lookup on
// `Session_Plans` — moved to `workoutAuthority.planEventRows()` with the rest of the
// plan ledger, so `seedAuthority()` below is the only thing that feeds these routes.
const tabs = { Log_Cleaned: [], Effort: [], Session_Plans: [] };

const SP_SESSION_IDX = sessionPlansColumns.indexOf('session_id');
const SP_PLAN_VERSION_IDX = sessionPlansColumns.indexOf('plan_version');
const SP_EVENT_IDX = sessionPlansColumns.indexOf('event_type');
const LOG_SESSION_IDX = logCleanedColumns.indexOf('session_id');
const EFFORT_SESSION_IDX = effortColumns.indexOf('session_id');

function sessionPlansRow({ sessionId, planVersion = 'pv_other', eventType = 'plan_accepted' }) {
  const row = sessionPlansColumns.map(() => '');
  row[SP_SESSION_IDX] = sessionId;
  row[SP_PLAN_VERSION_IDX] = planVersion;
  row[SP_EVENT_IDX] = eventType;
  return row;
}
function logRow(sessionId) {
  const row = logCleanedColumns.map(() => '');
  row[LOG_SESSION_IDX] = sessionId;
  return row;
}
function effortRow(sessionId) {
  const row = effortColumns.map(() => '');
  row[EFFORT_SESSION_IDX] = sessionId;
  return row;
}

// The DATE is fixed; the PERIOD comes from the same production helper the allocator
// uses (never a hardcoded AM/PM — the tests must pass at any wall-clock hour).
const DATE = '2026-08-03';
const SLOT = n => `${formatDateForSessionId(DATE)}-${formatAmPmSuffix()}-${String(n).padStart(2, '0')}`;

const PV = 'pv_11111111-1111-4111-8111-111111111111';
const PV2 = 'pv_22222222-2222-4222-8222-222222222222';
const PI = 'pi_aaaaaaaa-1111-4111-8111-111111111111';
const ITEM = { plan_item_id: PI, planned_order: 1, planned_lift_code: 'BEN01' };

let baseUrl, server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(registerSessionPlanRoutes());
  await new Promise(resolve => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
test.after(() => { if (server) server.close(); });

test.beforeEach(() => {
  captureCalls.length = 0;
  tabs.Log_Cleaned = [];
  tabs.Effort = [];
  tabs.Session_Plans = [];
  resetWorkoutAuthorityStub();
});

// Session identity comes from Supabase now, so the fixture rows have to reach the
// authority rather than the sheets reader. The route still reads Session_Plans
// through its injected reader for the RETRY-REUSE lookup, so `tabs.Session_Plans`
// keeps feeding that; occupancy is answered by the authority.
function seedAuthority() {
  const store = workoutAuthorityStore();
  store.loggedSets = tabs.Log_Cleaned.map((r) => r.slice());
  store.loggedSetWriteIds = store.loggedSets.map(() => null);
  store.effort = tabs.Effort.map((r) => r.slice());
  store.planEvents = tabs.Session_Plans.map((r) => r.slice());
}

async function accept(body, base = baseUrl) {
  // Seeded at the last possible moment, so a test that assigns its fixture rows
  // after beforeEach still has them in the authority when the request runs.
  seedAuthority();
  const r = await fetch(`${base}/api/session-plans/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
const NO_ID = { session_date: DATE, plan_version: PV, items: [ITEM] };

// ── allocation ───────────────────────────────────────────────────────────────────

test('no session_id + empty durable records → the server allocates the first slot and returns it', async () => {
  const { status, body } = await accept(NO_ID);
  assert.equal(status, 200);
  assert.equal(body.data.session_id, SLOT(1));
  assert.equal(captureCalls.length, 1);
  assert.equal(captureCalls[0].session.session_id, SLOT(1), 'the acceptance is written under the allocated identity');
  assert.equal(body.data.session_plans.captured, true);
});

test('a Session_Plans row ALONE occupies the slot — the first workout may exist only as an accepted plan', async () => {
  // The exact merge shape: workout 1 was accepted (Session_Plans rows) but has no
  // Log_Cleaned or Effort row yet. Workout 2's acceptance must step over it.
  tabs.Session_Plans = [sessionPlansRow({ sessionId: SLOT(1), planVersion: PV2 })];
  const { status, body } = await accept(NO_ID);
  assert.equal(status, 200);
  assert.equal(body.data.session_id, SLOT(2), 'a second same-period acceptance gets a DISTINCT identity');
  assert.equal(captureCalls[0].session.session_id, SLOT(2));
});

test('an Effort row occupies the slot (the union is not Session_Plans-only)', async () => {
  tabs.Effort = [effortRow(SLOT(1))];
  const { body } = await accept(NO_ID);
  assert.equal(body.data.session_id, SLOT(2));
});

test('a Log_Cleaned row occupies the slot (the union is not Session_Plans-only)', async () => {
  tabs.Log_Cleaned = [logRow(SLOT(1))];
  const { body } = await accept(NO_ID);
  assert.equal(body.data.session_id, SLOT(2));
});

test('occupancy is the UNION: rows across all three tabs each consume a slot', async () => {
  tabs.Effort = [effortRow(SLOT(1))];
  tabs.Log_Cleaned = [logRow(SLOT(2))];
  tabs.Session_Plans = [sessionPlansRow({ sessionId: SLOT(3), planVersion: PV2 })];
  const { body } = await accept(NO_ID);
  assert.equal(body.data.session_id, SLOT(4));
});

// ── retry / replay ───────────────────────────────────────────────────────────────

test('a retry of the same acceptance re-uses the identity its durable rows carry — never a second allocation', async () => {
  // First attempt wrote plan_accepted rows under slot 1. The union now CONTAINS
  // slot 1, so a replay that consulted only occupancy would allocate slot 2 and
  // fork one accepted workout into two identities. The durable plan_version match
  // must win.
  tabs.Session_Plans = [sessionPlansRow({ sessionId: SLOT(1), planVersion: PV })];
  const { status, body } = await accept(NO_ID);
  assert.equal(status, 200);
  assert.equal(body.data.session_id, SLOT(1), 'the original identity is returned, not the next slot');
  assert.equal(captureCalls[0].session.session_id, SLOT(1), 'the idempotent re-write addresses the original identity');
});

test('replay reuse holds even at a non-first slot and with other sessions around it', async () => {
  tabs.Session_Plans = [
    sessionPlansRow({ sessionId: SLOT(1), planVersion: PV2 }),
    sessionPlansRow({ sessionId: SLOT(3), planVersion: PV }),
  ];
  tabs.Effort = [effortRow(SLOT(2))];
  const { body } = await accept(NO_ID);
  assert.equal(body.data.session_id, SLOT(3));
});

test('a non-accept Session_Plans row for the same plan_version does not satisfy retry reuse', async () => {
  // Only a plan_accepted row is acceptance evidence; a stray closeout under the same
  // pv_ (malformed history) must not hand the acceptance a finalized identity.
  tabs.Session_Plans = [sessionPlansRow({ sessionId: SLOT(1), planVersion: PV, eventType: 'session_closeout' })];
  const { body } = await accept(NO_ID);
  assert.equal(body.data.session_id, SLOT(2), 'occupancy still counts the row; reuse does not');
});

// ── fail closed ──────────────────────────────────────────────────────────────────

// ONE SOURCE NOW, NOT TWO — AND THAT IS THE POINT.
//
// Occupancy was once a union of three whole-tab Sheets reads, then two sources (the
// authority for session identity, plus an injected Sheets reader still answering the
// `Session_Plans` retry-reuse lookup). Each had to be armed separately, and each was
// a way for a Google Sheets quota to refuse an acceptance.
//
// Both questions are answered by Supabase now, so there is exactly one thing that can
// refuse and exactly one refusal to assert. The two tests that armed the two sources
// separately collapse into this one — a genuine reduction, not a dropped case: no
// source went unproven, one of them stopped existing.
test('an unreadable authority fails CLOSED: 503, no identity minted, nothing written', async () => {
  failWorkoutAuthorityReads('session identity read refused (armed)');
  const { status, body } = await accept(NO_ID);
  assert.equal(status, 503);
  assert.match(body.message, /occupancy is unreadable/, 'the refusal names the unprovable source');
  assert.equal(captureCalls.length, 0, 'no acceptance may be written under an unprovable identity');
});

// F-SB4B overflow regression (2026-08-03): with every scanned slot occupied the old
// allocator WRAPPED to -01, and this route wrote a fresh acceptance into the first
// (sealed, finalized) session of the period — durably proven in the rehearsal debug
// sweep, where PM-01 accumulated four separate acceptances. The 11th acceptance must
// allocate slot 11; total exhaustion must refuse (503), never reuse.
test('the 11th same-period acceptance allocates slot 11 — never wraps into the sealed first session', async () => {
  for (let n = 1; n <= 10; n += 1) tabs.Session_Plans.push(sessionPlansRow({ sessionId: SLOT(n) }));
  const r = await accept(NO_ID);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.session_id, SLOT(11));
  assert.equal(captureCalls[0].session.session_id, SLOT(11));
});

test('total slot exhaustion fails CLOSED: 503, no identity minted, nothing written', async () => {
  for (let n = 1; n <= 99; n += 1) tabs.Session_Plans.push(sessionPlansRow({ sessionId: SLOT(n) }));
  const r = await accept(NO_ID);
  assert.equal(r.status, 503);
  assert.match(String(r.body.error || r.body.message || ''), /every slot .* occupied/i);
  assert.equal(captureCalls.length, 0, 'nothing may be written under a reused identity');
});

test('an unallocatable session_date → 400, nothing written', async () => {
  const { status } = await accept({ ...NO_ID, session_date: 'not-a-date' });
  assert.equal(status, 400);
  assert.equal(captureCalls.length, 0);
});

// ── established identity ─────────────────────────────────────────────────────────

test('an established session_id is honored verbatim — no occupancy reads, no reallocation, echoed back', async () => {
  tabs.Session_Plans = [sessionPlansRow({ sessionId: SLOT(1), planVersion: PV2 })];
  // "No occupancy read happens" is asserted by ARMING the authority to refuse every
  // read and requiring a 200 anyway. That is stronger than counting calls on a reader
  // the route no longer holds: a request that issued any read at all could not pass.
  failWorkoutAuthorityReads('no read may occur on an established identity');
  const { status, body } = await accept({ ...NO_ID, session_id: SLOT(1) });
  assert.equal(status, 200);
  assert.equal(body.data.session_id, SLOT(1), 'a continuing session keeps its identity — it never forks');
  assert.equal(captureCalls[0].session.session_id, SLOT(1));
});
