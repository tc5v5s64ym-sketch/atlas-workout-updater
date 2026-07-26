const { test, expect } = require('@playwright/test');

// #1165 slice 2 — drives the REAL browser coach-header → logger preview → review-card
// approval path. The network is stubbed, but no fixture calls the protocol module or write
// handler directly; a false-green helper that bypasses app.js cannot satisfy these assertions.

const TEST_KEY = 'playwright-test-key';
const SESSION = 'TC-E2E-SESSION';
const OTHER_SESSION = 'TC-E2E-SESSION-2';
const TURN = 'turn:2026-07-25T12:00:00.000Z_7_cliente2e';
const MESSAGE_TURN = 'turn:2026-07-25T12:01:00.000Z_8_messagee2e';
const CHAT_TURN_A = 'turn:2026-07-25T12:02:00.000Z_9_chata';
const CHAT_TURN_B = 'turn:2026-07-25T12:03:00.000Z_10_chatb';
const TOKEN_A = `pair:${'a'.repeat(32)}`;
const TOKEN_B = `pair:${'b'.repeat(32)}`;

function json(body, status = 200, headers = {}) {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    headers,
    body: JSON.stringify(body),
  };
}

async function openApp(page, capture, { startSecond = true } = {}) {
  capture.previews = [];
  capture.writes = [];
  capture.gates = [];
  capture.coachBodies = [];
  capture.messageBodies = [];

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'POST' && request.postData() ? request.postDataJSON() : null;

    if (path === '/api/coach/ask') {
      capture.coachBodies.push(body);
      return route.fulfill(json(
        { status: 'success', data: { depth: 'log_only', answer: null } },
        200,
        { 'x-atlas-turn-id': TURN },
      ));
    }
    if (path === '/api/coach/chat') {
      capture.coachBodies.push(body);
      return route.fulfill(json(
        { status: 'success', data: { message: 'Keep the session clean and finish strong.' } },
        200,
        { 'x-atlas-turn-id': TURN },
      ));
    }
    if (path === '/api/coach/message') {
      capture.messageBodies.push(body);
      return route.fulfill(json(
        { status: 'success', data: { message: 'That set landed cleanly.', note_tier: 'normal' } },
        200,
        { 'x-atlas-turn-id': MESSAGE_TURN },
      ));
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
            canonical_name: 'Bench Press',
            exercise: 'Bench Press',
            sets: [{ weight: 225, reps: 5, rir: 2 }],
          },
        },
      }));
    }
    if (path === '/api/session/compile') {
      return route.fulfill(json({ status: 'success', data: { workout_text: 'bench 225 5/2' } }));
    }
    if (path === '/api/log-workout' && method === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        const index = capture.previews.length;
        capture.previews.push(body);
        await new Promise(resolve => capture.gates.push(resolve));
        const token = index === 0 ? TOKEN_A : TOKEN_B;
        const rows = (body.log_rows || []).map(r => [
          r.date_clean, r.session_id, r.exercise, r.exercise, 'Chest', 'BEN01',
          r.set_number, r.weight, r.reps, r.rir, r.notes, '',
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
          'x-atlas-turn-id': body.correlation?.turn_id || TURN,
          'x-atlas-turn-pairing': token,
        }));
      }
      capture.writes.push(body);
      return route.fulfill(json({
        status: 'success',
        data: {
          sheet_write: 'success',
          sheet_written: true,
          log_rows_written: (body.log_rows || []).length,
          logAppendedRange: 'Log_Cleaned!A200:L200',
        },
      }));
    }
    if (path === '/api/log-workout/verify-range') {
      return route.fulfill(json({ status: 'success', data: { verified: true } }));
    }
    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({
        status: 'success',
        data: { exercises: [{ canonical_name: 'Bench Press', lift_code: 'BEN01' }] },
      }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });

  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
  // The advanced session-id field is intentionally collapsed in the UI; set the real
  // form control directly (the production submit path reads this exact DOM value).
  await page.evaluate(session => {
    document.getElementById('log-session-id').value = session;
  }, SESSION);

  // Use the production coach event listener and api() header callback to retain TURN.
  await page.evaluate(({ session, text }) => {
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: { text, context: { session_id: session } },
    }));
  }, { session: SESSION, text: 'How should I finish this session?' });
  await expect.poll(() => capture.coachBodies.length).toBeGreaterThanOrEqual(2);
  expect(capture.coachBodies.every(body => body.session_id === SESSION)).toBeTruthy();

  // Real conversational set buffer, then two overlapping real closeout previews.
  await page.locator('#workout-text').fill('bench 225 5/2');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
  await expect.poll(() =>
    capture.messageBodies.filter(body => body && typeof body.session_id === 'string' && body.session_id).length
  ).toBeGreaterThan(0);

  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.previews.length).toBe(1);

  if (!startSecond) return;

  await page.evaluate(() => {
    document.getElementById('workout-text').value = 'done';
    document.getElementById('logger-form').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
  });
  await expect.poll(() => capture.previews.length).toBe(2);
}

for (const order of ['B-then-A', 'A-then-B']) {
  test(`real preview/approve path retains B when responses complete ${order}`, async ({ page }) => {
    const capture = {};
    await openApp(page, capture);

    const a = capture.previews[0].correlation;
    const b = capture.previews[1].correlation;
    const messageSession = capture.messageBodies
      .filter(body => body && typeof body.session_id === 'string' && body.session_id)
      .at(-1).session_id;
    expect(messageSession).toBe(capture.previews[0].session_id);
    expect(a.turn_id).toBe(MESSAGE_TURN);
    expect(a.initiation_nonce).toMatch(/^init:/);
    expect(b.turn_id).toBe(MESSAGE_TURN);
    expect(b.initiation_nonce).not.toBe(a.initiation_nonce);
    expect(b.retire_initiation_nonces).toContain(a.initiation_nonce);

    if (order === 'B-then-A') {
      capture.gates[1]();
      capture.gates[0]();
    } else {
      capture.gates[0]();
      capture.gates[1]();
    }

    await expect(page.locator('#approve-btn')).toBeEnabled();
    await page.locator('.rv-save').last().click();
    await expect.poll(() => capture.writes.length).toBe(1);

    expect(capture.writes[0].correlation).toEqual({
      turn_id: MESSAGE_TURN,
      initiation_nonce: b.initiation_nonce,
      pairing_token: TOKEN_B,
    });
    expect(JSON.stringify(capture.writes[0].correlation)).not.toContain(TOKEN_A);
  });
}

