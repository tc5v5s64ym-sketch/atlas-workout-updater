'use strict';

// #1691 — the server owns slot completion. One logged set must not finish a
// multi-set slot, and a client-authored plan_state must not outrank the raw
// evidence the server runs through the F10 selector.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  computePlanState,
  planStateFromContext,
  planStateFromSlotEvidence,
} = require('../services/sessionPlanExecutor');
const { computeCloseout } = require('../services/sessionCloseout');
const { answerCurrentExercisePrescription } = require('../services/sessionQuestionAnswer');

const three = [
  { name: 'Back Squat', sets: 3 },
  { name: 'Overhead Press', sets: 3 },
];

test('#1691: one logged set does not complete a 3-set slot', () => {
  const s = computePlanState(three, ['Back Squat']);
  assert.deepEqual(s.remaining, ['Back Squat', 'Overhead Press']);
  assert.equal(s.isComplete, false);
});

test('#1691: a 3-set slot completes only when the performed count reaches 3', () => {
  const partial = computePlanState(three, ['Back Squat', 'Back Squat']);
  assert.ok(partial.remaining.includes('Back Squat'));
  const done = computePlanState(three, ['Back Squat', 'Back Squat', 'Back Squat']);
  assert.deepEqual(done.remaining, ['Overhead Press']);
  assert.equal(done.isComplete, false);
  const both = computePlanState(
    [{ name: 'Back Squat', sets: 3 }],
    [{ name: 'Back Squat', performedSets: 3 }]
  );
  assert.equal(both.isComplete, true);
  assert.deepEqual(both.remaining, []);
});

test('#1691: a plan with no prescribed count keeps the one-match rule', () => {
  const s = computePlanState(['Back Squat', 'Overhead Press'], ['Back Squat']);
  assert.deepEqual(s.remaining, ['Overhead Press']);
  assert.equal(s.isComplete, false);
});

test('#1691: two same-named slots — three sets close the first only', () => {
  const s = computePlanState(
    [{ name: 'Lat Pulldown', sets: 3 }, { name: 'Lat Pulldown', sets: 3 }],
    ['Lat Pulldown', 'Lat Pulldown', 'Lat Pulldown']
  );
  assert.deepEqual(s.remaining, ['Lat Pulldown']);
  assert.equal(s.isComplete, false);
});

test('#1691: computeCloseout does not close a session on 1 of 3', () => {
  assert.equal(
    computeCloseout([{ name: 'Back Squat', sets: 3 }], ['Back Squat']),
    null
  );
  const done = computeCloseout(
    [{ name: 'Back Squat', sets: 3 }],
    ['Back Squat', 'Back Squat', 'Back Squat']
  );
  assert.ok(done && done.isComplete === true);
  assert.deepEqual(done.planNames, ['Back Squat']);
});

test('#1691: slot evidence outranks a client plan_state that calls 1 of 3 done', () => {
  const ps = planStateFromContext({
    current_plan: [{ name: 'Back Squat', sets: 3 }, { name: 'Overhead Press', sets: 3 }],
    plan_completed: ['Back Squat'],
    plan_state: {
      planned: ['Back Squat', 'Overhead Press'],
      completed: ['Back Squat'],
      remaining: ['Overhead Press'],
      isComplete: false,
    },
    slot_evidence: {
      exercises: [
        { name: 'Back Squat', sets: 3, plan_item_id: 'pi_sq' },
        { name: 'Overhead Press', sets: 3, plan_item_id: 'pi_ohp' },
      ],
      completed: ['Back Squat'],
      session_log: [{ exercise: 'Back Squat', canonical: 'Back Squat' }],
    },
  });
  assert.deepEqual(ps.remaining, ['Back Squat', 'Overhead Press']);
  assert.deepEqual(ps.completed, []);
  assert.equal(ps.isComplete, false);
});

test('#1691: slot evidence also corrects a client that leaves a finished slot remaining', () => {
  const ps = planStateFromSlotEvidence({
    exercises: [
      { name: 'Back Squat', sets: 2 },
      { name: 'Bicep Curl', sets: 2 },
    ],
    completed: ['Back Squat'],
    session_log: [
      { exercise: 'Back Squat', canonical: 'Back Squat' },
      { exercise: 'Back Squat', canonical: 'Back Squat' },
    ],
  });
  assert.deepEqual(ps.completed, ['Back Squat']);
  assert.deepEqual(ps.remaining, ['Bicep Curl']);
  assert.equal(ps.isComplete, false);
});

