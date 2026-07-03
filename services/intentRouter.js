'use strict';

// Intent Router — Phase C1 of the Composer-First Migration (owner-approved
// 2026-07-03: "rip through guarded items", input-LLM decision adopted:
// Gemini 2.5 Flash-Lite on the existing GEMINI_API_KEY).
//
// PURE SERVICE MODULE — NOT WIRED TO ANY ROUTE. Wiring is Phase C2, which
// attaches this in SHADOW mode behind a default-OFF env flag
// (ATLAS_INTENT_ROUTER=shadow): classify-and-log only, no behavior change.
//
// What it does: classify a fall-through composer sentence (text the
// deterministic lanes did not claim) into a validated IntentEnvelope — the
// One-Brain engine's single input contract (services/intentEnvelope.js,
// docs/COACHING_CONTRACTS_SPEC.md §1). The LLM here is an INPUT-side
// classifier only: it names the intent and extracts closed-vocabulary
// constraints. It never words coaching, never invents numbers, and nothing
// downstream executes from it in this phase.
//
// Contract: TOTAL — classifyIntent() resolves to a fully validated envelope
// or `null`. It never throws and never returns a partially valid envelope:
// no API key, timeout, network failure, non-OK response, malformed JSON,
// unknown intent type, or an illegal constraint VALUE all yield null (the
// shadow lane observes failures; it must never create them). The single
// forgiving step: unknown constraint KEYS the model hallucinates are dropped
// (recorded in extraction.dropped_keys) — the vocabulary is addition-only,
// so a stray key should not void an otherwise-correct classification.
//
// Model selection mirrors the coach voice's pattern (services/coach.js):
// GEMINI_ROUTER_MODEL env override, defaulting to gemini-2.5-flash-lite;
// the existing GEMINI_API_KEY; x-goog-api-key header; AbortController
// timeout. Classification differences: temperature 0 (deterministic),
// responseMimeType application/json (strict JSON out), small token budget,
// and a tighter default timeout — the shadow lane must stay light.

const path = require('node:path');
const fs   = require('node:fs');

const { buildIntentEnvelope, validateIntentEnvelope } = require('./intentEnvelope');

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_ROUTER_MODEL = 'gemini-2.5-flash-lite';
// Shadow-evidence tune (owner review 2026-07-03): a valid plan correction
// ("it's face pulls next not back squats") logged ok:false at ms:4004 — right at
// the old 4000ms cap — while the near-identical sibling classified fine. The
// failure was a TIMEOUT, not a misclassification. The shadow classifier runs
// fire-and-forget OFF the reply path, so a longer budget is invisible to the
// lifter; raise it to stop dropping slow-but-valid classifications.
const DEFAULT_TIMEOUT_MS = 6000;
const MAX_INPUT_CHARS = 1000;

const VOCAB_FILE = path.join(__dirname, '..', 'config', 'coaching', 'contracts', 'intent.vocabulary.json');

