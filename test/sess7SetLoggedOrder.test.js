'use strict';

// SESS-7 — concurrent `atlas:set-logged` submissions recorded their chatTurns
// out of submission order.
//
// handleSetLogged records the user turn at entry, but its Atlas turns only
// land after the recommendation/coaching awaits (and the typeOut renders).
// The listener invoked it directly per event and the handler pushed its
// Atlas turns the moment they were computed, so two submissions in flight
// together interleaved: the second submission's coaching could finish — and
// be recorded — before the first one's, scrambling the history that later
// turns are answered from (chatTurns.slice(-8) in handleChatMessage,
// window.getChatHistory for the closeout compile).
//
// The fix orders ONLY the recording. The listener claims a flush slot per
// dispatch, in dispatch order; the handler body runs immediately and
// concurrently exactly as before (its fetches, typing and rendering are
// side effects other features time their own observations off — serializing
// the whole handler delayed them measurably and broke a staged-proposal
// E2E observation on PR #1308's first head). The body buffers its Atlas
// turns through recordTurn, and the wrapper flushes them into chatTurns
// only after every earlier submission's turns have flushed.
//
// These tests drive the REAL slot machinery + wrapper source (sliced from
// src/app/coach-conversation.js) with a controllable handleSetLogged
// stub, in the repo's slice-harness style (see test/postLogIdentity.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'app', 'coach-conversation.js'),
  'utf8'
);

function machineryBlock() {
  const stateStart = src.indexOf('const turnFlushSlots');
  const bodyStart = src.indexOf('async function handleSetLogged(');
  const wrapStart = src.indexOf('async function handleSetLoggedInOrder');
  const wrapEnd = src.indexOf('// End-of-session review', wrapStart);
  assert.ok(stateStart >= 0, 'the SESS-7 turn-flush slot machinery must exist');
  assert.ok(bodyStart > stateStart, 'handleSetLogged must follow the slot state');
  assert.ok(wrapStart > bodyStart, 'handleSetLoggedInOrder must follow the body');
  assert.ok(wrapEnd > wrapStart, 'the ordered entry point must be locatable');
  // The slot state + claim (before the body) and the ordered entry point
  // (after it); the harness shims the body between the two segments.
  return [src.slice(stateStart, bodyStart), src.slice(wrapStart, wrapEnd)];
}

