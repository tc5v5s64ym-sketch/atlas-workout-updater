'use strict';

// #1344 — Evidence quarantine + armed-item scheduler (Corpus V2 §F.12) golden fixtures.
//
// Pins, per §F.12 rule: each arming fires on its evidence; the guards
// (sleep threshold, negation, past-session reports, RIR band, grip
// requirement, established baseline, one-away counter); the quarantine
// (a readiness-limited turn banks no better-than-expected read); routine
// turns yield [] (the route emits the empty array, the detector returns it).
// Deterministic order: top_single_test, limiter_test, progression_bump.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildArmedItems, detectReadinessLimited } = require('../services/armedItems');

const TODAY = '2026-11-26';

// Raw Log_Cleaned rows (12 cols): [date, session_id, exercise, canonical,
// muscle, lift_code, set#, weight, reps, rir, notes, '']
const SQUAT_315 = [
  ['2026-11-19', 'sess-squat', 'Squat', 'Squat', 'Legs', 'SQUAT', '', 315, 3, 3, '', ''],
  ['2026-11-19', 'sess-squat', 'Squat', 'Squat', 'Legs', 'SQUAT', '', 315, 3, 3, '', ''],
];
const BENCH_185_TWICE = [
  ['2026-11-24', 'sess-bench2', 'Bench Press', 'Bench Press', 'Chest', 'BENCH', '', 185, 6, 2, '', ''],
  ['2026-11-24', 'sess-bench2', 'Bench Press', 'Bench Press', 'Chest', 'BENCH', '', 185, 6, 2, '', ''],
  ['2026-11-24', 'sess-bench2', 'Bench Press', 'Bench Press', 'Chest', 'BENCH', '', 185, 6, 2, '', ''],
  ['2026-11-17', 'sess-bench1', 'Bench Press', 'Bench Press', 'Chest', 'BENCH', '', 185, 6, 2, '', ''],
  ['2026-11-17', 'sess-bench1', 'Bench Press', 'Bench Press', 'Chest', 'BENCH', '', 185, 6, 2, '', ''],
  ['2026-11-17', 'sess-bench1', 'Bench Press', 'Bench Press', 'Chest', 'BENCH', '', 185, 6, 2, '', ''],
];
const BENCH_185_ONCE = BENCH_185_TWICE.slice(0, 3);
const BENCH_185_THRICE = [
  ...BENCH_185_TWICE,
  ['2026-11-10', 'sess-bench0', 'Bench Press', 'Bench Press', 'Chest', 'BENCH', '', 185, 6, 2, '', ''],
  ['2026-11-10', 'sess-bench0', 'Bench Press', 'Bench Press', 'Chest', 'BENCH', '', 185, 6, 2, '', ''],
  ['2026-11-10', 'sess-bench0', 'Bench Press', 'Bench Press', 'Chest', 'BENCH', '', 185, 6, 2, '', ''],
];
const ROWS_140 = [
  ['2026-11-19', 'sess-rows', 'Seated Rows', 'Seated Rows', 'Back', 'SEATED_ROWS', '', 140, 10, 2, '', ''],
  ['2026-11-19', 'sess-rows', 'Seated Rows', 'Seated Rows', 'Back', 'SEATED_ROWS', '', 140, 10, 2, '', ''],
  ['2026-11-19', 'sess-rows', 'Seated Rows', 'Seated Rows', 'Back', 'SEATED_ROWS', '', 140, 10, 2, '', ''],
];
const SQUAT_225_TWICE = [
  ['2026-11-24', 'sess-sq2', 'Squat', 'Squat', 'Legs', 'SQUAT', '', 225, 6, 2, '', ''],
  ['2026-11-24', 'sess-sq2', 'Squat', 'Squat', 'Legs', 'SQUAT', '', 225, 6, 2, '', ''],
  ['2026-11-24', 'sess-sq2', 'Squat', 'Squat', 'Legs', 'SQUAT', '', 225, 6, 2, '', ''],
  ['2026-11-17', 'sess-sq1', 'Squat', 'Squat', 'Legs', 'SQUAT', '', 225, 6, 2, '', ''],
  ['2026-11-17', 'sess-sq1', 'Squat', 'Squat', 'Legs', 'SQUAT', '', 225, 6, 2, '', ''],
  ['2026-11-17', 'sess-sq1', 'Squat', 'Squat', 'Legs', 'SQUAT', '', 225, 6, 2, '', ''],
];

function tally(exercise, perSet) {
  return { exercises: [{ exercise, sets: perSet.length, per_set: perSet, planned: true }], total_working_sets: perSet.length };
}

function kinds(items) {
  return items.map((f) => f.kind);
}

function build(message, logRows, sessionTally) {
  return buildArmedItems({ message, logRows, sessionTally, today: TODAY });
}

