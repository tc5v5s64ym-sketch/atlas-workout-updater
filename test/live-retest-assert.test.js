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
