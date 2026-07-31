'use strict';

// Synthetic containment for Coach_Shadow / Coach_Response (owner ruling 2026-07-31).
//
// WHY. Live-retest Actions run 30596164330 ran the deployed app authenticated. The
// browser write blockade correctly aborted every plan-ledger and flight-recorder
// write, but SIX coach turns still reached `/api/coach/message` — a route that is
// `writeCapable: false` in `config/routes.js` and genuinely does not mutate workout
// state. Its `res.on('finish')` hook nevertheless appended:
//
//   • Coach_Shadow    rows 90–91
//   • Coach_Response  rows 84–85
//
// Neither tab carries provenance columns, so those rows are indistinguishable from
// genuine owner activity and contaminate owner evidence. Intent_Shadow (+6 rows) and
// Brain_Shadow (+57 rows) from the same run were fine: they carry
// evidence_class / evidence_eligible / request_origin and tagged themselves synthetic.
//
// THE RULE. A positively-synthetic request never appends to Coach_Shadow or
// Coach_Response. `unknown` traffic still persists — for an evidence tab, dropping
// unclassifiable-but-possibly-genuine owner turns destroys real evidence, which is
// the worse failure. Intent_Shadow / Brain_Shadow keep recording, tagged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const coachShadowSheet = require('../services/coachShadowSheet');
const coachResponseSheet = require('../services/coachResponseSheet');
const { classifyRequestSignals, EVIDENCE_CLASSES, SYNTHETIC_ORIGINS } = require('../services/evidenceProvenance');

// A minimal but valid-enough params shape for each persist().
const RESPONSE_PARAMS = {
  turnId: 't-1', sessionId: '20260731-AM-01', route: '/api/coach/message',
  intentType: 'block', visible: { data: { message: 'Nice work.' } }, modelStatus: 'ok'
};
const SHADOW_PARAMS = {
  recordedAt: '2026-07-31T01:23:45.000Z',
  trace: { trace: { turn_id: 't-1', stages: [] }, missing: [] },
  assembled: { valid: true, errors: [], packet: { turn_id: 't-1' } },
  visible: { data: { message: 'Nice work.' } }
};

// Inject a writer AND the module's own real header, so `_ensureReady` validates
// cleanly and a genuine turn actually reaches the append (otherwise the header
// check swallows it and every case would look suppressed).
function headersFor(mod) {
  return mod.RESPONSE_HEADERS || mod.SHADOW_HEADERS;
}

async function captureAppends(mod, params, extra) {
  const appended = [];
  mod._resetForTesting({
    append: async (tab, rows) => { appended.push({ tab, rows }); },
    ensure: async () => {},
    getHeader: async () => headersFor(mod)
  });
  const result = mod.persist({ ...params, ...extra });
  await mod._flushForTesting();
  return { appended, result };
}

test.afterEach?.(() => {
  try { coachShadowSheet._resetForTesting({}); } catch { /* best-effort */ }
  try { coachResponseSheet._resetForTesting({}); } catch { /* best-effort */ }
});

// ── 1. A playwright/synthetic request cannot append to either tab ────────────

test('1a. Coach_Shadow: a synthetic turn appends nothing and returns null', async () => {
  const { appended, result } = await captureAppends(coachShadowSheet, SHADOW_PARAMS, { synthetic: true });
  assert.equal(result, null, 'a suppressed turn returns null, not a row');
  assert.deepEqual(appended, [], 'no append reached Coach_Shadow');
});

test('1b. Coach_Response: a synthetic turn appends nothing and returns null', async () => {
  const { appended, result } = await captureAppends(coachResponseSheet, RESPONSE_PARAMS, { synthetic: true });
  assert.equal(result, null);
  assert.deepEqual(appended, [], 'no append reached Coach_Response');
});

test('1c. suppressing a synthetic turn never blocks a later genuine turn with the same id', async () => {
  // The dedupe set must not be polluted by a suppressed turn.
  coachResponseSheet._resetForTesting({ append: async () => {}, ensure: async () => {}, getHeader: async () => coachResponseSheet.RESPONSE_HEADERS });
  assert.equal(coachResponseSheet.persist({ ...RESPONSE_PARAMS, turnId: 'dup-1', synthetic: true }), null);
  const genuine = coachResponseSheet.persist({ ...RESPONSE_PARAMS, turnId: 'dup-1' });
  assert.ok(genuine, 'the genuine turn still persists — the synthetic one did not claim its id');
});

// ── 2. Normal owner requests still persist, unchanged ────────────────────────

test('2a. an owner (non-synthetic) turn still appends to Coach_Shadow and Coach_Response', async () => {
  const shadow = await captureAppends(coachShadowSheet, SHADOW_PARAMS, {});
  assert.equal(shadow.appended.length, 1, 'Coach_Shadow still records owner turns');
  assert.equal(shadow.appended[0].tab, 'Coach_Shadow');

  const response = await captureAppends(coachResponseSheet, RESPONSE_PARAMS, {});
  assert.equal(response.appended.length, 1, 'Coach_Response still records owner turns');
  assert.equal(response.appended[0].tab, 'Coach_Response');
});

test('2b. only an explicit `synthetic: true` suppresses — absent/false/unknown still persist', async () => {
  for (const extra of [{}, { synthetic: false }, { synthetic: undefined }, { synthetic: 'true' }]) {
    const { appended } = await captureAppends(coachResponseSheet, RESPONSE_PARAMS, extra);
    assert.equal(appended.length, 1,
      `unclassified traffic must still persist (${JSON.stringify(extra)}) — losing genuine owner evidence is the worse failure`);
  }
});

