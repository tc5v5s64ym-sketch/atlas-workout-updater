'use strict';

// Regression — the confirm/review card must show ALL exercises logged this workout,
// including ones already saved earlier in the same gym session.
//
// Flight Recorder evidence (session FR-20260706013655-4t692wuh): the owner logged
// Bench / Seated Row / OHP, SAVED mid-workout (which clears sessionLog and starts a
// new session_id), then logged Laterals / Dips and hit "Done" — the closeout card,
// built only from the post-save buffer, showed just the new sets and dropped the 3
// already-saved exercises. Owner bug markers: "Session confirm card is missing 3
// workouts", "Your missing bench".
//
// The fix is a DISPLAY-ONLY ledger (sessionSavedLog) surfaced in the confirm card;
// the write payload is unchanged. This test drives the pure recap helper sliced out
// of app.js and pins both the coverage behavior and the wiring (incl. write-safety).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Slice the pure helper orderedUniqueExercises() out of app.js and run it in Node.
function loadOrderedUniqueExercises() {
  const start = appSrc.indexOf('function orderedUniqueExercises(rows)');
  const end = appSrc.indexOf('// A read-only "already saved this session" recap', start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'orderedUniqueExercises must exist in app.js');
  const slice = appSrc.slice(start, end);
  assert.ok(slice.includes('function orderedUniqueExercises'), 'slice must contain the function');
  return new Function(`${slice}; return orderedUniqueExercises;`)();
}

const orderedUniqueExercises = loadOrderedUniqueExercises();

test('orderedUniqueExercises: ordered, de-duplicated, blank-skipping', () => {
  const names = orderedUniqueExercises([
    { exercise: 'Bench Press' }, { exercise: 'Bench Press' }, // dup (same set, 2nd set)
    { exercise: '' }, { exercise: null }, { exercise: 'Seated Row' }
  ]);
  assert.deepEqual(names, ['Bench Press', 'Seated Row']);
});

// THE reproduction: a workout where 3 exercises were saved mid-session and 3 more
// were logged afterward. The confirm/review card = the to-write buffer (sessionLog)
// PLUS the already-saved recap (sessionSavedLog). All six must appear.
test('confirm card shows ALL logged exercises across a mid-session save', () => {
  // State at the final "Done" closeout, after a mid-workout save:
  const sessionSavedLog = [ // saved earlier this workout (buffer was cleared on save)
    { exercise: 'Bench Press' }, { exercise: 'Bench Press' },
    { exercise: 'Seated Row' }, { exercise: 'Overhead Press' }
  ];
  const sessionLog = [      // logged AFTER the save (the post-save buffer)
    { exercise: 'Lateral Raise' }, { exercise: 'Weighted Dip' }, { exercise: 'Lat Pulldown' }
  ];

  const recap = orderedUniqueExercises(sessionSavedLog);   // what the recap line shows
  const pending = orderedUniqueExercises(sessionLog);      // what the write table shows
  const shownInCard = new Set([...recap, ...pending]);

  for (const name of ['Bench Press', 'Seated Row', 'Overhead Press', 'Lateral Raise', 'Weighted Dip', 'Lat Pulldown']) {
    assert.ok(shownInCard.has(name), `confirm card must show "${name}" (was reported missing)`);
  }
  // The already-saved three are surfaced by the recap, not silently dropped.
  assert.deepEqual(recap, ['Bench Press', 'Seated Row', 'Overhead Press']);
});

// Wiring + write-safety pinned by source inspection (the render/save paths aren't
// unit-loadable without a DOM, mirroring the app.js source-introspection idiom).
test('wiring: ledger captured before reset, reset only on deliberate fresh start, never written', () => {
  // Captured from the just-saved buffer BEFORE sessionLog is cleared, gated on a
  // real log write.
  assert.match(appSrc, /if \(pendingLastWrite && Array\.isArray\(getSessionLog\(\)\) && getSessionLog\(\)\.length\) \{\s*\n\s*for \(const s of getSessionLog\(\)\) getSessionSavedLog\(\)\.push/,
    'save-success must append to sessionSavedLog before clearing the buffer');
  const captureIdx = appSrc.indexOf('for (const s of getSessionLog()) getSessionSavedLog().push');
  const clearIdx = appSrc.indexOf('setSessionLog([]);', captureIdx);
  assert.ok(captureIdx !== -1 && clearIdx !== -1 && captureIdx < clearIdx, 'capture must precede the buffer clear');

  // Reset ONLY on deliberate fresh starts — startOver and discard — never on save.
  assert.ok(appSrc.includes('setSessionSavedLog([]);     // deliberate fresh start'), 'startOver resets the ledger');
  assert.ok(appSrc.includes('setSessionSavedLog([]);     // discarding the restored workout'), 'discard resets the ledger');

  // Surfaced in the confirm/review card.
  assert.match(appSrc, /const savedRecap = renderSavedThisSessionRecap\(\);\s*\n\s*if \(savedRecap\) previewContent\.appendChild\(savedRecap\)/,
    'renderLogWorkoutPreview must append the saved-this-session recap');

  // WRITE-SAFETY: the write payload builder must never read the display ledger.
  const collectStart = appSrc.indexOf('function collectLogRows(');
  const collectEnd = appSrc.indexOf('\nfunction ', collectStart + 1);
  const collectSrc = appSrc.slice(collectStart, collectEnd);
  assert.ok(collectStart !== -1, 'collectLogRows must exist');
  assert.ok(!collectSrc.includes('sessionSavedLog'), 'collectLogRows (write payload) must NOT reference the display ledger');
});
