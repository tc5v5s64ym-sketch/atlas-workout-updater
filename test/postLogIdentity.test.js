'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const { analyzeSetSequence, assessNextMoveConflict } = require('../services/setEffortSignals');
const { rerouteNote } = require('../services/setEffortCopy');

// Post-log UI state consistency (follow-up to PR #479). Extract the real app.js
// identity/remaining helpers and the coach-conversation lift-code resolver and
// drive them with the exact live-test plan + aliases, so every post-log surface
// (sessionCompleted, plannedQueue, nextPlanned, reroute, confirmation card)
// resolves a logged alias to the SAME planned lift.

// --- harness: app.js plan identity + remaining-queue helpers -----------------
function loadIdentityHarness() {
  const src = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const slice1 = src.slice(
    src.indexOf('function plannedExerciseEntries()'),
    src.indexOf('function firstUnloggedPlannedLift()')
  );
  const slice2 = src.slice(
    src.indexOf('function resolveCompletedIdentity(rawName, enrichmentRow)'),
    src.indexOf('function emitSetLogged(')
  );
  assert.ok(slice1 && slice2, 'identity helpers must be found in app.js');
  const factory = new Function(`
    let activePlannedSession = null;
    let lastIntentData = null;
    let sessionCompleted = [];
    ${slice1}
    ${slice2}
    return {
      setActiveSession: s => { activePlannedSession = s; },
      setIntentData: d => { lastIntentData = d; },
      logCompleted: (raw, enr) => { sessionCompleted.push(resolveCompletedIdentity(raw, enr)); },
      getCompleted: () => sessionCompleted.slice(),
      plannedExerciseOrder,
      remainingPlannedExercises,
      resolveCompletedIdentity,
    };
  `);
  return factory();
}

// --- harness: coach-conversation.js liftCodeForExercise ----------------------
function loadLiftCodeResolver(options) {
  const src = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const fnSrc = src.slice(
    src.indexOf('function liftCodeForExercise(name)'),
    src.indexOf('async function getNextExerciseInPlan')
  );
  assert.ok(fnSrc, 'liftCodeForExercise must be found');
  const fakeDoc = { getElementById: () => ({ options }) };
  return new Function('document', `${fnSrc}; return liftCodeForExercise;`)(fakeDoc);
}

// The live-test plan, as a coach-suggested intent (activePlannedSession === null —
// the flow that previously dropped completion identity).
const SUGGESTED_PLAN = {
  intents: [{
    recommended: true,
    exercises: [
      { exercise: 'Bench Press', canonical_exercise: 'Bench Press', lift_code: 'BEN01' },
      { exercise: 'Seated Row', canonical_exercise: 'Seated Row', lift_code: 'ROW01' },
      { exercise: 'Weighted Dip', canonical_exercise: 'Weighted Dip', lift_code: 'DIP01' },
      { exercise: 'Lat Pulldown', canonical_exercise: 'Lat Pulldown', lift_code: 'LAT01' },
      { exercise: 'Incline DB Press', canonical_exercise: 'Incline DB Press', lift_code: 'INC01' },
      { exercise: 'Face Pull', canonical_exercise: 'Face Pull', lift_code: 'FAC01' },
    ],
  }],
};

// 1 — a logged alias resolves to the planned lift (by lift_code AND by alias/contains).
test('post-log identity: "Dips (Weighted)" / "Weighted dips" / "Lat pull" resolve to planned lifts', () => {
  const h = loadIdentityHarness();
  h.setIntentData(SUGGESTED_PLAN);
  // lift_code is authoritative even when the display canonical differs.
  assert.equal(h.resolveCompletedIdentity('Weighted dips', { lift_code: 'DIP01', canonical_exercise: 'Dips (Weighted)' }), 'Weighted Dip');
  // No code: alias/contains still maps the shorthand to the planned name.
  assert.equal(h.resolveCompletedIdentity('Weighted dips', { canonical_exercise: 'Dips (Weighted)' }), 'Weighted Dip');
  assert.equal(h.resolveCompletedIdentity('Lat pull', {}), 'Lat Pulldown');
  // Unrelated input is left as-is (no false plan match).
  assert.equal(h.resolveCompletedIdentity('Bicep Curl', {}), 'Bicep Curl');
});

