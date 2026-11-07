'use strict';

// Persona artifact finalization (#1664): the privacy sweep and the SHA-256
// hashes must certify the artifact bytes AS PUBLISHED, after the last write.
// The old order swept first and wrote after — the scorecard files, the
// rewritten evidence, and afterAll's raw log + pageerrors were never swept
// or hashed, and the recorded hashes went stale. These tests pin the new
// order's properties in the pure helper module (persona-artifacts.js),
// including an end-to-end replay of both orderings: the old ordering fails
// the final-bytes checks, the new ordering passes them.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EVIDENCE_FILENAME,
  buildForbiddenSecrets,
  redactSecrets,
  sweepArtifactDir,
  verifyFinalArtifacts,
} = require('../tests/e2e/gate/persona-artifacts');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const SECRETS = {
  spreadsheetId: '1AbC2dEf3GhIjKlMnOpQrStUvWxYz0123456789abcd',
  spreadsheetIdLast6: '89abcd',
  serviceAccountEmail: 'atlas-rehearsal@example.iam.gserviceaccount.com',
  // Built by concatenation, per the repo's own convention
  // (test/secret-scan.test.js, test/unit.test.js): the secret scanner reads
  // changed files as text and flags these shapes even as obvious fakes.
  providerKey: 'AIza' + 'SyD-EXAMPLE-PROVIDER-KEY-1234567890',
};
const FORBIDDEN = buildForbiddenSecrets(SECRETS);
const PRIVATE_KEY_BLOCK = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END ' + 'PRIVATE KEY-----';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-artifacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}

describe('redactSecrets — every forbidden value leaves the published text', () => {
  it('redacts the workbook id to its last 6, the key block, the service email, and the provider key', () => {
    const text = [
      `workbook=${SECRETS.spreadsheetId}`,
      `service account ${SECRETS.serviceAccountEmail} ready`,
      PRIVATE_KEY_BLOCK,
      `provider key ${SECRETS.providerKey} configured`,
      'clean line',
    ].join('\n');
    const out = redactSecrets(text, FORBIDDEN);
    assert.equal(out.includes(SECRETS.spreadsheetId), false, 'full workbook id must not survive');
    assert.match(out, /…89abcd/, 'workbook id is replaced by its last 6');
    assert.equal(out.includes('-----BEGIN'), false, 'private-key block must not survive');
    assert.match(out, /\[REDACTED PRIVATE KEY\]/);
    assert.equal(out.includes(SECRETS.serviceAccountEmail), false);
    assert.equal(out.includes(SECRETS.providerKey), false);
    assert.match(out, /clean line/, 'unrelated text is untouched');
    for (const f of FORBIDDEN.scan) assert.equal(f.re.test(out), false, `${f.kind} still matches the redacted text`);
  });

  it('leaves clean text byte-identical', () => {
    const text = 'gate-server listening\nGATE_PORT=8123\n';
    assert.equal(redactSecrets(text, FORBIDDEN), text);
  });
});

describe('sweepArtifactDir — the record over the bytes read', () => {
  it('hashes every file, records bytes, sorts by name, and names leaks', (t) => {
    const dir = tempDir(t);
    write(dir, 'b.txt', 'bee');
    write(dir, 'a.txt', `id ${SECRETS.spreadsheetId}`);
    write(dir, 'c.txt', PRIVATE_KEY_BLOCK);
    const record = sweepArtifactDir(dir, FORBIDDEN);
    assert.equal(record.swept, true);
    assert.deepEqual(record.files.map((f) => f.name), ['a.txt', 'b.txt', 'c.txt']);
    for (const f of record.files) {
      assert.equal(f.sha256, sha256(fs.readFileSync(path.join(dir, f.name))));
      assert.equal(f.bytes, fs.statSync(path.join(dir, f.name)).size);
    }
    assert.deepEqual(record.leaks, ['workbook_id in a.txt', 'private_key in c.txt']);
  });

  it('honors excludeNames', (t) => {
    const dir = tempDir(t);
    write(dir, 'a.txt', 'aye');
    write(dir, EVIDENCE_FILENAME, 'evidence');
    const record = sweepArtifactDir(dir, FORBIDDEN, { excludeNames: [EVIDENCE_FILENAME] });
    assert.deepEqual(record.files.map((f) => f.name), ['a.txt']);
  });
});

