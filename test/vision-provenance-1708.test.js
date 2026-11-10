'use strict';

// Issue #1708 — vision-invented duration enters the Effort preview and the
// approved write (Astra boundary audit, 6 CONFIRMED P1s; audit probes
// A_IMAGE_LIE / D_IMAGE_TO_RECORD).
//
// The audit probe: a blank 1x1 PNG — no visible metrics — produced an
// invented duration 09:47:13 (same for both providers), returned in
// parsed.duration and the Effort preview row; on approval the value was
// written to the Effort tab (with derived metrics) without another vision
// call. The write validator rejects malformed duration syntax but accepts a
// valid-looking invented duration.
//
// The fix direction (smallest): keep model-extracted metrics outside
// authoritative numeric fields until deterministic extraction or explicit
// user-entered values establish their source. Formatting validation alone
// cannot establish provenance.
//
// These are live-route tests: the stubbed vision provider returns the audit's
// invented values for the blank image, and the routes must never let those
// values into the authoritative Effort row (preview or written). The invented
// numbers stay visible as explicitly-unverified suggestions; only
// user-entered effort (effort_json) may populate the row.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetIdempotencyStore } = require('../services/idempotency');
const { logCleanedColumns, effortColumns } = require('../config/columns');

process.env.ATLAS_API_KEY = 'test-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';

// The audit input: a blank 1x1 PNG with no visible metrics.
const BLANK_1X1_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64'
);

// The audit's invented values, verbatim (A_IMAGE_LIE / D_IMAGE_TO_RECORD).
// The stubbed provider returns these for the blank image, exactly as the
// real providers did in the audit.
const INVENTED = {
  date: '2026-11-09',
  duration: '09:47:13',
  activeCalories: 750,
  totalCalories: 900,
  averageHR: 120,
  peakHR: 155,
  workoutType: 'Strength Training'
};

const fakeVision = {
  parseWorkoutScreenshot: async () => {
    return { status: 'image received', parsed_metrics: { ...INVENTED } };
  }
};
const visionPath = require.resolve('../services/vision');
require.cache[visionPath] = {
  id: visionPath, filename: visionPath, loaded: true, exports: fakeVision
};

const catalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench press|bench']
];

const sheetsState = {
  appendCalls: [],
  allowAppend: false,
  effortSessionIds: [],
  logCompositeKeys: []
};

const fakeSheets = {
  appendRows: async (tabName, rows) => {
    sheetsState.appendCalls.push({ tabName, rows });
    if (!sheetsState.allowAppend) {
      throw new Error('appendRows should not be called by tests that do not allow live writes');
    }
    return { data: { updates: { updatedRange: `${tabName}!A100:K100`, updatedRows: rows.length } } };
  },
  readRange: async () => [],
  deleteRowsByRange: async () => {},
  validateConfig: () => {},
  getExerciseCatalog: async () => catalogRows,
  getEffortSessionIds: async () => [...sheetsState.effortSessionIds],
  getLogCompositeKeys: async () => [...sheetsState.logCompositeKeys],
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getHeaderRow: async (tabName) => {
    if (tabName === 'Log_Cleaned') return [...logCleanedColumns];
    if (tabName === 'Effort') return [...effortColumns];
    return [];
  },
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Exercise_Catalog', 'Effort'],
  sheetsReadFailureClass: () => null,
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort'
};
require.cache[require.resolve('../sheets')] = {
  id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets
};

const { app } = require('../index');

let server;
let baseUrl;

test.before(async () => {
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

test.beforeEach(() => {
  resetIdempotencyStore();
  sheetsState.appendCalls.length = 0;
  sheetsState.allowAppend = false;
  sheetsState.effortSessionIds.length = 0;
  sheetsState.logCompositeKeys.length = 0;
});

async function requestMultipart(path, form) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    body: form,
    headers: { 'x-atlas-api-key': process.env.ATLAS_API_KEY }
  });
  const body = await response.json();
  return { response, body };
}

