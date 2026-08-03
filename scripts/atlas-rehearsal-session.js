'use strict';

// ── The ONE F-SB4B qualifying rehearsal-session command (TEMPORARY; sunset: F-SB4C) ──
//
//   npm run atlas:rehearsal-session -- --session=1 --model-up
//
// Adapted from the proven Stage A command (atlas-stage-a-session.js, sunset PR #1234)
// under the owner resolution recorded in docs/ATLAS_V1_EXECUTION_PLAN.md (F-SB4B,
// 2026-08-03). It implements NO runner, NO scenario, NO scorecard, and NO second
// environment authority: it preflights, constructs the child environment field by
// field, and invokes the ONE Playwright rehearsal spec on the ONE gate harness.
//
// Model-up only. --model-down is refused outright rather than downgraded: a
// deterministic-fallback session proves the machine path but not the product the owner
// is about to trust with real workouts.
//
// SESSION-START BOUNDARY (counting rule, governing): a rehearsal session BEGINS when,
// after all startup and safety preflight passes, the real browser submits the first
// synthetic athlete turn. Everything this script refuses happens strictly before that
// point, so a refusal here is NOT STARTED — never a failed session, never a reset.
//
// IDENTITY ISOLATION (recorded rules 2–5): this command mints the RUN and ATHLETE
// correlation identities only. It NEVER mints or passes a workout session id — the
// accepted-plan product path obtains that from the server allocator (PR #1246), the
// spec captures the returned identity, and every durable assertion goes through the
// gate harness's session-filtered /durable-rows verifier (which 403s any identity this
// process did not write).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.join(__dirname, '..');

// The credentials and provider key live in the repo's .env (docs/AGENT_LIVE_TESTING.md),
// exactly as index.js loads them. Loaded here so the preflight sees the real facts; the
// child still receives ONLY the field-by-field allowlist below — the ambient
// GOOGLE_SHEETS_ID that dotenv also loads is never copied in, and the preflight
// re-verifies that mechanically (childCarriesWorkbookId).
require('dotenv').config({ path: path.join(REPO_ROOT, '.env') });

const { SANDBOX_SPREADSHEET_ID_LAST6, isSandboxSpreadsheetId, SANDBOX_SPREADSHEET_ID } = require('../config/sandboxSheet');
const { pickNetworkPassthrough, assertNoWorkbookId } = require('../tests/e2e/gate/rehearsal-child-env');
const {
  REHEARSAL_SESSION, REHEARSAL_STREAK_LENGTH,
  mintIdentities, evaluateRehearsalPreflight,
} = require('../tests/e2e/gate/rehearsal-run-purpose');
const { fetchOriginMain, measureSourceTree } = require('../tests/e2e/gate/rehearsal-source-facts');
const { readRunStart, classifyIncompleteRun } = require('../tests/e2e/gate/rehearsal-run-start');

function fail(message) {
  console.error(`[rehearsal-session] ${message}`);
  process.exit(2);
}

// Exit 2 with the full refusal list. NOT STARTED, by the session-start boundary above.
function refuse(refusals) {
  console.error('\n[rehearsal-session] NOT STARTED — the qualifying preflight refused this run.');
  console.error('[rehearsal-session] No browser opened, no turn was submitted, the rehearsal streak is unchanged.\n');
  for (const r of refusals) console.error(`  ✗ ${r}`);
  console.error('');
  process.exit(2);
}

// ── arguments — explicit, no defaults ──────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--model-down')) {
  fail('rehearsal sessions are model-up only; a model-down run can never count and is refused rather than downgraded.');
}
if (!argv.includes('--model-up')) {
  fail('name the posture explicitly: --model-up (there is no default, and the rehearsal accepts no other posture).');
}
const MODE = 'model-up';

