'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyFullConsumptionGate } = require('../services/fullConsumptionGate');

// A fabricated single-set parse result (as the parser would hand back), so these
// unit tests exercise the gate in isolation from the grammar.
function logSets(sets, extra = {}) {
  return { intent: 'log_sets', raw_text: 'x', exercise: 'Bench Press', canonical_name: 'Bench Press', sets, warnings: [], ...extra };
}

// --- PARSE-4: mixed set-notation families refuse-and-ask ---------------------

test('PARSE-4: mixing slash + NxM@ downgrades to needs_clarification (no partial rows)', () => {
  const parsed = logSets([{ weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }]);
  const out = applyFullConsumptionGate(parsed, 'bench 185 5/2 3x8@165');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('mixed_set_format'));
  assert.equal(out.sets, undefined, 'no partial set list survives the refusal');
  assert.match(out.message, /more than one set format/i);
});

test('PARSE-4: mixing NxM@ + "N for M" downgrades', () => {
  const out = applyFullConsumptionGate(logSets([{ weight: 165, reps: 8, rir: null }]), 'bench 3x8@165 then 175 for 5');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('mixed_set_format'));
});

test('PARSE-4: mixing dumbbell slash + xN@ downgrades', () => {
  const out = applyFullConsumptionGate(logSets([{ weight: 60, reps: 10, rir: 3 }]), 'incline db press 60s 10/3 55s x8 @2');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('mixed_set_format'));
});

// --- PARSE-5: ambiguous small "@N" barbell weight refuses -------------------

test('PARSE-5: a barbell "@N" with N<=10 that was emitted as the weight asks', () => {
  const parsed = logSets([{ weight: 2, reps: 10, rir: null }, { weight: 2, reps: 10, rir: null }, { weight: 2, reps: 10, rir: null }]);
  const out = applyFullConsumptionGate(parsed, 'bench 3x10 @2');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('ambiguous_at_value'));
  assert.equal(out.sets, undefined);
  assert.match(out.message, /weight.*or.*RIR|RIR/i);
});

test('PARSE-5: boundary — @10 asks, @11 does not', () => {
  const at10 = applyFullConsumptionGate(logSets([{ weight: 10, reps: 5, rir: null }]), 'bench 3x5 @10');
  assert.equal(at10.intent, 'needs_clarification');
  const at11 = applyFullConsumptionGate(logSets([{ weight: 11, reps: 5, rir: null }]), 'bench 3x5 @11');
  assert.equal(at11.intent, 'log_sets');
});

test('PARSE-5: precision — only fires when the parser actually emitted that tiny weight', () => {
  // Same raw text, but the parser emitted a real weight (not 2) — do not flag as
  // ambiguous-@; and it is single-notation, so PARSE-4 does not fire either.
  const out = applyFullConsumptionGate(logSets([{ weight: 165, reps: 10, rir: null }]), 'bench 3x10 @2');
  assert.equal(out.intent, 'log_sets');
});

// --- A-01 (#1765): Unicode ×, multi-exercise children, zero-value sets ------

function logSetsMulti(exercises, extra = {}) {
  return { intent: 'log_sets_multi', raw_text: 'x', exercises, warnings: [], ...extra };
}

function child(name, sets, rawText) {
  return { exercise: name, canonical_name: name, raw_text: rawText, sets, warnings: [] };
}

test('A-01: Unicode × mixed notation refuses (gate shares the parser normalization)', () => {
  const parsed = logSets([{ weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }]);
  for (const text of [
    'bench 185 5/2 and 3×8@165',
    'bench 185 5/2 3×8@165',
    'bench 185 5/2 then 3×8@165',
    'bench 185 5/2 and 3×8 @165',
  ]) {
    const out = applyFullConsumptionGate(logSets(parsed.sets), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('mixed_set_format'), text);
    assert.equal(out.sets, undefined, text);
  }
});

test('A-01: ambiguous @ scans every @ in the text, not just the first', () => {
  const parsed = logSets([{ weight: 2, reps: 10, rir: null }]);
  const out = applyFullConsumptionGate(parsed, 'bench 3x5 @205 3x10 @2');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('ambiguous_at_value'));
});

