const test = require('node:test');
const assert = require('node:assert/strict');
const { PRIMARY_RISK_LABELS, evaluatePrimaryRiskLabels, resolveFinalStatus } = require('../scripts/risk-label-gate');

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

// --- Fail-closed final-status resolution (mirrors the workflow's if:always() publisher) ---

test('resolveFinalStatus: a conclusive success passes through', () => {
  const r = resolveFinalStatus('success', 'Exactly one primary risk label: auto-safe.');
  assert.equal(r.state, 'success');
  assert.match(r.description, /Exactly one/);
});

test('resolveFinalStatus: a conclusive failure passes through', () => {
  const r = resolveFinalStatus('failure', 'No primary risk label.');
  assert.equal(r.state, 'failure');
  assert.match(r.description, /No primary risk label/);
});

test('resolveFinalStatus: a missing/empty state fails closed (evaluation never ran)', () => {
  for (const missing of ['', undefined, null]) {
    const r = resolveFinalStatus(missing, undefined);
    assert.equal(r.state, 'failure', `state=${JSON.stringify(missing)} must fail closed`);
    assert.match(r.description, /could not complete/i);
  }
});

test('resolveFinalStatus: pending or any non-conclusive value fails closed', () => {
  for (const bad of ['pending', 'error', 'garbage', 'SUCCESS']) {
    const r = resolveFinalStatus(bad, 'whatever');
    assert.equal(r.state, 'failure', `state=${bad} must fail closed`);
  }
});

test('resolveFinalStatus: descriptions are clipped to the 140-char commit-status cap', () => {
  const long = 'x'.repeat(300);
  const r = resolveFinalStatus('success', long);
  assert.ok(r.description.length <= 140, `too long: ${r.description.length}`);
});

test('resolveFinalStatus: a success with no description gets a safe default', () => {
  const r = resolveFinalStatus('success', '');
  assert.equal(r.state, 'success');
  assert.ok(r.description.length > 0);
});
