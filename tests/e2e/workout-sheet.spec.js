const { test, expect } = require('@playwright/test');

// Workout Sheet — PR-1 (display-only) gesture + render, driven against the REAL built
// client at /app/ with mocked /api. The session pin is the pull handle; pulling it down
// opens the sheet, which renders done/current/pending cards from the canonical
// ActiveSession selectors; the dim tap closes it. No active session → no sheet.

const TEST_KEY = 'playwright-test-key';
function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

async function openApp(page) {
  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', route => route.fulfill(json({ status: 'success', data: {} })));
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');
  await page.waitForLoadState('networkidle');
}

// Start a planned session through the real (e2e-exposed) helper so the pin activates
// and the sheet reads a real ActiveSession — no reordering, display only.
async function startPlan(page) {
  await page.evaluate(() => window.startPlannedSession({
    label: 'Push', id: 'push',
    exercises: [
      { name: 'Bench Press', liftCode: 'BPR01', weight: 225, reps: 5, sets: 4, rir: 2 },
      { name: 'Incline DB Press', liftCode: 'IDP01', weight: 70, reps: 8, sets: 3, rir: 2 },
      { name: 'Overhead Press', liftCode: 'OHP01', weight: 115, reps: 6, sets: 3, rir: 2 },
    ],
  }));
}

// translateY of the sheet in px (negative = pulled up / hidden).
async function sheetTranslateY(page) {
  return page.evaluate(() => {
    const el = document.getElementById('workout-sheet');
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return m.m42;
  });
}

async function pullPinDown(page, distance = 420) {
  const pin = page.locator('#session-pin');
  const box = await pin.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + Math.min(box.height / 2, 12);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 14;
  for (let i = 1; i <= steps; i++) await page.mouse.move(cx, cy + (distance * i) / steps);
  await page.mouse.up();
}

test('CASE A — workout mode: pin carries the pull hint; pull opens the sheet with cards; dim closes it', async ({ page }) => {
  await openApp(page);
  await startPlan(page);

  const pin = page.locator('#session-pin');
  await expect(pin).toBeVisible();
  // The pin doubles as the pull handle and carries the affordance hint.
  await expect(pin.locator('.ws-pin-hint')).toHaveCount(1);

  const sheet = page.locator('#workout-sheet');
  await expect(sheet).toHaveAttribute('aria-hidden', 'true'); // closed initially
  const vh = await page.evaluate(() => document.documentElement.clientHeight);

  await pullPinDown(page);

  // The sheet is OPEN — a real detent, not hidden off-screen.
  await expect(sheet).toHaveClass(/ws-open/);
  await expect(sheet).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#workout-sheet-dim')).toHaveClass(/live/);
  // Settled to a detent that is mostly on-screen (center or full) — poll past the spring.
  await expect.poll(() => sheetTranslateY(page)).toBeGreaterThan(-vh * 0.55);

  // Cards render from the canonical selectors: 3 items, first is CURRENT (none logged),
  // the rest PENDING; none done yet.
  const cards = sheet.locator('.ws-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveClass(/now/);
  await expect(cards.nth(0).locator('.ws-nm')).toHaveText('Bench Press');
  await expect(cards.nth(1)).toHaveClass(/todo/);
  await expect(cards.nth(2)).toHaveClass(/todo/);
  await expect(sheet.locator('.ws-prog')).toContainText('0 of 3');
  // Read-only promise is on-screen.
  await expect(sheet.locator('.ws-note')).toContainText('nothing is written to Sheets');

  // Tap the dim BELOW the open sheet → the sheet closes and slides back off-screen.
  const w = await page.evaluate(() => document.documentElement.clientWidth);
  await page.mouse.click(Math.round(w / 2), Math.round(vh - 30));
  await expect(sheet).toHaveAttribute('aria-hidden', 'true');
  await expect(sheet).not.toHaveClass(/ws-open/);
  await expect.poll(() => sheetTranslateY(page)).toBeLessThan(-vh * 0.8); // slid off-screen (poll past the spring)
});

test('CASE B — no active session: the pin is hidden and the sheet is closed / not openable', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#session-pin')).toBeHidden();
  const sheet = page.locator('#workout-sheet');
  await expect(sheet).toHaveAttribute('aria-hidden', 'true');
  await expect(sheet).not.toHaveClass(/ws-open/);
  // A pointer sequence on the (hidden) pin must not open the sheet — the gesture is
  // gated on workout mode.
  await page.evaluate(() => {
    const pin = document.getElementById('session-pin');
    for (const [type, y] of [['pointerdown', 0], ['pointermove', 200], ['pointerup', 200]]) {
      pin.dispatchEvent(new PointerEvent(type, { clientY: y, bubbles: true }));
    }
  });
  await expect(sheet).toHaveAttribute('aria-hidden', 'true');
});

test('CASE C — reduced motion: the pull still opens the sheet (settle transition disabled, no crash)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  await startPlan(page);
  await pullPinDown(page);
  const sheet = page.locator('#workout-sheet');
  await expect(sheet).toHaveClass(/ws-open/);
  // Under reduced motion the settle transition is suppressed by the media query.
  const transition = await sheet.evaluate(el => getComputedStyle(el).transitionDuration);
  expect(['0s', '0ms']).toContain(transition);
});
