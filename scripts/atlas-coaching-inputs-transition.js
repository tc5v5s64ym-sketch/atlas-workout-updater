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
// USAGE
//   npm run atlas:coaching-inputs-transition            # dry run, writes nothing
//   npm run atlas:coaching-inputs-transition -- --apply # the owner-run write
//   npm run atlas:coaching-inputs-transition -- --json  # machine-readable report
//
// Owner workstation only (never commit):
//   ATLAS_COACHING_INPUTS_EXPECTED_SHEETS_ID=<production GOOGLE_SHEETS_ID>
//
// Required for --apply. Required before a metadata-confirmed missing tab may count as
// verified_absent (current verified absence in THAT workbook — not historical proof).

const sheets = require('../sheets');
const { confirmTabMissing } = sheets;
const adapter = require('../services/supabaseAdapter');

const EXPECTED_SHEETS_ID_ENV = 'ATLAS_COACHING_INPUTS_EXPECTED_SHEETS_ID';

/** Last characters only — never log a full spreadsheet id. */
function spreadsheetIdSuffix(id) {
  const value = String(id == null ? '' : id).trim();
  if (!value) return '(unset)';
  return value.length <= 8 ? `…${value}` : `…${value.slice(-8)}`;
}

// One-time precondition: the configured workbook must match the owner-supplied
// production id before metadata-confirmed absence may count as zero rows.
function resolveSourceWorkbookIdentity({ requireExpected = false } = {}) {
  const configuredId = String(process.env.GOOGLE_SHEETS_ID || '').trim();
  const expectedId = String(process.env[EXPECTED_SHEETS_ID_ENV] || '').trim();
  const configuredSuffix = spreadsheetIdSuffix(configuredId);
  const expectedSuffix = spreadsheetIdSuffix(expectedId);

  if (!configuredId) {
    return {
      ok: false,
      workbookVerified: false,
      configuredSuffix,
      expectedSuffix,
      reason: 'GOOGLE_SHEETS_ID is not set',
    };
  }
  if (requireExpected && !expectedId) {
    return {
      ok: false,
      workbookVerified: false,
      configuredSuffix,
      expectedSuffix,
      reason: `${EXPECTED_SHEETS_ID_ENV} is required for --apply`,
    };
  }
  if (expectedId && configuredId !== expectedId) {
    return {
      ok: false,
      workbookVerified: false,
      configuredSuffix,
      expectedSuffix,
      reason: 'configured workbook does not match expected production workbook',
    };
  }
  return {
    ok: true,
    workbookVerified: Boolean(expectedId),
    configuredSuffix,
    expectedSuffix,
  };
}
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
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    help: argv.includes('--help') || argv.includes('-h'),
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

REFUSES to run --apply against a destination that already holds rows. There is no
merge and no partial re-run: a second import is how a duplicate constraint set gets
built, and a duplicated injury restriction is not a harmless duplicate.
`.trim());
}

// Read one tab, header-stripped.
//
// A tab that is UNVERIFIED or UNREADABLE is a REFUSAL — importing nothing because
// the source could not be read is the exact silent loss this script exists to
// prevent.
//
// A tab that is VERIFIED ABSENT is equivalent to a valid zero-row source when:
//   (a) GOOGLE_SHEETS_ID matches the owner-supplied expected production workbook; and
//   (b) metadata read succeeds and the tab is missing from THAT workbook's tab list
//       (`confirmTabMissing`) — current verified absence, not historical proof.
// Permission failures, API failures, malformed ranges, wrong workbooks, and tabs
// that disappeared without proof still fail closed.
async function readSource(concept, { workbookVerified = false } = {}) {
  try {
    const rows = await sheets.getSheetRows(concept.tab);
    return {
      rows: (Array.isArray(rows) ? rows : []).filter(
        (row) => Array.isArray(row) && row.some((cell) => String(cell == null ? '' : cell).trim() !== '')
      ),
      source_status: 'read',
    };
  } catch (error) {
    if (await confirmTabMissing(error, concept.tab)) {
      if (!workbookVerified) {
        throw new Error(
          `Source tab "${concept.tab}" is absent from workbook ${spreadsheetIdSuffix(process.env.GOOGLE_SHEETS_ID)}, ` +
          'but the configured workbook is not verified as the expected production workbook. ' +
          `Set ${EXPECTED_SHEETS_ID_ENV} to the production GOOGLE_SHEETS_ID and retry.`
        );
      }
      return { rows: [], source_status: 'verified_absent' };
    }
    const message = error && error.message ? error.message : String(error);
    throw new Error(
      `Failed to read source tab "${concept.tab}": ${message}. ` +
      'Refusing to treat an unverified source as empty.'
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  if (!adapter.isConfigured('migrate')) {
    throw new Error(
      'ATLAS_SUPABASE_MIGRATE_URL is not set. This transition runs as atlas_migrate — the ' +
      'owner-run maintenance principal — and never as the runtime role.'
    );
  }

  const identity = resolveSourceWorkbookIdentity({ requireExpected: args.apply });
  if (!identity.ok) {
    throw new Error(
      `${identity.reason} (configured workbook ${identity.configuredSuffix}, ` +
      `expected ${identity.expectedSuffix})`
    );
  }

  const report = {
    apply: args.apply,
    source_workbook: identity.configuredSuffix,
    concepts: [],
    refusals: [],
  };
  const payload = { coachingNotes: [], constraints: [], deloadState: [], modalityLog: [] };
  const payloadKey = {
    coaching_notes: 'coachingNotes', constraints: 'constraints',
    deload_state: 'deloadState', modality_log: 'modalityLog',
  };

  for (const concept of CONCEPTS) {
    const { rows: source, source_status } = await readSource(concept, {
      workbookVerified: identity.workbookVerified,
    });
    const meaningful = source.filter(concept.isMeaningful);
    const destination = await concept.readDestination();

    const entry = {
      concept: concept.name,
      tab: concept.tab,
      source_status,
      source_rows: source.length,
      carryable_rows: meaningful.length,
      skipped_incomplete: source.length - meaningful.length,
      destination_rows: destination.length,
      inserted: 0,
      status: 'dry_run',
    };

    // An empty destination is the only state in which "insert everything" is
    // correct. The adapter repeats this check inside the all-concept transaction.
    if (destination.length > 0) {
      entry.status = 'refused_destination_not_empty';
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
    console.log(args.apply ? 'COACHING INPUTS TRANSITION — APPLIED' : 'COACHING INPUTS TRANSITION — DRY RUN (nothing written)');
    for (const entry of report.concepts) {
      console.log(
        `  ${entry.concept.padEnd(16)} ${entry.tab.padEnd(16)} ` +
        `source=${entry.source_rows} carryable=${entry.carryable_rows} ` +
        `skipped=${entry.skipped_incomplete} destination=${entry.destination_rows} ` +
        `inserted=${entry.inserted} [${entry.status}]`
      );
    }
    if (report.refusals.length) {
      console.log(
        `\nREFUSED ALL CONCEPTS because ${report.refusals.join(', ')} already holds rows. ` +
        'The transition is all-or-nothing; there is no merge or partial re-run.'
      );
    }
    if (!args.apply) console.log('\nRe-run with --apply to write. Owner-run, once, before writes reopen.');
  }

  await adapter.close().catch(() => {});
  if (report.refusals.length && args.apply) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[coaching-inputs-transition] FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONCEPTS,
  EXPECTED_SHEETS_ID_ENV,
  parseArgs,
  readSource,
  resolveSourceWorkbookIdentity,
  spreadsheetIdSuffix,
};
