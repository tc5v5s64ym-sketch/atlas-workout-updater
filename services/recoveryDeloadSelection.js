'use strict';

// Recovery & Deload SELECTION engine — Session Planning Engine §10 (PR 485).
//
// Decides WHEN the planner should choose normal training / micro-adjustment /
// recovery_reload / deload (and surfaces taper / complete-rest / pain-override
// context), from a converged set of fatigue + performance signals, and STYLES a
// deload by profile (§10.4). Convergence-based: Atlas does not deload after one
// bad session.
//
// SELECTION + RATIONALE ONLY. This does NOT compute any deload prescription —
// the protocol numbers stay owned by `computePrescription` / `docs/DELOAD_SPEC.md`
// (AI decides *if*, the engine decides *what*). The profile styles here are
// qualitative descriptors, never load/volume numbers.
//
// PURE / read-only: no I/O, no LLM, no Sheets, NO write path, NO Log_Cleaned /
// Deload_State schema change, no parser / coach / recommendation change. Consumes
// an already-derived signal snapshot; wiring it into the planner/coach is a later,
// separately-gated slice.

// The recovery decision ladder outcomes (§10.5).
const RECOVERY_DECISIONS = Object.freeze([
  'normal',            // isolated bad signal → adjust today only
  'micro_adjustment',  // one local fatigue signal → reduce/reroute that pattern
  'recovery_reload',   // multiple fatigue signals across days → lighter adjustment
  'deload',            // converged performance decline + fatigue → reduced-stress period
  'taper',             // test/competition date approaching → peak (cut volume, keep intensity)
  'complete_rest',     // illness / injury flare / burnout → cessation (rare, not the default)
]);

// The moderate warning signals that, stacked, raise the recovery decision (§10.2).
const MODERATE_WARNING_KEYS = Object.freeze([
  'performance_decline', 'subjective_fatigue', 'effort_drift', 'loads_feel_hard', 'high_soreness',
]);

// Profile-aware deload STYLE descriptors (§10.4) — qualitative, no numbers.
const DELOAD_STYLES = Object.freeze({
  strength: Object.freeze(['preserve main-lift exposure and bar feel', 'cut accessory volume first', 'reduce grinders / repeated hard sets', 'hinge may need a stronger cut than press']),
  hypertrophy: Object.freeze(['cut hard sets substantially', 'avoid failure and intensifiers', 'keep familiar exercises', 'volume reduction over total rest']),
  general_fitness: Object.freeze(['preserve routine and habit', 'reduce session length, effort, complexity', 'easy full-body / machines / walking', 'protect adherence']),
  cardio: Object.freeze(['swap hard intervals for easy base work', 'reduce high-zone volume', 'preserve easy aerobic rhythm', "don't stack hard sessions"]),
  bodyweight: Object.freeze(['reduce density, rounds, near-failure work', 'preserve skill patterns with easier leverage', 'cut high-eccentric / kipping / plyometric stress', 'easier versions, not novel soreness']),
});

function bool(v) { return v === true; }
function int(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; }

function styleFor(profile) {
  return DELOAD_STYLES[profile] ? { profile, focus: DELOAD_STYLES[profile].slice() } : null;
}

/**
 * Assess the recovery/deload decision from a converged signal snapshot.
 *
 * @param {object} signals
 * @param {string} [signals.profile]                  one of the taxonomy profiles (for deload styling)
 * @param {number} [signals.rir0_main_sessions]       consecutive sessions with unplanned RIR 0 / missed reps on MAIN lifts
 * @param {number} [signals.readiness_red_days]       consecutive planned training days readiness was red
 * @param {boolean} [signals.performance_decline]     e1RM / reps-at-load trending down across exposures
 * @param {boolean} [signals.subjective_fatigue]      volunteered/watch-derived poor sleep / mood / motivation
 * @param {boolean} [signals.high_soreness]           high soreness / joint aches
 * @param {boolean} [signals.effort_drift]            session RPE rising at unchanged workload
 * @param {boolean} [signals.loads_feel_hard]         normal loads feeling abnormally hard
 * @param {boolean} [signals.local_fatigue_signal]    a single local muscle/pattern fatigue signal
 * @param {boolean} [signals.pain_major]              a major pain warning
 * @param {string}  [signals.pain_pattern]            the affected pattern (for the pain override)
 * @param {boolean} [signals.test_date_approaching]   a test / competition date is near
 * @param {boolean} [signals.illness_or_injury_flare] illness / injury flare / burnout
 * @returns {{decision:string, deload_candidate:boolean, recovery_state:string,
 *            deload_style:(object|null), pain_override:(object|null),
 *            converged_signals:string[], rationale:string}}
 */
