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

const coachBrain = require('./coachBrain');

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
    '- Then show the exercise name alone on one line, followed by each set as "{weight}lbs {reps}/{rir}" on its own line (omit "/{rir}" when rir is null). Group consecutive identical sets as "{weight}lbs {reps}/{rir} x{count}" instead of repeating them. No bullet points.',
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

// Like strOrNull but with a caller-chosen length cap — for chat turns and the
// lifter's free-form message, which are longer than the short labels strOrNull
// guards.
function clampText(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
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

// Single Gemini call shared by every voice (set-coaching, plan, chat). Accepts a
// ready-made `contents` array so the chat voice can pass multi-turn history while
// the one-shot voices pass a single user turn. Throws when unconfigured, on a
// non-OK response, on timeout, or on empty output — the route turns any throw
// into a graceful "fall back to templated" response so the UI is never blocked.
async function callGeminiContents(systemText, contents, { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputTokens = 320 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(coachModel())}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens, topP: 0.95 }
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

// Single-turn convenience wrapper — preserves the original set/plan call shape.
async function callGemini(systemText, userText, timeoutMs) {
  return callGeminiContents(systemText, [{ role: 'user', parts: [{ text: userText }] }], { timeoutMs });
}

async function generateCoachMessage(facts, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return callGemini(buildCoachSystemPrompt(), buildCoachUserPrompt(facts), timeoutMs);
}

async function generatePlanMessage(facts, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return callGemini(buildPlanSystemPrompt(), buildPlanUserPrompt(facts), timeoutMs);
}

// ── Conversational chat voice ────────────────────────────────────────────────
// Free-form, two-way coaching chat. Unlike the set/plan voices, this forwards
// the lifter's OWN message to the model — so the system prompt is the guardrail:
// answer only from the read-only training snapshot, never invent numbers, and
// NEVER claim to have written, logged, changed, or deleted anything. This module
// performs no Google Sheets access; the route assembles the read-only snapshot.
//
// `context` is the sanitized snapshot (after sanitizeChatContext). It drives
// cold-start vs. data-informed framing — pass undefined for the safe default
// (cold-start, conservative).
function buildChatSystemPrompt(context) {
  const modeFragment = coachBrain.isColdStart(context || {})
    ? coachBrain.buildColdStartFragment()
    : coachBrain.buildDataInformedFragment();
  return [
    'You are Atlas, a sharp, encouraging strength coach having a conversation with the lifter.',
    "You are given a read-only TRAINING SNAPSHOT (recent sessions, movement-pattern readiness, today's recommended focus, current workout plan, and stalled lifts) as JSON, then the conversation so far. Answer the latest message in a natural, conversational coaching voice.",
    '',
    coachBrain.buildPrinciplesFragment(),
    '',
    modeFragment,
    '',
    'Hard rules:',
    '- Ground every specific in the SNAPSHOT. Never invent or change weights, reps, RIR, dates, PRs, trends, or session counts that are not in the snapshot.',
    "- If the snapshot does not contain what you need, say you don't have that data yet — never guess a number.",
    '- General training, form, and programming advice is fine, but tie any specifics back to the snapshot.',
    '- You can only TALK and SUGGEST. You never write, save, log, edit, undo, or delete anything — that is impossible for you. Never say or imply that you saved, logged, changed, or removed something.',
    '- Atlas slash notation: "Bench 225 5/2 5/2" means Bench Press, 225 lb × 5 reps at RIR 2, twice. "185 8" means 185 lb × 8 reps, no RIR given.',
    '- When the lifter sends sets in Atlas notation (e.g. "Bench 135 10/4 185 8/2 225 5/2 5/2"), acknowledge what you heard in plain language: repeat back the exercise name and each set as "{weight} × {reps} @ RIR {rir}" (omit RIR when not given), grouping identical consecutive sets. Then add a brief coaching note (1–2 sentences). This is how the lifter confirms you captured it right — keep it fast and scannable.',
    '- If they name a lift with no sets (e.g. "Bench"), ask for the sets rather than guessing.',
    '- The lifter saves the session by saying "log it" at the end — you never trigger the write. Until then, sets are in the conversation only.',
    '- When the lifter asks what to train today or what the session is: one sentence of context (why this focus), then the exercises immediately — each on its own line with the prescribed weight, reps, and sets. Never make them ask twice. Format: "Exercise — Xlbs × Y reps × Z sets @ RIR N". If the snapshot has no plan, give a reasonable suggestion from their recent history.',
    '- Keep it tight — usually 2–5 sentences. Plain text only: no markdown headings, no bold, no code fences.',
    '',
    'PROPOSING EDITS TO THE CURRENT PREVIEW:',
    '- When the lifter clearly asks to change, update, delete, or add a specific set in current_preview, you MAY propose an edit.',
    '- Only propose an edit when: (a) current_preview is non-empty, (b) the intent is unambiguous.',
    '- Put your prose reply first. Then, as the VERY LAST LINE of your response, write exactly:',
    '  PROPOSE_EDIT: {"action":"update_set","index":0,"weight":235,"reps":5,"rir":2}',
    '  or PROPOSE_EDIT: {"action":"delete_set","index":2}',
    '  or PROPOSE_EDIT: {"action":"add_set","weight":225,"reps":5,"rir":2}',
    '- index is 0-based. For update_set, omit weight/reps/rir fields you are not changing.',
    '- The PROPOSE_EDIT line is stripped by the app and never shown to the lifter — write your prose as if it does not exist.',
    '- If the intent is ambiguous or current_preview is empty, respond in prose only with no PROPOSE_EDIT line.',
    '',
    'PROPOSING A COACHING NOTE (persistent background memory):',
    '- When the lifter reveals something durable and actionable — an injury, a mobility limit, a goal, a program change, an equipment constraint — you MAY propose saving it as a coaching note.',
    '- Only propose a note for facts worth persisting across sessions. Session observations ("great set today") do not qualify.',
    '- You can only ever propose ONE thing per reply — either a PROPOSE_EDIT or a PROPOSE_NOTE, never both.',
    '- Put your prose reply first. Then, as the VERY LAST LINE of your response, write exactly:',
    '  PROPOSE_NOTE: {"note": "..."}',
    '- The note text must be concise (under 120 characters), factual, and third-person ("Left shoulder impingement — avoid overhead pressing"). No coaching advice in the note text itself.',
    '- The PROPOSE_NOTE line is stripped by the app and shown to the lifter as "Save this note?". Write your prose as if it does not exist.',
    '- If nothing worth persisting came up, respond in prose only with no PROPOSE_NOTE line.'
  ].join('\n');
}

// Extract an optional PROPOSE_EDIT: {...} from the last non-blank line of a
// Gemini reply. Returns { reply: proseText, propose_edit: objectOrNull }.
// Malformed JSON or an unrecognised schema → propose_edit is null.
function parseEditFromReply(text) {
  if (typeof text !== 'string') return { reply: '', propose_edit: null };
  const lines = text.split('\n');
  // Walk backwards, skip blank lines, inspect the first non-empty line from end.
  let editLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('PROPOSE_EDIT:')) editLineIdx = i;
    break; // stop after finding the first non-blank line from the end
  }
  if (editLineIdx === -1) return { reply: text.trim(), propose_edit: null };
  const jsonPart = lines[editLineIdx].trim().slice('PROPOSE_EDIT:'.length).trim();
  const prose = lines.slice(0, editLineIdx).join('\n').trim();
  let propose_edit = null;
  try {
    const parsed = JSON.parse(jsonPart);
    if (isValidEditSchema(parsed)) propose_edit = parsed;
  } catch { /* malformed JSON — no edit */ }
  return { reply: prose || text.trim(), propose_edit };
}

