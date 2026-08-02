'use strict';

// Gate harness — posture safety.
//
// These assert the HARNESS cannot serve a browser an unsafe workbook or a mislabeled model
// posture. Offline by construction: the only credentials used are deliberately malformed, so
// no Google client can authenticate and no write is reachable from any case here.
//
// HISTORY, because it changes what these cases mean. This file was `gateHarnessSandboxPosture`
// and carried a second set of cases for a temporary `ATLAS_GATE_SANDBOX_LIVE` posture, which
// let the Phase 4 Stage-A runner drive a durable write against the repository-declared sandbox
// workbook. Stage A reached 5/5 on 2026-08-01 and that posture was removed under its recorded
// sunset, together with its write guard, its preflight, and its durable-row verifier.
//
// What survived is the part that was never temporary:
//
//   • the workbook-safety guarantee, which is now STRONGER. It used to be an assertion — "the
//     resolved workbook must be the declared sandbox" — checked before publishing a port. It is
//     now structural: the harness always replaces `sheets.js` with an in-memory stub, so no
//     Google client is ever constructed and there is no workbook to select wrongly. The case
//     below that exports a real-looking `GOOGLE_SHEETS_ID` proves the harness ignores it.
//   • the model-posture authority from PR #1226: model-up is opt-in, never inferred from a key
//     being present, and a harness that cannot prove its declared posture refuses to start.
//   • the single declaration of the sandbox workbook id in `config/sandboxSheet.js`, which was
//     never Stage-A machinery — `sheets.js` reads it to decide `isSandboxSheet`, and
//     `scripts/sim/harness.js` reads it to decide whether write mode is legal.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { SANDBOX_SPREADSHEET_ID, SANDBOX_SPREADSHEET_ID_LAST6, isSandboxSpreadsheetId } = require('../config/sandboxSheet');

const GATE_SERVER = path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'gate-server.js');

// A private key with no usable PEM body: googleapis fails locally when it tries to sign,
// so these cases do not depend on reaching Google.
const FAKE_CREDS = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'stub@example.com',
  GOOGLE_PRIVATE_KEY: 'not-a-real-key',
};

// Spawn the harness with an EXPLICITLY constructed environment. `...process.env` is never
// spread: a host exporting a real GOOGLE_SHEETS_ID or provider key is the exact accident
// under test, and inheriting it would make these cases lie.
function runHarness(env, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE_SERVER], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; child.kill('SIGKILL'); resolve(result); } };
    const timer = setTimeout(() => done({ code: null, stdout, stderr, timedOut: true }), timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += String(d);
      // A published port means the harness decided to serve. Capture that and stop.
      if (/GATE_PORT=\d+/.test(stdout)) { clearTimeout(timer); done({ code: 0, stdout, stderr, served: true }); }
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('exit', (code) => { clearTimeout(timer); done({ code, stdout, stderr, served: /GATE_PORT=\d+/.test(stdout) }); });
  });
}

const served = (r) => /GATE_PORT=\d+/.test(r.stdout);

// ── the declared sandbox constant (permanent — not Stage-A machinery) ──────────

test('the sandbox workbook id is declared exactly once and both consumers agree', () => {
  // sheets.js decides `isSandboxSheet`; the sim harness decides whether write mode is legal.
  // Both must resolve the same id, or one guard would believe a workbook is the sandbox
  // while the other believed it is not.
  const sheets = require('../sheets');
  const prev = process.env.GOOGLE_SHEETS_ID;
  try {
    assert.ok(isSandboxSpreadsheetId(SANDBOX_SPREADSHEET_ID));
    assert.strictEqual(isSandboxSpreadsheetId('something-else'), false);
    assert.strictEqual(isSandboxSpreadsheetId(undefined), false);
    assert.strictEqual(SANDBOX_SPREADSHEET_ID_LAST6, SANDBOX_SPREADSHEET_ID.slice(-6));
    assert.strictEqual(typeof sheets.getSafeSpreadsheetConfig, 'function');
  } finally {
    if (prev === undefined) delete process.env.GOOGLE_SHEETS_ID; else process.env.GOOGLE_SHEETS_ID = prev;
  }
  const simHarness = require('../scripts/sim/harness');
  assert.strictEqual(simHarness.SANDBOX_SHEET_ID, SANDBOX_SPREADSHEET_ID,
    'the simulation harness resolved a different sandbox id than config/sandboxSheet.js');
});

