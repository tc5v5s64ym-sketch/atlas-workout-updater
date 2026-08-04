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
const {
  SEEN_ATTR, NEW_BUBBLE_SELECTOR, markExistingBubblesScript,
} = require('./gate/rehearsal-bubble-observer');

const THINKING = 'Thinking…';

// Install the real observer over a minimal thread, and collect reports exactly as the
// runner does — Node stamps each report on receipt.
async function startCollector(page, phaseRef) {
  const records = {};
  const state = { ingestSeq: 0, gate: null, rejectReports: false, signalEntered: null };
  await page.exposeFunction('__atlasBubbleObserved', async (batch) => {
    // ENTERED HANDSHAKE. Signalled BEFORE the gate await, so a test can prove the
    // callback was actually reached rather than assume it after a sleep. Reaching here
    // is causal evidence that the flush already built the batch and ran `pending.clear()`
    // — both happen before `await window[callbackName](batch)` in the collector.
    if (state.signalEntered) { const signal = state.signalEntered; state.signalEntered = null; signal(); }
    // `gate` lets a test HOLD a report in flight, which is how the flush-window race is
    // reproduced: the boundary is taken while this report has not yet reached Node.
    if (state.gate) await state.gate;
    // A rejecting handler is how "the report did not land" is reproduced: the flush must
    // report ok:false rather than swallow it.
    if (state.rejectReports) throw new Error('report handler rejected');
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

// The runner's own boundary: attempt a drain (proving its postcondition), and READ THE
// PAGE'S LOGICAL CLOCK at this instant. Ordering comes from the clock, never the drain.
async function takeBoundary(page, state) {
  let drained = false;
  let atChangeSeq = null;
  try {
    const flushed = await page.evaluate(() => (typeof window.__atlasBubbleFlush === 'function'
      ? window.__atlasBubbleFlush() : null));
    drained = Boolean(flushed && flushed.ok === true && flushed.pending === false);
  } catch { drained = false; }
  try {
    const st = await page.evaluate(() => (typeof window.__atlasBubbleState === 'function'
      ? window.__atlasBubbleState() : null));
    if (st && Number.isFinite(st.changeSeq)) atChangeSeq = st.changeSeq;
  } catch { atChangeSeq = null; }
  return makeBoundary({ atMs: Date.now(), atChangeSeq, ingestSeq: state.ingestSeq, drained });
}

// Arm the entered handshake: resolves when the exposed callback is next reached.
function armEnteredSignal(state) {
  return new Promise((resolve) => { state.signalEntered = resolve; });
}

// Read the logical clock alone, as the response listener does at the write's instant.
const readChangeSeq = (page) => page.evaluate(() => (typeof window.__atlasBubbleState === 'function'
  ? window.__atlasBubbleState().changeSeq : null));

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


// ── the boundary must carry evidence valid at ITS OWN instant ────────────────
// The transplant defect: the write boundary took `atMs` from the successful response
// but its drain certificate from the pre-click instant. A claim rendered after the
// click and before the response, still pending when the response was stamped, was then
// classified `after` on a certificate that proved nothing about that moment.

test.describe('F-SB4B boundary — no transplanted certificate, no unproven drain', () => {
  test('BITE: a claim rendered post-click / pre-response, held until after it, FAILS', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records, state } = await startCollector(page, phaseRef);
    await appendBubble(page, THINKING);
    await settle(page);

    // The pre-click drain succeeds and proves the collector is empty AT THIS INSTANT.
    const preClick = await takeBoundary(page, state);
    expect(preClick.drained, 'the pre-click drain really did succeed').toBe(true);

    // Save is clicked. The bubble becomes a save claim BEFORE the response arrives, and
    // its report is held so it cannot reach Node yet.
    let release;
    state.gate = new Promise((r) => { release = r; });
    await rewriteBubble(page, 0, 'All set — your workout is saved to your sheet.');
    await page.waitForTimeout(OBSERVER_FLUSH_MS * 3);

    // The successful write response is observed: read the clock at THIS instant.
    const liveWriteAtMs = Date.now();
    const atChangeSeq = await readChangeSeq(page);

    release();
    state.gate = null;
    await page.waitForTimeout(OBSERVER_FLUSH_MS * 3);

    const messages = recordsToMessages(records);
    expect(messages[0].text).toMatch(/saved to your sheet/);

    // The honest boundary: response time plus the clock read at that time.
    const honest = detectUnsupportedWriteClaim({
      messages, liveWriteBoundary: makeBoundary({ atMs: liveWriteAtMs, atChangeSeq }),
    });
    expect(honest.unsupported, `the claim was visible before the response: ${honest.detail}`).toBe(true);

    // And the TRANSPLANT — the pre-click certificate carried onto the response time —
    // must not rescue it either.
    const transplanted = detectUnsupportedWriteClaim({
      messages,
      liveWriteBoundary: makeBoundary({ atMs: liveWriteAtMs, ingestSeq: preClick.ingestSeq, drained: preClick.drained }),
    });
    expect(transplanted.unsupported,
      'a drain certificate from the pre-click instant may not authorize a later boundary').toBe(true);
    expect(transplanted.detail).toMatch(/without a drain/);
  });

  test('a claim rendered genuinely AFTER the response instant is earned', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records, state } = await startCollector(page, phaseRef);
    await appendBubble(page, THINKING);
    await settle(page);

    const liveWriteAtMs = Date.now();
    const atChangeSeq = await readChangeSeq(page);      // clock read at the response

    await rewriteBubble(page, 0, 'All set — your workout is saved to your sheet.');
    await settle(page);

    const sweep = detectUnsupportedWriteClaim({
      messages: recordsToMessages(records), liveWriteBoundary: makeBoundary({ atMs: liveWriteAtMs, atChangeSeq }),
    });
    expect(sweep.unsupported, `an honest post-write claim must pass: ${sweep.detail}`).toBe(false);
    expect(state.ingestSeq).toBeGreaterThan(0);
  });

  test('BITE: a MISSING flush function cannot be recorded as a successful drain', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records, state } = await startCollector(page, phaseRef);
    await appendBubble(page, THINKING);
    await settle(page);
    await page.evaluate(() => { delete window.__atlasBubbleFlush; });

    // The claim is rendered; the normal timer will deliver it later.
    await rewriteBubble(page, 0, 'All set — your workout is saved to your sheet.');
    const boundary = await takeBoundary(page, state);
    expect(boundary.drained, 'a missing flush function is not a drain').toBe(false);

    await settle(page);
    const sweep = detectUnsupportedWriteClaim({
      messages: recordsToMessages(records),
      liveWriteBoundary: makeBoundary({ atMs: boundary.atMs, ingestSeq: boundary.ingestSeq, drained: boundary.drained }),
    });
    expect(sweep.unsupported, 'a pre-boundary claim must stay unsupported').toBe(true);
  });

  test('BITE: a REJECTED report callback cannot be recorded as a successful drain', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records, state } = await startCollector(page, phaseRef);
    await appendBubble(page, THINKING);
    await settle(page);

    state.rejectReports = true;
    await rewriteBubble(page, 0, 'All set — your workout is saved to your sheet.');
    const boundary = await takeBoundary(page, state);
    expect(boundary.drained, 'a rejected callback is not a delivered report').toBe(false);

    // The re-queued report lands once the handler recovers — a failed delivery must not
    // DROP the evidence.
    state.rejectReports = false;
    await settle(page);
    expect(recordsToMessages(records)[0].text, 'the rejected batch was retried, not lost')
      .toMatch(/saved to your sheet/);

    const sweep = detectUnsupportedWriteClaim({
      messages: recordsToMessages(records),
      liveWriteBoundary: makeBoundary({ atMs: boundary.atMs, ingestSeq: boundary.ingestSeq, drained: boundary.drained }),
    });
    expect(sweep.unsupported, 'an unproven drain may not authorize anything').toBe(true);
  });

  test('a genuine drain proves its postcondition', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records, state } = await startCollector(page, phaseRef);
    await appendBubble(page, 'a real reply');
    const boundary = await takeBoundary(page, state);
    expect(boundary.drained).toBe(true);
    expect(boundary.atChangeSeq, 'the boundary carries the clock read at its own instant').not.toBeNull();
    expect(recordsToMessages(records)[0].text, 'the drain delivered the pending report').toBe('a real reply');
  });

  test('BITE: a bare-number boundary cannot authorize a collector record', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records } = await startCollector(page, phaseRef);
    await appendBubble(page, 'All set — saved to your sheet.');
    await settle(page);
    const messages = recordsToMessages(records);
    expect(Number.isFinite(messages[0].changeSeq), 'the record carries collector causality').toBe(true);

    // A bare timestamp carries no clock read and no drain proof.
    const sweep = detectUnsupportedWriteClaim({ messages, liveWriteAtMs: messages[0].atMs - 10 });
    expect(sweep.unsupported, 'a bare number must not disable the ordering question').toBe(true);
    expect(sweep.detail).toMatch(/without a drain/);
  });
});


