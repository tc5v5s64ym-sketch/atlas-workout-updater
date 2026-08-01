'use strict';
/*
 * F10D — closeout proving pack (owner directive 2026-07-18), run end-to-end against
 * the REAL app in the gate harness's LEDGER SANDBOX posture: real built client, real
 * server (index.js), the two dry-run flags ON, and a stubbed in-memory
 * Session_Plan_Sets tab — so accept-checkpoint → single confirmation → approved seal
 * is proven with NOTHING real reachable (sheets.js replaced in-process; no Google
 * client ever initializes; no LLM key; Playwright marks every request synthetic).
 *
 * Proves the four contract items that need the live UI path (the rest are proven in
 * test/closeoutSealIntegration.test.js, test/api-smoke.test.js, and the F10B/F10C
 * suites — the coverage map lives in docs/F10D_PRODUCTION_READINESS.md):
 *   R  — a rejected (abandoned) confirmation writes NOTHING: no Log, no Effort, no
 *        finalized event, no seal — while the accept-time ledger checkpoint stays
 *        durable and UNSEALED (amendment A2: closeout seals, never first-persists);
 *   A  — one approved confirmation writes and seals EVERYTHING with exact parity:
 *        visible actual rows = appended Log rows; the immutable original plan =
 *        the sealed ledger rows (substitution kept as SQ01 + performed elsewhere);
 *        effort row appended; finalized event recorded; one shared write_id;
 *   RL — reload/resume mid-session, then closeout: the reconstructed session seals
 *        the SAME durable checkpoint rows written before the reload;
 *   RT — a seal outage after committed appends reports honest-partial, and the
 *        review card's own Save performs the reachable idempotent retry: zero
 *        duplicate rows, the seal lands, the closeout verifies;
 *   NL — F-SB1: a planned session whose accept checkpoint was LOST. The seal
 *        succeeds with nothing to seal, so the server's verdict is still negative
 *        but no retry can ever clear it: the save completes, the negative verdict
 *        is reported, and no unreachable "Retry ledger seal" is offered.
 *
 * Artifacts: numbered screenshots + transcript.json + TRANSCRIPT.md under
 * ATLAS_GATE_ARTIFACT_DIR (default test-results/f10d-closeout/<project>).
 */

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { sessionPlanSetsColumns, sessionPlansColumns } = require('../../../config/columns');

const GATE_KEY = 'playwright-gate-key';
const SEAL_IDX = sessionPlanSetsColumns.indexOf('closeout_write_id');
const PLANNED_CODE_IDX = sessionPlanSetsColumns.indexOf('planned_lift_code');
const EVENT_TYPE_IDX = sessionPlansColumns.indexOf('event_type');
const CLOSEOUT_STATUS_IDX = sessionPlansColumns.indexOf('closeout_status');

let artDir = null;
const transcript = [];

function record(step, note) {
  transcript.push({ at: new Date().toISOString(), step, note });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, testInfo) => {
  artDir = process.env.ATLAS_GATE_ARTIFACT_DIR
    ? path.join(process.env.ATLAS_GATE_ARTIFACT_DIR, testInfo.project.name)
    : path.join(__dirname, '..', '..', '..', 'test-results', 'f10d-closeout', testInfo.project.name);
  fs.mkdirSync(artDir, { recursive: true });
});

test.afterAll(async () => {
  if (artDir) {
    fs.writeFileSync(path.join(artDir, 'transcript.json'), JSON.stringify(transcript, null, 2));
    const md = ['# F10D closeout proving-pack transcript', '', ...transcript.map(t => `- \`${t.at}\` **${t.step}** — ${t.note}`)];
    fs.writeFileSync(path.join(artDir, 'TRANSCRIPT.md'), md.join('\n'));
  }
});

