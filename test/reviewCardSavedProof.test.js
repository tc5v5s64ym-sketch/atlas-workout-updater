'use strict';

// QA-3 — a review card may display "Saved" ONLY on proof from that card's own
// write response that rows were written for that write.
//
// Live incident (2026-10-26, agent-run QA against the production build): an
// Overhead Press preview card flipped to "✓ Saved to your sheet" although ZERO
// rows were written to Log_Cleaned, on a POST /api/log-workout that returned
// 200. Two client mechanisms made that possible, and both are pinned here:
//
//   (a) The review card's #logger-status MutationObserver (coach-conversation.js)
//       called markReviewSaved() on ANY `.status-msg.ok` — including ok statuses
//       emitted by unrelated actions (a later "log it" compile writes
//       'Compiling session from conversation…' as `.ok`) — with no write at all
//       required. The fix keys the Saved claim to the same `data-atlas-state`
//       marker discipline the ledger-unverified warn already uses: app.js tags
//       its approve status `write-confirmed` only when that write's response
//       proved its rows landed, and `already-logged` when the write appended
//       nothing because the rows were already logged.
//
//   (b) The approve handler (app.js) WAIVED its rows-written proof whenever the
//       response had the duplicate shape (`duplicateBlocked`): the server's
//       all-rows-duplicate lane completes with log_rows_written: 0 and returns
//       200 (idempotency_status 'completed'), so a zero-append outcome was
//       accepted — and displayed — as a save. The fix keeps the duplicate
//       acceptance but derives the surfaced outcome from the echo itself: a
//       duplicate whose echoed response proves rows (log_rows_written > 0 or
//       effort_rows_written > 0) is that write's own proof; a duplicate that
//       cannot show rows is surfaced as already-logged, never as a fresh save.
//
// The behaviour half is `duplicateEchoProvesRows`, sliced from the built bundle
// and RUN here (the closeoutReplayIdempotency idiom). The wiring halves are
// source pins on the built bundle. The end-to-end card behaviour is proven in
// tests/e2e/review-card-saved-proof.spec.js, and the server response contract
// these pins consume is proven in test/logWorkoutDuplicateOutcomeSheets.test.js.
//
// S3 backport (PR #1313 → s3-maintenance): ported as-is except the one
// S4-flavoured fixture field (`write_authority`) is dropped — S3's server
// never emits it and the helper under test ignores it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const coachSrc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');

// ── The card's #logger-status observer: slice it out of the built bundle ──────
function observerSlice(src) {
  const start = src.indexOf('const ROWS_WRITTEN_STATE');
  assert.ok(start !== -1, 'the observer state markers must exist in the coach bundle');
  const endMarker = '}).observe(loggerStatusEl';
  const end = src.indexOf(endMarker, start);
  assert.ok(end !== -1, 'the #logger-status observer must exist in the coach bundle');
  return src.slice(start, end + endMarker.length);
}

test('QA-3 (a): the observer keys the Saved claim to the write-confirmed state marker', () => {
  const slice = observerSlice(coachSrc);
  assert.match(slice, /data-atlas-state="write-confirmed"/,
    'the observer must look for the write-confirmed marker on the approve status');
  assert.match(slice, /data-atlas-state="already-logged"/,
    'the observer must look for the already-logged marker on the approve status');
  assert.match(slice, /markReviewSaved\(\)/, 'the marked path still reaches markReviewSaved');
});

test('QA-3 (a): a bare .status-msg.ok must NOT reach markReviewSaved (the incident lane)', () => {
  const slice = observerSlice(coachSrc);
  // The pre-fix branch was `else if (ok && !currentReview.done) markReviewSaved();`
  // — ANY ok in #logger-status (a compile starting, a set edit, a preview) flipped
  // the current card to Saved with no write behind it.
  assert.doesNotMatch(slice, /else if \(ok && !currentReview\.done\)/,
    'no observer branch may fire on an unmarked ok status');
  assert.doesNotMatch(slice, /else if \(ok\)/,
    'no observer branch may fire on ok-ness alone');
});