function listenerBlock() {
  const start = src.indexOf("document.addEventListener('atlas:set-logged'");
  const end = src.indexOf("document.addEventListener('atlas:plan-mutated'");
  assert.ok(start >= 0, 'the atlas:set-logged listener must exist');
  assert.ok(end > start, 'the atlas:plan-mutated listener must follow it');
  const slice = src.slice(start, end);
  return slice.slice(0, slice.lastIndexOf('});') + 3);
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Build the real slot machinery + ordered entry point with a controllable
// body. The shim reproduces the real body's one-line recorder lookup
// (turnRecorderFor, itself part of the real segment under test); bodyImpl
// then mimics the body's behaviour: push the user turn synchronously at
// entry, do (gated) coaching work, record the Atlas turn through the
// recorder, and optionally throw after recording.
function loadMachinery() {
  const chatTurns = [];
  const events = [];
  const gates = {};
  const bodyImpl = async (detail, recordAtlasTurn) => {
    events.push(`bodyStart:${detail.id}`);
    chatTurns.push({ role: 'user', text: `u:${detail.id}` });
    if (gates[detail.id]) await gates[detail.id].promise;
    events.push(`bodyDone:${detail.id}`);
    recordAtlasTurn({ role: 'atlas', text: `a:${detail.id}` });
    if (detail.fail) throw new Error(`boom:${detail.id}`);
  };
  const [stateSeg, wrapSeg] = machineryBlock();
  const factory = new Function(
    'chatTurns', 'bodyImpl',
    `'use strict';
     ${stateSeg}
     async function handleSetLogged(detail) {
       const recordAtlasTurn = turnRecorderFor(detail) || ((turn) => { chatTurns.push(turn); });
       return bodyImpl(detail, recordAtlasTurn);
     }
     ${wrapSeg}
     return { claimTurnFlushSlot, handleSetLoggedInOrder };`
  );
  const api = factory(chatTurns, bodyImpl);
  return { ...api, chatTurns, events, gates };
}

const atlasTexts = (turns) => turns.filter((t) => t.role === 'atlas').map((t) => t.text);

test('SESS-7: Atlas turns flush in submission order even when a later body finishes first', async () => {
  const api = loadMachinery();
  const a = { id: 'A' };
  const b = { id: 'B' };
  api.gates.A = deferred();
  // Dispatch order: A, then B. A's coaching is slow; B's is immediate.
  api.claimTurnFlushSlot(a);
  api.claimTurnFlushSlot(b);
  const pA = api.handleSetLoggedInOrder(a);
  const pB = api.handleSetLoggedInOrder(b);
  await tick();
  // B's body has finished and recorded its turn — but the turn must NOT be
  // in chatTurns yet: A's earlier submission has not flushed.
  assert.deepEqual(api.events, ['bodyStart:A', 'bodyStart:B', 'bodyDone:B']);
  assert.deepEqual(atlasTexts(api.chatTurns), [], 'B’s Atlas turn waits for A’s flush');
  api.gates.A.resolve();
  await Promise.all([pA, pB]);
  assert.deepEqual(atlasTexts(api.chatTurns), ['a:A', 'a:B'],
    'the recorded history is in submission order, not completion order');
});

test('SESS-7: the handling itself is NOT serialized — bodies run concurrently', async () => {
  const api = loadMachinery();
  const a = { id: 'A' };
  const b = { id: 'B' };
  api.gates.A = deferred();
  api.claimTurnFlushSlot(a);
  api.claimTurnFlushSlot(b);
  const pA = api.handleSetLoggedInOrder(a);
  const pB = api.handleSetLoggedInOrder(b);
  await tick();
  assert.ok(api.events.includes('bodyStart:B') && api.events.includes('bodyDone:B'),
    'B’s fetches/coaching run while A is still in flight — only the recording is ordered');
  api.gates.A.resolve();
  await Promise.all([pA, pB]);
});

test('SESS-7: a throwing body still flushes its recorded turns and releases the chain', async () => {
  const api = loadMachinery();
  const a = { id: 'A', fail: true };
  const b = { id: 'B' };
  api.claimTurnFlushSlot(a);
  api.claimTurnFlushSlot(b);
  const pA = api.handleSetLoggedInOrder(a);
  const pB = api.handleSetLoggedInOrder(b);
  await assert.rejects(pA, /boom:A/, 'the body’s rejection still propagates to the caller');
  await pB;
  assert.deepEqual(atlasTexts(api.chatTurns), ['a:A', 'a:B'],
    'the failed submission’s recorded turns flush in order and the next submission is not jammed');
});

test('SESS-7: a handler invoked without a claimed slot flushes at its own settle', async () => {
  const api = loadMachinery();
  const solo = { id: 'S' };
  await api.handleSetLoggedInOrder(solo);
  assert.deepEqual(atlasTexts(api.chatTurns), ['a:S'],
    'direct invocations (no listener claim) keep the old record-at-completion behaviour');
});

test('SESS-7: the listener claims the slot at dispatch and invokes the ordered entry point directly', () => {
  const block = listenerBlock();
  assert.match(block, /claimTurnFlushSlot\(detail\)/,
    'the listener must claim the recording slot per dispatch');
  assert.ok(
    block.indexOf('beginTurnResponse') < block.indexOf('handleSetLoggedInOrder(detail)'),
    'the turn-response ticket is still minted at dispatch, before handling'
  );
  assert.ok(
    block.indexOf('claimTurnFlushSlot(detail)') < block.indexOf('handleSetLoggedInOrder(detail)'),
    'the slot is claimed before the handler is invoked'
  );
  assert.doesNotMatch(block, /setLoggedQueue/,
    'the handler is invoked directly — handling is not serialized (PR #1308 v1 regression)');
});

test('SESS-7: the body records Atlas turns through its recorder, never by direct push', () => {
  const start = src.indexOf('async function handleSetLogged(detail)');
  const end = src.indexOf('async function handleSetLoggedInOrder', start);
  assert.ok(start >= 0 && end > start, 'the handler body must be locatable');
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /chatTurns\.push\(\{ role: 'atlas'/,
    'Atlas turns are buffered through the recorder so the entry point can order them');
  assert.match(body, /turnRecorderFor\(detail\)/,
    'the body takes its recorder from the submission’s claimed slot');
  assert.match(body, /recordAtlasTurn\(\{ role: 'atlas', text: note \}\)/);
  assert.match(body, /chatTurns\.push\(\{ role: 'user', text \}\)/,
    'the user turn still pushes at entry — entries run in dispatch order, so it needs no slot');
});
