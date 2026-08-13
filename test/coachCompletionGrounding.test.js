'use strict';

// ---------------------------------------------------------------------------
// Completed-work grounding — Soul Corpus V2 Session 12.
//
// Conducting the fifteen-session Soul Corpus through the real browser client produced two
// fabrications on one session:
//
//   1. After the athlete's goodbye ("Ok. That's... actually the first workout plan that
//      doesn't stress me out. Later.") Atlas replied
//        "Overhead Press: 0 x 8 @ RIR 2, 0 x 8 @ RIR 2, 0 x 8 @ RIR 2. Romanian Deadlift:
//         0 x 10 @ RIR 2 … Plank: 0 x 30 @ RIR 0 … You have completed the workout."
//      Three prescribed-but-never-performed slots were rendered as actual sets at zero
//      load, and the workout was declared complete while `plan_state.isComplete` was false.
//
//   2. One turn earlier, "You've logged 3 sessions so far" — three EXERCISES in ONE
//      session converted into three HISTORICAL sessions, while the engine's
//      `session_count` was 0.
//
// The deterministic verdicts were present and forwarded the whole time (`plan_state`,
// `session_tally`, `session_count`), and the prompt already carried COMPLETION-CLAIM and
// PLANNED-VS-DONE rules. Prompt rules are not enforcement: nothing REJECTED the prose.
// The live claim-validation seam at routes/coachOps.js covered plan MUTATION only.
//
// Part A — the detector and its state-awareness (the authority boundary, pure).
// Part B — the PRODUCTION /api/coach/chat route: a model that fabricates completion is
//          overridden by the engine's own logged-vs-remaining statement.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');

const grounding = require('../services/coachResponseGrounding');

// The exact S12 state: three of six slots genuinely logged, three still outstanding,
// and no historical sessions on the sheet.
function s12Context() {
  return {
    plan_state: {
      planned: ['Barbell Squat', 'Barbell Bench Press', 'Barbell Row', 'Overhead Press', 'Romanian Deadlift', 'Plank'],
      completed: ['Barbell Squat', 'Barbell Bench Press', 'Barbell Row'],
      remaining: ['Overhead Press', 'Romanian Deadlift', 'Plank'],
      isComplete: false,
    },
    session_tally: {
      exercises: [
        { exercise: 'Barbell Squat', sets: 3, per_set: [{ weight: 45, reps: 8, rir: 2 }] },
        { exercise: 'Barbell Bench Press', sets: 3, per_set: [{ weight: 45, reps: 8, rir: 2 }] },
        { exercise: 'Barbell Row', sets: 3, per_set: [{ weight: 45, reps: 8, rir: 2 }] },
      ],
      total_working_sets: 9,
    },
    session_count: 0,
  };
}

// ── Part A — the authority boundary ────────────────────────────────────────

test('A1. PROOF 3 — the verbatim S12 fabrication is rejected (zero-load sets + completion)', () => {
  const reply = 'Overhead Press: 0 x 8 @ RIR 2, 0 x 8 @ RIR 2, 0 x 8 @ RIR 2. Romanian Deadlift: 0 x 10 @ RIR 2, 0 x 10 @ RIR 2, 0 x 10 @ RIR 2. Plank: 0 x 30 @ RIR 0, 0 x 30 @ RIR 0, 0 x 30 @ RIR 0. You have completed the workout.';
  const found = grounding.detectUngroundedCompletionClaim(reply, s12Context());
  assert.ok(found.length > 0, 'must be rejected');
  const kinds = new Set(found.map((f) => f.kind));
  assert.ok(kinds.has('fabricated_sets'), 'zero-load actual sets must be flagged');
  assert.ok(kinds.has('workout_completion'), 'the completion claim must be flagged');
});

test('A2. PROOF 6 — an exercise count can never become a historical session count', () => {
  const ctx = s12Context();
  for (const claim of ["You've logged 3 sessions so far.", 'You have completed 3 workouts.', '3 sessions so far.']) {
    const found = grounding.detectUngroundedCompletionClaim(claim, ctx);
    assert.ok(found.some((f) => f.kind === 'session_count'), `must flag: ${claim}`);
  }
  // The engine's own number is sayable.
  assert.equal(grounding.detectUngroundedCompletionClaim('You have logged 0 sessions so far.', ctx).length, 0);
});

test('A3. PROOF 6 — fail closed: a session count with no engine count is ungrounded', () => {
  const ctx = s12Context();
  delete ctx.session_count;
  const found = grounding.detectUngroundedCompletionClaim("You've logged 3 sessions so far.", ctx);
  assert.ok(found.some((f) => f.kind === 'session_count'), 'missing proof is a failure, not permission to guess');
});

