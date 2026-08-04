'use strict';

// ── The ONE Sheets read-failure authority ─────────────────────────────────────
//
// `sheets.js` used to classify nothing about a failed READ. Every read helper was a
// bare API call that threw an unclassified error, so five callers each invented
// their own meaning for it — `driftShadow` message-matched, three writers read ANY
// failure as "the tab does not exist", and every `routes/reads.js` handler read ANY
// failure as a hard 500. This file pins the replacement: one classifier, three kinds,
// and a bounded retry that exists only on the read side.
//
// Two things here are worth more than the rest.
//
// 1. A read is IDEMPOTENT and an append is NOT. The append guard
//    (`isTransientAppendError`) deliberately refuses to retry a 500/503/timeout,
//    because the row may already be committed and a retry would double-write. Those
//    same statuses are SAFE to retry on a read. The two predicates must therefore
//    DISAGREE on exactly those statuses, and the last test in this file asserts that
//    disagreement directly — collapsing them into one shared predicate is the obvious
//    "simplification" that would silently reintroduce the double-append.
//
// 2. `tab_missing` must be provable, not guessed. It is a member of
//    VERIFIED_EMPTY_SEAL_REASONS (services/turnWriteArtifact.js), so a transient
//    outage misread as a missing tab can present an unverified closeout as a
//    VERIFIED-empty ledger. Only Google's own range-parse rejection may produce it —
//    never a loose "not found", which is also how a missing SPREADSHEET reads.

const test = require('node:test');
const assert = require('node:assert/strict');

// Env captured by sheets.js at load — set unconditionally so this file is hermetic.
process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';

// ── Fake googleapis: `valuesGetPlan` is a queue of outcomes, one per call, so a
// test can spell out "fail, fail, then succeed" and then COUNT the calls. ────────
const calls = { valuesGet: [], spreadsheetsGet: [] };
let valuesGetPlan = [];
let spreadsheetsGetPlan = [];

function nextFrom(plan, fallback) {
  const step = plan.length ? plan.shift() : fallback;
  if (step instanceof Error) return Promise.reject(step);
  return Promise.resolve(step);
}

const fakeSheetsClient = {
  spreadsheets: {
    get: async (args) => {
      calls.spreadsheetsGet.push(args);
      return nextFrom(spreadsheetsGetPlan, { data: { sheets: [] } });
    },
    batchUpdate: async () => ({ data: {} }),
    values: {
      get: async (args) => {
        calls.valuesGet.push(args);
        return nextFrom(valuesGetPlan, { data: { values: [] } });
      },
      append: async () => ({ data: { updates: {} } }),
      update: async () => ({ data: {} })
    }
  }
};

const fakeGoogle = {
  auth: { GoogleAuth: class { async getClient() { return {}; } } },
  sheets: () => fakeSheetsClient
};

const googleapisPath = require.resolve('googleapis');
require.cache[googleapisPath] = {
  id: googleapisPath,
  filename: googleapisPath,
  loaded: true,
  exports: { google: fakeGoogle }
};

const sheets = require('../sheets');
const { classifySheetsReadError, isTransientReadError, isTabMissingError } = sheets;

test.beforeEach(() => {
  calls.valuesGet.length = 0;
  calls.spreadsheetsGet.length = 0;
  valuesGetPlan = [];
  spreadsheetsGetPlan = [];
});

// Realistic error shapes. gaxios (googleapis) puts the HTTP status on `.status` and
// `.response.status`, and the transport cause on `.code`.
const gaxios = (status, message, extra = {}) => Object.assign(new Error(message), {
  status,
  response: { status, data: { error: { status: extra.reason || '', message } } },
  ...(extra.errors ? { errors: extra.errors } : {})
});
const transport = (code, message) => Object.assign(new Error(message), { code });

// ── tab_missing: only Google's range-parse rejection ──────────────────────────

test('a range-parse rejection is tab_missing — the wording Google actually returns', () => {
  assert.equal(classifySheetsReadError(new Error('Unable to parse range: Session_Plans!A1:M1')), 'tab_missing');
  assert.equal(isTabMissingError(new Error('Unable to parse range: Session_Plans!A1:M1')), true);
});