// ---- Per-scenario sandbox server (full isolation: fresh tabs, fresh sessions) ----
async function bootSandbox() {
  const child = spawn(process.execPath, [path.join(__dirname, 'gate-server.js')],
    { env: { ...process.env, ATLAS_GATE_KEY: GATE_KEY, ATLAS_GATE_LEDGER_SANDBOX: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gate-server did not report its ports within 30s')), 30000);
    let buf = '';
    child.stdout.on('data', d => {
      buf += String(d);
      const app = buf.match(/GATE_PORT=(\d+)/);
      const st = buf.match(/GATE_STATE_PORT=(\d+)/);
      if (app && st) { clearTimeout(timer); resolve({ app: app[1], state: st[1] }); }
    });
    child.stderr.on('data', d => process.stderr.write(`[gate-server] ${d}`));
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`gate-server exited early (${code})`)); });
  });
  return {
    child,
    base: `http://127.0.0.1:${ports.app}`,
    stateBase: `http://127.0.0.1:${ports.state}`,
    stop: () => child.kill('SIGTERM'),
    state: async () => (await fetch(`http://127.0.0.1:${ports.state}/state`)).json(),
    armSealFailure: async () => (await fetch(`http://127.0.0.1:${ports.state}/fail-next-seal`)).json(),
    loseCheckpointRows: async () => (await fetch(`http://127.0.0.1:${ports.state}/lose-plan-set-rows`)).json(),
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
  record('say', text);
}

// Store-truth settle for a logging message (chat-first: a parsed set commits live).
async function logSet(page, text) {
  const before = await page.evaluate(() => {
    const t = c => { const n = document.querySelector(`#session-pin .${c}`); return n ? n.textContent : ''; };
    return { pin: `${t('pin-lift')}|${t('pin-sets')}`, closeouts: document.querySelectorAll('.session-closeout').length, logged: window.getSessionLog ? window.getSessionLog().length : 0 };
  });
  await say(page, text);
  await expect
    .poll(() => page.evaluate(prev => {
      const t = c => { const n = document.querySelector(`#session-pin .${c}`); return n ? n.textContent : ''; };
      const pin = `${t('pin-lift')}|${t('pin-sets')}`;
      const closeouts = document.querySelectorAll('.session-closeout').length;
      const logged = window.getSessionLog ? window.getSessionLog().length : 0;
      return pin !== prev.pin || closeouts > prev.closeouts || logged > prev.logged;
    }, before), { timeout: 25000 })
    .toBe(true);
}

// The pin can repaint before the session-log commit lands, so logSet's settle can
// fire early on a pin change. Every scenario pins the EXACT buffered-set count
// before moving on — the closeout compile must never race the last commit.
async function expectLoggedCount(page, n) {
  await expect.poll(() => page.evaluate(() => window.getSessionLog().length), { timeout: 15000 }).toBe(n);
}

async function acceptPlan(page, exercises) {
  const started = await page.evaluate(exs => window.atlasAcceptPlan({
    id: 'work_day', label: 'Work', why_today: 'F10D closeout proving pack.', exercises: exs
  }), exercises);
  expect(started && started.started).toBeTruthy();
}

// The accept-time durable checkpoint (amendment A2) lands async — settle on it.
async function waitForCheckpoint(srv, expectedRows) {
  await expect.poll(async () => (await srv.state()).plan_set_rows.length, { timeout: 15000 })
    .toBe(expectedRows);
}

async function fillEffort(page) {
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('effort-duration', '52:10');
    set('effort-active-cal', '412');
    set('effort-total-cal', '547');
    set('effort-avg-hr', '128');
    set('effort-peak-hr', '166');
  });
  record('effort', 'manual effort typed: 52:10 · 412 active / 547 total cal · 128 avg / 166 peak HR');
}

async function compileCloseout(page) {
  await say(page, 'done');
  await expect(page.locator('.closeout-confirm')).toHaveCount(1, { timeout: 25000 });
  await expect(page.locator('.review:not(.done) .rv-save')).toBeVisible();
}

function rowsFor(state, tab) {
  return state.appends.filter(a => a.tabName === tab).flatMap(a => a.rows);
}

function finalizedEvents(state) {
  return rowsFor(state, 'Session_Plans').filter(r =>
    String(r[EVENT_TYPE_IDX]) === 'session_closeout' && String(r[CLOSEOUT_STATUS_IDX]) === 'finalized');
}

function sealedIds(state) {
  return state.plan_set_rows.map(r => String(r[SEAL_IDX] || ''));
}

async function snap(page, name) {
  await page.screenshot({ path: path.join(artDir, name), fullPage: true });
}

