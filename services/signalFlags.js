'use strict';

// ── Emotion/adherence signal flags (Corpus V2 §F.11, issue #1343) ─────────────
// Pure engine-side detection so strategy selection isn't left to model
// improvisation. No I/O, no LLM, no clock (the caller supplies the layoff read).
//
// detectSignalFlags({ message, stalls, layoff, constraints }) → flags[]
//   One flag per firing dimension, in §F.11 order (gap, truncation, sentiment,
//   sensitivity). A dimension that doesn't fire contributes nothing — the
//   caller always emits the array itself (empty `[]` on a routine turn), so the
//   corpus detector reads an explicit absence, never an undefined field.
//
//   - gap_return: the lifter is returning after time off. History-derived via
//     the caller's layoff read (services/layoffGuard.assessLayoff — same 7-day
//     threshold), or message-stated ("it's been 9 days", "back after three
//     weeks off") when the stated gap is >= 7 days. Future plans ("three weeks
//     to 205") never fire: every pattern requires past-absence phrasing.
//   - truncation: the turn reports a cut-short session, with the #1341 cause
//     vocabulary (time | deliberate | truncated). Explicit phrases only,
//     mirroring services/discouragementSignal.js discipline: a negated phrase
//     ("didn't have to cut it short") never fires, and a question about
//     cutting short ("should I cut it short?") is a request, not a report.
//   - sentiment_discouragement: reuses detectDiscouragement verbatim — its
//     phrase, negation, and interrogative guards are settled behaviour, not
//     re-implemented here. Fires only on an explicit discouragement phrase.
//   - sensitivity_match: the turn touches a RECORDED injury constraint
//     (Constraints tab, kind 'injury' — the fixed vocabulary in
//     services/coach.js CONSTRAINT_KINDS/CONSTRAINT_RULES). Matches when the
//     message contains the constraint's target as a whole word/phrase. There
//     is no sensitivity store beyond recorded constraints: an unrecorded
//     body part never fires, and the flag names the constraint it matched.
//
// The flags drive strategy selection (the chat path passes the layoff read into
// selectCoachMode) and the corpus detector (services/corpusBaseline.js reads
// data.signal_flags). They are NOT added to the LLM prompt: the model already
// receives coach_mode + athlete_identity + the layoff prompt rules, and the
// flags are engine signals, not new prompt content.

const { detectDiscouragement } = require('./discouragementSignal');

// Same 7-day return threshold as services/layoffGuard.js RETURN_THRESHOLD_DAYS.
const GAP_THRESHOLD_DAYS = 7;

// Message-stated gap: past-absence phrasing only. Captures the number + unit.
// "it's been 9 days" / "it has been 2 weeks" / "haven't lifted in 3 weeks" /
// "back after three weeks off" / "9 days off" (bare "N days off" counts — it
// states an absence, not a plan). Word numbers 1-9 supported; digits any size.
const WORD_NUMBERS = {
  a: 1, an: 1,
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9,
};
const NUM = '(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine)';
const MESSAGE_GAP_PATTERNS = [
  new RegExp(`\\bit'?s been ${NUM} (day|week)`, 'i'),
  new RegExp(`\\bit has been ${NUM} (day|week)`, 'i'),
  new RegExp(`\\bhaven'?t (?:lifted|trained|worked out|been (?:in|to) the gym) (?:in |for )?${NUM} (day|week)`, 'i'),
  new RegExp(`\\bback after ${NUM} (day|week)`, 'i'),
  new RegExp(`\\b${NUM} (day|week)s? off\\b`, 'i'),
];