test('tab_missing is recognized when the wording is nested in the API error body, not the JS message', () => {
  const e = Object.assign(new Error('Request failed with status code 400'), {
    status: 400,
    response: { status: 400, data: { error: { status: 'INVALID_ARGUMENT', message: 'Unable to parse range: Ghost_Tab!A1' } } }
  });
  assert.equal(classifySheetsReadError(e), 'tab_missing');
});

// The dangerous false positive. `tab_missing` is a VERIFIED_EMPTY_SEAL_REASON, so
// every one of these must stay OUT of it: each means the deployment is wrong, not
// that one optional tab is absent. The regex this replaced matched "not found" and
// "does not exist" and therefore mislabelled all three.
test('a missing SPREADSHEET, a revoked account, and a wrong id are NEVER tab_missing', () => {
  const notTabMissing = [
    gaxios(404, 'Requested entity was not found.'),
    gaxios(403, 'The caller does not have permission'),
    gaxios(401, 'Request had invalid authentication credentials'),
    new Error('Sheet does not exist'),
    new Error('no such spreadsheet'),
  ];
  for (const e of notTabMissing) {
    assert.notEqual(classifySheetsReadError(e), 'tab_missing', `must not read as tab_missing: ${e.message}`);
  }
});

// ── transient vs permanent ────────────────────────────────────────────────────

test('the ambiguous upstream statuses are transient for a READ', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(classifySheetsReadError(gaxios(status, 'upstream')), 'transient', `HTTP ${status}`);
  }
});

test('a 403 is transient ONLY when Google names rate limiting or quota', () => {
  assert.equal(classifySheetsReadError(gaxios(403, 'Quota exceeded', { reason: 'RESOURCE_EXHAUSTED' })), 'transient');
  assert.equal(classifySheetsReadError(gaxios(403, 'rateLimitExceeded', { errors: [{ reason: 'rateLimitExceeded' }] })), 'transient');
  // A revoked service account is permanent — retrying it three times only delays the
  // truthful failure by a second.
  assert.equal(classifySheetsReadError(gaxios(403, 'The caller does not have permission')), 'permanent');
});

// The REAL shape of a Sheets per-user rate limit, and the reason the reason-signals
// are tested together instead of in `first || second` order. Google sends HTTP 403
// with `error.status: 'PERMISSION_DENIED'` AND the actual cause in
// `error.errors[0].reason`, nested under `response.data.error` — not on the error
// object. A short-circuit on the truthy 'PERMISSION_DENIED' therefore never reads the
// field that mattered, and the most common retryable failure in production was
// classified permanent: no retry, and a hard 500 out of the read routes.
test('a 403 quota rejection is transient even when its status says PERMISSION_DENIED', () => {
  const e = Object.assign(new Error('Quota exceeded for quota metric \'Read requests\''), {
    status: 403,
    response: {
      status: 403,
      data: {
        error: {
          code: 403,
          status: 'PERMISSION_DENIED',
          message: 'Quota exceeded for quota metric \'Read requests\'',
          errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded', message: 'User Rate Limit Exceeded' }],
        }
      }
    }
  });
  assert.equal(classifySheetsReadError(e), 'transient');

  // …and the nested reason alone is enough, even when no message names quota — the
  // signals must be read, not merely the first truthy one.
  const reasonOnly = {
    status: 403,
    message: 'Request failed with status code 403',
    response: {
      status: 403,
      data: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Forbidden', errors: [{ reason: 'rateLimitExceeded' }] } }
    }
  };
  assert.equal(classifySheetsReadError(reasonOnly), 'transient');

  // The guard against over-correcting: a genuine permission denial carries no quota
  // signal anywhere, and must stay permanent.
  const denied = Object.assign(new Error('The caller does not have permission'), {
    status: 403,
    response: {
      status: 403,
      data: {
        error: {
          code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission',
          errors: [{ domain: 'global', reason: 'forbidden', message: 'The caller does not have permission' }],
        }
      }
    }
  });
  assert.equal(classifySheetsReadError(denied), 'permanent');
});

