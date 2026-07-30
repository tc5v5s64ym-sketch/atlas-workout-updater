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
      forbidden: [/coach.{0,15}(isn'?t|is not|not).{0,15}available/i, /couldn'?t reach/i, /reach the coach/i, /coach[^.]{0,20}unavailable/i],
      // A real fixed reply nudges "re-type the set" — require it so an
      // unauthenticated error toast reads INCONCLUSIVE rather than a false PASS.
      expected: [/re-?type|add it to the preview|log it/i]
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
      forbidden: [/coach.{0,15}(isn'?t|is not|not).{0,15}available/i, /couldn'?t reach/i, /reach the coach/i, /coach[^.]{0,20}unavailable/i],
      // A real fixed reply nudges "re-type the set" — require it so an
      // unauthenticated error toast reads INCONCLUSIVE rather than a false PASS.
      expected: [/re-?type|add it to the preview|log it/i]
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
  },
  'bug-20260629-204817': {
    bugId: 'BUG-20260629-204817',
    purpose: 'A recovery/deload Coach\'s Pick session must not nudge "add load" / "lift more" (recurrence of -034034).',
    input: 'Engage a recovery Coach\'s Pick, log a working set, and read the per-set reaction + the "Next time" prescription.',
    expected: 'Recovery framing; the weight is held — no add-load nudge from either the set reaction or the recommend-next prescription.',
    forbidden: 'Add-load wording: "too much left in the tank" / "bump" / "move to <weight>" / "lift more" / "not lifting enough".',
    reference: 'docs/BUG_TRIAGE_LEDGER.md — recovery-bump recurrence; #704 + getActiveIntentId fallback + recommendNextSet holds weight on a recovery intent.',
    // Multi-step Coach\'s-Pick + recovery flow (engage a suggested recovery
    // session, then log a set) — not a single composer entry, so composer
    // navigation does not apply yet. The bootstrap load + screenshot stands;
    // full flow automation is a later slice. No write either way.
    navigation: { type: 'manual', note: 'recovery Coach\'s-Pick flow is multi-step (engage pick → log a set), not composer-driven — automate in a later slice.' },
    // Forbidden patterns recorded for when this flow becomes automatable; for now
    // the scenario is MANUAL (assertion: null) since the thread isn\'t driven here.
    assertion: null
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

// --- Synthetic provenance ---------------------------------------------------
// docs/AGENT_LIVE_TESTING.md ("Mark every agent request synthetic") requires
// every agent request to carry a recognized synthetic token from
// services/evidenceProvenance.js. `playwright` is the token for browser runs.
// Applied to the whole browser context, so EVERY request the run makes (the
// navigation, the app's XHRs, the preview call) is marked — synthetic traffic
// can never be mistaken for genuine owner activity, and never counts toward
// GATE A / LT owner evidence.
const SYNTHETIC_ORIGIN = 'playwright';
const SYNTHETIC_HEADERS = Object.freeze({ 'x-atlas-request-origin': SYNTHETIC_ORIGIN });

// --- Optional production authentication ------------------------------------
// The login contract (verified against index.js `POST /api/session/login` and
// services/session.js):
//   • request  — JSON body `{ api_key: <credential> }` (the route also accepts an
//                `x-atlas-api-key` header); the server compares it timing-safe
//                against its own configured key.
//   • 503      — durable sessions are not enabled on that server.
//   • 401      — the credential was rejected.
//   • 200      — `Set-Cookie: atlas_session=<token>; Path=/; HttpOnly;
//                SameSite=Lax; Max-Age=<seconds>[; Secure]`.
//
// NOTE ON THE CREDENTIAL NAME: the wire FIELD is `api_key`, but the VALUE comes
// from `ATLAS_ACCESS_CODE` — a dedicated secret. Do not substitute a local
// `ATLAS_API_KEY`: that value has been observed to return 401 against
// production, because it is a different key from the deployment's own. The
// credential is read from the environment ONLY (never a CLI flag, which would
// land in shell history and CI logs).
const ACCESS_CODE_ENV = 'ATLAS_ACCESS_CODE';
const SESSION_COOKIE_NAME = 'atlas_session';

// Defensive redaction. Nothing in this harness intentionally prints the
// credential, but a server error body or a thrown transport error could echo it
// back. Every string that reaches a log, a report, or an artifact passes through
// here first, so the credential cannot leak even by accident.
function redactCredential(text, credential) {
  const s = text === undefined || text === null ? '' : String(text);
  if (!credential) return s;
  return s.split(String(credential)).join('[REDACTED]');
}

// Parse the login response's Set-Cookie into a Playwright cookie object bound to
// the target origin. Pure and value-blind: it never logs the token.
function parseSessionCookie(setCookieHeader, { url, now = Date.now() } = {}) {
  const raw = String(setCookieHeader || '');
  const match = raw.match(new RegExp(`(?:^|,\\s*)${SESSION_COOKIE_NAME}=([^;,]*)`));
  if (!match || !match[1]) return null;
  const attrs = raw.slice(match.index).split(';').map(s => s.trim());
  const maxAge = attrs.map(a => a.match(/^Max-Age=(\d+)$/i)).find(Boolean);
  const cookie = {
    name: SESSION_COOKIE_NAME,
    value: match[1],
    url,
    httpOnly: /;\s*HttpOnly/i.test(raw),
    secure: /;\s*Secure/i.test(raw),
    sameSite: 'Lax'
  };
  if (maxAge) cookie.expires = Math.floor(now / 1000) + Number(maxAge[1]);
  return cookie;
}

// Exchange the access code for a session cookie and seed it into the Playwright
// context. Read-only: login establishes a session, it writes no Sheet data.
//
// Returns a booleans-and-status summary safe to serialize into any artifact:
//   { attempted, authenticated, status, reason }
// It never returns, logs, or embeds the credential or the session token.
async function authenticateContext({
  baseUrl,
  accessCode,
  context,
  fetchImpl = globalThis.fetch,
  logger = console
} = {}) {
  if (!accessCode) {
    // No credential configured — preserve the existing unauthenticated run.
    return { attempted: false, authenticated: false, status: null, reason: 'no_credential' };
  }

  const loginUrl = `${String(baseUrl).replace(/\/+$/, '')}/api/session/login`;
  logger.log('[auth] exchanging the access code for a session cookie (credential never logged)');

  let res;
  try {
    res = await fetchImpl(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...SYNTHETIC_HEADERS },
      body: JSON.stringify({ api_key: accessCode })
    });
  } catch (err) {
    const message = redactCredential(err && err.message ? err.message : err, accessCode);
    logger.error(`[auth] login transport failure: ${message}`);
    return { attempted: true, authenticated: false, status: 0, reason: 'transport_error' };
  }

  const status = res && typeof res.status === 'number' ? res.status : 0;
  if (status !== 200) {
    // Deliberately does NOT include the response body: a server echo could
    // contain the credential. Status alone is enough to diagnose.
    const reason = status === 401 ? 'rejected'
      : status === 503 ? 'sessions_disabled'
        : 'login_failed';
    logger.error(`[auth] login did not establish a session (HTTP ${status}, ${reason})`);
    return { attempted: true, authenticated: false, status, reason };
  }

  const setCookie = res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('set-cookie')
    : null;
  const cookie = parseSessionCookie(setCookie, { url: baseUrl });
  if (!cookie) {
    logger.error('[auth] login returned 200 but no session cookie was present');
    return { attempted: true, authenticated: false, status, reason: 'no_cookie' };
  }

  await context.addCookies([cookie]);
  logger.log(`[auth] session established and seeded into the browser context (cookie ${SESSION_COOKIE_NAME}, httpOnly=${cookie.httpOnly})`);
  return { attempted: true, authenticated: true, status, reason: 'ok' };
}

