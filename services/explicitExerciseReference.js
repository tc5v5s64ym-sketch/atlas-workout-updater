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
  // Equipment, not movement (Codex #1213 P2). A catalogue alias may END in a piece of
  // equipment, which would otherwise make "what weight on the barbell?" or "how much for
  // the dumbbell?" read as a named exercise and decline ordinary shorthand. Equipment
  // never identifies a lift on its own, and every exercise that uses it carries its own
  // movement word ("cable fly", "dumbbell row"), so excluding these loses no detection.
  // NOTE: 'bench' is deliberately NOT excluded, even though "on the bench" reads as
  // equipment. It is itself a lift alias, so the resolver answers those turns and this
  // detector never sees them; excluding it only created a hole — "close grip bench" failed
  // to resolve AND failed to be detected, so it inherited the active lift. A word that is
  // its own alias belongs in the vocabulary. The words below are not aliases of anything.
  'barbell', 'barbells', 'dumbbell', 'dumbbells', 'dumbell', 'dumbells', 'kettlebell',
  'kettlebells', 'cable', 'cables', 'band', 'bands', 'plate', 'plates', 'rack', 'sled',
  'belt', 'strap', 'straps', 'chalk', 'smith', 'weight', 'weights',
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
 * An AMBIGUOUS parser hit ("rows") counts as unresolvable: the name was understood but it
 * still identifies no single lift, so inheriting the previous lift is the same defect. Its
 * own disambiguation message is carried through, because "which row?" is the truthful ask
 * there — Atlas HAS rows; it just cannot tell which one was meant.
 *
 * @returns {{ phrase: string, ambiguousMessage: string|null }|null}
 */
function unresolvableExerciseReference(message, resolve) {
  const phrase = namedExercisePhrase(message);
  if (!phrase) return null;

  // A resolver failure must fail CLOSED, never fall through to another lift.
  const tryResolve = (text) => {
    try { return typeof resolve === 'function' ? resolve(text) : null; }
    catch (_) { return null; }
  };

  const hit = tryResolve(message);
  if (hit && hit.canonicalName) return null;

  // The parser reports ambiguity only for a name it sees at the START of the text, so
  // "how much for rows?" comes back empty while the bare "rows" comes back ambiguous.
  // Re-ask with the extracted phrase alone to recover that message. Only the AMBIGUITY
  // is taken from it — an anywhere-position canonical hit would already have been found
  // in the full message above, so this can never turn a decline into a resolution.
  const fromPhrase = (hit && hit.ambiguous) ? hit : tryResolve(phrase);
  const ambiguousMessage = fromPhrase && fromPhrase.ambiguous
    && typeof fromPhrase.message === 'string' && fromPhrase.message.trim()
    ? fromPhrase.message.trim()
    : null;
  return { phrase, ambiguousMessage };
}

/**
 * The short fail-closed ask. It never guesses a lift. A name the parser understood but
 * could not narrow keeps the parser's own disambiguation wording; an unknown name is named
 * back so the athlete can see exactly what Atlas heard.
 */
function unresolvedExerciseAsk(reference) {
  const ref = typeof reference === 'string' ? { phrase: reference } : (reference || {});
  if (ref.ambiguousMessage) return ref.ambiguousMessage;
  const named = String(ref.phrase == null ? '' : ref.phrase).trim();
  return named
    ? `I don't have "${named}" as a lift I can program. Which lift did you mean?`
    : "I don't have that lift. Which lift did you mean?";
}

// ── qualified-variant detection ─────────────────────────────────────────────
//
// The parser's alias table is deliberately narrow and matches an alias ANYWHERE in the
// text, so "how much for zercher squat?" matched `squat` and answered with BACK SQUAT's
// prescribed weight, planned total, and engine recommendation. Front, Goblet and Hack
// Squat, Close-Grip and Paused Bench, and Deficit Deadlift all leaked the base lift's
// numbers the same way. The athlete named one lift and got another lift's data.
//
// The parser already has `strictVariantGuard` for this, but it is calibrated for the LOG
// path: it rejects a match whose preceding token is merely NAME-LIKE, which in free-text
// coaching questions fires on ordinary verbs — "why did you program bench press?" would
// stop resolving. So the read path needs a check that recognises a real qualifier and
// nothing else.
//
// The Exercise KB already knows: "zercher squat" is `barbell_zercher_squat`, a different
// exercise from `back_squat`. So the question is answered from data, not from a
// hand-maintained modifier list — the message's own phrase is looked up, and it counts as
// a different lift only when the KB says so. A phrase the KB does not know ("program bench
// press") makes no claim at all, so ordinary wording is never rejected.

