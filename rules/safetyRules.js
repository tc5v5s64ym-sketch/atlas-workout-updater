'use strict';

// Safety rules — pure functions that flag risky or suspicious patterns.
// They never block a log (that's the lifter's data) — they flag with severity
// so the preview UI and coaching layer can surface them.
//
// All functions take normalized log rows: flat objects shaped like the
// Log_Cleaned sheet ({ session_id, date_clean, lift_code, canonical_exercise,
// weight, reps, rir, notes }) with numeric weight/reps/rir (or null).

const { decision } = require('./ruleTypes');

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function e1rm(weight, reps) {
  const w = num(weight);
  const r = num(reps);
  if (!w || !r) return null;
  return w * (1 + r / 30);
}

// Group flat rows into sessions ordered oldest → newest.
// Safe on non-array / empty.
function groupBySession(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = row.session_id || 'unknown';
    if (!map.has(key)) map.set(key, { session_id: key, date: row.date_clean || '', rows: [] });
    map.get(key).rows.push(row);
  }
  return Array.from(map.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date)) || String(a.session_id).localeCompare(String(b.session_id))
  );
}

// ── rir_caution: working sets at RIR ≤ threshold in the rows being logged ─────

function rirCaution(rows, config = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const { threshold = 1 } = config;
  const grinding = rows.filter(r => {
    if (!r || typeof r !== 'object') return false;
    const rir = num(r.rir);
    return rir !== null && rir <= threshold;
  });

  if (!grinding.length) return null;

  const lifts = [...new Set(grinding.map(r => r.canonical_exercise || r.exercise || r.lift_code).filter(Boolean))];
  return decision({
    decision: 'caution',
    rule_id: 'rir_caution',
    severity: 'warning',
    reasoning: `${grinding.length} set(s) at RIR ≤ ${threshold}${lifts.length ? ` (${lifts.join(', ')})` : ''}. They count as reps, not toward the clean-session standard.`,
  });
}

// ── junk_rep_guard: RIR 0 sets — record, don't celebrate ──────────────────────

function junkRepGuard(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const rirZero = rows.filter(r => {
    if (!r || typeof r !== 'object') return false;
    return num(r.rir) === 0;
  });
  if (!rirZero.length) return null;

  return decision({
    decision: 'caution',
    rule_id: 'junk_rep_guard',
    severity: 'info',
    reasoning: `${rirZero.length} set(s) at RIR 0. Any PRs here are quality:grind — logged but not the standard to chase.`,
  });
}

// ── pain_flag: pain words in set or workout notes ─────────────────────────────

const PAIN_WORDS = /\b(?:pain|painful|hurt|hurts|ache|aching|injur(?:y|ed)|tweak(?:ed)?|strain(?:ed)?|pinch(?:ed|ing)?|sharp)\b/i;

function painFlag(rows, workoutNotes = '') {
  if (!Array.isArray(rows)) rows = [];
  const sources = rows.map(r => r && typeof r === 'object' ? String(r.notes || '') : '').concat(String(workoutNotes || ''));
  const hits = sources.filter(s => PAIN_WORDS.test(s));
  if (!hits.length) return null;

  return decision({
    decision: 'caution',
    rule_id: 'pain_flag',
    severity: 'error',
    reasoning: `Pain/discomfort mentioned in notes ("${hits[0].slice(0, 60)}"). Hold load increases on the affected lift until it clears.`,
  });
}

// ── rir_drift: RIR at the same load declining across recent sessions ──────────

function rirDrift(historyRows, liftCode, config = {}) {
  if (!Array.isArray(historyRows) || historyRows.length === 0) return null;
  const { window = 3 } = config;
  const code = String(liftCode || '').trim().toUpperCase();
  const rows = historyRows.filter(r => {
    if (!r || typeof r !== 'object') return false;
    return String(r.lift_code || '').toUpperCase() === code && num(r.rir) !== null;
  });
  if (!rows.length) return null;

  const sessions = groupBySession(rows).slice(-window);
  if (sessions.length < 2) return null;

  // Compare avg RIR at the most common (modal) weight across these sessions
  const weightCounts = new Map();
  for (const s of sessions) {
    for (const r of s.rows) {
      if (!r || typeof r !== 'object') continue;
      const w = num(r.weight);
      if (w) weightCounts.set(w, (weightCounts.get(w) || 0) + 1);
    }
  }
  if (!weightCounts.size) return null;
  const modalWeight = [...weightCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const avgRirs = sessions.map(s => {
    const at = s.rows.filter(r => r && typeof r === 'object' && num(r.weight) === modalWeight);
    if (!at.length) return null;
    return at.reduce((sum, r) => sum + num(r.rir), 0) / at.length;
  }).filter(v => v !== null);

  if (avgRirs.length < 2) return null;
  const first = avgRirs[0];
  const last = avgRirs[avgRirs.length - 1];
  if (last >= first - 0.5) return null;

  return decision({
    decision: 'caution',
    rule_id: 'rir_drift',
    severity: 'warning',
    reasoning: `RIR at ${modalWeight} trending down: avg ${avgRirs.map(v => v.toFixed(1)).join(' → ')} over ${avgRirs.length} sessions. Fatigue accumulating — these don't count as clean sessions.`,
    criterion_progress: `RIR avg: ${avgRirs.map(v => v.toFixed(1)).join(' → ')}`,
    lift_code: code,
  });
}

// ── Orchestrator: evaluate all session-level safety rules for a preview ───────

// newRows: the rows about to be written (normalized objects).
// workoutNotes: top-level notes string, if any.
// Returns an array of decision objects (possibly empty), ready to surface as
// rule_flags in a preview response.
// Degrades safely on bad input.
function evaluateSessionSafety(newRows, workoutNotes = '') {
  if (!Array.isArray(newRows) || newRows.length === 0) return [];
  const flags = [];
  const checks = [
    rirCaution(newRows),
    junkRepGuard(newRows),
    painFlag(newRows, workoutNotes),
  ];
  for (const f of checks) {
    if (f) flags.push(f);
  }
  return flags;
}

module.exports = { rirCaution, junkRepGuard, painFlag, rirDrift, evaluateSessionSafety, groupBySession, e1rm };
