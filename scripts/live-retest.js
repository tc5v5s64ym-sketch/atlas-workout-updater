#!/usr/bin/env node
'use strict';

// Atlas live-retest harness.
//
// Roadmap (see BACKLOG.md "Live-retest harness"):
//   PR #715 — scaffolding (scenario catalogue, dry-run describe only).   [done]
//   PR #716 — browser bootstrap (THIS slice): launch Playwright, open the
//             deployed Atlas, verify it loads, locate the composer, capture
//             screenshots, exit. READ-ONLY — no save, no writes, no runtime
//             change.
//   PR #717+ — scenario navigation / assertions / library / owner UX.
//
// Safety contract (unchanged): this harness NEVER presses Save, never calls a
// write endpoint, and never writes to Google Sheets. `--dry-run-only` (default
// true) describes the retest without opening a browser. `--dry-run-only false`
// performs the read-only browser bootstrap below. It is NOT a merge gate and NOT
// a replacement for owner judgment.

const fs = require('fs');
const path = require('path');

// --- Scenario catalogue -----------------------------------------------------
// Each entry describes one retest. Sourced from docs/BUG_TRIAGE_LEDGER.md
// (the 🟡 "fixed, live re-test" rows).
const SCENARIOS = {
  'bug-20260629-153258': {
    bugId: 'BUG-20260629-153258',
    purpose: 'Coach "you missed rows" feedback must not dead-end at the generic "coach isn\'t available" message.',
    input: 'After logging a multi-exercise paste, tell Atlas in chat: "you missed a set".',
    expected: 'A natural, productive reply (e.g. "re-type the set and I\'ll log it") even when the LLM is momentarily down; the deterministic engine still owns logging.',
    forbidden: 'Any "couldn\'t reach the coach" / "coach isn\'t available" / "ask again" wording that reveals an LLM outage.',
    reference: 'docs/BUG_TRIAGE_LEDGER.md — coach-fallback pair; trigger fixed by #699/#701, reveal removed in chatFallback.'
  },
  'bug-20260629-153312': {
    bugId: 'BUG-20260629-153312',
    purpose: 'Duplicate of -153258 — confirm the coach-fallback reveal is gone on the "missed rows" path.',
    input: 'Tell Atlas it missed rows after a paste that previously dropped a row.',
    expected: 'Natural mid-session reply; rows are no longer dropped (the underlying trigger is fixed).',
    forbidden: 'The generic "coach isn\'t available" fallback message.',
    reference: 'docs/BUG_TRIAGE_LEDGER.md — dup of -153258.'
  },
  'bug-20260629-003505': {
    bugId: 'BUG-20260629-003505',
    purpose: 'The "restore session" banner tap must actually restore (was a no-op).',
    input: 'Trigger a restorable session, then tap the "restore session" banner.',
    expected: 'The banner is interactive and the prior session is restored on tap.',
    forbidden: 'Tapping the banner does nothing (silent no-op).',
    reference: 'docs/BUG_TRIAGE_LEDGER.md — interactive restore banner, PR #678.'
  },
  'bug-20260629-002945': {
    bugId: 'BUG-20260629-002945',
    purpose: 'A bare bodyweight rep entry ("Knee raises 20 20 20") must surface a confirmation/clarification, not be silently dropped.',
    input: 'Type: "Knee raises 20 20 20".',
    expected: 'Atlas prompts for the bodyweight reps / shows a confirmation path instead of a silent failure.',
    forbidden: 'A silent drop (422 from /api/log-modality with no card and no prompt).',
    reference: 'docs/BUG_TRIAGE_LEDGER.md — knee-raise bodyweight prompt, PR A #680.'
  }
};

// --- Tiny CLI arg parser ----------------------------------------------------
// Supports `--key value` and `--key=value`. Falls back to env vars so the
// GitHub Actions workflow can pass inputs either way.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq !== -1) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[tok.slice(2)] = 'true'; // bare flag
      } else {
        out[tok.slice(2)] = next;
        i += 1;
      }
    }
  }
  return out;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function printScenario(scenarioKey, scenario, { targetBaseUrl, dryRunOnly }) {
  const line = '─'.repeat(72);
  console.log(line);
  console.log(`Atlas live-retest harness — scenario: ${scenarioKey}`);
  console.log(line);
  console.log(`Bug id            : ${scenario.bugId}`);
  console.log(`Purpose           : ${scenario.purpose}`);
  console.log(`Input to type     : ${scenario.input}`);
  console.log(`Expected behavior : ${scenario.expected}`);
  console.log(`Forbidden behavior: ${scenario.forbidden}`);
  console.log(`Reference         : ${scenario.reference}`);
  console.log(line);
  console.log(`Target base URL   : ${targetBaseUrl || '(none provided — set ATLAS_BASE_URL or --target-base-url)'}`);
  console.log(`Mode              : ${dryRunOnly ? 'DRY-RUN (no browser, no live calls, no Sheets writes)' : 'BROWSER BOOTSTRAP (read-only: load + screenshot, never Save)'}`);
  console.log(line);
}

