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

// --- Pre-review round 2 (FIX FIRST): F1–F2 + multiline rescue -------------

test('pre-review F1: spaced WxRxN logs — the inner tail is the group count, never a second group', () => {
  const three = [
    { weight: 185, reps: 5, rir: null },
    { weight: 185, reps: 5, rir: null },
    { weight: 185, reps: 5, rir: null },
  ];
  for (const text of ['bench 185 x 5 x 3', 'bench 185 x 5x3', 'bench 185 x 5 x3', 'bench 187.5 x 5 x 3']) {
    const sets = text.startsWith('bench 187.5')
      ? three.map(s => ({ ...s, weight: 187.5 }))
      : three;
    const parsed = logSets(sets);
    const out = applyFullConsumptionGate(parsed, text);
    assert.equal(out.intent, 'log_sets', text);
    assert.deepEqual(out, parsed, text);
  }
  // Two spaced WxRxN groups still refuse — the second really drops.
  const two = applyFullConsumptionGate(logSets(three), 'bench 185 x 5 x 3 165 x 8 x 3');
  assert.equal(two.intent, 'needs_clarification');
  assert.ok(two.warnings.includes('repeated_set_group'));
});

test('pre-review F2: WxRxN beside a slash or for group refuses (one line)', () => {
  const wxrN = [
    { weight: 185, reps: 8, rir: null },
    { weight: 185, reps: 8, rir: null },
    { weight: 185, reps: 8, rir: null },
  ];
  for (const text of [
    'bench 185x8x3 165 8/2',
    'bench 165 8/2 185x8x3',
    'bench 185x8x3 and 165 8/2',
    'bench 185x8x3 225 5/2 8/8/7',
    'bench 185x8x3 175 for 5',
    'bench 175 for 5 185x8x3',
    'bench 185 5/2 165x8x3',
  ]) {
    const out = applyFullConsumptionGate(logSets(wxrN), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
  // Prose `for` is not a for-group: the turn still logs.
  const prose = applyFullConsumptionGate(logSets(wxrN), 'bench 185x8x3 for the record');
  assert.equal(prose.intent, 'log_sets');
});

test('multiline rescue: cross-family groups on separate lines log — the parser resolves per-line', () => {
  const cases = [
    ['bench 185x8x3\nbench 165 8/2',
      [{ weight: 185, reps: 8, rir: null }, { weight: 185, reps: 8, rir: null }, { weight: 185, reps: 8, rir: null }, { weight: 165, reps: 8, rir: 2 }]],
    ['bench 185 5/2\nbench 165x8x3',
      [{ weight: 185, reps: 5, rir: 2 }, { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }, { weight: 165, reps: 8, rir: null }]],
    ['bench 185x8x3\nbench 175 for 5',
      [{ weight: 185, reps: 8, rir: null }, { weight: 185, reps: 8, rir: null }, { weight: 185, reps: 8, rir: null }, { weight: 175, reps: 5, rir: null }]],
    ['bench 175 for 5\nbench 165 8/2',
      [{ weight: 175, reps: 5, rir: null }, { weight: 165, reps: 8, rir: 2 }]],
    ['bench 185x5\nbench 165 8/2',
      [{ weight: 185, reps: 5, rir: null }, { weight: 165, reps: 8, rir: 2 }]],
    ['bench 185x5 x3\nbench 165 8/2',
      [{ weight: 185, reps: 5, rir: null }, { weight: 185, reps: 5, rir: null }, { weight: 185, reps: 5, rir: null }, { weight: 165, reps: 8, rir: 2 }]],
    ['bench 185x5\nbench press 165 8/2',
      [{ weight: 185, reps: 5, rir: null }, { weight: 165, reps: 8, rir: 2 }]],
    ['bench 185x5\nbench 165 8/2 175 5/2',
      [{ weight: 185, reps: 5, rir: null }, { weight: 165, reps: 8, rir: 2 }, { weight: 175, reps: 5, rir: 2 }]],
  ];
  for (const [text, sets] of cases) {
    const parsed = logSets(sets);
    const out = applyFullConsumptionGate(parsed, text);
    assert.equal(out.intent, 'log_sets', text);
    assert.deepEqual(out, parsed, text);
  }
});

test('multiline blob: a later group still refuses when the parser flattens to one blob', () => {
  // x@-first: x@ groups are not set tokens, so the blob claims the first
  // group and later groups drop — no rescue shape, whole-text refusal stands.
  // A contextual-alias-only repeat (`press` alone) does not trip the G1
  // guard either, so the blob logs and the dropped group still refuses.
  // A repeated continuation word (`and`) is not a name-like repeat.
  const cases = [
    ['bench 3x8@165\nbench 3x8@135', X165_SETS],
    ['bench 185x5\nbench 3x8@165', X165_SETS],
    ['bench 3x8@165\nbench 165 8/2', X165_SETS],
    ['bench press 185x5\npress 165 8/2', [{ weight: 165, reps: 8, rir: 2 }]],
    ['bench 185x5\npress 165 8/2', [{ weight: 165, reps: 8, rir: 2 }]],
    ['did 3 sets of bench 3x8@165 bench 165 8/2', X165_SETS],
  ];
  for (const [text, sets] of cases) {
    const out = applyFullConsumptionGate(logSets(sets), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.length > 0, text);
    assert.equal(out.sets, undefined, text);
  }
  // A within-line drop on one line of a rescue turn still refuses.
  const within = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 8, rir: null }, { weight: 185, reps: 8, rir: null }, { weight: 185, reps: 8, rir: null }, { weight: 225, reps: 5, rir: 2 }]),
    'bench 185x8x3 165 8/2\nbench 225 5/2');
  assert.equal(within.intent, 'needs_clarification');
  assert.ok(within.warnings.includes('repeated_set_group'));
});

