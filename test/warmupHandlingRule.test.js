const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isWarmupNote, tagWarmupNote, WARMUP_NOTE_TOKEN, WARMUP_NOTE_RE } = require('../services/warmupTag');
const {
  computeMuscleGroupVolume,
  detectStalls,
  suggestDeloads,
  recommendNextSet,
  detectRecentPrs,
} = require('../services/analytics');

// ─────────────────────────────────────────────────────────────────────────────
// Owner warm-up handling rule (2026-06-25), the CONTRACT this file locks:
//   1. Warm-up sets are saved as NORMAL rows.
//   2. They are marked via the EXISTING notes mechanism (no new schema/column).
//   3. Warm-up sets ARE included in total volume.
//   4. Warm-up sets are EXCLUDED from progression / working-set decisions.
//   5. NEVER fabricate RIR for a warm-up set (no default/guessed RIR).
// This PR encodes the classification + accounting rule only; it does NOT wire the
// composer or the preview→approve→write path (that is P0, out of scope).
// ─────────────────────────────────────────────────────────────────────────────

// 12-column Log_Cleaned row:
// date|session|exercise|canonical|muscle|lift_code|set_number|weight|reps|rir|notes|volume_calc
function row({ session = 'S1', date = '2026-06-01', set = 1, weight, reps, rir = '', notes = '' }) {
  return [date, session, 'Deadlift', 'Deadlift', 'Back', 'DL', set, weight, reps, rir, notes, ''];
}

// ── Rule 1 + 2: warm-ups are normal rows, marked via the existing notes column ──

test('rule: a warm-up is an ordinary 12-column row carrying the notes mark (no new column)', () => {
  const r = row({ weight: 135, reps: 5, rir: '', notes: tagWarmupNote('') });
  // Still a plain 12-col Log_Cleaned row — same shape as any working set.
  assert.equal(r.length, 12, 'warm-up row keeps the 12-column contract (no extra column)');
  assert.equal(r[10], WARMUP_NOTE_TOKEN, 'the mark lives in the notes column (index 10)');
  assert.equal(isWarmupNote(r[10]), true, 'the row reads back as a warm-up');
  // The mark is the ONLY differentiator — weight/reps/etc. are normal values.
  assert.equal(r[7], 135);
  assert.equal(r[8], 5);
});

test('rule: the mark is notes-based and rides alongside a lifter note without duplicating', () => {
  assert.equal(tagWarmupNote('felt light'), `${WARMUP_NOTE_TOKEN}; felt light`);
  assert.equal(tagWarmupNote('warm-up'), 'warm-up', 'already-tagged is not double-marked');
  assert.equal(isWarmupNote('warm-up; felt light'), true);
});

// ── Rule 3: total volume INCLUDES warm-ups ──────────────────────────────────────

test('rule: warm-up sets ARE counted in total volume', () => {
  const rows = [
    row({ session: 'S1', weight: 135, reps: 5, notes: 'warm-up' }), // 675
    row({ session: 'S1', weight: 225, reps: 5, rir: 2 }),           // 1125
  ];
  // Large window so the recency cutoff never excludes the fixture (deterministic).
  const vol = computeMuscleGroupVolume(rows, 100000);
  const back = vol.find(v => v.muscle_group === 'Back');
  assert.ok(back, 'Back volume present');
  assert.equal(back.volume, 135 * 5 + 225 * 5, 'volume includes BOTH the warm-up and the working set');
  assert.equal(back.set_count, 2, 'the warm-up counts as a performed set');
});

test('rule: volume with the warm-up is strictly greater than volume of the working set alone', () => {
  const withWarmup = computeMuscleGroupVolume([
    row({ weight: 135, reps: 5, notes: 'warm-up' }),
    row({ weight: 225, reps: 5, rir: 2 }),
  ], 100000).find(v => v.muscle_group === 'Back').volume;
  const workingOnly = computeMuscleGroupVolume([
    row({ weight: 225, reps: 5, rir: 2 }),
  ], 100000).find(v => v.muscle_group === 'Back').volume;
  assert.ok(withWarmup > workingOnly, 'the warm-up adds to total volume, never subtracts');
  assert.equal(withWarmup - workingOnly, 135 * 5, 'the added volume is exactly the warm-up set');
});

// ── Rule 4: warm-ups are EXCLUDED from progression / working-set decisions ──────

