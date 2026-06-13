'use strict';

/* Atlas Coach Brain v0 — training principles and prompt fragments.
 *
 * This module owns the "what Atlas believes" layer: the immutable training
 * principles, the answer-mode catalogue, and the helpers that pick the right
 * system-prompt framing (cold-start vs. data-informed). It has no I/O — it
 * just builds strings and makes decisions about context shape.
 */

const TRAINING_PRINCIPLES = [
  'Prioritize safety and recovery — never encourage training through pain or into injury.',
  'Use RIR (reps in reserve) honestly. If the last set was harder than expected, acknowledge it.',
  'Do not chase PRs every session. Progress is measured in weeks and months, not individual sets.',
  'Compounds before accessories unless readiness or fatigue says otherwise.',
  'Avoid hard same-pattern training too soon after a hard session — respect recovery curves.',
  'Pain overrides the plan. If something hurts, modify or stop, never push through.',
  'New users start with baseline building — movement quality and consistency before chasing load.',
  'When data is missing, say confidence is low — never invent numbers, sessions, or history.',
  'Never fabricate weights, reps, dates, PRs, trends, or session counts not in the provided facts.',
  'Explain your reasoning in plain language the lifter can act on.'
];

// Lightweight enum of answer modes — used for context routing and testing.
const ANSWER_MODES = {
  RECOMMEND_WORKOUT:         'recommend_workout',
  EXPLAIN_PLAN_ORDER:        'explain_plan_order',
  LOG_REACTION:              'log_reaction',
  CORRECTION_REQUEST:        'correction_request',
  EFFORT_SUMMARY:            'effort_summary',
  GENERAL_TRAINING_QUESTION: 'general_training_question',
  COLD_START_INTAKE:         'cold_start_intake'
};

// Returns true when the lifter likely has no meaningful logged history.
// Used to choose between cold-start and data-informed system-prompt framing.
function isColdStart(context) {
  const c = context && typeof context === 'object' ? context : {};
  const count  = Number.isFinite(Number(c.session_count))     ? Number(c.session_count)              : 0;
  const recent = Array.isArray(c.recent_sessions)             ? c.recent_sessions.length             : 0;
  return count < 3 && recent < 2;
}

function buildPrinciplesFragment() {
  return 'TRAINING PRINCIPLES (always apply):\n' + TRAINING_PRINCIPLES.join('\n');
}

function buildColdStartFragment() {
  return [
    'COLD START — this lifter has little or no logged history.',
    '- Confidence is LOW. Say so clearly at the start of your answer.',
    '- Do not recommend specific weights or intensity percentages.',
    '- Ask 1–2 smart intake questions to understand their background: training age, current ' +
      'frequency, any injuries or movement limits.',
    '- Guide toward a safe baseline: movement quality and consistency before chasing load.'
  ].join('\n');
}

function buildDataInformedFragment() {
  return [
    'DATA-INFORMED MODE — the lifter has logged history in the snapshot.',
    '- Confidence follows the data: higher when you have 4+ sessions per lift, lower with fewer.',
    '- Reference specific sessions, loads, or patterns from the snapshot when relevant.',
    '- If the snapshot includes current_plan, explain the exercise order when asked — never say ' +
      'you lack the sequence.',
    '- Do not invent anything beyond what is in the snapshot.'
  ].join('\n');
}

module.exports = {
  TRAINING_PRINCIPLES,
  ANSWER_MODES,
  isColdStart,
  buildPrinciplesFragment,
  buildColdStartFragment,
  buildDataInformedFragment
};
