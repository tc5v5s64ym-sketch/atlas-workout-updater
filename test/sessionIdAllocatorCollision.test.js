'use strict';

// SESSION-ID ALLOCATION — ONE authority, reading the records that prove a workout exists.
//
// The defect these tests pin, reproduced at the production seam before it was fixed:
// two same-period workouts, the first logged WITHOUT Apple Watch effort, both landed
// under `20260802-PM-01` with HTTP 200 and no refusal. Two real sessions merged into
// one identity — and session_id is what history, the weekly summary, undo,
// Session_Plans, Session_Plan_Sets, and `atlas:review-live` all join on, so nothing
// downstream could tell them apart afterwards.
//
// It was an AUTHORITY defect: two things allocated the same concept.
//   * the client minted `${date}-${AM|PM}-01`, hardcoded, consulting nothing;
//   * the server's allocator consulted `getEffortSessionIds()` — the Effort tab alone.
// An Effort row is OPTIONAL (it exists only when the athlete supplies watch data), so a
// workout logged without one left NO trace in the allocator's input. And because the
// server honours a client-supplied id (explicit beats implicit), the allocator was never
// even reached: the client's guess always won.
//
// The winner is the server allocator; the loser — the client's mint — is gone. The
// allocator now reads the DURABLE union (Effort ∪ Log_Cleaned), and the client sends a
// blank id for a session whose identity is not yet established. Those two halves are one
// fix: widening the allocator alone changes nothing while the client still overrides it,
// and blanking the client alone would hand allocation to a reader that cannot see
// Log_Cleaned. `test/unit.test.js` pins the client half at its source.
//
// The F-SB4 rehearsal EXPOSED this (its scenarios log no effort, and every session minted
// `20260802-PM-01`), but it did not create it. Any owner who trains twice in one
// afternoon and skips the watch on the first reaches it.

const test = require('node:test');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { resetIdempotencyStore } = require('../services/idempotency');
const { logCleanedColumns, effortColumns } = require('../config/columns');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';

const LOG_SESSION_IDX = logCleanedColumns.indexOf('session_id');
const EFFORT_SESSION_IDX = effortColumns.indexOf('session_id');

const state = {
  appends: [],
  effortSessionIds: [],   // the Effort tab's column B — EMPTY when there is no watch data
  logCompositeKeys: [],   // what Log_Cleaned durably holds
  failLogRead: false,     // drives the fail-closed case
};

const exerciseCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Back Squat', 'Legs', 'SQ01', 'Back Squat', 'back squat|squat|squats'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench press|bench'],
];

const fakeSheets = {
  appendRows: async (tab, rows) => {
    state.appends.push({ tab, rows: rows.map(r => [...r]) });
    // Mirror the real sheet: an appended row becomes a durable record on the next read.
    if (tab === 'Log_Cleaned') {
      for (const r of rows) {
        const sid = String(r[LOG_SESSION_IDX] || '').trim();
        // sid||exercise||set_number, lowercased — exactly getLogCompositeKeys' shape.
        if (sid) state.logCompositeKeys.push(`${sid}||${r[2]}||${r[6]}`.toLowerCase());
      }
    }
    if (tab === 'Effort') {
      for (const r of rows) {
        const sid = String(r[EFFORT_SESSION_IDX] || '').trim();
        if (sid) state.effortSessionIds.push(sid);
      }
    }
    return { data: { updates: { updatedRange: `${tab}!A100:L${99 + rows.length}`, updatedRows: rows.length } } };
  },
  readRange: async () => [],
  updateColumnCells: async () => ({ data: { totalUpdatedCells: 0 } }),
  deleteRowsByRange: async () => ({ ok: true }),
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => [...state.effortSessionIds],
  getLogCompositeKeys: async () => {
    if (state.failLogRead) throw new Error('simulated Log_Cleaned read failure');
    return [...state.logCompositeKeys];
  },
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getHeaderRow: async tab => {
    if (tab === 'Log_Cleaned') return [...logCleanedColumns];
    if (tab === 'Effort') return [...effortColumns];
    return [];
  },
  getSpreadsheetTabs: async () => ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort'],
  ensureSheetTab: async () => ({ existed: true }),
  getSafeSpreadsheetConfig: () => ({ sheetId: 'stub-sheet', configured: true }),
  isTransientAppendError: () => false,
  retryWithBackoff: async fn => fn(),
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const { app } = require('../index');

let server;
let baseUrl;
test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(r => server.close(r)); });

