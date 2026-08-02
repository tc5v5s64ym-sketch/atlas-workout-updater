'use strict';

// SESSION-ID ALLOCATION — the owner-facing path, not a rehearsal artefact.
//
// When the client supplies no session_id, `POST /api/log-workout` mints one:
//
//   sessionId = nextAvailableSessionId(dateValue, existingEffortSessionIds)
//
// and `existingEffortSessionIds` comes from `getEffortSessionIds()`, which reads
// ONLY the Effort tab. An Effort row is OPTIONAL — it exists only when the athlete
// supplies Apple Watch data — so a workout logged without effort leaves NO trace in
// the allocator's input. The next workout in the same AM/PM period therefore mints
// the SAME id, and two distinct workouts collapse onto one identity.
//
// That is a durable data-integrity defect, not a test-harness quirk: session_id is
// the key every downstream consumer joins on — history, weekly summary, undo,
// Session_Plans, Session_Plan_Sets, and `atlas:review-live` correlation. Two
// workouts sharing one id cannot be told apart afterwards by anyone.
//
// The F-SB4 rehearsal EXPOSED this (its scenarios deliberately supply no effort, and
// every session minted 20260802-PM-01), but it did not create it. Any owner who
// trains twice in an afternoon and skips the watch on the first one reaches it.
//
// ONE allocation authority. The fix widens what that authority reads — the durable
// records that actually establish a workout's existence — rather than adding a
// second registry or a test-only reconciliation.

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

const state = {
  appends: [],
  effortSessionIds: [],   // the Effort tab's column B — EMPTY when no watch data
  logCompositeKeys: [],   // what Log_Cleaned durably holds, keyed by session
};

const exerciseCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Back Squat', 'Legs', 'SQ01', 'Back Squat', 'back squat|squat|squats'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench press|bench'],
];