test('initiating B synchronously disables staged A approval and an old click emits zero writes', async ({ page }) => {
  const capture = {};
  await openApp(page, capture, { startSecond: false });
  capture.gates[0]();

  await expect(page.locator('.rv-save').last()).toBeEnabled();
  await page.evaluate(() => {
    document.getElementById('workout-text').value = 'done';
    document.getElementById('logger-form').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
  });
  await expect.poll(() => capture.previews.length).toBe(2);

  await expect(page.locator('#approve-btn')).toBeDisabled();
  await page.evaluate(() => document.querySelector('.rv-save')?.click());
  await page.waitForTimeout(100);
  expect(capture.writes).toHaveLength(0);

  capture.gates[1]();
});

test('B can approve while A is pending and late A cannot alter B or emit another write', async ({ page }) => {
  const capture = {};
  await openApp(page, capture);
  const initiationA = capture.previews[0].correlation.initiation_nonce;
  const initiationB = capture.previews[1].correlation.initiation_nonce;

  capture.gates[1]();
  await expect(page.locator('.rv-save').last()).toBeEnabled();
  await page.locator('.rv-save').last().click();
  await expect.poll(() => capture.writes.length).toBe(1);
  expect(capture.writes[0].correlation).toEqual({
    turn_id: MESSAGE_TURN,
    initiation_nonce: initiationB,
    pairing_token: TOKEN_B,
  });

  capture.gates[0]();
  await page.waitForTimeout(200);
  expect(capture.writes).toHaveLength(1);
  expect(capture.writes[0].correlation.initiation_nonce).not.toBe(initiationA);
  expect(capture.writes[0].correlation.pairing_token).toBe(TOKEN_B);
});

for (const delayPoint of ['message-in-flight', 'recommendation-await']) {
test(`closeout waits for the ordinary set turn when delayed at ${delayPoint}`, async ({ page }) => {
  const capture = {
    coachBodies: [],
    messageRoute: null,
    recommendationRoute: null,
    previews: [],
    writes: [],
  };

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'POST' && request.postData()
      && request.headers()['content-type']?.includes('application/json')
      ? request.postDataJSON()
      : null;

    if (path === '/api/coach/ask') {
      capture.coachBodies.push(body);
      return route.fulfill(json(
        { status: 'success', data: { depth: 'log_only', answer: null } },
        200,
        { 'x-atlas-turn-id': TURN },
      ));
    }
    if (path === '/api/coach/chat') {
      capture.coachBodies.push(body);
      return route.fulfill(json(
        { status: 'success', data: { message: 'Use the retained turn.' } },
        200,
        { 'x-atlas-turn-id': TURN },
      ));
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
            canonical_name: 'Bench Press',
            exercise: 'Bench Press',
            sets: [{ weight: 225, reps: 5, rir: 2 }],
          },
        },
      }));
    }
    if (path.startsWith('/api/recommend/next/')
        && delayPoint === 'recommendation-await'
        && capture.recommendationRoute === null) {
      capture.recommendationRoute = route;
      return;
    }
    if (path === '/api/coach/message') {
      capture.messageRoute = route;
      return;
    }
    if (path === '/api/session/compile') {
      return route.fulfill(json({ status: 'success', data: { workout_text: 'bench 225 5/2' } }));
    }
    if (path === '/api/log-workout' && method === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        capture.previews.push(body);
        const rows = (body.log_rows || []).map(r => [
          r.date_clean, r.session_id, r.exercise, r.exercise, 'Chest', 'BEN01',
          r.set_number, r.weight, r.reps, r.rir, r.notes, '',
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
          'x-atlas-turn-id': body.correlation?.turn_id || TURN,
          'x-atlas-turn-pairing': TOKEN_A,
        }));
      }
      capture.writes.push(body);
      return route.fulfill(json({
        status: 'success',
        data: {
          sheet_write: 'success',
          sheet_written: true,
          log_rows_written: (body.log_rows || []).length,
          logAppendedRange: 'Log_Cleaned!A200:L200',
        },
      }));
    }
    if (path === '/api/log-workout/verify-range') {
      return route.fulfill(json({ status: 'success', data: { verified: true } }));
    }
    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({
        status: 'success',
        data: { exercises: [{ canonical_name: 'Bench Press', lift_code: 'BEN01' }] },
      }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });

  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
  await page.evaluate(({ session, text }) => {
    document.getElementById('log-session-id').value = session;
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: { text, context: { session_id: session } },
    }));
  }, { session: SESSION, text: 'How should I finish?' });
  await expect.poll(() => capture.coachBodies.length).toBeGreaterThanOrEqual(2);

  await page.locator('#workout-text').fill('bench 225 5/2');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .readback').last()).toBeVisible();
  if (delayPoint === 'recommendation-await') {
    await expect.poll(() => capture.recommendationRoute !== null).toBeTruthy();
    expect(capture.messageRoute).toBeNull();
  } else {
    await expect.poll(() => capture.messageRoute !== null).toBeTruthy();
  }

  await page.locator('#workout-text').fill('done');
  await page.locator('#preview-btn').click();
  await page.waitForTimeout(150);
  expect(capture.previews).toHaveLength(0);

  if (capture.recommendationRoute) {
    await capture.recommendationRoute.fulfill(json({
      status: 'success',
      data: { recommendation: 'Hold the load.', lift_code: 'BEN01' },
    }));
    await expect.poll(() => capture.messageRoute !== null).toBeTruthy();
  }
  await capture.messageRoute.fulfill(json(
    { status: 'success', data: { message: 'Older set response completed late.' } },
    200,
    { 'x-atlas-turn-id': MESSAGE_TURN },
  ));
  await expect(page.locator('#thread-messages')).toContainText('Older set response completed late.');
  await expect.poll(() => capture.previews.length).toBe(1);
  const previewCorrelation = capture.previews[0].correlation;
  expect(previewCorrelation.turn_id).toBe(MESSAGE_TURN);
  await expect(page.locator('.rv-save').last()).toBeEnabled();
  await page.locator('.rv-save').last().click();
  await expect.poll(() => capture.writes.length).toBe(1);
  expect(capture.writes[0].correlation).toEqual({
    turn_id: MESSAGE_TURN,
    initiation_nonce: previewCorrelation.initiation_nonce,
    pairing_token: TOKEN_A,
  });
});
}

