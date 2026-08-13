'use strict';

// Truthful Save error classification, through the LIVE /api/log-workout and
// /api/complete-workout seams.
//
// F-SB4B qualifying session 1 (2026-08-05, run fsb4b-s1-20260805T122822-04E1C5) died at
// closeout: a Google Sheets read-quota exhaustion inside `enrichAndFormatLogRows` was
// caught by a blanket handler and returned as HTTP 400. 400 says "your payload is
// invalid" and is terminal, so the client never retried and a complete, valid workout
// was lost — while the real cause, an unreachable datastore, was invisible.
//
// The contract these tests hold:
//   • a genuine payload/row rejection stays 400 — owner input really was wrong;
//   • a transient Sheets read failure (quota, 429, 5xx, timeout) is 503 — retryable;
//   • a permanent Sheets failure (revoked credentials, missing spreadsheet) is 5xx,
//     never 400 — it is a server/configuration fault, not the owner's input.
//
// Provenance comes from sheets.js, the single authority: `readWithRetry` stamps its own
// escaping errors and `sheetsReadFailureClass` reports the class. These tests inject
// failures through the REAL `readWithRetry`, so they exercise that authority rather than
// a hand-made stamp — a change that stops stamping, or that reclassifies quota, fails
// here even though the route code is untouched.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';

// The REAL read path, loaded before the stub replaces the module for index.js. Injected
// failures travel through the genuine retry ladder and the genuine classifier.
const realSheets = require('../sheets');

/** Build an error shaped exactly like the one Google returns, then run it through the
 *  REAL readWithRetry so it carries a REAL stamp. `sleep` is injected so an exhausting
 *  retry ladder costs no wall-clock. */
async function failedRead(buildError, { attempts = 1 } = {}) {
  try {
    await realSheets.readWithRetry(
      'Exercise_Catalog!A:Z',
      async () => { throw buildError(); },
      { maxAttempts: attempts, sleep: async () => {} },
    );
    throw new Error('the injected read was supposed to fail');
  } catch (error) {
    return error;
  }
}

// The real Sheets quota rejection: HTTP 403 carrying PERMISSION_DENIED at the top level
// and `userRateLimitExceeded` nested under response.data.error.errors — the exact shape
// sheets.js documents as having once been misread as permanent.
const quotaError = () => Object.assign(new Error(
  "Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user'"
), {
  status: 403,
  response: { status: 403, data: { error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'userRateLimitExceeded' }] } } },
});

const serviceUnavailable = () => Object.assign(new Error('The service is currently unavailable.'), {
  status: 503, response: { status: 503, data: { error: { status: 'UNAVAILABLE' } } },
});

// A revoked service account: 403 with NO rate-limit reason. Permanent — retrying is futile.
const revokedCredentials = () => Object.assign(new Error('The caller does not have permission'), {
  status: 403,
  response: { status: 403, data: { error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'forbidden' }] } } },
});

// ── the stub index.js sees ────────────────────────────────────────────────────
const catalog = {
  // Default: a healthy catalog. Individual tests swap in a thrower.
  read: async () => [['Exercise', 'Muscle_Group', 'Lift_Code'], ['Back Squat', 'Legs', 'SQ01']],
};
const appended = [];
const fakeSheets = {
  ...realSheets,
  validateConfig: () => {},
  getExerciseCatalog: async () => catalog.read(),
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getHeaderRow: async () => [],
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
  appendRows: async (...args) => { appended.push(args); return { updates: { updatedRange: 'Log_Cleaned!A2:K2' } }; },
  deleteRowsByRange: async () => {},
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
require.cache[require.resolve('../sheets')] = {
  id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets,
};
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true,
  exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) },
};

// The exercise catalog reads Supabase (OWNER CORRECTION 2026-08-13). Stubbed here so
// the suite never opens a database connection; it delegates to the sheets fixture above.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
const { app } = require('../index');

let server; let baseUrl;
test.before(async () => {
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  catalog.read = async () => [['Exercise', 'Muscle_Group', 'Lift_Code'], ['Back Squat', 'Legs', 'SQ01']];
  appended.length = 0;
});

const VALID_ROW = { exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 };

async function save(body) {
  const res = await fetch(`${baseUrl}/api/log-workout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify({ date: '2026-08-05', session_id: '20260805-PM-01', test_mode: true, ...body }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('a healthy Save still succeeds — the classifier changes nothing on the happy path', async () => {
  const res = await save({ log_rows: [VALID_ROW] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

// ── 1. genuine owner-input failures KEEP 400 ──────────────────────────────────
test('a genuine row-validation rejection is still 400', async () => {
  // An implausible weight — rejected by validateLogRowsBounds BEFORE any catalog read,
  // so this is unambiguously an input failure with no Sheets involvement.
  const res = await save({ log_rows: [{ ...VALID_ROW, weight: 2250 }] });
  assert.equal(res.status, 400, `implausible input must stay 400, got ${res.status}`);
  assert.match(JSON.stringify(res.body), /implausible/i);
});

test('a malformed payload is still 400', async () => {
  for (const body of [{ log_rows: [] }, { log_rows: 'not-an-array' }, {}]) {
    const res = await save(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} must stay 400, got ${res.status}`);
  }
});

