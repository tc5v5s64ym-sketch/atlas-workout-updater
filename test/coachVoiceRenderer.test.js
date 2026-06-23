'use strict';

// Coach Voice Renderer — deterministic set-feedback voice (slice 1).
//
// The engine decides the coaching MEANING; the renderer words it and guards the
// generic/LLM prose from contradicting a non-neutral signal. These fixtures use
// the REAL set-effort engine (analyzeSetSequence / assessNextMoveConflict) so the
// renderer is tested against genuine engine output, not hand-built shapes. The
// inputs mirror the owner's live acceptance examples.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { analyzeSetSequence, assessNextMoveConflict, EFFORT_REASON_CODES } = require('../services/setEffortSignals');
const { renderSetVoice, findForbiddenContradictions } = require('../services/coachVoiceRenderer');

const repoRoot = path.join(__dirname, '..');

// "Bench 230 5/2 5/0 3/1" — heavy-compound redline + same-load rep drop → pressing yellow.
const benchRedline = () => analyzeSetSequence([[230, 5, 2], [230, 5, 0], [230, 3, 1]], { exerciseName: 'Bench Press' });
// "Seated Row 180 8/4 x3" — every working set 2 RIR above target → under-dosed.
const rowUnderdose = () => analyzeSetSequence([[180, 8, 4], [180, 8, 4], [180, 8, 4]], { exerciseName: 'Seated Row' });
// Warmup feeder (135×10 @ RIR5) then a clean on-target work set (225×5 @ RIR2).
const warmupClean = () => analyzeSetSequence([[135, 10, 5], [225, 5, 2]], { exerciseName: 'Bench Press' });
// "Cable Fly 30 12/0" — isolation taken to failure → caution only.
const cableFlyRIR0 = () => analyzeSetSequence([[30, 12, 0]], { exerciseName: 'Cable Fly' });
// "Incline DB Press 70 8/2 x3" — exactly on target.
const inclineOnTarget = () => analyzeSetSequence([[70, 8, 2], [70, 8, 2], [70, 8, 2]], { exerciseName: 'Incline DB Press' });

const ADD_WEIGHT = /add\s+(more\s+)?(weight|load)|more\s+weight|go\s+heavier|earn(s)?\s+more\s+weight/i;
const HYPE = /keep\s+pushing|push\s+harder|on\s+track|crushed|nailed it|great (job|set)/i;

// 1 — a redline + rep drop must never be dressed up as a progression win.
test('redline_rep_drop_does_not_get_progression_hype', () => {
  const v = renderSetVoice({ analysis: benchRedline() });
  assert.equal(v.severity, 'block');
  assert.equal(v.suppress_generic_prose, true, 'a block owns the reaction — generic prose is suppressed');
  assert.ok(v.primary_line, 'a block must produce a deterministic line');
  assert.doesNotMatch(v.primary_line, HYPE, 'the deterministic line must not hype the redline');
  assert.match(v.primary_line, /pressing is yellow|hold/i, 'it must read as a hold, not a win');
});

// 2 — the block line (and the guard) must forbid "add weight" language.
test('redline_blocks_add_weight_language', () => {
  const v = renderSetVoice({ analysis: benchRedline() });
  assert.doesNotMatch(v.primary_line, ADD_WEIGHT, 'a held redline never says add weight');
  // The contradiction guard catches add-weight prose against the redline codes.
  const hits = findForbiddenContradictions(v.reason_codes, 'Strong set — add more weight next time.');
  assert.ok(hits.length > 0, 'guard must flag add-weight prose over a redline');
  assert.ok(hits.some(h => /add/i.test(h.phrase)));
});

// 3 — a high-RIR working set is called out as under-dosed.
test('high_rir_workset_gets_underdose_callout', () => {
  const v = renderSetVoice({ analysis: rowUnderdose() });
  assert.equal(v.severity, 'bump');
  assert.equal(v.suppress_generic_prose, true);
  assert.match(v.primary_line, /too much left in the tank|bump/i);
  assert.ok(v.reason_codes.includes('high_rir_workset_underdosed'));
});

// 4 — a warmup/feeder set is NEVER scolded as sandbagging.
test('warmup_high_rir_gets_no_sandbag_callout', () => {
  const a = warmupClean();
  assert.ok(a.reason_codes.includes('warmup_feeder_ignored'));
  // With no positive verdict, the renderer says nothing about the warmup (no callout).
  const v = renderSetVoice({ analysis: a });
  assert.equal(v.primary_line, null, 'an ignored warmup produces no effort callout');
  assert.equal(v.severity, 'neutral');
  // And the guard catches any sandbag prose aimed at the warmup.
  const hits = findForbiddenContradictions(a.reason_codes, 'You sandbagged that — too easy.');
  assert.ok(hits.length > 0, 'guard must flag sandbag prose over a warmup');
});

// 5 — isolation RIR 0 is caution-only, never heavy-compound block language.
test('isolation_rir0_is_caution_only', () => {
  const v = renderSetVoice({ analysis: cableFlyRIR0() });
  assert.equal(v.severity, 'caution');
  assert.notEqual(v.severity, 'block');
  assert.match(v.primary_line, /isolation/i);
  assert.doesNotMatch(v.primary_line, /does not earn more weight|pressing is yellow|ceiling today|hold the load/i,
    'isolation caution must not borrow heavy-compound block language');
});

