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

  if (fileArg) {
    try {
      text = fs.readFileSync(fileArg, 'utf8');
    } catch (error) {
      // Neither the operator-supplied path nor Node's message is echoed: `error.message` repeats
      // the path verbatim, so printing it would reinstate on the error path exactly the unvalidated
      // label that was just removed from the success path. A filename can carry private directory
      // names or compact workout prose, and there is no contract to validate it against.
      process.stderr.write(`atlas:turn-write-artifact — cannot read the supplied artifact file (${error.code || 'read failure'})\n`);
      return 2;
    }
  } else {
    text = readStdin();
  }

  const artifact = buildTurnWriteArtifact(text);
  if (json) process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  else process.stdout.write(`${formatTurnWriteArtifact(artifact)}\n`);

  if (artifact.status === 'complete') return 0;
  return artifact.status === 'empty' ? 2 : 1;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { main };
