'use strict';

// ---------------------------------------------------------------------------
// Active-plan MODIFICATION-request routing (2026-07-22 production failure).
//
// PROVEN production sequence (Bench Press active session):
//   1. "Why did you program bench press for 175 pounds at 9 reps with 5 RIR?"
//      → correctly routed to /api/coach/chat (named-lift question).
//   2. "That isn't what you planned. You planned 3 sets at 6 reps."
//      → correctly routed to /api/coach/chat (plan reference); #1126 resolved
//        Bench Press from history and answered deterministically. No model call,
//        no mutation.
//   3. "Can we change it to 3 sets of 6?"
//      → INCORRECTLY routed to /api/coach/ask. A shorthand change request carries
//        neither a lift name nor the word "plan", so isSessionStateQuestion /
//        isPlannedLiftQuestion / isPlanReference all miss it, `skipSme` was false,
//        and getChatReply asked the generic SME first — which returned a confident
//        warm-up card, so the change request never reached the proposal → approval
//        flow.
//
// These tests drive the REAL getChatReply (sliced from the built bundle) with a
// recording `api` stub, reproducing the routing decision itself. Read-only
// throughout: getChatReply only ever calls the two read-only coach endpoints; a
// write to any trust/log/plan endpoint would show up as an unexpected recorded
// call and fail the "no mutation" assertions.
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

  const src = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const start = src.indexOf('async function getChatReply(');
  const end = src.indexOf('function showSaveNotePrompt(');
  assert.ok(start !== -1 && end !== -1 && end > start, 'must locate getChatReply in the bundle');
  const slice = src.slice(start, end);
  // The modification-routing branch must be the one under test — guard against a
  // future refactor silently dropping it.
  assert.match(slice, /sessionQuestion\.isPlanModificationRequest\(message\)/,
    'getChatReply must consult the plan-modification classifier');
  makeGetChatReply = (api, isConnected) =>
    new Function('api', 'isConnected', 'sessionQuestion', `${slice}\n return getChatReply;`)(
      api, isConnected, sessionQuestion);
});

// A recording api stub. The SME returns a confident, athlete-facing card (the
// production behaviour that hijacked the change request); /api/coach/chat can carry
// a propose_plan_edit so we can prove it reaches the caller (the approval flow).
function makeApi({ chatExtra } = {}) {
  const calls = [];
  const api = (url, opts) => {
    let body = null;
    try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch { body = null; }
    calls.push({ url, body });
    if (url === '/api/coach/ask') {
      return Promise.resolve({ data: { depth: 'guide', answer: 'Start with a quick general warm-up, then a few ramp sets.', cards: ['warmup'] } });
    }
    if (url === '/api/coach/chat') {
      return Promise.resolve({ data: Object.assign({
        message: 'Sure — I can change Bench Press to 3 sets of 6. Want me to?',
        propose_edit: null, propose_note: null, propose_constraint: null, propose_plan_edit: null,
      }, chatExtra || {}) });
    }
    calls.push({ url, unexpected: true });
    return Promise.resolve({ data: {} });
  };
  return { api, calls };
}

const urls = (calls) => calls.map(c => c.url);
const ACTIVE_MULTI = () => ({
  current_plan: [
    { name: 'Bench Press', weight: 175, reps: 9, rir: 5, sets: 3 },
    { name: 'Seated Row', weight: 200, reps: 10, rir: 1, sets: 3 },
    { name: 'Back Squat', weight: 275, reps: 5, rir: 2, sets: 5 },
  ],
});

// --- The exact three-turn production sequence ----------------------------------------

test('EXACT PRODUCTION (three-turn sequence): the shorthand change request routes to /api/coach/chat and its plan edit reaches the approval flow', async () => {
  const planEdit = { action: 'replace_plan', exercises: [{ name: 'Bench Press', sets: 3, reps: 6, weight: 175, rir: 5 }] };
  const { api, calls } = makeApi({ chatExtra: { propose_plan_edit: planEdit } });
  const getChatReply = makeGetChatReply(api, () => true);
  const ctx = ACTIVE_MULTI();
  const history = [];

  // Turn 1 — explanation about Bench Press (named-lift question, unchanged).
  const t1 = 'Why did you program bench press for 175 pounds at 9 reps with 5 RIR?';
  let before = calls.length;
  const r1 = await getChatReply(t1, history.slice(-8), ctx);
  const t1calls = urls(calls.slice(before));
  assert.ok(!t1calls.includes('/api/coach/ask'), 'turn 1 explanation bypasses the SME');
  assert.ok(t1calls.includes('/api/coach/chat'), 'turn 1 explanation reaches the chat coach');
  history.push({ role: 'user', text: t1 }, { role: 'atlas', text: r1.message });

  // Turn 2 — factual correction, omitted lift (unchanged from #1126).
  const t2 = 'That isn’t what you planned. You planned 3 sets at 6 reps.';
  before = calls.length;
  const r2 = await getChatReply(t2, history.slice(-8), ctx);
  const t2calls = urls(calls.slice(before));
  assert.ok(!t2calls.includes('/api/coach/ask'), 'turn 2 correction bypasses the SME');
  assert.ok(t2calls.includes('/api/coach/chat'), 'turn 2 correction reaches the chat coach');
  history.push({ role: 'user', text: t2 }, { role: 'atlas', text: r2.message });

  // Turn 3 — THE BUG: a shorthand modification request (no lift name, no "plan").
  const t3 = 'Can we change it to 3 sets of 6?';
  before = calls.length;
  const r3 = await getChatReply(t3, history.slice(-8), ctx);
  const t3calls = urls(calls.slice(before));
  assert.ok(!t3calls.includes('/api/coach/ask'), 'turn 3 change request must NOT hit the generic SME');
  assert.ok(t3calls.includes('/api/coach/chat'), 'turn 3 change request reaches the session-aware coach');
  assert.doesNotMatch(r3.message, /warm-?up|ramp set/i, 'the generic warm-up SME answer never reaches the athlete');
  // propose_plan_edit is carried back to handleChatMessage, which dispatches
  // atlas:plan-edit-proposed → the EXISTING preview → approve → write approval flow.
  assert.deepEqual(r3.propose_plan_edit, planEdit, 'the proposed plan edit reaches the approval flow');

  // No automatic plan write anywhere in the sequence: the ONLY endpoint ever called
  // is the read-only chat coach (the SME was bypassed on every turn, and no
  // write/log/plan-mutation endpoint was touched).
  assert.deepEqual([...new Set(urls(calls))].sort(), ['/api/coach/chat'], 'only the read-only chat coach is called — no SME, no write');
});

