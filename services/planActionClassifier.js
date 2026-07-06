'use strict';

// STATUS (2026-07 architecture audit): DARK — roadmap Step 359 marked complete but
// no runtime consumer; wire-in-vs-retire decision filed in BACKLOG.md (dark-module
// disposition item). Distinct from the LIVE frontend classifier
// public/planMutationIntent.js — do not conflate them.

// Plan Action Classifier — PR 359
//
// Deterministic. Pure function. No I/O, no writes.
//
// Classifies a SINGLE logged exercise against an active session plan and
// returns the plan-level action: on_plan, reorder, substitute, add, or skip.
//
// Inputs are already-resolved exercise names — this is NOT a parser.
// Caller is responsible for calling classifyPlanAction only for exercises
// that have not already been classified in the current session (first log
// of each exercise, not every set).
//
// Dependencies:
//   sessionPlanExecutor.computePlanState  — computes remaining exercises
//   planMatcher.inferPrescribedPairs      — detects pattern/region matches for substitute

const { computePlanState } = require('./sessionPlanExecutor');
const { inferPrescribedPairs } = require('./planMatcher');

/**
 * classifyPlanAction(opts) → PlanActionResult
 *
 * action values:
 *   'on_plan'   — logged exercise matches the current (first remaining) plan step
 *   'reorder'   — logged exercise is a later remaining plan step (jumped ahead)
 *   'substitute'— logged exercise is not in plan; inferred to fill a remaining slot
 *                  via movement pattern / broad region matching
 *   'add'       — logged exercise is not in plan and cannot fill any remaining slot
 *   'skip'      — a planned exercise is being explicitly skipped (no sets logged)
 *
 * @param {object} opts
 * @param {Array<string|{name:string,liftCode?:string}>} opts.planned
 *   Ordered list of planned exercises for the session.
 * @param {Array<string|{name:string,liftCode?:string}>} opts.completed
 *   Exercises already logged/completed this session.
 * @param {string|null} opts.loggedName
 *   The exercise name just logged. Null when classifying a skip.
 * @param {string|null} [opts.loggedLiftCode]
 *   The lift_code of the logged exercise (from enrichment). Used for identity
 *   matching when names differ (e.g. "Barbell Row" with liftCode "barbell_row"
 *   matches planned "Rows" that also carries liftCode "barbell_row").
 * @param {string|null} [opts.skippedName]
 *   The planned exercise being explicitly skipped. Non-null only for skip actions.
 *
 * @returns {{ action: string, prescribedExercise: string|null, skippedAhead: string[] }}
 *   action             — one of the five action strings above
 *   prescribedExercise — the plan entry being fulfilled, substituted, or skipped;
 *                        null for 'add' and when no plan is active
 *   skippedAhead       — for 'reorder': planned exercises jumped over (in plan order);
 *                        empty array for all other actions
 */
function classifyPlanAction(opts) {
  const {
    planned    = [],
    completed  = [],
    loggedName = null,
    loggedLiftCode = null,
    skippedName = null,
  } = opts || {};

  // ── Skip ────────────────────────────────────────────────────────────────────
  // Explicit skip: a named planned exercise with no sets logged.
  if (skippedName && !loggedName) {
    return {
      action: 'skip',
      prescribedExercise: String(skippedName).trim() || null,
      skippedAhead: [],
    };
  }

  const logged = String(loggedName || '').trim();
  if (!logged) {
    return { action: 'add', prescribedExercise: null, skippedAhead: [] };
  }

  // ── No plan ─────────────────────────────────────────────────────────────────
  const planArr = Array.isArray(planned) ? planned : [];
  if (!planArr.length) {
    return { action: 'add', prescribedExercise: null, skippedAhead: [] };
  }

  // ── Compute remaining ────────────────────────────────────────────────────────
  // computePlanState returns remaining as string names. We also need the
  // lift_code for each remaining entry so we can match by code when names
  // differ (e.g. "Barbell Row" logged vs "Rows" planned, same lift_code).
  const state = computePlanState(planArr, completed);
  const { remaining } = state;  // string[]

  if (!remaining.length) {
    // Plan already complete — anything logged now is 'add'.
    return { action: 'add', prescribedExercise: null, skippedAhead: [] };
  }

  // Build name→liftCode lookup for planned entries so lift_code matching works
  // against the remaining name strings.
  const planLiftCodeByName = new Map();
  for (const p of planArr) {
    if (!p) continue;
    const name  = String(typeof p === 'string' ? p : (p.name || '')).trim();
    const code  = String((p && typeof p === 'object') ? (p.liftCode || p.lift_code || '') : '').trim();
    if (name) planLiftCodeByName.set(name.toLowerCase(), code);
  }

  // ── Match logged exercise against remaining plan entries ─────────────────────
  const loggedKey  = logged.toLowerCase();
  const loggedCode = String(loggedLiftCode || '').trim().toLowerCase();

  let matchIdx = -1;
  for (let i = 0; i < remaining.length; i++) {
    const rKey = remaining[i].toLowerCase();
    // Exact name match.
    if (rKey === loggedKey) { matchIdx = i; break; }
    // Lift_code match — both sides must have a non-empty code.
    if (loggedCode) {
      const planCode = (planLiftCodeByName.get(rKey) || '').toLowerCase();
      if (planCode && planCode === loggedCode) { matchIdx = i; break; }
    }
  }

  // ── on_plan ─────────────────────────────────────────────────────────────────
  if (matchIdx === 0) {
    return { action: 'on_plan', prescribedExercise: remaining[0], skippedAhead: [] };
  }

  // ── reorder ─────────────────────────────────────────────────────────────────
  if (matchIdx > 0) {
    return {
      action: 'reorder',
      prescribedExercise: remaining[matchIdx],
      skippedAhead: remaining.slice(0, matchIdx),
    };
  }

  // ── substitute or add ────────────────────────────────────────────────────────
  // The logged exercise is not in the remaining plan by name or lift_code.
  // Try to pair it with a remaining planned exercise by movement pattern / region.
  const pairs = inferPrescribedPairs(remaining, [logged]);
  if (pairs.length) {
    return {
      action: 'substitute',
      prescribedExercise: pairs[0].exercise,
      skippedAhead: [],
    };
  }

  return { action: 'add', prescribedExercise: null, skippedAhead: [] };
}

module.exports = { classifyPlanAction };