// =================================================================================
test('F10D-R: a rejected (abandoned) confirmation writes NOTHING — the ledger checkpoint stays durable and unsealed', async ({ page }) => {
  test.setTimeout(120000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await acceptPlan(page, [
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 1, target_rir: 3 }
    ]);
    await waitForCheckpoint(srv, 1);
    record('F10D-R', 'plan accepted (RDL 1×245×6@3) — the v1 recommendation checkpointed durably at ACCEPT time (1 ledger row, unsealed)');
    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 1);
    await compileCloseout(page);
    await snap(page, 'R-01-confirmation-rendered.png');
    record('F10D-R', 'closeout confirmation rendered (rows to write + rows to seal visible); Save NOT tapped');

    // Reject by abandonment: reload with the confirmation pending. Nothing may
    // have been written by render, edit, unload, or any other side channel.
    await page.reload();
    await page.waitForLoadState('networkidle');
    const st = await srv.state();
    expect(rowsFor(st, 'Log_Cleaned')).toHaveLength(0);
    expect(rowsFor(st, 'Effort')).toHaveLength(0);
    expect(finalizedEvents(st)).toHaveLength(0);
    expect((st.updates || [])).toHaveLength(0);
    // The two-truths split: the accept-time checkpoint is durable, and UNSEALED.
    expect(st.plan_set_rows).toHaveLength(1);
    expect(sealedIds(st)[0]).toBe('');
    // The session itself survived the rejection — nothing was lost client-side.
    await expect(page.locator('#session-pin')).toBeVisible();
    const logged = await page.evaluate(() => window.getSessionLog().length);
    expect(logged).toBe(1);
    await snap(page, 'R-02-after-rejection-nothing-written.png');
    record('F10D-R', 'rejected: ZERO Log rows, ZERO Effort rows, ZERO finalized events, ZERO seal updates; ledger checkpoint still durable (1 row, closeout_write_id empty); session state intact after reload');
  } finally { srv.stop(); }
});

// =================================================================================
test('F10D-A: one approved confirmation writes and seals everything — exact parity on both truths', async ({ page }) => {
  test.setTimeout(180000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await acceptPlan(page, [
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 2, target_rir: 3 },
      { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 1, target_rir: 2 },
      { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 115, target_reps: 6, target_sets: 1, target_rir: 2 }
    ]);
    await waitForCheckpoint(srv, 4); // 2 + 1 + 1 set-grain rows, v1
    record('F10D-A', 'plan accepted (RDL 2×, Back Squat 1×, OHP 1×) — 4 v1 ledger rows checkpointed at accept');

    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 1);
    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 2);
    await logSet(page, 'Front Squat 185 x 7 @2 instead of Back Squat');   // substitution binds the ORIGINAL slot
    await expectLoggedCount(page, 3);
    await logSet(page, "I don't want to do overhead press");              // deterministic skip
    await logSet(page, 'Bench Press 215 x 5 @2');                         // unplanned work
    await expectLoggedCount(page, 4);
    await fillEffort(page);
    await compileCloseout(page);

    // The single confirmation shows both truths before anything is written.
    const confirm = page.locator('.closeout-confirm');
    await expect(confirm).toContainText('Front Squat');
    await expect(confirm).toContainText('Back Squat');       // the original plan stays visible
    await expect(confirm).toContainText('Bench Press');      // unplanned work listed
    await expect(confirm).toContainText(/Rejecting writes nothing/);
    const foot = await confirm.locator('.cc-foot').innerText();
    expect(foot).toMatch(/Approving writes 4 set row/);
    expect(foot).toMatch(/effort row/);
    expect(foot).toMatch(/4 plan-ledger row/);
    await snap(page, 'A-01-single-confirmation-both-truths.png');
    record('F10D-A', `confirmation shows original plan, effective plan, actuals, substitution, skip, unplanned work, effort; footer: "${foot.replace(/\n/g, ' ')}"`);

    // Capture the VISIBLE actuals before approving — a successful save tears the
    // session down, and the parity claim is about what the owner saw at approval.
    const visible = await page.evaluate(() => window.getSessionLog().map(r => `${String(r.canonical || r.exercise).toLowerCase()}|${r.weight}|${r.reps}`));
    expect(visible).toHaveLength(4);

    await page.locator('.review:not(.done) .rv-save').click();
    await expect(page.locator('.review.done')).toBeVisible({ timeout: 25000 });
    await snap(page, 'A-02-saved-and-verified.png');

    const st = await srv.state();
    // Visible-actual ↔ Log_Cleaned parity: the appended rows are exactly the
    // client's canonical session log (name/weight/reps multisets equal).
    const appended = rowsFor(st, 'Log_Cleaned');
    expect(appended).toHaveLength(4);
    const appendedKey = appended.map(r => `${String(r[3] || r[2]).toLowerCase()}|${r[7]}|${r[8]}`).sort();
    expect(appendedKey).toEqual(visible.sort());
    // Effort parity: the one approval carried the typed effort row.
    const effort = rowsFor(st, 'Effort');
    expect(effort).toHaveLength(1);
    expect(String(effort[0][2])).toBe('52:10');
    expect(String(effort[0][5])).toBe('128');   // average_hr and peak_hr stay distinct
    expect(String(effort[0][6])).toBe('166');
    // Plan-truth immutability: the sealed ledger keeps the ORIGINAL planned codes —
    // the substitution performed Front Squat but the plan row remains SQ01, and the
    // skipped OHP row is sealed history too, never deleted.
    const plannedCodes = st.plan_set_rows.map(r => String(r[PLANNED_CODE_IDX])).sort();
    expect(plannedCodes).toEqual(['OHP01', 'RDL01', 'RDL01', 'SQ01']);
    // One shared closeout_write_id seals every ledger row.
    const ids = sealedIds(st);
    expect(ids).toHaveLength(4);
    expect(ids.every(id => id && id === ids[0])).toBe(true);
    // The finalized Session_Plans event was recorded INSIDE the approved write.
    expect(finalizedEvents(st)).toHaveLength(1);
    record('F10D-A', `approved once: 4 Log rows (= visible actuals), 1 Effort row, 1 finalized event, 4 ledger rows sealed under ${ids[0]}; original plan codes immutable [OHP01, RDL01, RDL01, SQ01]`);
  } finally { srv.stop(); }
});

