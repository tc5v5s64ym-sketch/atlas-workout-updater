'use strict';

// ── Athlete Identity Facts (Soul Plan PR-A7) ─────────────────────────────────
//
// The deterministic longitudinal story of THIS lifter, computed from the same
// 12-col Log_Cleaned rows the coach routes already fetch — so the voice can say
// "up from the 185 you opened at in March" instead of "strong set", citing
// facts the engine owns instead of inventing them.
//
// buildAthleteIdentity(logRows, { asOf }) → {
//   first_session_date:      'YYYY-MM-DD' | null,
//   tenure_months:           number | null,   // whole months since first session
//   days_since_last_session: number | null,
//   longest_gap_days:        number | null,   // largest gap between consecutive sessions
//   consistency: { current_weekly_streak, sessions_per_week_8wk } | null,
//   lift_prs: { [exerciseName]: {
//     history:      [{ weight, reps, date }],  // last 3 PR events, chronological
//     current_best: { weight, reps, date } | null
//   } },
//   recent_milestones: [{ exercise, weight, reps, date }]  // PR events in the last 60 days
// }
//
// Contract:
// - PURE. No I/O, no LLM, no Sheets, no clock: `asOf` is INJECTED (a
//   'YYYY-MM-DD' string or Date) and the clock is never read (no argless Date
//   construction) — same rule as services/liftPrescription.js (the BACKLOG
//   time-bomb note).
// - THIN HISTORY (< 3 distinct sessions) or missing/invalid input → the
//   mostly-null shape above with empty lift_prs/milestones. Never a fabricated
//   value; absent data reads as absent.
// - A "PR event" is a WORKING set (note-tagged warm-ups excluded via
//   services/warmupTag — the single source of truth) whose weight beats every
//   prior working-set weight for that lift, in chronological order. So
//   `history` reads as the lift's actual progression: 185 → 205 → 225.
// - Warm-ups never create a PR or a milestone; they still count as session
//   attendance (consistency/gaps are about showing up, not intensity).

const { normRow } = require('./liftPrescription');
const { isWarmupNote } = require('./warmupTag');

const DAY_MS = 86400000;
const THIN_HISTORY_SESSIONS = 3; // below this → mostly-null identity
const MAX_LIFTS = 8;             // most recently active lifts kept
const MAX_PR_HISTORY = 3;        // last N PR events per lift
const MAX_MILESTONES = 6;
const MILESTONE_WINDOW_DAYS = 60;
const TRAILING_WEEKS = 8;

// Parse 'YYYY-MM-DD' (or a Date) to UTC-noon ms — immune to TZ off-by-ones.
function dateMs(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12) : null;
  }
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isFinite(ms) ? ms : null;
}

function isoOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Monday-based week index (1970-01-01 was a Thursday; +3 days aligns Monday).
function weekIndex(ms) {
  return Math.floor((Math.floor(ms / DAY_MS) + 3) / 7);
}