// ── the retry may not relabel an old claim with a later unrelated sequence ────
// The interleaving the final review named: a pre-boundary claim is sent with sequence
// S; the delivery is held and rejects; meanwhile an unrelated thread mutation runs
// markAll and stamps that same bubble with a newer sequence S'; the re-queue skips the
// index because it is already pending; the retry then reports the OLD claim carrying
// S'. A boundary taken between S and S' would classify it `after`.

test.describe('F-SB4B collector — a rejected batch keeps its original causal sequence', () => {
  // The delivery must be HELD UNRESOLVED while the unrelated mutation happens. An
  // earlier version of this bite awaited the flush, so the catch had already re-queued
  // before the unrelated mutation ran — that only exercised the `markAll` call site and
  // left the rejection-side merge unproven (owner P1, 2026-08-03).
  test('BITE: an unrelated mutation DURING an unresolved delivery cannot relabel the claim', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records, state } = await startCollector(page, phaseRef);

    await appendBubble(page, THINKING);
    await settle(page);

    // 1. The unsupported pre-boundary claim appears at sequence S.
    await rewriteBubble(page, 0, 'All set — your workout is saved to your sheet.');
    const claimSeq = await readChangeSeq(page);

    // 2. HOLD the delivery. The flush promise is deliberately NOT awaited yet, and the
    //    race position is OBSERVED rather than assumed: a sleep is not evidence that the
    //    callback was entered, and under a delayed browser or IPC turn the unrelated
    //    mutation could otherwise land BEFORE the batch was built — in which case
    //    `markAll` alone preserves S and a broken re-queue still passes (owner P1,
    //    2026-08-03). Awaiting the entered handshake is causal proof that the batch was
    //    built and `pending.clear()` already ran.
    const entered = armEnteredSignal(state);
    let release;
    state.gate = new Promise((r) => { release = r; });
    state.rejectReports = true;
    const flushPromise = page.evaluate(() => window.__atlasBubbleFlush());
    await entered;

    // 3. WHILE the delivery is unresolved, an unrelated mutation runs markAll and puts
    //    this same index back into `pending` at S' > S.
    await appendBubble(page, 'an unrelated later bubble');
    const unrelatedSeq = await readChangeSeq(page);
    expect(unrelatedSeq, 'the unrelated mutation advanced the clock while delivery was in flight')
      .toBeGreaterThan(claimSeq);

    // 4. THE BOUNDARY sits between S and S'.
    const boundary = makeBoundary({ atMs: Date.now(), atChangeSeq: claimSeq });

    // 5. Release: the callback rejects, and the catch must merge S back over S'.
    release();
    state.gate = null;
    await flushPromise;

    // 6. Delivery recovers; the re-queued batch is retried.
    state.rejectReports = false;
    await settle(page);

    const messages = recordsToMessages(records);
    const claim = messages.find((m) => /saved to your sheet/.test(m.text));
    expect(claim, 'the re-queued claim must eventually be delivered').toBeTruthy();
    expect(claim.changeSeq, 'the retry must keep the claim\'s ORIGINAL pre-boundary sequence S')
      .toBeLessThanOrEqual(claimSeq);

    const sweep = detectUnsupportedWriteClaim({ messages, liveWriteBoundary: boundary });
    expect(sweep.unsupported,
      `a pre-boundary claim may not be relabelled past the boundary by an unrelated mutation: ${sweep.detail}`)
      .toBe(true);
  });

  // Retained as the INDEPENDENT proof of the `markAll` call site: here the catch has
  // already re-queued before the unrelated mutation, so only markAll's earliest-wins
  // merge can keep the claim's sequence.
  test('BITE: an unrelated mutation AFTER the re-queue cannot raise the claim sequence', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records, state } = await startCollector(page, phaseRef);

    await appendBubble(page, THINKING);
    await settle(page);

    state.rejectReports = true;
    await rewriteBubble(page, 0, 'All set — your workout is saved to your sheet.');
    const claimSeq = await readChangeSeq(page);

    // Awaited: the rejection and its re-queue complete BEFORE the unrelated mutation.
    await page.evaluate(() => window.__atlasBubbleFlush());

    await appendBubble(page, 'an unrelated later bubble');
    expect(await readChangeSeq(page)).toBeGreaterThan(claimSeq);

    const boundary = makeBoundary({ atMs: Date.now(), atChangeSeq: claimSeq });
    state.rejectReports = false;
    await settle(page);

    const messages = recordsToMessages(records);
    const claim = messages.find((m) => /saved to your sheet/.test(m.text));
    expect(claim.changeSeq, 'markAll must not raise an already-pending earlier sequence')
      .toBeLessThanOrEqual(claimSeq);
    expect(detectUnsupportedWriteClaim({ messages, liveWriteBoundary: boundary }).unsupported).toBe(true);
  });

  test('a genuine LATER transition of the same bubble still carries its own later sequence', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records } = await startCollector(page, phaseRef);

    await appendBubble(page, 'first text');
    await settle(page);
    const firstSeq = recordsToMessages(records)[0].changeSeq;

    // A successful delivery clears the slot, so the next change is judged on its own.
    await rewriteBubble(page, 0, 'All set — saved to your sheet.');
    await settle(page);

    const claim = recordsToMessages(records)[0];
    expect(claim.text).toMatch(/saved to your sheet/);
    expect(claim.changeSeq, 'a delivered slot does not pin later changes to the old sequence')
      .toBeGreaterThan(firstSeq);

    // A boundary before that later change: the claim is genuinely after it.
    const boundary = makeBoundary({ atMs: Date.now(), atChangeSeq: firstSeq });
    const sweep = detectUnsupportedWriteClaim({ messages: [claim], liveWriteBoundary: boundary });
    expect(sweep.unsupported, `an honest post-boundary claim must pass: ${sweep.detail}`).toBe(false);
  });

  test('several unrelated mutations while held cannot advance a held claim', async ({ page }) => {
    const phaseRef = { value: 'closeout' };
    const { records, state } = await startCollector(page, phaseRef);
    await appendBubble(page, THINKING);
    await settle(page);

    state.rejectReports = true;
    await rewriteBubble(page, 0, 'All set — saved to your sheet.');
    const claimSeq = await readChangeSeq(page);
    await page.evaluate(() => window.__atlasBubbleFlush());

    for (let i = 0; i < 3; i += 1) {
      await appendBubble(page, `unrelated ${i}`);
      await page.evaluate(() => window.__atlasBubbleFlush()).catch(() => {});
    }

    state.rejectReports = false;
    await settle(page);

    const claim = recordsToMessages(records).find((m) => /saved to your sheet/.test(m.text));
    expect(claim.changeSeq, 'repeated unrelated mutations must not drag the claim forward')
      .toBeLessThanOrEqual(claimSeq);
  });
});


