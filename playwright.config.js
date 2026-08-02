const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

// In the Claude Code remote execution environment, PLAYWRIGHT_BROWSERS_PATH is
// set to /opt/pw-browsers but the pre-installed Chromium revision may not match
// the revision @playwright/test expects. Use the stable system symlink when
// PLAYWRIGHT_BROWSERS_PATH is set so the suite runs without a download.
//
// This MUST be applied via `use.launchOptions.executablePath` (below), NOT the
// top-level `use.executablePath` — the latter is not a recognized `use` key on
// @playwright/test 1.60, so it was silently ignored and every spec fell back to the
// default headless-shell revision (which isn't pre-installed here), failing at launch.
// CI never sets PLAYWRIGHT_BROWSERS_PATH (it runs `playwright install`), so this is
// `undefined` there and the override is a no-op — CI browser resolution is unchanged.
const executablePath = process.env.PLAYWRIGHT_BROWSERS_PATH
  ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium')
  : undefined;

module.exports = defineConfig({
  testDir: './tests/e2e',
  // TEMPORARY F-SB4B — REMOVE IN F-SB4C.
  // Exactly one spec talks to a real sandbox workbook and a real provider: the
  // owner-pattern rehearsal runner. It needs credentials CI does not have and must never
  // run in the default lane, which is credential-free and write-free by construction.
  // It is invoked explicitly by `npm run fsb4b:rehearsal`, which is the ONLY thing that
  // sets ATLAS_FSB4B_REHEARSAL=1. Collection is opt-in rather than opt-out, so a plain
  // `playwright test` — with or without a path filter — can never pick it up by accident.
  // When F-SB4C deletes the spec, this exclusion goes with it.
  testIgnore: process.env.ATLAS_FSB4B_REHEARSAL === '1' ? [] : ['**/fsb4b-rehearsal.spec.js'],
  // Every spec in this directory is credential-free and write-free. The temporary Phase 4
  // Stage-A runner — the one spec that talked to a real sandbox workbook and had to be
  // excluded here — was removed under its recorded sunset once Stage A reached 5/5, so
  // there is nothing left to ignore and no posture flag gating collection.
  timeout: 30000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3107',
    serviceWorkers: 'block',
    trace: 'on-first-retry'
  },
  webServer: {
    command: 'node tests/e2e/static-server.js',
    url: 'http://127.0.0.1:3107/app/',
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) }
    },
    {
      name: 'mobile-chromium',
      // iPhone 13 defaults to WebKit; force Chromium so a single browser
      // install covers both projects (locally and in CI). Viewport, touch,
      // and mobile UA are kept from the device descriptor.
      use: { ...devices['iPhone 13'], browserName: 'chromium', ...(executablePath ? { launchOptions: { executablePath } } : {}) }
    }
  ]
});
