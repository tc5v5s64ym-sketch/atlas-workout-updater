const { defineConfig, devices } = require('@playwright/test');

// In the Claude Code remote execution environment, PLAYWRIGHT_BROWSERS_PATH is
// set to /opt/pw-browsers but the pre-installed Chromium revision may not match
// the revision @playwright/test expects. Use the stable system symlink when
// PLAYWRIGHT_BROWSERS_PATH is set so the suite runs without a download.
const executablePath = process.env.PLAYWRIGHT_BROWSERS_PATH
  ? '/opt/pw-browsers/chromium'
  : undefined;

module.exports = defineConfig({
  testDir: './tests/e2e',
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
      use: { ...devices['Desktop Chrome'], ...(executablePath ? { executablePath } : {}) }
    },
    {
      name: 'mobile-chromium',
      // iPhone 13 defaults to WebKit; force Chromium so a single browser
      // install covers both projects (locally and in CI). Viewport, touch,
      // and mobile UA are kept from the device descriptor.
      use: { ...devices['iPhone 13'], browserName: 'chromium', ...(executablePath ? { executablePath } : {}) }
    }
  ]
});
