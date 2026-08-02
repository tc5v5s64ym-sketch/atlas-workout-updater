'use strict';
/*
 * F-SB4B — the five-session owner-pattern AI rehearsal. TEMPORARY. REMOVE IN F-SB4C.
 *
 * Five consecutive model-up synthetic full sessions built around Dale's actual
 * conversational style, the exact phrasings he used, and the trust seams the first Stage B
 * attempts exposed. Each session runs the whole product path:
 *
 *   real browser → real built client → real local Express → the current production
 *   parser / router / session / coach / validator → the DECLARED SANDBOX WORKBOOK →
 *   preview → real browser approval → durable sandbox write → closeout → evidence review
 *
 * This is NOT the Stage A happy path replayed five times. Every session exercises a
 * different owner-like friction and still completes a full workout.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────
 * Synthetic. Never owner evidence, never LT evidence, never a GATE A eligible event, and
 * it can never advance Stage B — Stage B is five workouts Dale runs himself. This spec
 * advances only the separate F-SB4 rehearsal counter.
 *
 * ── DECLARED EXPECTATIONS ──────────────────────────────────────────────────────
 * Each scenario states its expected exercises, sets, events, rows and closeout result
 * BEFORE it runs, in the EXPECTED block beside it. The scorecard compares actual evidence
 * against that declaration. "Some rows appeared" is not a standard and is never accepted.
 *
 * ── AUTHORIZATION ──────────────────────────────────────────────────────────────
 * Owner ruling 2026-08-02 option A, recorded in docs/ATLAS_V1_EXECUTION_PLAN.md. Sandbox
 * workbook only; no production workbook schema change; no production data written;
 * SESSION_PLAN_SETS_WRITE_ENABLED on Render untouched.
 */

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { sessionPlansColumns, sessionPlanSetsColumns, logCleanedColumns } = require('../../../config/columns');

const GATE_KEY = 'fsb4b-rehearsal-key';

// Column indices, read from the contract rather than hard-coded positions.
const SP = name => sessionPlansColumns.indexOf(name);
const SPS = name => sessionPlanSetsColumns.indexOf(name);
const LOG = name => logCleanedColumns.indexOf(name);

const SP_EVENT = SP('event_type');
const SP_ITEM = SP('plan_item_id');
const SP_PLANNED = SP('planned_lift_code');
const SP_OUTCOME = SP('outcome');
const SP_PERFORMED = SP('performed_lift_code');
const SP_SESSION = SP('session_id');
const SP_CLOSEOUT = SP('closeout_status');
const SPS_SEAL = SPS('closeout_write_id');
const SPS_SESSION = SPS('session_id');
const LOG_SESSION = LOG('session_id');
const LOG_EXERCISE = LOG('exercise');

let artDir = null;
const scorecard = [];

// A run identity nothing else in the workbook can collide with. Every session gets its
// own, so cross-session contamination is detectable rather than assumed absent.
function freshRunId(session) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `FSB4B-S${session}-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function verdict(session, id, ok, detail) {
  scorecard.push({ session, id, verdict: ok ? 'PASS' : 'FAIL', detail: detail || '' });
  return ok;
}

// Sessions run in order (the runner uses --workers=1) but are INDEPENDENT. Serial mode
// skips every later test once one fails, which discards the evidence four other sessions
// would have produced — the opposite of what a diagnosis needs. Consecutiveness is judged
// from the scorecard, not from Playwright's skip behavior.

// A full owner-pattern workout is a dozen model-up turns, each a real Gemini call and a
// real Sheets round-trip, plus preview, approval, a durable write and a closeout. The
// lane's 30s default is sized for mocked specs and cannot fit one; a session that is cut
// off mid-flow produces no verdict at all, which is the one outcome this rehearsal must
// never report. Twelve minutes per session, and the runner is invoked on its own.
test.setTimeout(720000);

test.beforeAll(async ({}, testInfo) => {
  artDir = process.env.ATLAS_GATE_ARTIFACT_DIR
    ? path.join(process.env.ATLAS_GATE_ARTIFACT_DIR, testInfo.project.name)
    : path.join(__dirname, '..', '..', '..', 'test-results', 'fsb4b-rehearsal', testInfo.project.name);
  fs.mkdirSync(artDir, { recursive: true });
});

test.afterAll(async () => {
  if (!artDir) return;
  const pass = scorecard.filter(s => s.verdict === 'PASS').length;
  const fail = scorecard.filter(s => s.verdict === 'FAIL').length;
  const summary = { generated_at: new Date().toISOString(), pass, fail, conditions: scorecard };
  fs.writeFileSync(path.join(artDir, 'scorecard.json'), JSON.stringify(summary, null, 2));
  const md = [
    '# F-SB4B owner-pattern rehearsal scorecard', '',
    `PASS ${pass} · FAIL ${fail}`, '',
    ...scorecard.map(s => `- **S${s.session} ${s.id}** — ${s.verdict}${s.detail ? ` — ${s.detail}` : ''}`),
  ];
  fs.writeFileSync(path.join(artDir, 'SCORECARD.md'), md.join('\n'));
});

// ---- the sandbox-live harness (real client, real routes, real workbook) ----------
async function bootRehearsalServer(extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, 'gate-server.js')], {
    env: {
      ...process.env,
      ATLAS_GATE_KEY: GATE_KEY,
      ATLAS_GATE_SANDBOX_LIVE: '1',   // durable writes to the declared sandbox
      ATLAS_GATE_LEDGER_SANDBOX: '1', // Session_Plans + Session_Plan_Sets enabled
      ATLAS_GATE_MODEL_UP: '1',       // model-up only; a fallback is a failed session
      ...(extraEnv || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gate-server did not report its ports within 120s')), 120000);
    let buf = '';
    child.stdout.on('data', d => {
      buf += String(d);
      const app = buf.match(/GATE_PORT=(\d+)/);
      const st = buf.match(/GATE_STATE_PORT=(\d+)/);
      if (app && st) { clearTimeout(timer); resolve({ app: app[1], state: st[1], banner: buf }); }
    });
    child.stderr.on('data', d => process.stderr.write(`[gate-server] ${d}`));
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`gate-server exited early (${code})`)); });
  });
  return {
    child,
    banner: ports.banner,
    base: `http://127.0.0.1:${ports.app}`,
    stop: () => child.kill('SIGTERM'),
    state: async () => (await fetch(`http://127.0.0.1:${ports.state}/state`)).json(),
  };
}

// Every API call and every console error, recorded. When a turn does not do what the
// scenario declared, the question is always "what did the client actually ask the server,
// and what came back" — capturing it up front means a failure yields that answer instead
// of another run.
const netLog = [];
const consoleErrors = [];

async function openApp(page, base) {
  netLog.length = 0;
  consoleErrors.length = 0;
  page.on('response', res => {
    const url = res.url();
    if (url.includes('/api/')) {
      netLog.push({ at: new Date().toISOString(), method: res.request().method(), path: url.replace(base, ''), status: res.status() });
    }
  });
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push({ at: new Date().toISOString(), text: msg.text().slice(0, 300) });
  });
  page.on('pageerror', err => consoleErrors.push({ at: new Date().toISOString(), text: `pageerror: ${String(err && err.message).slice(0, 300)}` }));
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, GATE_KEY);
  await page.goto(`${base}/app/`);
  await page.waitForLoadState('networkidle');
}

function dumpDiagnostics(session) {
  if (!artDir) return;
  fs.writeFileSync(path.join(artDir, `S${session}-network.json`), JSON.stringify(netLog, null, 2));
  fs.writeFileSync(path.join(artDir, `S${session}-console-errors.json`), JSON.stringify(consoleErrors, null, 2));
}

async function say(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
}

