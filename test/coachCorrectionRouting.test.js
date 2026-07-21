'use strict';

// ---------------------------------------------------------------------------
// Active-plan correction routing (2026-07-21 production failure).
//
// PROVEN production failure: an active workout was running (Seated Row 200×10 @
// 1 RIR ×3). The athlete's explanation question ("Why did you program seated
// rows for 200 pounds at 10 reps with 1 RIR?") correctly reached /api/coach/chat.
// The follow-up CORRECTION — "That isn't what you planned. You planned 3 sets at
// 8 reps." — is not one of the enumerated session-state QUESTION shapes and omits
// the lift name, so it matched neither session classifier, `skipSme` was false, and
// getChatReply asked the generic Training SME (/api/coach/ask) first. The SME
// returned a confident but unrelated warm-up card, which getChatReply returned
// WITHOUT falling through to the session-aware coach — the athlete saw warm-up
// advice instead of an answer about the plan discrepancy.
//
// These tests drive the REAL getChatReply (sliced from the built bundle) with a
// recording `api` stub, so they reproduce the routing decision itself — not a
// re-implementation. Read-only throughout: getChatReply only ever calls the two
// read-only coach endpoints; a write to any trust/log/plan endpoint would show up
// as an unexpected recorded call and fail the "no mutation" assertions.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

let sessionQuestion;
let makeGetChatReply;

test.before(async () => {
  sessionQuestion = await import('../src/app/sessionQuestion.js');

  // Slice the real getChatReply out of the built bundle and rebuild it as a
  // callable, injecting only its three external dependencies (api, isConnected,
  // sessionQuestion). Everything else it uses is a local const or a global.
  const src = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const start = src.indexOf('async function getChatReply(');
  const end = src.indexOf('function showSaveNotePrompt(');
  assert.ok(start !== -1 && end !== -1 && end > start, 'must locate getChatReply in the bundle');
  const slice = src.slice(start, end);
  // The correction-routing branch must be the one under test — guard against a
  // future refactor silently dropping it.
  assert.match(slice, /sessionQuestion\.isPlanReference\(message\)/,
    'getChatReply must consult the plan-reference classifier');
  makeGetChatReply = (api, isConnected) =>
    new Function('api', 'isConnected', 'sessionQuestion', `${slice}\n return getChatReply;`)(
      api, isConnected, sessionQuestion);
});

// A recording api stub. Endpoint behaviour is configurable per test so we can
// simulate the confident SME card (the production failure) or a log_only precheck.
function makeApi({ smeAnswer, chatMessage, chatExtra } = {}) {
  const calls = [];
  const api = (url, opts) => {
    let body = null;
    try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch { body = null; }
    calls.push({ url, body });
    if (url === '/api/coach/ask') {
      // smeAnswer === null → a log_only precheck (answer:null) the client ignores;
      // otherwise a confident, athlete-facing SME card (the production behaviour).
      return Promise.resolve(smeAnswer === null
        ? { data: { depth: 'log_only', answer: null, cards: [] } }
        : { data: { depth: 'guide', answer: smeAnswer || 'Start with a quick general warm-up, then a few ramp sets.', cards: ['warmup'] } });
    }
    if (url === '/api/coach/chat') {
      return Promise.resolve({ data: Object.assign({
        message: chatMessage || 'The plan on Seated Row is 3 sets of 10 at RIR 1 — not 8 reps. Want me to change it?',
        propose_edit: null, propose_note: null, propose_constraint: null, propose_plan_edit: null,
      }, chatExtra || {}) });
    }
    // Any other endpoint (a write / log / plan-mutation path) is unexpected here.
    calls.push({ url, unexpected: true });
    return Promise.resolve({ data: {} });
  };
  return { api, calls };
}

const urls = (calls) => calls.map(c => c.url);
const ACTIVE_SEATED_ROW = () => ({
  current_plan: [{ name: 'Seated Row', weight: 200, reps: 10, rir: 1, sets: 3 }],
});

// --- The exact production correction -------------------------------------------------

