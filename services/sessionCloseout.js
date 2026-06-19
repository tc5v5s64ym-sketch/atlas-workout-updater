'use strict';

// Session Closeout Helper — PR 360
//
// Deterministic. Pure function. No I/O, no writes.
//
// Determines whether a planned session is fully complete and returns the
// data needed to render a session wrap-up message in the coach layer.
//
// The browser equivalent lives inside emitSetLogged (public/app.js).
// keep in sync with the planIsComplete check in emitSetLogged (public/app.js)

const { computePlanState } = require('./sessionPlanExecutor');

/**
 * computeCloseout(planned, completed) → CloseoutResult | null
 *
 * @param {Array<string|{name:string,liftCode?:string}>} planned
 *   Ordered list of planned exercises for the session.
 * @param {Array<string|{name:string,liftCode?:string}>} completed
 *   Exercises already logged/completed this session.
 *
 * @returns {{ isComplete: true, exerciseCount: number, planNames: string[] } | null}
 *   null  — plan is not yet complete (or no plan is active).
 *   object — all planned exercises are done; exerciseCount and planNames reflect
 *             the original plan (not the logged names).
 */
function computeCloseout(planned, completed) {
  if (!Array.isArray(planned) || !planned.length) return null;
  const state = computePlanState(planned, completed);
  if (!state.isComplete) return null;
  return {
    isComplete: true,
    exerciseCount: state.planned.length,
    planNames: state.planned,
  };
}

module.exports = { computeCloseout };