function blankPngForm(extra = {}) {
  const form = new FormData();
  form.append('image', new File([BLANK_1X1_PNG], 'blank.png', { type: 'image/png' }));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

const LOG_ROWS = JSON.stringify([
  { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2, notes: '' }
]);

// Effort row shape: [date, session, duration, activeCal, totalCal, avgHR, peakHR, location, notes]
function effortRowOf(appendCalls) {
  const call = appendCalls.find((c) => c.tabName === 'Effort');
  assert.ok(call, 'expected an Effort append');
  return call.rows[0];
}

// ---------------------------------------------------------------------------
// A_IMAGE_LIE — the preview must not present invented numbers as the row
// ---------------------------------------------------------------------------
test('A_IMAGE_LIE: parse-workout-image keeps the invented duration out of the preview effort row', async () => {
  const { response, body } = await requestMultipart('/api/parse-workout-image', blankPngForm());
  assert.equal(response.status, 200, JSON.stringify(body));
  const data = body.data;

  // The model output stays visible as a suggestion — the owner can see what
  // the model claimed — but it is explicitly marked unverified.
  assert.equal(data.parsed.duration, '09:47:13');
  assert.equal(data.parsed.provenance, 'vision-unverified');

  // The authoritative-shaped preview row must NOT carry the invented numbers.
  assert.equal(data.effort_row[2], '', 'invented duration must not enter the preview effort row');
  assert.equal(data.effort_row[3], '');
  assert.equal(data.effort_row[4], '');
  assert.equal(data.effort_row[5], '');
  assert.equal(data.effort_row[6], '');
  assert.equal(data.sheet_write, 'skipped');
});

// ---------------------------------------------------------------------------
// D_IMAGE_TO_RECORD — the approved write must not persist invented numbers
// ---------------------------------------------------------------------------
test('D_IMAGE_TO_RECORD: complete-workout live write never writes the invented duration', async () => {
  sheetsState.allowAppend = true;
  const form = blankPngForm({
    session_id: 'AUDIT-D-IMAGE-01',
    date: '2026-11-09',
    write_id: 'audit-d-image-01',
    log_rows_json: LOG_ROWS
  });
  const { response, body } = await requestMultipart('/api/complete-workout', form);
  try {
    assert.equal(response.status, 200, JSON.stringify(body));
    const data = body.data.data;
    assert.equal(data.effort_source, 'screenshot_unverified');
    assert.match((body.data.warnings || []).join(' '), /unverified/i);
    assert.equal(data.log_rows_written, 1, 'the logged sets still save');

    const row = effortRowOf(sheetsState.appendCalls);
    assert.equal(row[1], 'AUDIT-D-IMAGE-01');
    assert.equal(row[2], '', 'invented duration must not be written to the Effort tab');
    assert.equal(row[3], '');
    assert.equal(row[4], '');
    assert.equal(row[5], '');
    assert.equal(row[6], '');
  } finally {
    sheetsState.allowAppend = false;
  }
});

test('D_IMAGE_TO_RECORD preview: file-only preview shows the invented values as unverified suggestions, not as the row', async () => {
  const form = blankPngForm({
    session_id: 'AUDIT-D-IMAGE-02',
    date: '2026-11-09',
    write_id: 'audit-d-image-02',
    log_rows_json: LOG_ROWS,
    test_mode: 'true'
  });
  const { response, body } = await requestMultipart('/api/complete-workout', form);
  assert.equal(response.status, 200, JSON.stringify(body));
  const data = body.data.data;
  assert.equal(data.effort_source, 'screenshot_unverified');
  assert.equal(data.parsed_effort.duration, '09:47:13', 'suggestion stays visible for the owner to verify');
  assert.equal(data.parsed_effort.provenance, 'vision-unverified');
  assert.equal(data.effort_row[2], '', 'preview row stays blank for unverified vision numbers');
  assert.equal(data.test_mode, true);
  assert.equal(data.sheet_written, false);
});

// ---------------------------------------------------------------------------
// The sanctioned source: explicit user-entered values still write
// ---------------------------------------------------------------------------
test('manual effort (user-entered) still writes exactly as entered', async () => {
  sheetsState.allowAppend = true;
  const form = new FormData();
  form.append('session_id', 'MANUAL-EFFORT-01');
  form.append('date', '2026-11-09');
  form.append('write_id', 'manual-effort-01');
  form.append('log_rows_json', LOG_ROWS);
  form.append('effort_json', JSON.stringify({
    duration: '00:42:00',
    activeCalories: 410,
    totalCalories: 520,
    averageHR: 148,
    peakHR: 171,
    workoutType: 'Traditional Strength Training'
  }));
  const { response, body } = await requestMultipart('/api/complete-workout', form);
  try {
    assert.equal(response.status, 200, JSON.stringify(body));
    const data = body.data.data;
    assert.equal(data.effort_source, 'manual');
    const row = effortRowOf(sheetsState.appendCalls);
    assert.equal(row[2], '00:42:00');
    assert.equal(row[3], 410);
    assert.equal(row[4], 520);
    assert.equal(row[5], 148);
    assert.equal(row[6], 171);
  } finally {
    sheetsState.allowAppend = false;
  }
});

test('file + effort_json: explicit user-entered effort wins over the vision re-parse', async () => {
  sheetsState.allowAppend = true;
  const form = blankPngForm({
    session_id: 'MANUAL-WINS-01',
    date: '2026-11-09',
    write_id: 'manual-wins-01',
    log_rows_json: LOG_ROWS
  });
  form.append('effort_json', JSON.stringify({
    duration: '00:30:00',
    activeCalories: 300,
    totalCalories: 400,
    averageHR: 130,
    peakHR: 160,
    workoutType: 'Strength Training'
  }));
  const { response, body } = await requestMultipart('/api/complete-workout', form);
  try {
    assert.equal(response.status, 200, JSON.stringify(body));
    const data = body.data.data;
    assert.equal(data.effort_source, 'manual');
    const row = effortRowOf(sheetsState.appendCalls);
    assert.equal(row[2], '00:30:00', 'user-entered duration wins; the invented 09:47:13 must not');
    assert.equal(row[3], 300);
  } finally {
    sheetsState.allowAppend = false;
  }
});

// ---------------------------------------------------------------------------
// Rows without any effort source: the sets still save, effort stays blank
// ---------------------------------------------------------------------------
test('rows-only complete-workout previews the rows with a blank effort row', async () => {
  const form = new FormData();
  form.append('session_id', 'ROWS-ONLY-01');
  form.append('date', '2026-11-09');
  form.append('log_rows_json', LOG_ROWS);
  form.append('test_mode', 'true');
  const { response, body } = await requestMultipart('/api/complete-workout', form);
  assert.equal(response.status, 200, JSON.stringify(body));
  const data = body.data.data;
  assert.equal(data.log_rows_preview.length, 1);
  assert.equal(data.effort_row[2], '');
  assert.equal(data.effort_source, 'none');
});

// ---------------------------------------------------------------------------
// Effort-only screenshot with no user-entered values fails closed
// ---------------------------------------------------------------------------
test('effort-only screenshot with no manual values fails closed on the live write', async () => {
  sheetsState.allowAppend = true;
  const form = blankPngForm({
    session_id: 'AUDIT-D-IMAGE-03',
    date: '2026-11-09',
    write_id: 'audit-d-image-03',
    log_rows_json: JSON.stringify([])
  });
  const { response, body } = await requestMultipart('/api/complete-workout', form);
  try {
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.match(body.message, /manually/i);
    assert.equal(sheetsState.appendCalls.length, 0, 'nothing is written for unverified effort-only');
  } finally {
    sheetsState.allowAppend = false;
  }
});
