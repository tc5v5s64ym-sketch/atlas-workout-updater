'use strict';

/**
 * Detect that a chat message EXPLICITLY NAMES an exercise the parser cannot resolve.
 *
 * The defect this closes (owner gym session 2026-07-31): Atlas recommended Good Morning,
 * the athlete asked "how much for good morning?", the parser's deliberately narrow alias
 * table did not recognize the name, and `sessionQuestionAnswer.resolveLiftName` fell
 * through to the previous turn's lift and answered with the DEADLIFT load. Chest Fly has
 * the same exposure. An unresolvable name must never inherit another lift's numbers —
 * an explicitly named lift that cannot be resolved has to FAIL CLOSED and ask.
 *
 * The hard part is telling "how much for good morning?" (an exercise reference) apart from
 * "how much?" / "and reps?" / "how much for the last set?" (ordinary contextual shorthand,
 * which must keep using the active referent) and from "good morning, how much for bench?"
 * (a GREETING plus a real, resolvable reference). Three signals decide it:
 *
 *   1. GREETING POSITION. A message-initial salutation is not an exercise reference, so a
 *      leading "good morning"/"morning"/"hey" is removed before anything else. Only the
 *      leading occurrence — "how much for good morning?" keeps its reference.
 *   2. RESIDUE. Attribute tokens and contentless scaffolding are stripped, the same
 *      technique `sessionQuestionAnswer.prescriptionResidueIsEmpty` already uses. Pure
 *      shorthand leaves NOTHING, so it can never be read as naming an exercise.
 *   3. MOVEMENT VOCABULARY. What survives counts as an exercise name only when one of its
 *      words is a movement word — the head nouns of the real exercise catalogues
 *      (data/exercise_aliases.v1.json and data/parser_aliases.v1.json), derived at load
 *      time rather than hand-listed, so the vocabulary grows with the catalogue.
 *
 * Requiring POSITIVE evidence (a movement word) rather than "something unrecognized
 * survived" is what keeps ordinary conversation out: "how much for the last set?",
 * "what weight for warmup?", and "how much water?" carry no movement word and are left
 * alone. The trade is stated honestly: a genuinely unknown name with no movement word in
 * it ("how much for zerchers?") is NOT detected here and keeps the old behavior.
 *
 * READ-ONLY and pure: no Sheets, no LLM, no writes, no parser-grammar change. It resolves
 * nothing — it only reports that a name was used which the parser cannot resolve, so the
 * caller can decline instead of guessing.
 */

const PARSER_ALIASES = require('../data/parser_aliases.v1.json');
const KB_ALIASES = require('../data/exercise_aliases.v1.json');

// Words that end an exercise name in the catalogues but are ordinary English on their own
// ("up", "down", "over", "class", "body", "hold"). They are dropped from the vocabulary
// because a single one of them inside a question is not evidence that a lift was named.
// Dropping a word only ever makes this detector NARROWER — it can add a missed detection,
// never a false one.
const GENERIC_HEADS = new Set([
  'up', 'ups', 'down', 'over', 'overs', 'under', 'unders', 'through', 'throughs', 'apart',
  'aparts', 'hold', 'holds', 'place', 'role', 'switch', 'body', 'bodyweight', 'bar', 'bars',
  'ball', 'balls', 'class', 'machine', 'machines', 'negative', 'negatives', 'drop', 'kick',
  'kicks', 'drive', 'drill', 'pose', 'stone', 'stones', 'seated', 'standing', 'overhead',
  'eccentric', 'mobility', 'rehab', 'release', 'activation', 'stretch', 'stretches', 'strech',
  'steps', 'shots', 'waves', 'laps', 'b', 'j', 'lift', 'lifts', 'knee', 'knees', 'shoulder',
  'ankle', 'calves', 'triceps', 'delts', 'abductors', 'adductors', 'hip', 'sit', 'sits',
  'roll', 'rolling', 'roller', 'rope', 'ropes', 'roping', 'slide', 'slides', 'trainer',
]);

// Only word-shaped tokens join the vocabulary. Three letters is the floor because real
// movement words live there ("row", "fly", "dip"); catalogue shorthand like "bp", "dl",
// or "gm" is shorter and would otherwise match a stray two-letter token in ordinary prose.
function isVocabularyWord(token) {
  return /^[a-z]{3,}$/.test(token) && !GENERIC_HEADS.has(token);
}

function headOf(phrase) {
  const words = String(phrase == null ? '' : phrase)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length ? words[words.length - 1] : '';
}

/**
 * The movement vocabulary: the head word of every catalogue alias and canonical name.
 * Built once from the shipped data files, so a new exercise in either catalogue extends
 * it automatically. "good morning" contributes "morning"; "chest fly" contributes "fly";
 * "barbell rows" contributes "rows".
 */
