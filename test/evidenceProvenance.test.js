'use strict';

// PR-GATEA1 — evidence provenance classifier.
//
// GATE A's 50-real-event floor was un-auditable because Brain_Shadow / Intent_Shadow
// rows could not be separated into genuine athlete activity vs synthetic probes,
// simulations, canaries, Playwright, and smoke traffic. This module makes every
// future event DETERMINISTICALLY classifiable and fails CLOSED: only a positively
// identified genuine athlete-UI request in production is `evidence_eligible`.
// Classification is telemetry-only — it never changes a served coaching response.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EVIDENCE_CLASSES,
  classifyEvidence,
  normalizeEvidenceClass,
  isEvidenceEligible,
  isProductionRuntime,
  classifyRequestSignals,
  evidenceForRequest,
} = require('../services/evidenceProvenance');

// A genuine athlete request: production runtime + the UI origin marker + not test.
const ATHLETE = { testMode: false, requestOrigin: 'athlete_ui', productionRuntime: true };

test('frozen class vocabulary', () => {
  assert.deepEqual(
    Object.values(EVIDENCE_CLASSES).sort(),
    ['athlete_ui', 'synthetic', 'unknown']
  );
  assert.ok(Object.isFrozen(EVIDENCE_CLASSES));
});

// ── Rule 1: only a positively-identified genuine athlete UI request is eligible ──

test('genuine non-test athlete UI request in production → athlete_ui, eligible', () => {
  const r = classifyEvidence(ATHLETE);
  assert.equal(r.evidence_class, 'athlete_ui');
  assert.equal(r.evidence_eligible, true);
});

// ── Rule 2: test_mode:true is ALWAYS synthetic/ineligible (highest precedence) ──

test('test_mode:true → synthetic, ineligible — even with an athlete_ui marker in production', () => {
  const r = classifyEvidence({ ...ATHLETE, testMode: true });
  assert.equal(r.evidence_class, 'synthetic');
  assert.equal(r.evidence_eligible, false);
});

// ── Rule 3: local / CI / Playwright / sim / replay / canary / smoke → synthetic ──

test('Playwright / CI / local request → synthetic, ineligible', () => {
  for (const origin of ['playwright', 'e2e', 'ci']) {
    const r = classifyEvidence({ testMode: false, requestOrigin: origin, productionRuntime: false });
    assert.equal(r.evidence_class, 'synthetic', `${origin} → synthetic`);
    assert.equal(r.evidence_eligible, false);
  }
});

test('a non-production runtime is synthetic even if the request claims athlete_ui (Playwright drives the real UI)', () => {
  const r = classifyEvidence({ testMode: false, requestOrigin: 'athlete_ui', productionRuntime: false });
  assert.equal(r.evidence_class, 'synthetic', 'a real-UI E2E run against a CI/local server must not count');
  assert.equal(r.evidence_eligible, false);
});

test('simulation / canary / probe / smoke request → synthetic, ineligible (marked at the source)', () => {
  for (const origin of ['sim', 'simulation', 'replay', 'canary', 'probe', 'smoke']) {
    const r = classifyEvidence({ testMode: false, requestOrigin: origin, productionRuntime: true });
    assert.equal(r.evidence_class, 'synthetic', `${origin} → synthetic`);
    assert.equal(r.evidence_eligible, false);
  }
});

// ── Rule 4/5: direct untagged API / missing / malformed → unknown, ineligible ──

test('direct untagged API request in production → unknown, ineligible', () => {
  const r = classifyEvidence({ testMode: false, requestOrigin: null, productionRuntime: true });
  assert.equal(r.evidence_class, 'unknown', 'no athlete_ui marker → cannot be positively identified');
  assert.equal(r.evidence_eligible, false);
});

test('an unrecognized origin token in production → unknown, ineligible (fail closed)', () => {
  const r = classifyEvidence({ testMode: false, requestOrigin: 'somebody-elses-app', productionRuntime: true });
  assert.equal(r.evidence_class, 'unknown');
  assert.equal(r.evidence_eligible, false);
});

test('missing / malformed metadata → unknown, ineligible', () => {
  assert.equal(classifyEvidence({}).evidence_class, 'unknown');
  assert.equal(classifyEvidence(undefined).evidence_class, 'unknown');
  assert.equal(classifyEvidence(null).evidence_class, 'unknown');
  assert.equal(classifyEvidence({ requestOrigin: 42, productionRuntime: true }).evidence_class, 'unknown');
  assert.equal(classifyEvidence({ requestOrigin: {}, productionRuntime: 'yes' }).evidence_class, 'unknown');
  for (const bad of [classifyEvidence({}), classifyEvidence(null)]) {
    assert.equal(bad.evidence_eligible, false, 'missing/malformed is never eligible');
  }
});

// ── Rule 6: deterministic — depends only on {testMode, requestOrigin, runtime} ──

test('classification is deterministic and case/whitespace tolerant on the origin token', () => {
  assert.equal(classifyEvidence({ ...ATHLETE, requestOrigin: '  Athlete_UI  ' }).evidence_class, 'athlete_ui');
  // Same inputs always yield the same verdict (no volume/timestamp influence).
  for (let i = 0; i < 5; i++) assert.equal(classifyEvidence(ATHLETE).evidence_class, 'athlete_ui');
});

