'use strict';

// ── The ONE Phase 4 qualifying Stage-A session command (temporary Phase 4 machinery) ──
//
//   npm run atlas:stage-a-session -- --session=1 --model-up
//
// It implements NO runner, NO scenario, NO scorecard, and NO second environment authority.
// It is the sibling of `scripts/atlas-stage-a-canary.js` and invokes the SAME Playwright
// spec on the SAME gate harness with the SAME sandbox posture. There is exactly one browser
// runner in this repository and this is not a second one.
//
// WHAT IT ADDS, and why that is the whole of it: the canary is readiness proof and can never
// advance the Stage A streak (`stage_a_eligible` is always false on a CANARY run). A run that
// MAY count needs one extra thing — a mechanical distinction between "we proved the machine
// works" and "this was session N of the owner's five", plus the preconditions that make the
// second claim honest. That distinction is `ATLAS_RUN_PURPOSE`, and the preconditions are
// enforced here, before the browser opens, by the shared pure rules in
// `tests/e2e/gate/stage-a-run-purpose.js` — the same rules the scorecard re-checks afterwards.
//
// Model-up only. A deterministic-fallback session proves the machine path but not the product
// the owner is about to spend five real workouts on, so `--model-down` is refused outright
// rather than downgraded.
//
// SESSION-START BOUNDARY (owner ruling, governing). A Stage A session BEGINS when, after all
// startup and safety preflight passes, the real browser submits the first synthetic athlete
// turn. Everything this script refuses happens strictly before that point, so a refusal here
// is NOT STARTED — it is never a failed session and never resets the streak.
//
// Sunset: deleted, together with `ATLAS_RUN_PURPOSE` and the rest of the temporary Stage-A
// machinery, in the same PR that records Stage A at 5/5 (see docs/ATLAS_V1_EXECUTION_PLAN.md).

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.join(__dirname, '..');

const { SANDBOX_SPREADSHEET_ID_LAST6, isSandboxSpreadsheetId, SANDBOX_SPREADSHEET_ID } = require('../config/sandboxSheet');
const { pickNetworkPassthrough, assertNoWorkbookId } = require('../tests/e2e/gate/canary-child-env');
const {
  STAGE_A_SESSION, STAGE_A_STREAK_LENGTH,
  mintIdentities, parseCanonicalStageACount, evaluateStageAPreflight,
} = require('../tests/e2e/gate/stage-a-run-purpose');

const PLAN_PATH = path.join(REPO_ROOT, 'docs', 'ATLAS_V1_EXECUTION_PLAN.md');

function fail(message) {
  console.error(`[stage-a-session] ${message}`);
  process.exit(2);
}

// Exit 2 with the full refusal list. NOT STARTED, by the session-start boundary above.
function refuse(refusals) {
  console.error('\n[stage-a-session] NOT STARTED — the qualifying preflight refused this run.');
  console.error('[stage-a-session] No browser opened, no turn was submitted, the Stage A streak is unchanged.\n');
  for (const r of refusals) console.error(`  ✗ ${r}`);
  console.error('');
  process.exit(2);
}

// ── arguments ──────────────────────────────────────────────────────────────────
// Both are explicit and neither has a default. A defaulted session number is the same
// unbacked claim a defaulted posture is: an operator who did not name session 1 must never
// be handed a run that quietly named it for them.
const argv = process.argv.slice(2);
if (argv.includes('--model-down')) {
  fail('Stage A sessions are model-up only. Use `npm run atlas:stage-a-canary -- --model-down` for a model-down readiness probe; a model-down run can never count.');
}
if (!argv.includes('--model-up')) {
  fail('name the posture explicitly: --model-up (there is no default, and Stage A accepts no other posture).');
}
const MODE = 'model-up';

const sessionArg = argv.find((a) => a.startsWith('--session='));
if (!sessionArg) {
  fail(`--session=<n> is required and has no default (n is 1..${STAGE_A_STREAK_LENGTH}).`);
}
const sessionRaw = sessionArg.slice('--session='.length).trim();
// Parsed strictly: "1.5", "01x", and "" must not become 1.
const SESSION_NUMBER = /^[0-9]+$/.test(sessionRaw) ? Number(sessionRaw) : NaN;

