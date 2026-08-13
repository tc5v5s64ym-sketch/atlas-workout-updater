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

test('the standalone sandbox-live flag refuses loudly — it can never quietly serve a live workbook', async () => {
  // The Stage A STANDALONE live posture stays sunset. Under the recorded F-SB4B
  // resolution (docs/ATLAS_V1_EXECUTION_PLAN.md, 2026-08-03) the ONLY live posture is
  // the combined rehearsal one, TEMPORARY and named for F-SB4C removal — and a lone
  // ATLAS_GATE_SANDBOX_LIVE=1 now refuses with an explicit error rather than serving
  // anything at all. Refusing loudly is strictly safer than the old silent-ignore: a
  // misconfigured operator learns immediately instead of running a stub believing it
  // is live. The combined posture's own safety net is
  // test/gateHarnessRehearsalPosture.test.js (removed together with the posture at
  // F-SB4C, at which point this case reverts to the sunset shape).
  const r = await runHarness({ ATLAS_GATE_KEY: 'k', ATLAS_GATE_SANDBOX_LIVE: '1', ...FAKE_CREDS });
  assert.ok(!served(r), 'a standalone sandbox-live flag must never serve');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /requires ATLAS_GATE_LEDGER_SANDBOX=1/);
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

test('no spec in the e2e lane is gated behind a credentialed posture flag', () => {
  // The one spec that needed excluding here was the temporary Stage-A runner, removed with
  // its posture. `testIgnore` is therefore gone, and the lane collects everything — which is
  // only safe because nothing in the default lane can reach a credential or a workbook.
  // Under the recorded F-SB4B authorization the config may reference the live flag for
  // exactly ONE purpose: DELETING it before any spec worker exists, so an exported flag in
  // the invoking shell is inert for the whole lane (Codex P1, PR #1251). Any other use of
  // the flag in the config — gating collection, enabling a posture — still fails here.
  const fs = require('node:fs');
  const configText = fs.readFileSync(path.join(__dirname, '..', 'playwright.config.js'), 'utf8');
  assert.ok(!/testIgnore/.test(configText),
    'playwright.config.js reintroduced testIgnore — a spec is being excluded from the default lane');
  const flagUses = configText.match(/ATLAS_GATE_SANDBOX_LIVE/g) || [];
  assert.strictEqual(flagUses.length, 1, 'the config may mention the live flag exactly once — the scrub');
  assert.match(configText, /delete process\.env\.ATLAS_GATE_SANDBOX_LIVE;/,
    'the single permitted mention must be the scrub that deletes it');

  const specDir = path.join(__dirname, '..', 'tests', 'e2e');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.spec.js') ? [full] : []);
  });
  const offenders = walk(specDir).filter((f) => /ATLAS_GATE_SANDBOX_LIVE/.test(fs.readFileSync(f, 'utf8')));

  // Under the recorded F-SB4B authorization exactly ONE spec may set the live flag:
  // the rehearsal spec, which the plan names individually for F-SB4C removal. Even for
  // that one file the mention is legal only in the safe form: (a) the plan currently
  // records the authorization and sunset, (b) the flag is set ONLY together with the
  // ledger flag (the combined posture — a standalone live server refuses to boot), and
  // (c) the spec self-skips out of the default lane, so a plain `playwright test` run
  // never reaches the flag. Any other spec, or the rehearsal spec without those
  // properties, still fails here. When F-SB4C removes the spec, `permitted` empties
  // and this reverts to the plain no-offenders pin.
  const REHEARSAL_SPEC = path.join(specDir, 'gate', 'rehearsal.spec.js');
  const permitted = offenders.filter((f) => f === REHEARSAL_SPEC);
  assert.deepStrictEqual(offenders.filter((f) => f !== REHEARSAL_SPEC), [],
    'a spec references the retired sandbox-live posture, so it may expect a real workbook');
  for (const f of permitted) {
    const spec = fs.readFileSync(f, 'utf8');
    const plan = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ATLAS_V1_EXECUTION_PLAN.md'), 'utf8');
    assert.ok(/F-SB4B — BLOCKER RESOLVED 2026-08-03/.test(plan) && /named individually for F-SB4C removal/.test(plan),
      'the rehearsal spec sets the live flag but the plan does not record the F-SB4B authorization');
    assert.ok(/sunset: F-SB4C/.test(spec),
      'the rehearsal spec must carry its F-SB4C sunset marker');
    assert.match(spec, /ATLAS_GATE_SANDBOX_LIVE: '1',\r?\n\s*ATLAS_GATE_LEDGER_SANDBOX: '1',/,
      'the rehearsal spec may set the live flag only together with the ledger flag (the combined posture)');
    assert.match(spec, /test\.skip\(process\.env\.ATLAS_REHEARSAL_RUN !== '1'/,
      'the rehearsal spec must self-skip out of the default lane');
  }
});

// ── the temporary Stage-A machinery is gone and stays gone ─────────────────────

test('the retired Stage-A operator commands and runner are absent', () => {
  // The Stage A sunset is recorded in docs/ATLAS_V1_EXECUTION_PLAN.md. This is the
  // mechanical half: none of the Stage-A-specific machinery may reappear.
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
});

test('the F-SB4B live-workbook tokens exist ONLY while the plan records their authorization and sunset', () => {
  // The live-workbook path is back in gate-server.js — TEMPORARILY, in rehearsal form,
  // under the owner resolution recorded in the execution plan (F-SB4B, 2026-08-03),
  // which names every piece for F-SB4C removal. This case fails in BOTH dishonest
  // directions: if the tokens exist while the plan does not carry the authorization,
  // the restoration is unauthorized; and when F-SB4C removes the machinery, this case
  // is removed with it and the `gone` list above grows the rehearsal files.
  const fs = require('node:fs');
  const root = path.join(__dirname, '..');
  const harness = fs.readFileSync(path.join(root, 'tests/e2e/gate/gate-server.js'), 'utf8');
  const plan = fs.readFileSync(path.join(root, 'docs/ATLAS_V1_EXECUTION_PLAN.md'), 'utf8');
  for (const token of ['ATLAS_GATE_SANDBOX_LIVE', 'buildGuardedSheets', 'assertSandboxLive', 'durable-rows']) {
    assert.ok(harness.includes(token), `expected the temporary F-SB4B token "${token}" in gate-server.js`);
  }
  assert.ok(/F-SB4B — BLOCKER RESOLVED 2026-08-03/.test(plan),
    'gate-server.js carries the live-workbook posture but the plan does not record its authorization');
  assert.ok(/named individually for F-SB4C removal/.test(plan),
    'the recorded authorization must pin the F-SB4C sunset for the restored pieces');
  // The temporary pieces stay marked in the source, so the F-SB4C sweep can find them
  // mechanically and a reviewer can see the boundary without the plan open.
  for (const marker of ['TEMPORARY F-SB4B', 'sunset: F-SB4C']) {
    assert.ok(harness.includes(marker), `gate-server.js is missing the "${marker}" marker on the restored machinery`);
  }
});
