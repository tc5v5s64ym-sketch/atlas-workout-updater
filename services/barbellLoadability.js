'use strict';

// Barbell loadability guard (P0 AC12).
//
// A computed barbell working weight is only useful if the lifter can actually load
// it. The owner's plate inventory is 45/35/25/10/5/2.5 per side on a 45 lb bar, so
// the smallest symmetric jump is 2×2.5 = 5 lb total: loadable barbell totals are
// 45, 50, 55, … (the bar, plus any multiple of 5). A prescription of e.g. 116 lb is
// NOT loadable — round it to 115 and say why, rather than asking for a plate that
// doesn't exist.
//
// PURE / no I/O. This module only ROUNDS + explains; it never decides whether a lift
// is a barbell movement (the caller does that from equipment metadata) and never
// changes the write path. The engine still owns the underlying number — this is the
// loadability snap on top of it.

const DEFAULT_BAR = 45;   // standard Olympic bar (lb)
const DEFAULT_STEP = 5;   // smallest symmetric jump with the owner's plates (2×2.5)

function asNum(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}
function asPos(v, fallback) {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
// Trim a trailing ".0" so explanations read "116" not "116.0".
function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * isLoadableBarbell(weight, opts?) → boolean
 * True when `weight` sits on the bar (≥ bar) and is an exact multiple of `step`
 * above it. opts: { bar=45, step=5 }.
 */
function isLoadableBarbell(weight, opts = {}) {
  if (!Number.isFinite(weight)) return false;
  const bar = asNum(opts.bar, DEFAULT_BAR);
  const step = asPos(opts.step, DEFAULT_STEP);
  if (weight < bar) return false;
  return Math.abs((weight - bar) % step) < 1e-9;
}

/**
 * roundToLoadableBarbell(weight, opts?) → { weight, rounded, note }
 * Snap `weight` to the nearest loadable barbell total (ties round up).
 *   weight  – the loadable weight (the bar itself when the input is at/below it)
 *   rounded – true when the value changed from the input
 *   note    – a short rounding explanation when rounded, else null
 * opts: { bar=45, step=5 }. Returns { weight:null } for a non-finite input.
 */
function roundToLoadableBarbell(weight, opts = {}) {
  if (!Number.isFinite(weight)) return { weight: null, rounded: false, note: null };
  const bar = asNum(opts.bar, DEFAULT_BAR);
  const step = asPos(opts.step, DEFAULT_STEP);

  if (weight <= bar) {
    const rounded = weight !== bar;
    return {
      weight: bar,
      rounded,
      note: rounded ? `${fmt(weight)} is below the ${bar} lb bar — using the empty bar (${bar} lb).` : null,
    };
  }

  const snapped = bar + Math.round((weight - bar) / step) * step;
  const rounded = Math.abs(snapped - weight) > 1e-9;
  return {
    weight: snapped,
    rounded,
    note: rounded ? `Rounded ${fmt(weight)} → ${snapped} lb (loadable on a ${bar} lb bar in ${step} lb jumps).` : null,
  };
}

module.exports = { isLoadableBarbell, roundToLoadableBarbell, DEFAULT_BAR, DEFAULT_STEP };