// ── measure the world ──────────────────────────────────────────────────────────
// This script MEASURES; `evaluateStageAPreflight` DECIDES. Keeping the two apart is what
// makes the decision unit-testable without a git repository, a network, or credentials.
function git(...args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// Fetch origin/main first, so "HEAD equals origin/main" is measured against the real remote
// rather than a stale local ref that would make a superseded tree look current.
try {
  execFileSync('git', ['fetch', 'origin', 'main'], { cwd: REPO_ROOT, stdio: 'ignore' });
} catch {
  console.warn('[stage-a-session] warning: could not fetch origin/main; the staleness check will use the local ref.');
}

const gitFacts = {
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  head: git('rev-parse', 'HEAD'),
  originHead: git('rev-parse', 'origin/main'),
  clean: git('status', '--porcelain') === '',
};

let planText = '';
try {
  planText = fs.readFileSync(PLAN_PATH, 'utf8');
} catch {
  planText = '';
}
const canonical = parseCanonicalStageACount(planText);

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const nonce = crypto.randomBytes(3).toString('hex').toUpperCase();

let identities;
try {
  identities = mintIdentities({ purpose: STAGE_A_SESSION, sessionNumber: SESSION_NUMBER, stamp, nonce });
} catch (e) {
  fail(e.message);
}
const { run_id: RUN_ID, session_id: SESSION_ID, athlete_id: ATHLETE_ID } = identities;

// Stage-A artifacts live in their OWN ignored directory, outside `canary-artifacts/` and far
// outside `test-results/` (which Playwright wipes at the start of every run). Count evidence
// that a later canary can delete, or that sits in a directory named for the wrong purpose, is
// not preserved evidence.
const ARTIFACT_DIR = path.join(REPO_ROOT, 'stage-a-artifacts', `session-${SESSION_NUMBER}-${stamp}-${nonce}`);

// ── the child environment, constructed field by field ──────────────────────────
// `...process.env` is deliberately absent, for the reason canary-child-env.js records:
// the ambient GOOGLE_SHEETS_ID must never reach a write-enabled server.
const childEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: 'test',
  CI: process.env.CI,
  ...pickNetworkPassthrough(),
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD,
  ATLAS_GATE_SANDBOX_LIVE: '1',
  // The purpose distinction — the ONE thing that separates count-eligible evidence from
  // readiness proof. The spec records it; the scorecard decides what it permits.
  ATLAS_RUN_PURPOSE: STAGE_A_SESSION,
  ATLAS_STAGE_A_SESSION_NUMBER: String(SESSION_NUMBER),
  // The measured source facts, recorded in the evidence and re-checked by the scorecard, so a
  // published artifact carries the exact tree it came from rather than an unverifiable claim.
  ATLAS_RUN_SOURCE_SHA: gitFacts.head,
  ATLAS_RUN_SOURCE_ORIGIN_SHA: gitFacts.originHead,
  ATLAS_RUN_SOURCE_BRANCH: gitFacts.branch,
  ATLAS_RUN_SOURCE_CLEAN: gitFacts.clean ? '1' : '0',
  ATLAS_STAGE_A_PRIOR_COUNT: canonical.ok ? String(canonical.count) : '',
  // The runner's existing identity transport, shared by both purposes — one runner, one set
  // of names. The VALUES here are Stage-A identities, minted above.
  ATLAS_CANARY_MODE: MODE,
  ATLAS_CANARY_RUN_ID: RUN_ID,
  ATLAS_CANARY_SESSION_ID: SESSION_ID,
  ATLAS_CANARY_ATHLETE_ID: ATHLETE_ID,
  ATLAS_CANARY_ARTIFACT_DIR: ARTIFACT_DIR,
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};
if (process.env.GEMINI_COACH_MODEL) childEnv.GEMINI_COACH_MODEL = process.env.GEMINI_COACH_MODEL;
for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];

let childCarriesWorkbookId = false;
try { assertNoWorkbookId(childEnv); } catch { childCarriesWorkbookId = true; }

// ── decide ─────────────────────────────────────────────────────────────────────
const preflight = evaluateStageAPreflight({
  purpose: STAGE_A_SESSION,
  sessionNumber: SESSION_NUMBER,
  mode: MODE,
  sessionId: SESSION_ID,
  git: gitFacts,
  priorStageACount: canonical.ok ? canonical.count : null,
  priorCountReason: canonical.reason,
  env: {
    childCarriesWorkbookId,
    sandboxLiveDeclared: childEnv.ATLAS_GATE_SANDBOX_LIVE === '1',
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
console.log(`[stage-a-session] purpose  : ${STAGE_A_SESSION} — session ${SESSION_NUMBER} of ${STAGE_A_STREAK_LENGTH}`);
console.log(`[stage-a-session] prior    : canonical Stage A count ${canonical.count}/${STAGE_A_STREAK_LENGTH} (from the execution plan)`);
console.log(`[stage-a-session] source   : ${gitFacts.branch} @ ${gitFacts.head.slice(0, 12)} (clean, = origin/main)`);
console.log(`[stage-a-session] run      : ${RUN_ID}`);
console.log(`[stage-a-session] posture  : ${MODE}`);
console.log(`[stage-a-session] session  : ${SESSION_ID}`);
console.log(`[stage-a-session] athlete  : ${ATHLETE_ID}`);
console.log(`[stage-a-session] workbook : declared sandbox last6 ${SANDBOX_SPREADSHEET_ID_LAST6}`);
console.log(`[stage-a-session] ambient  : ${ambientLast6 ? `GOOGLE_SHEETS_ID last6 ${ambientLast6} present and NOT passed to the child` : 'no ambient GOOGLE_SHEETS_ID'}`);
console.log(`[stage-a-session] artifacts: ${path.relative(process.cwd(), ARTIFACT_DIR)}`);
console.log('[stage-a-session] the session begins when the browser submits the first synthetic athlete turn.\n');

const runner = spawn(
  process.execPath,
  [path.join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js'),
    'test', 'tests/e2e/gate/stage-a-canary.spec.js', '--project=chromium', '--workers=1'],
  { env: childEnv, stdio: 'inherit', cwd: REPO_ROOT },
);

runner.on('exit', (code) => {
  const scorecardPath = path.join(ARTIFACT_DIR, 'scorecard.json');
  if (!fs.existsSync(scorecardPath)) {
    // No scorecard means the run never reached scoring. A green process exit is explicitly
    // NOT sufficient evidence, and neither is a red one sufficient to call a session failed:
    // the operator reads the boundary rule to classify it.
    console.error('\n[stage-a-session] NO SCORECARD — the run did not reach scoring.');
    console.error('[stage-a-session] If no synthetic athlete turn was submitted, this is NOT STARTED and the streak is unchanged.');
    process.exit(1);
  }
  const card = JSON.parse(fs.readFileSync(scorecardPath, 'utf8'));
  console.log(`\n[stage-a-session] OVERALL: ${card.overall}  (PASS ${card.counts.PASS} · FAIL ${card.counts.FAIL} · ERROR ${card.counts.ERROR} · N/A ${card.counts.NOT_APPLICABLE})`);
  for (const c of card.conditions) {
    if (c.status !== 'PASS') console.log(`  ${c.status.padEnd(14)} ${c.id} — ${c.detail}`);
  }
  console.log(`[stage-a-session] stage_a_eligible: ${card.stage_a_eligible}`);
  console.log(`[stage-a-session] ${card.stage_a_note}`);
  if (card.stage_a_eligible !== true) {
    console.log('[stage-a-session] This run does NOT advance the Stage A streak.');
  }
  process.exit(code === 0 && card.stage_a_eligible === true ? 0 : 1);
});
