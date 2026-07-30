'use strict';

// Deterministic response-settle for the live-retest harness (settle-fix PR #1205).
//
// The fixed 2500 ms post-preview sleep raced a still-streaming coach reply, so
// the assertion read "…Thinking…" and every authenticated production run
// collapsed to a timing INCONCLUSIVE. `waitForSettledResponse` replaces it with
// a bounded poll that settles only when a NEW atlas reply bubble exists, no
// longer shows the "Thinking…" marker, and has stopped growing. These tests
// drive it with a FAKE clock and scripted bubble states — no browser, fully
// deterministic — and prove no false PASS while the response has not settled,
// including the Codex-P2 race where the thread is stable on the lifter's own
// bubble before any atlas reply arrives.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  waitForSettledResponse,
  THINKING_MARKER,
  assertScenario,
  SCENARIOS
} = require('../scripts/live-retest');

// A deterministic driver: `frames` is the reply-bubble state ({present,thinking,text})
// returned on successive reads. A virtual clock advances by `pollMs` per sleep,
// so timeouts are exact and no wall-clock time passes.
function driver(frames, { pollMs = 250 } = {}) {
  let t = 0;
  let i = 0;
  return {
    opts: {
      readReply: async () => {
        const f = frames[Math.min(i, frames.length - 1)];
        i += 1;
        return f;
      },
      sleep: async (ms) => { t += ms; },
      now: () => t,
      pollMs
    }
  };
}

const REPLY = "If a set didn't make it in, re-type it and I'll add it to the preview.";
const thinking = () => ({ present: true, thinking: true, text: THINKING_MARKER });
const reply = (text) => ({ present: true, thinking: false, text });
const noBubble = () => ({ present: false, thinking: false, text: '' }); // only the user bubble exists

// ── 1. A normal completed response settles quickly ──────────────────────────

test('normal completed response: settles once the atlas bubble stops showing Thinking and is stable', async () => {
  const d = driver([thinking(), reply(REPLY), reply(REPLY), reply(REPLY)]);
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 20000, stableMs: 500 });
  assert.equal(r.settled, true);
  assert.equal(r.reason, 'settled');
  assert.equal(r.sawThinking, true);
  assert.ok(r.text.includes('re-type'));
  assert.ok(r.waitedMs < 20000);
});

// ── 2. A slow completed response still settles (within the bound) ───────────

test('slow completed response: many Thinking frames then a stable reply → settled', async () => {
  const frames = [];
  for (let k = 0; k < 30; k += 1) frames.push(thinking());     // ~7.5s of thinking
  frames.push(reply('If a set'));                               // streams in, growing
  frames.push(reply("If a set didn't make it in, re-type"));
  frames.push(reply(REPLY), reply(REPLY), reply(REPLY));        // stabilises
  const d = driver(frames);
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 20000, stableMs: 500 });
  assert.equal(r.settled, true);
  assert.ok(r.text.includes('preview'));
});

// ── 3. Responses that never settle hit the bound, never wait forever ─────────

test('never settles (stuck Thinking): timeout_still_thinking, bounded', async () => {
  const d = driver([thinking()]);
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 5000, stableMs: 500 });
  assert.equal(r.settled, false);
  assert.equal(r.reason, 'timeout_still_thinking');
  assert.equal(r.waitedMs, 5000, 'stops exactly at the bound — never indefinite');
});

test('never settles (no atlas bubble ever — only the user bubble): timeout_no_response', async () => {
  // THE CODEX-P2 RACE: the thread is stable, but it is stable on the lifter's own
  // bubble; no atlas reply bubble ever appears. Must NOT settle.
  const d = driver([noBubble()]);
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 5000, stableMs: 500 });
  assert.equal(r.settled, false);
  assert.equal(r.reason, 'timeout_no_response');
  assert.equal(r.sawThinking, false);
});

