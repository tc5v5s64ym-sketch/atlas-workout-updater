'use strict';

// Plan Matcher — infers substitution pairs from planned sessions.
//
// When a user has an active planned session and logs a workout, this module
// compares planned exercises against logged exercises to find exercises that
// were substituted (planned but not logged verbatim).
//
// It ONLY generates `prescribed` pairs for `buildSubstitutionPreviews`; the
// actual substitution classification lives in `classifySubstitution`.
//
// Pure function. No I/O. No writes.

const { patternFor } = require('./movementPattern');
const { BROAD_REGION } = require('./substitutionIntent');

function broadRegionFor(name) {
  return BROAD_REGION[patternFor(name).pattern] || 'other';
}

function sameExercise(nameA, nameB) {
  return nameA.trim().toLowerCase() === nameB.trim().toLowerCase();
}

// Two lift codes identify the same lift when both are present and equal
// (case-insensitive). Identity by code supersedes name — the same lift can be
// logged under a different display name than the plan used.
function sameLiftCode(a, b) {
  return Boolean(a) && Boolean(b) &&
    String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
}

function normalizePlan(items) {
  return (Array.isArray(items) ? items : [])
    .map(p => ({
      name: String((p && (typeof p === 'string' ? p : p.name)) || '').trim(),
      lift_code: (p && typeof p === 'object' && p.lift_code) || null,
    }))
    .filter(p => p.name);
}

function normalizeLogged(items) {
  return (Array.isArray(items) ? items : [])
    .map(l => ({
      name: String((l && (typeof l === 'string' ? l : l.name)) || '').trim(),
      lift_code: (l && typeof l === 'object' && l.lift_code) || null,
    }))
    .filter(l => l.name);
}

/**
 * Given planned exercises and logged exercises, infer which planned exercises
 * were substituted — i.e. logged as a different exercise with the same
 * movement pattern (or same broad training region as a fallback).
 *
 * Pairing heuristic (in order):
 *  1. Exact name matches (case-insensitive) → plan fulfilled, not a substitution.
 *  2. For each unmatched planned exercise, find the best unmatched logged
 *     exercise by movement pattern:
 *       a. Same fine-grained pattern (e.g. hinge → hinge, squat → squat).
 *       b. Same broad region (e.g. lower, push, pull) as a fallback.
 *  3. If no plausible match is found for a planned exercise, skip it — never
 *     force a cross-region pairing.
 *
 * @param {Array<string|{name:string, lift_code?:string}>} planExercises
 * @param {Array<string|{name:string, lift_code?:string}>} loggedExercises
 * @returns {Array<{exercise:string, logged_exercise:string, lift_code?:string}>}
 *   Prescribed pairs ready for `buildSubstitutionPreviews`.
 */
function inferPrescribedPairs(planExercises, loggedExercises) {
  const planned = normalizePlan(planExercises);
  const logged = normalizeLogged(loggedExercises);
  if (!planned.length || !logged.length) return [];

  // Step 1: exact matches — plan fulfilled, not substitutions.
  const fulfilledPlanned = new Set();
  const claimedLogged = new Set();

  // Step 1a: exact name matches (case-insensitive).
  for (const p of planned) {
    for (const l of logged) {
      if (sameExercise(p.name, l.name) && !claimedLogged.has(l.name.toLowerCase())) {
        fulfilledPlanned.add(p.name.toLowerCase());
        claimedLogged.add(l.name.toLowerCase());
        break;
      }
    }
  }

  // Step 1b: lift_code identity matches for planned lifts the name pass missed.
  // Same lift_code = same lift even when the names differ (e.g. plan "Bench Press"
  // vs logged canonical "Barbell Bench Press"). Prevents Step 2 from mislabeling
  // an identical lift as a pattern-based substitution.
  for (const p of planned) {
    if (fulfilledPlanned.has(p.name.toLowerCase()) || !p.lift_code) continue;
    for (const l of logged) {
      if (sameLiftCode(p.lift_code, l.lift_code) && !claimedLogged.has(l.name.toLowerCase())) {
        fulfilledPlanned.add(p.name.toLowerCase());
        claimedLogged.add(l.name.toLowerCase());
        break;
      }
    }
  }

  const unmatchedPlanned = planned.filter(p => !fulfilledPlanned.has(p.name.toLowerCase()));
  const remainingLogged = logged.filter(l => !claimedLogged.has(l.name.toLowerCase()));

  if (!unmatchedPlanned.length || !remainingLogged.length) return [];

  // Step 2: match unmatched planned → unmatched logged by pattern / region.
  const available = [...remainingLogged];
  const pairs = [];

  for (const p of unmatchedPlanned) {
    const pPattern = patternFor(p.name).pattern;
    const pRegion = broadRegionFor(p.name);

    // First pass: same fine-grained pattern.
    let idx = available.findIndex(l => patternFor(l.name).pattern === pPattern);

    // Second pass: same broad region (never matches 'other').
    if (idx === -1 && pRegion !== 'other') {
      idx = available.findIndex(l => broadRegionFor(l.name) === pRegion);
    }

    if (idx === -1) continue;

    const match = available.splice(idx, 1)[0];
    const pair = { exercise: p.name, logged_exercise: match.name };
    if (p.lift_code) pair.lift_code = p.lift_code;
    pairs.push(pair);
  }

  return pairs;
}

module.exports = { inferPrescribedPairs };
