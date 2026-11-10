'use strict';

// #1710 — unit tests for the message-narration numeric grounding: the
// /api/coach/message facts → grounding-context adapter and the detector that
// enforces the B-02 binding mechanism on the narration paths. Pure — no app
// boot, no network. The route-level behavior (suppression to null) is
// covered in test/coachMessageNumericGrounding.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const grounding = require('../services/coachResponseGrounding');

const { buildCoachMessageGroundingContext, detectUngroundedMessageNumbers } = grounding;

// Bench Press 135x8 logged; the engine's next target is 135x8x3 at RIR 2;
// Seated Row is queued next (name only — no authorized numbers).
const SET_FACTS = {
  exerciseName: 'Bench Press',
  todaySets: [{ weight: 135, reps: 8, rir: 2 }],
  rec: {
    target_rir: 2,
    next_target: { weight: 135, reps: 8, sets: 3 },
    last_working_sets: [{ weight: 135, reps: 8, rir: 2 }],
  },
  planned_queue: ['Seated Row'],
};

const PLAN_FACTS = {
  label: 'Build strength',
  focus: 'Squat pattern',
  why_today: ['Squat pattern is fresh'],
  readiness: [{ pattern: 'squat', status: 'fresh' }],
  data_points: [{ label: 'Sessions this week', value: '3', context: 'week' }],
};

const kinds = (findings) => findings.map((f) => f.kind).sort();

// ── adapter ─────────────────────────────────────────────────────────────────

test('adapter: builds the tally from todaySets (object and [w,r,rir] forms)', () => {
  const ctx = buildCoachMessageGroundingContext({
    exerciseName: 'Bench Press',
    todaySets: [{ weight: 135, reps: 8, rir: 2 }, [140, 6, 1]],
    rec: {},
  }, 'set');
  assert.deepEqual(ctx.session_tally, {
    exercises: [{
      exercise: 'Bench Press',
      sets: 2,
      per_set: [
        { weight: 135, reps: 8, rir: 2 },
        { weight: 140, reps: 6, rir: 1 },
      ],
    }],
  });
});

test('adapter: next_target becomes the numbered plan entry; queue names carry no numbers', () => {
  const ctx = buildCoachMessageGroundingContext(SET_FACTS, 'set');
  assert.deepEqual(ctx.current_plan, [
    { name: 'Bench Press', weight: 135, reps: 8, sets: 3, rir: 2 },
    { name: 'Seated Row' },
  ]);
});

test('adapter: last_working_sets becomes the recent-session history ground', () => {
  const ctx = buildCoachMessageGroundingContext(SET_FACTS, 'set');
  assert.equal(ctx.recent_sessions.length, 1);
  assert.deepEqual(ctx.recent_sessions[0].lift_sets, {
    'Bench Press': [{ weight: 135, reps: 8, rir: 2 }],
  });
});

test('adapter: plan facts yield an empty context (no tally, no plan, no history)', () => {
  const ctx = buildCoachMessageGroundingContext(PLAN_FACTS, 'plan');
  assert.equal(ctx.session_tally, null);
  assert.deepEqual(ctx.current_plan, []);
  assert.deepEqual(ctx.recent_sessions, []);
});

// ── detector: set path ──────────────────────────────────────────────────────

test('detector (set): the audit B1-set-lying text is flagged on both halves', () => {
  const findings = detectUngroundedMessageNumbers(
    'You lifted 315 for 12 reps. Next do Deadlift at 225.', SET_FACTS, 'set');
  assert.deepEqual(kinds(findings), ['prescription_numbers', 'recap_numbers']);
});

test('detector (set): an honest recap of the logged set passes', () => {
  assert.deepEqual(
    detectUngroundedMessageNumbers('You lifted 135 for 8 reps — clean and controlled.', SET_FACTS, 'set'),
    []);
});

