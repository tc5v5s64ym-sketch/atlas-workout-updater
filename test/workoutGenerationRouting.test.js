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

let sessionQuestion;
let looksLikeSessionRequest;
let buildIntentRecommendationQuery;

function slice(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  const end = src.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start !== -1 && end !== -1 && end > start, `must locate ${JSON.stringify(startNeedle)}`);
  return src.slice(start, end);
}

test.before(async () => {
  sessionQuestion = await import('../src/app/sessionQuestion.js');

  const lsr = slice(appSrc, 'function looksLikeSessionRequest(', 'function looksLikeArtifactRequest(');
  assert.match(lsr, /sessionQuestion\.isWorkoutGenerationRequest\(t\)/,
    'looksLikeSessionRequest must consult the generation classifier');
  looksLikeSessionRequest = new Function('sessionQuestion', `${lsr}\n return looksLikeSessionRequest;`)(sessionQuestion);

  const biq = slice(ccSrc, 'function buildIntentRecommendationQuery(', 'async function typeSuggestedWorkout(');
  buildIntentRecommendationQuery = new Function(`${biq}\n return buildIntentRecommendationQuery;`)();
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
});
