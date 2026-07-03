'use strict';

// Tier-2 parser fuzz suite (owner-requested "AI live test every angle",
// 2026-07-03). A deterministic, seeded gym-language corpus is run through the
// REAL parser and the trust invariants are asserted for every input:
//
//   1. TOTALITY      — the parser never throws, whatever the input.
//   2. NO INVENTION  — every parsed weight/rep/RIR literally appears in the
//                      input text (the engine never invents a number).
//   3. NEVER SILENT  — set-bearing input (slash notation present) always
//                      produces sets, unresolved lines, or a clarification —
//                      user intent is never dropped without a trace.
//
// The corpus is SEEDED (mulberry32) — identical on every run, so a failure is
// reproducible by seed + index, never flaky. No Math.random, no Date.
//
// KNOWN FAILURES (t.todo below): the 2026-07-03 sweep found a silent
// MISATTRIBUTION family — an unknown exercise name on a set-bearing line can
// have its sets absorbed by a different, known exercise (worse than dropping:
// it corrupts the wrong lift's history at save). Pinned as executable todo
// reproducers; flip to hard assertions when the parser fix lands (BACKLOG,
// trust-critical).

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseWorkoutText } = require('../services/workoutTextParser');

// ── deterministic corpus ──────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['Bench', 'bench press', 'Squat', 'Back Squat', 'RDL', 'rows', 'Bicep Curl', 'curls',
  'Incline Bench', 'Leg Press', 'Mystery Machine', 'Zzqx Press', 'DB shoulder press', 'OHP', 'deadlift'];
const WEIGHTS = ['225', '185', '52.5', '315', '95', '135'];
const SET_SHAPES = w => [`${w} 5/2`, `${w} 5/2 x3`, `${w}lbs 8/1`, `${w} 12/3`, `${w} 5/2, ${w} 3/1`, `${w} 10/4 x2`];
const NOISE = ['', ' felt heavy', ' PR!!', '  ', ' - solid', ' (paused)'];

function buildCorpus(seed, count) {
  const rand = mulberry32(seed);
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const corpus = [];
  for (let i = 0; i < count; i++) {
    const nLines = 1 + Math.floor(rand() * 4);
    const lines = [];
    for (let l = 0; l < nLines; l++) {
      const w = pick(WEIGHTS);
      lines.push(`${pick(NAMES)} ${pick(SET_SHAPES(w))}${pick(NOISE)}`);
    }
    corpus.push(lines.join('\n'));
  }
  return corpus;
}

const CORPUS = buildCorpus(20260703, 400);

function collectSets(result) {
  const sets = [];
  if (result && Array.isArray(result.sets)) sets.push(...result.sets);
  if (result && Array.isArray(result.exercises)) {
    for (const ex of result.exercises) if (Array.isArray(ex.sets)) sets.push(...ex.sets);
  }
  return sets;
}

function numbersIn(text) { return new Set((String(text).match(/\d+(?:\.\d+)?/g) || []).map(Number)); }

// ── invariant 1+2+3 over the whole corpus ────────────────────────────────────

test('fuzz: totality — the parser never throws across the seeded corpus', () => {
  for (const [i, input] of CORPUS.entries()) {
    assert.doesNotThrow(() => parseWorkoutText(input), `corpus[${i}]: ${JSON.stringify(input)}`);
  }
});

test('fuzz: no invention — every parsed weight/rep/RIR appears literally in the input', () => {
  for (const [i, input] of CORPUS.entries()) {
    const result = parseWorkoutText(input);
    const inputNums = numbersIn(input);
    for (const s of collectSets(result)) {
      for (const [field, v] of [['weight', s.weight], ['reps', s.reps], ['rir', s.rir]]) {
        if (v == null) continue;
        assert.ok(inputNums.has(Number(v)),
          `corpus[${i}]: parsed ${field}=${v} does not appear in ${JSON.stringify(input)}`);
      }
    }
  }
});

