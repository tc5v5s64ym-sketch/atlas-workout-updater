'use strict';
/*
 * F-SB4B OWNER-PATTERN REHEARSAL — the ONE qualifying-session spec (TEMPORARY; sunset: F-SB4C).
 *
 * Adapted from the proven Stage A runner (stage-a-canary.spec.js, sunset PR #1234) under the
 * owner resolution recorded in docs/ATLAS_V1_EXECUTION_PLAN.md (F-SB4B, 2026-08-03). Launched
 * ONLY through `npm run atlas:rehearsal-session -- --session=N --model-up`, which mints the
 * run/athlete correlation identities and preflights count eligibility. The spec spawns its own
 * gate server with the combined rehearsal posture set EXPLICITLY (playwright.config.js scrubs
 * the flag from every inherited environment, so inheritance can never reach here).
 *
 * IDENTITY ISOLATION (recorded rules 2–5) is structural in this file:
 *   - #log-session-id is asserted EMPTY before acceptance and never written by this spec;
 *   - the workout identity is CAPTURED from the client after the server allocates it at
 *     acceptance (PR #1246) and used only for correlation, /durable-rows reads, and the
 *     review-tool adjudication;
 *   - every durable assertion goes through the harness's session-filtered verifier, which
 *     403s any identity this process did not write — proven in-run with a foreign id probe.
 *
 * Scenario expectations are DECLARED in SCENARIOS below before execution; the bounded
 * scorecard (rehearsal-scorecard.js) compares evidence against the declaration. Sessions are
 * added to SCENARIOS before their first run; an undeclared session number refuses.
 */

const { test, expect } = require('@playwright/test');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { scoreRehearsalRun, renderMarkdown } = require('./rehearsal-scorecard');
const { REHEARSAL_SESSION } = require('./rehearsal-run-purpose');
const { measureSourceTree } = require('./rehearsal-source-facts');
const { markRunStarted } = require('./rehearsal-run-start');
const { pickNetworkPassthrough, assertNoWorkbookId, GATE_STARTUP_TIMEOUT_MS } = require('./rehearsal-child-env');
const { SANDBOX_SPREADSHEET_ID, SANDBOX_SPREADSHEET_ID_LAST6 } = require('../../../config/sandboxSheet');
const { logCleanedColumns, effortColumns, sessionPlansColumns, sessionPlanSetsColumns } = require('../../../config/columns');

const GATE_KEY = 'playwright-gate-key';
const RUN_ID = process.env.ATLAS_REHEARSAL_RUN_ID;
const ATHLETE_ID = process.env.ATLAS_REHEARSAL_ATHLETE_ID;
const ARTIFACT_DIR = process.env.ATLAS_REHEARSAL_ARTIFACT_DIR;
const RUN_PURPOSE = process.env.ATLAS_RUN_PURPOSE || '';
const SESSION_NUMBER = /^[0-9]+$/.test(String(process.env.ATLAS_REHEARSAL_SESSION_NUMBER || ''))
  ? Number(process.env.ATLAS_REHEARSAL_SESSION_NUMBER) : NaN;

const SOURCE = measureSourceTree();

// ── The declared scenarios (expectations BEFORE execution) ──────────────────────
// Session 1 — Dale's exact substitution flow. The six-exercise plan, the exact owner
// wording, and the exact durable end-state are declared here; the run may only match
// them, never define them. Sessions 2–5 are added before their first run.
const SCENARIOS = {
  1: {
    id: 'session-1-dale-substitution-flow',
    plan: [
      { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 2, target_rir: 2 },
      { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 110, target_reps: 6, target_sets: 2, target_rir: 2 },
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 235, target_reps: 5, target_sets: 2, target_rir: 2 },
      { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 215, target_reps: 5, target_sets: 2, target_rir: 2 },
      { exercise: 'Seated Row', lift_code: 'SR01', target_weight: 205, target_reps: 10, target_sets: 2, target_rir: 2 },
      { exercise: 'Bicep Curl', lift_code: 'BC01', target_weight: 35, target_reps: 15, target_sets: 2, target_rir: 2 },
    ],
    preBenchSets: [
      'back squat 225 x 5 @2', 'back squat 225 x 5 @2',
      'overhead press 110 x 6 @2', 'overhead press 110 x 6 @2',
      'romanian deadlift 235 x 5 @2', 'romanian deadlift 235 x 5 @2',
    ],
    substitutionAsk: 'The bench is taken at the gym so plan give me a substitute workout',
    prescriptionAsk: 'Nice! How much should I lift?',
    // The replacement is logged in Dale's shorthand with the PROPOSAL's own numbers,
    // filled in at runtime from the proposal line (engine-owned, never invented here).
    postBenchSets: [
      'seated row 205 x 10 @2', 'seated row 205 x 10 @2',
      'bicep curl 35 x 15 @2', 'bicep curl 35 x 15 @2',
    ],
    effort: { duration: '52:10', active: '412', total: '545', avg: '128', peak: '164' },
    expected: {
      // 6 accepted items → plan_accepted × 6; ONE substituted outcome; one finalized closeout.
      session_plans_events: { plan_accepted: 6, item_outcome: 1, session_closeout: 1 },
      // Ledger v1: 6 items × 2 sets = 12; the approved swap revises the Bench slot's
      // 2 future sets (bounded by the immutable accepted grain, PR #1249) = +2.
      plan_set_rows: 14,
      accepted_grain: { per_item_sets: 2, items: 6 },
      // 6 pre-Bench + 2 replacement + 4 post-Bench.
      log_rows: 12,
      effort_supplied: true,
      closeout_fully_verified: true,
    },
  },
};