// Log one set and settle on the store commit. A turn that never commits RECORDS that fact
// and returns false rather than throwing, so one stalled turn yields a full scorecard and
// Atlas's own words instead of a bare Playwright timeout.
async function logSet(page, text, session, id) {
  const before = await page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : 0));
  await say(page, text);
  let after = before;
  for (let i = 0; i < 30 && after <= before; i += 1) {
    await page.waitForTimeout(1000);
    after = await page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : 0));
  }
  const ok = after > before;
  if (session && id) {
    const prose = await lastAtlas(page).innerText().catch(() => '');
    verdict(session, id, ok, ok ? `${before} → ${after}` : `did not commit (${before} → ${after}); Atlas said: ${JSON.stringify(prose.slice(0, 200))}`);
  }
  return ok;
}

async function acceptPlan(page, exercises, label) {
  const started = await page.evaluate(({ exs, lbl }) => window.atlasAcceptPlan({
    id: 'work_day', label: lbl, why_today: 'F-SB4B owner-pattern rehearsal (synthetic).', exercises: exs,
  }), { exs: exercises, lbl: label });
  expect(started && started.started, 'the plan must be accepted').toBeTruthy();
}

const rowsFor = (state, tab) => state.appends.filter(a => a.tabName === tab).flatMap(a => a.rows);
const lastAtlas = page => page.locator('#thread-messages .chat-bubble-atlas').last();

// Completed-mutation wording, in the exact phrasings the live failure used. A
// recommendation that has mutated nothing may never say any of these.
const COMPLETED_MUTATION_WORDING = [
  /i've\s+(swapped|noted|updated|changed|replaced)/i,
  /you'?re\s+substituting/i,
  /the\s+plan\s+(has\s+been|is)\s+(changed|updated)/i,
  /i\s+(updated|changed)\s+the\s+plan/i,
];

async function snap(page, name) {
  await page.screenshot({ path: path.join(artDir, name), fullPage: true });
}

// The shared finish → preview → approve → durable write → closeout block. Every session
// ends this way, so it is written ONCE: five copies would be five chances to prove a
// different thing by accident.
//
// `expectLogRows` is the session's DECLARED row count, stated before the run.
async function finishAndSave(page, srv, session, expectLogRows, prefix) {
  await say(page, 'done');
  // Settle on the closeout WITHOUT throwing. A "done" that does not produce a closeout is
  // a finding in its own right, and a bare timeout would discard the network trace and
  // Atlas's own reply — the evidence that says whether the turn was misrouted or merely slow.
  let confirmCount = 0;
  for (let i = 0; i < 90 && confirmCount === 0; i += 1) {
    await page.waitForTimeout(1000);
    confirmCount = await page.locator('.closeout-confirm').count();
  }
  if (confirmCount === 0) {
    const prose = await lastAtlas(page).innerText().catch(() => '');
    await snap(page, `${prefix}-no-closeout.png`);
    verdict(session, 'finish_produces_a_closeout', false,
      `"done" produced no closeout card in 90s; Atlas said: ${JSON.stringify(prose.slice(0, 240))}; last calls: ${JSON.stringify(netLog.slice(-6))}`);
    return { state: await srv.state(), logRows: [], sessionIds: [], previewText: '' };
  }
  verdict(session, 'finish_produces_a_closeout', true, `closeout card rendered after ${confirmCount} match(es)`);
  const reviewSave = page.locator('.review:not(.done) .rv-save');
  await expect(reviewSave).toBeVisible({ timeout: 30000 });
  await snap(page, `${prefix}-preview-before-write.png`);

  // (15) a preview exists BEFORE any write.
  const beforeApproval = await srv.state();
  verdict(session, 'preview_precedes_write', rowsFor(beforeApproval, 'Log_Cleaned').length === 0,
    `Log_Cleaned rows before approval: ${rowsFor(beforeApproval, 'Log_Cleaned').length} (must be 0)`);
  const previewText = await page.locator('.closeout-confirm').innerText();

  // (16) one visible approval, through the review card's own Save control.
  await reviewSave.click({ timeout: 30000 });

  // Settle on the card reaching its completed state, but NEVER throw here. A save that
  // does not complete is the single most important thing this rehearsal can observe, and
  // a bare assertion failure would discard the network trace and the button's own label —
  // exactly the evidence that separates "the write failed" from "the UI never said so".
  let doneCount = 0;
  for (let i = 0; i < 90 && doneCount === 0; i += 1) {
    await page.waitForTimeout(1000);
    doneCount = await page.locator('.review.done').count();
  }
  await snap(page, `${prefix}-after-approval.png`);

  const writeCalls = netLog.filter(n => /log-?workout|complete-?workout/i.test(n.path));
  verdict(session, 'approval_completes_the_save', doneCount > 0,
    `review card reached .done=${doneCount}; write calls: ${JSON.stringify(writeCalls.slice(-4))}`);

  // The completed state must be what the OWNER SEES. F-SB1-B was a trust defect precisely
  // because the owner read a stuck "Saving…" as a lost workout, so the honest check is the
  // VISIBLE surface: the action row is replaced by the saved confirmation, and no visible
  // text still claims a save is in flight.
  //
  // Reading `.rv-save`'s text directly is the wrong check — `.review.done .rv-act` is
  // `display: none`, so that label is retired along with the whole action row and its
  // residual "Saving…" is never rendered to anyone. Asserting on hidden text reports a
  // defect the product does not have.
  const actVisible = await page.locator('.review.done .rv-act').isVisible().catch(() => false);
  const savedVisible = await page.locator('.review.done .rv-saved').isVisible().catch(() => false);
  const visibleCardText = await page.locator('.review.done').first().innerText().catch(() => '');
  verdict(session, 'save_control_reaches_completed_state',
    doneCount > 0 && !actVisible && savedVisible,
    `action row visible=${actVisible} (must be false), saved confirmation visible=${savedVisible} (must be true)`);
  verdict(session, 'no_visible_saving_state_remains', !/saving/i.test(visibleCardText),
    `the saved card still shows an in-flight state: ${JSON.stringify(visibleCardText.slice(0, 160))}`);

  const afterWrite = await srv.state();
  const logRows = rowsFor(afterWrite, 'Log_Cleaned');
  verdict(session, 'durable_log_rows_written', logRows.length === expectLogRows,
    `declared ${expectLogRows} Log_Cleaned rows, found ${logRows.length}`);

  const sessionIds = new Set(logRows.map(r => String(r[LOG_SESSION] || '').trim()).filter(Boolean));
  verdict(session, 'single_session_identity', sessionIds.size === 1,
    `Log_Cleaned rows carry ${sessionIds.size} distinct session ids: ${[...sessionIds].join(', ')}`);

  // (17) a repeated approval writes nothing.
  const appendsBefore = afterWrite.appends.length;
  if (await reviewSave.isVisible().catch(() => false)) {
    await reviewSave.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  const afterRepeat = await srv.state();
  verdict(session, 'repeated_approval_writes_nothing', afterRepeat.appends.length === appendsBefore,
    `appends before=${appendsBefore} after=${afterRepeat.appends.length}`);

  // (18) closeout and (12) the seal.
  const finalized = rowsFor(afterRepeat, 'Session_Plans').filter(r =>
    String(r[SP_EVENT]) === 'session_closeout' && String(r[SP_CLOSEOUT]) === 'finalized');
  verdict(session, 'closeout_finalized', finalized.length === 1,
    `expected exactly 1 finalized session_closeout, found ${finalized.length}`);
  const sealStamps = (afterRepeat.updates || []).filter(u => u.tabName === 'Session_Plan_Sets');
  verdict(session, 'ledger_sealed', sealStamps.length >= 1,
    `Session_Plan_Sets seal stamps: ${sealStamps.length}`);

  // (23) a guard refusal means production attempted something unauthorized — never a pass.
  verdict(session, 'no_guard_refusals', (afterRepeat.refusals || []).length === 0,
    `refusals: ${JSON.stringify(afterRepeat.refusals || []).slice(0, 300)}`);

  return { state: afterRepeat, logRows, sessionIds: [...sessionIds], previewText };
}

// (21) GET /api/summary/weekly must answer 200 with a bounded body. The 500 observed on
// 2026-08-02 was post-write and never independently confirmed; this is where it would
// reproduce, so the exact status and body prefix are preserved either way.
async function weeklySummary(base) {
  // `x-atlas-api-key` is the gate the app itself authenticates with (index.js). An
  // `x-api-key` header is simply unauthenticated and returns 401 — a harness mistake that
  // would have been misread as the endpoint failing.
  const res = await fetch(`${base}/api/summary/weekly`, { headers: { 'x-atlas-api-key': GATE_KEY } });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* body preserved as text below */ }
  return { status: res.status, ok: res.ok, parsed, body: text.slice(0, 400) };
}

