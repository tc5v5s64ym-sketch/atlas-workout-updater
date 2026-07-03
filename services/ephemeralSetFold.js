'use strict';

// Ephemeral-set fold — the set-reaction promotion foundation (BACKLOG,
// One-Brain lane). Under session-level save, a just-logged set is not in the
// sheet yet; the Brain's snapshot derives from sheet rows only, so any
// decision it makes in-workout is stale by exactly that set. This helper
// folds the fresh set into the row history BEFORE state assembly, so the
// snapshot the Orchestrator sees is truthful — the same rows the sheet would
// hold the moment the session is saved.
//
// Pure: no I/O, no LLM, no Sheets, no write. Returns a NEW array (never
// mutates the input); the synthetic row is 12-col positional, copying the
// lift's identity columns from its most recent sheet row (or degrading to
// the lift code for a brand-new lift logged in-workout).
//
// The synthetic session_id '~ephemeral' sorts AFTER any real session id on
// the same date ('~' is ASCII 126), so chronological consumers
// (lastWorkingSet's date → session tie-break) always see the fresh set as
// the newest — exactly like the post-save sheet would read.

const EPHEMERAL_SESSION_ID = '~ephemeral';

function foldJustLoggedSet(rows, liftCode, justLoggedSet, asOf) {
  const list = Array.isArray(rows) ? rows : [];
  const code = String(liftCode || '').trim().toUpperCase();
  const set = justLoggedSet && typeof justLoggedSet === 'object' ? justLoggedSet : null;
  const weight = set ? Number(set.weight) : NaN;
  const reps = set ? Number(set.reps) : NaN;
  const dateOk = typeof asOf === 'string' && asOf.length >= 10;
  if (!code || !set || !dateOk || !Number.isFinite(weight) || !Number.isFinite(reps) || reps <= 0) {
    // An unfoldable set (no code, no numbers, no date to sort by) must not
    // produce a row that downstream filters would silently drop or mis-sort —
    // return the history unchanged; the caller's fold flag stays false.
    return list.slice();
  }

  // Identity columns from the lift's most recent sheet row (last occurrence —
  // rows arrive in sheet order, oldest first).
  let identity = null;
  for (const r of list) {
    if (Array.isArray(r) && String(r[5] || '').trim().toUpperCase() === code) identity = r;
  }

  const dateClean = asOf.slice(0, 10);
  const rir = set.rir != null && Number.isFinite(Number(set.rir)) ? Number(set.rir) : '';
  const synthetic = [
    dateClean,
    EPHEMERAL_SESSION_ID,
    identity ? identity[2] : code,   // exercise
    identity ? identity[3] : code,   // canonical_exercise (normRow requires non-empty)
    identity ? identity[4] : '',     // muscle_group
    code,
    1,
    weight,
    reps,
    rir,
    'ephemeral (just logged, unsaved)',
    weight * reps,
  ];
  return [...list, synthetic];
}

module.exports = { foldJustLoggedSet, EPHEMERAL_SESSION_ID };