const sessionArg = argv.find((a) => a.startsWith('--session='));
if (!sessionArg) {
  fail(`--session=<n> is required and has no default (n is 1..${REHEARSAL_STREAK_LENGTH}).`);
}
const sessionRaw = sessionArg.slice('--session='.length).trim();
// Parsed strictly: "1.5", "01x", and "" must not become 1.
const SESSION_NUMBER = /^[0-9]+$/.test(sessionRaw) ? Number(sessionRaw) : NaN;

// ── measure the world (this script MEASURES; the pure rules DECIDE) ────────────
const originRefreshed = fetchOriginMain(REPO_ROOT);
const source = measureSourceTree(REPO_ROOT);
const gitFacts = {
  branch: source.branch,
  head: source.head_sha,
  originHead: source.origin_head_sha,
  clean: source.clean,
};

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const nonce = crypto.randomBytes(3).toString('hex').toUpperCase();

let identities;
try {
  identities = mintIdentities({ sessionNumber: SESSION_NUMBER, stamp, nonce });
} catch (e) {
  fail(e.message);
}
const { run_id: RUN_ID, athlete_id: ATHLETE_ID } = identities;

// Rehearsal artifacts live in their OWN ignored directory, outside `test-results/`
// (which Playwright wipes at the start of every run). Evidence a later run can delete
// is not preserved evidence.
const ARTIFACT_DIR = path.join(REPO_ROOT, 'rehearsal-artifacts', `session-${SESSION_NUMBER}-${stamp}-${nonce}`);

// ── the child environment, constructed field by field ──────────────────────────
// `...process.env` is deliberately absent: the ambient GOOGLE_SHEETS_ID must never
// reach a write-enabled server, and playwright.config.js scrubs the live flag from
// inherited environments — so the flag below is EXPLICIT, exactly as the recorded
// design requires (the runner never relies on inheritance).
const childEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: 'test',
  CI: process.env.CI,
  ...pickNetworkPassthrough(),
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD,
  ATLAS_REHEARSAL_RUN: '1',
  ATLAS_RUN_PURPOSE: REHEARSAL_SESSION,
  ATLAS_REHEARSAL_SESSION_NUMBER: String(SESSION_NUMBER),
  ATLAS_REHEARSAL_RUN_ID: RUN_ID,
  ATLAS_REHEARSAL_ATHLETE_ID: ATHLETE_ID,
  ATLAS_REHEARSAL_ARTIFACT_DIR: ARTIFACT_DIR,
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};
if (process.env.GEMINI_COACH_MODEL) childEnv.GEMINI_COACH_MODEL = process.env.GEMINI_COACH_MODEL;
for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];

let childCarriesWorkbookId = false;
try { assertNoWorkbookId(childEnv); } catch { childCarriesWorkbookId = true; }
// Isolation rule 3, enforced mechanically: no name resembling a workout session id may
// cross into the child. The spec captures the SERVER-allocated identity itself.
const childCarriesWorkoutSessionId = Object.keys(childEnv)
  .some((k) => /SESSION_ID|WORKOUT_SESSION/i.test(k));

