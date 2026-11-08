'use strict';
/*
 * PERSONA REHEARSAL SPEC (persona test rig; issue #1607 — smoke: Slice 2a;
 * scored scenarios: Slice 2b). (TEMPORARY persona-lane machinery; sunset: persona campaign close)
 *
 * TWO MODES, one gate server each, chosen by ATLAS_PERSONA_SCORED:
 *
 * SMOKE MODE (default; Slice 2a) — proves the persona LANE PLUMBING end to end
 * and nothing more:
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
 * The smoke runs the gate server in the LEDGER-SANDBOX (in-memory) posture,
 * model-down, credential-free: it submits no coach turn and writes nothing
 * durable, so the combined sandbox-live posture would only add quota and
 * credential surface to a plumbing proof.
 *
 * SCORED MODE (Slice 2b; runner flag --scored) — the persona's SCENARIO: the
 * fixture's beats driven through the real app (browser → built client →
 * gate server → sandbox workbook → review-card Save), model-up, in the
 * COMBINED sandbox-live posture this spec is authorized for (execution plan,
 * "PERSONA LANE — SANDBOX-LIVE AUTHORIZATION 2026-10-29"; the posture pin in
 * test/gateHarnessPosture.test.js holds this spec to the same three proofs
 * as the rehearsal spec: the plan authorization, this sunset line, and the
 * combined-flags-only form). The scenario is judged by the SAME 25-condition
 * scorecard the rehearsals use (rehearsal-scorecard.js, PERSONA_RUN branches)
 * plus the persona fact checks (persona-facts.js): parsed-set equality
 * against the run's computed declaration, the correction end-states, the
 * retained-buffer correction, and the fixture's plan-state facts. The
 * fixture's voice/feel items ship in the evidence as a human checklist —
 * never automated prose assertions. The declaration itself is
 * slug-dispatched (persona-scenario.js): Marcus keeps his Slice 2b
 * declaration exactly, Priya's is computed from her own fixture (fixed
 * script values, a form-bail revision instead of a correction, a
 * Modality_Log plank row alongside the Log_Cleaned sets).
 *
 * A persona run is structurally non-counting in BOTH modes — its purpose is
 * PERSONA_RUN, and eligibility is gated on REHEARSAL_SESSION alone
 * (rehearsal-run-purpose.js); the scorecard records rehearsal_eligible false.
 *
 * Launched ONLY through `npm run atlas:rehearsal-session -- --persona=<slug>
 * --model-up` (add --scored for the scenario), which mints the persona
 * identities and preflights. Without that envelope the spec SKIPS — no hook
 * runs, no server spawns.
 */

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { PERSONA_RUN, isQualifyingPurpose, parseCanonicalRehearsalCount } = require('./rehearsal-run-purpose');
const { measureSourceTree, REPO_ROOT, PLAN_RELATIVE_PATH } = require('./rehearsal-source-facts');
const { checkServedBuildIdentity } = require('./rehearsal-build-identity');
const { refuseRetriedAttempt } = require('./rehearsal-attempt-guard');
const { markRunStarted, verifyRunStartMarker } = require('./rehearsal-run-start');
const { pickNetworkPassthrough, GATE_STARTUP_TIMEOUT_MS } = require('./rehearsal-child-env');
const { loadPersonaFixture } = require('./personas/load-persona');
const {
  scoreRehearsalRun, renderMarkdown, compareLedgerToDeclaration, classifyRepeatApprovalProbe,
  classifyCoachResponseCapture, classifySettlement, isSettled, deriveExpectedRemaining,
  detectUnsupportedMutationWording, detectUnsupportedWriteClaim,
} = require('./rehearsal-scorecard');
const { evaluateTraceWriteJoin } = require('./rehearsal-write-proof-join');
const { checkPersonaFacts, compareSetMultisets, declaredSet, durableModalityRow } = require('./persona-facts');
const { buildDeclaration, buildBufferNameMap, mapBufferSets } = require('./persona-scenario');
const {
  OBSERVER_FLUSH_MS, bubbleObserverInitScript, BUBBLE_ID_ATTR, BUBBLE_SEQ_ATTR,
  ingestLiveObservation, reconcileSweep, redeemOnStoredEvidence, recordsToMessages,
  makeBoundary, pairLiveWriteChangeSeq, SEEN_ATTR, NEW_BUBBLE_SELECTOR, markExistingBubblesScript,
} = require('./rehearsal-bubble-observer');
const { SANDBOX_SPREADSHEET_ID, SANDBOX_SPREADSHEET_ID_LAST6 } = require('../../../config/sandboxSheet');
const {
  EVIDENCE_FILENAME, buildForbiddenSecrets, redactSecrets, sweepArtifactDir, verifyFinalArtifacts,
} = require('./persona-artifacts');
const { logCleanedColumns, effortColumns, modalityLogColumns } = require('../../../config/columns');
const { sessionPlansColumns, sessionPlanSetsColumns } = require('../../../config/columns');

// Scored mode (Slice 2b): set by the runner's --scored flag in the spec worker
// env. The smoke and the scenario share one server per process, so the mode
// also chooses the posture in beforeAll: ledger-sandbox for the smoke,
// combined sandbox-live (model-up) for the scenario.
const SCORED = process.env.ATLAS_PERSONA_SCORED === '1';

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
// Set by the scored test once its artifacts are finalized (swept + hashed
// over the final bytes, §13). afterAll must not rewrite them after that —
// the old afterAll replaced the swept log with raw stdout (#1664).
let artifactsFinalized = false;
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

  // The child environment is CONSTRUCTED, never inherited — the posture flags
  // and the one persona line that arms the seam. Smoke mode carries no
  // credentials: the ledger-sandbox posture cannot reach a workbook or a
  // provider. Scored mode writes to the sandbox workbook and talks to the
  // live model, so it passes the rehearsal credentials through and refuses
  // without them — placeholder credentials would fail deep inside the run
  // and read like a product defect.
  const hasCreds = !!(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.GEMINI_API_KEY);
  if (SCORED && !hasCreds) {
    throw new Error('persona scored mode requires the service-account and Gemini credentials in the environment — the sandbox-live posture has no placeholder form.');
  }
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    ...pickNetworkPassthrough(),
    ATLAS_GATE_KEY: GATE_KEY,
    // The posture, in exactly one form per mode. Scored: the combined
    // sandbox-live flags, adjacent, under this spec's plan authorization
    // (execution plan, PERSONA LANE — SANDBOX-LIVE AUTHORIZATION 2026-10-29;
    // the posture pin holds the combined form to these two adjacent lines).
    // Smoke: the ledger-sandbox flag alone, model-down.
    ...(SCORED
      ? {
          ATLAS_GATE_SANDBOX_LIVE: '1',
          ATLAS_GATE_LEDGER_SANDBOX: '1',
          ATLAS_GATE_MODEL_UP: '1',
          ATLAS_INTERACTION_TRACE: 'shadow',
          GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
          GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        }
      : { ATLAS_GATE_LEDGER_SANDBOX: '1' }),
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
    if (artDir && !artifactsFinalized) {
      // Only when the scored test did NOT finalize its artifacts — an
      // aborted run, or the smoke test, which publishes no sweep record.
      // The log is published REDACTED (every forbidden value, not just the
      // workbook id) — never raw stdout (#1664: the old afterAll replaced
      // the swept log with the raw server output and added an unswept
      // pageerrors file after the sweep had run).
      const forbidden = buildForbiddenSecrets();
      fs.writeFileSync(path.join(artDir, 'server-log.txt'), redactSecrets(serverStdout, forbidden));
      fs.writeFileSync(path.join(artDir, 'pageerrors.txt'), pageErrors.join('\n\n') || '(no page errors captured)');
    }
  } catch { /* best-effort */ }
  if (child) child.kill('SIGTERM');
});

