'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSubstitutionHistory } = require('../services/substitutionHistory');
const { detectPatterns } = require('../services/coachMemory');

// 12-column Log_Cleaned row helper
// date_clean | session_id | exercise | canonical_exercise | muscle_group | lift_code | ...
function row(date, session, exercise, muscle, liftCode) {
  return [date, session, exercise, exercise, muscle, liftCode, '1', '100', '8', '2', '', ''];
}

// ── buildSubstitutionHistory ───────────────────────────────────────────────────

test('buildSubstitutionHistory: empty rows → empty array', () => {
  assert.deepEqual(buildSubstitutionHistory([]), []);
  assert.deepEqual(buildSubstitutionHistory(null), []);
});

test('buildSubstitutionHistory: header row skipped', () => {
  const rows = [['date_clean', 'session_id', 'exercise', 'canonical_exercise', 'muscle_group', 'lift_code']];
  assert.deepEqual(buildSubstitutionHistory(rows), []);
});

test('buildSubstitutionHistory: fewer than MIN_SESSIONS_FOR_USUAL → no events', () => {
  // Only 2 sessions of Bench Press — below the threshold of 3 for "usual"
  const rows = [
    row('2026-04-01', 'S1', 'Bench Press', 'chest', 'BPR01'),
    row('2026-04-08', 'S2', 'Bench Press', 'chest', 'BPR01'),
    row('2026-04-15', 'S3', 'Incline Press', 'chest', 'IPR01'),
  ];
  // Bench appears in 2 sessions (below 3 threshold), Incline in 1 → no usual lift
  const result = buildSubstitutionHistory(rows);
  assert.deepEqual(result, []);
});

test('buildSubstitutionHistory: GOLDEN FIXTURE — detects substitution when usual lift absent and later returns', () => {
  // 4 sessions of Bench Press, one Incline substitution, then Bench returns.
  // The return to Bench (S6) confirms S5 was a deviation, not a program change.
  const rows = [
    row('2026-03-01', 'S1', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-08', 'S2', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-15', 'S3', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-22', 'S4', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-29', 'S5', 'Incline Press', 'chest', 'IPR01'), // substitution
    row('2026-04-05', 'S6', 'Bench Press',   'chest', 'BPR01'), // return to usual → confirms S5
  ];
  const result = buildSubstitutionHistory(rows);
  assert.equal(result.length, 1, 'one substitution event expected');
  assert.equal(result[0].original.toLowerCase(), 'bench press');
  assert.equal(result[0].substitute.toLowerCase(), 'incline press');
  assert.equal(result[0].date, '2026-03-29');
  assert.equal(result[0].liftCode, 'BPR01', 'event must carry the usual lift\'s liftCode for per-lift filtering');
});

test('buildSubstitutionHistory: no event when usual lift IS present', () => {
  // Usual lift present every session → no substitution
  const rows = [
    row('2026-04-01', 'S1', 'Bench Press', 'chest', 'BPR01'),
    row('2026-04-08', 'S2', 'Bench Press', 'chest', 'BPR01'),
    row('2026-04-15', 'S3', 'Bench Press', 'chest', 'BPR01'),
    row('2026-04-22', 'S4', 'Bench Press', 'chest', 'BPR01'),
    row('2026-04-29', 'S5', 'Bench Press', 'chest', 'BPR01'),
  ];
  assert.deepEqual(buildSubstitutionHistory(rows), []);
});

