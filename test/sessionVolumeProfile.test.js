'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionVolumeProfile } = require('../services/sessionVolumeProfile');

// Log_Cleaned array row: [date, session, exercise, canonical, muscle, code, set, weight, reps, rir, notes, vol]
function setRow(date, session, exercise, muscle, setNo) {
  return [date, session, exercise, exercise, muscle, '', String(setNo), '135', '5', '2', '', ''];
}
// Build a session of N exercises × 3 sets each. `exs` is [ [name, muscle], ... ].
function session(date, id, exs) {
  const rows = [];
  for (const [name, muscle] of exs) for (let s = 1; s <= 3; s++) rows.push(setRow(date, id, name, muscle, s));
  return rows;
}

describe('buildSessionVolumeProfile — learns the lifter\'s session composition', () => {
  it('returns a profile sized to the lifter\'s own norm (≈4-exercise strength days)', () => {
    // 8 sessions, each ~4 exercises: a heavy compound + 1 secondary + 2 accessories.
    const rows = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date('2026-04-01'); d.setDate(d.getDate() + i * 3);
      rows.push(...session(d.toISOString().slice(0, 10), `S${i}`, [
        ['Bench Press', 'Chest'],          // main
        ['Incline DB Press', 'Chest'],     // secondary
        ['Lateral Raise', 'Shoulders'],    // accessory
        ['Triceps Pushdown', 'Triceps'],   // accessory
      ]));
    }
    const profile = buildSessionVolumeProfile(rows, { today: '2026-05-01' });
    assert.ok(profile, 'enough history → a profile');
    assert.equal(profile.exercises_per_session, 4, 'learns ~4 exercises/session');
    assert.equal(profile.accessories_per_session, 2, '~2 accessories/session');
    assert.equal(profile.compounds_per_session, 2, '~2 compound lifts/session');
    assert.equal(profile.sessions_analyzed, 8);
  });

  it('returns null below the minimum session count (sparse data → generic caps)', () => {
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push(...session(`2026-04-0${i + 1}`, `S${i}`, [['Squat', 'Quads'], ['Leg Curl', 'Hamstrings']]));
    assert.equal(buildSessionVolumeProfile(rows, { today: '2026-05-01' }), null);
  });

  it('counts DISTINCT exercises per session, not sets', () => {
    // One session, 2 exercises, lots of sets — must read as 2, not 6.
    const rows = [];
    for (let i = 0; i < 6; i++) {
      rows.push(...session(`2026-04-0${(i % 9) + 1}`, `S${i}`, [['Deadlift', 'Posterior Chain'], ['Back Squat', 'Quads']]));
    }
    const profile = buildSessionVolumeProfile(rows, { today: '2026-05-01' });
    assert.equal(profile.exercises_per_session, 2);
  });

  it('honors the recency window (old sessions outside the window are ignored)', () => {
    const recent = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date('2026-04-15'); d.setDate(d.getDate() + i);
      recent.push(...session(d.toISOString().slice(0, 10), `R${i}`, [['Bench Press', 'Chest'], ['Row', 'Back']]));
    }
    // A pile of ancient 6-exercise sessions that must NOT skew the recent profile.
    const ancient = [];
    for (let i = 0; i < 10; i++) {
      ancient.push(...session(`2024-01-0${(i % 9) + 1}`, `A${i}`, [
        ['A', 'Chest'], ['B', 'Back'], ['C', 'Quads'], ['D', 'Shoulders'], ['E', 'Triceps'], ['F', 'Biceps'],
      ]));
    }
    const profile = buildSessionVolumeProfile([...ancient, ...recent], { today: '2026-05-01', windowDays: 120 });
    assert.equal(profile.sessions_analyzed, 7, 'only recent sessions counted');
    assert.equal(profile.exercises_per_session, 2);
  });

  it('session_cap is roomy (≥ the median) so it trims only over-stuffed plans', () => {
    const rows = [];
    // Mostly 4-exercise days, a couple of 6-exercise days → cap should allow ~5–6.
    for (let i = 0; i < 6; i++) rows.push(...session(`2026-04-1${i}`, `S${i}`, [['Bench Press', 'Chest'], ['Row', 'Back'], ['Curl', 'Biceps'], ['Pushdown', 'Triceps']]));
    rows.push(...session('2026-04-20', 'S6', [['Bench Press', 'Chest'], ['Row', 'Back'], ['Curl', 'Biceps'], ['Pushdown', 'Triceps'], ['Lateral Raise', 'Shoulders'], ['Face Pull', 'Rear Delts']]));
    const profile = buildSessionVolumeProfile(rows, { today: '2026-05-01' });
    assert.ok(profile.session_cap >= profile.exercises_per_session, 'cap not below the median');
  });

  it('is null-safe', () => {
    assert.equal(buildSessionVolumeProfile([], {}), null);
    assert.equal(buildSessionVolumeProfile(null, {}), null);
  });
});
