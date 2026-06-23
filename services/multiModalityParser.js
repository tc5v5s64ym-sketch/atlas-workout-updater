'use strict';

// Multi-Modality input recognition — Taxonomy §4 (PR 486, slices 1–2).
//
// Recognizes the NON-slash-notation logging formats (timed holds, steady cardio,
// cardio intervals, and circuits) into structured fields, so Atlas can later
// preview / route them. This is a SEPARATE, pure recognizer — it deliberately does
// NOT touch `services/workoutTextParser.js` or the slash-notation contract
// (`225 5/2` = 225 lb × 5 reps @ RIR 2). It returns `null` for anything that looks
// like the existing weighted/slash workflow, so the resistance parser is never
// hijacked.
//
// PURE / read-only: no I/O, no LLM, no Sheets, NO write path, NO Log_Cleaned/Effort
// schema change, NOT wired into the live parse/preview/write path. Wiring (dry-run
// preview) and the [owner-gated] persistence target are later slices. Added-load
// bodyweight (which carries slash sets) is deferred to a later slice.

const MODALITIES = Object.freeze([
  'timed_hold', 'cardio_steady', 'cardio_interval', 'circuit',
]);

// Names that read as a timed isometric hold (duration is the whole point).
const HOLD_NAME = /\b(plank|wall\s*sit|dead\s*hang|hollow\s*hold|l-?sit|hold|iso(?:metric)?\s*hold|side\s*plank)\b/i;
// Names that read as steady cardio (machine or locomotion).
const CARDIO_NAME = /\b(run(?:ning)?|jog(?:ging)?|walk(?:ing)?|hike|row(?:ing)?|bike|cycl\w*|spin|elliptical|treadmill|stair\s*master|stairmaster|stair\s*climber|airdyne|assault\s*bike|ski\s*erg|erg|swim|ruck)\b/i;

// A weighted/slash-notation set token (e.g. "225 5/2", "8/2", "x3" after a slash
// set). If present, this is the resistance workflow → not ours.
const SLASH_SET = /\d+\s*\/\s*\d+/;

function num(s) { const n = Number(s); return Number.isFinite(n) ? n : null; }

// Shared scalar extractors (all optional, all null when absent).
function extractCommon(t) {
  const rpe = t.match(/\brpe\s*(\d+(?:\.\d+)?)/i);
  const hr = t.match(/\bavg(?:erage)?\s*hr\s*(\d+)/i) || t.match(/\bhr\s*(\d+)/i);
  const level = t.match(/\blevel\s*(\d+)/i);
  return {
    rpe: rpe ? num(rpe[1]) : null,
    avg_hr: hr ? num(hr[1]) : null,
    level: level ? num(level[1]) : null,
  };
}

