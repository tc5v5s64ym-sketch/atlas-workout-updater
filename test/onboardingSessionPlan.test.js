'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOnboardingSessionPlan,
  CORE_PATTERNS,
  WIDEN_PATTERNS,
} = require('../services/onboardingSessionPlan');
const { buildWarmupRamp } = require('../services/sessionBuilder');

// Find a slot for a given pattern across all sessions (first occurrence).
function firstSlot(plan, pattern) {
  for (const s of plan.sessions) {
    const hit = s.slots.find((slot) => slot.pattern === pattern);
    if (hit) return hit;
  }
  return null;
}

// --- Shape: the spec §3 three-session full-body calibration plan ---------------

test('emits 3 sessions, 8 reps @ 2 RIR, full-body calibration shape', () => {
  const plan = buildOnboardingSessionPlan();
  assert.equal(plan.shape, 'full_body_calibration');
  assert.equal(plan.sessions.length, 3);

  // Session 1 maps the four big patterns; sessions 2-3 widen to vertical push + isolation.
  assert.deepEqual(plan.sessions[0].slots.map((s) => s.pattern), CORE_PATTERNS);
  assert.deepEqual(
    plan.sessions[1].slots.map((s) => s.pattern),
    [...CORE_PATTERNS, ...WIDEN_PATTERNS],
  );
  assert.deepEqual(
    plan.sessions[2].slots.map((s) => s.pattern),
    [...CORE_PATTERNS, ...WIDEN_PATTERNS],
  );

  for (const session of plan.sessions) {
    for (const slot of session.slots) {
      // Spec §3 prescribes 2×8 @ 2 RIR (two working sets) throughout.
      assert.equal(slot.target_sets, 2);
      assert.equal(slot.target_reps, 8);
      assert.equal(slot.target_rir, 2);
    }
  }
});

test('default equipment selects the barbell variants from spec §3', () => {
  const plan = buildOnboardingSessionPlan();
  assert.equal(firstSlot(plan, 'squat').exercise, 'Back Squat');
  assert.equal(firstSlot(plan, 'horizontal_push').exercise, 'Bench Press');
  assert.equal(firstSlot(plan, 'horizontal_pull').exercise, 'Barbell Row');
  assert.equal(firstSlot(plan, 'hinge').exercise, 'Romanian Deadlift');
  assert.equal(plan.unsupported_patterns.length, 0);
});

// --- Cold / sparse history: all calibrating, "Start conservative", no ramps ----

test('cold start (no history): every slot calibrating with a start hint and no ramp', () => {
  const plan = buildOnboardingSessionPlan();
  for (const session of plan.sessions) {
    for (const slot of session.slots) {
      assert.equal(slot.calibration_status, 'calibrating');
      assert.equal(slot.working_weight, null);
      assert.deepEqual(slot.warmup_sets, []);
      assert.ok(slot.protocol, 'calibrating slot carries a protocol');
      assert.equal(slot.protocol.startHint, null);
      assert.match(slot.protocol.instruction, /^Start conservative/);
    }
  }
});

test('unknown / missing confidence maps to safe calibration', () => {
  const plan = buildOnboardingSessionPlan({
    lifts: {
      squat: { lift_confidence: 'banana' }, // unrecognized → calibrating
      hinge: {},                            // missing entirely → calibrating
    },
  });
  assert.equal(firstSlot(plan, 'squat').calibration_status, 'calibrating');
  assert.equal(firstSlot(plan, 'squat').warmup_sets.length, 0);
  assert.equal(firstSlot(plan, 'hinge').calibration_status, 'calibrating');
});

// --- F1–F3: start hints come from buildWorkingWeightProtocol (engine-owned) ----

test('F1/F3 — a reference seeds the 70% start hint via the engine helper', () => {
  const plan = buildOnboardingSessionPlan({
    lifts: {
      horizontal_push: { reference: 185 }, // 185 × 0.7 = 129.5 → 130
      squat: { reference: 225 },           // 157.5 → 160
      hinge: { reference: 275 },           // 192.5 → 195
      horizontal_pull: { reference: 100 }, // 70 → 70
    },
  });
  assert.equal(firstSlot(plan, 'horizontal_push').protocol.startHint, 130);
  assert.match(firstSlot(plan, 'horizontal_push').protocol.instruction, /^Start around 130 lbs/);
  assert.equal(firstSlot(plan, 'squat').protocol.startHint, 160);
  assert.equal(firstSlot(plan, 'hinge').protocol.startHint, 195);
  assert.equal(firstSlot(plan, 'horizontal_pull').protocol.startHint, 70);
});

