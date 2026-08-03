'use strict';

// Gate harness — F-SB4B rehearsal (sandbox-live) posture safety.
// TEMPORARY F-SB4B machinery's permanent-while-it-exists safety net (sunset: F-SB4C,
// together with the posture it guards). Adapted from the proven Stage A suite
// (test/gateHarnessSandboxPosture.test.js, sunset PR #1234).
//
// These assert the HARNESS refuses to serve a browser an unverified or unsafe workbook,
// and that the default posture is untouched. Offline by construction: the only
// credentials used are deliberately malformed, so no Google client can authenticate and
// no write is reachable from any case here. No case requires a real credential.
//
// The load-bearing case is `an explicitly supplied production workbook id is NOT
// inherited`. It works because the preflight runs its offline checks (config resolution,
// declared-sandbox comparison, isSandboxSheet, production fingerprint) BEFORE the first
// network call. So if the harness had inherited the supplied id, it would fail at
// `resolved_workbook_is_declared_sandbox`. It instead reaches the reachability check,
// which is only possible if the assignment won.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const { SANDBOX_SPREADSHEET_ID, SANDBOX_SPREADSHEET_ID_LAST6, isSandboxSpreadsheetId } = require('../config/sandboxSheet');

const GATE_SERVER = path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'gate-server.js');
const gateSrc = fs.readFileSync(GATE_SERVER, 'utf8');

// A private key with no usable PEM body: googleapis fails locally when it tries to sign,
// so these cases do not depend on reaching Google.
const FAKE_CREDS = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'stub@example.com',
  GOOGLE_PRIVATE_KEY: 'not-a-real-key',
};
// The combined flags are THE rehearsal posture.
const REHEARSAL_FLAGS = { ATLAS_GATE_SANDBOX_LIVE: '1', ATLAS_GATE_LEDGER_SANDBOX: '1' };

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
      if (/GATE_PORT=\d+/.test(stdout)) { clearTimeout(timer); done({ code: 0, stdout, stderr, served: true }); }
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('exit', (code) => { clearTimeout(timer); done({ code, stdout, stderr, served: /GATE_PORT=\d+/.test(stdout) }); });
  });
}

const served = (r) => /GATE_PORT=\d+/.test(r.stdout);

// ── the declared sandbox constant ──────────────────────────────────────────────

