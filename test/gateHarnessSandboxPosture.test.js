'use strict';

// Gate harness — sandbox-live posture safety.
//
// These assert the HARNESS refuses to serve a browser an unverified or unsafe workbook,
// and that the default posture is untouched. Offline by construction: the only credentials
// used are deliberately malformed, so no Google client can authenticate and no write is
// reachable from any case here. No case requires a real credential.
//
// The load-bearing case is `an explicitly supplied production workbook id is NOT inherited`.
// It works because the preflight runs its offline checks (config resolution, declared-sandbox
// comparison, isSandboxSheet, production fingerprint) BEFORE the first network call. So if the
// harness had inherited the supplied id, it would fail at `resolved_workbook_is_declared_sandbox`.
// It instead reaches the reachability check, which is only possible if the assignment won.

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

// ── the declared sandbox constant ──────────────────────────────────────────────

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
    // sheets.js captured its id at module load; assert its sandbox predicate agrees with
    // the constant rather than a second copy.
    assert.strictEqual(typeof sheets.getSafeSpreadsheetConfig, 'function');
  } finally {
    if (prev === undefined) delete process.env.GOOGLE_SHEETS_ID; else process.env.GOOGLE_SHEETS_ID = prev;
  }
  const simHarness = require('../scripts/sim/harness');
  assert.strictEqual(simHarness.SANDBOX_SHEET_ID, SANDBOX_SPREADSHEET_ID,
    'the simulation harness resolved a different sandbox id than config/sandboxSheet.js');
});

// ── default posture is untouched ───────────────────────────────────────────────

test('the DEFAULT posture still serves the in-memory stub and never a real workbook', async () => {
  const r = await runHarness({ ATLAS_GATE_KEY: 'k' });
  assert.ok(served(r), `the default harness failed to start: ${r.stderr.slice(-600)}`);
  assert.match(r.stdout, /GATE_SHEETS_POSTURE=in-memory-stub/);
  assert.match(r.stdout, /GATE_MODEL_POSTURE=model-down/);
  assert.ok(!/sandbox-live/.test(r.stdout), 'the default harness advertised sandbox-live');
});

test('the default posture is unchanged even when a real-looking workbook id is exported', async () => {
  const r = await runHarness({ ATLAS_GATE_KEY: 'k', GOOGLE_SHEETS_ID: 'a-production-workbook-id', ...FAKE_CREDS });
  assert.ok(served(r), `the default harness failed to start: ${r.stderr.slice(-600)}`);
  assert.match(r.stdout, /GATE_SHEETS_POSTURE=in-memory-stub/);
});

// ── 1 & 2: the ambient / supplied workbook id is never inherited ───────────────

test('an explicitly supplied production workbook id is NOT inherited by sandbox-live', async () => {
  const r = await runHarness({
    ATLAS_GATE_SANDBOX_LIVE: '1',
    GOOGLE_SHEETS_ID: 'a-production-workbook-id-that-must-never-be-used',
    ...FAKE_CREDS,
  });
  assert.ok(!served(r), 'the harness published a port with unusable credentials');
  // The decisive assertion: it did NOT fail on the declared-sandbox comparison, which means
  // the assignment replaced the supplied id before sheets.js captured it.
  assert.ok(!/resolved_workbook_is_declared_sandbox/.test(r.stderr),
    `the harness inherited the supplied workbook id: ${r.stderr.slice(-800)}`);
  assert.ok(!/is_sandbox_sheet_true/.test(r.stderr),
    `the harness resolved a non-sandbox workbook: ${r.stderr.slice(-800)}`);
  // It failed later, at reachability — the only check unusable credentials can reach.
  assert.match(r.stderr, /GATE_SANDBOX_ERROR: sandbox_reachable/);
});

test('an ambient-looking workbook id is likewise not inherited', async () => {
  const r = await runHarness({
    ATLAS_GATE_SANDBOX_LIVE: '1',
    GOOGLE_SHEETS_ID: '1AmbientWorkbookIdFromTheOperatorShellDuDcA0',
    ...FAKE_CREDS,
  });
  assert.ok(!served(r));
  assert.ok(!/resolved_workbook_is_declared_sandbox/.test(r.stderr),
    `the harness inherited the ambient workbook id: ${r.stderr.slice(-800)}`);
});

// ── 3: missing credentials / missing configuration fail closed ─────────────────

test('sandbox-live without service-account credentials refuses to start', async () => {
  const r = await runHarness({ ATLAS_GATE_SANDBOX_LIVE: '1' });
  assert.ok(!served(r));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_POSTURE_ERROR: ATLAS_GATE_SANDBOX_LIVE=1 requires GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY/);
});

test('sandbox-live with a half-supplied credential refuses to start', async () => {
  const r = await runHarness({
    ATLAS_GATE_SANDBOX_LIVE: '1',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'stub@example.com',
  });
  assert.ok(!served(r));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_POSTURE_ERROR/);
});

// ── 4 & 5: an unverifiable workbook never publishes a port ─────────────────────

test('sandbox-live never publishes a port when the workbook cannot be verified', async () => {
  const r = await runHarness({ ATLAS_GATE_SANDBOX_LIVE: '1', ...FAKE_CREDS });
  assert.ok(!served(r), 'a port was published without a verified workbook');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_SANDBOX_ERROR/);
  // Fail-closed: nothing is advertised, so no spec can attach to an unverified harness.
  assert.ok(!/GATE_STATE_PORT=/.test(r.stdout));
});