// ── 3. Both call sites forward the flag (no silently-unguarded third caller) ──

test('3a. every coachResponseSheet.persist / coachTurnPacketShadow.observe call site passes `synthetic`', () => {
  const sites = [
    ['routes/coachOps.js', 'coachResponseSheet.persist('],
    ['routes/coachOps.js', 'coachTurnPacketShadow.observe('],
    ['services/coachQaShadow.js', 'coachResponseSheet.persist('],
    ['services/coachQaShadow.js', 'coachTurnPacketShadow.observe(']
  ];
  for (const [file, call] of sites) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    let from = src.indexOf(call);
    assert.notEqual(from, -1, `${file} should contain ${call}`);
    while (from !== -1) {
      // The flag must appear within the call's argument block.
      const window = src.slice(from, from + 700);
      assert.match(window, /synthetic\s*:/,
        `${file}: ${call} must forward a \`synthetic\` flag — an unguarded call site would reopen the contamination`);
      from = src.indexOf(call, from + 1);
    }
  }
});

test('3b. coachTurnPacketShadow forwards `synthetic` down to coachShadowSheet.persist', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'coachTurnPacketShadow.js'), 'utf8');
  const i = src.indexOf('coachShadowSheet.persist(');
  assert.notEqual(i, -1);
  assert.match(src.slice(i, i + 300), /synthetic:\s*p\.synthetic === true/,
    'the packet shadow must forward the caller flag, never infer it locally');
});

// ── 4. The provenance classifier still tags synthetic telemetry correctly ────
// Intent_Shadow / Brain_Shadow rely on this classification and must keep recording
// synthetic rows as evidence-INELIGIBLE and provenance-tagged (owner ruling item 4).

test('4a. a playwright request classifies synthetic, ineligible, and origin-tagged', () => {
  const ev = classifyRequestSignals({ originHeader: 'playwright', productionRuntime: true });
  assert.equal(ev.evidence_class, EVIDENCE_CLASSES.SYNTHETIC);
  assert.equal(ev.evidence_eligible, false, 'synthetic telemetry never counts as owner evidence');
  assert.equal(ev.request_origin, 'playwright', 'the origin is preserved as a bounded token');
});

test('4b. every recognized synthetic origin stays ineligible', () => {
  for (const origin of SYNTHETIC_ORIGINS) {
    const ev = classifyRequestSignals({ originHeader: origin, productionRuntime: true });
    assert.equal(ev.evidence_class, EVIDENCE_CLASSES.SYNTHETIC, `${origin} is synthetic`);
    assert.equal(ev.evidence_eligible, false, `${origin} is never eligible`);
  }
});

test('4c. a genuine athlete-UI request stays eligible, so owner evidence is unaffected', () => {
  const ev = classifyRequestSignals({
    originHeader: 'athlete_ui', productionRuntime: true, firstPartyBrowser: true
  });
  assert.equal(ev.evidence_class, EVIDENCE_CLASSES.ATHLETE_UI);
  assert.equal(ev.evidence_eligible, true);
});

// ── 5. The gate keys on the DECLARED ORIGIN, not on evidence_class ───────────
// A first attempt gated on `evidence_class === SYNTHETIC`. That class also covers
// any NON-PRODUCTION runtime, so it suppressed legitimate sandbox/test persistence
// and broke 12 route tests — it would have silently narrowed what the shadow records
// everywhere outside production. The origin token is the precise signal.

test('5a. the suppressing signal is a declared synthetic origin', () => {
  const syntheticByOrigin = (c) => SYNTHETIC_ORIGINS.has(classifyRequestSignals(c).request_origin);
  assert.equal(syntheticByOrigin({ originHeader: 'playwright', productionRuntime: true }), true,
    'the agent run is contained');
  assert.equal(syntheticByOrigin({ originHeader: 'athlete_ui', productionRuntime: true, firstPartyBrowser: true }), false,
    'genuine owner traffic is never suppressed');
  assert.equal(syntheticByOrigin({ productionRuntime: true }), false,
    'unmarked traffic still persists — losing possibly-genuine evidence is the worse failure');
});

test('5b. a NON-PRODUCTION owner request still persists (the regression the broad gate caused)', () => {
  const c = { originHeader: 'athlete_ui', productionRuntime: false, firstPartyBrowser: true };
  assert.equal(classifyRequestSignals(c).evidence_class, EVIDENCE_CLASSES.SYNTHETIC,
    'its evidence CLASS is synthetic (non-production runtime)…');
  assert.equal(SYNTHETIC_ORIGINS.has(classifyRequestSignals(c).request_origin), false,
    '…but its declared ORIGIN is not synthetic, so the shadow still records it');
});

test('5c. both call sites gate on the origin, not on evidence_class', () => {
  for (const f of ['routes/coachOps.js', 'services/coachQaShadow.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(src, /SYNTHETIC_ORIGINS\.has\(evidenceForRequest\(req\)\.request_origin\)/,
      `${f} must key containment on the declared origin`);
    assert.doesNotMatch(src, /evidence_class === EVIDENCE_CLASSES\.SYNTHETIC/,
      `${f} must not reintroduce the over-broad evidence_class gate`);
  }
});