async function checkWeeklySummary(base, session) {
  const r = await weeklySummary(base);
  verdict(session, 'weekly_summary_200', r.status === 200, `HTTP ${r.status} — body: ${JSON.stringify(r.body)}`);
  // A parseable body is not enough: an error envelope parses too. The response must be a
  // SUCCESSFUL bounded document, or the check would pass on the very 500 it exists to catch.
  verdict(session, 'weekly_summary_bounded_body',
    r.status === 200 && r.parsed !== null && typeof r.parsed === 'object' && r.parsed.status !== 'error',
    `expected a successful bounded JSON object, got HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r;
}

// Persist a session's evidence. Identity, declared-vs-actual rows, and the harness banner
// — no request values and no workout content beyond the exercise names the scenario itself
// declared, so the artifact carries no credential, token, or fingerprint.
function writeSessionEvidence(session, runId, srv, result, extra) {
  fs.writeFileSync(path.join(artDir, `S${session}-state.json`), JSON.stringify(result.state, null, 2));
  fs.writeFileSync(path.join(artDir, `S${session}-identity.json`), JSON.stringify({
    run_id: runId,
    workout_session_ids: result.sessionIds,
    log_rows: result.logRows.length,
    banner: srv.banner.split('\n').filter(Boolean),
    ...(extra || {}),
  }, null, 2));
}

// Fail the test only at the END, so one bad condition still yields a full scorecard.
function assertSessionPassed(session) {
  dumpDiagnostics(session);
  const failed = scorecard.filter(s => s.session === session && s.verdict === 'FAIL');
  expect(failed, `S${session} conditions failed:\n${failed.map(f => `  ${f.id}: ${f.detail}`).join('\n')}`).toHaveLength(0);
}

// Stage a substitution proposal and return the visible prose. Shared by the sessions that
// need a proposal in flight before their own friction.
async function requestSubstitute(page, phrasing) {
  await say(page, phrasing);
  await expect(lastAtlas(page)).toBeVisible({ timeout: 45000 });
  await page.waitForTimeout(3000);
  return lastAtlas(page).innerText();
}

const approveControl = page => page.locator('.replacement-proposal-line button, .chat-bubble-atlas button')
  .filter({ hasText: /^Approve$/i }).last();

const substitutedOutcomes = state => rowsFor(state, 'Session_Plans')
  .filter(r => String(r[SP_EVENT]) === 'item_outcome' && String(r[SP_OUTCOME]) === 'substituted');

// =================================================================================
// SESSION 1 — Dale's exact substitution flow
//
// DECLARED EXPECTATION, stated before the session runs:
//   plan            6 exercises: SQ01, OHP01, RDL01, BEN01, SR01, BC01, 1 set each
//   ledger at accept 6 Session_Plan_Sets rows (one per planned set), unsealed
//   the ask         "The bench is taken at the gym so plan give me a substitute workout"
//                   → a lift-level substitution, NOT whole-session generation
//   on recommend    0 item_outcome rows · BEN01 still current · no completed wording
//                   · exactly one bounded pending proposal
//   the follow-up   "Nice! How much should I lift?" answered from the proposal's
//                   engine-owned prescription, not the earlier completed lift
//   on logging      exactly 1 substituted item_outcome, plan_item_id = BEN01's,
//                   performed_lift_code = the replacement, BEN01 leaves remaining work
//   final preview   does NOT say Bench Press remains
//   closeout        closeout_fully_verified true only once state and ledger agree
// =================================================================================
test('S1 — the bench is taken: recommend, answer from the proposal, accept by logging, one canonical substitution', async ({ page }) => {
  const SESSION_NO = 1;
  const runId = freshRunId(1);
  const srv = await bootRehearsalServer();
  try {
    // (3) model-up and (4) sandbox posture, proven from the harness's own banner.
    verdict(1, 'model_up_posture', /GATE_MODEL_POSTURE=model-up/.test(srv.banner), srv.banner.match(/GATE_MODEL_POSTURE=[^\n]*/)?.[0]);
    verdict(1, 'sandbox_posture', /GATE_SHEETS_POSTURE=sandbox-live/.test(srv.banner), srv.banner.match(/GATE_SHEETS_POSTURE=[^\n]*/)?.[0]);

    await openApp(page, srv.base);

    await acceptPlan(page, [
      { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 1, target_rir: 2 },
      { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 115, target_reps: 6, target_sets: 1, target_rir: 2 },
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 1, target_rir: 3 },
      { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 185, target_reps: 5, target_sets: 1, target_rir: 2 },
      { exercise: 'Seated Row', lift_code: 'SR01', target_weight: 150, target_reps: 10, target_sets: 1, target_rir: 2 },
      { exercise: 'Bicep Curl', lift_code: 'BC01', target_weight: 35, target_reps: 12, target_sets: 1, target_rir: 2 },
    ], runId);

    // The accept-time durable checkpoint: 6 planned sets, one per exercise.
    await expect.poll(async () => rowsFor(await srv.state(), 'Session_Plan_Sets').length, { timeout: 60000 }).toBe(6);
    verdict(1, 'accept_checkpoint_rows', true, '6 Session_Plan_Sets rows checkpointed at accept');

    // Progress naturally until Bench Press is current.
    await logSet(page, 'Back Squat 225 5/2', 1, 'log_back_squat');
    await logSet(page, 'Overhead Press 115 6/2', 1, 'log_overhead_press');
    await logSet(page, 'Romanian Deadlift 245 6/3', 1, 'log_rdl');

    const beforeAsk = await srv.state();
    const outcomesBefore = rowsFor(beforeAsk, 'Session_Plans').filter(r => String(r[SP_EVENT]) === 'item_outcome');

    // Dale's exact wording.
    await say(page, 'The bench is taken at the gym so plan give me a substitute workout');
    await expect(lastAtlas(page)).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(2500);
    await snap(page, 'S1-01-substitute-recommended.png');

    const afterAsk = await srv.state();
    const outcomesAfterAsk = rowsFor(afterAsk, 'Session_Plans').filter(r => String(r[SP_EVENT]) === 'item_outcome');
    verdict(1, 'recommendation_mutates_nothing',
      outcomesAfterAsk.length === outcomesBefore.length,
      `item_outcome rows before=${outcomesBefore.length} after=${outcomesAfterAsk.length} (a recommendation must write none)`);

    const proseAfterAsk = await lastAtlas(page).innerText();
    const claimed = COMPLETED_MUTATION_WORDING.find(re => re.test(proseAfterAsk));
    verdict(1, 'no_completed_mutation_wording', !claimed,
      claimed ? `claimed a completed mutation: ${JSON.stringify(proseAfterAsk.slice(0, 160))}` : 'no completed-mutation wording');

    verdict(1, 'not_whole_session_generation',
      !/today,?\s+let'?s\s+make\s+it/i.test(proseAfterAsk),
      'the turn stayed a lift-level swap and did not become whole-session generation');

    // The grounded follow-up: answered from the proposal's engine-owned prescription.
    await say(page, 'Nice! How much should I lift?');
    await expect(lastAtlas(page)).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(2500);
    const prescriptionProse = await lastAtlas(page).innerText();
    await snap(page, 'S1-02-how-much-answered.png');

    // The answer must come from the PENDING PROPOSAL's engine-owned prescription.
    //
    // Naming Bench Press here is CORRECT and required — the honest sentence is "X is the
    // proposed replacement FOR Bench Press", which states what is being replaced and that
    // the swap is not live yet. What would be wrong is answering ABOUT Bench Press as the
    // thing to lift now, or answering about a lift finished earlier. So this checks the
    // three properties that actually matter: the replacement is named, an engine-owned
    // target is present, and the proposal is not misreported as active.
    verdict(1, 'prescription_names_the_replacement', /incline/i.test(prescriptionProse),
      `the answer must name the proposed replacement: ${JSON.stringify(prescriptionProse.slice(0, 200))}`);
    verdict(1, 'prescription_carries_engine_target', /\d+\s*lb.*\d+\s*reps?/is.test(prescriptionProse),
      `the answer must carry the engine-owned target: ${JSON.stringify(prescriptionProse.slice(0, 200))}`);
    verdict(1, 'prescription_does_not_claim_active',
      !COMPLETED_MUTATION_WORDING.some(re => re.test(prescriptionProse)),
      `the answer must not present the swap as already applied: ${JSON.stringify(prescriptionProse.slice(0, 200))}`);

    // ── ACCEPTANCE ───────────────────────────────────────────────────────────
    // The proposal offers Approve / Keep it. Dale's flow accepts, then logs the
    // replacement in his normal shorthand. Capture what each turn actually does rather
    // than polling blindly, so a turn that does not commit yields evidence instead of a
    // bare timeout.
    const approve = page.locator('.replacement-proposal-line button, .chat-bubble-atlas button')
      .filter({ hasText: /^Approve$/i }).last();
    const approveVisible = await approve.isVisible().catch(() => false);
    verdict(1, 'acceptance_control_offered', approveVisible,
      'the proposal must offer a visible acceptance control');
    if (approveVisible) {
      await approve.click({ timeout: 15000 });
      await page.waitForTimeout(3000);
      await snap(page, 'S1-02b-after-approve.png');
    }

    const afterAccept = await srv.state();
    const acceptOutcomes = rowsFor(afterAccept, 'Session_Plans')
      .filter(r => String(r[SP_EVENT]) === 'item_outcome' && String(r[SP_OUTCOME]) === 'substituted');
    verdict(1, 'acceptance_mutates_exactly_once', acceptOutcomes.length === 1,
      `expected exactly 1 substituted item_outcome after acceptance, found ${acceptOutcomes.length}`);

    // Repeating the acceptance must not duplicate the canonical outcome.
    if (await approve.isVisible().catch(() => false)) {
      await approve.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    const afterRepeatAccept = await srv.state();
    verdict(1, 'repeated_acceptance_is_idempotent',
      rowsFor(afterRepeatAccept, 'Session_Plans')
        .filter(r => String(r[SP_EVENT]) === 'item_outcome' && String(r[SP_OUTCOME]) === 'substituted').length === 1,
      'a repeated acceptance must not emit a second item_outcome');

    // Now log the replacement, in Dale's normal shorthand.
    const logBefore = await page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : 0));
    await say(page, 'Incline Dumbbell Press 90 10/2');
    await page.waitForTimeout(6000);
    const logAfter = await page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : 0));
    const replacementProse = await lastAtlas(page).innerText();
    await snap(page, 'S1-02c-replacement-logged.png');
    verdict(1, 'replacement_commits_to_the_session', logAfter > logBefore,
      `session log ${logBefore} → ${logAfter}; Atlas said: ${JSON.stringify(replacementProse.slice(0, 220))}`);

    const afterLog = await srv.state();
    const planRows = rowsFor(afterLog, 'Session_Plans');
    const substituted = planRows.filter(r => String(r[SP_EVENT]) === 'item_outcome' && String(r[SP_OUTCOME]) === 'substituted');
    verdict(1, 'exactly_one_substituted_outcome', substituted.length === 1,
      `expected exactly 1 substituted item_outcome, found ${substituted.length}`);
    if (substituted.length === 1) {
      verdict(1, 'outcome_binds_source_slot', String(substituted[0][SP_PLANNED]).toUpperCase() === 'BEN01',
        `planned_lift_code=${substituted[0][SP_PLANNED]} (must be the ORIGINAL Bench Press slot)`);
      verdict(1, 'performed_lift_identifies_replacement',
        String(substituted[0][SP_PERFORMED] || '').trim() !== '' && String(substituted[0][SP_PERFORMED]).toUpperCase() !== 'BEN01',
        `performed_lift_code=${substituted[0][SP_PERFORMED]}`);
      verdict(1, 'outcome_carries_source_item_id', String(substituted[0][SP_ITEM] || '').trim() !== '',
        `plan_item_id=${substituted[0][SP_ITEM]}`);
    }

    // Bench Press must leave remaining work.
    const remaining = await page.evaluate(() => (window.getRemainingPlannedExercises
      ? window.getRemainingPlannedExercises()
      : (window.atlasRemainingPlanned || null)));
    if (remaining && Array.isArray(remaining)) {
      verdict(1, 'source_lift_left_remaining_work',
        !remaining.some(x => /bench/i.test(JSON.stringify(x))),
        `remaining=${JSON.stringify(remaining).slice(0, 200)}`);
    }

    // Finish the rest of the workout, then preview → approve → write → closeout.
    await logSet(page, 'Seated Row 150 10/2', 1, 'log_seated_row');
    await logSet(page, 'Bicep Curl 35 12/2', 1, 'log_bicep_curl');

    // One finish path for every session — see finishAndSave.
    const result = await finishAndSave(page, srv, 1, 6, 'S1-03');
    verdict(1, 'final_preview_does_not_keep_bench',
      !/still on your plan[^.]*bench/i.test(result.previewText),
      'the final preview must not say Bench Press remains');
    verdict(1, 'replacement_is_in_the_log',
      result.logRows.map(r => String(r[LOG_EXERCISE] || '')).some(e => /incline/i.test(e)),
      `logged exercises: ${result.logRows.map(r => String(r[LOG_EXERCISE] || '')).join(', ')}`);
    await checkWeeklySummary(srv.base, 1);
    writeSessionEvidence(1, runId, srv, result);

    assertSessionPassed(1);
  } finally {
    dumpDiagnostics(SESSION_NO);
    srv.stop();
  }
});

// =================================================================================
// SESSION 2 — conversational correction
//
// DECLARED EXPECTATION:
//   plan            5 exercises: SQ01, OHP01, RDL01, BEN01, SR01, 1 set each
//   ledger at accept 5 Session_Plan_Sets rows
//   the correction  "No I meant a substitute workout for bench press, like incline
//                   dumbbell or something" → a substitution proposal, NEVER a skip and
//                   never whole-session generation
//   the restatement "Well I was asking for a substitute" → still ONE bounded proposal,
//                   no subject change, no unrelated historical Bench Press concern
//   the follow-up   "How much?" → deterministic, proposal-grounded
//   acceptance      "Yes use that" → exactly 1 substituted item_outcome
//   repeated "yes"  → still exactly 1 (idempotent)
//   durable rows    5 Log_Cleaned rows · 1 finalized closeout · ledger sealed
// =================================================================================
test('S2 — a conversational "No" is a correction, not a skip, and a generic yes binds once', async ({ page }) => {
  const SESSION_NO = 2;
  const runId = freshRunId(2);
  const srv = await bootRehearsalServer();
  try {
    verdict(2, 'model_up_posture', /GATE_MODEL_POSTURE=model-up/.test(srv.banner), srv.banner.match(/GATE_MODEL_POSTURE=[^\n]*/)?.[0]);
    verdict(2, 'sandbox_posture', /GATE_SHEETS_POSTURE=sandbox-live/.test(srv.banner), srv.banner.match(/GATE_SHEETS_POSTURE=[^\n]*/)?.[0]);
    await openApp(page, srv.base);

    await acceptPlan(page, [
      { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 1, target_rir: 2 },
      { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 115, target_reps: 6, target_sets: 1, target_rir: 2 },
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 1, target_rir: 3 },
      { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 185, target_reps: 5, target_sets: 1, target_rir: 2 },
      { exercise: 'Seated Row', lift_code: 'SR01', target_weight: 150, target_reps: 10, target_sets: 1, target_rir: 2 },
    ], runId);
    await expect.poll(async () => rowsFor(await srv.state(), 'Session_Plan_Sets').length, { timeout: 90000 }).toBe(5);
    verdict(2, 'accept_checkpoint_rows', true, '5 Session_Plan_Sets rows checkpointed at accept');

    await logSet(page, 'Back Squat 225 5/2', 2, 'log_back_squat');
    await logSet(page, 'Overhead Press 115 6/2', 2, 'log_overhead_press');
    await logSet(page, 'Romanian Deadlift 245 6/3', 2, 'log_rdl');

    // The correction. The live failure turned "No I'm looking for a substitute for bench
    // press" into a SKIP that silently dropped the lift.
    const beforeCorrection = await srv.state();
    const correctionProse = await requestSubstitute(page, 'No I meant a substitute workout for bench press, like incline dumbbell or something');
    await snap(page, 'S2-01-correction.png');

    const afterCorrection = await srv.state();
    const skipped = rowsFor(afterCorrection, 'Session_Plans')
      .filter(r => String(r[SP_EVENT]) === 'item_outcome' && /skip/i.test(String(r[SP_OUTCOME])));
    verdict(2, 'no_becomes_correction_not_skip', skipped.length === 0,
      `a conversational "No" emitted ${skipped.length} skip outcome(s) — it must never drop the lift`);
    verdict(2, 'correction_mutates_nothing',
      substitutedOutcomes(afterCorrection).length === substitutedOutcomes(beforeCorrection).length,
      'a correction must not mutate before acceptance');
    verdict(2, 'correction_not_whole_session_generation',
      !/today,?\s+let'?s\s+make\s+it/i.test(correctionProse),
      `the correction must stay a lift-level swap: ${JSON.stringify(correctionProse.slice(0, 200))}`);
    verdict(2, 'correction_claims_nothing_noted',
      !COMPLETED_MUTATION_WORDING.some(re => re.test(correctionProse)),
      `no claim the substitution was noted before acceptance: ${JSON.stringify(correctionProse.slice(0, 200))}`);
    verdict(2, 'correction_addresses_the_substitution', /substitut|replace|incline/i.test(correctionProse),
      `Atlas must stay on the subject: ${JSON.stringify(correctionProse.slice(0, 200))}`);

    // The restatement. It must not stack a second proposal or change the subject.
    const restateProse = await requestSubstitute(page, 'Well I was asking for a substitute');
    await snap(page, 'S2-02-restatement.png');
    verdict(2, 'restatement_keeps_one_proposal',
      (await page.locator('.replacement-proposal-line').count()) <= 2,
      'the restatement must not stack unbounded proposals');
    verdict(2, 'restatement_stays_on_subject', /substitut|replace|incline|swap/i.test(restateProse),
      `Atlas must not change subjects: ${JSON.stringify(restateProse.slice(0, 200))}`);

    // The short follow-up, answered from the proposal.
    await say(page, 'How much?');
    await expect(lastAtlas(page)).toBeVisible({ timeout: 45000 });
    await page.waitForTimeout(3000);
    const howMuch = await lastAtlas(page).innerText();
    await snap(page, 'S2-03-how-much.png');
    verdict(2, 'follow_up_is_proposal_grounded', /\d+\s*lb|\d+\s*reps?/i.test(howMuch),
      `"How much?" must be answered from the engine-owned prescription: ${JSON.stringify(howMuch.slice(0, 200))}`);
    verdict(2, 'follow_up_claims_nothing_active',
      !COMPLETED_MUTATION_WORDING.some(re => re.test(howMuch)),
      `the answer must not present the swap as applied: ${JSON.stringify(howMuch.slice(0, 200))}`);

    // Natural shorthand acceptance.
    await say(page, 'Yes use that');
    await page.waitForTimeout(6000);
    await snap(page, 'S2-04-accepted.png');
    const afterYes = await srv.state();
    verdict(2, 'generic_yes_binds_exactly_once', substitutedOutcomes(afterYes).length === 1,
      `expected exactly 1 substituted item_outcome after "Yes use that", found ${substitutedOutcomes(afterYes).length}`);

    // Repeating the acceptance must not duplicate the canonical outcome.
    await say(page, 'yes');
    await page.waitForTimeout(5000);
    const afterSecondYes = await srv.state();
    verdict(2, 'repeated_yes_is_idempotent', substitutedOutcomes(afterSecondYes).length === 1,
      `a repeated "yes" produced ${substitutedOutcomes(afterSecondYes).length} substituted outcomes`);

    await logSet(page, 'Incline Dumbbell Press 90 10/2', 2, 'log_replacement');
    await logSet(page, 'Seated Row 150 10/2', 2, 'log_seated_row');

    const result = await finishAndSave(page, srv, 2, 5, 'S2-05');
    const finalSubs = substitutedOutcomes(result.state);
    verdict(2, 'exactly_one_substituted_outcome_at_end', finalSubs.length === 1,
      `expected exactly 1 substituted item_outcome overall, found ${finalSubs.length}`);
    if (finalSubs.length === 1) {
      verdict(2, 'outcome_binds_source_slot', String(finalSubs[0][SP_PLANNED]).toUpperCase() === 'BEN01',
        `planned_lift_code=${finalSubs[0][SP_PLANNED]}`);
      verdict(2, 'outcome_retains_source_item_id', String(finalSubs[0][SP_ITEM] || '').trim() !== '',
        `plan_item_id=${finalSubs[0][SP_ITEM]}`);
    }
    await checkWeeklySummary(srv.base, 2);
    writeSessionEvidence(2, runId, srv, result);
    assertSessionPassed(2);
  } finally {
    dumpDiagnostics(SESSION_NO);
    srv.stop();
  }
});

// =================================================================================
// SESSION 3 — the replacement appears SECOND in a batch (the Codex P1 edge, full-session)
//
// DECLARED EXPECTATION:
//   plan            5 exercises: SQ01, OHP01, RDL01, BEN01, SR01, 1 set each
//   staged          a legitimate replacement proposal for BEN01
//   the batch       one multi-exercise log where ANOTHER VALID exercise is FIRST
//                   (Seated Row, on plan) and the PROPOSED REPLACEMENT is SECOND
//                   (Incline Dumbbell Press)
//   plus            one genuinely unrelated off-plan exercise, logged separately, which
//                   must remain a legitimate INSERTION and never be read as a substitution
//   require         the binder examines EVERY logged exercise, not only the first;
//                   exactly 1 substituted item_outcome bound to BEN01; no duplicate when
//                   the batch or the acceptance repeats; BEN01 does not stay pending
//   "What do I have left?" → canonical plan state, not chat memory
//   durable rows    6 Log_Cleaned rows · 1 finalized closeout · ledger sealed
// =================================================================================
test('S3 — a replacement second in a batch still binds to its source slot, exactly once', async ({ page }) => {
  const SESSION_NO = 3;
  const runId = freshRunId(3);
  const srv = await bootRehearsalServer();
  try {
    verdict(3, 'model_up_posture', /GATE_MODEL_POSTURE=model-up/.test(srv.banner), srv.banner.match(/GATE_MODEL_POSTURE=[^\n]*/)?.[0]);
    verdict(3, 'sandbox_posture', /GATE_SHEETS_POSTURE=sandbox-live/.test(srv.banner), srv.banner.match(/GATE_SHEETS_POSTURE=[^\n]*/)?.[0]);
    await openApp(page, srv.base);

    await acceptPlan(page, [
      { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 1, target_rir: 2 },
      { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 115, target_reps: 6, target_sets: 1, target_rir: 2 },
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 1, target_rir: 3 },
      { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 185, target_reps: 5, target_sets: 1, target_rir: 2 },
      { exercise: 'Seated Row', lift_code: 'SR01', target_weight: 150, target_reps: 10, target_sets: 1, target_rir: 2 },
    ], runId);
    await expect.poll(async () => rowsFor(await srv.state(), 'Session_Plan_Sets').length, { timeout: 90000 }).toBe(5);
    verdict(3, 'accept_checkpoint_rows', true, '5 Session_Plan_Sets rows checkpointed at accept');

    await logSet(page, 'Back Squat 225 5/2', 3, 'log_back_squat');
    await logSet(page, 'Overhead Press 115 6/2', 3, 'log_overhead_press');
    await logSet(page, 'Romanian Deadlift 245 6/3', 3, 'log_rdl');

    // Stage the proposal for Bench Press.
    const proposalProse = await requestSubstitute(page, 'The bench is taken at the gym so plan give me a substitute workout');
    await snap(page, 'S3-01-proposal-staged.png');
    verdict(3, 'proposal_staged', /incline|replace|substitut/i.test(proposalProse),
      `a replacement proposal must be staged: ${JSON.stringify(proposalProse.slice(0, 200))}`);
    verdict(3, 'staging_mutates_nothing', substitutedOutcomes(await srv.state()).length === 0,
      'staging a proposal must write no item_outcome');

    // THE EDGE: the proposed replacement is SECOND in the batch. A binder that examined
    // only the first logged exercise would resolve Incline as an unrelated insertion and
    // leave Bench Press pending.
    const beforeBatch = await page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : 0));
    await say(page, 'Seated Row 150 10/2 and Incline Dumbbell Press 90 10/2');
    let afterBatch = beforeBatch;
    for (let i = 0; i < 40 && afterBatch < beforeBatch + 2; i += 1) {
      await page.waitForTimeout(1000);
      afterBatch = await page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : 0));
    }
    await snap(page, 'S3-02-batch-logged.png');
    verdict(3, 'batch_commits_both_exercises', afterBatch >= beforeBatch + 2,
      `session log ${beforeBatch} → ${afterBatch}; the batch must commit both logged exercises`);

    const afterBatchState = await srv.state();
    const batchSubs = substitutedOutcomes(afterBatchState);
    verdict(3, 'binder_examines_every_logged_exercise', batchSubs.length === 1,
      `expected exactly 1 substituted item_outcome from the batch, found ${batchSubs.length} — a binder that reads only the first exercise finds 0`);
    if (batchSubs.length === 1) {
      verdict(3, 'batch_replacement_binds_source_slot', String(batchSubs[0][SP_PLANNED]).toUpperCase() === 'BEN01',
        `planned_lift_code=${batchSubs[0][SP_PLANNED]} (must be the ORIGINAL Bench Press slot)`);
      verdict(3, 'batch_outcome_retains_item_id', String(batchSubs[0][SP_ITEM] || '').trim() !== '',
        `plan_item_id=${batchSubs[0][SP_ITEM]}`);
    }

    // Repeating the batch must not duplicate the canonical outcome.
    await say(page, 'Seated Row 150 10/2 and Incline Dumbbell Press 90 10/2');
    await page.waitForTimeout(8000);
    verdict(3, 'repeated_batch_no_duplicate_outcome', substitutedOutcomes(await srv.state()).length === 1,
      `a repeated batch produced ${substitutedOutcomes(await srv.state()).length} substituted outcomes`);

    // A genuinely unrelated off-plan lift must stay an INSERTION — never inferred as a
    // substitution from similarity.
    const subsBeforeOffPlan = substitutedOutcomes(await srv.state()).length;
    await logSet(page, 'Lateral Raise 20 15/2', 3, 'log_off_plan_insertion');
    const afterOffPlan = await srv.state();
    verdict(3, 'off_plan_stays_an_insertion', substitutedOutcomes(afterOffPlan).length === subsBeforeOffPlan,
      `an unrelated off-plan lift added ${substitutedOutcomes(afterOffPlan).length - subsBeforeOffPlan} substitution outcome(s) — it must stay an insertion`);

    // Canonical remaining work, not chat memory.
    await say(page, 'What do I have left?');
    await expect(lastAtlas(page)).toBeVisible({ timeout: 45000 });
    await page.waitForTimeout(3000);
    const leftProse = await lastAtlas(page).innerText();
    await snap(page, 'S3-03-what-is-left.png');
    verdict(3, 'remaining_work_excludes_substituted_slot', !/bench\s*press/i.test(leftProse),
      `Bench Press was substituted and must not remain: ${JSON.stringify(leftProse.slice(0, 220))}`);

    const result = await finishAndSave(page, srv, 3, 6, 'S3-04');
    verdict(3, 'exactly_one_substituted_outcome_at_end', substitutedOutcomes(result.state).length === 1,
      `expected exactly 1 substituted item_outcome overall, found ${substitutedOutcomes(result.state).length}`);
    await checkWeeklySummary(srv.base, 3);
    writeSessionEvidence(3, runId, srv, result);
    assertSessionPassed(3);
  } finally {
    dumpDiagnostics(SESSION_NO);
    srv.stop();
  }
});

// =================================================================================
// SESSION 4 — save, closeout, and HONEST INCOMPLETENESS
//
// DECLARED EXPECTATION:
//   plan            4 exercises: SQ01, OHP01, RDL01, BEN01, 1 set each
//   performed       3 of them; BEN01 deliberately left UNFINISHED
//   the ending      "I'm done for today" — Atlas reports remaining work HONESTLY and
//                   fabricates no completion
//   effort          NONE supplied → ZERO Effort rows expected, and their absence must
//                   NOT fail the workout write
//   the control     reaches a completed state and never stays on "Saving…"
//   durable rows    3 Log_Cleaned rows · 0 Effort rows · 1 finalized closeout
//   idempotence     one approved save writes once; a repeated approval writes nothing
//   teardown        a reloaded session inherits no proposal, log, or pending state
//   endpoint        GET /api/summary/weekly → HTTP 200 with a bounded body
// =================================================================================
test('S4 — an honestly unfinished lift still saves, seals, and reports the truth', async ({ page }) => {
  const SESSION_NO = 4;
  const runId = freshRunId(4);
  const srv = await bootRehearsalServer();
  try {
    verdict(4, 'model_up_posture', /GATE_MODEL_POSTURE=model-up/.test(srv.banner), srv.banner.match(/GATE_MODEL_POSTURE=[^\n]*/)?.[0]);
    verdict(4, 'sandbox_posture', /GATE_SHEETS_POSTURE=sandbox-live/.test(srv.banner), srv.banner.match(/GATE_SHEETS_POSTURE=[^\n]*/)?.[0]);
    await openApp(page, srv.base);

    await acceptPlan(page, [
      { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 1, target_rir: 2 },
      { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 115, target_reps: 6, target_sets: 1, target_rir: 2 },
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 1, target_rir: 3 },
      { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 185, target_reps: 5, target_sets: 1, target_rir: 2 },
    ], runId);
    await expect.poll(async () => rowsFor(await srv.state(), 'Session_Plan_Sets').length, { timeout: 90000 }).toBe(4);
    verdict(4, 'accept_checkpoint_rows', true, '4 Session_Plan_Sets rows checkpointed at accept');

    await logSet(page, 'Back Squat 225 5/2', 4, 'log_back_squat');
    await logSet(page, 'Overhead Press 115 6/2', 4, 'log_overhead_press');
    await logSet(page, 'Romanian Deadlift 245 6/3', 4, 'log_rdl');
    // Bench Press is deliberately NOT performed.

    await say(page, "I'm done for today");
    await expect(page.locator('.closeout-confirm')).toHaveCount(1, { timeout: 60000 });
    await snap(page, 'S4-01-ending-early.png');
    const closeoutText = await page.locator('.closeout-confirm').innerText();

    // Honest incompleteness: the unfinished lift is REPORTED, not hidden and not invented.
    verdict(4, 'remaining_work_reported_honestly', /bench\s*press/i.test(closeoutText),
      `the unfinished Bench Press must be reported: ${JSON.stringify(closeoutText.slice(0, 300))}`);
    verdict(4, 'no_fabricated_completion',
      !/all\s+(\d+\s+)?(exercises|lifts)\s+(are\s+)?(complete|done)/i.test(closeoutText),
      `completion must not be fabricated: ${JSON.stringify(closeoutText.slice(0, 300))}`);

    const result = await finishAndSave(page, srv, 4, 3, 'S4-02');

    // No effort was supplied, so no Effort row may exist — and its absence must not have
    // failed the write, which the 3 durable Log rows above already prove.
    const effortRows = rowsFor(result.state, 'Effort');
    verdict(4, 'no_effort_row_expected', effortRows.length === 0,
      `no Apple Watch effort was supplied, so 0 Effort rows are expected; found ${effortRows.length}`);

    // An honestly unfinished lift is NOT a substitution contradiction.
    verdict(4, 'incompleteness_is_not_a_substitution_contradiction',
      substitutedOutcomes(result.state).length === 0,
      `an unfinished lift produced ${substitutedOutcomes(result.state).length} substitution outcome(s) — it must produce none`);

    await checkWeeklySummary(srv.base, 4);

    // Teardown: a fresh load must inherit nothing from this session.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(4000);
    const inherited = await page.evaluate(() => ({
      log: window.getSessionLog ? window.getSessionLog().length : 0,
      proposals: document.querySelectorAll('.replacement-proposal-line').length,
    }));
    await snap(page, 'S4-03-after-reload.png');
    verdict(4, 'session_state_tears_down_cleanly', inherited.log === 0 && inherited.proposals === 0,
      `a reloaded session inherited log=${inherited.log} proposals=${inherited.proposals}; both must be 0`);

    writeSessionEvidence(4, runId, srv, result, { effort_rows: effortRows.length });
    assertSessionPassed(4);
  } finally {
    dumpDiagnostics(SESSION_NO);
    srv.stop();
  }
});

// =================================================================================
// SESSION 5 — referent drift and EVENING correlation
//
// DECLARED EXPECTATION:
//   clock           a controlled PACIFIC EVENING timestamp whose UTC date is the NEXT day
//                   (TZ=America/Los_Angeles plus the harness clock shim) — the exact shape
//                   that made `atlas:review-live` report a passing session all-UNKNOWN
//   plan            5 exercises: OHP01, SQ01, RDL01, BEN01, SR01, 1 set each
//   early           the PRESS (Overhead Press) is completed first — it is the lift a
//                   drifting referent would wrongly reach back to
//   later           a FRESH substitution proposal for a DIFFERENT current lift (BEN01),
//                   then "How much should I lift?"
//   require         the answer uses the FRESH proposal and does not drift to the finished
//                   press; it carries only engine-owned prescription facts
//   durable rows    5 Log_Cleaned rows · 1 substituted outcome · 1 finalized closeout
//   review          the corrected reviewer correlates the PACIFIC-LOCAL workout date
//                   despite the next-day UTC transcript; text and JSON agree; no
//                   all-UNKNOWN verdict; no rows from another session
//   endpoint        GET /api/summary/weekly → HTTP 200
// =================================================================================
test('S5 — an evening session: the referent stays on the fresh proposal and the reviewer finds it', async ({ page }) => {
  const SESSION_NO = 5;
  const runId = freshRunId(5);

  // Place the session at 20:34 Pacific, whose UTC instant is 03:34 the FOLLOWING day.
  // `services/sessionId.js` derives the session date and AM/PM from process-local time,
  // so TZ plus the offset reproduce the condition deterministically at any real hour.
  const realNow = new Date();
  const target = new Date(Date.UTC(realNow.getUTCFullYear(), realNow.getUTCMonth(), realNow.getUTCDate(), 3, 34, 0));
  if (target.getTime() <= realNow.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  const clockOffsetMs = target.getTime() - realNow.getTime();

  const srv = await bootRehearsalServer({
    TZ: 'America/Los_Angeles',
    ATLAS_GATE_CLOCK_OFFSET_MS: String(clockOffsetMs),
  });
  try {
    verdict(5, 'model_up_posture', /GATE_MODEL_POSTURE=model-up/.test(srv.banner), srv.banner.match(/GATE_MODEL_POSTURE=[^\n]*/)?.[0]);
    verdict(5, 'sandbox_posture', /GATE_SHEETS_POSTURE=sandbox-live/.test(srv.banner), srv.banner.match(/GATE_SHEETS_POSTURE=[^\n]*/)?.[0]);

    const shifted = srv.banner.match(/shifted_now=(\S+)/)?.[1] || '';
    const shiftedUtcDate = shifted.slice(0, 10);
    const localDate = new Date(target.getTime()).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    verdict(5, 'evening_condition_established', Boolean(shiftedUtcDate) && localDate < shiftedUtcDate,
      `Pacific-local date ${localDate} must precede the UTC date ${shiftedUtcDate} (shifted_now=${shifted})`);

    await openApp(page, srv.base);
    await acceptPlan(page, [
      { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 115, target_reps: 6, target_sets: 1, target_rir: 2 },
      { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 1, target_rir: 2 },
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 1, target_rir: 3 },
      { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 185, target_reps: 5, target_sets: 1, target_rir: 2 },
      { exercise: 'Seated Row', lift_code: 'SR01', target_weight: 150, target_reps: 10, target_sets: 1, target_rir: 2 },
    ], runId);
    await expect.poll(async () => rowsFor(await srv.state(), 'Session_Plan_Sets').length, { timeout: 90000 }).toBe(5);
    verdict(5, 'accept_checkpoint_rows', true, '5 Session_Plan_Sets rows checkpointed at accept');

    // The PRESS completes early — this is the referent a drifting answer reaches back to.
    await logSet(page, 'Overhead Press 115 6/2', 5, 'log_the_early_press');
    await logSet(page, 'Back Squat 225 5/2', 5, 'log_back_squat');
    await logSet(page, 'Romanian Deadlift 245 6/3', 5, 'log_rdl');

    // A FRESH proposal, for a DIFFERENT current lift.
    const proposalProse = await requestSubstitute(page, 'The bench is taken at the gym so plan give me a substitute workout');
    await snap(page, 'S5-01-fresh-proposal.png');
    verdict(5, 'fresh_proposal_staged', /incline|replace|substitut/i.test(proposalProse),
      `a fresh proposal must be staged: ${JSON.stringify(proposalProse.slice(0, 200))}`);

    await say(page, 'How much should I lift?');
    await expect(lastAtlas(page)).toBeVisible({ timeout: 45000 });
    await page.waitForTimeout(3000);
    const drift = await lastAtlas(page).innerText();
    await snap(page, 'S5-02-referent.png');

    // The referent must be the FRESH proposal, never the press finished earlier.
    verdict(5, 'referent_does_not_drift_to_finished_press', !/overhead\s*press/i.test(drift),
      `the answer drifted back to the completed press: ${JSON.stringify(drift.slice(0, 240))}`);
    verdict(5, 'referent_uses_the_fresh_proposal', /incline/i.test(drift),
      `the answer must use the fresh proposal: ${JSON.stringify(drift.slice(0, 240))}`);
    verdict(5, 'referent_carries_engine_facts_only', /\d+\s*lb|\d+\s*reps?/i.test(drift),
      `the answer must carry engine-owned prescription facts: ${JSON.stringify(drift.slice(0, 240))}`);

    const approve = approveControl(page);
    if (await approve.isVisible().catch(() => false)) {
      await approve.click({ timeout: 15000 });
      await page.waitForTimeout(4000);
    }
    verdict(5, 'acceptance_mutates_exactly_once', substitutedOutcomes(await srv.state()).length === 1,
      `expected exactly 1 substituted item_outcome, found ${substitutedOutcomes(await srv.state()).length}`);

    await logSet(page, 'Incline Dumbbell Press 90 10/2', 5, 'log_replacement');
    await logSet(page, 'Seated Row 150 10/2', 5, 'log_seated_row');

    const result = await finishAndSave(page, srv, 5, 5, 'S5-03');
    await checkWeeklySummary(srv.base, 5);

    // ── the corrected reviewer, on the exact session identity ────────────────
    //
    // The rehearsal deliberately writes NO Flight_Recorder rows — telemetry persistence is
    // off and the guard's append allowlist excludes that tab, so synthetic traffic can
    // never pollute an evidence tab. The reviewer still needs a transcript to select a
    // session by, so this session's own transcript is materialized LOCALLY and the real
    // CLI is run against it with `--from-dir`, joined to the REAL durable sandbox rows.
    // That exercises the corrected tool end-to-end on genuine rows without writing
    // anything the owner did not authorize.
    const workoutId = result.sessionIds[0] || '';
    const reviewDir = path.join(artDir, 'S5-review-input');
    fs.mkdirSync(reviewDir, { recursive: true });

    const { SANDBOX_SPREADSHEET_ID } = require('../../../config/sandboxSheet');
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        type: 'service_account',
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheetsApi = google.sheets({ version: 'v4', auth: await auth.getClient() });
    for (const tab of ['Log_Cleaned', 'Effort', 'Session_Plans', 'Session_Plan_Sets']) {
      const resp = await sheetsApi.spreadsheets.values.get({ spreadsheetId: SANDBOX_SPREADSHEET_ID, range: `${tab}!A:Z` });
      fs.writeFileSync(path.join(reviewDir, `${tab}.json`), JSON.stringify(resp.data.values || []));
    }

    // This session's transcript, at the EVENING UTC instants — the condition under test.
    const flightSessionId = `FR-FSB4B-S5-${crypto.randomBytes(4).toString('hex')}`;
    const t0 = new Date(target.getTime());
    const frRows = [
      ['captured_at', 'flight_session_id', 'seq', 'app_version', 'device_id', 'route', 'event_type',
        'user_input', 'user_action', 'ui_snapshot_json', 'session_state_json', 'api_endpoint',
        'request_summary', 'response_summary', 'decision_summary_json', 'shadow_refs_json', 'error', 'latency_ms'],
      [t0.toISOString(), flightSessionId, '1', 'fsb4b', 'rehearsal', 'logger', 'user_input',
        'overhead press 115 6/2', '', '', '', '', '', '', '', '', '', ''],
      [new Date(t0.getTime() + 300000).toISOString(), flightSessionId, '2', 'fsb4b', 'rehearsal', 'logger',
        'api_response', '', '', '', '', 'POST /api/log-workout', '', '200 OK', '', '', '', '180'],
    ];
    fs.writeFileSync(path.join(reviewDir, 'Flight_Recorder.json'), JSON.stringify(frRows));

    const runReview = args => new Promise(resolve => {
      const p = spawn(process.execPath, [path.join(__dirname, '..', '..', '..', 'scripts', 'atlas-review-live.js'), ...args],
        { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      const timer = setTimeout(() => { p.kill('SIGTERM'); resolve({ out, err, timedOut: true }); }, 120000);
      p.stdout.on('data', d => { out += String(d); });
      p.stderr.on('data', d => { err += String(d); });
      p.on('exit', code => { clearTimeout(timer); resolve({ out, err, code, timedOut: false }); });
    });

    const baseArgs = [`--from-dir=${reviewDir}`, `--session=${flightSessionId}`, `--workout-session=${workoutId}`];
    const jsonRun = await runReview([...baseArgs, '--json']);
    const textRun = await runReview(baseArgs);
    fs.writeFileSync(path.join(artDir, 'S5-review.json'), jsonRun.out);
    fs.writeFileSync(path.join(artDir, 'S5-review.txt'), textRun.out);

    let review = null;
    try { review = JSON.parse(jsonRun.out); } catch { /* reported below */ }
    verdict(5, 'reviewer_produced_a_verdict', review !== null,
      `the reviewer must emit parseable JSON: ${JSON.stringify(String(jsonRun.out).slice(0, 200))} ${JSON.stringify(String(jsonRun.err).slice(0, 200))}`);

    if (review) {
      verdict(5, 'reviewer_selected_the_exact_session', review.session && review.session.flight_session_id === flightSessionId,
        `selected ${review.session && review.session.flight_session_id}, expected ${flightSessionId}`);
      verdict(5, 'reviewer_correlated_the_evening_rows', review.session && review.session.log_rows === 5,
        `the Pacific-local rows must correlate despite the next-day UTC transcript; log_rows=${review.session && review.session.log_rows}`);
      verdict(5, 'reviewer_join_is_exact', review.log_correlation && review.log_correlation.basis === 'explicit_session_id',
        `join basis=${review.log_correlation && review.log_correlation.basis}`);
      verdict(5, 'reviewer_attributed_no_foreign_rows',
        review.log_correlation && Array.isArray(review.log_correlation.established_session_ids)
          && review.log_correlation.established_session_ids.length === 1
          && review.log_correlation.established_session_ids[0] === String(workoutId).toLowerCase(),
        `established ids=${JSON.stringify(review.log_correlation && review.log_correlation.established_session_ids)}, expected only ${String(workoutId).toLowerCase()}`);
      const allUnknown = Array.isArray(review.criteria) && review.criteria.length > 0
        && review.criteria.every(c => c.verdict === 'UNKNOWN');
      verdict(5, 'reviewer_gave_no_all_unknown_verdict', !allUnknown,
        'the reviewer must not report every criterion UNKNOWN for a session that wrote and sealed');
      verdict(5, 'reviewer_text_and_json_agree',
        textRun.out.includes(flightSessionId) && textRun.out.includes(String(review.overall)),
        `the text run must name the same session and the same overall verdict (${review.overall})`);
    }

    writeSessionEvidence(5, runId, srv, result, {
      flight_session_id: flightSessionId,
      pacific_local_date: localDate,
      utc_date: shiftedUtcDate,
      clock_offset_ms: clockOffsetMs,
    });
    assertSessionPassed(5);
  } finally {
    dumpDiagnostics(SESSION_NO);
    srv.stop();
  }
});
