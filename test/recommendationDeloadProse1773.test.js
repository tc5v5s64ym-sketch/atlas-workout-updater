'use strict';

// #1773 (Astra C-04) — failing-first probes: on an ACTIVE deload, the
// /api/recommend/next card must render its prescription prose from the FINAL
// (deload-overlaid) decision, not from the pre-overlay decision.
//
// Captured defect: final target 170 lb RIR 5 beside rendered prose
// "Repeat 185 × 8 to reconfirm this lift." — the deload overlay cut the
// structured target but left the prose naming the pre-deload load.
//
// Acceptance: four protocols + two just-logged-load variants; every displayed
// number matches the final structured target. The no-deload control pins that
// the legacy prose is untouched when no overlay applies.

const test = require('node:test');
const assert = require('node:assert/strict');

// --- Environment + sheet/vision/coach stubs (require-cache injection, per test/api-smoke.test.js) ---
process.env.ATLAS_API_KEY = 'test-api-key-1773';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
// Not a real key. sheets.js is fully stubbed in these tests, so this value is
// never parsed — it only needs to be present so config validation does not
// trip. Kept free of a literal PEM header so the changed-file secret scan
// does not flag this throwaway stub.
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Mutable per-test sheet state: the harness swaps log/deload rows between cases.
const sheetState = {
  logRows: [],
  deloadRows: [],
};

const fakeSheets = {
  validateConfig: () => {},
  appendRows: async () => { throw new Error('appendRows must not be called by the read-only recommend endpoint'); },
  deleteRowsByRange: async () => {},
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async (tabName) => (tabName === 'Log_Cleaned' ? sheetState.logRows : []),
  getSheetRows: async (tabName) => {
    if (tabName === 'Log_Cleaned') return sheetState.logRows;
    if (tabName === 'Deload_State') return sheetState.deloadRows;
    return [];
  },
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Deload_State', 'Effort'],
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
require.cache[require.resolve('../sheets')] = {
  id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets,
};

const fakeVision = { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) };
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: fakeVision,
};

const fakeCoach = {
  isConfigured: () => false,
  coachModel: () => 'gemini-2.5-flash-lite',
  generateCoachMessage: async () => null,
  generatePlanMessage: async () => null,
  generateChatReply: async () => ({ reply: null }),
  sanitizeFacts: (f) => f,
};
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true, exports: fakeCoach,
};

const originalConsoleLog = console.log;
const { app, invalidateSheetRowsCache } = require('../index');

let server;
let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  } finally {
    console.log = originalConsoleLog;
  }
});

async function getRecommendation(query = '', liftCode = 'BEN01') {
  // The route caches Log_Cleaned reads for 30 s (index.js sheetRowsCache);
  // evict it so each case reads the fixture rows this test just installed.
  invalidateSheetRowsCache();
  const res = await fetch(`${baseUrl}/api/recommend/next/${liftCode}${query}`, {
    headers: { 'x-atlas-api-key': process.env.ATLAS_API_KEY },
  });
  const body = await res.json();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  assert.ok(body.data, 'response must carry data');
  return body.data;
}

// Two sessions of 185 x 8 (RIR 2), last one `lastDaysAgo` days back. The
// stable-reps progression branch would say "Increase to 190"; the staleness
// guard (gap > 10 days) overrides it to "Repeat 185 x 8 to reconfirm".
function staleHistory(lastDaysAgo = 14) {
  return [
    [daysAgo(lastDaysAgo + 7), 'S-PRIOR', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '185', '8', '2', ''],
    [daysAgo(lastDaysAgo), 'S-LAST', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '185', '8', '2', ''],
  ];
}

// Recent history (2 days back) for the just-logged variants, so staleness
// never fires and the just-logged anchor is the prose source.
function recentHistory() {
  return [
    [daysAgo(9), 'S-PRIOR', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '185', '8', '2', ''],
    [daysAgo(2), 'S-LAST', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '185', '8', '2', ''],
  ];
}

function deloadRow(protocolId) {
  // deloadStateColumns order: updated_at, training_state, deload_protocol,
  // deload_reason, deload_start_date, deload_sessions_remaining, deload_exit_criteria
  return [['2026-11-20T00:00:00.000Z', 'DELOAD_ACTIVE', protocolId, 'fatigue', '2026-11-20', '1', '']];
}

function normalRow() {
  return [['2026-11-20T00:00:00.000Z', 'NORMAL', '', '', '', '0', '']];
}

