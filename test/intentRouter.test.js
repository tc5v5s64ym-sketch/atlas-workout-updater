'use strict';

// Phase C1 — services/intentRouter.js. Pure module, unwired; the contract
// under test is TOTALITY (envelope or null, never a throw, never partial)
// and the strictness split: unknown constraint KEYS are dropped+recorded,
// illegal VALUES / unknown intents / any transport failure → null.

const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../services/intentRouter');
const { validateIntentEnvelope } = require('../services/intentEnvelope');

const ASOF = '2026-07-03T06:00:00Z';

function geminiReply(obj) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }]
    })
  };
}

// Swap global fetch for one test body; restores env + fetch afterwards.
async function withStub({ fetchImpl, apiKey = 'test-key', model }, fn) {
  const origFetch = global.fetch;
  const origKey = process.env.GEMINI_API_KEY;
  const origModel = process.env.GEMINI_ROUTER_MODEL;
  if (apiKey == null) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = apiKey;
  if (model == null) delete process.env.GEMINI_ROUTER_MODEL;
  else process.env.GEMINI_ROUTER_MODEL = model;
  global.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    global.fetch = origFetch;
    if (origKey == null) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = origKey;
    if (origModel == null) delete process.env.GEMINI_ROUTER_MODEL; else process.env.GEMINI_ROUTER_MODEL = origModel;
  }
}

test('router: happy path — classification becomes a fully VALID IntentEnvelope', async () => {
  let captured = null;
  const result = await withStub({
    fetchImpl: async (url, opts) => { captured = { url, opts }; return geminiReply({
      type: 'generate_workout',
      constraints: { focus: 'upper_body', duration_minutes: 30, injury: 'shoulder' },
      confidence: 0.95
    }); }
  }, () => router.classifyIntent('give me a 30 minute upper body session, shoulder is tweaked', { asOf: ASOF }));

  assert.ok(result, 'must produce an envelope');
  assert.equal(result.type, 'generate_workout');
  assert.deepEqual(result.constraints, { focus: 'upper_body', duration_minutes: 30, injury: 'shoulder' });
  assert.equal(result.source, 'chat');
  assert.equal(result.asOf, ASOF);
  assert.equal(result.raw_input, 'give me a 30 minute upper body session, shoulder is tweaked');
  assert.equal(result.extraction.confidence, 0.95);
  const verdict = validateIntentEnvelope(result);
  assert.equal(verdict.valid, true, `must pass the real validator: ${verdict.errors.join('; ')}`);

  // Request shape: model in URL, key in header, temperature 0, strict JSON mime,
  // and ONLY the message text in the user turn (no client objects forwarded).
  assert.match(captured.url, /gemini-2\.5-flash-lite:generateContent$/);
  assert.equal(captured.opts.headers['x-goog-api-key'], 'test-key');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.generationConfig.temperature, 0);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.contents.length, 1);
  assert.equal(body.contents[0].parts[0].text, 'Message: give me a 30 minute upper body session, shoulder is tweaked');
});

test('router: GEMINI_ROUTER_MODEL env overrides the default model', async () => {
  let url = null;
  await withStub({
    model: 'gemini-2.5-flash',
    fetchImpl: async (u) => { url = u; return geminiReply({ type: 'clarify_intent', constraints: {}, confidence: 0.4 }); }
  }, () => router.classifyIntent('hm', { asOf: ASOF }));
  assert.match(url, /gemini-2\.5-flash:generateContent$/);
});

test('router: no API key → null and the network is never touched', async () => {
  let called = false;
  const result = await withStub({
    apiKey: null,
    fetchImpl: async () => { called = true; return geminiReply({}); }
  }, () => router.classifyIntent('build me a session', { asOf: ASOF }));
  assert.equal(result, null);
  assert.equal(called, false);
});

test('router: blank input → null without a fetch', async () => {
  let called = false;
  const result = await withStub({
    fetchImpl: async () => { called = true; return geminiReply({}); }
  }, () => router.classifyIntent('   ', { asOf: ASOF }));
  assert.equal(result, null);
  assert.equal(called, false);
});

test('router: transport failures are swallowed to null (reject, non-OK, bad JSON body)', async () => {
  const reject = await withStub({ fetchImpl: async () => { throw new Error('ECONNRESET'); } },
    () => router.classifyIntent('why bench?', { asOf: ASOF }));
  assert.equal(reject, null);

  const nonOk = await withStub({ fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'quota' }) },
    () => router.classifyIntent('why bench?', { asOf: ASOF }));
  assert.equal(nonOk, null);

  const badBody = await withStub({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) },
    () => router.classifyIntent('why bench?', { asOf: ASOF }));
  assert.equal(badBody, null);
});

