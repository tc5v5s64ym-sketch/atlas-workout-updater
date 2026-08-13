'use strict';

// C2 — A WRITE MAY ONLY EVICT WHAT IT MADE STALE.
//
// `index.js` caches the two full-tab reads a dashboard fans out over — Log_Cleaned and
// Effort — for 30 seconds, and drops the cache on every successful live write so a write is
// immediately visible to the next read. That part is right and is unchanged here.
//
// What was wrong is WHAT it dropped. Every write cleared BOTH tabs, so a Save that appended
// only log rows threw away Effort rows it had not touched, and the next dashboard spent a
// Sheets read re-reading data that had not changed. Writes to tabs this cache never holds
// at all — Coaching_Notes, Constraints, Modality_Log — did the same to both.
//
// The two directions are NOT symmetric, and this file tests both:
//   • under-eviction is a TRUST bug — a write must always be visible to the next read;
//   • over-eviction is only a wasted read.
// So the no-argument call still clears everything, and a caller that names its tabs must
// name every tab it wrote. Each test below asserts at the googleapis boundary — the reads
// that actually reached the API — so nothing above it can under-report.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_IDEMPOTENCY_FILE = require('node:path').join(
  require('node:os').tmpdir(), 'atlas-sheet-rows-cache-invalidation-idempotency.json');

const { logCleanedColumns, effortColumns, sessionPlansColumns } = require('../config/columns');

let SHEET;
function resetSheet() {
  SHEET = {
    Log_Cleaned: [[...logCleanedColumns],
      ['2026-08-01', 'S-OLD', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '1', '225', '5', '2', '', '1125']],
    Effort: [[...effortColumns],
      ['2026-08-01', 'S-OLD', '60', '400', '500', '130', '160', 'gym', '']],
    Exercise_Catalog: [['Exercise', 'Canonical_Name', 'Muscle_Group', 'Lift_Code'],
      ['Back Squat', 'Back Squat', 'Legs', 'SQ01']],
    Coaching_Notes: [['date', 'note']],
    // The undo path proves the session was not finalized before it deletes anything; without
    // this tab that check is unavailable and undo correctly refuses (503).
    Session_Plans: [[...sessionPlansColumns]],
  };
}
resetSheet();

// Tabs whose append must throw, so a PARTIAL write can be driven: rows land in one tab and
// the next append fails.
const failAppendsTo = new Set();

// Every range the API was asked for, in order. A tab is "re-read" when its name appears
// again after a write — whether it travelled alone or inside a batch.
const rangesRead = [];
function record(range) { rangesRead.push(String(range)); }

function valuesFor(range) {
  const text = String(range);
  const bang = text.indexOf('!');
  const tab = bang === -1 ? text : text.slice(0, bang);
  const spec = bang === -1 ? '' : text.slice(bang + 1);
  const rows = SHEET[tab];
  if (!rows) throw new Error(`Unable to parse range: ${text}`);
  if (/^1:1$/.test(spec)) return [rows[0]];
  return rows;
}

const fake = {
  spreadsheets: {
    get: async () => ({ data: { sheets: Object.keys(SHEET).map(title => ({ properties: { title, sheetId: 1 } })) } }),
    batchUpdate: async () => ({ data: {} }),
    values: {
      get: async ({ range }) => { record(range); return { data: { values: valuesFor(range) } }; },
      batchGet: async ({ ranges }) => {
        for (const r of ranges) record(r);
        return { data: { valueRanges: ranges.map(r => ({ range: r, values: valuesFor(r) })) } };
      },
      append: async ({ range, requestBody }) => {
        const tab = String(range).split('!')[0];
        if (failAppendsTo.has(tab)) throw new Error(`append to ${tab} refused by the test`);
        if (!SHEET[tab]) SHEET[tab] = [];
        for (const row of requestBody.values) SHEET[tab].push(row.map(v => (v == null ? '' : String(v))));
        const n = requestBody.values.length;
        const last = SHEET[tab].length;
        return { data: { updates: { updatedRows: n, updatedRange: `${tab}!A${last - n + 1}:L${last}` } } };
      },
      update: async () => ({ data: {} }),
      batchUpdate: async () => ({ data: { totalUpdatedCells: 0 } }),
    },
  },
};