// Structural schema check only — bounds are validated by the client against
// the visible rows so the server never needs to know row count.
function isValidEditSchema(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const { action } = obj;
  if (action === 'update_set' || action === 'delete_set') {
    return Number.isInteger(obj.index) && obj.index >= 0;
  }
  return action === 'add_set';
}

// Forward ONLY a known, bounded snapshot — never arbitrary client object keys.
function sanitizeChatContext(context) {
  const c = context && typeof context === 'object' ? context : {};
  const recent_sessions = Array.isArray(c.recent_sessions) ? c.recent_sessions.slice(0, 6).map(s => ({
    date: strOrNull(s && s.date),
    exercises: Array.isArray(s && s.exercises) ? s.exercises.slice(0, 12).map(strOrNull).filter(Boolean) : [],
    sets: numOrNull(s && s.sets),
    volume: numOrNull(s && s.volume)
  })) : [];
  const readiness = Array.isArray(c.readiness) ? c.readiness.slice(0, 8).map(r => ({
    pattern: strOrNull(r && r.pattern),
    status: strOrNull(r && r.status),
    detail: strOrNull(r && r.detail)
  })).filter(r => r.pattern) : [];
  const stalls = Array.isArray(c.stalls) ? c.stalls.slice(0, 8).map(s => ({
    exercise: strOrNull(s && s.exercise),
    weight: numOrNull(s && s.weight),
    sessions_stalled: numOrNull(s && s.sessions_stalled)
  })).filter(s => s.exercise) : [];
  const current_preview = Array.isArray(c.current_preview) ? c.current_preview.slice(0, 16).map(s => ({
    exercise: strOrNull(s && s.exercise),
    weight: numOrNull(s && s.weight),
    reps: numOrNull(s && s.reps),
    rir: s && s.rir == null ? null : numOrNull(s.rir)
  })).filter(s => s.exercise) : [];
  const current_plan = Array.isArray(c.current_plan) ? c.current_plan.slice(0, 10).map(e => ({
    name: strOrNull(e && e.name),
    rationale: strOrNull(e && e.rationale),
    weight: numOrNull(e && e.weight),
    reps: numOrNull(e && e.reps),
    sets: numOrNull(e && e.sets)
  })).filter(e => e.name) : [];
  const session_count = numOrNull(c.session_count);
  const coaching_notes = Array.isArray(c.coaching_notes)
    ? c.coaching_notes.slice(0, 10).map(n => ({
        date: strOrNull(n && n.date),
        note: clampText(n && n.note, 200)
      })).filter(n => n.note)
    : [];
  return {
    recommended_label: strOrNull(c.recommended_label),
    recommended_focus: strOrNull(c.recommended_focus),
    readiness,
    recent_sessions,
    stalls,
    current_preview,
    current_plan,
    session_count,
    coaching_notes
  };
}

