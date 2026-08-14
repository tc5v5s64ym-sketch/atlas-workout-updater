'use strict';

// ---------------------------------------------------------------------------
// Privacy-safe suppression classification.
//
// Atlas computed a precise validator violation code on every suppression and then threw it
// away, so `Coach_Response.suppression_reason` held only the coarse `validator_suppressed`.
// Eleven historical rows (five on the current build) could not be adjudicated without
// storing private model drafts — which Atlas deliberately never stores.
//
// These tests pin the observability WITHOUT any behaviour change: which responses pass or
// fail is untouched; only the recorded reason gains a bounded enum suffix.
//
// Part A — the pure classifier and its privacy boundary.
// Part B — the PRODUCTION finalizeCoachVoice, driven through the real /api/coach/message
//          route, proving each reachable producer emits its own precise code and that the
//          suppressed response is byte-equivalent to before.
// Part C — grouping compatibility for historical and new values.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SUPPRESSION_CODES,
  classifyRegisterViolations,
  formatSuppressionReason,
  isValidatorSuppressed,
  suppressionCodeOf,
} = require('../services/suppressionReason');

// ── Part A — the classifier and the privacy boundary ───────────────────────

test('A1. every enum code round-trips through the stored representation', () => {
  for (const code of Object.values(SUPPRESSION_CODES)) {
    const stored = formatSuppressionReason(code);
    assert.equal(stored, `validator_suppressed:${code}`);
    assert.ok(isValidatorSuppressed(stored), stored);
    assert.equal(suppressionCodeOf(stored), code);
  }
});

test('A2. PRIVACY: nothing outside the enum can ever be persisted', () => {
  const hostile = [
    'the model said fuck this set',                 // model prose
    'personal best',                                // a matched phrase
    'Bench Press 225 x 5',                          // athlete input / prescribed numbers
    'Error: at Object.<anonymous> (/app/x.js:1:1)', // stack trace
    { code: 'profanity_without_permission', phrase: 'fuck' }, // an object, not a code
    ['profanity_without_permission'],
    '', '   ', null, undefined, 42, true, {}, [],
    'validator_suppressed:profanity_without_permission', // already-formatted, not a code
  ];
  for (const value of hostile) {
    const stored = formatSuppressionReason(value);
    assert.equal(stored, 'validator_suppressed:unknown', JSON.stringify(value));
  }
});

test('A3. classification reads .code only — a matched phrase never survives', () => {
  const withPhrase = [{ code: 'profanity_without_permission', phrase: 'fuck' }];
  const code = classifyRegisterViolations(withPhrase);
  assert.equal(code, SUPPRESSION_CODES.PROFANITY_WITHOUT_PERMISSION);
  const stored = formatSuppressionReason(code);
  assert.ok(!stored.includes('fuck'));
  assert.ok(!/phrase/i.test(stored));
});

test('A4. multiple violations resolve by documented precedence, order-independently', () => {
  const profanity = { code: 'profanity_without_permission', phrase: 'x' };
  const celebration = { code: 'celebration_vocab_outside_earned_mode', phrase: 'y' };
  // Profanity outranks celebration vocabulary, whichever order the validator returns.
  assert.equal(classifyRegisterViolations([profanity, celebration]), SUPPRESSION_CODES.PROFANITY_WITHOUT_PERMISSION);
  assert.equal(classifyRegisterViolations([celebration, profanity]), SUPPRESSION_CODES.PROFANITY_WITHOUT_PERMISSION);
  // Alone, each reports itself.
  assert.equal(classifyRegisterViolations([celebration]), SUPPRESSION_CODES.CELEBRATION_VOCAB_OUTSIDE_EARNED_MODE);
  // The chat route's bare-string form is recognized.
  assert.equal(classifyRegisterViolations(['register_guard_unavailable']), SUPPRESSION_CODES.REGISTER_GUARD_UNAVAILABLE);
});

test('A5. malformed or unrecognized results fail closed to unknown', () => {
  for (const value of [[], null, undefined, 'nope', 42, [{}], [{ code: 'invented_code' }], ['pr_without_grant']]) {
    assert.equal(classifyRegisterViolations(value), SUPPRESSION_CODES.UNKNOWN, JSON.stringify(value));
  }
});

// ── Part B — the production route ──────────────────────────────────────────

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';

const fakeSheets = {
  validateConfig: () => {},
  appendRows: async () => { throw new Error('no writes on the coach-message path'); },
  deleteRowsByRange: async () => { throw new Error('no deletes'); },
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
require.cache[require.resolve('../sheets')] = { id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets };
require.cache[require.resolve('../services/vision')] = { id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) } };

