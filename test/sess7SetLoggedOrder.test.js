'use strict';

// SESS-7 — concurrent `atlas:set-logged` submissions recorded their chatTurns
// out of submission order.
//
// handleSetLogged records the user turn at entry, but its Atlas turns only
// land after the recommendation/coaching awaits (and the typeOut renders).
// The listener used to invoke it directly per event, so two submissions in
// flight together interleaved: the second submission's coaching could finish
// — and be recorded — before the first one's, scrambling the history that
// later turns are answered from (chatTurns.slice(-8) in handleChatMessage,
// window.getChatHistory for the closeout compile).
//
// The fix serializes the handling through a promise queue in the listener:
// submissions RUN one at a time, in dispatch order. The turn-response ticket
// is still minted synchronously at dispatch (logical set initiation, per the
// turn-correlation contract); only the handling — and its settlement bound —
// waits for the submission's turn in the queue.
//
// These tests drive the REAL listener source (sliced from
// src/app/coach-conversation.js) with a controllable handleSetLogged stub, in
// the repo's slice-harness style (see test/postLogIdentity.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'app', 'coach-conversation.js'),
  'utf8'
);

function listenerBlock() {
  const start = src.indexOf("document.addEventListener('atlas:set-logged'");
  const end = src.indexOf("document.addEventListener('atlas:plan-mutated'");
  assert.ok(start >= 0, 'the atlas:set-logged listener must exist');
  assert.ok(end > start, 'the atlas:plan-mutated listener must follow it');
  const slice = src.slice(start, end);
  return slice.slice(0, slice.lastIndexOf('});') + 3);
}

// Build the real listener with stubbed collaborators. `script` maps a detail
// id to { ms, fail } for the handleSetLogged stub: it records start/turn
// markers into `events` around a controllable delay, standing in for the real
// handler's awaits (its Atlas turn lands only after them).
function loadListener({ timeoutMs = 60000 } = {}) {
  const events = [];
  const completed = [];
  const cancelled = [];
  const listenerBox = {};
  const fakeDocument = {
    addEventListener: (name, fn) => { if (name === 'atlas:set-logged') listenerBox.fn = fn; },
  };
  const minted = [];
  const beginTurnResponse = ({ sessionId }) => {
    const ticket = { sessionId };
    minted.push(ticket);
    return ticket;
  };
  // Tickets are labelled by mint order (dispatch order in every test here):
  // the first ticket minted belongs to the first submission dispatched.
  const cancelTurnResponse = (ticket) => { cancelled.push(ticket); events.push(`cancel#${minted.indexOf(ticket)}`); };
  const completeTurnResponse = (ticket) => { completed.push(ticket); };
  const handleSetLogged = async (detail) => {
    events.push(`start:${detail.id}`);
    await new Promise((resolve) => setTimeout(resolve, detail.ms || 0));
    if (detail.fail) throw new Error(`boom:${detail.id}`);
    events.push(`turn:${detail.id}`);
  };
  const factory = new Function(
    'document', 'beginTurnResponse', 'cancelTurnResponse', 'completeTurnResponse',
    'handleSetLogged', 'COACH_LLM_TIMEOUT_MS', 'listenerBox',
    `'use strict';
     let setLoggedQueue = Promise.resolve();
     const setResponseTickets = new WeakMap();
     ${listenerBlock()}
     return {
       dispatch: (detail) => listenerBox.fn({ detail }),
       tickets: setResponseTickets,
       queue: () => setLoggedQueue,
     };`
  );
  const api = factory(
    fakeDocument, beginTurnResponse, cancelTurnResponse, completeTurnResponse,
    handleSetLogged, timeoutMs, listenerBox
  );
  assert.ok(listenerBox.fn, 'the listener must have been registered');
  return { ...api, events, completed, cancelled };
}

const detail = (id, ms, extra = {}) => ({
  id, ms, sessionId: 'S1', exercises: [{ exercise: 'Bench Press', sets: [] }], ...extra,
});

async function drain(api) {
  await api.queue();
  // Let any already-fired finally/timer callbacks land before asserting.
  await new Promise((resolve) => setTimeout(resolve, 5));
}

test('SESS-7: two submissions in flight record their turns in submission order', async () => {
  const api = loadListener();
  // A is submitted first but its coaching awaits run long; B is submitted
  // second and would complete almost immediately if run concurrently.
  api.dispatch(detail('A', 40));
  api.dispatch(detail('B', 0));
  await drain(api);
  assert.deepEqual(api.events.filter((e) => !e.startsWith('cancel')), [
    'start:A', 'turn:A', 'start:B', 'turn:B',
  ], 'the second submission must not start — let alone record its turn — before the first finishes');
});

test('SESS-7: the ticket is minted at dispatch, before the queued handling runs', async () => {
  const api = loadListener();
  const a = detail('A', 30);
  const b = detail('B', 0);
  api.dispatch(a);
  api.dispatch(b);
  // Synchronously after both dispatches (B still queued behind A), both
  // tickets already exist — minting is initiation-time, not run-time.
  assert.ok(api.tickets.get(a), 'ticket for A must be stored at dispatch');
  assert.ok(api.tickets.get(b), 'ticket for B must be stored at dispatch, while B is still queued');
  await drain(api);
});

test('SESS-7: a queued submission’s settlement bound starts when its handling starts', async () => {
  const api = loadListener({ timeoutMs: 30 });
  api.dispatch(detail('A', 50));
  api.dispatch(detail('B', 50));
  await drain(api);
  const startB = api.events.indexOf('start:B');
  const cancelB = api.events.indexOf('cancel#1'); // B's ticket: minted second
  assert.ok(startB >= 0 && cancelB > startB,
    'B must not be cancelled while it is still waiting in the queue — its bound runs from its own start');
  assert.equal(api.completed.length, 2, 'both tickets are completed (released) exactly once');
});

test('SESS-7: a rejected submission still releases its ticket and never jams the queue', async () => {
  const api = loadListener();
  api.dispatch(detail('bad', 0, { fail: true }));
  api.dispatch(detail('B', 0));
  await drain(api);
  assert.deepEqual(api.events.filter((e) => !e.startsWith('cancel')), [
    'start:bad', 'start:B', 'turn:B',
  ], 'the submission after a rejected one still runs, in order');
  assert.equal(api.completed.length, 2, 'the rejected submission’s ticket is still released in its finally');
});

test('SESS-7: the listener queues handling instead of invoking it directly', () => {
  const block = listenerBlock();
  assert.match(block, /setLoggedQueue = setLoggedQueue\.then\(/,
    'the listener must chain each submission onto the serialization queue');
  assert.ok(
    block.indexOf('beginTurnResponse') < block.indexOf('setLoggedQueue = setLoggedQueue.then('),
    'the ticket is minted at dispatch, before the submission is queued'
  );
  assert.match(src, /let setLoggedQueue = Promise\.resolve\(\);/,
    'the queue is a module-level promise chain in coach-conversation.js');
});