// Leading exercise name = the words before the first number/keyword token.
function leadName(t) {
  const m = t.match(/^([A-Za-z][A-Za-z\s'-]*?)(?=\s*(?:\d|\+|rpe\b|level\b|avg\b|hr\b))/i);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

function durationToMin(t) {
  const min = t.match(/(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?|mins)\b/i);
  if (min) return num(min[1]);
  const sec = t.match(/(\d+(?:\.\d+)?)\s*(?:sec(?:ond)?s?|secs)\b/i);
  if (sec) return Math.round((num(sec[1]) / 60) * 100) / 100;
  return null;
}
function durationToSec(t) {
  const sec = t.match(/(\d+(?:\.\d+)?)\s*(?:sec(?:ond)?s?|secs)\b/i);
  if (sec) return num(sec[1]);
  const min = t.match(/(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?|mins)\b/i);
  if (min) return Math.round(num(min[1]) * 60);
  return null;
}

// timed hold: a hold-name + a duration, no slash set, no distance.
function recognizeTimedHold(t) {
  if (!HOLD_NAME.test(t)) return null;
  if (SLASH_SET.test(t)) return null;
  const dur = durationToSec(t);
  if (dur == null) return null;
  // Sets multiplier: "x3" / "3x" as a standalone token anywhere in the input
  // (e.g. "Plank 60 sec x3 RPE 7" or "Plank 60 sec RPE 7 x3").
  const setsM = t.match(/(?:\bx\s*(\d+)|\b(\d+)\s*x)\b/i);
  const sets = setsM ? num(setsM[1] || setsM[2]) : null;
  const { rpe } = extractCommon(t);
  return {
    modality: 'timed_hold',
    exercise: leadName(t) || null,
    duration_sec: dur,
    sets: sets != null ? sets : 1,
    rpe,
  };
}

// steady cardio: a cardio name OR a distance token, no slash set. Carries any of
// duration / distance / elapsed time (mm:ss) / RPE / HR / machine level.
const DISTANCE = /(\d+(?:\.\d+)?)\s*(km|mi|mile|miles|meters|m)\b/i;
const ELAPSED = /\b(\d{1,3}:\d{2})\b/;

function recognizeCardio(t) {
  const hasCardioName = CARDIO_NAME.test(t);
  const distM = t.match(DISTANCE);
  if (!hasCardioName && !distM) return null;
  if (SLASH_SET.test(t)) return null; // weighted workflow, not cardio
  const durationMin = durationToMin(t);
  // Require at least one cardio quantity so a bare lift name never matches.
  const elapsed = t.match(ELAPSED);
  if (durationMin == null && !distM && !elapsed) return null;
  const { rpe, avg_hr, level } = extractCommon(t);
  let distance_km = null;
  if (distM) {
    const v = num(distM[1]); const unit = distM[2].toLowerCase();
    if (v != null) {
      if (unit === 'km') distance_km = v;
      else if (unit === 'mi' || unit === 'mile' || unit === 'miles') distance_km = Math.round(v * 1.60934 * 100) / 100;
      else if (unit === 'm' || unit === 'meters') distance_km = Math.round((v / 1000) * 1000) / 1000;
    }
  }
  return {
    modality: 'cardio_steady',
    exercise: leadName(t) || null,
    duration_min: durationMin,
    distance_km,
    elapsed: elapsed ? elapsed[1] : null,
    level,
    rpe,
    avg_hr,
  };
}

// cardio intervals: a "<rounds> x <work>" pattern where work is a distance or a
// time, optionally with a rest token after a slash (e.g. "8 x 400m / 90 sec").
// Longest unit alternatives first so "miles"/"meters" win over "mi"/"m".
const INTERVAL_ROUNDS = /\b(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(km|miles?|mi|meters|m|min(?:ute)?s?|sec(?:ond)?s?)\b/i;
const INTERVAL_REST = /\/\s*(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|mins|sec(?:ond)?s?|secs)\b/i;

function recognizeIntervals(t) {
  if (SLASH_SET.test(t)) return null; // weighted/slash workflow, not ours
  const m = t.match(INTERVAL_ROUNDS);
  if (!m) return null;
  const rounds = num(m[1]);
  const wv = num(m[2]);
  const unit = m[3].toLowerCase();
  let work_distance_m = null;
  let work_sec = null;
  if (wv != null) {
    if (unit === 'km') work_distance_m = Math.round(wv * 1000);
    else if (unit === 'mi' || unit === 'mile' || unit === 'miles') work_distance_m = Math.round(wv * 1609.34);
    else if (unit === 'm' || unit === 'meters') work_distance_m = Math.round(wv);
    else if (/^min/.test(unit)) work_sec = Math.round(wv * 60);
    else if (/^sec/.test(unit)) work_sec = Math.round(wv);
  }
  // Need a real work quantity to be an interval.
  if (work_distance_m == null && work_sec == null) return null;
  const restM = t.match(INTERVAL_REST);
  let rest_sec = null;
  if (restM) {
    const rv = num(restM[1]);
    rest_sec = /^min/i.test(restM[2]) ? Math.round(rv * 60) : Math.round(rv);
  }
  const { rpe, avg_hr } = extractCommon(t);
  return {
    modality: 'cardio_interval',
    exercise: leadName(t) || null,
    rounds,
    work_distance_m,
    work_sec,
    rest_sec,
    rpe,
    avg_hr,
  };
}

// circuits / conditioning: AMRAP / EMOM / circuit / WOD / metcon. Carries an
// optional time cap (mm min), a reported round count, and a colon-delimited list
// of movements. No slash sets (that is the resistance workflow).
const CIRCUIT_KIND = /\b(amrap|emom|circuit|wod|metcon)\b/i;

function recognizeCircuit(t) {
  const kindM = t.match(CIRCUIT_KIND);
  if (!kindM) return null;
  if (SLASH_SET.test(t)) return null; // weighted workflow, not ours
  const kind = kindM[1].toLowerCase();
  const capM = t.match(/(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?|mins)\b/i);
  const roundsM = t.match(/(\d+)\s*rounds?\b/i);
  const { rpe, avg_hr } = extractCommon(t);
  let movements = null;
  const colonIdx = t.indexOf(':');
  if (colonIdx >= 0) {
    // Drop trailing " - 6 rounds RPE 8"-style metadata after a dash.
    const body = t.slice(colonIdx + 1).split(/\s[-–—]\s/)[0];
    const parts = body.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) movements = parts;
  }
  return {
    modality: 'circuit',
    kind, // 'amrap' | 'emom' | 'circuit' | 'wod' | 'metcon'
    cap_min: capM ? num(capM[1]) : null,
    rounds: roundsM ? num(roundsM[1]) : null,
    movements,
    rpe,
    avg_hr,
  };
}

/**
 * Recognize a non-slash modality input. Returns a structured record or null
 * (null = let the existing slash-notation / resistance parser handle it).
 * Order matters:
 *   1. circuits (AMRAP/EMOM/…) — most specific keyword; a circuit may list a
 *      hold movement ("plank 30 sec"), so it must win over the timed-hold check.
 *   2. timed holds — hold-name + duration.
 *   3. intervals — must run before steady cardio, since an interval's distance
 *      token would otherwise be read as steady cardio.
 *   4. steady cardio — the fallback.
 * @param {string} text
 * @returns {object|null}
 */
function recognizeModalityInput(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  return recognizeCircuit(t)
    || recognizeTimedHold(t)
    || recognizeIntervals(t)
    || recognizeCardio(t)
    || null;
}

module.exports = { recognizeModalityInput, MODALITIES };