async function openSpecializedPreviewRace(page, capture, path) {
  capture.previews = [];
  capture.writes = [];
  capture.gates = [];
  capture.parseGates = [];
  capture.parseRequests = 0;
  capture.coachBodies = [];

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const requestPath = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'POST' && request.postData() ? request.postDataJSON() : null;

    if (requestPath === '/api/coach/ask') {
      capture.coachBodies.push(body);
      return route.fulfill(json(
        { status: 'success', data: { depth: 'log_only', answer: null } },
        200,
        { 'x-atlas-turn-id': TURN },
      ));
    }
    if (requestPath === '/api/coach/chat') {
      capture.coachBodies.push(body);
      return route.fulfill(json(
        { status: 'success', data: { message: 'Keep going.' } },
        200,
        { 'x-atlas-turn-id': TURN },
      ));
    }
    if (requestPath === '/api/parse-workout-text') {
      const parseIndex = capture.parseRequests++;
      if (capture.holdFirstParse && parseIndex === 0) {
        await new Promise(resolve => capture.parseGates.push(resolve));
      }
      return route.fulfill(json({ status: 'error', error: 'not a resistance log' }, 422));
    }
    if (requestPath === path && method === 'POST') {
      const isPreview = body?.test_mode === true || body?.test_mode === 'true';
      if (!isPreview) {
        capture.writes.push(body);
        return route.fulfill(json({
          status: 'success',
          data: path === '/api/bodyweight'
            ? { sheet_write: 'success', sheet_written: true }
            : { sheet_write: 'success', sheet_written: true, modality_rows_written: 1 },
        }));
      }

      const index = capture.previews.length;
      capture.previews.push(body);
      await new Promise(resolve => capture.gates.push(resolve));
      const token = index === 0 ? TOKEN_A : TOKEN_B;
      const responseData = path === '/api/bodyweight'
        ? {
            test_mode: true,
            sheet_write: 'skipped',
            sheet_written: false,
            no_write_confirmed: true,
            entry_preview: { date: body.date, weight: body.weight, notes: body.notes },
          }
        : {
            test_mode: true,
            sheet_write: 'skipped',
            sheet_written: false,
            no_write_confirmed: true,
            modality: 'cardio_steady',
            modality_row_preview: [
              body.date, body.session_id, 'cardio_steady', body.text,
              1800, 5000, '', '', '', 7, '', '',
            ],
          };
      return route.fulfill(json(
        { status: 'success', data: responseData },
        200,
        {
          'x-atlas-turn-id': body.correlation?.turn_id || TURN,
          'x-atlas-turn-pairing': token,
        },
      ));
    }
    if (requestPath === '/api/catalog/exercises') {
      return route.fulfill(json({ status: 'success', data: { exercises: [] } }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });

  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
  await page.evaluate(session => {
    document.getElementById('log-session-id').value = session;
  }, SESSION);
  await page.evaluate(({ session, text }) => {
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: { text, context: { session_id: session } },
    }));
  }, { session: SESSION, text: 'What should I do next?' });
  await expect.poll(() => capture.coachBodies.length).toBeGreaterThanOrEqual(2);
}

test('real modality path drops a late superseded response before staging approval', async ({ page }) => {
  const capture = {};
  await openSpecializedPreviewRace(page, capture, '/api/log-modality');

  await page.locator('#workout-text').fill('Ran 5km in 30 minutes');
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.previews.length).toBe(1);

  await page.evaluate(() => {
    document.getElementById('workout-text').value = 'Ran 6km in 35 minutes';
    document.getElementById('logger-form').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
  });
  await expect.poll(() => capture.previews.length).toBe(2);

  const a = capture.previews[0].correlation;
  const b = capture.previews[1].correlation;
  expect(b.retire_initiation_nonces).toContain(a.initiation_nonce);
  capture.gates[1]();
  capture.gates[0]();

  await expect(page.locator('#approve-btn')).toBeEnabled();
  await page.locator('#approve-btn').click();
  await expect.poll(() => capture.writes.length).toBe(1);
  expect(capture.writes[0].text).toBe('Ran 6km in 35 minutes');
  expect(capture.writes[0].correlation).toEqual({
    turn_id: TURN,
    initiation_nonce: b.initiation_nonce,
    pairing_token: TOKEN_B,
  });
});

test('real bodyweight path drops a late retired response before staging approval', async ({ page }) => {
  const capture = {};
  await openSpecializedPreviewRace(page, capture, '/api/bodyweight');

  await page.evaluate(() => {
    document.getElementById('bw-date').value = '2026-07-25';
    document.getElementById('bw-weight').value = '180';
    document.getElementById('bw-form').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
  });
  await expect.poll(() => capture.previews.length).toBe(1);

  await page.evaluate(() => {
    document.getElementById('bw-weight').value = '181';
    document.getElementById('bw-form').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
  });
  await expect.poll(() => capture.previews.length).toBe(2);

  const a = capture.previews[0].correlation;
  const b = capture.previews[1].correlation;
  expect(b.retire_initiation_nonces).toContain(a.initiation_nonce);
  capture.gates[1]();
  capture.gates[0]();

  await expect(page.locator('#bw-approve-btn')).toBeEnabled();
  await page.evaluate(() => document.getElementById('bw-approve-btn').click());
  await expect.poll(() => capture.writes.length).toBe(1);
  expect(capture.writes[0].weight).toBe(181);
  expect(capture.writes[0].correlation).toEqual({
    turn_id: TURN,
    initiation_nonce: b.initiation_nonce,
    pairing_token: TOKEN_B,
  });
});

test('a stale question-shaped modality parse cannot fall through to coach after B takes authority', async ({ page }) => {
  const capture = { holdFirstParse: true };
  await openSpecializedPreviewRace(page, capture, '/api/log-modality');
  const coachCountBeforeRace = capture.coachBodies.length;

  await page.locator('#workout-text').fill('How was my 5km run?');
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.parseGates.length).toBe(1);

  await page.evaluate(() => {
    document.getElementById('workout-text').value = 'Ran 6km in 35 minutes';
    document.getElementById('logger-form').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
  });
  await expect.poll(() => capture.previews.length).toBe(1);
  capture.gates[0]();
  await expect(page.locator('#approve-btn')).toBeEnabled();

  // A's delayed slash parse now fails. Because B already owns the submit generation,
  // A must stop before the modality-question early return can route stale coach work.
  capture.parseGates[0]();
  await page.waitForTimeout(500);
  expect(capture.coachBodies).toHaveLength(coachCountBeforeRace);
});

function multipartField(raw, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(raw || '').match(new RegExp(`name="${escaped}"\\r?\\n\\r?\\n([^\\r\\n]*)`));
  return match ? match[1] : null;
}

