'use strict';

// ---------------------------------------------------------------------------
// Workout-GENERATION routing (2026-07-22 production failure).
//
// PROVEN production failure: "Plan me a workout but have it start with back squats."
//   → went through the free-form /api/coach/chat lane, which had the model write a
//     LOCAL pseudo-plan (incomplete prescriptions, no plan_version, no canonical lift
//     codes) that the client wrongly treated as an active plan.
//
// The fix ROUTES generation requests, at the ONE composer lane, into the AUTHORITATIVE
// recommendation pipeline (Coach's Pick → GET /api/plan/intent-recommendation) instead
// of the chat pseudo-plan path. These tests drive the REAL functions sliced from the
// built bundle:
//   • looksLikeSessionRequest (app.js) — the composer gate that catches generation and
//     returns via openCoachPickInThread BEFORE the chat lane can run.
//   • buildIntentRecommendationQuery (coach-conversation.js) — turns the extracted
//     constraints into authoritative-pipeline query params.
// plus a source-introspection proof of the composer ordering (generation is handled and
// RETURNS before /api/coach/chat) and that the authoritative target never builds an
// active plan from a model list.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const ccSrc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
const { applyFirstExercise } = require('../services/planFirstExercise');

let sessionQuestion;
let planAcceptance;
let looksLikeSessionRequest;
let buildIntentRecommendationQuery;
let guardGenerationChatResult;
let normalizePlanExercise;

// The exact three athlete messages telemetry classified generate_workout on deployed
// commit 9f72ee5, which the browser classifier missed because "work out" was two words.
const PROD_GEN = [
  { message: 'Plan me a work out but have it start with bench press', firstExercise: 'bench press' },
  { message: 'Plan me a work out but have it start with squats', firstExercise: 'squats' },
  { message: 'Plan me a work out but have it start with lat pull', firstExercise: 'lat pull' },
];

function slice(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  const end = src.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start !== -1 && end !== -1 && end > start, `must locate ${JSON.stringify(startNeedle)}`);
  return src.slice(start, end);
}

test.before(async () => {
  sessionQuestion = await import('../src/app/sessionQuestion.js');
  planAcceptance = await import('../src/app/planAcceptance.js');

  const lsr = slice(appSrc, 'function looksLikeSessionRequest(', 'function looksLikeArtifactRequest(');
  assert.match(lsr, /sessionQuestion\.isWorkoutGenerationRequest\(t\)/,
    'looksLikeSessionRequest must consult the generation classifier');
  looksLikeSessionRequest = new Function('sessionQuestion', `${lsr}\n return looksLikeSessionRequest;`)(sessionQuestion);

  const biq = slice(ccSrc, 'function buildIntentRecommendationQuery(', 'async function typeSuggestedWorkout(');
  buildIntentRecommendationQuery = new Function(`${biq}\n return buildIntentRecommendationQuery;`)();

  // The chat-lane fail-closed guard (defense in depth) sliced from the built bundle.
  const ggr = slice(ccSrc, 'const GENERATION_CHAT_FAILSAFE_MESSAGE', 'async function handleChatMessage(');
  assert.match(ggr, /sessionQuestion\.isWorkoutGenerationRequest\(text\)/,
    'the chat guard must consult the generation classifier');
  guardGenerationChatResult = new Function('sessionQuestion', `${ggr}\n return guardGenerationChatResult;`)(sessionQuestion);

  // The exact plan-exercise normalizer the acceptance wiring (acceptDisplayedPlan) uses,
  // so the order-divergence proof runs the REAL 1:1 map, not a hand-rolled twin.
  const npe = slice(appSrc, 'function normalizePlanExercise(', '/* ===== Active planned session');
  normalizePlanExercise = new Function(`${npe}\n return normalizePlanExercise;`)();
});

// --- The composer gate catches generation requests (→ authoritative lane) ------------

test('looksLikeSessionRequest flags workout-generation requests (routes them to the authoritative pick, not chat)', () => {
  const generation = [
    'Plan me a workout but have it start with back squats.',
    'Plan me a workout.',
    'Build me a pull workout.',
    'What should I train today?',
  ];
  for (const g of generation) {
    assert.equal(looksLikeSessionRequest(g), true, `generation must be caught by the composer gate: ${JSON.stringify(g)}`);
  }
});

