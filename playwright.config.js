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

// TEMPORARY F-SB4B scrub (sunset: F-SB4C). The gate specs spawn gate-server.js with
// `{ ...process.env, ... }`, so a rehearsal-configured operator shell (with the
// sandbox-live posture flag exported) would otherwise turn EVERY ordinary gate spec
// into a real-workbook server and write ordinary scenarios to the sandbox outside the
// controlled rehearsal (Codex P1, PR #1251). This config file loads in the Playwright
// runner process — the parent of every spec worker — so deleting the flag here means
// no spec can inherit it, ever. The rehearsal spec does not rely on inheritance: its
// runner sets the flag EXPLICITLY in the env it constructs for its own gate-server
// spawn, from its own opt-in, so this scrub costs it nothing. The permanent posture
// suite pins that this file mentions the flag exactly once — this deletion.
delete process.env.ATLAS_GATE_SANDBOX_LIVE;

module.exports = defineConfig({
  testDir: './tests/e2e',
  // Every spec in this directory is credential-free and write-free under the default
  // lane: the sandbox-live flag is scrubbed above, so `npm run test:e2e` can never
  // reach a workbook regardless of the invoking shell's exports. The temporary F-SB4B
  // rehearsal posture (docs/TESTING_INDEX.md) is reachable only by a launcher that
  // sets the flag explicitly on its own gate-server spawn.
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