test('real blank-session screenshot preview adopts the server session and approves its pairing', async ({ page }) => {
  const capture = { coachBodies: [], previews: [], writes: [] };
  let provisionalSessionId = '';
  let resolvedSessionId = '';

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const requestPath = new URL(request.url()).pathname;
    const method = request.method();

    if (requestPath === '/api/coach/ask') {
      capture.coachBodies.push(request.postDataJSON());
      return route.fulfill(json(
        { status: 'success', data: { depth: 'log_only', answer: null } },
        200,
        { 'x-atlas-turn-id': TURN },
      ));
    }
    if (requestPath === '/api/coach/chat') {
      capture.coachBodies.push(request.postDataJSON());
      return route.fulfill(json(
        { status: 'success', data: { message: 'Keep going.' } },
        200,
        { 'x-atlas-turn-id': TURN },
      ));
    }
    if (requestPath === '/api/complete-workout' && method === 'POST') {
      const raw = request.postData() || '';
      const correlationRaw = multipartField(raw, 'correlation');
      const correlation = correlationRaw ? JSON.parse(correlationRaw) : null;
      const isPreview = multipartField(raw, 'test_mode') === 'true';
      const record = {
        raw,
        correlation,
        sessionId: multipartField(raw, 'session_id'),
      };
      if (!isPreview) {
        capture.writes.push(record);
        return route.fulfill(json({
          status: 'success',
          data: {
            data: {
              effort_only: true,
              effort_written: true,
              sheet_write: 'success',
              sheet_written: true,
            },
          },
        }));
      }

      capture.previews.push(record);
      const adoptionAuthorized =
        correlation?.provisional_session_id === provisionalSessionId;
      return route.fulfill(json({
        status: 'success',
        data: {
          data: {
            test_mode: true,
            sheet_write: 'skipped',
            sheet_written: false,
            no_write_confirmed: true,
            effort_only: true,
            session_id: resolvedSessionId,
            date: '2026-07-25',
            date_source: 'screenshot',
            rows_to_write: [],
            parsed_effort: {
              duration: '00:30:00',
              activeCalories: 250,
              totalCalories: 330,
              averageHR: 142,
              peakHR: 165,
              workoutType: 'Outdoor Run',
            },
            duplicate_check: { duplicate_session: false, duplicate_log_rows: 0 },
          },
          warnings: [],
          pending_exercises: [],
        },
      }, 200, adoptionAuthorized ? {
        'x-atlas-turn-id': TURN,
        'x-atlas-turn-pairing': TOKEN_A,
      } : {}));
    }
    if (requestPath === '/api/catalog/exercises') {
      return route.fulfill(json({ status: 'success', data: { exercises: [] } }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });

  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
  provisionalSessionId = await page.evaluate(() => {
    const suffix = new Date().getHours() < 12 ? 'AM' : 'PM';
    return `20260725-${suffix}-01`;
  });
  resolvedSessionId = provisionalSessionId.replace(/-01$/, '-02');

  await page.evaluate(({ session, text }) => {
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: { text, context: { session_id: session } },
    }));
  }, { session: provisionalSessionId, text: 'How should I finish?' });
  await expect.poll(() => capture.coachBodies.length).toBeGreaterThanOrEqual(2);

  await page.evaluate(() => {
    document.querySelector('input[name="effort-mode"][value="screenshot"]').checked = true;
    document.getElementById('log-date').value = '2026-07-25';
    document.getElementById('log-session-id').value = '';
  });
  await page.locator('#effort-image').setInputFiles({
    name: 'watch.png',
    mimeType: 'image/png',
    buffer: Buffer.from('screenshot-fixture'),
  });

  await expect.poll(() => capture.previews.length).toBe(1);
  const previewCorrelation = capture.previews[0].correlation;
  expect(capture.previews[0].sessionId).toBeNull();
  expect(previewCorrelation.provisional_session_id).toBe(provisionalSessionId);
  await expect(page.locator('#approve-btn')).toBeEnabled();
  await page.evaluate(() => document.getElementById('approve-btn').click());
  await expect.poll(() => capture.writes.length).toBe(1);
  expect(capture.writes[0].sessionId).toBe(resolvedSessionId);
  expect(capture.writes[0].correlation).toEqual({
    turn_id: TURN,
    initiation_nonce: previewCorrelation.initiation_nonce,
    pairing_token: TOKEN_A,
  });
});

test('overlapping SME fallthroughs retain the newer chat initiation, not the later fallback start', async ({ page }) => {
  const capture = {
    asks: new Map(),
    chats: new Map(),
    previews: [],
  };

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const requestPath = new URL(request.url()).pathname;
    const method = request.method();

    if (requestPath === '/api/coach/ask') {
      const body = request.postDataJSON();
      capture.asks.set(body.message, route);
      return;
    }
    if (requestPath === '/api/coach/chat') {
      const body = request.postDataJSON();
      capture.chats.set(body.message, route);
      return;
    }
    if (requestPath === '/api/complete-workout' && method === 'POST') {
      const raw = request.postData() || '';
      const correlationRaw = multipartField(raw, 'correlation');
      const correlation = correlationRaw ? JSON.parse(correlationRaw) : null;
      capture.previews.push({ raw, correlation });
      return route.fulfill(json({
        status: 'success',
        data: {
          data: {
            test_mode: true,
            sheet_write: 'skipped',
            sheet_written: false,
            no_write_confirmed: true,
            effort_only: true,
            session_id: SESSION,
            date: '2026-07-25',
            rows_to_write: [],
            parsed_effort: null,
            duplicate_check: { duplicate_session: false, duplicate_log_rows: 0 },
          },
          warnings: [],
          pending_exercises: [],
        },
      }, 200, {
        'x-atlas-turn-id': correlation?.turn_id || CHAT_TURN_B,
        'x-atlas-turn-pairing': TOKEN_B,
      }));
    }
    if (requestPath === '/api/catalog/exercises') {
      return route.fulfill(json({ status: 'success', data: { exercises: [] } }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });

  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
  await page.evaluate(session => {
    document.getElementById('log-session-id').value = session;
  }, SESSION);

  const messageA = 'Give me one short motivation A';
  const messageB = 'Give me one short motivation B';
  await page.evaluate(({ session, messageA, messageB }) => {
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: { text: messageA, context: { session_id: session } },
    }));
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: { text: messageB, context: { session_id: session } },
    }));
  }, { session: SESSION, messageA, messageB });
  await expect.poll(() => capture.asks.size).toBe(2);

  // B's SME check falls through first and starts B's /chat request. A's older SME
  // check then falls through later. A must reuse its older logical-turn ticket rather
  // than minting a fresh fallback ticket that supersedes B.
  await capture.asks.get(messageB).fulfill(json(
    { status: 'success', data: { depth: 'log_only', answer: null } },
    200,
    { 'x-atlas-turn-id': CHAT_TURN_B },
  ));
  await expect.poll(() => capture.chats.has(messageB)).toBeTruthy();
  await capture.asks.get(messageA).fulfill(json(
    { status: 'success', data: { depth: 'log_only', answer: null } },
    200,
    { 'x-atlas-turn-id': CHAT_TURN_A },
  ));
  await expect.poll(() => capture.chats.has(messageA)).toBeTruthy();

  await capture.chats.get(messageB).fulfill(json(
    { status: 'success', data: { message: 'Reply B' } },
    200,
    { 'x-atlas-turn-id': CHAT_TURN_B },
  ));
  await capture.chats.get(messageA).fulfill(json(
    { status: 'success', data: { message: 'Reply A' } },
    200,
    { 'x-atlas-turn-id': CHAT_TURN_A },
  ));
  await expect(page.locator('#thread-messages')).toContainText('Reply B');
  await expect(page.locator('#thread-messages')).toContainText('Reply A');

  await page.evaluate(() => {
    document.querySelector('input[name="effort-mode"][value="manual"]').checked = true;
    document.getElementById('log-date').value = '2026-07-25';
    document.getElementById('log-session-id').value = 'TC-E2E-SESSION';
    const values = {
      'effort-duration': '00:30:00',
      'effort-active-cal': '250',
      'effort-total-cal': '330',
      'effort-avg-hr': '142',
      'effort-peak-hr': '165',
    };
    for (const [id, value] of Object.entries(values)) {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.getElementById('effort-preview-btn').click();
  });
  await expect.poll(() => capture.previews.length).toBe(1);
  expect(capture.previews[0].correlation.turn_id).toBe(CHAT_TURN_B);
});

