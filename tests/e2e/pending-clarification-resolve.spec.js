const { test, expect } = require('@playwright/test');

// F09G (CONVO-LOG-1) browser replay — the observed failure: bare-rep bodyweight knee
// raises hit the parser's needs_clarification, whose partial.sets were DISCARDED, so the
// sets were silently dropped from the session buffer (and thus the final confirmation),
// and "Just log it" was not recognized. This spec drives the real UI: type the ambiguous
// bodyweight reps → a bounded question is shown and the coach is NOT called → "Just log
// it" commits EXACTLY those reps to the authoritative session buffer (getSessionLog).

const TEST_KEY = 'playwright-test-key';
const TEST_SESSION = 'CLARIFIED-SESSION';
const SEED_TURN = 'turn:clarified-seed';
const MESSAGE_TURN = 'turn:clarified-set-message';
const PAIRING = `pair:${'c'.repeat(32)}`;

function json(body, status = 200, headers = {}) {
  return { status, contentType: 'application/json; charset=utf-8', headers, body: JSON.stringify(body) };
}

async function mock(page, capture) {
  capture.chatCalls = capture.chatCalls || [];
  capture.messageCalls = capture.messageCalls || [];
  capture.previews = capture.previews || [];
  capture.writes = capture.writes || [];
  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));

  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'POST' && request.postData()
      && (request.headers()['content-type'] || '').includes('application/json')
      ? request.postDataJSON()
      : null;

    // The knee-raise input is ambiguous (weight-or-reps): the parser detects the reps
    // but must ask — it returns needs_clarification WITH partial.sets (the real shape).
    if (path === '/api/parse-workout-text' && String(body?.text || '').includes('Knee raises 15 12 10')) {
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
    if (path === '/api/parse-workout-text') {
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true,
          sheet_written: false,
          no_write_confirmed: true,
          warnings: [],
          parsed: {
            intent: 'log_sets',
            raw_name: 'Knee raises',
            canonical_name: 'Hanging Knee Raises',
            exercise: 'Hanging Knee Raises',
            sets: [
              { weight: 0, reps: 15, rir: null },
              { weight: 0, reps: 12, rir: null },
              { weight: 0, reps: 10, rir: null },
            ],
          },
        },
      }));
    }

    // A challenge/reassure-free coach lane — recorded so the test can prove the held
    // clarification is NOT leaked to the coach.
    if (path.startsWith('/api/recommend/next/') && capture.recommendationGate) {
      capture.recommendationCalls = (capture.recommendationCalls || 0) + 1;
      await capture.recommendationGate;
      return route.fulfill(json({ status: 'success', data: {} }));
    }
    if (path === '/api/coach/chat') {
      if (body?.message === 'Seed the clarified-set turn') {
        return route.fulfill(json(
          { status: 'success', data: { message: 'Seed turn retained.', configured: true } },
          200,
          { 'x-atlas-turn-id': SEED_TURN },
        ));
      }
      capture.chatCalls.push(body);
      return route.fulfill(json({ status: 'success', data: { message: 'ok', configured: true } }));
    }
    if (path === '/api/coach/message') {
      capture.messageCalls.push(body);
      if (capture.messageFailure) {
        return route.fulfill(json({ status: 'error', error: 'coach unavailable' }, 503));
      }
      if (capture.messageGate) await capture.messageGate;
      return route.fulfill(json(
        { status: 'success', data: { message: 'Clarified sets landed.', configured: true } },
        200,
        { 'x-atlas-turn-id': MESSAGE_TURN },
      ));
    }
    if (path === '/api/session/compile') {
      return route.fulfill(json({
        status: 'success',
        data: { workout_text: 'Hanging Knee Raises BW 15, 12, 10' },
      }));
    }
    if (path === '/api/log-workout' && method === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        capture.previews.push(body);
        const rows = (body.log_rows || []).map(row => [
          row.date_clean, row.session_id, row.exercise, row.exercise,
          'Core', 'HKR01', row.set_number, row.weight, row.reps, row.rir, row.notes, '',
        ]);
        return route.fulfill(json({
          status: 'success',
          data: {
            test_mode: true,
            sheet_write: 'skipped',
            sheet_written: false,
            no_write_confirmed: true,
            warnings: [],
            log_rows_preview: rows,
          },
        }, 200, {
          'x-atlas-turn-id': body.correlation?.turn_id || SEED_TURN,
          'x-atlas-turn-pairing': PAIRING,
        }));
      }
      capture.writes.push(body);
      return route.fulfill(json({
        status: 'success',
        data: {
          sheet_write: 'success',
          sheet_written: true,
          log_rows_written: (body.log_rows || []).length,
          logAppendedRange: 'Log_Cleaned!A300:L302',
        },
      }));
    }
    if (path === '/api/log-workout/verify-range') {
      return route.fulfill(json({ status: 'success', data: { verified: true } }));
    }
    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({
        status: 'success',
        data: { exercises: [{ canonical_name: 'Hanging Knee Raises', lift_code: 'HKR01' }] },
      }));
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

