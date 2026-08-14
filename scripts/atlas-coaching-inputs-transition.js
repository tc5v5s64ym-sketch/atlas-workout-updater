#!/usr/bin/env node
'use strict';

// `npm run atlas:coaching-inputs-transition` — the ONE-TIME carry-over of the four
// coaching inputs from Google Sheets into Supabase.
//
// AUTHORITY: OWNER CORRECTION 2026-08-13, recorded in
// `docs/ATLAS_V1_EXECUTION_PLAN.md`. The correction made Supabase the sole authority
// for `Coaching_Notes`, `Constraints`, `Deload_State` and `Modality_Log`, and those tabs hold
// REAL PRODUCTION DATA — the owner's accumulated coaching notes, the injuries and
// restrictions they have typed, and the deload state machine's history.
//
// ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────
//
// Cutting over to empty tables would be silent data loss with a safety consequence,
// not a clean slate. An empty `atlas.constraints` reads as "this athlete has
// reported no injuries", and the engine would immediately prescribe into one. An
// empty `atlas.deload_state` reads as NORMAL, and an athlete mid-deload would be
// given their full working load. Neither failure announces itself.
//
// ── WHAT IT IS, EXACTLY ──────────────────────────────────────────────────────
//
// A bounded, one-time, owner-run copy. It reads the four tabs, maps each row
// through the same column contract the runtime uses, and inserts. It is:
//
//   DRY-RUN BY DEFAULT.       It prints what it would insert and writes nothing.
//                             `--apply` is the only way to write, and it is typed
//                             by the owner.
//   ATOMIC + IDEMPOTENT.      All four destinations are checked empty and inserted
//                             in ONE transaction. A second or partial run inserts
//                             nothing; one occupied destination refuses them all.
//   NOT A BRIDGE.             It runs ONCE, before writes reopen. It is not wired
//                             into any route, no runtime path calls it, and it
//                             reconciles nothing on an ongoing basis.
//   READ-ONLY ON SHEETS.      It never writes to Google Sheets, so a failed run
//                             leaves the source exactly as it found it.
//
// ── EXACT SUNSET ─────────────────────────────────────────────────────────────
//
// This file is deleted in the same PR that closes the S4 cutover loop — the bounded
// post-window cleanup PR that also converges `atlas.migration_divergences`
// (docs/SUPABASE_HOT_PATH_MIGRATION.md §5.4 step 5). Its closure condition is
// exact: once the cutover is verified and writes have reopened, the three tabs are
// no longer read by anything, so a second carry-over could only import stale rows.
// It has no other consumer and no reason to survive that PR.
//
// ── A VERIFIED-ABSENT SOURCE TAB IS A ZERO-ROW SOURCE, ACKNOWLEDGED BY THE OWNER ──
//
// The production workbook never held every coaching-input tab: all four are
// OPTIONAL tabs in `config/sheetContract.js`, the runtime reads an absent tab as
// empty (constraints read as [], deload state reads as NORMAL), and every write
// path refuses to append to a tab that does not exist. A tab that is absent has
// therefore accumulated no rows that this carry-over could lose.
//
// Absence is a DURABLE SCHEMA FACT and is never inferred from an error message.
// It is established only by `sheets.confirmTabMissing` — the spreadsheet metadata
// was readable AND the tab is not in the enumerated list. A permission failure, a
// transient API failure, a malformed range against a tab that exists, unreadable
// metadata, or a missing spreadsheet still refuses the whole transition.
//
// What the workbook cannot prove is HISTORY: "absent today" reads the same for a
// tab that never existed and a tab someone deleted. Only the owner can tell those
// apart. So `--apply` REFUSES a verified-absent tab unless the owner names it with
// `--accept-absent-tab=<Tab>` — the typed command is the recorded acknowledgment
// that the tab never held data. The dry run reports absence and shows the exact
// flag the apply will require.
//
// USAGE
//   npm run atlas:coaching-inputs-transition            # dry run, writes nothing
//   npm run atlas:coaching-inputs-transition -- --apply # the owner-run write
//   npm run atlas:coaching-inputs-transition -- --json  # machine-readable report
//   npm run atlas:coaching-inputs-transition -- --apply --accept-absent-tab=Coaching_Notes
//                                                       # owner acknowledges an absent tab

const sheets = require('../sheets');
const adapter = require('../services/supabaseAdapter');
const {
  coachingNotesColumns, constraintsColumns, deloadStateColumns, modalityLogColumns,
} = require('../config/columns');