test('looksLikeSessionRequest still leaves education / dispute / modification / shorthand off the pick lane', () => {
  const notGeneration = [
    'How do I plan a workout?',        // education
    "That isn't what you planned.",    // dispute (#1126)
    'Can we change it to 3 sets of 6?',// modification (#1128) — also has a digit
    'bench 225 5/2',                   // logging shorthand
  ];
  for (const q of notGeneration) {
    assert.equal(looksLikeSessionRequest(q), false, `non-generation must stay off the pick lane: ${JSON.stringify(q)}`);
  }
});

// --- F-SB1-C: a substitute request is about ONE lift, not a whole session -------------
// Stage B workout 1 (2026-08-01), owner session FR-20260801152350-nngk9o6f. The owner
// typed "Bench press is taken at the moment, suggest a substitute workout out with reps
// and weights." The composer gate's loose phrase match — `(suggest|recommend) a <word>
// workout`, whose optional adjective slot took "substitute" — claimed it as a generation
// request, so he got today's plan read back at him ("Today, let's make it core.") and no
// substitute was ever offered. The turn never reached /api/suggest-substitute.
test('F-SB1-C: a substitute request never routes to the session-generation pick lane', () => {
  for (const q of [
    'Bench press is taken at the moment, suggest a substitute workout out with reps and weights.',
    'suggest a substitute workout',
    'recommend a substitute workout',
    'bench is taken, recommend an alternative workout',
    'suggest a replacement workout',
    'recommend a workout instead of bench',
  ]) {
    assert.equal(looksLikeSessionRequest(q), false,
      `a swap request must stay off the pick lane: ${JSON.stringify(q)}`);
  }
});

// The guard is narrow: an EXPLICIT generation request still wins, because the generation
// classifier runs first and stays authoritative.
test('F-SB1-C: the guard does not cost the generation lane its own phrases', () => {
  for (const g of [
    'Plan me a workout.',
    'Build me a pull workout.',
    'suggest a push workout',
    'recommend a session',
  ]) {
    assert.equal(looksLikeSessionRequest(g), true, `still generation: ${JSON.stringify(g)}`);
  }
});

// --- The extracted constraints become authoritative-pipeline query params ------------

test('buildIntentRecommendationQuery encodes the requested first exercise and focus', () => {
  assert.equal(
    buildIntentRecommendationQuery({ firstExercise: 'back squats', focus: 'pull' }),
    '?firstExercise=back%20squats&focus=pull');
  assert.equal(buildIntentRecommendationQuery({ firstExercise: 'back squats' }), '?firstExercise=back%20squats');
  assert.equal(buildIntentRecommendationQuery({ focus: 'upper_body' }), '?focus=upper_body');
});

test('buildIntentRecommendationQuery is empty (plain recommendation) with no constraints or a non-object (e.g. a click Event)', () => {
  assert.equal(buildIntentRecommendationQuery({}), '');
  assert.equal(buildIntentRecommendationQuery(undefined), '');
  assert.equal(buildIntentRecommendationQuery(null), '');
  // A DOM click Event carries no firstExercise/focus string props → no params.
  assert.equal(buildIntentRecommendationQuery({ type: 'click', target: {} }), '');
});

test('end-to-end constraint threading: the production phrase yields the Back-Squat-first query', () => {
  const phrase = 'Plan me a workout but have it start with back squats.';
  assert.equal(looksLikeSessionRequest(phrase), true);
  const constraints = sessionQuestion.extractGenerationConstraints(phrase);
  assert.deepEqual(constraints, { firstExercise: 'back squats' });
  assert.equal(buildIntentRecommendationQuery(constraints), '?firstExercise=back%20squats');
});

// --- The composer routes generation BEFORE the chat pseudo-plan lane (ordering) -------

test('the composer submit handler handles a generation request and RETURNS before the chat lane', () => {
  const submitStart = appSrc.indexOf("getElementById('logger-form').addEventListener('submit'");
  assert.notEqual(submitStart, -1, 'must locate the composer submit handler');
  const handler = appSrc.slice(submitStart, submitStart + 8000);

  const genIdx = handler.indexOf('looksLikeSessionRequest(workoutTextInput.value)');
  assert.notEqual(genIdx, -1, 'the handler must gate on looksLikeSessionRequest');

  // The generation branch extracts constraints, opens the authoritative pick, and returns.
  const branch = handler.slice(genIdx, genIdx + 600);
  assert.match(branch, /extractGenerationConstraints\(workoutTextInput\.value\)/,
    'the generation branch must extract the structured constraints');
  assert.match(branch, /openCoachPickInThread\(genConstraints\)/,
    'the generation branch must open the AUTHORITATIVE in-thread pick');
  assert.match(branch, /\breturn\b/, 'the generation branch must RETURN (never fall through to the chat lane)');

  // Ordering: the generation gate precedes any /api/coach/chat handling in the handler.
  const chatIdx = handler.indexOf('/api/coach/chat');
  if (chatIdx !== -1) {
    assert.ok(genIdx < chatIdx, 'the generation gate must run BEFORE the chat pseudo-plan lane');
  }
});

