const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeDisplayBlocks,
  looksLikeDisplayBlock,
  parseDisplaySetLine,
  isSetLine,
  setLineHasLeftoverSets,
  isHeaderLine,
  cleanHeaderName
} = require('../public/displayBlockNormalizer');

const { parseWorkoutText } = require('../services/workoutTextParser');

// --- parseDisplaySetLine: the real Atlas/app set-line formats ---

test('parseDisplaySetLine: real Atlas warm-up line "135lbs 10 · warm-up" → flagged, no RIR', () => {
  assert.deepEqual(parseDisplaySetLine('135lbs 10 · warm-up'),
    { weight: 135, reps: 10, rir: null, warmup: true, unit: 'lb' });
});

test('parseDisplaySetLine: real Atlas working line "245lbs 6/2" → reps 6, RIR 2, not warm-up', () => {
  assert.deepEqual(parseDisplaySetLine('245lbs 6/2'),
    { weight: 245, reps: 6, rir: 2, warmup: false, unit: 'lb' });
});

test('parseDisplaySetLine: "135 lb × 10" (× separator) → weight 135, reps 10, lb', () => {
  assert.deepEqual(parseDisplaySetLine('135 lb × 10'),
    { weight: 135, reps: 10, rir: null, warmup: false, unit: 'lb' });
});

test('parseDisplaySetLine: ascii x and no unit — "185x5"', () => {
  assert.deepEqual(parseDisplaySetLine('185x5'),
    { weight: 185, reps: 5, rir: null, warmup: false, unit: null });
});

test('parseDisplaySetLine: coach composer-hint warm-up token "135x10wu" → flagged warm-up', () => {
  assert.deepEqual(parseDisplaySetLine('135x10wu'),
    { weight: 135, reps: 10, rir: null, warmup: true, unit: null });
});

test('parseDisplaySetLine: warm-up annotations are flagged, not parsed into reps', () => {
  assert.equal(parseDisplaySetLine('45 × 12 (W)').warmup, true);
  assert.equal(parseDisplaySetLine('45 × 12 warmup').warmup, true);
  assert.equal(parseDisplaySetLine('45 × 12 · warm up').warmup, true);
});

test('parseDisplaySetLine: kg unit normalizes to "kg" and keeps the raw number (no conversion)', () => {
  assert.deepEqual(parseDisplaySetLine('60 kg × 8'),
    { weight: 60, reps: 8, rir: null, warmup: false, unit: 'kg' });
});

test('parseDisplaySetLine: decimal weight allowed (dumbbells)', () => {
  assert.deepEqual(parseDisplaySetLine('52.5 lb × 8'),
    { weight: 52.5, reps: 8, rir: null, warmup: false, unit: 'lb' });
});

test('parseDisplaySetLine: a bare slash line IS a set line (block-level header guard handles ambiguity)', () => {
  assert.deepEqual(parseDisplaySetLine('225 5/2'),
    { weight: 225, reps: 5, rir: 2, warmup: false, unit: null });
});

test('parseDisplaySetLine: returns null for non-set lines', () => {
  assert.equal(parseDisplaySetLine('Bench Press'), null);
  assert.equal(parseDisplaySetLine('10'), null, 'a lone number is not a set');
  assert.equal(parseDisplaySetLine(''), null);
});

test('isHeaderLine / isSetLine: a bare exercise name is a header, not a set line', () => {
  assert.equal(isHeaderLine('Bench Press'), true);
  assert.equal(isSetLine('Bench Press'), false);
  assert.equal(isSetLine('135lbs 10 · warm-up'), true);
  assert.equal(isHeaderLine('135lbs 10 · warm-up'), false);
  assert.equal(isHeaderLine('   '), false);
});

test('cleanHeaderName: strips a trailing " · Barbell" equipment annotation', () => {
  assert.equal(cleanHeaderName('Bench Press · Barbell'), 'Bench Press');
  assert.equal(cleanHeaderName('Lat Pulldown'), 'Lat Pulldown');
});

// --- normalizeDisplayBlocks: the exact paste from the live screenshots (IMG_4895) ---

test('normalizeDisplayBlocks: the real two-exercise live paste (Deadlift + Bench) splits correctly', () => {
  const text = [
    'Deadlift',
    '135lbs 10 · warm-up',
    '185lbs 10 · warm-up',
    '225lbs 8 · warm-up',
    '245lbs 6/2',
    '245lbs 6/2',
    '245lbs 6/2',
    'Bench Press',
    '140lbs 15 · warm-up',
    '190lbs 10 · warm-up',
    '230lbs 5/2',
    '230lbs 5/2',
    '230lbs 5/2'
  ].join('\n');
  const result = normalizeDisplayBlocks(text);
  assert.equal(result.isDisplayBlock, true);
  assert.deepEqual(result.blocks.map(b => b.name), ['Deadlift', 'Bench Press']);

  const dl = result.blocks[0];
  assert.equal(dl.sets.length, 6);
  assert.equal(dl.warmupCount, 3);
  assert.equal(dl.workingSetCount, 3);
  assert.equal(dl.canonicalText, 'Deadlift 135 10 185 10 225 8 245 6/2 245 6/2 245 6/2');
  assert.equal(dl.canonicalTextWorkingOnly, 'Deadlift 245 6/2 245 6/2 245 6/2');

  const bench = result.blocks[1];
  assert.equal(bench.sets.length, 5);
  assert.equal(bench.warmupCount, 2);
  assert.equal(bench.canonicalText, 'Bench Press 140 15 190 10 230 5/2 230 5/2 230 5/2');
});