// A request timeout is the server saying it stopped waiting for the request. For an
// idempotent read that is the textbook retry; the explicit-status branch below would
// otherwise call it permanent before the timeout-message check could ever run.
test('HTTP 408 is a transient READ failure', () => {
  assert.equal(classifySheetsReadError(gaxios(408, 'Request Timeout')), 'transient');
  assert.equal(isTransientReadError(gaxios(408, 'Request Timeout')), true);
});

test('a transport failure with no HTTP status at all is transient', () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED']) {
    assert.equal(classifySheetsReadError(transport(code, 'network')), 'transient', code);
  }
  assert.equal(classifySheetsReadError(new Error('socket hang up')), 'transient');
});

test('a 400 that is not a range-parse rejection is permanent, and so is a null error', () => {
  assert.equal(classifySheetsReadError(gaxios(400, 'Invalid value at requestBody')), 'permanent');
  assert.equal(classifySheetsReadError(null), 'permanent');
  assert.equal(classifySheetsReadError(undefined), 'permanent');
});

// The status must be read BEFORE `.code`. On a gaxios error `.code` is the transport
// cause and is non-numeric, so reading it first turns a real 503 into NaN and silently
// skips the retry — the same defect the append guard documents at the top of sheets.js.
test('an error carrying BOTH an HTTP status and a transport code is classified by the status', () => {
  const e = Object.assign(gaxios(503, 'Backend Error'), { code: 'ERR_BAD_RESPONSE' });
  assert.equal(classifySheetsReadError(e), 'transient');
  const permanent = Object.assign(gaxios(404, 'Requested entity was not found.'), { code: 'ERR_BAD_REQUEST' });
  assert.equal(classifySheetsReadError(permanent), 'permanent');
});

// ── the bounded retry, proven through a REAL read helper ──────────────────────

test('a read helper RETRIES a transient failure and returns the eventual success', async () => {
  valuesGetPlan = [
    gaxios(503, 'Backend Error'),
    gaxios(429, 'Quota exceeded'),
    { data: { values: [['h1'], ['r1']] } },
  ];
  const out = await sheets.getRecentRows('Log_Cleaned', 10);
  assert.deepEqual(out, [['r1']], 'the caller sees the successful read, not the outage');
  assert.equal(calls.valuesGet.length, 3, 'two retries, then success');
});

test('the retry is BOUNDED — it gives up and rethrows rather than looping', async () => {
  valuesGetPlan = [
    gaxios(503, 'Backend Error'),
    gaxios(503, 'Backend Error'),
    gaxios(503, 'Backend Error'),
    gaxios(503, 'Backend Error'),
    { data: { values: [['h1'], ['r1']] } },
  ];
  await assert.rejects(() => sheets.getRecentRows('Log_Cleaned', 10), /Backend Error/);
  assert.equal(calls.valuesGet.length, 3, 'exactly 3 attempts — the fourth outcome is never reached');
});

test('a PERMANENT failure is not retried at all — one attempt, then the truthful error', async () => {
  valuesGetPlan = [gaxios(404, 'Requested entity was not found.')];
  await assert.rejects(() => sheets.getRecentRows('Log_Cleaned', 10), /not found/);
  assert.equal(calls.valuesGet.length, 1);
});

test('a MISSING TAB is not retried either — it is a durable fact, not an outage', async () => {
  valuesGetPlan = [new Error('Unable to parse range: Ghost!A:Z')];
  await assert.rejects(() => sheets.getRecentRows('Ghost', 10), /Unable to parse range/);
  assert.equal(calls.valuesGet.length, 1);
});

