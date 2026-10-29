'use strict';
/*
 * PERSONA REHEARSAL — SMOKE SPEC (Slice 2a, persona test rig; issue #1607).
 *
 * This spec proves the persona LANE PLUMBING end to end and nothing more:
 *   1. the run starts under a persona run identity (purpose PERSONA_RUN);
 *   2. the gate server arms the persona-history seam for the declared fixture;
 *   3. the persona's declared plan is accepted through the ONE acceptance
 *      boundary (window.atlasAcceptPlan) and the SERVER allocates the workout
 *      identity — no identity is minted or written by this spec (isolation
 *      rule 3 holds under every purpose);
 *   4. the accepted plan lands in the harness's recorded state (Session_Plans
 *      plan_accepted events + materialized Session_Plan_Sets rows for exactly
 *      this session, read from the gate server's state endpoint);
 *   5. the app serves the fixture's history rows through its REAL read path
 *      (GET /api/session/<persona-history-id>) — rows that exist nowhere but
 *      the fixture, so their presence in the response is the seam's proof;
 *   6. the canonical rehearsal count is byte-identical before and after the
 *      run — the count machinery ignores a persona run by construction.
 *
 * POSTURE — read this before assuming: the smoke runs the gate server in the
 * LEDGER-SANDBOX (in-memory) posture, model-down, credential-free. That is
 * deliberate, on two grounds. (a) The smoke submits no coach turn and writes
 * nothing durable, so the combined sandbox-live posture would only add quota
 * and credential surface to a plumbing proof. (b) Governance: the posture pin
 * (test/gateHarnessPosture.test.js) permits exactly ONE spec in this lane to
 * set the sandbox-live flag — rehearsal.spec.js, named individually in the
 * execution plan under the F-SB4B authorization. This spec does not touch
 * that flag (and does not even name it: the pin scans file text). The
 * persona-history seam is posture-independent (the gate server serves
 * fixture rows in both postures); persona SCENARIOS (Slice 2b), which do
 * submit coach turns and save to the sandbox workbook, take up the combined
 * posture under that same governance when they land.
 *
 * It runs NO persona beats and scores NOTHING: parsed-set equality, plan-state
 * facts, and the 25-condition scorecard are Slice 2b. A persona run is
 * structurally non-counting — its purpose is PERSONA_RUN, and eligibility is
 * gated on REHEARSAL_SESSION alone (rehearsal-run-purpose.js), so this spec
 * writes no scorecard; the evidence records eligible=false computed from the
 * purpose module itself.
 *
 * Launched ONLY through `npm run atlas:rehearsal-session -- --persona=<slug>
 * --model-up`, which mints the persona identities and preflights. Without that
 * envelope the spec SKIPS — no hook runs, no server spawns.
 */

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { PERSONA_RUN, isQualifyingPurpose, parseCanonicalRehearsalCount } = require('./rehearsal-run-purpose');
const { measureSourceTree, REPO_ROOT, PLAN_RELATIVE_PATH } = require('./rehearsal-source-facts');
const { checkServedBuildIdentity } = require('./rehearsal-build-identity');
const { refuseRetriedAttempt } = require('./rehearsal-attempt-guard');
const { pickNetworkPassthrough, GATE_STARTUP_TIMEOUT_MS } = require('./rehearsal-child-env');
const { loadPersonaFixture } = require('./personas/load-persona');
const { sessionPlansColumns, sessionPlanSetsColumns } = require('../../../config/columns');

const GATE_KEY = 'playwright-gate-key';
const APP_READINESS_TIMEOUT_MS = 30000;
const RUN_ID = process.env.ATLAS_PERSONA_RUN_ID;
const ATHLETE_ID = process.env.ATLAS_PERSONA_ATHLETE_ID;
const ARTIFACT_DIR = process.env.ATLAS_PERSONA_ARTIFACT_DIR;
const RUN_PURPOSE = process.env.ATLAS_RUN_PURPOSE || '';
const SLUG = String(process.env.ATLAS_PERSONA_SLUG || '').trim().toLowerCase();