test('EXACT PRODUCTION: the Seated-Row correction bypasses /api/coach/ask and reaches /api/coach/chat with plan context', async () => {
  const { api, calls } = makeApi();
  const getChatReply = makeGetChatReply(api, () => true);
  const context = ACTIVE_SEATED_ROW();

  const result = await getChatReply('That isn’t what you planned. You planned 3 sets at 8 reps.', [], context);

  // Routing: the SME is bypassed, the session-aware coach is used.
  assert.ok(!urls(calls).includes('/api/coach/ask'), 'the correction must NOT hit the generic SME');
  assert.ok(urls(calls).includes('/api/coach/chat'), 'the correction must reach the session-aware coach');

  // Active plan/session context is passed through to the coach.
  const chatCall = calls.find(c => c.url === '/api/coach/chat');
  assert.ok(chatCall.body && Array.isArray(chatCall.body.context.current_plan), 'the current plan context is forwarded');
  assert.equal(chatCall.body.context.current_plan[0].name, 'Seated Row');

  // The visible reply is about the plan discrepancy — NOT the generic warm-up card.
  assert.match(result.message, /plan|seated row|reps|rir/i, 'the answer addresses the plan, not warm-ups');
  assert.doesNotMatch(result.message, /warm-?up|ramp set/i, 'the generic warm-up SME answer never reaches the athlete');

  // No mutation: only the two read-only coach endpoints were touched, and the
  // routing layer proposes no plan/preview edit (the plan is never changed just
  // because the athlete asserted a different target).
  assert.deepEqual([...new Set(urls(calls))].sort(), ['/api/coach/chat'], 'no endpoint other than the read-only chat coach is called');
  assert.equal(result.propose_plan_edit ?? null, null, 'routing proposes no plan edit — the plan is not mutated');
  assert.equal(result.propose_edit ?? null, null, 'routing proposes no preview edit');

  // Exactly one athlete-facing coach turn → exactly one Coach_Shadow/Coach_Response
  // pair through the #1120 chat-route wiring (verified server-side in
  // coachQaShadowRoute / coachResponseRoute).
  assert.equal(urls(calls).filter(u => u === '/api/coach/chat').length, 1, 'exactly one visible coach turn');
});

// --- Focused routing coverage (task cases A–J) ---------------------------------------

const ACTIVE_CORRECTIONS = [
  ['A. exact production correction', 'That isn’t what you planned. You planned 3 sets at 8 reps.'],
  ['B. correction with no lift name', 'No, you told me 8 reps.'],
  ['C. weight correction', 'That’s not the weight you gave me. You said 195.'],
  ['D. RIR correction', 'You planned 2 RIR, not 1.'],
  ['E. general plan dispute', 'Why is this different from the plan?'],
  ["I. straight-apostrophe variant", "That isn't what you planned."],
  ['I. curly-apostrophe variant', 'That isn’t what you planned.'],
];

for (const [label, msg] of ACTIVE_CORRECTIONS) {
  test(`routes to active-session coaching (not SME): ${label}`, async () => {
    const { api, calls } = makeApi();
    const getChatReply = makeGetChatReply(api, () => true);
    await getChatReply(msg, [], ACTIVE_SEATED_ROW());
    assert.ok(!urls(calls).includes('/api/coach/ask'), `${label}: SME must be bypassed`);
    assert.ok(urls(calls).includes('/api/coach/chat'), `${label}: session-aware coach must be used`);
  });
}

// F & G — education stays eligible for the SME even during an active workout.
// NOTE: "What is RIR?" ends in the bare "rir?" shorthand, which the PRE-EXISTING
// isSessionStateQuestion classifier already treats as session-shaped during an
// active workout (the 2026-06-20 "RIR?" live-test fix) — that routing predates and
// is untouched by this PR. So the RIR-education control here uses "What does RIR
// mean?", which carries no bare-shorthand collision; "What is RIR?" is covered
// separately below (classifier is false + SME-eligible with no active workout).
const EDUCATION_CONTROLS = [
  ['F. RIR education', 'What does RIR mean?'],
  ['G. warm-up how-to', 'How should I warm up for seated rows?'],
  ['education: progressive overload', 'What is progressive overload?'],
  ['education: muscles worked', 'What muscles do seated rows work?'],
];