// ── Readiness-limited detection (S5) ────────────────────────────────────────

test('readiness: four hours also flags the session', () => {
  assert.deepEqual(detectReadinessLimited('only slept four hours'),
    { limited: true, hours: 4, source: 'reported_sleep' });
  assert.deepEqual(detectReadinessLimited('I got about 4 hours of sleep'),
    { limited: true, hours: 4, source: 'reported_sleep' });
});

test('readiness: five hours of sleep flags the session (word + digit)', () => {
  assert.deepEqual(detectReadinessLimited('I only got about five hours of sleep, what are we doing today?'),
    { limited: true, hours: 5, source: 'reported_sleep' });
  assert.deepEqual(detectReadinessLimited('only got 5 hours of sleep last night'),
    { limited: true, hours: 5, source: 'reported_sleep' });
  assert.deepEqual(detectReadinessLimited('slept 5 hours'),
    { limited: true, hours: 5, source: 'reported_sleep' });
});

test('readiness: no sleep at all flags the session at zero hours', () => {
  assert.deepEqual(detectReadinessLimited('I got no sleep last night'),
    { limited: true, hours: 0, source: 'reported_sleep' });
});

test('readiness: a full night does not flag the session', () => {
  assert.deepEqual(detectReadinessLimited('I got eight hours of sleep, feeling good'),
    { limited: false, hours: 8, source: 'reported_sleep' });
  assert.deepEqual(detectReadinessLimited('slept 7 hours'),
    { limited: false, hours: 7, source: 'reported_sleep' });
});

test('readiness: a negated sleep report never fires', () => {
  assert.deepEqual(detectReadinessLimited("I didn't get five hours of sleep"), { limited: false, hours: null, source: null });
});

test('readiness: a past-session sleep report is history, not this check-in', () => {
  assert.deepEqual(detectReadinessLimited('last week I only got 5 hours of sleep before that session'),
    { limited: false, hours: null, source: null });
});

// B1 (PR #1816 rework): the marker may trail the report — a trailing
// 'last week' / 'last session' / 'last time' is the same rule, on both
// sleep patterns and the no-sleep branch. All six are Sunny's executed
// probes (verdict comment 7207975110).
test('readiness: a trailing past-session marker is history, not this check-in', () => {
  assert.deepEqual(detectReadinessLimited('I slept 5 hours last week before that session'),
    { limited: false, hours: null, source: null });
  assert.deepEqual(detectReadinessLimited('only got 5 hours of sleep last week'),
    { limited: false, hours: null, source: null });
  assert.deepEqual(detectReadinessLimited('I got 5 hours sleep last time'),
    { limited: false, hours: null, source: null });
  assert.deepEqual(detectReadinessLimited('5 hours of sleep, same as last week'),
    { limited: false, hours: null, source: null });
  assert.deepEqual(detectReadinessLimited('I got no sleep last week'),
    { limited: false, hours: null, source: null });
  assert.deepEqual(detectReadinessLimited('no sleep last session, but last night I slept fine'),
    { limited: false, hours: null, source: null });
  assert.deepEqual(detectReadinessLimited('last week I got no sleep'),
    { limited: false, hours: null, source: null });
});

test('readiness: yesterday’s sleep IS today’s readiness input', () => {
  assert.deepEqual(detectReadinessLimited('yesterday I got 5 hours sleep'),
    { limited: true, hours: 5, source: 'reported_sleep' });
});

test('readiness: no sleep report means no flag', () => {
  assert.deepEqual(detectReadinessLimited("what's on the plan today?"), { limited: false, hours: null, source: null });
  assert.deepEqual(detectReadinessLimited(''), { limited: false, hours: null, source: null });
});

// ── Top-single arming (S6) ──────────────────────────────────────────────────

test('top-single: RIR one higher at the same weight+reps arms the test for next week', () => {
  const out = build('Squat 315 3/4', SQUAT_315, tally('Squat', [{ weight: 315, reps: 3, rir: 4 }]));
  assert.deepEqual(out.armed_items.filter((f) => f.kind === 'top_single_test'), [
    {
      kind: 'top_single_test', lift: 'Squat', weight: 315, reps: 3,
      prior_rir: 3, rir: 4, prior_session_date: '2026-11-19',
      due: 'next_week', source: 'better_than_expected',
    },
  ]);
  assert.equal(out.readiness_applied, false);
});

test('top-single: matched effort arms nothing', () => {
  const out = build('Squat 315 3/3', SQUAT_315, tally('Squat', [{ weight: 315, reps: 3, rir: 3 }]));
  assert.deepEqual(kinds(out.armed_items), []);
});

test('top-single: a worse-than-expected read arms nothing', () => {
  const out = build('Squat 315 3/2', SQUAT_315, tally('Squat', [{ weight: 315, reps: 3, rir: 2 }]));
  assert.deepEqual(kinds(out.armed_items), []);
});