// Fail-closed navigation decision. When a credential WAS supplied but the
// session could not be established, the run must not quietly continue as an
// anonymous visitor — that would invite a misread of the resulting verdict. It
// stops instead. When no credential was supplied at all, the existing
// unauthenticated run proceeds unchanged and its assertions keep their
// INCONCLUSIVE semantics (an unauthenticated run never manufactures a PASS).
function shouldProceedToNavigation(auth) {
  if (auth && auth.attempted && !auth.authenticated) {
    return { proceed: false, reason: `authentication failed (${auth.reason}) — refusing to continue unauthenticated` };
  }
  return { proceed: true, reason: auth && auth.authenticated ? 'authenticated' : 'unauthenticated (no credential configured)' };
}

// --- Authenticated-content privacy (the repository is PUBLIC) ----------------
// Workflow logs, the step summary, and uploaded artifacts on a public repository
// are world-readable. An AUTHENTICATED run renders the owner's private coaching
// surface, so nothing that surface shows — screenshots, thread text, DOM values,
// response bodies, error echoes — may reach any of those sinks. Only safe
// operational metadata may be emitted: HTTP status, auth success/failure,
// selector presence booleans, verdict, timing, and lengths.
//
// Privacy engages whenever a credential is SUPPLIED, not merely when login
// succeeds, so every path fails closed (a crash mid-run still leaves the marker
// below, and the workflow refuses to upload artifacts unless it can prove the
// marker is absent). Unauthenticated runs are unchanged.
const PRIVACY_MARKER = 'AUTHENTICATED_RUN';