// ── the harness can never reach a real workbook ────────────────────────────────

test('the harness serves the in-memory stub and never a real workbook', async () => {
  const r = await runHarness({ ATLAS_GATE_KEY: 'k' });
  assert.ok(served(r), `the harness failed to start: ${r.stderr.slice(-600)}`);
  assert.match(r.stdout, /GATE_SHEETS_POSTURE=in-memory-stub/);
  assert.match(r.stdout, /GATE_MODEL_POSTURE=model-down/);
});

test('an exported production-looking workbook id is ignored, not inherited', async () => {
  // This is the case that used to matter most, and it still does — but for a stronger reason.
  // It previously proved an assertion caught a bad id; it now proves the id is irrelevant,
  // because no adapter exists that could use it.
  const r = await runHarness({ ATLAS_GATE_KEY: 'k', GOOGLE_SHEETS_ID: 'a-production-workbook-id', ...FAKE_CREDS });
  assert.ok(served(r), `the harness failed to start: ${r.stderr.slice(-600)}`);
  assert.match(r.stdout, /GATE_SHEETS_POSTURE=in-memory-stub/);
  assert.ok(!/a-production-workbook-id/.test(r.stdout), 'the harness echoed the supplied workbook id');
});

test('the sandbox-live posture refuses fake credentials rather than serving a half-configured run', async () => {
  // TEMPORARY F-SB4B — RESTORE THE UNCONDITIONAL ASSERTION IN F-SB4C.
  //
  // Until Stage A closed, this test asserted that NO live-workbook posture existed at all.
  // The owner ruling of 2026-08-02 (option A) restored the posture for the F-SB4 rehearsal,
  // so the absence assertion is temporarily wrong and would fail on correct code. What must
  // still hold — and what this now pins — is that the posture cannot be entered casually:
  // it fails CLOSED on anything it needs and does not have.
  //
  // FAKE_CREDS are syntactically present but not a real service account, so the sandbox
  // preflight cannot resolve the declared workbook and must refuse. A harness that PUBLISHED
  // a port here would be serving a run whose workbook was never verified.
  const r = await runHarness({ ATLAS_GATE_KEY: 'k', ATLAS_GATE_SANDBOX_LIVE: '1', ...FAKE_CREDS }, { timeoutMs: 90000 });
  assert.ok(!served(r), 'the sandbox-live posture published a port without a verified workbook');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_SANDBOX_ERROR:/,
    'the refusal must name which sandbox preflight check failed');
});

test('the sandbox-live + ledger combination is refused for any workbook that is not the declared sandbox', async () => {
  // TEMPORARY F-SB4B — DELETE WITH THE PERMISSION IN F-SB4C.
  //
  // The owner authorized the ledger tabs in the DECLARED SANDBOX ONLY. The permission is
  // therefore scoped to that one workbook literal, and every other workbook keeps the
  // original hard refusal — so a stray GOOGLE_SHEETS_ID can never unlock a live ledger
  // write. This pins the scope, which is the part of the permission that must not drift.
  const r = await runHarness({
    ATLAS_GATE_KEY: 'k',
    ATLAS_GATE_SANDBOX_LIVE: '1',
    ATLAS_GATE_LEDGER_SANDBOX: '1',
    ...FAKE_CREDS,
  }, { timeoutMs: 90000 });
  assert.ok(!served(r), 'a ledger-enabled sandbox-live run published a port without a verified workbook');
  assert.strictEqual(r.code, 2);
});

