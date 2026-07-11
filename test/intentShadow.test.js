'use strict';

// Phase C2 — services/intentShadow.js (the default-OFF shadow lane). The
// contract under test: inert when the flag is off, fire-and-forget when on,
// capped ring, and a failure inside the classifier can never escape.

const test = require('node:test');
const assert = require('node:assert/strict');

const shadow = require('../services/intentShadow');

function envelope(type, constraints = {}, extraction = { confidence: 0.9 }) {
  return { schema_version: 1, type, constraints, source: 'chat', asOf: '2026-07-03T06:00:00Z', actor: 'user', raw_input: 'x', extraction };
}

async function withFlag(value, fn) {
  const orig = process.env.ATLAS_INTENT_ROUTER;
  if (value == null) delete process.env.ATLAS_INTENT_ROUTER;
  else process.env.ATLAS_INTENT_ROUTER = value;
  const origLog = console.log;
  console.log = () => {};
  try { return await fn(); }
  finally {
    console.log = origLog;
    if (orig == null) delete process.env.ATLAS_INTENT_ROUTER; else process.env.ATLAS_INTENT_ROUTER = orig;
    shadow._resetForTesting();
  }
}

const tick = () => new Promise(r => setImmediate(r));

test('shadow: default OFF — no classify call, empty log, enabled:false', async () => {
  await withFlag(null, async () => {
    let called = 0;
    shadow._resetForTesting({ classify: async () => { called++; return envelope('best_workout'); } });
    shadow.observeChatMessage('what should I train');
    await tick();
    assert.equal(called, 0, 'the classifier must never run with the flag off');
    const log = shadow.getShadowLog();
    assert.equal(log.enabled, false);
    assert.equal(log.count, 0);
  });
});