// ── Rule 7: old rows without the new fields read back as unknown/ineligible ──

test('normalizeEvidenceClass: a stored class round-trips; absent/garbage → unknown (old rows)', () => {
  assert.equal(normalizeEvidenceClass('athlete_ui'), 'athlete_ui');
  assert.equal(normalizeEvidenceClass('synthetic'), 'synthetic');
  assert.equal(normalizeEvidenceClass('unknown'), 'unknown');
  // Old rows: the evidence_class cell simply does not exist.
  assert.equal(normalizeEvidenceClass(undefined), 'unknown', 'old 16-col Brain_Shadow / 13-col Intent_Shadow rows → unknown');
  assert.equal(normalizeEvidenceClass(''), 'unknown');
  assert.equal(normalizeEvidenceClass(null), 'unknown');
  assert.equal(normalizeEvidenceClass('eligible'), 'unknown', 'a garbage token is never trusted');
  assert.equal(isEvidenceEligible(normalizeEvidenceClass(undefined)), false, 'an old row never counts');
});

test('isEvidenceEligible: only athlete_ui is eligible', () => {
  assert.equal(isEvidenceEligible('athlete_ui'), true);
  assert.equal(isEvidenceEligible('synthetic'), false);
  assert.equal(isEvidenceEligible('unknown'), false);
  assert.equal(isEvidenceEligible('anything'), false);
});

// ── Security: request_origin is a bounded token — no raw header text is stored ──

test('no arbitrary/secret text can reach request_origin — unrecognized origins collapse to a fixed token', () => {
  const secretish = classifyEvidence({ requestOrigin: 'Bearer sk-live-DEADBEEF-secret', productionRuntime: true });
  assert.equal(secretish.evidence_class, 'unknown');
  assert.equal(secretish.request_origin, 'other', 'a raw/secret-looking origin is never persisted verbatim');
  const empty = classifyEvidence({ requestOrigin: '', productionRuntime: true });
  assert.equal(empty.request_origin, 'missing');
  // every emitted request_origin is a short, bounded token
  for (const inp of [{ testMode: true }, { requestOrigin: 'canary', productionRuntime: true }, { requestOrigin: 'x'.repeat(500), productionRuntime: true }]) {
    const r = classifyEvidence(inp);
    assert.ok(typeof r.request_origin === 'string' && r.request_origin.length <= 32, `bounded token, got ${r.request_origin}`);
  }
});

// ── Server adapters ──────────────────────────────────────────────────────────

test('isProductionRuntime: only NODE_ENV=production on the real (non-sandbox) sheet', () => {
  assert.equal(isProductionRuntime({ nodeEnv: 'production', isSandboxSheet: false }), true);
  assert.equal(isProductionRuntime({ nodeEnv: 'production', isSandboxSheet: true }), false, 'sandbox sheet is not production');
  assert.equal(isProductionRuntime({ nodeEnv: 'test', isSandboxSheet: false }), false);
  assert.equal(isProductionRuntime({ nodeEnv: 'development' }), false);
  assert.equal(isProductionRuntime({}), false, 'indeterminate → not production');
});

test('classifyRequestSignals: the x-atlas-simulation flag always wins → synthetic', () => {
  const r = classifyRequestSignals({ originHeader: 'athlete_ui', simulationHeader: '1', productionRuntime: true });
  assert.equal(r.evidence_class, 'synthetic');
  assert.equal(r.request_origin, 'sim');
  // a genuine athlete request with no sim flag, in production
  const ok = classifyRequestSignals({ originHeader: 'athlete_ui', simulationHeader: undefined, productionRuntime: true });
  assert.equal(ok.evidence_class, 'athlete_ui');
  assert.equal(ok.evidence_eligible, true);
});

test('evidenceForRequest: reads headers + is TOTAL (never throws) and fails closed', () => {
  const prevEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const req = { get: (h) => ({ 'x-atlas-request-origin': 'athlete_ui' })[h] };
    const r = evidenceForRequest(req);
    // production runtime here depends on the sandbox-sheet read; assert it never throws
    // and returns a valid, bounded verdict.
    assert.ok(['athlete_ui', 'synthetic', 'unknown'].includes(r.evidence_class));
    assert.equal(typeof r.evidence_eligible, 'boolean');
    // simulated header wins regardless of runtime
    const simReq = { get: (h) => ({ 'x-atlas-request-origin': 'athlete_ui', 'x-atlas-simulation': '1' })[h] };
    assert.equal(evidenceForRequest(simReq).evidence_class, 'synthetic');
    // garbage req → fail closed, no throw
    assert.equal(evidenceForRequest(null).evidence_class, 'unknown');
    assert.equal(evidenceForRequest({}).evidence_eligible, false);
    // bodyOrigin path (intent-observe POST bypasses the header seam)
    const bodyReq = { get: () => undefined };
    assert.ok(['athlete_ui', 'synthetic', 'unknown'].includes(evidenceForRequest(bodyReq, { bodyOrigin: 'athlete_ui' }).evidence_class));
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
  }
});