const MODEL_DRAFT = 'Fucking massive NEW PR there, you crushed it!';
const coachState = { configured: true, message: MODEL_DRAFT, violations: [] };
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => coachState.configured,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateCoachMessage: async () => coachState.message,
    generatePlanMessage: async () => coachState.message,
    generateChatReply: async () => ({ reply: coachState.message }),
    findRegisterViolations: () => coachState.violations,
    looksLikePrClaim: () => false,
    sanitizeFacts: (f) => f,
  },
};

const responseSheet = require('../services/coachResponseSheet');
const RESP = Object.fromEntries(responseSheet.RESPONSE_HEADERS.map((h, i) => [h, i]));
const appended = [];
function installCapture() {
  responseSheet._resetForTesting({
    ensure: async () => {},
    getHeader: async () => responseSheet.RESPONSE_HEADERS.slice(),
    append: async (tab, rows) => { for (const r of rows) appended.push(r); },
  });
}

const originalConsoleLog = console.log;
// The exercise catalog reads Supabase (OWNER CORRECTION 2026-08-13). Stubbed here so
// the suite never opens a database connection; it delegates to the sheets fixture above.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();

// The workout authority is Supabase since the S4 cutover, so stubbing `sheets.js`

// no longer controls the logged sets, the Effort row, the plan ledgers or the write

// receipts. `sheetsFallback` seeds this suite's existing fixture into the double, so

// no test's data changes — only where the route reads it from.

require('./helpers/stubWorkoutAuthority').installWorkoutAuthorityStub({ sheetsFallback: true });
const { app } = require('../index');
let server; let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  try { if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))); }
  finally { console.log = originalConsoleLog; delete process.env.ATLAS_INTERACTION_TRACE; }
});

// A 'set' turn whose deterministic voice does NOT own the reaction, so the model line is
// the candidate prose and the register guard is the deciding validator.
const SET_FACTS = {
  exercise: 'Bench Press', lift_code: 'BPX01', weight: 185, reps: 8, rir: 2,
  set_number: 1, todaySets: [{ exercise: 'Bench Press', weight: 185, reps: 8, rir: 2 }],
};

async function postSet(facts = SET_FACTS, kind = 'set') {
  appended.length = 0;
  installCapture();
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ facts, kind }),
  });
  const json = await res.json();
  for (let i = 0; i < 50; i++) { await new Promise((r) => setImmediate(r)); if (appended.length) break; }
  await responseSheet._flushForTesting();
  return { res, json, row: appended[appended.length - 1] || null };
}

