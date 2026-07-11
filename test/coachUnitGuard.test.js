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

// --- write-feeding path safety: compile slash notation is a no-op ---

test('valid compile slash notation passes through unchanged (no-op on the write-feeding shape)', () => {
  // compileSessionFromHistory emits numbers-only slash notation that feeds the
  // parser → preview → approve → write path. Even though the guard is NOT wired on
  // that path (see the wiring test below), prove it would be a no-op regardless.
  const compiled = 'Deadlift 135 10/4 185 10/2 225 8/2\nBench Press 140 15 190 10 230 5/2';
  assert.equal(stripFabricatedUnits(compiled), compiled);
});

// --- wiring: guard is on the DISPLAY voices, NOT the compile/write-feeding path ---

test('the unit guard is wired on the display voices and NOT on the compile path', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'coach.js'), 'utf8');
  const bodyOf = (name) => {
    const start = src.indexOf(`async function ${name}(`);
    assert.ok(start !== -1, `${name} must exist`);
    // Scope the body: stop at the next top-level "async function " or — for the
    // last function in the file — at the module.exports block, so the export list
    // (which names stripFabricatedUnits) is never mistaken for a call site.
    const bounds = [src.indexOf('\nasync function ', start + 1), src.indexOf('\nmodule.exports', start + 1)]
      .filter(i => i !== -1);
    const next = bounds.length ? Math.min(...bounds) : -1;
    return src.slice(start, next === -1 ? undefined : next);
  };
  // Display voices apply the guard…
  for (const voice of ['generateCoachMessage', 'generatePlanMessage', 'generateChatReply']) {
    assert.match(bodyOf(voice), /stripFabricatedUnits\(/, `${voice} must apply the unit guard`);
  }
  // …the compile path (feeds preview→approve→write) must NOT.
  assert.doesNotMatch(bodyOf('compileSessionFromHistory'), /stripFabricatedUnits/,
    'compileSessionFromHistory must NOT call the guard — its slash-notation output feeds the write path');
  // …and the shared low-level chokepoint must NOT (that would re-touch the compile path).
  assert.doesNotMatch(bodyOf('callGeminiContents'), /stripFabricatedUnits/,
    'callGeminiContents must NOT call the guard — it is shared with the write-feeding compile path');
});
