'use strict';

// Decision Desk #942 — D7(a) refuse-and-ask gate (owner verdict: per-line
// orchestration boundary, after recognized lines resolve, before preview assembly).
//
// A set line whose exercise NEITHER the parser NOR the KB recognizes must refuse
// and ask (needs_clarification, ZERO rows) instead of silently logging a made-up
// titlecased lift. KB-known-but-parser-narrow lifts (front squat, cable fly) keep
// logging — the refusal is KB-AWARE, so it only ever REDUCES what reaches preview
// for genuinely-unknown lifts. The KB resolver is INJECTED (never imported here) so
// the KB→parser decoupling boundary holds. Pure: no I/O.

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyUnresolvedLiftGate } = require('../services/unresolvedLiftGate');

// A stub KB resolver: only these names resolve confidently.
const KB = new Set(['front squat', 'cable fly', 'bench press']);
const resolve = (name) => {
  const key = String(name || '').trim().toLowerCase();
  return KB.has(key) ? { confident: true, name, exercise_id: key } : null;
};

const setEntry = (over = {}) => ({ intent: 'log_sets', raw_text: 'x', canonical_name: 'Bench Press', sets: [{ weight: 225, reps: 5, rir: 2 }], warnings: [], ...over });

// ── single line ───────────────────────────────────────────────────────────────

test('single: a genuinely-unknown set line (parser + KB both fail) refuses with zero rows', () => {
  const parsed = setEntry({ canonical_name: 'Zercher Thrust', warnings: ['unknown_exercise'] });
  const out = applyUnresolvedLiftGate(parsed, resolve);
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(!out.sets, 'no sets survive a refusal');
  assert.ok(Array.isArray(out.unresolved) && out.unresolved.length === 1);
  assert.match(out.message, /didn.?t catch|which one/i);
  assert.ok(out.warnings.includes('unresolved_lift'));
});

test('single: KB-known-but-parser-narrow lift keeps logging (no over-refusal)', () => {
  for (const name of ['Front Squat', 'Cable Fly']) {
    const parsed = setEntry({ canonical_name: name, warnings: ['unknown_exercise'] });
    const out = applyUnresolvedLiftGate(parsed, resolve);
    assert.equal(out.intent, 'log_sets', `${name} must keep logging (KB rescues)`);
    assert.equal(out.sets.length, 1);
  }
});

test('single: a fully-recognized line (no unknown_exercise) is untouched', () => {
  const parsed = setEntry();
  assert.equal(applyUnresolvedLiftGate(parsed, resolve), parsed);
});

// ── multi line ──────────────────────────────────────────────────────────────

test('multi: known rows survive; the unknown line is withheld + clarified', () => {
  const parsed = {
    intent: 'log_sets_multi', raw_text: 'x',
    exercises: [
      { canonical_name: 'Bench Press', sets: [{ weight: 225, reps: 5 }], warnings: [] },
      { canonical_name: 'Zercher Thrust', sets: [{ weight: 95, reps: 8 }], warnings: ['unknown_exercise'] },
    ],
    warnings: ['unknown_exercise'],
  };
  const out = applyUnresolvedLiftGate(parsed, resolve);
  assert.equal(out.intent, 'log_sets_multi');
  assert.deepEqual(out.exercises.map(e => e.canonical_name), ['Bench Press'], 'only the known lift survives as a row');
  assert.ok(out.unresolved.some(u => /zercher/i.test(u.line)), 'the unknown lift is withheld for clarification');
  assert.ok(out.warnings.includes('unresolved_lift'));
});

test('multi: all lines unknown → needs_clarification, zero rows', () => {
  const parsed = {
    intent: 'log_sets_multi', raw_text: 'x',
    exercises: [
      { canonical_name: 'Zercher Thrust', sets: [{ weight: 95, reps: 8 }], warnings: ['unknown_exercise'] },
      { canonical_name: 'Jefferson Curl', sets: [{ weight: 45, reps: 10 }], warnings: ['unknown_exercise'] },
    ],
    warnings: ['unknown_exercise'],
  };
  const out = applyUnresolvedLiftGate(parsed, resolve);
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(!out.exercises, 'no exercises survive');
  assert.equal(out.unresolved.length, 2);
});

test('multi: a KB-known parser-narrow line among others is NOT withheld', () => {
  const parsed = {
    intent: 'log_sets_multi', raw_text: 'x',
    exercises: [
      { canonical_name: 'Front Squat', sets: [{ weight: 185, reps: 5 }], warnings: ['unknown_exercise'] },
      { canonical_name: 'Bench Press', sets: [{ weight: 225, reps: 5 }], warnings: [] },
    ],
    warnings: ['unknown_exercise'],
  };
  const out = applyUnresolvedLiftGate(parsed, resolve);
  assert.equal(out.intent, 'log_sets_multi');
  assert.deepEqual(out.exercises.map(e => e.canonical_name).sort(), ['Bench Press', 'Front Squat']);
  assert.ok(!out.unresolved, 'nothing withheld — KB rescued Front Squat');
});

// ── totality / safety ─────────────────────────────────────────────────────────

test('non-log intents and garbage pass through untouched, never throw', () => {
  for (const p of [null, undefined, 42, { intent: 'needs_clarification', message: 'x' }, { intent: 'small_talk' }]) {
    assert.doesNotThrow(() => applyUnresolvedLiftGate(p, resolve));
  }
  const nc = { intent: 'needs_clarification', message: 'x' };
  assert.equal(applyUnresolvedLiftGate(nc, resolve), nc);
});
