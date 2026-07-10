'use strict';

// ── Celebration scarcity, derived not stored (Soul Plan PR-B3) ───────────────
//
// Big reactions stay rare because rarity is the feature. Instead of a new
// database field, Atlas derives "when did I last get genuinely excited" from
// the training log itself — new-ground events are already in there.
//
// computeCelebrationScarcity(logRows, { asOf, caps }) →
//   { scarcityClear, last_new_ground: {lift, date}|null,
//     new_ground_last_7d, new_ground_last_30d }
//
// SEMANTICS — reconstructs the live new_ground verdict from the SAME helpers:
// a historical new-ground EVENT on session day D for a lift is detected by
// running progressionVerdict(topOfDayD, progressionBand(all prior rows for the
// lift)) and checking level === 'new_ground'. Both helpers are IMPORTED from
// services/analytics.js (per-session top working weights, note-tagged warm-ups
// excluded from the band, ceiling = max prior session top, strictly-greater
// comparison). No re-derived PR math; if the band/verdict logic changes, this
// changes with it.
//
// ONE INTENTIONAL DIFFERENCE from the live coach top: the live `analyzeLift`
// path (services/analytics.js:720-722) computes its session `progressionTop`
// filtering only on a positive weight — it INCLUDES a tagged heavy warm-up —
// while its band excludes warm-ups. This module excludes warm-ups from the
// event-day top too, matching the band. So for a session whose max weight is a
// tagged warm-up, this module suppresses the "event" while the live verdict
// could read new_ground. That is the more-correct reading (a warm-up must never
// manufacture a working-weight PR — the reason warm-up tagging exists), but it
// means PR-B4 wiring must NOT assume byte-parity between this scarcity signal
// and a given live verdict on that edge. Reconciling the live `progressionTop`
// to exclude warm-ups is a separate trust-sensitive analytics change — filed in
// BACKLOG for PR-B4, not done here.
//
// Scarcity: `caps` defaults from config/coaching/register.calibration.json
// (PR-B2's owner data: profanity.cap → { max_per_window, rolling_days }).
// scarcityClear = the count of DISTINCT new-ground DAYS inside the rolling
// window, EXCLUDING asOf's own day, is below max_per_window. Excluding the
// asOf day means: (a) the day's own fresh event never spends the budget
// against itself, and (b) multi-lift same-day new grounds count once per the
// cap's unit (one moment-day, one budget unit). A spent budget downgrades
// celebrate → praise upstream (services/coachMode.js).
//
// PURE: injected `asOf` ('YYYY-MM-DD' or Date), no clock, no I/O beyond the
// two requires at load; derives from rows the caller already fetched — zero
// additional Sheets reads. Empty/thin/invalid input → scarcityClear: true
// with null last event (nothing has been celebrated; nothing is spent).

const { normalizeLogRow, progressionBand, progressionVerdict } = require('./analytics');
const CALIBRATION = require('../config/coaching/register.calibration.json');
const { isWarmupNote } = require('./warmupTag');

const DAY_MS = 86400000;

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

function defaultCaps() {
  const cap = CALIBRATION && CALIBRATION.profanity && CALIBRATION.profanity.cap;
  return {
    max_per_window: cap && Number.isFinite(Number(cap.max_per_window)) ? Number(cap.max_per_window) : 1,
    rolling_days: cap && Number(cap.rolling_days) > 0 ? Number(cap.rolling_days) : 7,
  };
}

function computeCelebrationScarcity(logRows, { asOf, caps } = {}) {
  const asOfMs = dateMs(asOf);
  const effCaps = { ...defaultCaps(), ...(caps && typeof caps === 'object' ? caps : {}) };
  const empty = {
    scarcityClear: true,
    last_new_ground: null,
    new_ground_last_7d: 0,
    new_ground_last_30d: 0,
  };
  if (asOfMs == null || !Array.isArray(logRows) || !logRows.length) return empty;

  // Normalize with the SAME row reader the live path uses, drop rows after asOf.
  const rows = [];
  for (const raw of logRows) {
    const r = normalizeLogRow(raw);
    if (!r || !r.lift_code) continue;
    const ms = dateMs(r.date_clean);
    if (ms == null || ms > asOfMs) continue;
    rows.push({ ...r, _ms: ms });
  }
  if (!rows.length) return empty;

  // Per lift: chronological sessions; an event where the session's top working
  // weight reads new_ground against the band of all PRIOR rows for that lift —
  // exactly progressionVerdict(top, progressionBand(prefix)).
  const byLift = new Map();
  for (const r of rows) {
    const code = String(r.lift_code).trim().toUpperCase();
    if (!byLift.has(code)) byLift.set(code, []);
    byLift.get(code).push(r);
  }

  const events = []; // { lift, date, ms }
  for (const [lift, liftRows] of byLift) {
    liftRows.sort((a, b) => (a._ms - b._ms)
      || String(a.session_id || '').localeCompare(String(b.session_id || '')));
    // Group rows by session (session_id, falling back to the day).
    const sessions = [];
    // Group by session_id ALONE — exactly as progressionBand does internally —
    // so the event-day top and the band it is judged against are computed from
    // the same session partition (the "identical by construction" guarantee). We
    // deliberately do NOT add a per-day fallback for a blank session_id: that
    // would split blank-session rows by day while progressionBand collapses them
    // into one `''` session, and the two groupings could then disagree on which
    // day clears the ceiling. Every real Log_Cleaned row carries a session_id
    // (col 2); a blank id is malformed input, and here it degrades identically to
    // the live band path rather than diverging from it.
    const seen = new Map();
    for (const r of liftRows) {
      const key = r.session_id;
      let s = seen.get(key);
      if (!s) { s = { ms: r._ms, date: String(r.date_clean).slice(0, 10), rows: [] }; seen.set(key, s); sessions.push(s); }
      s.rows.push(r);
    }
    const prefix = [];
    for (const s of sessions) {
      // Today's top working weight — warm-ups never set it (live band rule).
      let top = 0;
      for (const r of s.rows) {
        const w = Number(r.weight);
        if (Number.isFinite(w) && w > top && !isWarmupNote(r.notes)) top = w;
      }
      if (top > 0 && prefix.length) {
        const verdict = progressionVerdict(top, progressionBand(prefix));
        if (verdict && verdict.level === 'new_ground') {
          events.push({ lift, date: s.date, ms: s.ms });
        }
      }
      prefix.push(...s.rows);
    }
  }

  if (!events.length) return empty;
  events.sort((a, b) => a.ms - b.ms);

  const inWindow = (ev, days) => ev.ms > asOfMs - days * DAY_MS && ev.ms <= asOfMs;
  const last = events[events.length - 1];
  const days7 = new Set(events.filter(ev => inWindow(ev, 7)).map(ev => ev.date));
  const days30 = new Set(events.filter(ev => inWindow(ev, 30)).map(ev => ev.date));

  // Budget: distinct event DAYS in the cap window, excluding asOf's own day.
  const asOfDate = new Date(asOfMs).toISOString().slice(0, 10);
  const spentDays = new Set(events
    .filter(ev => inWindow(ev, effCaps.rolling_days) && ev.date !== asOfDate)
    .map(ev => ev.date));

  return {
    scarcityClear: spentDays.size < effCaps.max_per_window,
    last_new_ground: { lift: last.lift, date: last.date },
    new_ground_last_7d: days7.size,
    new_ground_last_30d: days30.size,
  };
}

module.exports = Object.freeze({ computeCelebrationScarcity });
