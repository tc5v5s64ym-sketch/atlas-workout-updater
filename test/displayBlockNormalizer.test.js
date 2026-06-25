const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeDisplayBlocks,
  looksLikeDisplayBlock,
  parseDisplaySetLine,
  isSetLine,
  isHeaderLine,
  cleanHeaderName
} = require('../public/displayBlockNormalizer');

const { parseWorkoutText } = require('../services/workoutTextParser');

test('parseDisplaySetLine: "135 lb × 10" → weight 135, reps 10, lb, not warm-up', () => {
  assert.deepEqual(parseDisplaySetLine('135 lb × 10'), { weight: 135, reps: 10, warmup: false, unit: 'lb' });
});

test('parseDisplaySetLine: ascii x and no unit — "185x5"', () => {
  assert.deepEqual(parseDisplaySetLine('185x5'), { weight: 185, reps: 5, warmup: false, unit: null });
});

test('parseDisplaySetLine: warm-up annotation is flagged, not parsed into reps', () => {
  assert.deepEqual(parseDisplaySetLine('135 lb × 10 · warm-up'), { weight: 135, reps: 10, warmup: true, unit: 'lb' });
  assert.equal(parseDisplaySetLine('45 × 12 (W)').warmup, true);
  assert.equal(parseDisplaySetLine('45 × 12 warmup').warmup, true);
});

test('parseDisplaySetLine: kg unit normalizes to "kg" and keeps the raw number (no conversion)', () => {
  assert.deepEqual(parseDisplaySetLine('60 kg × 8'), { weight: 60, reps: 8, warmup: false, unit: 'kg' });
});

test('parseDisplaySetLine: decimal weight allowed (dumbbells)', () => {
  assert.deepEqual(parseDisplaySetLine('52.5 lb × 8'), { weight: 52.5, reps: 8, warmup: false, unit: 'lb' });
});

test('parseDisplaySetLine: returns null for non-display lines', () => {
  assert.equal(parseDisplaySetLine('Bench Press'), null);
  assert.equal(parseDisplaySetLine('225 5/2'), null, 'slash notation is NOT a display set line');
  assert.equal(parseDisplaySetLine(''), null);
});

test('isHeaderLine / isSetLine: a bare exercise name is a header, not a set line', () => {
  assert.equal(isHeaderLine('Bench Press'), true);
  assert.equal(isSetLine('Bench Press'), false);
  assert.equal(isSetLine('135 lb × 10'), true);
  assert.equal(isHeaderLine('135 lb × 10'), false);
  assert.equal(isHeaderLine('   '), false);
});

test('cleanHeaderName: strips a trailing " · Barbell" equipment annotation', () => {
  assert.equal(cleanHeaderName('Bench Press · Barbell'), 'Bench Press');
  assert.equal(cleanHeaderName('Lat Pulldown'), 'Lat Pulldown');
});

test('normalizeDisplayBlocks: a single Strong-style block → one block with faithful + working canonical text', () => {
  const text = 'Bench Press\n135 lb × 10 · warm-up\n185 lb × 5\n185 lb × 5';
  const result = normalizeDisplayBlocks(text);
  assert.equal(result.isDisplayBlock, true);
  assert.equal(result.blocks.length, 1);
  const block = result.blocks[0];
  assert.equal(block.name, 'Bench Press');
  assert.equal(block.sets.length, 3);
  assert.equal(block.warmupCount, 1);
  assert.equal(block.workingSetCount, 2);
  assert.equal(block.canonicalText, 'Bench Press 135 10 185 5 185 5');
  assert.equal(block.canonicalTextWorkingOnly, 'Bench Press 185 5 185 5');
});

test('normalizeDisplayBlocks: multiple stacked workouts → one block each, in order', () => {
  const text = [
    'Bench Press',
    '185 lb × 5',
    '185 lb × 5',
    '',
    'Lat Pulldown',
    '120 lb × 12',
    '120 lb × 10',
    '',
    'Leg Press',
    '360 lb × 10'
  ].join('\n');
  const result = normalizeDisplayBlocks(text);
  assert.equal(result.isDisplayBlock, true);
  assert.deepEqual(result.blocks.map(b => b.name), ['Bench Press', 'Lat Pulldown', 'Leg Press']);
  assert.equal(result.blocks[0].canonicalText, 'Bench Press 185 5 185 5');
  assert.equal(result.blocks[1].canonicalText, 'Lat Pulldown 120 12 120 10');
  assert.equal(result.blocks[2].canonicalText, 'Leg Press 360 10');
});

