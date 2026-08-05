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
// 2. `tab_missing` must be PROVEN, not guessed — and no error object can prove it.
//    It is a member of VERIFIED_EMPTY_SEAL_REASONS (services/turnWriteArtifact.js),
//    so a failure misread as a missing tab can present an unverified closeout as a
//    VERIFIED-empty ledger. Google returns "Unable to parse range" both for an absent
//    tab AND for a malformed A1 range, so the classifier answers only the honest
//    `range_unresolved`; absence is established solely by `confirmTabMissing`, which
//    requires that the metadata read SUCCEEDED and that this tab is absent from it.

const test = require('node:test');
const assert = require('node:assert/strict');

// Env captured by sheets.js at load — set unconditionally so this file is hermetic.
process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';

// ── Fake googleapis: `valuesGetPlan` is a queue of outcomes, one per call, so a
// test can spell out "fail, fail, then succeed" and then COUNT the calls. ────────
const calls = { valuesGet: [], spreadsheetsGet: [], valuesBatchGet: [] };
let valuesGetPlan = [];
let spreadsheetsGetPlan = [];
let valuesBatchGetPlan = [];

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
      batchGet: async (args) => {
        calls.valuesBatchGet.push(args);
        return nextFrom(valuesBatchGetPlan, {
          data: { valueRanges: (args.ranges || []).map(range => ({ range, values: [] })) }
        });
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
const { classifySheetsReadError, isTransientReadError, confirmTabMissing } = sheets;

test.beforeEach(() => {
  calls.valuesGet.length = 0;
  calls.spreadsheetsGet.length = 0;
  calls.valuesBatchGet.length = 0;
  valuesGetPlan = [];
  spreadsheetsGetPlan = [];
  valuesBatchGetPlan = [];
  // getExerciseCatalog now holds a bounded cross-request cache. Without this reset a
  // cached catalog from an earlier test would serve the next one WITHOUT a read, and
  // the retry assertions below would silently stop exercising the read path.
  sheets._resetExerciseCatalogCache();
});

// Realistic error shapes. gaxios (googleapis) puts the HTTP status on `.status` and
// `.response.status`, and the transport cause on `.code`.
const gaxios = (status, message, extra = {}) => Object.assign(new Error(message), {
  status,
  response: { status, data: { error: { status: extra.reason || '', message } } },
  ...(extra.errors ? { errors: extra.errors } : {})
});
const transport = (code, message) => Object.assign(new Error(message), { code });

// ── range_unresolved: what the classifier may say, and what it may not ────────

test('a range-parse rejection is range_unresolved — NOT a claim that the tab is absent', () => {
  const e = new Error('Unable to parse range: Session_Plans!A1:M1');
  assert.equal(classifySheetsReadError(e), 'range_unresolved');
  // The classifier never emits tab_missing at all. Absence is not a property of an
  // error object; it is a property of the spreadsheet, established by a second read.
  assert.notEqual(classifySheetsReadError(e), 'tab_missing');
});

test('range_unresolved is recognized when the wording is nested in the API error body, not the JS message', () => {
  const e = Object.assign(new Error('Request failed with status code 400'), {
    status: 400,
    response: { status: 400, data: { error: { status: 'INVALID_ARGUMENT', message: 'Unable to parse range: Ghost_Tab!A1' } } }
  });
  assert.equal(classifySheetsReadError(e), 'range_unresolved');
});

// The dangerous false positive. Every one of these means the deployment is wrong, not
// that one optional tab is absent. The regex this replaced matched "not found" and
// "does not exist" and therefore mislabelled all three.
test('a missing SPREADSHEET, a revoked account, and a wrong id are NEVER range_unresolved', () => {
  const notRangeErrors = [
    gaxios(404, 'Requested entity was not found.'),
    gaxios(403, 'The caller does not have permission'),
    gaxios(401, 'Request had invalid authentication credentials'),
    new Error('Sheet does not exist'),
    new Error('no such spreadsheet'),
  ];
  for (const e of notRangeErrors) {
    assert.equal(classifySheetsReadError(e), 'permanent', `must be permanent: ${e.message}`);
  }
});

// ── confirmTabMissing: absence is proven or it is not claimed ─────────────────
//
// The review that caught this was exact: "Unable to parse range" is also what Google
// returns for a MALFORMED A1 range, and `readRange` takes arbitrary A1 from callers.
// Reading absence off that wording would let a programming error manufacture
// `tab_missing`, which is a VERIFIED_EMPTY_SEAL_REASON — so a bad range could present
// a ledger as verified-empty. Absence now requires both halves: the metadata read
// SUCCEEDED, and the requested tab is not in it.

const RANGE_ERROR = () => new Error('Unable to parse range: Session_Plans!A1:M1');

test('confirmTabMissing is TRUE only when the metadata read succeeded AND the tab is absent', async () => {
  const listTabs = async () => ['Log_Cleaned', 'Effort'];
  assert.equal(await confirmTabMissing(RANGE_ERROR(), 'Session_Plans', { listTabs }), true);
});

test('confirmTabMissing is FALSE when the tab is PRESENT — a malformed range is not absence', async () => {
  // Same error wording, same code path; the only difference is that the spreadsheet
  // actually contains the tab, so the range itself must have been the problem.
  const listTabs = async () => ['Log_Cleaned', 'Session_Plans'];
  const malformed = new Error('Unable to parse range: Session_Plans!A1:%%');
  assert.equal(await confirmTabMissing(malformed, 'Session_Plans', { listTabs }), false);
  assert.equal(await confirmTabMissing(RANGE_ERROR(), 'Session_Plans', { listTabs }), false);
});

test('confirmTabMissing FAILS CLOSED when the metadata read itself fails', async () => {
  for (const boom of [gaxios(503, 'Backend Error'), gaxios(403, 'The caller does not have permission'), new Error('socket hang up')]) {
    const listTabs = async () => { throw boom; };
    assert.equal(await confirmTabMissing(RANGE_ERROR(), 'Session_Plans', { listTabs }), false,
      `could not look ⇒ not evidence of absence: ${boom.message}`);
  }
  // A non-array answer is not a confirmed list either.
  assert.equal(await confirmTabMissing(RANGE_ERROR(), 'Session_Plans', { listTabs: async () => null }), false);
});

test('confirmTabMissing is FALSE without a tab name to confirm against', async () => {
  const listTabs = async () => [];
  for (const name of [undefined, null, '', '   ']) {
    assert.equal(await confirmTabMissing(RANGE_ERROR(), name, { listTabs }), false);
  }
});

test('confirmTabMissing never even looks unless the error was a range failure', async () => {
  let looked = 0;
  const listTabs = async () => { looked += 1; return []; };
  for (const e of [gaxios(503, 'Backend Error'), gaxios(404, 'Requested entity was not found.'), gaxios(429, 'rate'), null]) {
    assert.equal(await confirmTabMissing(e, 'Session_Plans', { listTabs }), false);
  }
  assert.equal(looked, 0, 'a transient or permanent failure must not trigger a metadata probe');
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

test('an UNRESOLVED RANGE is not retried either — repeating it returns the same answer', async () => {
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
    // The batch read is issued by the first read inside a request that declared ranges.
    // It reaches the same API through the same wrapper, so a transient failure must cost
    // it a retry and not a request.
    ['batched read', () => sheets.runWithReadContext(async () => {
      sheets.declareRequestRanges(['Tab!A:Z', 'Other!A:Z']);
      // The batch defers its failure to the read that needs the range, so the value has
      // to be ASKED for before the ladder's outcome is observable.
      await sheets.readRange('Tab!A:Z');
    }), 'valuesBatchGet'],
  ];
  for (const [name, invoke, counter] of cases) {
    calls.valuesGet.length = 0;
    calls.spreadsheetsGet.length = 0;
    calls.valuesBatchGet.length = 0;
    valuesGetPlan = [];
    spreadsheetsGetPlan = [];
    valuesBatchGetPlan = [];
    sheets._resetExerciseCatalogCache();
    if (counter === 'valuesGet') valuesGetPlan = [gaxios(503, 'Backend Error'), { data: { values: [] } }];
    else if (counter === 'spreadsheetsGet') spreadsheetsGetPlan = [gaxios(503, 'Backend Error'), { data: { sheets: [] } }];
    else valuesBatchGetPlan = [gaxios(503, 'Backend Error'),
      { data: { valueRanges: [{ range: 'Tab!A:Z', values: [] }, { range: 'Other!A:Z', values: [] }] } }];
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
    // Request-scoped read batching. None of these reaches the network: the first
    // establishes the per-request context, the second drops cached values for a tab
    // after a write, and the last three are the catalog cache's constant and its
    // test-only reset/inspection.
    // `declareRequestRanges` only RECORDS what a route expects to need; the batchGet it
    // enables is issued by the read helpers above and is covered by the 'batched read'
    // case in the retry test.
    'runWithReadContext', 'declareRequestRanges', 'invalidateTabCache',
    'CATALOG_CACHE_TTL_MS', '_resetExerciseCatalogCache', '_exerciseCatalogCacheStats',
    'validateConfig', 'getSafeSpreadsheetConfig',
    'isTransientAppendError', 'retryWithBackoff',
    'classifySheetsReadError', 'isTransientReadError', 'confirmTabMissing', 'readWithRetry',
    // Reads the provenance stamp `readWithRetry` puts on its own escaping errors, so a
    // route can tell an infrastructure failure from an input failure. It performs no
    // read and reaches no network — it reports what `classifySheetsReadError` already
    // decided, so it needs no retry coverage.
    'sheetsReadFailureClass',
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
