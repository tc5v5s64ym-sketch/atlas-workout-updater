'use strict';

// Coach Voice Renderer — deterministic set-feedback voice (Training Intelligence
// series, Coach Voice Renderer slice 1).
//
// PURE. No I/O, no LLM, no Sheets, no writes. Given the engine's set-effort
// analysis (services/setEffortSignals.js → analyzeSetSequence), the optional
// reroute conflict (assessNextMoveConflict), the recommendation engine's effort
// verdict, and the candidate generic/LLM prose, it decides the AUTHORITATIVE
// set-reaction voice:
//
//   - primary_line            the deterministic reaction line to show
//   - secondary_line          optional suggestion-only reroute line (never mutates a plan)
//   - severity                'block' | 'caution' | 'bump' | 'on_target' | 'hard' | 'neutral'
//   - reason_codes            the engine's codes, verbatim
//   - suppress_generic_prose  true when a non-neutral fatigue/underdose signal owns
//                             the reaction — generic/LLM prose must NOT speak over it
//   - contradictions          [{code, phrase}] found in the candidate prose that
//                             contradict the engine's reason codes (testable guard)
//
// CORE PRINCIPLE: the deterministic engine decides the coaching MEANING. The LLM
// may add tone only on a clean/neutral set; it may never contradict a redline,
// rep-drop, pressing-yellow, high-RIR underdose, or isolation caution. If the
// engine has an opinion, the engine wins.
//
// Scope (slice 1): current weighted/RIR set-feedback only. No parser change, no
// schema change, no write-path change, plan routing stays suggestion-only. The
// LLM prompt is untouched; suppression/override happens at the response boundary.

const { effortNote, rerouteNote } = require('./setEffortCopy');
const { EFFORT_REASON_CODES } = require('./setEffortSignals');

// Owner-approved correct-effort praise (COACH_VOICE_VALIDATION.md / setEffortCopy
// tonal anchors): praise the CORRECT effort, never the suffering.
const ON_TARGET_PRAISE = 'Dialled in — that landed right on target.';

// Fallbacks if the engine copy is ever empty (defensive — effortNote covers these).
const BLOCK_FALLBACK = 'That counted, but it does not earn more weight.';
const HOLD_CLAUSE = 'Hold the load and clean up reps.';

// ── Forbidden-contradiction phrase banks ──────────────────────────────────────
// Phrases that contradict a deterministic signal. Matched case-insensitively
// against the candidate generic/LLM prose; any hit means the prose is lying about
// what the engine measured, so it is suppressed.

// Progression hype — contradicts a redline / rep-drop / pressing-yellow HOLD.
const PROGRESSION_HYPE = [
  /push(ing)?\s+(it\s+)?harder/i,
  /keep\s+pushing/i,
  /keep\s+grinding/i,
  /add(ing)?\s+(more\s+)?(weight|load)/i,
  /more\s+weight/i,
  /go\s+heavier/i,
  /load\s+up/i,
  /(right\s+)?on\s+track/i,
  /right\s+where\s+you\s+want/i,
  /good\s+to\s+(add|go\s+up|load)/i,
  /crushed\s+it/i,
  /smashed\s+it/i,
  /nailed\s+it/i,
  /great\s+(job|set|work)/i,
  /perfect\s+set/i,
  /new\s+pr/i,
];

// On-target/perfect claims — contradict a HIGH-RIR UNDERDOSE (it was too easy).
const ON_TARGET_CLAIM = [
  /right\s+on\s+target/i,
  /on\s+the\s+money/i,
  /dial+ed\s+in/i,
  /perfect/i,
  /nailed\s+it/i,
  /bang\s+on/i,
  /exactly\s+(right|where)/i,
];

// Sandbag scolding — must NEVER be applied to a warmup/feeder set.
const SANDBAG = [
  /sandbag/i,
  /too\s+easy/i,
  /barely\s+registered/i,
  /under-?effort/i,
  /not\s+(really\s+)?trying/i,
  /phoning\s+it\s+in/i,
  /left\s+too\s+much/i,
];

/**
 * Pure contradiction guard. Given the engine's reason codes and a candidate prose
 * string, return every banned phrase the prose contains that contradicts a code.
 *
 * @param {string[]} reasonCodes
 * @param {string} prose
 * @returns {Array<{code:string, phrase:string}>}
 */