// ── Turn-own-bubble identity, and the eviction that broke counting ────────────
//
// Debug sweep Session 1 hung the full 90 s on a turn the product had answered
// correctly. `src/app/chat.js` caps the thread at MAX_BUBBLES = 12 and prunes
// `thread.firstChild` past it, so on a long session the user's own message evicts the
// OLDEST atlas bubble and the reply is then appended: the count never rises. The driver
// waited on `count() > bubblesBefore` and read the reply at `nth(bubblesBefore)`.
//
// These drive that exact shape — append with an eviction — and prove identity survives
// what counting and indexing cannot.

const evictOldestAndAppend = (page, text) => page.evaluate((t) => {
  const thread = document.getElementById('thread-messages');
  // Exactly what chat.js does: append, then prune from the front past the cap.
  const b = document.createElement('div');
  b.className = 'chat-bubble chat-bubble-atlas';
  const body = document.createElement('div');
  body.textContent = t;
  b.appendChild(body);
  thread.appendChild(b);
  thread.removeChild(thread.firstChild);
}, text);

const countAll = (page) => page.locator('#thread-messages .chat-bubble-atlas').count();
const countNew = (page) => page.locator(NEW_BUBBLE_SELECTOR).count();

test('identity: after marking, only bubbles added by the turn are unmarked', async ({ page }) => {
  await startCollector(page, { value: 'identity' });
  await appendBubble(page, 'older reply');
  await appendBubble(page, 'previous reply');

  const marked = await page.evaluate(markExistingBubblesScript, SEEN_ATTR);
  expect(marked).toBe(2);
  expect(await countNew(page)).toBe(0);      // nothing is the turn's own yet

  await appendBubble(page, 'THE TURN REPLY');
  expect(await countNew(page)).toBe(1);
  expect(await page.locator(NEW_BUBBLE_SELECTOR).first().innerText()).toContain('THE TURN REPLY');
});