describe('verifyFinalArtifacts — the record must match the published bytes', () => {
  it('passes on a clean final dir and scans the excluded container too', (t) => {
    const dir = tempDir(t);
    write(dir, 'server-log.txt', 'clean log\n');
    write(dir, 'scorecard.json', '{"overall":"PASS"}');
    write(dir, EVIDENCE_FILENAME, '{"kind":"PERSONA_SCORECARD"}');
    const record = sweepArtifactDir(dir, FORBIDDEN, { excludeNames: [EVIDENCE_FILENAME] });
    assert.deepEqual(verifyFinalArtifacts(dir, record, FORBIDDEN), { ok: true, checked: 3 });
  });

  it('fails when a listed file changes after the record', (t) => {
    const dir = tempDir(t);
    write(dir, 'server-log.txt', 'v1');
    const record = sweepArtifactDir(dir, FORBIDDEN);
    write(dir, 'server-log.txt', 'v2 — rewritten after the sweep');
    assert.throws(() => verifyFinalArtifacts(dir, record, FORBIDDEN), /changed after the sweep/);
  });

  it('fails when a secret is planted in the final bytes', (t) => {
    const dir = tempDir(t);
    write(dir, 'server-log.txt', 'clean');
    const record = sweepArtifactDir(dir, FORBIDDEN);
    write(dir, 'server-log.txt', `now with the key ${SECRETS.providerKey}`);
    assert.throws(() => verifyFinalArtifacts(dir, record, FORBIDDEN), /leakage in final bytes/);
  });

  it('fails when a secret is planted in the evidence container itself', (t) => {
    const dir = tempDir(t);
    write(dir, 'server-log.txt', 'clean');
    write(dir, EVIDENCE_FILENAME, '{"kind":"PERSONA_SCORECARD"}');
    const record = sweepArtifactDir(dir, FORBIDDEN, { excludeNames: [EVIDENCE_FILENAME] });
    write(dir, EVIDENCE_FILENAME, `{"kind":"PERSONA_SCORECARD","leak":"${SECRETS.spreadsheetId}"}`);
    assert.throws(() => verifyFinalArtifacts(dir, record, FORBIDDEN), /workbook_id in persona-evidence\.json/);
  });

  it('fails when a file is added after the record, or a recorded file is deleted', (t) => {
    const dir = tempDir(t);
    write(dir, 'a.txt', 'aye');
    const record = sweepArtifactDir(dir, FORBIDDEN);
    write(dir, 'late.txt', 'arrived after the sweep');
    assert.throws(() => verifyFinalArtifacts(dir, record, FORBIDDEN), /published but has no recorded hash/);
    fs.rmSync(path.join(dir, 'late.txt'));
    fs.rmSync(path.join(dir, 'a.txt'));
    assert.throws(() => verifyFinalArtifacts(dir, record, FORBIDDEN), /recorded but no longer published/);
  });
});

