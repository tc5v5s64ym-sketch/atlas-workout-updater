'use strict';

// Warm-up pattern detector — learns a lifter's OWN warm-up ramp from logged history.
//
// Atlas already prescribes a generic warm-up ramp on main compounds (50/70/85%,
// reps 8/5/3 — services/sessionBuilder.js::buildWarmupRamp). This module is the
// "intelligence" layer the owner asked for: when a lifter has a history of ramping
// a lift their OWN way, recognize that pattern so a later builder can prescribe a
// ramp matching them; when they don't, the caller falls back to the generic ramp.
//
// PURE + read-only. No I/O, no LLM, no Sheets. Emits a learned shape or null —
// it does not itself prescribe loads (that is the builder's job in a later step),
// and it never fabricates a pattern from thin evidence.
//
// How a warm-up is detected within a session (the owner logs RIR, e.g. Bench
// "135×15 @6 → 185×10 @2 → 225×5 @2"):
//   1. The session's working effort is its TOP set — the max-e1RM set (mirrors
//      detectStalls / the trend fix).
//   2. A warm-up set is one logged BEFORE that top set that is clearly lighter
//      (a lighter ascending lead-in by load); RIR, when present, is used only to
//      exclude a lighter set that was actually near failure (real work, not priming).
//   3. The warm-ups must ASCEND in load (a true ramp), so back-off / drop sets
//      after the top set are never mistaken for a ramp.
// A session with ≥1 such warm-up is a "ramped session". With enough ramped
// sessions, the most recent ramp shape is returned as the learned template.

const DEFAULTS = {
  // The defining feature of a ramp set is being a LIGHTER ascending lead-in to the
  // top working set — so load is the primary signal: a lead set must be at most
  // this fraction of the session's top working weight to count as a warm-up
  // (a near-top "feeler" single is not priming).
  maxWarmupFraction: 0.92,
  // RIR (reps-in-reserve) is a corroborating signal, used only to EXCLUDE a lighter
  // lead set that was actually hard work (near failure). A real ramp set sits well
  // short of failure. The owner's ramp reads "135×15 @6 → 185×10 @2 → 225 working":
  // the @2 transition set is a ramp (lighter, ascending), so the floor is low.
  minWarmupRir: 2,
  // Minimum ramped sessions before a personal pattern is trusted over the generic
  // ramp (don't fabricate a pattern from one stray session).
  minRampedSessions: 2,
};

function num(v) {
  // Empty / missing cells must read as ABSENT (null), not 0 — a blank RIR is "no
  // RIR logged", and Number('') / Number(null) coerce to 0, which would wrongly
  // read as "near failure".
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalize a logged row (array or object) to the few fields we need.
function readRow(row) {
  if (Array.isArray(row)) {
    return {
      session_id: String(row[1] || '').trim(),
      lift_code: String(row[5] || '').trim().toUpperCase(),
      exercise: String(row[2] || '').trim(),
      set_number: num(row[6]),
      weight: num(row[7]),
      reps: num(row[8]),
      rir: num(row[9]),
      date: String(row[0] || '').trim(),
    };
  }
  if (row && typeof row === 'object') {
    return {
      session_id: String(row.session_id || row.sessionId || '').trim(),
      lift_code: String(row.lift_code || row.liftCode || '').trim().toUpperCase(),
      exercise: String(row.exercise || row.exercise_name || '').trim(),
      set_number: num(row.set_number != null ? row.set_number : row.setNumber),
      weight: num(row.weight),
      reps: num(row.reps),
      rir: num(row.rir),
      date: String(row.date_clean || row.date || '').trim(),
    };
  }
  return null;
}

// e1RM (Epley) — same formula as recommendNextSet / detectStalls.
function e1rm(weight, reps) {
  return weight * (1 + reps / 30);
}

// Split one session's ordered sets into { warmups, top }. Returns null when there
// is no clear ramp (no lighter ascending priming sets before the top set).
function rampInSession(sets, opts) {
  const valid = sets.filter(s => s.weight > 0 && s.reps > 0);
  if (valid.length < 2) return null;

  // Order within the session by set_number when present, else by input order.
  const ordered = valid
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const an = a.s.set_number, bn = b.s.set_number;
      if (an != null && bn != null && an !== bn) return an - bn;
      return a.i - b.i;
    })
    .map(x => x.s);

  // Top working set = max e1RM (the heaviest effort, not the first logged set).
  let topIdx = 0;
  for (let i = 1; i < ordered.length; i++) {
    if (e1rm(ordered[i].weight, ordered[i].reps) > e1rm(ordered[topIdx].weight, ordered[topIdx].reps)) topIdx = i;
  }
  const top = ordered[topIdx];
  if (topIdx === 0) return null; // top set is first → nothing logged before it to ramp

  // Candidate warm-ups: lighter lead-in sets before the top set. Load is the
  // primary signal; RIR only excludes a lighter set that was actually near failure.
  const lead = ordered.slice(0, topIdx);
  const warmups = lead.filter(s => {
    if (!(s.weight < top.weight * opts.maxWarmupFraction)) return false; // must be clearly lighter
    if (s.rir != null && s.rir < opts.minWarmupRir) return false;        // lighter but near-failure → real work
    return true;
  });
  if (!warmups.length) return null;

  // The warm-ups must ascend in load (a real ramp, not random light sets).
  for (let i = 1; i < warmups.length; i++) {
    if (warmups[i].weight < warmups[i - 1].weight) return null;
  }
  return { warmups, top };
}