test('clarified sets keep the active logging session through coach turn and approved closeout', async ({ page }) => {
  const capture = {};
  await mock(page, capture);
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');
  await page.evaluate(session => {
    document.getElementById('log-session-id').value = session;
  }, TEST_SESSION);

  // Establish an older canonical turn in the same session. The clarified-set message
  // must replace it, otherwise closeout can falsely appear correlated while retaining
  // this unrelated seed turn.
  await page.evaluate(session => {
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: {
        text: 'Seed the clarified-set turn',
        context: { session_id: session },
      },
    }));
  }, TEST_SESSION);
  await expect(page.locator('#thread-messages')).toContainText('Seed turn retained.');

  await submit(page, 'Knee raises 15 12 10');
  await expect(page.locator('#logger-status')).toContainText('15, 12, 10');
  await submit(page, 'Just log it');

  await expect.poll(() => capture.messageCalls.length).toBe(1);
  expect(capture.messageCalls[0].session_id).toBe(TEST_SESSION);
  await expect(page.locator('#thread-messages')).toContainText('Clarified sets landed.');
  await expect.poll(() => page.evaluate(() => window.getSessionLog().length)).toBe(3);

  await submit(page, 'done');
  await expect.poll(() => capture.previews.length).toBe(1);
  const previewCorrelation = capture.previews[0].correlation;
  expect(capture.previews[0].session_id).toBe(TEST_SESSION);
  expect(previewCorrelation.turn_id).toBe(MESSAGE_TURN);
  expect(previewCorrelation.initiation_nonce).toMatch(/^init:/);

  await expect(page.locator('.rv-save').last()).toBeEnabled();
  await page.locator('.rv-save').last().click();
  await expect.poll(() => capture.writes.length).toBe(1);
  expect(capture.writes[0].correlation).toEqual({
    turn_id: MESSAGE_TURN,
    initiation_nonce: previewCorrelation.initiation_nonce,
    pairing_token: PAIRING,
  });
});

test('immediate done waits for the clarified-set turn before closeout preview', async ({ page }) => {
  let releaseMessage;
  const capture = {
    messageGate: new Promise(resolve => { releaseMessage = resolve; }),
  };
  await mock(page, capture);
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');
  await page.evaluate(session => {
    document.getElementById('log-session-id').value = session;
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: {
        text: 'Seed the clarified-set turn',
        context: { session_id: session },
      },
    }));
  }, TEST_SESSION);
  await expect(page.locator('#thread-messages')).toContainText('Seed turn retained.');

  await submit(page, 'Knee raises 15 12 10');
  await expect(page.locator('#logger-status')).toContainText('15, 12, 10');
  await submit(page, 'Just log it');
  await expect.poll(() => capture.messageCalls.length).toBe(1);

  // Do not wait for the set response. A real immediate closeout must not preview
  // against the unrelated seed turn while the clarified-set turn is still pending.
  await submit(page, 'done');
  await page.waitForTimeout(150);
  expect(capture.previews).toHaveLength(0);

  releaseMessage();
  await expect(page.locator('#thread-messages')).toContainText('Clarified sets landed.');
  await expect.poll(() => capture.previews.length).toBe(1);
  expect(capture.previews[0].correlation.turn_id).toBe(MESSAGE_TURN);

  const previewCorrelation = capture.previews[0].correlation;
  await page.locator('.rv-save').last().click();
  await expect.poll(() => capture.writes.length).toBe(1);
  expect(capture.writes[0].correlation).toEqual({
    turn_id: MESSAGE_TURN,
    initiation_nonce: previewCorrelation.initiation_nonce,
    pairing_token: PAIRING,
  });
});

