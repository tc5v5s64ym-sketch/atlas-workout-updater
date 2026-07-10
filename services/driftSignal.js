'use strict';

// ── Drift signal (Soul Plan PR-B5a, Part 1 — pure, unwired) ───────────────────
//
// The deterministic tripwire for "brave enough to challenge when you're drifting"
// (the north star). Chat has no engine trigger for challenge today — the model
// just improvises. This module detects three drift shapes from data the engine
// already has, so pushback always arrives WITH the receipts (Part 2 wires the
// output into selectCoachMode's `challenge` mode + the persona challenge block;
// the challenge is asked as a QUESTION, never a lecture).
//
// PURE + UNWIRED: no I/O, no LLM, no Sheets, no clock (asOf injected). Total —
// every input, including garbage, returns a valid { drifting:false, ... }.
//
// detectDrift(logRows, plannedVsCompleted, memoryPatterns, { asOf, deloadState })
//   → { drifting: bool, kind: 'skipped_pattern_streak'|'plan_deviation'|'sandbag_persistence'|null, evidence }
//
// Inputs (shapes the wiring PR adapts real data to):
//   logRows            — 12-col Log_Cleaned rows (for the layoff guard).
//   plannedVsCompleted — recent per-session planned-vs-completed, newest LAST:
//                        [{ date:'YYYY-MM-DD', planned:string[], completed:string[] }]
//                        (assembled in Part 2 from the Missed-Lift / planned-vs-
//                        completed memory, Roadmap Step 365).
//   memoryPatterns     — the array form [{ liftCode, patterns:[{ type, details }] }]
//                        (services/coachMemory.js; only `consistent_underperformance`
//                        is read here). Same shape selectCoachMode already consumes.
//   opts.asOf          — 'YYYY-MM-DD' anchor (no clock).
//   opts.deloadState   — the current Deload_State row (services/deloadState.js);
//                        an active deload suppresses drift (a planned recovery cut
//                        is NOT drift). Passed in so this module stays pure.
//
// A legitimate deload OR layoff window is NOT drift; thin history never fires.
// Thresholds are a tuned proposal (pinned in fixtures) — deliberately conservative
// so pushback is earned, not trigger-happy.

const { assessLayoff } = require('./layoffGuard');
const { patternFor } = require('./movementPattern');

const MIN_SESSIONS = 3;            // thin-history floor: need ≥3 planned sessions to judge
const SKIP_STREAK_THRESHOLD = 3;   // same pattern skipped in ≥3 consecutive planned sessions
const DEVIATION_THRESHOLD = 0.5;   // ≥50% of planned lifts not completed …
const DEVIATION_WINDOW = 3;        // … across 3 consecutive sessions
const SANDBAG_MIN_BELOW = 3;       // consistent_underperformance persisting: ≥3 sessions below
const LAYOFF_SUPPRESS_DAYS = 7;    // a real break (≥7 days) is not drift

const NOT_DRIFTING = Object.freeze({ drifting: false, kind: null, evidence: null });
function suppressed(reason) { return { drifting: false, kind: null, evidence: { suppressed: reason } }; }

function _names(arr) {
  return Array.isArray(arr) ? arr.map(n => (typeof n === 'string' ? n.trim() : '')).filter(Boolean) : [];
}

// The distinct movement patterns present in a name list. patternFor returns
// { pattern, needsReview }; we key on the pattern string.
function _patternsOf(names) {
  const out = new Set();
  for (const n of names) {
    const p = patternFor(n);
    const key = p && typeof p === 'object' ? p.pattern : p;
    if (key && typeof key === 'string') out.add(key);
  }
  return out;
}

