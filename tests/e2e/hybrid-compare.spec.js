const { test, expect } = require('@playwright/test');

// Hybrid Coach Compare v1 (dev-only) — Settings → Debug panel. Covers the scoped
// behaviors: hybrid-only visibility, invisibility with no validated Brian decision,
// that picking a preference never mutates the displayed recommendation, and that a
// second Compare click can't race an in-flight one. Pure-function coverage (gating,
// summarizing, storage) lives in test/hybridCompare.test.js; this file is DOM wiring.

const TEST_KEY = 'playwright-test-key';

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

const LEGACY_RECOMMENDATION = {
  liftCode: 'BEN01',
  recommendation: 'Hold 225 and build cleaner 5s.',
  reasoning: 'Two clean sessions at this load.',
  next_target: { weight: 225, reps: 5, sets: 3 },
  target_rir: 2
};

function hybridRecommendation(liftCode = 'BEN01', overrides = {}) {
  return {
    ...LEGACY_RECOMMENDATION,
    liftCode,
    brian: {
      decision_type: 'progression',
      status: 'answered',
      payload: { lift_code: liftCode, action: 'hold', target_weight: 225, target_reps: 5, rationale: 'Two clean sessions.' },
      confidence: { score: 82, tier: 'high', action: 'act', caveats: [] },
      safety: { level: 'green', flags: [], blocking: false }
    },
    ...overrides
  };
}

const HYBRID_RECOMMENDATION = hybridRecommendation();

// The static test server 501s on /api/**, so stub everything as an empty success
// and layer per-test overrides on top (same pattern as error-keyboard.spec.js).
async function stubApis(page, { recommendation = LEGACY_RECOMMENDATION } = {}) {
  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', route => route.fulfill(json({ status: 'success', data: {} })));
  await page.route('**/api/recommend/next/**', route => route.fulfill(json({
    status: 'success',
    data: recommendation
  })));
}

async function openSettings(page, opts) {
  await stubApis(page, opts);
  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
  await expect(page.locator('#workout-text')).toBeVisible();
  // The gear in the standard header (#open-settings) only exists on the Progress
  // surface; the Coach surface (default) reaches Settings via the hamburger drawer.
  await page.locator('#coach-menu-btn').click();
  await expect(page.locator('#coach-drawer')).toBeVisible();
  await page.locator('#drawer-settings').click();
  await expect(page.locator('#hybrid-compare-form')).toBeVisible();
}

async function runCompare(page, liftCode = 'BEN01') {
  await page.locator('#hybrid-compare-liftcode').fill(liftCode);
  await page.locator('#hybrid-compare-form button[type="submit"]').click();
}

test('Hybrid Coach Compare: card stays hidden with no validated Brian decision (legacy mode or unvalidated shadow attach)', async ({ page }) => {
  await openSettings(page, { recommendation: LEGACY_RECOMMENDATION });
  await runCompare(page);
  await expect(page.locator('#hybrid-compare-status')).toContainText('ATLAS_COACH_ENGINE=hybrid');
  await expect(page.locator('#hybrid-compare-card')).toBeHidden();
});

test('Hybrid Coach Compare: card appears with both summaries when recommendation.brian is present', async ({ page }) => {
  await openSettings(page, { recommendation: HYBRID_RECOMMENDATION });
  await runCompare(page);

  await expect(page.locator('#hybrid-compare-card')).toBeVisible();
  await expect(page.locator('#hybrid-compare-legacy')).toContainText('Hold 225 and build cleaner 5s.');
  await expect(page.locator('#hybrid-compare-legacy')).toContainText('target_weight: 225');
  await expect(page.locator('#hybrid-compare-brian')).toContainText('hold');
  await expect(page.locator('#hybrid-compare-brian')).toContainText('target_weight: 225');
});

test('Hybrid Coach Compare: selecting a preference saves feedback without changing the recommendation shown', async ({ page }) => {
  await openSettings(page, { recommendation: HYBRID_RECOMMENDATION });
  await runCompare(page);

  await expect(page.locator('#hybrid-compare-card')).toBeVisible();
  const legacyBefore = await page.locator('#hybrid-compare-legacy').textContent();
  const brianBefore = await page.locator('#hybrid-compare-brian').textContent();

  await page.locator('#hybrid-compare-prefer-brian').click();
  await expect(page.locator('#hybrid-compare-saved')).toContainText('Saved: brian');

  // The displayed summaries are untouched by the preference click — no re-fetch,
  // no mutation, the recommendation itself never changes.
  await expect(page.locator('#hybrid-compare-legacy')).toHaveText(legacyBefore);
  await expect(page.locator('#hybrid-compare-brian')).toHaveText(brianBefore);

  // Persisted to localStorage only — never posted anywhere (dev-only, no write path).
  const stored = await page.evaluate(() => localStorage.getItem('atlas_hybrid_compare_v1'));
  const parsed = JSON.parse(stored);
  expect(parsed.length).toBe(1);
  expect(parsed[0].preference).toBe('brian');
  expect(parsed[0].liftCode).toBe('BEN01');
});

test('Hybrid Coach Compare: the Compare button is disabled while a request is in flight, preventing a racing second click', async ({ page }) => {
  await stubApis(page, { recommendation: HYBRID_RECOMMENDATION });
  // Hold the response open until the test explicitly resolves it, so the button's
  // disabled state can be observed mid-flight — this is the guard that closes the
  // race where a second Compare click for a different lift could otherwise resolve
  // out of order and silently overwrite the first click's (or a later click's) result.
  let resolveRoute;
  const held = new Promise(resolve => { resolveRoute = resolve; });
  await page.route('**/api/recommend/next/**', async route => {
    await held;
    return route.fulfill(json({ status: 'success', data: HYBRID_RECOMMENDATION }));
  });
  await page.addInitScript(key => localStorage.setItem('atlas_api_key', key), TEST_KEY);
  await page.goto('/app/');
  await page.locator('#coach-menu-btn').click();
  await page.locator('#drawer-settings').click();
  await expect(page.locator('#hybrid-compare-form')).toBeVisible();

  const submitBtn = page.locator('#hybrid-compare-form button[type="submit"]');
  await page.locator('#hybrid-compare-liftcode').fill('BEN01');
  await submitBtn.click();

  await expect(submitBtn).toBeDisabled();
  resolveRoute();
  await expect(submitBtn).toBeEnabled();
  await expect(page.locator('#hybrid-compare-card')).toBeVisible();
});
