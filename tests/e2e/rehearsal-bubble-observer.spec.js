'use strict';

// ── INTEGRATION bite: the collector produces truthful timestamps in the sweep gap ──
// TEMPORARY F-SB4B machinery (sunset: F-SB4C).
//
// The unit bites prove the claim DECISIONS. They cannot prove the live COLLECTOR can
// produce an honest timestamp when no sweep runs while the text changes — the exact gap
// the exact-head review of ad01d9c identified (owner P1, 2026-08-03):
//
//   1. `say(page, 'done')` clicks and sweeps once, immediately;
//   2. the closeout bubble does not exist yet, or still reads `Thinking…`;
//   3. the runner waits for the closeout card, saves, waits for the live write, and
//      performs the durable reads;
//   4. the next guaranteed sweep is section 13a — AFTER the write.
//
// A claim rendered in step 2–3 used to receive a step-4 timestamp and be judged earned.
//
// This runs in a REAL browser against the credential-free static lane: no gate server,
// no credentials, no workbook, no write. It drives the same init script and the same
// reducers the rehearsal runner uses, and it performs NO manual sweep until after the
// synthetic live-write instant — reproducing the gap rather than describing it.

const { test, expect } = require('@playwright/test');
const {
  OBSERVER_FLUSH_MS, bubbleObserverInitScript,
  ingestLiveObservation, reconcileSweep, recordsToMessages, makeBoundary,
} = require('./gate/rehearsal-bubble-observer');
const { detectUnsupportedWriteClaim, detectUnsupportedMutationWording } = require('./gate/rehearsal-scorecard');

const THINKING = 'Thinking…';

// Install the real observer over a minimal thread, and collect reports exactly as the
// runner does — Node stamps each report on receipt.
async function startCollector(page, phaseRef) {
  const records = {};
  const state = { ingestSeq: 0, gate: null };
  await page.exposeFunction('__atlasBubbleObserved', async (batch) => {
    // `gate` lets a test HOLD a report in flight, which is how the flush-window race is
    // reproduced: the boundary is taken while this report has not yet reached Node.
    if (state.gate) await state.gate;
    const now = Date.now();
    for (const item of (Array.isArray(batch) ? batch : [])) {
      state.ingestSeq += 1;
      ingestLiveObservation(records, item, {
        phase: phaseRef.value, nowMs: now, ingestSeq: state.ingestSeq, thinkingMarker: THINKING,
      });
    }
  });
  await page.addInitScript(bubbleObserverInitScript, {
    flushMs: OBSERVER_FLUSH_MS,
    threadId: 'thread-messages',
    bubbleSelector: '.chat-bubble-atlas',
    callbackName: '__atlasBubbleObserved',
    flushName: '__atlasBubbleFlush',
    stateName: '__atlasBubbleState',
  });
  // A bare page carrying only the thread container the observer watches.
  //
  // NAVIGATE, do not `setContent`. An init script runs when a document is CREATED, and
  // `setContent` rewrites the document the page already had — so the observer would
  // never install and every assertion below would pass vacuously against an empty
  // record set. This bit during construction; the navigation is load-bearing.
  await page.goto('data:text/html,<!doctype html><html><body><div id="thread-messages"></div></body></html>');
  return { records, state };
}

// The runner's own barrier: drain, then stamp.
async function takeBoundary(page, state) {
  let drained = false;
  try {
    await page.evaluate(() => (typeof window.__atlasBubbleFlush === 'function' ? window.__atlasBubbleFlush() : null));
    drained = true;
  } catch { drained = false; }
  return makeBoundary({ atMs: Date.now(), ingestSeq: state.ingestSeq, drained });
}

const appendBubble = (page, text) => page.evaluate((t) => {
  const b = document.createElement('div');
  b.className = 'chat-bubble chat-bubble-atlas';
  const body = document.createElement('div');
  body.textContent = t;
  b.appendChild(body);
  document.getElementById('thread-messages').appendChild(b);
}, text);

const rewriteBubble = (page, index, text) => page.evaluate(({ i, t }) => {
  document.querySelectorAll('#thread-messages .chat-bubble-atlas')[i].firstChild.textContent = t;
}, { i: index, t: text });

const settle = (page) => page.waitForTimeout(OBSERVER_FLUSH_MS * 4);

