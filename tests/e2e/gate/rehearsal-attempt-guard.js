'use strict';

// ── F-SB4B rehearsal attempt guard — a retry is never scored (TEMPORARY; sunset: F-SB4C) ──
//
// THE DEFECT THIS MODULE EXISTS TO CLOSE. playwright.config.js grants every CI
// run one retry (`retries: process.env.CI ? 1 : 0`), and the rehearsal operator
// command forwarded the ambient CI into its Playwright child with no override.
// The rehearsal spec writes scorecard.json BEFORE asserting the run passed
// (writeFileSync truncates), and the operator command decides the run solely
// from the Playwright exit code plus the FINAL scorecard. So under CI=true a
// scored FAIL failed the test, Playwright retried the whole session, attempt 2
// overwrote scorecard.json (RUN_START.json is write-if-absent with identical
// identity across attempts, so nothing downstream could tell), and the run
// reported as a qualifying PASS — attempt 1's FAIL evidence destroyed by the
// retry itself. Demonstrated end-to-end on the base tree with a synthetic
// probe mimicking the spec's artifact discipline: attempt retry=0 wrote
// overall=FAIL and failed; attempt retry=1 overwrote it with overall=PASS;
// Playwright exited 0 ("1 flaky"). No recorded campaign run is implicated —
// CI is unset in this VM's agent shells — this closes a constructible hole.
//
// THE RULE: one run, one attempt, one scorecard. Defence in depth:
//   1. the operator command passes --retries=0 to its Playwright spawn, which
//      overrides the config for that invocation only (ordinary E2E keeps its
//      CI retry — playwright.config.js is untouched);
//   2. this guard, consulted by the spec's beforeAll BEFORE the gate server
//      spawns and before any athlete turn can exist: an attempt whose
//      test.info().retry is not exactly 0 refuses and is never scored, so
//      even a launcher that reaches the spec without the operator command
//      (or a future config change) cannot retry a session into a PASS.
//
// WHY NOT MACHINERY_ABORT.json: that marker asserts the RUN never started
// (started:false, "no synthetic athlete turn was submitted"). For a retried
// attempt that claim can be false — attempt 1 may have crossed the
// session-start boundary, and RUN_START.json records that crossing if it
// happened. This record therefore makes NO started claim about the run: it
// states only that THIS attempt was refused pre-turn and wrote nothing
// scored, so attempt 1's recorded evidence stands untouched. It deliberately
// does not touch scorecard.json, RUN_START.json, or any other artifact.
//
// Measure/decide split, as in rehearsal-build-identity.js: the spec measures
// (test.info().retry) and this module decides purely and records.

const fs = require('node:fs');
const path = require('node:path');

// The durable record of a refused retry, written into the run's artifact
// directory alongside the first attempt's own evidence.
const RETRY_REFUSED_MARKER = 'RETRY_REFUSED.json';
// The one boundary declaration every refusal record must carry, verbatim.
const RETRY_REFUSED_BOUNDARY = 'a retried attempt submits no athlete turn and writes no scorecard — the first attempt\'s recorded evidence stands';

// ── decide (pure) ──────────────────────────────────────────────────────────────
// { ok, retry, reason }. Only retry exactly 0 — the first attempt — may be
// scored. Fail-closed: a retry value that is not a non-negative integer cannot
// prove it is the first attempt, so it refuses like any retry.
function evaluateAttempt(input) {
  const i = input && typeof input === 'object' ? input : {};
  const retry = i.retry;
  if (retry === 0) return { ok: true, retry: 0, reason: null };
  if (Number.isInteger(retry) && retry > 0) {
    return {
      ok: false,
      retry,
      reason: `this is Playwright attempt ${retry + 1} (retry ${retry}) of the same run — a retried rehearsal attempt is never scored: scoring it would let a retry overwrite the first attempt's recorded scorecard, so the first attempt's evidence stands and this attempt refuses before the gate server spawns`,
    };
  }
  return {
    ok: false,
    retry: Number.isInteger(retry) ? retry : null,
    reason: `the attempt's retry index (${JSON.stringify(retry)}) is not a non-negative integer — it cannot be proven to be the first attempt, so it is refused unscored`,
  };
}

// ── the pre-turn enforcement (spec beforeAll) ──────────────────────────────────
// Decide; on refusal, record it in the run's artifact directory BEFORE
// returning, so the artifacts state why the extra attempt contributed nothing
// even when the run was driven outside the operator command. The record never
// touches the first attempt's artifacts. Never throws — the caller throws
// with the reason so the refusal surfaces in the run transcript.
function refuseRetriedAttempt({ artifactDir, runId, retry } = {}) {
  const verdict = evaluateAttempt({ retry });
  if (!verdict.ok && artifactDir) {
    try {
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, RETRY_REFUSED_MARKER), `${JSON.stringify({
        refused: true,
        kind: 'RETRY_REFUSED',
        at: new Date().toISOString(),
        boundary: RETRY_REFUSED_BOUNDARY,
        run_id: runId || null,
        retry_index: verdict.retry,
        attempt_number: Number.isInteger(verdict.retry) ? verdict.retry + 1 : null,
        reason: verdict.reason,
      }, null, 2)}\n`);
    } catch { /* the verdict still refuses; the record is best-effort */ }
  }
  return verdict;
}

module.exports = {
  RETRY_REFUSED_MARKER,
  RETRY_REFUSED_BOUNDARY,
  evaluateAttempt,
  refuseRetriedAttempt,
};