// Extract an optional PROPOSE_NOTE: {...} from the last non-blank line.
// Returns { reply: proseText, propose_note: objectOrNull }.
function parseNoteFromReply(text) {
  if (typeof text !== 'string') return { reply: '', propose_note: null };
  const lines = text.split('\n');
  let noteLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('PROPOSE_NOTE:')) noteLineIdx = i;
    break;
  }
  if (noteLineIdx === -1) return { reply: text.trim(), propose_note: null };
  const jsonPart = lines[noteLineIdx].trim().slice('PROPOSE_NOTE:'.length).trim();
  const prose = lines.slice(0, noteLineIdx).join('\n').trim();
  let propose_note = null;
  try {
    const parsed = JSON.parse(jsonPart);
    if (parsed && typeof parsed === 'object' && typeof parsed.note === 'string' && parsed.note.trim()) {
      propose_note = { note: parsed.note.trim().slice(0, 200) };
    }
  } catch { /* malformed JSON — no note */ }
  return { reply: prose || text.trim(), propose_note };
}

// Internal parser that handles both PROPOSE_EDIT and PROPOSE_NOTE in one pass —
// the last non-blank line can carry at most one token per reply.
function parseReplyWithProposals(text) {
  if (typeof text !== 'string') return { reply: '', propose_edit: null, propose_note: null };
  const lines = text.split('\n');
  let tokenLineIdx = -1;
  let tokenType = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('PROPOSE_EDIT:')) { tokenLineIdx = i; tokenType = 'edit'; }
    else if (trimmed.startsWith('PROPOSE_NOTE:')) { tokenLineIdx = i; tokenType = 'note'; }
    break;
  }
  if (tokenLineIdx === -1) return { reply: text.trim(), propose_edit: null, propose_note: null };
  const prefix = tokenType === 'edit' ? 'PROPOSE_EDIT:' : 'PROPOSE_NOTE:';
  const jsonPart = lines[tokenLineIdx].trim().slice(prefix.length).trim();
  const prose = lines.slice(0, tokenLineIdx).join('\n').trim();
  let propose_edit = null;
  let propose_note = null;
  try {
    const parsed = JSON.parse(jsonPart);
    if (tokenType === 'edit' && isValidEditSchema(parsed)) propose_edit = parsed;
    else if (tokenType === 'note' && parsed && typeof parsed === 'object' && typeof parsed.note === 'string' && parsed.note.trim()) {
      propose_note = { note: parsed.note.trim().slice(0, 200) };
    }
  } catch { /* malformed JSON — no proposal */ }
  return { reply: prose || text.trim(), propose_edit, propose_note };
}

