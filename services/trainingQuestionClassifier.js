'use strict';

/**
 * Deterministic training-question classifier.
 *
 * Decides how much depth a user message wants from the SME layer, so Atlas stays quiet and
 * practical during logging and only goes deeper when explicitly asked. No LLM, no I/O.
 *
 * Depth levels:
 *   log_only        - workout logging / no education wanted
 *   coach_brief     - a short practical answer
 *   explain         - a "why" / practical explanation
 *   compare_options - compare two or more options
 *   teach_me        - teach from the ground up
 *   deep_dive       - go deep on a topic
 */

const RESPONSE_DEPTHS = Object.freeze([
  'log_only',
  'coach_brief',
  'explain',
  'compare_options',
  'teach_me',
  'deep_dive',
]);

// Looks like a logged set: "190 6/2", "bench 190 6/2", "225 5/1", "3x8", "5 x 5 @ 135", "135 lbs".
const LOGGING_PATTERNS = [
  /\b\d{1,4}\s*\/\s*\d+\b/,            // reps/rir slash notation (6/2)
  /\b\d+\s*x\s*\d+\b/,                 // sets x reps (3x8, 5 x 5)
  /\b\d{2,3}\s+\d{1,2}\s*\/\s*\d+\b/,  // weight reps/rir (190 6/2)
  /\b\d+\s*(?:lb|lbs|kg|kgs)\b/,       // explicit load unit
];

const COMPARE_CUE = /\b(vs\.?|versus|compare|comparison|difference(?:s)? between|which is better)\b/;
const TEACH_CUE = /\b(teach me|walk me through|show me how|how do i learn)\b/;
const DEEP_CUE = /\b(go deep|deep[-\s]?dive|in[-\s]?depth|full breakdown|everything about)\b/;
const EXPLAIN_CUE = /\b(why|explain|what is|what are|what does|what'?s the point|how does|how do|meaning|means)\b/;
const QUESTION_CUE = /\?|\b(what|how|when|where|which|should i|do i|can i|is it|are there|tell me)\b/;

function isLoggingShaped(text) {
  return LOGGING_PATTERNS.some((re) => re.test(text));
}

function selectResponseDepth(text) {
  const t = (typeof text === 'string' ? text : '').toLowerCase().trim();
  if (!t) return 'log_only';

  const compare = COMPARE_CUE.test(t);
  const teach = TEACH_CUE.test(t);
  const deep = DEEP_CUE.test(t);
  const explain = EXPLAIN_CUE.test(t);
  const question = QUESTION_CUE.test(t);

  // Logging entries stay quiet unless they also carry an explicit question/education cue.
  if (isLoggingShaped(t) && !compare && !teach && !deep && !explain && !question) {
    return 'log_only';
  }

  if (compare) return 'compare_options';
  if (teach) return 'teach_me';
  if (deep) return 'deep_dive';
  if (explain) return 'explain';
  if (question) return 'coach_brief';

  // A plain statement that is not a question and not education → stay quiet.
  return 'log_only';
}

/**
 * Richer classification result (depth + the cues that fired), for callers that want detail.
 */
function classifyTrainingQuestion(text) {
  const t = (typeof text === 'string' ? text : '').toLowerCase().trim();
  return {
    depth: selectResponseDepth(t),
    isLoggingShaped: isLoggingShaped(t),
    wantsEducation: ['explain', 'compare_options', 'teach_me', 'deep_dive'].includes(selectResponseDepth(t)),
  };
}

module.exports = {
  RESPONSE_DEPTHS,
  selectResponseDepth,
  classifyTrainingQuestion,
  isLoggingShaped,
};
