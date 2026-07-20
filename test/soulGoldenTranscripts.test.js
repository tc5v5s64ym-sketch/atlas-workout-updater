'use strict';

// Soul Recovery (Issue #1073), Phase 1 Work item 3 — the ten golden conversation
// transcripts + the reusable Golden Session scenario, scored on BEHAVIOR, not wording.
//
// Each transcript drives the REAL /api/coach/message seam (the closest integration seam
// for the in-session voice): real coachNoteTier / batchNoteFacts / setEffortSignals /
// finalizeCoachVoice, with only Gemini + sheets stubbed. The assertions are behavioral
// labels — silence on routine work, a surfaced signal on a real one, honest degradation
// on an outage — so a phrasing change never breaks them and a behavior change always does.
//
// Harness mirrors test/coach-message-block.test.js (require-cache stub injection).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  GOLDEN_SESSION,
  GOLDEN_TRANSCRIPTS,
  blockBehavior,
  isHonestDegrade,
} = require('./fixtures/goldenSession');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
// Plain stub — sheets.js is fully require-cache stubbed below (never used for real auth).
// Deliberately NOT a PEM block so the changed-file secret scanner stays quiet.
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';

const sheetState = { appendCalls: [], deleteCalls: [] };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async (tabName, rows) => {
    sheetState.appendCalls.push({ tabName, rows });
    throw new Error('appendRows must not be called by the read-only coach path');
  },
  deleteRowsByRange: async (tabName, s, e) => { sheetState.deleteCalls.push({ tabName, s, e }); },
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
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

const coachState = { configured: true, message: 'Nice work on that block.', throwError: null, calls: 0, lastFacts: null };
const fakeCoach = {
  isConfigured: () => coachState.configured,
  coachModel: () => 'gemini-2.5-flash-lite',
  generateCoachMessage: async (facts) => {
    coachState.calls += 1;
    coachState.lastFacts = facts;
    if (coachState.throwError) throw new Error(coachState.throwError);
    return coachState.message;
  },
  generatePlanMessage: async () => null,
  generateChatReply: async () => ({ reply: null }),
  sanitizeFacts: (f) => f,
};
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true, exports: fakeCoach,
};

const originalConsoleLog = console.log;
const { app } = require('../index');

let server;
let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  try { if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))); }
  finally { console.log = originalConsoleLog; }
});

function resetCoach({ configured = true, message = 'Nice work on that block.', throwError = null } = {}) {
  coachState.configured = configured;
  coachState.message = message;
  coachState.throwError = throwError;
  coachState.calls = 0;
  coachState.lastFacts = null;
}

async function post(kind, facts) {
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ kind, facts }),
  });
  const body = await res.json();
  return { res, body };
}

// Assert a route response against a behavioral expectation descriptor.
function assertBehavior(id, res, body, expect) {
  assert.equal(res.status, 200, `${id}: the coach path never surfaces a 5xx`);
  if (expect.behavior === 'silence') {
    assert.equal(body.data.note_tier, 'ack_only', `${id}: a routine block tiers to ack_only`);
    assert.equal(body.data.message, null, `${id}: routine → no coaching prose`);
    assert.equal(coachState.calls, 0, `${id}: the LLM is never called on a routine block`);
    assert.equal(blockBehavior(body), 'silence', `${id}: classified as deliberate silence`);
  } else if (expect.behavior === 'surfaced') {
    assert.notEqual(body.data.note_tier, 'ack_only', `${id}: a signal block is not collapsed to the ack`);
    if (expect.trigger) {
      assert.equal(body.data.note_trigger, expect.trigger, `${id}: the ${expect.trigger} signal is the trigger`);
    }
    const note = (typeof body.data.message === 'string' && body.data.message.trim())
      || (typeof body.data.effort_note === 'string' && body.data.effort_note.trim());
    assert.ok(note, `${id}: a surfaced block produces a renderable note`);
    assert.equal(blockBehavior(body), 'surfaced', `${id}: classified as surfaced`);
  } else if (expect.engineTruth) {
    assert.ok(coachState.lastFacts, `${id}: the set path words via the coach voice`);
    const v = coachState.lastFacts.rec && coachState.lastFacts.rec.effort_verdict;
    assert.equal(v && v.level, expect.engineTruth, `${id}: the engine rule overwrites the forged verdict`);
  } else if (expect.degrade) {
    assert.ok(isHonestDegrade(body), `${id}: honest degradation — no fabricated prose; a deterministic note or an openly-down coach`);
  } else {
    assert.fail(`${id}: unknown expectation ${JSON.stringify(expect)}`);
  }
}