// The four concepts, each with the tab it comes from, the destination reader that
// proves the destination is empty, and the mapper that turns a cell row into the
// insert. Declared as data so the report, the emptiness check and the write all
// walk exactly the same list — there is no path here that handles one concept and
// forgets another.
const CONCEPTS = [
  {
    name: 'coaching_notes',
    tab: process.env.COACHING_NOTES_SHEET_NAME || 'Coaching_Notes',
    columns: coachingNotesColumns,
    readDestination: () => adapter.coachingNotes('migrate'),
    // A row is worth carrying only when it carries the thing the concept is FOR.
    // A blank note is not a note.
    isMeaningful: (row) => String(row[1] || '').trim() !== '',
    payload: (row) => ({
      date: String(row[0] || '').trim(),
      note: String(row[1] || '').trim(),
    }),
  },
  {
    name: 'constraints',
    tab: process.env.CONSTRAINTS_SHEET_NAME || 'Constraints',
    columns: constraintsColumns,
    readDestination: () => adapter.constraints('migrate'),
    // The runtime's own filter: a constraint without kind, target and rule is not a
    // constraint, and `GET /api/constraints` already drops it. Carrying it over
    // would import a row the engine has never been able to act on.
    isMeaningful: (row) => ['1', '2', '3'].every((i) => String(row[Number(i)] || '').trim() !== ''),
    payload: (row) => ({
      date: String(row[0] || '').trim(),
      kind: String(row[1] || '').trim(),
      target: String(row[2] || '').trim(),
      rule: String(row[3] || '').trim(),
      note: String(row[4] || '').trim(),
    }),
  },
  {
    name: 'deload_state',
    tab: process.env.DELOAD_STATE_SHEET_NAME || 'Deload_State',
    columns: deloadStateColumns,
    readDestination: () => adapter.deloadStateRows('migrate'),
    isMeaningful: (row) => String(row[1] || '').trim() !== '',
    // IN SHEET ORDER, and that is load-bearing rather than incidental: the current
    // state is the NEWEST row, so an import that reordered the history would change
    // which state the athlete is in.
    payload: (row) => deloadStateColumns.map((_, i) => String(row[i] == null ? '' : row[i])),
  },
  {
    // Cardio and conditioning. Included because `/api/log-modality` is an
    // athlete-facing preview → approve → write path, so its store is
    // workout-critical and moved with the rest of the workout.
    name: 'modality_log',
    tab: process.env.MODALITY_LOG_SHEET_NAME || 'Modality_Log',
    columns: modalityLogColumns,
    readDestination: () => adapter.modalityLogRows('migrate'),
    // `modality` is the one field the row cannot mean anything without.
    isMeaningful: (row) => String(row[2] || '').trim() !== '',
    payload: (row) => modalityLogColumns.map((_, i) => String(row[i] == null ? '' : row[i])),
  },
];

function parseArgs(argv) {
  const acceptAbsentTabs = [];
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith('--accept-absent-tab=')) {
      for (const piece of arg.slice('--accept-absent-tab='.length).split(',')) {
        const name = piece.trim();
        if (name) acceptAbsentTabs.push(name);
      }
    }
  }
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    help: argv.includes('--help') || argv.includes('-h'),
    acceptAbsentTabs,
  };
}

function printHelp() {
  console.log(`
atlas:coaching-inputs-transition — one-time carry-over of the coaching inputs.

  Coaching_Notes -> atlas.coaching_notes
  Constraints    -> atlas.constraints
  Deload_State   -> atlas.deload_state
  Modality_Log   -> atlas.modality_log

  (no flags)   DRY RUN. Reads both sides and reports. Writes nothing.
  --apply      Perform the inserts. Owner-run, once, before writes reopen.
  --json       Machine-readable report.
  --accept-absent-tab=<Tab>
               Owner acknowledgment that a VERIFIED-absent source tab never held
               data, so it carries zero rows. Repeatable; commas allowed. Without
               it, --apply refuses an absent tab.

REFUSES to run --apply against a destination that already holds rows. There is no
merge and no partial re-run: a second import is how a duplicate constraint set gets
built, and a duplicated injury restriction is not a harmless duplicate.

REFUSES to run --apply when a source tab is verified absent and not acknowledged
with --accept-absent-tab. Absence is verified only against the workbook's own tab
list (sheets.confirmTabMissing); an unreadable tab or workbook still refuses.
`.trim());
}

