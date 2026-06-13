const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

const EXERCISE_ALIASES = [
  ['Incline DB Press', ['incline dumbbell press', 'incline db press', 'incline db', 'db incline', 'incline press', 'incline']],
  ['Bench Press', ['bench press', 'barbell bench', 'flat bench', 'bb bench', 'bench', 'bp']],
  ['Back Squat', ['back squat', 'bb squat', 'squats', 'squat', 'bs']],
  ['Deadlift', ['deadlift', 'dead', 'dl']],
  ['RDL', ['romanian deadlift', 'romanian dl', 'rdl']],
  ['Overhead Press', ['overhead press', 'military press', 'standing press', 'strict press', 'overhead', 'ohp']],
  ['Lat Pulldown', ['lat pulldown', 'lat pull', 'pull down', 'pulldown', 'lats']],
  ['Seated Row', ['seated row', 'cable row', 'machine row']],
  ['Bent-Over Row', ['bent-over row', 'bent over row', 'bent row', 'reverse-grip row', 'reverse row', 'bor']],
  ['Hammer Curl', ['hammer curls', 'hammer curl', 'hammers', 'hammer']],
  ['Face Pull', ['face pulls', 'face pull']],
  ['Leg Curl', ['hamstring curl', 'leg curls', 'ham curls', 'leg curl']],
  ['Single-Leg Seated Leg Press', ['seated single leg press', 'single-leg press', 'single leg press', 'slp']],
  ['Hanging Knee Raises', ['hanging knee raises', 'captains chair', 'captain chair', 'knee raises', 'kr']],
  ['Lateral Raises', ['lateral raises', 'lateral raise', 'side raises', 'laterals', 'lateral']],
  ['Dips (Weighted)', ['weighted dips', 'dips', 'dip', 'wd']],
];

const AMBIGUOUS_ALIASES = {
  press: 'Which press - OHP, bench, or incline?',
  row: 'Which row - seated, bent-over, cable, or machine?',
  rows: 'Which row - seated, bent-over, cable, or machine?',
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

function parseWorkoutText(input, context = {}) {
  const rawText = normalizeParserText(input);
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

  return parseLogSets(rawText, context);
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

function parseLogSets(rawText, context = {}) {
  if (hasMultipleExerciseMentions(rawText)) {
    return {
      intent: 'needs_clarification',
      raw_text: rawText,
      message: 'This looks like mixed exercise input. Log one exercise at a time or split the exercises first.',
      warnings: ['multiple_exercises_in_input'],
    };
  }

  const exercise = findExerciseInText(rawText);
  if (exercise?.ambiguous) {
    return {
      intent: 'needs_clarification',
      raw_text: rawText,
      message: exercise.message,
      warnings: ['ambiguous_exercise_alias'],
    };
  }

  if (!exercise) {
    if (context.activeExercise) {
      return parseWithExercise(rawText, {
        canonicalName: context.activeExercise,
        rawName: context.activeExercise,
        rest: rawText,
      });
    }
    const unknownExercise = parseUnknownExercise(rawText);
    if (unknownExercise) return unknownExercise;
    return {
      intent: 'needs_clarification',
      raw_text: rawText,
      message: 'Which exercise is this for?',
      warnings: ['missing_exercise'],
    };
  }

  if (exercise.canonicalName === 'Hanging Knee Raises') {
    const bodyweightSets = parseBodyweightReps(exercise.rest);
    if (bodyweightSets.length) {
      return buildLogResult({
        rawText,
        rawName: titleCaseFallback(exercise.rawName),
        canonicalName: exercise.canonicalName,
        sets: bodyweightSets,
      });
    }
  }

  if (exercise.canonicalName === 'Hanging Knee Raises' && looksLikeBodyweightRepsOnly(exercise.rest)) {
    const reps = extractNumbers(exercise.rest).map(value => setRecord({ weight: null, reps: value, rir: null, weight_unit: null }));
    return {
      intent: 'needs_clarification',
      raw_text: rawText,
      message: 'Knee raises: do you mean bodyweight reps 20, 15, 15?',
      partial: {
        exercise: exercise.canonicalName,
        raw_name: exercise.rawName,
        sets: reps,
      },
      warnings: ['missing_weight_or_bodyweight_context'],
    };
  }

  return parseWithExercise(rawText, exercise);
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
    .replace(/\s+/g, ' ')
    .trim();

  return parseDumbbellSlashRepeats(cleaned)
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

function extractUnknownExerciseLead(rawText) {
  const tokens = normalizeParserText(rawText).split(/\s+/).filter(Boolean);
  const start = tokens.findIndex(token => looksLikeSetToken(token));
  if (start <= 0) return null;

  const rawName = tokens
    .slice(0, start)
    .join(' ')
    .replace(/^\s*(today|i did|did|was|were|then|and)\s+/i, '')
    .trim();
  if (!rawName) return null;

  return {
    rawName,
    rest: tokens.slice(start).join(' ').trim(),
  };
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

    const appStyle = tokens.slice(i).join(' ').match(/^(\d+(?:\.\d+)?)\s*(?:lb|lbs)?\s+(\d+)\s*(?:reps?)?\s*(?:rir\s*)?(\d+(?:\.\d+)?)?$/i);
    if (appStyle && sets.length === 0) {
      previousSet = setRecord({
        weight: Number(appStyle[1]),
        reps: Number(appStyle[2]),
        rir: appStyle[3] == null ? null : Number(appStyle[3]),
      });
      sets.push(previousSet);
      break;
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
const LOG_IT_PATTERNS = /^\s*(log\s+it|log\s+that|log\s+the\s+session|log\s+this\s+session|log\s+this\s+workout|save\s+the\s+session|save\s+it|ok\s+log\s+it|alright\s+log\s+it|compile\s+(the\s+)?session|that'?s?\s+all|we'?re?\s+done(\s+logging)?|done(\s+for\s+today)?|finish(\s+session)?|end\s+(the\s+)?session)\s*[.!]?\s*$/i;

function looksLikeLogIt(text) {
  return LOG_IT_PATTERNS.test(typeof text === 'string' ? text : '');
}

module.exports = {
  parseWorkoutText,
  buildWorkoutTextParseDryRunResponse,
  normalizeParserText,
  canonicalizeExerciseName: findExerciseInText,
  looksLikeCorrection,
  looksLikeLogIt
};
