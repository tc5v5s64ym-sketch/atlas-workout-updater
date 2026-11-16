'use strict';

// ── Coaching-note save grounding (Fable P3 B-18) ──────────────────────────────
//
// Pure, deterministic helpers for POST /api/coaching-notes. No I/O, no LLM, no
// clock, no writes.
//
// B-18: a model-proposed note carrying invented numbers ("Cap all pressing at
// 317 x 13") was saved verbatim on one tap — the client shows the note first,
// but shown-first does not make model numbers grounded, and the boundary rule
// is that model numbers never PERSIST ungrounded. The coordinator design
// (issue #1742, comment 6861404353) puts the check at the save, on the exact
// text being stored: any number in the note must match the session's bound
// facts (today's logged values) or the save is refused and the note is returned
// for editing. A proposal-side gate alone would not suffice — the client (or
// the athlete editing the shown note) can put invented numbers into the text
// between proposal and save.
//
// Bound facts are the session's logged values: today's Log_Cleaned rows
// (set_number, weight, reps, rir, volume_calc) and today's Effort row
// (duration, active/total calories, average/peak HR). Prescribed-but-not-yet-
// logged plan numbers are NOT in this set — a note quoting them is refused
// until the work is logged (the athlete can always edit the numbers out and
// save); plan-prescription grounding is a follow-up if the coordinator wants
// it. Number comparison is numeric, so "135.0" grounds against a logged 135.
//
// extractNoteNumbers / collectSessionBoundNumbers / findUngroundedNumbers /
// groundCoachingNote are the whole surface.

const { logCleanedColumns, effortColumns } = require('../config/columns');

// Numeric columns of a Log_Cleaned row that count as bound facts for the
// session the row belongs to.
const LOG_FACT_FIELDS = ['set_number', 'weight', 'reps', 'rir', 'volume_calc'];
// Numeric columns of an Effort row that count as bound facts.
const EFFORT_FACT_FIELDS = ['duration', 'active_calories', 'total_calories', 'average_hr', 'peak_hr'];

function toNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Every number token in the text, in order. Deliberately NOT word-boundary
// anchored: "135x8" carries two numbers (135 and 8), and a \b regex would
// miss the 8 after the "x". Numbers embedded in words ("B2B") also extract —
// the gate is fail-closed, so over-extraction only ever refuses more, never
// lets an invented number through.
function extractNoteNumbers(text) {
  const matches = String(text === null || text === undefined ? '' : text).match(/\d+(?:\.\d+)?/g);
  return (matches || []).map((m) => Number(m));
}

// Cell value of a sheet row (array in column order, or object keyed by column
// name) for a named column.
function rowCell(row, columns, field) {
  if (!row || typeof row !== 'object') return null;
  if (Array.isArray(row)) {
    const idx = columns.indexOf(field);
    return idx >= 0 ? row[idx] : null;
  }
  return Object.prototype.hasOwnProperty.call(row, field) ? row[field] : null;
}

// Row date of a sheet row (array: first column; object: date/date_clean).
function rowDate(row) {
  if (!row || typeof row !== 'object') return null;
  if (Array.isArray(row)) return row[0] === null || row[0] === undefined ? null : String(row[0]);
  return row.date_clean !== null && row.date_clean !== undefined
    ? String(row.date_clean)
    : (row.date !== null && row.date !== undefined ? String(row.date) : null);
}

// The session's bound facts: every number in the numeric columns of today's
// Log_Cleaned and Effort rows. Rows dated any other day are not this session's
// facts — a number from last week's session does not ground today's note.
function collectSessionBoundNumbers({ logRows, effortRows, date }) {
  const bound = new Set();
  const day = date === null || date === undefined ? null : String(date);
  for (const row of (Array.isArray(logRows) ? logRows : [])) {
    if (day !== null && rowDate(row) !== day) continue;
    for (const field of LOG_FACT_FIELDS) {
      const n = toNum(rowCell(row, logCleanedColumns, field));
      if (n !== null) bound.add(n);
    }
  }
  for (const row of (Array.isArray(effortRows) ? effortRows : [])) {
    if (day !== null && rowDate(row) !== day) continue;
    for (const field of EFFORT_FACT_FIELDS) {
      const n = toNum(rowCell(row, effortColumns, field));
      if (n !== null) bound.add(n);
    }
  }
  return bound;
}

// The numbers in the text that do not match any bound fact, in first-seen
// order, deduplicated. Empty means every number in the text is grounded (or
// the text has no numbers at all).
function findUngroundedNumbers(text, boundNumbers) {
  const bound = boundNumbers instanceof Set ? boundNumbers : new Set(boundNumbers || []);
  const ungrounded = [];
  for (const n of extractNoteNumbers(text)) {
    if (!bound.has(n) && !ungrounded.includes(n)) ungrounded.push(n);
  }
  return ungrounded;
}

// Judge one note against one session's bound facts.
// → { ok, numbers, ungrounded }
function groundCoachingNote(text, boundNumbers) {
  const numbers = extractNoteNumbers(text);
  const ungrounded = findUngroundedNumbers(text, boundNumbers);
  return { ok: ungrounded.length === 0, numbers, ungrounded };
}

module.exports = {
  extractNoteNumbers,
  collectSessionBoundNumbers,
  findUngroundedNumbers,
  groundCoachingNote,
};
