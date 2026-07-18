'use strict';

// F09G / CONVO-LOG-1 — pending bodyweight-rep clarification. When the parser detects
// the reps but must ask (bare-rep bodyweight), those sets must be HELD and committed on
// a short affirmation ("Just log it") — never dropped, never fabricated. DOM-free logic,
// unit-tested directly.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

let PC;
describe('pendingClarification', () => {
  it('loads the ES module', async () => {
    PC = await import('../src/app/pendingClarification.js');
    assert.ok(PC.looksLikeClarificationYes && PC.setPendingClarification && PC.resolvePendingClarification);
  });

  beforeEach(() => { if (PC) PC.clearPendingClarification(); });

  // ── affirmation detection ──
  it('looksLikeClarificationYes: matches short standalone confirmations only', () => {
    for (const y of ['Just log it', 'just log it', 'log it', 'log them', 'Log', 'yes', 'Yep', 'yeah', 'correct', 'do it', 'go ahead', "that's right", 'Yes!', 'log it.']) {
      assert.equal(PC.looksLikeClarificationYes(y), true, `affirmation: ${y}`);
    }
    for (const n of ['yes but heavier', 'log my squats too', 'how many reps?', 'no', 'actually 12 not 15', 'Bench 225 5/2', '', '   ', 'logging felt good']) {
      assert.equal(PC.looksLikeClarificationYes(n), false, `not an affirmation: ${n}`);
    }
  });

  // ── clarificationFrom: extract a holdable {exercise, sets} ──
  it('clarificationFrom: extracts from a parser partial (exercise + sets)', () => {
    const c = PC.clarificationFrom({ partial: { exercise: 'Hanging Knee Raises', sets: [{ weight: null, reps: 15, rir: null }, { weight: null, reps: 12, rir: null }, { weight: null, reps: 10, rir: null }] } });
    assert.equal(c.exercise, 'Hanging Knee Raises');
    assert.deepEqual(c.sets.map(s => s.reps), [15, 12, 10]);
  });

  it('clarificationFrom: extracts from the thrown client error shape (recognizedExercise + partialSets)', () => {
    const c = PC.clarificationFrom({ recognizedExercise: 'Hanging Knee Raises', partialSets: [{ weight: null, reps: 20, rir: null }] });
    assert.equal(c.exercise, 'Hanging Knee Raises');
    assert.deepEqual(c.sets.map(s => s.reps), [20]);
  });

  it('clarificationFrom: null when there is no exercise or no set with reps (nothing to hold)', () => {
    assert.equal(PC.clarificationFrom(null), null);
    assert.equal(PC.clarificationFrom({ partial: { exercise: 'Hanging Knee Raises', sets: [] } }), null);
    assert.equal(PC.clarificationFrom({ partial: { exercise: 'Hanging Knee Raises', sets: [{ weight: 100, reps: null }] } }), null);
    assert.equal(PC.clarificationFrom({ partial: { sets: [{ reps: 10 }] } }), null); // no exercise (ambiguous alias)
  });

  // ── pendingSetsToLogObjs: bodyweight shape, all reps retained, in order ──
  it('pendingSetsToLogObjs: bodyweight weight null → "0", each rep its own set, order kept', () => {
    const rows = PC.pendingSetsToLogObjs({ exercise: 'Hanging Knee Raises', sets: [{ weight: null, reps: 15, rir: null }, { weight: null, reps: 12, rir: 2 }, { weight: null, reps: 10, rir: null }] });
    assert.deepEqual(rows, [
      { exercise: 'Hanging Knee Raises', weight: '0', reps: '15', rir: '', notes: '' },
      { exercise: 'Hanging Knee Raises', weight: '0', reps: '12', rir: '2', notes: '' },
      { exercise: 'Hanging Knee Raises', weight: '0', reps: '10', rir: '', notes: '' },
    ]);
  });

  // ── the state machine ──
  it('resolve commits EXACTLY the held reps on an affirmation, and clears (no drop, no fabrication)', () => {
    PC.setPendingClarification({ partial: { exercise: 'Hanging Knee Raises', sets: [{ weight: null, reps: 15 }, { weight: null, reps: 12 }, { weight: null, reps: 10 }] } });
    assert.ok(PC.getPendingClarification(), 'held after capture');
    const rows = PC.resolvePendingClarification('Just log it');
    assert.deepEqual(rows.map(r => r.reps), ['15', '12', '10'], 'exactly the held reps, all of them, in order');
    assert.equal(PC.getPendingClarification(), null, 'the hold is cleared after resolving');
  });

  it('resolve returns null and KEEPS the hold when the message is not an affirmation', () => {
    PC.setPendingClarification({ partial: { exercise: 'Hanging Knee Raises', sets: [{ weight: null, reps: 15 }] } });
    assert.equal(PC.resolvePendingClarification('actually make it 20'), null);
    assert.ok(PC.getPendingClarification(), 'a non-affirmation does not consume the hold');
  });

  it('resolve returns null when nothing is held (affirmation with no pending never fabricates)', () => {
    assert.equal(PC.getPendingClarification(), null);
    assert.equal(PC.resolvePendingClarification('Just log it'), null);
  });

  it('a new clarification supersedes the prior; a non-holdable one clears the slot', () => {
    PC.setPendingClarification({ partial: { exercise: 'Hanging Knee Raises', sets: [{ reps: 15 }] } });
    PC.setPendingClarification({ partial: { exercise: 'Push-Up', sets: [{ reps: 30 }] } });
    assert.equal(PC.getPendingClarification().exercise, 'Push-Up', 'newest wins');
    PC.setPendingClarification({ partial: { exercise: 'Squat', sets: [] } }); // nothing to hold
    assert.equal(PC.getPendingClarification(), null, 'a non-holdable clarification clears the slot');
  });

  it('clearPendingClarification drops the hold (supersede on a fresh log / reset)', () => {
    PC.setPendingClarification({ partial: { exercise: 'Hanging Knee Raises', sets: [{ reps: 15 }] } });
    PC.clearPendingClarification();
    assert.equal(PC.getPendingClarification(), null);
    assert.equal(PC.resolvePendingClarification('yes'), null);
  });
});

