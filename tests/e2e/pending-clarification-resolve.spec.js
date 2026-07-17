const { test, expect } = require('@playwright/test');

// F09G (CONVO-LOG-1) browser replay — the observed failure: bare-rep bodyweight knee
// raises hit the parser's needs_clarification, whose partial.sets were DISCARDED, so the
// sets were silently dropped from the session buffer (and thus the final confirmation),
// and "Just log it" was not recognized. This spec drives the real UI: type the ambiguous
// bodyweight reps → a bounded question is shown and the coach is NOT called → "Just log
// it" commits EXACTLY those reps to the authoritative session buffer (getSessionLog).

const TEST_KEY = 'playwright-test-key';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

async function mock(page, capture) {
  capture.chatCalls = capture.chatCalls || [];
  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));

  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;

    // The knee-raise input is ambiguous (weight-or-reps): the parser detects the reps
    // but must ask — it returns needs_clarification WITH partial.sets (the real shape).
    if (path === '/api/parse-workout-text') {
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
          parsed: {
            intent: 'needs_clarification',
            message: 'Knee raises: do you mean bodyweight reps 15, 12, 10?',
            warnings: ['missing_weight_or_bodyweight_context'],
            partial: {
              exercise: 'Hanging Knee Raises',
              raw_name: 'Knee raises',
              sets: [
                { weight: null, reps: 15, rir: null },
                { weight: null, reps: 12, rir: null },
                { weight: null, reps: 10, rir: null },
              ],
            },
          },
        },
      }));
    }

    // A challenge/reassure-free coach lane — recorded so the test can prove the held
    // clarification is NOT leaked to the coach.
    if (path === '/api/coach/chat') {
      capture.chatCalls.push(route.request().postDataJSON());
      return route.fulfill(json({ status: 'success', data: { message: 'ok', configured: true } }));
    }
    if (path === '/api/coach/message') {
      return route.fulfill(json({ status: 'success', data: { message: null, configured: false } }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });
}

async function submit(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
}

test('bare-rep bodyweight clarification is HELD, then "Just log it" commits exactly those reps', async ({ page }) => {
  const capture = {};
  await mock(page, capture);
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');

  // 1) Ambiguous bodyweight reps → the bounded question is surfaced, the sets are held,
  //    and the message is NOT routed to the coach (no fabricated readback over an empty
  //    buffer).
  await submit(page, 'Knee raises 15 12 10');
  await expect(page.locator('#logger-status')).toContainText('15, 12, 10');
  expect(capture.chatCalls, 'a held clarification is not leaked to the coach').toHaveLength(0);
  // Nothing is in the buffer yet — the sets are held, not logged, until confirmed.
  expect(await page.evaluate(() => window.getSessionLog().length)).toBe(0);

  // 2) "Just log it" resolves the hold — committing EXACTLY the detected reps, in order,
  //    as bodyweight sets (weight 0). No set dropped, none fabricated.
  await submit(page, 'Just log it');
  await expect.poll(() => page.evaluate(() => window.getSessionLog().length)).toBe(3);
  const logged = await page.evaluate(() => window.getSessionLog().map(s => ({ exercise: s.exercise, weight: String(s.weight), reps: String(s.reps) })));
  expect(logged).toEqual([
    { exercise: 'Hanging Knee Raises', weight: '0', reps: '15' },
    { exercise: 'Hanging Knee Raises', weight: '0', reps: '12' },
    { exercise: 'Hanging Knee Raises', weight: '0', reps: '10' },
  ]);
  // The affirmation resolved the hold; it was never sent to the coach as chat.
  expect(capture.chatCalls).toHaveLength(0);
});