// --- The authoritative target never builds an active plan from a model list ----------

test('typeSuggestedWorkout fetches the authoritative recommendation (never propose_plan_edit / setActivePlannedSession from a model list)', () => {
  const fn = slice(ccSrc, 'async function typeSuggestedWorkout(', '/* ===== Coaching voice');
  assert.match(fn, /api\('\/api\/plan\/intent-recommendation' \+ buildIntentRecommendationQuery\(constraints\)\)/,
    'typeSuggestedWorkout must read the authoritative pipeline with the constraint query');
  // The pseudo-plan mechanism (a model propose_plan_edit becoming active state) must NOT
  // live in the generation target.
  assert.doesNotMatch(fn, /propose_plan_edit/, 'the authoritative pick must not consume a model plan edit');
  assert.doesNotMatch(fn, /setActivePlannedSession/, 'the authoritative pick must not materialize an active plan from prose');
  // The authoritative target reaches NONE of the bad-route endpoints from the production trace.
  for (const bad of ['/api/coach/ask', '/api/coach/chat', '/api/parse-workout-text', '/api/log-modality']) {
    assert.ok(!fn.includes(bad), `the authoritative pick must not call ${bad}`);
  }
});

// ===========================================================================
// The exact three production messages (deployed 9f72ee5). Each must route DIRECTLY to
// the authoritative recommendation pipeline (/api/plan/intent-recommendation), carry the
// requested first exercise, and NEVER touch the bad route the trace showed
// (/api/parse-workout-text → /api/log-modality 422 → /api/coach/ask → /api/coach/chat).
// ===========================================================================

test('each two-word "work out" production message is caught by the composer gate (authoritative lane, not chat)', () => {
  for (const { message } of PROD_GEN) {
    assert.equal(looksLikeSessionRequest(message), true,
      `production message must reach the authoritative pick, not the chat lane: ${JSON.stringify(message)}`);
  }
});

test('each production message threads its requested first exercise into the authoritative query', () => {
  for (const { message, firstExercise } of PROD_GEN) {
    const constraints = sessionQuestion.extractGenerationConstraints(message);
    assert.equal(constraints.firstExercise, firstExercise,
      `requested first exercise must be preserved: ${JSON.stringify(message)}`);
    const query = buildIntentRecommendationQuery(constraints);
    assert.ok(query.startsWith(`?firstExercise=${encodeURIComponent(firstExercise)}`),
      `authoritative query must lead with the requested first exercise: ${query}`);
  }
});

test('the composer submit handler routes each production message to the pick and RETURNS before any other lane', () => {
  const submitStart = appSrc.indexOf("getElementById('logger-form').addEventListener('submit'");
  assert.notEqual(submitStart, -1, 'must locate the composer submit handler');
  const handler = appSrc.slice(submitStart, submitStart + 8000);

  const genIdx = handler.indexOf('looksLikeSessionRequest(workoutTextInput.value)');
  assert.notEqual(genIdx, -1, 'the handler must gate on looksLikeSessionRequest');
  const branch = handler.slice(genIdx, genIdx + 600);
  assert.match(branch, /openCoachPickInThread\(genConstraints\)/, 'generation opens the authoritative in-thread pick');
  assert.match(branch, /\breturn\b/, 'generation RETURNS before the parse/modality/coach lanes below it can run');

  // The composer gate delegates to isWorkoutGenerationRequest, and each production
  // message satisfies it — so the return above is taken and the downstream
  // parse-workout-text / log-modality / coach lanes are never reached for these inputs.
  for (const { message } of PROD_GEN) {
    assert.equal(looksLikeSessionRequest(message), true, `gate must claim: ${JSON.stringify(message)}`);
  }
});

// ===========================================================================
// Defense in depth (requirement 5): a generation-shaped request that slips past the
// composer routing into the free-form chat lane must FAIL CLOSED — never materialize a
// local active plan (activePlannedSession / plan_order / remaining lifts) from a model
// propose_plan_edit — and instead answer with a retryable planner message.
// ===========================================================================