// --- Pack follow-up (Hammy BLOCKING on #1790, P4/P8/P9) ----------------------
// The coordinator's 11-input pack set: three pack-only forms still logged a
// partial preview at head 9ad3ca73 — a prose set group, a trailing x0 repeat,
// and a word-number zero group. All three refuse here; the legit `x3`
// repeats and the `10 sets` fragment still log untouched.

test('pack follow-up P4: a prose "N sets of M at W" group beside a consumed group refuses', () => {
  for (const [text, sets] of [
    ['bench 185 5/2 then 3 sets of 8 at 165', [{ weight: 185, reps: 5, rir: 2 }]],
    ['bench 3 sets of 8 at 165 and 2x5@185', [{ weight: 185, reps: 5, rir: 2 }, { weight: 185, reps: 5, rir: 2 }]],
    ['bench 185 5/2 then 3 sets of 8 @ 165', [{ weight: 185, reps: 5, rir: 2 }]],
    ['bench 185 5/2 then 3 sets of 8 reps at 165', [{ weight: 185, reps: 5, rir: 2 }]],
    ['bench 185 5/2\n3 sets of 8 at 165', [{ weight: 185, reps: 5, rir: 2 }]],
  ]) {
    const out = applyFullConsumptionGate(logSets(sets), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
    assert.match(out.message, /two sets/i, text);
  }
});

test('pack follow-up P4: a "sets of <word>" phrase is not a prose group', () => {
  // `did 3 sets of bench` carries no second group (no digits after "of"),
  // so beside a consumed slash group it must not trip the prose arm.
  const out = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 did 3 sets of bench');
  assert.equal(out.intent, 'log_sets');
});

test('pack follow-up P8/P9: zero-quantity directives beside a consumed group refuse', () => {
  for (const [text, sets] of [
    ['bench 185 5/2 x0', [{ weight: 185, reps: 5, rir: 2 }]],
    ['bench 185 5/2 x 0', [{ weight: 185, reps: 5, rir: 2 }]],
    ['bench 60s 10/3 x0', [{ weight: 60, reps: 10, rir: 3 }]],
    ['bench 185 5/2 for zero sets', [{ weight: 185, reps: 5, rir: 2 }]],
    ['bench 185 5/2 zero sets', [{ weight: 185, reps: 5, rir: 2 }]],
    ['bench 185 5/2 0 sets', [{ weight: 185, reps: 5, rir: 2 }]],
  ]) {
    const out = applyFullConsumptionGate(logSets(sets), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('zero_set_directive'), text);
    assert.equal(out.sets, undefined, text);
    assert.match(out.message, /zero/i, text);
  }
  // A `for` group beside x0 refuses through the repeated-group arm (the bare
  // WxR token `5 x0` beside the for-group); an x@ group beside x0 already
  // refused that way. The code differs; the outcome (refuse, 0 sets) is the same.
  for (const [text, sets, code] of [
    ['bench 175 for 5 x0', [{ weight: 175, reps: 5, rir: null }], 'repeated_set_group'],
    ['bench 3x8@165 x0', X165_SETS, 'repeated_set_group'],
  ]) {
    const out = applyFullConsumptionGate(logSets(sets), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes(code), text);
    assert.equal(out.sets, undefined, text);
  }
});

test('pack follow-up round 2 P4: prose set-group spellings refuse', () => {
  // Pre-review on 3a9eff2c (F1–F4): the same prose group spelled with a
  // `with` preposition, an `x` separator, or number-words in the count/rep
  // slots dropped just as silently. All four refuse here.
  for (const text of [
    'bench 185 5/2 then 3 sets of 8 with 165',
    'bench 185 5/2 then 3 sets x 8 at 165',
    'bench 185 5/2 then 3 sets of eight at 165',
    'bench 185 5/2 then three sets of 8 at 165',
  ]) {
    const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
  // The rep slot must still be numeric: a word after "of" is not a group.
  const words = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 did three sets of bench');
  assert.equal(words.intent, 'log_sets');
});

test('pack follow-up round 2 P8/P9: zero-directive spellings refuse', () => {
  // Pre-review on 3a9eff2c (F5–F8): `no`/`none` state zero sets as plainly
  // as `zero`; `x00`, `x 00`, and `x-0` are the same zero repeat spelled
  // with a doubled zero or a hyphen. All refuse here.
  for (const text of [
    'bench 185 5/2 for no sets',
    'bench 185 5/2 for none sets',
    'bench 185 5/2 x00',
    'bench 185 5/2 x 00',
    'bench 185 5/2 x-0',
  ]) {
    const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('zero_set_directive'), text);
    assert.equal(out.sets, undefined, text);
    assert.match(out.message, /zero/i, text);
  }
  // `x05` is a 5-repeat, not a zero repeat: it still logs untouched.
  const fiveRepeat = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 x05');
  assert.equal(fiveRepeat.intent, 'log_sets', 'x05 is a 5-repeat');
});

test('pack follow-up round 3 P8: unicode-dash zero repeats refuse', () => {
  // Pre-review on b9fa078d (G1): the zero repeat joined by a non-ASCII
  // dash — en dash, em dash, hyphen, non-breaking hyphen, U+2012, U+2212
  // minus — dropped just as silently as the ASCII `x-0`. All eight refuse
  // here; the dash glyphs are spelled out with escapes so the source stays
  // ASCII-readable.
  for (const text of [
    'bench 185 5/2 x \u2013 0',
    'bench 185 5/2 x \u2014 0',
    'bench 185 5/2 x\u20130',
    'bench 185 5/2 x\u20140',
    'bench 185 5/2 x\u22120',
    'bench 185 5/2 x \u2212 0',
    'bench 185 5/2 x\u20100',
    'bench 185 5/2 x\u20110',
  ]) {
    const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('zero_set_directive'), text);
    assert.equal(out.sets, undefined, text);
    assert.match(out.message, /zero/i, text);
  }
});

