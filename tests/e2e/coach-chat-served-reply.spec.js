'use strict';

// ── The visible chat reply is the reply the server served ─────────────────────
//
// THE FAILURE THIS PINS. Qualifying rehearsal Session 1 (2026-08-05) died at the
// open-question turn. `POST /api/coach/chat` returned 200 in ~16.7s carrying a
// complete 386-character coach message, and the turn's own bubble ended holding a
// deterministic outage line the server never served. `settleReply` waited its full
// 90s and refused, correctly: a visible reply that is not the served reply is not a
// settled one.
//
// The cause was a client `Promise.race` against a 15s budget that cancelled nothing.
// At 15s the client stopped listening and rendered `chatFallback`; the request stayed
// alive and returned the real answer 1.7s later, and nothing consumed it. Two things
// decided one turn's visible wording, and the outage line outranked the coach.
//
// This spec drives the REAL built shell, the REAL composer → chat lane, the REAL
// `typeOut` renderer, and the REAL turn-own-bubble identity `settleReply` consumes,
// and settles with the rehearsal's OWN classifier — so it holds the product to the
// same contract the rehearsal enforces. Nothing is simulated but the latency.
//
// Credential-free and write-free: every route is mocked, and the chat lane is
// read-only by construction.

const { test, expect } = require('@playwright/test');
const { openCoachLane } = require('./support/coach-lane-harness');
const { classifySettlement, isSettled } = require('./gate/rehearsal-scorecard');
const { SEEN_ATTR, NEW_BUBBLE_SELECTOR, markExistingBubblesScript } = require('./gate/rehearsal-bubble-observer');

// The failing turn's shape: an open coaching question answered in one paragraph.
// 386 characters, ordinary punctuation and spacing, ending on a period.
const SERVED_REPLY = 'Keep the bar path over your midfoot and brace before every rep, because a soft trunk is what lets the lower back round under load. Take the last two sets at RIR 2, not to failure. If the lumbar starts to fatigue, shorten the range slightly rather than dropping the weight, and finish with a slow, controlled walk back to the rack. Reset your breath between sets, and stop the set early.';

// Strictly longer than the 15s budget that used to end the turn, and the latency the
// live failure actually recorded.
const LIVE_FAILING_LATENCY_MS = 16700;

const QUESTION = 'any tips for keeping my lower back safe on the remaining lifts?';

const THINKING = 'Thinking…';
const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

const FIXTURE = {
  plan: {
    label: 'Pull', focus: 'Row + hinge',
    exercises: [{ name: 'Barbell Row', lift_code: 'BBROW', sets: 3, reps: 8, weight: 135 }],
  },
  catalog: [{ canonical_name: 'Barbell Row', lift_code: 'BBROW' }],
  substitute: null,
  parses: [],
};

// `control.serve(route)` decides what this turn is served, so a case can serve a
// slow success or a genuine failure without a second route table.
async function openLane(page, control) {
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });

  await openCoachLane(page, {}, FIXTURE);

  // An open coaching question has no SME card, so it falls through to the coach —
  // exactly the routing the live turn took.
  await page.route('**/api/coach/ask', route => route.fulfill({
    status: 200, contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ status: 'success', data: { depth: 'log_only', answer: null, cards: [] } }),
  }));
  await page.route('**/api/coach/chat', route => control.serve(route));

  // What the server SERVED, captured from the wire — never from the client, which is
  // the thing under test.
  const served = [];
  page.on('response', async res => {
    if (!res.url().includes('/api/coach/chat')) return;
    try {
      const body = await res.json();
      const m = body && body.data && body.data.message;
      if (typeof m === 'string' && m.length) served.push(m);
    } catch { /* a body that cannot be read served nothing this test can claim */ }
  });

  return { served, pageErrors };
}