test('normalizeDisplayBlocks: stacked blocks WITHOUT blank separators (header break splits them)', () => {
  const text = 'Bench Press\n185 × 5\nLat Pulldown\n120 × 12';
  const result = normalizeDisplayBlocks(text);
  assert.equal(result.isDisplayBlock, true);
  assert.deepEqual(result.blocks.map(b => b.name), ['Bench Press', 'Lat Pulldown']);
});

test('normalizeDisplayBlocks: NOT a display block — single-line slash notation passes through', () => {
  // The proven parser owns this; the normalizer must not claim it.
  assert.equal(normalizeDisplayBlocks('bench 225 5/2').isDisplayBlock, false);
  assert.equal(normalizeDisplayBlocks('225 5/2 x3').isDisplayBlock, false);
  assert.equal(looksLikeDisplayBlock('squat 315 3/1'), false);
});

test('normalizeDisplayBlocks: a set line with no preceding header bails out entirely (ambiguous)', () => {
  // "135 lb × 10" with nothing naming it — leave it to the proven parser rather
  // than coin a nameless block.
  const result = normalizeDisplayBlocks('135 lb × 10\n185 lb × 5');
  assert.equal(result.isDisplayBlock, false);
  assert.deepEqual(result.blocks, []);
});

test('normalizeDisplayBlocks: a mid-paste prose line makes it ambiguous → bail', () => {
  const text = 'Bench Press\n185 × 5\nfelt strong today, moving up next week';
  const result = normalizeDisplayBlocks(text);
  assert.equal(result.isDisplayBlock, false);
});

test('normalizeDisplayBlocks: empty / whitespace input is not a display block', () => {
  assert.equal(normalizeDisplayBlocks('').isDisplayBlock, false);
  assert.equal(normalizeDisplayBlocks('   \n  \n').isDisplayBlock, false);
});

test('normalizeDisplayBlocks: header with no following sets is dropped (no empty block)', () => {
  const text = 'Bench Press\n185 × 5\n\nStretching';
  const result = normalizeDisplayBlocks(text);
  // "Stretching" never gets a set line, so it is not emitted as a block.
  assert.deepEqual(result.blocks.map(b => b.name), ['Bench Press']);
});

// Contract guard: the canonical text the normalizer emits must actually parse
// with the EXISTING proven parser — that is the whole point of the pre-pass.
test('integration: each block canonicalText parses cleanly via the existing parseWorkoutText', () => {
  const text = 'Bench Press\n135 lb × 10 · warm-up\n185 lb × 5\n185 lb × 5\n\nLat Pulldown\n120 lb × 12\n120 lb × 10';
  const { blocks } = normalizeDisplayBlocks(text);

  const bench = parseWorkoutText(blocks[0].canonicalText);
  assert.equal(bench.intent, 'log_sets', JSON.stringify(bench));
  assert.equal(bench.canonical_exercise || bench.exercise, 'Bench Press');
  assert.equal(bench.sets.length, 3);
  assert.deepEqual(bench.sets.map(s => [s.weight, s.reps]), [[135, 10], [185, 5], [185, 5]]);

  const benchWorking = parseWorkoutText(blocks[0].canonicalTextWorkingOnly);
  assert.equal(benchWorking.sets.length, 2, 'working-only drops the warm-up set');
  assert.deepEqual(benchWorking.sets.map(s => [s.weight, s.reps]), [[185, 5], [185, 5]]);

  const pulldown = parseWorkoutText(blocks[1].canonicalText);
  assert.equal(pulldown.intent, 'log_sets', JSON.stringify(pulldown));
  assert.equal(pulldown.sets.length, 2);
  assert.deepEqual(pulldown.sets.map(s => [s.weight, s.reps]), [[120, 12], [120, 10]]);
});
