#!/usr/bin/env node
'use strict';

// Build the bounded #1165 review artifact from a captured deployment log.
//
// Usage:
//   npm run atlas:turn-write-artifact -- <logfile>
//   npm run atlas:turn-write-artifact -- <logfile> --json
//   some-log-source | npm run atlas:turn-write-artifact -- --json
//
// Read-only. It parses a local/stdin log stream and never touches the app, network, or Sheets.

const fs = require('node:fs');
const {
  buildTurnWriteArtifact,
  formatTurnWriteArtifact,
} = require('../services/turnWriteArtifact');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const fileArg = args.find((arg) => arg !== '--json' && arg !== '-');
  let text = '';
  let source = 'stdin';

  if (fileArg) {
    try {
      text = fs.readFileSync(fileArg, 'utf8');
      source = fileArg;
    } catch (error) {
      process.stderr.write(`atlas:turn-write-artifact — cannot read ${fileArg}: ${error.message}\n`);
      return 2;
    }
  } else {
    text = readStdin();
  }

  const artifact = buildTurnWriteArtifact(text);
  if (json) process.stdout.write(`${JSON.stringify({ source, ...artifact }, null, 2)}\n`);
  else process.stdout.write(`${formatTurnWriteArtifact(artifact, { source })}\n`);

  if (artifact.status === 'complete') return 0;
  return artifact.status === 'empty' ? 2 : 1;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { main };
