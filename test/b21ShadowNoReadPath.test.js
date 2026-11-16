'use strict';

// Drift Guard — B-21 shadow no-read-path guard (Fable P3, issue #1742).
// Proves no write path or answer path reads Coach_Response / Intent_Shadow as
// a source of facts. The guard itself lives in scripts/check-shadow-no-read.js;
// these tests pin its rules with fixtures (a planted read must fail) and run it
// against the real repository (it must pass). The runtime half of the probe —
// poisoned shadow rows that must never surface in a response or a sheet write —
// lives in test/api-smoke.test.js ("#1742 B-21 shadow no-read-path probe").

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { analyze, stripComments } = require('../scripts/check-shadow-no-read');

const F = (rel, content) => [{ path: rel, content }];

describe('Drift Guard — B-21 shadow no-read-path', () => {
  it('passes on the real repository (no runtime path reads a shadow tab)', () => {
    const r = analyze();
    assert.equal(r.valid, true, JSON.stringify(r.violations));
  });

  it('pins the ring consumer: exactly one getShadowLog() call site, in the debug endpoint', () => {
    const lines = stripComments(fs.readFileSync(path.join(__dirname, '..', 'routes', 'coachOps.js'), 'utf8'));
    const uses = lines.filter((l) => /\bgetShadowLog\s*\(/.test(l));
    assert.equal(uses.length, 1, `expected exactly one ring consumer, found ${uses.length}`);
    const idx = lines.findIndex((l) => /\bgetShadowLog\s*\(/.test(l));
    const nearDebugRoute = lines.slice(Math.max(0, idx - 5), idx + 1).some((l) => l.includes('/api/debug/intent-shadow'));
    assert.equal(nearDebugRoute, true, 'the one ring consumer must sit in GET /api/debug/intent-shadow');
  });

  it('R1 fails a getSheetRows read of Intent_Shadow', () => {
    const r = analyze(F('services/historyAnswer.js',
      "async function answer() {\n  const rows = await getSheetRows('Intent_Shadow');\n  return rows;\n}"));
    assert.equal(r.valid, false);
    assert.equal(r.violations[0].rule, 'shadow-tab-read');
    assert.equal(r.violations[0].file, 'services/historyAnswer.js');
  });

  it('R1 fails an A1-range read of Coach_Response', () => {
    const r = analyze(F('routes/coachOps.js',
      "const values = await readValues('Coach_Response!A1:Z100');"));
    assert.equal(r.valid, false);
    assert.equal(r.violations[0].rule, 'shadow-tab-read');
  });

  it('R1 fails a read through the RESPONSE_TAB constant', () => {
    const r = analyze(F('services/historyAnswer.js',
      "const rows = await getRecentRows(RESPONSE_TAB, 50);"));
    assert.equal(r.valid, false);
    assert.equal(r.violations.some((v) => v.rule === 'shadow-tab-read'), true);
  });

  it('R1 allows the header-validation read inside the write module', () => {
    const r = analyze(F('services/coachResponseSheet.js',
      "const RESPONSE_TAB = 'Coach_Response';\n"
      + "async function ensureReady(ensure, getHeader) {\n  await ensure(RESPONSE_TAB, RESPONSE_HEADERS);\n  const h = await getHeader(RESPONSE_TAB);\n  return h;\n}"));
    assert.equal(r.valid, true, JSON.stringify(r.violations));
  });

  it('R1 allows appends to a shadow tab (writes are the designed behavior)', () => {
    const r = analyze(F('services/coachResponseSheet.js',
      "const RESPONSE_TAB = 'Coach_Response';\n"
      + "async function persist(append) {\n  await append(RESPONSE_TAB, [row]);\n}"));
    assert.equal(r.valid, true, JSON.stringify(r.violations));
  });

  it('R1 never flags prose that merely names a tab', () => {
    const r = analyze(F('services/gateAScorecard.js',
      "intent_routing: { classification: 'SEPARATE', note: 'Intent routing is a separate promotion evaluated from Intent_Shadow, not from Brain_Shadow.' },"));
    assert.equal(r.valid, true, JSON.stringify(r.violations));
  });

  it('R1 never flags a comment that documents a tab', () => {
    const r = analyze(F('services/historyAnswer.js',
      "function answer() {\n  // Coach_Response stores the visible reply; never read it here.\n  return grounded();\n}"));
    assert.equal(r.valid, true, JSON.stringify(r.violations));
  });

  it('R2 fails a shadow-tab constant used without a local definition', () => {
    const r = analyze(F('services/historyAnswer.js',
      "const { RESPONSE_TAB } = require('./coachResponseSheet');\nconst rows = [];\n"));
    assert.equal(r.valid, false);
    assert.equal(r.violations.some((v) => v.rule === 'shadow-tab-constant-leak'), true);
  });

  it('R2 allows a module-local SHADOW_TAB definition (each shadow module owns its own)', () => {
    const r = analyze(F('services/brainShadow.js',
      "const SHADOW_TAB = 'Brain_Shadow';\nasync function persist(append) {\n  await append(SHADOW_TAB, [row]);\n}"));
    assert.equal(r.valid, true, JSON.stringify(r.violations));
  });

  it('R3 fails a second consumer requiring services/intentShadow', () => {
    const r = analyze(F('services/historyAnswer.js',
      "const { getShadowLog } = require('./intentShadow');\nfunction answer() { return getShadowLog(); }"));
    assert.equal(r.valid, false);
    assert.equal(r.violations.some((v) => v.rule === 'intent-ring-consumer'), true);
  });

  it('R3 allows the debug endpoint serving the ring in routes/coachOps.js', () => {
    const r = analyze(F('routes/coachOps.js',
      "const { getShadowLog, observeChatMessage } = require('../services/intentShadow');\n"
      + "  router.get('/api/debug/intent-shadow', (req, res) => {\n"
      + "    return standardSuccess(req, res, 'Intent-router shadow log', getShadowLog());\n"
      + "  });"));
    assert.equal(r.valid, true, JSON.stringify(r.violations));
  });

  it('R3 fails a getShadowLog use in coachOps.js away from the debug endpoint', () => {
    const r = analyze(F('routes/coachOps.js',
      "const { getShadowLog } = require('../services/intentShadow');\n"
      + "  router.get('/api/debug/intent-shadow', (req, res) => {\n"
      + "    return standardSuccess(req, res, 'ok', {});\n"
      + "  });\n"
      + "  async function answer() {\n"
      + "    const log = getShadowLog();\n"
      + "    return log.entries[0];\n"
      + "  }"));
    assert.equal(r.valid, false);
    assert.equal(r.violations.some((v) => v.rule === 'intent-ring-consumer'), true);
  });
});