// =================================================================================
test('F10D-RL: reload mid-session, resume, then closeout — the reconstructed session seals the SAME durable checkpoint', async ({ page }) => {
  test.setTimeout(150000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await acceptPlan(page, [
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 2, target_rir: 3 }
    ]);
    await waitForCheckpoint(srv, 2);
    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 1);
    await snap(page, 'RL-01-mid-session-before-reload.png');

    await page.reload();
    await page.waitForLoadState('networkidle');
    // The session reconstructed from durable state: same slot, same set count.
    await expect(page.locator('#session-pin .pin-lift')).toHaveText('Romanian Deadlift', { timeout: 15000 });
    await expect(page.locator('#session-pin .pin-sets')).toContainText('1 of 2');
    const checkpointAfterReload = (await srv.state()).plan_set_rows.length;
    expect(checkpointAfterReload).toBe(2); // reload re-checkpoints nothing (idempotent lane)
    record('F10D-RL', 'reloaded mid-session — pin resumed at Romanian Deadlift 1 of 2; ledger checkpoint unchanged at 2 rows');
    await snap(page, 'RL-02-resumed-after-reload.png');

    await logSet(page, 'Romanian Deadlift 245 x 5 @2');
    await expectLoggedCount(page, 2);
    await compileCloseout(page);
    await snap(page, 'RL-03-confirmation-after-resume.png');
    await page.locator('.review:not(.done) .rv-save').click();
    await expect(page.locator('.review.done')).toBeVisible({ timeout: 25000 });

    const st = await srv.state();
    expect(rowsFor(st, 'Log_Cleaned')).toHaveLength(2);
    const ids = sealedIds(st);
    expect(ids).toHaveLength(2);
    expect(ids.every(id => id && id === ids[0])).toBe(true);
    expect(finalizedEvents(st)).toHaveLength(1);
    record('F10D-RL', `resumed closeout approved: 2 Log rows, the SAME pre-reload checkpoint rows sealed under ${ids[0]}, 1 finalized event`);
    await snap(page, 'RL-04-sealed-after-resume.png');
  } finally { srv.stop(); }
});

