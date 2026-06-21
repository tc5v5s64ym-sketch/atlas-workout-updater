'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectWarmupRampShape } = require('../services/warmupDetector');

// Log_Cleaned array-form row helper: [date, session, exercise, canonical, muscle, code, set, weight, reps, rir, notes, vol]
function row(date, session, code, setNo, weight, reps, rir, exercise = 'Bench Press') {
  return [date, session, exercise, exercise, 'Chest', code, String(setNo), String(weight), String(reps), rir == null ? '' : String(rir), '', ''];
}

// The owner's actual ramp style: a light high-rep warm-up, a heavier transition
// set, then working sets at the top weight. (Thu Jun 18: Bench 135×15@6, 185×10@2,
// then 225 working.)
function ownerBenchSession(date, session, topWeight) {
  return [
    row(date, session, 'BEN01', 1, 135, 15, 6),                 // light warm-up
    row(date, session, 'BEN01', 2, Math.round(topWeight * 0.82), 10, 2), // transition ramp set
    row(date, session, 'BEN01', 3, topWeight, 8, 1),            // top working set
    row(date, session, 'BEN01', 4, topWeight, 5, 2),
    row(date, session, 'BEN01', 5, topWeight, 5, 2),
  ];
}

describe('detectWarmupRampShape — learns a lifter\'s own ramp', () => {
  it('detects the owner\'s 2-step Bench ramp across several sessions', () => {
    const rows = [
      ...ownerBenchSession('2026-05-01', 'S1', 225),
      ...ownerBenchSession('2026-05-08', 'S2', 225),
      ...ownerBenchSession('2026-05-15', 'S3', 225),
    ];
    const shape = detectWarmupRampShape(rows, { liftCode: 'BEN01' });
    assert.ok(shape, 'a pattern should be detected');
    assert.equal(shape.steps.length, 2, 'two warm-up steps (135 + 185), not the working sets');
    // Ascending fractions of the 225 top set: ~0.60 then ~0.82.
    assert.ok(shape.steps[0].load_fraction < shape.steps[1].load_fraction, 'steps ascend');
    assert.ok(shape.steps[0].load_fraction >= 0.55 && shape.steps[0].load_fraction <= 0.65, `first ~0.60, got ${shape.steps[0].load_fraction}`);
    assert.ok(shape.steps[1].load_fraction >= 0.78 && shape.steps[1].load_fraction <= 0.86, `second ~0.82, got ${shape.steps[1].load_fraction}`);
    assert.equal(shape.steps[0].reps, 15);
    assert.equal(shape.steps[1].reps, 10);
    assert.equal(shape.ramped_sessions, 3);
  });

  it('confidence scales with corroborating sessions (medium at 2–3, high at 4+)', () => {
    const two = [...ownerBenchSession('2026-05-01', 'S1', 225), ...ownerBenchSession('2026-05-08', 'S2', 225)];
    assert.equal(detectWarmupRampShape(two, { liftCode: 'BEN01' }).confidence, 'medium');
    const four = ['2026-05-01', '2026-05-08', '2026-05-15', '2026-05-22']
      .flatMap((d, i) => ownerBenchSession(d, `S${i}`, 225));
    assert.equal(detectWarmupRampShape(four, { liftCode: 'BEN01' }).confidence, 'high');
  });

  it('returns null with too few ramped sessions (no fabrication from one session)', () => {
    const one = ownerBenchSession('2026-05-01', 'S1', 225);
    assert.equal(detectWarmupRampShape(one, { liftCode: 'BEN01' }), null);
  });

  it('returns null for a flat accessory (no warm-ups, all working sets)', () => {
    // Seated Row 190×10 @2 ×3 across sessions — no ramp.
    const rows = ['2026-05-01', '2026-05-08', '2026-05-15'].flatMap((d, i) => [
      row(d, `S${i}`, 'SR01', 1, 190, 10, 2, 'Seated Row'),
      row(d, `S${i}`, 'SR01', 2, 190, 10, 2, 'Seated Row'),
      row(d, `S${i}`, 'SR01', 3, 190, 10, 2, 'Seated Row'),
    ]);
    assert.equal(detectWarmupRampShape(rows, { liftCode: 'SR01' }), null);
  });

  it('does not mistake back-off sets (logged after the top set) for a ramp', () => {
    // Top set first, then lighter back-offs — descending, not a ramp-up.
    const rows = ['2026-05-01', '2026-05-08'].flatMap((d, i) => [
      row(d, `S${i}`, 'SQ01', 1, 315, 5, 1, 'Squat'),
      row(d, `S${i}`, 'SQ01', 2, 275, 8, 3, 'Squat'),
      row(d, `S${i}`, 'SQ01', 3, 245, 10, 4, 'Squat'),
    ]);
    assert.equal(detectWarmupRampShape(rows, { liftCode: 'SQ01' }), null, 'top-set-first then back-offs is not a ramp');
  });

  it('excludes a lighter lead set that was near failure (real work, not priming)', () => {
    // A lighter first set taken to failure (@0) before a heavier top is hard work.
    const rows = ['2026-05-01', '2026-05-08'].flatMap((d, i) => [
      row(d, `S${i}`, 'DL01', 1, 225, 8, 0, 'Deadlift'),  // lighter but @0 → not a warm-up
      row(d, `S${i}`, 'DL01', 2, 275, 3, 2, 'Deadlift'),  // top
    ]);
    assert.equal(detectWarmupRampShape(rows, { liftCode: 'DL01' }), null);
  });

  it('works without RIR data (load-only ascending lead-in)', () => {
    const rows = ['2026-05-01', '2026-05-08'].flatMap((d, i) => [
      row(d, `S${i}`, 'OHP01', 1, 65, 8, null, 'Overhead Press'),
      row(d, `S${i}`, 'OHP01', 2, 95, 8, null, 'Overhead Press'),
      row(d, `S${i}`, 'OHP01', 3, 115, 6, null, 'Overhead Press'),
    ]);
    const shape = detectWarmupRampShape(rows, { liftCode: 'OHP01' });
    assert.ok(shape && shape.steps.length === 2, 'two lighter ascending lead-ins detected without RIR');
  });

  it('resolves the lift by exercise name when no code is given', () => {
    const rows = [...ownerBenchSession('2026-05-01', 'S1', 225), ...ownerBenchSession('2026-05-08', 'S2', 225)];
    assert.ok(detectWarmupRampShape(rows, { exerciseName: 'Bench Press' }));
  });

  it('is null-safe and needs a lift target', () => {
    assert.equal(detectWarmupRampShape([], { liftCode: 'BEN01' }), null);
    assert.equal(detectWarmupRampShape(null, { liftCode: 'BEN01' }), null);
    assert.equal(detectWarmupRampShape([row('2026-05-01', 'S1', 'BEN01', 1, 135, 5, 2)], {}), null, 'no liftCode/name → null');
  });
});
