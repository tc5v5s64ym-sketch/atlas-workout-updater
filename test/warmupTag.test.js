const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isWarmupNote, tagWarmupNote, WARMUP_NOTE_TOKEN } = require('../services/warmupTag');
const { computeBenchmark, resolveWorkingWeight } = require('../services/exerciseBenchmark');
const { computeExpectedPerformance } = require('../services/expectedPerformance');
const { detectTrend } = require('../services/trendDetector');
const { progressionBand } = require('../services/analytics');

// 12-column Log_Cleaned row builder:
// date|session|exercise|canonical|muscle|lift_code|set_number|weight|reps|rir|notes|volume_calc
function row({ session = 'S1', date = '2026-06-01', weight, reps, rir = '', notes = '' }) {
  return [date, session, 'Deadlift', 'Deadlift', 'Back', 'DL', 1, weight, reps, rir, notes, ''];
}

// --- the shared marker helper ---

test('isWarmupNote: recognizes the warm-up vocabulary, ignores plain notes', () => {
  assert.equal(isWarmupNote('warm-up'), true);
  assert.equal(isWarmupNote('warm up'), true);
  assert.equal(isWarmupNote('warmup'), true);
  assert.equal(isWarmupNote('wu'), true);
  assert.equal(isWarmupNote('(W)'), true);
  assert.equal(isWarmupNote('felt strong'), false);
  assert.equal(isWarmupNote(''), false);
  assert.equal(isWarmupNote(null), false);
});

test('tagWarmupNote: adds the marker without dropping the lifter note or duplicating', () => {
  assert.equal(tagWarmupNote(''), WARMUP_NOTE_TOKEN);
  assert.equal(tagWarmupNote('felt easy'), `${WARMUP_NOTE_TOKEN}; felt easy`);
  // Already tagged → unchanged (no double marker).
  assert.equal(tagWarmupNote('warm-up'), 'warm-up');
  assert.equal(tagWarmupNote('wu; light'), 'wu; light');
});

// --- exerciseBenchmark: a note-tagged warm-up is excluded even when it's heavy ---

test('computeBenchmark: a note-tagged heavy warm-up is excluded from the working set', () => {
  // 250×3 is the heaviest set but it's a feeler/warm-up; 245×5 @2 is the real work.
  // The legacy weight/RIR heuristic would KEEP 250 (heavy, low RIR) — the tag closes that hole.
  const tagged = [
    row({ session: 'S1', weight: 250, reps: 3, rir: '', notes: 'warm-up' }),
    row({ session: 'S1', weight: 245, reps: 5, rir: 2 })
  ];
  assert.equal(computeBenchmark('DL', tagged).recentBest, 245, 'tagged 250 warm-up excluded → top working set is 245');

  // Control: identical rows, no tag → the heuristic keeps 250 and it becomes the top.
  const untagged = [
    row({ session: 'S1', weight: 250, reps: 3, rir: '', notes: '' }),
    row({ session: 'S1', weight: 245, reps: 5, rir: 2 })
  ];
  assert.equal(computeBenchmark('DL', untagged).recentBest, 250, 'without the tag the heavy feeler leaks in');
});

test('resolveWorkingWeight: a note-tagged heavy warm-up does not become the working weight', () => {
  const tagged = [
    row({ session: 'S1', weight: 250, reps: 3, rir: '', notes: 'warm-up' }),
    row({ session: 'S1', weight: 245, reps: 5, rir: 2 }),
    row({ session: 'S2', date: '2026-06-03', weight: 250, reps: 3, rir: '', notes: 'warm-up' }),
    row({ session: 'S2', date: '2026-06-03', weight: 245, reps: 5, rir: 2 })
  ];
  assert.equal(resolveWorkingWeight('DL', tagged).weight, 245);
});

// --- expectedPerformance: a note-tagged warm-up at the target weight is excluded ---

test('computeExpectedPerformance: a tagged warm-up at the target weight does not inflate expected reps', () => {
  const sessions = ['S1', 'S2', 'S3'];
  const dates = ['2026-06-01', '2026-06-03', '2026-06-05'];
  const tagged = [];
  const untagged = [];
  sessions.forEach((s, i) => {
    // A real working set (5 reps) and a high-rep warm-up (12 reps) at the same weight.
    tagged.push(row({ session: s, date: dates[i], weight: 245, reps: 5, rir: 2 }));
    tagged.push(row({ session: s, date: dates[i], weight: 245, reps: 12, rir: '', notes: 'warm-up' }));
    untagged.push(row({ session: s, date: dates[i], weight: 245, reps: 5, rir: 2 }));
    untagged.push(row({ session: s, date: dates[i], weight: 245, reps: 12, rir: '' }));
  });

  // With the tag, the 12-rep warm-up is dropped → the session representative is the 5-rep working set.
  assert.equal(computeExpectedPerformance('DL', tagged, 245).expectedReps, 5);
  // Control: untagged, the 12-rep set (most reps at this weight) becomes the representative.
  assert.equal(computeExpectedPerformance('DL', untagged, 245).expectedReps, 12);
});

// --- trendDetector: a note-tagged heavy warm-up must not distort the e1RM trend ---

test('detectTrend: a tagged heavy warm-up does not pollute the e1RM trajectory', () => {
  const dates = ['2026-06-01', '2026-06-03', '2026-06-05', '2026-06-07'];
  const sessions = ['S1', 'S2', 'S3', 'S4'];
  const tagged = [];
  const untagged = [];
  sessions.forEach((s, i) => {
    tagged.push(row({ session: s, date: dates[i], weight: 200, reps: 5, rir: 2 }));
    untagged.push(row({ session: s, date: dates[i], weight: 200, reps: 5, rir: 2 }));
  });
  // Session 1 also has a heavy feeler logged as a warm-up — a high e1RM outlier.
  tagged.push(row({ session: 'S1', date: dates[0], weight: 300, reps: 5, rir: '', notes: 'warm-up' }));
  untagged.push(row({ session: 'S1', date: dates[0], weight: 300, reps: 5, rir: '' }));

  // Tagged: the outlier is excluded → every session e1RM is equal → a clean 'flat' trend.
  assert.equal(detectTrend('DL', tagged).trend, 'flat');
  // Control: untagged, the 300-lb feeler spikes session 1's e1RM → the trend is no longer flat.
  assert.notEqual(detectTrend('DL', untagged).trend, 'flat');
});

// --- analytics.recommendNextSet (progressionBand): the primary live weight-bump path ---

test('progressionBand: a note-tagged heavy warm-up does not inflate the working-weight band', () => {
  // Normalized row objects (as recommendNextSet passes them).
  const tagged = [
    { session_id: 'S1', weight: 245, notes: '' },
    { session_id: 'S1', weight: 300, notes: 'warm-up' } // heavy feeler, tagged
  ];
  const band = progressionBand(tagged);
  assert.equal(band.range_high, 245, 'tagged 300 feeler excluded from range_high');
  assert.equal(band.ceiling, 245, 'tagged 300 feeler excluded from ceiling');

  // Control: untagged, the 300 leaks into the band (the hole this closes).
  const control = progressionBand([
    { session_id: 'S1', weight: 245, notes: '' },
    { session_id: 'S1', weight: 300, notes: '' }
  ]);
  assert.equal(control.ceiling, 300);
});