// Every displayed number must match the final structured target: the prose
// names the final weight and reps at the final RIR, and the stale pre-overlay
// load appears nowhere in the prose or the reasoning.
function assertProseMatchesFinalTarget(data, { weight, reps, rir, staleWeight }) {
  assert.equal(data.next_target.weight, weight, 'structured weight is the deload target');
  assert.equal(data.next_target.reps, reps, 'structured reps are unchanged by the overlay');
  assert.equal(data.target_rir, rir, 'structured RIR is the protocol RIR');
  assert.match(data.recommendation, new RegExp(`${weight} × ${reps}`), 'prose names the final weight and reps');
  assert.match(data.recommendation, new RegExp(`RIR ${rir}`), 'prose names the final RIR');
  assert.doesNotMatch(data.recommendation, new RegExp(`\\b${staleWeight}\\b`), 'prose must not name the stale pre-overlay load');
  assert.doesNotMatch(data.reasoning, new RegExp(`\\b${staleWeight}\\b`), 'reasoning must not name the stale pre-overlay load');
  assert.match(data.reasoning, new RegExp(`${weight}`), 'reasoning names the final weight');
}

// Four protocols, staleness prose source: 185 x 0.92 -> 170, 0.85 -> 155,
// 0.90 -> 165, 0.80 -> 150 (rounded to the 5 lb rack step).
const PROTOCOL_CASES = [
  { id: 'STRENGTH_DELOAD_V1', weight: 170, rir: 5 },
  { id: 'HYPERTROPHY_DELOAD_V1', weight: 155, rir: 5 },
  { id: 'POWER_DELOAD_V1', weight: 165, rir: 4 },
  { id: 'ENDURANCE_DELOAD_V1', weight: 150, rir: 5 },
];

for (const { id, weight, rir } of PROTOCOL_CASES) {
  test(`#1773 ${id}: stale prose re-renders from the deload target (${weight} x 8, RIR ${rir})`, async () => {
    sheetState.logRows = staleHistory(14);
    sheetState.deloadRows = deloadRow(id);
    const data = await getRecommendation();
    assert.equal(data.deload.in_deload, true, 'deload must be active in the fixture');
    assert.equal(data.deload.protocol_id, id, 'fixture protocol must be the one applied');
    assertProseMatchesFinalTarget(data, { weight, reps: 8, rir, staleWeight: 185 });
  });
}

test('#1773 just-logged A (RIR 5, room to progress): prose re-renders from the deload target, not the 190 lb step-up', async () => {
  // The anchor steps the working weight to 190 first; the overlay scales THAT
  // decision (190 x 0.92 = 174.8 -> 175). The prose must name the final 175,
  // never the pre-overlay 190.
  sheetState.logRows = recentHistory();
  sheetState.deloadRows = deloadRow('STRENGTH_DELOAD_V1');
  const data = await getRecommendation('?w=185&reps=8&rir=5');
  assert.equal(data.deload.in_deload, true, 'deload must be active in the fixture');
  assertProseMatchesFinalTarget(data, { weight: 175, reps: 8, rir: 5, staleWeight: 190 });
});

test('#1773 just-logged B (no RIR, repeat to learn effort): prose re-renders from the deload target, not the logged 185 lb', async () => {
  sheetState.logRows = recentHistory();
  sheetState.deloadRows = deloadRow('STRENGTH_DELOAD_V1');
  const data = await getRecommendation('?w=185&reps=8');
  assert.equal(data.deload.in_deload, true, 'deload must be active in the fixture');
  assertProseMatchesFinalTarget(data, { weight: 170, reps: 8, rir: 5, staleWeight: 185 });
});

test('#1773 control (no deload): legacy staleness prose is untouched', async () => {
  sheetState.logRows = staleHistory(14);
  sheetState.deloadRows = normalRow();
  const data = await getRecommendation();
  assert.equal(data.deload.in_deload, false, 'no deload must be active in the control');
  assert.equal(data.recommendation, 'Repeat 185 × 8 to reconfirm this lift.');
  assert.equal(data.next_target.weight, 185);
  assert.equal(data.next_target.reps, 8);
});

// --- Variant probing (#1773): the overlay is prose-source-agnostic — every
// legacy prose branch must re-render from the final decision, not just the
// staleness and just-logged branches in the acceptance list. ---

function recentHistoryWithRir(lastRir) {
  return [
    [daysAgo(9), 'S-PRIOR', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '185', '8', '2', ''],
    [daysAgo(2), 'S-LAST', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '185', '8', String(lastRir), ''],
  ];
}

