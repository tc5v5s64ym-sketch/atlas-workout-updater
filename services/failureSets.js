'use strict';

// Detect sets taken to (or beyond) failure — RIR <= 0 — from a session's logged
// sets, so the coach can ACKNOWLEDGE failure work and advise on fatigue when the
// lifter asks about it ("why till failure for dips?"). Read-only and deterministic:
// it only reads logged RIR, invents no loads, and changes no progression math (the
// RIR<=0 "hold, near failure" recommendation already lives in services/analytics.js).
//
// RIR semantics: 0 = taken to failure, negative = pushed past the target (grind).
// A null/blank/non-numeric RIR is UNKNOWN and is never treated as failure.

function isFailureRir(rir) {
  // Blank / null / undefined RIR is UNKNOWN, never failure. Guard before Number()
  // because Number('') and Number(null) both coerce to 0 — which would misread an
  // un-logged RIR as a failure set.
  if (rir === null || rir === undefined || rir === '') return false;
  const n = typeof rir === 'number' ? rir : Number(rir);
  return Number.isFinite(n) && n <= 0;
}

// sets: [{ exercise, weight, reps, rir }] (the live session's logged sets).
// Returns [{ exercise, failure_count, sets: [{ weight, reps, rir }] }] — one entry
// per exercise that has at least one failure set, in first-seen order. Weight/reps
// that aren't positive finite numbers are surfaced as null (never invented).
function detectFailureSets(sets) {
  const order = [];
  const byExercise = new Map();
  for (const s of Array.isArray(sets) ? sets : []) {
    if (!s || typeof s !== 'object') continue;
    const name = s.exercise != null ? String(s.exercise).trim() : '';
    if (!name) continue;
    if (!isFailureRir(s.rir)) continue;
    const key = name.toLowerCase();
    if (!byExercise.has(key)) {
      byExercise.set(key, { exercise: name, failure_count: 0, sets: [] });
      order.push(key);
    }
    const group = byExercise.get(key);
    const weight = Number(s.weight);
    const reps = Number(s.reps);
    group.failure_count += 1;
    group.sets.push({
      weight: Number.isFinite(weight) && weight > 0 ? weight : null,
      reps: Number.isFinite(reps) && reps > 0 ? reps : null,
      rir: Number(s.rir)
    });
  }
  return order.map(k => byExercise.get(k));
}

// Pull the CURRENT session's logged sets out of the chat context (the live preview
// the client sends) into the flat shape detectFailureSets expects. Saved history is
// intentionally excluded — failure_sets is a "what you just did" signal, and the
// coach already answers prior-session questions from recent_sessions[*].lift_sets.
function sessionSetsFromContext(context) {
  const c = context && typeof context === 'object' ? context : {};
  const preview = Array.isArray(c.current_preview) ? c.current_preview : [];
  return preview
    .filter(r => r && typeof r === 'object')
    .map(r => ({ exercise: r.exercise || r.canonical_exercise || r.name, weight: r.weight, reps: r.reps, rir: r.rir }));
}

module.exports = { isFailureRir, detectFailureSets, sessionSetsFromContext };