test('F2 — a reference seeds a start hint but never raises confidence', () => {
  // A stated number is not a logged set: the lift stays calibrating (spec §6, owner call 5).
  const plan = buildOnboardingSessionPlan({ lifts: { squat: { reference: 225 } } });
  const squat = firstSlot(plan, 'squat');
  assert.equal(squat.calibration_status, 'calibrating');
  assert.equal(squat.working_weight, null);
  assert.deepEqual(squat.warmup_sets, []);
});

// --- F7: warm-up ramp only once a working weight exists ------------------------

test('F7 — graduated lift with a working weight gets the 50/70/85 ramp, no start hint', () => {
  const plan = buildOnboardingSessionPlan({
    lifts: { squat: { lift_confidence: 'medium', working_weight: 225 } },
  });
  const squat = firstSlot(plan, 'squat');
  assert.equal(squat.calibration_status, 'graduated');
  assert.equal(squat.working_weight, 225);
  assert.deepEqual(squat.warmup_sets, buildWarmupRamp(225));
  assert.equal(squat.warmup_sets.length, 3);
  assert.equal(squat.protocol, null);
});

test('F7 — graduated label without a working weight does NOT fabricate a ramp', () => {
  // Safe direction: no working weight → stay in calibration, never ramp on a missing number.
  const plan = buildOnboardingSessionPlan({
    lifts: { squat: { lift_confidence: 'high' } },
  });
  const squat = firstSlot(plan, 'squat');
  assert.deepEqual(squat.warmup_sets, []);
  assert.equal(squat.working_weight, null);
  assert.ok(squat.protocol, 'falls back to a calibration start hint');
});

// --- Per-lift only: no majority gate -------------------------------------------

test('per-lift status — a graduated squat and a calibrating deadlift stay distinct', () => {
  const plan = buildOnboardingSessionPlan({
    lifts: {
      squat: { lift_confidence: 'medium', working_weight: 200 }, // graduated
      hinge: { lift_confidence: 'low' },                         // calibrating
    },
  });
  const squat = firstSlot(plan, 'squat');
  const hinge = firstSlot(plan, 'hinge');
  assert.equal(squat.calibration_status, 'graduated');
  assert.equal(hinge.calibration_status, 'calibrating');
  // No session-level collapse: the two coexist in the same plan with different states.
  assert.equal(squat.warmup_sets.length, 3);
  assert.equal(hinge.warmup_sets.length, 0);
  assert.ok(hinge.protocol);
  assert.equal(squat.protocol, null);
});

// --- Equipment-aware variant selection -----------------------------------------

test('dumbbell-only swaps in the dumbbell variants and drops barbell-less patterns', () => {
  const plan = buildOnboardingSessionPlan({ availableEquipment: ['dumbbell'] });
  assert.equal(firstSlot(plan, 'squat').exercise, 'Goblet Squat');
  assert.equal(firstSlot(plan, 'horizontal_push').exercise, 'Dumbbell Bench Press');
  assert.equal(firstSlot(plan, 'hinge').exercise, 'Dumbbell RDL');
  assert.equal(firstSlot(plan, 'isolation').exercise, 'Dumbbell Curl');
});

test('bodyweight-only drops patterns with no bodyweight variant (isolation)', () => {
  const plan = buildOnboardingSessionPlan({ availableEquipment: ['bodyweight'] });
  assert.equal(firstSlot(plan, 'squat').exercise, 'Bodyweight Squat');
  assert.equal(firstSlot(plan, 'horizontal_push').exercise, 'Push-Up');
  // Isolation has no bodyweight variant → unsupported, dropped from every session.
  assert.ok(plan.unsupported_patterns.includes('isolation'));
  assert.equal(firstSlot(plan, 'isolation'), null);
});

test('all slots reference real engine numbers only (no invented load)', () => {
  // Every emitted load is either a passed working weight, its buildWarmupRamp output,
  // or a buildWorkingWeightProtocol start hint — never synthesized by the builder.
  const plan = buildOnboardingSessionPlan({
    lifts: { squat: { lift_confidence: 'medium', working_weight: 185 } },
  });
  const squat = firstSlot(plan, 'squat');
  assert.deepEqual(squat.warmup_sets, buildWarmupRamp(185));
  for (const session of plan.sessions) {
    for (const slot of session.slots) {
      if (slot.calibration_status === 'calibrating') {
        assert.equal(slot.working_weight, null);
        assert.deepEqual(slot.warmup_sets, []);
      }
    }
  }
});