// Drop the marker file the workflow's upload gate reads. Written BEFORE any
// browser work so no failure mode can skip it.
function writePrivacyMarker(outputDir, on) {
  fs.mkdirSync(outputDir, { recursive: true });
  if (on) fs.writeFileSync(path.join(outputDir, PRIVACY_MARKER), 'true\n');
  return Boolean(on);
}

// Classify an error WITHOUT echoing its message: a thrown Playwright error can
// embed page content (and the login path could embed a credential), so on an
// authenticated run only the error's name and a coarse class are reported.
function safeErrorSummary(err) {
  const msg = String((err && err.message) || '');
  const kind = /timeout/i.test(msg) ? 'timeout'
    : /net::|ERR_|ECONN|EAI_|fetch failed/i.test(msg) ? 'network'
      : /locator|selector|element|waiting for/i.test(msg) ? 'selector'
        : /closed/i.test(msg) ? 'closed'
          : 'error';
  return `${(err && err.name) || 'Error'}/${kind} — details withheld (authenticated run on a public repository)`;
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
async function navigateScenario({ page, scenarioKey, scenario, outputDir, privacy = false }) {
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
  if (privacy) {
    console.log(`[navigate] composer populated (screenshot withheld — authenticated run)`);
  } else {
    await page.screenshot({ path: path.join(outputDir, `${scenarioKey}-02-composer.png`), fullPage: true });
    console.log(`[navigate] composer populated; screenshot saved`);
  }

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
  if (privacy) {
    // The thread is the owner's private coaching surface: log only its length.
    // The text itself stays in memory for the assertion and goes nowhere else.
    console.log(`[navigate] thread after preview: (content withheld — authenticated run; length=${threadText.length})`);
    console.log(`[navigate] preview-flow screenshot withheld — authenticated run`);
  } else {
    const preview = threadText.replace(/\s+/g, ' ').trim().slice(0, 240);
    console.log(`[navigate] thread after preview: ${preview ? `"${preview}"` : '(no visible change)'}`);
    await page.screenshot({ path: path.join(outputDir, `${scenarioKey}-03-preview.png`), fullPage: true });
    console.log(`[navigate] preview-flow screenshot saved`);
  }

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
function assertScenario({ scenarioKey, scenario, navResult, outputDir, auth = null, privacy = false }) {
  const a = scenario.assertion;
  const threadText = (navResult && navResult.threadText) || '';
  const haystack = threadText.replace(/\s+/g, ' ').trim();
  // On an authenticated run the thread is private surface content: the result
  // JSON gets NO excerpt, only the explicit authenticated_run flag. The text is
  // still asserted against in memory — the verdict is unaffected.
  const authenticated_run = Boolean(auth && auth.authenticated);
  const excerptOf = (n) => (privacy ? null : haystack.slice(0, n));

  if (!a) {
    const verdict = 'MANUAL';
    writeResult(outputDir, scenarioKey, scenario, { verdict, authenticated_run, forbidden: [], expected: [], threadExcerpt: excerptOf(240) });
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

  writeResult(outputDir, scenarioKey, scenario, { verdict, authenticated_run, forbidden, expected, threadExcerpt: excerptOf(400) });

  console.log(`[assert] ${scenarioKey}: ${verdict}`);
  for (const f of forbidden) console.log(`[assert]   forbidden ${f.matched ? 'PRESENT ✗' : 'absent ✓'}: ${f.pattern}`);
  for (const e of expected) console.log(`[assert]   expected  ${e.matched ? 'present ✓' : 'MISSING …'}: ${e.pattern}`);
  if (verdict === 'INCONCLUSIVE') {
    // The hint must not send the owner to re-run something they already did. An
    // authenticated run's INCONCLUSIVE is NOT a credential problem, so say so.
    console.log(auth && auth.authenticated
      ? '[assert]   (inconclusive — the session WAS authenticated, so this is not a credential problem; the expected reply did not render inside the observed window.)'
      : '[assert]   (inconclusive — likely an unauthenticated run; retest in an authed context for a real PASS/FAIL.)');
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
      expectedBehavior: scenario.expected,
      forbiddenBehavior: scenario.forbidden,
      ...fields,
      // Only list screenshots that actually landed on disk — a MANUAL /
      // non-navigated scenario produces just 01-loaded, not 02/03.
      screenshots: [`${scenarioKey}-01-loaded.png`, `${scenarioKey}-02-composer.png`, `${scenarioKey}-03-preview.png`]
        .filter(name => fs.existsSync(path.join(outputDir, name)))
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
async function bootstrapBrowser({ baseUrl, scenarioKey, outputDir, scenario, accessCode = null }) {
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
  let verdict = 'UNKNOWN';
  let auth = { attempted: false, authenticated: false, status: null, reason: 'no_credential' };
  // Privacy engages on credential PRESENCE (fail closed), not login success.
  const privacy = Boolean(accessCode);
  let page;
  try {
    // Block service workers so a cached shell can't mask a load failure.
    const context = await browser.newContext({ serviceWorkers: 'block' });

    // Every request from this context is marked synthetic (see SYNTHETIC_HEADERS).
    await context.setExtraHTTPHeaders({ ...SYNTHETIC_HEADERS });
    console.log(`[bootstrap] synthetic provenance set on every request: x-atlas-request-origin: ${SYNTHETIC_ORIGIN}`);

    // Authenticate BEFORE the first navigation so the app shell loads as the
    // owner rather than rendering its unauthenticated state first.
    auth = await authenticateContext({ baseUrl, accessCode, context });
    const gate = shouldProceedToNavigation(auth);
    if (!gate.proceed) {
      // `finally` closes the browser; return without navigating.
      console.error(`[bootstrap] ${gate.reason}`);
      return { exitCode: 1, verdict: 'ERROR', auth };
    }
    console.log(`[bootstrap] proceeding — ${gate.reason}`);

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
    if (privacy) {
      // DOM values are private-surface content on an authenticated run: log
      // presence booleans only.
      console.log(`[bootstrap] app loaded — data-surface present=${surface !== null}`);
      console.log(`[bootstrap] composer located (#workout-text), placeholder present=${placeholder !== null}`);
    } else {
      console.log(`[bootstrap] app loaded — body data-surface="${surface}"`);
      console.log(`[bootstrap] composer located (#workout-text), placeholder="${placeholder}"`);
    }

    // Read-only confirmation: the write trigger should exist and be disabled.
    // We observe it; we never enable or click it.
    const approve = page.locator('#approve-btn');
    const approveDisabled = await approve.isDisabled().catch(() => null);
    console.log(`[bootstrap] write button (#approve-btn) present, disabled=${approveDisabled} (never clicked)`);

    if (privacy) {
      console.log('[bootstrap] screenshot withheld — authenticated run on a public repository');
    } else {
      const shot = path.join(outputDir, `${scenarioKey}-01-loaded.png`);
      await page.screenshot({ path: shot, fullPage: true });
      console.log(`[bootstrap] screenshot saved: ${shot}`);
    }
    console.log('[bootstrap] OK — app loaded and composer located.');

    // PR #717: drive the scenario through the composer/preview flow (no Save).
    const navResult = await navigateScenario({ page, scenarioKey, scenario, outputDir, privacy });

    // PR #718: assert the observed thread against the scenario's expected /
    // forbidden patterns. A FAIL (the bug behaviour reappeared) surfaces as a
    // non-zero exit; PASS / INCONCLUSIVE / MANUAL exit 0.
    verdict = assertScenario({ scenarioKey, scenario, navResult, outputDir, auth, privacy });
    if (verdict === 'FAIL') exitCode = 2;

    console.log(`[bootstrap] DONE — read-only retest complete (verdict: ${verdict}). Never pressed Save, no writes.`);
  } catch (err) {
    exitCode = 1;
    verdict = 'ERROR';
    // Authenticated run: a thrown Playwright error can embed page content, so
    // only its name and a coarse class are reported. Unauthenticated: redacted
    // as before (a transport/URL error can carry whatever was in flight).
    console.error(`[bootstrap] FAILED: ${privacy ? safeErrorSummary(err) : redactCredential(err.message, accessCode)}`);
    // Best-effort failure screenshot for the artifact, if a page exists —
    // NEVER on an authenticated run (it would capture the private surface).
    if (page && !privacy) {
      try {
        const failShot = path.join(outputDir, `${scenarioKey}-FAILED.png`);
        await page.screenshot({ path: failShot, fullPage: true });
        console.error(`[bootstrap] failure screenshot saved: ${failShot}`);
      } catch { /* ignore screenshot failure */ }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { exitCode, verdict, auth };
}

async function run(argv, env = process.env) {
  const args = parseArgs(argv);

  const scenarioKey = (args.scenario || env.SCENARIO || '').trim();
  // Default is the SAFE mode: dry-run / no browser unless explicitly disabled.
  const dryRunOnly = toBool(args['dry-run-only'] !== undefined ? args['dry-run-only'] : env.DRY_RUN_ONLY, true);
  const targetBaseUrl = (args['target-base-url'] || env.TARGET_BASE_URL || env.ATLAS_BASE_URL || '').trim();
  const outputDir = (args['output-dir'] || env.LIVE_RETEST_ARTIFACT_DIR || 'live-retest-artifacts').trim();

  if (!scenarioKey) {
    console.error('ERROR: --scenario is required (or use "all").');
    console.error(`Valid scenarios: all, ${Object.keys(SCENARIOS).join(', ')}`);
    return 1;
  }

  // "all" runs every scenario in sequence and prints a summary (PR #719).
  const keys = scenarioKey === 'all' ? Object.keys(SCENARIOS) : [scenarioKey];
  if (scenarioKey !== 'all' && !SCENARIOS[scenarioKey]) {
    console.error(`ERROR: unknown scenario "${scenarioKey}".`);
    console.error(`Valid scenarios: all, ${Object.keys(SCENARIOS).join(', ')}`);
    return 1;
  }

  for (const k of keys) printScenario(k, SCENARIOS[k], { targetBaseUrl, dryRunOnly });

  if (dryRunOnly) {
    console.log('DRY-RUN: nothing was executed. This only describes the retest(s);');
    console.log('the owner runs the real app and decides pass/fail. No browser, no Sheets writes.');
    return 0;
  }

  // Browser bootstrap requires a target to open.
  if (!targetBaseUrl) {
    console.error('ERROR: browser bootstrap needs a target — pass --target-base-url or set ATLAS_BASE_URL.');
    return 1;
  }

  console.log('BROWSER BOOTSTRAP + NAVIGATION + ASSERT: read-only load, populate composer, preview, compare. Never presses Save.');

  // Credential from the environment only — never a CLI flag (shell history / CI
  // logs). Absent is the normal case and keeps the unauthenticated run.
  const accessCode = (env[ACCESS_CODE_ENV] || '').trim() || null;
  console.log(accessCode
    ? `Auth              : ${ACCESS_CODE_ENV} present — will establish a session before loading the app`
    : `Auth              : ${ACCESS_CODE_ENV} absent — unauthenticated run (assertions keep INCONCLUSIVE semantics)`);

  // Fail-closed privacy marker: written BEFORE any browser work whenever a
  // credential is supplied, so a crash mid-run still blocks the workflow's
  // artifact upload. Unauthenticated runs write nothing and are unchanged.
  writePrivacyMarker(outputDir, Boolean(accessCode));
  if (accessCode) {
    console.log('Privacy           : authenticated-content privacy ON — screenshots, thread text, DOM values, and excerpts are withheld; artifact upload is blocked');
  }

  const results = [];
  for (const k of keys) {
    const { exitCode, verdict, auth } = await bootstrapBrowser({ baseUrl: targetBaseUrl, scenarioKey: k, outputDir, scenario: SCENARIOS[k], accessCode });
    results.push({ scenario: k, bugId: SCENARIOS[k].bugId, verdict, exitCode, auth });
  }

  writeSummary(results, outputDir);

  // Exit code: 2 if any retest FAILed (a forbidden/bug pattern reappeared);
  // 1 if any run hit a harness error; otherwise 0.
  if (results.some(r => r.verdict === 'FAIL')) return 2;
  if (results.some(r => r.exitCode === 1)) return 1;
  return 0;
}

// Print a verdict summary table and write summary.json (PR #719 reporting).
function writeSummary(results, outputDir) {
  const line = '─'.repeat(72);
  console.log(line);
  console.log('Live-retest summary');
  console.log(line);
  for (const r of results) {
    console.log(`  ${r.verdict.padEnd(12)} ${r.scenario}  (${r.bugId})`);
  }
  const tally = results.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});
  console.log(line);
  console.log(`  totals: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`);
  console.log(line);
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const authenticated_run = results.some(r => r.auth && r.auth.authenticated);
    fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify({ authenticated_run, results, tally }, null, 2));
    // PR #720: owner-facing markdown report (rendered into the GitHub Actions
    // run summary by the workflow).
    fs.writeFileSync(path.join(outputDir, 'summary.md'),
      buildMarkdownReport(results, { serverUrl: process.env.GITHUB_SERVER_URL, repo: process.env.GITHUB_REPOSITORY }));
  } catch (err) {
    console.error(`could not write summary artifacts: ${err.message}`);
  }
}

// --- PR #720: owner-experience markdown report ------------------------------
// Pure: turns the verdict results into a friendly markdown report for the
// GitHub Actions run summary — a verdict table with BUG-id links, a totals
// line, and a clear read-only / not-a-merge-gate disclaimer.
const VERDICT_ICON = { PASS: '✅', FAIL: '❌', INCONCLUSIVE: '⚠️', MANUAL: '◻️', ERROR: '💥', UNKNOWN: '❔' };

function bugLink(bugId, { serverUrl, repo } = {}) {
  // Link the BUG id to a commit search (finds the fix commits) when running in
  // Actions; otherwise just show the id.
  if (serverUrl && repo) {
    return `[${bugId}](${serverUrl}/${repo}/search?q=${encodeURIComponent(bugId)}&type=commits)`;
  }
  return bugId;
}

function buildMarkdownReport(results, ctx = {}) {
  const lines = [];
  lines.push('## 🏋️ Atlas live-retest report');
  lines.push('');
  lines.push('| Verdict | Bug | Purpose |');
  lines.push('|---|---|---|');
  for (const r of results) {
    const scenario = SCENARIOS[r.scenario] || {};
    const purpose = (scenario.purpose || '').replace(/\|/g, '\\|');
    lines.push(`| ${VERDICT_ICON[r.verdict] || ''} ${r.verdict} | ${bugLink(r.bugId, ctx)} | ${purpose} |`);
  }
  const tally = results.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});
  lines.push('');
  lines.push(`**Totals:** ${Object.entries(tally).map(([k, v]) => `${VERDICT_ICON[k] || ''} ${k}=${v}`).join(' · ') || '(none)'}`);
  lines.push('');
  // Auth posture — booleans only; no credential and no session token.
  const authed = results.some(r => r.auth && r.auth.authenticated);
  const attempted = results.some(r => r.auth && r.auth.attempted);
  lines.push(`**Authenticated run:** ${authed}`);
  lines.push('');
  lines.push(attempted
    ? `**Session:** ${authed ? 'authenticated' : 'authentication FAILED — the run stopped instead of continuing unauthenticated'}.`
    : `**Session:** unauthenticated (no \`${ACCESS_CODE_ENV}\` configured) — an expected reply that needs a session reads ⚠️ INCONCLUSIVE, never ✅ PASS.`);
  if (attempted) {
    lines.push('');
    lines.push('Screenshots, thread text, DOM values, and result excerpts are **withheld** on an authenticated run, and no workflow artifact is uploaded — the repository is public and the authenticated surface is private.');
  }
  lines.push('');
  lines.push(`All traffic is marked synthetic (\`x-atlas-request-origin: ${SYNTHETIC_ORIGIN}\`) and never counts as genuine owner/gym evidence.`);
  lines.push('');
  lines.push('Screenshots and result JSON for each step are attached as the `live-retest-artifacts-*` workflow artifact.');
  lines.push('');
  lines.push('**Verdicts:** ✅ PASS — expected behaviour seen · ⚠️ INCONCLUSIVE — no bug signal but the expected reply didn\'t render (likely an unauthenticated run; retest in an authed context) · ❌ FAIL — a forbidden/bug pattern reappeared · ◻️ MANUAL — needs a hands-on retest (no automatable assertion yet).');
  lines.push('');
  lines.push('> Read-only retest — it never presses Save and never writes to Google Sheets. **Not a merge gate and not a replacement for owner judgment.**');
  lines.push('');
  return lines.join('\n');
}

if (require.main === module) {
  run(process.argv.slice(2)).then(code => process.exit(code)).catch(err => {
    console.error(`FATAL: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = {
  SCENARIOS, parseArgs, toBool, run, bootstrapBrowser, navigateScenario, assertScenario,
  writeSummary, buildMarkdownReport,
  // Synthetic provenance + optional authentication (PR A).
  SYNTHETIC_ORIGIN, SYNTHETIC_HEADERS, ACCESS_CODE_ENV, SESSION_COOKIE_NAME,
  redactCredential, parseSessionCookie, authenticateContext, shouldProceedToNavigation,
  // Authenticated-content privacy (public repository).
  PRIVACY_MARKER, writePrivacyMarker, safeErrorSummary
};