test('newer closeout screenshot selection survives an older image parse completing last', async ({ page }) => {
  const capture = {
    coachBodies: [],
    messageBodies: [],
    imageGates: [],
    imageCompletions: [],
    imageRequests: 0,
    previews: [],
  };

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const requestPath = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'POST' && request.postData()
      && request.headers()['content-type']?.includes('application/json')
      ? request.postDataJSON()
      : null;

    if (requestPath === '/api/coach/ask') {
      capture.coachBodies.push(body);
      return route.fulfill(json(
        { status: 'success', data: { depth: 'log_only', answer: null } },
        200,
        { 'x-atlas-turn-id': TURN },
      ));
    }
    if (requestPath === '/api/coach/chat') {
      capture.coachBodies.push(body);
      return route.fulfill(json(
        { status: 'success', data: { message: 'Finish the planned set cleanly.' } },
        200,
        { 'x-atlas-turn-id': TURN },
      ));
    }
    if (requestPath === '/api/parse-workout-text') {
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true,
          sheet_written: false,
          no_write_confirmed: true,
          warnings: [],
          parsed: {
            intent: 'log_sets',
            canonical_name: 'Bench Press',
            exercise: 'Bench Press',
            sets: [{ weight: 225, reps: 5, rir: 2 }],
          },
        },
      }));
    }
    if (requestPath === '/api/coach/message') {
      capture.messageBodies.push(body);
      return route.fulfill(json(
        { status: 'success', data: { message: 'That completes the planned work.' } },
        200,
        { 'x-atlas-turn-id': MESSAGE_TURN },
      ));
    }
    if (requestPath === '/api/parse-workout-image') {
      const imageIndex = capture.imageRequests++;
      await new Promise(resolve => capture.imageGates.push(resolve));
      const isNewer = imageIndex === 1;
      capture.imageCompletions.push(isNewer ? 'B' : 'A');
      return route.fulfill(json({
        status: 'success',
        data: {
          parsed: {
            duration: isNewer ? '00:22:00' : '00:11:00',
            activeCalories: isNewer ? 222 : 111,
            totalCalories: isNewer ? 300 : 180,
            averageHR: isNewer ? 142 : 121,
            peakHR: isNewer ? 168 : 145,
            workoutType: isNewer ? 'Newer screenshot B' : 'Older screenshot A',
            date: '2026-07-25',
          },
        },
      }));
    }
    if (requestPath === '/api/log-workout' && method === 'POST') {
      if (body?.test_mode === true || body?.test_mode === 'true') {
        const isScreenshotCloseout = Boolean(body.closeout_context && body.effort_row);
        if (isScreenshotCloseout) capture.previews.push(body);
        const rows = (body.log_rows || []).map(r => [
          r.date_clean, r.session_id, r.exercise, r.exercise, 'Chest', 'BEN01',
          r.set_number, r.weight, r.reps, r.rir, r.notes, '',
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
            effort_row_preview: body.effort_row || null,
          },
        }, 200, {
          'x-atlas-turn-id': body.correlation?.turn_id || MESSAGE_TURN,
          'x-atlas-turn-pairing': !isScreenshotCloseout || capture.previews.length === 1 ? TOKEN_B : TOKEN_A,
        }));
      }
      return route.fulfill(json({ status: 'success', data: { sheet_written: true } }));
    }
    if (requestPath === '/api/session-plans/accept') {
      return route.fulfill(json({
        status: 'success',
        data: { session_plans: { captured: false, reason: 'disabled' } },
      }));
    }
    if (requestPath === '/api/session-plan-sets/accept') {
      return route.fulfill(json({
        status: 'success',
        data: { session_plan_sets: { captured: false, reason: 'disabled' } },
      }));
    }
    if (requestPath === '/api/catalog/exercises') {
      return route.fulfill(json({
        status: 'success',
        data: { exercises: [{ canonical_name: 'Bench Press', lift_code: 'BEN01' }] },
      }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });

  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
  await page.evaluate(({ session, text }) => {
    document.getElementById('log-session-id').value = session;
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: { text, context: { session_id: session } },
    }));
  }, { session: SESSION, text: 'How should I finish this plan?' });
  await expect.poll(() => capture.coachBodies.length).toBeGreaterThanOrEqual(2);

  const started = await page.evaluate(() => window.atlasAcceptPlan({
    id: 'work_day',
    label: 'Work',
    exercises: [{
      exercise: 'Bench Press',
      lift_code: 'BEN01',
      target_weight: 225,
      target_reps: 5,
      target_sets: 1,
      target_rir: 2,
    }],
  }));
  expect(started?.started).toBeTruthy();

  await page.locator('#workout-text').fill('bench 225 5/2');
  await page.locator('#preview-btn').click();
  await expect.poll(() => page.evaluate(() => window.getSessionLog().length)).toBe(1);
  await expect.poll(() => capture.messageBodies.length).toBe(1);
  await expect(page.locator('#thread-messages')).toContainText('That completes the planned work.');

  await page.evaluate(() => {
    const screenshot = document.querySelector('input[name="effort-mode"][value="screenshot"]');
    screenshot.checked = true;
    screenshot.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#effort-image').setInputFiles({
    name: 'older-a.png',
    mimeType: 'image/png',
    buffer: Buffer.from('older-a'),
  });
  await expect.poll(() => capture.imageGates.length).toBe(1);
  await page.locator('#effort-image').setInputFiles({
    name: 'newer-b.png',
    mimeType: 'image/png',
    buffer: Buffer.from('newer-b'),
  });
  await expect.poll(() => capture.imageGates.length).toBe(2);

  capture.imageGates[1]();
  await expect.poll(() => capture.previews.length).toBe(1);
  expect(capture.imageCompletions).toEqual(['B']);
  const newerPreview = capture.previews[0];
  expect(newerPreview.effort_row.active_calories).toBe(222);
  expect(newerPreview.correlation.turn_id).toBe(MESSAGE_TURN);

  capture.imageGates[0]();
  await expect.poll(() => capture.imageCompletions).toEqual(['B', 'A']);
  await page.waitForTimeout(250);
  expect(capture.previews).toHaveLength(1);
  expect(capture.previews[0]).toBe(newerPreview);
});

