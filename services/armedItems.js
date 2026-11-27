'use strict';

// ── Evidence quarantine + armed-item scheduler (Corpus V2 §F.12, issue #1344) ──
// Pure engine-side session state: booked future tests that resurface on
// schedule, and the readiness-limited flag that quarantines a session out of
// progression evidence. No I/O, no LLM, no clock (the caller supplies `today`);
// rows are raw Log_Cleaned rows, normalized inside (analytics.normalizeLogRow).
//
// buildArmedItems({ message, logRows, sessionTally, today }) → {
//   armed_items: [...],        // always an array; [] on a routine turn
//   readiness_applied: bool,   // the turn applied a reported readiness input
//   readiness: null | { limited, hours, source }  // the flag detail
// }
//
// Arming rules (each names its corpus session):
//   - top_single_test (S6): today's top set at the same weight+reps as the
//     most recent prior same-class session, with RIR ≥1 higher, arms the top
//     single for next week. Banked, not spent: the extra reserve licenses the
//     booked test, never an impromptu max.
//   - limiter_test (S8): reps fall across today's sets while RIR stays
//     constant, the athlete cites grip, and a prior session at the same load
//     establishes the baseline → arms a straps isolation test for the next
//     session of that lift.
//   - progression_bump (S9/S14): holdUntilClean one clean session away from
//     loading (N−1 of N) arms the next load, due at the next clean session.
//     Reuses the engine's own counter verbatim — never recomputed.
// Quarantine (S5): a reported low-sleep turn (≤5h) flags the session
// readiness-limited. A better-than-expected read from a flagged session is
// NOT banked — no top-single test is armed from it — because
// readiness-limited sessions are evidence-quarantined: neither progression
// nor regression verdicts are drawn from them. History-derived arms (the
// progression bump) are unaffected: the quarantine covers THIS session's
// evidence, not past sessions' counters. The durable cross-session exclusion
// (a past quarantined session never counting in holdUntilClean) needs a
// per-session marker whose write surface is a Dale ruling — this module
// covers the in-turn flag and the arming; see #1344 determination
// (comment 7206398231).
//
// The caller always emits armed_items itself (empty [] on a routine turn), so
// the corpus detector reads an explicit absence, never an undefined field.
// The items are NOT added to the LLM prompt: the model already receives
// coach_mode + athlete_identity + the readiness prompt rules; the items are
// engine signals for strategy selection and the corpus detector, emitted on
// the response — the same split as signal_flags (#1343).

const { normalizeLogRow } = require('./analytics');
const { sessionContextClass } = require('./comparableSessionSelector');
const { isWarmupNote } = require('./warmupTag');
const { holdUntilClean, DEFAULT_CONFIG, isLowerBodyGroup } = require('../rules/progressionRules');

// S5: "I only got about five hours of sleep" flags the session. Five hours is
// the corpus case; the threshold is the reported-hours number, not a feeling.
const READINESS_SLEEP_LIMIT_HOURS = 5;

const WORD_NUMBERS = {
  a: 1, an: 1,
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9,
};
const NUM = '(\\d+|one|two|three|four|five|six|seven|eight|nine)';

