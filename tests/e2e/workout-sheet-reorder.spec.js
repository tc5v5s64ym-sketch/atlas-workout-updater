const { test, expect } = require('@playwright/test');

// Workout Sheet — PR-2 (drag-to-reorder), against the REAL built client with mocked
// /api. PENDING cards carry a ≡ grip (pointer drag) and ▲/▼ controls (non-drag
// fallback); both dispatch the ONE canonical plan mutation (window.reorderPlannedExercise).
// The CURRENT lift and DONE lifts are pinned. The key proof: the drag path yields the
// SAME ActiveSession state as invoking activeSession.reorderExercise directly.

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

// A 4-exercise plan, nothing logged → Bench is CURRENT, the other three are PENDING
// (so there are ≥2 reorderable cards and a pinned current).
async function startPlan(page) {
  await page.evaluate(() => window.startPlannedSession({
    label: 'Push', id: 'push',
    exercises: [
      { name: 'Bench Press', liftCode: 'BPR01', weight: 225, reps: 5, sets: 4, rir: 2 },
      { name: 'Incline DB Press', liftCode: 'IDP01', weight: 70, reps: 8, sets: 3, rir: 2 },
      { name: 'Overhead Press', liftCode: 'OHP01', weight: 115, reps: 6, sets: 3, rir: 2 },
      { name: 'Cable Fly', liftCode: 'CFL01', weight: 40, reps: 12, sets: 3, rir: 1 },
    ],
  }));
}

// Open to the FULL detent so the whole plan (header → last card) is on-screen and every
// card's grip is hittable — at the center detent the sheet's top sits above the viewport.
async function openSheet(page) {
  const pin = page.locator('#session-pin');
  const box = await pin.boundingBox();
  const vh = await page.evaluate(() => document.documentElement.clientHeight);
  const cx = box.x + box.width / 2, cy = box.y + Math.min(box.height / 2, 12);
  const distance = vh + 80;                 // overshoot full → snaps to full (~92%)
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(cx, cy + (distance * i) / 16);
  await page.mouse.up();
  await expect(page.locator('#workout-sheet')).toHaveClass(/ws-open/);
  // Settled at (near) full: the sheet top is on-screen, so the first card is visible.
  await expect.poll(async () => {
    const b = await page.locator('#workout-sheet .ws-card').first().boundingBox();
    return b ? b.y : -1;
  }).toBeGreaterThan(0);
}

const cardNames = page => page.locator('#workout-sheet .ws-card .ws-nm').allTextContents();
const canonicalNames = page => page.evaluate(() => window.getCanonicalSession().exercises.map(e => e.name));

// Drag a card's ≡ grip onto another card (release over the target's vertical centre).
async function dragGripToCard(page, sourceName, targetName) {
  const src = page.locator('.ws-card', { hasText: sourceName }).locator('.ws-grip');
  const tgt = page.locator('.ws-card', { hasText: targetName });
  const g = await src.boundingBox();
  const t = await tgt.boundingBox();
  const gx = g.x + g.width / 2, gy = g.y + g.height / 2;
  const ty = t.y + t.height / 2, tx = t.x + t.width / 2;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(gx + (tx - gx) * i / 10, gy + (ty - gy) * i / 10);
  await page.mouse.up();
}

test('CASE D — dragging a pending card reorders it, and matches the direct canonical mutation', async ({ page }) => {
  await openApp(page);
  await startPlan(page);
  await openSheet(page);

  const sheet = page.locator('#workout-sheet');
  await expect(sheet.locator('.ws-card')).toHaveCount(4);
  expect(await cardNames(page)).toEqual(['Bench Press', 'Incline DB Press', 'Overhead Press', 'Cable Fly']);

  // What activeSession.reorderExercise produces for the SAME logical move (Incline →
  // the pending slot Cable Fly holds) — computed BEFORE the drag, from the same state.
  const expected = await page.evaluate(() => {
    const before = window.getCanonicalSession();
    const destPendingIdx = window.remainingPlannedExercises().indexOf('Cable Fly');
    return window.activeSession.reorderExercise(before, 'Incline DB Press', destPendingIdx).exercises.map(e => e.name);
  });
  expect(expected).toEqual(['Bench Press', 'Overhead Press', 'Cable Fly', 'Incline DB Press']);

  await dragGripToCard(page, 'Incline DB Press', 'Cable Fly');

  // The drag path lands on IDENTICAL ActiveSession state — canonical model AND the
  // rendered order both equal the direct-mutation result. Bench (current) stayed put.
  expect(await canonicalNames(page)).toEqual(expected);
  expect(await cardNames(page)).toEqual(expected);
  await expect(page.locator('.ws-card').first()).toHaveClass(/now/);
  await expect(page.locator('.ws-card').first().locator('.ws-nm')).toHaveText('Bench Press');
  // A toast confirmed the plan change (no Sheets write).
  await expect(sheet.locator('.ws-toast')).toContainText('plan updated');
});

test('CASE E — the ▲/▼ fallback reorders identically; current is pinned (no grip/controls)', async ({ page }) => {
  await openApp(page);
  await startPlan(page);
  await openSheet(page);

  // The CURRENT card is pinned — no drag grip, no move controls.
  const now = page.locator('.ws-card.now');
  await expect(now.locator('.ws-grip')).toHaveCount(0);
  await expect(now.locator('.ws-move')).toHaveCount(0);
  // Every PENDING card is reorderable — grip + up/down controls present.
  const todos = page.locator('.ws-card.todo');
  await expect(todos).toHaveCount(3);
  await expect(todos.first().locator('.ws-grip')).toHaveCount(1);
  await expect(todos.first().locator('.ws-mv')).toHaveCount(2);

  const expected = await page.evaluate(() => {
    const before = window.getCanonicalSession();
    const destPendingIdx = window.remainingPlannedExercises().indexOf('Overhead Press');
    return window.activeSession.reorderExercise(before, 'Incline DB Press', destPendingIdx).exercises.map(e => e.name);
  });
  expect(expected).toEqual(['Bench Press', 'Overhead Press', 'Incline DB Press', 'Cable Fly']);

  // Move Incline DOWN one via the fallback control — same canonical result as the mutation.
  await page.locator('.ws-card', { hasText: 'Incline DB Press' }).locator('.ws-down').click();
  expect(await canonicalNames(page)).toEqual(expected);
  expect(await cardNames(page)).toEqual(expected);
});

test('CASE F — reduced motion: reorder still works (no card transition, no crash)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  await startPlan(page);
  await openSheet(page);

  // The settle/scale transitions are suppressed under reduced motion.
  const dur = await page.locator('.ws-card.todo').first().evaluate(el => getComputedStyle(el).transitionDuration);
  expect(['0s', '0ms']).toContain(dur);

  // The fallback control still reorders (the mutation is instant, just unanimated).
  await page.locator('.ws-card', { hasText: 'Cable Fly' }).locator('.ws-up').click();
  expect(await cardNames(page)).toEqual(['Bench Press', 'Incline DB Press', 'Cable Fly', 'Overhead Press']);
});