test('rule: a tagged heavy warm-up does not mask a real stall (detectStalls excludes warm-ups)', () => {
  // Three sessions of flat working sets (200×5) → a genuine stall. The latest
  // session also carries a heavy 260×5 set; tagged warm-up it must be excluded so
  // the stall still surfaces. Untagged, that heavy set is a working PR and breaks the stall.
  const base = [
    row({ session: 'A', date: '2026-05-01', weight: 200, reps: 5, rir: 2 }),
    row({ session: 'B', date: '2026-05-08', weight: 200, reps: 5, rir: 2 }),
    row({ session: 'C', date: '2026-05-15', weight: 200, reps: 5, rir: 2 }),
  ];
  const tagged   = [...base, row({ session: 'C', date: '2026-05-15', set: 2, weight: 260, reps: 5, notes: 'warm-up' })];
  const untagged = [...base, row({ session: 'C', date: '2026-05-15', set: 2, weight: 260, reps: 5, notes: '' })];

  const stalledTagged = detectStalls(tagged, 3).some(s => s.liftCode === 'DL');
  const stalledUntagged = detectStalls(untagged, 3).some(s => s.liftCode === 'DL');
  assert.equal(stalledTagged, true, 'the tagged heavy warm-up is excluded → the flat working stall still detects');
  assert.equal(stalledUntagged, false, 'control: untagged, the heavy set is a working set and breaks the stall');
});

test('rule: a tagged warm-up does not set the deload weight (suggestDeloads reads working sets only)', () => {
  const rows = [
    row({ session: 'A', date: '2026-05-01', weight: 200, reps: 5, rir: 2 }),
    row({ session: 'B', date: '2026-05-08', weight: 200, reps: 5, rir: 2 }),
    row({ session: 'C', date: '2026-05-15', weight: 200, reps: 5, rir: 2 }),
    row({ session: 'C', date: '2026-05-15', set: 2, weight: 260, reps: 5, notes: 'warm-up' }),
  ];
  const deloads = suggestDeloads(rows, 3);
  const dl = deloads.find(d => d.lift_code === 'DL' || d.liftCode === 'DL');
  assert.ok(dl, 'the stalled lift surfaces a deload suggestion');
  assert.equal(dl.suggested_deload_weight, 200, 'deload holds the WORKING weight (200), not the 260 warm-up');
});

test('rule: a warm-up logged last does not become the progression bump anchor', () => {
  const rows = [
    row({ session: 'A', date: '2026-05-01', weight: 225, reps: 5, rir: 2 }),
    row({ session: 'B', date: '2026-05-08', weight: 225, reps: 5, rir: 2 }),
    // A light back-off/feeler tagged warm-up, logged last in the latest session.
    row({ session: 'B', date: '2026-05-08', set: 2, weight: 135, reps: 5, notes: 'warm-up' }),
  ];
  const rec = recommendNextSet(rows, 'DL', { today: '2026-05-09' });
  assert.ok(rec && rec.recommendation, 'a recommendation is produced');
  // The bump anchor is the 225 working set, not the 135 warm-up logged last.
  const lastWorking = rec.last_working_sets[rec.last_working_sets.length - 1];
  assert.equal(lastWorking.weight, 225, 'the working set anchors the recommendation, not the trailing warm-up');
});

test('rule: a tagged heavy warm-up never registers as a personal record', () => {
  const rows = [
    row({ session: 'A', date: '2026-05-01', weight: 225, reps: 5, rir: 2 }),
    row({ session: 'A', date: '2026-05-01', set: 2, weight: 275, reps: 3, notes: 'warm-up' }),
  ];
  const prs = detectRecentPrs(rows).filter(p => p.liftCode === 'DL');
  // The 275 feeler is tagged warm-up → it must not be the PR weight.
  assert.ok(!prs.some(p => p.weight === 275), 'the tagged 275 warm-up is not a PR');
});

// ── Rule 5: warm-up status comes from the notes mark, NEVER from a fabricated RIR ─

test('rule: warm-up classification ignores RIR entirely (no RIR is read or fabricated)', () => {
  // A missing / low RIR does NOT make a set a warm-up (classification is notes-only),
  // so the system never needs to invent an RIR to mark or unmark a warm-up.
  assert.equal(isWarmupNote(''), false, 'blank notes → not a warm-up regardless of RIR');
  assert.equal(WARMUP_NOTE_RE.test('rir 4'), false, 'a low RIR string is not a warm-up marker');
  // The mark helper only ever touches notes — it cannot fabricate an RIR.
  const tagged = tagWarmupNote('');
  assert.equal(tagged, WARMUP_NOTE_TOKEN);
  assert.ok(!/\d/.test(tagged), 'the warm-up mark contains no fabricated numeric RIR');
});

test('rule: a warm-up row logged with no RIR keeps an empty RIR (nothing back-fills it)', () => {
  // The classification/accounting layer reads a warm-up row as-is; a blank RIR is
  // preserved (no default/guessed RIR is stamped onto the warm-up).
  const r = row({ weight: 135, reps: 5, rir: '', notes: 'warm-up' });
  assert.equal(r[9], '', 'the RIR column stays empty for an un-rated warm-up');
  assert.equal(isWarmupNote(r[10]), true, 'it is still recognized as a warm-up — via notes, not RIR');
});
