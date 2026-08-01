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
// Each set is ONE message carrying its own exercise name — the form the existing gate specs
// use ('Romanian Deadlift 245 x 6 @3'). An earlier attempt switched exercise with a bare lift
// name and then sent a bare load, and the first set after the switch never committed. Naming
// the lift on every set removes the two-step dependency and keeps each turn self-contained.
const WORKOUT = Object.freeze([
  { exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2, say: 'Back Squat 225 x 5 @2' },
  { exercise: 'Back Squat', set_number: 2, weight: 225, reps: 5, rir: 2, say: 'Back Squat 225 x 5 @2' },
  { exercise: 'Bench Press', set_number: 1, weight: 185, reps: 8, rir: 3, say: 'Bench Press 185 x 8 @3' },
  { exercise: 'Bench Press', set_number: 2, weight: 185, reps: 7, rir: 2, say: 'Bench Press 185 x 7 @2' },
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
      // Read the body BEFORE deciding: the harness reports why it failed in the body, and
      // throwing on the status alone discards that and leaves only a bare "HTTP 500".
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`HTTP ${res.status}${body && body.error ? ` — ${body.error}` : ''}`);
      if (body && body.error) throw new Error(String(body.error));
      return body;
    } catch (error) {
      lastError = error;
      // A Sheets read-QUOTA rejection is per MINUTE, so a few seconds of backoff cannot clear
      // it — the retry would just burn its attempts and report a product failure. Back off past
      // the quota window instead. Reads only; nothing here retries a write.
      const quota = /quota/i.test(String(error && error.message));
      await new Promise(r => setTimeout(r, quota ? 30000 : 1000 * attempt));
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
    // The exercise shape the existing gate specs pass to atlasAcceptPlan — `exercise` +
    // `target_*`, not `name`/`sets`. A wrong shape is accepted silently and produces a plan
    // the client cannot render, so it is copied from the established call site rather than
    // guessed from the field names.
    exercises: [
      { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 2, target_rir: 2 },
      { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 185, target_reps: 8, target_sets: 2, target_rir: 3 },
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
  // Each response is tagged with the phase captured SYNCHRONOUSLY at event time. The handler
  // awaits res.json(), so anything read from a shared variable after that await — or any slice
  // of the array taken before the handler has pushed — races the network. An earlier version
  // sliced the array right after the reply rendered and saw zero responses, because none had
  // been recorded yet even though all six eventually arrived.
  let currentPhase = 'setup';
  const coachResponses = [];
  page.on('response', async (res) => {
    const phase = currentPhase;
    if (!/\/api\/coach\/(chat|ask|message)\b/.test(res.url())) return;
    try {
      const body = await res.json();
      const data = body && body.data && typeof body.data === 'object' ? body.data : body;
      coachResponses.push({
        phase,
        url: new URL(res.url()).pathname,
        source: data && typeof data.source === 'string' ? data.source : null,
        model: data && typeof data.model === 'string' ? data.model : null,
        configured: data ? data.configured === true : null,
      });
    } catch { /* non-JSON or already consumed — recorded as absent, never guessed */ }
  });

  // Everything the ELIGIBLE turn produces is bracketed. A whole session issues many coach
  // calls, and judging the provider from all of them together is a category error: a
  // set-logging turn legitimately answers deterministically while the conversational question
  // is answered by the model. Aggregating them made a correct model-up run look ambiguous.
  currentPhase = 'eligible_question';
  const QUESTION = 'what is left in this session?';
  const threadBefore = await page.locator('#thread-messages').innerText();
  await say(page, QUESTION);

  // Wait for a SETTLED reply, using the discipline scripts/live-retest.js already documents:
  // the 'Thinking…' marker must be gone, the body non-empty, and the text stable. An earlier
  // version settled on "thread text grew", which the echoed user bubble plus the 'Thinking…'
  // placeholder satisfies instantly — so the run captured "what is left in this session?
  // Thinking…" as the reply and scored grounding PASS off the word "left" in the ECHOED
  // QUESTION. A false green in the exact condition this canary exists to make honest.
  const THINKING = 'Thinking…';
  let settledText = '';
  let stableSince = null;
  let lastSeen = null;
  await expect.poll(async () => {
    const now = await page.locator('#thread-messages').innerText();
    const delta = now.slice(threadBefore.length);
    if (delta !== lastSeen) { lastSeen = delta; stableSince = Date.now(); return false; }
    const body = delta.split(THINKING).join('').replace(QUESTION, '').trim();
    if (delta.includes(THINKING) || body.length === 0) return false;
    if (stableSince === null || Date.now() - stableSince < 750) return false;
    settledText = delta;
    return true;
  }, { timeout: 90000, intervals: [250] }).toBe(true);

  // The assistant's words only — the echoed question is stripped, so grounding can never be
  // satisfied by the athlete's own text.
  const reply = settledText.split(THINKING).join('').replace(QUESTION, '').trim();
  // Grounding requires the reply to name a lift that is actually in THIS session's plan,
  // not merely to contain a plausible word.
  observations.ui.grounded_question = {
    asked: true,
    reply_text: reply,
    grounded_in_session: /back squat|bench press|squat|bench/i.test(reply),
  };
  await snap(page, '03-grounded-question.png');
  note('question', `asked a session-state question; reply length ${reply.length}`);

  // ── 5. Enter the workout through the real composer ───────────────────────────
  currentPhase = 'logging';
  let logged = 0;
  for (const set of WORKOUT) {
    logged += 1;
    await logSet(page, set.say, logged);
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
  // The review card's Save is the visible approval control, and it appears only once the
  // preview proof exists — so its presence IS the preview-proof gate, not a separate claim.
  // `#approve-btn.disabled` is read (never clicked) as the second half of the same evidence.
  const saveControl = page.locator('.review:not(.done) .rv-save');
  await expect(saveControl).toBeVisible({ timeout: 40000 });
  observations.ui.preview_proof_present = await page.evaluate(() => {
    const b = document.getElementById('approve-btn');
    return b !== null && b.disabled === false;
  });
  await snap(page, '05-preview-before-write.png');
  note('preview', `closeout confirmation rendered with ${observations.ui.preview_sets.length} sets; review Save visible; approve-btn enabled ${observations.ui.preview_proof_present}`);

  // ── 9. The real approval control ─────────────────────────────────────────────
  //
  // The athlete taps the review card's "Save workout" (`coach-conversation.js`), which is the
  // ONLY visible approval control. `#approve-btn` is the underlying gated write trigger — it
  // is never visible, so clicking it directly is not a gesture a user could perform, and the
  // previous attempt to do so could never succeed. The existing F10D closeout specs use this
  // same `.rv-save` gesture, so the canary follows the established gate authority.
  await saveControl.click();
  observations.ui.approval_clicked = true;
  observations.ui.approval_control = '.review:not(.done) .rv-save';
  observations.ui.write_trigger = '#approve-btn';
  observations.ui.direct_write_route_used = false; // nothing in this spec calls a write route
  await expect.poll(async () => (await serverState()).appends.length,
    { timeout: 90000, intervals: [500, 1000, 2000] }).toBeGreaterThan(0);
  // `.review.done` is the client's own post-write state, so it is read rather than inferred.
  await expect(page.locator('.review.done')).toBeVisible({ timeout: 90000 });
  await snap(page, '06-after-approval.png');
  note('approve', 'real review-card Save clicked (routes to #approve-btn); server reported appends; review card marked done');

  // ── 10. The durable sandbox write ───────────────────────────────────────────
  // Poll slowly and explicitly. Each check costs real Sheets read requests, and the limit that
  // bites is requests-per-minute — a default fast poll can exhaust the quota by itself and then
  // report the resulting failure as a missing durable write.
  // Capture the settled read rather than issuing another identical one. Every durable read
  // costs Sheets request quota, and the poll's final value IS the post-write state.
  let after = null;
  await expect.poll(async () => {
    after = await durableRows(SESSION_ID);
    return after.log_rows.length;
  }, { timeout: 180000, intervals: [3000, 5000, 5000, 10000] })
    .toBe(WORKOUT.length);
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
  // The sealed state is the client's own rendering: the review card is `.done` and carries its
  // saved confirmation. A card still offering Save means the closeout did NOT seal.
  const sealedLabel = await page.locator('.review.done .rv-saved-txt').innerText().catch(() => '');
  const stillOfferingSave = await page.locator('.review:not(.done) .rv-save').count();
  observations.ui.closeout_approved = true;
  observations.ui.sealed_state_label = sealedLabel.trim();
  observations.ui.sealed_state_valid = sealedLabel.trim().length > 0 && stillOfferingSave === 0;
  await snap(page, '07-sealed.png');
  note('seal', `sealed state "${sealedLabel.trim()}"; unsaved review cards remaining ${stillOfferingSave}`);

  // At-most-once: re-triggering the underlying write control must add no durable row. This
  // deliberately pokes `#approve-btn` — the gated trigger itself — rather than the Save button,
  // because the visible Save is gone once the card is done, and the property under test is that
  // the WRITE TRIGGER cannot fire twice for one approved action.
  observations.ui.second_approval_attempted = true;
  await page.evaluate(() => {
    const b = document.getElementById('approve-btn');
    if (b) b.click();
  });
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

  // Model source marker, read from the ELIGIBLE turn's own responses. A positive
  // `source: 'gemini'` is the only thing treated as live-provider proof; a settled reply,
  // the absence of outage wording, and `configured: true` are each explicitly not proof.
  //
  // Scoping to the eligible turn is what makes this check meaningful rather than lenient: a
  // turn that produces NO gemini response still fails, and `training_sme` — the /api/coach/ask
  // log-only pre-check, which is not athlete-facing — is never proof on its own. What scoping
  // removes is only the false ambiguity of judging one turn by other turns' routes.
  const finalState = await serverState();
  observations.provenance.coach_responses = coachResponses;
  // Resolved HERE, at the end of the run, so every async response handler has completed.
  const eligibleTurnResponses = coachResponses.filter(r => r.phase === 'eligible_question');
  observations.provenance.eligible_turn_responses = eligibleTurnResponses;
  const gemini = eligibleTurnResponses.filter(r => r.source === 'gemini');
  const eligibleSources = [...new Set(eligibleTurnResponses.map(r => r.source).filter(Boolean))];
  observations.ui.grounded_question.provider_called = gemini.length > 0;
  observations.ui.grounded_question.source = gemini.length > 0
    ? 'live_model'
    : (eligibleSources[0] || '');
  // A model-up run must be able to name the model that answered, on the same response that
  // claimed the provider. A gemini source with no model name is genuinely ambiguous.
  observations.ui.grounded_question.source_ambiguous = MODE === 'model-up'
    && gemini.length > 0
    && !gemini.some(r => r.model);

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
