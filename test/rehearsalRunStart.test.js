'use strict';

// F-SB4B session-start marker bites (TEMPORARY; sunset: F-SB4C). The counting rule
// hangs the whole streak on the RUN_START marker, so the pre-submission check must be
// a full read-back through the canonical reader — path existence is not evidence. An
// empty, partial, malformed, stale, or foreign-run marker EXISTS on disk and would
// permit submission while later reading as NOT STARTED, misclassifying a genuinely
// started (and possibly failed) session as never begun — the one direction the
// counting rule can never tolerate (owner P2, 2026-08-03).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RUN_START_MARKER, RUN_START_BOUNDARY,
  markRunStarted, verifyRunStartMarker, readRunStart, classifyIncompleteRun,
} = require('../tests/e2e/gate/rehearsal-run-start');

const EXPECTED = Object.freeze({
  run_id: 'fsb4b-s1-20260803T000000-AA11BB',
  purpose: 'REHEARSAL_SESSION',
  rehearsal_session_number: 1,
  source_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
});

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-marker-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const markerPath = () => path.join(dir, RUN_START_MARKER);

describe('the happy path', () => {
  it('write → read-back verifies every identity field and the boundary declaration', () => {
    assert.equal(markRunStarted(dir, EXPECTED), true);
    const v = verifyRunStartMarker(dir, EXPECTED);
    assert.deepEqual(v, { ok: true, reason: null });
    const parsed = readRunStart(dir);
    assert.equal(parsed.boundary, RUN_START_BOUNDARY);
    assert.equal(classifyIncompleteRun(parsed).verdict, 'FAILED_SESSION');
  });
});

describe('read-back refusals — every corrupt-but-existing marker refuses BEFORE submission', () => {
  it('refuses malformed JSON', () => {
    fs.writeFileSync(markerPath(), '{ not json');
    const v = verifyRunStartMarker(dir, EXPECTED);
    assert.equal(v.ok, false);
    assert.match(v.reason, /could not be read back/);
  });

  it('refuses an empty file', () => {
    fs.writeFileSync(markerPath(), '');
    const v = verifyRunStartMarker(dir, EXPECTED);
    assert.equal(v.ok, false);
    assert.match(v.reason, /could not be read back/);
  });

  it('refuses a marker that never declares started:true', () => {
    fs.writeFileSync(markerPath(), JSON.stringify({ ...EXPECTED, boundary: RUN_START_BOUNDARY }));
    const v = verifyRunStartMarker(dir, EXPECTED);
    assert.equal(v.ok, false);
    assert.match(v.reason, /could not be read back/);
  });

  for (const [field, wrong] of [
    ['run_id', 'fsb4b-s1-20260101T000000-ZZ99ZZ'],
    ['rehearsal_session_number', 2],
    ['purpose', 'STAGE_A_CANARY'],
    ['source_sha', 'ffffffffffffffffffffffffffffffffffffffff'],
    ['boundary', 'some other declaration'],
  ]) {
    it(`refuses a wrong ${field}`, () => {
      fs.writeFileSync(markerPath(), JSON.stringify({
        started: true, boundary: RUN_START_BOUNDARY, ...EXPECTED, [field]: wrong,
      }));
      const v = verifyRunStartMarker(dir, EXPECTED);
      assert.equal(v.ok, false, field);
      assert.match(v.reason, new RegExp(field));
      assert.match(v.reason, /stale or foreign marker/);
    });
  }

  it('refuses a STALE pre-existing marker from another run — markRunStarted never overwrites, and read-back catches the mismatch', () => {
    const staleRun = { ...EXPECTED, run_id: 'fsb4b-s1-20260802T000000-OLD001' };
    assert.equal(markRunStarted(dir, staleRun), true);
    // The new run attempts to mark; the stale file survives (never overwritten)…
    assert.equal(markRunStarted(dir, EXPECTED), false);
    // …and existence alone would have permitted submission. The read-back refuses.
    assert.equal(fs.existsSync(markerPath()), true);
    const v = verifyRunStartMarker(dir, EXPECTED);
    assert.equal(v.ok, false);
    assert.match(v.reason, /run_id/);
  });

  it('refuses a missing marker and a missing artifact dir', () => {
    assert.equal(verifyRunStartMarker(dir, EXPECTED).ok, false);
    assert.equal(verifyRunStartMarker(null, EXPECTED).ok, false);
  });
});