for (const delayedSubstitution of [
  {
    label: 'implicit substitution',
    message: "I don't want to do squats, give me something else",
    exercise: 'Back Squat',
    liftCode: 'BSQ01',
    replacement: 'Leg Press',
  },
  {
    label: 'constraint suggestion',
    message: 'How is my form?',
    exercise: 'Bench Press',
    liftCode: 'BEN01',
    replacement: 'Incline Bench Press',
  },
]) {
test(`real composer A delayed in ${delayedSubstitution.label} cannot mutate after B modality approval`, async ({ page }) => {
  const capture = {
    chats: [],
    suggestRoute: null,
    previews: [],
    writes: [],
  };

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const requestPath = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === 'POST' && request.postData()
      && request.headers()['content-type']?.includes('application/json')
      ? request.postDataJSON()
      : null;

    if (requestPath === '/api/parse-workout-text') {
      return route.fulfill(json({ status: 'error', error: 'not a resistance log' }, 422));
    }
    if (requestPath === '/api/coach/ask') {
      return route.fulfill(json(
        { status: 'success', data: { depth: 'log_only', answer: null } },
        200,
        { 'x-atlas-turn-id': capture.chats.length === 0 ? TURN : CHAT_TURN_A },
      ));
    }
    if (requestPath === '/api/coach/chat') {
      capture.chats.push(body);
      const isSeed = capture.chats.length === 1;
      return route.fulfill(json(
        { status: 'success', data: { message: isSeed ? 'Seed turn retained.' : 'Older A completed late.' } },
        200,
        { 'x-atlas-turn-id': isSeed ? TURN : CHAT_TURN_A },
      ));
    }
    if (requestPath === '/api/suggest-substitute') {
      if (capture.suggestRoute === null) {
        capture.suggestRoute = route;
        return;
      }
      return route.fulfill(json({ status: 'success', data: { recommendation: null } }));
    }
    if (requestPath === '/api/log-modality' && method === 'POST') {
      const isRun = typeof body?.text === 'string' && body.text.startsWith('Ran ');
      if (!isRun) {
        return route.fulfill(json({ status: 'error', error: 'not a modality log' }, 422));
      }
      if (body?.test_mode === true || body?.test_mode === 'true') {
        capture.previews.push(body);
        return route.fulfill(json({
          status: 'success',
          data: {
            test_mode: true,
            sheet_write: 'skipped',
            sheet_written: false,
            no_write_confirmed: true,
            modality: 'cardio_steady',
            modality_row_preview: [
              body.date, body.session_id, 'cardio_steady', body.text,
              1800, 5000, '', '', '', 7, '', '',
            ],
          },
        }, 200, {
          'x-atlas-turn-id': body.correlation?.turn_id || TURN,
          'x-atlas-turn-pairing': TOKEN_B,
        }));
      }
      capture.writes.push(body);
      return route.fulfill(json({
        status: 'success',
        data: { sheet_write: 'success', sheet_written: true, modality_rows_written: 1 },
      }));
    }
    if (requestPath === '/api/session-plans/accept') {
      return route.fulfill(json({
        status: 'success',
        data: { session_plans: { captured: false, reason: 'disabled' } },
      }));
    }
    if (requestPath === '/api/session-plan-sets/accept') {
      return route.fulfill(json({
        status: 'success',
        data: { session_plan_sets: { captured: false, reason: 'disabled' } },
      }));
    }
    if (requestPath === '/api/catalog/exercises') {
      return route.fulfill(json({
        status: 'success',
        data: {
          exercises: [
            { canonical_name: 'Bench Press', lift_code: 'BEN01' },
            { canonical_name: 'Back Squat', lift_code: 'BSQ01' },
            { canonical_name: 'Leg Press', lift_code: 'LEG01' },
            { canonical_name: 'Incline Bench Press', lift_code: 'IBP01' },
          ],
        },
      }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });

  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
  await page.evaluate(session => {
    document.getElementById('log-session-id').value = session;
    window.__lateSubstitutionEvents = [];
    document.addEventListener('atlas:plan-mutated', event => {
      window.__lateSubstitutionEvents.push({ type: event.type, detail: event.detail });
    });
    document.addEventListener('atlas:substitute-suggested', event => {
      window.__lateSubstitutionEvents.push({ type: event.type, detail: event.detail });
    });
  }, SESSION);

  // Establish the canonical turn through the real composer, not a synthetic chat event.
  await page.locator('#workout-text').fill('How should I finish?');
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.chats.length).toBe(1);

  const started = await page.evaluate(({ exercise, liftCode }) => window.atlasAcceptPlan({
    id: 'race_plan',
    label: 'Race plan',
    exercises: [{
      exercise,
      lift_code: liftCode,
      target_weight: 225,
      target_reps: 5,
      target_sets: 1,
      target_rir: 2,
    }],
  }), delayedSubstitution);
  expect(started?.started).toBeTruthy();

  // A passes modality routing, then stalls inside the real substitute check.
  await page.locator('#workout-text').fill(delayedSubstitution.message);
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.suggestRoute !== null).toBeTruthy();

  // B is initiated later and stages a real modality preview/approval.
  await page.locator('#workout-text').fill('Ran 5km in 30 minutes');
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.previews.length).toBe(1);
  const b = capture.previews[0].correlation;
  await expect(page.locator('#approve-btn')).toBeEnabled();

  // A resumes after B with a SUCCESSFUL substitute response. It must stop before
  // mutating the plan, cursor, pending-substitution sidecar, or B's retained pairing.
  await capture.suggestRoute.fulfill(json({
    status: 'success',
    data: {
      recommendation: {
        recommendation: delayedSubstitution.replacement,
        next_target: { weight: 185, reps: 8, sets: 3, rir: 2 },
      },
    },
  }));
  await page.waitForTimeout(250);
  await expect(page.locator('#approve-btn')).toBeEnabled();
  expect(capture.chats).toHaveLength(1);
  expect(await page.evaluate(() => window.__lateSubstitutionEvents)).toEqual([]);
  await expect(page.locator('#active-session-banner')).toContainText(delayedSubstitution.exercise);
  await expect(page.locator('#active-session-banner')).not.toContainText(delayedSubstitution.replacement);

  await page.locator('#approve-btn').click();
  await expect.poll(() => capture.writes.length).toBe(1);
  expect(capture.writes[0].correlation).toEqual({
    turn_id: TURN,
    initiation_nonce: b.initiation_nonce,
    pairing_token: TOKEN_B,
  });
});
}

