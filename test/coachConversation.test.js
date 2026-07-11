const test = require('node:test');
const assert = require('node:assert/strict');
// PR-08: coachVoiceTemplates is an ES module now — dynamic import (Node 20 CI has
// no require(esm)).
let liftLabel, templatedSubstitutionLine, formatSubstituteCoachLine, templatedNextMoveAdvisoryLine,
  templatedRecoveryAdvisoryLine, governorOverridesProgressionInvite, templatedGovernorHoldLine;
test.before(async () => {
  ({ liftLabel, templatedSubstitutionLine, formatSubstituteCoachLine, templatedNextMoveAdvisoryLine,
    templatedRecoveryAdvisoryLine, governorOverridesProgressionInvite, templatedGovernorHoldLine } =
    await import('../src/app/coachVoiceTemplates.js'));
});

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

test('templatedNextMoveAdvisoryLine: promote_alternative reads cleanly with a named lift (no "instead of on")', () => {
  const line = templatedNextMoveAdvisoryLine({ action: 'promote_alternative', next_exercise: 'Incline Press' });
  assert.match(line, /instead of Incline Press\./);
  assert.doesNotMatch(line, /instead of on/);
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

/* ===== G2 — coach addresses EVERY logged lift, not just the first ===== */

// handleSetLogged is a DOM-bound handler in the IIFE, so this layer is verified by
// source-introspection (the repo's pattern for this file). The fix: after the
// primary lift's coaching, iterate the ADDITIONAL logged lifts and build a coaching
// note for each, so a stacked multi-exercise entry coaches all lifts — not exercises[0].
function handleSetLoggedSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  const start = src.indexOf('async function handleSetLogged(');
  assert.ok(start !== -1, 'handleSetLogged must exist');
  const end = src.indexOf('\n  async function ', start + 1);
  return src.slice(start, end === -1 ? start + 4000 : end);
}

test('G2: handleSetLogged coaches every ADDITIONAL logged lift (not just exercises[0])', () => {
  const fn = handleSetLoggedSource();
  // The primary lift is still coached exactly as before…
  assert.match(fn, /const primary = exercises\[0\]/, 'primary lift coaching preserved');
  // …and there is now a loop over the remaining lifts that builds a coaching note
  // for each, attributing the prose to its lift name so both lifts are referenced.
  assert.match(fn, /for \(const ex of exercises\.slice\(1\)\)/,
    'must iterate the additional logged lifts');
  const loop = fn.slice(fn.indexOf('for (const ex of exercises.slice(1))'));
  assert.match(loop, /getInWorkoutNote\(/, 'each additional lift gets its own coaching note');
  assert.match(loop, /exerciseName:\s*ex\.exercise/, 'the note is built for that lift');
  assert.match(loop, /\$\{ex\.exercise\}:\s*\$\{exReaction\.note\}/,
    'the additional lift’s prose is attributed by lift name (both lifts referenced)');
});

// FA — coach renders per-lift blocks [card -> coaching -> Next] in order, not all
// cards then all coaching. (Updated from the prior G2 "all-cards readback loop"
// structural assertions, which pinned the pre-FA implementation; the behavioral
// guarantees they protected — every lift coached, single-lift unchanged, no double-
// coach — are preserved and re-asserted here against the new interleaved structure.)

test('FA: single-exercise entry renders one block, byte-identical (no upfront all-cards loop)', () => {
  const fn = handleSetLoggedSource();
  // The pre-FA batched "for (const ex of exercises) { ...readback... }" loop is GONE —
  // cards are no longer all rendered up front.
  assert.doesNotMatch(fn, /for \(const ex of exercises\) \{/,
    'the upfront all-cards readback loop must be removed (cards are now per-lift)');
  // The PRIMARY lift's card is inserted before `body`, so a single-lift entry is exactly
  // [card][coaching(body)][effort][Next] as before.
  assert.match(fn, /bubble\.insertBefore\(buildReadback\(primary\.exercise[\s\S]*?\), body\)/,
    'the primary card is inserted before body (single-lift order unchanged)');
  // All additional rendering is scoped to exercises.slice(1) — empty for one lift, so a
  // single-lift entry produces no extra block (no doubled output).
  assert.match(fn, /for \(const ex of exercises\.slice\(1\)\)/,
    'additional lifts are rendered only inside the slice(1) loop');
});

test('FA: a stacked entry renders each lift as card -> coaching -> Next, in order', () => {
  const fn = handleSetLoggedSource();
  const loop = fn.slice(fn.indexOf('for (const ex of exercises.slice(1))'));
  const end = loop.indexOf('\n    }');
  const body = end === -1 ? loop : loop.slice(0, end);
  // Within each additional lift's block, the three pieces appear in order:
  // card (buildReadback) -> coaching (getInWorkoutNote) -> Next (buildNextPrescription).
  const cardIdx = body.indexOf('buildReadback(');
  const coachIdx = body.indexOf('getInWorkoutNote(');
  const nextIdx = body.indexOf('buildNextPrescription(');
  assert.ok(cardIdx !== -1, 'each additional lift renders its own card');
  assert.ok(coachIdx !== -1, 'each additional lift renders its own coaching note');
  assert.ok(nextIdx !== -1, 'each additional lift renders its own Next prescription');
  assert.ok(cardIdx < coachIdx && coachIdx < nextIdx,
    'order per lift must be card -> coaching -> Next');
  // The card is appended (interleaved with this lift's coaching), not inserted before body
  // (which would batch it with the primary card at the top).
  assert.match(body, /bubble\.appendChild\(buildReadback\(ex\.exercise/,
    'the additional lift card is appended in sequence, not batched before body');
});

/* ===== governor grade fallback voice (PR 484 — LLM-down stimulus_grade voicing) ===== */

test('governorOverridesProgressionInvite: true when the governor holds / backs off / flags fatigue', () => {
  assert.equal(governorOverridesProgressionInvite({ progression_verdict: 'hold', fatigue_signal: 'none' }), true);
  assert.equal(governorOverridesProgressionInvite({ progression_verdict: 'back_off', fatigue_signal: 'none' }), true);
  assert.equal(governorOverridesProgressionInvite({ progression_verdict: '+load', fatigue_signal: 'elevated' }), true);
  assert.equal(governorOverridesProgressionInvite({ progression_verdict: '+reps', fatigue_signal: 'high' }), true);
});

test('governorOverridesProgressionInvite: false when the governor invites progression with no fatigue', () => {
  assert.equal(governorOverridesProgressionInvite({ progression_verdict: '+load', fatigue_signal: 'none' }), false);
  assert.equal(governorOverridesProgressionInvite(null), false);
  assert.equal(governorOverridesProgressionInvite(undefined), false);
  assert.equal(governorOverridesProgressionInvite({}), false);
});

test('templatedGovernorHoldLine: a back_off / high-fatigue read words a firm hold (no numbers)', () => {
  const backOff = templatedGovernorHoldLine({ profile: 'strength', progression_verdict: 'back_off', fatigue_signal: 'none' });
  const highFatigue = templatedGovernorHoldLine({ profile: 'hypertrophy', progression_verdict: 'hold', fatigue_signal: 'high' });
  for (const line of [backOff, highFatigue]) {
    assert.equal(typeof line, 'string');
    assert.match(line, /back off|hold/i);
    assert.doesNotMatch(line, /\d/, 'the governor hold line must never state a number');
  }
});

test('templatedGovernorHoldLine: general_fitness hold names the goal is met, never celebrates chasing more', () => {
  const line = templatedGovernorHoldLine({ profile: 'general_fitness', progression_verdict: 'hold', fatigue_signal: 'elevated' });
  assert.match(line, /goal/i);
  assert.match(line, /hold/i);
  assert.doesNotMatch(line, /\d/);
});

test('templatedGovernorHoldLine: default hold says repeat, not jump (no numbers)', () => {
  const line = templatedGovernorHoldLine({ profile: 'strength', progression_verdict: 'hold', fatigue_signal: 'none' });
  assert.match(line, /hold/i);
  assert.match(line, /repeat|not a jump/i);
  assert.doesNotMatch(line, /\d/);
});

test('templatedGovernorHoldLine: null when the governor does not override (progression invited, no fatigue)', () => {
  assert.equal(templatedGovernorHoldLine({ profile: 'strength', progression_verdict: '+load', fatigue_signal: 'none' }), null);
  assert.equal(templatedGovernorHoldLine(null), null);
});

// --- PR-4 (composer-first Phase 0a): tier-aware brevity in the deterministic voice ---

test('isBriefTier: short and ack_only are brief; extended/null/per-set are not', async () => {
  const t = await import('../src/app/coachVoiceTemplates.js');
  assert.equal(t.isBriefTier('short'), true);
  assert.equal(t.isBriefTier('ack_only'), true);
  assert.equal(t.isBriefTier('extended'), false);
  assert.equal(t.isBriefTier(null), false, 'per-set notes carry no tier and must never be brief');
  assert.equal(t.isBriefTier(undefined), false);
});

test('tier-aware brevity: short trims supplements, never the recovery read', () => {
  const cc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  const fn = cc.slice(cc.indexOf('async function getInWorkoutNote'), cc.indexOf('async function getLlmCoachingMessage'));
  assert.match(fn, /const brief = coachVoiceTemplates\.isBriefTier\(data && data\.note_tier\)/,
    'the deterministic paths must consult the engine tier');
  assert.match(fn, /const subLine = brief \? null :/, 'the substitution ack is a supplement — trimmed when brief');
  assert.match(fn, /\(data && !brief\) \? coachVoiceTemplates\.templatedNextMoveAdvisoryLine/,
    'the next-move heads-up is a supplement — trimmed when brief');
  assert.match(fn, /const recoveryLine = data \? coachVoiceTemplates\.templatedRecoveryAdvisoryLine/,
    'the recovery read is safety-class and must NOT be gated on brief');
});

// --- ack_only = brief acknowledgement, NOT silence (every logged lift is coached) ---

test('templatedAckLine: a routine (ack_only) lift gets a concise deterministic acknowledgement, never empty', async () => {
  const t = await import('../src/app/coachVoiceTemplates.js');
  const line = t.templatedAckLine();
  assert.equal(typeof line, 'string');
  assert.ok(line.trim().length > 0, 'a routine set must still get a note — ack_only is not silence');
  assert.ok(line.length <= 60, 'the acknowledgement stays concise');
  assert.doesNotMatch(line, /\d/, 'the numbers live on the readback card, never in the ack line');
});

test('templatedAckLine: name-free so the multi-lift caller can attribute it without doubling the lift name', async () => {
  const t = await import('../src/app/coachVoiceTemplates.js');
  const line = t.templatedAckLine('Bench Press');
  // The additional-lift path prefixes `${ex.exercise}: ${note}`, so the ack itself must
  // not embed the exercise name (else "Bench Press: Bench Press — logged").
  assert.doesNotMatch(line, /bench/i, 'the ack line carries no exercise name');
});

test('getInWorkoutNote: an ack_only block returns a brief ack note (not silence), keeping the box/effort suppressed', () => {
  const cc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  const fn = cc.slice(cc.indexOf('async function getInWorkoutNote'), cc.indexOf('async function getLlmCoachingMessage'));
  const branchStart = fn.indexOf("data.note_tier === 'ack_only'");
  assert.ok(branchStart !== -1, 'the ack_only branch must exist');
  const branch = fn.slice(branchStart, branchStart + 260);
  // The note is now a deterministic acknowledgement — NOT null (which rendered nothing).
  assert.match(branch, /note:\s*coachVoiceTemplates\.templatedAckLine\(/,
    'ack_only must return a brief templated acknowledgement, not silence');
  assert.doesNotMatch(branch, /\bnote:\s*null/, 'ack_only must no longer return note: null (that was the silence bug)');
  // The routine block stays minimal: still flagged ack_only (Next box + effort line suppressed).
  assert.match(branch, /ack_only:\s*true/, 'the block is still tagged ack_only so the Next box + effort line stay suppressed');
  assert.match(branch, /effort_note:\s*null/, 'a routine block carries no separate effort line');
});

// --- Composer-first Phase A: the coach speaks first (deterministic opening line) ---

test('opening: greeting renders synchronously and issues no fetch', () => {
  const cc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  const iife = cc.slice(cc.indexOf('(function setGreeting()'), cc.indexOf('function renderCoachOpening'));
  assert.match(iife, /el\.textContent = `Good \$\{part\}, Dale\.`;/, 'the greeting never waits on a fetch');
  assert.doesNotMatch(iife, /await |api\(/, 'the greeting path issues no fetch of its own');
});

// Coach-first home opener (owner 2026-07-03, PR-1): the "Today's read" briefing
// is replaced by a deterministic coaching DECISION (call + engine reason +
// invitation). renderCoachOpening paints it and retires the dashboard chrome.
test('opening: the coach opener renders app.js\'s decision — LLM-free, no fetch, retires the dashboard chrome', () => {
  const cc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  const fn = cc.slice(cc.indexOf('function renderCoachOpening'), cc.indexOf("document.addEventListener('atlas:preview-ready'"));
  assert.match(fn, /addEventListener\('atlas:glance-ready'/, 'renders the opener app.js dispatched from the startup fetch');
  assert.doesNotMatch(fn, /\bapi\(/, 'the opener issues no fetch of its own — app.js already fetched the data');
  assert.doesNotMatch(fn, /\/api\/coach/, 'no LLM anywhere in the opener path');
  assert.match(fn, /hero\.hasAttribute\('hidden'\)/, 'skips when the conversation already started');
  assert.match(fn, /d\.opener/, 'paints the deterministic coach decision');
  assert.doesNotMatch(fn, /d\.headline|Today's read/, 'no "Today\'s read" headline — that was the dashboard tell');
  assert.match(fn, /getElementById\('coach-facts'\)[\s\S]*facts\.hidden = true/, 'retires the stacked facts wall');
  assert.match(fn, /getElementById\('coach-guide'\)[\s\S]*guide\.hidden = true/, 'retires the static tutorial');
});

// The opener STRING is built in app.js from the same startup fetch — a coaching
// decision, not a metrics wall. Functional check of the composition: the engine's
// own why_today sentence (verbatim) for the reason, the recommended focus for the
// call, a fixed invitation, and degradation to '' when the engine named nothing.
test('opening: buildCoachOpener words the engine decision + reason verbatim, drops near-duplicates, invites, degrades', () => {
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const src = app.slice(app.indexOf('function buildCoachOpener('), app.indexOf('function emitGlanceReady('));
  const { buildCoachOpener, endSentence, isNearDuplicateReason } =
    new Function(`${src}\nreturn { buildCoachOpener, endSentence, isNearDuplicateReason };`)();
  // Reason (verbatim why_today) + call (recommended focus) + invitation. No
  // weekday, no "Today's read" label, no facts wall, no days-since.
  assert.equal(
    buildCoachOpener({
      todays_read: { recommended_intent_id: 'build_strength', recommended_reason: 'Heavy compound work' },
      intents: [
        { id: 'build_strength', recommended: true, focus: 'Heavy compound work', why_today: ['Multiple muscle groups are recovered'] },
        { id: 'build_muscle', recommended: false, focus: 'Moderate load' },
      ],
    }),
    "Multiple muscle groups are recovered. Today, let's make it heavy compound work. Ready when you are — or tell me to change the plan."
  );
  // Acronyms in the focus survive the mid-sentence lowercasing (OHP, not ohp).
  assert.equal(
    buildCoachOpener({ todays_read: {}, intents: [{ recommended: true, focus: 'Bench + OHP', why_today: ['Pressing patterns are fresh'] }] }),
    "Pressing patterns are fresh. Today, let's make it bench + OHP. Ready when you are — or tell me to change the plan."
  );
  // No why_today → call + invitation only; still no fabrication, no forecast.
  assert.equal(
    buildCoachOpener({ todays_read: { recommended_reason: 'Upper body — press + pull' }, intents: [] }),
    "Today, let's make it upper body — press + pull. Ready when you are — or tell me to change the plan."
  );
  // Near-duplicate reason (the engine's low-data default why mirrors the focus) is
  // DROPPED — the opener states the call once, never restates it.
  assert.equal(
    buildCoachOpener({ todays_read: {}, intents: [{ recommended: true, focus: 'Heavy compound work', why_today: ['Good time for heavy compound work'] }] }),
    "Today, let's make it heavy compound work. Ready when you are — or tell me to change the plan."
  );
  // No engine read at all → empty, so nothing is dispatched and the default hero stands.
  assert.equal(buildCoachOpener({}), '');
  assert.equal(buildCoachOpener({ intents: [], todays_read: {} }), '');
  assert.equal(buildCoachOpener(null), '');

  // endSentence hardens against terminal !/? — no double punctuation ("Ready?.").
  assert.equal(endSentence('Bar speed is back!'), 'Bar speed is back.');
  assert.equal(endSentence('Feeling strong?'), 'Feeling strong.');
  assert.equal(endSentence('Pressing patterns are fresh'), 'Pressing patterns are fresh.');
  assert.equal(endSentence('Recovered —'), 'Recovered.');
  // A why_today ending in "!" flows into the opener cleanly (no "!.").
  assert.equal(
    buildCoachOpener({ todays_read: {}, intents: [{ recommended: true, focus: 'Bench + OHP', why_today: ['You crushed it last week!'] }] }),
    "You crushed it last week. Today, let's make it bench + OHP. Ready when you are — or tell me to change the plan."
  );

  // The near-duplicate guard is whole-word bounded: a shared stem is NOT a duplicate.
  assert.equal(isNearDuplicateReason('Good time for heavy compound work', 'Heavy compound work'), true);
  assert.equal(isNearDuplicateReason('Heavy compound work', 'Heavy compound work'), true);
  assert.equal(isNearDuplicateReason('Pushing patterns are fresh', 'Push'), false);
  assert.equal(isNearDuplicateReason('Pressing patterns are fresh', 'Bench + OHP'), false);
});

// emitGlanceReady dispatches the single opener string and degrades silently; the
// old weekday/"Today's read" headline, the facts wall, and buildPatternBriefing
// are gone. loadDashboard hands over its own fetch (no second call, no LLM).
test('opening: emitGlanceReady dispatches the coach opener and stays silent when the engine named no session', () => {
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const builder = app.slice(app.indexOf('function buildCoachOpener('), app.indexOf('function emitGlanceReady('));
  assert.doesNotMatch(builder, /Today's read|weekday|toLocaleDateString|buildPatternBriefing|buildConsistencyText|daysSince/,
    'no weekday / "Today\'s read" label / facts / streak / days-since — the dashboard tells are gone');
  assert.match(builder, /why_today/, 'the reason is the engine\'s own why_today sentence');
  assert.equal(app.includes('function buildPatternBriefing('), false, 'the freshest-pattern facts builder is retired');
  const emit = app.slice(app.indexOf('function emitGlanceReady('), app.indexOf('async function loadCoachPlan('));
  assert.match(emit, /atlas:glance-ready/, 'dispatches the prebuilt opener');
  assert.match(emit, /opener,[\s\S]*compressed:[\s\S]*signature:/, 'hands over the opener + compressed continuation + de-dup signature');
  assert.match(emit, /if \(!opener\) return/, 'stays silent when the engine named no session (default hero stands)');
  assert.doesNotMatch(emit, /\/api\/coach/, 'no LLM in the opener path');
  assert.match(app, /emitGlanceReady\(intentData\);/, 'loadDashboard emits the opener from its own fetch');
});

// Anti-repetition (PR-2, display-only): the compressed continuation words the SAME
// decision the engine made (no invention, floored, never blank); the signature
// keys on the engine read so a same-day reopen with unchanged state can de-dup.
test('opening: the compressed continuation + signature come from the engine read (PR-2)', () => {
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const src = app.slice(app.indexOf('function buildCoachOpener('), app.indexOf('function emitGlanceReady('));
  const { compressedOpener, openerSignature } =
    new Function(`${src}\nreturn { compressedOpener, openerSignature };`)();
  const read = {
    todays_read: { recommended_intent_id: 'build_strength', days_since_last_session: 5 },
    intents: [{ id: 'build_strength', recommended: true, focus: 'Heavy compound work', why_today: ['x'] }],
  };
  assert.equal(compressedOpener(read), "Still here. Heavy compound work whenever you're ready.",
    'the short line words the SAME decision — floored, never blank, invents nothing');
  assert.match(openerSignature(read), /\|build_strength\|5$/, 'signature keys on recommended intent + gap (+ day)');
  // No engine read → no signature and no compressed line (never compresses).
  assert.equal(compressedOpener({}), '');
  assert.equal(openerSignature({}), '');
});

// The real emitGlanceReady → renderCoachOpening path: a same-day repeat reopen with
// UNCHANGED engine state shows the compressed continuation instead of re-briefing;
// a changed state (or a new day) briefs in full again. Driven headless with DOM +
// localStorage stubs.
test('opening: a same-state repeat reopen shows the compressed continuation, not a re-brief (PR-2 ledger)', () => {
  const fs = require('node:fs'), path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const cc = fs.readFileSync(path.join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  const appSrc = app.slice(app.indexOf('function buildCoachOpener('), app.indexOf('async function loadCoachPlan('));
  const ccStart = cc.indexOf('const OPENER_LEDGER_KEY');
  const ccSrc = cc.slice(ccStart, cc.indexOf('\n', cc.indexOf("document.addEventListener('atlas:glance-ready'")));

  const store = {};
  const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const els = {
    'coach-empty': { hasAttribute: () => false },
    'coach-opening': { textContent: "Let's get stronger." },
    'coach-facts': { hidden: false }, 'coach-guide': { hidden: false },
  };
  const listeners = {};
  const document = {
    getElementById: id => els[id] || null,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent: ev => { (listeners[ev.type] || []).forEach(fn => fn(ev)); return true; },
  };
  const CustomEvent = class { constructor(type, init) { this.type = type; this.detail = (init || {}).detail; } };
  // Wire the real code once (single listener registration), then reopen repeatedly.
  const { emitGlanceReady } = new Function('document', 'CustomEvent', 'localStorage',
    `${appSrc}\n${ccSrc}\nreturn { emitGlanceReady };`)(document, CustomEvent, localStorage);

  const readA = {
    todays_read: { recommended_intent_id: 'build_strength', days_since_last_session: 5 },
    intents: [{ id: 'build_strength', recommended: true, focus: 'Heavy compound work', why_today: ['Multiple muscle groups are recovered'] }],
  };

  emitGlanceReady(readA);  // first open today → full brief
  assert.match(els['coach-opening'].textContent,
    /^Multiple muscle groups are recovered\. Today, let's make it heavy compound work\./,
    'first open of the day briefs in full');
  assert.equal(els['coach-facts'].hidden, true, 'dashboard chrome still retired');

  els['coach-opening'].textContent = "Let's get stronger.";
  emitGlanceReady(readA);  // same state, same day → compressed
  assert.equal(els['coach-opening'].textContent, "Still here. Heavy compound work whenever you're ready.",
    'a same-state repeat reopen does not re-brief');

  // A CHANGED state (different recommended intent) briefs in full again.
  els['coach-opening'].textContent = "Let's get stronger.";
  emitGlanceReady({
    todays_read: { recommended_intent_id: 'build_muscle', days_since_last_session: 5 },
    intents: [{ id: 'build_muscle', recommended: true, focus: 'Moderate load, 6–12 reps', why_today: ['Volume is in a good range'] }],
  });
  assert.match(els['coach-opening'].textContent, /^Volume is in a good range\. Today, let's make it/,
    'a changed engine read briefs in full, not compressed');
});

// PR-11 Bug 3 — logging identical sets must summarize, not repeat. The readback tile
// listed every set individually ("225×5 RIR 2 · 225×5 RIR 2 · 225×5 RIR 2"); it must
// group consecutive identical sets ("225×5 RIR 2 ×3") the way the review card does.
test('PR-11 Bug 3: consecutive identical sets group with a count via one shared helper', () => {
  const cc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  const start = cc.indexOf('function groupConsecutiveSets(');
  assert.ok(start !== -1, 'a shared groupConsecutiveSets helper must exist');
  const end = cc.indexOf('\n  function ', start + 1);
  // Newline before `return` so a trailing line comment in the slice can't swallow it.
  const groupConsecutiveSets = new Function(`${cc.slice(start, end)}\nreturn groupConsecutiveSets;`)();

  // Three identical bench sets → ONE group, count 3 (no repetition).
  const g1 = groupConsecutiveSets([{ weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 5, rir: 2 }]);
  assert.equal(g1.length, 1);
  assert.equal(g1[0].count, 3);
  // A warm-up climb → three DISTINCT groups, count 1 each (different sets never merge).
  const g2 = groupConsecutiveSets([{ weight: 135, reps: 12, rir: 4 }, { weight: 185, reps: 10, rir: 2 }, { weight: 225, reps: 5, rir: 0 }]);
  assert.equal(g2.length, 3);
  assert.ok(g2.every(x => x.count === 1));
  // Only CONSECUTIVE identical sets collapse (matches the review card exactly).
  const g3 = groupConsecutiveSets([{ weight: 225, reps: 5, rir: 2 }, { weight: 185, reps: 8, rir: 2 }, { weight: 225, reps: 5, rir: 2 }]);
  assert.equal(g3.length, 3);

  // The readback tile now groups via the shared helper (the visible Bug-3 fix), and the
  // review-card set line uses the SAME helper (one grouping source of truth).
  const readout = cc.slice(cc.indexOf('function appendSetReadout('), cc.indexOf('function buildReadback('));
  assert.match(readout, /groupConsecutiveSets\(/, 'appendSetReadout must group identical sets');
  const review = cc.slice(cc.indexOf('function buildReviewSetLine('), cc.indexOf('function buildEffortGrid('));
  assert.match(review, /groupConsecutiveSets\(/, 'buildReviewSetLine must use the same shared grouper');
});

test('bodyweight display: no-load sets read as reps everywhere — never "0×reps" (owner live find 2026-07-03)', () => {
  const cc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  const guard = cc.slice(cc.indexOf('function hasLoad('), cc.indexOf('function appendSetReadout('));
  assert.match(guard, /Number\(weight\) !== 0/, 'a literal 0 counts as bodyweight (sheet rows store bodyweight sets with weight 0)');
  // All three renderers consult the shared guard.
  const readout = cc.slice(cc.indexOf('function appendSetReadout('), cc.indexOf('function buildReadback('));
  assert.match(readout, /hasLoad\(s\.weight\) \? `\$\{s\.weight\}×\$\{s\.reps\} ` : `\$\{s\.reps\} reps `/,
    'the readback tile reads bodyweight sets as reps');
  const review = cc.slice(cc.indexOf('function buildReviewSetLine('), cc.indexOf('function buildEffortGrid('));
  assert.match(review, /hasLoad\(g\.set\.weight\)/, 'the review-card set line uses the same rule');
  // (The old "Last time: …" opener rendered a set and carried its own 0-weight
  // guard; it was replaced by the deterministic engine briefing — owner 2026-07-03
  // — which renders no set line, so there is no opener load edge to guard here.)
  // app.js carries ONE shared helper for every logged-set renderer (review #828
  // swept the full file: recap, plan card, PR table, best-recent, last-session
  // hint, plan-sheet labels, in-lift panel).
  // PR-09b: app.js was split into ES modules; the logged-set renderers now live
  // across app.js + the extracted view modules. Read the concatenated shell so
  // both the "every renderer uses formatSetLoad" sweep and the "no unguarded
  // template remains" sweep still see every call site.
  const _fs = require('node:fs'), _p = require('node:path');
  const app = ['app.js', 'api.js', 'dom.js', 'bugReport.js', 'settingsHealth.js', 'historyView.js', 'progressView.js']
    .map(f => _fs.readFileSync(_p.join(__dirname, '..', 'public', f), 'utf8')).join('\n');
  const helper = app.slice(app.indexOf('function formatSetLoad('), app.indexOf('function formatSetLoad(') + 300);
  assert.match(helper, /Number\(weight\) !== 0/, 'the app.js helper carries the same literal-0 rule');
  for (const site of ["class: 'session-ex-set'", 'coach-plan-last', 'bestWeightSet ?', 'bestRepSet ?', "rows.push(['Last'"]) {
    const idx = app.indexOf(site);
    assert.ok(idx > -1, `site marker missing: ${site}`);
    assert.ok(app.slice(Math.max(0, idx - 300), idx + 300).includes('formatSetLoad('),
      `logged-set renderer near "${site}" must use formatSetLoad`);
  }
  // No LOGGED-set weight×reps template remains outside the helper (engine
  // TARGET renders — t./target./ex. plan rows — keep their own rendering).
  for (const bad of ['${s.weight} × ${s.reps}', '${r.weight} × ${r.reps}', '${last.weight} × ${last.reps}',
    '${lastSet.weight} × ${lastSet.reps}', '${s.weight}×${s.reps}']) {
    assert.equal(app.includes(bad), false, `unguarded logged-set render remains: ${bad}`);
  }
  const nav = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'nav.js'), 'utf8');
  assert.match(nav, /Number\(s\.weight\) !== 0\) \? `\$\{s\.weight\}×\$\{s\.reps\}` : `\$\{s\.reps\} reps`/,
    'the last-session chip row reads bodyweight sets as reps');
});

// --- Owner directive (2026-07-03, live screenshots): plans read STACKED ---
// The chat's plan reply rendered "RDL — 230 × 8 reps × 3 sets @ RIR 2" prose;
// the owner wants the Coach's-Pick stacked block everywhere a plan renders.

test('stacked plans: an applied chat plan edit renders the structured block, not prose', () => {
  const cc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  const branch = cc.slice(cc.indexOf('if (chatResult.propose_plan_edit)'), cc.indexOf("// Show \"Save this note?\""));
  assert.match(branch, /appendWorkoutPlan\(bubble,/, 'the applied edit renders through the SAME structured block the pick uses');
  // PR-12 (Bug 3): the block renders the single normalized model app.js stored
  // (handed back on result.exercises), not a second independent re-mapping of
  // edit.exercises — so the block, the banner, and the store cannot drift.
  assert.match(branch, /result\.exercises/, 'block renders the applied single-source model');
  assert.doesNotMatch(branch, /target_weight: x\.weight/, 'no second, drift-prone re-mapping of edit.exercises');
  assert.match(branch, /Plan updated\./, 'the confirmation note survives');
});

test('stacked plans: the chat prompt tells the model NOT to enumerate the plan in prose', () => {
  const coach = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'services', 'coach.js'), 'utf8');
  assert.match(coach, /Do NOT enumerate the plan exercise-by-exercise in your prose/,
    'the app owns the plan render; the model words the focus only');
});

test('stacked plans: suggest/recommend phrasings route to the canonical pick (deterministic, stacked)', () => {
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const src = app.slice(app.indexOf('function looksLikeSessionRequest'), app.indexOf('function looksLikeArtifactRequest'));
  const fn = new Function(`${src}; return looksLikeSessionRequest;`)();
  for (const t of ['What workout would you suggest for today', 'can you suggest a workout', 'recommend me a session']) {
    assert.equal(fn(t), true, `must route to the pick: "${t}"`);
  }
  for (const t of ['I suggest you rest', 'that workout was hard', 'Bench 225 5/2']) {
    assert.equal(fn(t), false, `must NOT route to the pick: "${t}"`);
  }
});

test('opening: the default tagline survives every failure path (element + copy intact)', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="coach-opening" class="coach-empty-tagline">Let's get stronger\.</,
    'the cold-start/offline default is unchanged');
});

// --- Home screen (owner directive 2026-07-03): one Atlas text box, no tiles ---

test('home guide box: the hero is ONE Atlas text box — no tiles, no chips', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.equal(html.includes('id="coach-chips"'), false, 'the state-driven hero chips are retired');
  assert.equal(html.includes('id="suggested-tiles"'), false, 'the quick-start tiles are retired');
  assert.equal(html.includes('id="learn-chips"'), false, 'the learn chips are retired');
  const heroIdx = html.indexOf('id="coach-empty"');
  const boxIdx = html.indexOf('class="coach-guide-box"');
  const guideIdx = html.indexOf('id="coach-guide"');
  const heroEnd = html.indexOf('id="session-pin"');
  assert.ok(heroIdx > -1 && boxIdx > heroIdx && boxIdx < heroEnd, 'the guide box lives inside the hero');
  assert.ok(guideIdx > boxIdx && guideIdx < heroEnd, 'the guidance line lives inside the guide box');
});

test('home guide box: every suggested phrasing routes deterministically through the composer', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /what are we doing today\?/, 'the guide names the pick sentence');
  assert.match(html, /Bench 225 5\/2/, 'the guide shows the slash-notation example (freestyle = just log)');
  // The pick sentence Atlas suggests MUST be a phrase looksLikeSessionRequest
  // recognizes — what Atlas tells the user to type has to actually work.
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const routeFn = app.slice(app.indexOf('function looksLikeSessionRequest('), app.indexOf('function looksLikeArtifactRequest('));
  assert.match(routeFn, /what are we doing/, 'the suggested sentence is on the deterministic pick route');
});

test('chips: the deprecated static strip is gone; its in-thread handlers remain for reuse', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.equal(html.includes('id="suggestion-chips"'), false, 'the second-lane strip is retired');
  const nav = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'nav.js'), 'utf8');
  assert.doesNotMatch(nav, /getElementById\('suggestion-chips'\)/, 'its dead listener is removed');
  assert.match(nav, /window\.atlasChipAnswerLast = chipAnswerLast/, 'the conversation layer still reuses chipAnswerLast');
});