function assessRecoveryDeload(signals = {}) {
  const s = signals && typeof signals === 'object' ? signals : {};
  const profile = typeof s.profile === 'string' ? s.profile : null;

  const moderate = MODERATE_WARNING_KEYS.filter((k) => bool(s[k]));
  const rir0 = int(s.rir0_main_sessions);
  const redDays = int(s.readiness_red_days);

  // Pain override is computed independently of the fatigue decision (§10.5 #5):
  // a major pain warning pivots/stops the affected pattern, but is NOT by itself a deload.
  const painOverride = bool(s.pain_major)
    ? { pattern: (typeof s.pain_pattern === 'string' && s.pain_pattern) || null, action: 'pivot_or_stop' }
    : null;

  // Strong deload convergence triggers (§10.2).
  const deloadTrigger =
    rir0 >= 2 ||
    redDays >= 3 ||
    (bool(s.performance_decline) && (bool(s.subjective_fatigue) || bool(s.high_soreness)));

  const converged = [];
  if (rir0 >= 2) converged.push('repeated_rir0_main_lift');
  if (redDays >= 3) converged.push('readiness_red_3_days');
  for (const k of moderate) converged.push(k);
  if (bool(s.local_fatigue_signal)) converged.push('local_fatigue_signal');

  let decision;
  let recovery_state;
  if (bool(s.illness_or_injury_flare)) {
    decision = 'complete_rest'; recovery_state = 'cease';
  } else if (bool(s.test_date_approaching)) {
    decision = 'taper'; recovery_state = 'peak';
  } else if (deloadTrigger) {
    decision = 'deload'; recovery_state = 'deload';
  } else if (moderate.length >= 2) {
    // Multiple fatigue signals across days → the lighter adjustment that may
    // prevent a full deload (§10.5 #3).
    decision = 'recovery_reload'; recovery_state = 'reduced';
  } else if (bool(s.local_fatigue_signal)) {
    decision = 'micro_adjustment'; recovery_state = 'monitor';
  } else {
    // Isolated bad signal (or none) → adjust today only; normal routing.
    decision = 'normal'; recovery_state = moderate.length === 1 ? 'monitor' : 'recovered';
  }

  const deload_candidate = decision === 'deload';
  const deload_style = (decision === 'deload' || decision === 'recovery_reload') ? styleFor(profile) : null;

  const rationale = buildRationale(decision, converged, painOverride);

  return { decision, deload_candidate, recovery_state, deload_style, pain_override: painOverride, converged_signals: converged, rationale };
}

function buildRationale(decision, converged, painOverride) {
  const sig = converged.length ? converged.join(', ') : 'no fatigue convergence';
  let base;
  switch (decision) {
    case 'deload': base = `Converged fatigue (${sig}) → deload: reduce the stress, keep the rhythm.`; break;
    case 'recovery_reload': base = `Multiple stacked fatigue signals (${sig}) → recovery_reload before a full deload is warranted.`; break;
    case 'micro_adjustment': base = `One local fatigue signal (${sig}) → reduce/reroute that pattern only.`; break;
    case 'taper': base = 'Test/competition date approaching → taper (cut volume, keep intensity), not a fatigue deload.'; break;
    case 'complete_rest': base = 'Illness / injury flare / burnout → complete rest may be warranted, not a normal deload.'; break;
    default: base = `No convergence (${sig}) → normal training; one bad day is not a deload.`;
  }
  if (painOverride) base += ` Pain override: pivot/stop ${painOverride.pattern || 'the affected pattern'} (handled separately from the deload decision).`;
  return base;
}

module.exports = { assessRecoveryDeload, RECOVERY_DECISIONS, MODERATE_WARNING_KEYS, DELOAD_STYLES };