async function openStructuredChatRace(page, capture) {
  capture.chatRoutes = new Map();
  capture.chatBodies = [];
  capture.previews = [];
  capture.writes = [];

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const requestPath = new URL(request.url()).pathname;
    const method = request.method();
    const contentType = request.headers()['content-type'] || '';
    const body = method === 'POST' && request.postData() && contentType.includes('application/json')
      ? request.postDataJSON()
      : null;

    if (requestPath === '/api/coach/ask') {
      return route.fulfill(json(
        { status: 'success', data: { depth: 'log_only', answer: null } },
        200,
        { 'x-atlas-turn-id': TURN },
      ));
    }
    if (requestPath === '/api/coach/chat') {
      capture.chatBodies.push(body);
      if (body.message === 'Seed the structured-race turn') {
        return route.fulfill(json(
          { status: 'success', data: { message: 'Seed turn ready.' } },
          200,
          { 'x-atlas-turn-id': TURN },
        ));
      }
      capture.chatRoutes.set(body.message, route);
      return;
    }
    if (requestPath === '/api/parse-workout-text') {
      return route.fulfill(json({
        status: 'success',
        data: {
          test_mode: true,
          sheet_written: false,
          no_write_confirmed: true,
          warnings: [],
          parsed: { intent: 'needs_clarification', message: 'Could not find sets.' },
        },
      }));
    }
    if (requestPath === '/api/log-modality' && method === 'POST') {
      const isRun = typeof body?.text === 'string' && body.text.startsWith('Ran ');
      if (!isRun) return route.fulfill(json({ status: 'error', error: 'not modality' }, 422));
      if (body.test_mode === true || body.test_mode === 'true') {
        capture.previews.push(body);
        return route.fulfill(json({
          status: 'success',
          data: {
            test_mode: true,
            sheet_write: 'skipped',
            sheet_written: false,
            no_write_confirmed: true,
            modality: 'cardio_steady',
            modality_row_preview: [
              body.date, body.session_id, 'cardio_steady', body.text,
              1800, 5000, '', '', '', 7, '', '',
            ],
          },
        }, 200, {
          'x-atlas-turn-id': body.correlation?.turn_id || TURN,
          'x-atlas-turn-pairing': TOKEN_B,
        }));
      }
      capture.writes.push(body);
      return route.fulfill(json({
        status: 'success',
        data: { sheet_write: 'success', sheet_written: true, modality_rows_written: 1 },
      }));
    }
    if (requestPath === '/api/session-plans/accept') {
      return route.fulfill(json({
        status: 'success',
        data: { session_plans: { captured: false, reason: 'disabled' } },
      }));
    }
    if (requestPath === '/api/session-plan-sets/accept') {
      return route.fulfill(json({
        status: 'success',
        data: { session_plan_sets: { captured: false, reason: 'disabled' } },
      }));
    }
    if (requestPath === '/api/catalog/exercises') {
      return route.fulfill(json({
        status: 'success',
        data: {
          exercises: [
            { canonical_name: 'Bench Press', lift_code: 'BEN01' },
            { canonical_name: 'Back Squat', lift_code: 'BSQ01' },
          ],
        },
      }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });

  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
  await page.evaluate(session => {
    document.getElementById('log-session-id').value = session;
    window.__structuredRaceEvents = [];
    document.addEventListener('atlas:plan-edit-proposed', event => {
      window.__structuredRaceEvents.push(event.detail.edit);
    });
  }, SESSION);

  await page.locator('#workout-text').fill('Seed the structured-race turn');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages')).toContainText('Seed turn ready.');
}

test('chat A completing after preview B begins cannot apply a structured set edit', async ({ page }) => {
  const capture = {};
  await openStructuredChatRace(page, capture);
  await page.evaluate(() => addSetRow({
    exercise: 'Bench Press',
    weight: 225,
    reps: 5,
    rir: 2,
  }));

  const messageA = 'change set 1 to 235';
  await page.locator('#workout-text').fill(messageA);
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.chatRoutes.has(messageA)).toBeTruthy();

  await page.locator('#workout-text').fill('Ran 5km in 30 minutes');
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.previews.length).toBe(1);
  const b = capture.previews[0].correlation;
  await expect(page.locator('#approve-btn')).toBeEnabled();

  await capture.chatRoutes.get(messageA).fulfill(json({
    status: 'success',
    data: {
      message: 'A finished after B.',
      propose_edit: { action: 'update_set', index: 0, weight: 235, reps: 5, rir: 2 },
    },
  }, 200, { 'x-atlas-turn-id': CHAT_TURN_A }));
  await expect(page.locator('#thread-messages')).toContainText('A finished after B.');

  await expect(page.locator('.set-weight').first()).toHaveValue('225');
  await expect(page.locator('.edit-applied-note')).toHaveCount(0);
  await expect(page.locator('#approve-btn')).toBeEnabled();
  expect(capture.writes).toHaveLength(0);

  await page.locator('#approve-btn').click();
  await expect.poll(() => capture.writes.length).toBe(1);
  expect(capture.writes[0].correlation).toEqual({
    turn_id: TURN,
    initiation_nonce: b.initiation_nonce,
    pairing_token: TOKEN_B,
  });
});