test('buildSubstitutionHistory: program change — no event when usual lift never returns', () => {
  // 3 sessions of Bench establishes it as usual, then 3 sessions of Incline only.
  // Because Bench never returns, this is a program change — NOT a substitution.
  const rows = [
    row('2026-03-01', 'S1', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-08', 'S2', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-15', 'S3', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-22', 'S4', 'Incline Press', 'chest', 'IPR01'),
    row('2026-03-29', 'S5', 'Incline Press', 'chest', 'IPR01'),
    row('2026-04-05', 'S6', 'Incline Press', 'chest', 'IPR01'),
  ];
  assert.deepEqual(buildSubstitutionHistory(rows), [], 'program change must not emit substitution events');
});

test('buildSubstitutionHistory: multiple substitutions across sessions → multiple events', () => {
  // 4 baseline sessions then 3 confirmed substitutions (Bench returns between each).
  const rows = [
    row('2026-03-01', 'S1',  'Bench Press', 'chest', 'BPR01'),
    row('2026-03-08', 'S2',  'Bench Press', 'chest', 'BPR01'),
    row('2026-03-15', 'S3',  'Bench Press', 'chest', 'BPR01'),
    row('2026-03-22', 'S4',  'Bench Press', 'chest', 'BPR01'),
    row('2026-03-29', 'S5',  'Incline Press', 'chest', 'IPR01'), // sub 1
    row('2026-04-05', 'S6',  'Bench Press',   'chest', 'BPR01'), // return → confirms S5
    row('2026-04-12', 'S7',  'Incline Press', 'chest', 'IPR01'), // sub 2
    row('2026-04-19', 'S8',  'Bench Press',   'chest', 'BPR01'), // return → confirms S7
    row('2026-04-26', 'S9',  'Incline Press', 'chest', 'IPR01'), // sub 3
    row('2026-05-03', 'S10', 'Bench Press',   'chest', 'BPR01'), // return → confirms S9
  ];
  const result = buildSubstitutionHistory(rows);
  assert.equal(result.length, 3, 'three substitution events expected');
  assert.ok(result.every(e => e.original.toLowerCase() === 'bench press'));
  assert.ok(result.every(e => e.substitute.toLowerCase() === 'incline press'));
});

test('buildSubstitutionHistory: returns events sorted chronologically', () => {
  const rows = [
    row('2026-03-01', 'S1', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-08', 'S2', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-15', 'S3', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-22', 'S4', 'Incline Press', 'chest', 'IPR01'), // sub 1
    row('2026-03-29', 'S5', 'Bench Press',   'chest', 'BPR01'), // return → confirms S4
    row('2026-04-05', 'S6', 'Incline Press', 'chest', 'IPR01'), // sub 2
    row('2026-04-12', 'S7', 'Bench Press',   'chest', 'BPR01'), // return → confirms S6
  ];
  const result = buildSubstitutionHistory(rows);
  assert.equal(result.length, 2);
  assert.ok(result[0].date <= result[1].date, 'events should be chronological');
});

test('buildSubstitutionHistory: emits only one event per session × muscle group', () => {
  // Two different substitutes present in S5 — should only emit one event.
  // Bench returns in S6 confirming S5 was a substitution session.
  const rows = [
    row('2026-03-01', 'S1', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-08', 'S2', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-15', 'S3', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-22', 'S4', 'Bench Press', 'chest', 'BPR01'),
    row('2026-03-29', 'S5', 'Incline Press', 'chest', 'IPR01'),
    row('2026-03-29', 'S5', 'Cable Fly',     'chest', 'CFY01'), // second chest exercise
    row('2026-04-05', 'S6', 'Bench Press',   'chest', 'BPR01'), // return → confirms S5
  ];
  const result = buildSubstitutionHistory(rows);
  // Both Incline and Cable Fly are substitutes for the same session × muscle group —
  // only one event should be emitted (the one with most sets in the session, which is
  // either; both have count 1 so it's implementation-defined — just verify only 1)
  const chestEvents = result.filter(e => e.date === '2026-03-29');
  assert.equal(chestEvents.length, 1, 'only one event per session × muscle group');
});

// ── Integration: buildSubstitutionHistory → detectPatterns ────────────────────

test('GOLDEN FIXTURE — repeated_substitution fires when 3+ substitutions detected', () => {
  const liftCode = 'BPR01';
  const rows = [
    // 4 baseline Bench Press sessions (chest)
    row('2026-03-01', 'S1',  'Bench Press', 'chest', liftCode),
    row('2026-03-08', 'S2',  'Bench Press', 'chest', liftCode),
    row('2026-03-15', 'S3',  'Bench Press', 'chest', liftCode),
    row('2026-03-22', 'S4',  'Bench Press', 'chest', liftCode),
    // 3 confirmed substitutions (Bench returns between each to confirm deviation)
    row('2026-03-29', 'S5',  'Incline Press', 'chest', 'IPR01'),
    row('2026-04-05', 'S6',  'Bench Press',   'chest', liftCode), // return → confirms S5
    row('2026-04-12', 'S7',  'Incline Press', 'chest', 'IPR01'),
    row('2026-04-19', 'S8',  'Bench Press',   'chest', liftCode), // return → confirms S7
    row('2026-04-26', 'S9',  'Incline Press', 'chest', 'IPR01'),
    row('2026-05-03', 'S10', 'Bench Press',   'chest', liftCode), // return → confirms S9
  ];

  const substitutionHistory = buildSubstitutionHistory(rows);
  // In production buildChatContext filters by liftCode; here all events are BPR01 so unfiltered is equivalent.
  const { patterns } = detectPatterns(liftCode, rows, { substitutionHistory });

  const subPattern = patterns.find(p => p.type === 'repeated_substitution');
  assert.ok(subPattern, 'repeated_substitution pattern must fire with 3+ substitutions');
  assert.equal(subPattern.details.count, 3);
  assert.equal(subPattern.details.original.toLowerCase(), 'bench press');
  assert.equal(subPattern.details.substitute.toLowerCase(), 'incline press');
});

test('repeated_substitution does NOT fire when fewer than 3 substitutions', () => {
  const liftCode = 'BPR01';
  const rows = [
    row('2026-03-01', 'S1', 'Bench Press', 'chest', liftCode),
    row('2026-03-08', 'S2', 'Bench Press', 'chest', liftCode),
    row('2026-03-15', 'S3', 'Bench Press', 'chest', liftCode),
    row('2026-03-22', 'S4', 'Incline Press', 'chest', 'IPR01'), // sub 1
    row('2026-03-29', 'S5', 'Bench Press',   'chest', liftCode), // return → confirms S4
    row('2026-04-05', 'S6', 'Incline Press', 'chest', 'IPR01'), // sub 2
    row('2026-04-12', 'S7', 'Bench Press',   'chest', liftCode), // return → confirms S6
    // Only 2 confirmed substitutions, not 3
  ];
  const substitutionHistory = buildSubstitutionHistory(rows);
  const { patterns } = detectPatterns(liftCode, rows, { substitutionHistory });
  const subPattern = patterns.find(p => p.type === 'repeated_substitution');
  assert.equal(subPattern, undefined, 'should not fire with only 2 substitutions');
});

test('per-lift filtering: Bench substitution history must NOT bleed into unrelated lifts', () => {
  // 4 baseline Bench + 3 confirmed substitutions (Bench returns between each).
  // An unrelated lift (Deadlift / DLT01) present in the same log must NOT inherit
  // the Bench pattern when its substitutionHistory is filtered to DLT01 only.
  const rows = [
    row('2026-03-01', 'S1',  'Bench Press', 'chest', 'BPR01'),
    row('2026-03-08', 'S2',  'Bench Press', 'chest', 'BPR01'),
    row('2026-03-15', 'S3',  'Bench Press', 'chest', 'BPR01'),
    row('2026-03-22', 'S4',  'Bench Press', 'chest', 'BPR01'),
    row('2026-03-29', 'S5',  'Incline Press', 'chest', 'IPR01'),
    row('2026-04-05', 'S6',  'Bench Press',   'chest', 'BPR01'), // return → confirms S5
    row('2026-04-12', 'S7',  'Incline Press', 'chest', 'IPR01'),
    row('2026-04-19', 'S8',  'Bench Press',   'chest', 'BPR01'), // return → confirms S7
    row('2026-04-26', 'S9',  'Incline Press', 'chest', 'IPR01'),
    row('2026-05-03', 'S10', 'Bench Press',   'chest', 'BPR01'), // return → confirms S9
    // Deadlift rows — unrelated muscle group, always present
    row('2026-03-01', 'S1', 'Deadlift', 'back', 'DLT01'),
    row('2026-03-08', 'S2', 'Deadlift', 'back', 'DLT01'),
  ];
  const substitutionHistory = buildSubstitutionHistory(rows);

  // Simulate buildChatContext per-lift filtering
  const benchHistory = substitutionHistory.filter(e => e.liftCode === 'BPR01');
  const deadliftHistory = substitutionHistory.filter(e => e.liftCode === 'DLT01');

  const { patterns: benchPatterns } = detectPatterns('BPR01', rows, { substitutionHistory: benchHistory });
  const { patterns: deadliftPatterns } = detectPatterns('DLT01', rows, { substitutionHistory: deadliftHistory });

  const benchSub = benchPatterns.find(p => p.type === 'repeated_substitution');
  assert.ok(benchSub, 'BPR01 must detect the Bench→Incline repeated substitution');

  const deadliftSub = deadliftPatterns.find(p => p.type === 'repeated_substitution');
  assert.equal(deadliftSub, undefined, 'DLT01 must NOT inherit the Bench substitution pattern');
});
