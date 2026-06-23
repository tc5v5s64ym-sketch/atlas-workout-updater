'use strict';

// Modality_Log row builder — PR 486 slice 4b.
//
// Reconciles a `recognizeModalityInput()` record (services/multiModalityParser.js)
// into the canonical `Modality_Log` column contract (config/columns.js). The
// recognizer emits per-modality field names in MIXED units (duration_min / km /
// work_sec / work_distance_m / elapsed mm:ss / sets); this module normalizes them
// to the tab's `duration_sec` / `distance_m` / `rounds` columns so a write never
// misroutes a value or persists the wrong unit.
//
// PURE: no I/O, no Sheets, no LLM. Returns plain data; the write route owns the
// trust loop, idempotency, and the actual append.

const { modalityLogColumns } = require('../config/columns');

function num(v) { return Number.isFinite(v) ? v : null; }

// "mm:ss" or "h:mm:ss" → total seconds (null if unparseable).
function elapsedToSec(s) {
  if (typeof s !== 'string') return null;
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.length === 2
    ? nums[0] * 60 + nums[1]
    : nums[0] * 3600 + nums[1] * 60 + nums[2];
}

/**
 * Normalize a recognizer record into the canonical Modality_Log field set.
 * `modality` discriminates how the shared metric columns are filled.
 * @param {object} record  a recognizeModalityInput() result
 * @returns {object|null}
 */
function normalizeModalityRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const m = record.modality;
  const out = {
    modality: m || null,
    exercise: record.exercise || null,
    duration_sec: null,
    distance_m: null,
    rounds: null,
    rest_sec: null,
    level: num(record.level),
    rpe: num(record.rpe),
    avg_hr: num(record.avg_hr),
    notes_extra: null,
  };

  if (m === 'timed_hold') {
    out.duration_sec = num(record.duration_sec);
    out.rounds = num(record.sets); // a hold's "sets" are its rounds
  } else if (m === 'cardio_steady') {
    out.duration_sec = record.duration_min != null
      ? Math.round(record.duration_min * 60)   // min → sec
      : elapsedToSec(record.elapsed);          // fall back to elapsed mm:ss
    out.distance_m = record.distance_km != null ? Math.round(record.distance_km * 1000) : null; // km → m
    if (record.elapsed) out.notes_extra = `elapsed ${record.elapsed}`;
  } else if (m === 'cardio_interval') {
    out.rounds = num(record.rounds);
    out.duration_sec = num(record.work_sec);          // per-rep work time
    out.distance_m = num(record.work_distance_m);     // per-rep work distance (already metres)
    out.rest_sec = num(record.rest_sec);
  } else if (m === 'circuit') {
    out.exercise = record.kind ? String(record.kind).toUpperCase() : (record.exercise || null);
    out.duration_sec = record.cap_min != null ? Math.round(record.cap_min * 60) : null; // time cap min → sec
    out.rounds = num(record.rounds);
    if (Array.isArray(record.movements) && record.movements.length) {
      out.notes_extra = record.movements.join('; ');
    }
  } else {
    return null; // unknown modality → not persistable
  }
  return out;
}

function cell(v) { return v == null ? '' : v; }

/**
 * Build the ordered Modality_Log row (matching modalityLogColumns) from a
 * recognizer record + the write envelope. Caller `notes` and any structured
 * extra (elapsed, circuit movements) are merged into the notes column (≤200 chars).
 * @returns {Array|null}  ordered row, or null if the record is not persistable
 */
function toModalityLogRow(record, envelope = {}) {
  const norm = normalizeModalityRecord(record);
  if (!norm) return null;
  const { date, session_id, notes } = envelope;

  const noteParts = [];
  if (notes) noteParts.push(String(notes).trim());
  if (norm.notes_extra) noteParts.push(norm.notes_extra);
  const noteStr = noteParts.filter(Boolean).join(' | ').slice(0, 200);

  const byCol = {
    date: cell(date),
    session_id: cell(session_id),
    modality: cell(norm.modality),
    exercise: cell(norm.exercise),
    duration_sec: cell(norm.duration_sec),
    distance_m: cell(norm.distance_m),
    rounds: cell(norm.rounds),
    rest_sec: cell(norm.rest_sec),
    level: cell(norm.level),
    rpe: cell(norm.rpe),
    avg_hr: cell(norm.avg_hr),
    notes: noteStr,
  };
  return modalityLogColumns.map((col) => byCol[col]);
}

module.exports = { normalizeModalityRecord, toModalityLogRow, elapsedToSec };