// Read one tab, header-stripped. A tab that is UNREADABLE is a REFUSAL, never an
// empty carry-over: importing nothing because the source could not be read is the
// exact silent loss this script exists to prevent. A tab that is VERIFIED ABSENT —
// established only by the two-step authority in `sheets.confirmTabMissing`
// (metadata readable AND the tab not in the workbook's own tab list) — is a
// zero-row source, reported as such, and gated at --apply by the owner
// acknowledgment above. Every other failure still throws and refuses the run.
async function readSource(concept) {
  let rows;
  try {
    rows = await sheets.getSheetRows(concept.tab);
  } catch (error) {
    if (!(await sheets.confirmTabMissing(error, concept.tab))) throw error;
    return { rows: [], tabAbsent: true };
  }
  return {
    rows: (Array.isArray(rows) ? rows : []).filter(
      (row) => Array.isArray(row) && row.some((cell) => String(cell == null ? '' : cell).trim() !== '')
    ),
    tabAbsent: false,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { printHelp(); return null; }

  if (!adapter.isConfigured('migrate')) {
    throw new Error(
      'ATLAS_SUPABASE_MIGRATE_URL is not set. This transition runs as atlas_migrate — the ' +
      'owner-run maintenance principal — and never as the runtime role.'
    );
  }

  const report = { apply: args.apply, concepts: [], refusals: [] };
  const payload = { coachingNotes: [], constraints: [], deloadState: [], modalityLog: [] };
  const payloadKey = {
    coaching_notes: 'coachingNotes', constraints: 'constraints',
    deload_state: 'deloadState', modality_log: 'modalityLog',
  };

  for (const concept of CONCEPTS) {
    const source = await readSource(concept);
    const meaningful = source.rows.filter(concept.isMeaningful);
    const destination = await concept.readDestination();
    const absenceAccepted = source.tabAbsent ? args.acceptAbsentTabs.includes(concept.tab) : null;

    const entry = {
      concept: concept.name,
      tab: concept.tab,
      source_tab_absent: source.tabAbsent,
      absence_accepted: absenceAccepted,
      source_rows: source.rows.length,
      carryable_rows: meaningful.length,
      skipped_incomplete: source.rows.length - meaningful.length,
      destination_rows: destination.length,
      inserted: 0,
      status: 'dry_run',
    };

    // An empty destination is the only state in which "insert everything" is
    // correct. The adapter repeats this check inside the all-concept transaction.
    // Both refusals are computed on the dry run too, so the dry run previews the
    // exact apply verdict rather than a friendlier one.
    if (destination.length > 0) {
      entry.status = 'refused_destination_not_empty';
      report.refusals.push(entry.concept);
    } else if (source.tabAbsent && !absenceAccepted) {
      entry.status = 'refused_source_tab_absent';
      report.refusals.push(entry.concept);
    }
    payload[payloadKey[concept.name]] = meaningful.map(concept.payload);
    report.concepts.push(entry);
  }

  if (args.apply && report.refusals.length === 0) {
    const inserted = await adapter.transitionCoachingInputs(payload);
    for (const entry of report.concepts) {
      entry.inserted = Number(inserted[entry.concept] || 0);
      entry.status = 'applied';
    }

    // Read all four back. The transaction began from empty, so exact counts prove
    // that every planned row landed and that no concept was only partly carried.
    for (const concept of CONCEPTS) {
      const destination = await concept.readDestination();
      const entry = report.concepts.find((item) => item.concept === concept.name);
      if (destination.length !== entry.carryable_rows) {
        throw new Error(`${concept.name} verification failed: expected ${entry.carryable_rows}, found ${destination.length}`);
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const applied = args.apply && report.refusals.length === 0;
    console.log(applied ? 'COACHING INPUTS TRANSITION — APPLIED'
      : args.apply ? 'COACHING INPUTS TRANSITION — REFUSED (nothing written)'
        : 'COACHING INPUTS TRANSITION — DRY RUN (nothing written)');
    for (const entry of report.concepts) {
      const absentNote = entry.source_tab_absent
        ? (entry.absence_accepted ? ' SOURCE TAB ABSENT (verified, acknowledged)' : ' SOURCE TAB ABSENT (verified)')
        : '';
      console.log(
        `  ${entry.concept.padEnd(16)} ${entry.tab.padEnd(16)} ` +
        `source=${entry.source_rows} carryable=${entry.carryable_rows} ` +
        `skipped=${entry.skipped_incomplete} destination=${entry.destination_rows} ` +
        `inserted=${entry.inserted} [${entry.status}]${absentNote}`
      );
    }
    const notEmpty = report.concepts.filter((e) => e.status === 'refused_destination_not_empty');
    const absent = report.concepts.filter((e) => e.status === 'refused_source_tab_absent');
    if (notEmpty.length) {
      console.log(
        `\nREFUSED ALL CONCEPTS because ${notEmpty.map((e) => e.concept).join(', ')} already holds rows. ` +
        'The transition is all-or-nothing; there is no merge or partial re-run.'
      );
    }
    if (absent.length) {
      console.log(
        `\n${notEmpty.length ? 'ALSO refused' : 'REFUSED ALL CONCEPTS'} because these source tabs are verified absent ` +
        'and not acknowledged. If (and only if) each tab never held data, acknowledge it explicitly:\n' +
        absent.map((e) => `  --accept-absent-tab=${e.tab}`).join('\n')
      );
    }
    if (!args.apply) console.log('\nRe-run with --apply to write. Owner-run, once, before writes reopen.');
  }

  await adapter.close().catch(() => {});
  if (report.refusals.length && args.apply) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[coaching-inputs-transition] FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { CONCEPTS, parseArgs, readSource, main };
