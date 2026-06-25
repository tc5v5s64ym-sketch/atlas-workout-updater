const { test } = require('node:test');
const assert = require('node:assert/strict');

const { stripFabricatedUnits } = require('../services/coach');

// G4 (live 2026-06-25): the coach rendered "70kg" / "best of 50kg" for lb data —
// the model fabricated a unit against an explicit "numbers only, no units" prompt.
// The deterministic guard strips any weight-unit token the model emits, AFTER
// generation, at the single coach-output chokepoint (callGeminiContents). The prompt
// is NOT the fix; this guard enforces the numbers-only contract regardless of model.

// --- strips fabricated weight units, keeps the number + sentence ---

test('strips a fabricated kg unit attached to a weight', () => {
  assert.equal(stripFabricatedUnits('You hit 70kg today'), 'You hit 70 today');
  assert.equal(stripFabricatedUnits('past your previous best of 50kg'), 'past your previous best of 50');
  assert.equal(stripFabricatedUnits('50 kg'), '50');
});

test('strips lb / pounds / kilogram variants (with or without a space)', () => {
  assert.equal(stripFabricatedUnits('lifted 225 lbs'), 'lifted 225');
  assert.equal(stripFabricatedUnits('225lb'), '225');
  assert.equal(stripFabricatedUnits('a clean 100 pounds'), 'a clean 100');
  assert.equal(stripFabricatedUnits('1 pound'), '1');
  assert.equal(stripFabricatedUnits('100 kilograms'), '100');
  assert.equal(stripFabricatedUnits('100 kilos'), '100');
});

test('preserves the number, decimals, and trailing punctuation', () => {
  assert.equal(stripFabricatedUnits('52.5kg felt smooth'), '52.5 felt smooth');
  assert.equal(stripFabricatedUnits('best of 50kg.'), 'best of 50.');
  assert.equal(stripFabricatedUnits('hit 50 kg, then more'), 'hit 50, then more');
});

test('strips every occurrence in one note', () => {
  assert.equal(
    stripFabricatedUnits('add 5 lbs to your 225 lbs working weight'),
    'add 5 to your 225 working weight'
  );
});

// --- false-positive guards: must NOT alter non-weight numbers or ordinary words ---

test('does not touch rep / RIR / set counts', () => {
  const s = 'Solid 5 reps at RIR 2 across 3 sets';
  assert.equal(stripFabricatedUnits(s), s);
});

test('does not touch percentages, calories, HR, dates, or durations', () => {
  const s = '85% of your max, 476 cal, 159 bpm, on 2026-06-25, total 01:10:44';
  assert.equal(stripFabricatedUnits(s), s);
});

test('does not strip unit letters embedded in ordinary words', () => {
  // "club" contains "lb"; "kilojoule" contains "kilo"; neither follows a number as a
  // standalone unit token, so both pass through untouched.
  assert.equal(stripFabricatedUnits('Nice work at the club today'), 'Nice work at the club today');
  assert.equal(stripFabricatedUnits('burned 500 kilojoules'), 'burned 500 kilojoules');
});

test('a clean coach note with no units passes through unchanged', () => {
  const s = 'Right on your target — clean session. Up from last time. Keep it here.';
  assert.equal(stripFabricatedUnits(s), s);
});

// --- chat path safety: the trailing PROPOSE_EDIT JSON survives intact ---

test('does not corrupt the chat PROPOSE_EDIT JSON directive', () => {
  const s = 'Bumping you up.\nPROPOSE_EDIT: {"action":"update_set","index":0,"weight":225,"reps":5,"rir":2}';
  assert.equal(stripFabricatedUnits(s), s);
});

// --- defensive input handling ---

test('handles empty / non-string input without throwing', () => {
  assert.equal(stripFabricatedUnits(''), '');
  assert.equal(stripFabricatedUnits(null), null);
  assert.equal(stripFabricatedUnits(undefined), undefined);
});