for (const [label, msg] of EDUCATION_CONTROLS) {
  test(`education stays on the SME during an active workout: ${label}`, async () => {
    const { api, calls } = makeApi();
    const getChatReply = makeGetChatReply(api, () => true);
    const result = await getChatReply(msg, [], ACTIVE_SEATED_ROW());
    assert.ok(urls(calls).includes('/api/coach/ask'), `${label}: the SME must be attempted`);
    assert.ok(!urls(calls).includes('/api/coach/chat'), `${label}: a confident SME answer must not fall through to chat`);
    assert.match(result.message, /warm-?up|ramp|Based on/i, `${label}: the athlete gets the SME answer`);
  });
}

// F (literal) — the plan-reference classifier never pulls "What is RIR?" off the
// SME, and with no active workout the SME is the route. (During an active workout
// the pre-existing bare-"RIR?" shorthand owns it — not this PR's concern.)
test('F. "What is RIR?" — plan-reference classifier stays false; SME-eligible with no active workout', async () => {
  assert.equal(sessionQuestion.isPlanReference('What is RIR?'), false, 'education is never a plan reference');
  const { api, calls } = makeApi();
  const getChatReply = makeGetChatReply(api, () => true);
  await getChatReply('What is RIR?', [], {}); // no active workout
  assert.ok(urls(calls).includes('/api/coach/ask'), 'with no active workout, education reaches the SME');
});

// H — no active workout: a plan-reference sentence must NOT be treated as an
// active-plan correction; the existing SME-first safe fallback stands.
test('H. no active plan: the same sentence is NOT force-routed off the SME (safe fallback stands)', async () => {
  const { api, calls } = makeApi({ smeAnswer: null }); // SME returns log_only → falls through
  const getChatReply = makeGetChatReply(api, () => true);
  await getChatReply('That isn’t what you planned.', [], {}); // no active workout, no prior turns
  // The plan-reference bypass requires an active workout, so the SME IS attempted.
  assert.ok(urls(calls).includes('/api/coach/ask'), 'with no active workout the SME is attempted (no false active-plan bypass)');
  // Its log_only precheck then falls through to chat — the existing safe fallback.
  assert.ok(urls(calls).includes('/api/coach/chat'), 'the log_only precheck falls through to chat unchanged');
});

// --- Regression: preserve existing good behaviour ------------------------------------

test('regression: the earlier explanation question still reaches /api/coach/chat', async () => {
  const { api, calls } = makeApi();
  const getChatReply = makeGetChatReply(api, () => true);
  await getChatReply('Why did you program seated rows for 200 pounds at 10 reps with 1 RIR?', [], ACTIVE_SEATED_ROW());
  assert.ok(!urls(calls).includes('/api/coach/ask'), 'the explanation is session-aware, not SME');
  assert.ok(urls(calls).includes('/api/coach/chat'), 'the explanation reaches the session-aware coach (unchanged)');
});

test('regression: /api/coach/ask log_only fallback is unchanged (education precheck → chat)', async () => {
  const { api, calls } = makeApi({ smeAnswer: null }); // SME log_only
  const getChatReply = makeGetChatReply(api, () => true);
  // A non-plan, non-session message with an active workout: SME first, log_only, → chat.
  await getChatReply('Tell me something motivating.', [], ACTIVE_SEATED_ROW());
  assert.deepEqual(urls(calls), ['/api/coach/ask', '/api/coach/chat'],
    'the SME is attempted first and its log_only precheck falls through to chat, in order');
});

test('regression: ordinary set-logging shorthand is not a plan reference and is not force-routed off the SME', () => {
  // Pure shorthand names no plan and attributes nothing to Atlas.
  assert.equal(sessionQuestion.isPlanReference('bench 225 5/2'), false);
  assert.equal(sessionQuestion.isPlanReference('seated row 200 10/1'), false);
});
