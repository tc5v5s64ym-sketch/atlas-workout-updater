'use strict';

// Safety rules — pure functions that flag risky or suspicious patterns.
// They never block a log (that's the lifter's data) — they flag with severity
// so the preview UI and coaching layer can surface them.
//
// All functions take normalized log rows: flat objects shaped like the
// Log_Cleaned sheet ({ session_id, date_clean, lift_code, canonical_exercise,
// weight, reps, rir, notes }) with numeric weight/reps/rir (or null).

const { decision } = require('./ruleTypes');
const { checkE1rmJump } = require('./validationRules');

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

// ── e1rm_jump: a new set's estimated 1RM jumping implausibly vs last session ──

// Best (max) e1RM across a set of normalized rows. null when none computable.
function bestE1rm(rows) {
  let best = null;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const v = e1rm(r.weight, r.reps);
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best;
}

// Best e1RM the lift reached in its most recent PRIOR session (sessions whose
// id appears in excludeSessionIds — i.e. the one being previewed — are skipped
// so a set never compares against itself). null when there is no prior session.
function previousSessionBestE1rm(historyRows, liftCode, excludeSessionIds) {
  const code = String(liftCode || '').trim().toUpperCase();
  const rows = historyRows.filter(r =>
    r && typeof r === 'object' && String(r.lift_code || '').toUpperCase() === code);
  const sessions = groupBySession(rows).filter(s => !excludeSessionIds.has(s.session_id));
  if (!sessions.length) return null;
  return bestE1rm(sessions[sessions.length - 1].rows);
}

// ── Orchestrator: evaluate all session-level safety rules for a preview ───────

// newRows: the rows about to be written (normalized objects).
// workoutNotes: top-level notes string, if any.
// historyRows: the lift's prior logged rows (normalized objects), optional. When
//   provided, the history-dependent guards run per distinct lift in newRows:
//   rirDrift (RIR declining at the same load) and the e1RM typo guard (a new set's
//   estimated 1RM jumping >15% above the lift's last-session best). Omitting it (or
//   passing []) preserves the original behavior — only the row-local checks run — so
//   existing two-arg callers are unaffected.
// Returns an array of decision objects (possibly empty), ready to surface as
// rule_flags in a preview response.
// Degrades safely on bad input. Malformed rows coerce to an empty array, but the
// checks still run: painFlag reads top-level workoutNotes, so a notes-only session
// (no rows) must still surface a pain warning. Each check tolerates empty rows.
function evaluateSessionSafety(newRows, workoutNotes = '', historyRows = []) {
  const rows = Array.isArray(newRows) ? newRows : [];
  const history = Array.isArray(historyRows) ? historyRows : [];
  const flags = [];
  const checks = [
    rirCaution(rows),
    junkRepGuard(rows),
    painFlag(rows, workoutNotes),
  ];
  for (const f of checks) {
    if (f) flags.push(f);
  }

  if (history.length) {
    const codes = [...new Set(rows
      .map(r => (r && typeof r === 'object' ? String(r.lift_code || '').toUpperCase() : ''))
      .filter(Boolean))];
    const previewSessionIds = new Set(rows.map(r => r && r.session_id).filter(Boolean));
    for (const code of codes) {
      const drift = rirDrift(history, code);
      if (drift) flags.push(drift);

      const liftRows = rows.filter(r => String(r.lift_code || '').toUpperCase() === code);
      const jump = checkE1rmJump(bestE1rm(liftRows), previousSessionBestE1rm(history, code, previewSessionIds));
      if (jump) {
        flags.push(decision({
          decision: 'caution',
          rule_id: 'e1rm_jump',
          severity: 'warning',
          reasoning: jump.warning,
          criterion_progress: `e1RM jump: +${(jump.pct * 100).toFixed(1)}%`,
          lift_code: code,
        }));
      }
    }
  }

  return flags;
}

module.exports = { rirCaution, junkRepGuard, painFlag, rirDrift, evaluateSessionSafety, groupBySession, e1rm, bestE1rm, previousSessionBestE1rm };