test('the default posture is still the in-memory stub, and never sandbox-live', async () => {
  // The restored posture is STRICTLY OPT-IN. Without the flag nothing Google-shaped exists,
  // which is what keeps every other gate spec credential-free and write-free.
  const r = await runHarness({ ATLAS_GATE_KEY: 'k', ...FAKE_CREDS });
  assert.ok(served(r), `the harness failed to start: ${r.stderr.slice(-600)}`);
  assert.match(r.stdout, /GATE_SHEETS_POSTURE=in-memory-stub/);
  assert.ok(!/sandbox-live/.test(r.stdout), 'the default posture advertised sandbox-live');
});

// ── model posture, unchanged authority from PR #1226 ───────────────────────────

test('model-down deletes a provider key rather than inferring model-up from it', async () => {
  const r = await runHarness({ ATLAS_GATE_KEY: 'k', GEMINI_API_KEY: 'fake-key-value', ...FAKE_CREDS });
  assert.ok(served(r), `the harness failed to start: ${r.stderr.slice(-600)}`);
  assert.match(r.stdout, /GATE_MODEL_POSTURE=model-down/);
  assert.ok(!/GATE_POSTURE_ERROR: model-down harness has provider key/.test(r.stderr),
    'model-down should have deleted the provider key before the app loaded');
});

test('a model-up run with an unreachable provider refuses to start', async () => {
  const r = await runHarness({
    ATLAS_GATE_KEY: 'k', ATLAS_GATE_MODEL_UP: '1',
    GEMINI_API_KEY: 'definitely-not-a-valid-key', ...FAKE_CREDS,
  }, { timeoutMs: 60000 });
  assert.ok(!served(r), 'model-up published a port without a reachable provider');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_POSTURE_ERROR: ATLAS_GATE_MODEL_UP=1/);
});

test('a model-up run with no provider key at all fails closed', async () => {
  const r = await runHarness({ ATLAS_GATE_KEY: 'k', ATLAS_GATE_MODEL_UP: '1', ...FAKE_CREDS });
  assert.ok(!served(r));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_POSTURE_ERROR: ATLAS_GATE_MODEL_UP=1/);
});

test('a scripted coach can never be served as a model-up run', async () => {
  const r = await runHarness({
    ATLAS_GATE_KEY: 'k', ATLAS_GATE_MODEL_UP: '1', ATLAS_GATE_COACH_SCRIPT: '1',
    GEMINI_API_KEY: 'fake', ...FAKE_CREDS,
  });
  assert.ok(!served(r));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /a scripted coach calls no provider/);
});

// ── the default Playwright lane stays credential-free and write-free ───────────

test('exactly ONE spec is credentialed, and it is excluded from the default lane', () => {
  // TEMPORARY F-SB4B — RESTORE THE "NOTHING IS EXCLUDED" ASSERTION IN F-SB4C.
  //
  // The default e2e lane is credential-free and write-free by construction, and that is
  // what lets CI run it. The F-SB4 rehearsal runner is the single exception: it drives a
  // real provider and a real sandbox workbook. The risk is not that an exception exists —
  // it is that the set of exceptions GROWS unnoticed, so this pins the set to exactly one
  // named file and pins that the file is genuinely excluded.
  const fs = require('node:fs');
  const configText = fs.readFileSync(path.join(__dirname, '..', 'playwright.config.js'), 'utf8');
  assert.match(configText, /testIgnore:.*ATLAS_FSB4B_REHEARSAL.*'\*\*\/fsb4b-rehearsal\.spec\.js'/s,
    'the credentialed rehearsal spec must be excluded unless explicitly opted into');
  assert.ok(!/ATLAS_GATE_SANDBOX_LIVE/.test(configText),
    'playwright.config.js must not itself set the sandbox-live posture flag');

  const specDir = path.join(__dirname, '..', 'tests', 'e2e');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.spec.js') ? [full] : []);
  });
  const offenders = walk(specDir)
    .filter((f) => /ATLAS_GATE_SANDBOX_LIVE/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.basename(f));
  assert.deepStrictEqual(offenders, ['fsb4b-rehearsal.spec.js'],
    'exactly one spec may reach a real workbook, and it is the F-SB4B rehearsal runner');
});

// ── the temporary Stage-A machinery is gone and stays gone ─────────────────────