// 1b — parity in the STARTED-session flow (activePlannedSession set).
test('post-log identity: started-session flow resolves the same way', () => {
  const h = loadIdentityHarness();
  h.setActiveSession({ exercises: [
    { name: 'Weighted Dip', canonicalName: 'Weighted Dip', liftCode: 'DIP01' },
    { name: 'Lat Pulldown', canonicalName: 'Lat Pulldown', liftCode: 'LAT01' },
  ] });
  assert.equal(h.resolveCompletedIdentity('Weighted dips', { lift_code: 'DIP01' }), 'Weighted Dip');
  assert.equal(h.resolveCompletedIdentity('Lat pull', {}), 'Lat Pulldown');
});

// 2 — plannedQueue (remaining) excludes the just-completed Weighted Dip.
test('post-log identity: remaining queue excludes a completed lift logged under an alias', () => {
  const h = loadIdentityHarness();
  h.setIntentData(SUGGESTED_PLAN);
  h.logCompleted('Bench Press', { lift_code: 'BEN01' });
  h.logCompleted('Seated Row', { lift_code: 'ROW01' });
  h.logCompleted('Weighted dips', { lift_code: 'DIP01', canonical_exercise: 'Dips (Weighted)' });
  const remaining = h.remainingPlannedExercises();
  assert.ok(!remaining.includes('Weighted Dip'), 'completed Weighted Dip must not remain');
  assert.deepEqual(remaining, ['Lat Pulldown', 'Incline DB Press', 'Face Pull']);
});

// 3 — reroute must never defer the lift that was just completed.
test('post-log identity: reroute does not defer the just-completed Weighted Dip', () => {
  const h = loadIdentityHarness();
  h.setIntentData(SUGGESTED_PLAN);
  h.logCompleted('Bench Press', { lift_code: 'BEN01' });
  h.logCompleted('Seated Row', { lift_code: 'ROW01' });
  h.logCompleted('Weighted dips', { lift_code: 'DIP01', canonical_exercise: 'Dips (Weighted)' });
  const remaining = h.remainingPlannedExercises(); // the plannedQueue sent to the engine
  const analysis = analyzeSetSequence([[50, 11, 0], [50, 10, 1], [50, 10, 0]], { exerciseName: 'Weighted Dip' });
  assert.equal(analysis.signals.pressing_readiness_yellow, true); // pressing went yellow
  const line = rerouteNote(assessNextMoveConflict(analysis, remaining));
  // Next planned is Lat Pulldown (a pull) → no same-prime-mover conflict, and in no
  // case may a reroute point back at the lift that was just logged.
  assert.ok(!line || !line.includes('Weighted Dip'), 'reroute must never defer the completed lift');
});

// 5 — after Lat Pulldown (logged as "Lat pull"), next remaining is Incline DB Press.
test('post-log identity: after Lat Pulldown the next remaining is Incline DB Press', () => {
  const h = loadIdentityHarness();
  h.setIntentData(SUGGESTED_PLAN);
  for (const [raw, enr] of [
    ['Bench Press', { lift_code: 'BEN01' }],
    ['Seated Row', { lift_code: 'ROW01' }],
    ['Weighted dips', { lift_code: 'DIP01' }],
    ['Lat pull', {}], // shorthand, no code → resolved by alias
  ]) h.logCompleted(raw, enr);
  const remaining = h.remainingPlannedExercises();
  assert.equal(remaining[0], 'Incline DB Press');
  assert.deepEqual(remaining, ['Incline DB Press', 'Face Pull']);
});

// 4 — the confirmation/next-prescription card resolves for shorthand-logged lifts.
test('post-log identity: liftCodeForExercise resolves shorthand via alias fallback', () => {
  const resolve = loadLiftCodeResolver([
    { value: 'Lat Pulldown', label: 'LAT01' },
    { value: 'Bench Press', label: 'BEN01' },
  ]);
  assert.equal(resolve('Bench Press'), 'BEN01');  // exact
  assert.equal(resolve('Lat pull'), 'LAT01');      // alias/contains fallback
  assert.equal(resolve('Nonexistent Lift'), null); // no false match
});

// 6 / 8 — source: handoff, composer, and reroute queue use one shared remaining
// source; the post-log identity path touches no write path.
test('post-log identity: emitSetLogged derives nextPlanned + plannedQueue from one source; no write path', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const block = src.slice(src.indexOf('function emitSetLogged('), src.indexOf('// The session lives in the buffer'));
  assert.match(block, /const remaining = remainingPlannedExercises\(\);/);
  assert.match(block, /const nextPlanned = remaining\[0\] \|\| null;/);
  assert.match(block, /const plannedQueue = remaining;/);
  // Read-only narration — emitSetLogged must not touch any write path.
  assert.doesNotMatch(block, /\/api\/log-workout|\/api\/complete-workout|appendRows/);
});