// =================================================================================
test('F10D-RT: a seal outage reports honest-partial; the review card retries idempotently — zero duplicates, then verified', async ({ page }) => {
  test.setTimeout(150000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await acceptPlan(page, [
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 1, target_rir: 3 }
    ]);
    await waitForCheckpoint(srv, 1);
    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 1);
    await fillEffort(page);
    await compileCloseout(page);

    await srv.armSealFailure();
    await page.locator('.review:not(.done) .rv-save').click();

    // Honest partial: the sets are committed, the seal is not — the card must NOT
    // claim a verified closeout, and Save must come back as a real retry.
    await expect.poll(() => page.evaluate(() => {
      const b = document.getElementById('approve-btn');
      return b ? b.textContent : '';
    }), { timeout: 25000 }).toBe('Retry ledger seal');
    const midState = await srv.state();
    expect(rowsFor(midState, 'Log_Cleaned')).toHaveLength(1);
    expect(rowsFor(midState, 'Effort')).toHaveLength(1);
    expect(sealedIds(midState)[0]).toBe('');
    expect(midState.updates.filter(u => u.failed)).toHaveLength(1);
    await snap(page, 'RT-01-honest-partial-retry-offered.png');
    record('F10D-RT', 'seal outage after committed appends: 1 Log row + 1 Effort row written, ledger UNSEALED, no verified claim — Save re-offered as "Retry ledger seal"');

    // The promised retry, through the review card's own Save. F-SB1-B: the owner never
    // sees #approve-btn, so the retry LABEL has to reach the control he actually taps —
    // his Stage B workout 1 screenshot showed it still reading "Saving…" while the status
    // told him to tap Save again.
    const retrySave = page.locator('.review:not(.done) .rv-save');
    await expect(retrySave).toBeEnabled({ timeout: 15000 });
    await expect(retrySave).toHaveText('Retry ledger seal');
    await retrySave.click();
    await expect(page.locator('.review.done')).toBeVisible({ timeout: 25000 });

    const st = await srv.state();
    expect(rowsFor(st, 'Log_Cleaned')).toHaveLength(1);   // no duplicate sets
    expect(rowsFor(st, 'Effort')).toHaveLength(1);        // no duplicate effort
    expect(finalizedEvents(st)).toHaveLength(1);          // event folded idempotently
    const ids = sealedIds(st);
    expect(ids[0]).not.toBe('');
    expect(st.updates.filter(u => !u.failed)).toHaveLength(1);
    record('F10D-RT', `retry healed the closeout idempotently: still 1 Log row, 1 Effort row, 1 finalized event; ledger sealed under ${ids[0]}`);
    await snap(page, 'RT-02-retry-sealed-verified.png');
  } finally { srv.stop(); }
});

// =================================================================================
// F-SB1 — the defect the owner hit on Stage B workout 1 (2026-08-01). His 20 sets were
// written and his closeout event recorded, but the plan ledger held no rows for the
// session, so `closeout_fully_verified` came back false. The client read that as a
// failed seal, told him his workout might be unverified, and offered "Retry ledger
// seal" — a button that re-reads the same absent rows and can never clear. He reported
// the session as "it didn't save the workout". It had.
//
// This is a DIFFERENT failure from RT above: there the seal call broke and a retry
// genuinely heals it. Here the seal call SUCCEEDS (`sealed_ok:true`, `no_ledger:true`)
// and there is nothing a retry could do. The harness reaches it by losing the accept
// checkpoint's rows — the append reports success, the rows never land.
test('F10D-NL: a lost accept checkpoint reports the negative verdict honestly and offers NO unreachable retry', async ({ page }) => {
  test.setTimeout(150000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await srv.loseCheckpointRows();
    await acceptPlan(page, [
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 1, target_rir: 3 }
    ]);
    // The checkpoint ran and believed it succeeded; its rows are simply gone.
    await expect.poll(async () => (await srv.state()).appends
      .filter(a => a.tabName === 'Session_Plan_Sets').length, { timeout: 15000 }).toBe(1);
    const armed = await srv.state();
    expect(armed.plan_set_rows_lost).toBe(true);
    expect(armed.plan_set_rows).toHaveLength(0);
    record('F10D-NL', 'plan accepted (RDL 1×245×6@3); the accept checkpoint appended and reported success, but 0 ledger rows materialized — a lost checkpoint');

    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 1);
    await fillEffort(page);
    await compileCloseout(page);
    await page.locator('.review:not(.done) .rv-save').click();

    // The save COMPLETES. The sets are committed and no second call could bind rows
    // that were never written, so holding the session open would only cost the owner
    // his next workout to a duplicate-session collision.
    await expect(page.locator('.review.done')).toBeVisible({ timeout: 25000 });
    const st = await srv.state();
    expect(rowsFor(st, 'Log_Cleaned')).toHaveLength(1);
    expect(rowsFor(st, 'Effort')).toHaveLength(1);
    expect(finalizedEvents(st)).toHaveLength(1);
    expect(st.plan_set_rows).toHaveLength(0);        // still nothing to seal
    expect(st.updates).toHaveLength(0);              // a working seal stamped nothing

    // The negative verdict is REPORTED — never silently upgraded to a clean success.
    await expect(page.locator('#logger-status')).toContainText('Plan tracking incomplete');
    await expect(page.locator('#logger-status')).toContainText('there is nothing to retry');
    // …and the unreachable retry is NOT offered.
    const approve = page.locator('#approve-btn');
    await expect(approve).not.toHaveText('Retry ledger seal');
    await expect(approve).toHaveText('Written ✓');
    // The session really ended: the buffer is clear, so the next set starts a new one.
    expect(await page.evaluate(() => window.getSessionLog().length)).toBe(0);
    await snap(page, 'NL-01-no-ledger-reported-no-retry.png');
    record('F10D-NL', 'lost checkpoint: 1 Log row + 1 Effort row committed, 1 finalized event, 0 ledger rows, 0 seal stamps; the incomplete-plan-tracking verdict is shown under a completed save, no retry offered, session torn down');
  } finally { srv.stop(); }
});

