'use strict';
// #1791 proving probes — server-enforced preview-to-approve on /api/log-workout.
// Boots the REAL Express app at the PR head with sheets.js stubbed in memory
// (the concurrentDifferentIdSave idiom). No production data, no live Sheets:
// every append lands in the in-memory fake.
//
// P1: a direct live write with no preview_digest is refused (409,
//     preview_digest_required), nothing appended.
// P2: a live write whose rows differ from the previewed digest is refused
//     (409, preview_digest_mismatch), nothing appended.
// P3: a write replaying a STALE digest after a re-preview is refused; the
//     fresh digest writes.
// P4: the approved preview→approve flow still writes, and the live response
//     carries the history flags (e1rm_jump) the preview showed.
// P5: the hard bounds still refuse (2250 lb / 101 reps) — and a bound refusal
//     precedes the digest requirement (400, not 409, with no digest).
// U1–U4: the digest module itself — deterministic mint, tamper evidence,
//     malformed input fails closed.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1791-preview-digest-idempotency.json');

const { resetIdempotencyStore } = require('../services/idempotency');
const { resetSessionClaims } = require('../services/sessionWriteClaim');
const { logCleanedColumns, effortColumns } = require('../config/columns');
const { mintPreviewDigest, verifyPreviewDigest } = require('../services/previewDigest');

const state = { appends: [], logCompositeKeys: [], effortSessionIds: [] };

// Prior-session history the preview/live paths read via getSheetRows(Log_Cleaned):
// Bench Press 135x5, rir 2, session 1791-HIST-01 on 2026-11-10.
// best e1RM = 135 * (1 + 5/30) = 157.5.
// Log_Cleaned column order: date_clean, session_id, exercise, canonical_exercise,
// muscle_group, lift_code, set_number, weight, reps, rir, notes, volume_calc.
const HISTORY_ROWS = [
  ['2026-11-10', '1791-HIST-01', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', 1, 135, 5, 2, '', 787.5],
];

const exerciseCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench|bench press'],
];

