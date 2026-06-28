'use strict';

// Effort panel submit affordance (owner live-test gap, 2026-06-28).
//
// Manual effort (and the device-screenshot sub-mode) live INSIDE the logger form,
// but the only control that submitted them was the composer's ↑ button. After
// typing manual effort there was no obvious next step — the values "just sat
// there." This adds an "Add effort & preview" button to the effort panel that
// dispatches the SAME logger-form submit the ↑ does, so manual effort + the
// buffered session flow into one preview through the identical
// preview→approve→write path. No new write path; no trust-loop change.
//
// Structural source-introspection tests, matching the repo's frontend-wiring test
// style (jsdom is not a dependency).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const htmlSrc = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

test('html: the effort panel has an "Add effort & preview" submit button', () => {
  assert.match(htmlSrc, /id="effort-preview-btn"/, 'effort-preview-btn must exist');
  assert.match(htmlSrc, /id="effort-preview-btn"[^>]*>Add effort &amp; preview<\/button>/,
    'button label must read "Add effort & preview"');
});

test('html: the button is type="button" so it never acts as a native submit', () => {
  // A native submit would fire the form before our handler can route effort + buffer;
  // we intentionally dispatch the submit ourselves from a plain button.
  const m = htmlSrc.match(/<button[^>]*id="effort-preview-btn"[^>]*>/);
  assert.ok(m, 'effort-preview-btn button tag found');
  assert.match(m[0], /type="button"/, 'effort-preview-btn must be type="button"');
});

test('html: the button lives inside the #effort-details panel', () => {
  const start = htmlSrc.indexOf('id="effort-details"');
  assert.ok(start >= 0, '#effort-details panel exists');
  const end = htmlSrc.indexOf('</details>', start);
  assert.ok(end >= 0, '#effort-details has a closing tag');
  const panel = htmlSrc.slice(start, end);
  assert.match(panel, /id="effort-preview-btn"/,
    'the button must be inside the effort panel, next to the effort fields');
});

test('app: clicking the button dispatches the logger-form submit (reuses the existing path)', () => {
  const idx = appSrc.indexOf("getElementById('effort-preview-btn')");
  assert.ok(idx >= 0, 'app.js must wire the effort-preview-btn click');
  const wiring = appSrc.slice(idx, idx + 320);
  assert.match(wiring, /addEventListener\('click'/, 'must listen for click');
  assert.match(wiring, /getElementById\('logger-form'\)\.dispatchEvent/,
    'must dispatch a submit on the logger-form (same trigger as the composer ↑)');
  assert.match(wiring, /new Event\('submit'/, 'must dispatch a submit event');
});

test('app: the wiring opens NO new write path — it only re-triggers the existing submit', () => {
  const idx = appSrc.indexOf("getElementById('effort-preview-btn')");
  assert.ok(idx >= 0);
  const wiring = appSrc.slice(idx, idx + 320);
  // Guard against drift: this handler must not call a write/preview endpoint itself.
  assert.doesNotMatch(wiring, /\/api\//, 'the button must not call any API directly');
  assert.doesNotMatch(wiring, /approve-btn|appendRows|complete-workout|log-workout/,
    'the button must not touch the write/approve path directly');
});