// =================================================================================
// F10D readiness (owner directive) — the screenshot-with-rows closeout runs through
// the SAME single confirmation. The vision parse is stubbed deterministically in
// the gate server (48:22 · 389/512 cal · 131/168 HR · date 2026-07-18); the parse
// is not under test — the ROUTING is. The scenario shape is the previously-
// bypassing one: an accepted plan NOT complete at upload time (the plan-complete
// shape already routed via the FB closeout lane).

const SHOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

async function uploadShot(page) {
  // The real owner gesture: "+" → "Fitness device screenshot" (flips the effort
  // mode and opens the picker), then the file lands on the input — whose change
  // listener AUTO-SUBMITS the preview flow (no separate Preview tap).
  await page.locator('#composer-attach').click();
  await page.locator('#attach-screenshot').click();
  await page.locator('#effort-image').setInputFiles({ name: 'watch.png', mimeType: 'image/png', buffer: SHOT_PNG });
  record('upload', 'synthetic effort screenshot uploaded (deterministic stubbed parse)');
  await expect(page.locator('.closeout-confirm')).toHaveCount(1, { timeout: 25000 });
  await expect(page.locator('.review:not(.done) .rv-save')).toBeVisible();
}

test('F10D-SS-R: a rejected screenshot-closeout confirmation writes NOTHING', async ({ page }) => {
  test.setTimeout(120000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await acceptPlan(page, [
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 2, target_rir: 3 },
      { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 115, target_reps: 6, target_sets: 1, target_rir: 2 }
    ]);
    await waitForCheckpoint(srv, 3);
    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 1);
    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 2);
    await uploadShot(page);
    await snap(page, 'SS-R-01-confirmation-from-screenshot.png');
    record('F10D-SS-R', 'screenshot upload mid-plan (OHP unperformed) opened the SINGLE confirmation; Save NOT tapped');

    await page.reload();
    await page.waitForLoadState('networkidle');
    const st = await srv.state();
    expect(rowsFor(st, 'Log_Cleaned')).toHaveLength(0);
    expect(rowsFor(st, 'Effort')).toHaveLength(0);
    expect(finalizedEvents(st)).toHaveLength(0);
    expect(st.updates || []).toHaveLength(0);
    expect(st.plan_set_rows).toHaveLength(3);
    expect(sealedIds(st).every(id => id === '')).toBe(true);
    expect((st.vision_calls || []).length).toBeGreaterThanOrEqual(1);
    record('F10D-SS-R', 'rejected: ZERO Log/Effort/finalized/seal writes; 3 checkpoint rows durable and unsealed; the vision parse ran (evidence) but wrote nothing');
    await snap(page, 'SS-R-02-nothing-written.png');
  } finally { srv.stop(); }
});