test('A4. PROOF 1 — goodbye language does not complete remaining exercises', () => {
  const ctx = s12Context();
  for (const claim of [
    'You have completed the workout.',
    "That's the workout done.",
    'The session is complete.',
    "You're all done for today.",
    'Workout complete.',
    'You completed Overhead Press, Romanian Deadlift and Plank.',
  ]) {
    assert.ok(grounding.detectUngroundedCompletionClaim(claim, ctx).length > 0, `must flag: ${claim}`);
  }
});

test('A5. PROOF 2 — remaining slots stay remaining: honest framings pass unchanged', () => {
  const ctx = s12Context();
  for (const ok of [
    'The plan still shows Overhead Press, Romanian Deadlift, and Plank remaining.',
    'Overhead Press, Romanian Deadlift and Plank are still to come.',
    'Still remaining: Overhead Press 3 sets of 8 reps.',
    'Next up is Overhead Press, 3 sets of 8 at RIR 2 planned.',
  ]) {
    assert.equal(grounding.detectUngroundedCompletionClaim(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

test('A5b. prescription prose about a remaining slot is never an actual-work claim', () => {
  const ctx = s12Context();
  // Caught in review by test/coachChatGrounding.test.js: an earlier draft keyed on set
  // NUMERALS, which rejected truthful planning prose. Numbers describe a prescription at
  // least as often as a performance, so only an explicit completed-work assertion counts.
  for (const ok of [
    'The plan calls for 200 for 10 reps at 1 RIR on Overhead Press to increase volume on a lift that has stalled.',
    'Overhead Press: 3 sets of 8 at RIR 2 — that is the target.',
    "You'll do Romanian Deadlift for 3 sets of 10.",
    'Plank is 3 sets of 30 seconds on the plan.',
  ]) {
    assert.equal(grounding.detectUngroundedCompletionClaim(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

test('A5c. an RIR figure of 0 is not a zero LOAD', () => {
  const ctx = s12Context();
  assert.equal(grounding.detectUngroundedCompletionClaim('Barbell Squat: 45 at RIR 0 x 8.', ctx).length, 0);
  // But a genuine zero-load actual set still is one.
  assert.ok(grounding.detectUngroundedCompletionClaim('Plank: 0 x 30.', ctx).length > 0);
});

test('A6. PROOF 4 — genuinely completed exercises remain intact and sayable', () => {
  const ctx = s12Context();
  for (const ok of [
    'Barbell Squat: 45 x 8 at RIR 2, three sets.',
    'You logged Barbell Squat, Barbell Bench Press and Barbell Row today.',
    'You completed Barbell Squat.',
    'Nine working sets logged this session.',
  ]) {
    assert.equal(grounding.detectUngroundedCompletionClaim(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

test('A7. PROOF 5 — completion is sayable once, and only once, the engine says so', () => {
  const ctx = s12Context();
  assert.ok(grounding.detectUngroundedCompletionClaim('You have completed the workout.', ctx).length > 0);
  const done = s12Context();
  done.plan_state.completed = done.plan_state.planned.slice();
  done.plan_state.remaining = [];
  done.plan_state.isComplete = true;
  assert.equal(grounding.detectUngroundedCompletionClaim('You have completed the workout.', done).length, 0,
    'a real completion must not be suppressed');
  assert.equal(grounding.workoutIsComplete(done), true);
  assert.equal(grounding.workoutIsComplete(ctx), false);
});

test('A8. PROOF 5 — fail closed: no authoritative session state means no completion claim', () => {
  for (const ctx of [{}, { plan_state: null }, { plan_state: { planned: [], completed: [], remaining: [], isComplete: false } }]) {
    assert.ok(grounding.detectUngroundedCompletionClaim('You have completed the workout.', ctx).length > 0,
      'absent state must not read as complete');
  }
});

test('A9. state-awareness: proposals, questions, quotations and negations are not claims', () => {
  const ctx = s12Context();
  for (const ok of [
    'Do you want me to mark the workout complete?',
    'I can mark the workout complete if you like.',
    "You said you'd completed the workout.",
    "You haven't completed the workout yet.",
    'Nothing is complete yet.',
  ]) {
    assert.equal(grounding.detectUngroundedCompletionClaim(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

test('A9b. Codex #1225 P1 — a false completion asserted in ONE clause is caught, whatever the rest of the sentence does', () => {
  const ctx = s12Context();
  // Sentence-level state-awareness was too coarse: a question mark or a modal ANYWHERE in
  // the sentence excused the asserted clause, so these reached the athlete unchanged.
  for (const claim of [
    'You completed the workout, so should we cool down?',
    'You completed the workout, so you should cool down.',
    'You have completed the workout, but let me know if you want more.',
    'You have completed the workout; I can queue up next week if you like.',
    'Nice work — you completed the workout, and I could write it up now.',
  ]) {
    assert.ok(grounding.detectUngroundedCompletionClaim(claim, ctx).length > 0, `must flag: ${claim}`);
  }
});

test('A9c. Codex #1225 P1 — clause splitting adds detections without inventing them', () => {
  const ctx = s12Context();
  for (const ok of [
    // A genuine whole-sentence proposal or negation stays safe once split.
    "You haven't completed the workout, so let's keep going.",
    'Do you want me to say you completed the workout?',
    // An ordinary list is one clause — no comma-conjunction boundary inside it.
    'Barbell Squat, Barbell Bench Press and Barbell Row are logged.',
  ]) {
    assert.equal(grounding.detectUngroundedCompletionClaim(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

test('A9d. Codex #1225 P2 — a current-session count is not judged against the HISTORICAL count', () => {
  const done = s12Context();
  done.plan_state.completed = done.plan_state.planned.slice();
  done.plan_state.remaining = [];
  done.plan_state.isComplete = true;
  // session_count counts PREVIOUSLY logged sessions and excludes the in-progress one, so
  // this truthful line must not be rejected just because it differs from that number.
  for (const ok of ['You completed 1 workout today.', "That's 1 session done today.", 'You have logged 1 workout this session.']) {
    assert.equal(grounding.detectUngroundedCompletionClaim(ok, done).length, 0, `must NOT flag: ${ok}`);
  }
  // The historical claim is still caught — it carries no current-session framing.
  assert.ok(grounding.detectUngroundedCompletionClaim("You've logged 3 sessions so far.", done).length > 0);
});

test('A10. the deterministic replacement states logged and remaining, and claims nothing', () => {
  const statement = grounding.buildGroundedSessionStateStatement(s12Context());
  assert.match(statement, /Barbell Squat/);
  assert.match(statement, /Still remaining/);
  assert.match(statement, /Overhead Press/);
  assert.doesNotMatch(statement, /completed the workout/i);
  assert.doesNotMatch(statement, /\b0\s*x\s*\d+/);
  // No authoritative state → says so rather than inventing one.
  assert.match(grounding.buildGroundedSessionStateStatement({}), /don't have an authoritative record/);
});

test('A11. remainingExerciseNames trusts the tally over a stale remaining list', () => {
  const ctx = s12Context();
  ctx.plan_state.remaining = ['Overhead Press', 'Romanian Deadlift', 'Plank', 'Barbell Row'];
  const remaining = grounding.remainingExerciseNames(ctx);
  assert.ok(!remaining.includes('Barbell Row'), 'a logged lift is never reported as remaining');
  assert.deepEqual(remaining, ['Overhead Press', 'Romanian Deadlift', 'Plank']);
});

// ── Part B — the production route ──────────────────────────────────────────

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;

const writeAttempts = [];
const fakeSheets = {
  validateConfig: () => {},
  // PROOF 10 — a read-only coach turn that reaches a write is a test failure, not a pass.
  appendRows: async (tab, rows) => { writeAttempts.push({ tab, rows }); throw new Error('no writes on the coach chat path'); },
  deleteRowsByRange: async () => { throw new Error('no deletes'); },
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
require.cache[require.resolve('../sheets')] = { id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets };
require.cache[require.resolve('../services/vision')] = { id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) } };

// The model is the adversary here: it returns exactly what S12 produced.
const coachState = { reply: null };
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => true,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateCoachMessage: async () => null,
    generatePlanMessage: async () => null,
    generateChatReply: async () => ({ reply: coachState.reply }),
    findRegisterViolations: () => [],
    looksLikePrClaim: () => false,
    sanitizeFacts: (f) => f,
    sanitizeChatContext: (c) => c,
  },
};

const originalConsoleLog = console.log;
// The exercise catalog reads Supabase (OWNER CORRECTION 2026-08-13). Stubbed here so
// the suite never opens a database connection; it delegates to the sheets fixture above.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
const { app } = require('../index');
let server; let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  try { if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))); }
  finally { console.log = originalConsoleLog; }
});

const S12_PLAN = [
  { name: 'Barbell Squat', sets: 3, reps: 8, rir: 2 },
  { name: 'Barbell Bench Press', sets: 3, reps: 8, rir: 2 },
  { name: 'Barbell Row', sets: 3, reps: 8, rir: 2 },
  { name: 'Overhead Press', sets: 3, reps: 8, rir: 2 },
  { name: 'Romanian Deadlift', sets: 3, reps: 10, rir: 2 },
  { name: 'Plank', sets: 3, reps: 30, rir: 0 },
];

async function chat(message, reply) {
  coachState.reply = reply;
  writeAttempts.length = 0;
  const res = await fetch(`${baseUrl}/api/coach/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': 'test-api-key', 'x-atlas-request-origin': 'probe' },
    body: JSON.stringify({
      message,
      context: {
        current_plan: S12_PLAN,
        plan_completed: ['Barbell Squat', 'Barbell Bench Press', 'Barbell Row'],
        plan_state: {
          planned: S12_PLAN.map((e) => e.name),
          completed: ['Barbell Squat', 'Barbell Bench Press', 'Barbell Row'],
          remaining: ['Overhead Press', 'Romanian Deadlift', 'Plank'],
          isComplete: false,
        },
        session_tally: {
          exercises: [
            { exercise: 'Barbell Squat', sets: 3, per_set: [{ weight: 45, reps: 8, rir: 2 }], planned: true },
            { exercise: 'Barbell Bench Press', sets: 3, per_set: [{ weight: 45, reps: 8, rir: 2 }], planned: true },
            { exercise: 'Barbell Row', sets: 3, per_set: [{ weight: 45, reps: 8, rir: 2 }], planned: true },
          ],
          total_working_sets: 9,
        },
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, data: body && body.data ? body.data : {} };
}

test('B1. PROOF 7/8 — the S12 goodbye turn: the model cannot override deterministic completion', async () => {
  const fabricated = 'Overhead Press: 0 x 8 @ RIR 2, 0 x 8 @ RIR 2, 0 x 8 @ RIR 2. Romanian Deadlift: 0 x 10 @ RIR 2, 0 x 10 @ RIR 2, 0 x 10 @ RIR 2. Plank: 0 x 30 @ RIR 0, 0 x 30 @ RIR 0, 0 x 30 @ RIR 0. You have completed the workout.';
  const { status, data } = await chat("Ok. That's... actually the first workout plan that doesn't stress me out. Later.", fabricated);
  assert.equal(status, 200);
  // PROOF 3 — no fabricated zero-load actual set reaches visible output.
  assert.doesNotMatch(String(data.message || ''), /\b0\s*(?:x|×)\s*\d+/);
  // PROOF 5/7 — completion is not declared.
  assert.doesNotMatch(String(data.message || ''), /completed the workout/i);
  // The engine, not the model, owns the replacement.
  assert.equal(data.source, 'engine');
  // PROOF 2 — remaining slots are still reported as remaining.
  assert.match(String(data.message || ''), /Still remaining/);
  assert.match(String(data.message || ''), /Overhead Press/);
  // PROOF 4 — genuinely completed work survives.
  assert.match(String(data.message || ''), /Barbell Squat/);
  // A turn that fabricates completed work carries no trustworthy proposal.
  assert.equal(data.propose_edit, null);
  assert.equal(data.propose_plan_edit, null);
  // PROOF 10 — no Sheet write was attempted.
  assert.equal(writeAttempts.length, 0);
});

test('B2. PROOF 6 — the exercise-count-as-session-count claim is replaced on the live route', async () => {
  const { status, data } = await chat("Should I just say I'll come Thursday? I hate saying it and then not.", "You've logged 3 sessions so far. Keep the streak going.");
  assert.equal(status, 200);
  assert.doesNotMatch(String(data.message || ''), /3 sessions/i);
  assert.equal(data.source, 'engine');
  assert.equal(writeAttempts.length, 0);
});

test('B3. PROOF 4 — a grounded reply is passed through untouched', async () => {
  const honest = 'Squat, Bench Press and Row are logged — nine working sets. Overhead Press, Romanian Deadlift and Plank are still remaining.';
  const { status, data } = await chat('Where am I at?', honest);
  assert.equal(status, 200);
  assert.equal(data.message, honest, 'an honest reply must not be rewritten');
  assert.equal(data.source, 'gemini');
  assert.equal(writeAttempts.length, 0);
});

test('B4. the mutation backstop still runs — this PR adds a lane, it does not replace one', async () => {
  const { status, data } = await chat('Change bench to 3x8', 'The plan was updated. It now calls for 3 sets of 8.');
  assert.equal(status, 200);
  assert.equal(data.source, 'engine');
  assert.doesNotMatch(String(data.message || ''), /was updated/i);
  assert.equal(writeAttempts.length, 0);
});
