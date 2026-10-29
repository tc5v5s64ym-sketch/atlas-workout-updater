'use strict';

// F-SB4B rehearsal attempt-guard bites (TEMPORARY; sunset: F-SB4C). Proves a
// qualifying rehearsal run can never be retried into a PASS: playwright.config.js
// grants CI runs one retry, the rehearsal spec writes scorecard.json BEFORE
// asserting the run passed (writeFileSync truncates), and the operator command
// decides solely from the Playwright exit code plus the final scorecard — so a
// scored FAIL under CI=true was retried, overwritten, and reported as a PASS
// (demonstrated end-to-end on the base tree with a synthetic probe: attempt
// retry=0 wrote overall=FAIL, attempt retry=1 overwrote it with overall=PASS,
// Playwright exited 0). These bites pin the two layers:
//   the runner's spawn carries --retries=0 (the config is untouched, so
//   ordinary E2E keeps its CI retry);
//   the spec consults the guard in beforeAll, before the gate server spawns;
//   evaluateAttempt / refuseRetriedAttempt — the pure decision and the record
//   that leaves the first attempt's evidence byte-identical.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RETRY_REFUSED_MARKER, RETRY_REFUSED_BOUNDARY, evaluateAttempt, refuseRetriedAttempt,
} = require('../tests/e2e/gate/rehearsal-attempt-guard');

describe('evaluateAttempt — the pure decision', () => {
  it('passes the first attempt (retry exactly 0)', () => {
    const v = evaluateAttempt({ retry: 0 });
    assert.equal(v.ok, true);
    assert.equal(v.retry, 0);
    assert.equal(v.reason, null);
  });

  it('refuses retry 1 and names the attempt it would have been', () => {
    const v = evaluateAttempt({ retry: 1 });
    assert.equal(v.ok, false);
    assert.equal(v.retry, 1);
    assert.match(v.reason, /attempt 2 \(retry 1\)/);
    assert.match(v.reason, /never scored/);
  });

  it('refuses any higher retry index too', () => {
    const v = evaluateAttempt({ retry: 3 });
    assert.equal(v.ok, false);
    assert.match(v.reason, /attempt 4 \(retry 3\)/);
  });

  it('refuses fail-closed when the retry index cannot prove a first attempt', () => {
    for (const retry of [undefined, null, '1', 1.5, -1, NaN]) {
      const v = evaluateAttempt({ retry });
      assert.equal(v.ok, false, `retry=${String(retry)} must refuse`);
      assert.match(v.reason, /cannot be proven to be the first attempt/);
    }
  });
});

describe('refuseRetriedAttempt — the pre-turn refusal and its record', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-attempt-guard-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('a refused retry records RETRY_REFUSED.json — and makes NO started claim about the run', () => {
    const artifactDir = path.join(root, 'artifacts');
    const v = refuseRetriedAttempt({ artifactDir, runId: 'fsb4b-s1-test', retry: 1 });
    assert.equal(v.ok, false);
    const record = JSON.parse(fs.readFileSync(path.join(artifactDir, RETRY_REFUSED_MARKER), 'utf8'));
    assert.equal(record.refused, true);
    assert.equal(record.kind, 'RETRY_REFUSED');
    assert.equal(record.run_id, 'fsb4b-s1-test');
    assert.equal(record.retry_index, 1);
    assert.equal(record.attempt_number, 2);
    assert.equal(record.boundary, RETRY_REFUSED_BOUNDARY);
    assert.match(record.reason, /never scored/);
    // MACHINERY_ABORT.json asserts the run never started; for a retry that can
    // be false (attempt 1 may have crossed the boundary), so this record
    // carries no `started` field in either direction.
    assert.equal('started' in record, false);
  });

  it('a refusal leaves the first attempt\'s scorecard and RUN_START byte-identical', () => {
    const artifactDir = path.join(root, 'artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    const failCard = `${JSON.stringify({ overall: 'FAIL', counts: { PASS: 24, FAIL: 1 } }, null, 2)}\n`;
    const runStart = `${JSON.stringify({ started: true, run_id: 'fsb4b-s1-test' }, null, 2)}\n`;
    fs.writeFileSync(path.join(artifactDir, 'scorecard.json'), failCard);
    fs.writeFileSync(path.join(artifactDir, 'RUN_START.json'), runStart);
    refuseRetriedAttempt({ artifactDir, runId: 'fsb4b-s1-test', retry: 1 });
    assert.equal(fs.readFileSync(path.join(artifactDir, 'scorecard.json'), 'utf8'), failCard);
    assert.equal(fs.readFileSync(path.join(artifactDir, 'RUN_START.json'), 'utf8'), runStart);
  });

  it('the first attempt records nothing and passes', () => {
    const artifactDir = path.join(root, 'artifacts');
    const v = refuseRetriedAttempt({ artifactDir, runId: 'fsb4b-s1-test', retry: 0 });
    assert.equal(v.ok, true);
    assert.equal(fs.existsSync(path.join(artifactDir, RETRY_REFUSED_MARKER)), false);
  });
});

describe('the two layers are wired where they must be', () => {
  const runnerSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'atlas-rehearsal-session.js'), 'utf8');
  const specSrc = fs.readFileSync(path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'rehearsal.spec.js'), 'utf8');
  const configSrc = fs.readFileSync(path.join(__dirname, '..', 'playwright.config.js'), 'utf8');

  it('the operator command\'s Playwright spawn carries --retries=0', () => {
    assert.match(runnerSrc, /'--retries=0'/);
  });

  it('the spec consults the guard on test.info().retry BEFORE the gate server spawns', () => {
    const guardAt = specSrc.indexOf('refuseRetriedAttempt({');
    const serverAt = specSrc.indexOf("path.join(__dirname, 'gate-server.js')");
    assert.ok(guardAt !== -1, 'the spec must consult refuseRetriedAttempt');
    assert.match(specSrc.slice(guardAt, guardAt + 200), /test\.info\(\)\.retry/);
    assert.ok(serverAt !== -1 && guardAt < serverAt, 'the guard must precede the gate-server spawn');
  });

  it('playwright.config.js keeps its CI retry — ordinary E2E behaviour is out of scope', () => {
    assert.match(configSrc, /retries: process\.env\.CI \? 1 : 0/);
  });
});
