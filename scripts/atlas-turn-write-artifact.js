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
  MAX_INPUT_CHARS,
} = require('../services/turnWriteArtifact');

// The parser's size cap only limits what the parser allocates. It cannot help if the CALLER has
// already materialized the whole input, and this CLI is the only production caller — so an
// oversized capture could exhaust memory during the read and emit no artifact at all, which is
// exactly the outcome the bound exists to prevent. The cap is therefore applied WHILE READING:
// a bounded descriptor read that stops once it has enough, for a file and for stdin alike.
//
// One extra chunk beyond the cap is read on purpose, so the parser can still see that the input
// overflowed and report the truncation instead of silently presenting a partial artifact as whole.
const READ_CHUNK = 1 << 16;
const READ_CEILING = MAX_INPUT_CHARS + READ_CHUNK;

// Returns the decoded text AND whether the read stopped before EOF. The flag is not inferable from
// the decoded length: this ceiling counts BYTES, and a multibyte capture decodes to fewer
// characters than it occupies — five million `é` fill ~10 MB yet decode to ~5M characters, well
// under the parser's character cap. Relying on length alone let a truncated read report `complete`
// with zero rejected records.
function readBounded(fd) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(READ_CHUNK);
  let total = 0;
  let truncated = false;
  for (;;) {
    let read = 0;
    try {
      read = fs.readSync(fd, buffer, 0, READ_CHUNK, null);
    } catch (error) {
      // EAGAIN on a non-blocking pipe means "nothing yet", not "end of input".
      if (error && error.code === 'EAGAIN') continue;
      throw error;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
    total += read;
    if (total >= READ_CEILING) {
      // Stopped on the ceiling rather than on EOF — unless the next read would have returned 0.
      let probe = 0;
      try {
        probe = fs.readSync(fd, buffer, 0, 1, null);
      } catch (error) {
        if (!error || error.code !== 'EAGAIN') throw error;
      }
      truncated = probe > 0;
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function readStdin() {
  try {
    return readBounded(0);
  } catch (_) {
    return { text: '', truncated: false };
  }
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const fileArg = args.find((arg) => arg !== '--json' && arg !== '-');
  let text = '';
  let truncated = false;

  if (fileArg) {
    try {
      const fd = fs.openSync(fileArg, 'r');
      try {
        ({ text, truncated } = readBounded(fd));
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      // Neither the operator-supplied path nor Node's message is echoed: `error.message` repeats
      // the path verbatim, so printing it would reinstate on the error path exactly the unvalidated
      // label that was just removed from the success path. A filename can carry private directory
      // names or compact workout prose, and there is no contract to validate it against.
      process.stderr.write(`atlas:turn-write-artifact — cannot read the supplied artifact file (${error.code || 'read failure'})\n`);
      return 2;
    }
  } else {
    ({ text, truncated } = readStdin());
  }

  const artifact = buildTurnWriteArtifact(text, { truncated });
  if (json) process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  else process.stdout.write(`${formatTurnWriteArtifact(artifact)}\n`);

  if (artifact.status === 'complete') return 0;
  return artifact.status === 'empty' ? 2 : 1;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { main };
