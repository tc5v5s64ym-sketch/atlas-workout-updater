'use strict';

// #1164 — durable closeout finality, for the V1 fail-closed undo contract.
//
// A workout that reached a durable `finalized` closeout in Session_Plans can no longer be undone.
// `/api/log-workout/undo-last` deletes Log_Cleaned rows and consults nothing else — it references
// no Session_Plans, no Session_Plan_Sets, no seal — so without this check an undo strips the logged
// sets while Session_Plans still asserts `finalized`, and (once the seal lane is enabled) leaves
// `closeout_write_id` stamped on rows whose sets no longer exist. Session_Plans is an ALREADY-LIVE
// lane, so that incoherence is reachable in production today, with the seal flag still 0.
//
// This module only ANSWERS. It never writes, never repairs, and never touches historical evidence.
//
// FAIL-CLOSED CONTRACT (owner ruling, 2026-07-29). Exactly two answers:
//
//   { finalized: false }  the tab EXISTS, its rows READ, the fold was CLEAN, and no finalized
//                         session matched — a positive proof of not-final. Undo may proceed.
//   { finalized: true }   a finalized session matched. Undo is refused.
//   { unknown: true }     finality could not be ESTABLISHED. The caller must refuse and delete
//                         nothing.
//
// A MISSING Session_Plans tab is `unknown`, never `finalized:false`. The tab is an expected live
// production dependency; its unexpected absence is an anomaly, not proof that a session was never
// finalized. This deliberately differs from `sessionPlanSetsStore`'s confirmed-absent branch, where
// an absent tab genuinely means "this owner has not enabled that lane yet" — the opposite posture
// is correct here, because guessing wrong deletes an athlete's completed workout.

const sheets = require('../sheets');
const { SESSION_PLANS_TAB } = require('./sessionPlanStore');
const { foldSessionPlans } = require('./sessionPlanReader');

const UNKNOWN = Object.freeze({ unknown: true });

async function isSessionFinalized(sessionId) {
  const sid = String(sessionId == null ? '' : sessionId).trim();
  if (!sid) return UNKNOWN;

  // 1. Tab list. An unreadable tab list proves nothing either way.
  let tabs;
  try {
    tabs = await sheets.getSpreadsheetTabs();
  } catch (_) {
    return UNKNOWN;
  }
  if (!Array.isArray(tabs) || !tabs.includes(SESSION_PLANS_TAB)) return UNKNOWN;

  // 2. Rows.
  let rows;
  try {
    rows = await sheets.getSheetRows(SESSION_PLANS_TAB);
  } catch (_) {
    return UNKNOWN;
  }

  // 3. Fold. `foldSessionPlans` is the same reader the rest of Atlas folds closeout state with, so
  // the guard and the reader can never disagree about what `finalized` means.
  let folded;
  try {
    folded = foldSessionPlans(rows);
  } catch (_) {
    return UNKNOWN;
  }
  if (!Array.isArray(folded)) return UNKNOWN;

  const mine = folded.filter((s) => String(s && s.session_id == null ? '' : s.session_id).trim() === sid);

  // A malformed fold for THIS session yields status 'error' — the reader's own fail-closed marker.
  // It means the durable record could not be interpreted, which is exactly `unknown`: refusing on
  // an unreadable record is safe, permitting a delete on one is not.
  if (mine.some((s) => s && s.status === 'error')) return UNKNOWN;

  return { finalized: mine.some((s) => s && s.status === 'finalized') };
}

module.exports = { isSessionFinalized, SESSION_PLANS_TAB };