// Every read helper, not just the one above — a helper added later without the
// wrapper is the drift this test exists to catch.
test('EVERY read helper retries a transient failure', async () => {
  const cases = [
    ['readRange', () => sheets.readRange('Tab!A1:B2'), 'valuesGet'],
    ['getRecentRows', () => sheets.getRecentRows('Tab'), 'valuesGet'],
    ['getSheetRows', () => sheets.getSheetRows('Tab'), 'valuesGet'],
    ['getHeaderRow', () => sheets.getHeaderRow('Tab'), 'valuesGet'],
    ['getExerciseCatalog', () => sheets.getExerciseCatalog(), 'valuesGet'],
    ['getEffortSessionIds', () => sheets.getEffortSessionIds(), 'valuesGet'],
    ['getLogCompositeKeys', () => sheets.getLogCompositeKeys(), 'valuesGet'],
    ['getSpreadsheetTabs', () => sheets.getSpreadsheetTabs(), 'spreadsheetsGet'],
  ];
  for (const [name, invoke, counter] of cases) {
    calls.valuesGet.length = 0;
    calls.spreadsheetsGet.length = 0;
    valuesGetPlan = [];
    spreadsheetsGetPlan = [];
    const plan = counter === 'valuesGet' ? 'valuesGetPlan' : 'spreadsheetsGetPlan';
    const success = counter === 'valuesGet' ? { data: { values: [] } } : { data: { sheets: [] } };
    if (plan === 'valuesGetPlan') valuesGetPlan = [gaxios(503, 'Backend Error'), success];
    else spreadsheetsGetPlan = [gaxios(503, 'Backend Error'), success];
    await invoke();
    assert.equal(calls[counter].length, 2, `${name} must retry a transient read failure`);
  }
});

// TRIPWIRE for the next legitimate repository state. The test above enumerates the
// read helpers, and an enumeration cannot see a helper added tomorrow — it would ship
// unwrapped while every test here stayed green. This pins the exported surface, so
// adding OR removing a read helper fails here and sends the author to the retry test
// above. It deliberately fails on any change rather than trying to guess which new
// exports are reads.
//
// `ensureSheetTab` is intentionally absent from the read list: it CREATES a tab, and
// retrying the probe inside it would change when a schema mutation happens. It is a
// write-path helper that happens to read, and it is out of scope for a read-robustness
// change.
test('the exported read surface is exactly the set proven to retry', () => {
  const READ_HELPERS = [
    'readRange',
    'getExerciseCatalog',
    'getEffortSessionIds',
    'getLogCompositeKeys',
    'getRecentRows',
    'getSheetRows',
    'getHeaderRow',
    'getSpreadsheetTabs',
  ];
  const NON_READ_EXPORTS = [
    'appendRows', 'updateColumnCells', 'deleteRowsByRange', 'ensureSheetTab',
    'validateConfig', 'getSafeSpreadsheetConfig',
    'isTransientAppendError', 'retryWithBackoff',
    'classifySheetsReadError', 'isTransientReadError', 'isTabMissingError', 'readWithRetry',
    'logSheetName', 'effortSheetName',
  ];
  assert.deepEqual(
    Object.keys(sheets).sort(),
    [...READ_HELPERS, ...NON_READ_EXPORTS].sort(),
    'sheets.js exports changed — if a READ helper was added, wrap it in readWithRetry and add it to the retry test above'
  );
});

// ── the append guard and the read guard must DISAGREE ─────────────────────────
//
// This is the test that stops the obvious "simplification". If someone deletes
// isTransientReadError and points the read helpers at isTransientAppendError, every
// other test in this file still passes on the 429 cases — and the 503 retry silently
// disappears. If someone does the reverse and points appendRows at the read
// predicate, appendRows starts retrying an ambiguous 503 and can double-write a
// workout row. The disagreement IS the contract.
test('the read guard retries the ambiguous statuses that the append guard must refuse', () => {
  for (const status of [408, 500, 502, 503, 504]) {
    const e = gaxios(status, 'upstream');
    assert.equal(isTransientReadError(e), true, `read must retry HTTP ${status} — a read is idempotent`);
    assert.equal(sheets.isTransientAppendError(e), false, `append must NEVER retry HTTP ${status} — the row may already be committed`);
  }
});

test('the two guards agree on 429, the one unambiguous pre-write rejection', () => {
  const e = gaxios(429, 'Too many requests');
  assert.equal(isTransientReadError(e), true);
  assert.equal(sheets.isTransientAppendError(e), true);
});