function detectDrift(logRows, plannedVsCompleted, memoryPatterns, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const asOf = typeof o.asOf === 'string' ? o.asOf : null;

  // ── Guard 1: an active deload is a planned recovery cut, never drift. ──
  const ds = o.deloadState;
  if (ds && typeof ds === 'object' && typeof ds.training_state === 'string'
      && ds.training_state.trim() && ds.training_state.trim().toUpperCase() !== 'NORMAL') {
    return suppressed('deload');
  }

  // ── Guard 2: a real layoff (≥7 days away) is not drift. ──
  try {
    const layoff = assessLayoff(Array.isArray(logRows) ? logRows : [], asOf ? { today: asOf } : {});
    if (layoff && (layoff.returning_from_layoff === true
        || (Number.isFinite(layoff.days_since_last_session) && layoff.days_since_last_session >= LAYOFF_SUPPRESS_DAYS))) {
      return suppressed('layoff');
    }
  } catch { /* layoff read is best-effort; absence never fabricates drift */ }

  // Normalize the planned-vs-completed history, newest LAST, dropping empty-plan
  // sessions (a session with no plan can't be "deviated from").
  const sessions = (Array.isArray(plannedVsCompleted) ? plannedVsCompleted : [])
    .map(s => (s && typeof s === 'object'
      ? { date: typeof s.date === 'string' ? s.date : null, planned: _names(s.planned), completed: _names(s.completed) }
      : null))
    .filter(s => s && s.planned.length > 0);

  // ── Guard 3: thin history — not enough planned sessions to judge drift. ──
  if (sessions.length < MIN_SESSIONS) {
    // sandbag_persistence can still fire from memory patterns alone (below), but a
    // pattern/deviation read needs the planned history, so only the sandbag branch
    // is reachable with thin plan history.
    const sandbag = _detectSandbag(memoryPatterns);
    return sandbag || NOT_DRIFTING;
  }

  // ── Kind 1: skipped_pattern_streak — the SAME movement pattern planned but not
  //    performed in the last ≥3 consecutive sessions (an avoided pattern). ──
  const streak = _detectSkippedPatternStreak(sessions);
  if (streak) return streak;

  // ── Kind 2: plan_deviation — ≥50% of planned lifts unperformed across the last
  //    3 consecutive sessions (chronic drift from the plan). ──
  const deviation = _detectPlanDeviation(sessions);
  if (deviation) return deviation;

  // ── Kind 3: sandbag_persistence — a lift underperforming its own history,
  //    persistently (consistent_underperformance with enough sessions below). ──
  const sandbag = _detectSandbag(memoryPatterns);
  if (sandbag) return sandbag;

  return NOT_DRIFTING;
}

// Walk the sessions newest→oldest; for each pattern that was PLANNED in the newest
// session but not COMPLETED, count how many consecutive recent sessions skipped it
// (planned-with-that-pattern but completed none of it). Fire at ≥ threshold.
function _detectSkippedPatternStreak(sessions) {
  const ordered = sessions.slice(); // newest last
  const newest = ordered[ordered.length - 1];
  const newestPlanned = _patternsOf(newest.planned);
  const newestCompleted = _patternsOf(newest.completed);
  const candidatePatterns = [...newestPlanned].filter(p => !newestCompleted.has(p));

  for (const pattern of candidatePatterns) {
    let streak = 0;
    const streakSessions = [];
    for (let i = ordered.length - 1; i >= 0; i--) {
      const s = ordered[i];
      const planned = _patternsOf(s.planned);
      if (!planned.has(pattern)) break;            // pattern wasn't on the plan → streak ends
      const completed = _patternsOf(s.completed);
      if (completed.has(pattern)) break;           // they did perform it → not skipped
      streak += 1;
      streakSessions.push(s.date);
    }
    if (streak >= SKIP_STREAK_THRESHOLD) {
      return {
        drifting: true,
        kind: 'skipped_pattern_streak',
        evidence: { pattern, streak, sessions: streakSessions.filter(Boolean) },
      };
    }
  }
  return null;
}

function _detectPlanDeviation(sessions) {
  const window = sessions.slice(-DEVIATION_WINDOW);
  if (window.length < DEVIATION_WINDOW) return null;
  const ratios = [];
  for (const s of window) {
    const completedSet = new Set(s.completed.map(n => n.toLowerCase()));
    const missed = s.planned.filter(n => !completedSet.has(n.toLowerCase())).length;
    ratios.push(missed / s.planned.length);
  }
  if (ratios.every(r => r >= DEVIATION_THRESHOLD)) {
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    return {
      drifting: true,
      kind: 'plan_deviation',
      evidence: { deviation_pct: Math.round(avg * 100), sessions_checked: window.length },
    };
  }
  return null;
}

function _detectSandbag(memoryPatterns) {
  const list = Array.isArray(memoryPatterns) ? memoryPatterns : [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.patterns)) continue;
    for (const p of item.patterns) {
      if (!p || p.type !== 'consistent_underperformance') continue;
      const d = p.details && typeof p.details === 'object' ? p.details : {};
      const below = Number(d.sessions_below);
      const checked = Number(d.sessions_checked);
      if (Number.isFinite(below) && below >= SANDBAG_MIN_BELOW) {
        return {
          drifting: true,
          kind: 'sandbag_persistence',
          evidence: {
            liftCode: typeof item.liftCode === 'string' ? item.liftCode : null,
            sessions_below: below,
            sessions_checked: Number.isFinite(checked) ? checked : null,
          },
        };
      }
    }
  }
  return null;
}

module.exports = { detectDrift };