test('fuzz: never silent — set-bearing input always leaves a trace (sets, unresolved, or a clarification)', () => {
  for (const [i, input] of CORPUS.entries()) {
    if (!/\d+\s*\/\s*\d+/.test(input)) continue;
    const result = parseWorkoutText(input);
    const sets = collectSets(result);
    const unresolved = Array.isArray(result.unresolved) ? result.unresolved.length : 0;
    const clarifies = result.intent === 'needs_clarification' || Boolean(result.message);
    assert.ok(sets.length > 0 || unresolved > 0 || clarifies,
      `corpus[${i}]: slash-notation input produced no sets, no unresolved lines, and no clarification: ${JSON.stringify(input)}`);
  }
});

// ── the slash contract, exhaustively over its grammar cell ───────────────────

test('fuzz: slash contract — "Name W R/I" parses to exactly {W, R, I} for catalog names', () => {
  const rand = mulberry32(7);
  for (let i = 0; i < 100; i++) {
    const w = [95, 135, 185, 225, 315][Math.floor(rand() * 5)];
    const r = 1 + Math.floor(rand() * 12);
    const rir = Math.floor(rand() * 5);
    const name = ['Bench', 'Squat', 'Deadlift'][Math.floor(rand() * 3)];
    const result = parseWorkoutText(`${name} ${w} ${r}/${rir}`);
    const sets = collectSets(result);
    assert.equal(sets.length, 1, `"${name} ${w} ${r}/${rir}" must parse exactly one set`);
    assert.equal(Number(sets[0].weight), w);
    assert.equal(Number(sets[0].reps), r);
    assert.equal(Number(sets[0].rir), rir);
  }
});

// ── KNOWN FAILURES — the silent-misattribution family (2026-07-03 sweep) ─────
// Executable reproducers, marked todo so CI records them without blocking.
// Flip each `t.todo` to a hard test when the parser fix lands (BACKLOG,
// trust-critical: an unknown name's sets must NEVER attach to another lift).

test('fuzz KNOWN FAILURE: an unknown name sharing a paste with one known lift must not donate its sets to it', t => {
  const input = 'Zzqx Press 185 5/2 - solid\nBench 200 5/2';
  const result = parseWorkoutText(input);
  const sets = collectSets(result);
  const benchSets = Array.isArray(result.sets) && (result.canonical_name === 'Bench Press' || result.exercise === 'Bench Press')
    ? result.sets
    : (result.exercises || []).filter(e => (e.canonical_name || e.exercise) === 'Bench Press').flatMap(e => e.sets || []);
  const misattributed = benchSets.some(s => Number(s.weight) === 185);
  if (misattributed) {
    t.todo('185×5 (Zzqx Press) is absorbed into Bench Press with no warning — silent misattribution');
    return;
  }
  assert.ok(!misattributed, 'fixed! flip this todo into a hard assertion');
  assert.ok(sets.length >= 1, 'the known lift still parses');
});

test('fuzz KNOWN FAILURE: the multi-line rescue must not attach an unknown-name line to the carried exercise', t => {
  const input = 'Leg Press 95 5/2, 95 3/1\nRDL 225 5/2 x3\nZzqx Press 185 5/2 - solid';
  const result = parseWorkoutText(input);
  const rdl = (result.exercises || []).find(e => /RDL|Romanian/i.test(e.canonical_name || e.exercise || ''));
  const phantom = rdl && (rdl.sets || []).some(s => Number(s.weight) === 185);
  if (phantom) {
    t.todo('the Zzqx Press line\'s 185×5 set is merged into RDL by the rescue carry-forward — silent misattribution');
    return;
  }
  assert.ok(!phantom, 'fixed! flip this todo into a hard assertion');
  const unresolved = Array.isArray(result.unresolved) ? result.unresolved : [];
  const traced = unresolved.some(u => /zzqx/i.test(u.line || '')) ||
    (result.exercises || []).some(e => /zzqx/i.test(e.canonical_name || e.exercise || ''));
  assert.ok(traced, 'the unknown-name line must leave a trace (own entry or unresolved)');
});