// ── decide ─────────────────────────────────────────────────────────────────────
const preflight = evaluateRehearsalPreflight({
  purpose: REHEARSAL_SESSION,
  sessionNumber: SESSION_NUMBER,
  mode: MODE,
  runId: RUN_ID,
  git: gitFacts,
  originRefreshed,
  priorRehearsalCount: source.prior_rehearsal_count,
  priorCountReason: source.prior_count_reason,
  env: {
    childCarriesWorkbookId,
    childCarriesWorkoutSessionId,
    rehearsalPostureDeclared: childEnv.ATLAS_REHEARSAL_RUN === '1',
    declaredWorkbookIsSandbox: isSandboxSpreadsheetId(SANDBOX_SPREADSHEET_ID),
    nodeEnvProduction: childEnv.NODE_ENV === 'production',
    hasServiceAccountEmail: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
    hasPrivateKey: Boolean(process.env.GOOGLE_PRIVATE_KEY),
    hasProviderKey: Boolean(process.env.GEMINI_API_KEY),
  },
});
if (!preflight.ok) refuse(preflight.refusals);

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const ambientLast6 = process.env.GOOGLE_SHEETS_ID ? String(process.env.GOOGLE_SHEETS_ID).slice(-6) : null;
console.log(`[rehearsal-session] purpose  : ${REHEARSAL_SESSION} — session ${SESSION_NUMBER} of ${REHEARSAL_STREAK_LENGTH}`);
console.log(`[rehearsal-session] prior    : canonical rehearsal count ${source.prior_rehearsal_count}/${REHEARSAL_STREAK_LENGTH} (from the execution plan)`);
console.log(`[rehearsal-session] source   : ${gitFacts.branch} @ ${gitFacts.head.slice(0, 12)} (clean, = origin/main)`);
console.log(`[rehearsal-session] run      : ${RUN_ID}`);
console.log(`[rehearsal-session] posture  : ${MODE} + combined sandbox-live/ledger (set by the spec's own gate-server spawn)`);
console.log(`[rehearsal-session] athlete  : ${ATHLETE_ID}`);
console.log('[rehearsal-session] workout  : NO pre-seeded id — the server allocator mints it at acceptance (isolation rule 3)');
console.log(`[rehearsal-session] workbook : declared sandbox last6 ${SANDBOX_SPREADSHEET_ID_LAST6}`);
console.log(`[rehearsal-session] ambient  : ${ambientLast6 ? `GOOGLE_SHEETS_ID last6 ${ambientLast6} present and NOT passed to the child` : 'no ambient GOOGLE_SHEETS_ID'}`);
console.log(`[rehearsal-session] artifacts: ${path.relative(process.cwd(), ARTIFACT_DIR)}`);
console.log('[rehearsal-session] the session begins when the browser submits the first synthetic athlete turn.\n');

const runner = spawn(
  process.execPath,
  [path.join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js'),
    'test', 'tests/e2e/gate/rehearsal.spec.js', '--project=chromium', '--workers=1'],
  { env: childEnv, stdio: 'inherit', cwd: REPO_ROOT },
);

runner.on('exit', (code) => {
  const scorecardPath = path.join(ARTIFACT_DIR, 'scorecard.json');
  if (!fs.existsSync(scorecardPath)) {
    // No scorecard does not say WHICH side of the session-start boundary the run died
    // on, and the two outcomes have opposite streak consequences — read the recorded
    // crossing rather than inferring.
    const classification = classifyIncompleteRun(readRunStart(ARTIFACT_DIR));
    console.error('\n[rehearsal-session] NO SCORECARD — the run did not reach scoring.');
    console.error(`[rehearsal-session] ${classification.verdict}: ${classification.detail}`);
    console.error(`[rehearsal-session] evidence preserved at ${path.relative(process.cwd(), ARTIFACT_DIR)}`);
    process.exit(1);
  }
  const card = JSON.parse(fs.readFileSync(scorecardPath, 'utf8'));
  console.log(`\n[rehearsal-session] OVERALL: ${card.overall}  (PASS ${card.counts.PASS} · FAIL ${card.counts.FAIL} · ERROR ${card.counts.ERROR} · N/A ${card.counts.NOT_APPLICABLE})`);
  for (const c of card.conditions) {
    if (c.status !== 'PASS') console.log(`  ${c.status.padEnd(14)} ${c.id} — ${c.detail}`);
  }
  console.log(`[rehearsal-session] rehearsal_eligible: ${card.rehearsal_eligible}`);
  console.log(`[rehearsal-session] ${card.rehearsal_note}`);
  if (card.rehearsal_eligible !== true) {
    console.log('[rehearsal-session] This run does NOT advance the rehearsal streak.');
  }
  process.exit(code === 0 && card.rehearsal_eligible === true ? 0 : 1);
});