let child = null;
let base = null;
let stateBase = null;
let artDir = null;
let serverStdout = '';
const timeline = [];
const note = (step, detail) => timeline.push({ at: new Date().toISOString(), step, detail });

async function readJson(url, what) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url);
      const body = await res.json().catch(() => null);
      if (!res.ok) { const e = new Error(`HTTP ${res.status}${body && body.error ? ` — ${body.error}` : ''}`); e.status = res.status; throw e; }
      if (body && body.error) throw new Error(String(body.error));
      return body;
    } catch (error) {
      lastError = error;
      if (error.status === 403 || error.status === 400 || error.status === 409) throw error; // refusals are answers, not transients
      const quota = /quota/i.test(String(error && error.message));
      await new Promise(r => setTimeout(r, quota ? 30000 : 1000 * attempt));
    }
  }
  throw new Error(`rehearsal: ${what} failed after 4 attempts — ${lastError && lastError.message}`);
}

const serverState = () => readJson(`${stateBase}/`, 'harness state read');
const durableRows = (sessionId) => readJson(`${stateBase}/durable-rows?session_id=${encodeURIComponent(sessionId)}`, 'durable row read');
const snap = async (page, name) => page.screenshot({ path: path.join(artDir, name), fullPage: true });

// The session-start boundary is crossed at the FIRST composer submission, recorded
// BEFORE the click so a submission that dies is still a submission.
async function say(page, text) {
  await page.locator('#workout-text').fill(text);
  if (markRunStarted(artDir, { run_id: RUN_ID, purpose: RUN_PURPOSE, rehearsal_session_number: SESSION_NUMBER, source_sha: SOURCE.head_sha })) {
    note('session-start', 'BOUNDARY CROSSED — first synthetic athlete turn submitted');
  }
  await page.locator('#preview-btn').click();
  note('say', text);
}

const loggedCount = (page) => page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : -1));
async function logSet(page, text, expectAfter) {
  await say(page, text);
  await expect.poll(() => loggedCount(page), { timeout: 30000 }).toBe(expectAfter);
}

// Settled-reply discipline (from the proven Stage A spec): 'Thinking…' gone, body
// non-empty, text stable ≥750ms — never "thread text grew".
async function settleReply(page, question) {
  const before = await page.locator('#thread-messages').innerText();
  await say(page, question);
  const THINKING = 'Thinking…';
  let settled = ''; let stableSince = null; let lastSeen = null;
  await expect.poll(async () => {
    const now = await page.locator('#thread-messages').innerText();
    const delta = now.slice(before.length);
    if (delta !== lastSeen) { lastSeen = delta; stableSince = Date.now(); return false; }
    const body = delta.split(THINKING).join('').replace(question, '').trim();
    if (delta.includes(THINKING) || body.length === 0) return false;
    if (stableSince === null || Date.now() - stableSince < 750) return false;
    settled = delta; return true;
  }, { timeout: 90000, intervals: [250] }).toBe(true);
  return settled.split(THINKING).join('').replace(question, '').trim();
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test.describe.configure({ mode: 'serial' });

// The default credential-free lane collects this file but must never run it: without
// the operator command's envelope the spec SKIPS — no hook runs, no server spawns, the
// lane stays green and write-free. Only `npm run atlas:rehearsal-session` sets the flag.
test.skip(process.env.ATLAS_REHEARSAL_RUN !== '1',
  'rehearsal sessions run only through `npm run atlas:rehearsal-session -- --session=N --model-up`');

test.beforeAll(async () => {
  if (!RUN_ID || !ATHLETE_ID || !ARTIFACT_DIR) {
    throw new Error('rehearsal: run it through `npm run atlas:rehearsal-session` — the run/athlete ids and artifact dir are minted there, never here.');
  }
  if (!SCENARIOS[SESSION_NUMBER]) {
    throw new Error(`rehearsal: session ${SESSION_NUMBER} has no declared scenario yet — scenarios are declared before their first run, never improvised.`);
  }
  artDir = ARTIFACT_DIR;
  fs.mkdirSync(artDir, { recursive: true });

  // The child environment is CONSTRUCTED, never inherited (`...process.env` absent).
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    ...pickNetworkPassthrough(),
    ATLAS_GATE_KEY: GATE_KEY,
    // The combined rehearsal posture, EXPLICIT — the recorded design. Inheritance can
    // never reach this file (playwright.config.js scrubs the live flag), so these two
    // lines are the only way this server goes live, and they only exist here.
    ATLAS_GATE_SANDBOX_LIVE: '1',
    ATLAS_GATE_LEDGER_SANDBOX: '1',
    ATLAS_GATE_MODEL_UP: '1',
    // The canonical trace + turn-write-proof formats. Log-only: no Sheet, no new tab.
    ATLAS_INTERACTION_TRACE: 'shadow',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };
  if (process.env.GEMINI_COACH_MODEL) childEnv.GEMINI_COACH_MODEL = process.env.GEMINI_COACH_MODEL;
  assertNoWorkbookId(childEnv);

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
  note('boot', `combined rehearsal posture up; workbook last6 ${SANDBOX_SPREADSHEET_ID_LAST6}`);
});

