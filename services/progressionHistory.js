'use strict';

// History-aware coaching facts — a PURE composer over the EXISTING deterministic
// progression rules. No invented thresholds, no I/O, no LLM, no Sheets writes. The
// engine owns every number and every decision; this module only ARRANGES them so the
// coach voice can WORD a lift's arc across sessions. It never authorizes a load change
// — the "next checkpoint" decision is holdUntilClean's, passed through verbatim.
//
// buildProgressionHistory(rows, liftCode) → {
//   current_verdict,        // progression_verdict.level for the latest session (or null)
//   previous_verdict,       // progression_verdict.level for the prior session (or null)
//   consecutive_on_target,  // clean sessions logged at the current load (holdUntilClean)
//   next_checkpoint,        // the engine-authorized progression checkpoint (or null)
// }
//
//   rows     – normalized Log_Cleaned rows (analytics.normalizeLogRow shape). May span
//              all lifts; this module filters to `liftCode` itself.
//   liftCode – the lift's Sheets lift_code.
//
// Facts 1-2 reuse analytics.progressionVerdict / progressionBand (the SAME verdict the
// coach already words for today). Facts 3-4 reuse rules/progressionRules.holdUntilClean
// (the wired progression authority) — its `criterion_progress` string is parsed for the
// engine's own counts; nothing is recomputed and no threshold is introduced here.

const { progressionBand, progressionVerdict } = require('./analytics');
const { holdUntilClean } = require('../rules/progressionRules');

function isPositiveFinite(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

// Distinct sessions for the lift, chronological, each with its top working weight
// (max logged weight in the session — mirrors analytics.recommendNextSet's
// progressionTop, which does NOT drop warm-ups from the session max).
function sessionsInOrder(rows) {
  const map = new Map();
  for (const r of rows) {
    const sid = r && r.session_id;
    if (!sid) continue;
    const w = Number(r.weight);
    const cur = map.get(sid) || { session_id: sid, date: r.date_clean || '', top: 0 };
    if (Number.isFinite(w) && w > cur.top) cur.top = w;
    if (!cur.date && r.date_clean) cur.date = r.date_clean;
    map.set(sid, cur);
  }
  return [...map.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.session_id !== b.session_id) return a.session_id < b.session_id ? -1 : 1;
    return 0;
  });
}

const verdictLevel = (top, band) => {
  if (!isPositiveFinite(top) || !band) return null;
  const v = progressionVerdict(top, band);
  return v && v.level ? v.level : null;
};

// Parse holdUntilClean's own progress string ("X of Y clean sessions at Z") so the
// engine's counts are surfaced structurally without recomputing them. Returns null on
// any shape it does not own (e.g. the no_data path carries criterion_progress = null).
function parseCleanProgress(s) {
  const m = /^(\d+)\s+of\s+(\d+)\s+clean sessions at\s+([\d.]+)$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  return { clean_sessions: Number(m[1]), required_sessions: Number(m[2]), load: Number(m[3]) };
}

function buildProgressionHistory(rows, liftCode) {
  const empty = { current_verdict: null, previous_verdict: null, consecutive_on_target: null, next_checkpoint: null };
  const code = String(liftCode || '').trim().toUpperCase();
  if (!Array.isArray(rows) || !code) return empty;

  // Working sets for THIS lift only (weight+reps present) — verdict/band inputs.
  const liftRows = rows.filter(r =>
    r && typeof r === 'object' &&
    String(r.lift_code || '').toUpperCase() === code &&
    isPositiveFinite(r.weight) && isPositiveFinite(r.reps));

  const sessions = sessionsInOrder(liftRows);

  // Fact 1 — current verdict: the latest session's top judged against the lifter's
  // own band EXCLUDING that session (identical to recommendNextSet's read).
  let current_verdict = null;
  if (sessions.length) {
    const last = sessions[sessions.length - 1];
    current_verdict = verdictLevel(last.top, progressionBand(liftRows, last.session_id));
  }

  // Fact 2 — previous verdict: the prior session's top judged against the band of the
  // sessions BEFORE it (the read as of that session — no future leakage).
  let previous_verdict = null;
  if (sessions.length >= 2) {
    const prev = sessions[sessions.length - 2];
    const priorIds = new Set(sessions.slice(0, sessions.length - 2).map(s => s.session_id));
    const priorRows = liftRows.filter(r => priorIds.has(r.session_id));
    previous_verdict = verdictLevel(prev.top, progressionBand(priorRows, null));
  }

  // Facts 3-4 — consecutive on-target sessions + the next engine-authorized checkpoint,
  // both straight from holdUntilClean (the wired progression rule). Its `decision`
  // (hold | load | no_data) is the ENGINE'S — passed through verbatim so the coach words
  // it and never authorizes a load change the engine hasn't.
  let consecutive_on_target = null;
  let next_checkpoint = null;
  const hc = holdUntilClean(rows, code);
  if (hc && (hc.decision === 'hold' || hc.decision === 'load')) {
    const p = parseCleanProgress(hc.criterion_progress);
    if (p) consecutive_on_target = p.clean_sessions;
    next_checkpoint = {
      decision: hc.decision,
      criterion_progress: hc.criterion_progress || null,
      clean_sessions: p ? p.clean_sessions : null,
      required_sessions: p ? p.required_sessions : null,
      load: p ? p.load : null,
    };
  }

  return { current_verdict, previous_verdict, consecutive_on_target, next_checkpoint };
}

module.exports = { buildProgressionHistory };