test('pack follow-up round 3: spaced/dashed non-zero repeats beside a slash or for group refuse', () => {
  // Builder probe while verifying G1: the parser takes a slash group's
  // repeat only in the tight `xN` form, and never takes a dashed repeat
  // beside a `for` group — the spaced/dashed spellings previewed one set.
  for (const text of [
    'bench 185 5/2 x 3',
    'bench 185 5/2 x-3',
    'bench 185 5/2 x \u2013 3',
    'bench 185 5/2 x 10',
    'bench 175 for 5 x-3',
  ]) {
    const sets = text.includes('175 for 5')
      ? [{ weight: 175, reps: 5, rir: null }]
      : [{ weight: 185, reps: 5, rir: 2 }];
    const out = applyFullConsumptionGate(logSets(sets), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
  // The x@ and WxR families consume their spaced/dashed repeats, so the
  // gate must not fire there: the parser logs these whole.
  const xat = applyFullConsumptionGate(logSets(X165_SETS), 'bench 3x8@165 x-3');
  assert.equal(xat.intent, 'log_sets', 'x@ group consumes x-3');
  const wxr = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: null }]), 'bench 185x5 x 3');
  assert.equal(wxr.intent, 'log_sets', 'WxR group consumes x 3');
  // A 1-repeat is indistinguishable from no repeat: it still logs.
  const one = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 x 1');
  assert.equal(one.intent, 'log_sets', 'x 1 is one set either way');
});

