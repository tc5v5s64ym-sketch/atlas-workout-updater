'use strict';

// Deterministic response-settle for the live-retest harness (settle-fix PR).
//
// The fixed 2500 ms post-preview sleep raced a still-streaming coach reply, so
// the assertion read "…Thinking…" and every authenticated production run
// collapsed to a timing INCONCLUSIVE. `waitForSettledResponse` replaces it with
// a bounded poll that settles only when the "Thinking…" marker is gone AND a
// non-empty reply has stopped growing. These tests drive it with a FAKE clock
// and a scripted thread — no browser, fully deterministic — and prove the
// assertion never returns a false PASS while the response has not settled.

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

// A deterministic driver: `frames` is the thread text returned on successive
// reads. A virtual clock advances by `pollMs` on every sleep, so timeouts are
// exact and no wall-clock time passes.
function driver(frames, { pollMs = 250 } = {}) {
  let t = 0;
  let i = 0;
  const reads = [];
  return {
    opts: {
      readThread: async () => {
        const frame = frames[Math.min(i, frames.length - 1)];
        reads.push(frame);
        i += 1;
        return frame;
      },
      sleep: async (ms) => { t += ms; },
      now: () => t,
      pollMs
    },
    reads
  };
}

const REPLY = "If a set didn't make it in, re-type it and I'll add it to the preview.";

// ── 1. A normal completed response settles quickly ──────────────────────────

test('normal completed response: settles once "Thinking…" clears and text is stable', async () => {
  // thinking → reply appears → reply stable
  const d = driver([
    `you missed a set ${THINKING_MARKER}`,
    REPLY,
    REPLY,
    REPLY
  ]);
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 20000, stableMs: 500 });
  assert.equal(r.settled, true);
  assert.equal(r.reason, 'settled');
  assert.equal(r.sawThinking, true);
  assert.ok(r.text.includes('re-type'));
  assert.ok(r.waitedMs < 20000, 'settled well within the bound');
});

// ── 2. A slow completed response still settles (within the bound) ───────────

test('slow completed response: many Thinking frames then a stable reply → settled', async () => {
  const frames = [];
  for (let k = 0; k < 30; k += 1) frames.push(`typing ${THINKING_MARKER}`); // ~7.5s of thinking
  // reply then streams in, growing, then stabilises
  frames.push('If a set');
  frames.push('If a set didn\'t make it in, re-type');
  frames.push(REPLY, REPLY, REPLY);
  const d = driver(frames);
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 20000, stableMs: 500 });
  assert.equal(r.settled, true, 'a slow-but-completing reply settles');
  assert.ok(r.text.includes('preview'));
});

// ── 3. A response that never settles hits the bound, never waits forever ─────

test('never settles (stuck Thinking): returns timeout_still_thinking, bounded', async () => {
  const d = driver([`${THINKING_MARKER}`]); // every read is "Thinking…"
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 5000, stableMs: 500 });
  assert.equal(r.settled, false);
  assert.equal(r.reason, 'timeout_still_thinking');
  assert.equal(r.sawThinking, true);
  assert.equal(r.waitedMs, 5000, 'stops exactly at the bound — never indefinite');
});

test('never settles (empty thread): returns timeout_no_response, bounded', async () => {
  const d = driver(['']);
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 3000, stableMs: 500 });
  assert.equal(r.settled, false);
  assert.equal(r.reason, 'timeout_no_response');
  assert.equal(r.waitedMs, 3000);
});

test('never settles (reply keeps growing): returns timeout_unstable, bounded', async () => {
  // A reply that grows on every single poll never stabilises.
  const frames = [];
  for (let k = 1; k < 100; k += 1) frames.push('x'.repeat(k));
  const d = driver(frames);
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 4000, stableMs: 750 });
  assert.equal(r.settled, false);
  assert.equal(r.reason, 'timeout_unstable');
  assert.equal(r.waitedMs, 4000);
});

// ── 4. An error response (deterministic engine fallback) is a completed reply ─

test('error/fallback response settles: a fallback reply is a real completed response', async () => {
  const fallback = 'Re-type the set and I will add it to the preview.';
  const d = driver([`${THINKING_MARKER}`, fallback, fallback, fallback]);
  const r = await waitForSettledResponse({ ...d.opts, timeoutMs: 20000, stableMs: 500 });
  assert.equal(r.settled, true, 'the fallback reply settles like any completed reply');
  assert.ok(r.text.includes('Re-type'));
});

// ── 5. The assertion never returns a false PASS while "Thinking…" remains ────

const TMP = path.join(os.tmpdir(), 'atlas-live-retest-settle');
fs.mkdirSync(TMP, { recursive: true });
const SCN = SCENARIOS['bug-20260629-153258'];

test('assert: an unsettled response is INCONCLUSIVE with the settle reason, never PASS', () => {
  // The thread contains the exact PASS-matching text BUT the response never
  // settled — a naive matcher would PASS; the settle gate must not.
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
  assert.equal(result, 'PASS', 'a settled, matching reply is a real PASS — not timing INCONCLUSIVE');
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
  assert.equal(result, 'PASS', 'absent settle is treated as settled for existing callers');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
