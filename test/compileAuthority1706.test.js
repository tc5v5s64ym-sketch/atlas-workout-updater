'use strict';

// #1706 (Astra D-01) — model-compiled session text becomes real workout rows.
//
// DEFECT (CONFIRMED by the Astra boundary audit at head 52600a56, reproduced
// here at the current s3 head): when the structured set buffer is empty,
// runCloseout asks the model to compile the conversation history
// (POST /api/session/compile) and drops the returned text into the composer
// as if the athlete typed it. The parser validates the generated notation,
// not whether the athlete stated its values — so history containing only
// "I did some stretching" plus a model return of `Bench Press 315 12/0`
// stages a real preview, and approving it appends a real Log_Cleaned row
// (volume 3780 computed from invented operands).
//
// FIX DIRECTION: generated compilation must never be an authority for actual
// workout rows. runCloseout must not call /api/session/compile, the route
// must not exist, and the coach must not export a session compiler. The
// empty-buffer closeout asks the athlete to re-enter the sets instead.
//
// These tests are written against the FIXED behavior: they FAIL on the
// current head (the defect reproduces) and PASS once the fix lands.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { routeDefinitions } = require('../config/routes');
const coach = require('../services/coach');

const repoRoot = path.join(__dirname, '..');

function readBuiltApp() {
  return fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
}

function runCloseoutSlice() {
  const src = readBuiltApp();
  const start = src.indexOf('async function runCloseout()');
  assert.ok(start >= 0, 'runCloseout must exist in the built app');
  const end = src.indexOf('function generateWriteId()', start);
  assert.ok(end > start, 'generateWriteId must follow runCloseout');
  return src.slice(start, end);
}

// Eval the REAL runCloseout slice with fakes. The slice contains backticks,
// so the factory source is built by concatenation, never interpolated into a
// template literal.
function buildCloseoutHarness({ turns, compileText }) {
  const slice = runCloseoutSlice();
  const calls = [];
  const statuses = [];
  const dispatched = [];
  const composer = { value: '' };
  const form = { dispatchEvent: evt => dispatched.push(evt) };
  const fakeDoc = {
    getElementById: id => (id === 'logger-form' ? form : null),
  };
  const fakeWindow = { getChatHistory: () => turns };
  const prelude = [
    'let sessionCompiledAwaitingPreview = false;',
    'let lastWrite = null;',
    'let lastWriteTurnCount = null;',
    'const loggerStatus = {};',
    'const workoutTextInput = composer;',
    'async function waitForLatestSetTurn() {}',
    'function getSessionLog() { return []; }',
    'function getCanonicalSession() { return null; }',
    'function setStatus(el, text, kind) { statuses.push({ text: text, kind: kind }); }',
    'function invalidatePreview() {}',
    'async function api(path, opts) {',
    '  calls.push({ path: path, body: opts && opts.body });',
    '  if (path === "/api/session/compile") {',
    '    return { data: { workout_text: compileText } };',
    '  }',
    '  return { data: {} };',
    '}',
  ].join('\n');
  const factorySrc = prelude + '\n' + slice + '\nreturn { runCloseout: runCloseout, getComposer: function () { return composer.value; }, getCompiledFlag: function () { return sessionCompiledAwaitingPreview; } };';
  const factory = new Function('document', 'window', 'calls', 'statuses', 'dispatched', 'composer', 'turns', 'compileText', factorySrc);
  const api = factory(fakeDoc, fakeWindow, calls, statuses, dispatched, composer, turns, compileText);
  return { api, calls, statuses, dispatched, composer };
}

test('#1706: runCloseout with an empty buffer never calls the model compile — invented text must not reach the composer', async () => {
  // The audit probe: history holds only "I did some stretching"; the model
  // invents `Bench Press 315 12/0`.
  const turns = [{ role: 'user', text: 'I did some stretching' }];
  const { api, calls, statuses, dispatched, composer } = buildCloseoutHarness({
    turns,
    compileText: 'Bench Press 315 12/0',
  });
  await api.runCloseout();

  assert.ok(
    !calls.some(c => c.path === '/api/session/compile'),
    'runCloseout must not call /api/session/compile — the model is never an authority for workout rows'
  );
  assert.equal(composer.value, '', 'no model text may be planted in the composer');
  assert.equal(dispatched.length, 0, 'no preview may be staged from compiled text');
  assert.equal(api.getCompiledFlag(), false, 'no compiled preview may be armed');
  // The athlete is asked for the missing values instead.
  assert.ok(
    statuses.some(s => /type them in the composer|log some sets|re-enter/i.test(s.text)),
    'closeout must route to manual entry, got: ' + JSON.stringify(statuses)
  );
});

test('#1706: no /api/session/compile route is registered', () => {
  const route = routeDefinitions.find(r => r.path === '/api/session/compile');
  assert.equal(route, undefined, 'the compile endpoint must not exist — it is the loaded gun behind D-01');
});

test('#1706: runCloseout source contains no compile fallback', () => {
  const slice = runCloseoutSlice();
  assert.ok(
    !slice.includes('/api/session/compile'),
    'runCloseout must not reference /api/session/compile'
  );
});

test('#1706: the coach module exports no session compiler', () => {
  assert.equal(typeof coach.compileSessionFromHistory, 'undefined', 'compileSessionFromHistory must be removed');
  assert.equal(typeof coach.buildCompileSystemPrompt, 'undefined', 'buildCompileSystemPrompt must be removed');
});