// --- PR #716: read-only browser bootstrap -----------------------------------
// Launch Playwright Chromium, open the deployed Atlas app shell, verify it
// loaded, locate the composer, screenshot, and exit. This NEVER fills the
// composer, never clicks the preview/approve (write) buttons, and never calls a
// write endpoint — it only loads and observes.
async function bootstrapBrowser({ baseUrl, scenarioKey, outputDir }) {
  // Lazy require so dry-run mode never needs Playwright installed.
  const { chromium } = require('@playwright/test');

  // Match playwright.config.js: use the pre-installed Chromium when
  // PLAYWRIGHT_BROWSERS_PATH points at it, otherwise let Playwright resolve.
  const executablePath = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium')
    : undefined;

  const appUrl = `${baseUrl.replace(/\/+$/, '')}/app/`;
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`[bootstrap] launching headless Chromium`);
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  });

  let exitCode = 0;
  let page;
  try {
    // Block service workers so a cached shell can't mask a load failure.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    page = await context.newPage();

    console.log(`[bootstrap] opening ${appUrl}`);
    const response = await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const status = response ? response.status() : 'no-response';
    console.log(`[bootstrap] HTTP status: ${status}`);

    // Verify the app shell loaded by waiting for the composer to be visible.
    const composer = page.locator('#workout-text');
    await composer.waitFor({ state: 'visible', timeout: 15000 });

    const surface = await page.locator('body').getAttribute('data-surface').catch(() => null);
    const placeholder = await composer.getAttribute('placeholder').catch(() => null);
    console.log(`[bootstrap] app loaded — body data-surface="${surface}"`);
    console.log(`[bootstrap] composer located (#workout-text), placeholder="${placeholder}"`);

    // Read-only confirmation: the write trigger should exist and be disabled.
    // We observe it; we never enable or click it.
    const approve = page.locator('#approve-btn');
    const approveDisabled = await approve.isDisabled().catch(() => null);
    console.log(`[bootstrap] write button (#approve-btn) present, disabled=${approveDisabled} (never clicked)`);

    const shot = path.join(outputDir, `${scenarioKey}-app.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`[bootstrap] screenshot saved: ${shot}`);

    console.log('[bootstrap] OK — app loaded and composer located. No interaction, no writes.');
  } catch (err) {
    exitCode = 1;
    console.error(`[bootstrap] FAILED: ${err.message}`);
    // Best-effort failure screenshot for the artifact, if a page exists.
    if (page) {
      try {
        const failShot = path.join(outputDir, `${scenarioKey}-FAILED.png`);
        await page.screenshot({ path: failShot, fullPage: true });
        console.error(`[bootstrap] failure screenshot saved: ${failShot}`);
      } catch { /* ignore screenshot failure */ }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return exitCode;
}

async function run(argv, env = process.env) {
  const args = parseArgs(argv);

  const scenarioKey = (args.scenario || env.SCENARIO || '').trim();
  // Default is the SAFE mode: dry-run / no browser unless explicitly disabled.
  const dryRunOnly = toBool(args['dry-run-only'] !== undefined ? args['dry-run-only'] : env.DRY_RUN_ONLY, true);
  const targetBaseUrl = (args['target-base-url'] || env.TARGET_BASE_URL || env.ATLAS_BASE_URL || '').trim();
  const outputDir = (args['output-dir'] || env.LIVE_RETEST_ARTIFACT_DIR || 'live-retest-artifacts').trim();

  if (!scenarioKey) {
    console.error('ERROR: --scenario is required.');
    console.error(`Valid scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
    return 1;
  }

  const scenario = SCENARIOS[scenarioKey];
  if (!scenario) {
    console.error(`ERROR: unknown scenario "${scenarioKey}".`);
    console.error(`Valid scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
    return 1;
  }

  printScenario(scenarioKey, scenario, { targetBaseUrl, dryRunOnly });

  if (dryRunOnly) {
    console.log('DRY-RUN: nothing was executed. This slice only describes the retest;');
    console.log('the owner runs the real app and decides pass/fail. No browser, no Sheets writes.');
    return 0;
  }

  // Browser bootstrap requires a target to open.
  if (!targetBaseUrl) {
    console.error('ERROR: browser bootstrap needs a target — pass --target-base-url or set ATLAS_BASE_URL.');
    return 1;
  }

  console.log('BROWSER BOOTSTRAP: read-only load + locate + screenshot. Never presses Save.');
  return bootstrapBrowser({ baseUrl: targetBaseUrl, scenarioKey, outputDir });
}

if (require.main === module) {
  run(process.argv.slice(2)).then(code => process.exit(code)).catch(err => {
    console.error(`FATAL: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = { SCENARIOS, parseArgs, toBool, run, bootstrapBrowser };