test('pack follow-up round 4 H1: spaced/dashed repeats beside a dumbbell x@ group refuse', () => {
  // Pre-review round 3 on 1e83793e (H1): the round-3 arm fired only on
  // slash/`for` groups, so a spaced/dashed repeat beside a dumbbell x@
  // group previewed one set though the parser takes the repeat only tight.
  for (const text of [
    'bench 60s x10 @3 x 3',
    'bench 60s x10 @3 x-3',
    'bench 60s x10 @3 x \u2013 3',
    'bench 60s x10 @3 x 2',
    'bench 60s x10 @3\nx 3',
  ]) {
    const out = applyFullConsumptionGate(
      logSets([{ weight: 60, reps: 10, rir: 3 }]), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
  // Tight repeats and a 1-repeat still log: the parser consumes those.
  const three = [
    { weight: 60, reps: 10, rir: 3 },
    { weight: 60, reps: 10, rir: 3 },
    { weight: 60, reps: 10, rir: 3 },
  ];
  const tight = applyFullConsumptionGate(logSets(three), 'bench 60s x10 @3 x3');
  assert.equal(tight.intent, 'log_sets', 'dumbbell group consumes tight x3');
  const one = applyFullConsumptionGate(
    logSets([{ weight: 60, reps: 10, rir: 3 }]), 'bench 60s x10 @3 x 1');
  assert.equal(one.intent, 'log_sets', 'x 1 is one set either way');
});

test('pack follow-up round 4 H2: prose set-group with a dash weight separator refuses', () => {
  // Pre-review round 3 on 1e83793e (H2): PROSE_SET_GROUP's weight
  // preposition was `at`/`@`/`with` only, so a dash separator dropped the
  // group in every spacing. The fully-tight form (`8-165`) reads as a
  // range and stays out of scope.
  for (const text of [
    'bench 185 5/2 then 3 sets of 8 - 165',
    'bench 185 5/2 then 3 sets of 8 \u2013 165',
    'bench 185 5/2 then 3 sets of 8 \u2014 165',
    'bench 185 5/2 then 3 sets of 8- 165',
    'bench 185 5/2 then 3 sets of 8 -165',
    'bench 185 5/2 then 3 sets of 8 - 165 lbs',
    'bench 185 5/2\n3 sets of 8 - 165',
    'bench 185 5/2 then 3 sets of eight - 165',
  ]) {
    const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
  // A dash with no weight after it names no group: the turn still logs.
  const noWeight = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 then 3 sets of 8 - felt good');
  assert.equal(noWeight.intent, 'log_sets', 'dash without a weight is not a prose group');
});

test('pack follow-up round 4 H3: leading-zero repeat counts refuse', () => {
  // Pre-review round 3 on 1e83793e (H3): the repeat count pattern
  // defeated itself on a leading zero (`05` starts with `0`), so
  // `x 03` previewed one set though the parser accepts tight `x03`.
  for (const text of [
    'bench 185 5/2 x 03',
    'bench 185 5/2 x 02',
    'bench 185 5/2 x 05',
    'bench 185 5/2 x-05',
  ]) {
    const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
  // Value 1 with a leading zero is still a no-op repeat: it logs.
  const one = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 x 01');
  assert.equal(one.intent, 'log_sets', 'x 01 is one set either way');
  // The tight leading-zero form is consumed by the parser: it logs whole.
  const five = [
    { weight: 185, reps: 5, rir: 2 },
    { weight: 185, reps: 5, rir: 2 },
    { weight: 185, reps: 5, rir: 2 },
    { weight: 185, reps: 5, rir: 2 },
    { weight: 185, reps: 5, rir: 2 },
  ];
  const tight = applyFullConsumptionGate(logSets(five), 'bench 185 5/2 x05');
  assert.equal(tight.intent, 'log_sets', 'x05 is a 5-repeat');
});

test('pack follow-up round 5 I1/I2: prose set-group with `for` in either slot refuses', () => {
  // Pre-review round 4 on d55dcdb3 (I1/I2): `for` in the count/reps
  // separator (`3 sets for 8 at 165`) and in the weight preposition with
  // `reps` (`3 sets of 8 reps for 165`) both dropped the group — `for` is
  // the third natural English word for both prose slots.
  for (const text of [
    'bench 185 5/2 then 3 sets for 8 at 165',
    'bench 185 5/2 then 3 sets for 8 reps at 165',
    'bench 185 5/2 then 3 sets for eight at 165',
    'bench 185 5/2 then three sets for 8 at 165',
    'bench 185 5/2 then 3 sets for 8 - 165',
    'bench 185 5/2 then 3 sets for 8 with 165',
    'bench 185 5/2\n3 sets for 8 at 165',
    'bench 175 for 5 then 3 sets for 8 at 165',
    'bench 185 5/2 then 3 sets for 8 at 165 lbs',
    'bench 185 5/2 then 3 sets of 8 reps for 165',
    'bench 185 5/2 then 3 sets for eight reps for 165',
  ]) {
    const sets = text.includes('175 for 5')
      ? [{ weight: 175, reps: 5, rir: null }]
      : [{ weight: 185, reps: 5, rir: 2 }];
    const out = applyFullConsumptionGate(logSets(sets), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
  // The bare `8 for 165` form already refused before this round (via
  // `mixed_set_format`, the parser consuming `8 for 165` as a set); the
  // prose arm now names it first. Same fail-closed outcome either way.
  const bare = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 then 3 sets of 8 for 165');
  assert.equal(bare.intent, 'needs_clarification', 'bare 8 for 165 still refuses');
  assert.ok(bare.warnings.includes('repeated_set_group'), 'bare 8 for 165');
  assert.equal(bare.sets, undefined, 'bare 8 for 165');
  // `for` with no weight after it names no group: the turn still logs.
  const noWeight = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 then 3 sets for 8');
  assert.equal(noWeight.intent, 'log_sets', 'for without a weight is not a prose group');
  const forTime = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 then 3 sets for time');
  assert.equal(forTime.intent, 'log_sets', 'for time is not a prose group');
});

test('pack follow-up round 6 J1/J2: prose set-group with `*` in either slot refuses', () => {
  // Pre-review round 5 on b3298d8f (J1/J2): `*` (U+002A, the ASCII
  // multiplication sign) in the count/reps separator
  // (`3 sets * 8 at 165`) and in the weight preposition with `reps`
  // (`3 sets of 8 reps * 165`) both dropped the group — `*` is listed
  // in the gate's own multiplier-glyph comment and in
  // UNRECOGNIZED_MULTIPLIER, and its siblings `x`/`×` already refuse
  // in both slots.
  for (const text of [
    'bench 185 5/2 then 3 sets * 8 at 165',
    'bench 185 5/2 then 3 sets * eight at 165',
    'bench 185 5/2 then three sets * 8 at 165',
    'bench 185 5/2\n3 sets * 8 at 165',
    'bench 185 5/2 then 3 sets of 8 reps * 165',
    'bench 185 5/2 then 3 sets for 8 reps * 165',
  ]) {
    const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
  // The bare `8 * 165` form already refused before this round (via
  // `unrecognized_set_notation`); unaffected by this change.
  const bare = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 then 3 sets of 8 * 165');
  assert.equal(bare.intent, 'needs_clarification', 'bare 8 * 165 still refuses');
  assert.ok(bare.warnings.includes('unrecognized_set_notation'), 'bare 8 * 165');
  assert.equal(bare.sets, undefined, 'bare 8 * 165');
  // `*` with no weight after it names no group: the turn still logs.
  const noWeight = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 then 3 sets * 8');
  assert.equal(noWeight.intent, 'log_sets', 'star without a weight is not a prose group');
  const starTime = applyFullConsumptionGate(
    logSets([{ weight: 185, reps: 5, rir: 2 }]), 'bench 185 5/2 then 3 sets of 8 reps * time');
  assert.equal(starTime.intent, 'log_sets', 'reps * time is not a prose group');
});

test('pack follow-up round 7 K1: prose set-group with enumerated multiplier glyphs and `*` runs refuses', () => {
  // Hammy BLOCKING on f5e4d374 (K1): round 6 widened the prose slots to
  // ASCII `*` only, but the gate's own enumerated multiplier glyphs
  // (`✕ ✗ ✖ ＊ Ｘ ｘ`) still dropped the group in both slots, as did
  // runs of `*` (`**`, `***`, `* *`, `x*`, `×*`) and markdown-bolded
  // numbers (`**8**`, `**165**`). Full enumeration, both slots:
  for (const glyph of ['✕', '✗', '✖', '＊', 'Ｘ', 'ｘ']) {
    for (const text of [
      `bench 185 5/2 then 3 sets ${glyph} 8 at 165`,
      `bench 185 5/2 then 3 sets of 8 reps ${glyph} 165`,
    ]) {
      const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
      assert.equal(out.intent, 'needs_clarification', text);
      assert.ok(out.warnings.includes('repeated_set_group'), text);
      assert.equal(out.sets, undefined, text);
    }
  }
  for (const text of [
    'bench 185 5/2 then 3 sets ** 8 at 165',
    'bench 185 5/2 then 3 sets *** 8 at 165',
    'bench 185 5/2 then 3 sets * * 8 at 165',
    'bench 185 5/2 then 3 sets **8** at 165',
    'bench 185 5/2 then 3 sets of **8** at 165',
    'bench 185 5/2 then 3 sets x* 8 at 165',
    'bench 185 5/2 then 3 sets ×* 8 at 165',
    'bench 185 5/2 then 3 sets of 8 reps ** 165',
    'bench 185 5/2 then 3 sets of 8 reps * **165**',
    // A bold marker separated from its number by a space is the same
    // dropped group, not a tight multiplier.
    'bench 185 5/2 then 3 sets of 8 ** at 165',
    'bench 185 5/2 then 3 sets of ** 8 at 165',
  ]) {
    const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
  // The disclosed tight forms stay out of scope: only a run of two or
  // more glyphs may abut the count, because `**8**` is bolded reps.
  for (const text of [
    'bench 185 5/2 then 3 sets*8 at 165',
    'bench 185 5/2 then 3 sets *8 at 165',
    'bench 185 5/2 then 3 sets* 8 at 165',
    'bench 185 5/2 then 3 sets of 8-165',
  ]) {
    const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
    assert.equal(out.intent, 'log_sets', text);
  }
});

test('pack follow-up round 8 L1/L2/L3: prose set-group with other multiplier glyphs, markdown wraps, and glyph after a preposition refuses', () => {
  // Hammy BLOCKING on d1c77884 (round 7, L1–L3): the round-7 fix enumerated
  // the gate's own six glyphs, but twenty same-class bypasses still dropped
  // the group — other multiplier-like glyphs (L1), markdown-wrapped numbers
  // (L2), and a glyph after a preposition/dash (L3). Fix direction: a broader
  // multiplier-like class (a generic non-alphanumeric separator run), balanced
  // markdown wraps, and an optional glyph run after the word/dash preposition
  // — not one more enumeration.
  // L1 — other multiplier-like glyphs, both slots (9 glyphs; ✘ and ∗ in both
  // slots, the other seven in the count slot — 11 cases in the verdict).
  for (const glyph of ['✘', '❌', '∗', '✳', '✱', '╳', '⨯', '⋅', '·']) {
    for (const text of [
      `bench 185 5/2 then 3 sets ${glyph} 8 at 165`,
      `bench 185 5/2 then 3 sets of 8 reps ${glyph} 165`,
    ]) {
      const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
      assert.equal(out.intent, 'needs_clarification', text);
      assert.ok(out.warnings.includes('repeated_set_group'), text);
      assert.equal(out.sets, undefined, text);
    }
  }
  // L2 — markdown wraps (5): single-`*`/`_`-wrapped numbers, and the
  // `**8 reps**` form where the closer follows "reps".
  for (const text of [
    'bench 185 5/2 then 3 sets __8__ at 165',
    'bench 185 5/2 then 3 sets _8_ at 165',
    'bench 185 5/2 then 3 sets *8* at 165',
    'bench 185 5/2 then 3 sets of 8 reps at *165*',
    'bench 185 5/2 then 3 sets of **8 reps** at 165',
  ]) {
    const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
  // L3 — glyph after a preposition/dash (4).
  for (const text of [
    'bench 185 5/2 then 3 sets of 8 with ✕ 165',
    'bench 185 5/2 then 3 sets of 8 for ✕ 165',
    'bench 185 5/2 then 3 sets of 8 at ✕ 165',
    'bench 185 5/2 then 3 sets of 8 - ✕ 165',
    // A two-atom run may abut the weight, parallel to `**165`: `-✕` is a
    // dash-plus-glyph run, so `-✕165` refuses even with no space before the
    // digits. A single atom abutting the weight still logs (below).
    'bench 185 5/2 then 3 sets of 8 -✕165',
  ]) {
    const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
  // Pre-review findings on this head, fixed before handback: bracket-wrapped
  // numbers are the same L2 class, and clause punctuation tight against its
  // word is the same L1 separator class (see the Round 8 comment in the gate).
  // A second hunt round found the same wrap class on quoted numbers and on
  // the structural words themselves (sets-count, `sets`, separator, `reps`,
  // preposition) — every position in the prose pattern may carry a wrap.
  for (const text of [
    'bench 185 5/2 then 3 sets (8) at 165',
    'bench 185 5/2 then 3 sets [8] at 165',
    'bench 185 5/2 then 3 sets {8} at 165',
    'bench 185 5/2 then 3 sets of 8 reps at (165)',
    'bench 185 5/2 then 3 sets of 8 reps at [165]',
    'bench 185 5/2 then 3 sets: 8 at 165',
    'bench 185 5/2 then 3 sets, 8 at 165',
    'bench 185 5/2 then 3 sets. 8 at 165',
    'bench 185 5/2 then 3 sets of: 8 at 165',
    'bench 185 5/2 then 3 sets of 8 reps: 165',
    'bench 185 5/2 then 3 sets of 8 reps, 165',
    'bench 185 5/2 then 3 sets "8" at 165',
    "bench 185 5/2 then 3 sets '8' at 165",
    'bench 185 5/2 then 3 sets of 8 reps at "165"',
    'bench 185 5/2 then 3 **sets** of 8 at 165',
    'bench 185 5/2 then 3 *sets* of 8 at 165',
    'bench 185 5/2 then **3** sets of 8 at 165',
    'bench 185 5/2 then *3* sets of 8 at 165',
    'bench 185 5/2 then (3) sets of 8 at 165',
    'bench 185 5/2 then "3" sets of 8 at 165',
    'bench 185 5/2 then 3 sets **of** 8 at 165',
    'bench 185 5/2 then 3 sets "of" 8 at 165',
    'bench 185 5/2 then 3 sets (of) 8 at 165',
    'bench 185 5/2 then 3 sets of 8 **reps** at 165',
    'bench 185 5/2 then 3 sets of 8 *reps* at 165',
    'bench 185 5/2 then 3 sets of 8 reps **at** 165',
    'bench 185 5/2 then 3 sets of 8 reps *at* 165',
    'bench 185 5/2 then 3 sets of 8 reps _at_ 165',
    'bench 185 5/2 then 3 sets of 8 reps "at" 165',
    'bench 185 5/2 then 3 sets of 8 reps (at) 165',
    'bench 185 5/2 then 3 sets of 8 reps **at 165**',
  ]) {
    const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
    assert.equal(out.intent, 'needs_clarification', text);
    assert.ok(out.warnings.includes('repeated_set_group'), text);
    assert.equal(out.sets, undefined, text);
  }
  // Scope holds: a single marker that abuts a number with no closer is still
  // the disclosed tight form — it logs, exactly as `3 sets *8` does. The
  // wrap refuses only when the closer is present; a glyph run abutting the
  // weight with no space before the digits is likewise out of scope.
  for (const text of [
    'bench 185 5/2 then 3 sets of *8 at 165',
    'bench 185 5/2 then 3 sets of 8 reps at *165',
    'bench 185 5/2 then 3 sets of 8 with✕165',
    'bench 185 5/2 then 3 sets.8 at 165',
    'bench 185 5/2 then 3 sets (8 at 165',
    "bench 185 5/2 then 3 sets of 8's at 165",
    'bench 185 5/2 then 3 sets of 8 (warm-up) at 165',
    "bench 185 5/2 then 3 sets of Ben's 8 at 165",
  ]) {
    const out = applyFullConsumptionGate(logSets([{ weight: 185, reps: 5, rir: 2 }]), text);
    assert.equal(out.intent, 'log_sets', text);
  }
});

test('pack follow-up: legit repeats and non-zero counts still log untouched', () => {
  const three = [
    { weight: 185, reps: 5, rir: 2 },
    { weight: 185, reps: 5, rir: 2 },
    { weight: 185, reps: 5, rir: 2 },
  ];
  const slashRepeat = applyFullConsumptionGate(logSets(three), 'bench 185 5/2 x3');
  assert.equal(slashRepeat.intent, 'log_sets', 'x3 is the slash group\'s own repeat count');
  assert.deepEqual(slashRepeat, logSets(three));
  const tenSets = applyFullConsumptionGate(logSets(X165_SETS), 'bench 3x8@165 10 sets');
  assert.equal(tenSets.intent, 'log_sets', '"10 sets" states no zero quantity');
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