describe('the #1664 ordering — old order fails, new order passes', () => {
  // The server stdout a scored run can emit: the full workbook id, the
  // service email, a private-key block, and the provider key.
  const serverStdout = [
    'gate-server listening',
    `workbook=${SECRETS.spreadsheetId}`,
    `service account ${SECRETS.serviceAccountEmail} ready`,
    PRIVATE_KEY_BLOCK,
    `provider key ${SECRETS.providerKey} configured`,
    'GATE_PORT=8123',
  ].join('\n');

  function recordMatchesFinalBytes(dir, record) {
    const byName = new Map(record.files.map((f) => [f.name, f]));
    for (const name of fs.readdirSync(dir)) {
      // The evidence file is excluded from its own file list by design
      // (self_excluded) — its bytes are leak-scanned, not hashed.
      if (name === EVIDENCE_FILENAME) continue;
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;
      const listed = byName.get(name);
      if (!listed) return `published ${name} has no recorded hash`;
      if (listed.sha256 !== sha256(fs.readFileSync(full))) return `recorded hash of ${name} is stale`;
    }
    return null;
  }

  it('the old ordering publishes bytes its record cannot certify', (t) => {
    const dir = tempDir(t);
    // Old §13: redacted log (workbook id only), first evidence write, sweep,
    // scorecard files, evidence rewrite — then old afterAll: raw log +
    // pageerrors.
    write(dir, 'server-log.txt', serverStdout.split(SECRETS.spreadsheetId).join(`…${SECRETS.spreadsheetIdLast6}`));
    write(dir, EVIDENCE_FILENAME, '{"kind":"PERSONA_SCORECARD","ok":false}\n');
    const record = sweepArtifactDir(dir, FORBIDDEN);
    write(dir, 'scorecard.json', '{"overall":"PASS"}');
    write(dir, 'SCORECARD.md', '# Scorecard\n\nPASS\n');
    write(dir, EVIDENCE_FILENAME, '{"kind":"PERSONA_SCORECARD","ok":true}\n');
    write(dir, 'server-log.txt', serverStdout);
    write(dir, 'pageerrors.txt', '[pageerror] boom\n');
    const mismatch = recordMatchesFinalBytes(dir, record);
    assert.match(mismatch, /stale|no recorded hash/);
    assert.equal(fs.readFileSync(path.join(dir, 'server-log.txt'), 'utf8').includes(SECRETS.spreadsheetId), true,
      'the final log carries the full workbook id the sweep never saw');
    assert.throws(() => verifyFinalArtifacts(dir, record, FORBIDDEN), /verification failed/);
  });

  it('the new ordering publishes bytes its record certifies', (t) => {
    const dir = tempDir(t);
    // New §13, same order as persona.spec.js: content artifacts, provisional
    // sweep, scorecard files + evidence, final sweep, evidence rewrite with
    // the final record, post-write verification.
    write(dir, 'server-log.txt', redactSecrets(serverStdout, FORBIDDEN));
    write(dir, 'pageerrors.txt', '[pageerror] boom\n');
    const provisional = sweepArtifactDir(dir, FORBIDDEN);
    const observations = { artifacts: { ...provisional, self_excluded: EVIDENCE_FILENAME } };
    write(dir, 'scorecard.json', '{"overall":"PASS"}');
    write(dir, 'SCORECARD.md', '# Scorecard\n\nPASS\n');
    const evidence = { kind: 'PERSONA_SCORECARD', ok: true, observations };
    write(dir, EVIDENCE_FILENAME, `${JSON.stringify(evidence, null, 2)}\n`);
    const finalRecord = sweepArtifactDir(dir, FORBIDDEN, { excludeNames: [EVIDENCE_FILENAME] });
    assert.deepEqual(finalRecord.leaks, [], 'the final bytes leak nothing');
    for (const f of provisional.files) {
      const now = finalRecord.files.find((g) => g.name === f.name);
      assert.ok(now && now.sha256 === f.sha256, `${f.name} changed between the sweeps`);
    }
    observations.artifacts = { ...finalRecord, self_excluded: EVIDENCE_FILENAME };
    write(dir, EVIDENCE_FILENAME, `${JSON.stringify(evidence, null, 2)}\n`);
    assert.equal(verifyFinalArtifacts(dir, observations.artifacts, FORBIDDEN).ok, true);
    assert.equal(recordMatchesFinalBytes(dir, observations.artifacts), null);
    const published = JSON.parse(fs.readFileSync(path.join(dir, EVIDENCE_FILENAME), 'utf8'));
    assert.deepEqual(published.observations.artifacts.files.map((f) => f.name).sort(),
      ['SCORECARD.md', 'pageerrors.txt', 'scorecard.json', 'server-log.txt']);
    assert.equal(published.observations.artifacts.self_excluded, EVIDENCE_FILENAME);
    const log = fs.readFileSync(path.join(dir, 'server-log.txt'), 'utf8');
    for (const f of FORBIDDEN.scan) assert.equal(f.re.test(log), false, `${f.kind} in the published log`);
  });
});
