const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let findPlanEntry, planMismatchForLift, formatPlanMismatchLine;
test.before(async () => {
  ({ findPlanEntry, planMismatchForLift, formatPlanMismatchLine } =
    await import('../src/app/planConformance.js'));
});

/* ===== findPlanEntry ===== */

const SESSION = {
  accepted: true,
  exercises: [
    { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01', weight: 275, reps: 8, sets: 3 },
    { name: 'Bench Press', canonicalName: 'Bench Press', liftCode: 'BEN01', weight: 185, reps: 10, sets: 3 },
    { name: 'Plank', canonicalName: 'Plank', liftCode: '', weight: null, reps: null, sets: 1 },
  ],
};

test('findPlanEntry matches case-insensitively', () => {
  assert.equal(findPlanEntry('romanian deadlift', SESSION).weight, 275);
  assert.equal(findPlanEntry('RDL', SESSION), null, 'no lift-code matching: the lookup is by name, like planStepFor');
});

test('findPlanEntry returns null for off-plan work', () => {
  assert.equal(findPlanEntry('Hammer Curls', SESSION), null);
  assert.equal(findPlanEntry('Bench', SESSION).name, 'Bench Press', 'substring fallback mirrors planStepFor');
});

test('findPlanEntry bridges a logged alias via lift code, never over an exact name', () => {
  assert.equal(findPlanEntry('RDL', SESSION, 'RDL01').name, 'Romanian Deadlift',
    'the issue’s own shape: the batch log can name the lift “RDL”');
  assert.equal(findPlanEntry('RDL', SESSION, null), null, 'without a code, an alias does not guess');
  assert.equal(findPlanEntry('Bench Press', SESSION, 'RDL01').name, 'Bench Press',
    'an exact name match always wins over the code');
});

/* ===== planMismatchForLift ===== */

test('issue #1632 failing draw: plan 275, logged 285 → mismatch', () => {
  const entry = findPlanEntry('Romanian Deadlift', SESSION);
  const m = planMismatchForLift(
    [{ weight: 285, reps: 8 }, { weight: 285, reps: 8 }, { weight: 285, reps: 8 }],
    entry,
  );
  assert.ok(m, 'a weight contradiction must surface');
  assert.equal(m.planWeight, 275);
  assert.equal(m.planReps, 8);
  assert.deepEqual(m.differing, [{ weight: 285, reps: 8, count: 3 }]);
});

test('matching values → null (confirmation unchanged)', () => {
  const entry = findPlanEntry('Romanian Deadlift', SESSION);
  assert.equal(planMismatchForLift(
    [{ weight: 275, reps: 8 }, { weight: 275, reps: 8 }],
    entry,
  ), null);
});

test('reps-only contradiction surfaces; RIR never counts', () => {
  const entry = findPlanEntry('Romanian Deadlift', SESSION);
  const m = planMismatchForLift([{ weight: 275, reps: 10, rir: 0 }], entry);
  assert.ok(m, 'a reps contradiction must surface even when weight matches');
  assert.equal(planMismatchForLift([{ weight: 275, reps: 8, rir: 0 }], entry), null,
    'an RIR difference alone is effort reporting, not a plan contradiction');
});

test('a missing plan target is never fabricated into a mismatch', () => {
  const entry = findPlanEntry('Plank', SESSION);
  assert.equal(planMismatchForLift([{ weight: null, reps: null }], entry), null);
  const bench = findPlanEntry('Bench Press', SESSION);
  assert.equal(planMismatchForLift([{ weight: null, reps: 10 }], bench), null,
    'a logged set with no weight cannot contradict a weight target it does not state');
});

test('partial contradiction reports only the differing sets', () => {
  const entry = findPlanEntry('Romanian Deadlift', SESSION);
  const m = planMismatchForLift(
    [{ weight: 275, reps: 8 }, { weight: 285, reps: 8 }, { weight: 275, reps: 8 }],
    entry,
  );
  assert.deepEqual(m.differing, [{ weight: 285, reps: 8, count: 1 }]);
});

test('no plan entry → null (off-plan extra work is a normal flow)', () => {
  assert.equal(planMismatchForLift([{ weight: 285, reps: 8 }], null), null);
});

/* ===== formatPlanMismatchLine ===== */

test('the line names planned vs logged and asks intent, never inventing numbers', () => {
  const entry = findPlanEntry('Romanian Deadlift', SESSION);
  const m = planMismatchForLift([{ weight: 285, reps: 8 }], entry);
  const line = formatPlanMismatchLine('Romanian Deadlift', m);
  assert.match(line, /275/);
  assert.match(line, /285/);
  assert.match(line, /intentional|typo/i);
  assert.doesNotMatch(line, /saved|written/i, 'the line must not claim anything about the write');
});

/* ===== wiring: handleSetLogged surfaces the mismatch per lift ===== */

function coachConversationSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'coach-conversation.js'), 'utf-8');
}

test('wiring: coach-conversation imports the pure plan-conformance module', () => {
  assert.match(coachConversationSource(), /from '\.\/planConformance\.js'/);
});

test('wiring: handleSetLogged computes a plan mismatch for the primary lift', () => {
  const fn = coachConversationSource();
  const start = fn.indexOf('async function handleSetLogged(');
  assert.ok(start !== -1);
  const body = fn.slice(start, start + 12000);
  assert.match(body, /const planMismatchLineFor = /, 'the primary lift must consult the plan comparison');
  assert.match(body, /accepted === true/, 'mismatches surface only for an accepted plan');
  assert.match(body, /appendPlanMismatch\(primary\.exercise, primary\.sets, body\)/,
    'the primary mismatch line sits directly under its readback');
  assert.match(body, /liftCodeForExercise\(exerciseName\)/,
    'the helper resolves the catalog code so logged aliases reach their slot');
  assert.match(body, /findPlanEntry\(exerciseName, activeSession, code\)/,
    'the catalog code is passed into the plan lookup');
  assert.match(body, /entry\.canonicalName \|\| entry\.name/,
    'the plan side is named by the plan entry, not the logged alias');
});

test('wiring: handleSetLogged computes a plan mismatch for each additional lift', () => {
  const fn = coachConversationSource();
  const start = fn.indexOf('for (const ex of exercises.slice(1))');
  assert.ok(start !== -1);
  const body = fn.slice(start, start + 6000);
  assert.match(body, /appendPlanMismatch\(ex\.exercise, ex\.sets, null\)/,
    'additional lifts must get the same treatment as the primary');
});