test('detector (set): an honest recap with a matching RIR passes; a wrong RIR flags', () => {
  assert.deepEqual(
    detectUngroundedMessageNumbers('You lifted 135 for 8 reps at RIR 2.', SET_FACTS, 'set'), []);
  assert.deepEqual(
    kinds(detectUngroundedMessageNumbers('You lifted 135 for 8 reps at RIR 0.', SET_FACTS, 'set')),
    ['recap_numbers']);
});

test('detector (set): a prescription matching next_target passes; an off-plan lift flags', () => {
  assert.deepEqual(
    detectUngroundedMessageNumbers('Next up is Bench Press at 135 for 8 reps across 3 sets.', SET_FACTS, 'set'),
    []);
  assert.deepEqual(
    kinds(detectUngroundedMessageNumbers('Next do Deadlift at 225.', SET_FACTS, 'set')),
    ['prescription_numbers']);
});

test('detector (set): a numeric prescription for a queued (name-only) lift flags', () => {
  assert.deepEqual(
    kinds(detectUngroundedMessageNumbers('Next up is Seated Row at 100 for 3 sets of 10.', SET_FACTS, 'set')),
    ['prescription_numbers']);
});

test('detector (set): a "last time" citation of the shown working sets passes; without them it flags', () => {
  assert.deepEqual(
    detectUngroundedMessageNumbers('Last time you did 135 for 8 reps.', SET_FACTS, 'set'), []);
  const noHistory = { ...SET_FACTS, rec: { target_rir: 2, next_target: { weight: 135, reps: 8, sets: 3 } } };
  assert.deepEqual(
    kinds(detectUngroundedMessageNumbers('Last time you did 135 for 8 reps.', noHistory, 'set')),
    ['recap_history_numbers']);
  assert.deepEqual(
    kinds(detectUngroundedMessageNumbers('Last time you did 185 lb for 8 reps.', SET_FACTS, 'set')),
    ['recap_history_numbers']);
});

test('detector (set): a completed plan-change claim flags (read-only route)', () => {
  assert.deepEqual(
    kinds(detectUngroundedMessageNumbers("I've updated the plan to add Deadlift.", SET_FACTS, 'set')),
    ['unsupported_mutation']);
});

test('detector (set): number-free honest prose passes', () => {
  assert.deepEqual(
    detectUngroundedMessageNumbers('Strong, controlled set — right in your groove.', SET_FACTS, 'set'),
    []);
});

// ── detector: plan path ─────────────────────────────────────────────────────

test('detector (plan): the audit B1-plan-lying text is flagged', () => {
  const findings = detectUngroundedMessageNumbers(
    'Today do Deadlift at 315 for 5 sets of 12 reps; then add 20 next session.', PLAN_FACTS, 'plan');
  assert.ok(findings.some((f) => f.kind === 'prescription_numbers'));
});

test('detector (plan): number-free honest plan prose passes', () => {
  assert.deepEqual(
    detectUngroundedMessageNumbers('Squat pattern is fresh today — a good day to push the main lift.', PLAN_FACTS, 'plan'),
    []);
});

test('detector (plan): a completed-work numeric claim naming a lift flags (no per-lift ground exists)', () => {
  assert.deepEqual(
    kinds(detectUngroundedMessageNumbers('You lifted 315 for 12 reps last session.', PLAN_FACTS, 'plan')),
    ['message_plan_recap']);
});

// ── shared verb change ('lifted') ───────────────────────────────────────────

test("shared recap detector: 'lifted' is a completed-work verb (chat context shape)", () => {
  const chatCtx = {
    session_tally: { exercises: [{ exercise: 'Bench Press', sets: 1, per_set: [{ weight: 135, reps: 8, rir: 2 }] }] },
    current_plan: [{ name: 'Bench Press', weight: 135, reps: 8, sets: 3 }],
    current_preview: [],
    recent_sessions: [],
  };
  assert.deepEqual(
    kinds(grounding.detectUngroundedRecapNumbers('You lifted Bench Press 315 for 12 reps.', chatCtx)),
    ['recap_numbers']);
  assert.deepEqual(
    grounding.detectUngroundedRecapNumbers('You lifted Bench Press 135 for 8 reps.', chatCtx),
    []);
});