test('normalizeDisplayBlocks: × display format with warm-ups still works', () => {
  const text = 'Bench Press\n135 lb × 10 · warm-up\n185 lb × 5\n185 lb × 5';
  const result = normalizeDisplayBlocks(text);
  assert.equal(result.isDisplayBlock, true);
  const block = result.blocks[0];
  assert.equal(block.name, 'Bench Press');
  assert.equal(block.warmupCount, 1);
  assert.equal(block.canonicalText, 'Bench Press 135 10 185 5 185 5');
  assert.equal(block.canonicalTextWorkingOnly, 'Bench Press 185 5 185 5');
});

test('normalizeDisplayBlocks: stacked blocks WITHOUT blank separators (header break splits them)', () => {
  const text = 'Bench Press\n185 × 5\nLat Pulldown\n120 × 12';
  const result = normalizeDisplayBlocks(text);
  assert.equal(result.isDisplayBlock, true);
  assert.deepEqual(result.blocks.map(b => b.name), ['Bench Press', 'Lat Pulldown']);
});

test('normalizeDisplayBlocks: NOT a display block — single-line slash notation passes through', () => {
  // The proven parser owns this; the normalizer must not claim a headerless line.
  assert.equal(normalizeDisplayBlocks('bench 225 5/2').isDisplayBlock, false);
  assert.equal(normalizeDisplayBlocks('225 5/2 x3').isDisplayBlock, false);
  assert.equal(looksLikeDisplayBlock('squat 315 3/1'), false);
});

test('normalizeDisplayBlocks: a set line with no preceding header bails out entirely (ambiguous)', () => {
  const result = normalizeDisplayBlocks('135lbs 10 · warm-up\n245lbs 6/2');
  assert.equal(result.isDisplayBlock, false);
  assert.deepEqual(result.blocks, []);
});

test('normalizeDisplayBlocks: a mid-paste prose line makes it ambiguous → bail', () => {
  const text = 'Bench Press\n185 × 5\nfelt strong today, moving up next week';
  assert.equal(normalizeDisplayBlocks(text).isDisplayBlock, false);
});

test('normalizeDisplayBlocks: a header + PACKED multi-set line bails (never drops sets silently)', () => {
  // SET_LINE_RE captures only the first set on a line; a packed line would lose the
  // rest. The whole paste must bail to the proven parser, not log one of three sets.
  assert.equal(setLineHasLeftoverSets('225 5/2 225 5/2 225 5/2'), true);
  assert.equal(setLineHasLeftoverSets('245lbs 6/2'), false);
  assert.equal(setLineHasLeftoverSets('135lbs 10 · warm-up'), false);
  const result = normalizeDisplayBlocks('Bench Press\n225 5/2 225 5/2 225 5/2');
  assert.equal(result.isDisplayBlock, false, 'packed multi-set line → bail to proven parser');
  assert.deepEqual(result.blocks, []);
});

test('normalizeDisplayBlocks: empty / whitespace input is not a display block', () => {
  assert.equal(normalizeDisplayBlocks('').isDisplayBlock, false);
  assert.equal(normalizeDisplayBlocks('   \n  \n').isDisplayBlock, false);
});

test('normalizeDisplayBlocks: header with no following sets is dropped (no empty block)', () => {
  const text = 'Bench Press\n185 × 5\n\nStretching';
  assert.deepEqual(normalizeDisplayBlocks(text).blocks.map(b => b.name), ['Bench Press']);
});

// Contract guard: the canonical text the normalizer emits must actually parse
// with the EXISTING proven parser — that is the whole point of the pre-pass.
test('integration: the live two-exercise paste round-trips through the real parseWorkoutText', () => {
  const text = [
    'Deadlift',
    '135lbs 10 · warm-up',
    '185lbs 10 · warm-up',
    '225lbs 8 · warm-up',
    '245lbs 6/2',
    '245lbs 6/2',
    '245lbs 6/2',
    'Bench Press',
    '140lbs 15 · warm-up',
    '190lbs 10 · warm-up',
    '230lbs 5/2',
    '230lbs 5/2',
    '230lbs 5/2'
  ].join('\n');
  const { blocks } = normalizeDisplayBlocks(text);

  const dl = parseWorkoutText(blocks[0].canonicalText);
  assert.equal(dl.intent, 'log_sets', JSON.stringify(dl));
  assert.equal(dl.canonical_exercise || dl.exercise, 'Deadlift');
  assert.equal(dl.sets.length, 6);
  assert.deepEqual(dl.sets.map(s => [s.weight, s.reps, s.rir]), [
    [135, 10, null], [185, 10, null], [225, 8, null],
    [245, 6, 2], [245, 6, 2], [245, 6, 2]
  ]);

  // Working-only drops the 3 warm-ups, keeps the 3 working sets with RIR.
  const dlWorking = parseWorkoutText(blocks[0].canonicalTextWorkingOnly);
  assert.equal(dlWorking.sets.length, 3);
  assert.deepEqual(dlWorking.sets.map(s => [s.weight, s.reps, s.rir]), [[245, 6, 2], [245, 6, 2], [245, 6, 2]]);

  const bench = parseWorkoutText(blocks[1].canonicalText);
  assert.equal(bench.intent, 'log_sets', JSON.stringify(bench));
  assert.equal(bench.sets.length, 5);
});
