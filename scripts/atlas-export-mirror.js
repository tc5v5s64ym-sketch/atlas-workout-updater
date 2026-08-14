#!/usr/bin/env node
'use strict';

// `npm run atlas:export-mirror` — run the completed-session Sheets export by hand.
//
// AUTHORITY: `docs/SUPABASE_HOT_PATH_MIGRATION.md` §5.4.
//
// This is the owner-run consumer of `services/sheetsMirrorExport.js`, and it runs
// exactly the code the background worker runs — same claim, same allocation, same
// pre-write range check, same whole-tab verification, same acknowledgement. There is
// no separate manual path that could behave differently from the automatic one.
//
// `--status` reports the backlog without exporting anything, which is the read-only
// question ("how far behind is the mirror") and needs no owner authorization.
//
// WRITE SAFETY. A run without `--status` WRITES GOOGLE SHEETS — the four mirrored
// tabs, inside each session's own allocated block, never by append and never by
// delete. It writes no Supabase workout data: its only Supabase writes are the
// export-state columns of `atlas.workout_sessions` and the mirror allocations.
//
// It cannot corrupt a workout. Supabase is the authority, this projects it, and a
// refusal leaves the session unexported rather than half-written.

const { runExportPass, exportStatus } = require('../services/sheetsMirrorExport');

function parseArgs(argv) {
  const args = { status: false, json: false, maxSessions: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--status') args.status = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--max' && argv[i + 1]) { args.maxSessions = Number(argv[i + 1]); i += 1; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.status) {
    const status = await exportStatus();
    if (args.json) { console.log(JSON.stringify(status, null, 2)); return 0; }
    console.log(`Sessions owing an export : ${status.sessions_owed}`);
    console.log(`Sessions blocked         : ${status.sessions_blocked}`);
    console.log(`Oldest owed              : ${status.oldest_session_id || '(none)'}`);
    for (const row of status.blocked) {
      console.log(`  BLOCKED ${row.session_id} (${row.attempts} attempts) — ${row.error}`);
    }
    // A blocked session needs the owner, so it is a non-zero exit: this command is
    // runnable from a scheduler and silence must not look like health.
    return status.sessions_blocked > 0 ? 2 : 0;
  }

  const pass = await runExportPass({ maxSessions: args.maxSessions });
  if (args.json) { console.log(JSON.stringify(pass, null, 2)); }
  else {
    for (const result of pass.results) {
      console.log(result.exported
        ? `exported ${result.session_id}`
        : `NOT exported ${result.session_id} — ${result.reason} (${result.state || 'n/a'})`);
    }
    if (!pass.results.length) console.log('nothing owed an export');
    if (pass.stopped) console.log(`pass stopped: ${pass.stopped} ${pass.detail || ''}`);
  }
  return pass.results.some((r) => !r.exported) || pass.stopped ? 2 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error('❌ Mirror export failed:', error && error.message);
    process.exitCode = 1;
  });