const googleapisPath = require.resolve('googleapis');
require.cache[googleapisPath] = {
  id: googleapisPath, filename: googleapisPath, loaded: true,
  exports: { google: { auth: { GoogleAuth: class { async getClient() { return {}; } } }, sheets: () => fake } },
};

const { resetIdempotencyStore } = require('../services/idempotency');
// Hermetic: the catalog reads Supabase (OWNER CORRECTION 2026-08-13). This stub also
// blanks the ATLAS_SUPABASE_* roles, so no test can open a database connection.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
const { app } = require('../index');

let server; let baseUrl;
test.before(async () => {
  server = await new Promise(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Reads of a tab since the marker — a name match, so a batched range counts too. */
function readsOf(tab, since) {
  return rangesRead.slice(since).filter(r => r.split('!')[0] === tab).length;
}

// Warm both cached tabs, then hand back the marker to count from.
async function warmCaches() {
  resetSheet();
  resetIdempotencyStore();
  await call('GET', '/api/plan/intent-recommendation');  // reads Log_Cleaned AND Effort
  await call('GET', '/api/prs/recent');                  // reads Log_Cleaned
  // Prove they really are warm: a second round must reach the API for neither.
  const before = rangesRead.length;
  await call('GET', '/api/plan/intent-recommendation');
  await call('GET', '/api/prs/recent');
  assert.equal(readsOf('Effort', before), 0, 'Effort must be cached before the write');
  assert.equal(readsOf('Log_Cleaned', before), 0, 'Log_Cleaned must be cached before the write');
  return rangesRead.length;
}

const logRow = { exercise: 'Back Squat', set_number: 1, weight: 235, reps: 5, rir: 2 };

test('a log-only Save evicts Log_Cleaned and KEEPS the Effort rows it did not touch', async () => {
  await warmCaches();

  const write = await call('POST', '/api/log-workout', {
    date: '2026-08-06', session_id: 'S-NEW', write_id: 'w_log_only', log_rows: [logRow],
  });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  assert.equal(write.body.data.effort_rows_written, 0, 'this Save must write no Effort row');

  const after = rangesRead.length;
  await call('GET', '/api/prs/recent');
  await call('GET', '/api/plan/intent-recommendation');

  assert.ok(readsOf('Log_Cleaned', after) > 0,
    'the tab the Save appended to must be re-read — a write is always visible to the next read');
  assert.equal(readsOf('Effort', after), 0,
    'a Save that wrote no Effort row must not make the next dashboard re-read Effort');
});

test('a Save that writes an Effort row makes it visible to the very next read', async () => {
  await warmCaches();

  const write = await call('POST', '/api/log-workout', {
    date: '2026-08-06', session_id: 'S-EFFORT', write_id: 'w_with_effort',
    log_rows: [logRow],
    effort_row: {
      date: '2026-08-06', session_id: 'S-EFFORT', duration: 55, active_calories: 380,
      total_calories: 520, average_hr: 128, peak_hr: 161, location: 'gym',
    },
  });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  assert.equal(write.body.data.effort_rows_written, 1, 'this Save must write an Effort row');

  const after = rangesRead.length;
  const read = await call('GET', '/api/plan/intent-recommendation');
  assert.ok(readsOf('Effort', after) > 0,
    'an Effort write must evict the Effort cache — a stale recommendation is a trust bug');
  assert.equal(read.status, 200);
  // And the value really is the post-write one, not a cached pre-write answer.
  assert.ok(SHEET.Effort.some(r => r[1] === 'S-EFFORT'), 'the Effort row is on the sheet');
});

test('a write to an uncached tab evicts neither cached tab', async () => {
  await warmCaches();

  const note = await call('POST', '/api/coaching-notes', {
    note: 'felt strong today', write_id: 'w_note_1',
  });
  assert.equal(note.status, 200, JSON.stringify(note.body));

  const after = rangesRead.length;
  await call('GET', '/api/plan/intent-recommendation');
  await call('GET', '/api/prs/recent');
  assert.equal(readsOf('Effort', after), 0, 'a Coaching_Notes write makes no Effort row stale');
  assert.equal(readsOf('Log_Cleaned', after), 0, 'a Coaching_Notes write makes no log row stale');
});

test('an undo evicts Log_Cleaned — the rows it deleted must not be served again', async () => {
  await warmCaches();

  const write = await call('POST', '/api/log-workout', {
    date: '2026-08-06', session_id: 'S-UNDO', write_id: 'w_undo_target', log_rows: [logRow],
  });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  const range = write.body.data.logAppendedRange;

  // Re-warm so the eviction under test is the UNDO's, not the Save's.
  await call('GET', '/api/prs/recent');
  const before = rangesRead.length;
  await call('GET', '/api/prs/recent');
  assert.equal(readsOf('Log_Cleaned', before), 0, 'Log_Cleaned must be warm before the undo');

  const undo = await call('POST', '/api/log-workout/undo-last', {
    log_appended_range: range, session_id: 'S-UNDO', rows_to_delete: 1, confirm_delete: true,
    write_id: 'w_undo_1',
  });
  assert.equal(undo.status, 200, JSON.stringify(undo.body));

  const after = rangesRead.length;
  await call('GET', '/api/prs/recent');
  assert.ok(readsOf('Log_Cleaned', after) > 0,
    'deleted rows must never be served from cache');
});

// A PARTIAL write is where under-eviction hides. `/api/complete-workout` appends the log
// rows and then the effort row; when the second throws, the first is already on the sheet.
// Every branch after that throw — including the one reached when idempotency is off, which
// used to invalidate nothing at all — must drop what actually landed.
test('a partial complete-workout write still evicts the tab whose rows landed', async () => {
  await warmCaches();

  failAppendsTo.add('Effort');
  let response;
  try {
    const form = new FormData();
    form.append('session_id', 'S-PARTIAL');
    form.append('write_id', 'w_partial_1');
    form.append('date', '2026-08-06');
    form.append('log_rows_json', JSON.stringify([
      { exercise: 'Back Squat', set_number: 1, weight: 245, reps: 5, rir: 2 },
    ]));
    form.append('effort_json', JSON.stringify({
      duration: '42', activeCalories: 410, totalCalories: 520, averageHR: 148, peakHR: 171,
    }));
    response = await fetch(`${baseUrl}/api/complete-workout`, {
      method: 'POST', headers: { 'x-atlas-api-key': 'test-api-key' }, body: form,
    });
  } finally {
    failAppendsTo.delete('Effort');
  }

  // The request fails — that is the point. What must NOT fail with it is the cache.
  assert.ok(response.status >= 400, `the effort append was refused, so this must fail: ${response.status}`);
  assert.ok(SHEET.Log_Cleaned.some(row => row[1] === 'S-PARTIAL'),
    'the log rows really did land before the throw');

  const after = rangesRead.length;
  await call('GET', '/api/prs/recent');
  assert.ok(readsOf('Log_Cleaned', after) > 0,
    'rows that landed before a partial failure must never be served from a pre-write cache');
});

// The safety default. A call site that does not say what it wrote must still be correct,
// because under-eviction serves a stale read after a write and over-eviction only costs one.
test('invalidateSheetRowsCache with no arguments still clears everything', async () => {
  const marker = await warmCaches();
  assert.ok(marker > 0);

  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  const start = src.indexOf('function invalidateSheetRowsCache(');
  const fn = src.slice(start, start + 800);
  assert.match(fn, /tabsWritten\.length === 0/, 'the no-argument case must be handled explicitly');
  assert.match(fn, /sheetRowsCache = createTtlCache\(SHEET_ROWS_TTL_MS\)/,
    'the no-argument case must swap in a fresh cache, dropping every entry');

  // And no call site may silently under-evict: every one names a tab, or names none.
  const calls = [...src.matchAll(/invalidateSheetRowsCache\(([^)]*)\)/g)]
    .map(m => m[1].trim())
    .filter((_, i, all) => all.length > 0);
  assert.ok(calls.length >= 8, `expected the known call sites, found ${calls.length}`);
});
