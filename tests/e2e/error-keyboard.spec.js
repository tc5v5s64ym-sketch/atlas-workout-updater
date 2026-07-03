const { test, expect } = require('@playwright/test');

// Accessibility, keyboard-navigation, error-state and mobile-overflow coverage.
// These exercise the chrome (hamburger drawer + Progress subnav — the surface
// switcher was retired in Phase D, 2026-07-03) and the validation path — never
// the trust loop, which app-smoke.spec.js owns.

const TEST_KEY = 'playwright-test-key';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

// The static test server 501s on /api/**, so stub everything as an empty success.
// Individual tests override specific endpoints as needed.
async function stubApis(page) {
  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', route => route.fulfill(json({ status: 'success', data: {} })));
}

async function openApp(page) {
  await stubApis(page);
  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
  await expect(page.locator('#workout-text')).toBeVisible();
}

// The Coach hamburger opens the side panel; a Views row routes to the surface.
async function openDrawerNav(page, tab) {
  await page.locator('#coach-menu-btn').click();
  await expect(page.locator('#coach-drawer')).toBeVisible();
  await page.locator(`#coach-drawer .drawer-nav-row[data-tab="${tab}"]`).click();
  await expect(page.locator('#coach-drawer')).toBeHidden();
}

test('subnav exposes ARIA tab semantics; the retired surface switcher is gone', async ({ page }) => {
  await openApp(page);

  // Phase D (2026-07-03): the Coach|Progress segmented control no longer exists.
  await expect(page.locator('.segmented')).toHaveCount(0);
  await expect(page.locator('.surface-btn')).toHaveCount(0);

  await expect(page.locator('#subnav')).toHaveAttribute('role', 'tablist');
  await expect(page.locator('#nav-today')).toHaveAttribute('role', 'tab');

  // Panels are tabpanels, focusable so keyboard users can jump into content.
  await expect(page.locator('#tab-logger')).toHaveAttribute('role', 'tabpanel');
  await expect(page.locator('#tab-dashboard')).toHaveAttribute('role', 'tabpanel');
});

test('drawer: Coach and Progress stay reachable both ways without the switcher', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('body')).toHaveAttribute('data-surface', 'coach');

  await openDrawerNav(page, 'dashboard'); // hamburger → drawer → Progress (Today)
  await expect(page.locator('body')).toHaveAttribute('data-surface', 'progress');
  await expect(page.locator('#tab-dashboard')).toBeVisible();

  await openDrawerNav(page, 'logger');    // and back to the coach
  await expect(page.locator('body')).toHaveAttribute('data-surface', 'coach');
  await expect(page.locator('#workout-text')).toBeVisible();
});

test('keyboard: arrow keys move and activate the Progress subnav', async ({ page }) => {
  await openApp(page);
  await openDrawerNav(page, 'dashboard'); // hamburger → drawer → Progress (Today)
  await expect(page.locator('#tab-dashboard')).toBeVisible();

  const today = page.locator('#nav-today');
  const trends = page.locator('#nav-trends');

  await today.focus();
  await page.keyboard.press('ArrowRight');
  await expect(trends).toBeFocused();
  await expect(trends).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tab-progress')).toBeVisible();
});

test('effort inputs are associated with their labels', async ({ page }) => {
  await openApp(page);
  await expect(page.getByLabel('Duration')).toHaveAttribute('id', 'effort-duration');
  await expect(page.getByLabel('Avg HR')).toHaveAttribute('id', 'effort-avg-hr');
  await expect(page.getByLabel('Peak HR')).toHaveAttribute('id', 'effort-peak-hr');
});

test('empty preview shows a validation hint instead of writing', async ({ page }) => {
  await openApp(page);
  // Parser reports no sets so empty input cannot become rows.
  await page.route('**/api/parse-workout-text', route => route.fulfill(json({
    status: 'success',
    data: { test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
            parsed: { intent: 'needs_clarification', message: 'No sets found.' } }
  })));

  await page.locator('#workout-text').fill('');
  await page.locator('#preview-btn').click();

  await expect(page.locator('#logger-status')).toContainText('Enter workout text first');
  await expect(page.locator('#preview-panel')).toBeHidden();
});

test('mobile: no horizontal overflow at iPhone-13 width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('reduced motion: CSS transitions are disabled', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  const duration = await page.evaluate(() => {
    const el = document.querySelector('.glance-chevron');
    return el ? getComputedStyle(el).transitionDuration : null;
  });
  expect(duration).toBe('0s');
});