// --- Shorthand modification variants (requirement 6) ---------------------------------

const MODIFICATION_SHORTHANDS = [
  'Change it to 3x6.',
  'Make that 8 reps.',
  'Could we lower it to 175?',
  'I want to change it to 3 sets.',
  'Can we change it to 3 sets of 6?',
];

for (const msg of MODIFICATION_SHORTHANDS) {
  test(`shorthand change request routes to the chat coach (not the SME): ${JSON.stringify(msg)}`, async () => {
    const planEdit = { action: 'replace_plan', exercises: [{ name: 'Bench Press', sets: 3, reps: 6, weight: 175, rir: 5 }] };
    const { api, calls } = makeApi({ chatExtra: { propose_plan_edit: planEdit } });
    const getChatReply = makeGetChatReply(api, () => true);
    const r = await getChatReply(msg, [], ACTIVE_MULTI());
    assert.ok(!urls(calls).includes('/api/coach/ask'), `${msg}: the SME must be bypassed`);
    assert.ok(urls(calls).includes('/api/coach/chat'), `${msg}: the session-aware coach must be used`);
    assert.deepEqual(r.propose_plan_edit, planEdit, `${msg}: the plan edit reaches the approval flow`);
    assert.deepEqual([...new Set(urls(calls))].sort(), ['/api/coach/chat'], `${msg}: no write/SME endpoint is called`);
  });
}

// --- Education preservation (requirement 3) ------------------------------------------
// A change request is not the only sentence with the word "change"/"lower". Education
// must stay on the SME — it must NOT become an active-plan modification.

const EDUCATION_CONTROLS = [
  'What is progressive overload?',
  'How do I change my grip?',
  'Can changing rep ranges build muscle?',
];

for (const msg of EDUCATION_CONTROLS) {
  test(`education stays on the SME during an active workout (never a plan modification): ${JSON.stringify(msg)}`, async () => {
    assert.equal(sessionQuestion.isPlanModificationRequest(msg), false, `${msg}: classifier must NOT flag education as a modification`);
    const { api, calls } = makeApi();
    const getChatReply = makeGetChatReply(api, () => true);
    const r = await getChatReply(msg, [], ACTIVE_MULTI());
    assert.ok(urls(calls).includes('/api/coach/ask'), `${msg}: the SME must be attempted`);
    assert.ok(!urls(calls).includes('/api/coach/chat'), `${msg}: a confident SME answer must not fall through to chat`);
    assert.equal(r.propose_plan_edit ?? null, null, `${msg}: education never proposes a plan edit`);
  });
}

// --- Preserve #1126 exactly: disputes/explanations still route to chat ----------------

test('regression: a factual dispute is not a modification and still routes to the chat coach (unchanged from #1126)', async () => {
  assert.equal(sessionQuestion.isPlanModificationRequest("That isn't what you planned. You planned 3 sets at 6 reps."), false,
    'a factual dispute is not a modification request');
  const { api, calls } = makeApi();
  const getChatReply = makeGetChatReply(api, () => true);
  await getChatReply("That isn’t what you planned. You planned 3 sets at 6 reps.", [], ACTIVE_MULTI());
  assert.ok(!urls(calls).includes('/api/coach/ask'), 'the dispute bypasses the SME (via isPlanReference)');
  assert.ok(urls(calls).includes('/api/coach/chat'), 'the dispute reaches the chat coach');
});

test('regression: with no active workout a shorthand change request is not force-routed off the SME', async () => {
  const { api, calls } = makeApi();
  const getChatReply = makeGetChatReply(api, () => true);
  await getChatReply('Change it to 3x6.', [], {}); // no active workout, no prior turns
  assert.ok(urls(calls).includes('/api/coach/ask'), 'with no active workout the SME is attempted (the modification bypass is gated on an active workout)');
});
