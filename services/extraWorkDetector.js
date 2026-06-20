'use strict';

// Unprogrammed / extra-work detector.
//
// Deterministic. Pure function. No I/O, no history, no LLM.
// Compares what was prescribed against what was logged and reports work that
// went BEYOND the plan:
//   - extra_sets:      a planned exercise logged for more sets than prescribed.
//   - extra_exercises: a logged exercise that was not in the plan at all.
//
// The engine only reports the facts; the coach voice may word them later
// (e.g. "you added 2 extra sets of bench and threw in some curls"). It never
// invents numbers and never writes.
//
// Matching: a logged exercise is tied to a prescribed one by lift_code when both
// carry a non-null code (identity supersedes name), otherwise by case-insensitive
// name. This mirrors planMatcher's identity rule.

function nameOf(x) {
  if (!x) return '';
  return String(typeof x === 'string' ? x : (x.name || x.exercise || '')).trim();
}

function codeOf(x) {
  return (x && typeof x === 'object' && (x.lift_code || x.liftCode)) || null;
}

// Logged set count: accept an explicit count (sets / set_count / setsLogged) or
// an array of sets whose length is the count.
function setCountOf(x) {
  if (!x || typeof x !== 'object') return null;
  if (Array.isArray(x.sets)) return x.sets.length;
  for (const k of ['sets', 'set_count', 'setsLogged', 'logged_sets']) {
    if (typeof x[k] === 'number' && Number.isFinite(x[k])) return x[k];
  }
  return null;
}

function targetSetsOf(x) {
  if (!x || typeof x !== 'object') return null;
  for (const k of ['target_sets', 'targetSets', 'sets', 'prescribed_sets']) {
    if (typeof x[k] === 'number' && Number.isFinite(x[k])) return x[k];
  }
  return null;
}

function sameCode(a, b) {
  return Boolean(a) && Boolean(b) &&
    String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
}

function sameName(a, b) {
  return Boolean(a) && Boolean(b) && a.toLowerCase() === b.toLowerCase();
}

/**
 * @param {Array<{exercise?:string,name?:string,lift_code?:string,target_sets?:number}>} prescribed
 * @param {Array<{exercise?:string,name?:string,lift_code?:string,sets?:number|Array}>} logged
 * @returns {{
 *   extra_sets: Array<{exercise:string, prescribed_sets:number, logged_sets:number, extra:number}>,
 *   extra_exercises: Array<{exercise:string}>,
 *   has_extra: boolean
 * }}
 */
function detectExtraWork(prescribed, logged) {
  const plan = (Array.isArray(prescribed) ? prescribed : [])
    .map(p => ({ name: nameOf(p), code: codeOf(p), target: targetSetsOf(p) }))
    .filter(p => p.name);
  const done = (Array.isArray(logged) ? logged : [])
    .map(l => ({ name: nameOf(l), code: codeOf(l), count: setCountOf(l) }))
    .filter(l => l.name);

  const extra_sets = [];
  const extra_exercises = [];

  for (const l of done) {
    const match = plan.find(p =>
      (l.code && p.code && sameCode(l.code, p.code)) || sameName(l.name, p.name)
    );

    if (!match) {
      // Logged but never prescribed → unprogrammed addition.
      extra_exercises.push({ exercise: l.name });
      continue;
    }

    // Planned: did it exceed the prescribed set count?
    if (typeof match.target === 'number' && match.target > 0 &&
        typeof l.count === 'number' && l.count > match.target) {
      extra_sets.push({
        exercise: match.name,
        prescribed_sets: match.target,
        logged_sets: l.count,
        extra: l.count - match.target,
      });
    }
  }

  return {
    extra_sets,
    extra_exercises,
    has_extra: extra_sets.length > 0 || extra_exercises.length > 0,
  };
}

module.exports = { detectExtraWork };