test('guardGenerationChatResult strips a model plan edit for a generation request and returns a retryable planner line', () => {
  const modelResult = {
    message: "Here's your workout: Lat Pulldown, Bench Press, ...",
    propose_plan_edit: { action: 'replace_plan', exercises: [{ exercise: 'Lat Pulldown' }, { exercise: 'Bench Press' }] },
    propose_edit: null,
    propose_note: null,
  };
  for (const { message } of PROD_GEN) {
    const guarded = guardGenerationChatResult(message, modelResult);
    assert.equal(guarded.propose_plan_edit, null,
      `no active plan may be materialized from chat prose: ${JSON.stringify(message)}`);
    assert.ok(guarded.message && /plan|session/i.test(guarded.message),
      'the fail-closed reply is a retryable planner message');
    assert.notEqual(guarded.message, modelResult.message, 'the model pseudo-plan prose is discarded');
  }
});

test('guardGenerationChatResult leaves NON-generation chat untouched (dispute / modification / education keep their propose_plan_edit)', () => {
  const edit = { action: 'add_exercises', exercises: [{ exercise: 'Incline Bench' }] };
  const nonGeneration = [
    'Switch to Front Squat.',            // plan modification (#1128) — proposal → approve flow
    "That isn't what you planned.",      // plan dispute (#1126)
    'What is a good workout split?',     // education
  ];
  for (const message of nonGeneration) {
    const result = { message: 'ok', propose_plan_edit: edit, propose_edit: null, propose_note: null };
    const guarded = guardGenerationChatResult(message, result);
    assert.deepEqual(guarded.propose_plan_edit, edit,
      `non-generation chat must keep its plan edit: ${JSON.stringify(message)}`);
    assert.equal(guarded.message, 'ok', 'non-generation reply is unchanged');
  }
});

test('guardGenerationChatResult is a no-op when there is no plan edit to strip', () => {
  const result = { message: 'sure', propose_plan_edit: null, propose_edit: null, propose_note: null };
  assert.equal(guardGenerationChatResult('Plan me a work out', result), result, 'no plan edit → return the result untouched');
});

// ===========================================================================
// Requirement 8: visible plan order and internal plan_order cannot diverge for a
// requested first exercise. The production trace showed Lat Pulldown first in plan_order
// while the visible prose led with Bench Press. The authoritative path reorders ONE
// array (applyFirstExercise); the visible render AND the acceptance boundary
// (buildAcceptedItems) both derive from that single array, position-for-position.
// ===========================================================================

test('a requested first exercise leads BOTH the visible plan and the internal plan_order (no divergence is representable)', () => {
  // Production shape: the engine's recommended intent initially leads with Lat Pulldown,
  // but the athlete asked to START WITH Bench Press.
  const result = {
    intents: [{
      recommended: true,
      exercises: [
        { exercise: 'Lat Pulldown', lift_code: 'LAT01' },
        { exercise: 'Bench Press', lift_code: 'BEN01' },
        { exercise: 'Barbell Row', lift_code: 'ROW01' },
      ],
    }],
  };
  applyFirstExercise(result, { name: 'Bench Press', code: 'BEN01', target: { weight: 225, reps: 5, sets: 3, rir: 2 } });
  const rec = result.intents[0];

  // VISIBLE order — the array appendWorkoutPlan renders — now leads with Bench Press.
  assert.equal(rec.exercises[0].exercise, 'Bench Press', 'the visible plan leads with the requested lift');

  // INTERNAL plan_order — the acceptance boundary — is built from the SAME array via the
  // REAL normalizer the acceptance wiring uses. planned_order i+1 ↔ visible index i.
  const displayed = rec.exercises.map(normalizePlanExercise); // exactly acceptDisplayedPlan's map
  let n = 0;
  const built = planAcceptance.buildAcceptedItems(displayed, () => `pi_${++n}`);
  assert.equal(built.ok, true, 'every displayed exercise resolves a canonical lift code');

  // The requested lift is BOTH visible index 0 and planned_order 1 — the same single row.
  assert.equal(built.items[0].planned_order, 1);
  assert.equal(built.items[0].planned_lift_code, 'BEN01', 'plan_order[0] is the requested first exercise');

  // For EVERY position, the internal plan_order row is the identical visible row — the two
  // orders are one array, so a Lat-Pulldown-first plan_order with a Bench-first visible
  // prose (the production divergence) cannot be produced by this path.
  built.items.forEach((item, i) => {
    assert.equal(item.planned_order, i + 1, 'planned_order is strictly the visible array position');
    assert.equal(item.planned_lift_code, displayed[i].liftCode, `plan_order[${i}] == visible row ${i}`);
  });
});
