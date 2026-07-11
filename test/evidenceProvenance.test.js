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
  isFirstPartyBrowser,
} = require('../services/evidenceProvenance');

// A genuine athlete request: production runtime + the UI origin marker + not test +
// VERIFIED first-party browser provenance (same-origin fetch metadata). The marker
// alone is a client CLAIM — eligibility now requires the browser signal to agree.
const ATHLETE = { testMode: false, requestOrigin: 'athlete_ui', productionRuntime: true, firstPartyBrowser: true };

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

// ── First-party browser provenance: the marker alone is only a CLAIM ──────────

test('athlete_ui marker WITHOUT verified first-party browser provenance → unknown, ineligible', () => {
  // A direct API call or a script that merely sets x-atlas-request-origin: athlete_ui
  // (production, not test/sim) must NOT count — it only recorded what the caller claimed.
  const r = classifyEvidence({ testMode: false, requestOrigin: 'athlete_ui', productionRuntime: true, firstPartyBrowser: false });
  assert.equal(r.evidence_class, 'unknown');
  assert.equal(r.evidence_eligible, false);
  // missing (undefined) browser provenance also fails closed
  const missing = classifyEvidence({ requestOrigin: 'athlete_ui', productionRuntime: true });
  assert.equal(missing.evidence_class, 'unknown');
});

test('isFirstPartyBrowser: requires same-origin Sec-Fetch-Site and host-consistent Origin/Referer', () => {
  const host = 'atlas.example.com';
  // genuine same-origin browser fetch: sec-fetch-site same-origin, referer host matches, no Origin (GET)
  assert.equal(isFirstPartyBrowser({ secFetchSite: 'same-origin', refererHost: host, requestHost: host }), true);
  // POST with matching Origin too
  assert.equal(isFirstPartyBrowser({ secFetchSite: 'same-origin', originHost: host, refererHost: host, requestHost: host }), true);
  // cross-site fetch metadata → not first-party
  assert.equal(isFirstPartyBrowser({ secFetchSite: 'cross-site', refererHost: host, requestHost: host }), false);
  assert.equal(isFirstPartyBrowser({ secFetchSite: 'same-site', requestHost: host }), false);
  // missing sec-fetch-site (a script / non-browser) → fail closed
  assert.equal(isFirstPartyBrowser({ refererHost: host, requestHost: host }), false);
  assert.equal(isFirstPartyBrowser({}), false);
  // host mismatch on a present Origin/Referer → contradictory → fail closed
  assert.equal(isFirstPartyBrowser({ secFetchSite: 'same-origin', originHost: 'evil.example.com', requestHost: host }), false);
  assert.equal(isFirstPartyBrowser({ secFetchSite: 'same-origin', refererHost: 'evil.example.com', requestHost: host }), false);
  // malformed input → fail closed, never throws
  assert.doesNotThrow(() => isFirstPartyBrowser(null));
  assert.equal(isFirstPartyBrowser(null), false);
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
  // a genuine athlete request with no sim flag, in production, with verified browser provenance
  const ok = classifyRequestSignals({ originHeader: 'athlete_ui', simulationHeader: undefined, productionRuntime: true, firstPartyBrowser: true });
  assert.equal(ok.evidence_class, 'athlete_ui');
  assert.equal(ok.evidence_eligible, true);
});

test('classifyRequestSignals: test_mode:true → synthetic even with athlete_ui in production (rule 1 on the wired path)', () => {
  const r = classifyRequestSignals({ originHeader: 'athlete_ui', productionRuntime: true, testMode: true });
  assert.equal(r.evidence_class, 'synthetic');
  assert.equal(r.evidence_eligible, false);
});

// ── evidenceForRequest: full first-party browser provenance (the owner's cases) ──

// A minimal Express-like request with case-insensitive header access.
function mkReq(headers = {}, extra = {}) {
  const h = {};
  for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];
  return { get: (name) => h[String(name).toLowerCase()], headers: h, query: extra.query, body: extra.body };
}
const HOST = 'atlas.example.com';
const SAME_ORIGIN = { 'host': HOST, 'sec-fetch-site': 'same-origin', 'referer': `https://${HOST}/app/`, 'x-atlas-request-origin': 'athlete_ui' };

test('evidenceForRequest: production same-origin REAL-BROWSER request + athlete_ui → athlete_ui, eligible', () => {
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const r = evidenceForRequest(mkReq(SAME_ORIGIN));
    assert.equal(r.evidence_class, 'athlete_ui');
    assert.equal(r.evidence_eligible, true);
    assert.equal(r.request_origin, 'athlete_ui');
  } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
});