function findForbiddenContradictions(reasonCodes, prose) {
  const text = typeof prose === 'string' ? prose : '';
  if (!text.trim() || !Array.isArray(reasonCodes) || reasonCodes.length === 0) return [];
  const codes = new Set(reasonCodes);
  const out = [];
  const check = (code, patterns) => {
    if (!codes.has(code)) return;
    for (const re of patterns) {
      const m = text.match(re);
      if (m) out.push({ code, phrase: m[0] });
    }
  };
  // Bind to the engine's frozen reason-code map (not string literals) so a rename
  // in setEffortSignals.js can't silently stop this trust-critical guard from
  // firing. A redline / rep-drop / pressing-yellow means HOLD — any progression
  // hype lies.
  check(EFFORT_REASON_CODES.REDLINE_SET, PROGRESSION_HYPE);
  check(EFFORT_REASON_CODES.REP_DROP_AFTER_REDLINE, PROGRESSION_HYPE);
  check(EFFORT_REASON_CODES.PRESSING_READINESS_YELLOW, PROGRESSION_HYPE);
  // A high-RIR working set was UNDER target — calling it perfect/on-target lies.
  check(EFFORT_REASON_CODES.HIGH_RIR_WORKSET_UNDERDOSED, ON_TARGET_CLAIM);
  // A warmup/feeder set must never be scolded as sandbagging.
  check(EFFORT_REASON_CODES.WARMUP_FEEDER_IGNORED, SANDBAG);
  return out;
}

// Deterministic severity. Negative fatigue/underdose signals (from the set-effort
// engine) take precedence over the recommendation engine's positive effort verdict
// — a redline is never "on target", even if the lone working set hit its RIR.
function classifySeverity(analysis, recVerdict) {
  if (analysis && typeof analysis === 'object') {
    if (analysis.progression_verdict === 'block') return 'block';
    if (analysis.progression_verdict === 'caution') return 'caution';
    if (analysis.progression_verdict === 'bump') return 'bump';
  }
  const level = recVerdict && recVerdict.level;
  if (level === 'on_target') return 'on_target';
  if (level === 'hard') return 'hard';
  return 'neutral';
}

/**
 * Render the authoritative set-reaction voice.
 *
 * @param {object} input
 * @param {object|null} input.analysis      - analyzeSetSequence output for the logged lift.
 * @param {object|null} input.conflict      - assessNextMoveConflict output (reroute).
 * @param {object|null} input.recVerdict    - rec.effort_verdict ({ level }) for the set.
 * @param {string}      input.candidateProse- the generic/LLM prose to vet (may be '').
 * @returns {object} voice (see module header).
 */
function renderSetVoice({ analysis = null, conflict = null, recVerdict = null, candidateProse = '' } = {}) {
  const reason_codes = analysis && Array.isArray(analysis.reason_codes) ? analysis.reason_codes.slice() : [];
  const severity = classifySeverity(analysis, recVerdict);
  const observation = effortNote(analysis); // null on neutral, warmup-only, or on-target
  const secondary_line = rerouteNote(conflict) || null;

  let primary_line = null;
  let suppress_generic_prose = false;

  if (severity === 'block') {
    // A heavy-compound redline / rep-drop. The engine's observation, plus an
    // explicit HOLD so the lifter doesn't read silence as "add weight".
    const base = observation || BLOCK_FALLBACK;
    primary_line = /hold/i.test(base) ? base : `${base} ${HOLD_CLAUSE}`;
    suppress_generic_prose = true;
  } else if (severity === 'caution') {
    // Isolation taken to failure — caution only, never a heavy-compound block.
    primary_line = observation;
    suppress_generic_prose = true;
  } else if (severity === 'bump') {
    // A working set left well above target — under-dosed; a bump is coming.
    primary_line = observation;
    suppress_generic_prose = true;
  } else if (severity === 'on_target') {
    // Correct effort. In the weighted/RIR set-feedback lane the deterministic
    // voice OWNS this too — short, consistent Atlas voice, not a paragraph of
    // generic LLM prose. Praise the execution, not heroics, and suppress the
    // prose (the next-recommendation card still carries the numbers).
    primary_line = ON_TARGET_PRAISE;
    suppress_generic_prose = true;
  } else if (severity === 'hard') {
    // A tough set right at target — correct effort, not a redline. No
    // contradiction is possible (no negative signal), so the LLM may still add
    // tone; this praise line is the deterministic floor / LLM-down path.
    primary_line = ON_TARGET_PRAISE;
    suppress_generic_prose = false;
  } else {
    // neutral — nothing the engine wants to say; defer entirely to the prose.
    primary_line = null;
    suppress_generic_prose = false;
  }

  const contradictions = findForbiddenContradictions(reason_codes, candidateProse);

  return {
    primary_line: primary_line || null,
    secondary_line,
    severity,
    reason_codes,
    suppress_generic_prose,
    contradictions,
  };
}

module.exports = { renderSetVoice, findForbiddenContradictions };
