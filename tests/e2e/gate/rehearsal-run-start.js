'use strict';

// ── The session-start boundary, recorded durably ───────────────────────────────
// TEMPORARY F-SB4B machinery (sunset: F-SB4C), adapted from the proven Stage A module
// (stage-a-run-start.js, sunset PR #1234).
//
// The counting rule draws one line and hangs the whole streak on it:
//
//   A rehearsal session BEGINS when, after all startup and safety preflight passes,
//   the real browser submits the FIRST synthetic athlete turn.
//
//   Before it → NOT STARTED. Not a failed session; the streak is unchanged.
//   After it  → any meaningful FAIL or ERROR is a FAILED session; the streak resets
//               to 0/5 and restarts at Session 1 after the fix merges.
//
// Without a durable marker both sides of that line look identical from the outside
// when a run dies before scoring. So the crossing is written to disk at the moment it
// happens, by the code that performs it, and read back by the operator command — a
// fact the run recorded, not a conclusion drawn afterwards.

const fs = require('node:fs');
const path = require('node:path');

const RUN_START_MARKER = 'RUN_START.json';

// Written at the FIRST composer submission, never overwritten. Best-effort by design —
// a marker that threw would abort a run that had genuinely started; a missing marker
// reads as NOT STARTED, the honest default direction.
function markRunStarted(artifactDir, details) {
  if (!artifactDir) return false;
  const target = path.join(artifactDir, RUN_START_MARKER);
  try {
    if (fs.existsSync(target)) return false;
    fs.writeFileSync(target, `${JSON.stringify({
      started: true,
      at: new Date().toISOString(),
      boundary: 'the real browser submitted the first synthetic athlete turn',
      ...details,
    }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

function readRunStart(artifactDir) {
  if (!artifactDir) return null;
  try {
    const raw = fs.readFileSync(path.join(artifactDir, RUN_START_MARKER), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.started === true ? parsed : null;
  } catch {
    return null;
  }
}

// The verdict for a run that produced NO scorecard. Pure — the marker's presence is the
// only thing that decides which side of the boundary the run reached.
function classifyIncompleteRun(runStart) {
  if (runStart && runStart.started === true) {
    return {
      started: true,
      verdict: 'FAILED_SESSION',
      detail: 'the first synthetic athlete turn was submitted, so this is a failed rehearsal session — the streak resets to 0/5 and restarts at Session 1 after the causal fix merges. Do not repair and re-run it as though it never happened.',
    };
  }
  return {
    started: false,
    verdict: 'NOT_STARTED',
    detail: 'no synthetic athlete turn was submitted, so the session never began — the rehearsal streak is unchanged. Resolve the refusal and attempt the same numbered session.',
  };
}

module.exports = { RUN_START_MARKER, markRunStarted, readRunStart, classifyIncompleteRun };