// Truncation: explicit cut-short reports. Each entry carries its #1341 cause.
// 'time' — the reason given is time ("ran out of time", "tones dropped").
// 'deliberate' — the lifter chose to stop ("decided to call it", "called it a day").
// 'truncated' — cut short with no cause stated ("had to bail", "couldn't finish").
const TRUNCATION_PATTERNS = [
  { re: /\bran out of time\b/i, cause: 'time' },
  { re: /\btones dropped\b/i, cause: 'time' },
  { re: /\bhad to (?:bail|leave early|cut out early|stop early)\b/i, cause: 'truncated' },
  { re: /\bcut (?:it|today|the session|things) short\b/i, cause: 'truncated' },
  { re: /\bcouldn'?t finish\b/i, cause: 'truncated' },
  { re: /\bhad to cut\b/i, cause: 'truncated' },
  { re: /\bdecided to (?:stop|call it|cut)\b/i, cause: 'deliberate' },
  { re: /\bcalled it (?:a day|early)\b/i, cause: 'deliberate' },
  { re: /\bchose to stop\b/i, cause: 'deliberate' },
];

// A negated truncation report ("didn't have to cut it short") never fires.
const NEGATION_BEFORE = /(?:didn'?t|did not|never|not|no need to|don'?t have to)\s+[^.]{0,20}$/i;
// A truncation reported for a PAST session ("cut it short last week") is
// history, not this turn's signal — the flag must not misattribute it to the
// current session. Window-scoped (see _detectTruncation): only a marker near
// the phrase counts, so "yesterday I felt great, today I had to cut it
// short" still fires on the today-report.
const PAST_SESSION_MARKERS = /\b(last week|yesterday|last session|last time|last night)\b/i;
// A question about cutting short ("should I cut it short?") is a request, not
// a report. Only a leading interrogative suppresses — a report followed by a
// question ("had to cut it short — should I make it up?") still fires.
const LEADING_INTERROGATIVE = /^(?:should|can|could|would|shall|may|do|is|are|what if)\b/i;

function _numValue(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return WORD_NUMBERS[String(s).toLowerCase()] ?? null;
}

function _daysFromMatch(numStr, unit) {
  const n = _numValue(numStr);
  if (n === null || n === undefined) return null;
  return unit && unit.toLowerCase().startsWith('week') ? n * 7 : n;
}

function _escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _detectMessageGap(message) {
  const t = String(message === null || message === undefined ? '' : message);
  for (const re of MESSAGE_GAP_PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    const days = _daysFromMatch(m[1], m[2]);
    if (days !== null && days !== undefined && days >= GAP_THRESHOLD_DAYS) {
      return { kind: 'gap_return', days_since_last_session: days, severity: null, source: 'message' };
    }
    return null; // a stated sub-threshold gap is a definite non-fire, not "try next pattern"
  }
  return null;
}

function _detectTruncation(message) {
  const t = String(message === null || message === undefined ? '' : message).trim();
  if (!t) return null;
  if (LEADING_INTERROGATIVE.test(t)) return null;
  for (const { re, cause } of TRUNCATION_PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    const before = t.slice(0, m.index);
    if (NEGATION_BEFORE.test(before)) continue;
    // Past-session report? A past marker NEAR the phrase (within 30 chars
    // before the match or 20 after it) ties the truncation to a past session.
    // "yesterday I felt great, today I had to cut it short" still fires:
    // "yesterday" sits far before this match, outside the window.
    const windowStart = Math.max(0, m.index - 30);
    const windowEnd = m.index + m[0].length + 20;
    if (PAST_SESSION_MARKERS.test(t.slice(windowStart, windowEnd))) continue;
    return { kind: 'truncation', cause };
  }
  return null;
}

function _detectSensitivity(message, constraints) {
  const t = String(message === null || message === undefined ? '' : message);
  if (!t) return null;
  const rows = Array.isArray(constraints) ? constraints : [];
  for (const c of rows) {
    if (!c || typeof c !== 'object') continue;
    if (String(c.kind || '').trim().toLowerCase() !== 'injury') continue;
    if (!['avoid', 'limit', 'substitute'].includes(String(c.rule || '').trim().toLowerCase())) continue;
    const target = String(c.target || '').trim();
    if (!target) continue;
    // Single-word targets match their plural too ("knees" matches a 'knee'
    // constraint); multi-word targets match as the whole phrase.
    const pattern = target.includes(' ') ? _escapeRegExp(target) : `${_escapeRegExp(target)}s?`;
    const re = new RegExp(`\\b${pattern}\\b`, 'i');
    if (re.test(t)) {
      return { kind: 'sensitivity_match', constraint: { kind: 'injury', target, rule: String(c.rule).trim().toLowerCase() } };
    }
  }
  return null;
}

function detectSignalFlags(input = {}) {
  const message = typeof input.message === 'string' ? input.message : '';
  const stalls = Array.isArray(input.stalls) ? input.stalls : [];
  const flags = [];

  // 1. Gap length — history-derived first (the engine's own read wins over a
  //    stated number when both exist); message-stated only as a fallback.
  const layoff = input.layoff && typeof input.layoff === 'object' ? input.layoff : null;
  if (layoff && layoff.returning_from_layoff === true) {
    flags.push({
      kind: 'gap_return',
      days_since_last_session: typeof layoff.days_since_last_session === 'number' ? layoff.days_since_last_session : null,
      severity: typeof layoff.severity === 'string' ? layoff.severity : null,
      source: 'history',
    });
  } else {
    const stated = _detectMessageGap(message);
    if (stated) flags.push(stated);
  }

  // 2. Truncation cause.
  const trunc = _detectTruncation(message);
  if (trunc) flags.push(trunc);

  // 3. Sentiment cue — detectDiscouragement verbatim, with its own guards.
  const d = detectDiscouragement(message, { stalls });
  if (d && d.discouraged === true) {
    flags.push({ kind: 'sentiment_discouragement', cue: d.kind || 'frustration', matched: d.matched || null });
  }

  // 4. Sensitivity match against recorded injury constraints.
  const sens = _detectSensitivity(message, input.constraints);
  if (sens) flags.push(sens);

  return flags;
}

module.exports = { detectSignalFlags, GAP_THRESHOLD_DAYS };
