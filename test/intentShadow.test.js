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

// --- wiring pins (source-level: the chat route observes, never awaits) ---

test('shadow wiring: the chat route fires observeChatMessage BEFORE any reply lane, un-awaited', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const routeIdx = src.indexOf("app.post('/api/coach/chat'");
  assert.ok(routeIdx > -1);
  const block = src.slice(routeIdx, routeIdx + 2000);
  const observeIdx = block.indexOf('observeChatMessage(message);');
  assert.ok(observeIdx > -1, 'the chat route must call the shadow observer');
  assert.notEqual(block.slice(observeIdx - 60, observeIdx).includes('await'), true, 'the observer is never awaited');
  const bareIdx = block.indexOf('answerBareShorthand');
  assert.ok(observeIdx < bareIdx, 'shadow observation precedes the first reply lane');
});

test('shadow wiring: /api/debug/intent-shadow is registered read-only + auth-gated', () => {
  const { routeDefinitions } = require('../config/routes');
  const route = routeDefinitions.find(r => r.path === '/api/debug/intent-shadow');
  assert.ok(route, 'route must be declared in config/routes.js');
  assert.deepEqual(route.methods, ['GET']);
  assert.equal(route.authRequired, true);
  assert.equal(route.readOnly, true);
  assert.equal(route.writeCapable, false);
});