// Detect a lifter's learned warm-up ramp shape for one lift.
//
// @param logRows  full Log_Cleaned rows (array-form or object-form), any lifts
// @param options  { liftCode?, exerciseName?, warmupRirFloor?, maxWarmupFraction?, minRampedSessions? }
// @returns {
//   steps: [{ load_fraction, reps }],   // ascending ramp as fractions of the top working set
//   confidence: 'low' | 'medium' | 'high',
//   ramped_sessions, total_sessions
// }  — or null when there is no trustworthy personal pattern (caller falls back
//     to the generic ramp).
function detectWarmupRampShape(logRows, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const wantCode = String(options.liftCode || '').trim().toUpperCase();
  const wantName = String(options.exerciseName || '').trim().toLowerCase();
  if (!wantCode && !wantName) return null;

  const rows = (Array.isArray(logRows) ? logRows : [])
    .map(readRow)
    .filter(Boolean)
    .filter(r => (wantCode ? r.lift_code === wantCode : true))
    .filter(r => (wantName ? r.exercise.toLowerCase() === wantName : true))
    .filter(r => r.weight > 0 && r.reps > 0);
  if (!rows.length) return null;

  // Group into sessions, preserving chronological order (caller's rows are
  // expected oldest→newest; we record first-seen order to pick the most recent).
  const sessions = new Map();
  const order = [];
  for (const r of rows) {
    const key = `${r.date}||${r.session_id}`;
    if (!sessions.has(key)) { sessions.set(key, []); order.push(key); }
    sessions.get(key).push(r);
  }

  const ramps = [];
  for (const key of order) {
    const ramp = rampInSession(sessions.get(key), opts);
    if (ramp) ramps.push(ramp);
  }
  const totalSessions = order.length;
  if (ramps.length < opts.minRampedSessions) return null;

  // Learn the shape from the MOST RECENT ramped session ("follow their current
  // logic"), expressed as load fractions of that session's top working set.
  const latest = ramps[ramps.length - 1];
  const steps = latest.warmups.map(w => ({
    load_fraction: Math.round((w.weight / latest.top.weight) * 100) / 100,
    reps: w.reps,
  }));

  // Confidence scales with how many sessions corroborate a ramp.
  let confidence = 'low';
  if (ramps.length >= 4) confidence = 'high';
  else if (ramps.length >= opts.minRampedSessions) confidence = 'medium';

  return { steps, confidence, ramped_sessions: ramps.length, total_sessions: totalSessions };
}

module.exports = { detectWarmupRampShape, DEFAULTS };