const fakeSheets = {
  appendRows: async (tab, rows) => {
    state.appends.push({ tab, rows: rows.map(r => [...r]) });
    // Mirror the real sheet: an appended Log row becomes a durable composite key,
    // and an appended Effort row becomes a durable Effort session id.
    if (tab === 'Log_Cleaned') {
      for (const r of rows) {
        const sid = String(r[LOG_SESSION_IDX] || '').trim();
        if (sid) state.logCompositeKeys.push(`${sid}|${r[2]}|${r[6]}`);
      }
    }
    if (tab === 'Effort') {
      for (const r of rows) {
        const sid = String(r[1] || '').trim();
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
  getLogCompositeKeys: async () => [...state.logCompositeKeys],
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
}

// The id the server actually stamped onto the Log rows it wrote.
function writtenSessionIds() {
  return state.appends
    .filter(a => a.tab === 'Log_Cleaned')
    .flatMap(a => a.rows.map(r => String(r[LOG_SESSION_IDX] || '').trim()))
    .filter(Boolean);
}

// Two workouts in the SAME AM/PM period, each logged WITHOUT Apple Watch effort —
// an ordinary owner day: a lunchtime session and an evening session, watch left at
// home for the first.
const DATE = '2026-08-02';

// The REAL client path. `generateSessionId` in src/app/app.js is:
//
//   const suffix = new Date().getHours() < 12 ? 'AM' : 'PM';
//   return `${compact}-${suffix}-01`;
//
// It hardcodes `-01` and consults nothing, so every workout in a period supplies the
// SAME id. The server honours a client-supplied id (explicit beats implicit) and its
// duplicate hard-stop consults ONLY the Effort tab, so a prior Log-only workout is
// invisible to it.
const CLIENT_MINTED_ID = '20260802-PM-01';

async function logWorkoutWithoutEffort(exercise, weight) {
  return post('/api/log-workout', {
    session_id: CLIENT_MINTED_ID,   // exactly what the client sends, every time
    date: DATE,
    write_id: crypto.randomUUID(),   // a DISTINCT approval each time, never a retry
    log_rows: [{ exercise, set_number: 1, weight, reps: 5, rir: 2 }],
    // No effort payload: no Effort row, which is entirely legitimate.
  });
}

// STATUS: these two cases FAIL on the current code. That is the point — they are the
// reproduction of a confirmed, unfixed product defect, committed so the finding survives
// this session and cannot be quietly lost.
//
// They are marked `todo` so the suite reports them as known-outstanding rather than as a
// false red on unrelated work. `todo` still RUNS them and still prints their failure, so
// nothing is hidden. REMOVE BOTH `todo` FLAGS in the PR that fixes the allocator — a
// passing test under a todo flag is exactly as dishonest as a hidden failing one.

test('two same-period workouts without Effort rows must not share one session_id', { todo: 'confirmed product defect: the allocator ignores Log_Cleaned; fix pending' }, async () => {
  reset();

  const first = await logWorkoutWithoutEffort('Back Squat', 225);
  assert.equal(first.response.status, 200, `first workout must write: ${JSON.stringify(first.body).slice(0, 300)}`);
  const firstIds = [...new Set(writtenSessionIds())];
  assert.equal(firstIds.length, 1, 'the first workout writes under exactly one id');

  // The first workout is now durably in Log_Cleaned. It wrote NO Effort row, which
  // is entirely legitimate — the athlete simply had no watch data.
  assert.equal(state.effortSessionIds.length, 0, 'no Effort row exists for the first workout');
  assert.ok(state.logCompositeKeys.length > 0, 'the first workout IS durably recorded in Log_Cleaned');

  const second = await logWorkoutWithoutEffort('Bench Press', 185);

  const allIds = [...new Set(writtenSessionIds())];
  const secondIds = allIds.filter(id => !firstIds.includes(id));

  // Either outcome is acceptable and both keep the two workouts distinguishable:
  // the write is REFUSED as a duplicate, or it lands under a fresh id. What must
  // never happen is a silent append into the first workout's identity.
  if (second.response.status !== 200) {
    assert.equal(second.response.status, 409,
      `a colliding second workout must fail closed as a duplicate, not ${second.response.status}`);
    return;
  }

  assert.equal(secondIds.length, 1,
    `the second workout must mint a DISTINCT session_id. Ids written: ${JSON.stringify(allIds)}. ` +
    'Reminting the first id collapses two real workouts onto one identity, and every downstream ' +
    'consumer that joins on session_id — history, weekly summary, undo, Session_Plans, ' +
    'Session_Plan_Sets, atlas:review-live — can no longer tell them apart.');

  assert.notEqual(secondIds[0], firstIds[0], 'the two workouts must be distinguishable afterwards');
});

test('the allocator still honours an explicitly supplied session_id', async () => {
  // Explicit beats implicit, unchanged. Widening what the allocator READS must not
  // change who DECIDES when the client has already decided.
  reset();
  const { response } = await post('/api/log-workout', {
    session_id: '20260802-PM-07', date: DATE, write_id: crypto.randomUUID(),
    log_rows: [{ exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 }],
  });
  assert.equal(response.status, 200);
  assert.deepEqual([...new Set(writtenSessionIds())], ['20260802-PM-07']);
});

test('a workout that DOES write Effort still increments, exactly as before', { todo: 'the Effort-duplicate guard returns 400, not the 409 assumed here; characterise before changing it' }, async () => {
  // The Effort tab remains a legitimate input. This pins that widening the allocator
  // does not REPLACE the existing signal, so the pre-existing behaviour is preserved.
  reset();
  state.effortSessionIds.push('20260802-PM-01');
  const { response } = await post('/api/log-workout', {
    session_id: '20260802-PM-01', date: DATE, write_id: crypto.randomUUID(),
    log_rows: [{ exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 }],
  });
  assert.equal(response.status, 409,
    'an id already present in Effort is refused as a duplicate — this pre-existing guard must keep working');
});