// THE BITE for the Session 1 defect. The count is FLAT across the turn — the pre-fix
// driver polled exactly this and could never proceed — while identity finds the reply.
test('identity: survives the thread evicting its oldest bubble (the Session 1 hang)', async ({ page }) => {
  await startCollector(page, { value: 'identity' });
  for (const t of ['bubble 1', 'bubble 2', 'bubble 3']) await appendBubble(page, t);

  await page.evaluate(markExistingBubblesScript, SEEN_ATTR);
  const totalBefore = await countAll(page);

  await evictOldestAndAppend(page, 'THE TURN REPLY');

  // Counting cannot see this turn at all: the total is unchanged.
  expect(await countAll(page)).toBe(totalBefore);
  // Identity can.
  expect(await countNew(page)).toBe(1);
  expect(await page.locator(NEW_BUBBLE_SELECTOR).first().innerText()).toContain('THE TURN REPLY');
});

// THE BITE for the worse half. With an eviction, the old positional read addresses a
// DIFFERENT turn's bubble — so a settled reply could be scored against the wrong turn.
// This asserts the index is genuinely wrong and that identity is genuinely right, so the
// test fails if someone reverts to indexing even where the count does rise.
test('identity: an index into the thread addresses the WRONG bubble after an eviction', async ({ page }) => {
  await startCollector(page, { value: 'identity' });
  for (const t of ['bubble 1', 'bubble 2', 'bubble 3']) await appendBubble(page, t);

  const bubblesBefore = await countAll(page);           // what the old driver captured
  await page.evaluate(markExistingBubblesScript, SEEN_ATTR);

  await evictOldestAndAppend(page, 'reply A');
  await appendBubble(page, 'reply B');                  // now the count does rise

  const all = page.locator('#thread-messages .chat-bubble-atlas');
  const positional = await all.nth(bubblesBefore).innerText();
  expect(positional, 'the old index lands on an unrelated bubble').not.toContain('reply A');

  const byIdentity = await page.locator(NEW_BUBBLE_SELECTOR).first().innerText();
  expect(byIdentity, 'identity addresses the turn\'s own first bubble').toContain('reply A');
  expect(await countNew(page)).toBe(2);                 // both of this turn's bubbles
});

