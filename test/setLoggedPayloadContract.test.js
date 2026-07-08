'use strict';

// PR-10 / Minefield Map §3 — byte-for-byte payload contract for `atlas:set-logged`.
//
// coach-conversation.js and nav.js consume this event; its detail fields may not be
// renamed, removed, retyped, or reordered in meaning (the next-up/handoff logic and
// the G3-family closeout fixes depend on `completed` + `plannedOrder`). PR-10 moved
// sessionCompleted into the store, so the one legitimate change is
// `completed: [...sessionCompleted]` → `completed: [...getSessionCompleted()]`; every
// other field is identical. This test fails if the migration (or a later PR) drops,
// renames, reorders, or re-sources any field. Source-introspection style — the repo's
// frontend-wiring convention (no jsdom dependency).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Isolate the emitSetLogged dispatch's `detail: { ... }` object literal.
const anchor = appSrc.indexOf("new CustomEvent('atlas:set-logged'");
assert.ok(anchor >= 0, 'app.js must dispatch atlas:set-logged');
const detailStart = appSrc.indexOf('detail: {', anchor);
assert.ok(detailStart >= 0, 'the dispatch must carry a detail object');
// Balanced-brace slice of the detail object.
let i = appSrc.indexOf('{', detailStart), depth = 0, end = -1;
for (; i < appSrc.length; i++) {
  if (appSrc[i] === '{') depth++;
  else if (appSrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
const detail = appSrc.slice(detailStart, end + 1);

test('atlas:set-logged carries exactly the frozen field set, in order', () => {
  // Top-level keys of the detail literal, in source order. Keys appear as `key:`
  // (value form) or `key,` (shorthand — planIsComplete / nextPlanned); the three
  // conditional fields start with `...` and are asserted separately below. Strip the
  // opening `detail: {` line first so the outer key isn't counted.
  const inner = detail.slice(detail.indexOf('{') + 1);
  const keyOrder = [...inner.matchAll(/^\s*([a-zA-Z][a-zA-Z]*)\s*[:,]/gm)].map(m => m[1]);
  assert.deepEqual(keyOrder, [
    'exercises', 'text', 'planIsComplete', 'nextPlanned', 'completed', 'plannedOrder',
  ], 'the fixed (non-conditional) detail keys must be these, in this order');
});

test('completed[] is spread from the STORE getter, not a stale local (PR-10 migration)', () => {
  assert.match(detail, /completed:\s*\[\.\.\.getSessionCompleted\(\)\]/,
    'completed must be [...getSessionCompleted()] — the single source of truth, not a copied sessionCompleted let');
});

test('plannedOrder is the live selector, not a cached array', () => {
  assert.match(detail, /plannedOrder:\s*plannedExerciseOrder\(\)/,
    'plannedOrder must call plannedExerciseOrder() so it reflects the current plan');
});

test('the three conditional fields remain conditional spreads (additive, never always-present)', () => {
  assert.match(detail, /\.\.\.\(plannedQueue\.length \? \{ plannedQueue \} : \{\}\)/,
    'plannedQueue must stay a conditional spread');
  assert.match(detail, /\.\.\.\(Array\.isArray\(substitutions\) && substitutions\.length \? \{ substitutions \} : \{\}\)/,
    'substitutions must stay a conditional spread');
  assert.match(detail, /\.\.\.\(lastUnverifiedExercise \? \{ unverified: lastUnverifiedExercise \} : \{\}\)/,
    'unverified must stay a conditional spread (lastUnverifiedExercise is PR-11 write-slice state, still a bare let)');
});

test('planIsComplete keeps its derived-from-remaining definition (G3 closeout guard)', () => {
  assert.match(appSrc, /const planIsComplete = plannedExerciseOrder\(\)\.length > 0 && remaining\.length === 0;/,
    'planIsComplete must derive from the same remaining state as nextPlanned so they cannot disagree');
});