test('A-01: zero weight / zero reps refuse (RIR 0 stays legal)', () => {
  const zeroReps = applyFullConsumptionGate(
    logSets([{ weight: 165, reps: 0, rir: null }, { weight: 165, reps: 0, rir: null }, { weight: 165, reps: 0, rir: null }]),
    'bench 3x0@165');
  assert.equal(zeroReps.intent, 'needs_clarification');
  assert.ok(zeroReps.warnings.includes('zero_set_value'));
  assert.equal(zeroReps.sets, undefined);

  const zeroWeight = applyFullConsumptionGate(
    logSets([{ weight: 0, reps: 8, rir: 2 }]), 'bench 0 8/2');
  assert.equal(zeroWeight.intent, 'needs_clarification');
  assert.ok(zeroWeight.warnings.includes('zero_set_value'));

  const rirZero = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 0 }]), 'bench 185 5/0');
  assert.equal(rirZero.intent, 'log_sets', 'RIR 0 means to failure — a real set');
});

test('A-01: mixed notation inside a multi-exercise child refuses the whole turn', () => {
  const bench = child('Bench Press',
    [{ weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }],
    'bench 185 5/2 and 3×8@165');
  const squat = child('Back Squat', [{ weight: 225, reps: 5, rir: 2 }], 'squat 225 5/2');
  const out = applyFullConsumptionGate(
    logSetsMulti([bench, squat], { raw_text: 'bench 185 5/2 and 3×8@165\nsquat 225 5/2' }),
    'bench 185 5/2 and 3×8@165\nsquat 225 5/2');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('mixed_set_format'));
  assert.equal(out.exercises, undefined, 'no partial child list survives the refusal');
});

test('A-01: ambiguous @ inside a multi-exercise child refuses the whole turn', () => {
  const bench = child('Bench Press',
    [{ weight: 2, reps: 10, rir: null }, { weight: 2, reps: 10, rir: null }, { weight: 2, reps: 10, rir: null }],
    'bench 3x10 @2');
  const squat = child('Back Squat', [{ weight: 225, reps: 5, rir: 2 }], 'squat 225 5/2');
  const out = applyFullConsumptionGate(
    logSetsMulti([bench, squat], { raw_text: 'bench 3x10 @2\nsquat 225 5/2' }),
    'bench 3x10 @2\nsquat 225 5/2');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('ambiguous_at_value'));
  assert.equal(out.exercises, undefined);
});

test('A-01: zero-rep sets inside a multi-exercise child refuse the whole turn', () => {
  const bench = child('Bench Press',
    [{ weight: 165, reps: 0, rir: null }], 'bench 3x0@165');
  const squat = child('Back Squat', [{ weight: 225, reps: 5, rir: 2 }], 'squat 225 5/2');
  const out = applyFullConsumptionGate(
    logSetsMulti([bench, squat], { raw_text: 'bench 3x0@165\nsquat 225 5/2' }),
    'bench 3x0@165\nsquat 225 5/2');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('zero_set_value'));
});

test('A-01: clean multi-exercise turns pass untouched (one family per child)', () => {
  const bench = child('Bench Press', [{ weight: 185, reps: 5, rir: 2 }], 'bench 185 5/2');
  const squat = child('Back Squat',
    [{ weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }],
    'squat 3x8@165');
  const parsed = logSetsMulti([bench, squat], { raw_text: 'bench 185 5/2\nsquat 3x8@165' });
  const out = applyFullConsumptionGate(parsed, 'bench 185 5/2\nsquat 3x8@165');
  assert.equal(out.intent, 'log_sets_multi');
  assert.deepEqual(out, parsed, 'the parsed object is returned unchanged');
});

test('A-01: dumbbell @ stays an RIR in multi turns, including Unicode ×', () => {
  const db = child('Incline DB Press', [{ weight: 55, reps: 10, rir: 3 }], 'incline db press 55s x10 @3');
  const squat = child('Back Squat', [{ weight: 225, reps: 5, rir: 2 }], 'squat 225 5/2');
  const parsed = logSetsMulti([db, squat], { raw_text: 'incline db press 55s x10 @3\nsquat 225 5/2' });
  assert.equal(applyFullConsumptionGate(parsed, 'incline db press 55s x10 @3\nsquat 225 5/2').intent, 'log_sets_multi');

  const dbX = child('Incline DB Press', [{ weight: 55, reps: 8, rir: 2 }], 'incline db press 55s ×8 @2');
  const parsedX = logSetsMulti([dbX, squat], { raw_text: 'incline db press 55s ×8 @2\nsquat 225 5/2' });
  assert.equal(applyFullConsumptionGate(parsedX, 'incline db press 55s ×8 @2\nsquat 225 5/2').intent, 'log_sets_multi');
});

