'use strict';

// ── The session-start boundary, recorded durably ───────────────────────────────
//
// The owner ruling draws one line and hangs the whole streak on it:
//
//   A Stage A session BEGINS when, after all startup and safety preflight passes, the real
//   browser submits the FIRST synthetic athlete turn.
//
//   Before it  → NOT STARTED. Not a failed session; the streak is unchanged.
//   After it   → any meaningful FAIL or ERROR is a FAILED session; the streak resets to 0/5.
//
// Without a durable marker, both sides of that line look identical from the outside when a
// run dies before scoring: a server that refused to start and a timeout waiting for the first
// coach reply both leave "no scorecard". The operator would then be inferring which side of
// the reset boundary the run reached — and an operator inferring NOT STARTED for a run that
// had in fact begun is a silently un-reset streak, which is the same class of false counting
// the run purpose exists to prevent.
//
// So the crossing is written to disk at the moment it happens, by the code that performs it,
// and read back by the operator command. It is a fact the run recorded, not a conclusion
// drawn afterwards.
//
// Sunset: deleted with the rest of the temporary Phase 4 Stage-A machinery, in the same PR
// that records Stage A at 5/5.

const fs = require('node:fs');
const path = require('node:path');

const RUN_START_MARKER = 'RUN_START.json';

// Written by the runner at the FIRST composer submission, and never overwritten: the boundary
// is the first turn, so a later turn must not move it. Best-effort by design — a marker that
// threw would abort a run that had genuinely started, which is a worse outcome than a marker
// that is missing. A missing marker reads as NOT STARTED, and that is the direction the rest
// of the machinery is built to be honest about (see `classifyIncompleteRun`).
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

// The verdict for a run that produced NO scorecard. Pure, so the rule can be tested without
// a browser: the marker's presence is the only thing that decides which side of the boundary
// the run reached.
function classifyIncompleteRun(runStart) {
  if (runStart && runStart.started === true) {
    return {
      started: true,
      verdict: 'FAILED_SESSION',
      detail: 'the first synthetic athlete turn was submitted, so this is a failed Stage A session — the streak resets to 0/5. Do not repair and re-run it as though it never happened.',
    };
  }
  return {
    started: false,
    verdict: 'NOT_STARTED',
    detail: 'no synthetic athlete turn was submitted, so the session never began — the Stage A streak is unchanged.',
  };
}

module.exports = { RUN_START_MARKER, markRunStarted, readRunStart, classifyIncompleteRun };