test('QA-3 (a): the undo reading of an unmarked ok is preserved', () => {
  const slice = observerSlice(coachSrc);
  assert.match(slice, /\/undone\/i\.test\(ok\.textContent/,
    'an unmarked ok whose text reports an undo still routes to markReviewUndone');
  assert.match(slice, /markReviewUndone\(\)/, 'the undo path stays wired');
});

test('QA-3 (a): the already-logged card state exists and is applied, never `done`', () => {
  assert.match(coachSrc, /const ALREADY_LOGGED_NOTE = 'Already logged/,
    'the already-logged note names the true state');
  assert.match(coachSrc, /function applyAlreadyLoggedState\(review\) \{/,
    'the already-logged state has its own apply function, beside the rows-written one');
  assert.match(coachSrc, /alreadyLogged: false/,
    'the review record tracks the already-logged state from construction');
  const slice = observerSlice(coachSrc);
  assert.match(slice, /applyAlreadyLoggedState\(currentReview\)/,
    'the observer applies the already-logged state to the current card');
});

// ── duplicateEchoProvesRows: the waiver decision, run against real shapes ────
function loadEchoProof(src) {
  const start = src.indexOf('function duplicateEchoProvesRows(');
  assert.ok(start !== -1, 'duplicateEchoProvesRows must exist in the built app bundle');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end !== -1, 'duplicateEchoProvesRows must be a closed function');
  const slice = src.slice(start, end + 3);
  return new Function(`${slice}; return duplicateEchoProvesRows;`)();
}

test('QA-3 (b): the all-rows-duplicate response proves NO rows — it is not a save', () => {
  const proves = loadEchoProof(appSrc);
  // The exact server body of the all-rows-duplicate lane (index.js): a completed
  // 200 that appended nothing. Before the fix the handler waived the rows check
  // for this shape and displayed a save.
  assert.equal(proves({
    duplicate_write: true, all_rows_duplicate: true, idempotency_status: 'completed',
    sheet_write: 'skipped_duplicate',
    sheet_written: false, original_sheet_write: 'success',
    log_rows_written: 0, effort_rows_written: 0, skipped_duplicates: 3,
  }), false);
  // An echo OF that record (same write_id retried) replays the same zero.
  assert.equal(proves({ duplicate_write: true, log_rows_written: 0 }), false);
});

test('QA-3 (b): a duplicate echo carrying the original rows-written count IS that write\u2019s proof', () => {
  const proves = loadEchoProof(appSrc);
  // Lost-response retry: the same write_id replays, and the echo carries the
  // original response — including the rows it wrote. That is proof from the
  // card's own write response that rows were written for that write.
  assert.equal(proves({ duplicate_write: true, log_rows_written: 3 }), true);
  assert.equal(proves({ duplicate_write: true, effort_rows_written: 1 }), true);
});

test('QA-3 (b): a dry-run body and an empty body prove no rows', () => {
  const proves = loadEchoProof(appSrc);
  assert.equal(proves({ test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true }), false);
  assert.equal(proves({}), false);
  assert.equal(proves(null), false);
  assert.equal(proves(undefined), false);
});

// ── Approve-handler wiring: the outcome is computed and tagged onto the status ─
function approveHandlerSlice(src) {
  const start = src.indexOf("getElementById('approve-btn').addEventListener('click'");
  assert.ok(start !== -1, 'the approve handler must exist in the built app bundle');
  const end = src.indexOf('/* ===== Session loader', start);
  assert.ok(end !== -1, 'the approve handler slice must terminate at the session loader');
  return src.slice(start, end);
}

test('QA-3 wiring: the write-outcome states are named constants, shared as strings', () => {
  assert.match(appSrc, /const WRITE_CONFIRMED_STATE = 'write-confirmed';/);
  assert.match(appSrc, /const ALREADY_LOGGED_STATE = 'already-logged';/);
});

test('QA-3 wiring: a zero-proof duplicate is reclassified already-logged in the approve handler', () => {
  const slice = approveHandlerSlice(appSrc);
  assert.match(slice, /if \(duplicateBlocked && !duplicateEchoProvesRows\(writeData\)\) \{\s*writeStatusState = ALREADY_LOGGED_STATE;/,
    'the default write branch must reclassify a duplicate whose echo proves no rows');
});

test('QA-3 wiring: the approve success status carries the outcome state marker', () => {
  const slice = approveHandlerSlice(appSrc);
  assert.match(slice, /'ok',\s*writeStatusState\s*\)/,
    'setStatus for the approve outcome must pass the state as its marker argument');
  assert.match(slice, /Already logged — this workout was already written/,
    'the zero-append outcome is worded as already logged, not as a save');
});