test('A-01: per-line backstop catches a mixed line whose segment merged away', () => {
  // Same exercise in two segments: the merged child keeps only the first
  // segment's raw_text, so the mixed second line is invisible per-child — the
  // per-line backstop over the whole turn still refuses.
  const bench = child('Bench Press',
    [{ weight: 225, reps: 5, rir: 2 },
     { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }],
    'bench 225 5/2');
  const out = applyFullConsumptionGate(
    logSetsMulti([bench], { raw_text: 'bench 225 5/2\nbench 185 5/2 and 3×8@165' }),
    'bench 225 5/2\nbench 185 5/2 and 3×8@165');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('mixed_set_format'));
});

test('A-01: an already-unresolved line never discards its clean siblings', () => {
  const bench = child('Bench Press', [{ weight: 225, reps: 5, rir: 2 }], 'bench 225 5/2');
  const unresolved = [{ line: 'bench 185 5/2 and 3×8@165', message: 'Could not read this line as sets.', warnings: ['missing_exercise'] }];
  const parsed = logSetsMulti([bench],
    { raw_text: 'bench 225 5/2\nbench 185 5/2 and 3×8@165', unresolved });
  const out = applyFullConsumptionGate(parsed, 'bench 225 5/2\nbench 185 5/2 and 3×8@165');
  assert.equal(out.intent, 'log_sets_multi', 'the unresolved line emitted no sets, so nothing was silently dropped from it');
  assert.deepEqual(out, parsed);
});

test('A-01: a multi refusal preserves the unresolved lines', () => {
  const bench = child('Bench Press',
    [{ weight: 165, reps: 8, rir: null }], 'bench 185 5/2 and 3×8@165');
  const unresolved = [{ line: 'mystery lift here', message: 'Could not read this line as sets.', warnings: ['missing_exercise'] }];
  const out = applyFullConsumptionGate(
    logSetsMulti([bench], { raw_text: 'bench 185 5/2 and 3×8@165\nmystery lift here', unresolved }),
    'bench 185 5/2 and 3×8@165\nmystery lift here');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('mixed_set_format'));
  assert.deepEqual(out.unresolved, unresolved);
});

// --- B1 (pre-review blocker): multipliers the parser never recognizes ------

test('B1: a group joined by ✕ / Ｘ / * / ＊ refuses (gate detects, never folds)', () => {
  // The parser folds only U+00D7 ×. Each of these glyphs drops its group on
  // base and on the first commit — the turn must ask, with zero rows.
  for (const glyph of ['✕', 'Ｘ', '*', '＊']) {
    const parsed = logSets([{ weight: 185, reps: 5, rir: 2 }]);
    const out = applyFullConsumptionGate(parsed, `bench 185 5/2 and 3${glyph}8@165`);
    assert.equal(out.intent, 'needs_clarification', glyph);
    assert.ok(out.warnings.includes('unrecognized_set_notation'), glyph);
    assert.equal(out.sets, undefined, glyph);
  }
});

test('B1: same-family repeat with an unrecognized multiplier refuses (a fold would miss this)', () => {
  // Folding ✕ to x would make this look like one clean x@ family while the
  // 135 group is still dropped — the detector, not a fold, is the fix.
  const parsed = logSets([
    { weight: 165, reps: 8, rir: null },
    { weight: 165, reps: 8, rir: null },
    { weight: 165, reps: 8, rir: null },
  ]);
  const out = applyFullConsumptionGate(parsed, 'bench 3x8@165 and 3✕8@135');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('unrecognized_set_notation'));
  assert.equal(out.sets, undefined);
});

