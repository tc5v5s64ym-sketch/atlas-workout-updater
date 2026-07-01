'use strict';

// PR-3 frontend glue: groupLoggedBlocks over the REAL client write-payload shape.
//
// public/app.js is a browser script (DOM globals at load), not Node-requireable,
// so extract the pure, self-contained groupLoggedBlocks helper from source and
// exercise it directly. This is the integration seam the server-route tests
// (test/coach-message-block.test.js) do NOT cover — they POST a `todaySets`
// payload and never run groupLoggedBlocks. The bug this guards against: the client
// payload is an array of collectLogRows OBJECTS (not 12-column positional arrays),
// so a positional-array reader silently returns [] and the coach note never fires.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const start = appSrc.indexOf('function groupLoggedBlocks(');
const end = appSrc.indexOf('function renderBatchCoachNotes(');
assert.ok(start > -1 && end > start, 'groupLoggedBlocks must be defined before renderBatchCoachNotes');
// The helper is self-contained (Array.isArray / Map / its args only) — safe to
// evaluate in isolation without the rest of app.js.
const groupLoggedBlocks = new Function(appSrc.slice(start, end) + '\nreturn groupLoggedBlocks;')();

// The exact shape collectLogRows(...) produces (public/app.js): objects, no
// lift_code / muscle_group, string-valued weight/reps/rir.
function collectLogRowsPayload() {
  return [
    { date_clean: '2026-07-01', session_id: 's1', exercise: 'Bench Press', set_number: '1', weight: '225', reps: '5', rir: '2', notes: '' },
    { date_clean: '2026-07-01', session_id: 's1', exercise: 'Bench Press', set_number: '2', weight: '225', reps: '3', rir: '0', notes: '' },
    { date_clean: '2026-07-01', session_id: 's1', exercise: 'Lat Pulldown', set_number: '1', weight: '120', reps: '10', rir: '2', notes: '' },
  ];
}

test('groupLoggedBlocks groups collectLogRows objects by exercise name (the real client shape)', () => {
  const blocks = groupLoggedBlocks(collectLogRowsPayload());
  assert.equal(blocks.length, 2, 'two exercises → two blocks');
  assert.deepEqual(blocks.map(b => b.exerciseName), ['Bench Press', 'Lat Pulldown'], 'first-seen order preserved');
  assert.deepEqual(blocks[0].sets, [
    { weight: '225', reps: '5', rir: '2' },
    { weight: '225', reps: '3', rir: '0' },
  ], 'both Bench sets grouped, raw values preserved');
  assert.equal(blocks[1].sets.length, 1);
  // muscle_group is intentionally empty client-side (server derives it from the name).
  assert.equal(blocks[0].muscleGroup, '');
});

test('groupLoggedBlocks skips nameless rows and handles empty / non-array input', () => {
  assert.deepEqual(groupLoggedBlocks([]), []);
  assert.deepEqual(groupLoggedBlocks(null), []);
  assert.deepEqual(groupLoggedBlocks(undefined), []);
  assert.deepEqual(groupLoggedBlocks([{ weight: '100', reps: '5', rir: '2' }]), [], 'row with no exercise name → skipped');
});

test('regression: a 12-column positional-array row is NOT the client shape → yields no block', () => {
  // The client never sends positional arrays; if grouping ever reverts to r[5]-style
  // access it must not silently produce empty output on real object rows (that was
  // the original bug). Feeding an array here must return [] (no `.exercise` key).
  const positional = [['2026-07-01', 's1', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '225', '5', '2', '', '']];
  assert.deepEqual(groupLoggedBlocks(positional), []);
});