test('immediate done waits for an ordinary set turn before closeout preview', async ({ page }) => {
  let releaseMessage;
  const capture = {
    messageGate: new Promise(resolve => { releaseMessage = resolve; }),
  };
  await mock(page, capture);
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');
  await page.evaluate(session => {
    document.getElementById('log-session-id').value = session;
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: {
        text: 'Seed the clarified-set turn',
        context: { session_id: session },
      },
    }));
  }, TEST_SESSION);
  await expect(page.locator('#thread-messages')).toContainText('Seed turn retained.');

  await submit(page, 'Knee raises BW 15 12 10');
  await expect.poll(() => capture.messageCalls.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.getSessionLog().length)).toBe(3);

  await submit(page, 'done');
  await page.waitForTimeout(150);
  expect(capture.previews).toHaveLength(0);

  releaseMessage();
  await expect(page.locator('#thread-messages')).toContainText('Clarified sets landed.');
  await expect.poll(() => capture.previews.length).toBe(1);
  expect(capture.previews[0].correlation.turn_id).toBe(MESSAGE_TURN);
});

test('failed set coaching settles the closeout wait and leaves the write uncorrelated', async ({ page }) => {
  const capture = { messageFailure: true };
  await mock(page, capture);
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');
  await page.evaluate(session => {
    document.getElementById('log-session-id').value = session;
  }, TEST_SESSION);

  await submit(page, 'Knee raises 15 12 10');
  await expect(page.locator('#logger-status')).toContainText('15, 12, 10');
  await submit(page, 'Just log it');
  await expect.poll(() => capture.messageCalls.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.getSessionLog().length)).toBe(3);

  await submit(page, 'done');
  await expect.poll(() => capture.previews.length).toBe(1);
  expect(capture.previews[0].correlation).toBeUndefined();

  await expect(page.locator('.rv-save').last()).toBeEnabled();
  await page.locator('.rv-save').last().click();
  await expect.poll(() => capture.writes.length).toBe(1);
  expect(capture.writes[0].correlation).toBeUndefined();
});

test('a stalled pre-message recommendation cannot block closeout indefinitely', async ({ page }) => {
  let releaseRecommendation;
  const capture = {
    recommendationGate: new Promise(resolve => { releaseRecommendation = resolve; }),
  };
  await mock(page, capture);
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');
  await page.evaluate(session => {
    document.getElementById('log-session-id').value = session;
  }, TEST_SESSION);

  await submit(page, 'Knee raises BW 15 12 10');
  await expect.poll(() => capture.recommendationCalls || 0).toBe(1);
  await expect.poll(() => page.evaluate(() => window.getSessionLog().length)).toBe(3);
  expect(capture.messageCalls).toHaveLength(0);

  await submit(page, 'done');
  await expect.poll(() => capture.previews.length, { timeout: 11_000 }).toBe(1);
  expect(capture.previews[0].correlation).toBeUndefined();
  expect(capture.messageCalls).toHaveLength(0);

  releaseRecommendation();
  await page.waitForTimeout(500);
  expect(capture.messageCalls).toHaveLength(0);
});