test('B1: an unrecognized multiplier inside a multi-exercise child refuses the whole turn', () => {
  const bench = child('Bench Press', [{ weight: 185, reps: 5, rir: 2 }], 'bench 185 5/2 and 3✕8@165');
  const squat = child('Back Squat', [{ weight: 225, reps: 5, rir: 2 }], 'squat 225 5/2');
  const out = applyFullConsumptionGate(
    logSetsMulti([bench, squat], { raw_text: 'bench 185 5/2 and 3✕8@165\nsquat 225 5/2' }),
    'bench 185 5/2 and 3✕8@165\nsquat 225 5/2');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('unrecognized_set_notation'));
  assert.equal(out.exercises, undefined);
});

test('B1: an unrecognized multiplier on its own line in a multi turn refuses (backstop)', () => {
  // Gate-level: a glyph line the parser did NOT surface as unresolved is
  // refused by the backstop. At the route, the real parser surfaces this
  // line as unresolved ("Could not find sets for Bench Press."), so the
  // turn logs its siblings WITH that unresolved line flagged in the
  // response — flagged, not silent. Tightening that to a refusal would
  // change the unresolved UX and is coordinator direction, not this fix.
  const bench = child('Bench Press', [{ weight: 185, reps: 5, rir: 2 }], 'bench 185 5/2');
  const squat = child('Back Squat', [{ weight: 225, reps: 5, rir: 2 }], 'squat 225 5/2');
  const out = applyFullConsumptionGate(
    logSetsMulti([bench, squat], { raw_text: 'bench 185 5/2\nsquat 225 5/2\nbench 3✕8@165' }),
    'bench 185 5/2\nsquat 225 5/2\nbench 3✕8@165');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('unrecognized_set_notation'));
});

test('B1: digit–multiplier–@ (no reps between glyph and @) refuses; a trailing markdown asterisk does not trip', () => {
  const atAfterGlyph = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 and 3✕ @165');
  assert.equal(atAfterGlyph.intent, 'needs_clarification');
  assert.ok(atAfterGlyph.warnings.includes('unrecognized_set_notation'));

  const trailingStar = applyFullConsumptionGate(
    logSets([{ weight: 165, reps: 8, rir: null }]), 'bench 3x8@165*');
  assert.equal(trailingStar.intent, 'log_sets', 'a trailing * is emphasis, not a multiplier');
});

// --- No over-rejection of valid terse notation ------------------------------

test('valid: the 225 5/2 slash contract and repeated slash sets pass untouched', () => {
  const single = logSets([{ weight: 225, reps: 5, rir: 2 }]);
  assert.equal(applyFullConsumptionGate(single, 'bench 225 5/2').intent, 'log_sets');
  const multiSlash = logSets([{ weight: 225, reps: 5, rir: 2 }, { weight: 185, reps: 8, rir: 2 }]);
  const out = applyFullConsumptionGate(multiSlash, 'squat 225 5/2 185 8/2');
  assert.equal(out.intent, 'log_sets');
  assert.deepEqual(out, multiSlash, 'the parsed object is returned unchanged');
});

test('valid: single-family NxM@W (W>10) and dumbbell @RIR pass untouched', () => {
  assert.equal(applyFullConsumptionGate(logSets([{ weight: 205, reps: 5, rir: null }]), 'bench 3x5 @205').intent, 'log_sets');
  assert.equal(applyFullConsumptionGate(logSets([{ weight: 55, reps: 10, rir: 3 }]), 'incline db press 55s x10 @3').intent, 'log_sets');
  assert.equal(applyFullConsumptionGate(logSets([{ weight: 165, reps: 8, rir: null }]), 'bench 3x8@165').intent, 'log_sets');
});

// --- A-01 re-fix (#1765 regression, Astra re-audit #3): repeated set groups --
// `parseSetsFirst` / `parseWeightRepsSets` match only the FIRST group, so a
// second group token in one span is dropped by construction. The gate counts
// group tokens per span and refuses when a second group is present that no
// grammar consumes whole.

const X165_SETS = [
  { weight: 165, reps: 8, rir: null },
  { weight: 165, reps: 8, rir: null },
  { weight: 165, reps: 8, rir: null },
];