const SOURCE = measureSourceTree();
const PLAN_TEXT_BEFORE = (() => {
  try { return fs.readFileSync(path.join(REPO_ROOT, PLAN_RELATIVE_PATH), 'utf8'); } catch { return ''; }
})();

test.describe.configure({ mode: 'serial' });

test.skip(process.env.ATLAS_PERSONA_RUN !== '1',
  'persona runs launch only through `npm run atlas:rehearsal-session -- --persona=<slug> --model-up`');

let child = null;
let base = '';
let stateBase = '';
let artDir = null;
let serverStdout = '';
const pageErrors = [];
const checks = [];
function check(id, ok, detail) {
  checks.push({ id, ok: ok === true, detail: detail || '' });
}

async function readJson(url, label, apiKey) {
  const res = await fetch(url, apiKey ? { headers: { 'x-atlas-api-key': apiKey } } : undefined);
  if (!res.ok) {
    const err = new Error(`${label} failed: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
const gateState = () => readJson(`${stateBase}/state`, 'gate state read');

test.beforeAll(async () => {
  // A retried attempt is never evidence (same rule as the rehearsal lane): the
  // operator command passes --retries=0, and this spec refuses on its own too,
  // before the artifact dir is touched and before any server spawns.
  const attempt = refuseRetriedAttempt({ artifactDir: ARTIFACT_DIR, runId: RUN_ID, retry: test.info().retry });
  if (!attempt.ok) {
    throw new Error(`persona retry refused (NOT SCORED): ${attempt.reason}`);
  }
  if (!RUN_ID || !ATHLETE_ID || !ARTIFACT_DIR) {
    throw new Error('persona: run it through `npm run atlas:rehearsal-session -- --persona=<slug>` — the run/athlete ids and artifact dir are minted there, never here.');
  }
  if (RUN_PURPOSE !== PERSONA_RUN) {
    throw new Error(`persona: the recorded run purpose must be ${PERSONA_RUN}; got "${RUN_PURPOSE}" — a persona run never borrows a rehearsal purpose.`);
  }
  // The fixture is the run's declaration; a malformed one refuses here, before
  // the server spawns (the gate server will refuse it again on its own side).
  loadPersonaFixture(SLUG);
  artDir = ARTIFACT_DIR;
  fs.mkdirSync(artDir, { recursive: true });

  // The served client must be the build OF THIS source (same guard as the
  // rehearsal lane): a stale bundle would make every observation below a
  // claim about a product nobody is running.
  const buildIdentity = checkServedBuildIdentity({
    repoRoot: REPO_ROOT, sourceHeadSha: SOURCE.head_sha, artifactDir: artDir, runId: RUN_ID,
  });
  if (!buildIdentity.ok) {
    throw new Error(`persona machinery abort (NOT STARTED): ${buildIdentity.reason}`);
  }

  // The child environment is CONSTRUCTED, never inherited — the ledger-sandbox
  // posture flags and the one persona line that arms the seam. No credentials:
  // this posture cannot reach a workbook or a provider (see the header).
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    ...pickNetworkPassthrough(),
    ATLAS_GATE_KEY: GATE_KEY,
    ATLAS_GATE_LEDGER_SANDBOX: '1',
    ATLAS_GATE_PERSONA: SLUG,
  };

  child = spawn(process.execPath, [path.join(__dirname, 'gate-server.js')],
    { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gate-server did not report its ports within ${GATE_STARTUP_TIMEOUT_MS / 1000}s`)), GATE_STARTUP_TIMEOUT_MS);
    let stderr = '';
    child.stdout.on('data', d => {
      serverStdout += String(d);
      const app = serverStdout.match(/GATE_PORT=(\d+)/);
      const st = serverStdout.match(/GATE_STATE_PORT=(\d+)/);
      if (app && st) { clearTimeout(timer); resolve({ app: app[1], state: st[1] }); }
    });
    child.stderr.on('data', d => { stderr += String(d); process.stderr.write(`[gate-server] ${d}`); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`gate-server exited early (${code}): ${stderr.slice(-2000)}`)); });
  });
  base = `http://127.0.0.1:${ports.app}`;
  stateBase = `http://127.0.0.1:${ports.state}`;
});