test('#1773 variant V1 (progression "Increase to 190"): prose re-renders from the deload target 175', async () => {
  sheetState.logRows = recentHistoryWithRir(2);
  sheetState.deloadRows = deloadRow('STRENGTH_DELOAD_V1');
  const data = await getRecommendation();
  assert.equal(data.deload.in_deload, true);
  assertProseMatchesFinalTarget(data, { weight: 175, reps: 8, rir: 5, staleWeight: 190 });
});

test('#1773 variant V2 (hold at failure, RIR 0): prose re-renders from the deload target 170', async () => {
  sheetState.logRows = recentHistoryWithRir(0);
  sheetState.deloadRows = deloadRow('STRENGTH_DELOAD_V1');
  const data = await getRecommendation();
  assert.equal(data.deload.in_deload, true);
  assertProseMatchesFinalTarget(data, { weight: 170, reps: 8, rir: 5, staleWeight: 185 });
});

test('#1773 variant V3 (add-a-rep, RIR 1): prose re-renders from the deload target 170 x 9', async () => {
  sheetState.logRows = recentHistoryWithRir(1);
  sheetState.deloadRows = deloadRow('STRENGTH_DELOAD_V1');
  const data = await getRecommendation();
  assert.equal(data.deload.in_deload, true);
  assertProseMatchesFinalTarget(data, { weight: 170, reps: 9, rir: 5, staleWeight: 185 });
});

test('#1773 variant V4 (recovery intent caps at today): prose re-renders from the deload target 170', async () => {
  sheetState.logRows = recentHistoryWithRir(2);
  sheetState.deloadRows = deloadRow('STRENGTH_DELOAD_V1');
  const data = await getRecommendation('?intentId=recovery_pump');
  assert.equal(data.deload.in_deload, true);
  assertProseMatchesFinalTarget(data, { weight: 170, reps: 8, rir: 5, staleWeight: 185 });
});

test('#1773 variant V5 (post-deload recovery "back to 205" while still active): prose re-renders from the deload target 190', async () => {
  // Three sessions: established 205, then a noted deload session at 170 two
  // days ago. The legacy recovery branch promises "back to 205" — but the
  // deload is still ACTIVE, so the overlay must win: 205 x 0.92 = 188.6 -> 190.
  sheetState.logRows = [
    [daysAgo(21), 'S-OLD', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '205', '5', '2', ''],
    [daysAgo(14), 'S-MID', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '205', '5', '2', ''],
    [daysAgo(2), 'S-LAST', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '170', '8', '2', 'deload'],
  ];
  sheetState.deloadRows = deloadRow('STRENGTH_DELOAD_V1');
  const data = await getRecommendation();
  assert.equal(data.deload.in_deload, true);
  assertProseMatchesFinalTarget(data, { weight: 190, reps: 8, rir: 5, staleWeight: 205 });
});

test('#1773 variant V6 (bodyweight, no usable load): no overlay, prose untouched, no crash', async () => {
  sheetState.logRows = [
    [daysAgo(21), 'S-PRIOR', 'Push-Up', 'Push-Up', 'Chest', 'PU01', '1', '', '12', '', ''],
    [daysAgo(14), 'S-LAST', 'Push-Up', 'Push-Up', 'Chest', 'PU01', '1', '', '12', '', ''],
  ];
  sheetState.deloadRows = deloadRow('STRENGTH_DELOAD_V1');
  const data = await getRecommendation('', 'PU01');
  assert.equal(data.deload.in_deload, true);
  assert.equal(data.recommendation, 'Repeat 12 reps to reconfirm this lift.');
  assert.equal(data.next_target.weight, 0);
  assert.equal(data.next_target.reps, 12);
});

test('#1773 variant V7 (no history, just-logged anchor): prose re-renders from the deload target, layoff clause dropped', async () => {
  sheetState.logRows = [];
  sheetState.deloadRows = deloadRow('STRENGTH_DELOAD_V1');
  const data = await getRecommendation('?w=185&reps=8&rir=5');
  assert.equal(data.deload.in_deload, true);
  assertProseMatchesFinalTarget(data, { weight: 175, reps: 8, rir: 5, staleWeight: 190 });
  assert.doesNotMatch(data.reasoning, /Last trained/, 'no history means no layoff clause');
});

test('#1773 variant V8 (no history, no just-logged set): no target, no overlay, no crash', async () => {
  sheetState.logRows = [];
  sheetState.deloadRows = deloadRow('STRENGTH_DELOAD_V1');
  const data = await getRecommendation();
  assert.equal(data.deload.in_deload, true);
  assert.equal(data.next_target, null);
  assert.equal(data.recommendation, 'No recent working sets found for this lift code.');
});
