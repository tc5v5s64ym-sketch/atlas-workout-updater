const { classifyMessageIntent } = require('./messageIntent');

const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

const EXERCISE_ALIASES = [
  ['Incline DB Press', ['incline dumbbell press', 'incline db press', 'incline db bench', 'dumbbell incline press']],
  ['Incline Bench Press', ['incline bench press', 'incline barbell bench', 'incline bench', 'ibp']],
  ['Decline Bench Press', ['decline bench press', 'decline barbell bench', 'decline bench']],
  ['Bench Press', ['bench press', 'barbell bench', 'flat bench', 'bb bench', 'bench', 'bp']],
  ['Back Squat', ['back squat', 'bb squat', 'squats', 'squat', 'bs']],
  ['Deadlift', ['deadlift', 'dead', 'dl']],
  ['RDL', ['romanian deadlifts', 'romanian deadlift', 'romanian dls', 'romanian dl', 'rdls', 'rdl']],
  ['Overhead Press', ['overhead press', 'military press', 'standing press', 'strict press', 'overhead', 'ohp']],
  ['Lat Pulldown', ['lat pulldown', 'lat pull down', 'pulldown', 'cable pulldown']],
  ['Seated Row', ['seated row', 'cable row', 'machine row']],
  ['Bent-Over Row', ['bent-over row', 'bent over row', 'bent row', 'reverse-grip row', 'reverse row', 'bor']],
  ['Hammer Curl', ['hammer curls', 'hammer curl', 'hammers', 'hammer']],
  ['Face Pull', ['face pulls', 'face pull']],
  // findExerciseInText sorts aliases by key length descending, so "single-leg leg curl" (19 chars)
  // wins over "leg curl" (8 chars) regardless of array order here.
  ['Single-Leg Leg Curl', ['single-leg leg curl', 'single leg leg curl', 'sl leg curl']],
  ['Leg Curl', ['hamstring curl', 'leg curls', 'ham curls', 'leg curl']],
  ['Leg Extension', ['leg extension', 'leg extensions', 'leg ext', 'knee extension']],
  ['Shrug', ['shrugs', 'shrug', 'db shrugs', 'dumbbell shrugs', 'barbell shrugs']],
  ['Single-Leg Seated Leg Press', ['seated single leg press', 'single-leg press', 'single leg press', 'slp']],
  ['Leg Press', ['leg press', 'machine leg press']],
  ['Pull-Up', ['pull-up', 'pull up', 'pullup', 'pullups', 'pull-ups']],
  ['Chin-Up', ['chin-up', 'chin up', 'chinup', 'chinups', 'chin-ups']],
  ['Hip Thrust', ['hip thrust', 'hip thrusts', 'barbell hip thrust']],
  ['Hanging Knee Raises', ['hanging knee raises', 'captains chair', 'captain chair', 'knee raises', 'kr']],
  ['Lateral Raises', ['lateral raises', 'lateral raise', 'side raises', 'laterals', 'lateral']],
  ['Dips (Weighted)', ['weighted dips', 'dips', 'dip', 'wd']],
  ['Push-Up', ['push-up', 'push up', 'pushups', 'push ups', 'push-ups', 'pushup']],
  ['Cable Tricep Pushdown', ['cable tricep pushdown', 'cable tricep pushdowns', 'tricep pushdown', 'tricep pushdowns', 'tricep pulldown', 'tricep pulldowns', 'tricep pull', 'tricep pulls', 'cable triceps', 'cable tricep']],
];

const AMBIGUOUS_ALIASES = {
  press: 'Which press - OHP, bench, or incline?',
  row: 'Which row - seated, bent-over, cable, or machine?',
  rows: 'Which row - seated, bent-over, cable, or machine?',
};

// Contextual aliases only resolve when the exercise's strong alias is already
// present in the same parsed input. They cannot start a new exercise on their
// own. Longer aliases are listed first so stripping is applied longest-match-first.
const CONTEXTUAL_ALIASES = {
  'Lat Pulldown':    ['lat pull', 'lats'],
  'Incline DB Press': ['incline press', 'incline'],
};