test('top-single: a different weight is not the same test', () => {
  const out = build('Squat 320 3/4', SQUAT_315, tally('Squat', [{ weight: 320, reps: 3, rir: 4 }]));
  assert.deepEqual(kinds(out.armed_items), []);
});

test('top-single: no history arms nothing', () => {
  const out = build('Squat 315 3/4', [], tally('Squat', [{ weight: 315, reps: 3, rir: 4 }]));
  assert.deepEqual(out.armed_items, []);
});

test('top-single: RIR two higher also arms (better is better, not exactly +1)', () => {
  const out = build('Squat 315 3/5', SQUAT_315, tally('Squat', [{ weight: 315, reps: 3, rir: 5 }]));
  assert.equal(kinds(out.armed_items).includes('top_single_test'), true);
});

test('top-single: same weight, different reps is not the same test', () => {
  const out = build('Squat 315 4/4', SQUAT_315, tally('Squat', [{ weight: 315, reps: 4, rir: 4 }]));
  assert.deepEqual(kinds(out.armed_items), []);
});

test('top-single: a re-entry today does not compare to a working prior week', () => {
  const old = [
    ['2026-10-20', 'sess-old', 'Squat', 'Squat', 'Legs', 'SQUAT', '', 315, 3, 3, '', ''],
  ];
  const out = build('Squat 315 3/4', old, tally('Squat', [{ weight: 315, reps: 3, rir: 4 }]));
  assert.deepEqual(out.armed_items, []);
});

test('top-single: a deload prior session does not compare to a working today', () => {
  const deload = SQUAT_315.map((r) => {
    const c = [...r];
    c[10] = 'deload week';
    return c;
  });
  const out = build('Squat 315 3/4', deload, tally('Squat', [{ weight: 315, reps: 3, rir: 4 }]));
  assert.deepEqual(out.armed_items, []);
});

// ── Limiter-test arming (S8) ────────────────────────────────────────────────

test('limiter: rep drop at stable RIR + grip cited arms the straps test', () => {
  const sets = [
    { weight: 140, reps: 10, rir: 2 },
    { weight: 140, reps: 8, rir: 2 },
    { weight: 140, reps: 8, rir: 2 },
  ];
  const out = build('Rows 140 10/2 8/2 8/2 — grip was gone, honestly', ROWS_140, tally('Seated Rows', sets));
  assert.deepEqual(out.armed_items.filter((f) => f.kind === 'limiter_test'), [
    {
      kind: 'limiter_test', lift: 'Seated Rows', test: 'straps', weight: 140,
      reps_from: 10, reps_to: 8, prior_reps: 10, rir: 2,
      due: 'next_session', source: 'limiter_pattern',
    },
  ]);
});

test('limiter: no grip mention arms nothing', () => {
  const sets = [
    { weight: 140, reps: 10, rir: 2 },
    { weight: 140, reps: 8, rir: 2 },
    { weight: 140, reps: 8, rir: 2 },
  ];
  const out = build('Rows 140 10/2 8/2 8/2', ROWS_140, tally('Seated Rows', sets));
  assert.deepEqual(out.armed_items, []);
});

test('limiter: reserve that moved is fatigue, not a limiter', () => {
  const sets = [
    { weight: 140, reps: 10, rir: 2 },
    { weight: 140, reps: 8, rir: 1 },
    { weight: 140, reps: 8, rir: 1 },
  ];
  const out = build('Rows 140 10/2 8/1 8/1 — grip was gone', ROWS_140, tally('Seated Rows', sets));
  assert.deepEqual(out.armed_items, []);
});

test('limiter: no rep drop arms nothing', () => {
  const sets = [
    { weight: 140, reps: 10, rir: 2 },
    { weight: 140, reps: 10, rir: 2 },
    { weight: 140, reps: 10, rir: 2 },
  ];
  const out = build('Rows 140 10/2 x3 — grip was gone', ROWS_140, tally('Seated Rows', sets));
  assert.deepEqual(out.armed_items, []);
});

test('limiter: warm-up sets do not mask the working-load drop', () => {
  const sets = [
    { weight: 95, reps: 8, rir: 5 },
    { weight: 140, reps: 10, rir: 2 },
    { weight: 140, reps: 8, rir: 2 },
    { weight: 140, reps: 8, rir: 2 },
  ];
  const out = build('Rows 140 10/2 8/2 8/2 — grip was gone', ROWS_140, tally('Seated Rows', sets));
  assert.equal(kinds(out.armed_items).includes('limiter_test'), true);
});

