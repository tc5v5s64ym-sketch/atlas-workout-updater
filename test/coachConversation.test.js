const test = require('node:test');
const assert = require('node:assert/strict');
const { liftLabel, templatedSubstitutionLine, formatSubstituteCoachLine, templatedNextMoveAdvisoryLine, templatedRecoveryAdvisoryLine } = require('../public/coachVoiceTemplates');

/* ===== liftLabel ===== */

test('liftLabel extracts .name from an object ref', () => {
  assert.equal(liftLabel({ name: 'Back Squat', id: 1 }, 'fallback'), 'Back Squat');
});

test('liftLabel returns bare string refs unchanged', () => {
  assert.equal(liftLabel('Bench Press', 'fallback'), 'Bench Press');
});

test('liftLabel falls back when ref is null', () => {
  assert.equal(liftLabel(null, 'the prescribed lift'), 'the prescribed lift');
});

test('liftLabel falls back when object has no name', () => {
  assert.equal(liftLabel({}, 'default'), 'default');
});

/* ===== templatedSubstitutionLine ===== */

test('templatedSubstitutionLine: preserved good pivot — brief, non-lecturing acknowledgement (slice 2)', () => {
  const line = templatedSubstitutionLine({
    classification: 'preserved',
    quality: 'excellent',
    prescribed: { name: 'Barbell Row' },
    logged: { name: 'Cable Row' }
  });
  assert.match(line, /^Good pivot/);
  assert.match(line, /Cable Row/);
  assert.match(line, /Log it\./);
  // It must not lecture or scold a smart swap.
  assert.doesNotMatch(line, /next time|downgrade|shifts the target|untrained/i);
});

test('templatedSubstitutionLine: preserved but poor quality keeps the measured line (no false praise)', () => {
  const line = templatedSubstitutionLine({
    classification: 'preserved',
    quality: 'poor',
    prescribed: { name: 'Barbell Row' },
    logged: { name: 'Cable Row' }
  });
  assert.doesNotMatch(line, /Good pivot/);
  assert.match(line, /same job, different tool/i);
});

test('templatedSubstitutionLine: changed — shifts-muscle language', () => {
  const line = templatedSubstitutionLine({
    classification: 'changed',
    prescribed: 'Back Squat',
    logged: 'Leg Curl'
  });
  assert.match(line, /Leg Curl for Back Squat/);
  assert.match(line, /shifts the target muscle/i);
});

test('templatedSubstitutionLine: abandoned — untrained language', () => {
  const line = templatedSubstitutionLine({
    classification: 'abandoned',
    prescribed: { name: 'Back Squat' },
    logged: { name: 'Bench Press' }
  });
  assert.match(line, /Bench Press for Back Squat/);
  assert.match(line, /objective untrained/i);
});

test('templatedSubstitutionLine: baseline — no-history language', () => {
  const line = templatedSubstitutionLine({
    classification: 'baseline',
    prescribed: 'Deadlift',
    logged: 'Trap Bar Deadlift'
  });
  assert.match(line, /no history yet/i);
  assert.match(line, /baseline/i);
});

test('templatedSubstitutionLine: appends reason suffix when reason is present', () => {
  const line = templatedSubstitutionLine({
    classification: 'preserved',
    prescribed: 'Back Squat',
    logged: 'Leg Press',
    reason: 'platform unavailable'
  });
  assert.match(line, /Reason: platform unavailable/);
});

test('templatedSubstitutionLine: no reason suffix when reason is absent', () => {
  const line = templatedSubstitutionLine({
    classification: 'preserved',
    prescribed: 'Back Squat',
    logged: 'Leg Press'
  });
  assert.doesNotMatch(line, /Reason:/);
});

test('templatedSubstitutionLine: unknown classification falls back gracefully', () => {
  const line = templatedSubstitutionLine({
    classification: 'mystery',
    prescribed: 'Squat',
    logged: 'Lunge'
  });
  assert.match(line, /Lunge for Squat/);
});

test('templatedSubstitutionLine: null input does not throw', () => {
  const line = templatedSubstitutionLine(null);
  assert.equal(typeof line, 'string');
});

