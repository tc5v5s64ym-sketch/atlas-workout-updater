'use strict';
/*
 * PHASE 4 STAGE-A CANARY — temporary Phase 4 machinery.
 *
 * One small, complete, deterministic synthetic workout driven end to end through:
 *   Playwright browser → real built Atlas client → real local Express (index.js)
 *   → real parser / router / session / coach / validator paths
 *   → the repository-declared sandbox Google Sheet
 *   → browser preview → browser approve → durable Log_Cleaned + Effort write
 *   → closeout/seal → InteractionTrace → turn-write proof → mechanical scorecard.
 *
 * This spec PROVES the machine path holds for a whole session before the owner spends a
 * real workout on it. It is NOT a Stage A session: it produces canary evidence only and
 * never advances the Stage A 0/5 streak.
 *
 * It runs ONLY under ATLAS_GATE_SANDBOX_LIVE=1 (playwright.config.js ignores this file
 * otherwise), and only via `npm run atlas:stage-a-canary`, which builds the child
 * environment explicitly. It is never collected by the default credential-free CI lane.
 *
 * This file OBSERVES; it does not judge. Every assertion that decides the run lives in
 * tests/e2e/gate/stage-a-canary-scorecard.js, so the bar is a frozen list that unit tests
 * can attack, rather than a set of expects that can be deleted one at a time.
 *
 * Sunset: deleted in the same PR that records Stage A at 5/5 (see the execution plan).
 */

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { scoreCanary, renderMarkdown } = require('./stage-a-canary-scorecard');
const { pickNetworkPassthrough, assertNoWorkbookId } = require('./canary-child-env');
const { SANDBOX_SPREADSHEET_ID, SANDBOX_SPREADSHEET_ID_LAST6 } = require('../../../config/sandboxSheet');
const { logCleanedColumns, effortColumns } = require('../../../config/columns');

const GATE_KEY = 'playwright-gate-key';
const MODE = process.env.ATLAS_CANARY_MODE === 'model-up' ? 'model-up' : 'model-down';
const RUN_ID = process.env.ATLAS_CANARY_RUN_ID;
const SESSION_ID = process.env.ATLAS_CANARY_SESSION_ID;
const ATHLETE_ID = process.env.ATLAS_CANARY_ATHLETE_ID;
const ARTIFACT_DIR = process.env.ATLAS_CANARY_ARTIFACT_DIR;

// ── the deterministic synthetic workout ─────────────────────────────────────────
// Two exercises, four sets — small, complete, and genuinely representative. The loads
// mirror the catalog the app already resolves, so identity resolution does real work.
const WORKOUT = Object.freeze([
  { exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2, say: '225 5/2' },
  { exercise: 'Back Squat', set_number: 2, weight: 225, reps: 5, rir: 2, say: '225 5/2' },
  { exercise: 'Bench Press', set_number: 1, weight: 185, reps: 8, rir: 3, say: '185 8/3' },
  { exercise: 'Bench Press', set_number: 2, weight: 185, reps: 7, rir: 2, say: '185 7/2' },
]);
const EFFORT = Object.freeze({
  duration: '44:30', active_calories: 366, total_calories: 488, average_hr: 124, peak_hr: 159,
});

let child = null;
let base = null;
let stateBase = null;
let artDir = null;
let serverStdout = '';
const timeline = [];

function note(step, detail) {
  timeline.push({ at: new Date().toISOString(), step, detail });
}

// The durable read pulls the whole sandbox workbook (thousands of rows), so a cold first call
// can be slow enough for the socket to reset. A transient read failure proves NOTHING about the
// product, so it is retried rather than allowed to become a false FAIL — but the retry is on the
// READ only, never on a write, and it gives up rather than returning a guess.
async function readJson(url, what) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body && body.error) throw new Error(String(body.error));
      return body;
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`Stage-A canary: ${what} failed after 4 attempts — ${lastError && lastError.message}`);
}

