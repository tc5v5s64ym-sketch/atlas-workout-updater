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
  finalizePersonaArtifacts,
} = require('../tests/e2e/gate/persona-artifacts');
const { renderMarkdown } = require('../tests/e2e/gate/rehearsal-scorecard');

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

describe('finalizePersonaArtifacts — verification failure must invalidate PASS (#1664, reopened)', () => {
  // The reopened gap: on verifier failure the current §13 left the
  // already-written scorecard + evidence claiming PASS (ok:true) and
  // afterAll rewrote the log + pageerrors after the final sweep. The
  // failing-first case Astra names: a forbidden value that appears ONLY in
  // evidence.turns/notes — the step-4 sweep cannot see the self-excluded
  // evidence file, so only the step-5 post-write verification catches it.
  const serverStdout = 'gate-server listening\nGATE_PORT=8123\n';

  function makeScorecard(overrides = {}) {
    return {
      purpose: 'PERSONA_RUN', persona_slug: 'priya', qualifying: false,
      session_number: undefined, overall: 'PASS',
      counts: { PASS: 24, FAIL: 0, ERROR: 0, NOT_APPLICABLE: 0 },
      conditions: [{ id: '23', status: 'PASS', detail: 'artifacts swept, no leaks' }],
      rehearsal_eligible: false, rehearsal_note: 'persona run — scenario evidence only',
      ...overrides,
    };
  }

  function makeEvidence(overrides = {}) {
    return {
      kind: 'PERSONA_SCORECARD', ok: true, run_id: 'test-run',
      turns: [], notes: [],
      observations: { artifacts: { swept: false, leaks: [], files: [] } },
      scorecard: { overall: 'PASS', counts: { PASS: 24, FAIL: 0, ERROR: 0, NOT_APPLICABLE: 0 }, rehearsal_eligible: false },
      ...overrides,
    };
  }

  // Stages steps 1-2 exactly as persona.spec.js §13 does, then hands the
  // scored artifacts to the helper for steps 3-5 + the failure repair.
  function finalize(t, { evidence, scorecard, scorecardJson, scorecardMd, pageErrors = [] }) {
    const dir = tempDir(t);
    write(dir, 'server-log.txt', redactSecrets(serverStdout, FORBIDDEN));
    write(dir, 'pageerrors.txt', pageErrors.join('\n\n') || '(no page errors captured)');
    const provisional = sweepArtifactDir(dir, FORBIDDEN);
    evidence.observations.artifacts = { ...provisional, self_excluded: EVIDENCE_FILENAME };
    const result = finalizePersonaArtifacts(dir, {
      serverStdout, pageErrors, evidence, scorecard,
      scorecardJson: scorecardJson ?? JSON.stringify(scorecard, null, 2),
      scorecardMd: scorecardMd ?? renderMarkdown(scorecard),
      renderScorecardMarkdown: renderMarkdown, forbidden: FORBIDDEN, provisional,
    });
    return { dir, result };
  }

  function publishedEvidence(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, EVIDENCE_FILENAME), 'utf8'));
  }

  it('a forbidden value only in evidence.turns fails the run AND the published artifacts stop claiming PASS', (t) => {
    const evidence = makeEvidence({ turns: [{ note: `workbook=${SECRETS.spreadsheetId}` }] });
    const scorecard = makeScorecard();
    const { dir, result } = finalize(t, { evidence, scorecard });
    assert.equal(result.ok, false, 'the run must fail — a forbidden value reached the evidence');
    assert.match(result.reason, /workbook_id in persona-evidence\.json/);
    const published = publishedEvidence(dir);
    assert.equal(published.ok, false, 'the published evidence must not claim ok:true');
    assert.equal(published.scorecard.overall, 'FAIL');
    assert.equal(published.scorecard.counts.FAIL, 1, 'the evidence summary counts the FAIL condition too');
    assert.match(published.finalization_failure, /workbook_id in persona-evidence\.json/);
    assert.equal(JSON.stringify(published).includes(SECRETS.spreadsheetId), false,
      'the forbidden value must not survive in the published evidence');
    const publishedCard = JSON.parse(fs.readFileSync(path.join(dir, 'scorecard.json'), 'utf8'));
    assert.equal(publishedCard.overall, 'FAIL');
    assert.equal(publishedCard.counts.FAIL, 1);
    assert.deepEqual(
      publishedCard.conditions.filter((c) => c.id === 'finalization').map((c) => c.status), ['FAIL']);
    const md = fs.readFileSync(path.join(dir, 'SCORECARD.md'), 'utf8');
    assert.match(md, /— FAIL/, 'the markdown banner must say FAIL');
    assert.match(md, /\| finalization \| FAIL \|/, 'the markdown must carry the FAIL condition');
    // The repaired artifact set certifies its own final bytes: no leak in
    // any published file, every recorded hash matching.
    assert.equal(verifyFinalArtifacts(dir, published.observations.artifacts, FORBIDDEN).ok, true);
    assert.equal(recordMatchesFinalBytes(dir, published.observations.artifacts), null);
  });

  it('a leak in the scorecard files fails at the final sweep and is repaired the same way', (t) => {
    const evidence = makeEvidence();
    const scorecard = makeScorecard();
    const { dir, result } = finalize(t, {
      evidence, scorecard,
      scorecardJson: `{"overall":"PASS","leak":"${SECRETS.spreadsheetId}"}`,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /leak in final bytes/);
    const published = publishedEvidence(dir);
    assert.equal(published.ok, false);
    assert.equal(published.scorecard.overall, 'FAIL');
    assert.equal(JSON.stringify(published).includes(SECRETS.spreadsheetId), false);
    assert.equal(fs.readFileSync(path.join(dir, 'scorecard.json'), 'utf8').includes(SECRETS.spreadsheetId), false);
    assert.equal(verifyFinalArtifacts(dir, published.observations.artifacts, FORBIDDEN).ok, true);
  });

  it('a clean run finalizes with ok:true and a record that verifies (no regression)', (t) => {
    const evidence = makeEvidence();
    const scorecard = makeScorecard();
    const { dir, result } = finalize(t, { evidence, scorecard, pageErrors: ['[pageerror] boom'] });
    assert.deepEqual(result, { ok: true });
    const published = publishedEvidence(dir);
    assert.equal(published.ok, true);
    assert.equal(published.scorecard.overall, 'PASS');
    assert.equal(published.finalization_failure, undefined);
    assert.equal(verifyFinalArtifacts(dir, published.observations.artifacts, FORBIDDEN).ok, true);
    assert.equal(recordMatchesFinalBytes(dir, published.observations.artifacts), null);
    assert.deepEqual(published.observations.artifacts.files.map((f) => f.name).sort(),
      ['SCORECARD.md', 'pageerrors.txt', 'scorecard.json', 'server-log.txt']);
    assert.equal(published.observations.artifacts.self_excluded, EVIDENCE_FILENAME);
  });
});
