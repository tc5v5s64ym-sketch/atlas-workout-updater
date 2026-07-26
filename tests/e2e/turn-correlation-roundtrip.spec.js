const { test, expect } = require('@playwright/test');

// #1165 slice 2 — drives the REAL browser coach-header → logger preview → review-card
// approval path. The network is stubbed, but no fixture calls the protocol module or write
// handler directly; a false-green helper that bypasses app.js cannot satisfy these assertions.

const TEST_KEY = 'playwright-test-key';
const SESSION = 'TC-E2E-SESSION';
const TURN = 'turn:2026-07-25T12:00:00.000Z_7_cliente2e';
const MESSAGE_TURN = 'turn:2026-07-25T12:01:00.000Z_8_messagee2e';
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

async function openApp(page, capture) {
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