let _vocab = null;
function _loadVocab() {
  if (_vocab) return _vocab;
  _vocab = Object.freeze(JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8')));
  return _vocab;
}
function _resetForTesting() { _vocab = null; }

function routerModel() {
  const m = process.env.GEMINI_ROUTER_MODEL;
  return (typeof m === 'string' && m.trim()) ? m.trim() : DEFAULT_ROUTER_MODEL;
}

// One-line glosses for the closed intent vocabulary. Display-only prompt text —
// the LEGAL list is always read from the vocabulary file, so a vocabulary
// addition shows up here as an intent with a generic gloss, never an illegal
// output (the validator holds the line either way).
const INTENT_GLOSSES = {
  best_workout:           'asks what to train today / wants the recommended session',
  generate_workout:       'asks to build a session, possibly with constraints (time, focus, equipment, injury)',
  modify_workout:         "asks to change today's planned session (shorten, refocus, adjust)",
  progression_review:     'asks how a lift or their training is progressing/trending',
  explain_recommendation: 'asks WHY a recommendation or coaching call was made',
  substitute_exercise:    'asks to replace a specific exercise with something else',
  // The router NAMES a log; it does not extract set details. sets/reps/weight/rir
  // are NOT constraint-vocabulary keys — the deterministic slash-parser owns them
  // — so a model that emits them has those keys dropped+recorded (blocker 3: the
  // drop is expected, not a lost field).
  log_intent:             'states sets/work performed (normally the deterministic parser claims this — classify only; do NOT emit sets/reps/weight/rir)',
  progress_query:         'asks to see history: last session, weekly numbers, records',
  readiness_checkin:      'reports sleep/soreness/stress/energy as a readiness check-in (requires readiness_inputs)',
  ingest_signal:          'structured device/wearable signal — almost never typed chat (requires signal)',
  nutrition_query:        'asks about food, diet, protein, calories',
  onboarding_step:        'setup/preferences step (goals, schedule, equipment inventory)',
  clarify_intent:         'ambiguous or off-domain — the safe default when unsure'
};

function _constraintSpecLine(key, spec) {
  switch (spec.type) {
    case 'enum':         return `- ${key}: one of ${spec.values.join(' | ')}`;
    case 'integer':      return `- ${key}: integer ${spec.min}-${spec.max}`;
    case 'string':       return `- ${key}: string (a lift name, e.g. "Bench Press")`;
    case 'string_array': return `- ${key}: array of strings${spec.values ? ` from ${spec.values.join(' | ')}` : ''}`;
    case 'int_map':      return `- ${key}: object with integer values ${spec.min}-${spec.max} for keys ${spec.keys.join(' | ')}`;
    case 'object':       return `- ${key}: object with required "${(spec.required || []).join('", "')}"${spec.kind_values ? `; kind one of ${spec.kind_values.join(' | ')}` : ''}`;
    default:             return `- ${key}`;
  }
}

// System prompt built FROM the vocabulary file (single source of truth) — the
// legal intent list and constraint specs are enumerated, never hand-copied.
// Only the lifter's raw sentence is ever sent alongside this; no client
// objects, no training data, no secrets (same forward-only-whitelisted-fields
// rule as the coach voices).
function buildRouterSystemPrompt() {
  const vocab = _loadVocab();
  const intents = vocab.intent_types
    .map(t => `- ${t}: ${INTENT_GLOSSES[t] || 'see contract'}`)
    .join('\n');
  const constraints = Object.entries(vocab.constraint_keys)
    .map(([k, spec]) => _constraintSpecLine(k, spec))
    .join('\n');
  return [
    'You classify one gym-app user message into exactly one intent type and extract explicit constraints.',
    'You are a CLASSIFIER, not a coach: never answer the message, never give advice, never invent facts.',
    '',
    'INTENT TYPES (closed list — you MUST pick exactly one):',
    intents,
    '',
    'CONSTRAINT KEYS (closed list — include a key ONLY when the message explicitly states it):',
    constraints,
    '',
    'Rules:',
    '- Output ONLY a JSON object: {"type": "<intent>", "constraints": {...}, "confidence": <0..1>}',
    '- No prose, no markdown, no explanation.',
    '- constraints: {} when nothing is explicitly stated. NEVER guess a constraint the message does not state.',
    '- readiness_checkin requires readiness_inputs; ingest_signal requires signal — if the message does not carry them, it is NOT that intent.',
    '- When ambiguous or off-domain, use clarify_intent with lower confidence.',
    '',
    'Examples:',
    'Message: "give me a 30 minute upper body session, no barbell my shoulder is tweaked"',
    '{"type":"generate_workout","constraints":{"focus":"upper_body","duration_minutes":30,"injury":"shoulder"},"confidence":0.95}',
    'Message: "why bench again?"',
    '{"type":"explain_recommendation","constraints":{},"confidence":0.85}',
    'Message: "hows my squat coming along"',
    '{"type":"progression_review","constraints":{"target_lift":"Squat"},"confidence":0.9}',
    // A plan correction ("not Y, X instead" / "it's X next not Y") is the CLOSEST
    // fit to substitute_exercise — swap the named-out lift for the named-in one.
    // Shadow evidence: this exact phrase failed to classify (blocker 2).
    'Message: "it\'s face pulls next not back squats"',
    '{"type":"substitute_exercise","constraints":{"target_lift":"Face Pull","exclude_exercises":["Back Squat"]},"confidence":0.9}',
    'Message: "asdf lol"',
    '{"type":"clarify_intent","constraints":{},"confidence":0.3}'
  ].join('\n');
}

// Same shape as services/coach.js extractText — duplicated (not imported) so
// this module has zero coupling to the coach voice.
function extractText(data) {
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
}

// Parse the model's reply into a plain object, tolerating markdown fences and
// stray prose around one JSON object. Returns null on anything unusable.
function parseRouterJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const direct = JSON.parse(t);
    return (direct && typeof direct === 'object' && !Array.isArray(direct)) ? direct : null;
  } catch { /* fall through to brace slice */ }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try {
    const sliced = JSON.parse(t.slice(first, last + 1));
    return (sliced && typeof sliced === 'object' && !Array.isArray(sliced)) ? sliced : null;
  } catch { return null; }
}

