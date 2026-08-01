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
  // The Phase 4 Stage-A canary talks to a REAL sandbox Google Sheet and needs credentials,
  // so it is collected ONLY under the explicit sandbox-live posture that
  // `npm run atlas:stage-a-canary` sets. Default CI — and a bare `npx playwright test` —
  // never collects it, which keeps the default lane credential-free and write-free.
  // The direction is fail-closed: the flag's ABSENCE excludes the file.
  testIgnore: process.env.ATLAS_GATE_SANDBOX_LIVE === '1' ? [] : ['**/stage-a-canary.spec.js'],
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
