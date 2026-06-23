'use strict';

// Multi-Modality input recognition — Taxonomy §4 (PR 486, slice 1).
//
// Recognizes the NON-slash-notation logging formats (timed holds + steady cardio,
// by duration or distance) into structured fields, so Atlas can later preview /
// route them. This is a SEPARATE, pure recognizer — it deliberately does NOT touch
// `services/workoutTextParser.js` or the slash-notation contract (`225 5/2` =
// 225 lb × 5 reps @ RIR 2). It returns `null` for anything that looks like the
// existing weighted/slash workflow, so the resistance parser is never hijacked.
//
// PURE / read-only: no I/O, no LLM, no Sheets, NO write path, NO Log_Cleaned/Effort
// schema change, NOT wired into the live parse/preview/write path. Wiring (dry-run
// preview) and the [owner-gated] persistence target are later slices. Intervals,
// circuits (AMRAP/EMOM), and added-load bodyweight are deferred to slice 2.

const MODALITIES = Object.freeze(['timed_hold', 'cardio_steady']);

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
  const setsM = t.match(/x\s*(\d+)\s*$/i);
  const { rpe } = extractCommon(t);
  return {
    modality: 'timed_hold',
    exercise: leadName(t) || null,
    duration_sec: dur,
    sets: setsM ? num(setsM[1]) : 1,
    rpe,
  };
}

// steady cardio: a cardio name OR a distance token, no slash set. Carries any of
// duration / distance / elapsed time (mm:ss) / pace / RPE / HR / machine level.
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

/**
 * Recognize a non-slash modality input. Returns a structured record or null
 * (null = let the existing slash-notation / resistance parser handle it).
 * @param {string} text
 * @returns {object|null}
 */
function recognizeModalityInput(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  return recognizeTimedHold(t) || recognizeCardio(t) || null;
}

module.exports = { recognizeModalityInput, MODALITIES };
