'use strict';

// Return-after-layoff / catch-up guard.
//
// Deterministic. Pure function. No I/O, no history mutation, no LLM.
// Looks at how long it has been since the last logged session and reports
// whether the lifter is returning from a layoff — and, if so, how much to ease
// back make-up volume so a comeback session doesn't overreach.
//
// The engine only emits the signal + a volume factor; a caller (e.g. scoreIntents)
// may apply it to target_sets and the coach may word it. It never writes and
// never invents numbers.
//
// Severity tiers (pinned here so golden fixtures are deterministic):
//   < 7 days   → none        (factor 1.0)   — normal cadence, not a layoff.
//   7–13 days  → mild         (factor 0.8)   — a week+ off; trim a little.
//   14–27 days → significant  (factor 0.66)  — multiple weeks; ease back clearly.
//   >= 28 days → extended     (factor 0.5)   — detraining likely; half-volume reset.

const SEVERITY_TIERS = [
  { min: 28, severity: 'extended',    volume_factor: 0.5 },
  { min: 14, severity: 'significant', volume_factor: 0.66 },
  { min: 7,  severity: 'mild',        volume_factor: 0.8 },
];
const RETURN_THRESHOLD_DAYS = 7;

// Parse a YYYY-MM-DD (or ISO) date string to a UTC-noon epoch so whole-day
// differences are DST-safe and never off-by-one.
function utcNoon(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const m = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

// Pull a date string out of a log row (12-col array → index 0 date_clean; or an
// object with date_clean / date).
function rowDate(row) {
  if (Array.isArray(row)) return typeof row[0] === 'string' ? row[0] : null;
  if (row && typeof row === 'object') return row.date_clean || row.date || null;
  return null;
}

function latestSessionMs(logRows) {
  let latest = null;
  for (const r of (Array.isArray(logRows) ? logRows : [])) {
    const ms = utcNoon(rowDate(r));
    if (ms != null && (latest == null || ms > latest)) latest = ms;
  }
  return latest;
}

function todayUtcNoon(today) {
  const fromArg = utcNoon(today);
  if (fromArg != null) return fromArg;
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0);
}

/**
 * @param {Array} logRows  - 12-col Log_Cleaned rows or {date_clean|date} objects.
 * @param {{today?: string}} [options]
 * @returns {{
 *   days_since_last_session: number|null,
 *   returning_from_layoff: boolean,
 *   severity: 'none'|'mild'|'significant'|'extended',
 *   volume_factor: number,
 *   watch: string|null
 * }}
 */
function assessLayoff(logRows, options = {}) {
  const todayMs = todayUtcNoon(options && options.today);

  const latest = latestSessionMs(logRows);
  if (latest == null) {
    return {
      days_since_last_session: null,
      returning_from_layoff: false,
      severity: 'none',
      volume_factor: 1.0,
      watch: null,
    };
  }

  const days = Math.max(0, Math.round((todayMs - latest) / 86400000));
  const tier = SEVERITY_TIERS.find(t => days >= t.min);

  if (!tier || days < RETURN_THRESHOLD_DAYS) {
    return {
      days_since_last_session: days,
      returning_from_layoff: false,
      severity: 'none',
      volume_factor: 1.0,
      watch: null,
    };
  }

  return {
    days_since_last_session: days,
    returning_from_layoff: true,
    severity: tier.severity,
    volume_factor: tier.volume_factor,
    watch: `Returning after ${days} days off — ease back in, cap make-up volume, do not chase old numbers.`,
  };
}

module.exports = { assessLayoff, SEVERITY_TIERS, RETURN_THRESHOLD_DAYS };
