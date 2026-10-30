'use strict';

// #1625 — value-correction wiring: tryApplyValueCorrection driven against a
// controlled session log, sliced from the built bundle exactly as the
// identity-correction wiring tests drive tryApplyIdentityCorrection.
//
// The defect, end to end: the retained buffer is the client's session log.
// "Typo. 275." matched no deterministic lane (the identity classifier needs an
// exercise NAME and rejects a digit-led capture), so the turn fell through to
// /api/coach/chat and the retained RDL sets kept 285 — while the model's recap
// asserted they were "logged as planned" (275). These tests pin both halves:
//   (a) the correction APPLIES to the retained sets, and
//   (b) the confirmation the athlete sees is composed from the buffer's own
//       post-correction state (the dispatched detail), never from free prose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

let valueCorrection;
test.before(async () => { valueCorrection = await import('../src/app/valueCorrection.js'); });

class FakeCustomEvent {
  constructor(type, init) { this.type = type; this.detail = (init && init.detail) || {}; }
}

// Slice the same span the identity-correction harness uses: it carries the
// correction helpers (resolveBufferedLiftName), BOTH correction lanes and
// their announcers. Only tryApplyValueCorrection is called here.
function loadValueHarness() {
  const slice = appSrc.slice(
    appSrc.indexOf('// ── P0 PR 4:'),
    appSrc.indexOf('function renderActiveSessionBanner(')
  );
  assert.ok(slice.includes('tryApplyValueCorrection'), 'the bundle slice must contain tryApplyValueCorrection');
  assert.ok(slice.includes('resolveBufferedLiftName'), 'the bundle slice must contain resolveBufferedLiftName');

  const events = [];
  const fakeDoc = {
    getElementById: () => null,
    dispatchEvent: evt => events.push(evt),
  };
  const fakeWindow = { valueCorrection };

  const factory = new Function('document', 'window', 'CustomEvent', 'events', `
    ${STORE_SHIM}
    let lastIntentData = null;
    let activeExercise = null;
    function getCanonicalSession() { return null; }
    function renderActiveSessionBanner() {}

    ${slice}

    return {
      setSessionLog: log => { sessionLog = log.map(e => Object.assign({}, e)); },
      getSessionLog: () => sessionLog.map(e => Object.assign({}, e)),
      setCoachDiscussionSinceLog,
      tryApplyValueCorrection,
      getEvents: () => events.slice(),
    };
  `);
  return factory(fakeDoc, fakeWindow, FakeCustomEvent, events);
}

const set = (exercise, weight, reps, rir) => ({ exercise, weight, reps, rir });
const benchRdlBuffer = () => [
  set('Bench Press', 225, 5, 2), set('Bench Press', 225, 5, 2), set('Bench Press', 225, 5, 2),
  set('RDL', 285, 6, 2), set('RDL', 285, 6, 2), set('RDL', 285, 6, 2),
];

// ── (a) THE REPRO: the corpus correction applies to the retained sets ────────
test('VC wiring repro: "Typo. 275." rewrites the retained RDL sets to 275, bench untouched', () => {
  const h = loadValueHarness();
  h.setSessionLog(benchRdlBuffer());
  const handled = h.tryApplyValueCorrection('Typo. 275.');
  assert.equal(handled, true, 'the correction turn must be handled deterministically');
  const log = h.getSessionLog();
  assert.deepEqual(log.filter(s => s.exercise === 'RDL').map(s => s.weight), [275, 275, 275],
    'all retained RDL sets carry the corrected weight');
  assert.deepEqual(log.filter(s => s.exercise === 'Bench Press').map(s => s.weight), [225, 225, 225],
    'the bench sets are exactly as logged');
  assert.deepEqual(log.filter(s => s.exercise === 'RDL').map(s => [s.reps, s.rir]), [[6, 2], [6, 2], [6, 2]],
    'only the weight field changed');
});

// ── (b) the confirmation is composed from the buffer's post-correction state ─
test('VC wiring: the announced detail equals the buffer truth (from = pre value, to = applied value, count = sets changed)', () => {
  const h = loadValueHarness();
  h.setSessionLog(benchRdlBuffer());
  const before = h.getSessionLog().filter(s => s.exercise === 'RDL').map(s => s.weight);
  h.tryApplyValueCorrection('Typo. 275.');
  const ev = h.getEvents().find(e => e.type === 'atlas:value-corrected');
  assert.ok(ev, 'a value-corrected event must be dispatched');
  assert.deepEqual(ev.detail, { exercise: 'RDL', field: 'weight', from: 285, to: 275, count: 3, unchanged: false });
  assert.equal(ev.detail.from, before[0], 'from is the value the buffer actually held');
  const after = h.getSessionLog().filter(s => s.exercise === 'RDL').map(s => s.weight);
  assert.ok(after.every(w => w === ev.detail.to), 'to is the value the buffer actually holds now');
  assert.equal(ev.detail.count, after.length, 'count is the number of retained sets corrected');
  // …and the rendered line, composed from that detail, states exactly that.
  assert.equal(valueCorrection.formatValueCorrection(ev.detail),
    '✓ Corrected RDL: 285 → 275 on all 3 sets.');
});

