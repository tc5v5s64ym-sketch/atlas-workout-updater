'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { recentWorkingWeight, deloadFillerWeight, detectDeloadRecovery } = require('../services/deloadPolicy');

// Golden fixtures pinning the deload POLICY decisions extracted from analytics.js
// (Step 1C). These guard the behaviour now that the logic lives in its own module.

// ── recentWorkingWeight ───────────────────────────────────────────────────────
test('recentWorkingWeight: takes the heaviest of the recent working sets', () => {
  const rec = { last_working_sets: [{ weight: 185 }, { weight: 190 }, { weight: 188 }] };
  assert.equal(recentWorkingWeight(rec), 190);
});

test('recentWorkingWeight: falls back to best_weight when no working sets', () => {
  assert.equal(recentWorkingWeight({ last_working_sets: [], best_weight: 225 }), 225);
});

test('recentWorkingWeight: falls back to next_target weight when no history', () => {
  assert.equal(recentWorkingWeight({ next_target: { weight: 135 } }), 135);
});

test('recentWorkingWeight: null when nothing usable', () => {
  assert.equal(recentWorkingWeight({}), null);
  assert.equal(recentWorkingWeight(null), null);
  assert.equal(recentWorkingWeight({ last_working_sets: [{ weight: 0 }, { weight: -5 }] , best_weight: 0 }), null);
});

// ── deloadFillerWeight ────────────────────────────────────────────────────────
test('deloadFillerWeight: holds the working weight (cut comes from fewer sets, not load)', () => {
  // NOT the next_target (a step up) — the documented working weight.
  const rec = { last_working_sets: [{ weight: 100 }, { weight: 105 }], next_target: { weight: 110 } };
  assert.equal(deloadFillerWeight(rec), 105, 'holds the working weight, not the +next_target');
});

test('deloadFillerWeight: falls back to next_target only when no history exists', () => {
  assert.equal(deloadFillerWeight({ next_target: { weight: 95 } }), 95);
});

test('deloadFillerWeight: null when neither history nor a next target', () => {
  assert.equal(deloadFillerWeight({}), null);
});

// ── detectDeloadRecovery ──────────────────────────────────────────────────────
const row = (sid, weight, notes = '') => ({ session_id: sid, weight, notes });

test('detectDeloadRecovery: null with fewer than 3 sessions', () => {
  const rows = [row('s1', 200), row('s2', 205)];
  assert.equal(detectDeloadRecovery(rows), null);
});

test('detectDeloadRecovery: heuristic fires when the last top is ≥7% below the established working weight', () => {
  // Established = 200; last = 180 → 10% drop → deload recovery.
  const rows = [row('s1', 195), row('s2', 200), row('s3', 180)];
  const out = detectDeloadRecovery(rows);
  assert.ok(out && out.isDeload, 'a 10% drop is a deload');
  assert.equal(out.preDeloadWeight, 200);
  assert.equal(out.lastTop, 180);
  assert.equal(out.dropPct, 10);
  assert.equal(out.signal, 'heuristic');
});

test('detectDeloadRecovery: a small dip (<7%) is NOT a deload', () => {
  // Established = 200; last = 195 → 2.5% drop → normal variation, not a deload.
  const rows = [row('s1', 198), row('s2', 200), row('s3', 195)];
  assert.equal(detectDeloadRecovery(rows), null);
});

test('detectDeloadRecovery: an explicit deload note fires even on a tiny drop', () => {
  const rows = [row('s1', 198), row('s2', 200), row('s3', 196, 'planned deload week')];
  const out = detectDeloadRecovery(rows);
  assert.ok(out && out.isDeload, 'an explicit note is definitive');
  assert.equal(out.signal, 'note');
});

test('detectDeloadRecovery: null when the last session is not lighter than established', () => {
  const rows = [row('s1', 195), row('s2', 200), row('s3', 205)];
  assert.equal(detectDeloadRecovery(rows), null);
});

test('detectDeloadRecovery: defensive — non-array input returns null (does not throw)', () => {
  assert.equal(detectDeloadRecovery(undefined), null);
  assert.equal(detectDeloadRecovery(null), null);
});
