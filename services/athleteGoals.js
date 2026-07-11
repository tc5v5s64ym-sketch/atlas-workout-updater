'use strict';

// ── Athlete Goals (Soul Plan PR-B8a) ─────────────────────────────────────────
//
// The one identity fact the training log cannot derive: what the lifter is
// training TOWARD. Owner-ratified storage (docs/ATLAS_VOICE_RATIFICATION_V1.md
// D8 — Constraints-tab row convention): a Constraints row with kind `goal` and a
// `target` cell shaped "<lift_code> <target_weight> [target_reps]", e.g.
// "bench_press 215" or "back_squat 315 3". Goals are hand-seeded owner data —
// the app never creates them (POST /api/constraints rejects a `goal` kind, and
// the constraint resolver / coach sanitizer both ignore it), so this reader is
// the ONLY consumer of `goal` rows.
//
// This module is PURE and READ-ONLY: it maps already-fetched Constraints rows to
// the frozen goal schema, skips any malformed row (never fabricates a goal), and
// never throws. It performs no I/O and reads no clock. The value is forwarded to
// the coach voice through the sanitizer whitelist (services/coach.js
// sanitizeAthleteGoals); goal-proximity claims are grounded cite-never-invent by
// the persona core.
//
// Schema (per PR-B8a): { lift_code, target_weight, target_reps?, set_date, note? }
// — read-only from the coach's perspective (goal EDITING is a later surface).

const MAX_GOALS = 20; // generous read cap; the sanitizer bounds again (12) at the voice edge.

// A Constraints row is either a positional array [date, kind, target, rule, note]
// or an object with those keys (getSheetRows returns either), mirroring the chat
// route's own constraint mapping. Normalize to the fields a goal needs.
function normRow(row) {
  if (Array.isArray(row)) {
    return { date: row[0] ?? null, kind: row[1] ?? null, target: row[2] ?? null, note: row[4] ?? null };
  }
  if (row && typeof row === 'object') {
    return { date: row.date ?? null, kind: row.kind ?? null, target: row.target ?? null, note: row.note ?? null };
  }
  return { date: null, kind: null, target: null, note: null };
}

const str = v => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));
const posNum = v => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Parse a goal `target` cell: "<lift_code> <target_weight> [target_reps]".
// lift_code must be a non-numeric token; target_weight must parse to a positive
// finite number. A missing/unparseable weight or lift_code → null (skip the row);
// a missing/unparseable reps token → target_reps null (the goal still stands).
function parseTarget(target) {
  const tokens = str(target).split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const lift_code = tokens[0];
  if (!lift_code || posNum(lift_code) != null) return null; // a numeric first token is not a lift code
  const target_weight = posNum(tokens[1]);
  if (target_weight == null) return null;
  const target_reps = tokens[2] != null ? posNum(tokens[2]) : null;
  return { lift_code, target_weight, target_reps };
}

// readAthleteGoals(rows) → [{ lift_code, target_weight, target_reps, set_date, note }]
// Pure. Filters to kind `goal`, parses the target, skips malformed rows, caps the
// count. Never throws; non-array input → [].
function readAthleteGoals(rows) {
  if (!Array.isArray(rows)) return [];
  const goals = [];
  for (const row of rows) {
    if (goals.length >= MAX_GOALS) break;
    const { date, kind, target, note } = normRow(row);
    if (str(kind).toLowerCase() !== 'goal') continue;
    const parsed = parseTarget(target);
    if (!parsed) continue;
    goals.push({
      lift_code: parsed.lift_code,
      target_weight: parsed.target_weight,
      target_reps: parsed.target_reps,
      set_date: str(date) || null,
      note: str(note) || null,
    });
  }
  return goals;
}

module.exports = { readAthleteGoals };
