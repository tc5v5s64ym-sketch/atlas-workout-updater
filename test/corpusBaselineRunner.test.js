'use strict';

// Corpus Baseline Runner — proof through the real seam (Atlas Recovery Campaign, Phase 3
// owner side-instrument). Asserts the invariants the instrument must never break:
//   • it replays all fifteen sessions against the REAL read-only coach code;
//   • it NEVER attempts a Sheets write (segregation / absolute data safety);
//   • every turn observation is tagged corpus-synthetic;
//   • it never contaminates the real [coach-turn-shadow] / divergence stream;
//   • the scoreboard is deterministic (run twice → identical scores);
//   • the scorer is HONEST — it can and does emit 'absent' (no false green), and it can
//     move a capability up when the real signal is present (not hardcoded to 'absent').
//
// Requiring the runner FIRST installs its require-cache stubs (sheets/vision/coach) before
// index.js loads — the same discipline as test/soulGoldenTranscripts.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

// Order matters: the runner injects the sheets/vision/coach stubs at require time.
const runner = require('../scripts/corpus-baseline-runner');
const {
  scoreCorpus, buildDetectors, deriveTurnObservation,
  CORPUS_SYNTHETIC_TAG, formatScoreboardMarkdown,
} = require('../services/corpusBaseline');
const { CAPABILITIES } = require('../services/corpusBaselineRubric');
const { SESSIONS } = require('../test/fixtures/corpusBaseline/sessions');
const coachTurnPacketShadow = require('../services/coachTurnPacketShadow');

const LEVELS = new Set(['pass', 'partial', 'absent']);

test('the corpus rubric is the synthesis\'s 35-capability matrix', () => {
  assert.equal(CAPABILITIES.length, 35, 'exactly 35 capabilities');
  assert.equal(SESSIONS.length, 15, 'exactly 15 sessions');
  // Every capability names the phase/BACKLOG that builds it when absent.
  for (const c of CAPABILITIES) {
    assert.ok(typeof c.builds === 'string' && c.builds.length > 0, `#${c.num} names its building phase`);
    assert.ok(Array.isArray(c.sessions) && c.sessions.length > 0, `#${c.num} lists demonstrating sessions`);
  }
});

test('replay runs against the real code and scores a well-formed, honest baseline', async () => {
  const result = await runner.run();
  assert.equal(result.total_sessions, 15, '15 sessions replayed');
  assert.equal(result.total_capabilities, 35, '35 capabilities scored');
  const cc = result.capability_counts;
  assert.equal(cc.pass + cc.partial + cc.absent, 35, 'every capability has exactly one status');
  for (const c of result.capabilities) assert.ok(LEVELS.has(c.status), `#${c.num} has a valid status`);

  // HONESTY: a low, absent-heavy baseline (no false green). Most capabilities live in
  // later phases, so the current read-only code cannot demonstrate them.
  assert.ok(cc.absent >= 20, `an honest low baseline: ${cc.absent} absent (>= 20 expected pre-Phase-4)`);
  assert.ok(cc.pass + cc.partial <= 15, 'few capabilities are present in the read-only code today');

  // The one capability Phase 1 actually built (the receipt died) must not be absent.
  const brevity = result.capabilities.find((c) => c.num === 32);
  assert.notEqual(brevity.status, 'absent', '#32 deliberate brevity/silence is present (Phase 1)');
});

test('the replay NEVER attempts a Sheets write (segregation + absolute data safety)', async () => {
  runner._sheetState.appendCalls.length = 0;
  await runner.replayAll();
  assert.equal(runner._sheetState.appendCalls.length, 0, 'no appendRows call during a read-only replay');
});

test('every turn observation is tagged corpus-synthetic', async () => {
  const observationsBySession = await runner.replayAll();
  let turns = 0;
  for (const id of Object.keys(observationsBySession)) {
    for (const o of observationsBySession[id]) {
      turns += 1;
      assert.equal(o.corpus_synthetic, true, `${id} turn tagged corpus_synthetic`);
      assert.equal(o.tag, CORPUS_SYNTHETIC_TAG, `${id} turn carries the corpus-synthetic tag`);
    }
  }
  assert.ok(turns >= 30, 'a meaningful number of turns were replayed');
});

test('the real shadow / divergence stream is never contaminated by the replay', async () => {
  assert.equal(process.env.ATLAS_INTERACTION_TRACE, undefined, 'the shadow log flag is force-unset by the runner');
  coachTurnPacketShadow._resetForTesting();
  await runner.replayAll();
  // The runner assembles the packet OUT OF BAND; it must never push to the shadow log
  // (which is what the divergence tool reads).
  assert.equal(coachTurnPacketShadow.getShadowLog().length, 0, 'no [coach-turn-shadow] records emitted');
});