test('limiter: grip exonerated arms nothing', () => {
  const sets = [
    { weight: 140, reps: 10, rir: 2 },
    { weight: 140, reps: 8, rir: 2 },
    { weight: 140, reps: 8, rir: 2 },
  ];
  const out = build('Rows 140 10/2 8/2 8/2 — grip feels fine today, just tired', ROWS_140, tally('Seated Rows', sets));
  assert.deepEqual(out.armed_items, []);
  const out2 = build('Rows 140 10/2 8/2 8/2 — grip was not the issue', ROWS_140, tally('Seated Rows', sets));
  assert.deepEqual(out2.armed_items, []);
});

test('limiter: a heavier today than the baseline is a different load', () => {
  const sets = [
    { weight: 150, reps: 10, rir: 2 },
    { weight: 150, reps: 8, rir: 2 },
    { weight: 150, reps: 8, rir: 2 },
  ];
  const out = build('Rows 150 10/2 8/2 8/2 — grip was gone', ROWS_140, tally('Seated Rows', sets));
  assert.deepEqual(out.armed_items, []);
});

test('limiter: no prior baseline arms nothing', () => {
  const sets = [
    { weight: 140, reps: 10, rir: 2 },
    { weight: 140, reps: 8, rir: 2 },
    { weight: 140, reps: 8, rir: 2 },
  ];
  const out = build('Rows 140 10/2 8/2 8/2 — grip was gone', [], tally('Seated Rows', sets));
  assert.deepEqual(out.armed_items, []);
});

// ── Progression-bump arming (S9/S14) ────────────────────────────────────────

test('bump: two of three clean sessions arms the next load (upper +5)', () => {
  const out = build("what's on the plan today?", BENCH_185_TWICE, null);
  assert.deepEqual(out.armed_items, [
    {
      kind: 'progression_bump', lift: 'Bench Press', lift_code: 'BENCH',
      load: 185, next_load: 190, clean_sessions: 2, required_sessions: 3,
      due: 'next_clean_session', source: 'hold_until_clean',
    },
  ]);
});

test('bump: one of three clean sessions arms nothing', () => {
  const out = build("what's on the plan today?", BENCH_185_ONCE, null);
  assert.deepEqual(out.armed_items, []);
});

test('bump: three of three is earned, not armed', () => {
  const out = build("what's on the plan today?", BENCH_185_THRICE, null);
  assert.deepEqual(out.armed_items, []);
});

test('bump: lower-body increment is +10', () => {
  const out = build("what's on the plan today?", SQUAT_225_TWICE, null);
  assert.deepEqual(out.armed_items, [
    {
      kind: 'progression_bump', lift: 'Squat', lift_code: 'SQUAT',
      load: 225, next_load: 235, clean_sessions: 2, required_sessions: 3,
      due: 'next_clean_session', source: 'hold_until_clean',
    },
  ]);
});

test('bump: sub-target reps are not clean sessions', () => {
  const fiveRep = BENCH_185_TWICE.map((r) => {
    const c = [...r];
    c[8] = 5;
    return c;
  });
  const out = build("what's on the plan today?", fiveRep, null);
  assert.deepEqual(out.armed_items, []);
});

test('bump: a mixed-rep session is not clean', () => {
  const mixed = BENCH_185_TWICE.map((r, i) => {
    const c = [...r];
    if (i === 1) c[8] = 5;
    return c;
  });
  const out = build("what's on the plan today?", mixed, null);
  assert.deepEqual(out.armed_items, []);
});

test('bump: an RIR-1 set is not clean', () => {
  const hard = BENCH_185_TWICE.map((r, i) => {
    const c = [...r];
    if (i === 2) c[9] = 1;
    return c;
  });
  const out = build("what's on the plan today?", hard, null);
  assert.deepEqual(out.armed_items, []);
});

// ── Quarantine (S5) + routine guard ─────────────────────────────────────────

test('quarantine: a better-than-expected read on a low-sleep day is not banked', () => {
  const rows = [...SQUAT_315, ...BENCH_185_TWICE];
  const out = build('I only got about five hours of sleep. Squat 315 3/4', rows,
    tally('Squat', [{ weight: 315, reps: 3, rir: 4 }]));
  assert.equal(out.readiness_applied, true);
  assert.deepEqual(out.readiness, { limited: true, hours: 5, source: 'reported_sleep' });
  assert.equal(kinds(out.armed_items).includes('top_single_test'), false);
  // History-derived arms are unaffected: the bench bump still arms.
  assert.equal(kinds(out.armed_items).includes('progression_bump'), true);
});

test('routine: no arming event, no readiness report yields an empty array', () => {
  const out = build("what's on the plan today?", [], null);
  assert.deepEqual(out.armed_items, []);
  assert.equal(out.readiness_applied, false);
  assert.deepEqual(out.readiness, { limited: false, hours: null, source: null });
});

test('routine: empty inputs degrade safely', () => {
  const out = buildArmedItems({});
  assert.deepEqual(out.armed_items, []);
  assert.equal(out.readiness_applied, false);
});