test('router: markdown-fenced JSON is tolerated', async () => {
  const result = await withStub({
    fetchImpl: async () => geminiReply('```json\n{"type":"progress_query","constraints":{},"confidence":0.8}\n```')
  }, () => router.classifyIntent('show my last session', { asOf: ASOF }));
  assert.ok(result);
  assert.equal(result.type, 'progress_query');
});

test('router: non-JSON prose reply → null', async () => {
  const result = await withStub({
    fetchImpl: async () => geminiReply('Sure! I think you want a workout today.')
  }, () => router.classifyIntent('gimme something', { asOf: ASOF }));
  assert.equal(result, null);
});

test('router: unknown intent type → null (closed vocabulary holds)', async () => {
  const result = await withStub({
    fetchImpl: async () => geminiReply({ type: 'order_pizza', constraints: {}, confidence: 0.9 })
  }, () => router.classifyIntent('feed me', { asOf: ASOF }));
  assert.equal(result, null);
});

test('router: hallucinated constraint KEY is dropped and recorded; envelope survives', async () => {
  const result = await withStub({
    fetchImpl: async () => geminiReply({
      type: 'generate_workout',
      constraints: { focus: 'push', vibe: 'aggressive' },
      confidence: 0.9
    })
  }, () => router.classifyIntent('push day please', { asOf: ASOF }));
  assert.ok(result);
  assert.deepEqual(result.constraints, { focus: 'push' });
  assert.deepEqual(result.extraction.dropped_keys, ['vibe']);
  assert.equal(validateIntentEnvelope(result).valid, true);
});

test('router: illegal constraint VALUE → null (strict — no partially valid envelope)', async () => {
  const result = await withStub({
    fetchImpl: async () => geminiReply({ type: 'generate_workout', constraints: { focus: 'arms' }, confidence: 0.9 })
  }, () => router.classifyIntent('arm day', { asOf: ASOF }));
  assert.equal(result, null);
});

test('router: signal/readiness-required intents without their payloads → null', async () => {
  const signal = await withStub({
    fetchImpl: async () => geminiReply({ type: 'ingest_signal', constraints: {}, confidence: 0.9 })
  }, () => router.classifyIntent('hrv came in', { asOf: ASOF }));
  assert.equal(signal, null);

  const readiness = await withStub({
    fetchImpl: async () => geminiReply({ type: 'readiness_checkin', constraints: {}, confidence: 0.9 })
  }, () => router.classifyIntent('feeling rough', { asOf: ASOF }));
  assert.equal(readiness, null);
});

test('router: confidence is coerced and clamped; missing defaults to 0.5', async () => {
  const high = await withStub({
    fetchImpl: async () => geminiReply({ type: 'best_workout', constraints: {}, confidence: 1.4 })
  }, () => router.classifyIntent('what should I train', { asOf: ASOF }));
  assert.equal(high.extraction.confidence, 1);

  const missing = await withStub({
    fetchImpl: async () => geminiReply({ type: 'best_workout', constraints: {} })
  }, () => router.classifyIntent('what should I train', { asOf: ASOF }));
  assert.equal(missing.extraction.confidence, 0.5);
});

test('router: timeout aborts to null', async () => {
  const result = await withStub({
    fetchImpl: (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('AbortError')));
    })
  }, () => router.classifyIntent('what should I train', { asOf: ASOF, timeoutMs: 20 }));
  assert.equal(result, null);
});

// ─── Shadow-evidence regression: three promotion blockers (owner review 2026-07-03) ───

// Blocker 2: "It's face pulls next not back squats" logged ok:false in shadow.
// The near-identical "No that was face pulls not back squats" classified fine
// (substitute_exercise 0.9), and the failing entry took ms:4004 — right at the
// old 4000ms cap. Root cause = TIMEOUT, not classification. The shadow classifier
// runs OFF the reply path (fire-and-forget), so a longer budget costs nothing
// user-facing and stops a slow-but-valid classification from being dropped.
test('router (blocker 2): the shadow classifier budget is raised past the 4s that timed out a valid classification', () => {
  assert.ok(router.DEFAULT_TIMEOUT_MS >= 6000,
    `budget must be >= 6000ms (shadow evidence: a valid correction timed out at ms:4004); got ${router.DEFAULT_TIMEOUT_MS}`);
});