// ── The ten transcripts ──
test('the ten golden transcripts number exactly ten and cover silence, surfaced, and degrade', () => {
  assert.equal(GOLDEN_TRANSCRIPTS.length, 10, 'exactly ten golden transcripts');
  const behaviors = new Set(GOLDEN_TRANSCRIPTS.map(t => t.expect.behavior).filter(Boolean));
  assert.ok(behaviors.has('silence'), 'at least one silence transcript');
  assert.ok(behaviors.has('surfaced'), 'at least one surfaced transcript');
  assert.ok(GOLDEN_TRANSCRIPTS.some(t => t.expect.degrade), 'at least one honest-degrade transcript');
  assert.ok(GOLDEN_TRANSCRIPTS.some(t => t.expect.engineTruth), 'the forged-verdict guard is covered');
});

for (const t of GOLDEN_TRANSCRIPTS.filter(t => t.seam !== 'client:render')) {
  test(`golden transcript ${t.id}: ${t.story}`, async () => {
    resetCoach(t.coach || {});
    const kind = t.seam === 'coach/message:set' ? 'set' : 'block';
    const { res, body } = await post(kind, t.facts);
    assertBehavior(t.id, res, body, t.expect);
  });
}

// T10 — the client render TIMING contract: a completed on-plan block gets the grounded
// wrap line, an intermediate single set stays silent. Ties the server's ack_only tier to
// the visible voice the owner asked for at the gate.
test('golden transcript T10-client-render-timing-contract: a completed on-plan block gets the grounded wrap line; an intermediate set stays silent', () => {
  const cc = fs.readFileSync(path.join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  const fn = cc.slice(cc.indexOf('async function getInWorkoutNote'), cc.indexOf('async function getLlmCoachingMessage'));
  const branchStart = fn.indexOf("data.note_tier === 'ack_only'");
  assert.ok(branchStart !== -1, 'the ack_only render branch must exist');
  const branch = fn.slice(branchStart, branchStart + 400);
  assert.match(branch, /facts\.exercise_complete/, 'the render is gated on exercise completion');
  assert.match(branch, /templatedOnPlanWrapLine\(facts\)/, 'a completed on-plan block renders the grounded wrap line');
  assert.match(branch, /:\s*null/, 'an intermediate single set stays silent (note null)');
  assert.doesNotMatch(branch, /templatedAckLine/, 'never the retired receipt template');
});

// ── The Golden Session — the scripted two-exercise scenario, replayed through the seam ──
test('Golden Session: the scripted arc is well-formed (plan → routine silence → surfaced signal → closeout)', () => {
  const beats = GOLDEN_SESSION.beats;
  assert.ok(beats.length >= 8, 'the scripted session has the full arc of beats');
  assert.ok(beats.some(b => b.seam === 'coach/message:plan'), 'it opens with a plan-from-history beat');
  const silenceBeats = beats.filter(b => b.expect && b.expect.behavior === 'silence');
  assert.ok(silenceBeats.length >= 2, 'routine work is met with silence in more than one beat');
  assert.ok(beats.some(b => b.expect && b.expect.behavior === 'surfaced'), 'a real signal is surfaced');
  assert.ok(beats.some(b => b.beat === 'close-out-once'), 'the session closes out once');
  // Every framing beat we do not drive here is explicitly reserved for the live run.
  for (const b of beats) {
    const asserted = b.seam === 'coach/message:plan' || (b.expect && b.expect.behavior);
    assert.ok(asserted || b.reservedForLive === true,
      `beat ${b.beat} is either asserted here or explicitly reserved for the Phase 4 live run`);
  }
});

for (const beat of GOLDEN_SESSION.beats.filter(b => b.seam === 'coach/message:block')) {
  test(`Golden Session beat "${beat.beat}": ${beat.note}`, async () => {
    resetCoach();
    const { res, body } = await post('block', beat.facts);
    assertBehavior(`beat:${beat.beat}`, res, body, beat.expect);
  });
}

test('Golden Session beat "plan-from-history": the plan voice seam is exercised', async () => {
  resetCoach();
  const planBeat = GOLDEN_SESSION.beats.find(b => b.seam === 'coach/message:plan');
  const { res, body } = await post('plan', planBeat.facts);
  assert.equal(res.status, 200, 'the plan seam responds 200');
  assert.equal(body.data.kind, 'plan', 'the response is the plan voice, not a set/block reaction');
});
