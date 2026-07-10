'use strict';

// PR-G1 — explicit item-outcome capture (src/app/planOutcome.js). Pure/DI; runs in
// Node with no DOM. Pins: identity resolved by plan_item_id ONLY (never lift-code /
// name / position; duplicate lift codes stay unambiguous); fail-closed when the plan
// isn't an accepted session or the id is unknown (no fallback matching); substituted
// preserves planned_lift_code + records performed_lift_code; skipped carries no
// performed code; completed is out of scope this slice; a sidecar failure never
// throws and never blocks the workout.

const test = require('node:test');
const assert = require('node:assert/strict');

let mod;
test.before(async () => { mod = await import('../src/app/planOutcome.js'); });

// Two items sharing a lift code but with DISTINCT ids — proves identity is by id.
const PLAN = {
  accepted: true, session_id: 'S1', session_date: '2026-07-10', plan_version: 'pv_x1',
  items: [
    { plan_item_id: 'pi_a', planned_order: 1, planned_lift_code: 'BEN01', movement_pattern: 'horizontal_push' },
    { plan_item_id: 'pi_b', planned_order: 2, planned_lift_code: 'BEN01', movement_pattern: null },
  ],
};

// ── identity resolution ─────────────────────────────────────────────────────--

test('resolveItemForOutcome: matches by plan_item_id only; duplicate lift codes stay unambiguous', () => {
  assert.equal(mod.resolveItemForOutcome(PLAN, 'pi_a').planned_order, 1);
  assert.equal(mod.resolveItemForOutcome(PLAN, 'pi_b').planned_order, 2);
  assert.equal(mod.resolveItemForOutcome(PLAN, 'pi_unknown'), null);
  assert.equal(mod.resolveItemForOutcome(PLAN, 'BEN01'), null, 'a lift code is never an identity');
  assert.equal(mod.resolveItemForOutcome(PLAN, ''), null);
});

// ── payload build (fail closed) ─────────────────────────────────────────────--

test('buildOutcomePayload: skipped → identity + planned metadata, no performed code', () => {
  const p = mod.buildOutcomePayload(PLAN, { plan_item_id: 'pi_a', outcome: 'skipped' });
  assert.equal(p.session_id, 'S1');
  assert.equal(p.plan_version, 'pv_x1');
  assert.equal(p.item.plan_item_id, 'pi_a');
  assert.equal(p.item.planned_lift_code, 'BEN01');
  assert.equal(p.item.outcome, 'skipped');
  assert.ok(!('performed_lift_code' in p.item), 'skipped carries no performed code');
});

test('buildOutcomePayload: substituted preserves planned_lift_code and records performed_lift_code', () => {
  const p = mod.buildOutcomePayload(PLAN, { plan_item_id: 'pi_a', outcome: 'substituted', performed_lift_code: 'DBP01' });
  assert.equal(p.item.plan_item_id, 'pi_a');
  assert.equal(p.item.planned_lift_code, 'BEN01', 'original planned code preserved');
  assert.equal(p.item.performed_lift_code, 'DBP01');
  assert.equal(p.item.outcome, 'substituted');
});

test('buildOutcomePayload fails closed: substituted without a canonical performed code → null', () => {
  assert.equal(mod.buildOutcomePayload(PLAN, { plan_item_id: 'pi_a', outcome: 'substituted' }), null);
  assert.equal(mod.buildOutcomePayload(PLAN, { plan_item_id: 'pi_a', outcome: 'substituted', performed_lift_code: 'DB P01' }), null);
});

test('buildOutcomePayload fails closed: unaccepted plan / missing plan_version / unknown id → null (no fallback)', () => {
  assert.equal(mod.buildOutcomePayload({ ...PLAN, accepted: false }, { plan_item_id: 'pi_a', outcome: 'skipped' }), null);
  assert.equal(mod.buildOutcomePayload({ ...PLAN, plan_version: '' }, { plan_item_id: 'pi_a', outcome: 'skipped' }), null);
  assert.equal(mod.buildOutcomePayload(PLAN, { plan_item_id: 'pi_zzz', outcome: 'skipped' }), null, 'unknown id never falls back to lift-code/name');
});

test('buildOutcomePayload: completed → identity + planned metadata, no performed code (PR-G2)', () => {
  const p = mod.buildOutcomePayload(PLAN, { plan_item_id: 'pi_a', outcome: 'completed' });
  assert.equal(p.item.outcome, 'completed');
  assert.equal(p.item.plan_item_id, 'pi_a');
  assert.equal(p.item.planned_lift_code, 'BEN01');
  assert.ok(!('performed_lift_code' in p.item), 'completed carries no performed code');
});

test('buildOutcomePayload: an unknown outcome is still rejected', () => {
  assert.equal(mod.buildOutcomePayload(PLAN, { plan_item_id: 'pi_a', outcome: 'done' }), null);
  assert.equal(mod.buildOutcomePayload(PLAN, { plan_item_id: 'pi_a', outcome: 'planned' }), null);
});

// ── orchestration ─────────────────────────────────────────────────────────────

test('runOutcome: happy path posts the payload and reports captured', async () => {
  const posted = [];
  const r = await mod.runOutcome(PLAN, { plan_item_id: 'pi_a', outcome: 'skipped' }, {
    postOutcome: async (p) => { posted.push(p); return { data: { session_plans: { captured: true, status: 'written' } } }; },
  });
  assert.equal(r.emitted, true);
  assert.equal(r.captured, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].item.outcome, 'skipped');
});

test('runOutcome: no identity → not emitted, never posts', async () => {
  let posts = 0;
  const r = await mod.runOutcome(PLAN, { plan_item_id: 'pi_zzz', outcome: 'skipped' }, { postOutcome: async () => { posts += 1; return {}; } });
  assert.equal(r.emitted, false);
  assert.equal(r.reason, 'no_identity');
  assert.equal(posts, 0);
});

test('runOutcome: a sidecar failure is isolated — emitted:true, captured:false, never throws', async () => {
  const r = await mod.runOutcome(PLAN, { plan_item_id: 'pi_a', outcome: 'skipped' }, { postOutcome: async () => { throw new Error('network down'); } });
  assert.equal(r.emitted, true);
  assert.equal(r.captured, false);
});

test('runOutcome: a disabled/non-captured envelope → emitted:true, captured:false', async () => {
  const r = await mod.runOutcome(PLAN, { plan_item_id: 'pi_a', outcome: 'skipped' }, {
    postOutcome: async () => ({ data: { session_plans: { captured: false, status: 'disabled' } } }),
  });
  assert.equal(r.emitted, true);
  assert.equal(r.captured, false);
});
