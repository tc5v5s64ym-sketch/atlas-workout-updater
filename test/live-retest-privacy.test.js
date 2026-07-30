'use strict';

// Authenticated-content privacy for the live-retest harness (P2, 2026-07-30).
//
// The repository is PUBLIC: workflow logs, the step summary, and uploaded
// artifacts are world-readable. An authenticated run renders the owner's
// private coaching surface, so a distinctive private coach message must be
// UNREACHABLE from every publishable sink: console output, generated JSON,
// generated Markdown, screenshots (and their filenames), the workflow's
// artifact inputs, and thrown errors. These tests drive the real functions
// with mock pages/loggers — deterministic, offline, no browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SCENARIOS,
  navigateScenario,
  assertScenario,
  writeSummary,
  buildMarkdownReport,
  writePrivacyMarker,
  safeErrorSummary,
  PRIVACY_MARKER
} = require('../scripts/live-retest');

// Distinctive sentinel standing in for private production coach text.
const PRIVATE = 'PRIVATE-COACH-LINE-zz9-bench-285x3-left-shoulder';

const TMP = path.join(os.tmpdir(), 'atlas-live-retest-privacy');

function freshDir(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Every file in a directory, read as latin1 so PNG-ish binaries scan too.
function dirDump(dir) {
  if (!fs.existsSync(dir)) return { names: [], blob: '' };
  const names = fs.readdirSync(dir);
  const blob = names.map(n => {
    try { return fs.readFileSync(path.join(dir, n), 'latin1'); } catch { return ''; }
  }).join('\n');
  return { names, blob };
}

function captureConsole(fn) {
  const lines = [];
  const realLog = console.log; const realErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  const restore = () => { console.log = realLog; console.error = realErr; };
  return Promise.resolve()
    .then(fn)
    .then(v => { restore(); return { out: lines.join('\n'), value: v }; },
      e => { restore(); throw e; });
}

// A mock page whose thread shows the private message. screenshot() records
// every call so a privacy run can prove zero captures.
function mockPage({ threadText = PRIVATE } = {}) {
  const screenshots = [];
  const locators = {
    '#workout-text': {
      fill: async () => {},
      inputValue: async () => SCENARIOS['bug-20260629-153258'].navigation.text,
      waitFor: async () => {},
      getAttribute: async () => 'Log a set or ask anything…'
    },
    '#preview-btn': { click: async () => {} },
    '#approve-btn': { isDisabled: async () => true },
    '#thread-messages': { innerText: async () => threadText },
    body: { getAttribute: async () => 'coach' }
  };
  return {
    screenshots,
    locator: (sel) => locators[sel] || { getAttribute: async () => null },
    screenshot: async ({ path: p }) => { screenshots.push(p); },
    waitForTimeout: async () => {}
  };
}

const SCN = SCENARIOS['bug-20260629-153258'];
const AUTHED = { attempted: true, authenticated: true, status: 200, reason: 'ok' };

// ── navigateScenario: screenshots and console ────────────────────────────────

test('privacy: navigation takes ZERO screenshots and logs no thread text', async () => {
  const dir = freshDir('nav-priv');
  const page = mockPage();
  const { out, value } = await captureConsole(() =>
    navigateScenario({ page, scenarioKey: 'p1', scenario: SCN, outputDir: dir, privacy: true }));
  assert.equal(page.screenshots.length, 0, 'no screenshot call on an authenticated run');
  assert.ok(!out.includes(PRIVATE), 'console never shows the private message');
  assert.match(out, /content withheld — authenticated run; length=\d+/, 'length-only metadata is logged');
  assert.equal(value.threadText, PRIVATE, 'the text still reaches the in-memory assertion');
  const { names, blob } = dirDump(dir);
  assert.equal(names.length, 0, 'nothing written to the artifact dir by navigation');
  assert.ok(!blob.includes(PRIVATE));
});

test('unauthenticated navigation is unchanged: two screenshots, thread excerpt logged', async () => {
  const dir = freshDir('nav-open');
  const page = mockPage();
  const { out } = await captureConsole(() =>
    navigateScenario({ page, scenarioKey: 'p2', scenario: SCN, outputDir: dir, privacy: false }));
  assert.equal(page.screenshots.length, 2, 'composer + preview screenshots as before');
  assert.ok(out.includes(PRIVATE), 'excerpt logging preserved for the public shell');
});

// ── assertScenario: result JSON ──────────────────────────────────────────────

test('privacy: result JSON has authenticated_run:true and a null threadExcerpt', async () => {
  const dir = freshDir('assert-priv');
  const { out } = await captureConsole(() =>
    assertScenario({
      scenarioKey: 'p3', scenario: SCN,
      navResult: { navigated: true, threadText: PRIVATE },
      outputDir: dir, auth: AUTHED, privacy: true
    }));
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'p3-result.json'), 'utf8'));
  assert.equal(result.authenticated_run, true);
  assert.equal(result.threadExcerpt, null);
  assert.ok(!JSON.stringify(result).includes(PRIVATE), 'JSON never carries the private message');
  assert.ok(!out.includes(PRIVATE), 'assert console lines are pattern-only');
});

