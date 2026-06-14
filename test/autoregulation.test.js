'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { autoregulateNextSet } = require('../services/autoregulation');

test('RIR overshoot (harder than planned) reduces next-set load', () => {
  const result = autoregulateNextSet({ targetRIR: 2, actualRIR: 0, currentLoad: 200 });
  assert.equal(result.action, 'reduce_load_or_drop_backoff');
  assert.ok(result.loadAdjustmentPct < 0);
  assert.ok(result.suggestedLoad < 200);
  assert.ok(result.reasonCodes.includes('autoreg_reduce_load_rir_overshoot'));
});

test('RIR undershoot (easier) with solid technique increases next-set load', () => {
  const result = autoregulateNextSet({ targetRIR: 2, actualRIR: 4, techniqueSolid: true, currentLoad: 200 });
  assert.equal(result.action, 'increase_load');
  assert.ok(result.loadAdjustmentPct > 0);
  assert.ok(result.suggestedLoad > 200);
  assert.ok(result.reasonCodes.includes('autoreg_increase_load_rir_undershoot'));
});

test('RIR undershoot but degrading technique holds load (technique gates load)', () => {
  const result = autoregulateNextSet({ targetRIR: 2, actualRIR: 4, techniqueSolid: false });
  assert.equal(result.action, 'hold');
  assert.ok(result.reasonCodes.includes('autoreg_technique_gates_load'));
});

test('power: high velocity loss / grindy reps ends the set, never grinds to failure', () => {
  const byVelocity = autoregulateNextSet({ goal: 'power', targetRIR: 4, actualRIR: 4, velocityLossPct: 30, currentLoad: 135 });
  assert.equal(byVelocity.action, 'end_set_or_switch_low_fatigue');
  assert.notEqual(byVelocity.action, 'increase_load');
  assert.ok(byVelocity.reasonCodes.includes('autoreg_power_protect_speed'));

  const byGrind = autoregulateNextSet({ goal: 'power', targetRIR: 4, actualRIR: 4, repsGrindy: true });
  assert.equal(byGrind.action, 'end_set_or_switch_low_fatigue');
});

test('pain above threshold overrides everything and regresses', () => {
  // RIR alone would say "increase load"; pain must win.
  const result = autoregulateNextSet({ targetRIR: 2, actualRIR: 4, techniqueSolid: true, painLevel: 5, currentLoad: 200 });
  assert.equal(result.action, 'regress');
  assert.ok(result.reasonCodes.includes('autoreg_pain_regress'));
});

test('on-target RIR holds, and a target RIR range is supported', () => {
  assert.equal(autoregulateNextSet({ targetRIR: 2, actualRIR: 2 }).action, 'hold');
  // Range form: midpoint is 2, actual 0 is harder than planned -> reduce.
  const ranged = autoregulateNextSet({ targetRIR: { min: 1, max: 3 }, actualRIR: 0, currentLoad: 100 });
  assert.equal(ranged.action, 'reduce_load_or_drop_backoff');
});