test('B1. PRODUCTION ROUTE: a register violation records its precise code', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.violations = [{ code: 'profanity_without_permission', phrase: 'Fucking' }];
  const { res, json, row } = await postSet();
  assert.equal(res.status, 200);
  assert.equal(json.data.message, null, 'the suppressed response still returns message:null');
  assert.ok(row, 'the suppressed turn is still recorded');
  assert.equal(row[RESP.suppressed], 'TRUE');
  assert.equal(row[RESP.suppression_reason], 'validator_suppressed:profanity_without_permission');
  coachState.violations = [];
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('B2. PRODUCTION ROUTE: precedence holds through the real route', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.violations = [
    { code: 'celebration_vocab_outside_earned_mode', phrase: 'NEW PR' },
    { code: 'profanity_without_permission', phrase: 'Fucking' },
  ];
  const { row } = await postSet();
  assert.equal(row[RESP.suppression_reason], 'validator_suppressed:profanity_without_permission');
  coachState.violations = [];
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('B3. PRODUCTION ROUTE: an unrecognized violation fails closed to unknown', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.violations = ['pr_without_grant']; // not in the enum
  const { row } = await postSet();
  assert.equal(row[RESP.suppression_reason], 'validator_suppressed:unknown');
  coachState.violations = [];
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('B4. PRODUCTION ROUTE: an empty model reply records empty_model_reply', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.message = '   ';
  const { json, row } = await postSet();
  assert.equal(json.data.message, null);
  assert.equal(row[RESP.suppression_reason], 'validator_suppressed:empty_model_reply');
  coachState.message = MODEL_DRAFT;
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('B5. PRIVACY: no model prose or matched phrase reaches the record', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.violations = [{ code: 'profanity_without_permission', phrase: 'Fucking' }];
  const { json, row } = await postSet();
  const stored = row.join(' | ');
  assert.ok(!stored.includes(MODEL_DRAFT), 'the draft must never be stored');
  assert.ok(!/fucking/i.test(stored), 'the matched phrase must never be stored');
  assert.ok(!/NEW PR/i.test(stored));
  assert.equal(row[RESP.visible_message], '', 'the visible message stays empty for a suppressed turn');
  // The reason is a bounded token: no whitespace, no punctuation beyond the one colon.
  assert.match(row[RESP.suppression_reason], /^validator_suppressed:[a-z_]+$/);
  // And the API response itself carries no violation detail.
  const body = JSON.stringify(json);
  assert.ok(!/fucking/i.test(body));
  assert.ok(!body.includes('phrase'));
  coachState.violations = [];
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('B6. BEHAVIOUR UNCHANGED: a valid message still passes through untouched', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.message = 'Solid work — that is a clean set.';
  coachState.violations = [];
  const { json, row } = await postSet();
  assert.equal(json.data.message, coachState.message, 'a clean reply is returned verbatim');
  assert.equal(row[RESP.suppressed], 'FALSE');
  assert.equal(row[RESP.suppression_reason], '', 'a passing turn carries no suppression reason');
  assert.equal(row[RESP.visible_message], coachState.message);
  coachState.message = MODEL_DRAFT;
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('B7. BEHAVIOUR UNCHANGED: the suppressed response shape is identical to before', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.violations = [{ code: 'profanity_without_permission', phrase: 'Fucking' }];
  const { json } = await postSet();
  // message:null plus the same companion fields the client's deterministic fallback reads.
  assert.equal(json.data.message, null);
  assert.equal(json.data.configured, true);
  assert.ok('voice' in json.data, 'voice still accompanies the suppressed response');
  assert.ok('sub_voice' in json.data);
  // The observational code must NOT leak into the athlete-facing payload.
  assert.ok(!('suppression_code' in json.data), 'the reason code is evidence, not a response field');
  assert.ok(!JSON.stringify(json).includes('profanity_without_permission'));
  coachState.violations = [];
  delete process.env.ATLAS_INTERACTION_TRACE;
});

// ── Part C — grouping compatibility ────────────────────────────────────────

test('C1. historical rows and new rows group together; other reasons do not', () => {
  // The five historical rows carry exactly this value and are never rewritten.
  assert.ok(isValidatorSuppressed('validator_suppressed'));
  assert.equal(suppressionCodeOf('validator_suppressed'), null, 'a historical row is not retroactively classified');

  for (const code of Object.values(SUPPRESSION_CODES)) {
    assert.ok(isValidatorSuppressed(`validator_suppressed:${code}`), code);
  }
  // A code added in future still groups, so a consumer never needs updating again.
  assert.ok(isValidatorSuppressed('validator_suppressed:some_future_code'));

  // Every other classification stays out of the group.
  for (const other of ['deliberate_silence', 'templated_fallback', 'model_error_fallback', 'outage_fallback', '', null, undefined]) {
    assert.equal(isValidatorSuppressed(other), false, String(other));
  }
});

test('C1b. COVERAGE: /api/coach/ask cannot produce a validator suppression at all', () => {
  // The third route that records a Coach_Response row. It is captured only when it carries
  // a non-empty answer (_askIsAthleteFacing), and _normalizeVisible falls back to
  // `data.answer` for the message — so `messagePresent` is always true when captured and
  // the suppressed branch is unreachable. That is why it needs no producer code, rather
  // than silently recording `unknown`.
  const qaShadow = require('../services/coachQaShadow');
  const askBody = { data: { depth: 'deep', answer: 'Rest 2-3 minutes between heavy sets.', source: 'training_sme' } };
  assert.equal(qaShadow._askIsAthleteFacing(askBody), true, 'an athlete-facing ask IS captured');
  assert.equal(qaShadow._normalizeVisible(askBody).data.message, askBody.data.answer, 'the answer IS the message');
  // Captured ⇒ message present ⇒ never suppressed, whatever the model status.
  for (const status of ['ok', 'skipped']) {
    assert.equal(responseSheet.deriveSuppression(status, true, true).suppressed, false, status);
  }
  // And an empty-answer / log_only pre-check is not captured at all, so it writes no row.
  assert.equal(qaShadow._askIsAthleteFacing({ data: { depth: 'log_only', answer: 'x' } }), false);
  assert.equal(qaShadow._askIsAthleteFacing({ data: { depth: 'deep', answer: '   ' } }), false);
});

test('C2. no Sheet schema change — the header is byte-identical', () => {
  assert.deepEqual(responseSheet.RESPONSE_HEADERS, [
    'recorded_at', 'turn_id', 'session_id', 'route', 'intent_type', 'visible_source',
    'visible_kind', 'visible_message_present', 'visible_message', 'suppressed',
    'suppression_reason', 'app_version', 'visible_error',
  ]);
  assert.equal(responseSheet.RESPONSE_HEADERS.length, 13, 'no column added');
});