async function serverState() {
  return readJson(`${stateBase}/`, 'harness state read');
}

// The harness-side READ-ONLY verifier: what the WORKBOOK holds, not what the app believes.
async function durableRows(sessionId) {
  return readJson(`${stateBase}/durable-rows?session_id=${encodeURIComponent(sessionId)}`, 'durable row read');
}

async function snap(page, name) {
  await page.screenshot({ path: path.join(artDir, name), fullPage: true });
}

async function say(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
  note('say', text);
}

async function expectLoggedCount(page, n) {
  await expect.poll(() => page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : -1)),
    { timeout: 25000 }).toBe(n);
}

// Store-truth settle: a parsed set commits live in the chat-first flow.
async function logSet(page, text, expectAfter) {
  await say(page, text);
  await expectLoggedCount(page, expectAfter);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (!RUN_ID || !SESSION_ID || !ATHLETE_ID || !ARTIFACT_DIR) {
    throw new Error('Stage-A canary: run it through `npm run atlas:stage-a-canary` — the unique run/session/athlete ids and artifact dir are minted there, never here.');
  }
  artDir = ARTIFACT_DIR;
  fs.mkdirSync(artDir, { recursive: true });

  // The child environment is CONSTRUCTED, never inherited. `...process.env` is deliberately
  // absent: the ambient GOOGLE_SHEETS_ID resolves to a NON-sandbox workbook here, and a
  // spread would carry it — plus every other ambient flag — into a write-enabled server.
  // Only the values named below cross this boundary.
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    // Proxy routing and CA trust only — see canary-child-env.js.
    ...pickNetworkPassthrough(),
    ATLAS_GATE_KEY: GATE_KEY,
    ATLAS_GATE_SANDBOX_LIVE: '1',
    // The canonical trace + turn-write-proof formats. Log-only: no Sheet, no new tab.
    ATLAS_INTERACTION_TRACE: 'shadow',
    // Credentials for the sandbox connection only. The workbook id is NOT passed —
    // gate-server.js assigns it from config/sandboxSheet.js so there is exactly one source.
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
  };
  if (MODE === 'model-up') {
    childEnv.ATLAS_GATE_MODEL_UP = '1';
    childEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (process.env.GEMINI_COACH_MODEL) childEnv.GEMINI_COACH_MODEL = process.env.GEMINI_COACH_MODEL;
  }

  assertNoWorkbookId(childEnv);
  child = spawn(process.execPath, [path.join(__dirname, 'gate-server.js')],
    { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });

  const ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gate-server did not report its ports within 60s')), 60000);
    let stderr = '';
    child.stdout.on('data', d => {
      serverStdout += String(d);
      const app = serverStdout.match(/GATE_PORT=(\d+)/);
      const state = serverStdout.match(/GATE_STATE_PORT=(\d+)/);
      if (app && state) { clearTimeout(timer); resolve({ app: app[1], state: state[1] }); }
    });
    child.stderr.on('data', d => { stderr += String(d); process.stderr.write(`[gate-server] ${d}`); });
    // A refused posture exits BEFORE publishing a port, so early exit is the fail-closed path.
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`gate-server exited early (${code}): ${stderr.slice(-2000)}`)); });
  });
  base = `http://127.0.0.1:${ports.app}`;
  stateBase = `http://127.0.0.1:${ports.state}`;
  note('boot', `sandbox-live gate server up; posture ${MODE}; workbook last6 ${SANDBOX_SPREADSHEET_ID_LAST6}`);
});

test.afterAll(async () => {
  if (child) child.kill('SIGTERM');
});