test('evidenceForRequest: production athlete_ui with NO browser provenance (script/direct API spoof) → unknown/ineligible', () => {
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    // only the marker + api key — no Sec-Fetch-Site, no Referer (a curl/node caller)
    const r = evidenceForRequest(mkReq({ 'host': HOST, 'x-atlas-request-origin': 'athlete_ui' }));
    assert.equal(r.evidence_class, 'unknown', 'a bare header claim is not first-party');
    assert.equal(r.evidence_eligible, false);
  } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
});

test('evidenceForRequest: production CROSS-SITE request with athlete_ui → unknown/ineligible', () => {
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const r = evidenceForRequest(mkReq({ ...SAME_ORIGIN, 'sec-fetch-site': 'cross-site', 'referer': 'https://evil.example.com/' }));
    assert.equal(r.evidence_class, 'unknown');
    assert.equal(r.evidence_eligible, false);
  } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
});

test('evidenceForRequest: production Origin/Referer host MISMATCH (spoofed marker) → unknown/ineligible', () => {
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const r = evidenceForRequest(mkReq({ ...SAME_ORIGIN, 'origin': 'https://evil.example.com' }));
    assert.equal(r.evidence_class, 'unknown', 'a present Origin whose host ≠ request host is contradictory → fail closed');
  } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
});

test('evidenceForRequest: a navigator.webdriver client sends origin "playwright" → synthetic/ineligible', () => {
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    // the frontend seam replaces athlete_ui with a synthetic marker under automation
    const r = evidenceForRequest(mkReq({ ...SAME_ORIGIN, 'x-atlas-request-origin': 'playwright' }));
    assert.equal(r.evidence_class, 'synthetic');
    assert.equal(r.evidence_eligible, false);
    assert.equal(r.request_origin, 'playwright');
  } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
});

test('evidenceForRequest: synthetic markers + test_mode still outrank a perfect same-origin browser request', () => {
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal(evidenceForRequest(mkReq({ ...SAME_ORIGIN, 'x-atlas-simulation': '1' })).evidence_class, 'synthetic', 'sim wins');
    assert.equal(evidenceForRequest(mkReq({ ...SAME_ORIGIN }, { query: { test_mode: 'true' } })).evidence_class, 'synthetic', 'test_mode wins');
  } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
});

test('evidenceForRequest: malformed browser headers fail closed and never throw; no raw header value is persisted', () => {
  const prev = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const junk = mkReq({ 'host': HOST, 'sec-fetch-site': { nope: 1 }, 'origin': 'not a url', 'referer': 12345, 'x-atlas-request-origin': 'athlete_ui' });
    let r;
    assert.doesNotThrow(() => { r = evidenceForRequest(junk); });
    assert.equal(r.evidence_class, 'unknown', 'malformed provenance → fail closed');
    // request_origin is a bounded token — never a host, URL, or raw header value
    assert.ok(['athlete_ui', 'other', 'missing', 'sim', 'smoke'].includes(r.request_origin), `bounded token, got ${r.request_origin}`);
    assert.ok(!/example\.com|https?:|not a url/.test(String(r.request_origin)), 'no raw header content in request_origin');
  } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
});

test('evidenceForRequest: a test_mode flag on the request (query or body) forces synthetic (rule 1 wired)', () => {
  const prevEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    // test_mode outranks everything — synthetic regardless of the sandbox-sheet read.
    const qReq = { get: (h) => ({ 'x-atlas-request-origin': 'athlete_ui' })[h], query: { test_mode: 'true' } };
    assert.equal(evidenceForRequest(qReq).evidence_class, 'synthetic', 'query test_mode → synthetic');
    const bReq = { get: (h) => ({ 'x-atlas-request-origin': 'athlete_ui' })[h], body: { test_mode: true } };
    assert.equal(evidenceForRequest(bReq).evidence_class, 'synthetic', 'body test_mode → synthetic');
    // control: same shape without test_mode is NOT forced synthetic by rule 1
    const clean = { get: (h) => ({ 'x-atlas-request-origin': 'athlete_ui' })[h], query: {} };
    assert.ok(['athlete_ui', 'synthetic', 'unknown'].includes(evidenceForRequest(clean).evidence_class));
    assert.notEqual(evidenceForRequest(clean).request_origin, 'test_mode', 'no test_mode → not classified via rule 1');
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
  }
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