test('the sandbox workbook id is declared exactly once and both consumers agree', () => {
  const sheets = require('../sheets');
  assert.ok(isSandboxSpreadsheetId(SANDBOX_SPREADSHEET_ID));
  assert.strictEqual(isSandboxSpreadsheetId('something-else'), false);
  assert.strictEqual(SANDBOX_SPREADSHEET_ID_LAST6, SANDBOX_SPREADSHEET_ID.slice(-6));
  assert.strictEqual(typeof sheets.getSafeSpreadsheetConfig, 'function');
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

// ── exactly ONE live posture: the combined rehearsal ───────────────────────────

test('standalone sandbox-live (without the ledger posture) refuses to start — the Stage A mode stays sunset', async () => {
  const r = await runHarness({ ATLAS_GATE_SANDBOX_LIVE: '1', ...FAKE_CREDS });
  assert.ok(!served(r));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /requires ATLAS_GATE_LEDGER_SANDBOX=1/);
});

// ── the ambient / supplied workbook id is never inherited ──────────────────────

test('an explicitly supplied production workbook id is NOT inherited by the rehearsal posture', async () => {
  const r = await runHarness({
    ...REHEARSAL_FLAGS,
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

// ── missing credentials / unverifiable workbook fail closed ────────────────────

test('the rehearsal posture without service-account credentials refuses to start', async () => {
  const r = await runHarness({ ...REHEARSAL_FLAGS });
  assert.ok(!served(r));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_POSTURE_ERROR: ATLAS_GATE_SANDBOX_LIVE=1 requires GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY/);
});

test('the rehearsal posture never publishes a port when the workbook cannot be verified', async () => {
  const r = await runHarness({ ...REHEARSAL_FLAGS, ...FAKE_CREDS }, { timeoutMs: 90000 });
  assert.ok(!served(r), 'a port was published without a verified workbook');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_SANDBOX_ERROR/);
  assert.ok(!/GATE_STATE_PORT=/.test(r.stdout), 'nothing may be advertised from an unverified harness');
});

// ── model posture authority (PR #1226) is inherited, not reimplemented ─────────

test('the rehearsal posture inherits model-down default rather than reimplementing it', async () => {
  const r = await runHarness({ ...REHEARSAL_FLAGS, GEMINI_API_KEY: 'fake-key-value', ...FAKE_CREDS }, { timeoutMs: 90000 });
  assert.ok(!served(r));
  assert.ok(!/GATE_POSTURE_ERROR: model-down harness has provider key/.test(r.stderr),
    'model-down should have deleted the provider key before the app loaded');
  assert.match(r.stderr, /GATE_SANDBOX_ERROR/);
});

test('a model-up rehearsal with an unreachable provider refuses to start', async () => {
  const r = await runHarness({
    ...REHEARSAL_FLAGS, ATLAS_GATE_MODEL_UP: '1',
    GEMINI_API_KEY: 'definitely-not-a-valid-key', ...FAKE_CREDS,
  }, { timeoutMs: 60000 });
  assert.ok(!served(r), 'model-up published a port without a reachable provider');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_POSTURE_ERROR: ATLAS_GATE_MODEL_UP=1/);
});

// ── the write guard's shape, pinned at source level ────────────────────────────
// The guard's live behavior needs a real workbook, so its boundary is pinned on the
// source: what it refuses unconditionally, what it allows only under the combined
// posture, and that the allowlist widens ONLY under REHEARSAL_LIVE.

test('the guard refuses schema changes and deletions unconditionally', () => {
  const guard = gateSrc.slice(gateSrc.indexOf('function buildGuardedSheets('), gateSrc.indexOf('// ── The Sheets adapter the app will see'));
  assert.match(guard, /ensureSheetTab: async \(tabName\) => \{[\s\S]*?refuse\('ensureSheetTab', tabName, 'creating or ensuring a tab is a schema change and is owner-reserved'\)/,
    'ensureSheetTab must always refuse — tab creation is owner-reserved');
  assert.match(guard, /deleteRowsByRange: async \(\.\.\.args\) => \{[\s\S]*?refuse\('deleteRowsByRange'/,
    'deleteRowsByRange must always refuse — the rehearsal never deletes sandbox data');
  assert.match(guard, /assertSandboxNow\('appendRows', tabName\)/, 'every append re-checks the sandbox at call time');
  assert.match(guard, /assertSandboxNow\('updateColumnCells', tabName\)/, 'every cell update re-checks the sandbox at call time');
});

test('the seal column is the ONLY writable cell class, and only under the combined posture', () => {
  assert.match(gateSrc, /REHEARSAL_LIVE && tabName === 'Session_Plan_Sets' && columnLetter === SEAL_COL_LETTER/,
    'updateColumnCells must be limited to the Session_Plan_Sets seal column under REHEARSAL_LIVE');
});

test('the append allowlist widens to the plan-ledger tabs ONLY under the combined posture', () => {
  assert.match(gateSrc, /const WRITABLE_TABS = new Set\(REHEARSAL_LIVE\s*\?\s*\['Log_Cleaned', 'Effort', 'Session_Plans', 'Session_Plan_Sets'\]\s*:\s*\['Log_Cleaned', 'Effort'\]\)/,
    'the four-tab write set must be conditional on REHEARSAL_LIVE');
});

test('the preflight requires the owner-created ledger tabs with EXACT contract headers', () => {
  assert.match(gateSrc, /\['Session_Plans', sessionPlansColumns\], \['Session_Plan_Sets', sessionPlanSetsColumns\]/,
    'both plan-ledger tabs are header-checked in the preflight');
  assert.match(gateSrc, /header_exact_\$\{tab\}/, 'plan-ledger headers are compared exactly, mirroring the capture layers');
  assert.match(gateSrc, /ledger_write_flags_on/, 'the combined posture records the write flags as posture facts');
  assert.match(gateSrc, /telemetry_persistence_off/, 'telemetry persistence must stay off in the live posture');
});

test('the durable verifier answers only for one explicit session identity (isolation rule 5)', () => {
  const verifier = gateSrc.slice(gateSrc.indexOf("startsWith('/durable-rows')"), gateSrc.indexOf('sandbox_last6: SANDBOX_SPREADSHEET_ID_LAST6'));
  assert.match(verifier, /session_id is required — the verifier answers only for one session identity/,
    'a session-less read must be refused, never a whole-workbook dump');
  assert.match(verifier, /String\(r\[idx\] \|\| ''\)\.trim\(\) === wantSession/,
    'the span is re-filtered by the requested session id');
  // Codex P2 (PR #1251): the verifier may answer ONLY for an identity this process
  // durably wrote — a prior rehearsal's id, the owner's setup rows, or a guessed
  // date-pattern id must be refused, so the endpoint cannot browse the workbook.
  assert.match(verifier, /the verifier answers only for a session identity this process durably wrote/,
    'an identity this process did not write must be refused (403)');
  assert.match(verifier, /c\.live === true/, 'the write record consulted is the LIVE append log');
});

test('both harness servers bind to loopback and the default lane scrubs the live flag (Codex P1/P2)', () => {
  assert.match(gateSrc, /app\.listen\(0, '127\.0\.0\.1'/, 'the app server must bind loopback only');
  assert.match(gateSrc, /stateServer\.listen\(0, '127\.0\.0\.1'/, 'the state server must bind loopback only');
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'playwright.config.js'), 'utf8');
  assert.match(cfg, /delete process\.env\.ATLAS_GATE_SANDBOX_LIVE;/,
    'playwright.config.js must scrub the live flag before any spec worker exists — an exported flag in the invoking shell must be inert for the whole default lane');
});