// ── 6: fake Sheets can never be active while sandbox-live is claimed ───────────

test('sandbox-live refuses the ledger posture, which would require creating a real tab', async () => {
  const r = await runHarness({
    ATLAS_GATE_SANDBOX_LIVE: '1', ATLAS_GATE_LEDGER_SANDBOX: '1', ...FAKE_CREDS,
  });
  assert.ok(!served(r));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /ATLAS_GATE_SANDBOX_LIVE=1 with ATLAS_GATE_LEDGER_SANDBOX=1/);
  assert.match(r.stderr, /owner-reserved schema change/);
});

test('the sandbox-live and stub postures are mutually exclusive in what they advertise', async () => {
  // The default advertises the stub; sandbox-live can only ever advertise sandbox-live,
  // and it cannot reach that line without a verified workbook (proven above).
  const def = await runHarness({ ATLAS_GATE_KEY: 'k' });
  assert.match(def.stdout, /GATE_SHEETS_POSTURE=in-memory-stub/);
  assert.ok(!/GATE_SHEETS_POSTURE=sandbox-live/.test(def.stdout));
});

// ── 7 & 8: model posture, unchanged authority from PR #1226 ────────────────────

test('sandbox-live inherits PR #1226 model-down default rather than reimplementing it', async () => {
  // With unusable credentials the run stops at the sandbox check — but the MODEL posture is
  // asserted first, so reaching a sandbox error proves model-down already passed.
  const r = await runHarness({ ATLAS_GATE_SANDBOX_LIVE: '1', GEMINI_API_KEY: 'fake-key-value', ...FAKE_CREDS });
  assert.ok(!served(r));
  assert.ok(!/GATE_POSTURE_ERROR: model-down harness has provider key/.test(r.stderr),
    'model-down should have deleted the provider key before the app loaded');
  assert.match(r.stderr, /GATE_SANDBOX_ERROR/);
});

test('a model-up run with an unreachable provider refuses to start, sandbox-live or not', async () => {
  const r = await runHarness({
    ATLAS_GATE_SANDBOX_LIVE: '1', ATLAS_GATE_MODEL_UP: '1',
    GEMINI_API_KEY: 'definitely-not-a-valid-key', ...FAKE_CREDS,
  }, { timeoutMs: 60000 });
  assert.ok(!served(r), 'model-up published a port without a reachable provider');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_POSTURE_ERROR: ATLAS_GATE_MODEL_UP=1/);
});

test('a model-up run with no provider key at all fails closed', async () => {
  const r = await runHarness({ ATLAS_GATE_SANDBOX_LIVE: '1', ATLAS_GATE_MODEL_UP: '1', ...FAKE_CREDS });
  assert.ok(!served(r));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_POSTURE_ERROR: ATLAS_GATE_MODEL_UP=1/);
});

test('a scripted coach can never be served as a sandbox-live model-up run', async () => {
  const r = await runHarness({
    ATLAS_GATE_SANDBOX_LIVE: '1', ATLAS_GATE_MODEL_UP: '1', ATLAS_GATE_COACH_SCRIPT: '1',
    GEMINI_API_KEY: 'fake', ...FAKE_CREDS,
  });
  assert.ok(!served(r));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /a scripted coach calls no provider/);
});

// ── the canary spec is not collected by the default lane ───────────────────────

test('the Stage-A canary spec is excluded from the default credential-free Playwright lane', () => {
  const prev = process.env.ATLAS_GATE_SANDBOX_LIVE;
  try {
    delete process.env.ATLAS_GATE_SANDBOX_LIVE;
    delete require.cache[require.resolve('../playwright.config.js')];
    const off = require('../playwright.config.js');
    assert.deepStrictEqual(off.testIgnore, ['**/stage-a-canary.spec.js'],
      'the default lane would collect the credentialed canary spec');

    process.env.ATLAS_GATE_SANDBOX_LIVE = '1';
    delete require.cache[require.resolve('../playwright.config.js')];
    const on = require('../playwright.config.js');
    assert.deepStrictEqual(on.testIgnore, []);
  } finally {
    delete require.cache[require.resolve('../playwright.config.js')];
    if (prev === undefined) delete process.env.ATLAS_GATE_SANDBOX_LIVE;
    else process.env.ATLAS_GATE_SANDBOX_LIVE = prev;
  }
});

test('the operator command refuses an unnamed or doubled posture', () => {
  const { execFileSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'scripts', 'atlas-stage-a-canary.js');
  const run = (args) => {
    try {
      execFileSync(process.execPath, [script, ...args], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stderr: '' };
    } catch (e) {
      return { code: e.status, stderr: String(e.stderr || '') };
    }
  };
  const none = run([]);
  assert.strictEqual(none.code, 2);
  assert.match(none.stderr, /name exactly one posture/);
  const both = run(['--model-down', '--model-up']);
  assert.strictEqual(both.code, 2);
  assert.match(both.stderr, /name exactly one posture/);
  // And a named posture still refuses without the sandbox service account.
  const noCreds = run(['--model-down']);
  assert.strictEqual(noCreds.code, 2);
  assert.match(noCreds.stderr, /GOOGLE_SERVICE_ACCOUNT_EMAIL must be exported/);
});
