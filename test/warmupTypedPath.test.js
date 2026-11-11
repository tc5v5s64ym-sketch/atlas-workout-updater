/**
 * #1564 — warm-up logging, typed/backend path (failing-first).
 *
 * Owner decision (2026-06-25): warm-up sets ARE logged as rows and DO count
 * toward volume; they are excluded ONLY from the progression / weight-bump
 * decision, via an explicit `warm-up` marker in the `notes` column (no
 * warm-up column exists in Log_Cleaned and adding one is owner-gated).
 *
 * What works today: the display-block paste path tags warm-ups
 * (rowsFromDisplayBlocks: `s.warmup ? WARMUP_LOG_NOTE : ''`).
 *
 * What is broken (verified 2026-11-04, reproduced here at head f802ab7b):
 * the typed/backend path tags NOTHING. "Bench Press 140 15 190 10 245 6/2
 * 245 6/2" parses as 4 ordinary working rows (set_type 'working',
 * notes null); rowsFromBackendParsedWorkout maps notes from load_note only
 * ('per_hand' is the only load_note); the parser never sets a warm-up
 * set_type or notes. So the warm-up climb logs untagged and progression
 * falls back to the weight/RIR heuristic — a heavy warm-up leaks in.
 *
 * Required outcome: the bare-pair warm-up climb before the slash working
 * sets is tagged warm-up (parser set_type + `warm-up` notes on the Log
 * rows); the slash working sets stay untagged; every row is still saved
 * (volume counts all sets). Bare pairs with NO slash working set after
 * them are NOT a climb — they stay working (no signal to call them
 * warm-ups); slash-only input stays untagged.
 *
 * Run: node --test test/warmupTypedPath.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseWorkoutText } = require('../services/workoutTextParser');
const { isWarmupNote } = require('../services/warmupTag');

const repoRoot = path.join(__dirname, '..');

function rowsFromBackendParsedWorkout() {
  const appSource = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const converterSource = appSource.slice(
    appSource.indexOf('function rowsFromBackendParsedWorkout(parsed)'),
    appSource.indexOf('async function parseWorkoutTextWithBackend')
  );
  assert.ok(converterSource.length > 0, 'rowsFromBackendParsedWorkout must exist in public/app.js');
  return new Function(`${converterSource}; return rowsFromBackendParsedWorkout;`)();
}

const CLIMB = 'Bench Press 140 15 190 10 245 6/2 245 6/2';

test('#1564: backend parser tags the bare-pair warm-up climb before slash working sets', () => {
  const r = parseWorkoutText(CLIMB);
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.sets.length, 4);
  // The climb: 140x15, 190x10 — lighter bare pairs before the first RIR set.
  assert.equal(r.sets[0].set_type, 'warmup');
  assert.equal(r.sets[1].set_type, 'warmup');
  assert.ok(isWarmupNote(r.sets[0].notes), 'climb set 1 notes must carry the warm-up marker');
  assert.ok(isWarmupNote(r.sets[1].notes), 'climb set 2 notes must carry the warm-up marker');
  // The working sets: 245 6/2, 245 6/2 — untouched.
  assert.equal(r.sets[2].set_type, 'working');
  assert.equal(r.sets[3].set_type, 'working');
  assert.equal(isWarmupNote(r.sets[2].notes), false);
  assert.equal(isWarmupNote(r.sets[3].notes), false);
});

test('#1564: rowsFromBackendParsedWorkout carries the warm-up tag into Log row notes', () => {
  const convert = rowsFromBackendParsedWorkout();
  const r = parseWorkoutText(CLIMB);
  const rows = convert(r);
  assert.equal(rows.length, 4);
  // Tagged rows are still real rows: weight/reps saved, volume counts them.
  assert.deepEqual(rows.map(row => [row.weight, row.reps]), [['140', '15'], ['190', '10'], ['245', '6'], ['245', '6']]);
  assert.equal(rows[0].notes, 'warm-up');
  assert.equal(rows[1].notes, 'warm-up');
  assert.equal(rows[2].notes, '');
  assert.equal(rows[3].notes, '');
  // Progression consumers read the tag, not the heuristic.
  assert.equal(isWarmupNote(rows[0].notes), true);
  assert.equal(isWarmupNote(rows[1].notes), true);
  assert.equal(isWarmupNote(rows[2].notes), false);
  assert.equal(isWarmupNote(rows[3].notes), false);
});

test('#1564: boundary — bare pairs with no slash working set after them stay working', () => {
  const r = parseWorkoutText('Bench 140 15 190 10');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.sets.length, 2);
  assert.equal(r.sets[0].set_type, 'working');
  assert.equal(r.sets[1].set_type, 'working');
  assert.equal(isWarmupNote(r.sets[0].notes), false);
  assert.equal(isWarmupNote(r.sets[1].notes), false);
  const rows = rowsFromBackendParsedWorkout()(r);
  assert.equal(rows[0].notes, '');
  assert.equal(rows[1].notes, '');
});

test('#1564: boundary — slash-only working sets stay untagged', () => {
  const r = parseWorkoutText('Bench 230 5/2 5/2 5/2');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.sets.length, 3);
  assert.ok(r.sets.every(s => s.set_type === 'working' && !isWarmupNote(s.notes)));
  const rows = rowsFromBackendParsedWorkout()(r);
  assert.ok(rows.every(row => row.notes === ''));
});