function normalizeParserText(value) {
  return String(value || '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u00d7/g, 'x')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKey(value) {
  return normalizeParserText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCaseFallback(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function setRecord({ weight = null, reps = null, rir = null, rpe = null, set_type = 'working', notes = null, weight_unit = 'lb', load_note = null }) {
  const row = {
    weight,
    weight_unit: weight == null ? null : weight_unit,
    reps,
    rir,
    rpe,
    set_type,
    notes,
  };
  if (load_note) row.load_note = load_note;
  return row;
}

function buildLogResult({ rawText, rawName, canonicalName, sets, warnings = [], needsCatalogReview = false }) {
  return {
    intent: 'log_sets',
    raw_text: rawText,
    raw_name: rawName,
    exercise: canonicalName,
    canonical_name: canonicalName,
    sets,
    warnings,
    ...(needsCatalogReview ? { needs_catalog_review: true } : {}),
  };
}

function findExerciseInText(text) {
  const normalized = normalizeKey(text);
  if (!normalized) return null;

  for (const [ambiguous, message] of Object.entries(AMBIGUOUS_ALIASES)) {
    if (normalized === ambiguous || normalized.startsWith(`${ambiguous} `)) {
      return { ambiguous: true, rawName: ambiguous, message };
    }
  }

  const aliases = [];
  for (const [canonicalName, names] of EXERCISE_ALIASES) {
    for (const alias of names) aliases.push({ canonicalName, alias, key: normalizeKey(alias) });
  }
  aliases.sort((a, b) => b.key.length - a.key.length);

  for (const candidate of aliases) {
    const atStart = normalized === candidate.key || normalized.startsWith(`${candidate.key} `);
    const anywhere = new RegExp(`\\b${escapeRegExp(candidate.key)}\\b`).test(normalized);
    if (atStart || anywhere) {
      return {
        canonicalName: candidate.canonicalName,
        rawName: candidate.alias,
        rest: stripExerciseText(text, candidate.key),
      };
    }
  }

  return null;
}

function findExerciseMentions(text) {
  const normalizedWords = normalizeKey(text).split(' ').filter(Boolean);
  const mentions = [];
  const seen = new Set();

  for (const [canonicalName, names] of EXERCISE_ALIASES) {
    for (const alias of names) {
      const aliasWords = normalizeKey(alias).split(' ').filter(Boolean);
      if (!aliasWords.length) continue;
      for (let i = 0; i <= normalizedWords.length - aliasWords.length; i += 1) {
        if (normalizedWords.slice(i, i + aliasWords.length).join(' ') === aliasWords.join(' ')) {
          const key = `${canonicalName}:${i}:${i + aliasWords.length}`;
          if (!seen.has(key)) {
            mentions.push({ canonicalName, index: i, alias, aliasWords });
            seen.add(key);
          }
        }
      }
    }
  }

  return mentions
    .filter(mention => !mentions.some(other =>
      other.canonicalName !== mention.canonicalName &&
      other.index <= mention.index &&
      other.index + other.aliasWords.length >= mention.index + mention.aliasWords.length &&
      other.aliasWords.length > mention.aliasWords.length
    ));
}

function hasMultipleExerciseMentions(text) {
  const canonicalNames = new Set(findExerciseMentions(text).map(mention => mention.canonicalName));
  return canonicalNames.size > 1;
}

// Split a multi-exercise message into one sub-string per exercise, using the
// recognized exercise names as boundaries — so "Deadlift 245 6/2 5/2 bench 185 8/2"
// (several lifts on one line, the way the lifter actually types) becomes
// ["Deadlift 245 6/2 5/2", "bench 185 8/2"], each of which the proven
// single-exercise parser already handles. Returns null when it can't split safely:
//   - fewer than two DISTINCT recognized exercises (nothing to split), or
//   - the lowercase-key token count doesn't match the raw token count (punctuation
//     made the mention indices unreliable) — in which case the caller must NOT
//     guess; it falls back to asking, never mis-logging.
// Boundaries are the FIRST occurrence of each distinct canonical (so two aliases of
// the same lift don't over-split). Indices come from findExerciseMentions, which
// counts normalizeKey tokens; we slice the raw (slash-preserving) tokens at the
// same indices, guarded by the equal-length check above.
function splitMultiExerciseSegments(text) {
  const mentions = findExerciseMentions(text);
  if (!mentions.length) return null;

  const firstIdxByCanon = new Map();
  for (const m of mentions) {
    if (!firstIdxByCanon.has(m.canonicalName) || m.index < firstIdxByCanon.get(m.canonicalName)) {
      firstIdxByCanon.set(m.canonicalName, m.index);
    }
  }
  if (firstIdxByCanon.size < 2) return null;

  const keyTokens = normalizeKey(text).split(' ').filter(Boolean);
  const rawTokens = normalizeParserText(text).split(' ').filter(Boolean);
  if (keyTokens.length !== rawTokens.length) return null; // index mapping unreliable

  const starts = [...firstIdxByCanon.values()].sort((a, b) => a - b);
  const segments = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : rawTokens.length;
    const seg = rawTokens.slice(from, to).join(' ').trim();
    if (seg) segments.push(seg);
  }
  return segments.length >= 2 ? segments : null;
}

// Set-notation words that appear BETWEEN set tokens in normal single-exercise
// entries ("205 lb 5 reps RIR 2", "70 x 12 @2", "205 for 7"). A word run that
// contains any of these is notation, never a second exercise name.
const SET_NOTATION_WORD_RE = /^(x\d*|reps?|rir|rpe|lbs?|kgs?|for|at|by|to|of|with|secs?|s|amrap|ss|dropset|drop)$/i;
// Continuation / connector words that join sets within ONE exercise or describe
// effort across them ("then 245", "6 and 6", "all around RIR", "three times").
// Number words are included so "three times" is never read as an exercise name.
const SET_CONTINUATION_WORD_RE = /^(today|i|did|was|were|then|and|another|next|same|again|also|plus|times?|all|around|about|roughly|approx|approximately|each|per|set|sets|one|two|three|four|five|six|seven|eight|nine|ten)$/i;

// Refuse-to-merge guard (G1). Detect leftover set tokens that CANNOT be confidently
// attributed to the recognized exercise: a trailing set-group separated from the
// first set-group by a word run that is ENTIRELY "name-like" — every word an ordinary
// noun token, NONE of which is set notation (reps/rir/lb/for/x…), a continuation
// filler (then/and/all/around/times…), a number word, or a known contextual/ambiguous
// alias (incline/lats/press/row). That precise shape is a SECOND exercise's name the
// catalog didn't recognize ("…Dumbbell Side Bend 70 15/1…"); its sets must never be
// silently merged into the first lift. Natural-language notation between sets always
// contains a notation/filler word, so the run is not entirely name-like and this never
// fires on it. Pure; NO catalog/KB lookup — conservative (errs toward NOT firing, i.e.
// today's behavior) so it adds a new refuse branch without changing any existing parse.
const CONTEXTUAL_ALIAS_WORDS = new Set(
  [].concat(
    ...Object.values(CONTEXTUAL_ALIASES).map(list => list.join(' ').split(/\s+/)),
    Object.keys(AMBIGUOUS_ALIASES)
  ).map(w => w.toLowerCase()).filter(Boolean)
);
function hasUnattributableTrailingSets(rest) {
  const tokens = normalizeParserText(rest)
    .split(' ')
    .map(t => t.replace(/[,.;:]+$/, '').trim())
    .filter(Boolean);
  if (tokens.length < 3) return false;

  const isSet = t => looksLikeSetToken(t);
  const isNameWord = t =>
    /^[a-z][a-z-]*$/i.test(t) &&
    !SET_NOTATION_WORD_RE.test(t) &&
    !SET_CONTINUATION_WORD_RE.test(t) &&
    !CONTEXTUAL_ALIAS_WORDS.has(t.toLowerCase());

  let sawSetBefore = false;
  let i = 0;
  while (i < tokens.length) {
    if (isSet(tokens[i])) { sawSetBefore = true; i += 1; continue; }
    // Start of a non-set word run — collect it.
    const runStart = i;
    while (i < tokens.length && !isSet(tokens[i])) i += 1;
    const run = tokens.slice(runStart, i);
    const setAfter = i < tokens.length; // a set token follows this run
    // A pure name run (≥1 token, all name-like) sandwiched between set groups means
    // the trailing sets belong to an unrecognized second exercise → unattributable.
    if (sawSetBefore && setAfter && run.length && run.every(isNameWord)) {
      return true;
    }
  }
  return false;
}

function stripExerciseText(text, exerciseKey) {
  const normalizedWords = normalizeKey(text).split(' ');
  const exerciseWords = exerciseKey.split(' ');
  let start = -1;
  for (let i = 0; i <= normalizedWords.length - exerciseWords.length; i += 1) {
    if (normalizedWords.slice(i, i + exerciseWords.length).join(' ') === exerciseKey) {
      start = i;
      break;
    }
  }
  if (start === -1) return text;

  const originalWords = normalizeParserText(text).split(' ');
  return originalWords
    .slice(0, start)
    .concat(originalWords.slice(start + exerciseWords.length))
    .join(' ')
    .replace(/^\s*(today|was|were|is|:|,|then|and)\s*/i, '')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectIntent(text) {
  const normalized = normalizeKey(text);
  if (!normalized) return 'unknown';
  if (/\b(what are we doing|whats next|what's next|back at the gym|give me todays workout|give me today's workout|what'?s the plan|where did we leave off)\b/.test(normalized)) {
    return 'plan_request';
  }
  if (/\b(log everything|log everything to spreadsheet|finish session|save session|thats it|that's it|we're done|were done)\b/.test(normalized)) {
    return 'finish_session';
  }
  if (/\b(delete last set|remove last set|delete that|remove that)\b/.test(normalized)) {
    return 'delete_last_set';
  }
  if (/\b(change that to|make that|rir was|call it|change rir to|change reps to|change weight to|actually call it)\b/.test(normalized)) {
    return 'update_last_set';
  }
  if (/\b(duration|active calories|active|total calories|avg hr|average hr|peak hr|watch data|apple watch)\b/.test(normalized)) {
    return 'effort_capture';
  }
  return 'log_sets';
}

// When the input has blank-line-separated paragraphs, discard any that are
// explanatory prose (no set data AND reads like a sentence) so they can't
// compete with the actual performed-exercise header/sets. A paragraph is prose
// when it ends with terminal punctuation (. ! ?) or contains an internal
// sentence break (". "). Short headers like "Leg Press" have no terminal
// punctuation and are kept so they join with the following set paragraph.
// Note: this heuristic is best-effort — prose without terminal punctuation
// (e.g. "no squats — swapping for leg press") is not caught and falls through
// to the existing multi-exercise guard. When nothing is filtered, returns input
// unchanged so normalizeParserText handles it as before.
function extractSetParagraphs(input) {
  const HAS_SET_SLASH = /\d+\/\d+/;
  const IS_PROSE = /[.!?]$|[.!?]\s/;
  const normalized = String(input || '').replace(/\r\n/g, '\n');
  const paragraphs = normalized.split(/\n[ \t]*\n/);
  if (paragraphs.length <= 1) return input;
  const useful = paragraphs.filter(p => HAS_SET_SLASH.test(p) || !IS_PROSE.test(p.trim()));
  if (useful.length === paragraphs.length) return normalized;
  if (!useful.length) return input;
  return useful.join('\n');
}

function parseWorkoutText(input, context = {}) {
  const rawText = normalizeParserText(extractSetParagraphs(input));
  const intent = detectIntent(rawText);

  if (intent === 'unknown') {
    return { intent: 'unknown', raw_text: rawText, warnings: ['empty_input'] };
  }
  if (intent === 'plan_request') {
    return { intent, raw_text: rawText };
  }
  if (intent === 'finish_session') {
    return { intent, raw_text: rawText, requires_effort_check: true };
  }
  if (intent === 'delete_last_set') {
    return { intent, raw_text: rawText };
  }
  if (intent === 'update_last_set') {
    return parseUpdateLastSet(rawText, context);
  }
  if (intent === 'effort_capture') {
    return parseEffortCapture(rawText);
  }

  const skipped = extractSkipNotes(rawText);
  const result = parseLogSets(rawText, context);

  // A multi-exercise log is unambiguous (every chunk resolved to real sets, or
  // parseLogSets would have asked for clarification) — return it directly, past the
  // single-exercise question-floor / skip handling below.
  if (result?.intent === 'log_sets_multi') {
    return skipped.length > 0 ? { ...result, prescribed: skipped } : result;
  }

  // AC8 credibility floor (CONVERSATION_DESIGN.md): never log a phantom set.
  // If the message reads as a question and did NOT resolve to a real logged set,
  // it is answered — never fabricated into an exercise from the question text
  // (the 2026-06-16 "Didn't you suggest 225 5/2 x3" bug, which parseUnknownExercise
  // would otherwise turn into a logged "Didnt You Suggest" set). A genuinely
  // resolved set (real lift + set tokens) still logs even if it also asks a
  // question, so this can never suppress a real log.
  const hasResolvedLift = result?.intent === 'log_sets'
    && !(result.warnings || []).includes('unknown_exercise');
  const hasSetTokens = result?.intent === 'log_sets';
  const floor = classifyMessageIntent(rawText, { hasResolvedLift, hasSetTokens });
  if (floor.suppressLog && floor.reason === 'question') {
    return {
      intent: 'question',
      raw_text: rawText,
      message: "That reads like a question, so nothing was logged — ask me directly and I'll answer.",
      warnings: ['logged_nothing_question'],
    };
  }

  if (skipped.length > 0 && result?.intent === 'log_sets') {
    return { ...result, prescribed: skipped };
  }
  return result;
}

function buildWorkoutTextParseDryRunResponse(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid JSON payload. A JSON object is required.');
  }

  if (String(payload.test_mode || '').toLowerCase() !== 'true') {
    throw new Error('test_mode=true is required. parse-workout-text is dry-run only.');
  }

  if (typeof payload.text !== 'string' || payload.text.trim() === '') {
    throw new Error('text is required.');
  }

  const context = payload.context && typeof payload.context === 'object' && !Array.isArray(payload.context)
    ? payload.context
    : {};
  const parsed = parseWorkoutText(payload.text, context);

  return {
    status: 'success',
    test_mode: true,
    parsed,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    sheet_written: false,
    no_write_confirmed: true,
  };
}

function parseUpdateLastSet(rawText) {
  const rir = parseNumberMatch(
    rawText.match(/\brir\s*(?:was|to|=)?\s*(\d+(?:\.\d+)?)/i) ||
    rawText.match(/\b(?:call it|actually call it)\s+rir\s*(\d+(?:\.\d+)?)/i)
  );
  const reps = parseNumberMatch(rawText.match(/\breps?\s*(?:was|to|=)?\s*(\d+(?:\.\d+)?)/i));
  const weight = parseNumberMatch(rawText.match(/\bweight\s*(?:was|to|=)?\s*(\d+(?:\.\d+)?)/i));
  if (rir == null && reps == null && weight == null) {
    const bareNumber = parseNumberMatch(rawText.match(/\b(?:change that to|make that|call it|to)\s*(\d+(?:\.\d+)?)\b/i));
    return {
      intent: 'needs_clarification',
      raw_text: rawText,
      message: bareNumber == null
        ? 'What should change - reps, weight, or RIR?'
        : `${bareNumber} what - reps, weight, or RIR?`,
      warnings: ['ambiguous_correction_field'],
    };
  }
  return {
    intent: 'update_last_set',
    raw_text: rawText,
    update: {
      ...(rir == null ? {} : { rir }),
      ...(reps == null ? {} : { reps }),
      ...(weight == null ? {} : { weight }),
    },
  };
}

function parseEffortCapture(rawText) {
  const duration = parseNumberMatch(rawText.match(/\bduration\s*(\d+(?:\.\d+)?)/i));
  const active = parseNumberMatch(rawText.match(/\bactive(?:\s+calories)?\s*(\d+(?:\.\d+)?)/i));
  const total = parseNumberMatch(rawText.match(/\btotal(?:\s+calories)?\s*(\d+(?:\.\d+)?)/i));
  const avg = parseNumberMatch(rawText.match(/\b(?:avg|average)\s*hr\s*(\d+(?:\.\d+)?)/i));
  const peak = parseNumberMatch(rawText.match(/\bpeak\s*hr\s*(\d+(?:\.\d+)?)/i));
  const locationMatch = rawText.match(/\bpeak\s*hr\s*\d+(?:\.\d+)?\s+(.+)$/i);

  return {
    intent: 'effort_capture',
    raw_text: rawText,
    effort: {
      duration_min: duration,
      active_calories: active,
      total_calories: total,
      avg_hr: avg,
      peak_hr: peak,
      location: locationMatch ? locationMatch[1].trim() : null,
    },
  };
}

function parseNumberMatch(match) {
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

// Remove sentences that are skip notes — they name an exercise and include a
// skip keyword ("skipped", "skipping") but carry no set data (no reps/RIR slash
// token). This prevents "Deadlift skipped — platform busy." from registering
// as a second exercise mention when the user is logging a substitution.
// Sentences are delimited by ". " (period + space), which normalizeParserText
// preserves. If nothing is stripped the original text is returned unchanged.
function stripSkipNoteSentences(text) {
  const SKIP_WORD = /\bskipp?(?:ed|ing)?\b/i;
  const HAS_SET_SLASH = /\d+\/\d+/;
  const parts = text.split('. ');
  const kept = parts.filter(p => !(SKIP_WORD.test(p) && !HAS_SET_SLASH.test(p)));
  // Never strip everything: when the skip note isn't a separate ". "-delimited
  // sentence (e.g. "Skipped warmup bench 225x5 225x5"), filtering the lone part
  // would wipe real set data. Fall back to the original text in that case.
  if (!kept.length) return text;
  return kept.length < parts.length ? kept.join('. ').trim() : text;
}

// Extract prescribed/skipped exercise metadata from skip-note sentences without
// stripping them (that is stripSkipNoteSentences' job). Returns an array of
// { exercise, reason } objects — one per detected skip sentence.
// Only the documented "<Exercise> skipped …" format is supported: the entire
// lead before "skipped" must be a recognized exercise name with nothing else.
// This prevents prose like "Bench felt great so I skipped deadlift" from
// extracting "Bench" as the prescribed exercise. Safer to emit nothing than
// to emit a wrong prescribed name.
function extractSkipNotes(text) {
  const SKIP_WORD = /\bskipp?(?:ed|ing)?\b/i;
  const HAS_SET_SLASH = /\d+\/\d+/;
  const EXERCISE_LEAD = /^(.+?)\s+skipp?(?:ed|ing)?\b/i;
  const REASON_SUFFIX = /skipp?(?:ed|ing)?\s*[-–—:]\s*(.+)/i;
  const skipped = [];
  for (const part of text.split('. ')) {
    if (!SKIP_WORD.test(part) || HAS_SET_SLASH.test(part)) continue;
    const m = EXERCISE_LEAD.exec(part.trim());
    if (!m) continue;
    const lead = m[1].trim();
    const knownExercise = findExerciseInText(lead);
    if (!knownExercise || knownExercise.ambiguous) continue;
    // Require the lead to be exactly the exercise alias — no extra words.
    // "Back Squat" passes; "Bench felt great so I" does not.
    if (normalizeKey(lead) !== normalizeKey(knownExercise.rawName)) continue;
    const reasonMatch = REASON_SUFFIX.exec(part.trim());
    skipped.push({
      exercise: knownExercise.canonicalName,
      reason: reasonMatch ? reasonMatch[1].trim().replace(/[.!?]+$/, '') : null,
    });
  }
  return skipped;
}

function parseLogSets(rawText, context = {}) {
  // Strip skip-note sentences before multi-exercise check and exercise lookup
  // so "Deadlift skipped." doesn't count as a second exercise when the user
  // is logging a substitution on the following lines.
  const textForParsing = stripSkipNoteSentences(rawText);

  if (hasMultipleExerciseMentions(textForParsing)) {
    // Several exercises in one message — split on the recognized names and parse
    // each chunk with the normal single-exercise path, so the lifter can log them
    // however they type (inline or stacked). NEVER mis-log: only return the
    // combined result if EVERY chunk cleanly resolves to real sets; any ambiguous
    // chunk falls through to the clarification ask below.
    const segments = splitMultiExerciseSegments(textForParsing);
    if (segments && segments.length >= 2) {
      const parsedSegments = segments.map(seg => parseLogSets(seg, context));
      const allClean = parsedSegments.every(r =>
        r && r.intent === 'log_sets' && Array.isArray(r.sets) && r.sets.length);
      if (allClean) {
        return {
          intent: 'log_sets_multi',
          raw_text: rawText,
          exercises: parsedSegments,
          warnings: [...new Set(parsedSegments.flatMap(r => r.warnings || []))],
        };
      }
    }
    return {
      intent: 'needs_clarification',
      raw_text: rawText,
      message: 'This looks like mixed exercise input — I couldn’t cleanly tell the exercises apart. Log one at a time, or put each exercise on its own line.',
      warnings: ['multiple_exercises_in_input'],
    };
  }

  const exercise = findExerciseInText(textForParsing);
  if (exercise?.ambiguous) {
    return {
      intent: 'needs_clarification',
      raw_text: rawText,
      message: exercise.message,
      warnings: ['ambiguous_exercise_alias'],
    };
  }

  if (!exercise) {
    // Contextual aliases (e.g. "lats", "incline") cannot start a new exercise
    // on their own, but they should still inherit the activeExercise when that
    // exercise matches (cross-turn continuation). With no matching context they
    // surface as ambiguous rather than creating a bogus unknown-exercise row.
    const contextualLead = findContextualAliasLead(rawText);
    if (contextualLead) {
      if (context.activeExercise === contextualLead.canonicalName) {
        const ctxAliases = CONTEXTUAL_ALIASES[contextualLead.canonicalName] || [];
        const strippedRest = ctxAliases.reduce((text, alias) => {
          const key = normalizeKey(alias);
          return text.replace(new RegExp(`\\b${escapeRegExp(key)}\\b`, 'gi'), ' ').replace(/\s+/g, ' ').trim();
        }, contextualLead.rest);
        return parseWithExercise(rawText, {
          canonicalName: contextualLead.canonicalName,
          rawName: contextualLead.canonicalName,
          rest: strippedRest,
        });
      }
      return {
        intent: 'needs_clarification',
        raw_text: rawText,
        message: `Did you mean ${contextualLead.canonicalName}? Use the full exercise name to be sure.`,
        warnings: ['ambiguous_exercise_alias'],
      };
    }

    // A leading exercise NAME the resolver couldn't confidently match must never
    // be silently absorbed into the previous active exercise — that writes the
    // wrong lift's history (e.g. "shrugs 70 12/10" becoming Bench Press). Echo
    // the typed name and flag it for review instead.
    const unknownExercise = parseUnknownExercise(textForParsing);
    if (unknownExercise) return unknownExercise;
    // No leading name — bare set tokens like "205 5/3" are continuation sets of
    // the lift already in progress, so inherit the active exercise.
    if (context.activeExercise) {
      return parseWithExercise(rawText, {
        canonicalName: context.activeExercise,
        rawName: context.activeExercise,
        rest: textForParsing,
      });
    }
    return {
      intent: 'needs_clarification',
      raw_text: rawText,
      message: 'Which exercise is this for?',
      warnings: ['missing_exercise'],
    };
  }

  // Strip contextual alias tokens from the rest text. Contextual aliases are
  // only valid because the strong alias was already matched above — any
  // remaining occurrence is a set-separator label, not a new exercise name.
  const contextualAliases = CONTEXTUAL_ALIASES[exercise.canonicalName];
  const resolvedExercise = contextualAliases && exercise.rest
    ? { ...exercise, rest: contextualAliases.reduce((text, alias) => {
        const key = normalizeKey(alias);
        return text.replace(new RegExp(`\\b${escapeRegExp(key)}\\b`, 'gi'), ' ').replace(/\s+/g, ' ').trim();
      }, exercise.rest) }
    : exercise;

  // G1 refuse-to-merge: if the rest carries a trailing set-group that can't be
  // confidently attributed to this exercise (separated by a pure exercise-name word
  // run, e.g. "…Dumbbell Side Bend 70 15/1…"), do NOT silently absorb those sets into
  // this lift. Surface them as unresolved so the lifter re-enters the second exercise
  // — never a phantom merged PR. (Splitting it into its own exercise is a separate,
  // owner-gated piece of work; see BACKLOG.)
  if (hasUnattributableTrailingSets(resolvedExercise.rest)) {
    return {
      intent: 'needs_clarification',
      raw_text: rawText,
      message: `I logged sets for ${resolvedExercise.canonicalName}, but it looks like another exercise is stacked in the same entry and I can't tell its sets apart. Please re-enter that exercise on its own so nothing is mis-logged.`,
      warnings: ['unattributable_trailing_sets'],
    };
  }

  if (resolvedExercise.canonicalName === 'Hanging Knee Raises') {
    const bodyweightSets = parseBodyweightReps(resolvedExercise.rest);
    if (bodyweightSets.length) {
      return buildLogResult({
        rawText,
        rawName: titleCaseFallback(resolvedExercise.rawName),
        canonicalName: resolvedExercise.canonicalName,
        sets: bodyweightSets,
      });
    }
  }

  if (resolvedExercise.canonicalName === 'Hanging Knee Raises' && looksLikeBodyweightRepsOnly(resolvedExercise.rest)) {
    const reps = extractNumbers(resolvedExercise.rest).map(value => setRecord({ weight: null, reps: value, rir: null, weight_unit: null }));
    return {
      intent: 'needs_clarification',
      raw_text: rawText,
      message: 'Knee raises: do you mean bodyweight reps 20, 15, 15?',
      partial: {
        exercise: resolvedExercise.canonicalName,
        raw_name: resolvedExercise.rawName,
        sets: reps,
      },
      warnings: ['missing_weight_or_bodyweight_context'],
    };
  }

  // Bare bodyweight Dips ("Dips 10/2 x3", "Dip 10/2 x3") logs as BODYWEIGHT, distinct
  // from the added-load form. The "dips"/"dip" alias resolves to "Dips (Weighted)"
  // (added load is the common gym case), so ONLY when the rest carries no external
  // load — i.e. the weighted slash parser finds no sets — do we re-label to a
  // bodyweight "Dips" and read the reps as bodyweight (weight null). Weighted dips
  // ("Dips +25 8/2", "Weighted dips +50 10/2 x3") still parse weighted below, since
  // parseSetGroups resolves their load. All Dips variants share lift code DIP01, so
  // bodyweight/added-load differ only by the weight value, not the exercise.
  if (resolvedExercise.canonicalName === 'Dips (Weighted)' && !parseSetGroups(resolvedExercise.rest).length) {
    const bodyweightSets = parseBodyweightReps(resolvedExercise.rest);
    if (bodyweightSets.length) {
      return buildLogResult({
        rawText,
        rawName: titleCaseFallback(resolvedExercise.rawName),
        canonicalName: 'Dips',
        sets: bodyweightSets,
      });
    }
  }

  if (resolvedExercise.canonicalName === 'Push-Up') {
    // Slash/repeat formats (parseBodyweightReps), then bare space/comma-separated
    // integer lists ("40 40 40"). Push-Up is an unambiguously bodyweight move —
    // no external load — so bare integers are always reps, never weight.
    const bwSets = parseBodyweightReps(resolvedExercise.rest);
    const bodyweightSets = bwSets.length ? bwSets : (parseBareBodyweightReps(resolvedExercise.rest) || []);
    if (bodyweightSets.length) {
      return buildLogResult({
        rawText,
        rawName: titleCaseFallback(resolvedExercise.rawName),
        canonicalName: resolvedExercise.canonicalName,
        sets: bodyweightSets,
      });
    }
  }

  return parseWithExercise(rawText, resolvedExercise);
}

function parseWithExercise(rawText, exercise) {
  const rest = exercise.rest || '';
  const sets = parseSetGroups(rest);
  if (!sets.length) {
    return {
      intent: 'needs_clarification',
      raw_text: rawText,
      message: `Could not find sets for ${exercise.canonicalName}.`,
      partial: { exercise: exercise.canonicalName, raw_name: exercise.rawName },
      warnings: ['missing_sets'],
    };
  }

  return buildLogResult({
    rawText,
    rawName: titleCaseFallback(exercise.rawName),
    canonicalName: exercise.canonicalName,
    sets,
  });
}

function parseSetGroups(text) {
  const cleaned = normalizeParserText(text)
    .replace(/\b(today|i did|did|was|were)\b/gi, ' ')
    // Added-load bodyweight notation: a token-LEADING "+" on a load ("Dips +25 8/2",
    // "Pull-ups +25 6/2") marks EXTERNAL load. Atlas has no separate added-load
    // column, so within the slash-notation contract the "+" is dropped and the
    // number is read as Weight — the movement NAME is unchanged, and reps/RIR/xN
    // then parse exactly like any normal slash set. Bare slash sets (no "+") are
    // untouched. Bodyweight is NOT auto-added here (no existing rule does that).
    // Anchored to start-of-text / after-space, so a "+" wedged BETWEEN digits
    // ("225+25") is left alone and can never silently concatenate into a bogus weight.
    .replace(/(^|\s)\+(\d)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();

  return parseDumbbellSlashRepeats(cleaned)
    || parseDumbbellGroups(cleaned)
    || parseDumbbellList(cleaned)
    || parseSetsFirst(cleaned)
    || parseWeightRepsSets(cleaned)
    || parseNaturalSets(cleaned)
    || parseDaleShorthand(cleaned)
    || [];
}

function parseUnknownExercise(rawText) {
  const unknown = extractUnknownExerciseLead(rawText);
  if (!unknown) return null;

  const parsedSets = parseSetGroups(unknown.rest);
  const sets = parsedSets.length ? parsedSets : parseBodyweightReps(unknown.rest);
  if (!sets.length) return null;

  const canonicalName = titleCaseFallback(unknown.rawName);
  return buildLogResult({
    rawText,
    rawName: canonicalName,
    canonicalName,
    sets,
    warnings: ['unknown_exercise'],
    needsCatalogReview: true,
  });
}

// Returns the canonical exercise name and stripped rest text when the input
// leads with a contextual alias (e.g. "lats 130 8/2" → Lat Pulldown). Returns
// null when no contextual alias is present at the start of the text. Aliases
// are checked longest-first because CONTEXTUAL_ALIASES lists them that way.
function findContextualAliasLead(rawText) {
  const normalized = normalizeKey(rawText);
  for (const [canonicalName, aliases] of Object.entries(CONTEXTUAL_ALIASES)) {
    for (const alias of aliases) {
      const key = normalizeKey(alias);
      if (normalized === key || normalized.startsWith(`${key} `)) {
        return { canonicalName, rest: stripExerciseText(rawText, key) };
      }
    }
  }
  return null;
}

function extractUnknownExerciseLead(rawText) {
  const tokens = normalizeParserText(rawText).split(/\s+/).filter(Boolean);
  const start = tokens.findIndex(token => looksLikeSetToken(token));
  if (start <= 0) return null;

  const rawName = tokens
    .slice(0, start)
    .join(' ')
    // Strip continuation fillers so phrasing like "another 205 5/3" or "same
    // 185 8/2" stays a continuation of the active lift rather than becoming a
    // bogus exercise named "Another"/"Same".
    .replace(/^\s*(today|i did|did|was|were|then|and|another|next|same|again|also|plus)\b\s*/i, '')
    .trim();
  if (!rawName) return null;

  // Guard against coining a phantom exercise from conversational feedback. A real
  // (even unknown) exercise name is a short noun phrase ("Jefferson Curl", "Hack
  // Squat"). Natural-language feedback ("I don't want to do 11 reps...", "we
  // should move up...") contains pronouns/negations/verbs that never appear in
  // lift names, or simply runs long. When the lead reads as prose, bail (→ the
  // message is treated as a coach question, not a logged set) instead of saving a
  // bogus "I Don't Want To Do" lift.
  if (looksLikeProse(rawName)) return null;

  return {
    rawName,
    rest: tokens.slice(start).join(' ').trim(),
  };
}

// Words that occur in conversational feedback but never in an exercise name.
const NON_EXERCISE_WORDS = /\b(i|im|i'?m|ive|i'?ve|you|your|we|we'?re|they|my|me|us|he|she|it'?s|dont|don'?t|do|does|wont|won'?t|cant|can'?t|not|no|want|wanna|should|would|could|will|like|love|hate|feel|felt|think|thought|need|gonna|let'?s|lets|because|across|prove|proven|instead|maybe|please|too|really|just|move|after|before|when|why|how|what|that'?s|thats)\b/i;

// A lead reads as prose (not a lift name) when it contains a conversational word
// or runs longer than a plausible exercise name (real names are ≤ 4 words, e.g.
// "Single Leg Leg Press"). High-precision: equipment/movement names never trip it.
function looksLikeProse(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length > 4) return true;
  return NON_EXERCISE_WORDS.test(name);
}


function looksLikeSetToken(token) {
  return /^x\d+$/i.test(token)
    || /^\d+(?:\.\d+)?(?:lb|lbs|s)?$/i.test(token)
    || /^\d+\/\d+(?:\.\d+)?$/i.test(token);
}

function parseDumbbellSlashRepeats(text) {
  const match = text.match(/^(\d+(?:\.\d+)?)s\s+(\d+)\/(\d+(?:\.\d+)?)\s+x(\d+)$/i);
  if (!match) return null;
  const weight = Number(match[1]);
  const reps = Number(match[2]);
  const rir = Number(match[3]);
  const count = Number(match[4]);
  if (count > 10) return null;
  return Array.from({ length: count }, () => setRecord({
    weight,
    reps,
    rir,
    load_note: 'per_hand',
  }));
}

// Parses one or more per-hand dumbbell set groups, supporting two notations:
//   NNNs REPS/RIR [xCOUNT]   — "60s 10/3", "60s 10/3 65s 8/2"
//   NNNs xREPS @RIR [xCOUNT] — "55s x10 @3", "55s x10 @3 60s x8 @2"
// Groups may be separated by commas or spaces.
// parseDumbbellSlashRepeats handles the narrower anchored form (one weight, xN);
// this function handles the multi-group and single-set-without-xN cases.
function parseDumbbellGroups(text) {
  const SLASH_GROUP = /(\d+(?:\.\d+)?)s\s+(\d+)\/(\d+(?:\.\d+)?)(?:\s+x(\d+))?/gi;
  const XREP_GROUP  = /(\d+(?:\.\d+)?)s\s+x(\d+)\s+@(\d+(?:\.\d+)?)(?:\s+x(\d+))?/gi;

  // Slash form wins when both notations appear in one entry; xrep is not tried.
  const slashMatches = [...text.matchAll(SLASH_GROUP)];
  if (slashMatches.length) {
    const sets = [];
    for (const m of slashMatches) {
      const count = m[4] ? Number(m[4]) : 1;
      if (count > 10) return null;
      for (let i = 0; i < count; i++) {
        sets.push(setRecord({ weight: Number(m[1]), reps: Number(m[2]), rir: Number(m[3]), load_note: 'per_hand' }));
      }
    }
    return sets.length ? sets : null;
  }

  const xrepMatches = [...text.matchAll(XREP_GROUP)];
  if (xrepMatches.length) {
    const sets = [];
    for (const m of xrepMatches) {
      const count = m[4] ? Number(m[4]) : 1;
      if (count > 10) return null;
      for (let i = 0; i < count; i++) {
        sets.push(setRecord({ weight: Number(m[1]), reps: Number(m[2]), rir: Number(m[3]), load_note: 'per_hand' }));
      }
    }
    return sets.length ? sets : null;
  }

  return null;
}

function parseDumbbellList(text) {
  const match = text.match(/\b(\d+(?:\.\d+)?)s\s+((?:\d+\s*,\s*)+\d+)\b/i);
  if (!match) return null;
  const weight = Number(match[1]);
  return match[2].split(/\s*,\s*/).map(reps => setRecord({
    weight,
    reps: Number(reps),
    rir: null,
    load_note: 'per_hand',
  }));
}

function parseSetsFirst(text) {
  const match = text.match(/\b(\d+)\s*x\s*(\d+)\s*@\s*(\d+(?:\.\d+)?)\b/i);
  if (!match) return null;
  const setCount = Number(match[1]);
  if (setCount > 10) return null;
  const reps = Number(match[2]);
  const weight = Number(match[3]);
  return Array.from({ length: setCount }, () => setRecord({ weight, reps, rir: null }));
}

function parseWeightRepsSets(text) {
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*x\s*(\d+)\s*x\s*(\d+)\b/i);
  if (!match) return null;
  const weight = Number(match[1]);
  const reps = Number(match[2]);
  const setCount = Number(match[3]);
  if (setCount > 10) return null;
  return Array.from({ length: setCount }, () => setRecord({ weight, reps, rir: null }));
}

function parseNaturalSets(text) {
  const lowered = text.toLowerCase();
  const allAroundRir = parseNumberMatch(lowered.match(/\ball around rir\s*(\d+(?:\.\d+)?)/i));
  const firstThenMatch = lowered.match(/\b(\d+(?:\.\d+)?)\s+for\s+(\d+),?\s+then\s+(\d+)\s+and\s+(\d+)/i);
  if (firstThenMatch) {
    const weight = Number(firstThenMatch[1]);
    return [firstThenMatch[2], firstThenMatch[3], firstThenMatch[4]].map(reps => setRecord({
      weight,
      reps: Number(reps),
      rir: allAroundRir,
    }));
  }

  const matches = [...lowered.matchAll(/\b(\d+(?:\.\d+)?)\s+for\s+(\d+)(?:\s+(one|two|three|four|five|\d+)\s+times)?/gi)];
  if (!matches.length) return null;

  const sets = [];
  for (const match of matches) {
    const weight = Number(match[1]);
    const reps = Number(match[2]);
    const repeat = match[3] ? (NUMBER_WORDS[match[3]] || Number(match[3])) : 1;
    for (let i = 0; i < repeat; i += 1) {
      sets.push(setRecord({ weight, reps, rir: allAroundRir }));
    }
  }
  return sets;
}

function parseDaleShorthand(text) {
  const rirWordMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(?:lb|lbs)?\s+(\d+)\s*reps?\s+rir\s*(\d+(?:\.\d+)?)\b/i);
  if (rirWordMatch) {
    return [setRecord({
      weight: Number(rirWordMatch[1]),
      reps: Number(rirWordMatch[2]),
      rir: Number(rirWordMatch[3]),
    })];
  }

  const tokens = normalizeParserText(text)
    .replace(/,/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const sets = [];
  let currentWeight = null;
  let previousSet = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    // A single space-separated "{weight} {reps} {rir?}" log — "225 5 2", "185 8".
    // Matched against the WHOLE token string at the start ONLY: anchoring to the
    // full text (not a sub-window) is what stops "140 15 190 10" from being
    // mis-segmented as a stray "15 190 10" → 15×190 @10. A longer sequence (more
    // tokens, or any slash) falls through to the weight/slash/bare-pair handling.
    if (i === 0) {
      const single = tokens.join(' ').match(/^(\d+(?:\.\d+)?)\s*(?:lb|lbs)?\s+(\d+)\s*(?:reps?)?\s*(?:rir\s*)?(\d+(?:\.\d+)?)?$/i);
      if (single) {
        sets.push(setRecord({
          weight: Number(single[1]),
          reps: Number(single[2]),
          rir: single[3] == null ? null : Number(single[3]),
        }));
        break;
      }
    }

    const repeat = token.match(/^x(\d+)$/i);
    if (repeat && previousSet) {
      const totalInstances = Number(repeat[1]);
      if (totalInstances > 10) return null;
      for (let copy = 1; copy < totalInstances; copy += 1) {
        sets.push({ ...previousSet });
      }
      continue;
    }

    const slash = token.match(/^(\d+)\/(\d+(?:\.\d+)?)$/);
    if (slash && currentWeight != null) {
      previousSet = setRecord({
        weight: currentWeight,
        reps: Number(slash[1]),
        rir: Number(slash[2]),
      });
      sets.push(previousSet);
      continue;
    }

    const weight = token.match(/^(\d+(?:\.\d+)?)(?:lb|lbs)?$/i);
    const nextSlash = tokens[i + 1]?.match(/^(\d+)\/(\d+(?:\.\d+)?)$/);
    if (weight && nextSlash) {
      currentWeight = Number(weight[1]);
      previousSet = setRecord({
        weight: currentWeight,
        reps: Number(nextSlash[1]),
        rir: Number(nextSlash[2]),
      });
      sets.push(previousSet);
      i += 1;
      continue;
    }

    // Bare "{weight} {reps}" pair (no slash, no RIR) inside a multi-set sequence —
    // e.g. the warm-up climb "140 15 190 10" before the slash working sets. Only
    // fires when this token is a plain weight AND the next token is a plain integer
    // (not a slash, not an xN). The whole-text single-set rule above already
    // claimed a lone "{weight} {reps}"/"{weight} {reps} {rir}", so this never
    // swallows the trailing RIR of a single space-separated set.
    const nextBare = tokens[i + 1]?.match(/^(\d+)$/);
    if (weight && nextBare) {
      currentWeight = Number(weight[1]);
      previousSet = setRecord({ weight: currentWeight, reps: Number(nextBare[1]), rir: null });
      sets.push(previousSet);
      i += 1;
      continue;
    }
  }

  return sets;
}

function parseBodyweightReps(text) {
  const cleaned = normalizeParserText(text);

  // "15 x3" → 3 sets of 15 reps BW
  const repeatMatch = cleaned.match(/^(\d+)\s*x(\d+)$/i);
  if (repeatMatch) {
    const reps = Number(repeatMatch[1]);
    const count = Number(repeatMatch[2]);
    if (count > 10) return [];
    return Array.from({ length: count }, () => setRecord({ weight: null, reps, rir: null, weight_unit: null }));
  }

  // "15/1 x3" → 3 sets of 15 reps @ RIR 1 BW
  const slashRepeatMatch = cleaned.match(/^(\d+)\/(\d+(?:\.\d+)?)\s*x(\d+)$/i);
  if (slashRepeatMatch) {
    const reps = Number(slashRepeatMatch[1]);
    const rir = Number(slashRepeatMatch[2]);
    const count = Number(slashRepeatMatch[3]);
    if (count > 10) return [];
    return Array.from({ length: count }, () => setRecord({ weight: null, reps, rir, weight_unit: null }));
  }

  // "15/1 12/2 10/3" → 3 varied BW sets with RIR
  const slashPairs = [...cleaned.matchAll(/\b(\d+)\/(\d+(?:\.\d+)?)\b/g)];
  if (slashPairs.length > 0) {
    return slashPairs.map(m => setRecord({ weight: null, reps: Number(m[1]), rir: Number(m[2]), weight_unit: null }));
  }

  return [];
}

// "40 40 40" or "40, 40, 40" → bare rep list for unambiguously bodyweight exercises.
// Only called for exercises where external load is never implied (Push-Up).
// Guard: every token must be a plain integer within reps range (1–100) and there
// must be at least two tokens (a single integer is too ambiguous to be a set list).
function parseBareBodyweightReps(text) {
  const cleaned = normalizeParserText(text);
  const tokens = cleaned.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every(t => /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 100)) {
    return tokens.map(t => setRecord({ weight: null, reps: Number(t), rir: null, weight_unit: null }));
  }
  return null;
}

function looksLikeBodyweightRepsOnly(text) {
  const numbers = extractNumbers(text);
  return numbers.length > 1 && numbers.every(value => value > 0 && value <= 100);
}

function extractNumbers(text) {
  return [...String(text || '').matchAll(/\b(\d+(?:\.\d+)?)\b/g)].map(match => Number(match[1]));
}

// Phrases that suggest the lifter wants to correct a previously saved workout
// rather than log a new one. Used by the frontend correction guard so the user
// is offered a choice (replace / log as new / cancel) instead of silently
// appending a duplicate.
const CORRECTION_PATTERNS = /\b(actually\s+i\s+was\s+wrong|correction|change\s+that\s+to|replace\s+that|i\s+meant|sorry\s+i\s+meant|wait\s+i\s+meant|no\s+i\s+meant|actually\s+it\s+was)\b/i;

function looksLikeCorrection(text) {
  return CORRECTION_PATTERNS.test(typeof text === 'string' ? text : '');
}

// Detects end-of-session "log it" triggers — phrases that mean the lifter is
// done logging sets conversationally and wants Atlas to compile the session from
// the chat history into a single preview.
// An OPTIONAL leading closeout-acknowledgment ("done," / "ok" / "that's it") may
// precede the core phrase so natural combined commands ("Done, log it.") close out.
// Mirrors public/app.js looksLikeLogIt (the browser copy) — keep the two in sync.
const LOG_IT_PATTERNS = /^\s*(?:(?:ok(?:ay)?|alright|cool|great|sweet|nice|yep|yeah|done|finished|that'?s\s+(?:it|all)|we'?re?\s+done)[,.\s]+){0,2}(log\s+it|log\s+that|log\s+the\s+session|log\s+this\s+session|log\s+this\s+workout|save\s+the\s+session|save\s+it|ok\s+log\s+it|alright\s+log\s+it|compile\s+(the\s+)?session|that'?s?\s+all|we'?re?\s+done(\s+logging)?|done(\s+for\s+today)?|finish(\s+session)?|end\s+(the\s+)?session)\s*[.!]?\s*$/i;

function looksLikeLogIt(text) {
  // Normalize curly apostrophes (’→') so a mobile-autocorrected "that’s it, log it"
  // matches here too — true parity with the app.js copy's ['’] classes (PR-581 review).
  const t = (typeof text === 'string' ? text : '').replace(/’/g, "'");
  if (/\?\s*$/.test(t)) return false;          // a question ("should I log it?") never closes out
  return LOG_IT_PATTERNS.test(t);
}

module.exports = {
  parseWorkoutText,
  buildWorkoutTextParseDryRunResponse,
  normalizeParserText,
  canonicalizeExerciseName: findExerciseInText,
  splitMultiExerciseSegments,
  looksLikeCorrection,
  looksLikeLogIt
};
