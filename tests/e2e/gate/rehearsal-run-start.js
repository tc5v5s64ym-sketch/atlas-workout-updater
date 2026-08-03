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
// The one counting-boundary declaration every marker must carry, verbatim — the
// writer stamps it and the verifier requires it, from the same constant.
const RUN_START_BOUNDARY = 'the real browser submitted the first synthetic athlete turn';

// Written at the FIRST composer submission, never overwritten. This function never
// throws, but it is NOT fire-and-forget: the one submitting caller (rehearsal.spec.js
// `say()`) READS THE MARKER BACK through verifyRunStartMarker BEFORE clicking submit
// and refuses the submission on any mismatch — a pre-submission refusal is honestly
// NOT STARTED, whereas submitting with no verified durable marker would misclassify a
// later crash as NOT STARTED when the counting rule demands a streak reset (Codex P2,
// PR #1252; hardened from existence-only to full read-back in the runner-honesty
// corrective PR).
function markRunStarted(artifactDir, details) {
  if (!artifactDir) return false;
  const target = path.join(artifactDir, RUN_START_MARKER);
  try {
    if (fs.existsSync(target)) return false;
    fs.writeFileSync(target, `${JSON.stringify({
      started: true,
      at: new Date().toISOString(),
      boundary: RUN_START_BOUNDARY,
      ...details,
    }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// The pre-submission read-back. Path existence is not evidence: an empty, partial,
// malformed, stale, or foreign-run marker EXISTS and would permit submission while
// later failing readRunStart — misclassifying a genuinely started run as NOT STARTED,
// the exact direction the counting rule cannot tolerate. So the marker is read back
// through the SAME canonical parse the operator command uses, and every identity
// field must match this run exactly. Returns { ok, reason }; never throws.
function verifyRunStartMarker(artifactDir, expected) {
  if (!artifactDir) return { ok: false, reason: 'no artifact directory to verify the marker in' };
  const parsed = readRunStart(artifactDir);
  if (!parsed) {
    return { ok: false, reason: 'the session-start marker could not be read back as started:true through the canonical reader (missing, empty, malformed, or not started)' };
  }
  const want = expected && typeof expected === 'object' ? expected : {};
  const fields = [
    ['run_id', want.run_id],
    ['purpose', want.purpose],
    ['rehearsal_session_number', want.rehearsal_session_number],
    ['source_sha', want.source_sha],
    ['boundary', RUN_START_BOUNDARY],
  ];
  for (const [field, wantValue] of fields) {
    if (parsed[field] !== wantValue) {
      return {
        ok: false,
        reason: `the marker's ${field} is ${JSON.stringify(parsed[field])} but this run requires ${JSON.stringify(wantValue)} — a stale or foreign marker cannot vouch for this run's counting boundary`,
      };
    }
  }
  return { ok: true, reason: null };
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

module.exports = { RUN_START_MARKER, RUN_START_BOUNDARY, markRunStarted, verifyRunStartMarker, readRunStart, classifyIncompleteRun };
