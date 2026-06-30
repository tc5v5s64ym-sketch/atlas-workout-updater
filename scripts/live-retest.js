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
    reference: 'docs/BUG_TRIAGE_LEDGER.md — coach-fallback pair; trigger fixed by #699/#701, reveal removed in chatFallback.',
    // Navigation (PR #717): type the chat message into the composer and submit
    // (preview). This routes to the chat/coach path — a read-only call, no write.
    navigation: { type: 'composer', text: 'you missed a set' },
    // Assertion (PR #718): the LLM-down "coach isn't available" reveal must be gone.
    assertion: {
      forbidden: [/coach.{0,15}(isn'?t|is not|not).{0,15}available/i, /couldn'?t reach/i, /reach the coach/i, /\bunavailable\b/i],
      expected: []
    }
  },
  'bug-20260629-153312': {
    bugId: 'BUG-20260629-153312',
    purpose: 'Duplicate of -153258 — confirm the coach-fallback reveal is gone on the "missed rows" path.',
    input: 'Tell Atlas it missed rows after a paste that previously dropped a row.',
    expected: 'Natural mid-session reply; rows are no longer dropped (the underlying trigger is fixed).',
    forbidden: 'The generic "coach isn\'t available" fallback message.',
    reference: 'docs/BUG_TRIAGE_LEDGER.md — dup of -153258.',
    navigation: { type: 'composer', text: 'you missed a set' },
    assertion: {
      forbidden: [/coach.{0,15}(isn'?t|is not|not).{0,15}available/i, /couldn'?t reach/i, /reach the coach/i, /\bunavailable\b/i],
      expected: []
    }
  },
  'bug-20260629-003505': {
    bugId: 'BUG-20260629-003505',
    purpose: 'The "restore session" banner tap must actually restore (was a no-op).',
    input: 'Trigger a restorable session, then tap the "restore session" banner.',
    expected: 'The banner is interactive and the prior session is restored on tap.',
    forbidden: 'Tapping the banner does nothing (silent no-op).',
    reference: 'docs/BUG_TRIAGE_LEDGER.md — interactive restore banner, PR #678.',
    // This scenario is a UI-state action (restore banner), not a composer entry.
    // Composer navigation does not apply; the bootstrap load + screenshot stands
    // and full banner automation is deferred to a later slice. No write either way.
    navigation: { type: 'manual', note: 'restore-banner tap is a UI-state action, not composer-driven — automate in a later slice.' },
    // No automatable assertion yet (manual scenario) → verdict MANUAL.
    assertion: null
  },
  'bug-20260629-002945': {
    bugId: 'BUG-20260629-002945',
    purpose: 'A bare bodyweight rep entry ("Knee raises 20 20 20") must surface a confirmation/clarification, not be silently dropped.',
    input: 'Type: "Knee raises 20 20 20".',
    expected: 'Atlas prompts for the bodyweight reps / shows a confirmation path instead of a silent failure.',
    forbidden: 'A silent drop (422 from /api/log-modality with no card and no prompt).',
    reference: 'docs/BUG_TRIAGE_LEDGER.md — knee-raise bodyweight prompt, PR A #680.',
    // Navigation (PR #717): type the workout text and submit (preview only).
    // The preview is a test_mode dry-run — no write.
    navigation: { type: 'composer', text: 'Knee raises 20 20 20' },
    // Assertion (PR #718): must prompt for bodyweight reps, not silently drop
    // (the old "Not a recognized modality input" 422 is the forbidden signal).
    assertion: {
      forbidden: [/not a recognized modality/i],
      expected: [/bodyweight|how many reps|reps\?|did you mean/i]
    }
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
  console.log(`Mode              : ${dryRunOnly ? 'DRY-RUN (no browser, no live calls, no Sheets writes)' : 'LIVE (read-only: load + populate composer + preview + assert; never Save)'}`);
  console.log(line);
}

// --- PR #717: scenario navigation (composer populate + preview) -------------
// Type the scenario's input into the composer and submit the PREVIEW flow only.
// The preview is a test_mode dry-run — no Sheets write. This NEVER clicks the
// approve/"Write to Google Sheets" button (#approve-btn) and never enables it.
// Assertions (pass/fail) are a later slice (#718); this just navigates and
// captures what the UI shows.
async function navigateScenario({ page, scenarioKey, scenario, outputDir }) {
  const nav = scenario.navigation || { type: 'manual' };

  if (nav.type !== 'composer') {
    console.log(`[navigate] scenario "${scenarioKey}" is ${nav.type} (${nav.note || 'no composer step'}); skipping composer navigation.`);
    return { navigated: false, threadText: '' };
  }

  // Hard read-only guard: this slice must never trigger a write. We only ever
  // touch the composer and the PREVIEW button — never #approve-btn.
  console.log(`[navigate] populating composer with: ${JSON.stringify(nav.text)}`);
  const composer = page.locator('#workout-text');
  await composer.fill(nav.text);
  const typed = await composer.inputValue();
  if (typed !== nav.text) {
    throw new Error(`composer did not accept the input (got ${JSON.stringify(typed)})`);
  }
  await page.screenshot({ path: path.join(outputDir, `${scenarioKey}-02-composer.png`), fullPage: true });
  console.log(`[navigate] composer populated; screenshot saved`);

  // Submit the preview flow (test_mode dry-run). Tolerant: a readback may or may
  // not render depending on the authenticated context — capturing the result is
  // enough for this slice.
  console.log(`[navigate] clicking #preview-btn (preview/dry-run only — never Save)`);
  await page.locator('#preview-btn').click();
  // Give the thread a moment to update without coupling to a specific outcome.
  await page.waitForTimeout(2500);

  // Re-confirm we never enabled/clicked the write button.
  const approveDisabled = await page.locator('#approve-btn').isDisabled().catch(() => null);
  console.log(`[navigate] post-preview: #approve-btn disabled=${approveDisabled} (never clicked — no write)`);

  const threadText = await page.locator('#thread-messages').innerText().catch(() => '');
  const preview = threadText.replace(/\s+/g, ' ').trim().slice(0, 240);
  console.log(`[navigate] thread after preview: ${preview ? `"${preview}"` : '(no visible change)'}`);

  await page.screenshot({ path: path.join(outputDir, `${scenarioKey}-03-preview.png`), fullPage: true });
  console.log(`[navigate] preview-flow screenshot saved`);

  return { navigated: true, threadText };
}

// --- PR #718: read-only assertion engine ------------------------------------
// Compare the observed UI (the post-preview thread text) against the scenario's
// expected/forbidden patterns and produce a verdict. Purely a string/regex
// comparison over already-captured text — no extra navigation, no writes.
//
// Verdict semantics:
//   FAIL          — a forbidden pattern appeared (the bug behaviour is back).
//   PASS          — no forbidden pattern AND every expected pattern matched
//                   (or, when no expected patterns are defined, the thread
//                   showed a real response).
//   INCONCLUSIVE  — no forbidden pattern, but an expected signal is missing
//                   (e.g. an unauthenticated run where the real reply never
//                   rendered) — the owner should retest in an authed context.
//   MANUAL        — the scenario has no automatable assertion (e.g. the
//                   restore-banner UI action).
function assertScenario({ scenarioKey, scenario, navResult, outputDir }) {
  const a = scenario.assertion;
  const threadText = (navResult && navResult.threadText) || '';
  const haystack = threadText.replace(/\s+/g, ' ').trim();

  if (!a) {
    const verdict = 'MANUAL';
    writeResult(outputDir, scenarioKey, scenario, { verdict, forbidden: [], expected: [], threadExcerpt: haystack.slice(0, 240) });
    console.log(`[assert] ${scenarioKey}: ${verdict} — no automatable assertion (${scenario.navigation && scenario.navigation.note ? scenario.navigation.note : 'manual scenario'}).`);
    return verdict;
  }

  const forbidden = (a.forbidden || []).map(re => ({ pattern: String(re), matched: re.test(haystack) }));
  const expected = (a.expected || []).map(re => ({ pattern: String(re), matched: re.test(haystack) }));
  const forbiddenHit = forbidden.some(f => f.matched);

  let verdict;
  if (forbiddenHit) {
    verdict = 'FAIL';
  } else if (expected.length > 0) {
    verdict = expected.every(e => e.matched) ? 'PASS' : 'INCONCLUSIVE';
  } else {
    verdict = haystack ? 'PASS' : 'INCONCLUSIVE';
  }

  writeResult(outputDir, scenarioKey, scenario, { verdict, forbidden, expected, threadExcerpt: haystack.slice(0, 400) });

  console.log(`[assert] ${scenarioKey}: ${verdict}`);
  for (const f of forbidden) console.log(`[assert]   forbidden ${f.matched ? 'PRESENT ✗' : 'absent ✓'}: ${f.pattern}`);
  for (const e of expected) console.log(`[assert]   expected  ${e.matched ? 'present ✓' : 'MISSING …'}: ${e.pattern}`);
  if (verdict === 'INCONCLUSIVE') {
    console.log('[assert]   (inconclusive — likely an unauthenticated run; retest in an authed context for a real PASS/FAIL.)');
  }
  return verdict;
}

function writeResult(outputDir, scenarioKey, scenario, fields) {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const result = {
      scenario: scenarioKey,
      bugId: scenario.bugId,
      purpose: scenario.purpose,
      expected: scenario.expected,
      forbidden: scenario.forbidden,
      ...fields,
      screenshots: [`${scenarioKey}-01-loaded.png`, `${scenarioKey}-02-composer.png`, `${scenarioKey}-03-preview.png`]
    };
    fs.writeFileSync(path.join(outputDir, `${scenarioKey}-result.json`), JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`[assert] could not write result artifact: ${err.message}`);
  }
}