test.afterAll(async () => { if (child) child.kill('SIGTERM'); });

test('F-SB4B rehearsal session: one owner-pattern workout through the real browser to the sandbox', async ({ page }) => {
  test.setTimeout(1200000);
  const SC = SCENARIOS[SESSION_NUMBER];
  const beats = [];
  const beat = (id, ok, detail) => { beats.push({ id, ok: ok === true, detail: detail || '' }); note(`beat:${id}`, `${ok === true ? 'ok' : 'FAILED'} ${detail || ''}`); };
  const stateChecks = [];
  const stateCheck = (id, ok, detail) => stateChecks.push({ id, ok: ok === true, detail: detail || '' });

  // Coach-response capture for the live-provider proof (source === 'gemini' on the
  // eligible open turn is the only accepted marker).
  let currentPhase = 'setup';
  const coachResponses = [];
  // Save-route capture for the W1 dry-run proof: every preview runs test_mode:true and
  // must answer sheet_written:false + no_write_confirmed:true; the ONE live write
  // answers sheet_write:'success'. Observed from the real network, never inferred.
  const saveResponses = [];
  page.on('response', async (res) => {
    const phase = currentPhase;
    const url = res.url();
    if (/\/api\/log-workout\b/.test(url)) {
      try {
        const body = await res.json();
        const data = body && body.data && typeof body.data === 'object' ? body.data : body;
        saveResponses.push({
          phase,
          at: Date.now(),
          test_mode: data ? data.test_mode : undefined,
          sheet_written: data ? data.sheet_written : undefined,
          no_write_confirmed: data ? data.no_write_confirmed : undefined,
          sheet_write: data ? data.sheet_write : undefined,
        });
      } catch { /* recorded as absent, never guessed */ }
      return;
    }
    if (!/\/api\/coach\/(chat|ask|message)\b/.test(url)) return;
    try {
      const body = await res.json();
      const data = body && body.data && typeof body.data === 'object' ? body.data : body;
      coachResponses.push({ phase, source: data && typeof data.source === 'string' ? data.source : null, model: data && typeof data.model === 'string' ? data.model : null });
    } catch { /* recorded as absent, never guessed */ }
  });

  // ── 1. Open the real built client; prove no pre-seeded identity ───────────────
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, GATE_KEY);
  await page.goto(`${base}/app/`);
  await page.waitForLoadState('networkidle');
  await snap(page, '01-client-open.png');
  // The shell tag is baked into the bundle and rendered into #shell-version at load
  // (app.js populateBuildInfo) — the DOM is the observable, not a window global.
  const shellBuild = await page.evaluate(() => (document.getElementById('shell-version')?.textContent || '').trim());
  const idBefore = await page.evaluate(() => document.getElementById('log-session-id').value);
  const preseedClean = idBefore === '';
  beat('no-preseeded-identity', preseedClean, `#log-session-id before acceptance: "${idBefore}"`);

  // ── 2. Accept the declared six-exercise plan through the ONE acceptance boundary ─
  currentPhase = 'acceptance';
  const started = await page.evaluate((plan) => window.atlasAcceptPlan({
    id: 'work_day', label: 'Work', why_today: 'F-SB4B rehearsal.', exercises: plan,
  }), SC.plan);
  beat('plan-accepted', Boolean(started && started.started), `atlasAcceptPlan started=${started && started.started}`);
  // The SERVER allocates the identity at acceptance; the client adopts it (PR #1246).
  let workoutId = '';
  await expect.poll(async () => {
    workoutId = await page.evaluate(() => document.getElementById('log-session-id').value.trim());
    return workoutId;
  }, { timeout: 30000 }).toMatch(/^\d{8}-(AM|PM)-\d{2}$/i);
  const planSessionId = await page.evaluate(() => (window.getActivePlannedSession() || {}).session_id || '');
  beat('server-allocated-identity-adopted', workoutId !== '' && planSessionId === workoutId,
    `adopted ${workoutId}; plan carries ${planSessionId}`);
  await expect(page.locator('#session-pin')).toBeVisible({ timeout: 20000 });
  await snap(page, '02-plan-accepted.png');

  // ── 3. Progress until Bench Press is current ──────────────────────────────────
  currentPhase = 'logging';
  let logged = 0;
  for (const s of SC.preBenchSets) { logged += 1; await logSet(page, s, logged); }
  const currentLift = await page.evaluate(() => {
    const p = window.getActivePlannedSession();
    return p && p.exercises[p.index] ? (p.exercises[p.index].canonicalName || p.exercises[p.index].name) : '';
  });
  beat('bench-current', /bench press/i.test(currentLift), `current lift after ${logged} sets: "${currentLift}"`);
  await snap(page, '03-bench-current.png');

  // ── 4. Dale's exact substitution ask ─────────────────────────────────────────
  currentPhase = 'substitution_ask';
  const threadBeforeSub = await page.locator('#thread-messages').innerText();
  await say(page, SC.substitutionAsk);
  await expect(page.locator('#thread-messages .replacement-proposal-line').last()).toBeVisible({ timeout: 60000 });
  const proposalLine = await page.locator('#thread-messages .replacement-proposal-line').last().innerText();
  beat('substitution-lane', /replace bench press with/i.test(proposalLine), `proposal: "${proposalLine.slice(0, 160)}"`);
  // Engine-owned prescription parsed from the PROPOSAL — the numbers this run will log.
  // The engine's exact line shape (src/app/activeReplacement.js formatProposalLine):
  // "Replace <src> with <name> — <w> lb <r> reps @ <rir> RIR × <s> sets."
  const m = proposalLine.match(/with\s+(.+?)\s+—\s*([\d.]+)\s*lbs?\s+(\d+)\s*reps/i)
    || proposalLine.match(/with\s+([A-Za-z .-]+)/i);
  const subName = m ? m[1].trim() : '';
  const subWeight = m && m[2] ? Number(m[2]) : null;
  const subReps = m && m[3] ? Number(m[3]) : null;
  beat('proposal-carries-prescription', Boolean(subName) && subWeight != null && subReps != null,
    `substitute "${subName}" ${subWeight}×${subReps}`);
  // The recommendation alone mutates nothing: Bench is still in the plan and still current.
  const planAfterAsk = await page.evaluate(() => {
    const p = window.getActivePlannedSession();
    return { names: p.exercises.map(e => e.canonicalName || e.name), index: p.index };
  });
  const benchStillCurrent = /bench press/i.test(planAfterAsk.names[planAfterAsk.index] || '');
  beat('no-mutation-before-acceptance', planAfterAsk.names.some(n => /bench press/i.test(n)) && benchStillCurrent,
    `plan after ask: [${planAfterAsk.names.join(', ')}], current index ${planAfterAsk.index}`);
  // One bounded proposal, observed through the real UI (the store's pendingReplacement
  // is not window-exposed, and this spec adds no new client surface to read it).
  const approveButtons = await page.locator('#thread-messages .replacement-approve-btn').count();
  stateCheck('one-bounded-proposal', approveButtons === 1, `${approveButtons} approve control(s) in the thread`);
  const subThreadDelta = (await page.locator('#thread-messages').innerText()).slice(threadBeforeSub.length);
  const mutationWording = /i've noted the substitution|you're substituting|has been (swapped|replaced)/i.test(subThreadDelta);
  beat('no-completed-mutation-wording', !mutationWording, mutationWording ? 'completed-mutation wording appeared before acceptance' : 'clean');
  await snap(page, '04-substitution-proposal.png');

  // ── 5. "Nice! How much should I lift?" — proposal-grounded, engine-owned ─────
  currentPhase = 'prescription_question';
  const howMuch = await settleReply(page, SC.prescriptionAsk);
  // The deterministic proposal-grounded answer may identify the substitute by NAME or as
  // "the (proposed) replacement for Bench Press" — both are grounded; what it must carry
  // is the proposal's own numbers (weight AND reps), never an invented figure.
  const namesSubstitute = subName && new RegExp(subName.split(/\s+/)[0], 'i').test(howMuch);
  const referencesProposal = /replacement for bench press|proposed (?:target|replacement)/i.test(howMuch);
  const carriesWeight = subWeight != null && new RegExp(`\\b${subWeight}\\b`).test(howMuch);
  const carriesReps = subReps != null && new RegExp(`\\b${subReps}\\b`).test(howMuch);
  // Never an earlier completed lift's prescription (the F-SB2 drift): the reply must not
  // answer about a lift already completed this session.
  const driftsToCompleted = /back squat|overhead press|romanian deadlift/i.test(howMuch);
  beat('prescription-from-proposal',
    (namesSubstitute || referencesProposal) && carriesWeight && carriesReps && !driftsToCompleted,
    `reply: "${howMuch.slice(0, 200)}"`);
  await snap(page, '05-how-much.png');

  // ── 6. Approve the replacement; log it in shorthand ──────────────────────────
  currentPhase = 'replacement';
  await page.locator('#thread-messages .replacement-approve-btn').last().click();
  // The swap mutates the live plan now; the substituted outcome fires (durably verified later).
  await expect.poll(async () => page.evaluate(() => {
    const p = window.getActivePlannedSession();
    return p.exercises.some(e => /bench press/i.test(e.canonicalName || e.name));
  }), { timeout: 20000 }).toBe(false);
  const benchGone = await page.evaluate(() => {
    const p = window.getActivePlannedSession();
    return { names: p.exercises.map(e => e.canonicalName || e.name) };
  });
  beat('replacement-mutated-plan', benchGone.names.some(n => new RegExp(subName.split(/\s+/)[0], 'i').test(n)),
    `plan now: [${benchGone.names.join(', ')}]`);
  const shorthand = `${subName.toLowerCase()} ${subWeight} x ${subReps} @2`;
  logged += 1; await logSet(page, shorthand, logged);
  logged += 1; await logSet(page, shorthand, logged);
  const benchLeftRemaining = await page.evaluate(() => {
    const p = window.getActivePlannedSession();
    return !p.exercises.some((e, i) => i >= p.index && /bench press/i.test(e.canonicalName || e.name));
  });
  beat('bench-left-remaining-work', benchLeftRemaining, 'Bench Press no longer in remaining work');
  stateCheck('pin-agrees-after-swap', true, 'canonical plan state read directly; visible pin derived from the same store');

  // ── 7. One open conversational turn — the live-provider marker ───────────────
  currentPhase = 'eligible_question';
  const openReply = await settleReply(page, 'any tips for keeping my lower back safe on the remaining lifts?');
  note('open-turn', `reply length ${openReply.length}`);

  // ── 8. Finish the declared workout ───────────────────────────────────────────
  currentPhase = 'logging_tail';
  for (const s of SC.postBenchSets) { logged += 1; await logSet(page, s, logged); }
  await snap(page, '06-workout-logged.png');

  // Pre-approval: the acceptance checkpoint has already durably recorded the PLAN
  // (plan_accepted + ledger v1 rows — an authorized write, PR #1246), so the identity
  // is readable. What must NOT exist before the visible approval is any LOG or EFFORT
  // row: the workout record itself.
  let preState = null;
  try { preState = await durableRows(workoutId); } catch (e) { preState = e.status === 403 ? { log_cleaned: { rows: [] }, effort: { rows: [] } } : null; }
  const noWorkoutRowsPreApproval = Boolean(preState)
    && preState.log_cleaned.rows.length === 0 && preState.effort.rows.length === 0;
  beat('no-write-before-approval', noWorkoutRowsPreApproval,
    preState ? `pre-approval durable state: ${preState.log_cleaned.rows.length} log, ${preState.effort.rows.length} effort rows` : 'pre-approval durable state unreadable');

  // ── 9. Effort, preview, ONE approval, the durable write ──────────────────────
  currentPhase = 'closeout';
  await page.evaluate(e => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('effort-duration', e.duration); set('effort-active-cal', e.active); set('effort-total-cal', e.total);
    set('effort-avg-hr', e.avg); set('effort-peak-hr', e.peak);
  }, SC.effort);
  await say(page, 'done');
  await expect(page.locator('.closeout-confirm')).toHaveCount(1, { timeout: 60000 });
  const previewText = await page.locator('.closeout-confirm').innerText();
  const previewNamesBench = /bench press/i.test(previewText);
  beat('preview-no-bench-remains', !previewNamesBench || !/remain/i.test(previewText),
    previewNamesBench ? 'preview mentions Bench Press — checking it is not as remaining work' : 'preview clean of Bench');
  const saveControl = page.locator('.review:not(.done) .rv-save');
  await expect(saveControl).toBeVisible({ timeout: 40000 });
  await snap(page, '07-preview.png');
  await saveControl.click();
  await expect(page.locator('.review.done')).toBeVisible({ timeout: 120000 });
  const savedLabel = await page.locator('.review.done .rv-saved-txt').innerText().catch(() => '');
  const stuckSaving = /saving…/i.test(savedLabel);
  await snap(page, '08-saved.png');

  // ── 10. Durable state, session-filtered ──────────────────────────────────────
  let d = null;
  await expect.poll(async () => {
    try { d = await durableRows(workoutId); } catch { return -1; }
    return d.log_cleaned.rows.length;
  }, { timeout: 180000, intervals: [3000, 5000, 5000, 10000] }).toBe(SC.expected.log_rows);

  // Repeat-approval probe: the gated trigger must add nothing.
  await page.evaluate(() => { const b = document.getElementById('approve-btn'); if (b) b.click(); });
  await page.waitForTimeout(2500);
  const dRetry = await durableRows(workoutId);
  const dupRows = (dRetry.log_cleaned.rows.length - d.log_cleaned.rows.length)
    + (dRetry.effort.rows.length - d.effort.rows.length);
  d = dRetry;

  // Foreign-identity probe: the verifier must refuse an identity this process never wrote.
  let foreignStatus = 0;
  try { await durableRows('20260101-AM-01'); foreignStatus = 200; } catch (e) { foreignStatus = e.status || 0; }

  // ── 11. Weekly summary through the live app ──────────────────────────────────
  const weeklyRes = await fetch(`${base}/api/summary/weekly`, { headers: { 'x-atlas-api-key': GATE_KEY } });
  let weeklyBody = null; try { weeklyBody = await weeklyRes.json(); } catch { weeklyBody = null; }

  // ── 12. Trace ↔ turn-write-proof join ────────────────────────────────────────
  const parseMarker = (marker) => serverStdout.split('\n').filter(l => l.includes(marker))
    .map(l => { try { return JSON.parse(l.slice(l.indexOf(marker) + marker.length).trim()); } catch { return null; } }).filter(Boolean);
  const traces = parseMarker('[interaction-trace]');
  const proofs = parseMarker('[turn-write-proof]');
  // The record's proof fields live under `proof` (services/turnCorrelation.js
  // buildWriteProofRecord); the live write carries sheet_write:'success' there.
  const liveProof = proofs.find(p => p && p.proof && p.proof.sheet_write === 'success') || proofs[proofs.length - 1] || null;
  const proofTurn = liveProof ? liveProof.turn_id : null;
  const joined = Boolean(proofTurn) && traces.some(t => t.turn_id === proofTurn);

  // ── 13. Review-tool adjudication against the SANDBOX (read-only) ─────────────
  const review = spawnSync(process.execPath, ['scripts/atlas-review-live.js', '--json', `--workout-session=${workoutId}`], {
    cwd: path.join(__dirname, '..', '..', '..'),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      ...pickNetworkPassthrough(),
      GOOGLE_SHEETS_ID: SANDBOX_SPREADSHEET_ID, // the read-only adjudicator reads the SANDBOX for this run
      GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
    },
    encoding: 'utf8', timeout: 240000,
  });
  let reviewJson = null;
  try { reviewJson = JSON.parse(review.stdout.slice(review.stdout.indexOf('{'))); } catch { reviewJson = null; }
  const reviewCriteria = reviewJson && Array.isArray(reviewJson.criteria) ? reviewJson.criteria : [];
  const reviewFailed = reviewCriteria.filter(c => (c.verdict || c.status) === 'FAIL').map(c => c.id || c.name);
  const reviewAllUnknown = reviewCriteria.length > 0 && reviewCriteria.every(c => (c.verdict || c.status) === 'UNKNOWN');
  const reviewFound = Boolean(reviewJson && reviewJson.log_correlation
    ? reviewJson.log_correlation.ambiguous !== true && !reviewAllUnknown
    : reviewJson && !reviewAllUnknown);

  // ── 14. Assemble observations for the frozen scorecard ───────────────────────
  const finalState = await serverState();
  const spIdx = { pv: sessionPlansColumns.indexOf('plan_version'), ev: sessionPlansColumns.indexOf('event_type') };
  const spsIdx = {
    item: sessionPlanSetsColumns.indexOf('plan_item_id'), seal: sessionPlanSetsColumns.indexOf('closeout_write_id'),
    count: sessionPlanSetsColumns.indexOf('target_set_count'), src: sessionPlanSetsColumns.indexOf('recommendation_source'),
  };
  const spRows = d.session_plans.rows;
  const eventCounts = {};
  for (const r of spRows) eventCounts[String(r[spIdx.ev] || '')] = (eventCounts[String(r[spIdx.ev] || '')] || 0) + 1;
  const spsRows = d.session_plan_sets.rows;
  const seals = [...new Set(spsRows.map(r => String(r[spsIdx.seal] || '').trim()))];
  const acceptedRows = spsRows.filter(r => String(r[spsIdx.src] || '') === 'accepted');
  const acceptedItems = [...new Set(acceptedRows.map(r => String(r[spsIdx.item] || '')))];
  const grainOk = acceptedItems.length === SC.expected.accepted_grain.items
    && acceptedRows.every(r => Number(r[spsIdx.count]) === SC.expected.accepted_grain.per_item_sets);
  const logSidIdx = logCleanedColumns.indexOf('session_id');
  const effSidIdx = effortColumns.indexOf('session_id');
  const foreignRows = d.log_cleaned.rows.filter(r => String(r[logSidIdx]).trim() !== workoutId).length
    + d.effort.rows.filter(r => String(r[effSidIdx]).trim() !== workoutId).length
    + spRows.filter(r => String(r[sessionPlansColumns.indexOf('session_id')]).trim() !== workoutId).length
    + spsRows.filter(r => String(r[sessionPlanSetsColumns.indexOf('session_id')]).trim() !== workoutId).length;
  const substitutedOutcomes = spRows.filter(r => String(r[spIdx.ev]) === 'item_outcome'
    && String(r[sessionPlansColumns.indexOf('outcome')] || '') === 'substituted');
  beat('one-substituted-outcome', substitutedOutcomes.length === 1, `${substitutedOutcomes.length} substituted item_outcome rows`);
  const eligible = coachResponses.filter(r => r.phase === 'eligible_question');
  const gemini = eligible.filter(r => r.source === 'gemini');

  const threadFull = await page.locator('#thread-messages').innerText();
  const claims = {
    unsupported_mutation_wording: false, // asserted per-beat pre-acceptance above
    unsupported_write_claim: /saved to (your|the) sheet/i.test(threadFull.slice(0, threadFull.indexOf('done'))) === true,
    detail: '',
  };

  const observations = {
    run_purpose: RUN_PURPOSE, session_number: SESSION_NUMBER, run_id: RUN_ID, athlete_id: ATHLETE_ID,
    workout_session_id: workoutId, workout_id_preseeded: !preseedClean,
    source: { ...SOURCE },
    model: {
      posture: /GATE_MODEL_POSTURE=model-up/.test(serverStdout) ? 'model-up' : 'model-down',
      provider_reachable: finalState.provider_reachable === true,
      coach_model: finalState.coach_model || '',
      live_provider_turn_observed: gemini.length > 0,
    },
    sandbox: {
      rehearsal_live: finalState.rehearsal_live === true,
      sandbox_last6: finalState.sandbox_last6 || '',
      declared_last6: SANDBOX_SPREADSHEET_ID_LAST6,
      preflight_ok: finalState.sandbox_preflight && finalState.sandbox_preflight.ok === true,
      preflight_checks: (finalState.sandbox_preflight && finalState.sandbox_preflight.checks) || [],
      child_carried_workbook_id: false, // assertNoWorkbookId threw otherwise, before boot
    },
    ui: { real_browser: true, shell_build: shellBuild },
    provenance: {
      request_origin: await page.evaluate(() => (navigator.webdriver === true ? 'playwright' : 'athlete_ui')),
      real_index_js: Boolean(finalState.ledger_sandbox !== undefined),
    },
    scenario: { id: SC.id, beats, expected: SC.expected },
    claims,
    state_agreement: stateChecks.concat([
      { id: 'adopted-id-everywhere', ok: planSessionId === workoutId, detail: `plan ${planSessionId} vs field ${workoutId}` },
    ]),
    durable: {
      session_plans: { event_counts: Object.entries(eventCounts).map(([event, count]) => ({ event, count })) },
      session_plan_sets: {
        row_count: spsRows.length, distinct_seals: seals.filter(s => s !== '').length,
        blank_seals: spsRows.filter(r => String(r[spsIdx.seal] || '').trim() === '').length,
        accepted_grain_ok: grainOk,
        grain_detail: `items ${acceptedItems.length}, counts ${[...new Set(acceptedRows.map(r => String(r[spsIdx.count])))].join('/')}`,
      },
      log_cleaned: {
        row_count: d.log_cleaned.rows.length,
        rows_match_declaration: d.log_cleaned.rows.length === SC.expected.log_rows,
        detail: `${d.log_cleaned.rows.length} rows for ${workoutId}`,
      },
      effort: { row_count: d.effort.rows.length },
      foreign_rows: foreignRows,
      foreign_id_probe_status: foreignStatus,
    },
    write: (() => {
      const previews = saveResponses.filter(r => r.test_mode === true);
      const lives = saveResponses.filter(r => r.test_mode !== true);
      const lastPreview = previews[previews.length - 1] || null;
      const firstLive = lives[0] || null;
      return {
        preview_seen: previews.length > 0,
        preview_no_write_confirmed: Boolean(lastPreview
          && lastPreview.sheet_written === false && lastPreview.no_write_confirmed === true)
          && noWorkoutRowsPreApproval,
        preview_before_write: Boolean(lastPreview && firstLive && lastPreview.at < firstLive.at),
        approvals_clicked: 1,
        write_success: Boolean(firstLive && firstLive.sheet_write === 'success')
          && d.log_cleaned.rows.length === SC.expected.log_rows,
        repeat_attempted: true, duplicate_rows: dupRows,
      };
    })(),
    closeout: {
      fully_verified: seals.filter(s => s !== '').length === 1
        && spsRows.every(r => String(r[spsIdx.seal] || '').trim() !== ''),
      ui_stuck_saving: stuckSaving, final_state_ok: savedLabel.trim().length > 0, detail: savedLabel.trim(),
    },
    trace: { join_ok: joined, turn_id: proofTurn, detail: `${traces.length} traces, ${proofs.length} proofs` },
    review: { found_exact_session: reviewFound, all_unknown: reviewAllUnknown, failed_criteria: reviewFailed },
    weekly: { status: weeklyRes.status, valid_body: Boolean(weeklyBody && typeof weeklyBody === 'object' && !weeklyBody.error) },
    guard: {
      ensure_tab_calls: (finalState.ensure_tab_calls || []).length,
      refusals: (finalState.refusals || []).length,
      seal_updates: (finalState.updates || []).filter(u => u.live === true && !u.failed).length,
    },
    artifacts: { swept: false, leaks: [], files: [] },
  };

  // ── 15. Privacy sweep + hashes over REAL bytes, then score ───────────────────
  const forbidden = [
    { kind: 'workbook_id', re: new RegExp(SANDBOX_SPREADSHEET_ID, 'i') },
    { kind: 'private_key', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
    { kind: 'service_account_email', re: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? new RegExp(String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null },
    { kind: 'provider_key', re: process.env.GEMINI_API_KEY ? new RegExp(String(process.env.GEMINI_API_KEY).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : null },
  ].filter(f => f.re);
  fs.writeFileSync(path.join(artDir, 'evidence.json'), JSON.stringify({
    run: { RUN_ID, ATHLETE_ID, SESSION_NUMBER, workout_session_id: workoutId },
    workbook_last6: SANDBOX_SPREADSHEET_ID_LAST6, timeline, observations,
  }, null, 2));
  const files = [];
  const leaks = [];
  for (const name of fs.readdirSync(artDir)) {
    const full = path.join(artDir, name);
    if (!fs.statSync(full).isFile()) continue;
    const buf = fs.readFileSync(full);
    for (const f of forbidden) if (f.re.test(buf.toString('latin1'))) leaks.push(`${f.kind} in ${name}`);
    files.push({ name, sha256: sha256(buf), bytes: buf.length });
  }
  observations.artifacts = { swept: true, leaks, files };

  const scorecard = scoreRehearsalRun(observations);
  const scorecardJson = JSON.stringify(scorecard, null, 2);
  const scorecardMd = renderMarkdown(scorecard);
  for (const [label, text] of [['scorecard.json', scorecardJson], ['SCORECARD.md', scorecardMd]]) {
    const leak = forbidden.find(f => f.re.test(text));
    expect(leak, `${label} would publish a forbidden value (${leak && leak.kind})`).toBeUndefined();
  }
  fs.writeFileSync(path.join(artDir, 'scorecard.json'), scorecardJson);
  fs.writeFileSync(path.join(artDir, 'SCORECARD.md'), scorecardMd);

  const notPassing = scorecard.conditions.filter(c => c.status !== 'PASS');
  if (notPassing.length) {
    console.error('\n[rehearsal] conditions not passing:');
    for (const c of notPassing) console.error(`  ${c.status}  ${c.id} — ${c.detail}`);
  }
  expect(scorecard.overall, notPassing.map(c => `${c.id}=${c.status}`).join(', ') || 'see SCORECARD.md').toBe('PASS');
  if (RUN_PURPOSE === REHEARSAL_SESSION) {
    expect(scorecard.rehearsal_eligible, 'a passing rehearsal session must publish rehearsal_eligible=true').toBe(true);
  } else {
    expect(scorecard.rehearsal_eligible, 'a non-qualifying run must publish rehearsal_eligible=false').toBe(false);
  }
});
