const { test, expect } = require('@playwright/test');

// Hybrid Coach Compare v1 (dev-only) — Settings → Debug panel. Covers the three
// scoped behaviors: hybrid-only visibility, legacy-mode invisibility, and that
// picking a preference never mutates the displayed recommendation. Pure-function
// coverage (gating, summarizing, storage) lives in test/hybridCompare.test.js;
// this file is the DOM wiring only.

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

const HYBRID_RECOMMENDATION = {
  ...LEGACY_RECOMMENDATION,
  brian: {
    decision_type: 'progression',
    status: 'answered',
    payload: { lift_code: 'BEN01', action: 'hold', target_weight: 225, target_reps: 5, rationale: 'Two clean sessions.' },
    confidence: { score: 82, tier: 'high', action: 'act', caveats: [] },
    safety: { level: 'green', flags: [], blocking: false }
  }
};

// The static test server 501s on /api/**, so stub everything as an empty success
// and layer per-test overrides on top (same pattern as error-keyboard.spec.js).
async function stubApis(page, { coachEngineMode = 'legacy', recommendation = LEGACY_RECOMMENDATION } = {}) {
  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/**', route => route.fulfill(json({ status: 'success', data: {} })));
  await page.route('**/api/debug/config', route => route.fulfill(json({
    status: 'success',
    data: { serviceName: 'atlas-workout-updater', coachEngineMode }
  })));
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

test('Hybrid Coach Compare: card stays hidden in legacy mode', async ({ page }) => {
  await openSettings(page, { coachEngineMode: 'legacy', recommendation: LEGACY_RECOMMENDATION });
  await runCompare(page);
  await expect(page.locator('#hybrid-compare-status')).toContainText('legacy');
  await expect(page.locator('#hybrid-compare-card')).toBeHidden();
});

test('Hybrid Coach Compare: card stays hidden in hybrid mode when no brian decision is attached', async ({ page }) => {
  // ATLAS_COACH_ENGINE=hybrid but the shadow attach didn't validate — index.js
  // omits recommendation.brian entirely in that case.
  await openSettings(page, { coachEngineMode: 'hybrid', recommendation: LEGACY_RECOMMENDATION });
  await runCompare(page);
  await expect(page.locator('#hybrid-compare-card')).toBeHidden();
});

test('Hybrid Coach Compare: card appears with both summaries in hybrid mode', async ({ page }) => {
  await openSettings(page, { coachEngineMode: 'hybrid', recommendation: HYBRID_RECOMMENDATION });
  await runCompare(page);

  await expect(page.locator('#hybrid-compare-card')).toBeVisible();
  await expect(page.locator('#hybrid-compare-legacy')).toContainText('Hold 225 and build cleaner 5s.');
  await expect(page.locator('#hybrid-compare-legacy')).toContainText('target_weight: 225');
  await expect(page.locator('#hybrid-compare-brian')).toContainText('hold');
  await expect(page.locator('#hybrid-compare-brian')).toContainText('target_weight: 225');
});

test('Hybrid Coach Compare: selecting a preference saves feedback without changing the recommendation shown', async ({ page }) => {
  await openSettings(page, { coachEngineMode: 'hybrid', recommendation: HYBRID_RECOMMENDATION });
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
