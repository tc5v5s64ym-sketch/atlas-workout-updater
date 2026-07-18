'use strict';

// F10 — Authoritative planned-slot completion identity (RED-FIRST reproduction).
//
// Findings: PR-24 slice-3 divergence, SESS-4, SESS-5, Workout Sheet duplicate-name
// identity. The historical failure: completion is decided by NAME (a Set of logged
// names broadcast across the plan), so:
//   (1) two same-named planned slots BOTH drop out of `remaining` on ONE logged set
//       — one log completes every same-named slot (the duplicate-name bug), and
//   (2) an ambiguous substring is resolved by guessing instead of refusing.
//
// This file reproduces the duplicate-name failure through the CLOSEST live seam
// (services/sessionPlanExecutor.computePlanState — the server chat/closeout plan
// state) and pins the authoritative fix: each logged completion attributes to AT
// MOST ONE planned slot, so a second same-named slot stays remaining. The full
// per-slot selector contract lives in test/planSlotStatuses.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { computePlanState } = require('../services/sessionPlanExecutor');

test('F10 repro: two same-named planned slots are NOT both completed by one logged set', () => {
  // A push session that legitimately programs the same movement twice (e.g. a top
  // set then a back-off block rendered as two slots, or the same accessory twice).
  const planned = ['Lat Pulldown', 'Cable Row', 'Lat Pulldown'];
  // The lifter has logged ONE Lat Pulldown so far (names dedupe upstream in
  // sessionCompleted, so the server sees a single "Lat Pulldown").
  const completed = ['Lat Pulldown'];

  const state = computePlanState(planned, completed);

  // Exactly ONE of the two Lat Pulldown slots is satisfied — the other is still to do.
  const remainingLatPulldowns = state.remaining.filter(n => n.toLowerCase() === 'lat pulldown');
  assert.equal(remainingLatPulldowns.length, 1,
    'one logged Lat Pulldown must clear exactly ONE of the two slots, not both');
  assert.deepEqual(state.remaining, ['Cable Row', 'Lat Pulldown'],
    'Cable Row and the second Lat Pulldown remain, in plan order');
  assert.equal(state.isComplete, false, 'the plan is not complete after one of two duplicate slots');
});

test('F10 repro: both duplicate slots complete only when both are logged', () => {
  const planned = ['Lat Pulldown', 'Cable Row', 'Lat Pulldown'];
  // Two DISTINCT completion entries (the client would push a second identity only
  // when a second slot is genuinely attributed — e.g. via the explicit id lane).
  const completed = ['Lat Pulldown', 'Cable Row', 'Lat Pulldown'];
  const state = computePlanState(planned, completed);
  assert.deepEqual(state.remaining, [], 'all three slots satisfied once both duplicates are logged');
  assert.equal(state.isComplete, true);
});