test.describe('F-SB4B bubble collector — truthful timing without a sweep', () => {
  test('BITE: a write claim rendered before the live write FAILS, though no sweep ran until after it', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records, state } = await startCollector(page, phaseRef);

    // Step 1–2: the turn is submitted; the immediate sweep sees a placeholder only.
    await appendBubble(page, THINKING);
    await settle(page);
    reconcileSweep(records, [THINKING], { phase: phaseRef.value, nowMs: Date.now(), thinkingMarker: THINKING });
    expect(recordsToMessages(records)[0].placeholder, 'the immediate sweep sees no final claim').toBe(true);

    // Step 3: the bubble becomes an unsupported save claim. NO sweep runs here.
    await rewriteBubble(page, 0, 'All set — your workout is saved to your sheet.');
    await settle(page);

    // The synthetic live write happens AFTER the claim became visible.
    const liveWriteAtMs = Date.now();

    // Step 4: the first sweep since step 1, well after the write.
    await page.waitForTimeout(150);
    const texts = await page.locator('#thread-messages .chat-bubble-atlas')
      .allInnerTexts().catch(() => []);
    reconcileSweep(records, texts, { phase: 'teardown', nowMs: Date.now(), thinkingMarker: THINKING });

    const messages = recordsToMessages(records);
    expect(messages, 'one bubble, one record').toHaveLength(1);
    expect(messages[0].text).toMatch(/saved to your sheet/);
    expect(messages[0].retroactive, 'the observer saw it live, so the record is not retroactive').toBe(false);
    expect(messages[0].atMs, 'the timestamp must predate the live write, not the later sweep')
      .toBeLessThan(liveWriteAtMs);

    const sweep = detectUnsupportedWriteClaim({
      messages, liveWriteBoundary: makeBoundary({ atMs: liveWriteAtMs, ingestSeq: state.ingestSeq, drained: true }),
    });
    expect(sweep.unsupported, `the claim was visible before the write and must fail: ${sweep.detail}`).toBe(true);
  });

  test('BITE: the analogous pre-mutation claim fails on the same collector and clock', async ({ page }) => {
    const phaseRef = { value: 'substitution_ask' };
    const { records, state } = await startCollector(page, phaseRef);

    await appendBubble(page, THINKING);
    await settle(page);
    await rewriteBubble(page, 0, "Done — I've noted the substitution.");
    await settle(page);

    const mutationAtMs = Date.now();          // the mutation happens AFTER the claim
    await page.waitForTimeout(150);
    const texts = await page.locator('#thread-messages .chat-bubble-atlas').allInnerTexts().catch(() => []);
    reconcileSweep(records, texts, { phase: 'replacement', nowMs: Date.now(), thinkingMarker: THINKING });

    const messages = recordsToMessages(records);
    expect(messages[0].atMs).toBeLessThan(mutationAtMs);
    expect(messages[0].phase, 'the phase stays bound to the turn that created the bubble').toBe('substitution_ask');
    const sweep = detectUnsupportedMutationWording({
      messages, mutationBoundary: makeBoundary({ atMs: mutationAtMs, ingestSeq: state.ingestSeq, drained: true }),
    });
    expect(sweep.unsupported, sweep.detail).toBe(true);
  });

  test('a claim that only ever appears to a later sweep is marked retroactive and fails closed', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records } = await startCollector(page, phaseRef);
    // The observer never reports: the text is written with the callback removed, which
    // is the "observer missed it" case the reconciler must refuse to trust.
    await page.evaluate(() => { delete window.__atlasBubbleObserved; });
    await appendBubble(page, 'All set — saved to your sheet.');
    await settle(page);

    const liveWriteAtMs = Date.now() - 1000;   // the write already happened
    const texts = await page.locator('#thread-messages .chat-bubble-atlas').allInnerTexts().catch(() => []);
    reconcileSweep(records, texts, { phase: 'teardown', nowMs: Date.now(), thinkingMarker: THINKING });

    const messages = recordsToMessages(records);
    expect(messages[0].retroactive, 'a sweep-only record cannot be trusted for timing').toBe(true);
    const sweep = detectUnsupportedWriteClaim({ messages, liveWriteAtMs });
    expect(sweep.unsupported, 'an untrustworthy timestamp must fail closed, not pass').toBe(true);
    expect(sweep.detail).toMatch(/only observed by a later sweep/);
  });

  test('a later sweep cannot improve a live timestamp', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records } = await startCollector(page, phaseRef);
    await appendBubble(page, 'saved to your sheet');
    await settle(page);
    const liveAt = recordsToMessages(records)[0].atMs;

    await page.waitForTimeout(200);
    const texts = await page.locator('#thread-messages .chat-bubble-atlas').allInnerTexts().catch(() => []);
    reconcileSweep(records, texts, { phase: 'teardown', nowMs: Date.now(), thinkingMarker: THINKING });

    const after = recordsToMessages(records)[0];
    expect(after.atMs, 'the sweep observed the same text, so it must not restamp it').toBe(liveAt);
    expect(after.retroactive).toBe(false);
  });

  test('the observer tracks several bubbles and keeps each one\'s own first-seen phase', async ({ page }) => {
    const phaseRef = { value: 'logging' };
    const { records } = await startCollector(page, phaseRef);
    await appendBubble(page, 'first');
    await settle(page);
    phaseRef.value = 'substitution_ask';
    await appendBubble(page, 'second');
    await settle(page);

    const messages = recordsToMessages(records);
    expect(messages.map(m => m.text)).toEqual(['first', 'second']);
    expect(messages.map(m => m.phase)).toEqual(['logging', 'substitution_ask']);
  });
});