test('the retired Stage-A operator commands and runner are absent', () => {
  // The sunset is recorded in docs/ATLAS_V1_EXECUTION_PLAN.md. This is the mechanical half:
  // if any of it is restored without an owner instruction, this fails rather than quietly
  // reopening a path from a browser test to a real Google workbook.
  const fs = require('node:fs');
  const root = path.join(__dirname, '..');
  const gone = [
    'scripts/atlas-stage-a-canary.js',
    'scripts/atlas-stage-a-session.js',
    'tests/e2e/gate/stage-a-canary.spec.js',
    'tests/e2e/gate/stage-a-canary-scorecard.js',
    'tests/e2e/gate/stage-a-run-purpose.js',
    'tests/e2e/gate/stage-a-run-start.js',
    'tests/e2e/gate/stage-a-source-facts.js',
    'tests/e2e/gate/canary-child-env.js',
  ];
  for (const rel of gone) {
    assert.strictEqual(fs.existsSync(path.join(root, rel)), false,
      `${rel} was removed under the Stage-A sunset and has reappeared`);
  }

  const scripts = require('../package.json').scripts;
  assert.deepStrictEqual(Object.keys(scripts).filter((k) => /stage-a/i.test(k)), [],
    'a retired Stage-A operator command reappeared in package.json');

  const harness = fs.readFileSync(path.join(root, 'tests/e2e/gate/gate-server.js'), 'utf8');
  // The durable-row verifier stayed retired. It was a harness-side endpoint that read
  // workbook rows back; the F-SB4 rehearsal reads the sandbox directly with the
  // read-only reviewer instead, so no such endpoint is reintroduced.
  assert.ok(!harness.includes('durable-rows'),
    'gate-server.js reintroduced the durable-row verifier endpoint');
});

test('every restored F-SB4B artifact carries its F-SB4C removal marker', () => {
  // TEMPORARY F-SB4B — THIS TEST IS DELETED IN F-SB4C, ONCE THE ARTIFACTS ARE.
  //
  // The sandbox-live posture is back under the owner ruling of 2026-08-02 (option A), so
  // asserting its ABSENCE would now fail on correct code. What replaces that assertion is
  // this: every restored piece must SAY it is temporary and name the slice that removes
  // it. A sunset recorded only in a plan is a promise; a sunset that fails the build is a
  // mechanism. F-SB4C deletes the artifacts, this test, and the two posture tests above
  // together — and the file-absence list below keeps guarding the pieces that were never
  // restored.
  const fs = require('node:fs');
  const root = path.join(__dirname, '..');
  const harness = fs.readFileSync(path.join(root, 'tests/e2e/gate/gate-server.js'), 'utf8');

  for (const token of ['ATLAS_GATE_SANDBOX_LIVE', 'buildGuardedSheets', 'assertSandboxLive']) {
    assert.ok(harness.includes(token),
      `gate-server.js is missing "${token}" — if F-SB4C has run, delete this test with it`);
  }
  const markers = harness.match(/REMOVE IN F-SB4C/g) || [];
  assert.ok(markers.length >= 3,
    `each restored F-SB4B block must carry a "REMOVE IN F-SB4C" marker; found ${markers.length}`);

  // The provisioner is temporary too, and says so in its own header.
  const provisioner = path.join(root, 'scripts/fsb4b-provision-sandbox-ledger.js');
  assert.strictEqual(fs.existsSync(provisioner), true,
    'the F-SB4B provisioner is missing — if F-SB4C has run, delete this test with it');
  assert.match(fs.readFileSync(provisioner, 'utf8'), /DELETE IN F-SB4C/,
    'the provisioner must declare its own removal condition');

  // The permission is SCOPED: the harness must still refuse a non-sandbox workbook.
  assert.match(harness, /permitted ONLY against the declared sandbox workbook/,
    'the ledger permission lost its declared-sandbox scope');
  // And the app must still be structurally unable to create a tab.
  assert.match(harness, /creating or ensuring a tab is a schema change and is owner-reserved/,
    'the harness stopped refusing ensureSheetTab');
});