// Blocker 2: a "not Y, X instead / it's X next not Y" plan correction must have an
// in-prompt exemplar so the model reliably routes it to the closest existing enum
// (substitute_exercise) with the swap constraints, rather than ambiguating.
test('router (blocker 2): the prompt teaches the plan-correction exemplar (closest enum = substitute_exercise)', () => {
  const prompt = router.buildRouterSystemPrompt();
  assert.match(prompt, /Message: "it's face pulls next not back squats"/,
    'the exact shadow-failing phrase is an in-prompt example');
  assert.match(prompt, /"type":"substitute_exercise"/, 'the exemplar routes to the closest enum');
  assert.match(prompt, /"exclude_exercises":\["Back Squat"\]/, 'the exemplar carries the swapped-out lift');
});

// Blocker 2: full-path regression — when the model returns the closest-enum
// classification for the shadow-failing phrase, it must build a VALID envelope
// (not ok:false). Pins the envelope path; the timeout fix covers the transport.
test('router (blocker 2): a "next X not Y" plan correction classifies to substitute_exercise', async () => {
  const result = await withStub({
    fetchImpl: async () => geminiReply({
      type: 'substitute_exercise',
      constraints: { target_lift: 'Face Pull', exclude_exercises: ['Back Squat'] },
      confidence: 0.9
    })
  }, () => router.classifyIntent("it's face pulls next not back squats", { asOf: ASOF }));
  assert.ok(result, 'the correction must produce an envelope, not ok:false');
  assert.equal(result.type, 'substitute_exercise');
  assert.deepEqual(result.constraints, { target_lift: 'Face Pull', exclude_exercises: ['Back Squat'] });
  assert.equal(validateIntentEnvelope(result).valid, true);
});

// Blocker 3: "Bench Press — 225 × 5 reps × 3 sets @ RIR 2" classified as
// log_intent 0.9 but dropped sets/reps/weight_kg/rir. This is EXPECTED: the
// IntentEnvelope has no set-detail constraint keys by design — the router only
// NAMES the intent; the deterministic slash-parser (services/workoutTextParser)
// owns the numbers. The hallucinated set-detail keys are correctly dropped and
// recorded, and the log_intent envelope stays valid.
test('router (blocker 3): log_intent drops set-detail keys (sets/reps/weight_kg/rir) — the parser owns numbers', async () => {
  const result = await withStub({
    fetchImpl: async () => geminiReply({
      type: 'log_intent',
      constraints: { target_lift: 'Bench Press', sets: 3, reps: 5, weight_kg: 102, rir: 2 },
      confidence: 0.9
    })
  }, () => router.classifyIntent('Bench Press — 225 × 5 reps × 3 sets @ RIR 2', { asOf: ASOF }));
  assert.ok(result);
  assert.equal(result.type, 'log_intent');
  assert.deepEqual(result.constraints, { target_lift: 'Bench Press' }, 'only vocabulary constraints survive');
  assert.deepEqual([...result.extraction.dropped_keys].sort(), ['reps', 'rir', 'sets', 'weight_kg'],
    'the set-detail keys are dropped and recorded (not silently lost)');
  assert.equal(validateIntentEnvelope(result).valid, true);
});

test('router: the system prompt is built FROM the vocabulary (all 13 intents + constraint keys enumerated)', () => {
  const vocab = require('../config/coaching/contracts/intent.vocabulary.json');
  const prompt = router.buildRouterSystemPrompt();
  for (const t of vocab.intent_types) assert.ok(prompt.includes(`- ${t}:`), `prompt must list intent '${t}'`);
  for (const k of Object.keys(vocab.constraint_keys)) assert.ok(prompt.includes(`- ${k}:`), `prompt must list constraint '${k}'`);
  assert.match(prompt, /Output ONLY a JSON object/);
  assert.match(prompt, /NEVER guess a constraint/);
});

test('router: buildEnvelopeFromClassification is pure and strict on garbage', () => {
  const ctx = { text: 'x', source: 'chat', asOf: ASOF };
  assert.equal(router.buildEnvelopeFromClassification(null, ctx), null);
  assert.equal(router.buildEnvelopeFromClassification([], ctx), null);
  assert.equal(router.buildEnvelopeFromClassification({ type: 42 }, ctx), null);
  const nonObject = router.buildEnvelopeFromClassification({ type: 'best_workout', constraints: 'nope', confidence: 0.7 }, ctx);
  assert.ok(nonObject, 'non-object constraints are treated as {} — classification survives');
  assert.deepEqual(nonObject.constraints, {});
  assert.equal(validateIntentEnvelope(nonObject).valid, true);
});