// ── THE FLUSH-WINDOW RACE ─────────────────────────────────────────────────────
// The bounded 100 ms coalescing window is itself a race: a claim visible at t=0 can be
// stamped at t≈100, after a boundary recorded at t=50. The bites above deliberately
// drain the observer before the boundary, so they cannot catch it. These do not.

test.describe('F-SB4B collector — a pending report cannot be inverted across a boundary', () => {
  test('BITE: boundary taken with the report STILL IN FLIGHT — condition 9 must FAIL', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records, state } = await startCollector(page, phaseRef);

    // The immediate sweep sees only the placeholder.
    await appendBubble(page, THINKING);
    await settle(page);
    expect(recordsToMessages(records)[0].placeholder).toBe(true);

    // HOLD the next report at the Node boundary: the page will flush, but the handler
    // blocks, so nothing is ingested yet.
    let release;
    state.gate = new Promise((r) => { release = r; });

    // The bubble becomes an unsupported save claim, visible NOW.
    await rewriteBubble(page, 0, 'All set — your workout is saved to your sheet.');
    await page.waitForTimeout(OBSERVER_FLUSH_MS * 3);   // the flush fired; the report is stuck

    // The boundary is taken WITHOUT a drain while that report is pending — exactly the
    // production race. The claim is already visible on screen at this instant.
    const boundary = makeBoundary({ atMs: Date.now(), ingestSeq: state.ingestSeq, drained: false });

    // Only now is the report allowed through, so it is stamped AFTER the boundary.
    release();
    state.gate = null;
    await page.waitForTimeout(OBSERVER_FLUSH_MS * 3);
    const texts = await page.locator('#thread-messages .chat-bubble-atlas').allInnerTexts().catch(() => []);
    reconcileSweep(records, texts, { phase: 'teardown', nowMs: Date.now(), thinkingMarker: THINKING });

    const messages = recordsToMessages(records);
    expect(messages[0].text).toMatch(/saved to your sheet/);
    expect(messages[0].atMs, 'the report really was stamped after the boundary')
      .toBeGreaterThanOrEqual(boundary.atMs);

    const sweep = detectUnsupportedWriteClaim({ messages, liveWriteBoundary: boundary });
    expect(sweep.unsupported,
      'a claim reported after an UNDRAINED boundary may have been visible first and must fail closed').toBe(true);
    expect(sweep.detail).toMatch(/without a drain/);
  });

  test('BITE: the same race across the MUTATION boundary fails closed too', async ({ page }) => {
    const phaseRef = { value: 'substitution_ask' };
    const { records, state } = await startCollector(page, phaseRef);
    await appendBubble(page, THINKING);
    await settle(page);

    let release;
    state.gate = new Promise((r) => { release = r; });
    await rewriteBubble(page, 0, "Done — I've noted the substitution.");
    await page.waitForTimeout(OBSERVER_FLUSH_MS * 3);

    const boundary = makeBoundary({ atMs: Date.now(), ingestSeq: state.ingestSeq, drained: false });
    release();
    state.gate = null;
    await page.waitForTimeout(OBSERVER_FLUSH_MS * 3);

    const sweep = detectUnsupportedMutationWording({
      messages: recordsToMessages(records), mutationBoundary: boundary,
    });
    expect(sweep.unsupported, 'the same causal primitive governs both boundaries').toBe(true);
    expect(sweep.detail).toMatch(/without a drain/);
  });

  test('the DRAIN barrier closes the race: draining first ingests the pending claim before the boundary', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records, state } = await startCollector(page, phaseRef);
    await appendBubble(page, THINKING);
    await settle(page);

    // The claim becomes visible; NO wait, so a report is genuinely pending.
    await rewriteBubble(page, 0, 'All set — your workout is saved to your sheet.');

    // The runner's barrier: drain, THEN stamp.
    const boundary = await takeBoundary(page, state);
    expect(boundary.drained, 'the drain must have run').toBe(true);

    const messages = recordsToMessages(records);
    expect(messages[0].text, 'the drain ingested the pending claim before the boundary')
      .toMatch(/saved to your sheet/);
    expect(messages[0].atMs).toBeLessThanOrEqual(boundary.atMs);

    const sweep = detectUnsupportedWriteClaim({ messages, liveWriteBoundary: boundary });
    expect(sweep.unsupported, 'the claim was visible before the write and must fail').toBe(true);
  });

  test('a genuinely later claim, after a drained boundary, is honest', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records, state } = await startCollector(page, phaseRef);
    await appendBubble(page, THINKING);
    await settle(page);

    const boundary = await takeBoundary(page, state);   // drained; nothing claimed yet
    await rewriteBubble(page, 0, 'All set — your workout is saved to your sheet.');
    await settle(page);

    const sweep = detectUnsupportedWriteClaim({ messages: recordsToMessages(records), liveWriteBoundary: boundary });
    expect(sweep.unsupported, `a claim made after a drained write boundary is earned: ${sweep.detail}`).toBe(false);
  });
});