// Classification object → validated envelope (or null). Pure; exported for
// tests so the strictness rules are pinned without a fetch stub.
function buildEnvelopeFromClassification(cls, { text, source, asOf }) {
  if (!cls || typeof cls !== 'object' || Array.isArray(cls)) return null;
  let vocab;
  try { vocab = _loadVocab(); } catch { return null; }

  if (typeof cls.type !== 'string' || !vocab.intent_types.includes(cls.type)) return null;

  // Drop hallucinated constraint KEYS (recorded); leave VALUES strict — an
  // illegal value fails validation below and the whole result is null.
  const constraints = {};
  const dropped = [];
  const raw = (cls.constraints && typeof cls.constraints === 'object' && !Array.isArray(cls.constraints)) ? cls.constraints : {};
  for (const [k, v] of Object.entries(raw)) {
    if (vocab.constraint_keys[k]) constraints[k] = v;
    else dropped.push(k);
  }

  let confidence = Number(cls.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));

  const extraction = { confidence, extractor: routerModel() };
  if (dropped.length) extraction.dropped_keys = dropped;

  const envelope = buildIntentEnvelope({
    type: cls.type,
    constraints,
    source,
    asOf,
    raw_input: text,
    extraction
  });
  const verdict = validateIntentEnvelope(envelope);
  return verdict.valid ? envelope : null;
}

/**
 * Classify one fall-through composer message into a validated IntentEnvelope.
 * TOTAL: resolves to the envelope or null — never throws, never partial.
 *
 * @param {string} text            the lifter's message (raw sentence only)
 * @param {object} [opts]
 * @param {string} [opts.source]   envelope source, default 'chat'
 * @param {string} [opts.asOf]     strict ISO-8601; defaults to now
 * @param {number} [opts.timeoutMs]
 */
async function classifyIntent(text, { source = 'chat', asOf, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message) return null;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const when = (typeof asOf === 'string' && asOf) ? asOf : new Date().toISOString();
    const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(routerModel())}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: buildRouterSystemPrompt() }] },
      contents: [{ role: 'user', parts: [{ text: `Message: ${message.slice(0, MAX_INPUT_CHARS)}` }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
        responseMimeType: 'application/json'
      }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return null;

    const data = await response.json();
    const cls = parseRouterJson(extractText(data));
    return buildEnvelopeFromClassification(cls, { text: message, source, asOf: when });
  } catch {
    return null;   // total: timeout, network, JSON, or anything unforeseen
  }
}

module.exports = {
  DEFAULT_ROUTER_MODEL,
  DEFAULT_TIMEOUT_MS,
  routerModel,
  buildRouterSystemPrompt,
  parseRouterJson,
  buildEnvelopeFromClassification,
  classifyIntent,
  _resetForTesting,
};