function endColumnFor(rows) {
  const width = Math.max(0, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
  let letters = '';
  let n = width;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters || 'A';
}

const fakeSheets = {
  appendRows: async (tab, rows) => {
    state.appends.push({ tab, rows: rows.map(r => [...r]) });
    if (tab === 'Log_Cleaned') {
      for (const row of rows) {
        const key = `${row[1]}||${row[2]}||${row[6]}`.toLowerCase();
        if (!state.logCompositeKeys.includes(key)) state.logCompositeKeys.push(key);
      }
    }
    if (tab === 'Effort') {
      for (const row of rows) {
        if (row[1] && !state.effortSessionIds.includes(String(row[1]))) {
          state.effortSessionIds.push(String(row[1]));
        }
      }
    }
    return { data: { updates: { updatedRange: `${tab}!A100:${endColumnFor(rows)}${99 + rows.length}`, updatedRows: rows.length } } };
  },
  readRange: async () => [],
  updateColumnCells: async () => ({ data: { totalUpdatedCells: 0 } }),
  deleteRowsByRange: async () => ({ ok: true }),
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => [...state.effortSessionIds],
  getLogCompositeKeys: async () => [...state.logCompositeKeys],
  getRecentRows: async () => [],
  getSheetRows: async () => HISTORY_ROWS.map(r => [...r]),
  getHeaderRow: async tab => {
    if (tab === 'Log_Cleaned') return [...logCleanedColumns];
    if (tab === 'Effort') return [...effortColumns];
    return [];
  },
  getSpreadsheetTabs: async () => [
    'Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Constraints', 'Deload_State', 'Session_Plans', 'Session_Plan_Sets',
  ],
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
const post = async (body) => {
  const res = await fetch(`${baseUrl}/api/log-workout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const logRowsWritten = () => state.appends
  .filter(a => a.tab === 'Log_Cleaned').reduce((n, a) => n + a.rows.length, 0);
const benchRows = (sessionId) => state.appends
  .filter(a => a.tab === 'Log_Cleaned').flatMap(a => a.rows)
  .filter(r => String(r[1]) === sessionId)
  .map(r => ({ set: r[6], weight: r[7], reps: r[8], rir: r[9] }));

test.before(async () => {
  resetIdempotencyStore();
  resetSessionClaims();
  server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

test.beforeEach(() => {
  resetIdempotencyStore();
  resetSessionClaims();
});

// P1: direct live write, no preview at all, no digest → 409, nothing appended.
test('P1 — direct live write with no preview_digest is refused', async () => {
  const before = logRowsWritten();
  const live = await post({
    date: '2026-11-19', session_id: '1791-P1',
    write_id: 'w-1791-p1',
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 315, reps: 3, rir: 1 }],
  });
  assert.equal(live.status, 409);
  assert.equal(live.body.details && live.body.details.code, 'preview_digest_required');
  assert.equal(logRowsWritten(), before);
  assert.deepEqual(benchRows('1791-P1'), []);
});

// P2: preview 225x5, then live-write DIFFERENT rows (315x3) with that digest → 409.
test('P2 — live write whose rows differ from the previewed digest is refused', async () => {
  const preview = await post({
    date: '2026-11-19', session_id: '1791-P2', test_mode: true,
    write_id: 'w-1791-p2-preview',
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 }],
  });
  assert.equal(preview.status, 200);
  const digest = preview.body.data && preview.body.data.preview_digest;
  assert.equal(typeof digest, 'string');
  assert.ok(digest.length > 0);

  const before = logRowsWritten();
  const live = await post({
    date: '2026-11-19', session_id: '1791-P2',
    write_id: 'w-1791-p2-live',
    preview_digest: digest,
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 315, reps: 3, rir: 1 }],
  });
  assert.equal(live.status, 409);
  assert.equal(live.body.details && live.body.details.code, 'preview_digest_mismatch');
  assert.equal(logRowsWritten(), before);
  assert.deepEqual(benchRows('1791-P2'), []);
});

// P3: stale digest after a re-preview is refused; the fresh digest writes.
test('P3 — stale digest after re-preview is refused, fresh digest writes', async () => {
  const previewA = await post({
    date: '2026-11-19', session_id: '1791-P3', test_mode: true,
    write_id: 'w-1791-p3-preview-a',
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 }],
  });
  assert.equal(previewA.status, 200);
  const digestA = previewA.body.data.preview_digest;

  const previewB = await post({
    date: '2026-11-19', session_id: '1791-P3', test_mode: true,
    write_id: 'w-1791-p3-preview-b',
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 235, reps: 5, rir: 2 }],
  });
  assert.equal(previewB.status, 200);
  const digestB = previewB.body.data.preview_digest;
  assert.notEqual(digestB, digestA);

  const stale = await post({
    date: '2026-11-19', session_id: '1791-P3',
    write_id: 'w-1791-p3-stale',
    preview_digest: digestA,
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 235, reps: 5, rir: 2 }],
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details && stale.body.details.code, 'preview_digest_mismatch');
  assert.deepEqual(benchRows('1791-P3'), []);

  const live = await post({
    date: '2026-11-19', session_id: '1791-P3',
    write_id: 'w-1791-p3-live',
    preview_digest: digestB,
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 235, reps: 5, rir: 2 }],
  });
  assert.equal(live.status, 200);
  assert.equal(live.body.data.sheet_write, 'success');
  assert.equal(live.body.data.log_rows_written, 1);
  assert.deepEqual(benchRows('1791-P3'), [{ set: 1, weight: 235, reps: 5, rir: 2 }]);
});

// P4: the approved preview→approve flow still writes, and the live response
// carries the history flags the preview showed (e1rm_jump +66.7% vs 135x5).
test('P4 — approved preview→approve writes and surfaces the history flags', async () => {
  const preview = await post({
    date: '2026-11-19', session_id: '1791-P4', test_mode: true,
    write_id: 'w-1791-p4-preview',
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 }],
  });
  assert.equal(preview.status, 200);
  const previewFlags = (preview.body.data.rule_flags || []).map(f => f.rule_id);
  assert.ok(previewFlags.includes('e1rm_jump'), `preview flags: ${previewFlags.join(',')}`);
  const digest = preview.body.data.preview_digest;

  const live = await post({
    date: '2026-11-19', session_id: '1791-P4',
    write_id: 'w-1791-p4-live',
    preview_digest: digest,
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 }],
  });
  assert.equal(live.status, 200);
  assert.equal(live.body.data.sheet_write, 'success');
  assert.equal(live.body.data.log_rows_written, 1);
  const liveFlags = (live.body.data.rule_flags || []).map(f => f.rule_id);
  assert.ok(liveFlags.includes('e1rm_jump'), `live flags: ${liveFlags.join(',')}`);
  assert.deepEqual(benchRows('1791-P4'), [{ set: 1, weight: 225, reps: 5, rir: 2 }]);
});

// P5: the hard bounds still refuse — and a bound refusal precedes the digest
// requirement (400, not 409, with no digest presented).
test('P5 — hard bounds still refuse, before the digest requirement', async () => {
  const before = logRowsWritten();
  const heavy = await post({
    date: '2026-11-19', session_id: '1791-P5-HEAVY',
    write_id: 'w-1791-p5-heavy',
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 2250, reps: 5, rir: 2 }],
  });
  assert.equal(heavy.status, 400);
  assert.match(heavy.body.message || '', /2250/);

  const many = await post({
    date: '2026-11-19', session_id: '1791-P5-MANY',
    write_id: 'w-1791-p5-many',
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 135, reps: 101, rir: 2 }],
  });
  assert.equal(many.status, 400);
  assert.match(many.body.message || '', /101/);
  assert.equal(logRowsWritten(), before);
});

// U1–U4: digest module unit checks.
test('U1 — mint is deterministic for the same rows', () => {
  const fields = {
    sessionId: '1791-U1', date: '2026-11-19',
    logRows: [['2026-11-19', '1791-U1', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', 1, 225, 5, 2, '', 1125]],
    effortRow: null,
  };
  assert.equal(mintPreviewDigest(fields), mintPreviewDigest(fields));
});

test('U2 — verify accepts its own mint and rejects a tampered row', () => {
  const fields = {
    sessionId: '1791-U2', date: '2026-11-19',
    logRows: [['2026-11-19', '1791-U2', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', 1, 225, 5, 2, '', 1125]],
    effortRow: null,
  };
  const digest = mintPreviewDigest(fields);
  assert.equal(verifyPreviewDigest(digest, fields), true);
  const tampered = {
    ...fields,
    logRows: [['2026-11-19', '1791-U2', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', 1, 315, 3, 1, '', 945]],
  };
  assert.equal(verifyPreviewDigest(digest, tampered), false);
  assert.equal(verifyPreviewDigest(digest, { ...fields, sessionId: '1791-OTHER' }), false);
});

test('U3 — malformed digests fail closed, never throw', () => {
  const fields = {
    sessionId: '1791-U3', date: '2026-11-19',
    logRows: [['2026-11-19', '1791-U3', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', 1, 225, 5, 2, '', 1125]],
    effortRow: null,
  };
  for (const bad of [undefined, null, '', 42, {}, [], 'not-a-digest', 'pd1.', 'pd1.!!!']) {
    assert.equal(verifyPreviewDigest(bad, fields), false);
  }
});

test('U4 — a digest for one date does not verify for another', () => {
  const fields = {
    sessionId: '1791-U4', date: '2026-11-19',
    logRows: [['2026-11-19', '1791-U4', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', 1, 225, 5, 2, '', 1125]],
    effortRow: null,
  };
  const digest = mintPreviewDigest(fields);
  assert.equal(verifyPreviewDigest(digest, { ...fields, date: '2026-11-20' }), false);
});