// Explicit sleep reports with an hour count. "five hours of sleep" /
// "5 hours sleep" / "slept 5 hours" / "only got about five hours of sleep".
const SLEEP_PATTERNS = [
  new RegExp(`\\b${NUM}\\s*(?:hours?|hrs?)\\s*(?:of\\s+)?sleep\\b`, 'i'),
  new RegExp(`\\bslept\\s+(?:about\\s+|around\\s+|only\\s+)?${NUM}\\s*(?:hours?|hrs?)\\b`, 'i'),
];
// "no sleep" / "zero sleep" / "didn't get any sleep" — zero hours, limited.
const NO_SLEEP_PATTERN = /\b(?:no|zero|didn'?t get any|not any)\s+sleep\b/i;
// A negated sleep report ("didn't get five hours of sleep") states no number
// the engine can trust — never fires. Same discipline as signalFlags.
const NEGATION_BEFORE = /(?:didn'?t|did not|never|not|no need to|don'?t have to)\s+[^.]{0,20}$/i;
// A sleep report tied to a PAST session ("last week I only got 5 hours
// sleep") is history, not this session's check-in — the marker may sit
// BEFORE the report or AFTER it ("I slept 5 hours last week"), so the
// guard checks a 30-char window on both sides of the match (B1, PR #1816).
// "Yesterday"/"last night" do NOT suppress: last night's sleep IS today's
// readiness input (S5 is reported the morning after).
const PAST_SESSION_MARKERS = /\b(last week|last session|last time)\b/i;
const PAST_SESSION_WINDOW = 30;

// True when a past-session marker sits within the window on either side
// of the match [matchStart, matchEnd).
function _tiedToPastSession(t, matchStart, matchEnd) {
  const beforeStart = Math.max(0, matchStart - PAST_SESSION_WINDOW);
  if (PAST_SESSION_MARKERS.test(t.slice(beforeStart, matchStart))) return true;
  return PAST_SESSION_MARKERS.test(t.slice(matchEnd, matchEnd + PAST_SESSION_WINDOW));
}

function _numValue(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return WORD_NUMBERS[String(s).toLowerCase()] ?? null;
}

// detectReadinessLimited(message) → { limited, hours, source }.
// limited is true only on an explicit low-sleep report (≤5h, or no sleep at
// all) about this session. hours is the reported number (null when no sleep
// report matched at all); source names what the flag rests on.
function detectReadinessLimited(message) {
  const t = String(message === null || message === undefined ? '' : message);
  if (!t.trim()) return { limited: false, hours: null, source: null };
  for (const re of SLEEP_PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    const before = t.slice(0, m.index);
    if (NEGATION_BEFORE.test(before)) continue;
    if (_tiedToPastSession(t, m.index, m.index + m[0].length)) continue;
    const hours = _numValue(m[1]);
    if (hours === null || hours === undefined) return { limited: false, hours: null, source: null };
    // A stated above-threshold night is a definite non-fire, not "try next
    // pattern" — same discipline as signalFlags' message gap.
    return {
      limited: hours <= READINESS_SLEEP_LIMIT_HOURS,
      hours,
      source: 'reported_sleep',
    };
  }
  const noSleep = t.match(NO_SLEEP_PATTERN);
  if (noSleep) {
    const before = t.slice(0, noSleep.index);
    if (!NEGATION_BEFORE.test(before)
      && !_tiedToPastSession(t, noSleep.index, noSleep.index + noSleep[0].length)) {
      return { limited: true, hours: 0, source: 'reported_sleep' };
    }
  }
  return { limited: false, hours: null, source: null };
}

function _isPositiveFinite(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

// Exercise-name match: exact normalized name, plus the parser's known
// singular/plural alias ('Seated Rows' is the same lift as 'Seated Row' —
// services/workoutTextParser.js). Lift codes are NOT used for the
// tally→history join: the tally carries names, and a generated code
// (services/exerciseEnrichment.generateLiftCode) need not equal the code on
// the logged rows.
function _normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function _sameLift(a, b) {
  const na = _normName(a);
  const nb = _normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const singular = (s) => s.replace(/\brows$/, 'row');
  return singular(na) === singular(nb);
}

// Distinct sessions for one lift, chronological, each with its working sets,
// top working weight, and the deload-note tag — the same session shape
// services/comparableSessionSelector.js reasons over. Warm-up-note rows never
// form or join a session. Only sessions strictly before `today` count: the
// tally is today's in-progress session, not yet history.
function _sessionsForLift(rows, liftName, today) {
  const byId = new Map();
  const sorted = [...rows]
    .filter((r) => r && typeof r === 'object'
      && _sameLift(r.canonical_exercise || r.exercise, liftName)
      && _isPositiveFinite(r.weight) && _isPositiveFinite(r.reps)
      && !isWarmupNote(r.notes)
      && String(r.date_clean || '') < String(today || ''))
    .sort((a, b) => (a.date_clean || '').localeCompare(b.date_clean || '')
      || (a.session_id || '').localeCompare(b.session_id || '')
      || (Number(a.set_number) || 0) - (Number(b.set_number) || 0));
  for (const r of sorted) {
    const sid = String(r.session_id || '').trim();
    if (!sid) continue;
    const cur = byId.get(sid) || { session_id: sid, date_clean: r.date_clean || '', rows: [] };
    cur.rows.push(r);
    if (!cur.date_clean && r.date_clean) cur.date_clean = r.date_clean;
    byId.set(sid, cur);
  }
  const sessions = [...byId.values()].sort((a, b) => (a.date_clean || '').localeCompare(b.date_clean || '')
    || a.session_id.localeCompare(b.session_id));
  for (const s of sessions) {
    s.top = s.rows.reduce((m, r) => Math.max(m, Number(r.weight) || 0), 0);
    s.noteTaggedDeload = s.rows.some((r) => /deload/i.test(String(r.notes || '')));
  }
  return sessions;
}

// Today's top set per tally exercise: the last set at the max weight (the
// top set is the heaviest; if several sets share it, the last logged).
function _topSet(sets) {
  const good = (sets || []).filter((s) => s && _isPositiveFinite(s.weight)
    && _isPositiveFinite(s.reps) && Number.isFinite(Number(s.rir)));
  if (!good.length) return null;
  const maxW = Math.max(...good.map((s) => Number(s.weight)));
  const atTop = good.filter((s) => Number(s.weight) === maxW);
  return atTop[atTop.length - 1];
}

// S6 — better than expected: today's top set matches the most recent prior
// same-class session's set at the same weight+reps, with RIR ≥1 higher.
function _detectTopSingle(exercise, sets, rows, today) {
  const top = _topSet(sets);
  if (!top) return null;
  const sessions = _sessionsForLift(rows, exercise, today);
  if (!sessions.length) return null;
  const todaySession = {
    session_id: '',
    date_clean: today,
    top: Number(top.weight),
    noteTaggedDeload: false,
  };
  const todayClass = sessionContextClass(todaySession, sessions);
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const s = sessions[i];
    const match = [...s.rows].reverse().find((r) => Number(r.weight) === Number(top.weight)
      && Number(r.reps) === Number(top.reps)
      && Number.isFinite(Number(r.rir)));
    if (!match) continue;
    if (sessionContextClass(s, sessions.slice(0, i)) !== todayClass) continue;
    if (Number(top.rir) - Number(match.rir) < 1) return null;
    return {
      kind: 'top_single_test',
      lift: exercise,
      weight: Number(top.weight),
      reps: Number(top.reps),
      prior_rir: Number(match.rir),
      rir: Number(top.rir),
      prior_session_date: s.date_clean || null,
      due: 'next_week',
      source: 'better_than_expected',
    };
  }
  return null;
}

// S8 — limiter pattern: reps fall across today's sets while RIR stays
// constant, the athlete cites grip, and a prior session at the same load
// establishes the baseline (today's first-set reps were the norm). A grip
// mention that exonerates grip ("grip feels fine", "grip wasn't the issue")
// never fires: the pattern needs the athlete's report to agree with it.
const GRIP_EXONERATED = /\bgrip\b[^.]{0,40}\b(fine|good|ok|okay|solid|great)\b/i;
const GRIP_NOT_THE_ISSUE = /\bgrip\b[^.]{0,30}\b(was ?n'?t|was not|is ?n'?t|is not)\s+(?:the\s+)?(?:issue|problem|limiter)\b/i;

function _detectLimiter(exercise, sets, rows, today, message) {
  const good = (sets || []).filter((s) => s && _isPositiveFinite(s.weight)
    && _isPositiveFinite(s.reps) && Number.isFinite(Number(s.rir)));
  if (good.length < 2) return null;
  // Only the working load counts: warm-up sets at a lighter weight must not
  // mask the drop (their reps are not the working pattern).
  const maxW = Math.max(...good.map((s) => Number(s.weight)));
  const working = good.filter((s) => Number(s.weight) === maxW);
  if (working.length < 2) return null;
  const msg = String(message || '');
  if (!/\bgrip\b/i.test(msg)) return null;
  if (GRIP_EXONERATED.test(msg) || GRIP_NOT_THE_ISSUE.test(msg)) return null;
  const rirs = working.map((s) => Number(s.rir));
  if (!rirs.every((r) => r === rirs[0])) return null; // reserve moved: not a limiter read
  const firstReps = Number(working[0].reps);
  const minReps = Math.min(...working.map((s) => Number(s.reps)));
  if (!(firstReps > minReps)) return null; // no rep drop
  const sessions = _sessionsForLift(rows, exercise, today);
  const baseline = sessions.length
    && sessions[sessions.length - 1].rows.some((r) => Number(r.weight) === Number(working[0].weight)
      && Number(r.reps) === firstReps);
  if (!baseline) return null;
  return {
    kind: 'limiter_test',
    lift: exercise,
    test: 'straps',
    weight: Number(working[0].weight),
    reps_from: firstReps,
    reps_to: minReps,
    prior_reps: firstReps,
    rir: rirs[0],
    due: 'next_session',
    source: 'limiter_pattern',
  };
}

// Parse holdUntilClean's own progress string ("X of Y clean sessions at Z").
// Same shape services/progressionHistory.js parses; null on any shape it
// does not own.
function _parseCleanProgress(s) {
  const m = /^(\d+)\s+of\s+(\d+)\s+clean sessions at\s+([\d.]+)$/.exec(String(s === null || s === undefined ? '' : s).trim());
  if (!m) return null;
  return { clean_sessions: Number(m[1]), required_sessions: Number(m[2]), load: Number(m[3]) };
}

// S9/S14 — progression bump: one clean session away from the engine's own
// load decision. The next load reuses holdUntilClean's increment rule
// (upper +5 / lower +10 by muscle group) — never a second increment table.
function _detectProgressionBumps(rows) {
  const items = [];
  const codes = [...new Set((rows || [])
    .filter((r) => r && typeof r === 'object' && String(r.lift_code || '').trim())
    .map((r) => String(r.lift_code).trim().toUpperCase()))].sort();
  for (const code of codes) {
    let hc;
    try {
      hc = holdUntilClean(rows, code);
    } catch {
      continue;
    }
    if (!hc || hc.decision !== 'hold') continue;
    const p = _parseCleanProgress(hc.criterion_progress);
    if (!p) continue;
    if (p.required_sessions - p.clean_sessions !== 1) continue;
    const liftRows = rows.filter((r) => r && String(r.lift_code || '').trim().toUpperCase() === code);
    const last = liftRows[liftRows.length - 1];
    const muscleGroup = (last && last.muscle_group) || '';
    const increment = isLowerBodyGroup(muscleGroup)
      ? DEFAULT_CONFIG.load_increment_lower
      : DEFAULT_CONFIG.load_increment_upper;
    const name = (last && (last.canonical_exercise || last.exercise)) || code;
    items.push({
      kind: 'progression_bump',
      lift: name,
      lift_code: code,
      load: p.load,
      next_load: p.load + increment,
      clean_sessions: p.clean_sessions,
      required_sessions: p.required_sessions,
      due: 'next_clean_session',
      source: 'hold_until_clean',
    });
  }
  return items;
}

// Tally exercises in the client's own shape:
// { exercises: [{ exercise, sets, per_set: [{weight, reps, rir}], planned }],
//   total_working_sets } — the authoritative in-session record
// (services/coach.js SESSION-TALLY RULE). Only named exercises with at least
// one finite working set are considered.
function _tallyExercises(sessionTally) {
  const raw = sessionTally && typeof sessionTally === 'object' ? sessionTally : null;
  if (!raw || !Array.isArray(raw.exercises)) return [];
  return raw.exercises
    .filter((e) => e && typeof e === 'object' && String(e.exercise || '').trim()
      && Array.isArray(e.per_set) && e.per_set.some((s) => s && _isPositiveFinite(s.weight) && _isPositiveFinite(s.reps)))
    .map((e) => ({ exercise: String(e.exercise).trim(), sets: e.per_set }));
}

function buildArmedItems(input = {}) {
  const message = typeof input.message === 'string' ? input.message : '';
  const rawRows = Array.isArray(input.logRows) ? input.logRows : [];
  const today = typeof input.today === 'string' && input.today
    ? input.today
    : new Date().toISOString().slice(0, 10);
  const readiness = detectReadinessLimited(message);

  // Normalized working rows (warm-up-note rows excluded — they never form a
  // session, same as the comparable-session selector).
  const rows = rawRows
    .map((r) => normalizeLogRow(r))
    .filter((r) => _isPositiveFinite(r.weight) && _isPositiveFinite(r.reps) && !isWarmupNote(r.notes));

  const items = [];
  const tally = _tallyExercises(input.sessionTally);
  // Top-single tests — SKIPPED on a readiness-limited turn: a
  // better-than-expected read from a quarantined session is not banked (S5).
  if (!readiness.limited) {
    for (const t of tally) {
      const armed = _detectTopSingle(t.exercise, t.sets, rows, today);
      if (armed) items.push(armed);
    }
  }
  // Limiter tests — diagnostic, not progression evidence: the quarantine
  // does not suppress them.
  for (const t of tally) {
    const armed = _detectLimiter(t.exercise, t.sets, rows, today, message);
    if (armed) items.push(armed);
  }
  // Progression bumps — derived from history, not from today's session:
  // the quarantine covers this session's evidence, not past counters.
  items.push(..._detectProgressionBumps(rows));

  return {
    armed_items: items,
    readiness_applied: readiness.limited === true,
    readiness,
  };
}

module.exports = {
  buildArmedItems,
  detectReadinessLimited,
  READINESS_SLEEP_LIMIT_HOURS,
};