// Bound the conversation to the last few turns; only role + text survive. The
// caller passes PRIOR turns here and the current message separately.
function sanitizeChatHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-8).map(turn => {
    const role = (turn && turn.role === 'atlas') ? 'model' : 'user';
    const text = clampText(turn && turn.text, 2000);
    return text ? { role, text } : null;
  }).filter(Boolean);
}

async function generateChatReply({ message, context, history } = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const userMessage = clampText(message, 2000);
  if (!userMessage) throw new Error('chat message is required');

  const snapshot = sanitizeChatContext(context);
  const turns = sanitizeChatHistory(history);

  // Prime with the snapshot as the first exchange so the model treats it as
  // grounding, then replay prior turns, then the lifter's current message.
  // coaching_notes arrive already inside `snapshot` (via sanitizeChatContext);
  // they are included here without any extra instruction so the model treats them
  // as silent background — not something to announce or repeat.
  const contents = [
    { role: 'user', parts: [{ text: `TRAINING SNAPSHOT (read-only facts):\n${JSON.stringify(snapshot, null, 2)}` }] },
    { role: 'model', parts: [{ text: "Got it — I'll answer from these facts, use any coaching notes as silent background only, and never claim to save anything." }] }
  ];
  for (const t of turns) contents.push({ role: t.role, parts: [{ text: t.text }] });
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  const raw = await callGeminiContents(buildChatSystemPrompt(snapshot), contents, { timeoutMs, maxOutputTokens: 450 });
  return parseReplyWithProposals(raw);
}

function extractText(data) {
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
}

// ── Session compilation: extract logged sets from conversation ────────────────
// When the lifter says "log it" at the end of a conversational session, this
// asks Gemini to extract all the workout sets they actually did — ignoring
// Atlas's own suggestions and any sets discussed but not performed.
function buildCompileSystemPrompt() {
  return [
    'You are Atlas, a workout logging assistant.',
    'You are given a conversation between a lifter and Atlas (their coach).',
    'Your job: extract ONLY the workout sets the lifter ACTUALLY LOGGED OR PERFORMED during this session.',
    '',
    'Output format — Atlas slash notation, one exercise per line:',
    '  Bench Press 135 10 185 8/2 225 6/1',
    '  Deadlift 135 10/4 185 10/2 225 8/2 245 6/2',
    '',
    'Set notation: {exercise} {weight} {reps}/{rir}',
    '  - weight is in lbs (numbers only, no units in output)',
    '  - reps is number of reps',
    '  - rir is reps in reserve — omit the /rir if not mentioned',
    '  - Chain multiple sets for the same exercise on one line',
    '',
    'Rules:',
    '- ONLY include sets the lifter did. Ignore Atlas\'s recommendations, plans, and suggestions.',
    '- If the lifter corrected a number ("actually that was 8 not 10"), use the corrected value.',
    '- Preserve the order exercises were performed.',
    '- Use the canonical exercise name when obvious (e.g. "bench" → "Bench Press"), or the lifter\'s exact phrasing otherwise.',
    '- If no workout sets are found in the conversation, output exactly: NO_WORKOUT_FOUND',
    '- Output ONLY the workout lines. No prose, no explanations, no headings, no commentary.'
  ].join('\n');
}

async function compileSessionFromHistory(turns, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Array.isArray(turns) || !turns.length) return { workout_text: null };

  const sanitized = turns
    .filter(t => t && (t.role === 'user' || t.role === 'atlas'))
    .slice(-40)
    .map(t => {
      const role = t.role === 'atlas' ? 'Atlas' : 'Lifter';
      const text = clampText(t.text, 800);
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean);

  if (!sanitized.length) return { workout_text: null };

  const userPrompt = `CONVERSATION:\n${sanitized.join('\n')}\n\nExtract the workout sets.`;
  const raw = await callGemini(buildCompileSystemPrompt(), userPrompt, timeoutMs);
  const result = raw.trim();
  if (!result || result === 'NO_WORKOUT_FOUND') return { workout_text: null };
  return { workout_text: result };
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
  generatePlanMessage,
  buildChatSystemPrompt,
  sanitizeChatContext,
  sanitizeChatHistory,
  generateChatReply,
  parseEditFromReply,
  parseNoteFromReply,
  isValidEditSchema,
  buildCompileSystemPrompt,
  compileSessionFromHistory
};