// ── The variation draw (design §3.3) ─────────────────────────────────────────
// Seeded by the run id, drawn BEFORE the run, and recorded in the evidence:
// the same run id always resolves the same script. mulberry32 + FNV-1a —
// tiny, deterministic, and identical in the spec and any re-derivation.
function personaSeed(runId) {
  let h = 0x811c9dc5;
  for (const ch of String(runId || '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function personaRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('persona lane smoke: fixture history + declared plan through the real harness', async ({ page }) => {
  test.skip(SCORED, 'scored mode runs the persona scenario test, not the smoke');
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

// ═════════════════════════════════════════════════════════════════════════════
// SCORED PERSONA SCENARIO (Slice 2b) — the fixture's beats through the real
// app, judged by the 25-condition scorecard (PERSONA_RUN branches) plus the
// persona fact checks. The evidence machinery is the rehearsal spec's own,
// ported section for section (bubble-lifecycle collector, served-reply
// settlement, claim sweeps, durable reads, review adjudication): a persona
// run must be measured by the same instruments as a rehearsal, or the two
// lanes' evidence could not be compared. The persona-specific deltas are the
// declaration (fixture + seeded variation draw), the correction beat and its
// mutation boundary, and the persona fact checks. Voice/feel is NEVER
// asserted — the fixture's reviewChecklist ships in the evidence for a human.
// ═════════════════════════════════════════════════════════════════════════════
test('persona scenario (scored): fixture beats through the real app under the scorecard', async ({ page }) => {
  test.skip(!SCORED, 'the persona scenario runs only in scored mode (runner --scored)');
  test.setTimeout(35 * 60_000);
  const PERSONA = loadPersonaFixture(SLUG);
  const startedAt = new Date().toISOString();
  const beats = [];
  const stateChecks = [];
  const notes = [];
  const beat = (id, ok, detail) => { beats.push({ id, ok: ok === true, detail: detail || '' }); };
  const stateCheck = (id, ok, detail) => { stateChecks.push({ id, ok: ok === true, detail: detail || '' }); };
  const note = (id, detail) => { notes.push({ id, detail: detail || '' }); };
  const durableRows = (sessionId) => readJson(`${stateBase}/durable-rows?session_id=${encodeURIComponent(sessionId)}`, 'durable row read');

  // ── Resolve the run: declaration + the seeded variation draw (§3.3) ────────
  // Drawn from the run id BEFORE the run and recorded here; every expectation
  // below is computed from the fixture and the draw — never read from a reply.
  // The computation lives in persona-scenario.js, dispatched by slug: Marcus
  // keeps his Slice 2b declaration exactly (unit-pinned against the
  // pre-extraction inline block for all three draws); Priya's is computed
  // from her own fixture. A slug with no driver (Tara, until her slice)
  // throws here, before any server or browser work — never a fallback to
  // another persona's beats.
  const seed = personaSeed(RUN_ID);
  const rng = personaRng(seed);
  const draw = SLUG === 'marcus'
    ? { topRirDelta: PERSONA.variation.topRirDeltaChoices[Math.floor(rng() * PERSONA.variation.topRirDeltaChoices.length)] }
    : {};
  const scenario = buildDeclaration(SLUG, PERSONA, draw);
  const expectedSets = scenario.expectedSets;
  const loggedNames = expectedSets.map((s) => s.exercise);
  const closeoutMinutes = scenario.closeoutMinutes;
  const closeoutText = scenario.closeoutText;
  const declaration = { persona_slug: SLUG, seed, ...scenario.declaration };
  // The retained buffer the fact checks judge: Marcus's after the correction
  // beat, Priya's after the final log turn. Each turn section sets it.
  let finalBuffer = null;

  // #1659 re-fix — the one modality row Priya's plank writes mid-run, by
  // explicit approval of its staged preview (rows-and-plank beat). Null for
  // a persona with no modality turn (Marcus): the no-write-before-approval
  // beat then still requires zero modality rows. Recorded here so that beat
  // can tell this approved write apart from a pre-approval leak.
  let approvedModality = null;

  // ── The run-start marker: written and verified before the first turn ───────
  // A persona run declares NO rehearsal session number (null) — the marker
  // itself cannot be mistaken for a streak member's.
  const markerFields = {
    run_id: RUN_ID, purpose: PERSONA_RUN, rehearsal_session_number: null,
    source_sha: SOURCE.head_sha, persona_slug: SLUG, persona_seed: seed,
  };
  const markerWritten = markRunStarted(artDir, markerFields);
  const markerCheck = verifyRunStartMarker(artDir, markerFields);
  beat('run-start-marker', markerWritten === true && markerCheck.ok,
    markerCheck.ok ? 'marker written and verified for this run id, purpose and source head' : (markerCheck.reason || 'marker refused'));

  // ── Bubble-lifecycle collector (the rehearsal spec's instruments) ──────────
  const THINKING = 'Thinking…';
  const SETTLE_TIMEOUT_MS = 90000;
  const STABLE_MS = 750;
  const currentPhaseRef = { value: 'setup' };
  const coachCaptureFailures = { count: 0 };
  let bubbleRecords = {};
  let bubbleIngestSeq = 0;
  let mutationBoundary = null;
  const servedReplies = [];
  const coachResponses = [];
  const saveResponses = [];
  let writeBoundarySamples = [];
  const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

  function onBubblesObserved(batch) {
    const now = Date.now();
    for (const item of (Array.isArray(batch) ? batch : [])) {
      bubbleIngestSeq += 1;
      ingestLiveObservation(bubbleRecords, item, {
        phase: currentPhaseRef.value, nowMs: now, ingestSeq: bubbleIngestSeq, thinkingMarker: THINKING,
      });
    }
  }
  async function takeBoundary() {
    let drained = false;
    let atChangeSeq = null;
    try {
      const flushed = await page.evaluate(() => (typeof window.__atlasBubbleFlush === 'function' ? window.__atlasBubbleFlush() : null));
      drained = Boolean(flushed && flushed.ok === true && flushed.pending === false);
    } catch { drained = false; }
    try {
      const st = await page.evaluate(() => (typeof window.__atlasBubbleState === 'function' ? window.__atlasBubbleState() : null));
      if (st && Number.isFinite(st.changeSeq)) atChangeSeq = st.changeSeq;
    } catch { atChangeSeq = null; }
    return makeBoundary({ atMs: Date.now(), atChangeSeq, ingestSeq: bubbleIngestSeq, drained });
  }
  async function sweepAtlasBubbles() {
    const swept = await page.evaluate(async () => {
      let flushed = null;
      try { flushed = typeof window.__atlasBubbleFlush === 'function' ? await window.__atlasBubbleFlush() : null; } catch { flushed = null; }
      if (typeof window.__atlasBubbleRead !== 'function') return { observed: null, quiet: false };
      const observed = window.__atlasBubbleRead();
      let st = null;
      try { st = typeof window.__atlasBubbleState === 'function' ? window.__atlasBubbleState() : null; } catch { st = null; }
      return {
        observed,
        quiet: Boolean(flushed && flushed.ok === true) && Boolean(st) && st.pending === false,
        atChangeSeq: (st && Number.isFinite(st.changeSeq)) ? st.changeSeq : null,
      };
    }).catch(() => ({ observed: null, quiet: false, atChangeSeq: null }));
    if (!Array.isArray(swept.observed)) {
      throw new Error('persona: the bubble collector\'s read hook is unavailable — the claim sweep cannot observe anything, so this run cannot be scored');
    }
    reconcileSweep(bubbleRecords, swept.observed, {
      phase: currentPhaseRef.value, nowMs: Date.now(), thinkingMarker: THINKING,
      collectorQuiet: swept.quiet, sweptAtChangeSeq: swept.atChangeSeq,
    });
    return swept.observed.length;
  }
  async function settleBubbleCollector() {
    let previous = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sweepAtlasBubbles();
      let pending = true;
      try {
        const st = await page.evaluate(() => (typeof window.__atlasBubbleState === 'function' ? window.__atlasBubbleState() : null));
        pending = !st || st.pending !== false;
      } catch { pending = true; }
      const snapshot = JSON.stringify(recordsToMessages(bubbleRecords)
        .map((r) => [r.id, r.text, r.retroactive === true, r.placeholder === true]));
      if (!pending && snapshot === previous) { redeemOnStoredEvidence(bubbleRecords); return true; }
      previous = snapshot;
      await page.waitForTimeout(OBSERVER_FLUSH_MS * 2);
    }
    return false;
  }
  async function markBubblesSeen() { return page.evaluate(markExistingBubblesScript, SEEN_ATTR); }
  async function say(text) {
    await page.locator('#workout-text').fill(text);
    await page.locator('#preview-btn').click();
    await sweepAtlasBubbles();
  }
  async function settleReply(question) {
    const newBubbles = page.locator(NEW_BUBBLE_SELECTOR);
    const servedBefore = servedReplies.length;
    const captureFailuresBefore = coachCaptureFailures.count;
    await markBubblesSeen();
    const strays = await newBubbles.count();
    if (strays !== 0) throw new Error(`persona: ${strays} bubble(s) were unmarked before the turn — the turn's own reply could not be identified`);
    await say(question);
    await expect.poll(() => newBubbles.count(), { timeout: SETTLE_TIMEOUT_MS, intervals: [250] }).toBeGreaterThan(0);
    const mine = newBubbles.first();
    let settled = '';
    let lastSeen = null;
    let stableSince = null;
    let lastDiagnosis = 'no observation yet';
    const DIAGNOSIS = {
      thinking: 'the bubble still showed Thinking… — the request had not returned',
      empty: 'the bubble was empty — rendering had not begun',
      growing: 'the bubble text was still growing — typeOut had not finished',
      'partial-render': 'the bubble stopped changing while still shorter than the reply the server served — a partial render, not a settled one',
      'capture-failed': 'a coach response for this turn could not be parsed, so the served reply is unknown; settlement fails closed rather than trusting quiet',
    };
    try {
      await expect.poll(async () => {
        const text = norm(await mine.innerText().catch(() => ''));
        if (text !== lastSeen) { lastSeen = text; stableSince = Date.now(); }
        const outcome = classifySettlement({
          text,
          servedMessages: servedReplies.slice(servedBefore),
          stableForMs: stableSince === null ? 0 : Date.now() - stableSince,
          stableThresholdMs: STABLE_MS,
          thinkingMarker: THINKING,
          captureFailed: coachCaptureFailures.count > captureFailuresBefore,
        });
        if (isSettled(outcome)) { settled = text; return true; }
        lastDiagnosis = DIAGNOSIS[outcome] || `settlement refused (${outcome})`;
        return false;
      }, { timeout: SETTLE_TIMEOUT_MS, intervals: [250] }).toBe(true);
    } catch (e) {
      throw new Error(`persona: reply never settled for "${String(question).slice(0, 60)}" after ${SETTLE_TIMEOUT_MS / 1000}s — ${lastDiagnosis}`);
    }
    await sweepAtlasBubbles();
    return settled;
  }
  const loggedCount = () => page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : -1));
  const turns = [];
  // A beat turn that fails (timeout, unsettled reply, short count) is RECORDED
  // and the run continues to its durable reads and judging — the scorecard,
  // not an exception, is where a persona run's failures belong.
  async function runTurn(id, phase, text, expectedLogCount) {
    currentPhaseRef.value = phase;
    let reply = '';
    let err = '';
    try { reply = await settleReply(text); } catch (e) { err = String((e && e.message) || e); }
    // The settled reply is the turn's FIRST bubble; a turn can render more
    // (a confirmation, then a question). The tail keeps the transcript honest
    // about everything the turn showed, not only the bubble that settled it.
    const tail = recordsToMessages(bubbleRecords).slice(-3).map((m) => m.text).join(' ⏎ ');
    turns.push({ phase, text, reply, thread_tail: tail });
    if (expectedLogCount == null) {
      beat(id, !err, err || 'reply settled');
      return reply;
    }
    let count = -1;
    try {
      await expect.poll(async () => { count = await loggedCount(); return count; }, { timeout: 60000 }).toBe(expectedLogCount);
    } catch { /* the beat records the shortfall */ }
    beat(id, !err && count === expectedLogCount,
      err || `session log holds ${count} set(s) after the beat (expected ${expectedLogCount})`);
    return reply;
  }
  // The map is built in Node (persona-scenario.js, unit-pinned) and the
  // session log is fetched from the page, then mapped in Node through the
  // same mapBufferSets the unit tests exercise — so the mapping the run
  // judges is the mapping the tests pin. Keys: the plan exercise name,
  // the lift-code stem, the acronym, plus the fixture's own catalog
  // synonyms for that lift (Priya: 'rows' → OAR01, 'db bench' → DBB01).
  // Marcus's catalogRows is [], so his map is exactly the old one.
  const bufferNameMap = buildBufferNameMap(PERSONA.plan, PERSONA.catalogRows);
  const readBufferSets = async () => mapBufferSets(
    await page.evaluate(() => window.getSessionLog() || []),
    bufferNameMap,
  );
  async function bufferCheck(id, expected) {
    const buf = await readBufferSets();
    // Both sides through declaredSet, the one comparable set shape: the
    // declaration carries rir: null for Priya's bench bail, and only the
    // num() normalization turns that null into the NaN the mapped buffer
    // carries — a raw comparison would fail a parse-correct run on
    // "null" vs "NaN". This mirrors the retained-buffer fact check.
    const cmp = compareSetMultisets(buf.map(declaredSet), expected.map(declaredSet));
    beat(id, cmp.ok, cmp.ok
      ? `retained buffer equals the declared sets (${buf.length})`
      : `undeclared: [${cmp.unmatched.join('; ')}]; missing: [${cmp.missing.join('; ')}]`);
    return buf;
  }

  // #1659 re-fix — the mixed rows/plank turn stages a modality preview,
  // not a coach bubble: the resistance half does not parse (prose turn),
  // so the turn's product surface is the preview panel, and the plank's
  // write is the driver's EXPLICIT approval of that preview — clicked
  // here, before the next submit clears it (invalidatePreview nulls
  // pendingWrite on every submit). Settlement for this turn is the preview
  // staging (approve enabled, Timed hold preview rendered); the write is
  // proven by the durable row, not by a reply. The turn records an empty
  // reply — no coach bubble was served, and the preview text must never
  // be scored as one.
  async function runModalityTurn(id, phase, text) {
    currentPhaseRef.value = phase;
    await say(text);
    let preview = '';
    let staged = false;
    try {
      await expect.poll(async () => {
        const st = await page.evaluate(() => {
          const btn = document.getElementById('approve-btn');
          const content = document.getElementById('preview-content');
          return {
            approveEnabled: Boolean(btn && !btn.disabled),
            previewText: content ? content.innerText : '',
          };
        });
        preview = st.previewText;
        return st.approveEnabled && /Timed hold/i.test(st.previewText) && /Modality_Log/.test(st.previewText);
      }, { timeout: 60000, intervals: [500] }).toBe(true);
      staged = true;
    } catch { staged = false; }
    const tail = recordsToMessages(bubbleRecords).slice(-3).map((m) => m.text).join(' ⏎ ');
    turns.push({ phase, text, reply: '', thread_tail: tail });
    beat(id, staged, staged
      ? 'modality preview staged: Timed hold to write (Modality_Log), approve enabled'
      : 'no staged modality preview after the mixed turn (approve stayed disabled or no Timed hold preview rendered)');
    if (!staged) return '';
    // Explicit approval — the plank's write happens on this click. A click
    // failure is recorded as a failed beat (not a thrown error) so the run
    // still reaches its durable reads and judging with the failure on the
    // record, like the closeout save flow below.
    try {
      await page.locator('#approve-btn').click();
    } catch (e) {
      beat('modality-write-approved', false, `the approve click failed: ${String((e && e.message) || e).slice(0, 200)}`);
      return preview;
    }
    const wantSec = PERSONA.facts.plankPb.todaySec;
    let landed = false;
    try {
      await expect.poll(async () => {
        const d = await durableRows(workoutId).catch(() => null);
        const rows = d && d.modality ? d.modality.rows : [];
        const mine = rows.filter((r) => String(r[modalityLogColumns.indexOf('session_id')]).trim() === workoutId);
        const good = mine.filter((r) => {
          const m = durableModalityRow(r);
          return m.modality === 'timed_hold' && /plank/i.test(m.exercise || '') && m.durationSec === wantSec;
        });
        return good.length;
      }, { timeout: 60000, intervals: [2000] }).toBe(1);
      landed = true;
    } catch { landed = false; }
    if (landed) {
      approvedModality = { session_id: workoutId, modality: 'timed_hold', exercise: 'Plank', durationSec: wantSec };
    }
    beat('modality-write-approved', landed, landed
      ? `approved modality write landed: 1 session-attributed timed_hold/Plank/${wantSec}s row`
      : `the approved modality write did not land as exactly one session-attributed timed_hold/Plank/${wantSec}s row`);
    return preview;
  }

  // ── Network capture: coach responses + both save routes ────────────────────
  page.on('pageerror', (err) => { pageErrors.push(`[pageerror] ${err && err.message}`); });
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(`[console.error] ${msg.text().slice(0, 500)}`); });
  page.on('response', async (res) => {
    const phase = currentPhaseRef.value;
    const url = res.url();
    if (/\/api\/(log-workout|complete-workout)\b/.test(url)) {
      const endpoint = url.includes('complete-workout') ? 'complete-workout' : 'log-workout';
      const responseHeaders = res.headers();
      const turnIdHeader = typeof responseHeaders['x-atlas-turn-id'] === 'string' ? responseHeaders['x-atlas-turn-id'] : null;
      const pairingHeaderPresent = typeof responseHeaders['x-atlas-turn-pairing'] === 'string';
      try {
        const body = await res.json();
        const layers = [body, body && body.data, body && body.data && body.data.data].filter((l) => l && typeof l === 'object');
        const data = layers.find((l) => 'test_mode' in l || 'sheet_write' in l || 'sheet_written' in l) || null;
        saveResponses.push({
          phase, at: Date.now(), endpoint, status: res.status(),
          test_mode: data ? data.test_mode : undefined,
          sheet_written: data ? data.sheet_written : undefined,
          no_write_confirmed: data ? data.no_write_confirmed : undefined,
          sheet_write: data ? data.sheet_write : undefined,
          capture_failed: data ? false : true,
          turn_id_header: turnIdHeader, pairing_header_present: pairingHeaderPresent,
        });
      } catch {
        saveResponses.push({ phase, at: Date.now(), endpoint, status: null, capture_failed: true, turn_id_header: turnIdHeader, pairing_header_present: pairingHeaderPresent });
      }
      return;
    }
    if (!/\/api\/coach\/(chat|ask|message)\b/.test(url)) return;
    let parsed = null;
    let parseFailed = false;
    try { parsed = await res.json(); } catch { parseFailed = true; }
    const data = (parsed && parsed.data && typeof parsed.data === 'object') ? parsed.data : parsed;
    coachResponses.push({
      phase,
      source: data && typeof data.source === 'string' ? data.source : null,
      model: data && typeof data.model === 'string' ? data.model : null,
    });
    const capture = classifyCoachResponseCapture({ status: res.status(), body: parsed, parseFailed });
    if (capture.outcome === 'served') servedReplies.push(capture.message);
    else if (capture.outcome === 'capture-failed') { coachCaptureFailures.count += 1; note('coach-capture-failed', capture.reason); }
  });

  // ── 1. Seam + posture in the serving process ───────────────────────────────
  const st0 = await gateState();
  beat('persona-seam-armed', Boolean(st0.persona) && st0.persona.slug === PERSONA.slug,
    `gate state persona: ${JSON.stringify(st0.persona)}`);
  beat('combined-sandbox-live-posture', st0.sandbox_live === true && st0.ledger_sandbox === true
    && Boolean(st0.sandbox_preflight) && st0.sandbox_preflight.ok === true,
  `sandbox_live=${st0.sandbox_live} ledger_sandbox=${st0.ledger_sandbox} sandbox_preflight_ok=${st0.sandbox_preflight && st0.sandbox_preflight.ok}`);
  const countBefore = parseCanonicalRehearsalCount(PLAN_TEXT_BEFORE);

  // ── 2. Open the app; accept the declared plan ──────────────────────────────
  await page.exposeFunction('__atlasBubbleObserved', onBubblesObserved);
  await page.addInitScript(bubbleObserverInitScript, {
    flushMs: OBSERVER_FLUSH_MS, threadId: 'thread-messages', bubbleSelector: '.chat-bubble-atlas',
    callbackName: '__atlasBubbleObserved', flushName: '__atlasBubbleFlush', stateName: '__atlasBubbleState',
    readName: '__atlasBubbleRead', boundaryName: '__atlasWriteBoundary', idAttr: BUBBLE_ID_ATTR, seqAttr: BUBBLE_SEQ_ATTR,
  });
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, GATE_KEY);
  await page.goto(`${base}/app/`);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => typeof window.atlasAcceptPlan === 'function', null, { timeout: APP_READINESS_TIMEOUT_MS });
  const shellBuild = await page.evaluate(() => (document.getElementById('shell-version')?.textContent || '').trim());
  const buildIdentity = checkServedBuildIdentity({ repoRoot: REPO_ROOT, sourceHeadSha: SOURCE.head_sha, artifactDir: artDir, runId: RUN_ID });
  const servedBuildCommit = buildIdentity.served_commit || null;
  const idBefore = await page.evaluate(() => document.getElementById('log-session-id').value);
  beat('no-preseeded-identity', idBefore === '', `#log-session-id before acceptance: "${idBefore}"`);
  currentPhaseRef.value = 'acceptance';
  const started = await page.evaluate(({ plan, why }) => window.atlasAcceptPlan({
    id: 'work_day', label: 'Work', why_today: why, exercises: plan,
  }), { plan: PERSONA.plan, why: `Persona scenario — ${PERSONA.slug} (Slice 2b, scored).` });
  beat('plan-accepted', Boolean(started && started.started), `atlasAcceptPlan started=${started && started.started}`);
  let workoutId = '';
  await expect.poll(async () => {
    workoutId = await page.evaluate(() => document.getElementById('log-session-id').value.trim());
    return workoutId;
  }, { timeout: 30000 }).toMatch(/^\d{8}-(AM|PM)-\d{2}$/i);
  const planSessionId = await page.evaluate(() => (window.getActivePlannedSession() || {}).session_id || '');
  stateCheck('adopted-id-everywhere', planSessionId === workoutId, `plan carries ${planSessionId}; field shows ${workoutId}`);
  const remainingAtAcceptance = await page.evaluate(() => (window.remainingPlannedExercises
    ? window.remainingPlannedExercises().map((e) => e.canonicalName || e.name || String(e)) : null));
  stateCheck('plan-slots-open', Array.isArray(remainingAtAcceptance) && remainingAtAcceptance.length === PERSONA.plan.length,
    `remaining at acceptance: ${JSON.stringify(remainingAtAcceptance)}`);
  await page.screenshot({ path: path.join(artDir, '01-plan-accepted.png'), fullPage: true }).catch(() => {});

  // ── 3. The declared beats, in fixture order ────────────────────────────────
  // Slug-dispatched: the turn section is the one persona-specific part of
  // the driver (the instruments around it are shared). Marcus's branch is
  // his Slice 2b sequence verbatim, re-indented only; Priya's follows her
  // fixture's beats in script order. The dispatch above already refused
  // any other slug, so the else branch is Marcus.
  if (SLUG === 'priya') {
    const { squatSets, benchSets, turnTexts } = scenario;
    await runTurn('beat-plan-ask', 'eligible_question', turnTexts.planAsk, null);
    await runTurn('beat-rir-question', 'eligible_question', turnTexts.rirQuestion, null);
    await runTurn('beat-squat-log', 'squat-log', turnTexts.squatLog, squatSets.length);
    await bufferCheck('parsed-sets-after-squat', squatSets);
    // The bench turn is interrogative, not imperative ("Is that bad??") —
    // the live path must log 25 x 8 x3 from the question plus the plan,
    // with RIR null (golden SC7-PRIYA-02). If it cannot, this beat fails
    // honestly and the run continues to judging: that is a parse-recovery
    // finding, not a driver defect.
    await runTurn('beat-bench-form-bail', 'bench-form-bail', turnTexts.benchBail, squatSets.length + benchSets.length);
    await bufferCheck('parsed-sets-after-bench', [...squatSets, ...benchSets]);
    // The revision moment: the bench target moves 10 → 8 on form here, so
    // the mutation boundary is taken now — after it, a completed-change
    // claim is earned; before it, it is not. (Marcus takes his at the
    // correction beat; Priya has no correction beat, by design.)
    mutationBoundary = await takeBoundary();
    // The mixed turn: rows sets plus the plank hold in ONE message, the
    // script's shape. Its product surface is the MODALITY PREVIEW, not a
    // coach bubble — the resistance half does not parse (prose turn; see
    // the #1659 re-fix handback) so the turn stages the plank preview
    // instead of logging, and the driver approves that preview explicitly
    // here, before the next submit clears it (#1659). The buffer multiset
    // check below is still the assertion for the rows sets; it fails
    // honestly while the prose-parse finding stands, and the modality
    // write is judged by the durable plank row + the plank fact check.
    await runModalityTurn('beat-rows-and-plank', 'rows-and-plank', turnTexts.rowsPlank);
    finalBuffer = await bufferCheck('parsed-sets-after-rows-plank', expectedSets);
    stateCheck('buffer-equals-declaration-after-rows-plank',
      beats.find((b) => b.id === 'parsed-sets-after-rows-plank')?.ok === true,
      'the retained buffer after the final log turn equals the run\'s declared sets');
    await runTurn('beat-progress-doubt', 'progress-doubt', turnTexts.progressDoubt, null);
  } else {
    const {
      squatLineSets, backoffSets, preCorrectionSets,
      squatText, backoffText, batchText, correctionText,
      rdlPlan, correction, fatFingerWeight,
    } = scenario;
    await runTurn('beat-plan-ask', 'eligible_question', 'Plan.', null);
    await runTurn('beat-squat-line', 'squat-warmups-and-top', squatText, squatLineSets.length);
    await bufferCheck('parsed-sets-after-squat', squatLineSets);
    await runTurn('beat-backoffs', 'squat-backoffs', backoffText, squatLineSets.length + backoffSets.length);
    await bufferCheck('parsed-sets-after-backoffs', [...squatLineSets, ...backoffSets]);
    await runTurn('beat-batch', 'bench-rdl-batch', batchText, preCorrectionSets.length);
    await bufferCheck('parsed-sets-after-batch', preCorrectionSets);

    // The correction beat: the retained buffer must reach the corrected
    // end-state, and the mutation boundary is taken at that moment — after it,
    // a completed-change claim is earned; before it, it is not. The poll below
    // is scoped to the corrected lift's sets, matching the authoritative fact
    // (persona-retained-buffer-corrected): another lift may legitimately use
    // the fat-finger weight (the unrevised squat back-offs ARE 285), and a
    // session-wide ban would fail a correct run on that coincidence (#1633).
    await runTurn('beat-correction', 'rdl-correction', correctionText, preCorrectionSets.length);
    let bufferCorrected = false;
    try {
      await expect.poll(async () => {
        const buf = await readBufferSets();
        const rdl = buf.filter((s) => s.lift_code === rdlPlan.lift_code);
        bufferCorrected = rdl.length === correction.sets
          && rdl.every((s) => s.weight === correction.weight)
          && !rdl.some((s) => s.weight === fatFingerWeight);
        return bufferCorrected;
      }, { timeout: 30000 }).toBe(true);
    } catch { /* recorded below */ }
    const bufferAfterCorrection = await bufferCheck('parsed-sets-after-correction', expectedSets);
    beat('correction-landed-in-buffer', bufferCorrected,
      bufferCorrected
        ? `retained buffer carries ${correction.weight} on all ${correction.sets} RDL sets and no ${fatFingerWeight} on any RDL set`
        : 'the retained buffer did not reach the corrected end-state inside the poll window');
    stateCheck('buffer-equals-declaration-after-correction',
      beats.find((b) => b.id === 'parsed-sets-after-correction')?.ok === true,
      'the retained buffer after the correction equals the run\'s declared sets');
    mutationBoundary = await takeBoundary();
    finalBuffer = bufferAfterCorrection;
  }

  // Effort (the script supplies duration only), then the closeout beat. The
  // closeout is sent WITHOUT settleReply: its product surface is the closeout
  // CARD, not a chat bubble (the rehearsal drivers say 'done' the same way) —
  // the first scored run (20261030T001500) waited 90s for a bubble that was
  // never the closeout's shape and misread the flow from there.
  await page.evaluate((mins) => {
    const el = document.getElementById('effort-duration');
    if (el) { el.value = `${mins}:00`; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
  }, closeoutMinutes);
  currentPhaseRef.value = 'closeout';
  await say(closeoutText);
  turns.push({ phase: 'closeout', text: closeoutText, reply: recordsToMessages(bubbleRecords).slice(-2).map((m) => m.text).join(' ⏎ ') });
  beat('beat-closeout', true, 'closeout statement sent; the closeout card is the surface judged next');
  const obsRemaining = await page.evaluate(() => (window.remainingPlannedExercises
    ? window.remainingPlannedExercises().map((e) => e.canonicalName || e.name || String(e)) : null));
  const derivedFinal = deriveExpectedRemaining({ plan: PERSONA.plan, loggedNames, replacement: null });
  stateCheck('remaining-work-final', Array.isArray(obsRemaining)
    && JSON.stringify(obsRemaining.map((s) => String(s).toLowerCase())) === JSON.stringify(derivedFinal.remaining.map((s) => String(s).toLowerCase())),
  `client remaining ${JSON.stringify(obsRemaining)}; derived ${JSON.stringify(derivedFinal.remaining)}`);

  // ── 4. Closeout card, preview, ONE approval, the durable write ─────────────
  currentPhaseRef.value = 'closeout';
  let previewText = '';
  let savedLabel = '';
  let stuckSaving = false;
  let noWorkoutRowsPreApproval = false;
  try {
    await expect(page.locator('.closeout-confirm')).toHaveCount(1, { timeout: 60000 });
    previewText = await page.locator('.closeout-confirm').innerText();
    let preState = null;
    try { preState = await durableRows(workoutId); } catch (e) { preState = e.status === 403 ? { log_cleaned: { rows: [] }, effort: { rows: [] }, modality: { rows: [] } } : null; }
    // #1659 re-fix — the plank's write is already durable by the time this
    // beat runs: it was approved explicitly mid-run (rows-and-plank beat),
    // before the closeout preview existed. That ONE session-attributed
    // timed_hold/Plank row is the approved write, not a pre-approval leak —
    // so the beat allows exactly it, and still requires zero Log_Cleaned
    // and zero Effort rows, and zero modality rows when no mid-run approval
    // was recorded (Marcus).
    const modalityPre = preState && preState.modality && Array.isArray(preState.modality.rows) ? preState.modality.rows : [];
    let approvedModalityPre = false;
    if (approvedModality) {
      approvedModalityPre = modalityPre.length === 1
        && String(modalityPre[0][modalityLogColumns.indexOf('session_id')]).trim() === approvedModality.session_id
        && durableModalityRow(modalityPre[0]).modality === approvedModality.modality
        && /plank/i.test(durableModalityRow(modalityPre[0]).exercise || '')
        && durableModalityRow(modalityPre[0]).durationSec === approvedModality.durationSec;
    } else {
      approvedModalityPre = modalityPre.length === 0;
    }
    noWorkoutRowsPreApproval = Boolean(preState)
      && preState.log_cleaned.rows.length === 0 && preState.effort.rows.length === 0
      && approvedModalityPre;
    beat('no-write-before-approval', noWorkoutRowsPreApproval,
      preState ? `pre-approval durable state: ${preState.log_cleaned.rows.length} log, ${preState.effort.rows.length} effort rows, ${modalityPre.length} modality rows${approvedModality ? ' (1 approved mid-run modality row allowed)' : ''}` : 'pre-approval durable state unreadable');
    const saveControl = page.locator('.review:not(.done) .rv-save');
    await expect(saveControl).toBeVisible({ timeout: 40000 });
    await page.screenshot({ path: path.join(artDir, '02-preview.png'), fullPage: true }).catch(() => {});
    await takeBoundary();
    await saveControl.click();
    await expect(page.locator('.review.done')).toBeVisible({ timeout: 300000 });
    savedLabel = await page.locator('.review.done .rv-saved-txt').innerText().catch(() => '');
    stuckSaving = /saving…/i.test(savedLabel);
    await page.screenshot({ path: path.join(artDir, '03-saved.png'), fullPage: true }).catch(() => {});
  } catch (e) {
    beat('closeout-save-flow', false, `closeout/save flow failed: ${String((e && e.message) || e).slice(0, 300)}`);
  }
  beat('preview-observed', previewText.trim().length > 0, previewText ? 'the closeout preview rendered' : 'no closeout preview text captured');

  // ── 5. Durable state, session-filtered; repeat probe; foreign probe ────────
  // The poll waits on the Log_Cleaned count only: the modality row (Priya's
  // plank) lands through no turn the driver controls, and its absence is a
  // scorecard verdict, not a reason to hang the run — the final durable
  // read below carries whatever modality rows exist by judging time.
  // expectedLogCleaned splits the fixture's log_rows on its declared
  // modality_rows (Marcus: 13 − 0, unchanged).
  const expectedLogCleaned = PERSONA.expected.log_rows - (PERSONA.expected.modality_rows || 0);
  let d = { log_cleaned: { rows: [] }, effort: { rows: [] }, session_plans: { rows: [] }, session_plan_sets: { rows: [] }, modality: { rows: [] } };
  try {
    await expect.poll(async () => {
      try { d = await durableRows(workoutId); } catch { return -1; }
      return d.log_cleaned.rows.length;
    }, { timeout: 240000, intervals: [8000, 12000, 15000, 20000] }).toBe(expectedLogCleaned);
  } catch { beat('durable-log-rows-landed', false, `durable Log_Cleaned rows stuck at ${d.log_cleaned.rows.length} (expected ${expectedLogCleaned})`); }
  const liveWritesBefore = saveResponses.length;
  const repeatClick = await page.evaluate(() => {
    const b = document.getElementById('approve-btn');
    if (!b) return { control_present: false, disabled_at_click: null, dispatched: false };
    let dispatched = false;
    const seen = () => { dispatched = true; };
    b.addEventListener('click', seen, { once: true });
    const disabled = b.disabled === true;
    b.click();
    b.removeEventListener('click', seen);
    return { control_present: true, disabled_at_click: disabled, dispatched };
  });
  await page.waitForTimeout(2500);
  const liveWritesAfter = saveResponses.length;
  const repeatOutcome = classifyRepeatApprovalProbe({
    control_present: repeatClick.control_present,
    disabled_at_click: repeatClick.disabled_at_click,
    dispatched: repeatClick.dispatched,
    live_saves_before: liveWritesBefore,
    live_saves_after: liveWritesAfter,
  });
  note('repeat-approval', `outcome=${repeatOutcome} (control=${repeatClick.control_present}, disabled=${repeatClick.disabled_at_click}, dispatched=${repeatClick.dispatched}, live saves ${liveWritesBefore}→${liveWritesAfter})`);
  let dupRows = 0;
  try {
    const dRetry = await durableRows(workoutId);
    dupRows = (dRetry.log_cleaned.rows.length - d.log_cleaned.rows.length)
      + (dRetry.effort.rows.length - d.effort.rows.length)
      + (dRetry.session_plans.rows.length - d.session_plans.rows.length)
      + (dRetry.session_plan_sets.rows.length - d.session_plan_sets.rows.length)
      + ((dRetry.modality ? dRetry.modality.rows.length : 0) - (d.modality ? d.modality.rows.length : 0));
    d = dRetry;
  } catch { dupRows = -1; }
  let foreignStatus = 0;
  try { await durableRows('20260101-AM-01'); foreignStatus = 200; } catch (e) { foreignStatus = e.status || 0; }

  // ── 6. Weekly summary through the live app ─────────────────────────────────
  const weeklyRes = await fetch(`${base}/api/summary/weekly`, { headers: { 'x-atlas-api-key': GATE_KEY } });
  let weeklyBody = null; try { weeklyBody = await weeklyRes.json(); } catch { weeklyBody = null; }
  const weeklyErrorDetail = weeklyRes.status === 200 ? '' : String((weeklyBody && (weeklyBody.error || weeklyBody.message)) || '(no error body)').slice(0, 300);

  // ── 7. Trace ↔ turn-write-proof join ───────────────────────────────────────
  const parseMarker = (marker) => serverStdout.split('\n').filter((l) => l.includes(marker))
    .map((l) => { try { return JSON.parse(l.slice(l.indexOf(marker) + marker.length).trim()); } catch { return null; } }).filter(Boolean);
  const { join_ok: joined, turn_id: proofTurn, detail: traceJoinDetail } = evaluateTraceWriteJoin({
    traces: parseMarker('[interaction-trace]'), proofs: parseMarker('[turn-write-proof]'),
  });

  // ── 8. Review-tool adjudication against the SANDBOX (read-only) ────────────
  await new Promise((r) => setTimeout(r, 45000));
  const { spawnSync } = require('node:child_process');
  const review = spawnSync(process.execPath, ['scripts/atlas-review-live.js', '--json', `--workout-session=${workoutId}`], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      ...pickNetworkPassthrough(),
      GOOGLE_SHEETS_ID: SANDBOX_SPREADSHEET_ID,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
    },
    encoding: 'utf8', timeout: 240000,
  });
  let reviewJson = null;
  try { reviewJson = JSON.parse(review.stdout.slice(review.stdout.indexOf('{'))); } catch { reviewJson = null; }
  const reviewCriteria = reviewJson && Array.isArray(reviewJson.criteria) ? reviewJson.criteria : [];
  const reviewFailed = reviewCriteria.filter((c) => (c.verdict || c.status) === 'FAIL').map((c) => c.id || c.name);
  const reviewAllUnknown = reviewCriteria.length === 0
    || (reviewJson && reviewJson.overall === 'UNKNOWN')
    || reviewCriteria.every((c) => (c.verdict || c.status) === 'UNKNOWN');
  const reviewCorr = (reviewJson && reviewJson.log_correlation) || null;
  const reviewCorrIds = reviewCorr && Array.isArray(reviewCorr.distinct_session_ids)
    ? reviewCorr.distinct_session_ids.map((s) => String(s).trim()) : [];
  const reviewFound = review.status === 0
    && Boolean(reviewJson)
    && reviewJson.overall === 'PASS'
    && reviewCriteria.length > 0
    && Boolean(reviewCorr)
    && reviewCorr.ambiguous !== true
    && reviewCorrIds.length > 0
    && reviewCorrIds.every((id) => id === workoutId);

  // ── 9. The eligible-question proof, completed if the first ask fell short ──
  // The proof phases are the ask turns: Marcus's plan-ask, Priya's plan-ask
  // and RIR question (both 'eligible_question'), plus Priya's progress-doubt
  // turn, which carries its own phase so the two distinct beats are never
  // conflated — but a live Gemini reply on either ask family still proves a
  // live provider turn was observed. Marcus never runs progress-doubt, so
  // this filter behaves identically for him.
  const ELIGIBLE_QUESTION_PHASES = new Set(['eligible_question', 'progress-doubt']);
  let geminiEligible = coachResponses.filter((r) => ELIGIBLE_QUESTION_PHASES.has(r.phase) && r.source === 'gemini');
  if (geminiEligible.length === 0) {
    await runTurn('beat-eligible-retry', 'eligible_question', 'One more thing - anything I should focus on for recovery tonight?', null);
    geminiEligible = coachResponses.filter((r) => ELIGIBLE_QUESTION_PHASES.has(r.phase) && r.source === 'gemini');
    try {
      const after = await durableRows(workoutId);
      beat('question-turn-writes-nothing', after.log_cleaned.rows.length === d.log_cleaned.rows.length,
        `Log_Cleaned rows after the question turn: ${after.log_cleaned.rows.length} (was ${d.log_cleaned.rows.length})`);
    } catch { /* the durable comparison above already recorded the state */ }
  }

  // ── 10. Claim sweeps over everything the athlete was shown ─────────────────
  try {
    const samples = await page.evaluate(() => (typeof window.__atlasWriteBoundary === 'function' ? window.__atlasWriteBoundary() : null));
    if (Array.isArray(samples)) writeBoundarySamples = samples;
  } catch { writeBoundarySamples = []; }
  const liveWriteBoundary = (() => {
    const live = saveResponses.filter((r) => r.capture_failed !== true && r.test_mode !== true && r.sheet_write === 'success');
    if (!live.length) return null;
    return makeBoundary({ atMs: live[0].at, atChangeSeq: pairLiveWriteChangeSeq(saveResponses, writeBoundarySamples), drained: false });
  })();
  await settleBubbleCollector();
  const visibleMessages = recordsToMessages(bubbleRecords);
  // Astra P1-3 (#1661): the sweeps judge claims against the SPECIFIC
  // mutations this run actually made, not one global boundary. Each mutation
  // is supplied only when the buffer check that verifies it passed — a
  // mutation the buffer never reached is not recorded, so a claim asserting
  // it is judged against the global boundary instead of the mutation's own.
  // That omission cannot rescue a red run: a failed verifying beat already
  // fails the run via the beats condition. The performed
  // sets are supplied only when the final buffer equals the declaration, for
  // the same reason. The mutation's phase is the beat that made it; the
  // detector orders phases by their first appearance in the thread, so an
  // in-turn confirmation — rendered by the turn that applied the change,
  // before the boundary is taken — is earned.
  const benchMutationOk = beats.find((b) => b.id === 'parsed-sets-after-bench')?.ok === true;
  const correctionMutationOk = beats.find((b) => b.id === 'parsed-sets-after-correction')?.ok === true;
  const finalBufferOk = beats.find((b) => b.id === (SLUG === 'priya' ? 'parsed-sets-after-rows-plank' : 'parsed-sets-after-correction'))?.ok === true;
  const scoredMutations = SLUG === 'priya' && benchMutationOk
    ? [{ lift: scenario.benchRevised.exercise, weight: scenario.benchRevised.weight, reps: scenario.benchRevised.reps, sets: scenario.benchRevised.sets, phase: 'bench-form-bail' }]
    : SLUG === 'marcus' && correctionMutationOk
      ? [{ lift: scenario.correction.exercise, weight: scenario.correction.weight, reps: scenario.correction.reps, sets: scenario.correction.sets, phase: 'rdl-correction' }]
      : [];
  // Phase-tagged performed sets (Astra re-audit, #1661 reopened): the
  // observed state at each message's phase. The correction/revision moves
  // one lift's numbers mid-run; judging every message against the final
  // sets false-reds a truthful pre-correction confirmation (Marcus RDL
  // 285) and false-greens a pre-correction claim about the corrected
  // numbers (Priya bench 25x8 before the bail). Baseline = the sets as
  // they stood before the correction beat; the corrected lift's final
  // numbers carry the correction phase, so messages at/after that phase
  // are judged against them and earlier messages against the baseline.
  // Marcus: the batch beat verified preCorrectionSets (RDL at the
  // fat-finger weight). Priya: only the corrected bench sets are
  // phase-tagged — the 25x10 plan was never a performed set, so a pre-bail
  // bench recap fails closed as "no sets yet at this phase". Same
  // finalBufferOk gate as before: no sets are supplied when the final
  // buffer did not equal the declaration.
  const scoredActualSets = (() => {
    if (!finalBufferOk) return null;
    const toActual = (s) => ({ lift: s.exercise, weight: s.weight, reps: s.reps });
    if (SLUG === 'marcus') {
      const corrected = Array.from({ length: scenario.correction.sets },
        () => ({ lift: scenario.correction.exercise, weight: scenario.correction.weight, reps: scenario.correction.reps, phase: 'rdl-correction' }));
      return [...scenario.preCorrectionSets.map(toActual), ...corrected];
    }
    if (SLUG === 'priya') {
      const corrected = scenario.benchSets.map((s) => ({ ...toActual(s), phase: 'bench-form-bail' }));
      return [...scenario.expectedSets.filter((s) => s.exercise !== scenario.benchPlan.exercise).map(toActual), ...corrected];
    }
    return expectedSets.map(toActual);
  })();
  const mutationSweep = detectUnsupportedMutationWording({
    messages: visibleMessages,
    mutationBoundary,
    ...(scoredMutations.length ? { mutations: scoredMutations } : {}),
    ...(scoredActualSets ? { actualSets: scoredActualSets } : {}),
  });
  const writeSweep = detectUnsupportedWriteClaim({ messages: visibleMessages, liveWriteBoundary });
  const claims = {
    unsupported_mutation_wording: mutationSweep.unsupported,
    unsupported_write_claim: writeSweep.unsupported,
    detail: [mutationSweep.detail, writeSweep.detail].filter(Boolean).join(' | '),
    records: visibleMessages.map((m) => ({
      id: (m.id === null || m.id === undefined) ? null : String(m.id),
      phase: m.phase || 'unknown',
      retroactive: m.retroactive === true,
      placeholder: m.placeholder === true,
      change_seq: Number.isFinite(m.changeSeq) ? m.changeSeq : null,
      swept_at_change_seq: Number.isFinite(m.sweptAtChangeSeq) ? m.sweptAtChangeSeq : null,
    })),
    boundaries: {
      write: liveWriteBoundary ? { atMs: liveWriteBoundary.atMs, atChangeSeq: liveWriteBoundary.atChangeSeq, drained: liveWriteBoundary.drained } : null,
      mutation: mutationBoundary ? { atMs: mutationBoundary.atMs, atChangeSeq: mutationBoundary.atChangeSeq, drained: mutationBoundary.drained } : null,
    },
  };

  // ── 11. Persona fact checks (design §3.4) ──────────────────────────────────
  // The buffer moment differs by persona (Marcus: after the correction;
  // Priya: after the final log turn), so the detail names it — a Priya
  // detail must never claim a correction that never happened.
  // The modality rows for THIS session only, for the plank check (#1663):
  // the fact checker judges the modality row's content (a plank timed hold
  // at todaySec), not just the count a treadmill row could stand in for.
  // Null when the verifier returned no modality surface at all — the check
  // then fails closed on the unproven measurement.
  const modSidIdx = modalityLogColumns.indexOf('session_id');
  const sessionModalityRows = d.modality
    ? d.modality.rows.filter((r) => String(r[modSidIdx]).trim() === workoutId)
    : null;
  const personaFacts = checkPersonaFacts({
    fixture: PERSONA,
    expectedSets,
    loggedNames,
    bufferSets: finalBuffer,
    durableLogRows: d.log_cleaned.rows,
    durableModalityRows: sessionModalityRows,
    observedRemaining: obsRemaining,
    ...(SLUG === 'priya' ? {
      bufferContext: 'after the final log turn',
      bufferNote: '(revised bench target in place, every other lift untouched)',
    } : {}),
  });
  for (const c of personaFacts.checks) beat(c.id, c.ok, c.detail);

  // ── 12. Assemble observations for the scorecard ────────────────────────────
  const finalState = await gateState().catch(() => ({}));
  const spRows = d.session_plans.rows;
  const spsRows = d.session_plan_sets.rows;
  const spEvIdx = sessionPlansColumns.indexOf('event_type');
  const eventCounts = {};
  for (const r of spRows) eventCounts[String(r[spEvIdx] || '')] = (eventCounts[String(r[spEvIdx] || '')] || 0) + 1;
  const spsSealIdx = sessionPlanSetsColumns.indexOf('closeout_write_id');
  const spsSrcIdx = sessionPlanSetsColumns.indexOf('recommendation_source');
  const spsItemIdx = sessionPlanSetsColumns.indexOf('plan_item_id');
  const spsCountIdx = sessionPlanSetsColumns.indexOf('target_set_count');
  const spsLiftIdx = sessionPlanSetsColumns.indexOf('planned_lift_code');
  const seals = [...new Set(spsRows.map((r) => String(r[spsSealIdx] || '').trim()))];
  const acceptedRows = spsRows.filter((r) => String(r[spsSrcIdx] || '') === 'accepted');
  const acceptedItems = [...new Set(acceptedRows.map((r) => String(r[spsItemIdx] || '')))];
  const declaredSetCount = new Map(PERSONA.plan.map((p) => [String(p.lift_code).toUpperCase(), p.target_sets]));
  const grainOk = acceptedItems.length === PERSONA.plan.length
    && acceptedRows.every((r) => {
      const want = declaredSetCount.get(String(r[spsLiftIdx] || '').trim().toUpperCase());
      return want != null && Number(r[spsCountIdx]) === want;
    });
  const ledgerCmp = compareLedgerToDeclaration(spsRows, {
    accepted: PERSONA.plan.map((p) => ({
      lift: p.lift_code, set_count: p.target_sets, weight: p.target_weight, reps: p.target_reps, rir: p.target_rir,
    })),
    revisions: null,
    confidence: 'reliable',
  });
  const sidIdx = {
    log: logCleanedColumns.indexOf('session_id'), eff: effortColumns.indexOf('session_id'),
    sp: sessionPlansColumns.indexOf('session_id'), sps: sessionPlanSetsColumns.indexOf('session_id'),
    mod: modalityLogColumns.indexOf('session_id'),
  };
  const foreignRows = d.log_cleaned.rows.filter((r) => String(r[sidIdx.log]).trim() !== workoutId).length
    + d.effort.rows.filter((r) => String(r[sidIdx.eff]).trim() !== workoutId).length
    + spRows.filter((r) => String(r[sidIdx.sp]).trim() !== workoutId).length
    + spsRows.filter((r) => String(r[sidIdx.sps]).trim() !== workoutId).length
    + (d.modality ? d.modality.rows.filter((r) => String(r[sidIdx.mod]).trim() !== workoutId).length : 0);
  const previews = saveResponses.filter((r) => r.capture_failed !== true && r.test_mode === true);
  const lives = saveResponses.filter((r) => r.capture_failed !== true && r.test_mode !== true);
  const lastPreview = previews[previews.length - 1] || null;
  const firstLive = lives[0] || null;
  const quotaLines = serverStdout.split('\n').filter((l) => /quota|429|RESOURCE_EXHAUSTED/i.test(l)).slice(0, 10);
  const planTextAfter = (() => { try { return fs.readFileSync(path.join(REPO_ROOT, PLAN_RELATIVE_PATH), 'utf8'); } catch { return ''; } })();
  const countAfter = parseCanonicalRehearsalCount(planTextAfter);
  beat('canonical-count-untouched', countBefore.ok === countAfter.ok && countBefore.count === countAfter.count && planTextAfter === PLAN_TEXT_BEFORE,
    `count before ${JSON.stringify(countBefore)}; after ${JSON.stringify(countAfter)}; plan text identical: ${planTextAfter === PLAN_TEXT_BEFORE}`);
  const observations = {
    run_purpose: PERSONA_RUN, persona_slug: SLUG, session_number: undefined,
    run_id: RUN_ID, athlete_id: ATHLETE_ID,
    workout_session_id: workoutId, workout_id_preseeded: false,
    source: { ...SOURCE, prior_rehearsal_count: countBefore.ok ? countBefore.count : null, prior_count_reason: countBefore.ok ? null : 'canonical count unparsable in the run checkout' },
    model: {
      posture: /GATE_MODEL_POSTURE=model-up/.test(serverStdout) ? 'model-up' : 'model-down',
      provider_reachable: finalState.provider_reachable === true,
      coach_model: finalState.coach_model || '',
      live_provider_turn_observed: geminiEligible.length > 0,
    },
    sandbox: {
      rehearsal_live: finalState.sandbox_live === true,
      sandbox_last6: finalState.sandbox_last6 || '',
      declared_last6: SANDBOX_SPREADSHEET_ID_LAST6,
      preflight_ok: finalState.sandbox_preflight && finalState.sandbox_preflight.ok === true,
      preflight_checks: (finalState.sandbox_preflight && finalState.sandbox_preflight.checks) || [],
      child_carried_workbook_id: false,
    },
    ui: { real_browser: true, shell_build: shellBuild, build_commit: servedBuildCommit },
    provenance: {
      request_origin: await page.evaluate(() => (navigator.webdriver === true ? 'playwright' : 'athlete_ui')),
      real_index_js: Boolean(finalState.ledger_sandbox !== undefined),
    },
    scenario: { id: `persona-${SLUG}`, beats, expected: PERSONA.expected },
    claims,
    state_agreement: stateChecks,
    durable: {
      session_plans: { event_counts: Object.entries(eventCounts).map(([event, count]) => ({ event, count })) },
      session_plan_sets: {
        row_count: spsRows.length,
        distinct_seals: seals.filter((s) => s !== '').length,
        blank_seals: spsRows.filter((r) => String(r[spsSealIdx] || '').trim() === '').length,
        accepted_grain_ok: grainOk,
        grain_detail: `${acceptedItems.length} accepted items of ${PERSONA.plan.length} declared`,
        declared_multiset_ok: ledgerCmp.ok,
        multiset_detail: ledgerCmp.ok ? '' : (ledgerCmp.problems || []).slice(0, 6).join('; '),
      },
      log_cleaned: {
        row_count: d.log_cleaned.rows.length,
        rows_match_declaration: personaFacts.checks.find((c) => c.id === 'persona-parsed-set-equality')?.ok === true,
        detail: (personaFacts.checks.find((c) => c.id === 'persona-parsed-set-equality') || {}).detail || '',
      },
      modality: {
        row_count: d.modality ? d.modality.rows.length : 0,
        // The content, not just the count (#1663): a row_count-only
        // observation let a 5-second treadmill row stand in for the plank.
        plank: (() => {
          const rows = (sessionModalityRows || []).map(durableModalityRow);
          const named = rows.filter((m) => /plank/i.test(m.exercise || ''));
          const row = named[0] || null;
          return {
            found: named.length === 1,
            row_count: named.length,
            duration_sec: row && Number.isFinite(row.durationSec) ? row.durationSec : null,
            modality: row ? row.modality : null,
          };
        })(),
      },
      effort: { row_count: d.effort.rows.length },
      foreign_rows: foreignRows,
      foreign_id_probe_status: foreignStatus,
    },
    write: {
      preview_seen: previews.length > 0,
      preview_no_write_confirmed: Boolean(lastPreview && lastPreview.sheet_written === false && lastPreview.no_write_confirmed === true) && noWorkoutRowsPreApproval,
      preview_before_write: Boolean(lastPreview && firstLive && lastPreview.at < firstLive.at),
      approvals_clicked: 1,
      write_success: Boolean(firstLive && firstLive.sheet_write === 'success')
        && d.log_cleaned.rows.length + (d.modality ? d.modality.rows.length : 0) === PERSONA.expected.log_rows,
      repeat_attempted: repeatOutcome !== 'no-op-unproven',
      repeat_outcome: repeatOutcome,
      duplicate_rows: dupRows,
    },
    closeout: {
      fully_verified: seals.filter((s) => s !== '').length === 1 && spsRows.every((r) => String(r[spsSealIdx] || '').trim() !== ''),
      ui_stuck_saving: stuckSaving,
      final_state_ok: savedLabel.trim().length > 0,
      detail: savedLabel.trim(),
    },
    trace: { join_ok: joined, turn_id: proofTurn, detail: traceJoinDetail },
    review: { found_exact_session: reviewFound, all_unknown: reviewAllUnknown, failed_criteria: reviewFailed },
    weekly: { status: weeklyRes.status, valid_body: Boolean(weeklyBody && typeof weeklyBody === 'object' && !weeklyBody.error), detail: weeklyErrorDetail },
    guard: {
      ensure_tab_calls: (finalState.ensure_tab_calls || []).length,
      refusals: (finalState.refusals || []).length,
      seal_updates: (finalState.updates || []).filter((u) => u.live === true && !u.failed).length,
    },
    artifacts: { swept: false, leaks: [], files: [] },
  };

  // ── 13. Evidence, privacy sweep + hashes over FINAL bytes, then score ─────
  // #1664: the sweep and the hashes must certify the bytes as published,
  // after the last write. The old order swept first and wrote after — the
  // scorecard files, the rewritten evidence, and afterAll's raw log +
  // pageerrors were never swept or hashed, and the recorded hashes went
  // stale. The new order:
  //   1. write every content artifact (fully redacted log, pageerrors);
  //   2. provisional sweep + score (conditions 23/24 judge this record);
  //   3. write the scorecard files + the evidence (provisional record);
  //   4. final sweep over every file except the evidence file itself, then
  //      rewrite the evidence with the final record;
  //   5. post-write verification: rescan + rehash every published byte.
  // After step 5 nothing writes to the artifact dir (afterAll stands down —
  // see artifactsFinalized). One disclosed limit: the scorecard's
  // condition-24 detail names the provisional artifact count (the scorecard
  // is written before the final sweep adds its own two files); the PASS
  // status is identical under the final record, and the evidence file's
  // final record is the verified authority. The log and pageerrors are the
  // snapshot at finalization — output after that point is not published.
  const forbidden = buildForbiddenSecrets();
  // 1. Every content artifact is written before any sweep runs. The log is
  // fully redacted (every forbidden value), not just the workbook id.
  fs.writeFileSync(path.join(artDir, 'server-log.txt'), redactSecrets(serverStdout, forbidden));
  fs.writeFileSync(path.join(artDir, 'pageerrors.txt'), pageErrors.join('\n\n') || '(no page errors captured)');
  const evidence = {
    kind: 'PERSONA_SCORECARD',
    ok: false, // replaced after scoring, below — the file on disk is rewritten
    started: true,
    at: startedAt,
    run_id: RUN_ID,
    athlete_id: ATHLETE_ID,
    purpose: PERSONA_RUN,
    rehearsal_eligible: isQualifyingPurpose(RUN_PURPOSE),
    persona: { slug: PERSONA.slug, source_ref: PERSONA.sourceRef, history_mode: PERSONA.historyMode },
    posture: { sheets: 'sandbox workbook (combined sandbox-live)', model: 'up' },
    source_sha: SOURCE.head_sha,
    workout_session_id: workoutId,
    declaration,
    turns,
    persona_facts: personaFacts,
    review_checklist: PERSONA.reviewChecklist,
    canonical_count_before: countBefore,
    canonical_count_after: countAfter,
    quota_lines: quotaLines,
    notes,
    observations,
  };
  // 2. Provisional sweep: the scoring input. Its leaks list and file hashes
  // are re-verified over the final bytes in step 5; a file that changed
  // between the sweeps fails the run in step 4.
  const provisional = sweepArtifactDir(artDir, forbidden);
  observations.artifacts = { ...provisional, self_excluded: EVIDENCE_FILENAME };
  const scorecard = scoreRehearsalRun(observations);
  const scorecardJson = JSON.stringify(scorecard, null, 2);
  const scorecardMd = renderMarkdown(scorecard);
  for (const [label, text] of [['scorecard.json', scorecardJson], ['SCORECARD.md', scorecardMd]]) {
    const leak = forbidden.scan.find((f) => f.re.test(text));
    expect(leak, `${label} would publish a forbidden value (${leak && leak.kind})`).toBeUndefined();
  }
  // 3. The scorecard files and the evidence (provisional record).
  fs.writeFileSync(path.join(artDir, 'scorecard.json'), scorecardJson);
  fs.writeFileSync(path.join(artDir, 'SCORECARD.md'), scorecardMd);
  evidence.ok = scorecard.overall === 'PASS' && personaFacts.ok;
  evidence.scorecard = { overall: scorecard.overall, counts: scorecard.counts, rehearsal_eligible: scorecard.rehearsal_eligible };
  fs.writeFileSync(path.join(artDir, 'persona-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  // 4. Final sweep over the published bytes, except the evidence file
  // itself: the record cannot hash its own container, so the evidence file
  // is excluded from its own file list and the exclusion is recorded. A
  // leak in the final bytes, or a file that changed since the provisional
  // sweep, fails the run here — no clean record is published over them.
  const finalRecord = sweepArtifactDir(artDir, forbidden, { excludeNames: [EVIDENCE_FILENAME] });
  if (finalRecord.leaks.length) {
    throw new Error(`persona artifacts leak in final bytes: ${finalRecord.leaks.join(', ')}`);
  }
  for (const f of provisional.files) {
    const now = finalRecord.files.find((g) => g.name === f.name);
    if (!now || now.sha256 !== f.sha256) {
      throw new Error(`persona artifact ${f.name} changed after the provisional sweep — the scorecard judged stale bytes`);
    }
  }
  observations.artifacts = { ...finalRecord, self_excluded: EVIDENCE_FILENAME };
  fs.writeFileSync(path.join(artDir, 'persona-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  // 5. Post-write verification: rescan + rehash every published byte,
  // including the rewritten evidence file. After this step nothing writes
  // to the artifact dir on the success path (a failed verification leaves
  // artifactsFinalized false, and afterAll publishes redacted diagnostics
  // for the already-failed run instead).
  verifyFinalArtifacts(artDir, observations.artifacts, forbidden, { selfExcludedName: EVIDENCE_FILENAME });
  artifactsFinalized = true;

  const notPassing = scorecard.conditions.filter((c) => c.status !== 'PASS');
  if (notPassing.length) {
    console.error('\n[persona] conditions not passing:');
    for (const c of notPassing) console.error(`  ${c.status}  ${c.id} — ${c.detail}`);
  }
  expect(personaFacts.ok, `persona fact checks failed: ${personaFacts.checks.filter((c) => !c.ok).map((c) => c.id).join(', ')}`).toBe(true);
  expect(scorecard.overall, notPassing.map((c) => `${c.id}=${c.status}`).join(', ') || 'see SCORECARD.md').toBe('PASS');
  expect(scorecard.rehearsal_eligible, 'a persona run must publish rehearsal_eligible=false').toBe(false);
});