// Whole calendar months between two UTC-noon timestamps (floor).
function monthsBetween(fromMs, toMs) {
  if (toMs < fromMs) return 0;
  const a = new Date(fromMs);
  const b = new Date(toMs);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function emptyIdentity() {
  return {
    first_session_date: null,
    tenure_months: null,
    days_since_last_session: null,
    longest_gap_days: null,
    consistency: null,
    lift_prs: {},
    recent_milestones: [],
  };
}

function buildAthleteIdentity(logRows, { asOf } = {}) {
  const asOfMs = dateMs(asOf);
  if (asOfMs == null || !Array.isArray(logRows) || !logRows.length) return emptyIdentity();

  // Normalize + keep only rows with a parseable date and an exercise name.
  const rows = [];
  for (const raw of logRows) {
    const o = normRow(raw);
    if (!o || !o.canonical_exercise || !o.canonical_exercise.trim()) continue;
    const ms = dateMs(o.date_clean);
    if (ms == null || ms > asOfMs) continue; // never read the future relative to asOf
    rows.push({ ...o, ms });
  }
  if (!rows.length) return emptyIdentity();

  // Chronological order: date, then session_id (stable within a day).
  rows.sort((a, b) => (a.ms - b.ms) || (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0));

  // Sessions = distinct session ids (fall back to the day when the id is blank).
  const sessionDates = new Map(); // session key → first ms seen
  for (const r of rows) {
    const key = r.session_id || `day:${r.ms}`;
    if (!sessionDates.has(key)) sessionDates.set(key, r.ms);
  }
  const sessionMsList = [...sessionDates.values()].sort((a, b) => a - b);
  if (sessionMsList.length < THIN_HISTORY_SESSIONS) return emptyIdentity();

  const firstMs = sessionMsList[0];
  const lastMs = sessionMsList[sessionMsList.length - 1];

  // Gaps between consecutive distinct session DAYS.
  const uniqueDays = [...new Set(sessionMsList)];
  let longestGap = 0;
  for (let i = 1; i < uniqueDays.length; i++) {
    longestGap = Math.max(longestGap, Math.round((uniqueDays[i] - uniqueDays[i - 1]) / DAY_MS));
  }

  // Consistency: consecutive Monday-weeks with ≥1 session, walking back from the
  // asOf week (the current week gets grace if it has no session yet), plus the
  // trailing-8-week session rate.
  const weeksTrained = new Set(sessionMsList.map(weekIndex));
  let streakWeek = weekIndex(asOfMs);
  if (!weeksTrained.has(streakWeek)) streakWeek -= 1;
  let streak = 0;
  while (weeksTrained.has(streakWeek - streak)) streak += 1;
  const windowStart = asOfMs - (TRAILING_WEEKS * 7 - 1) * DAY_MS;
  const recentSessions = sessionMsList.filter(ms => ms >= windowStart).length;
  const perWeek = Math.round((recentSessions / TRAILING_WEEKS) * 10) / 10;

  // Per-lift PR events over WORKING sets (warm-ups excluded), chronological.
  const byLift = new Map(); // exercise name → { events: [{weight,reps,date,ms}], lastActiveMs }
  for (const r of rows) {
    const name = r.canonical_exercise.trim();
    let entry = byLift.get(name);
    if (!entry) { entry = { events: [], best: 0, lastActiveMs: r.ms }; byLift.set(name, entry); }
    entry.lastActiveMs = Math.max(entry.lastActiveMs, r.ms);
    if (isWarmupNote(r.notes)) continue;
    if (!Number.isFinite(r.weight) || r.weight <= 0 || !Number.isFinite(r.reps) || r.reps <= 0) continue;
    if (r.weight > entry.best) {
      entry.best = r.weight;
      entry.events.push({ weight: r.weight, reps: r.reps, date: isoOf(r.ms), ms: r.ms });
    }
  }

  const liftNames = [...byLift.entries()]
    .filter(([, e]) => e.events.length > 0)
    .sort((a, b) => b[1].lastActiveMs - a[1].lastActiveMs)
    .slice(0, MAX_LIFTS)
    .map(([name]) => name);

  const lift_prs = {};
  const allEvents = [];
  for (const name of liftNames) {
    const { events } = byLift.get(name);
    const history = events.slice(-MAX_PR_HISTORY).map(({ weight, reps, date }) => ({ weight, reps, date }));
    const last = events[events.length - 1];
    lift_prs[name] = { history, current_best: { weight: last.weight, reps: last.reps, date: last.date } };
    for (const ev of events) allEvents.push({ exercise: name, weight: ev.weight, reps: ev.reps, date: ev.date, ms: ev.ms });
  }

  const milestoneFloor = asOfMs - MILESTONE_WINDOW_DAYS * DAY_MS;
  const recent_milestones = allEvents
    .filter(ev => ev.ms >= milestoneFloor)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, MAX_MILESTONES)
    .map(({ exercise, weight, reps, date }) => ({ exercise, weight, reps, date }));

  return {
    first_session_date: isoOf(firstMs),
    tenure_months: monthsBetween(firstMs, asOfMs),
    days_since_last_session: Math.max(0, Math.round((asOfMs - lastMs) / DAY_MS)),
    longest_gap_days: uniqueDays.length > 1 ? longestGap : null,
    consistency: { current_weekly_streak: streak, sessions_per_week_8wk: perWeek },
    lift_prs,
    recent_milestones,
  };
}

module.exports = { buildAthleteIdentity };