/* ===== templatedNextMoveAdvisoryLine (PR 484 — Fatigue Router fallback voice) ===== */

// Every voiced ROUTE_ACTION yields a suggestion-only heads-up — never an order,
// never a number, never a plan reorder. Mirrors the LLM prompt rule in coach.js.
const NEXT_MOVE_CASES = [
  ['reduce', /heads up/i, /ease off|trim a set|off the bar/i],
  ['make_optional', /optional/i, /skip it/i],
  ['promote_alternative', /rested|antagonist/i, /instead/i],
  ['block_pr', /no PR attempts|until you've recovered/i, /recover/i],
  ['reduce_intensity', /easy/i, /lower the zone|cut it short/i],
  ['reduce_density', /rounds|density/i, /cut/i],
];

for (const [action, headRe, bodyRe] of NEXT_MOVE_CASES) {
  test(`templatedNextMoveAdvisoryLine: ${action} → suggestion-only heads-up, no command/number`, () => {
    const line = templatedNextMoveAdvisoryLine({ action, next_exercise: 'Incline Press', reason: 'engine reason' });
    assert.equal(typeof line, 'string');
    assert.match(line, headRe);
    assert.match(line, bodyRe);
    assert.doesNotMatch(line, /\d/, 'deterministic next-move line must never carry a number');
    assert.doesNotMatch(line, /\byou (must|need to|have to)\b/i, 'never a command');
  });
}

test('templatedNextMoveAdvisoryLine: names the next exercise when present', () => {
  const line = templatedNextMoveAdvisoryLine({ action: 'reduce', next_exercise: 'Weighted Dips' });
  assert.match(line, /Weighted Dips/);
});

test('templatedNextMoveAdvisoryLine: missing next_exercise still reads cleanly', () => {
  const line = templatedNextMoveAdvisoryLine({ action: 'make_optional' });
  assert.match(line, /the next move/);
});

test('templatedNextMoveAdvisoryLine: keep / unknown / null carry no advice', () => {
  assert.equal(templatedNextMoveAdvisoryLine({ action: 'keep' }), null);
  assert.equal(templatedNextMoveAdvisoryLine({ action: 'mystery' }), null);
  assert.equal(templatedNextMoveAdvisoryLine(null), null);
});

/* ===== templatedRecoveryAdvisoryLine (PR 484 — Recovery/Deload fallback voice) ===== */

test('templatedRecoveryAdvisoryLine: deload → cautious, never a command, no numbers', () => {
  const line = templatedRecoveryAdvisoryLine({
    decision: 'deload',
    converged_signals: ['performance_decline', 'subjective_fatigue'],
    deload_style: { profile: 'strength', focus: ['cut accessory volume first'] }
  });
  assert.match(line, /worth considering/i, 'deload is suggested, never commanded');
  assert.doesNotMatch(line, /\byou (must|need to|have to)\b/i);
  assert.doesNotMatch(line, /\d/, 'no prescription numbers in the deload fallback line');
  assert.match(line, /performance decline, subjective fatigue/, 'humanizes the converged signals');
  assert.match(line, /cut accessory volume first/, 'names the deload-style focus when present');
});

test('templatedRecoveryAdvisoryLine: recovery_reload → hold-the-line, lighter not a full deload', () => {
  const line = templatedRecoveryAdvisoryLine({ decision: 'recovery_reload', converged_signals: ['effort_drift'] });
  assert.match(line, /holding the line/i);
  assert.match(line, /not a full deload/i);
  assert.doesNotMatch(line, /\d/);
});

test('templatedRecoveryAdvisoryLine: no signals → still a clean cautious line', () => {
  const line = templatedRecoveryAdvisoryLine({ decision: 'deload' });
  assert.match(line, /worth considering/i);
});

test('templatedRecoveryAdvisoryLine: non-recovery decisions and null carry no advice', () => {
  assert.equal(templatedRecoveryAdvisoryLine({ decision: 'normal' }), null);
  assert.equal(templatedRecoveryAdvisoryLine({ decision: 'taper' }), null);
  assert.equal(templatedRecoveryAdvisoryLine(null), null);
});

/* ===== formatSubstituteCoachLine ===== */

test('formatSubstituteCoachLine: excellent quality — single-coach prose', () => {
  const text = formatSubstituteCoachLine({
    prescribed: 'Barbell Back Squat',
    recommendation: 'Leg Press',
    quality: 'excellent',
    reason: 'Same quad/glute load'
  });
  assert.match(text, /No Barbell Back Squat today/);
  assert.match(text, /Leg Press is your best swap/);
  assert.match(text, /Same quad\/glute load/);
  assert.match(text, /Same stimulus, different bar/i);
});

test('formatSubstituteCoachLine: non-excellent quality — covers-the-session language', () => {
  const text = formatSubstituteCoachLine({
    prescribed: 'Deadlift',
    recommendation: 'Romanian Deadlift',
    quality: 'good',
    reason: 'Hip hinge pattern preserved'
  });
  assert.match(text, /No Deadlift today/);
  assert.match(text, /switch to Romanian Deadlift/i);
  assert.match(text, /Hip hinge pattern preserved/);
  assert.match(text, /get Deadlift back in/i);
});

test('formatSubstituteCoachLine: omits reason clause when reason is absent', () => {
  const text = formatSubstituteCoachLine({
    prescribed: 'Pull-up',
    recommendation: 'Lat Pulldown',
    quality: 'excellent'
  });
  assert.match(text, /No Pull-up today/);
  assert.doesNotMatch(text, /\. \./);   // no double-period artefact from empty reason
});

test('formatSubstituteCoachLine: returns null when required fields are missing', () => {
  assert.equal(formatSubstituteCoachLine({ recommendation: 'Leg Press' }), null);
  assert.equal(formatSubstituteCoachLine({ prescribed: 'Squat' }), null);
  assert.equal(formatSubstituteCoachLine({}), null);
  assert.equal(formatSubstituteCoachLine(), null);
});

/* ===== Composer placeholder: compact full prescription + parse-safe aliases ===== */
const fs = require('node:fs');
const path = require('node:path');
const { canonicalizeExerciseName } = require('../services/workoutTextParser');

test('composer aliases all round-trip through the canonicalizer (no wrong-lift logs)', () => {
  // Read the COMPOSER_ALIASES table from the source and assert every alias parses
  // back to a real canonical lift — so a typed hint never logs the wrong exercise.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  const block = src.slice(src.indexOf('const COMPOSER_ALIASES'), src.indexOf('function composerLiftAlias'));
  const aliases = [...block.matchAll(/,\s*'([^']+)'\]/g)].map(m => m[1]);
  assert.ok(aliases.length >= 5, `expected the alias table to be present, found ${aliases.length}`);
  for (const alias of aliases) {
    const canon = canonicalizeExerciseName(alias);
    assert.ok(canon && canon.canonicalName,
      `composer alias ${JSON.stringify(alias)} must canonicalize to a real lift, got ${JSON.stringify(canon)}`);
  }
});

test('buildWorkoutPlaceholder renders the compact full prescription (alias + wu + collapsed sets)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  // Placeholder is built from the compact prescription, not just the lead set.
  assert.match(src, /function buildWorkoutPlaceholder[\s\S]*?compactPrescription\(exercises\[0\]\)/,
    'buildWorkoutPlaceholder should use compactPrescription');
  // compactPrescription marks warm-ups "wu" and collapses repeated working sets "xN".
  assert.match(src, /\$\{w\.weight\}x\$\{w\.reps\}wu/, 'warm-ups rendered as "{w}x{r}wu"');
  assert.match(src, /x\$\{sets\}/, 'repeated working sets collapsed as "xN"');
  // Warm-ups come off the RAW exercise (display-only), never normalized into the plan.
  assert.match(src, /warmupSetsFor\(raw\)/, 'warm-ups read from the raw exercise (display-only)');
});

test('app.js attaches a bare set sequence to the first unlogged planned lift', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /function firstUnloggedPlannedLift\(\)/, 'helper that finds the current planned lift');
  assert.match(src, /activeExercise:\s*activeExercise \|\| firstUnloggedPlannedLift\(\)/,
    'parse context falls back to the first unlogged planned lift when no lift is active');
});