test('never settles (reply keeps growing): timeout_unstable, bounded', async () => {
  const frames = [];
  for (let k = 1; k < 100; k += 1) frames.push(reply('x'.repeat(k)));
  const d = driver(frames);
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 4000, stableMs: 750 });
  assert.equal(r.settled, false);
  assert.equal(r.reason, 'timeout_unstable');
  assert.equal(r.waitedMs, 4000);
});

// ── The Codex-P2 race, precisely: a stable user bubble must not settle, then the
//    real reply arrives late and DOES settle ──────────────────────────────────

test('a long pre-reply gap on the user bubble does NOT settle; the late reply settles', async () => {
  const frames = [];
  for (let k = 0; k < 20; k += 1) frames.push(noBubble());  // 5s: only the user bubble, stable
  frames.push(thinking());                                  // coach finally starts
  frames.push(reply(REPLY), reply(REPLY), reply(REPLY));     // real reply settles
  const d = driver(frames);
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 20000, stableMs: 500 });
  assert.equal(r.settled, true, 'settles on the real reply, not the stable user bubble');
  assert.ok(r.waitedMs >= 5000, 'it waited through the stable user-bubble gap instead of settling early');
  assert.ok(r.text.includes('preview'));
});

// ── 4. An error/fallback response is a completed reply ──────────────────────

test('error/fallback response settles: a fallback reply is a real completed response', async () => {
  const fallback = 'Re-type the set and I will add it to the preview.';
  const d = driver([thinking(), reply(fallback), reply(fallback), reply(fallback)]);
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 20000, stableMs: 500 });
  assert.equal(r.settled, true);
  assert.ok(r.text.includes('Re-type'));
});

// ── 5. The assertion never returns a false PASS while unsettled ─────────────

const TMP = path.join(os.tmpdir(), 'atlas-live-retest-settle');
fs.mkdirSync(TMP, { recursive: true });
const SCN = SCENARIOS['bug-20260629-153258'];

test('assert: an unsettled response is INCONCLUSIVE with the settle reason, never PASS', () => {
  const result = assertScenario({
    scenarioKey: 's1', scenario: SCN,
    navResult: {
      navigated: true,
      threadText: `${THINKING_MARKER} If a set didn't make it in, re-type it and I'll add it to the preview.`,
      settle: { settled: false, reason: 'timeout_still_thinking' }
    },
    outputDir: TMP
  });
  assert.equal(result, 'INCONCLUSIVE', 'no false PASS while unsettled');
  const json = JSON.parse(fs.readFileSync(path.join(TMP, 's1-result.json'), 'utf8'));
  assert.equal(json.settleReason, 'timeout_still_thinking');
});

test('assert: a SETTLED matching response is a genuine PASS', () => {
  const result = assertScenario({
    scenarioKey: 's2', scenario: SCN,
    navResult: {
      navigated: true,
      threadText: "If a set didn't make it in, re-type it and I'll add it to the preview.",
      settle: { settled: true, reason: 'settled' }
    },
    outputDir: TMP
  });
  assert.equal(result, 'PASS');
});

test('assert: a forbidden/bug pattern is FAIL even if the response did not settle', () => {
  const result = assertScenario({
    scenarioKey: 's3', scenario: SCN,
    navResult: {
      navigated: true,
      threadText: `${THINKING_MARKER} Sorry, the coach is unavailable right now.`,
      settle: { settled: false, reason: 'timeout_still_thinking' }
    },
    outputDir: TMP
  });
  assert.equal(result, 'FAIL', 'a bug pattern that already appeared is a real FAIL regardless of settle');
});

test('assert: back-compat — a navResult with no settle field behaves as before (settled)', () => {
  const result = assertScenario({
    scenarioKey: 's4', scenario: SCN,
    navResult: { navigated: true, threadText: "re-type it and I'll add it to the preview" },
    outputDir: TMP
  });
  assert.equal(result, 'PASS');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