test.afterAll(async () => {
  try {
    if (artDir) {
      fs.writeFileSync(path.join(artDir, 'server-log.txt'), serverStdout);
      fs.writeFileSync(path.join(artDir, 'pageerrors.txt'), pageErrors.join('\n\n') || '(no page errors captured)');
    }
  } catch { /* best-effort */ }
  if (child) child.kill('SIGTERM');
});

test('persona lane smoke: fixture history + declared plan through the real harness', async ({ page }) => {
  test.setTimeout(600000);
  const PERSONA = loadPersonaFixture(SLUG);
  const startedAt = new Date().toISOString();
  page.on('pageerror', (err) => { pageErrors.push(`[pageerror] ${err && err.message}`); });
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(`[console.error] ${msg.text().slice(0, 500)}`); });

  // ── 1. The seam is armed in the serving process, with THIS fixture ─────────
  const st0 = await gateState();
  check('persona-seam-armed', Boolean(st0.persona) && st0.persona.slug === PERSONA.slug
    && st0.persona.history_mode === PERSONA.historyMode
    && st0.persona.history_rows === PERSONA.historyRows.length
    && st0.persona.catalog_rows === PERSONA.catalogRows.length,
  `gate state persona: ${JSON.stringify(st0.persona)}`);
  check('ledger-sandbox-posture', st0.ledger_sandbox === true && st0.sheets_stubbed_in_memory === true && st0.sandbox_live === false,
    `ledger_sandbox=${st0.ledger_sandbox} sheets_stubbed_in_memory=${st0.sheets_stubbed_in_memory} sandbox_live=${st0.sandbox_live}`);

  // ── 2. The app serves the fixture's history through its real read path ─────
  // The fixture's second history session (Marcus: PERS-M2, the squat day);
  // its rows exist nowhere but the fixture, so an exact match through
  // GET /api/session/<id> proves the seam serves them to the product — not
  // merely that the server loaded a file. Derived from the fixture, never
  // hardcoded to one persona's ids.
  const historySessionIds = [...new Set(PERSONA.historyRows.map(r => r[1]))];
  const historySessionId = historySessionIds[1] || historySessionIds[0];
  const expectedHistory = PERSONA.historyRows
    .filter(r => r[1] === historySessionId)
    .map(r => ({
      date_clean: r[0], session_id: r[1], exercise: r[2], canonical_exercise: r[3],
      muscle_group: r[4], lift_code: r[5], set_number: r[6], weight: r[7],
      reps: r[8], rir: r[9], notes: r[10],
    }));
  const sessionView = await readJson(`${base}/api/session/${encodeURIComponent(historySessionId)}`, 'persona history read', GATE_KEY);
  const gotHistory = (sessionView && sessionView.data && sessionView.data.log_rows) || [];
  check('persona-history-served', JSON.stringify(gotHistory) === JSON.stringify(expectedHistory),
    `GET /api/session/${historySessionId} returned ${gotHistory.length} rows; fixture declares ${expectedHistory.length}`);

  // ── 3. Count snapshot BEFORE: the machinery's view of the streak ───────────
  const countBefore = parseCanonicalRehearsalCount(PLAN_TEXT_BEFORE);

  // ── 4. Open the real built client; prove no pre-seeded identity ────────────
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, GATE_KEY);
  await page.goto(`${base}/app/`);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => typeof window.atlasAcceptPlan === 'function', null, { timeout: APP_READINESS_TIMEOUT_MS });
  const idBefore = await page.evaluate(() => document.getElementById('log-session-id').value);
  check('no-preseeded-identity', idBefore === '', `#log-session-id before acceptance: "${idBefore}"`);

  // ── 5. Accept the persona's declared plan through the ONE boundary ─────────
  const started = await page.evaluate(({ plan, why }) => window.atlasAcceptPlan({
    id: 'work_day', label: 'Work', why_today: why, exercises: plan,
  }), { plan: PERSONA.plan, why: `Persona smoke — ${PERSONA.slug} (Slice 2a plumbing).` });
  check('plan-accepted', Boolean(started && started.started), `atlasAcceptPlan started=${started && started.started}`);
  let workoutId = '';
  await expect.poll(async () => {
    workoutId = await page.evaluate(() => document.getElementById('log-session-id').value.trim());
    return workoutId;
  }, { timeout: 30000 }).toMatch(/^\d{8}-(AM|PM)-\d{2}$/i);
  const planSessionId = await page.evaluate(() => (window.getActivePlannedSession() || {}).session_id || '');
  check('server-allocated-identity-adopted', workoutId !== '' && planSessionId === workoutId,
    `adopted ${workoutId}; plan carries ${planSessionId}`);
  await page.screenshot({ path: path.join(artDir, 'persona-plan-accepted.png') });

  // ── 6. The acceptance landed in the harness state, exactly as declared ─────
  const st1 = await gateState();
  const spSessionIdx = sessionPlansColumns.indexOf('session_id');
  const spEventIdx = sessionPlansColumns.indexOf('event_type');
  const planAccepted = (st1.appends || [])
    .filter(c => c.tabName === 'Session_Plans')
    .flatMap(c => c.rows)
    .filter(r => r[spSessionIdx] === workoutId && r[spEventIdx] === 'plan_accepted')
    .length;
  const spsSessionIdx = sessionPlanSetsColumns.indexOf('session_id');
  const planSetRows = (st1.plan_set_rows || []).filter(r => r[spsSessionIdx] === workoutId).length;
  const declaredPlanSets = PERSONA.plan.reduce((sum, row) => sum + row.target_sets, 0);
  check('recorded-plan-events', planAccepted === PERSONA.plan.length,
    `plan_accepted events ${planAccepted}; fixture declares ${PERSONA.plan.length} plan rows`);
  check('recorded-plan-set-rows', planSetRows === declaredPlanSets,
    `Session_Plan_Sets rows ${planSetRows}; fixture declares ${declaredPlanSets} plan sets`);
  const workoutRows = (st1.appends || [])
    .filter(c => c.tabName === 'Log_Cleaned' || c.tabName === 'Effort')
    .flatMap(c => c.rows)
    .filter(r => r[1] === workoutId)
    .length;
  check('no-workout-rows-yet', workoutRows === 0,
    `pre-beat recorded state: ${workoutRows} log/effort rows for this session (no beats run in the smoke)`);

  // ── 7. Count snapshot AFTER: byte-identical — the run never touched it ─────
  const planTextAfter = fs.readFileSync(path.join(REPO_ROOT, PLAN_RELATIVE_PATH), 'utf8');
  const countAfter = parseCanonicalRehearsalCount(planTextAfter);
  check('canonical-count-untouched', planTextAfter === PLAN_TEXT_BEFORE
    && countBefore.ok === countAfter.ok && countBefore.count === countAfter.count,
  `count before ${JSON.stringify(countBefore)}; after ${JSON.stringify(countAfter)}; plan text identical: ${planTextAfter === PLAN_TEXT_BEFORE}`);

  // ── Evidence — the run's own artifact, under its persona run id ────────────
  const ok = checks.every(c => c.ok);
  const evidence = {
    kind: 'PERSONA_SMOKE',
    ok,
    started: true,
    at: startedAt,
    run_id: RUN_ID,
    athlete_id: ATHLETE_ID,
    purpose: RUN_PURPOSE,
    rehearsal_eligible: isQualifyingPurpose(RUN_PURPOSE),
    persona: { slug: PERSONA.slug, source_ref: PERSONA.sourceRef, history_mode: PERSONA.historyMode },
    posture: { sheets: 'in-memory ledger-sandbox (stub)', model: 'down — no coach turn submitted' },
    source_sha: SOURCE.head_sha,
    workout_session_id: workoutId,
    canonical_count_before: countBefore,
    canonical_count_after: countAfter,
    checks,
    note: 'Slice 2a plumbing smoke: no persona beats were run and nothing was scored. '
      + 'PERSONA_RUN is structurally non-counting — eligibility is gated on REHEARSAL_SESSION alone.',
  };
  fs.writeFileSync(path.join(artDir, 'persona-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

  for (const c of checks) {
    if (!c.ok) throw new Error(`persona smoke check failed: ${c.id} — ${c.detail}`);
  }
});