test('Stage-A canary: one complete synthetic workout through the real browser to the sandbox Sheet', async ({ page }) => {
  // The durable verifier reads the whole sandbox workbook (thousands of rows) on each of its
  // four calls, on top of a full browser session. 300s was tight enough that a slow read could
  // have timed the run out and produced no scorecard — an environment cost reported as a
  // product failure. This is an operator-run canary, not CI, so the headroom is cheap.
  test.setTimeout(900000);

  const observations = {
    run: { run_id: RUN_ID, mode: MODE, session_id: SESSION_ID, athlete_id: ATHLETE_ID,
      expected_model: process.env.GEMINI_COACH_MODEL || '' },
    expected: { sets: WORKOUT.map(s => ({ ...s })), effort: { ...EFFORT } },
    ui: {}, durable: {}, env: {}, provenance: {}, trace: {}, write_proof: {}, privacy: {},
  };

  // ── 1. Open the real built client ────────────────────────────────────────────
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, GATE_KEY);
  await page.goto(`${base}/app/`);
  await page.waitForLoadState('networkidle');
  await snap(page, '01-client-open.png');
  note('open', 'real built Atlas client loaded against the sandbox-live server');

  // ── 2. Confirm the synthetic identity and an isolated initial state ──────────
  // The session id goes into `#log-session-id`, the REAL product input the write path reads
  // (`src/app/app.js`: `sessionInput?.value?.trim() || generateSessionId(date)`), so every row
  // this run writes carries the unique synthetic id and can never collide with owner data or a
  // prior canary run.
  //
  // It is set by value + `input` event rather than `locator.fill()` because its container
  // (`#logger-details`) is `hidden` by design — "Session fields: hidden, auto-populated
  // silently" — so a visibility-gated gesture can never reach it. This is the same seam the
  // F10D closeout spec already uses for the sibling `#effort-*` inputs in the hidden
  // `#effort-details` panel, so the canary follows the existing gate authority rather than
  // inventing a second convention.
  //
  // This is NOT fixture-only DOM mutation: the field is a genuine product input whose value the
  // write path reads, and nothing here asserts the app honored it. That is proven END TO END —
  // the durable readback filters on this exact id, and `no_contamination` fails if any written
  // row carries a different one. If the app ignored the value, the canary fails.
  await page.evaluate(id => {
    const el = document.getElementById('log-session-id');
    el.value = id;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, SESSION_ID);
  const idApplied = await page.evaluate(() => document.getElementById('log-session-id').value);
  observations.ui.identity_confirmed = idApplied === SESSION_ID;
  observations.ui.initial_logged_sets = await page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : -1));
  const preRun = await durableRows(SESSION_ID);
  observations.ui.durable_rows_before_run = preRun.log_rows.length + preRun.effort_rows.length;
  const baselineLogTotal = preRun.log_total_rows;
  const baselineEffortTotal = preRun.effort_total_rows;
  note('identity', `synthetic session ${SESSION_ID}; ${observations.ui.durable_rows_before_run} pre-existing durable rows`);

  // Provenance: the client marks automation itself (navigator.webdriver → 'playwright'),
  // which is the existing recognized mechanism — nothing new is minted here.
  observations.provenance.request_origin = await page.evaluate(() =>
    (navigator.webdriver === true ? 'playwright' : 'athlete_ui'));
  // The runtime is non-production (sandbox workbook + NODE_ENV=test), so the classifier
  // fails closed to synthetic and can never mark this run evidence-eligible.
  observations.provenance.evidence_class = 'synthetic';
  observations.provenance.evidence_eligible = false;

  // ── 3. Establish a plan through the current product path ─────────────────────
  const started = await page.evaluate(() => window.atlasAcceptPlan({
    id: 'work_day', label: 'Work', why_today: 'Phase 4 Stage-A canary.',
    exercises: [
      { name: 'Back Squat', lift_code: 'SQ01', sets: 2, target_reps: 5, target_rir: 2, weight: 225 },
      { name: 'Bench Press', lift_code: 'BEN01', sets: 2, target_reps: 8, target_rir: 3, weight: 185 },
    ],
  }));
  observations.ui.plan_established = Boolean(started && started.started);
  observations.ui.plan_exercises = ['Back Squat', 'Bench Press'];
  // Remaining/completed state must be VISIBLE in the client, not merely accepted server-side.
  await expect(page.locator('#session-pin')).toBeVisible({ timeout: 20000 });
  const pinText = await page.locator('#session-pin').innerText();
  observations.ui.plan_remaining_visible = pinText.trim().length > 0;
  await snap(page, '02-plan-established.png');
  note('plan', `plan accepted and visible in the pin: ${pinText.replace(/\n/g, ' ')}`);

  // ── 4. One conversational question grounded in current session state ─────────
  //
  // The provider marker is read from the RESPONSE the eligible turn actually received.
  // The InteractionTrace's `source` names the ROUTE (`coach_chat` / `coach_message`), not the
  // provider, so inferring model use from it would be a category error — it can never carry
  // "gemini". The authoritative marker is the response body's own `source`, which is exactly
  // what `services/coachQaShadow.js` reads to decide `modelRan` (`data.source === 'gemini'`).
  // `engine` is the deterministic fallback and `training_sme` is the SME path; neither is
  // model-up proof.
  const coachResponses = [];
  page.on('response', async (res) => {
    if (!/\/api\/coach\/(chat|ask|message)\b/.test(res.url())) return;
    try {
      const body = await res.json();
      const data = body && body.data && typeof body.data === 'object' ? body.data : body;
      coachResponses.push({
        url: new URL(res.url()).pathname,
        source: data && typeof data.source === 'string' ? data.source : null,
        model: data && typeof data.model === 'string' ? data.model : null,
        configured: data ? data.configured === true : null,
      });
    } catch { /* non-JSON or already consumed — recorded as absent, never guessed */ }
  });

  const threadBefore = await page.locator('#thread-messages').innerText();
  await say(page, 'what is left in this session?');
  await expect.poll(async () => (await page.locator('#thread-messages').innerText()).length,
    { timeout: 40000 }).toBeGreaterThan(threadBefore.length);
  const threadAfter = await page.locator('#thread-messages').innerText();
  const reply = threadAfter.slice(threadBefore.length).trim();
  // Grounding is proven by the reply naming session truth (a planned lift), not by the
  // reply merely existing and not by the absence of outage wording.
  observations.ui.grounded_question = {
    asked: true,
    reply_text: reply,
    grounded_in_session: /squat|bench|remaining|left/i.test(reply),
  };
  await snap(page, '03-grounded-question.png');
  note('question', `asked a session-state question; reply length ${reply.length}`);

  // ── 5. Enter the workout through the real composer ───────────────────────────
  await logSet(page, 'back squat', 0).catch(() => {});
  let logged = await page.evaluate(() => window.getSessionLog().length);
  for (const set of WORKOUT) {
    if (set.set_number === 1) { await say(page, set.exercise.toLowerCase()); }
    await logSet(page, set.say, logged + 1);
    logged += 1;
  }
  observations.ui.logged_sets = await page.evaluate(() => window.getSessionLog().length);
  observations.ui.exercises_logged = await page.evaluate(() =>
    [...new Set(window.getSessionLog().map(e => e.exercise || e.canonical_exercise))].filter(Boolean));
  await snap(page, '04-workout-logged.png');
  note('log', `${observations.ui.logged_sets} sets buffered across ${observations.ui.exercises_logged.length} exercises`);

  // ── 6. No durable row may exist before approval ──────────────────────────────
  const preApproval = await durableRows(SESSION_ID);
  const preApprovalState = await serverState();
  observations.ui.durable_rows_before_approval = preApproval.log_rows.length + preApproval.effort_rows.length;
  observations.ui.appends_before_approval = preApprovalState.appends.length;
  note('pre-approval', `${observations.ui.durable_rows_before_approval} durable rows, ${observations.ui.appends_before_approval} appends before approval`);

  // ── 7-8. The real preview, containing only the intended synthetic sets ───────
  await page.evaluate(e => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('effort-duration', e.duration);
    set('effort-active-cal', String(e.active_calories));
    set('effort-total-cal', String(e.total_calories));
    set('effort-avg-hr', String(e.average_hr));
    set('effort-peak-hr', String(e.peak_hr));
  }, EFFORT);
  await say(page, 'done');
  await expect(page.locator('.closeout-confirm')).toHaveCount(1, { timeout: 40000 });
  observations.ui.preview_rendered = true;
  observations.ui.closeout_rendered = true;
  const previewText = await page.locator('.closeout-confirm').innerText();
  // Read the preview from the session log the confirmation was compiled from, then check
  // the rendered card actually names each one — the card is prose, the log is the payload.
  observations.ui.preview_sets = await page.evaluate(() => window.getSessionLog().map(e => ({
    exercise: e.exercise || e.canonical_exercise, weight: e.weight, reps: e.reps, rir: e.rir,
  })));
  observations.ui.preview_names_all_exercises = observations.ui.exercises_logged.every(x => previewText.includes(x));
  observations.ui.preview_proof_present = await page.evaluate(() =>
    document.getElementById('approve-btn') !== null && document.getElementById('approve-btn').disabled === false);
  await snap(page, '05-preview-before-write.png');
  note('preview', `closeout confirmation rendered with ${observations.ui.preview_sets.length} sets; approve enabled ${observations.ui.preview_proof_present}`);

  // ── 9. The real approval control ─────────────────────────────────────────────
  await page.locator('#approve-btn').click();
  observations.ui.approval_clicked = true;
  observations.ui.approval_control = '#approve-btn';
  observations.ui.direct_write_route_used = false; // nothing in this spec calls a write route
  await expect.poll(async () => (await serverState()).appends.length, { timeout: 60000 }).toBeGreaterThan(0);
  await expect.poll(async () => page.evaluate(() => {
    const b = document.getElementById('approve-btn');
    return b ? b.textContent : '';
  }), { timeout: 60000 }).toMatch(/Written|Retry|Saved/i);
  await snap(page, '06-after-approval.png');
  note('approve', 'real #approve-btn clicked; server reported appends');

  // ── 10. The durable sandbox write ───────────────────────────────────────────
  await expect.poll(async () => (await durableRows(SESSION_ID)).log_rows.length, { timeout: 60000 })
    .toBe(WORKOUT.length);
  const after = await durableRows(SESSION_ID);
  observations.durable.log_rows = after.log_rows;
  observations.durable.effort_rows = after.effort_rows;
  observations.durable.log_column_index = {
    // Contract FIELD names, not display labels — config/columns.js holds the former.
    exercise: logCleanedColumns.indexOf('exercise'),
    weight: logCleanedColumns.indexOf('weight'),
    reps: logCleanedColumns.indexOf('reps'),
    rir: logCleanedColumns.indexOf('rir'),
    set_number: logCleanedColumns.indexOf('set_number'),
  };
  observations.durable.effort_column_index = {
    duration: effortColumns.indexOf('duration'),
    active_calories: effortColumns.indexOf('active_calories'),
    total_calories: effortColumns.indexOf('total_calories'),
    average_hr: effortColumns.indexOf('average_hr'),
    peak_hr: effortColumns.indexOf('peak_hr'),
  };
  // No row carrying a non-synthetic identity: every row this run wrote must carry the
  // canary session id, and no other session's row count may have moved.
  const sidIdx = logCleanedColumns.indexOf('session_id');
  const effSidIdx = effortColumns.indexOf('session_id');
  observations.durable.foreign_identity_rows =
    after.log_rows.filter(r => String(r[sidIdx]).trim() !== SESSION_ID).length
    + after.effort_rows.filter(r => String(r[effSidIdx]).trim() !== SESSION_ID).length;
  observations.durable.other_session_rows_delta =
    (after.log_total_rows - baselineLogTotal - after.log_rows.length)
    + (after.effort_total_rows - baselineEffortTotal - after.effort_rows.length);
  note('durable', `${after.log_rows.length} Log_Cleaned rows and ${after.effort_rows.length} Effort rows for ${SESSION_ID}`);

  // ── 11-13. Complete the workout, exercise closeout/seal, verify sealed state ─
  const sealedLabel = await page.evaluate(() => {
    const b = document.getElementById('approve-btn');
    return b ? b.textContent.trim() : '';
  });
  observations.ui.closeout_approved = true;
  observations.ui.sealed_state_label = sealedLabel;
  // A sealed state is the write having completed AND the approval control no longer
  // offering another write — a retry label means the closeout did NOT seal.
  observations.ui.sealed_state_valid = /Written/i.test(sealedLabel)
    && (await page.evaluate(() => document.getElementById('approve-btn').disabled)) === true;
  await snap(page, '07-sealed.png');
  note('seal', `sealed state label "${sealedLabel}"; valid ${observations.ui.sealed_state_valid}`);

  // At-most-once: a second approval gesture must add no durable row.
  observations.ui.second_approval_attempted = true;
  await page.evaluate(() => document.getElementById('approve-btn').click());
  await page.waitForTimeout(2500);
  const afterRetry = await durableRows(SESSION_ID);
  observations.durable.rows_added_by_second_approval =
    (afterRetry.log_rows.length - after.log_rows.length)
    + (afterRetry.effort_rows.length - after.effort_rows.length);
  note('retry', `second approval gesture added ${observations.durable.rows_added_by_second_approval} durable rows`);

  // ── 14-15. Trace + turn-write proof, joined on the canonical turn_id ────────
  const parseMarker = (marker) => serverStdout.split('\n')
    .filter(l => l.includes(marker))
    .map(l => { try { return JSON.parse(l.slice(l.indexOf(marker) + marker.length).trim()); } catch { return null; } })
    .filter(Boolean);
  observations.trace.records = parseMarker('[interaction-trace]');
  observations.write_proof.records = parseMarker('[turn-write-proof]');
  note('artifacts', `${observations.trace.records.length} interaction-trace records, ${observations.write_proof.records.length} turn-write-proof records`);

  // Model source marker, read from the eligible coach turn's OWN RESPONSE. A positive
  // `source: 'gemini'` is the only thing treated as live-provider proof; a settled reply,
  // the absence of outage wording, and `configured: true` are each explicitly not proof.
  const finalState = await serverState();
  observations.provenance.coach_responses = coachResponses;
  const observedSources = [...new Set(coachResponses.map(r => r.source).filter(Boolean))];
  const gemini = coachResponses.filter(r => r.source === 'gemini');
  observations.ui.grounded_question.provider_called = gemini.length > 0;
  observations.ui.grounded_question.source = gemini.length > 0
    ? 'live_model'
    : (observedSources[0] || '');
  // Ambiguity is a real observation, not an inference: in a model-up run the eligible turn
  // must show one unmistakable provider verdict. A mix of gemini and non-gemini sources means
  // some eligible turn fell back, which the scorecard must see rather than have averaged away.
  observations.ui.grounded_question.source_ambiguous = MODE === 'model-up'
    && observedSources.length > 1
    && gemini.length > 0;
  // Model-up additionally requires the answering model to be named on the same response.
  if (MODE === 'model-up' && gemini.length > 0 && !gemini.some(r => r.model)) {
    observations.ui.grounded_question.source_ambiguous = true;
  }

  // ── server + environment observations ───────────────────────────────────────
  observations.server = finalState;
  observations.env = {
    declared_sandbox_last6: SANDBOX_SPREADSHEET_ID_LAST6,
    child_sheet_id_last6: finalState.sandbox_last6,
    ambient_sheet_id_last6: process.env.GOOGLE_SHEETS_ID ? String(process.env.GOOGLE_SHEETS_ID).slice(-6) : '',
    // Proven, not asserted: the child env this spec built carries no GOOGLE_SHEETS_ID at all,
    // and the server independently resolved the declared sandbox.
    inherited_ambient: false,
  };

  // ── 16. Bounded, privacy-filtered evidence ─────────────────────────────────
  // Scan every artifact for the things that must never appear. The full workbook id is
  // included in the forbidden list precisely because this run knows it.
  const forbidden = [
    { kind: 'workbook_id', re: new RegExp(SANDBOX_SPREADSHEET_ID, 'i') },
    { kind: 'ambient_workbook_id', re: process.env.GOOGLE_SHEETS_ID ? new RegExp(String(process.env.GOOGLE_SHEETS_ID), 'i') : null },
    { kind: 'private_key', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
    { kind: 'service_account_email', re: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? new RegExp(String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null },
    { kind: 'provider_key', re: process.env.GEMINI_API_KEY ? new RegExp(String(process.env.GEMINI_API_KEY).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : null },
  ].filter(f => f.re);

  const evidence = {
    run: observations.run,
    workbook_last6: SANDBOX_SPREADSHEET_ID_LAST6,
    timeline,
    server: finalState,
    ui: observations.ui,
    durable: observations.durable,
    env: observations.env,
    provenance: observations.provenance,
    trace: observations.trace,
    write_proof: observations.write_proof,
  };
  // Persist the evidence FIRST so the scan covers what is actually published, then scan every
  // file in the artifact directory — screenshots included. Counting files it never opened, and
  // measuring only the JSON, would let the privacy condition claim coverage it did not perform;
  // that is the exact false green this canary exists to prevent, so the scan reads real bytes.
  const evidenceText = JSON.stringify(evidence, null, 2);
  fs.writeFileSync(path.join(artDir, 'evidence.json'), evidenceText);

  const scanned = [];
  const violations = [];
  let totalBytes = 0;
  for (const name of fs.readdirSync(artDir)) {
    const full = path.join(artDir, name);
    if (!fs.statSync(full).isFile()) continue;
    const buf = fs.readFileSync(full);
    totalBytes += buf.length;
    // Byte-level scan: catches a forbidden literal anywhere in the file, including PNG text
    // chunks and metadata, not just in the JSON this spec authored.
    const asText = buf.toString('latin1');
    for (const f of forbidden) {
      if (f.re.test(asText)) violations.push({ kind: f.kind, file: name });
    }
    scanned.push(name);
  }
  observations.privacy = {
    violations,
    artifacts_scanned: scanned.length,
    artifact_bytes: totalBytes,
    artifact_bytes_limit: 8_000_000,
  };

  // ── score, render, persist ─────────────────────────────────────────────────
  const scorecard = scoreCanary(observations);
  const scorecardJson = JSON.stringify(scorecard, null, 2);
  const scorecardMd = renderMarkdown(scorecard);
  // The two scorecard files are derived from already-scanned data, so they cannot be part of
  // the scan that produced them. Check them directly instead of asserting they are safe.
  for (const [label, text] of [['scorecard.json', scorecardJson], ['SCORECARD.md', scorecardMd]]) {
    const leak = forbidden.find(f => f.re.test(text));
    expect(leak, `${label} would publish a forbidden value (${leak && leak.kind})`).toBeUndefined();
  }
  fs.writeFileSync(path.join(artDir, 'scorecard.json'), scorecardJson);
  fs.writeFileSync(path.join(artDir, 'SCORECARD.md'), scorecardMd);

  const failed = scorecard.conditions.filter(c => c.status === 'FAIL' || c.status === 'ERROR');
  if (failed.length) {
    console.error('\n[stage-a-canary] conditions not passing:');
    for (const c of failed) console.error(`  ${c.status}  ${c.id} — ${c.detail}`);
  }
  expect(scorecard.overall, `canary scorecard: ${failed.map(c => `${c.id}=${c.status}`).join(', ') || 'see SCORECARD.md'}`).toBe('PASS');
});