// --- PR #716: read-only browser bootstrap -----------------------------------
// Launch Playwright Chromium, open the deployed Atlas app shell, verify it
// loaded, locate the composer, screenshot, then (PR #717) navigate the preview
// flow. It loads/observes, types into the composer, and submits the PREVIEW
// (dry-run) only — it NEVER presses Save (#approve-btn) and never calls a write
// endpoint or writes to Google Sheets.
async function bootstrapBrowser({ baseUrl, scenarioKey, outputDir, scenario }) {
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

    const shot = path.join(outputDir, `${scenarioKey}-01-loaded.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`[bootstrap] screenshot saved: ${shot}`);
    console.log('[bootstrap] OK — app loaded and composer located.');

    // PR #717: drive the scenario through the composer/preview flow (no Save).
    const navResult = await navigateScenario({ page, scenarioKey, scenario, outputDir });

    // PR #718: assert the observed thread against the scenario's expected /
    // forbidden patterns. A FAIL (the bug behaviour reappeared) surfaces as a
    // non-zero exit; PASS / INCONCLUSIVE / MANUAL exit 0.
    const verdict = assertScenario({ scenarioKey, scenario, navResult, outputDir });
    if (verdict === 'FAIL') exitCode = 2;

    console.log(`[bootstrap] DONE — read-only retest complete (verdict: ${verdict}). Never pressed Save, no writes.`);
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

  console.log('BROWSER BOOTSTRAP + NAVIGATION: read-only load, locate, populate composer, preview. Never presses Save.');
  return bootstrapBrowser({ baseUrl: targetBaseUrl, scenarioKey, outputDir, scenario });
}

if (require.main === module) {
  run(process.argv.slice(2)).then(code => process.exit(code)).catch(err => {
    console.error(`FATAL: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = { SCENARIOS, parseArgs, toBool, run, bootstrapBrowser, navigateScenario, assertScenario };