test('re-fix: same-family NxM@W repeat refuses, every separator', () => {
  for (const text of [
    'bench 3x8@165 3x8@135',
    'bench 3x8@165 and 3x8@135',
    'bench 3x8@165, 3x8@135',
    'bench 3x8@165 + 3x8@135',
    'bench 3x8@165 then 3x8@135',
    'bench 3x8@165; 3x8@135',
    'bench 3x8@165 2x8@135',
    'bench 3x8@165 3x10@135',
    'bench 3x8@165 3x8@165',
    'bench 3x8@165 and 3x8@135 and 3x8@115',
    'bench 3×8@165 3×8@135',
    'bench 3x8 @165 3x8 @135',
    'bench 3 x 8 @ 165 3 x 8 @ 135',
  ]) {
    const out = applyFullConsumptionGate(logSets(X165_SETS), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
    assert.match(out.message, /two sets/i, text);
  }
});

test('re-fix: same-family WxRxN repeat refuses; WxR beside an x@ group refuses either order', () => {
  for (const [text, sets] of [
    ['bench 185x8x3 165x8x3', [{ weight: 185, reps: 8, rir: null }, { weight: 185, reps: 8, rir: null }, { weight: 185, reps: 8, rir: null }]],
    ['bench 185x5 3x8@165', X165_SETS],
    ['bench 245 x 6 3x8@165', X165_SETS],
    ['bench 3x8@165 185x5', X165_SETS],
    ['bench 3x8@165 245 x 6 @3', X165_SETS],
  ]) {
    const out = applyFullConsumptionGate(logSets(sets), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
});

test('re-fix: a bare NxM token after a consumed group refuses; a trailing xN repeat or stray @ refuses', () => {
  for (const [text, sets] of [
    ['bench 3x8@165 3x8', X165_SETS],
    ['bench 185 5/2 3x8', [{ weight: 185, reps: 5, rir: 2 }]],
    ['bench 3x8@165 x3', X165_SETS],
    ['bench 3x8@165 @135', X165_SETS],
    ['bench 185 5/2 @135', [{ weight: 185, reps: 5, rir: 2 }]],
  ]) {
    const out = applyFullConsumptionGate(logSets(sets), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
});

test('re-fix: a bare WxR token beside a slash / for / WxRxN / dumbbell group refuses', () => {
  for (const [text, sets] of [
    ['bench 185x5 165 8/2', [{ weight: 165, reps: 8, rir: 2 }]],
    ['bench 165 8/2 185x5', [{ weight: 165, reps: 8, rir: 2 }]],
    ['bench 185x5 165x8x3', [{ weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }]],
    ['bench 185x5 175 for 5', [{ weight: 175, reps: 5, rir: null }]],
    ['bench 185x5 55s x10 @3', [{ weight: 55, reps: 10, rir: 3 }]],
  ]) {
    const out = applyFullConsumptionGate(logSets(sets), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
});

test('re-fix: a dumbbell group beside any barbell group refuses', () => {
  for (const [text, sets] of [
    ['bench 185 5/2 55s x10 @3', [{ weight: 55, reps: 10, rir: 3 }]],
    ['bench 3x8@165 55s x10 @3', [{ weight: 55, reps: 10, rir: 3 }]],
    ['bench 175 for 5 55s x10 @3', [{ weight: 55, reps: 10, rir: 3 }]],
  ]) {
    const out = applyFullConsumptionGate(logSets(sets), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
});

test('re-fix: multiline same-exercise repeat refuses on the single path (newlines collapse to one blob)', () => {
  for (const text of [
    'bench 3x8@165\nbench 3x8@135',
    'bench 3x8@165\n3x8@135',
    'bench\n3x8@165\n3x8@135',
  ]) {
    const out = applyFullConsumptionGate(logSets(X165_SETS), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
});

test('re-fix: segment-path repeat refuses per-child (segments split on FIRST mention only)', () => {
  // The squat segment's own raw_text carries both groups; the per-child
  // check sees the drop even though the per-line backstop cannot (each line
  // alone holds one group).
  const bench = child('Bench Press', [{ weight: 185, reps: 5, rir: 2 }], 'bench 185 5/2');
  const squat = child('Back Squat', X165_SETS, 'squat 3x8@165 squat 3x8@135');
  const out = applyFullConsumptionGate(
    logSetsMulti([bench, squat], { raw_text: 'bench 185 5/2\nsquat 3x8@165\nsquat 3x8@135' }),
    'bench 185 5/2\nsquat 3x8@165\nsquat 3x8@135');
  assert.equal(out.intent, 'needs_clarification');
  assert.ok(out.warnings.includes('repeated_set_group'));
  assert.equal(out.exercises, undefined);
});

test('re-fix: rescue-path repeat logs (per-line parsing + set concat consumes both groups)', () => {
  // Same two bench groups, but a squat line between them routes the turn
  // through the multiline rescue: each line parses separately and the sets
  // concat — nothing is dropped, so the gate must NOT refuse.
  const bench = child('Bench Press', [
    { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null },
    { weight: 135, reps: 8, rir: null }, { weight: 135, reps: 8, rir: null }, { weight: 135, reps: 8, rir: null },
  ], 'bench 3x8@165');
  const squat = child('Back Squat', [{ weight: 225, reps: 5, rir: 2 }], 'squat 225 5/2');
  const parsed = logSetsMulti([bench, squat], { raw_text: 'bench 3x8@165\nsquat 225 5/2\nbench 3x8@135' });
  const out = applyFullConsumptionGate(parsed, 'bench 3x8@165\nsquat 225 5/2\nbench 3x8@135');
  assert.equal(out.intent, 'log_sets_multi');
  assert.deepEqual(out, parsed);
});

test('re-fix: forms the parser consumes whole still pass untouched', () => {
  // Slash repeats (shorthand token loop), `for` repeats (matchAll), dumbbell
  // repeats (matchAll), WxR pairs + WxR@RIR tiling pairs, slash + trailing
  // x3 (the shorthand repeat — never a second group), dumbbell slash repeat
  // with its own x3 count, chains, and warm-up climbs.
  const cases = [
    ['bench 185 5/2 165 8/2', [{ weight: 185, reps: 5, rir: 2 }, { weight: 165, reps: 8, rir: 2 }]],
    ['bench 175 for 5 165 for 8', [{ weight: 175, reps: 5, rir: null }, { weight: 165, reps: 8, rir: null }]],
    ['incline db press 55s x10 @3 60s x8 @2', [{ weight: 55, reps: 10, rir: 3 }, { weight: 60, reps: 8, rir: 2 }]],
    ['incline db press 60s 10/3 65s 8/2', [{ weight: 60, reps: 10, rir: 3 }, { weight: 65, reps: 8, rir: 2 }]],
    ['bench 185x5 165x8', [{ weight: 185, reps: 5, rir: null }, { weight: 165, reps: 8, rir: null }]],
    ['bench 245 x 6 @3 225 x 5 @2', [{ weight: 245, reps: 6, rir: 3 }, { weight: 225, reps: 5, rir: 2 }]],
    ['bench 185 5/2 x3', [{ weight: 185, reps: 5, rir: 2 }, { weight: 185, reps: 5, rir: 2 }, { weight: 185, reps: 5, rir: 2 }]],
    ['incline db press 60s 10/3 x3', [{ weight: 60, reps: 10, rir: 3 }, { weight: 60, reps: 10, rir: 3 }, { weight: 60, reps: 10, rir: 3 }]],
    ['bench 225 5/2 8/8/7', [{ weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 8, rir: null }, { weight: 225, reps: 8, rir: null }, { weight: 225, reps: 7, rir: null }]],
    ['bench 135 10 185 5/2', [{ weight: 135, reps: 10, rir: null }, { weight: 185, reps: 5, rir: 2 }]],
  ];
  for (const [text, sets] of cases) {
    const parsed = logSets(sets);
    const out = applyFullConsumptionGate(parsed, text);
    assert.equal(out.intent, 'log_sets', text);
    assert.deepEqual(out, parsed, text);
  }
});

// --- Pre-review round 1 (FIX FIRST): B1–B4 ---------------------------------

test('pre-review B1: slash-chain + trailing xN logs — the xN repeats the last chain element', () => {
  // The strip removes weight+slash pairs AND chain tails before counting, so
  // the RIR digit never reads as a WxR leader (`7 x3` phantom).
  const sets = [
    { weight: 225, reps: 5, rir: 2 },
    { weight: 225, reps: 8, rir: null }, { weight: 225, reps: 8, rir: null },
    { weight: 225, reps: 7, rir: null }, { weight: 225, reps: 7, rir: null }, { weight: 225, reps: 7, rir: null },
  ];
  const parsed = logSets(sets);
  const out = applyFullConsumptionGate(parsed, 'bench 225 5/2 8/8/7 x3');
  assert.equal(out.intent, 'log_sets');
  assert.deepEqual(out, parsed);
});

test('pre-review B2: WxR + trailing xN logs — the xN is the WxRxN count; a trailing xN after a counted group still refuses', () => {
  const three = [
    { weight: 185, reps: 5, rir: null },
    { weight: 185, reps: 5, rir: null },
    { weight: 185, reps: 5, rir: null },
  ];
  const parsed = logSets(three);
  const out = applyFullConsumptionGate(parsed, 'bench 185x5 x3');
  assert.equal(out.intent, 'log_sets', 'the parser reads 185x5 x3 as 3× 185x5');
  assert.deepEqual(out, parsed);

  const counted = applyFullConsumptionGate(logSets(three), 'bench 185x8x3 x3');
  assert.equal(counted.intent, 'needs_clarification', 'the group already carries its count — the trailing x3 is unconsumed');
  assert.ok(counted.warnings.includes('repeated_set_group'));
});

test('pre-review B3: one-line multi-exercise turns log — the parser segments per exercise and consumes both', () => {
  // The per-line backstop checks only line content no child's raw_text
  // already covers; each segment is verified per-child.
  for (const [text, benchSets, squatSets] of [
    ['bench 3x8@165 squat 3x8@135', X165_SETS,
      [{ weight: 135, reps: 8, rir: null }, { weight: 135, reps: 8, rir: null }, { weight: 135, reps: 8, rir: null }]],
    ['bench 185x8x3 squat 225x8x3',
      [{ weight: 185, reps: 8, rir: null }, { weight: 185, reps: 8, rir: null }, { weight: 185, reps: 8, rir: null }],
      [{ weight: 225, reps: 8, rir: null }, { weight: 225, reps: 8, rir: null }, { weight: 225, reps: 8, rir: null }]],
    ['bench 3x8@165 squat 225x5', X165_SETS, [{ weight: 225, reps: 5, rir: null }]],
  ]) {
    const bench = child('Bench Press', benchSets, text.split(' squat ')[0]);
    const squat = child('Back Squat', squatSets, `squat ${text.split(' squat ')[1]}`);
    const parsed = logSetsMulti([bench, squat], { raw_text: text });
    const out = applyFullConsumptionGate(parsed, text);
    assert.equal(out.intent, 'log_sets_multi', text);
    assert.deepEqual(out, parsed, text);
  }
});

test('pre-review B4: unit-glued groups refuse — 85kgx5 / 185lbx5 survive normalization unconverted', () => {
  for (const [text, sets] of [
    ['bench 85kgx5 3x8@165', X165_SETS],
    ['bench 3x8@165 85kgx5', X165_SETS],
    ['bench 185lbx5 3x8@165', X165_SETS],
    ['bench 185lbsx5 3x8@165', X165_SETS],
    ['bench 85kgx5 165x8x3', [{ weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }]],
    ['bench 85kgx8x3 165x8x3', [{ weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }]],
    ['bench 85kgx5 165 8/2', [{ weight: 165, reps: 8, rir: 2 }]],
  ]) {
    const out = applyFullConsumptionGate(logSets(sets), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
});

// --- Robustness -------------------------------------------------------------

test('gate is a no-op for non-log_sets intents and garbage input', () => {
  const clar = { intent: 'needs_clarification', warnings: ['missing_sets'] };
  assert.equal(applyFullConsumptionGate(clar, 'bench 185 5/2 3x8@165'), clar);
  const multi = { intent: 'log_sets_multi', exercises: [] };
  assert.equal(applyFullConsumptionGate(multi, 'bench 185 5/2 3x8@165'), multi);
  assert.equal(applyFullConsumptionGate(null, 'x'), null);
  assert.equal(applyFullConsumptionGate(logSets([{ weight: 225, reps: 5, rir: 2 }]), '').intent, 'log_sets');
});
