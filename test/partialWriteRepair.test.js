'use strict';

// #1628 — screenshot partial write: Log rows land, the Effort append fails,
// and the retry is refused as a duplicate instead of repairing the missing
// component.
//
// Defect chain, verified firsthand at s3-maintenance head b4d46c9c:
//   1. /api/complete-workout records the write COMPLETED with
//      sheet_write: 'partial', sheet_written: true, effort_written: false
//      (index.js partial branch) and returns it as a 500 with that body in
//      `details` (response.js standardError). The approve handler's catch
//      shows only the generic "Write failed" message and keeps the SAME
//      write_id, so nothing records the partial state or keys a repair.
//   2. The athlete's natural retry reuses that write_id. The server
//      returns skipped_duplicate with original_sheet_written: true, and
//      the client derives "Already logged" from original_sheet_written
//      ALONE — ignoring original_effort_written: false. The card retires
//      its Save as already-logged while the Effort row is still missing.
//   3. Repair was always possible with a FRESH write_id and an effort-only
//      resubmission (same session, no Log rows, Effort tab has no such
//      session so the duplicate-session guard does not fire) — nothing
//      told the athlete or the client to do that.
//
// Bounded fix, no durable-receipt schema: the server's partial record is
// reused as-is. The client surfaces the component-level partial state
// (Log done / Effort missing) and keys the retry to the missing component
// only — a fresh-id, effort-only write with the same session/date/effort.
// Same-id duplicate refusal is UNCHANGED (the dedupe guard is preserved;
// the repair is a new write_id, exactly the path the server already
// accepts). Same-id resume would be the durable-receipt design, which
// is Dale's schema decision and is deliberately NOT built here.
//
// The behaviour half slices the helpers from the built bundle and RUNS
// them (the duplicateEchoProvesRows idiom in reviewCardSavedProof.test.js).
// The wiring half pins the approve handler's partial branches.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

