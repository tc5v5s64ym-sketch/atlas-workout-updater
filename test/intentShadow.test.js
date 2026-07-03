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

// --- wiring pins (widened 2026-07-03: observation moved to the ONE composer
//     chokepoint via POST /api/debug/intent-observe, so ALL typed messages are
//     seen — not just the residue that fell through to /api/coach/chat) ---

const _fs = require('node:fs');
const _path = require('node:path');
const _indexSrc = () => _fs.readFileSync(_path.join(__dirname, '..', 'index.js'), 'utf8');
const _appSrc = () => _fs.readFileSync(_path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('shadow wiring: /api/coach/chat NO LONGER observes (it only ever saw the fall-through residue)', () => {
  const src = _indexSrc();
  const routeIdx = src.indexOf("app.post('/api/coach/chat'");
  assert.ok(routeIdx > -1);
  const nextRouteIdx = src.indexOf('app.post(', routeIdx + 10);
  const block = src.slice(routeIdx, nextRouteIdx > -1 ? nextRouteIdx : routeIdx + 4000);
  assert.ok(!block.includes('observeChatMessage('),
    'the chat route must not observe — that missed every deterministically-claimed lane');
});

test('shadow wiring: POST /api/debug/intent-observe forwards the message to observeChatMessage (observe-only)', () => {
  const src = _indexSrc();
  const routeIdx = src.indexOf("app.post('/api/debug/intent-observe'");
  assert.ok(routeIdx > -1, 'the observe endpoint must exist');
  const block = src.slice(routeIdx, routeIdx + 600);
  assert.match(block, /observeChatMessage\(message\)/, 'forwards the posted message to the shadow observer');
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
  const helper = app.slice(helperStart, helperStart + 700);
  assert.match(helper, /\/api\/debug\/intent-observe/, 'posts to the observe endpoint');
  assert.match(helper, /\.catch\(/, 'errors are swallowed — observation never surfaces to the lifter');
  assert.ok(!/await\s+api\(/.test(helper), 'the observe POST is fire-and-forget (never awaited)');
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
