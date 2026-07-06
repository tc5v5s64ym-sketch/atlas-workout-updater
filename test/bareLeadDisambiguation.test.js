'use strict';

// Plan-aware disambiguation of a BARE generic lead exercise term. Owner direction
// (2026-07-06): a short generic name means the plan's unique exercise of that family
// — "seated row is the only row planned, so 'rows' means seated row"; "bench" with
// "Bench Press" planned is bench press, not flat bench; "curls" with "Hammer Curls"
// planned is hammer curls. Only fires on a UNIQUE plan match; otherwise unchanged so
// the existing alias/ask/default behavior stands. Pure function sliced from app.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function loadRewriter() {
  const start = appSrc.indexOf('function bareLeadTokens(');
  const end = appSrc.indexOf('function planNamesForDisambiguation(');
  assert.ok(start !== -1 && end !== -1 && end > start, 'bare-lead helpers must exist in app.js');
  const slice = appSrc.slice(start, end);
  return new Function(`${slice}; return rewriteBareLeadAgainstPlan;`)();
}
const rewrite = loadRewriter();

test('bare "rows" resolves to the only planned row', () => {
  assert.equal(rewrite('rows 95 10/2', ['Seated Row']), 'Seated Row 95 10/2');
  assert.equal(rewrite('row 95 10/2', ['Seated Row']), 'Seated Row 95 10/2'); // singular too
});

test('bare "bench" resolves to planned Bench Press (not flat bench, not asked)', () => {
  assert.equal(rewrite('bench 135 5/2 5/2', ['Bench Press', 'Overhead Press']), 'Bench Press 135 5/2 5/2');
});

test('bare "curls" resolves to the planned curl type', () => {
  assert.equal(rewrite('curls 30 12/2', ['Hammer Curls']), 'Hammer Curls 30 12/2');
  assert.equal(rewrite('curls 30 12/2', ['Bicep Curl']), 'Bicep Curl 30 12/2');
});

test('ambiguous — multiple planned matches → unchanged (existing ask/default stands)', () => {
  assert.equal(rewrite('rows 95 10/2', ['Seated Row', 'Cable Row']), 'rows 95 10/2');
  assert.equal(rewrite('curls 30 12/2', ['Bicep Curl', 'Hammer Curls']), 'curls 30 12/2');
});

test('no planned exercise of that family → unchanged', () => {
  assert.equal(rewrite('rows 95 10/2', ['Bench Press', 'Squat']), 'rows 95 10/2');
  assert.equal(rewrite('curls 30 12/2', []), 'curls 30 12/2');
});

test('an explicit/specific lead is left alone', () => {
  // "hammer curls" is more specific than the planned "Bicep Curl" (not a subset) → no match.
  assert.equal(rewrite('hammer curls 30 12/2', ['Bicep Curl']), 'hammer curls 30 12/2');
  // A lead that already equals the plan entry is a no-op (returned unchanged).
  assert.equal(rewrite('seated row 95 10/2', ['Seated Row']), 'seated row 95 10/2');
});

test('only the leading name is touched; sets and non-log text preserved', () => {
  assert.equal(rewrite('bench 135 10 · warm-up', ['Bench Press']), 'Bench Press 135 10 · warm-up');
  assert.equal(rewrite('just chatting, no sets', ['Bench Press']), 'just chatting, no sets'); // no set number → unchanged
});