// generateWriteId reads `window` in the browser; in Node, give it a stub so
// the fallback id path runs instead of throwing on an undefined global.
if (typeof globalThis.window === 'undefined') globalThis.window = {};

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} must exist in the built app bundle`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end !== -1, `${name} must be a closed function`);
  return src.slice(start, end + 3);
}

function loadPartialHelpers() {
  const slices = [
    sliceFunction(appSrc, 'isPartialCompleteWrite'),
    sliceFunction(appSrc, 'duplicateEchoIsPartialCompleteWrite'),
    sliceFunction(appSrc, 'partialFromError'),
    sliceFunction(appSrc, 'effortJsonFromParsedEffort'),
    sliceFunction(appSrc, 'generateWriteId'),
    sliceFunction(appSrc, 'keyPartialRepair'),
  ];
  return new Function(`${slices.join('\n')}; return { isPartialCompleteWrite, duplicateEchoIsPartialCompleteWrite, partialFromError, keyPartialRepair };`)();
}

function approveHandlerSlice(src) {
  const start = src.indexOf("getElementById('approve-btn').addEventListener('click'");
  assert.ok(start !== -1, 'the approve handler must exist in the built app bundle');
  const end = src.indexOf('/* ===== Session loader', start);
  assert.ok(end !== -1, 'the approve handler slice must terminate at the session loader');
  return src.slice(start, end);
}

// ── isPartialCompleteWrite ──────────────────────────────────────────────────

test('#1628: a server partial (Log done, Effort missing) is a partial write', () => {
  const { isPartialCompleteWrite } = loadPartialHelpers();
  assert.equal(isPartialCompleteWrite({
    sheet_write: 'partial', sheet_written: true, log_rows_written: 1, effort_written: false,
  }), true);
});

test('#1628: success, unverified, and a partial whose Effort DID land are not partial writes', () => {
  const { isPartialCompleteWrite } = loadPartialHelpers();
  assert.equal(isPartialCompleteWrite({ sheet_write: 'success', sheet_written: true, effort_written: true }), false);
  assert.equal(isPartialCompleteWrite({ sheet_write: 'unverified', sheet_written: true, effort_written: false }), false);
  // The unlikely later-step throw after a successful Effort append: Effort is
  // NOT missing, so this is not the Effort-repair case and must not be keyed.
  assert.equal(isPartialCompleteWrite({ sheet_write: 'partial', sheet_written: true, effort_written: true }), false);
  assert.equal(isPartialCompleteWrite({}), false);
  assert.equal(isPartialCompleteWrite(null), false);
  assert.equal(isPartialCompleteWrite(undefined), false);
});

// ── duplicateEchoIsPartialCompleteWrite ─────────────────────────────────────

test('#1628: a duplicate echo of a partial original is partial, not already-logged', () => {
  const { duplicateEchoIsPartialCompleteWrite } = loadPartialHelpers();
  assert.equal(duplicateEchoIsPartialCompleteWrite({
    duplicate_write: true, sheet_write: 'skipped_duplicate', sheet_written: false,
    original_sheet_written: true, original_log_rows_written: 1, original_effort_written: false,
  }), true);
});

test('#1628: a duplicate echo of a fully-written original is not partial', () => {
  const { duplicateEchoIsPartialCompleteWrite } = loadPartialHelpers();
  assert.equal(duplicateEchoIsPartialCompleteWrite({
    duplicate_write: true, sheet_write: 'skipped_duplicate', sheet_written: false,
    original_sheet_written: true, original_effort_written: true,
  }), false);
  assert.equal(duplicateEchoIsPartialCompleteWrite({ duplicate_write: true, sheet_write: 'success' }), false);
  assert.equal(duplicateEchoIsPartialCompleteWrite({}), false);
  assert.equal(duplicateEchoIsPartialCompleteWrite(null), false);
});

// ── keyPartialRepair ────────────────────────────────────────────────────────

test('#1628: a screenshot pending write is keyed to an effort-only repair', () => {
  const { keyPartialRepair } = loadPartialHelpers();
  const pending = {
    mode: 'screenshot', file: 'image-blob', logRows: [{ exercise: 'Bench' }],
    sessionId: '20261030-AM-01', date: '2026-10-30', location: 'Home', notes: '',
    parsedEffort: { duration: 42, activeCalories: 410, totalCalories: 520, averageHR: 148, peakHR: 171, workoutType: 'Traditional Strength Training' },
    writeId: 'original-write-id',
  };
  assert.equal(keyPartialRepair(pending), true);
  assert.equal(pending.mode, 'effort-only');
  assert.equal(pending.effortOnly, true);
  assert.deepEqual(pending.logRows, []);
  assert.equal(pending.file, null);
  assert.deepEqual(pending.manualEffort, {
    duration: 42, activeCalories: 410, totalCalories: 520, averageHR: 148, peakHR: 171, workoutType: 'Traditional Strength Training',
  });
  assert.notEqual(pending.writeId, 'original-write-id');
  assert.equal(pending.sessionId, '20261030-AM-01');
  assert.equal(pending.date, '2026-10-30');
});

test('#1628: an effort-only pending write is keyed with a fresh id and its own effort', () => {
  const { keyPartialRepair } = loadPartialHelpers();
  const manualEffort = { duration: 30, activeCalories: 200, totalCalories: 300, averageHR: 140, peakHR: 160 };
  const pending = {
    mode: 'effort-only', logRows: [], sessionId: '20261030-AM-02', date: '2026-10-30',
    manualEffort, effortOnly: true, writeId: 'original-effort-id',
  };
  assert.equal(keyPartialRepair(pending), true);
  assert.equal(pending.mode, 'effort-only');
  assert.equal(pending.manualEffort, manualEffort);
  assert.notEqual(pending.writeId, 'original-effort-id');
  assert.equal(pending.sessionId, '20261030-AM-02');
});

test('#1628: with no effort payload there is no repair to key — the write is left untouched', () => {
  const { keyPartialRepair } = loadPartialHelpers();
  const pending = {
    mode: 'screenshot', file: null, logRows: [{ exercise: 'Bench' }],
    sessionId: '20261030-AM-03', date: '2026-10-30', parsedEffort: null, writeId: 'no-effort-id',
  };
  assert.equal(keyPartialRepair(pending), false);
  assert.equal(pending.mode, 'screenshot');
  assert.equal(pending.writeId, 'no-effort-id');
  assert.deepEqual(pending.logRows, [{ exercise: 'Bench' }]);
});

// ── partialFromError ────────────────────────────────────────────────────────

test('#1628: a 500 whose details carry the partial record is a partial error', () => {
  const { partialFromError } = loadPartialHelpers();
  const err = new Error('Effort row append failed after log rows were written.');
  err.body = { status: 'error', message: err.message, details: { sheet_write: 'partial', sheet_written: true, log_rows_written: 1, effort_written: false } };
  const partial = partialFromError(err);
  assert.ok(partial, 'the partial record must be extracted from the error body');
  assert.equal(partial.sheet_write, 'partial');
  assert.equal(partial.effort_written, false);
});

test('#1628: a non-partial error carries no partial record', () => {
  const { partialFromError } = loadPartialHelpers();
  const err = new Error('Write failed');
  err.body = { status: 'error', message: 'Write failed', details: { sheet_write: 'success' } };
  assert.equal(partialFromError(err), null);
  const bare = new Error('transport failed');
  assert.equal(partialFromError(bare), null);
  assert.equal(partialFromError(null), null);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test('#1628 wiring: the partial state is a named constant beside the QA-3 states', () => {
  assert.match(appSrc, /const WRITE_PARTIAL_STATE = 'write-partial';/);
});

test('#1628 wiring: the approve handler routes a partial duplicate to the repair, before any already-logged claim', () => {
  const slice = approveHandlerSlice(appSrc);
  // One call in the handler (the PR 486 test slices this handler with a
  // fixed 5200-char window, so the helper owns the status/button work).
  assert.match(slice, /handlePartialDuplicate\(writeData, pendingWrite, approveBtn, loggerStatus\)/, 'the screenshot lane must route a partial duplicate to its helper');
  const partialAt = slice.indexOf('handlePartialDuplicate(writeData');
  const alreadyAt = slice.indexOf('writeStatusState = ALREADY_LOGGED_STATE', partialAt);
  assert.ok(alreadyAt === -1 || slice.slice(partialAt, alreadyAt).includes('return;'),
    'a partial duplicate must return before the already-logged outcome can be claimed');
  // And the helper itself does the detection, the repair keying, and the marker.
  const helperStart = appSrc.indexOf('function handlePartialDuplicate(');
  assert.ok(helperStart !== -1, 'handlePartialDuplicate must exist in the built app bundle');
  const helper = appSrc.slice(helperStart, appSrc.indexOf('\n}\n', helperStart) + 3);
  assert.match(helper, /duplicateEchoIsPartialCompleteWrite\(writeData\)/);
  assert.match(helper, /keyPartialRepair\(pendingWrite\)/);
  assert.match(helper, /WRITE_PARTIAL_STATE/);
});

test('#1628 wiring: the approve catch routes a partial error to the repair instead of the generic failure', () => {
  const slice = approveHandlerSlice(appSrc);
  assert.match(slice, /partialFromError\(err\)/, 'the catch must extract the partial record from the thrown error');
  assert.match(slice, /WRITE_PARTIAL_STATE/, 'the catch partial path must carry the write-partial marker');
});
