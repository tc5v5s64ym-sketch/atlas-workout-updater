#!/usr/bin/env node
'use strict';

// #1164 — read-only audit: sessions FINALIZED in Session_Plans that have no Log_Cleaned rows.
//
// Usage:
//   npm run audit:finalized-orphans
//   npm run audit:finalized-orphans -- --json
//
// Why this exists. `/api/log-workout/undo-last` deletes Log_Cleaned rows and, before the #1164
// guard, consulted no closeout state. Session_Plans is a separate ALREADY-LIVE lane, so undoing a
// closed-out session left Session_Plans asserting `finalized` for a session whose rows were gone.
// The guard stops NEW occurrences; this audit finds EXISTING ones.
//
// READ-ONLY AND NON-DESTRUCTIVE. It reads two tabs and prints counts. It never repairs, mutates,
// deletes, or writes anything, and it never emits workout content — session dates, plan versions,
// and row counts only, never exercises, weights, reps, or notes.
//
// Honesty rule, matching the other Atlas instruments: an unreadable tab is reported as UNKNOWN and
// exits non-zero. It is never presented as "no orphans found" — absence of evidence is not a clean
// bill of health.

require('dotenv').config();

const sheets = require('../sheets');
const { SESSION_PLANS_TAB } = require('../services/sessionPlanStore');
const { foldSessionPlans } = require('../services/sessionPlanReader');
const { logCleanedColumns } = require('../config/columns');

const LOG_TAB = sheets.logSheetName || 'Log_Cleaned';
const SID_IDX = logCleanedColumns.indexOf('session_id');

async function audit() {
  let tabs;
  try {
    tabs = await sheets.getSpreadsheetTabs();
  } catch (error) {
    return { status: 'unknown', reason: 'tab_list_unreadable', detail: String(error && error.message || error).slice(0, 120) };
  }
  if (!tabs.includes(SESSION_PLANS_TAB)) {
    return { status: 'unknown', reason: 'session_plans_tab_absent' };
  }

  let planRows;
  try {
    planRows = await sheets.getSheetRows(SESSION_PLANS_TAB);
  } catch (error) {
    return { status: 'unknown', reason: 'session_plans_unreadable', detail: String(error && error.message || error).slice(0, 120) };
  }

  let logRows;
  try {
    logRows = await sheets.getSheetRows(LOG_TAB);
  } catch (error) {
    return { status: 'unknown', reason: 'log_cleaned_unreadable', detail: String(error && error.message || error).slice(0, 120) };
  }

  const logCounts = new Map();
  for (const row of Array.isArray(logRows) ? logRows : []) {
    const sid = String(Array.isArray(row) && row[SID_IDX] != null ? row[SID_IDX] : '').trim();
    if (sid) logCounts.set(sid, (logCounts.get(sid) || 0) + 1);
  }

  const folded = foldSessionPlans(planRows);
  const finalized = folded.filter((s) => s && s.status === 'finalized');
  const errored = folded.filter((s) => s && s.status === 'error');

  const orphans = finalized
    .filter((s) => (logCounts.get(String(s.session_id).trim()) || 0) === 0)
    .map((s) => ({
      session_date: s.date || null,
      plan_version: s.plan_version || null,
      planned_items: Array.isArray(s.planned) ? s.planned.length : null,
      log_rows: 0,
    }));

  return {
    status: orphans.length ? 'orphans_found' : 'clean',
    summary: {
      finalized_sessions: finalized.length,
      orphaned_sessions: orphans.length,
      unfoldable_sessions: errored.length,
      log_sessions_seen: logCounts.size,
    },
    // Session identifiers are deliberately NOT published — the date and plan_version locate a row
    // for the owner without putting a session id into a shared report.
    orphans,
  };
}

function render(result) {
  if (result.status === 'unknown') {
    console.log(`Finalized-orphan audit — UNKNOWN (${result.reason})`);
    if (result.detail) console.log(`  detail: ${result.detail}`);
    console.log('  This is NOT a clean result. The audit could not read what it needed.');
    return 2;
  }
  const s = result.summary;
  console.log(`Finalized-orphan audit — ${result.status === 'clean' ? 'CLEAN' : 'ORPHANS FOUND'}`);
  console.log(`  finalized sessions:   ${s.finalized_sessions}`);
  console.log(`  orphaned (no rows):   ${s.orphaned_sessions}`);
  console.log(`  unfoldable sessions:  ${s.unfoldable_sessions}`);
  console.log(`  sessions in the log:  ${s.log_sessions_seen}`);
  for (const o of result.orphans) {
    console.log(`   - ${o.session_date || 'unknown date'}  plan_version=${o.plan_version || 'none'}  planned_items=${o.planned_items}`);
  }
  if (result.orphans.length) {
    console.log('  Historical data is NOT repaired by this tool. Report findings to the owner.');
  }
  return result.orphans.length ? 1 : 0;
}

if (require.main === module) {
  audit()
    .then((result) => {
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.status === 'unknown' ? 2 : (result.orphans && result.orphans.length ? 1 : 0));
      }
      process.exit(render(result));
    })
    .catch((error) => {
      console.error('Finalized-orphan audit failed:', String(error && error.message || error).slice(0, 200));
      process.exit(2);
    });
}

module.exports = { audit };
