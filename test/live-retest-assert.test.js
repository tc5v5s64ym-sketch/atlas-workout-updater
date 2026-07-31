'use strict';

// Unit coverage for the live-retest assertion engine (scripts/live-retest.js).
// assertScenario is a pure verdict function — this locks the FAIL / PASS /
// INCONCLUSIVE / MANUAL branches so a future change can't silently flip a
// verdict. It writes a result JSON to outputDir; we point that at a temp dir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertScenario, SCENARIOS } = require('../scripts/live-retest');

const TMP = path.join(os.tmpdir(), 'atlas-live-retest-assert');
fs.mkdirSync(TMP, { recursive: true });

function run(scenario, threadText) {
  return assertScenario({
    scenarioKey: 'unit',
    scenario,
    navResult: { navigated: true, threadText },
    outputDir: TMP
  });
}

test('FAIL when a forbidden pattern appears', () => {
  const scenario = { bugId: 'X', assertion: { forbidden: [/coach[^.]{0,20}unavailable/i], expected: [] } };
  assert.equal(run(scenario, 'Sorry, the coach is unavailable right now.'), 'FAIL');
});

test('PASS when no forbidden pattern and a real response rendered (no expected patterns)', () => {
  const scenario = { bugId: 'X', assertion: { forbidden: [/couldn'?t reach/i], expected: [] } };
  assert.equal(run(scenario, 'Re-type the set and I will add it to the preview.'), 'PASS');
});

test('PASS when every expected pattern matches', () => {
  const scenario = { bugId: 'X', assertion: { forbidden: [/not a recognized modality/i], expected: [/bodyweight|reps\?/i] } };
  assert.equal(run(scenario, 'Did you mean bodyweight reps? How many?'), 'PASS');
});

test('INCONCLUSIVE when an expected pattern is missing (no forbidden hit)', () => {
  const scenario = { bugId: 'X', assertion: { forbidden: [/not a recognized modality/i], expected: [/bodyweight|reps\?/i] } };
  assert.equal(run(scenario, 'Noted — keep logging and say "log it" when done.'), 'INCONCLUSIVE');
});

test('INCONCLUSIVE when the thread is empty and no expected patterns are defined', () => {
  const scenario = { bugId: 'X', assertion: { forbidden: [/whatever/i], expected: [] } };
  assert.equal(run(scenario, ''), 'INCONCLUSIVE');
});

test('MANUAL when the scenario has no assertion', () => {
  const scenario = { bugId: 'X', assertion: null };
  assert.equal(run(scenario, 'anything'), 'MANUAL');
});

test('coach-fallback row: generic error → INCONCLUSIVE, real fixed reply → PASS, reveal phrasing → FAIL', () => {
  const real = SCENARIOS['bug-20260629-153258'];
  assert.ok(real && real.assertion, 'scenario + assertion present');
  // A generic "503 Service Unavailable" page is not the bug returning, but it
  // also isn't the real fixed reply → INCONCLUSIVE (not a false PASS).
  assert.equal(run(real, '503 Service Unavailable. Please try later.'), 'INCONCLUSIVE');
  // The real fixed reply ("re-type the set …") → PASS.
  assert.equal(run(real, "If a set didn't make it in, re-type it and I'll add it to the preview."), 'PASS');
  // The actual coach-reveal phrasing → FAIL.
  assert.equal(run(real, "I couldn't reach the coach just now."), 'FAIL');
});

test('writes a result JSON artifact with the verdict', () => {
  const scenario = { bugId: 'BUG-TEST', assertion: { forbidden: [/x/], expected: [] } };
  run(scenario, 'clean response');
  const file = path.join(TMP, 'unit-result.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.verdict, 'PASS');
  assert.equal(parsed.bugId, 'BUG-TEST');
  assert.ok(Array.isArray(parsed.screenshots));
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

// --- PR #720: owner-experience markdown report -------------------------------
const { buildMarkdownReport, writeSummary } = require('../scripts/live-retest');

test('buildMarkdownReport renders a verdict table, totals, links, and the read-only disclaimer', () => {
  const results = [
    { scenario: 'bug-20260629-153258', bugId: 'BUG-20260629-153258', verdict: 'PASS' },
    { scenario: 'bug-20260629-002945', bugId: 'BUG-20260629-002945', verdict: 'INCONCLUSIVE' },
    { scenario: 'bug-20260629-003505', bugId: 'BUG-20260629-003505', verdict: 'MANUAL' }
  ];
  const md = buildMarkdownReport(results, { serverUrl: 'https://github.com', repo: 'o/r' });
  assert.match(md, /Atlas live-retest report/);
  assert.match(md, /\| Verdict \| Bug \| Purpose \|/);
  assert.match(md, /✅ PASS/);
  assert.match(md, /⚠️ INCONCLUSIVE/);
  assert.match(md, /◻️ MANUAL/);
  // BUG id linked to a commit search when server/repo are known.
  assert.match(md, /\[BUG-20260629-153258\]\(https:\/\/github\.com\/o\/r\/search\?q=BUG-20260629-153258&type=commits\)/);
  assert.match(md, /Totals:.*PASS=1.*INCONCLUSIVE=1.*MANUAL=1/);
  // The report must state the CORRECTED safety scope (owner ruling 2026-07-31):
  // no workout/session-state mutation, and explicitly NOT a zero-Sheet-writes
  // claim while synthetic shadow telemetry is still appended.
  assert.match(md, /mutates no workout or session state/);
  // A declared-synthetic run now reaches none of the four shadow tabs, so the
  // report states that instead of the retired "still appends synthetic" disclaimer.
  assert.match(md, /none of the four shadow tabs/);
  assert.doesNotMatch(md, /never writes to Google Sheets/,
    'the retired absolute claim must not reappear');
  assert.match(md, /Not a merge gate/);
});

test('buildMarkdownReport shows the bare BUG id when no Actions context is available', () => {
  const md = buildMarkdownReport([{ scenario: 'x', bugId: 'BUG-1', verdict: 'FAIL' }], {});
  assert.match(md, /❌ FAIL/);
  assert.match(md, /\| BUG-1 \|/);          // plain id, not a markdown link
  assert.doesNotMatch(md, /\[BUG-1\]\(/);
});

test('writeSummary writes both summary.json and summary.md', () => {
  const dir = path.join(TMP, 'sum');
  fs.mkdirSync(dir, { recursive: true });
  writeSummary([{ scenario: 'bug-20260629-002945', bugId: 'BUG-20260629-002945', verdict: 'PASS' }], dir);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  assert.equal(j.tally.PASS, 1);
  const md = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
  assert.match(md, /✅ PASS/);
});
