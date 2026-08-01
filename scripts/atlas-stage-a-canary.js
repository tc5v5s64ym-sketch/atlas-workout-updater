'use strict';

// ── The ONE Phase 4 Stage-A canary operator command (temporary Phase 4 machinery) ──
//
//   npm run atlas:stage-a-canary -- --model-down
//   npm run atlas:stage-a-canary -- --model-up
//
// It does not implement a runner. It mints this run's unique synthetic identities,
// constructs the child environment EXPLICITLY, and invokes the existing Playwright gate
// runner on the existing gate harness. There is exactly one browser runner in this
// repository and this is not a second one.
//
// Exactly one mode must be named. There is no default, because a defaulted posture is the
// same unbacked claim PR #1226 removed from the harness: an operator who did not choose
// model-up must never be handed a run that quietly chose for them.
//
// WHY THIS SCRIPT EXISTS AT ALL, rather than an env-var incantation in a runbook: the one
// thing that must never happen is the ambient GOOGLE_SHEETS_ID reaching a write-enabled
// server. Here that is mechanical — the variable is deleted from the child environment and
// its absence is asserted — instead of depending on an operator remembering to unset it.
//
// Sunset: deleted in the same PR that records Stage A at 5/5 (see the execution plan).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { SANDBOX_SPREADSHEET_ID_LAST6 } = require('../config/sandboxSheet');
const { pickNetworkPassthrough, assertNoWorkbookId } = require('../tests/e2e/gate/canary-child-env');

function fail(message) {
  console.error(`[stage-a-canary] ${message}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const wantDown = argv.includes('--model-down');
const wantUp = argv.includes('--model-up');
if (wantDown === wantUp) {
  fail('name exactly one posture: --model-down or --model-up (there is no default).');
}
const MODE = wantUp ? 'model-up' : 'model-down';

// Unique per run: nothing this canary writes can collide with a prior run, another run,
// or owner data. The session id carries CANARY so a durable row is self-identifying in
// the workbook, and the scorecard refuses a session id that does not.
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const nonce = crypto.randomBytes(3).toString('hex').toUpperCase();
const RUN_ID = `canary-${stamp}-${nonce}`;
const SESSION_ID = `CANARY-${stamp}-${nonce}`;
const ATHLETE_ID = `canary-athlete-${nonce}`;
const ARTIFACT_DIR = path.join(__dirname, '..', 'test-results', 'stage-a-canary', `${MODE}-${stamp}-${nonce}`);

// Required credentials, checked here so the failure is a clear operator message rather
// than a child process exiting mid-spawn.
for (const key of ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY']) {
  if (!process.env[key]) fail(`${key} must be exported — the canary needs the sandbox service account.`);
}
if (MODE === 'model-up' && !process.env.GEMINI_API_KEY) {
  fail('--model-up requires GEMINI_API_KEY. The harness proves reachability before publishing a port; it will not degrade to model-down.');
}

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

// The child environment, constructed field by field. `...process.env` is deliberately
// absent — see the header. GOOGLE_SHEETS_ID is not in this object at any value: the
// harness assigns the declared sandbox id itself from config/sandboxSheet.js.
const childEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: 'test',
  CI: process.env.CI,
  // Proxy routing and CA trust only — see tests/e2e/gate/canary-child-env.js.
  ...pickNetworkPassthrough(),
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD,
  ATLAS_GATE_SANDBOX_LIVE: '1',
  ATLAS_CANARY_MODE: MODE,
  ATLAS_CANARY_RUN_ID: RUN_ID,
  ATLAS_CANARY_SESSION_ID: SESSION_ID,
  ATLAS_CANARY_ATHLETE_ID: ATHLETE_ID,
  ATLAS_CANARY_ARTIFACT_DIR: ARTIFACT_DIR,
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
};
if (MODE === 'model-up') {
  childEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (process.env.GEMINI_COACH_MODEL) childEnv.GEMINI_COACH_MODEL = process.env.GEMINI_COACH_MODEL;
}
for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];

// Assertion, not intention: the constructed environment carries no workbook id.
try { assertNoWorkbookId(childEnv); } catch (e) { fail(e.message); }

const ambientLast6 = process.env.GOOGLE_SHEETS_ID ? String(process.env.GOOGLE_SHEETS_ID).slice(-6) : null;
console.log(`[stage-a-canary] run      : ${RUN_ID}`);
console.log(`[stage-a-canary] posture  : ${MODE}`);
console.log(`[stage-a-canary] session  : ${SESSION_ID}`);
console.log(`[stage-a-canary] workbook : declared sandbox last6 ${SANDBOX_SPREADSHEET_ID_LAST6}`);
console.log(`[stage-a-canary] ambient  : ${ambientLast6 ? `GOOGLE_SHEETS_ID last6 ${ambientLast6} present and NOT passed to the child` : 'no ambient GOOGLE_SHEETS_ID'}`);
console.log(`[stage-a-canary] artifacts: ${path.relative(process.cwd(), ARTIFACT_DIR)}`);
if (ambientLast6 && ambientLast6 === SANDBOX_SPREADSHEET_ID_LAST6) {
  console.log('[stage-a-canary] note     : the ambient id happens to match the sandbox; the child still receives none.');
}

const runner = spawn(
  process.execPath,
  [path.join(__dirname, '..', 'node_modules', '@playwright', 'test', 'cli.js'),
    'test', 'tests/e2e/gate/stage-a-canary.spec.js', '--project=chromium', '--workers=1'],
  { env: childEnv, stdio: 'inherit', cwd: path.join(__dirname, '..') },
);

runner.on('exit', (code) => {
  const scorecardPath = path.join(ARTIFACT_DIR, 'scorecard.json');
  if (fs.existsSync(scorecardPath)) {
    const card = JSON.parse(fs.readFileSync(scorecardPath, 'utf8'));
    console.log(`\n[stage-a-canary] OVERALL: ${card.overall}  (PASS ${card.counts.PASS} · FAIL ${card.counts.FAIL} · ERROR ${card.counts.ERROR} · N/A ${card.counts.NOT_APPLICABLE})`);
    for (const c of card.conditions) {
      if (c.status !== 'PASS') console.log(`  ${c.status.padEnd(14)} ${c.id} — ${c.detail}`);
    }
    console.log(`[stage-a-canary] ${card.stage_a_note}`);
  } else {
    console.error('\n[stage-a-canary] no scorecard was produced — the run did not reach scoring (posture refused, or the harness never started).');
  }
  process.exit(code === 0 ? 0 : 1);
});