test('VC wiring: a named correction applies to the whole named group, even when it is not the trailing group', () => {
  const h = loadValueHarness();
  h.setSessionLog([
    set('RDL', 285, 6, 2), set('RDL', 285, 6, 2), set('RDL', 285, 6, 2),
    set('Bench Press', 225, 5, 2), set('Bench Press', 225, 5, 2), set('Bench Press', 225, 5, 2),
  ]);
  assert.equal(h.tryApplyValueCorrection('RDL was 275'), true);
  const log = h.getSessionLog();
  assert.deepEqual(log.filter(s => s.exercise === 'RDL').map(s => s.weight), [275, 275, 275]);
  assert.deepEqual(log.filter(s => s.exercise === 'Bench Press').map(s => s.weight), [225, 225, 225]);
});

test('VC wiring: a mixed-weight trailing group is NOT guessed at — it asks and mutates nothing', () => {
  const h = loadValueHarness();
  const buffer = [
    set('Bench Press', 225, 5, 2), set('Bench Press', 225, 5, 2), set('Bench Press', 225, 5, 2),
    set('Back Squat', 135, 5, 5), set('Back Squat', 225, 3, 4), set('Back Squat', 275, 2, 3), set('Back Squat', 315, 3, 3),
  ];
  h.setSessionLog(buffer);
  assert.equal(h.tryApplyValueCorrection('Typo. 275.'), true, 'a clear correction cue is handled — by asking');
  assert.deepEqual(h.getSessionLog(), buffer, 'no set may be mutated on an ambiguous target');
  assert.ok(h.getEvents().some(e => e.type === 'atlas:value-correction-ambiguous'), 'the ask event fires');
  assert.ok(!h.getEvents().some(e => e.type === 'atlas:value-corrected'), 'no correction may be claimed');
});

test('VC wiring: after the conversation has moved on, an unnamed correction asks instead of mutating (ADD-5 lesson)', () => {
  const h = loadValueHarness();
  h.setSessionLog(benchRdlBuffer());
  h.setCoachDiscussionSinceLog(true);
  assert.equal(h.tryApplyValueCorrection('Typo. 275.'), true);
  assert.deepEqual(h.getSessionLog(), benchRdlBuffer(), 'the retained sets are left exactly as logged');
  assert.ok(h.getEvents().some(e => e.type === 'atlas:value-correction-ambiguous'));
});

test('VC wiring: a correction naming a lift that is not in the buffer asks and mutates nothing', () => {
  const h = loadValueHarness();
  h.setSessionLog(benchRdlBuffer());
  assert.equal(h.tryApplyValueCorrection('Trap Bar Deadlift was 275'), true);
  assert.deepEqual(h.getSessionLog(), benchRdlBuffer());
  assert.ok(h.getEvents().some(e => e.type === 'atlas:value-correction-ambiguous'));
});

test('VC wiring: a reps correction changes only the reps of the trailing group', () => {
  const h = loadValueHarness();
  h.setSessionLog([
    set('Bench Press', 225, 5, 2), set('Bench Press', 225, 5, 2), set('Bench Press', 225, 5, 2),
    set('RDL', 275, 6, 2), set('RDL', 275, 6, 2), set('RDL', 275, 6, 2),
  ]);
  assert.equal(h.tryApplyValueCorrection('typo, 8 reps'), true);
  const log = h.getSessionLog();
  assert.deepEqual(log.filter(s => s.exercise === 'RDL').map(s => s.reps), [8, 8, 8]);
  assert.deepEqual(log.filter(s => s.exercise === 'RDL').map(s => s.weight), [275, 275, 275]);
  const ev = h.getEvents().find(e => e.type === 'atlas:value-corrected');
  assert.equal(ev.detail.field, 'reps');
});

test('VC wiring: a no-op correction is answered truthfully (already reads the value), never as a change', () => {
  const h = loadValueHarness();
  h.setSessionLog([
    set('RDL', 275, 6, 2), set('RDL', 275, 6, 2), set('RDL', 275, 6, 2),
  ]);
  assert.equal(h.tryApplyValueCorrection('Typo. 275.'), true);
  const ev = h.getEvents().find(e => e.type === 'atlas:value-corrected');
  assert.deepEqual(ev.detail, { exercise: 'RDL', field: 'weight', from: 275, to: 275, count: 3, unchanged: true });
  assert.equal(valueCorrection.formatValueCorrection(ev.detail), '✓ RDL already reads 275 — nothing to change.');
});

test('VC wiring: non-corrections fall through untouched (no handling, no events, no mutation)', () => {
  const h = loadValueHarness();
  h.setSessionLog(benchRdlBuffer());
  for (const text of ['275', 'Bench 225 5/2 x3.', 'that was heavy', 'how many sets left?', 'RDL 285 6/2 x3']) {
    assert.equal(h.tryApplyValueCorrection(text), false, `must fall through: "${text}"`);
  }
  assert.deepEqual(h.getSessionLog(), benchRdlBuffer());
  assert.equal(h.getEvents().length, 0);
});

test('VC wiring: with an empty buffer there is nothing to correct — fall through', () => {
  const h = loadValueHarness();
  h.setSessionLog([]);
  assert.equal(h.tryApplyValueCorrection('Typo. 275.'), false);
  assert.equal(h.getEvents().length, 0);
});