// 6 — pressing-yellow reroute is a suggestion only; it never mutates the plan.
test('pressing_yellow_reroute_is_suggestion_only', () => {
  const a = benchRedline();
  const queue = Object.freeze(['Overhead Press', 'Seated Row']); // frozen → a mutation would throw
  const conflict = assessNextMoveConflict(a, queue);
  const v = renderSetVoice({ analysis: a, conflict });
  assert.ok(v.secondary_line, 'a reroute suggestion must be present');
  assert.match(v.secondary_line, /Seated Row/, 'it suggests the pull first');
  assert.match(v.secondary_line, /lighter or skip it|optional/i, 'the press is deferred, not dropped');
  assert.deepEqual(queue, ['Overhead Press', 'Seated Row'], 'the plan queue is never reordered/mutated');
});

// 7 — on-target effort praises the CORRECT effort, not the suffering.
test('on_target_effort_gets_correct_effort_praise', () => {
  const v = renderSetVoice({ analysis: inclineOnTarget(), recVerdict: { level: 'on_target' } });
  assert.equal(v.severity, 'on_target');
  assert.match(v.primary_line, /on target|dial+ed in/i);
  assert.doesNotMatch(v.primary_line, /grind|failure|to the well|crushed|survive/i,
    'praise correct effort, never suffering');
  assert.equal(v.suppress_generic_prose, false, 'with no negative signal the LLM may still add tone');
});

// 8 — plan-complete voice is short and closeout-focused (no recap / next-up).
test('plan_complete_voice_is_short_and_closeout_focused', () => {
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const block = cc.slice(cc.indexOf('class = \'session-closeout\''), cc.indexOf('class = \'next-exercise-handoff\''));
  // It must read as a closeout with a save cue, not a session summary.
  assert.match(cc, /Plan complete\. Say "done"/, 'a short plan-complete line must exist');
  assert.match(cc, /complete\. Say "done" or take a screenshot to save/, 'closeout offers the save cue');
  // The closeout branch must not build a per-set or full-session recap.
  assert.doesNotMatch(block, /sessionLog\b/, 'closeout must not enumerate the whole session');
});

// 9 — deterministic voice suppresses contradictory generic/LLM prose.
test('deterministic_voice_suppresses_contradictory_llm_prose', () => {
  const bad = "That was a tough session. Keep pushing this weight, you're right on track.";
  const v = renderSetVoice({ analysis: benchRedline(), candidateProse: bad });
  assert.equal(v.suppress_generic_prose, true, 'a non-neutral signal suppresses the prose');
  assert.ok(v.contradictions.length > 0, 'the contradictions are surfaced for the boundary to act on');
  assert.ok(v.contradictions.some(c => /keep pushing/i.test(c.phrase)));
  assert.ok(v.contradictions.some(c => /on track/i.test(c.phrase)));
  // The voice that wins is the deterministic one, not the contradictory prose.
  assert.doesNotMatch(v.primary_line, /keep pushing|on track/i);
});

// 10 — a single set never triggers a full-session recap.
test('no_full_session_recap_after_single_set', () => {
  const v = renderSetVoice({ analysis: benchRedline() });
  assert.ok(!/\n/.test(v.primary_line), 'the reaction is one line, not a multi-paragraph recap');
  const sentences = v.primary_line.split(/[.!?]+/).filter(s => s.trim().length);
  assert.ok(sentences.length <= 3, `terse reaction (<=3 short sentences), got ${sentences.length}`);
  // It speaks about THIS lift only — it does not enumerate other planned exercises.
  assert.doesNotMatch(v.primary_line, /Seated Row|Lat Pulldown|Overhead Press/);
});

// 11b — the guard fires for EACH reason code on its own (no co-occurrence cover).
// Binds to the engine's frozen map, so a rename in setEffortSignals can't quietly
// disable a check and slip past the fixtures (where the pressing/rep-drop codes
// only ever appear alongside redline_set).
test('contradiction guard fires per reason code, bound to the engine map', () => {
  const cases = [
    [EFFORT_REASON_CODES.REDLINE_SET, 'add more weight next time'],
    [EFFORT_REASON_CODES.REP_DROP_AFTER_REDLINE, "keep pushing, you're on track"],
    [EFFORT_REASON_CODES.PRESSING_READINESS_YELLOW, 'go heavier next set'],
    [EFFORT_REASON_CODES.HIGH_RIR_WORKSET_UNDERDOSED, 'perfect, right on target'],
    [EFFORT_REASON_CODES.WARMUP_FEEDER_IGNORED, 'you sandbagged that, too easy'],
  ];
  for (const [code, prose] of cases) {
    const hits = findForbiddenContradictions([code], prose);
    assert.ok(hits.length > 0, `guard must fire for ${code} in isolation`);
    assert.ok(hits.every(h => h.code === code), `every hit must attribute to ${code}`);
  }
  // A clean, non-contradictory line trips nothing even with a live code present.
  assert.deepEqual(
    findForbiddenContradictions([EFFORT_REASON_CODES.REDLINE_SET], 'Hold the load and clean up reps.'),
    []
  );
});

// 12 — the renderer is pure: no write path, parser, schema, or I/O.
test('coach voice renderer stays pure (no write path / parser / schema / IO)', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'services', 'coachVoiceRenderer.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]\.\/sheets/, 'must not touch the sheets client');
  assert.doesNotMatch(src, /require\(['"]\.\/services\/workoutTextParser|workoutTextParser/, 'must not touch the parser');
  assert.doesNotMatch(src, /appendRows|getSheetRows|Log_Cleaned|fetch\(/, 'no writes / reads / network');
  // It only depends on the deterministic copy layer.
  assert.match(src, /require\(['"]\.\/setEffortCopy['"]\)/);
});
