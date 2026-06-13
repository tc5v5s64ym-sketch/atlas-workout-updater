/* Atlas coaching voice — Gemini layer.
 *
 * Atlas's engine produces the *facts* (what was logged, the last working sets,
 * the deterministic next-set recommendation). This service turns those facts
 * into the coach's *voice* via Gemini 2.5 Flash-Lite. It is the server side of
 * the frontend's getCoachingMessage() seam.
 *
 * Hard rules (enforced by the prompt + by only ever forwarding whitelisted
 * fields): the model phrases the numbers, it never invents them, and it never
 * writes anything. This module performs no Google Sheets access of any kind.
 */

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_TIMEOUT_MS = 8000;

function coachModel() {
  return process.env.GEMINI_COACH_MODEL || DEFAULT_MODEL;
}

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// The coach's voice + the guardrails. Kept as its own function so it can be
// unit-tested without a network call (mirrors services/vision.js).
function buildCoachSystemPrompt() {
  return [
    'You are Atlas, a sharp, encouraging strength coach talking to a lifter who just logged a set.',
    'You are given STRUCTURED FACTS as JSON. Write a short coaching note in a natural, conversational voice — like a knowledgeable training partner, not a report.',
    '',
    'Hard rules:',
    '- Never invent or change numbers. Use ONLY the weights, reps, and RIR present in the facts.',
    '- Do not claim a PR, stall, or fatigue state unless the facts say so.',
    '- Keep it tight: under ~120 words.',
    '- Open with one honest reaction line (e.g. acknowledge effort, a step up, or a set that hit failure).',
    '- Then list the sets you were given, one per line, in the form "* {weight} × {reps} @{rir}" (omit "@{rir}" when rir is null).',
    '- End with exactly one "Next:" line based on the provided recommendation. If no recommendation is given, give one safe, general next step.',
    '- Output plain text only. No markdown headings, no bold, no code fences.',
    '- You never write to any database or sheet; you only talk.'
  ].join('\n');
}

// Forward ONLY known fields to the model — never arbitrary client-supplied
// text. This both keeps the prompt grounded and avoids passing unexpected
// content to the LLM.
function sanitizeFacts(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const toSet = s => ({
    weight: numOrNull(s && s.weight),
    reps: numOrNull(s && s.reps),
    rir: s && s.rir == null ? null : numOrNull(s.rir)
  });
  const rec = f.rec && typeof f.rec === 'object' ? f.rec : {};
  const target = rec.next_target && typeof rec.next_target === 'object' ? rec.next_target : null;
  return {
    exercise: strOrNull(f.exerciseName) || strOrNull(rec.exercise_name) || strOrNull(f.liftCode),
    lift_code: strOrNull(f.liftCode),
    today_sets: Array.isArray(f.todaySets) ? f.todaySets.slice(0, 12).map(toSet) : [],
    last_working_sets: Array.isArray(rec.last_working_sets)
      ? rec.last_working_sets.slice(-6).map(s => ({
          weight: numOrNull(s && s.weight),
          reps: numOrNull(s && s.reps),
          rir: s && s.rir == null ? null : numOrNull(s.rir)
        }))
      : [],
    recommendation: strOrNull(rec.recommendation),
    next_target: target ? { weight: numOrNull(target.weight), reps: numOrNull(target.reps), sets: numOrNull(target.sets) } : null,
    e1rm_trend: strOrNull(rec.e1rm_trend),
    sessions_analyzed: numOrNull(rec.sessions_analyzed)
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, 80) : null;
}

function buildCoachUserPrompt(facts) {
  return `STRUCTURED FACTS:\n${JSON.stringify(sanitizeFacts(facts), null, 2)}`;
}

// ── Plan voice: "why this session, today" ─────────────────────────────────────
// Phrases the deterministic intent-recommendation reasoning as a short coaching
// line. The engine still owns the reasons/readiness/numbers; this only words them.
function buildPlanSystemPrompt() {
  return [
    'You are Atlas, a sharp strength coach. The athlete just asked what to train today.',
    "You are given STRUCTURED FACTS as JSON: today's recommended focus, the reasons behind it, current movement-pattern readiness, and supporting numbers.",
    'Write 1–3 sentences, in a natural coaching voice, explaining WHY this focus fits today.',
    '',
    'Hard rules:',
    '- Use ONLY the reasons, readiness, and numbers in the facts. Never invent data.',
    '- Do not list the exercises — the app already shows them.',
    '- Speak to the athlete ("you"). Be direct and encouraging, not a bulleted report.',
    '- Under ~70 words. Plain text only — no markdown, no bullets, no headings.',
    '- You never write to any database or sheet; you only explain.'
  ].join('\n');
}

function sanitizePlanFacts(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const valueStr = v => (v == null ? null : String(v).trim().slice(0, 40) || null);
  return {
    label: strOrNull(f.label),
    focus: strOrNull(f.focus),
    why_today: Array.isArray(f.why_today) ? f.why_today.map(strOrNull).filter(Boolean).slice(0, 4) : [],
    readiness: Array.isArray(f.readiness)
      ? f.readiness.slice(0, 6)
          .map(r => ({ pattern: strOrNull(r && r.pattern), status: strOrNull(r && r.status) }))
          .filter(r => r.pattern)
      : [],
    data_points: Array.isArray(f.data_points)
      ? f.data_points.slice(0, 4)
          .map(d => ({ label: strOrNull(d && d.label), value: valueStr(d && d.value), context: strOrNull(d && d.context) }))
          .filter(d => d.label && d.value)
      : []
  };
}

function buildPlanUserPrompt(facts) {
  return `STRUCTURED FACTS:\n${JSON.stringify(sanitizePlanFacts(facts), null, 2)}`;
}

// Single Gemini call shared by the set-coaching and plan voices. Throws when
// unconfigured, on a non-OK response, on timeout, or on empty output — the route
// turns any throw into a graceful "fall back to templated" response so the UI is
// never blocked.
async function callGemini(systemText, userText, timeoutMs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(coachModel())}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 320, topP: 0.95 }
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

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gemini request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const data = await response.json();
  const text = extractText(data);
  if (!text) throw new Error('Gemini returned no text output.');
  return text;
}

async function generateCoachMessage(facts, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return callGemini(buildCoachSystemPrompt(), buildCoachUserPrompt(facts), timeoutMs);
}

async function generatePlanMessage(facts, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return callGemini(buildPlanSystemPrompt(), buildPlanUserPrompt(facts), timeoutMs);
}

function extractText(data) {
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
}

module.exports = {
  isConfigured,
  coachModel,
  buildCoachSystemPrompt,
  buildCoachUserPrompt,
  sanitizeFacts,
  buildPlanSystemPrompt,
  buildPlanUserPrompt,
  sanitizePlanFacts,
  generateCoachMessage,
  generatePlanMessage
};