test('shadow: flag on — records a successful classification (newest first)', async () => {
  await withFlag('shadow', async () => {
    shadow._resetForTesting({
      classify: async (text) => envelope('generate_workout', { focus: 'push' }, { confidence: 0.9, dropped_keys: ['vibe'] })
    });
    shadow.observeChatMessage('push day please');
    shadow.observeChatMessage('second message');
    await tick();
    const log = shadow.getShadowLog();
    assert.equal(log.enabled, true);
    assert.equal(log.count, 2);
    const entry = log.entries[0];   // newest first
    assert.equal(entry.ok, true);
    assert.equal(entry.type, 'generate_workout');
    assert.equal(entry.confidence, 0.9);
    assert.deepEqual(entry.constraint_keys, ['focus']);
    assert.deepEqual(entry.dropped_keys, ['vibe']);
    assert.equal(entry.message_preview, 'second message');
    assert.ok(typeof entry.ms === 'number' && entry.ms >= 0);
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('shadow: a null classification records ok:false (never throws, never blocks)', async () => {
  await withFlag('shadow', async () => {
    shadow._resetForTesting({ classify: async () => null });
    shadow.observeChatMessage('anything');
    await tick();
    const entry = shadow.getShadowLog().entries[0];
    assert.equal(entry.ok, false);
    assert.equal(entry.type, undefined);
  });
});

test('shadow: an unexpected classifier THROW is swallowed to an ok:false entry', async () => {
  await withFlag('shadow', async () => {
    shadow._resetForTesting({ classify: async () => { throw new Error('should never escape'); } });
    assert.doesNotThrow(() => shadow.observeChatMessage('anything'));
    await tick();
    const entry = shadow.getShadowLog().entries[0];
    assert.equal(entry.ok, false);
  });
});

test('shadow: the ring is capped at RING_MAX, keeping the newest', async () => {
  await withFlag('shadow', async () => {
    shadow._resetForTesting({ classify: async (text) => envelope('best_workout') });
    for (let i = 0; i < shadow.RING_MAX + 10; i++) shadow.observeChatMessage(`msg ${i}`);
    await tick();
    const log = shadow.getShadowLog();
    assert.equal(log.count, shadow.RING_MAX);
    assert.equal(log.entries[0].message_preview, `msg ${shadow.RING_MAX + 9}`, 'newest survives');
  });
});

test('shadow: blank input is ignored even with the flag on', async () => {
  await withFlag('shadow', async () => {
    let called = 0;
    shadow._resetForTesting({ classify: async () => { called++; return null; } });
    shadow.observeChatMessage('   ');
    shadow.observeChatMessage(null);
    await tick();
    assert.equal(called, 0);
    assert.equal(shadow.getShadowLog().count, 0);
  });
});

test('shadow: long messages are preview-capped in the log', async () => {
  await withFlag('shadow', async () => {
    shadow._resetForTesting({ classify: async () => envelope('clarify_intent') });
    shadow.observeChatMessage('x'.repeat(500));
    await tick();
    assert.equal(shadow.getShadowLog().entries[0].message_preview.length, 80);
  });
});

// --- Intent_Shadow Sheet persistence (owner direction 2026-07-03: "review the
//     shadow" without debug JSON — a durable diagnostics tab, best-effort) ---

test('persist: a SUCCESSFUL classification appends one 16-column row; the original 13 columns keep their order', async () => {
  await withFlag('shadow', async () => {
    const appended = [];
    shadow._resetForTesting({
      classify: async () => envelope('generate_workout', { focus: 'push' }, { confidence: 0.9, dropped_keys: ['vibe'] }),
      append: async (tab, rows) => { appended.push({ tab, rows }); },
    });
    shadow.observeChatMessage('push day please', { route: 'composer', source: 'chat', appVersion: 'v105' });
    await tick(); await tick();
    assert.equal(appended.length, 1, 'exactly one append attempted');
    assert.equal(appended[0].tab, shadow.SHADOW_TAB, 'appends to the Intent_Shadow tab (never Log_Cleaned/Effort)');
    const row = appended[0].rows[0];
    assert.equal(row.length, 16, 'row grew 13 → 16 (PR-GATEA1 appended three provenance columns)');
    // The original 13 columns are unchanged, in place:
    assert.equal(row[1], 'push day please', 'message_preview');
    assert.equal(row[2], 'generate_workout', 'intent_type');
    assert.equal(row[3], 0.9, 'confidence');
    assert.equal(row[4], JSON.stringify(['focus']), 'constraint_keys_json');
    assert.equal(row[5], JSON.stringify(['vibe']), 'dropped_keys_json');
    assert.equal(row[6], 'TRUE', 'ok');
    assert.equal(typeof row[7], 'number', 'latency_ms');
    assert.equal(row[8], 'chat', 'source');
    assert.equal(row[9], 'composer', 'route');
    assert.equal(row[10], 'v105', 'app_version stamped from the client');
    assert.equal(row[11], '', 'review_status blank (owner fills on review)');
    assert.equal(row[12], '', 'review_notes blank');
    // PR-GATEA1 provenance appended at the end; no evidence supplied here → fail closed.
    assert.equal(row[13], 'unknown', 'evidence_class defaults to unknown when the route supplied no verdict');
    assert.equal(row[14], 'FALSE', 'evidence_eligible');
    assert.equal(row[15], '', 'request_origin');
  });
});

test('persist: an ok:false classification/failure is ALSO captured as a row (ok=FALSE)', async () => {
  await withFlag('shadow', async () => {
    const appended = [];
    shadow._resetForTesting({
      classify: async () => null,                       // classification failed / unclassifiable
      append: async (tab, rows) => { appended.push({ tab, rows }); },
    });
    shadow.observeChatMessage('It\'s face pulls next not back squats', { route: 'composer', appVersion: 'v105' });
    await tick(); await tick();
    assert.equal(appended.length, 1, 'a failure still persists a row');
    const row = appended[0].rows[0];
    assert.equal(row[6], 'FALSE', 'ok column reflects the failed classification');
    assert.equal(row[2], '', 'intent_type blank on failure');
  });
});

test('persist: a Sheets append FAILURE is swallowed — the caller is never affected', async () => {
  await withFlag('shadow', async () => {
    shadow._resetForTesting({
      classify: async () => envelope('best_workout'),
      append: async () => { throw new Error('no Intent_Shadow tab / no creds / transient'); },
    });
    assert.doesNotThrow(() => shadow.observeChatMessage('what should I train', { route: 'composer' }));
    await tick(); await tick();
    // The ring still recorded the entry — persistence is a best-effort mirror, not
    // a precondition; a Sheets failure must not lose the diagnostic or block anyone.
    const log = shadow.getShadowLog();
    assert.equal(log.count, 1);
    assert.equal(log.entries[0].ok, true);
  });
});

test('persist: NOTHING is appended when the shadow flag is off (no classify, no Sheet write)', async () => {
  await withFlag(null, async () => {
    let appendCalls = 0;
    shadow._resetForTesting({
      classify: async () => envelope('best_workout'),
      append: async () => { appendCalls++; },
    });
    shadow.observeChatMessage('push day', { route: 'composer' });
    await tick(); await tick();
    assert.equal(appendCalls, 0, 'flag off → no persistence attempt');
  });
});

test('persist (source): the shadow module touches ONLY the Intent_Shadow tab — no write/trust path', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'intentShadow.js'), 'utf8');
  assert.match(src, /Intent_Shadow/, 'persists to the diagnostics tab');
  // Never the trust-contract tabs / write path / proof fields.
  for (const forbidden of ['Log_Cleaned', 'Effort', '/api/log-workout', 'sheet_write', 'no_write_confirmed', 'write_id']) {
    assert.ok(!src.includes(forbidden), `must not reference ${forbidden}`);
  }
});

// --- wiring pins (widened 2026-07-03: observation moved to the ONE composer
//     chokepoint via POST /api/debug/intent-observe, so ALL typed messages are
//     seen — not just the residue that fell through to /api/coach/chat) ---

const _fs = require('node:fs');
const _path = require('node:path');
const _indexSrc = () => _fs.readFileSync(_path.join(__dirname, '..', 'index.js'), 'utf8');
// PR-17: the coach/chat + debug/intent-observe routes moved to routes/coachOps.js.
const _coachOpsSrc = () => _fs.readFileSync(_path.join(__dirname, '..', 'routes', 'coachOps.js'), 'utf8');
const _appSrc = () => _fs.readFileSync(_path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('shadow wiring: /api/coach/chat NO LONGER observes (it only ever saw the fall-through residue)', () => {
  const src = _coachOpsSrc();
  const routeIdx = src.indexOf("router.post('/api/coach/chat'");
  assert.ok(routeIdx > -1);
  const nextRouteIdx = src.indexOf('router.post(', routeIdx + 10);
  const block = src.slice(routeIdx, nextRouteIdx > -1 ? nextRouteIdx : routeIdx + 4000);
  assert.ok(!block.includes('observeChatMessage('),
    'the chat route must not observe — that missed every deterministically-claimed lane');
});

test('shadow wiring: POST /api/debug/intent-observe forwards the message to observeChatMessage (observe-only)', () => {
  const src = _coachOpsSrc();
  const routeIdx = src.indexOf("router.post('/api/debug/intent-observe'");
  assert.ok(routeIdx > -1, 'the observe endpoint must exist');
  // Scope the block to exactly this handler (up to the next route) so it stays
  // robust as additive fields — e.g. PR-GATEA1 provenance — grow the handler body.
  const nextRouteIdx = src.indexOf('router.', routeIdx + 20);
  const block = src.slice(routeIdx, nextRouteIdx > -1 ? nextRouteIdx : routeIdx + 900);
  assert.match(block, /observeChatMessage\(message,/, 'forwards the posted message (+ diagnostics meta) to the shadow observer');
  // Observe-only: it must never await the classification, touch Sheets, or reply
  // with anything but an ack.
  assert.ok(!/await/.test(block.slice(0, block.indexOf('observeChatMessage'))),
    'the observer is never awaited');
  assert.ok(!/getSheetRows|log-workout|sheet_write/.test(block), 'no Sheets / write path in the observe route');
});

test('shadow wiring: the composer submit chokepoint fires observeComposerText BEFORE any lane, un-awaited', () => {
  const app = _appSrc();
  // The helper posts fire-and-forget to the observe endpoint and swallows errors.
  const helperStart = app.indexOf('function observeComposerText(');
  assert.ok(helperStart > -1, 'observeComposerText helper must exist');
  // Scope to the helper's own body (up to the submit handler that follows) so this
  // stays robust as additive fields grow the fetch body.
  const helperEnd = app.indexOf("document.getElementById('logger-form')", helperStart);
  const helper = app.slice(helperStart, helperEnd > -1 ? helperEnd : helperStart + 1700);
  assert.match(helper, /\/api\/debug\/intent-observe/, 'posts to the observe endpoint');
  assert.match(helper, /\.catch\(/, 'errors are swallowed — observation never surfaces to the lifter');
  assert.ok(!/await\s+api\(/.test(helper), 'the observe POST is fire-and-forget (never awaited)');
  // A BARE fetch, not api() (review #838): api() records failures into the request
  // history that bug reports capture, so a dropped observation would leave a trace.
  assert.match(helper, /fetch\('\/api\/debug\/intent-observe'/, 'uses a bare fetch (not api()) so a dropped observation leaves no error-history trace');
  assert.match(helper, /'x-atlas-api-key': getApiKey\(\)/, 'the bare fetch still carries auth');
  // The call sits at the TOP of the submit handler, before the first lane branch
  // (parseBugCommand / looksLikeSessionRequest), so every submission is observed.
  const submitIdx = app.indexOf("document.getElementById('logger-form').addEventListener('submit'");
  const observeCall = app.indexOf('observeComposerText(submittedText);', submitIdx);
  const firstLane = app.indexOf('parseBugCommand(submittedText)', submitIdx);
  assert.ok(observeCall > submitIdx, 'the chokepoint call is inside the submit handler');
  assert.ok(observeCall < firstLane, 'observation precedes the first deterministic lane (all submissions seen)');
});

test('shadow wiring: /api/debug/intent-shadow (read) + /api/debug/intent-observe (write-of-observation) are auth-gated, non-write', () => {
  const { routeDefinitions } = require('../config/routes');
  const read = routeDefinitions.find(r => r.path === '/api/debug/intent-shadow');
  assert.ok(read, 'shadow read route must be declared in config/routes.js');
  assert.deepEqual(read.methods, ['GET']);
  assert.equal(read.authRequired, true);
  assert.equal(read.readOnly, true);
  assert.equal(read.writeCapable, false);

  const observe = routeDefinitions.find(r => r.path === '/api/debug/intent-observe');
  assert.ok(observe, 'observe route must be declared in config/routes.js');
  assert.deepEqual(observe.methods, ['POST']);
  assert.equal(observe.authRequired, true);
  assert.equal(observe.writeCapable, false, 'observe-only — never a Sheets write');
});
