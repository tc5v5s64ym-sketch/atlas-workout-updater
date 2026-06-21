'use strict';

// Per-user session-volume profile — learns how a lifter ACTUALLY composes their
// sessions from logged history, so the suggested session can be sized to THEIR own
// norm (exercise count, compound-vs-accessory split) instead of a generic cap.
//
// This is the session-level analog of the personalized warm-up ramp: learn the
// structure from the lifter's data, let the engine own the smart numbers. Pure +
// read-only — it returns a profile (or null when there isn't enough history, so
// the caller keeps the generic caps). It prescribes nothing itself.

const { classifyLiftRole } = require('./liftRole');

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Light row reader (array Log_Cleaned row or object) — only the fields we need.
function readRow(row) {
  if (Array.isArray(row)) {
    return {
      date: String(row[0] || '').trim(),
      session_id: String(row[1] || '').trim(),
      exercise: String(row[3] || row[2] || '').trim(), // prefer canonical (idx 3)
      muscle_group: String(row[4] || '').trim(),
    };
  }
  if (row && typeof row === 'object') {
    return {
      date: String(row.date_clean || row.date || '').trim(),
      session_id: String(row.session_id || row.sessionId || '').trim(),
      exercise: String(row.canonical_exercise || row.exercise || row.exercise_name || '').trim(),
      muscle_group: String(row.muscle_group || row.muscleGroup || '').trim(),
    };
  }
  return null;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Nearest-rank percentile (p in 0..1).
function percentile(nums, p) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}

// Build the lifter's session-volume profile from logged history.
//
// @param logRows  full Log_Cleaned rows (array-form or object-form)
// @param options  { today?, windowDays = 120, minSessions = 6 }
// @returns {
//   exercises_per_session,    // median distinct exercises in a session
//   compounds_per_session,    // median main+secondary lifts in a session
//   accessories_per_session,  // median accessory/isolation lifts in a session
//   session_cap,              // a roomy cap (75th pct) for trimming oversized plans
//   sessions_analyzed,
//   window_days,
//   confidence,               // 'low' | 'medium' | 'high' by sessions_analyzed
// }  — or null when there is too little history (caller keeps generic caps).
function buildSessionVolumeProfile(logRows, options = {}) {
  const windowDays = Number.isFinite(options.windowDays) ? options.windowDays : 120;
  const minSessions = Number.isFinite(options.minSessions) ? options.minSessions : 6;

  const rows = (Array.isArray(logRows) ? logRows : [])
    .map(readRow)
    .filter(r => r && r.session_id && r.exercise && r.date);
  if (!rows.length) return null;

  // Optional recency window — recent sessions reflect current habits.
  let cutoff = null;
  if (options.today) {
    const t = new Date(`${options.today}T12:00:00`);
    if (!Number.isNaN(t.getTime())) {
      const c = new Date(t.getTime() - windowDays * 86400000);
      cutoff = c.toISOString().slice(0, 10);
    }
  }

  // Group into sessions; collect the DISTINCT exercises performed in each.
  const sessions = new Map(); // key -> Map(exerciseLower -> { exercise, muscle_group })
  for (const r of rows) {
    if (cutoff && r.date < cutoff) continue;
    const key = `${r.date}||${r.session_id}`;
    if (!sessions.has(key)) sessions.set(key, new Map());
    const exKey = r.exercise.toLowerCase();
    if (!sessions.get(key).has(exKey)) sessions.get(key).set(exKey, { exercise: r.exercise, muscle_group: r.muscle_group });
  }
  if (sessions.size < minSessions) return null;

  const totals = [];
  const compounds = [];
  const accessories = [];
  for (const exMap of sessions.values()) {
    let comp = 0, acc = 0;
    for (const { exercise, muscle_group } of exMap.values()) {
      const role = classifyLiftRole(exercise, muscle_group);
      if (role === 'accessory') acc += 1; else comp += 1; // main + secondary = "compound" work
    }
    totals.push(exMap.size);
    compounds.push(comp);
    accessories.push(acc);
  }

  const sessions_analyzed = sessions.size;
  let confidence = 'low';
  if (sessions_analyzed >= minSessions + 12) confidence = 'high';
  else if (sessions_analyzed >= minSessions + 4) confidence = 'medium';

  return {
    exercises_per_session: Math.round(median(totals)),
    compounds_per_session: Math.round(median(compounds)),
    accessories_per_session: Math.round(median(accessories)),
    // Roomy caps (75th percentile, rounded up) — big enough to allow the lifter's
    // fuller days, tight enough to trim an over-stuffed generic plan. session_cap
    // bounds total exercises; accessory_cap bounds isolation/accessory work.
    session_cap: Math.ceil(percentile(totals, 0.75)),
    accessory_cap: Math.ceil(percentile(accessories, 0.75)),
    sessions_analyzed,
    window_days: windowDays,
    confidence,
  };
}

module.exports = { buildSessionVolumeProfile };