// ── app.js wiring (source-slice) ─────────────────────────────────────────────
// Deterministic guard that the composer integrates the module at the four required
// points, and in the required ORDER (resolution before the "log it"/closeout routing),
// so the browser flow can't silently regress the hold/resolve/supersede behavior.
const fs = require('node:fs');
const path = require('node:path');
describe('pendingClarification — app.js wiring', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  it('carries the parser-detected sets on the needs_clarification error (no discard)', () => {
    assert.match(app, /err\.partialSets\s*=\s*\(parsed\?\.partial && Array\.isArray\(parsed\.partial\.sets\)\)/,
      'rowsFromBackendParsedWorkout must carry partial.sets so the clarification can hold them');
  });

  it('a short affirmation resolves the hold BEFORE the closeout / "log it" routing', () => {
    const resolveIdx = app.indexOf('resolvePendingClarification(workoutTextInput.value.trim())');
    const closeoutIdx = app.indexOf('if (looksLikeLogIt(workoutTextInput.value)) {');
    assert.ok(resolveIdx > 0, 'the composer must consult resolvePendingClarification');
    assert.ok(closeoutIdx > 0, 'the closeout check must exist');
    assert.ok(resolveIdx < closeoutIdx, 'resolution must run before the "log it"/closeout routing');
    // The resolved rows are committed through the same buffer path as a normal set log.
    assert.match(app.slice(resolveIdx, closeoutIdx), /emitSetLogged\(resolvedRows,/,
      'a resolved clarification commits its rows via emitSetLogged');
  });

  it('captures a sets-carrying needs_clarification (holds it and surfaces the question)', () => {
    assert.match(app, /err\.parsedIntent === 'needs_clarification' && setPendingClarification\(err\)/,
      'the catch block must hold a sets-carrying clarification instead of dropping it to the coach');
  });

  it('a real set log supersedes any held clarification', () => {
    // F10S2 inserts the deferred-swap arming between the clear and the emit; the
    // contract pinned here is unchanged — the commit path clears the held
    // clarification BEFORE logging (bounded window, same code block).
    assert.match(app, /clearPendingClarification\(\);[\s\S]{0,800}?emitSetLogged\(logRows,/,
      'the normal set-log path clears any held clarification before logging');
  });
});