test('privacy holds on the MANUAL branch too', async () => {
  const dir = freshDir('assert-manual');
  await captureConsole(() =>
    assertScenario({
      scenarioKey: 'p4', scenario: { bugId: 'X', assertion: null },
      navResult: { navigated: true, threadText: PRIVATE },
      outputDir: dir, auth: AUTHED, privacy: true
    }));
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'p4-result.json'), 'utf8'));
  assert.equal(result.threadExcerpt, null);
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
});

test('unauthenticated result JSON keeps its excerpt and reports authenticated_run:false', async () => {
  const dir = freshDir('assert-open');
  await captureConsole(() =>
    assertScenario({
      scenarioKey: 'p5', scenario: SCN,
      navResult: { navigated: true, threadText: PRIVATE },
      outputDir: dir, auth: null, privacy: false
    }));
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'p5-result.json'), 'utf8'));
  assert.equal(result.authenticated_run, false);
  assert.ok(String(result.threadExcerpt).includes('PRIVATE-COACH-LINE'), 'excerpt preserved when the surface is public');
});

test('the verdict itself is unaffected by privacy (assertion still sees the text)', async () => {
  const dir = freshDir('assert-verdict');
  const passText = "If a set didn't make it in, re-type it and I'll add it to the preview.";
  let verdict;
  await captureConsole(() => {
    verdict = assertScenario({
      scenarioKey: 'p6', scenario: SCN,
      navResult: { navigated: true, threadText: passText },
      outputDir: dir, auth: AUTHED, privacy: true
    });
  });
  assert.equal(verdict, 'PASS');
});

// ── summary.json / summary.md / step summary ─────────────────────────────────

test('summary.json and summary.md carry authenticated_run and no private content', async () => {
  const dir = freshDir('summary');
  const results = [{ scenario: 'bug-20260629-153258', bugId: SCN.bugId, verdict: 'PASS', exitCode: 0, auth: AUTHED }];
  await captureConsole(() => writeSummary(results, dir));
  const json = fs.readFileSync(path.join(dir, 'summary.json'), 'utf8');
  const md = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
  assert.equal(JSON.parse(json).authenticated_run, true, 'explicit report field present');
  assert.match(md, /\*\*Authenticated run:\*\* true/, 'explicit report field in markdown');
  assert.match(md, /withheld/i, 'markdown states the privacy posture');
  for (const s of [json, md]) assert.ok(!s.includes(PRIVATE), 'no private content in reports');
});

test('buildMarkdownReport output is built only from repo data + auth booleans', () => {
  const md = buildMarkdownReport(
    [{ scenario: 'bug-20260629-153258', bugId: SCN.bugId, verdict: 'INCONCLUSIVE', exitCode: 0, auth: AUTHED }], {});
  assert.ok(!md.includes(PRIVATE));
  assert.match(md, /\*\*Authenticated run:\*\* true/);
});

test('an unauthenticated summary reports authenticated_run:false and keeps prior shape', async () => {
  const dir = freshDir('summary-open');
  const results = [{ scenario: 'bug-20260629-153258', bugId: SCN.bugId, verdict: 'PASS', exitCode: 0, auth: { attempted: false, authenticated: false } }];
  await captureConsole(() => writeSummary(results, dir));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')).authenticated_run, false);
  assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /\*\*Authenticated run:\*\* false/);
});

// ── the workflow's artifact input: the fail-closed marker ───────────────────

test('the privacy marker is written when a credential is supplied, absent otherwise', () => {
  const dir = freshDir('marker');
  writePrivacyMarker(dir, true);
  assert.ok(fs.existsSync(path.join(dir, PRIVACY_MARKER)), 'marker present — workflow skips upload');
  const dir2 = freshDir('marker-off');
  writePrivacyMarker(dir2, false);
  assert.ok(!fs.existsSync(path.join(dir2, PRIVACY_MARKER)), 'no marker — unauthenticated upload unchanged');
});

// ── thrown errors ────────────────────────────────────────────────────────────

test('safeErrorSummary never echoes the error message (private text or credential)', () => {
  const err = new Error(`Timeout 15000ms exceeded while waiting for text "${PRIVATE}" with code SENTINEL-cred-77`);
  const summary = safeErrorSummary(err);
  assert.ok(!summary.includes(PRIVATE));
  assert.ok(!summary.includes('SENTINEL-cred-77'));
  assert.match(summary, /^Error\/timeout — details withheld/);
});

test('safeErrorSummary classifies without content: network, selector, closed, other', () => {
  assert.match(safeErrorSummary(new Error(`net::ERR_CONNECTION_RESET at ${PRIVATE}`)), /\/network /);
  assert.match(safeErrorSummary(new Error(`locator resolved to hidden ${PRIVATE}`)), /\/selector /);
  assert.match(safeErrorSummary(new Error('Target page, context or browser has been closed')), /\/closed /);
  assert.ok(!safeErrorSummary(new Error(PRIVATE)).includes(PRIVATE));
});

// ── end-to-end sweep over everything a privacy run wrote ────────────────────

test('sweep: nothing any privacy-mode function wrote contains the private message', () => {
  const { names, blob } = dirDump(path.join(TMP, 'assert-priv'));
  assert.ok(names.length > 0, 'the privacy assert test produced files to sweep');
  assert.ok(!blob.includes(PRIVATE));
  for (const n of names) assert.ok(!n.includes('PRIVATE'), 'no private content in filenames');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
