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

  // ── #1687: session binding — the proving test ──
  it('#1687: hold in A → end A → start B → "yes" commits nothing and clears the hold', () => {
    PC.setPendingClarification({ partial: { exercise: 'Hanging Knee Raises', sets: [{ weight: null, reps: 15 }, { weight: null, reps: 12 }] } }, 'session-A');
    assert.equal(PC.resolvePendingClarification('yes', 'session-B'), null, 'cross-session yes commits nothing');
    assert.equal(PC.getPendingClarification(), null, 'cross-session yes clears the hold');
    assert.equal(PC.resolvePendingClarification('yes', 'session-A'), null, 'the hold is gone even for its own session afterwards');
  });

  it('#1687: same-session "yes" still commits exactly the held sets', () => {
    PC.setPendingClarification({ partial: { exercise: 'Hanging Knee Raises', sets: [{ weight: null, reps: 15 }, { weight: null, reps: 12 }, { weight: null, reps: 10 }] } }, 'session-A');
    const rows = PC.resolvePendingClarification('Just log it', 'session-A');
    assert.deepEqual(rows.map(r => r.reps), ['15', '12', '10'], 'exactly the held reps, all of them, in order');
    assert.equal(PC.getPendingClarification(), null, 'the hold is cleared after resolving');
  });

  it('#1687: a non-affirmation in a NEW session clears the stale hold (mismatch checked first)', () => {
    PC.setPendingClarification({ partial: { exercise: 'Hanging Knee Raises', sets: [{ reps: 15 }] } }, 'session-A');
    assert.equal(PC.resolvePendingClarification('actually make it 20', 'session-B'), null);
    assert.equal(PC.getPendingClarification(), null, 'a stale hold is dead on any turn of the new session');
  });

  it('#1687: a non-affirmation in the SAME session keeps the hold', () => {
    PC.setPendingClarification({ partial: { exercise: 'Hanging Knee Raises', sets: [{ reps: 15 }] } }, 'session-A');
    assert.equal(PC.resolvePendingClarification('actually make it 20', 'session-A'), null);
    assert.ok(PC.getPendingClarification(), 'a non-affirmation does not consume the hold in its own session');
  });

  it('#1687: the held record carries its session key; a new key supersedes with its own key', () => {
    PC.setPendingClarification({ partial: { exercise: 'Hanging Knee Raises', sets: [{ reps: 15 }] } }, 'session-A');
    assert.equal(PC.getPendingClarification().sessionKey, 'session-A');
    PC.setPendingClarification({ partial: { exercise: 'Push-Up', sets: [{ reps: 30 }] } }, 'session-B');
    assert.equal(PC.getPendingClarification().exercise, 'Push-Up', 'newest wins');
    assert.equal(PC.getPendingClarification().sessionKey, 'session-B');
  });

  it('#1687: an unbound hold (no key) only resolves for an unbound resolve — never for a keyed session', () => {
    PC.setPendingClarification({ partial: { exercise: 'Hanging Knee Raises', sets: [{ reps: 15 }] } });
    assert.equal(PC.resolvePendingClarification('yes', 'session-A'), null, 'a keyed session cannot commit an unbound hold');
    assert.equal(PC.getPendingClarification(), null, 'the refused hold is cleared');
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
    const resolveIdx = app.indexOf('resolvePendingClarification(workoutTextInput.value.trim(), currentSessionKey())');
    const closeoutIdx = app.indexOf('if (looksLikeLogIt(workoutTextInput.value)) {');
    assert.ok(resolveIdx > 0, 'the composer must consult resolvePendingClarification');
    assert.ok(closeoutIdx > 0, 'the closeout check must exist');
    assert.ok(resolveIdx < closeoutIdx, 'resolution must run before the "log it"/closeout routing');
    // The resolved rows are committed through the same buffer path as a normal set log.
    assert.match(app.slice(resolveIdx, closeoutIdx), /emitSetLogged\(resolvedRows,/,
      'a resolved clarification commits its rows via emitSetLogged');
  });

  it('captures a sets-carrying needs_clarification (holds it and surfaces the question)', () => {
    assert.match(app, /err\.parsedIntent === 'needs_clarification' && setPendingClarification\(err, currentSessionKey\(\)\)/,
      'the catch block must hold a sets-carrying clarification instead of dropping it to the coach');
  });

  it('a real set log supersedes any held clarification', () => {
    // F10S2 inserts the deferred-swap arming between the clear and the emit; the
    // contract pinned here is unchanged — the commit path clears the held
    // clarification BEFORE logging (bounded window, same code block).
    // Anchored on the parse-path clear's own F09G comment: the bare
    // clearPendingClarification() string now also matches the #1687 clears in
    // endPlannedSession / startOverWorkout, which are different sites.
    assert.match(app, /\/\/ F09G: a real set log supersedes[\s\S]{0,300}?clearPendingClarification\(\);[\s\S]{0,800}?emitSetLogged\(logRows,/,
      'the normal set-log path clears any held clarification before logging');
  });

  // ── #1687: session-epoch wiring ──────────────────────────────────────────
  it('#1687: the session key is an epoch that steps at session boundaries, not the log-session-id', () => {
    // generateSessionId is date + AM/PM only — two same-day sessions share it, so
    // it can never be the hold's identity. The epoch is the identity.
    assert.match(app, /let sessionEpoch = 0;/, 'a session epoch counter must exist');
    assert.match(app, /function currentSessionKey\(\) \{ return `session-\$\{sessionEpoch\}`; \}/,
      'currentSessionKey must derive from the epoch');
  });

  it('#1687: endPlannedSession steps the epoch and clears the hold', () => {
    const start = app.indexOf('function endPlannedSession() {');
    assert.ok(start > 0, 'endPlannedSession must exist');
    const body = app.slice(start, app.indexOf('\n}\n', start));
    assert.match(body, /sessionEpoch \+= 1;/, 'ending the planned session must step the epoch');
    assert.match(body, /clearPendingClarification\(\);/, 'ending the planned session must clear the hold');
  });

  it('#1687: Start Over steps the epoch and clears the hold', () => {
    const start = app.indexOf('function startOverWorkout() {');
    assert.ok(start > 0, 'startOverWorkout must exist');
    const body = app.slice(start, app.indexOf('\n}\n', start));
    assert.match(body, /sessionEpoch \+= 1;/, 'a deliberate fresh start must step the epoch');
    assert.match(body, /clearPendingClarification\(\);/, 'a deliberate fresh start must clear the hold');
  });
});