// REGRESSION: the runner deleted ATLAS_INTERACTION_TRACE before requiring the app, but
// index.js runs `require('dotenv').config()` during that require, which repopulated the
// variable from a local `.env`. interactionTraceShadow reads the flag PER REQUEST, so on a
// machine whose `.env` carried ATLAS_INTERACTION_TRACE=shadow the replay emitted real
// [coach-turn-shadow] records — measured at 69 for one replay — and those synthetic turns
// would then read as production divergence evidence.
//
// Setting the variable here reproduces the exact post-dotenv state: the app is already
// loaded, and the flag is on when the replay starts. The runner must still emit nothing.
test('a .env that switches the shadow flag back on cannot contaminate the replay', async () => {
  const saved = process.env.ATLAS_INTERACTION_TRACE;
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  try {
    coachTurnPacketShadow._resetForTesting();
    await runner.replayAll();
    assert.equal(coachTurnPacketShadow.getShadowLog().length, 0,
      'the replay emits no [coach-turn-shadow] records even when the flag was set after app load');
    assert.notEqual(process.env.ATLAS_INTERACTION_TRACE, 'shadow',
      'replayAll unsets the flag rather than trusting the caller');
  } finally {
    if (saved === undefined) delete process.env.ATLAS_INTERACTION_TRACE;
    else process.env.ATLAS_INTERACTION_TRACE = saved;
  }
});

// The fail-closed half: if a future change ever lets a corpus turn reach the shadow
// stream, replayAll must ABORT rather than return a clean-looking result. Proven by
// seeding the shadow log mid-replay through the same module the runner checks.
test('replayAll fails closed when the shadow log grows during a replay', async () => {
  coachTurnPacketShadow._resetForTesting();
  const real = coachTurnPacketShadow.getShadowLog;
  let calls = 0;
  // First call is the pre-replay depth (0); the post-replay call reports growth.
  coachTurnPacketShadow.getShadowLog = () => (++calls === 1 ? [] : [{ synthetic: 'contaminant' }]);
  try {
    await assert.rejects(
      () => runner.replayAll(),
      /\[coach-turn-shadow\] record\(s\) emitted during a segregated replay/,
      'a contaminated replay aborts instead of returning observations');
  } finally {
    coachTurnPacketShadow.getShadowLog = real;
    coachTurnPacketShadow._resetForTesting();
  }
});

test('the scoreboard is deterministic (run twice → identical scores)', async () => {
  const a = await runner.run();
  const b = await runner.run();
  assert.deepEqual(a.capability_counts, b.capability_counts, 'identical headline counts');
  assert.deepEqual(a.capabilities.map((c) => [c.num, c.status]), b.capabilities.map((c) => [c.num, c.status]),
    'identical per-capability scores across runs');
});

test('the scorer is honest: absent by default, but rises when the REAL signal is present', () => {
  // No observations ⇒ every capability absent (never a false green).
  const empty = scoreCorpus(SESSIONS, {});
  assert.equal(empty.capability_counts.pass, 0, 'no observations ⇒ 0 pass');
  assert.equal(empty.capability_counts.partial, 0, 'no observations ⇒ 0 partial');
  assert.equal(empty.capability_counts.absent, 35, 'no observations ⇒ all absent');

  // A synthetic silence+surface pair moves #32 to pass — proves the rubric is live, not
  // hardcoded to absent.
  const routine = deriveTurnObservation(
    { kind: 'block', facts: { todaySets: [{ weight: 100, reps: 10, rir: 3 }] } },
    { data: { note_tier: 'ack_only' } }, { valid: true, embedded: {} });
  const signal = deriveTurnObservation(
    { kind: 'block', facts: { substitution: { classification: 'substituted' }, todaySets: [{ weight: 100, reps: 8, rir: 0 }] } },
    { data: { note_tier: 'short', note_trigger: 'form_safety', message: 'careful there' } }, { valid: true, embedded: {} });
  const det = buildDetectors([routine, signal]);
  assert.equal(det.silenceOnRoutine, true, 'silence detected on the routine block');
  assert.equal(det.surfaceOnSignal, true, 'surface detected on the signal block');
  const cap32 = CAPABILITIES.find((c) => c.num === 32);
  assert.equal(cap32.score(det), 'pass', '#32 rises to pass when both halves are present');

  // A packet that embeds session truth moves session-gated capabilities off absent —
  // this is why the Phase-4 rerun will show movement without touching the rubric.
  const withSession = deriveTurnObservation(
    { kind: 'block', facts: { todaySets: [{ weight: 100, reps: 10, rir: 2 }] } },
    { data: { note_tier: 'ack_only' } }, { valid: true, embedded: { session: true, athlete_profile_goal: true } });
  const detS = buildDetectors([withSession]);
  const cap1 = CAPABILITIES.find((c) => c.num === 1);
  assert.equal(cap1.score(detS), 'partial', '#1 rises to partial once the packet carries session truth (Phase 4)');
});

test('the scoreboard markdown is generated and self-describes its segregation contract', async () => {
  const result = await runner.run();
  const md = formatScoreboardMarkdown(result, { phase: 'BASELINE (pre-Phase-4)', recorded: '2026-07-22' });
  assert.match(md, /Corpus Baseline/, 'has a title');
  assert.match(md, /corpus-synthetic/, 'documents the corpus-synthetic tag');
  assert.match(md, /never a live write/i, 'documents the no-write invariant');
  assert.match(md, /Per-capability baseline/, 'has the per-capability table');
  assert.match(md, /Per-session baseline/, 'has the per-session table');
  // Every capability row is present.
  for (const c of CAPABILITIES) assert.ok(md.includes(c.name), `row for #${c.num} ${c.name}`);
});