test('F10D-SS-A: one approved screenshot-closeout writes and seals everything — parsed effort rides the one approval', async ({ page }) => {
  test.setTimeout(150000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await acceptPlan(page, [
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 2, target_rir: 3 },
      { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 115, target_reps: 6, target_sets: 1, target_rir: 2 }
    ]);
    await waitForCheckpoint(srv, 3);
    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 1);
    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 2);
    await uploadShot(page);

    const confirm = page.locator('.closeout-confirm');
    await expect(confirm).toContainText('Romanian Deadlift');
    await expect(confirm).toContainText('Overhead Press');
    const foot = await confirm.locator('.cc-foot').innerText();
    expect(foot).toMatch(/Approving writes 2 set row/);
    expect(foot).toMatch(/effort row/);
    expect(foot).toMatch(/3 plan-ledger row/);
    await snap(page, 'SS-A-01-confirmation-with-parsed-effort.png');

    const visible = await page.evaluate(() => window.getSessionLog().map(r => `${String(r.canonical || r.exercise).toLowerCase()}|${r.weight}|${r.reps}`));
    await page.locator('.review:not(.done) .rv-save').click();
    await expect(page.locator('.review.done')).toBeVisible({ timeout: 25000 });
    await snap(page, 'SS-A-02-saved-and-sealed.png');

    const st = await srv.state();
    const appended = rowsFor(st, 'Log_Cleaned');
    expect(appended).toHaveLength(2);
    expect(appended.map(r => `${String(r[3] || r[2]).toLowerCase()}|${r[7]}|${r[8]}`).sort()).toEqual(visible.sort());
    expect(appended.every(r => String(r[0]) === '2026-07-18')).toBe(true);   // the screenshot-resolved date stamps the rows
    const effort = rowsFor(st, 'Effort');
    expect(effort).toHaveLength(1);
    expect(String(effort[0][2])).toBe('00:48:22');   // the stubbed parse's metrics, route-normalized — what was previewed is what was written
    expect(String(effort[0][3])).toBe('389');
    expect(String(effort[0][4])).toBe('512');
    expect(String(effort[0][5])).toBe('131');
    expect(String(effort[0][6])).toBe('168');
    expect(String(effort[0][1])).toBe(String(appended[0][1]));   // Log and Effort share the session identity
    expect(finalizedEvents(st)).toHaveLength(1);
    const ids = sealedIds(st);
    expect(ids).toHaveLength(3);
    expect(ids.every(id => id && id === ids[0])).toBe(true);
    expect((st.vision_calls || []).length).toBeGreaterThanOrEqual(1);
    record('F10D-SS-A', `approved once: 2 Log rows (= visible actuals, screenshot-dated), the parsed effort row (48:22 · 389/512 · 131/168), 1 finalized event, 3 ledger rows sealed under ${ids[0]}`);
  } finally { srv.stop(); }
});

test('F10D-SS-RT: a seal outage on the screenshot closeout retries idempotently through the review card', async ({ page }) => {
  test.setTimeout(150000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await acceptPlan(page, [
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 1, target_rir: 3 }
    ]);
    await waitForCheckpoint(srv, 1);
    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 1);
    await uploadShot(page);

    await srv.armSealFailure();
    await page.locator('.review:not(.done) .rv-save').click();
    await expect.poll(() => page.evaluate(() => {
      const b = document.getElementById('approve-btn');
      return b ? b.textContent : '';
    }), { timeout: 25000 }).toBe('Retry ledger seal');
    const midState = await srv.state();
    expect(rowsFor(midState, 'Log_Cleaned')).toHaveLength(1);
    expect(rowsFor(midState, 'Effort')).toHaveLength(1);
    expect(sealedIds(midState)[0]).toBe('');
    await snap(page, 'SS-RT-01-honest-partial.png');

    const retrySave = page.locator('.review:not(.done) .rv-save');
    await expect(retrySave).toBeEnabled({ timeout: 15000 });
    await retrySave.click();
    await expect(page.locator('.review.done')).toBeVisible({ timeout: 25000 });

    const st = await srv.state();
    expect(rowsFor(st, 'Log_Cleaned')).toHaveLength(1);
    expect(rowsFor(st, 'Effort')).toHaveLength(1);     // the screenshot effort row did NOT duplicate on retry
    expect(finalizedEvents(st)).toHaveLength(1);
    const ids = sealedIds(st);
    expect(ids[0]).not.toBe('');
    record('F10D-SS-RT', `screenshot closeout healed idempotently: still 1 Log row + 1 Effort row + 1 finalized event; sealed under ${ids[0]}`);
    await snap(page, 'SS-RT-02-sealed-after-retry.png');
  } finally { srv.stop(); }
});
