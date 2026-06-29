'use strict';

// PR4a — preview→approve→write trust-loop proof gate (public/app.js).
//
// The trust loop's safety hinges on three pure functions in app.js:
//   - previewProofFromResult(result, mode) — captures the dry-run proof fields
//     the server returned for a preview.
//   - pendingWriteHasPreviewProof(write)   — the GATE the approve button checks;
//     a real write is only allowed if a valid dry-run proof was captured first.
//   - pendingBodyweightHasPreviewProof(write) — the same gate for the bodyweight
//     write path.
//
// Until now these were only verified by source-string matching in unit.test.js
// ("the handler calls the gate"), never by exercising the gate logic itself.
// This file runs the REAL functions (extracted from app.js, the same technique
// the activeSession* tests use for the browser IIFE) and asserts they accept a
// valid dry-run proof and reject every missing/stale/live-write variant.
//
// Test-only: app.js is read, never modified. This pins CURRENT behaviour — if a
// case ever fails, that is a finding to report, not a cue to edit app.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Extract a top-level `function NAME(...) {...}` from app.js by slicing to the
// next top-level `\nfunction ` (same approach as activeSessionSavePayload.test.js).
function extractFn(name) {
  const start = appSrc.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} must exist in app.js`);
  const end = appSrc.indexOf('\nfunction ', start + 1);
  const fnSrc = appSrc.slice(start, end === -1 ? start + 2000 : end);
  return new Function(`${fnSrc}\n; return ${name};`)();
}

const previewProofFromResult = extractFn('previewProofFromResult');
const pendingWriteHasPreviewProof = extractFn('pendingWriteHasPreviewProof');
const pendingBodyweightHasPreviewProof = extractFn('pendingBodyweightHasPreviewProof');

// A server dry-run response that proves no write happened.
const DRY_RUN_DATA = { test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true };

// ---------------------------------------------------------------------------
// previewProofFromResult — reads the right nesting per mode and stamps a time
// ---------------------------------------------------------------------------
test('previewProofFromResult reads result.data for manual/modality modes', () => {
  const proof = previewProofFromResult({ data: DRY_RUN_DATA }, 'manual');
  assert.equal(proof.mode, 'manual');
  assert.equal(proof.test_mode, true);
  assert.equal(proof.sheet_write, 'skipped');
  assert.equal(proof.sheet_written, false);
  assert.equal(proof.no_write_confirmed, true);
  assert.equal(typeof proof.created_at_ms, 'number');
});

test('previewProofFromResult reads the nested result.data.data for screenshot/effort-only modes', () => {
  const proof = previewProofFromResult({ data: { data: DRY_RUN_DATA } }, 'screenshot');
  assert.equal(proof.mode, 'screenshot');
  assert.equal(proof.test_mode, true);
  assert.equal(proof.sheet_write, 'skipped');
});

test('previewProofFromResult is null-safe on a missing result', () => {
  const proof = previewProofFromResult(undefined, 'manual');
  assert.equal(proof.test_mode, undefined);
  assert.equal(proof.mode, 'manual');
});

// ---------------------------------------------------------------------------
// pendingWriteHasPreviewProof — the approve gate
// ---------------------------------------------------------------------------
test('gate ACCEPTS a valid manual dry-run proof', () => {
  const write = { previewProof: previewProofFromResult({ data: DRY_RUN_DATA }, 'manual') };
  assert.equal(pendingWriteHasPreviewProof(write), true);
});

test('gate ACCEPTS valid modality / screenshot / effort-only proofs', () => {
  for (const mode of ['modality', 'screenshot', 'effort-only']) {
    const nested = mode === 'modality' ? { data: DRY_RUN_DATA } : { data: { data: DRY_RUN_DATA } };
    const write = { previewProof: previewProofFromResult(nested, mode) };
    assert.equal(pendingWriteHasPreviewProof(write), true, `${mode} proof should pass`);
  }
});

test('gate REJECTS a missing write or missing previewProof', () => {
  assert.equal(pendingWriteHasPreviewProof(undefined), false);
  assert.equal(pendingWriteHasPreviewProof(null), false);
  assert.equal(pendingWriteHasPreviewProof({}), false);
  assert.equal(pendingWriteHasPreviewProof({ previewProof: null }), false);
});

test('gate REJECTS a proof that does not prove no-write (the live-write guard)', () => {
  const base = { mode: 'manual', sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true };
  // test_mode not strictly true
  assert.equal(pendingWriteHasPreviewProof({ previewProof: { ...base, test_mode: false } }), false);
  assert.equal(pendingWriteHasPreviewProof({ previewProof: { ...base, test_mode: undefined } }), false);
  // sheet actually written
  assert.equal(pendingWriteHasPreviewProof({ previewProof: { ...base, test_mode: true, sheet_written: true } }), false);
  // no_write not confirmed
  assert.equal(pendingWriteHasPreviewProof({ previewProof: { ...base, test_mode: true, no_write_confirmed: false } }), false);
});

test('gate REJECTS a manual/modality/screenshot proof whose sheet_write is not "skipped"', () => {
  for (const mode of ['manual', 'modality', 'screenshot', 'effort-only']) {
    const proof = { mode, test_mode: true, sheet_written: false, no_write_confirmed: true, sheet_write: 'success' };
    assert.equal(pendingWriteHasPreviewProof({ previewProof: proof }), false, `${mode} with sheet_write:success must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// pendingBodyweightHasPreviewProof — the bodyweight approve gate
// ---------------------------------------------------------------------------
test('bodyweight gate ACCEPTS a valid dry-run proof and REJECTS missing/live variants', () => {
  const good = { previewProof: { test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true } };
  assert.equal(pendingBodyweightHasPreviewProof(good), true);

  assert.equal(pendingBodyweightHasPreviewProof(undefined), false);
  assert.equal(pendingBodyweightHasPreviewProof({}), false);
  assert.equal(pendingBodyweightHasPreviewProof({ previewProof: { ...good.previewProof, test_mode: false } }), false);
  assert.equal(pendingBodyweightHasPreviewProof({ previewProof: { ...good.previewProof, sheet_write: 'success' } }), false);
  assert.equal(pendingBodyweightHasPreviewProof({ previewProof: { ...good.previewProof, sheet_written: true } }), false);
  assert.equal(pendingBodyweightHasPreviewProof({ previewProof: { ...good.previewProof, no_write_confirmed: false } }), false);
});

// ---------------------------------------------------------------------------
// round-trip — the proof a successful dry-run produces always satisfies the gate
// ---------------------------------------------------------------------------
test('round-trip: a dry-run proof captured by previewProofFromResult passes the approve gate', () => {
  const serverDryRun = { data: { test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true } };
  const write = { previewProof: previewProofFromResult(serverDryRun, 'manual') };
  assert.equal(pendingWriteHasPreviewProof(write), true);
});