// Submit one turn and settle its own bubble the way `settleReply` does: by IDENTITY
// (mark every existing bubble; the turn's own is the one left unmarked), and by the
// scorecard's own settlement classifier.
async function settleOwnBubble(page, served, question, timeoutMs, { expectServed = true } = {}) {
  await page.evaluate(markExistingBubblesScript, SEEN_ATTR);
  const newBubbles = page.locator(NEW_BUBBLE_SELECTOR);
  expect(await newBubbles.count(), 'no unmarked bubble may exist before the turn').toBe(0);
  const servedBefore = served.length;

  await page.locator('#workout-text').fill(question);
  await page.locator('#preview-btn').click();

  await expect.poll(() => newBubbles.count(), { timeout: timeoutMs, intervals: [250] }).toBeGreaterThan(0);
  const mine = newBubbles.first();

  let outcome = 'no observation yet';
  let stableSince = null;
  let lastSeen = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = norm(await mine.innerText().catch(() => ''));
    if (text !== lastSeen) { lastSeen = text; stableSince = Date.now(); }
    outcome = classifySettlement({
      text,
      servedMessages: served.slice(servedBefore),
      stableForMs: stableSince === null ? 0 : Date.now() - stableSince,
      stableThresholdMs: 750,
      thinkingMarker: THINKING,
      captureFailed: false,
    });
    if (isSettled(outcome)) break;
    await page.waitForTimeout(250);
  }

  // The assertion is served-vs-visible, so the served reply must genuinely be in
  // hand before it is read. Without this the historical failure reports itself as
  // "the server served nothing" — the client settles on its own line while the
  // response is still in flight, which is the very state under test.
  const servedDeadline = Date.now() + (expectServed ? Math.min(timeoutMs, 30000) : 0);
  while (served.length === servedBefore && Date.now() < servedDeadline) {
    await page.waitForTimeout(250);
  }
  // Give any client render that follows the response time to land, so a pass is
  // never credited to a read taken too early.
  await page.waitForTimeout(3000);

  return { outcome, text: norm(await mine.innerText().catch(() => '')) };
}

test.describe('the visible chat reply is the reply the server served', () => {
  test('a reply served AFTER the old 15s budget still reaches the bubble in full', async ({ page }) => {
    test.setTimeout(120000);
    const control = {
      serve: async route => {
        await new Promise(r => setTimeout(r, LIVE_FAILING_LATENCY_MS));
        await route.fulfill({
          status: 200, contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({ status: 'success', data: { message: SERVED_REPLY, configured: true } }),
        });
      },
    };
    const { served, pageErrors } = await openLane(page, control);

    const settled = await settleOwnBubble(page, served, QUESTION, 90000);

    // The served reply is in hand, and it is the one on screen — character for
    // character, under the rehearsal's own normalization.
    expect(served, 'the server served exactly one reply for this turn').toHaveLength(1);
    expect(settled.text).toBe(norm(SERVED_REPLY));
    // Settled by COMPLETION, not by looking quiet: `served-complete` is the outcome
    // that proves the whole served message is on screen. The partial-render outcome
    // this failure produced can never be settled.
    expect(settled.outcome).toBe('served-complete');
    expect(pageErrors).toEqual([]);
  });

  test('an ordinary fast reply is unchanged', async ({ page }) => {
    test.setTimeout(60000);
    const control = {
      serve: route => route.fulfill({
        status: 200, contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ status: 'success', data: { message: SERVED_REPLY, configured: true } }),
      }),
    };
    const { served, pageErrors } = await openLane(page, control);

    const settled = await settleOwnBubble(page, served, QUESTION, 60000);

    expect(settled.text).toBe(norm(SERVED_REPLY));
    expect(settled.outcome).toBe('served-complete');
    expect(pageErrors).toEqual([]);
  });

  test('a turn that genuinely serves nothing still gets the deterministic line', async ({ page }) => {
    test.setTimeout(60000);
    // The outage lane must stay reachable: waiting for the server is not the same as
    // waiting forever, and a failed turn must never sit on "Thinking…".
    const control = {
      serve: route => route.fulfill({
        status: 500, contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ status: 'error', message: 'coach unavailable' }),
      }),
    };
    const { served } = await openLane(page, control);

    const settled = await settleOwnBubble(page, served, QUESTION, 60000, { expectServed: false });

    expect(served, 'a failed turn serves no message').toHaveLength(0);
    expect(settled.text).not.toContain(THINKING);
    expect(settled.text.length).toBeGreaterThan(0);
    // Nothing was served, so stability is the only settlement available — and it is
    // honest here, which is exactly why it must not be available when a reply WAS
    // served.
    expect(settled.outcome).toBe('stable-no-served-message');
  });
});