// A bubble the app REUSES (handlePreviewReady reuses an existing element rather than
// appending) keeps its mark, so it is correctly not mistaken for new work.
test('identity: a reused bubble stays marked and is never counted as the turn\'s own', async ({ page }) => {
  await startCollector(page, { value: 'identity' });
  await appendBubble(page, 'existing card');
  await page.evaluate(markExistingBubblesScript, SEEN_ATTR);

  await rewriteBubble(page, 0, 'existing card, rebuilt in place');
  expect(await countNew(page)).toBe(0);
  expect(await page.locator('#thread-messages .chat-bubble-atlas').first().innerText())
    .toContain('rebuilt in place');
});

// ── F-SB4B corrective 4: a sweep may not race the flush it reconciles ──────────
//
// THE DEFECT. `reconcileSweep` marks a record `retroactive` whenever the swept text
// differs from the record's. `say()` sweeps the instant it submits — inside the
// collector's flush window — so a change the observer HAD seen was swept before its
// report landed: the sweep wrote the new text and set `retroactive`. The live report
// that followed could not clear the mark, because `ingestLiveObservation` only resets it
// when the text DIFFERS and the sweep had already written that very text. The record
// stayed untrustworthy forever, and every claim decision failed closed on it. Session 1
// reported seven messages as seen only by the sweep for exactly this reason, against a
// product that had rendered them normally.
//
// The fix is at the source: a sweep drains first and reads the collector's own state at
// the same instant it reads the text, and a sweep facing a collector that still owes a
// report may not downgrade an existing live record.
test.describe('F-SB4B sweep — a pending report is not a missed one', () => {
  // The runner's real sweep: drain, then read text and collector state in ONE page
  // evaluation, so `quiet` describes the instant the texts were taken.
  const sweepLikeRunner = async (page, records, phase) => {
    const swept = await page.evaluate(async () => {
      let flushed = null;
      try {
        flushed = typeof window.__atlasBubbleFlush === 'function' ? await window.__atlasBubbleFlush() : null;
      } catch { flushed = null; }
      const texts = Array.from(document.querySelectorAll('#thread-messages .chat-bubble-atlas'))
        .map(e => String(e.innerText || ''));
      let state = null;
      try {
        state = typeof window.__atlasBubbleState === 'function' ? window.__atlasBubbleState() : null;
      } catch { state = null; }
      return { texts, quiet: Boolean(flushed && flushed.ok === true) && Boolean(state) && state.pending === false };
    }).catch(() => ({ texts: [], quiet: false }));
    reconcileSweep(records, swept.texts, {
      phase, nowMs: Date.now(), thinkingMarker: THINKING, collectorQuiet: swept.quiet,
    });
    return swept;
  };

  const REPLY = 'Replace Bench Press with Incline Dumbbell Press — 90 lb 10 reps.';

  test('BITE: the OLD undrained sweep poisons a live-observed record permanently', async ({ page }) => {
    const phaseRef = { value: 'logging' };
    const { records } = await startCollector(page, phaseRef);
    await appendBubble(page, THINKING);
    await settle(page);
    expect(records[0].retroactive).toBe(false);

    // The bubble becomes the real reply; the old sweep looks immediately, without a drain.
    await rewriteBubble(page, 0, REPLY);
    const texts = await page.evaluate(() => Array.from(
      document.querySelectorAll('#thread-messages .chat-bubble-atlas')).map(e => String(e.innerText || '')));
    reconcileSweep(records, texts, { phase: 'substitution_ask', nowMs: Date.now(), thinkingMarker: THINKING });
    expect(records[0].retroactive, 'the undrained sweep marks it').toBe(true);

    // The observer's OWN live report for that very change now lands — and cannot help,
    // because the sweep already wrote the text it would have differed from.
    await settle(page);
    expect(records[0].text).toContain('Incline Dumbbell Press');
    expect(records[0].retroactive, 'this is the defect: permanently untrustworthy though observed live').toBe(true);
  });

  test('the drained sweep leaves the in-flight record alone, and the live report keeps it trusted', async ({ page }) => {
    const phaseRef = { value: 'logging' };
    const { records } = await startCollector(page, phaseRef);
    await appendBubble(page, THINKING);
    await settle(page);

    await rewriteBubble(page, 0, REPLY);
    const swept = await sweepLikeRunner(page, records, 'substitution_ask');
    expect(swept.texts[0]).toContain('Incline Dumbbell Press');

    // Either the drain delivered the change (so the record is live and current) or the
    // collector was not quiet (so the sweep declined to downgrade it). Both end trusted.
    await settle(page);
    expect(records[0].text).toContain('Incline Dumbbell Press');
    expect(records[0].retroactive, 'a change the observer saw is never reported as sweep-only').toBe(false);
    expect(Number.isFinite(records[0].changeSeq), 'it keeps the change\'s own logical time').toBe(true);
  });

  test('a bubble the observer never reported is STILL filled in and STILL marked retroactive', async ({ page }) => {
    const phaseRef = { value: 'logging' };
    const { records, state } = await startCollector(page, phaseRef);

    // Reports cannot land at all — the observer's say is genuinely lost.
    state.rejectReports = true;
    await appendBubble(page, 'a bubble no report will ever describe');
    await settle(page);
    expect(records[0], 'nothing was ingested').toBeUndefined();

    await sweepLikeRunner(page, records, 'teardown');
    expect(records[0], 'the sweep still fills it in').toBeTruthy();
    expect(records[0].retroactive, 'and an unobserved bubble is never silently trusted').toBe(true);
  });

  test('a genuinely missed TRANSITION is still marked when the collector is quiet', async ({ page }) => {
    const phaseRef = { value: 'logging' };
    const { records, state } = await startCollector(page, phaseRef);
    await appendBubble(page, THINKING);
    await settle(page);
    expect(records[0].retroactive).toBe(false);

    // The observer stops being able to deliver, so the transition is truly lost. The
    // drain cannot prove its postcondition, so the sweep declines to downgrade — and the
    // record keeps its OWN honest text rather than acquiring a claim it never observed.
    state.rejectReports = true;
    await rewriteBubble(page, 0, REPLY);
    const swept = await sweepLikeRunner(page, records, 'substitution_ask');
    expect(swept.quiet, 'a failed drain is never quiet').toBe(false);
    expect(records[0].text, 'an unbacked claim is not written into a trusted record').toBe(THINKING);

    // Once delivery works again the observer reports it, and the record is honest.
    state.rejectReports = false;
    await settle(page);
    expect(records[0].text).toContain('Incline Dumbbell Press');
    expect(records[0].retroactive).toBe(false);
  });
});