async function post(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

function reset() {
  resetIdempotencyStore();
  state.appends = [];
  state.effortSessionIds = [];
  state.logCompositeKeys = [];
  state.failLogRead = false;
}

// The id the server actually stamped onto the Log rows it wrote, in write order.
function writtenSessionIds() {
  return state.appends
    .filter(a => a.tab === 'Log_Cleaned')
    .flatMap(a => a.rows.map(r => String(r[LOG_SESSION_IDX] || '').trim()))
    .filter(Boolean);
}

const DATE = '2026-08-02';

// The FIXED client path. `#log-session-id` is blank for a session whose identity is not
// yet established — a fresh app load, or the field cleared by a concluded save — so the
// payload carries no session_id and the server allocates. See the app.js source
// assertions in test/unit.test.js for the client half.
async function logNewWorkoutWithoutEffort(exercise, weight) {
  return post('/api/log-workout', {
    date: DATE,
    write_id: crypto.randomUUID(),   // a DISTINCT approval each time, never a retry
    log_rows: [{ exercise, set_number: 1, weight, reps: 5, rir: 2 }],
    // No session_id: "this is a new workout — you decide."
    // No effort payload: no Effort row, which is entirely legitimate.
  });
}

// Two workouts in the SAME AM/PM period, each logged WITHOUT Apple Watch effort — an
// ordinary owner day: a lunchtime session and an evening session, watch left at home for
// the first. This is the exact case that used to merge.
test('two same-period workouts without Effort rows get distinct session_ids', async () => {
  reset();

  const first = await logNewWorkoutWithoutEffort('Back Squat', 225);
  assert.equal(first.response.status, 200, `first workout must write: ${JSON.stringify(first.body).slice(0, 300)}`);
  const firstIds = [...new Set(writtenSessionIds())];
  assert.deepEqual(firstIds, ['20260802-PM-01'], 'the first workout takes the first free slot');

  // The first workout is now durably in Log_Cleaned. It wrote NO Effort row, which is
  // entirely legitimate — the athlete simply had no watch data. Effort-only knowledge is
  // therefore blind to it, and that blindness is what caused the merge.
  assert.equal(state.effortSessionIds.length, 0, 'no Effort row exists for the first workout');
  assert.ok(state.logCompositeKeys.length > 0, 'the first workout IS durably recorded in Log_Cleaned');

  const second = await logNewWorkoutWithoutEffort('Bench Press', 185);
  assert.equal(second.response.status, 200, `second workout must write: ${JSON.stringify(second.body).slice(0, 300)}`);

  const allIds = [...new Set(writtenSessionIds())];
  assert.deepEqual(allIds, ['20260802-PM-01', '20260802-PM-02'],
    `the second workout must take the NEXT free slot. Ids written: ${JSON.stringify(allIds)}. ` +
    'Re-minting the first id collapses two real workouts onto one identity, and every ' +
    'downstream consumer that joins on session_id can no longer tell them apart.');

  // The response must NAME the identity it chose — the client pins it onto the write it
  // is about to approve, and the owner sees the real …-02 rather than a forced …-01.
  assert.equal(second.body?.data?.session_id, '20260802-PM-02',
    'the allocated identity is reported back to the client');
});

test('an explicitly supplied session_id is still honoured — explicit beats implicit', async () => {
  // Widening what the allocator READS must not change who DECIDES when the owner (or an
  // accepted plan, or a preview the client already pinned) has already decided.
  reset();
  const { response } = await post('/api/log-workout', {
    session_id: '20260802-PM-07', date: DATE, write_id: crypto.randomUUID(),
    log_rows: [{ exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 }],
  });
  assert.equal(response.status, 200);
  assert.deepEqual([...new Set(writtenSessionIds())], ['20260802-PM-07']);
});

test('continuing an established session appends to it rather than forking a new id', async () => {
  // The everyday flow: log a few sets, save, log more, save again. The client sends the
  // established id the first save resolved, so the second save must land in the SAME
  // session. Allocation must never fire for a session that already has an identity.
  reset();
  const first = await logNewWorkoutWithoutEffort('Back Squat', 225);
  const established = first.body?.data?.session_id;
  assert.equal(established, '20260802-PM-01');

  const { response } = await post('/api/log-workout', {
    session_id: established, date: DATE, write_id: crypto.randomUUID(),
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 185, reps: 5, rir: 2 }],
  });
  assert.equal(response.status, 200);
  assert.deepEqual([...new Set(writtenSessionIds())], ['20260802-PM-01'],
    'a continued session keeps its identity — the allocator must not fork it');
});

