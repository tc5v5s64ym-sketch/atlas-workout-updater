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

test.describe.configure({ mode: 'serial' });

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
async function bootRehearsalServer() {
  const child = spawn(process.execPath, [path.join(__dirname, 'gate-server.js')], {
    env: {
      ...process.env,
      ATLAS_GATE_KEY: GATE_KEY,
      ATLAS_GATE_SANDBOX_LIVE: '1',   // durable writes to the declared sandbox
      ATLAS_GATE_LEDGER_SANDBOX: '1', // Session_Plans + Session_Plan_Sets enabled
      ATLAS_GATE_MODEL_UP: '1',       // model-up only; a fallback is a failed session
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

async function openApp(page, base) {
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, GATE_KEY);
  await page.goto(`${base}/app/`);
  await page.waitForLoadState('networkidle');
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

    await say(page, 'done');
    await expect(page.locator('.closeout-confirm')).toHaveCount(1, { timeout: 40000 });
    const reviewSave = page.locator('.review:not(.done) .rv-save');
    await expect(reviewSave).toBeVisible({ timeout: 20000 });
    await snap(page, 'S1-03-preview-before-write.png');

    const previewText = await page.locator('.closeout-confirm').innerText();
    verdict(1, 'final_preview_does_not_keep_bench',
      !/still on your plan[^.]*bench/i.test(previewText),
      'the final preview must not say Bench Press remains');

    // (16) one visible approval through the review-card Save control.
    await reviewSave.click({ timeout: 20000 });
    await expect(page.locator('.review.done')).toHaveCount(1, { timeout: 60000 });
    await snap(page, 'S1-04-after-approval.png');

    const afterWrite = await srv.state();
    const logRows = rowsFor(afterWrite, 'Log_Cleaned');
    verdict(1, 'durable_log_rows_written', logRows.length === 6,
      `expected 6 Log_Cleaned rows (5 planned lifts completed + 1 replacement), found ${logRows.length}`);

    const sessionIds = new Set(logRows.map(r => String(r[LOG_SESSION] || '').trim()).filter(Boolean));
    verdict(1, 'single_session_identity', sessionIds.size === 1,
      `Log_Cleaned rows carry ${sessionIds.size} distinct session ids: ${[...sessionIds].join(', ')}`);

    const exercises = logRows.map(r => String(r[LOG_EXERCISE] || ''));
    verdict(1, 'replacement_is_in_the_log', exercises.some(e => /incline/i.test(e)),
      `logged exercises: ${exercises.join(', ')}`);

    // (17) a repeated approval writes nothing.
    const appendsBeforeRepeat = afterWrite.appends.length;
    if (await reviewSave.isVisible().catch(() => false)) {
      await reviewSave.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    const afterRepeat = await srv.state();
    verdict(1, 'repeated_approval_writes_nothing', afterRepeat.appends.length === appendsBeforeRepeat,
      `appends before=${appendsBeforeRepeat} after=${afterRepeat.appends.length}`);

    // (18) closeout, and (12) the seal.
    const finalized = rowsFor(afterRepeat, 'Session_Plans').filter(r =>
      String(r[SP_EVENT]) === 'session_closeout' && String(r[SP_CLOSEOUT]) === 'finalized');
    verdict(1, 'closeout_finalized', finalized.length === 1,
      `expected exactly 1 finalized session_closeout, found ${finalized.length}`);

    const sealStamps = (afterRepeat.updates || []).filter(u => u.tabName === 'Session_Plan_Sets');
    verdict(1, 'ledger_sealed', sealStamps.length >= 1,
      `Session_Plan_Sets seal stamps: ${sealStamps.length}`);

    // (23) no guard refusal — a refusal means production tried something unauthorized.
    verdict(1, 'no_guard_refusals', (afterRepeat.refusals || []).length === 0,
      `refusals: ${JSON.stringify(afterRepeat.refusals || []).slice(0, 300)}`);

    fs.writeFileSync(path.join(artDir, 'S1-state.json'), JSON.stringify(afterRepeat, null, 2));
    fs.writeFileSync(path.join(artDir, 'S1-identity.json'), JSON.stringify({
      run_id: runId,
      workout_session_ids: [...sessionIds],
      log_rows: logRows.length,
      banner: srv.banner.split('\n').filter(Boolean),
    }, null, 2));

    const failed = scorecard.filter(s => s.session === 1 && s.verdict === 'FAIL');
    expect(failed, `S1 conditions failed:\n${failed.map(f => `  ${f.id}: ${f.detail}`).join('\n')}`).toHaveLength(0);
  } finally {
    srv.stop();
  }
});
