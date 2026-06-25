const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

const { normalizeDisplayBlocks } = require('../public/displayBlockNormalizer');
const { isWarmupNote } = require('../services/warmupTag');

// The warm-up note app.js writes MUST be recognized by the server-side reader that
// excludes tagged warm-ups from the bump decision — otherwise the composer would
// log a warm-up the progression engine then counts. Pin them in sync.
test('app.js WARMUP_LOG_NOTE is recognized by services/warmupTag.isWarmupNote', () => {
  const token = (appSrc.match(/const WARMUP_LOG_NOTE = '([^']+)'/) || [])[1];
  assert.ok(token, 'app.js must define WARMUP_LOG_NOTE');
  assert.equal(isWarmupNote(token), true, 'the token app.js writes must be detected server-side');
});

// rowsFromWorkoutInput must run the display-block pre-pass: detect via the
// normalizer, tag warm-ups, gate kg, and feed the existing preview path — before
// the backend/coach route that previously lost the sets.
test('rowsFromWorkoutInput wires the display-block pre-pass (detect + tag + kg gate)', () => {
  const fn = appSrc.slice(
    appSrc.indexOf('async function rowsFromWorkoutInput('),
    appSrc.indexOf('async function rowsFromWorkoutInput(') + 2400
  );
  assert.match(fn, /displayBlockNormalizer\.normalizeDisplayBlocks\(workoutText\)/, 'must detect a display block');
  assert.match(fn, /isDisplayBlock/, 'must gate on isDisplayBlock');
  assert.match(fn, /rowsFromDisplayBlocks\(/, 'must build rows from the blocks');
  assert.match(fn, /unit === 'kg'/, 'must gate kg input');
  assert.match(fn, /populateSetRows\(blockRows\)/, 'must feed the existing preview/trust loop');
});

// rowsFromDisplayBlocks (mirrored here against the normalizer output) must tag
// warm-ups, keep working RIR, and number sets per exercise.
test('display-block rows: warm-ups tagged, working RIR kept, exercise name passed through', () => {
  const text = [
    'Deadlift',
    '135lbs 10 · warm-up',
    '225lbs 8 · warm-up',
    '245lbs 6/2',
    '245lbs 6/2'
  ].join('\n');
  const { blocks } = normalizeDisplayBlocks(text);
  assert.equal(blocks.length, 1);
  const b = blocks[0];
  // Mirror of rowsFromDisplayBlocks (kept in app.js, which the source test above pins).
  const rows = b.sets.map((s, i) => ({
    exercise: b.name,
    set_number: String(i + 1),
    weight: String(s.weight),
    reps: String(s.reps),
    rir: s.rir == null ? '' : String(s.rir),
    notes: s.warmup ? 'warm-up' : ''
  }));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(r => r.notes), ['warm-up', 'warm-up', '', '']);
  assert.deepEqual(rows.map(r => r.rir), ['', '', '2', '2']);
  assert.ok(rows.every(r => r.exercise === 'Deadlift'));
  // Every tagged warm-up note must be server-recognized.
  for (const r of rows) {
    if (r.notes) assert.equal(isWarmupNote(r.notes), true);
  }
});