/** Alias key: lowercase, hyphens and punctuation to spaces, whitespace collapsed. */
function aliasKey(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildKbIndex() {
  const byAlias = new Map();
  for (const entry of Array.isArray(KB_ALIASES) ? KB_ALIASES : []) {
    if (!entry || !entry.alias || !entry.exercise_id) continue;
    const key = aliasKey(entry.alias);
    if (key && !byAlias.has(key)) byAlias.set(key, String(entry.exercise_id));
  }
  return byAlias;
}

const KB_ID_BY_ALIAS = buildKbIndex();

/** The KB exercise id for a phrase, trying the plural form too. Null when unknown. */
function kbExerciseId(phrase) {
  const key = aliasKey(phrase);
  if (!key) return null;
  if (KB_ID_BY_ALIAS.has(key)) return KB_ID_BY_ALIAS.get(key);
  const singular = key.replace(/s$/, '');
  if (singular !== key && KB_ID_BY_ALIAS.has(singular)) return KB_ID_BY_ALIAS.get(singular);
  return null;
}

// The longest KB alias appearing anywhere in the text, as an exercise id. Longest wins on
// purpose: a qualified variant is always longer than the base it contains, so "front
// squat" beats "squat" and "close grip bench" beats "bench". Scanning the text rather than
// requiring the whole message to be an alias is what makes "why did you program front
// squat?" work — the framing words no longer hide the name.
const KB_MAX_ALIAS_WORDS = 6;

function longestKbExerciseIdIn(text) {
  const words = aliasKey(text).split(' ').filter(Boolean);
  if (!words.length) return null;
  for (let size = Math.min(KB_MAX_ALIAS_WORDS, words.length); size >= 1; size -= 1) {
    for (let i = 0; i + size <= words.length; i += 1) {
      const id = kbExerciseId(words.slice(i, i + size).join(' '));
      if (id) return id;
    }
  }
  return null;
}

/**
 * True when the message names a DIFFERENT real exercise than the one the parser matched.
 *
 * Both sides must be known to the KB. When either is unknown this returns false, because
 * an unknown phrase is not evidence of anything — the caller keeps whatever the parser
 * decided. That one-sided design is what keeps ordinary conversation and every legitimate
 * alias untouched: only a phrase the KB positively identifies as another exercise counts.
 *
 * @param {string} message        the athlete's message
 * @param {string} matchedName    the canonical name the parser resolved it to
 */
function namesDifferentExercise(message, matchedName) {
  const matchedId = longestKbExerciseIdIn(matchedName);
  if (!matchedId) return false;
  // Compared on a crude singular stem so "goblet squats" still overlaps "Back Squat".
  const stem = (w) => w.replace(/s$/, '');
  const matchedWords = new Set(
    aliasKey(matchedName).split(' ').filter((w) => w.length >= 4).map(stem),
  );
  if (!matchedWords.size) return false;

  // Every KB alias occurrence in the message, with the word span it covers.
  const words = aliasKey(message).split(' ').filter(Boolean);
  const own = [];        // spans naming the matched lift itself
  const qualifying = []; // spans naming a DIFFERENT lift that shares a word with it
  for (let size = Math.min(KB_MAX_ALIAS_WORDS, words.length); size >= 1; size -= 1) {
    for (let i = 0; i + size <= words.length; i += 1) {
      const phraseWords = words.slice(i, i + size);
      const id = kbExerciseId(phraseWords.join(' '));
      if (!id) continue;
      if (id === matchedId) { own.push([i, i + size]); continue; }
      // A different lift only QUALIFIES this one when it shares a word with it:
      // "front squat" replaces Back Squat, while "how are bench press and back squat?"
      // names two lifts that share nothing — an ambiguous multi-lift turn the other
      // lanes must keep seeing as two, not one silently dropped here.
      if (size >= 2 && phraseWords.some((w) => matchedWords.has(stem(w)))) {
        qualifying.push([i, i + size]);
      }
    }
  }
  if (!qualifying.length) return false;

  // The qualifier must COVER the matched lift's mention, not sit beside it. In "zercher
  // squat" the base alias `squat` lies inside the variant's span, so the athlete named one
  // lift. In "bench press and overhead press" each lift has its own span, so both are
  // genuinely named and neither may be dropped — that turn is ambiguous, not qualified.
  const disjoint = ([aS, aE], [bS, bE]) => aE <= bS || bE <= aS;
  return qualifying.some((q) => !own.some((o) => disjoint(o, q)));
}

module.exports = {
  namedExercisePhrase,
  unresolvableExerciseReference,
  unresolvedExerciseAsk,
  namesDifferentExercise,
  kbExerciseId,
  MOVEMENT_VOCABULARY,
};