test('preview B beginning during chat A rendering blocks every stale structured side effect', async ({ page }) => {
  const capture = {};
  await openStructuredChatRace(page, capture);
  const started = await page.evaluate(() => window.atlasAcceptPlan({
    id: 'structured_race_plan',
    label: 'Structured race plan',
    exercises: [{
      exercise: 'Bench Press',
      lift_code: 'BEN01',
      target_weight: 225,
      target_reps: 5,
      target_sets: 1,
      target_rir: 2,
    }],
  }));
  expect(started?.started).toBeTruthy();

  const messageA = 'Could we replace the active plan?';
  await page.locator('#workout-text').fill(messageA);
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.chatRoutes.has(messageA)).toBeTruthy();

  const longReply = `Delayed ${'structured response still typing '.repeat(25)}finished.`;
  await capture.chatRoutes.get(messageA).fulfill(json({
    status: 'success',
    data: {
      message: longReply,
      propose_plan_edit: {
        action: 'replace_plan',
        exercises: [{ name: 'Back Squat', sets: 3, reps: 5, weight: 225, rir: 2 }],
      },
      propose_note: { note: 'stale note must not remain actionable' },
      propose_constraint: {
        kind: 'injury',
        target: 'back squats',
        rule: 'avoid',
        note: 'stale constraint must not remain actionable',
      },
    },
  }, 200, { 'x-atlas-turn-id': CHAT_TURN_A }));
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('Delayed');

  await page.locator('#workout-text').fill('Ran 5km in 30 minutes');
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.previews.length).toBe(1);
  const b = capture.previews[0].correlation;
  await expect(page.locator('#approve-btn')).toBeEnabled();
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('finished.');

  expect(await page.evaluate(() => window.__structuredRaceEvents)).toEqual([]);
  await expect(page.locator('#active-session-banner')).toContainText('Bench Press');
  await expect(page.locator('#active-session-banner')).not.toContainText('Back Squat');
  await expect(page.locator('.propose-note-wrap')).toHaveCount(0);
  await expect(page.locator('.edit-applied-note')).toHaveCount(0);
  await expect(page.locator('#approve-btn')).toBeEnabled();
  expect(capture.writes).toHaveLength(0);

  await page.locator('#approve-btn').click();
  await expect.poll(() => capture.writes.length).toBe(1);
  expect(capture.writes[0].correlation).toEqual({
    turn_id: CHAT_TURN_A,
    initiation_nonce: b.initiation_nonce,
    pairing_token: TOKEN_B,
  });
});

test('session S2 response and preview revoke a still-rendering structured response from S1', async ({ page }) => {
  const capture = {};
  await openStructuredChatRace(page, capture);
  const started = await page.evaluate(() => window.atlasAcceptPlan({
    id: 'cross_session_race_plan',
    label: 'Cross-session race plan',
    exercises: [{
      exercise: 'Bench Press',
      lift_code: 'BEN01',
      target_weight: 225,
      target_reps: 5,
      target_sets: 1,
      target_rir: 2,
    }],
  }));
  expect(started?.started).toBeTruthy();

  const messageA = 'Replace the S1 plan after a long explanation';
  await page.locator('#workout-text').fill(messageA);
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.chatRoutes.has(messageA)).toBeTruthy();
  const longReply = `Cross-session A ${'is still rendering structured output '.repeat(60)}finished.\nBack Squat\n225lbs 5`;
  await capture.chatRoutes.get(messageA).fulfill(json({
    status: 'success',
    data: {
      message: longReply,
      propose_plan_edit: {
        action: 'replace_plan',
        exercises: [{ name: 'Back Squat', sets: 3, reps: 5, weight: 225, rir: 2 }],
      },
    },
  }, 200, { 'x-atlas-turn-id': CHAT_TURN_A }));
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText('Cross-session A');

  const messageB = 'S2 owns the current turn';
  await page.evaluate(({ session, message }) => {
    document.getElementById('log-session-id').value = session;
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: { text: message, context: { session_id: session } },
    }));
  }, { session: OTHER_SESSION, message: messageB });
  await expect.poll(() => capture.chatRoutes.has(messageB)).toBeTruthy();
  await capture.chatRoutes.get(messageB).fulfill(json({
    status: 'success',
    data: { message: 'S2 response selected.' },
  }, 200, { 'x-atlas-turn-id': CHAT_TURN_B }));
  await expect(page.locator('#thread-messages')).toContainText('S2 response selected.');

  await page.locator('#workout-text').fill('Ran 5km in 30 minutes');
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.previews.length).toBe(1);
  const b = capture.previews[0].correlation;
  expect(capture.previews[0].session_id).toBe(OTHER_SESSION);
  expect(b.turn_id).toBe(CHAT_TURN_B);
  await expect(page.locator('#approve-btn')).toBeEnabled();
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('atlas:plan-mutated', {
      detail: { current: 'Bench Press' },
    }));
  });
  await expect(page.locator('#thread-messages .chat-bubble-atlas')
    .filter({ hasText: 'Cross-session A' })).toContainText('finished.', { timeout: 20_000 });

  expect(await page.evaluate(() => window.__structuredRaceEvents)).toEqual([]);
  await expect(page.locator('#workout-text')).toHaveAttribute('placeholder', 'Bench Press');
  await expect(page.locator('#active-session-banner')).toContainText('Bench Press');
  await expect(page.locator('#active-session-banner')).not.toContainText('Back Squat');
  await expect(page.locator('#approve-btn')).toBeEnabled();
  expect(capture.writes).toHaveLength(0);

  await page.locator('#approve-btn').click();
  await expect.poll(() => capture.writes.length).toBe(1);
  expect(capture.writes[0].correlation).toEqual({
    turn_id: CHAT_TURN_B,
    initiation_nonce: b.initiation_nonce,
    pairing_token: TOKEN_B,
  });
});

test('a malformed session that cannot mint a ticket cannot authorize structured output', async ({ page }) => {
  const capture = {};
  await openStructuredChatRace(page, capture);
  await page.evaluate(() => {
    addSetRow({ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2 });
    document.getElementById('log-session-id').value = 'S'.repeat(129);
  });

  const messageA = 'change set 1 to 235 without a valid session ticket';
  await page.locator('#workout-text').fill(messageA);
  await page.locator('#preview-btn').click();
  await expect.poll(() => capture.chatRoutes.has(messageA)).toBeTruthy();
  await capture.chatRoutes.get(messageA).fulfill(json({
    status: 'success',
    data: {
      message: 'Malformed-session response returned.',
      propose_edit: { action: 'update_set', index: 0, weight: 235, reps: 5, rir: 2 },
    },
  }, 200, { 'x-atlas-turn-id': CHAT_TURN_A }));
  await expect(page.locator('#thread-messages')).toContainText('Malformed-session response returned.');

  await expect(page.locator('.set-weight').first()).toHaveValue('225');
  await expect(page.locator('.edit-applied-note')).toHaveCount(0);
  expect(capture.writes).toHaveLength(0);
});