// ── 2. transient Sheets failures become 503 ───────────────────────────────────
for (const [label, build] of [['quota exhaustion', quotaError], ['503 UNAVAILABLE', serviceUnavailable]]) {
  test(`a ${label} during enrichment is 503, not 400`, async () => {
    const stamped = await failedRead(build, { attempts: 3 });
    assert.equal(realSheets.sheetsReadFailureClass(stamped), 'transient',
      'precondition: sheets.js must classify this as transient');
    catalog.read = async () => { throw stamped; };

    const res = await save({ log_rows: [VALID_ROW] });
    assert.equal(res.status, 503,
      `an unreachable datastore must not be reported as invalid input; got ${res.status}`);
    assert.notEqual(res.status, 400);
  });
}

// ── 3. permanent Sheets failures are server-side, never 400 ───────────────────
test('revoked credentials during enrichment are a 5xx, never 400', async () => {
  const stamped = await failedRead(revokedCredentials);
  assert.equal(realSheets.sheetsReadFailureClass(stamped), 'permanent',
    'precondition: a 403 with no rate-limit reason is permanent');
  catalog.read = async () => { throw stamped; };

  const res = await save({ log_rows: [VALID_ROW] });
  assert.ok(res.status >= 500 && res.status < 600,
    `a configuration fault must be a server error, got ${res.status}`);
  assert.notEqual(res.status, 400);
});

test('a malformed range is a 5xx — a server bug is never the owner\'s input', async () => {
  const stamped = await failedRead(() => Object.assign(new Error('Unable to parse range: Exercise_Catalog!!A:Z'), {
    status: 400, response: { status: 400, data: { error: { message: 'Unable to parse range: Exercise_Catalog!!A:Z' } } },
  }));
  assert.equal(realSheets.sheetsReadFailureClass(stamped), 'range_unresolved');
  catalog.read = async () => { throw stamped; };

  const res = await save({ log_rows: [VALID_ROW] });
  assert.ok(res.status >= 500 && res.status < 600,
    `a range this server built wrong is a server fault, got ${res.status}`);
});

// ── 4. the catalog is never fabricated ────────────────────────────────────────
test('a failed catalog read never becomes an empty catalog or a silent success', async () => {
  const stamped = await failedRead(quotaError, { attempts: 3 });
  catalog.read = async () => { throw stamped; };
  const res = await save({ log_rows: [VALID_ROW] });
  assert.notEqual(res.status, 200, 'a failed catalog read must never present as a successful Save');
  assert.equal(appended.length, 0, 'nothing may be appended when the catalog could not be read');
});

// ── 5. the sibling Save path carries the same contract ────────────────────────
test('/api/complete-workout classifies the same way — both Save paths or neither', async () => {
  const stamped = await failedRead(quotaError, { attempts: 3 });
  catalog.read = async () => { throw stamped; };
  // This route is multipart, and it reaches enrichment only with manual effort present
  // (`duration`) plus `log_rows_json` — a JSON body would 400 on shape long before the
  // catalog read, proving nothing.
  const form = new FormData();
  form.set('date', '2026-08-05');
  form.set('session_id', '20260805-PM-01');
  form.set('test_mode', 'true');
  // Complete, VALID effort metrics — so the request clears metric validation and the
  // only thing left that can fail is the catalog read this test is about.
  form.set('effort_json', JSON.stringify({
    duration: '01:00:00', activeCalories: 450, totalCalories: 600, averageHR: 130, peakHR: 165,
  }));
  form.set('log_rows_json', JSON.stringify([VALID_ROW]));
  const res = await fetch(`${baseUrl}/api/complete-workout`, {
    method: 'POST',
    headers: { 'x-atlas-api-key': 'test-api-key' },
    body: form,
  });
  const body = await res.json().catch(() => null);
  assert.notEqual(res.status, 400,
    `the screenshot Save shares the catalog read and must not report quota as bad input; body=${JSON.stringify(body)}`);
  assert.ok(res.status >= 500 && res.status < 600,
    `expected a server-class status, got ${res.status}; body=${JSON.stringify(body)}`);
});

// ── 6. THE MUTATION BITE ──────────────────────────────────────────────────────
// The defect was a blanket `400` in the catch. If provenance ever stops reaching the
// route — the stamp removed, the export dropped, the mapping reverted — every transient
// case above silently returns to 400. This proves the tests above fail for the
// classification and nothing else, by reproducing the ORIGINAL broad catch directly.
test('mutation: the original blanket catch turns the transient cases red', async () => {
  const stamped = await failedRead(quotaError, { attempts: 3 });

  // The pre-fix behaviour, restored literally: one status for every error.
  const originalBroadCatch = () => 400;
  assert.equal(originalBroadCatch(stamped), 400,
    'the original catch answered 400 for a quota exhaustion — that is the defect');

  // The corrected authority, on the same error.
  const corrected = realSheets.sheetsReadFailureClass(stamped) === 'transient' ? 503 : 400;
  assert.equal(corrected, 503);
  assert.notEqual(corrected, originalBroadCatch(stamped),
    'if these ever agree, the fix has been reverted and the 503 assertions above are vacuous');
});

test('mutation: an unstamped error still maps to 400, so provenance is what decides', () => {
  // A validation Error never touched Sheets, so it carries no stamp and keeps 400.
  // This is why the route asks for provenance rather than asking the classifier
  // directly — `classifySheetsReadError` answers "permanent" for this very error.
  const validationError = new Error('Implausible set values rejected — row 1: weight 2250');
  assert.equal(realSheets.sheetsReadFailureClass(validationError), null,
    'an error that never came from a read must carry no provenance');
  assert.equal(realSheets.classifySheetsReadError(validationError), 'permanent',
    'and asking the classifier directly would wrongly call it a server fault — the trap this design avoids');
});