test('a stale row-level session_id cannot override the allocated identity', async () => {
  // The client stamps a session_id into every row it collects. A row-level value beats
  // the top-level fallback, so without server-side stamping an allocated …-02 would be
  // silently overridden by the …-01 the rows still carried — landing the write in the
  // very slot the allocator had just stepped over.
  reset();
  await logNewWorkoutWithoutEffort('Back Squat', 225);

  const { response, body } = await post('/api/log-workout', {
    date: DATE, write_id: crypto.randomUUID(),
    // No top-level session_id, but the rows carry the stale one.
    log_rows: [{ session_id: '20260802-PM-01', exercise: 'Bench Press', set_number: 1, weight: 185, reps: 5, rir: 2 }],
  });
  assert.equal(response.status, 200, JSON.stringify(body).slice(0, 300));
  assert.deepEqual([...new Set(writtenSessionIds())], ['20260802-PM-01', '20260802-PM-02'],
    'every written row carries the ALLOCATED identity, not the one the rows proposed');
});

test('a duplicate Effort session is still refused — the pre-existing guard is untouched', async () => {
  // The Effort tab remains a legitimate input, and its own duplicate hard-stop (never
  // double-write an Effort row) must keep working. It is scoped to writes that actually
  // append an Effort row, so the payload has to carry one for the guard to apply.
  reset();
  state.effortSessionIds.push('20260802-PM-01');
  const { response } = await post('/api/log-workout', {
    session_id: '20260802-PM-01', date: DATE, write_id: crypto.randomUUID(),
    log_rows: [{ exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 }],
    effort_row: { date: DATE, session_id: '20260802-PM-01', duration: 60, active_calories: 400, total_calories: 500, average_hr: 120, peak_hr: 160, location: 'Gym', notes: '' },
  });
  assert.equal(response.status, 409,
    'an id already present in Effort is refused as a duplicate — this pre-existing guard must keep working');
});

test('an unreadable Log_Cleaned refuses to allocate rather than guessing a free slot', async () => {
  // Fail CLOSED on identity. Falling back to Effort-only knowledge would reinstate the
  // exact blindness that caused the silent merge — and it would do so precisely when
  // Sheets is flaky, which is when a retry storm makes a collision most likely.
  reset();
  state.failLogRead = true;
  const { response, body } = await post('/api/log-workout', {
    date: DATE, write_id: crypto.randomUUID(),
    log_rows: [{ exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 }],
  });
  assert.equal(response.status, 500, 'allocation refuses rather than minting an unproven id');
  // The MESSAGE matters, not just the status. The same unreadable tab also trips the
  // row-level dedup further down the write path, which returns 500 too — so a status
  // check alone passes even if allocation silently guessed and the refusal came from
  // somewhere else entirely. Naming the guard is what makes this test bite.
  assert.equal(body.message, 'Failed to allocate a session id.',
    'the ALLOCATOR is what refused — not a later guard masking a guessed identity');
  assert.deepEqual(writtenSessionIds(), [], 'nothing is written when the identity cannot be proven free');
});
