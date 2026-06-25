/* Single source of truth for how a warm-up set is marked in Log_Cleaned.
 *
 * The 12-column Log_Cleaned contract has no warm-up column, and adding one is an
 * owner-gated schema migration. Owner decision (2026-06-25): mark warm-ups via the
 * free-text `notes` column (the "notes/status mechanism"). The rules:
 *
 *   - Warm-up sets ARE logged as real rows and DO count toward total session
 *     volume (the lifter performed them — they're training history).
 *   - Warm-ups are excluded ONLY from the progression / weight-bump decision —
 *     i.e. the "should we add weight next time" judgement reads working sets only.
 *
 * Atlas never invents numbers, so a warm-up is NOT encoded by stamping a fake RIR
 * (e.g. the live "RIR 4"). It is encoded by an explicit token in `notes`, detected
 * here. This is a STRONGER, unambiguous signal than the legacy weight/RIR heuristic
 * (weight < 60 % of session max OR RIR ≥ 4), which has a hole: a heavy warm-up
 * (e.g. 225×8 warm-up at > 60 % of a 245 top set) would otherwise leak into
 * progression. The explicit tag closes that hole; the heuristic remains as a
 * fallback for untagged historical rows.
 *
 * Pure / no I/O — used by the progression consumers (exerciseBenchmark,
 * expectedPerformance, coachMemory) and, later, by the write/composer path that
 * tags warm-up rows.
 */
'use strict';

// The human-readable token Atlas writes into `notes` to mark a warm-up.
const WARMUP_NOTE_TOKEN = 'warm-up';

// Recognizes a warm-up marker in a notes string: "warm-up" / "warm up" / "warmup",
// a standalone "wu" token, or "(W)". Mirrors the composer/normalizer warm-up
// vocabulary so a tag round-trips. Case-insensitive.
const WARMUP_NOTE_RE = /\bwarm[\s-]?up\b|\bwu\b|\(w\)/i;

// True when a notes value marks the set as a warm-up.
function isWarmupNote(notes) {
  return WARMUP_NOTE_RE.test(String(notes == null ? '' : notes));
}

// Add the warm-up marker to an existing notes value without duplicating it or
// dropping the lifter's own note. Returns the token alone when there was no note.
function tagWarmupNote(existing) {
  const note = String(existing == null ? '' : existing).trim();
  if (isWarmupNote(note)) return note || WARMUP_NOTE_TOKEN;
  return note ? `${WARMUP_NOTE_TOKEN}; ${note}` : WARMUP_NOTE_TOKEN;
}

module.exports = { WARMUP_NOTE_TOKEN, WARMUP_NOTE_RE, isWarmupNote, tagWarmupNote };
