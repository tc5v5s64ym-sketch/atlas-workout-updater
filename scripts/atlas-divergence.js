#!/usr/bin/env node
'use strict';

// Atlas Phase 3 nightly divergence report (H-03/H-14).
//
// Reads the deployment's `[coach-turn-shadow]` log records — collected from the log
// stream over real training with ATLAS_INTERACTION_TRACE=shadow — and prints every place
// production contradicted or bypassed packet truth. It is the Phase-4 TODO list.
//
// Usage:
//   npm run atlas:divergence -- <logfile>        # analyze a captured log file
//   some-log-source | npm run atlas:divergence   # or read the log stream from stdin
//   npm run atlas:divergence -- <logfile> --json  # machine-readable output
//
// Read-only, deterministic. It parses logs only — it never touches Sheets, the network,
// or the running app, and it never fabricates health: 0 records in ⇒ 0 turns reported.

const fs = require('fs');
const { parseShadowLines, analyzeDivergences, formatReport } = require('../services/coachTurnDivergence');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const fileArg = args.find((a) => a !== '--json' && a !== '-');

  let text = '';
  let source = 'stdin';
  if (fileArg) {
    try { text = fs.readFileSync(fileArg, 'utf8'); source = fileArg; }
    catch (e) { process.stderr.write(`atlas:divergence — cannot read ${fileArg}: ${e.message}\n`); return 2; }
  } else {
    text = readStdin();
  }

  const records = parseShadowLines(text);
  const analysis = analyzeDivergences(records);

  if (json) {
    process.stdout.write(JSON.stringify({ source, ...analysis }, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(analysis, { source }) + '\n');
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };
