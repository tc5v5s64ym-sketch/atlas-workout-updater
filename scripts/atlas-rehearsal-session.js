'use strict';

// ── The ONE F-SB4B qualifying rehearsal-session command (TEMPORARY; sunset: F-SB4C) ──
//
//   npm run atlas:rehearsal-session -- --session=1 --model-up
//
//   Persona rehearsals (Slice 2a, persona test rig — issue #1607) ride the same
//   command under their own purpose:
//
//   npm run atlas:rehearsal-session -- --persona=marcus --model-up
//
//   A persona run is structurally NON-COUNTING: it carries no session number,
//   the preflight never consults the canonical count on its behalf, and its
//   artifacts can never publish rehearsal_eligible=true. --persona combined
//   with --qualifying (or --debug) is refused by resolveRunPurpose before
//   anything else happens.
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

const { spawn, spawnSync } = require('node:child_process');
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
  REHEARSAL_SESSION, REHEARSAL_DEBUG, PERSONA_RUN, REHEARSAL_STREAK_LENGTH, REQUIRED_BRANCH,
  mintIdentities, mintPersonaIdentities, resolveRunPurpose, evaluateRehearsalPreflight,
} = require('../tests/e2e/gate/rehearsal-run-purpose');
const { fetchOriginRequiredBranch, measureSourceTree } = require('../tests/e2e/gate/rehearsal-source-facts');
const { measureServedBuild, evaluateBuildIdentity } = require('../tests/e2e/gate/rehearsal-build-identity');
const { readRunStart, classifyIncompleteRun } = require('../tests/e2e/gate/rehearsal-run-start');

function fail(message) {
  console.error(`[rehearsal-session] ${message}`);
  process.exit(2);
}

// Exit 2 with the full refusal list. NOT STARTED, by the session-start boundary above.
function refuse(refusals) {
  console.error(`\n[rehearsal-session] NOT STARTED — ${IS_PERSONA ? 'the persona preflight refused this run' : 'the qualifying preflight refused this run'}.`);
  console.error(IS_PERSONA
    ? '[rehearsal-session] No browser opened, no turn was submitted, and the canonical count was never consulted.\n'
    : '[rehearsal-session] No browser opened, no turn was submitted, the rehearsal streak is unchanged.\n');
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

// ── RUN PURPOSE — explicit, no default (owner instruction 2026-08-03) ──────────
// `--qualifying` may advance the streak and requires the canonical count to equal
// session_number - 1. `--debug` proves the scenarios on exact clean s3-maintenance, is NOT
// ordered against the count, and can never advance or authorize one. `--persona=<slug>`
// (Slice 2a) runs a persona fixture on the same harness under its own purpose: no
// session number, the count never consulted, never eligible. None is the
// default: a run that does not say which it is, is refused, because "which kind of run
// was that?" must never be answered by reading which check happened to go red.
const wantsDebug = argv.includes('--debug');
const wantsQualifying = argv.includes('--qualifying');
const personaArg = argv.find((a) => a.startsWith('--persona='));
const PERSONA_SLUG = personaArg ? personaArg.slice('--persona='.length).trim().toLowerCase() : null;
// The DECISION is pure and unit-tested (resolveRunPurpose in
// rehearsal-run-purpose.js): exactly one purpose per run, and a persona run
// combined with a counting flag is refused there — this script only acts on it.
const resolution = resolveRunPurpose({ wantsQualifying, wantsDebug, personaSlug: PERSONA_SLUG });
if (!resolution.ok) fail(resolution.refusal);
const RUN_PURPOSE = resolution.purpose;
const IS_QUALIFYING = RUN_PURPOSE === REHEARSAL_SESSION;
const IS_PERSONA = RUN_PURPOSE === PERSONA_RUN;

const sessionArg = argv.find((a) => a.startsWith('--session='));
if (IS_PERSONA && sessionArg) {
  fail('--session does not apply to a persona run: a persona run is not a streak member and carries no session number.');
}
if (!IS_PERSONA && !sessionArg) {
  fail(`--session=<n> is required and has no default (n is 1..${REHEARSAL_STREAK_LENGTH}).`);
}
// Parsed strictly: "1.5", "01x", and "" must not become 1. A persona run has no
// session number at all (null, never NaN-as-a-number).
const sessionRaw = !IS_PERSONA && sessionArg ? sessionArg.slice('--session='.length).trim() : '';
const SESSION_NUMBER = IS_PERSONA ? null : (/^[0-9]+$/.test(sessionRaw) ? Number(sessionRaw) : NaN);

// A persona run names a fixture, and the fixture must exist and be well-formed
// before anything else is measured — an unknown persona is a NOT STARTED
// refusal here, never a mid-run surprise.
if (IS_PERSONA) {
  try {
    require('../tests/e2e/gate/personas/load-persona').loadPersonaFixture(PERSONA_SLUG);
  } catch (e) {
    fail(e.message);
  }
}

// ── measure the world (this script MEASURES; the pure rules DECIDE) ────────────
const originRefreshed = fetchOriginRequiredBranch(REPO_ROOT);
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
  identities = IS_PERSONA
    ? mintPersonaIdentities({ slug: PERSONA_SLUG, stamp, nonce })
    : mintIdentities({ sessionNumber: SESSION_NUMBER, stamp, nonce });
} catch (e) {
  fail(e.message);
}
const { run_id: RUN_ID, athlete_id: ATHLETE_ID } = identities;

// Rehearsal artifacts live in their OWN ignored directory, outside `test-results/`
// (which Playwright wipes at the start of every run). Evidence a later run can delete
// is not preserved evidence.
// The purpose is in the DIRECTORY NAME. Diagnostic artifacts must be identifiable as
// diagnostic from the path alone, without opening a file.
const ARTIFACT_DIR = path.join(REPO_ROOT, 'rehearsal-artifacts',
  IS_PERSONA
    ? `persona-${PERSONA_SLUG}-${stamp}-${nonce}`
    : `${IS_QUALIFYING ? 'qualifying' : 'debug'}-session-${SESSION_NUMBER}-${stamp}-${nonce}`);

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
  ...(IS_PERSONA ? {
    ATLAS_PERSONA_RUN: '1',
    ATLAS_RUN_PURPOSE: RUN_PURPOSE,
    ATLAS_PERSONA_SLUG: PERSONA_SLUG,
    ATLAS_PERSONA_RUN_ID: RUN_ID,
    ATLAS_PERSONA_ATHLETE_ID: ATHLETE_ID,
    ATLAS_PERSONA_ARTIFACT_DIR: ARTIFACT_DIR,
  } : {
    ATLAS_REHEARSAL_RUN: '1',
    ATLAS_RUN_PURPOSE: RUN_PURPOSE,
    ATLAS_REHEARSAL_SESSION_NUMBER: String(SESSION_NUMBER),
    ATLAS_REHEARSAL_RUN_ID: RUN_ID,
    ATLAS_REHEARSAL_ATHLETE_ID: ATHLETE_ID,
    ATLAS_REHEARSAL_ARTIFACT_DIR: ARTIFACT_DIR,
  }),
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
const preflightEnv = {
  childCarriesWorkbookId,
  childCarriesWorkoutSessionId,
  rehearsalPostureDeclared: IS_PERSONA
    ? childEnv.ATLAS_PERSONA_RUN === '1'
    : childEnv.ATLAS_REHEARSAL_RUN === '1',
  declaredWorkbookIsSandbox: isSandboxSpreadsheetId(SANDBOX_SPREADSHEET_ID),
  nodeEnvProduction: childEnv.NODE_ENV === 'production',
  hasServiceAccountEmail: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
  hasPrivateKey: Boolean(process.env.GOOGLE_PRIVATE_KEY),
  hasProviderKey: Boolean(process.env.GEMINI_API_KEY),
};
const preflight = evaluateRehearsalPreflight(IS_PERSONA ? {
  purpose: RUN_PURPOSE,
  personaSlug: PERSONA_SLUG,
  mode: MODE,
  runId: RUN_ID,
  git: gitFacts,
  originRefreshed,
  // NO priorRehearsalCount, deliberately: a persona run never consults the
  // canonical count — not for ordering, not as a refusal — so the measured
  // count is not even handed to the decision. (The preflight's persona branch
  // refuses nothing about an absent count; the rehearsal branches keep theirs.)
  env: preflightEnv,
} : {
  purpose: RUN_PURPOSE,
  sessionNumber: SESSION_NUMBER,
  mode: MODE,
  runId: RUN_ID,
  git: gitFacts,
  originRefreshed,
  priorRehearsalCount: source.prior_rehearsal_count,
  priorCountReason: source.prior_count_reason,
  env: preflightEnv,
});
if (!preflight.ok) refuse(preflight.refusals);

// ── build the client from the exact verified tree ─────────────────────────────
// public/ is gitignored Vite output and the gate server requires index.js
// directly, so the app's build-if-missing guard never runs in a rehearsal — a
// bundle built from an OLDER commit otherwise serves silently while the server
// and the tests execute fresh (run fsb4b-s3-20261029T101354-B9957C scored
// against a client built 2026-10-27). Build HERE — the source is verified,
// no browser exists yet — and re-verify the stamp the build wrote. A build
// failure or a wrong stamp is a machinery refusal on the NOT STARTED side of
// the session-start boundary, never a scored attempt.
// RENDER_GIT_COMMIT is neutralized for the build child: write-build-info.js
// prefers it, and a Render-only value ambient in an operator shell would stamp
// the bundle with a commit this tree never verified. Empty falls back to
// `git rev-parse HEAD` — the verified source itself.
console.log('[rehearsal-session] building the client from the verified tree (npm run build)…');
const build = spawnSync('npm', ['run', 'build'], {
  cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, RENDER_GIT_COMMIT: '' },
});
if (build.error || build.status !== 0) {
  refuse([`the client build failed (${build.error ? build.error.message : `npm run build exited ${build.status}`}) — a rehearsal never runs against an unbuilt or stale client`]);
}
const buildIdentity = evaluateBuildIdentity({ buildInfo: measureServedBuild(REPO_ROOT), sourceHeadSha: gitFacts.head });
if (!buildIdentity.ok) refuse([buildIdentity.reason]);
console.log(`[rehearsal-session] client   : built from ${buildIdentity.served_commit.slice(0, 12)} — the verified source`);

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const ambientLast6 = process.env.GOOGLE_SHEETS_ID ? String(process.env.GOOGLE_SHEETS_ID).slice(-6) : null;
if (IS_PERSONA) {
  console.log(`[rehearsal-session] purpose  : ${RUN_PURPOSE} — persona "${PERSONA_SLUG}" (plumbing smoke; no beats run, nothing scored)`);
  console.log('[rehearsal-session] *** PERSONA RUN — NON-COUNTING. It exercises the same browser, provider, write');
  console.log('[rehearsal-session] *** and durable-evidence path as a qualifying run, with the athlete, plan and history');
  console.log('[rehearsal-session] *** supplied by the persona fixture. It has no session number, the canonical count is');
  console.log('[rehearsal-session] *** never consulted on its behalf, and it can never publish rehearsal_eligible=true.');
  console.log('[rehearsal-session] prior    : canonical rehearsal count NOT consulted (persona runs are not streak members)');
} else {
  console.log(`[rehearsal-session] purpose  : ${RUN_PURPOSE} — session ${SESSION_NUMBER} of ${REHEARSAL_STREAK_LENGTH}`);
  if (!IS_QUALIFYING) {
    console.log('[rehearsal-session] *** DIAGNOSTIC RUN — NON-COUNTING. It exercises the same browser, provider,');
    console.log('[rehearsal-session] *** write, durable-evidence, adjudicator, privacy and scenario conditions as a');
    console.log('[rehearsal-session] *** qualifying run, and can score every condition PASS, but it always publishes');
    console.log('[rehearsal-session] *** rehearsal_eligible=false and can never advance or authorize the count.');
  }
  console.log(`[rehearsal-session] prior    : canonical rehearsal count ${source.prior_rehearsal_count}/${REHEARSAL_STREAK_LENGTH} (from the execution plan)${IS_QUALIFYING ? '' : ' — recorded, not enforced for a debug run'}`);
}
console.log(`[rehearsal-session] source   : ${gitFacts.branch} @ ${gitFacts.head.slice(0, 12)} (clean, = origin/${REQUIRED_BRANCH})`);
console.log(`[rehearsal-session] run      : ${RUN_ID}`);
console.log(IS_PERSONA
  ? '[rehearsal-session] posture  : model-up operator command; the persona smoke\'s gate server runs the in-memory ledger posture (it submits no coach turn — see persona.spec.js)'
  : `[rehearsal-session] posture  : ${MODE} + combined sandbox-live/ledger (set by the spec's own gate-server spawn)`);
console.log(`[rehearsal-session] athlete  : ${ATHLETE_ID}`);
console.log('[rehearsal-session] workout  : NO pre-seeded id — the server allocator mints it at acceptance (isolation rule 3)');
console.log(`[rehearsal-session] workbook : declared sandbox last6 ${SANDBOX_SPREADSHEET_ID_LAST6}`);
console.log(`[rehearsal-session] ambient  : ${ambientLast6 ? `GOOGLE_SHEETS_ID last6 ${ambientLast6} present and NOT passed to the child` : 'no ambient GOOGLE_SHEETS_ID'}`);
console.log(`[rehearsal-session] artifacts: ${path.relative(process.cwd(), ARTIFACT_DIR)}`);
console.log(IS_PERSONA
  ? '[rehearsal-session] the smoke begins when the browser opens the app against the persona-armed harness.\n'
  : '[rehearsal-session] the session begins when the browser submits the first synthetic athlete turn.\n');

// --retries=0 is load-bearing, not cosmetic: playwright.config.js grants CI
// runs one retry (`retries: process.env.CI ? 1 : 0`) and this command forwards
// the ambient CI into the child (childEnv above). The spec writes its
// scorecard BEFORE asserting the run passed, and this command decides the run
// from the exit code plus the FINAL scorecard — so one retry would re-run the
// whole session, overwrite a scored FAIL's scorecard, and report a qualifying
// PASS. The flag overrides the config for THIS invocation only; ordinary E2E
// keeps its CI retry. The ambient CI is deliberately NOT stripped instead:
// CI also drives the config's forbidOnly and webServer.reuseExistingServer
// in the child, and flipping those is outside this concern. The spec refuses
// a retried attempt on its own as the second layer (rehearsal-attempt-guard).
const runner = spawn(
  process.execPath,
  [path.join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js'),
    'test', IS_PERSONA ? 'tests/e2e/gate/persona.spec.js' : 'tests/e2e/gate/rehearsal.spec.js',
    '--project=chromium', '--workers=1', '--retries=0'],
  { env: childEnv, stdio: 'inherit', cwd: REPO_ROOT },
);

runner.on('exit', (code) => {
  if (IS_PERSONA) {
    // A persona run publishes persona-evidence.json, never a scorecard: there
    // is nothing to score in a plumbing smoke, and a scorecard-shaped artifact
    // from a non-rehearsal purpose is exactly the confusion the separate
    // purpose exists to prevent. No evidence = the smoke did not complete.
    const evidencePath = path.join(ARTIFACT_DIR, 'persona-evidence.json');
    if (!fs.existsSync(evidencePath)) {
      console.error('\n[rehearsal-session] NO PERSONA EVIDENCE — the smoke did not complete.');
      console.error('[rehearsal-session] Nothing was scored, and a persona run has no count to affect either way.');
      console.error(`[rehearsal-session] evidence preserved at ${path.relative(process.cwd(), ARTIFACT_DIR)}`);
      process.exit(1);
    }
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const passed = (evidence.checks || []).filter((c) => c.ok).length;
    console.log(`\n[rehearsal-session] PERSONA SMOKE: ${evidence.ok ? 'OK' : 'NOT OK'} — ${passed}/${(evidence.checks || []).length} plumbing checks passed`);
    for (const c of evidence.checks || []) {
      if (!c.ok) console.log(`  FAILED ${c.id} — ${c.detail}`);
    }
    console.log(`[rehearsal-session] rehearsal_eligible: ${evidence.rehearsal_eligible} (a persona run can never count)`);
    process.exit(code === 0 && evidence.ok === true ? 0 : 1);
  }
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
  // A DEBUG run's success criterion is the SCORECARD, not eligibility: it is expected
  // to publish rehearsal_eligible=false, so exiting non-zero on that would report every
  // clean diagnostic session as a failure. A QUALIFYING run must reach eligibility.
  if (!IS_QUALIFYING) {
    const clean = card.overall === 'PASS';
    console.log(`[rehearsal-session] DIAGNOSTIC RESULT: ${clean ? 'CLEAN' : 'NOT CLEAN'} — the count is untouched either way.`);
    if (card.rehearsal_eligible === true) {
      // Structurally impossible (the scorecard gates on purpose), so if it ever
      // happens the eligibility rule itself is broken and this must not exit 0.
      console.error('[rehearsal-session] FATAL: a diagnostic run published rehearsal_eligible=true. Do not record a count.');
      process.exit(1);
    }
    process.exit(code === 0 && clean ? 0 : 1);
  }
  if (card.rehearsal_eligible !== true) {
    console.log('[rehearsal-session] This run does NOT advance the rehearsal streak.');
  }
  process.exit(code === 0 && card.rehearsal_eligible === true ? 0 : 1);
});