function buildMovementVocabulary() {
  const vocabulary = new Set();
  const add = (phrase) => {
    const head = headOf(phrase);
    if (isVocabularyWord(head)) vocabulary.add(head);
  };

  for (const entry of Array.isArray(KB_ALIASES) ? KB_ALIASES : []) {
    if (entry && entry.alias) add(entry.alias);
    if (entry && entry.exercise_id) add(String(entry.exercise_id).replace(/_/g, ' '));
  }
  for (const [canonicalName, names] of (PARSER_ALIASES && PARSER_ALIASES.exercise_aliases) || []) {
    add(canonicalName);
    for (const alias of names || []) add(alias);
  }
  // The parser's ambiguous entries ("row", "rows") are names too — they are exactly the
  // case where a name IS recognized but resolves to no single lift.
  for (const ambiguous of Object.keys((PARSER_ALIASES && PARSER_ALIASES.ambiguous_aliases) || {})) {
    add(ambiguous);
  }
  return vocabulary;
}

const MOVEMENT_VOCABULARY = buildMovementVocabulary();

// A message-initial salutation. "Good morning, how much for bench?" greets; it does not
// ask about the Good Morning. Anchored to the START only, and only the singular greeting
// forms — "good mornings" is the exercise, never a greeting.
const GREETING_RE = /^\s*(?:good\s+(?:morning|afternoon|evening)|morning|afternoon|evening|hey+|hi|hello|yo|sup|howdy|whats\s+up)\b[\s,.!?;:—-]*/i;

// Attribute phrases (multi-word before their parts), then contentless scaffolding. Both
// mirror the residue strip already proven in sessionQuestionAnswer for the bare
// prescription lane; the scaffold list additionally carries the session nouns that show up
// in a shorthand follow-up ("the last set", "next one", "warmup", "today").
const ATTR_STRIP_RE = /\b(?:how\s+much(?:\s+weight)?|how\s+many\s+(?:reps?|sets?)|how\s+heavy|how\s+light|reps?\s+in\s+reserve|rir|rpe|reps?|sets?|weight|load)\b/gi;
const SCAFFOLD_RE = /\b(?:what|whats|which|how|is|are|was|were|am|do|does|did|should|shall|will|would|can|could|be|being|gonna|wanna|supposed|to|too|i|im|me|my|mine|you|your|we|our|us|the|a|an|this|that|these|those|it|its|for|of|on|at|in|with|and|or|plus|then|so|but|currently|current|right|now|today|tonight|tomorrow|next|last|first|second|third|final|more|less|again|please|tell|give|remind|here|there|doing|done|use|using|need|want|got|get|go|going|lift|exercise|movement|move|set|one|ones|thing|stuff|ok|okay|yeah|yes|no|thanks|warm|warmup|warmups|session|workout|round|rest|break|about|regarding|re|time|times|day|days|week|weeks|month|months|minute|minutes|min|mins|ago|earlier|later)\b/gi;

function normalize(message) {
  return String(message == null ? '' : message)
    .toLowerCase()
    .replace(/[‘’ʼ′']/g, '')      // "what's" → "whats", matching the existing strip
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The contentful words left after the greeting, the attribute tokens, and the scaffolding. */
function residueWords(message) {
  const stripped = String(message == null ? '' : message).replace(GREETING_RE, ' ');
  return normalize(stripped)
    .replace(ATTR_STRIP_RE, ' ')
    .replace(SCAFFOLD_RE, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !/^\d+$/.test(w));
}

/**
 * The exercise name a message appears to use, or null when it names none.
 *
 * Null for pure contextual shorthand ("how much?", "and reps?"), for a greeting
 * ("good morning!"), and for a session-noun follow-up ("how much for the last set?") — all
 * of which must keep resolving against the active referent.
 *
 * @param {string} message
 * @returns {string|null} the residue phrase, e.g. "good morning" or "chest fly"
 */
function namedExercisePhrase(message) {
  const words = residueWords(message);
  if (!words.length) return null;
  if (!words.some((w) => MOVEMENT_VOCABULARY.has(w))) return null;
  return words.join(' ');
}

/**
 * True when the message names an exercise (per `namedExercisePhrase`) that `resolve`
 * cannot turn into one canonical lift. `resolve` is INJECTED — normally
 * `workoutTextParser.canonicalizeExerciseName` — so this module stays pure and the
 * caller keeps ownership of what "resolvable" means.
 *
 * An AMBIGUOUS parser hit ("row") counts as unresolvable: the name was understood but it
 * still identifies no single lift, so inheriting the previous lift is the same defect.
 *
 * @returns {{ phrase: string }|null}
 */
function unresolvableExerciseReference(message, resolve) {
  const phrase = namedExercisePhrase(message);
  if (!phrase) return null;
  let hit = null;
  try {
    hit = typeof resolve === 'function' ? resolve(message) : null;
  } catch (_) {
    hit = null; // a resolver failure must fail CLOSED, never fall through to another lift
  }
  if (hit && hit.canonicalName) return null;
  return { phrase };
}

/** The short fail-closed ask. It names what was heard and asks; it never guesses a lift. */
function unresolvedExerciseAsk(phrase) {
  const named = String(phrase == null ? '' : phrase).trim();
  return named
    ? `I don't have "${named}" as a lift I can program. Which lift did you mean?`
    : "I don't have that lift. Which lift did you mean?";
}

module.exports = {
  namedExercisePhrase,
  unresolvableExerciseReference,
  unresolvedExerciseAsk,
  MOVEMENT_VOCABULARY,
};
