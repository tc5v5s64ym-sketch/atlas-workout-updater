'use strict';

// Prose-slot gate design ledger — Astra 6.2 design of record (#1765,
// comment 7049597345). Generated from the design's case ledger; do not
// edit by hand. Route cases run the real route (parseWorkoutText +
// applyFullConsumptionGate) and assert the design's binary expect.
// Direct (gate-entry) cases are skipped: their fixtures live in
// attack-corpus.json, held by the coordinator — never reconstructed
// by guesswork. The five precision survivors are extra asks, not logs:
// the design still requires REFUSE on them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkoutText } = require('../services/workoutTextParser');
const { applyFullConsumptionGate } = require('../services/fullConsumptionGate');

function rowsOf(result) {
  if (Array.isArray(result.sets)) return result.sets;
  if (Array.isArray(result.exercises)) return result.exercises.flatMap(e => e.sets || []);
  return [];
}

test('marks-1 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8́via165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('marks-2 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8\u0000at165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('marks-3 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8󠂀at165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('marks-4 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8🧑‍🦽at165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('marks-5 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8＿at165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('marks-6 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8at165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('anchors-1 expects REFUSE', () => {
  const text = "bench 185 5/2 then threeѕets of eight at 165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('anchors-2 expects REFUSE', () => {
  const text = "bench 185 5/2 then threesetseightrepsat165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('anchors-3 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3se⁠ts8reṕs165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('anchors-4 expects REFUSE', () => {
  const text = "bench 185 5/2 then ３ｓｅｔｓ８ａｔ１６５";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('anchors-5 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 s.e.t.s of 8 at 165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('anchors-6 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3totalsetsaround8reps165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test.skip('anchors-7 expects REFUSE (direct — fixture in attack-corpus.json)', () => {});
test('numbers-1 expects REFUSE', () => {
  const text = "bench 185 5/2 then ٣ sets of ۸ at ۱۶۵";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('numbers-2 expects REFUSE', () => {
  const text = "bench 185 5/2 then Ⅲ sets of ⑧ at ⅭⅬⅩⅤ";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('numbers-3 expects REFUSE', () => {
  const text = "bench 185 5/2 then 𝟛 sets of 𝟠 at 𝟙𝟞𝟝";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('numbers-4 expects REFUSE', () => {
  const text = "bench 185 5/2 then three sets of eight at two hundred and five";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('numbers-5 expects REFUSE', () => {
  const text = "bench 185 5/2 then three sets of eight at onehundredandsixtyfive";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('numbers-6 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8#１６５";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('bounds-1 expects REFUSE', () => {
  const text = "bench 185 5/2 then 4sets7reps149";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('bounds-2 expects REFUSE', () => {
  const text = "bench 185 5/2 then 4 sets for each of these 7 at 149";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('bounds-3 expects REFUSE', () => {
  const text = "bench 185 5/2 then 4 sets for each one of these 7 at 149";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('bounds-4 expects REFUSE', () => {
  const text = "bench 185 5/2 then 4 sets of ✦ ✦ ✦ ✦ ✦ 7 at 149";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('bounds-5 expects REFUSE', () => {
  const text = "bench 185 5/2 then 4 sets of 7 ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± ± 149";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('bounds-6 expects REFUSE', () => {
  const text = "bench 185 5/2 then 4 very very very very very very very very very very very very sets of seven at 149";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('bounds-7 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of of of of of 8 at 165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('bounds-8 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8 at at at at at 165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('dash-1 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8֊165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('dash-2 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8⸺via165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('dash-3 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8 via−165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('dash-4 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3‑total‐sets8―at165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('dash-5 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8 𐵮 165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('dash-6 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8˗at165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('mixed-1 expects REFUSE', () => {
  const text = "bench 185 5/2 then **3**sets[of]8️⃣—via✕165lb";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('mixed-2 expects REFUSE', () => {
  const text = "bench 185 5/2 then three✣sets∕eight­@one-hundred-sixty-five";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('mixed-3 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3»sets8⑴via‑１６５";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('mixed-4 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3sets of8.165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('mixed-5 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets of 8165 at one hundred";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('collision-1 expects REFUSE', () => {
  const text = "bench 165 8/2 x3 then 3 sets of 8 at 165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('collision-2 expects REFUSE', () => {
  const text = "bench three sets of eight at 165 then 165 8/2 x3";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('collision-3 expects REFUSE', () => {
  const text = "bench 165 8/2 x3 then 3 sets of eight at 166";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('collision-4 expects REFUSE', () => {
  const text = "bench 185 5/2 x2 then 3 sets x2 at 185";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('collision-5 expects REFUSE', () => {
  const text = "bench 185 5/2 x2 then 3 sets of 5 x2 at 185";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('scope-1 expects REFUSE', () => {
  const text = "bench 185 5/2 then squat 225 3sets8 via 155";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('scope-2 expects LOG', () => {
  const text = "bench 185 5/2\nsquat 225 3 sets8 via 155";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('scope-3 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3\nsets8⁠at165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('scope-4 expects REFUSE', () => {
  const text = "bench 185 5/2\n\nThen 3 sets8…at165.";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('scope-5 expects LOG', () => {
  const text = "bench 185 5/2\nsquat 225 5/2\nbench 205 5/2 then 3 sets8 via 155";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('scope-6 expects LOG', () => {
  const text = "bench 185 5/2\nbench 165 8/2";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('scope-7 expects REFUSE', () => {
  const text = "bench 185 5/2\nsquat 225 5/2 then 3 sets8 at 165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('scope-8 expects REFUSE', () => {
  const text = "bench 185 5/2\nsquat 225 5/2\nbench 205 5/2 then 3 sets8 at 165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('scope-9 expects REFUSE', () => {
  const text = "bench 185 5/2\nsquat 225 3 sets of 8 at 165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('r2-1 expects REFUSE', () => {
  const text = "bench 185 5/2 then three sets of nine, same as earlier";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('r2-2 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 sets ofnine";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('r2-3 expects REFUSE', () => {
  const text = "bench 185 5/2 then three sets of eight reps only";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('r2-4 expects REFUSE', () => { // precision survivor: extra ask, still REFUSE
  const text = "bench 185 8/2 x3 (three sets of eight)";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('r2-5 expects REFUSE', () => {
  const text = "bench 185 8/2 x3 then (three sets of eight)";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('r2-6 expects LOG', () => {
  const text = "bench 185 8/2 x3 three sets done";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('r2-7 expects REFUSE', () => { // precision survivor: extra ask, still REFUSE
  const text = "bench 185 8/2 x3 (three sets of eight)";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('r2-8 expects REFUSE', () => {
  const text = "bench 185 5/2 then threesetsofeight";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('r2-9 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 totalsets ofeight";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('affirm-1 expects LOG', () => {
  const text = "Goblet Squat 37 pound one, 4 sets of 9";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('affirm-2 expects LOG', () => {
  const text = "Goblet Squat 37 pound one, 4 sets of 9. Tank answer: 1. Maybe 1.";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('affirm-3 expects REFUSE', () => {
  const text = "Goblet Squat 37 pound one, 4 sets of 9 at two hundred";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('affirm-4 expects LOG', () => {
  const text = "did 4 sets of bench 175 6/2 x4";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('affirm-5 expects REFUSE', () => {
  const text = "did 4 sets of bench 175 6/2 x3";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('affirm-6 expects LOG', () => {
  const text = "bench all 3 sets stopped at 8 instead of 10";
  const context = {"todayPlan": ["Bench Press 185 10/2 x3"]};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('affirm-7 expects REFUSE', () => {
  const text = "bench all 3 sets stopped at 8 instead of 10 then three sets of eight at thirty";
  const context = {"todayPlan": ["Bench Press 185 10/2 x3"]};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('affirm-8 expects LOG', () => {
  const text = "Rows done, 30 pounds, 10 each arm, 3 sets. Tank answer: 2. Plank 40 seconds!! That is a record for me.";
  const context = {"todayPlan": ["One-Arm Row 30 10 x3"]};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('affirm-9 expects LOG', () => {
  const text = "Ok squats done!! I did the 35 pound one, 3 sets of 10. Honestly the last set the answer was like... 1? Maybe 1.";
  const context = {"todayPlan": ["Goblet Squat 35 10/2 x3"]};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('negative-1 expects LOG', () => {
  const text = "bench 155 6/2 x8.";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('negative-2 expects LOG', () => {
  const text = "bench 155 6/2 x08";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('negative-3 expects LOG', () => {
  const text = "bench 155 6/2, felt solid";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('negative-4 expects LOG', () => {
  const text = "bench 155 6/2 did three sets of bench";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('negative-5 expects LOG', () => {
  const text = "bench 3x6@155 3 sets";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('negative-6 expects LOG', () => {
  const text = "bench 155 6/2 then 3 sets for time";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('negative-7 expects REFUSE', () => { // precision survivor: extra ask, still REFUSE
  const text = "bench 185 5/2 x2 headset is gone";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('negative-8 expects LOG', () => {
  const text = "bench 185 5/2 x2 my mindset improved";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('repair-1 expects REFUSE', () => {
  const text = "Goblet Squat 35 pound one, 3 sets of 10. Tank answer: 2. Then 3 sets of ten at thirty-five.";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('repair-2 expects REFUSE', () => {
  const text = "bench 185 8/2 x3 (three sets of eight) then three sets of eight at one hundred";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('repair-3 expects REFUSE', () => {
  const text = "bench 185 8/2 x3 (three sets of eight at 165)";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('repair-4 expects REFUSE', () => {
  const text = "bench 185 8/2 x3 (four sets of eight)";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('repair-5 expects REFUSE', () => {
  const text = "bench 185 8/2 x3 (three sets of nine)";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('repair-6 expects REFUSE', () => {
  const text = "bench 185 5/2 x3 did 3 sets\nbench 165 8/2";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('weak-1 expects REFUSE', () => {
  const text = "bench 185 5/2 then 3 very totalsetsaround ofeight";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('weak-2 expects REFUSE', () => {
  const text = "bench 185 5/2 then x3 very worksetsagain ofeight";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('weak-3 expects REFUSE', () => {
  const text = "bench 185 5/2 x3 worksets ofeight";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('weak-4 expects REFUSE', () => {
  const text = "bench 185 5/2 x3 worksets ofeight atone";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('weak-5 expects REFUSE', () => { // precision survivor: extra ask, still REFUSE
  const text = "bench 185 5/2 x2 headset is gone on my phone";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('weak-6 expects LOG', () => {
  const text = "bench 185 5/2 x2 headset feels fine";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('weak-7 expects REFUSE', () => { // precision survivor: extra ask, still REFUSE
  const text = "bench 205 4/3 x2 headset is gone";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test.skip('evidence-1 expects REFUSE (direct — fixture in attack-corpus.json)', () => {});
test.skip('evidence-2 expects REFUSE (direct — fixture in attack-corpus.json)', () => {});
test.skip('evidence-3 expects REFUSE (direct — fixture in attack-corpus.json)', () => {});
test.skip('evidence-4 expects REFUSE (direct — fixture in attack-corpus.json)', () => {});
test.skip('evidence-5 expects LOG (direct — fixture in attack-corpus.json)', () => {});
test.skip('evidence-6 expects REFUSE (direct — fixture in attack-corpus.json)', () => {});
test.skip('evidence-7 expects LOG (direct — fixture in attack-corpus.json)', () => {});
test.skip('evidence-8 expects REFUSE (direct — fixture in attack-corpus.json)', () => {});
test.skip('boundaries-1 expects REFUSE (direct — fixture in attack-corpus.json)', () => {});
test.skip('boundaries-2 expects REFUSE (direct — fixture in attack-corpus.json)', () => {});
test('boundaries-3 expects LOG', () => {
  const text = "Goblet Squat 35 pound one,\n3 sets of 10";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test.skip('boundaries-4 expects LOG (direct — fixture in attack-corpus.json)', () => {});
test('boundaries-5 expects REFUSE', () => {
  const text = "bench 185 5/2\n\nThree sets of 8 at one hundred and sixty-five.";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('intro-1 expects LOG', () => {
  const text = "did three sets of bench 3x8@165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('intro-2 expects LOG', () => {
  const text = "did 3 sets of bench 185 x 5 x 3";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('intro-3 expects LOG', () => {
  const text = "did 3 sets of bench 185 for 5 three times";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('intro-4 expects REFUSE', () => {
  const text = "did three sets of bench 2x8@165";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('intro-5 expects REFUSE', () => {
  const text = "did three sets of bench 3x8@165 then 3 sets of six at one hundred";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.equal(result.intent, 'needs_clarification', `expected REFUSE, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(rowsOf(result).length, 0, 'a refusal contains zero previewable rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});

test('intro-6 expects LOG', () => {
  const text = "did 1 set of bench 185 5/2";
  const context = {};
  const parsed = parseWorkoutText(text, context);
  const snapshot = JSON.stringify(parsed);
  const result = applyFullConsumptionGate(parsed, text);
  assert.ok(result.intent === 'log_sets' || result.intent === 'log_sets_multi', `expected LOG, got ${result.intent}: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(rowsOf(result).length > 0, 'a LOG keeps its preview rows');
  assert.equal(JSON.stringify(parsed), snapshot, 'gate must not mutate its input');
});
