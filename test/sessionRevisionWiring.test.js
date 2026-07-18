'use strict';

// F10B-REVISION-WIRING-1 — the app.js wiring that turns an EXPLICIT mid-session
// substitution into durable future-set revisions, and the structural proof that a
// PERFORMED value never creates one. Slices the real emitFutureSetRevision from the
// built bundle and drives it with the real sessionLedger + a store shim + an api stub.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const ledger = require('../src/app/sessionLedger.js');

function loadHarness() {
  const slice = appSrc.slice(
    appSrc.indexOf('function emitFutureSetRevision('),
    appSrc.indexOf('function reorderPlannedExercise('),
  );
  assert.ok(slice.includes('function emitFutureSetRevision('), 'slice must contain emitFutureSetRevision');
  const state = { plan: null, log: [], revisions: [], posts: [], snapshots: 0 };
  const factory = new Function(
    'buildFutureRevisions', 'appendRevisions', 'ledgerPerformedSetCount', 'state', `
    function getActivePlannedSession(){ return state.plan; }
    function getSessionLog(){ return state.log; }
    function getSessionRevisions(){ return state.revisions; }
    function setSessionRevisions(v){ state.revisions = Array.isArray(v) ? v : []; }
    function saveSessionSnapshot(){ state.snapshots++; }
    function api(url, opts){ state.posts.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({}); }
    ${slice}
    return { emitFutureSetRevision, state };
  `);
  return factory(ledger.buildFutureRevisions, ledger.appendRevisions, ledger.performedSetCount, state);
}

const ACCEPTED = { accepted: true, session_id: 'S1', session_date: '2026-07-16', plan_version: 'pv_x' };
const PRESC = { weight: 60, reps: 8, sets: 3, rir: 2 };

test('an explicit substitution checkpoints future-set revisions (append + post), performed sets frozen', async () => {
  const h = loadHarness();
  h.state.plan = ACCEPTED;
  h.state.log = [{ exercise: 'Bench Press', weight: 185, reps: 8, rir: 2 }]; // 1 set of the ORIGINAL already done
  h.emitFutureSetRevision('pi_1', 'DBP01', PRESC, 'Bench Press');
  await Promise.resolve();
  // Set 1 (performed) is NOT revised; sets 2 & 3 are.
  assert.deepEqual(h.state.revisions.map(r => r.set_index), [2, 3]);
  assert.ok(h.state.revisions.every(r => r.plan_version === 2 && r.recommendation_source === 'live_revision'));
  assert.equal(h.state.posts.length, 2, 'one /revision post per future set');
  assert.ok(h.state.posts.every(p => p.url === '/api/session-plan-sets/revision'));
  assert.equal(h.state.posts[0].body.revision.target_weight, 60);
  assert.equal(h.state.posts[0].body.plan_version, 'pv_x', 'the pv_ token rides on the session envelope');
  assert.ok(h.state.snapshots >= 1, 'the revision is persisted for reload');
});

test('an unaccepted plan / no canonical code / no explicit target → NO revision (fails closed)', async () => {
  const h = loadHarness();
  // unaccepted plan
  h.state.plan = { accepted: false, session_id: 'S1' };
  h.emitFutureSetRevision('pi_1', 'DBP01', PRESC, 'Bench Press');
  assert.equal(h.state.revisions.length, 0);
  // accepted, but no prescription targets
  h.state.plan = ACCEPTED;
  h.emitFutureSetRevision('pi_1', 'DBP01', { sets: 3 }, 'Bench Press');
  assert.equal(h.state.revisions.length, 0, 'no explicit weight/reps → no fabricated revision');
  assert.equal(h.state.posts.length, 0);
});

test('append-only: re-emitting the same substitution does not duplicate revisions', async () => {
  const h = loadHarness();
  h.state.plan = ACCEPTED;
  h.state.log = [];
  h.emitFutureSetRevision('pi_1', 'DBP01', PRESC, 'Bench Press');
  const after = h.state.revisions.length;
  h.emitFutureSetRevision('pi_1', 'DBP01', PRESC, 'Bench Press');
  assert.equal(h.state.revisions.length, after, 'no duplicate (item,set,version) rows');
});

// ── structural: a PERFORMED value never creates a revision ────────────────────────

test('performed values never create revisions: the log path never touches sessionRevisions', () => {
  const emit = appSrc.slice(appSrc.indexOf('function emitSetLogged('), appSrc.indexOf('// The session lives in the buffer'));
  assert.doesNotMatch(emit, /setSessionRevisions|buildFutureRevisions|emitFutureSetRevision/,
    'emitSetLogged (logging a set) must never create a revision — only an explicit recommendation does');
  // The ONLY caller of emitFutureSetRevision is the explicit substitution path.
  const callers = (appSrc.match(/emitFutureSetRevision\(/g) || []).length;
  assert.equal(callers, 2, 'exactly the definition + the one explicit-substitution call site');
  const sub = appSrc.slice(appSrc.indexOf('function applySessionSubstitution('), appSrc.indexOf('function emitFutureSetRevision('));
  assert.match(sub, /emitFutureSetRevision\(originalItemId/, 'the explicit substitution is the revision trigger');
});
