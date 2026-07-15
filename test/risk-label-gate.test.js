const test = require('node:test');
const assert = require('node:assert/strict');
const { PRIMARY_RISK_LABELS, evaluatePrimaryRiskLabels } = require('../scripts/risk-label-gate');

test('the four canonical primary labels are the enforced set', () => {
  assert.deepEqual(PRIMARY_RISK_LABELS, ['auto-safe', 'owner-live-test', 'owner-decision', 'blocked']);
});

test('exactly one primary label passes', () => {
  const r = evaluatePrimaryRiskLabels(['auto-safe', 'infrastructure']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.present, ['auto-safe']);
});

test('each primary label individually passes', () => {
  for (const label of PRIMARY_RISK_LABELS) {
    const r = evaluatePrimaryRiskLabels([label, 'trust-sensitive']);
    assert.equal(r.ok, true, `${label} should pass`);
    assert.deepEqual(r.present, [label]);
  }
});

test('no primary label fails (only category labels present)', () => {
  const r = evaluatePrimaryRiskLabels(['infrastructure', 'coach-behavior']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.present, []);
  assert.match(r.message, /No primary risk label/i);
});

test('an empty / missing label set fails', () => {
  assert.equal(evaluatePrimaryRiskLabels([]).ok, false);
  assert.equal(evaluatePrimaryRiskLabels(undefined).ok, false);
  assert.equal(evaluatePrimaryRiskLabels(null).ok, false);
});

test('two primary labels fail (ambiguous classification)', () => {
  const r = evaluatePrimaryRiskLabels(['auto-safe', 'owner-decision']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.present, ['auto-safe', 'owner-decision']);
  assert.match(r.message, /Multiple primary risk labels/i);
});

test('blocked counts as a valid single primary label (merge-eligibility is a separate gate)', () => {
  const r = evaluatePrimaryRiskLabels(['blocked']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.present, ['blocked']);
});

test('label matching is case-insensitive and whitespace-tolerant', () => {
  const r = evaluatePrimaryRiskLabels(['  Auto-Safe  ', 'INFRASTRUCTURE']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.present, ['auto-safe']);
});

test('duplicate primary labels collapse to one (still passes)', () => {
  const r = evaluatePrimaryRiskLabels(['auto-safe', 'auto-safe']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.present, ['auto-safe']);
});

test('non-string / falsy label entries are ignored', () => {
  const r = evaluatePrimaryRiskLabels(['auto-safe', '', null, undefined, 0]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.present, ['auto-safe']);
});

test('a category-only label that merely contains a primary name is not counted', () => {
  // Guard against substring false positives — only exact label names count.
  const r = evaluatePrimaryRiskLabels(['auto-safe-ish', 'not-blocked']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.present, []);
});