test('#1691: an alias log counts against the slot via its canonical, not the raw spelling', () => {
  const ps = planStateFromSlotEvidence({
    exercises: [{ name: 'Romanian Deadlift', sets: 2, liftCode: 'RDL01' }],
    completed: ['Romanian Deadlift'],
    session_log: [
      { exercise: 'RDL', canonical: 'Romanian Deadlift' },
      { exercise: 'RDL', canonical: 'Romanian Deadlift' },
    ],
  });
  assert.equal(ps.isComplete, true);
  assert.deepEqual(ps.remaining, []);
});

test('#1691: a skipped explicit outcome is not remaining and not completed', () => {
  const ps = planStateFromSlotEvidence({
    exercises: [
      { name: 'Back Squat', sets: 3, plan_item_id: 'pi_sq' },
      { name: 'Curl', sets: 2, plan_item_id: 'pi_curl' },
    ],
    items: [{ plan_item_id: 'pi_curl', outcome: 'skipped' }],
    completed: [],
    session_log: [],
  });
  assert.deepEqual(ps.remaining, ['Back Squat']);
  assert.deepEqual(ps.completed, []);
  assert.equal(ps.isComplete, false);
});

test('#1691: substituted stays pending until the substitute is logged (not a silent complete)', () => {
  const ps = planStateFromSlotEvidence({
    exercises: [{ name: 'Incline DB Press', sets: 3, plan_item_id: 'pi_bench' }],
    items: [{ plan_item_id: 'pi_bench', outcome: 'substituted' }],
    completed: [],
    session_log: [],
  });
  assert.deepEqual(ps.remaining, ['Incline DB Press']);
  assert.deepEqual(ps.completed, []);
});

test('#1691: missing or empty slot_evidence falls through to the client plan_state', () => {
  const trusted = planStateFromContext({
    current_plan: ['Deadlift', 'Row'],
    plan_completed: ['Deadlift'],
    plan_state: {
      planned: ['Deadlift', 'Row'],
      completed: [],
      remaining: ['Deadlift', 'Row'],
      isComplete: false,
    },
  });
  assert.deepEqual(trusted.remaining, ['Deadlift', 'Row']);
  const empty = planStateFromContext({
    current_plan: ['Deadlift'],
    plan_completed: ['Deadlift'],
    slot_evidence: { exercises: [] },
    plan_state: {
      planned: ['Deadlift'],
      completed: [],
      remaining: ['Deadlift'],
      isComplete: false,
    },
  });
  assert.deepEqual(empty.remaining, ['Deadlift'], 'empty evidence does not wipe a legacy verdict');
});

test('#1691: a shorthand prescription question stands on the in-progress slot, not the client remaining list', () => {
  const answer = answerCurrentExercisePrescription('weight and reps?', {
    current_plan: [
      { name: 'Back Squat', sets: 3, weight: 315, reps: 5 },
      { name: 'Overhead Press', sets: 3, weight: 135, reps: 5 },
    ],
    plan_completed: ['Back Squat'],
    plan_state: {
      planned: ['Back Squat', 'Overhead Press'],
      completed: ['Back Squat'],
      remaining: ['Overhead Press'],
      isComplete: false,
    },
    slot_evidence: {
      exercises: [
        { name: 'Back Squat', sets: 3 },
        { name: 'Overhead Press', sets: 3 },
      ],
      completed: ['Back Squat'],
      session_log: [{ exercise: 'Back Squat', canonical: 'Back Squat' }],
    },
  });
  assert.equal(answer && answer.kind, 'answer');
  assert.match(answer.text, /^Back Squat:/);
  assert.doesNotMatch(answer.text, /Overhead Press/);
});

test('#1691 wiring: the client sends raw slot_evidence and the server reads it before plan_state', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'app.js'), 'utf8');
  const start = appSrc.indexOf('function routeMessageToCoach(');
  assert.ok(start !== -1);
  const block = appSrc.slice(start, start + 4500);
  assert.match(block, /context\.slot_evidence = \{/, 'routeMessageToCoach sends slot_evidence');
  assert.match(block, /session_log:/, 'evidence includes the per-set log, not a status verdict');
  assert.match(block, /context\.plan_state = \{/, 'legacy plan_state still travels for old servers');
  const exec = fs.readFileSync(path.join(__dirname, '..', 'services', 'sessionPlanExecutor.js'), 'utf8');
  const fn = exec.indexOf('function planStateFromContext');
  const body = exec.slice(fn, fn + 2200);
  const evidenceAt = body.indexOf('planStateFromSlotEvidence');
  const verdictAt = body.indexOf('cc.plan_state');
  assert.ok(evidenceAt !== -1 && verdictAt !== -1 && evidenceAt < verdictAt,
    'slot evidence is consulted before the client plan_state verdict');
});
