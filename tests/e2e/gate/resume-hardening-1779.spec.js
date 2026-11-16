'use strict';
/*
 * #1779 — resume-hardening proving pack, run end-to-end against the REAL app
 * in the gate harness's LEDGER SANDBOX posture: real built client, real server
 * (index.js), stubbed in-memory workbook (Session_Plans present with contract
 * headers, so the finality check can answer not-finalized).
 *
 * Proves the acceptance probes that need the live UI path:
 *   P1 — log 3 sets, kill + restart the server, reopen into a cold-start
 *        finality outage (the first finality read fails, retries exhaust, the
 *        resume is refused) → the athlete is told to retry instead of shown
 *        an empty app; a fresh load after the outage recovers the session
 *        (the reload's beforeunload persist must NOT delete the snapshot),
 *        the session continues and saves; the saved record matches what was
 *        logged.
 *   P1-retry — the same refused resume, recovered by TAPPING the retry
 *        notice instead of reloading.
 *   P2 — the same flow with the client closed/reopened and the tab discarded
 *        in between (page.close + fresh page in the same context).
 *   P3 — the owner's burst flow: open the cold app after a spin-down, enter an
 *        entire finished workout in one burst, save → the record is correct
 *        and complete.
 *   P5 — no phantom resume: a finished (saved) session does not resurrect
 *        after a restart.
 * P4 (a restart mid-save) is not a UI flow: the save-authority invariants are
 * proven by the idempotency / read-back suites, and this PR changes no write
 * path — the post-restart save in P1 proves the record is written exactly
 * once after a restart.
 *
 * The rebooted server comes back on the SAME port (ATLAS_GATE_PORT): the
 * client snapshot lives in localStorage, which is origin-scoped (port
 * included). Each Playwright project gets its own fixed port so the two
 * project workers never collide.
 */

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const GATE_KEY = 'playwright-gate-key';

let artDir = null;
const transcript = [];

function record(step, note) {
  transcript.push({ at: new Date().toISOString(), step, note });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, testInfo) => {
  artDir = process.env.ATLAS_GATE_ARTIFACT_DIR
    ? path.join(process.env.ATLAS_GATE_ARTIFACT_DIR, testInfo.project.name)
    : path.join(__dirname, '..', '..', '..', 'test-results', 'resume-1779', testInfo.project.name);
  fs.mkdirSync(artDir, { recursive: true });
});

test.afterAll(async () => {
  if (artDir) {
    fs.writeFileSync(path.join(artDir, 'transcript.json'), JSON.stringify(transcript, null, 2));
    const md = ['# #1779 resume-hardening proving-pack transcript', '', ...transcript.map(t => `- \`${t.at}\` **${t.step}** — ${t.note}`)];
    fs.writeFileSync(path.join(artDir, 'TRANSCRIPT.md'), md.join('\n'));
  }
});

// Fixed app port per project — the reboot must land on the same origin, or the
// reopened client cannot see the localStorage snapshot it restores from.
function fixedPort(projectName) {
  return projectName === 'mobile-chromium' ? 32180 : 32179;
}

// ---- Per-scenario sandbox server (fresh tabs, fresh sessions) ----
async function bootSandbox(port) {
  const child = spawn(process.execPath, [path.join(__dirname, 'gate-server.js')],
    { env: { ...process.env, ATLAS_GATE_KEY: GATE_KEY, ATLAS_GATE_LEDGER_SANDBOX: '1', ATLAS_GATE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    kill: () => new Promise(resolve => {
      child.once('exit', resolve);
      child.kill('SIGKILL');
      setTimeout(resolve, 5000);
    }),
    state: async () => (await fetch(`http://127.0.0.1:${ports.state}/state`)).json(),
    // #1779: fault the finality read on this server (cold-start outage).
    failFinality: async (on) => (await fetch(`http://127.0.0.1:${ports.state}/fail-finality?on=${on ? 1 : 0}`)).json(),
  };
}

// A killed listener frees its port at once, but retry the same fixed port a few
// times so a slow teardown never flakes the restart.
async function rebootSandbox(port, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await bootSandbox(port);
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastErr;
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

// Store-truth settle for a logging message (a parsed set commits live).
async function logSet(page, text) {
  const before = await page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : 0));
  await say(page, text);
  await expect
    .poll(() => page.evaluate(() => (window.getSessionLog ? window.getSessionLog().length : 0)), { timeout: 25000 })
    .toBeGreaterThan(before);
}

async function expectLoggedCount(page, n) {
  await expect.poll(() => page.evaluate(() => window.getSessionLog().length), { timeout: 15000 }).toBe(n);
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

async function saveSession(page) {
  await fillEffort(page);
  await compileCloseout(page);
  await page.locator('.review:not(.done) .rv-save').click();
  await expect(page.locator('.review.done')).toBeVisible({ timeout: 25000 });
}

function rowsFor(state, tab) {
  return state.appends.filter(a => a.tabName === tab).flatMap(a => a.rows);
}

function loggedKey(rows) {
  return rows.map(r => `${String(r[3] || r[2]).toLowerCase()}|${r[7]}|${r[8]}`).sort();
}

async function expectResumed(page, n) {
  // The restore banner replaces the "Restoring…" pending state once the
  // finality check answers; the session log is the store truth underneath it.
  await expect(page.locator('#session-resume-notice')).toContainText('Session restored', { timeout: 20000 });
  await expect(page.locator('#session-resume-notice')).toBeVisible();
  await expectLoggedCount(page, n);
}

async function snap(page, name) {
  await page.screenshot({ path: path.join(artDir, name), fullPage: true });
}

const THREE_SETS = [
  'Bench Press 225 x 5 @2',
  'Bench Press 215 x 6 @2',
  'Back Squat 315 x 3 @2',
];

async function logThreeSets(page) {
  for (const text of THREE_SETS) await logSet(page, text);
  await expectLoggedCount(page, 3);
  record('log', '3 sets logged (Bench 225x5, Bench 215x6, Squat 315x3)');
}

// =================================================================================
test('P1: log 3 sets, kill + restart the server, reopen into a finality outage → told to retry, then recovered', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  const port = fixedPort(testInfo.project.name);
  let srv = await bootSandbox(port);
  try {
    await openApp(page, srv.base);
    await logThreeSets(page);

    // The service spins down mid-workout (free plan). Kill it dead — no
    // graceful shutdown, no flush — then boot it again on the same port.
    await srv.kill();
    record('restart', 'server killed (SIGKILL, no flush) — the spin-down');
    srv = await rebootSandbox(port);
    record('restart', `server back on the same port (${port})`);

    // Arm the cold-start finality outage on the REBOOTED server, then reopen:
    // the first finality read fails, the retries exhaust, the resume is refused.
    await srv.failFinality(true);
    await page.reload();
    await page.waitForLoadState('networkidle');
    // The athlete is TOLD the server could not be reached — not shown an
    // empty app with no signal. (At head this banner does not exist: the
    // refusal was silent and the app looked empty — the owner report.)
    await expect(page.locator('#session-resume-notice')).toContainText('reach the server', { timeout: 20000 });
    await expect(page.locator('#session-resume-notice')).toContainText('tap to retry');
    await expect(page.locator('#session-resume-notice')).toBeVisible();
    await snap(page, 'P1-01-retry-banner-after-refused-resume.png');
    record('P1', 'reopened into the outage: retry banner shown, no silent empty app');

    // The server recovers; a fresh load retries the check. This reload's
    // beforeunload persists the (empty, refused) buffer — at head that
    // persist DELETED the snapshot; with the fix the snapshot survives and
    // the session restores.
    await srv.failFinality(false);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expectResumed(page, 3);
    const restored = await page.evaluate(() => window.getSessionLog().map(r => `${String(r.canonical || r.exercise).toLowerCase()}|${r.weight}|${r.reps}`));
    expect(restored.sort()).toEqual(['back squat|315|3', 'bench press|215|6', 'bench press|225|5']);
    await snap(page, 'P1-02-restored-after-outage.png');
    record('P1', 'fresh load after the outage: resume banner shown, all 3 sets intact');

    // The session continues and saves; the saved record matches what was logged.
    await logSet(page, 'Bench Press 205 x 8 @2');
    await expectLoggedCount(page, 4);
    const visible = await page.evaluate(() => window.getSessionLog().map(r => `${String(r.canonical || r.exercise).toLowerCase()}|${r.weight}|${r.reps}`));
    await saveSession(page);
    const st = await srv.state();
    const appended = rowsFor(st, 'Log_Cleaned');
    expect(appended).toHaveLength(4);
    expect(loggedKey(appended)).toEqual(visible.sort());
    record('P1', 'continued with a 4th set and saved: Log_Cleaned rows match the 4 logged sets exactly');
  } finally {
    srv.stop();
  }
});

test('P1-retry: tap-to-retry after a refused resume restores the session', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  const port = fixedPort(testInfo.project.name);
  let srv = await bootSandbox(port);
  try {
    await openApp(page, srv.base);
    await logThreeSets(page);

    await srv.kill();
    srv = await rebootSandbox(port);
    await srv.failFinality(true);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#session-resume-notice')).toContainText('tap to retry', { timeout: 20000 });

    // The server recovers; tapping the banner re-runs the restore against the
    // kept snapshot — no reload needed.
    await srv.failFinality(false);
    await page.locator('#session-resume-notice .resume-content').click();
    await expectResumed(page, 3);
    await snap(page, 'P1-retry-01-restored-by-tap.png');
    record('P1-retry', 'tapped the retry banner: session restored, all 3 sets intact');
  } finally {
    srv.stop();
  }
});

test('P2: same flow with the client closed and the tab discarded in between', async ({ page, context }, testInfo) => {
  test.setTimeout(180000);
  const port = fixedPort(testInfo.project.name);
  let srv = await bootSandbox(port);
  try {
    await openApp(page, srv.base);
    await logThreeSets(page);

    // Discard the tab, then spin the service down and back up.
    await page.close();
    record('discard', 'tab closed (discarded) with 3 sets logged');
    await srv.kill();
    srv = await rebootSandbox(port);
    record('restart', `server back on the same port (${port})`);

    // A fresh tab in the same browser context (same origin localStorage).
    const page2 = await context.newPage();
    await openApp(page2, srv.base);
    await expectResumed(page2, 3);
    await snap(page2, 'P2-01-restored-after-discard-and-restart.png');
    record('P2', 'fresh tab after discard + restart: resume banner shown, all 3 sets intact');

    await logSet(page2, 'Bench Press 205 x 8 @2');
    await expectLoggedCount(page2, 4);
    const visible = await page2.evaluate(() => window.getSessionLog().map(r => `${String(r.canonical || r.exercise).toLowerCase()}|${r.weight}|${r.reps}`));
    await saveSession(page2);
    const st = await srv.state();
    const appended = rowsFor(st, 'Log_Cleaned');
    expect(appended).toHaveLength(4);
    expect(loggedKey(appended)).toEqual(visible.sort());
    record('P2', 'continued with a 4th set and saved: Log_Cleaned rows match the 4 logged sets exactly');
    await page2.close();
  } finally {
    srv.stop();
  }
});

test('P3: the owner burst flow — cold app, entire finished workout in one burst, save', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  const port = fixedPort(testInfo.project.name);
  let srv = await bootSandbox(port);
  try {
    // Cold open after a spin-down: the server just booted for this test.
    await openApp(page, srv.base);
    await expect(page.locator('#session-resume-notice')).toBeHidden();
    // One pasted message carrying the entire finished workout — the owner's
    // burst is a single paste, not three racing submits (the turn authority
    // revokes an in-flight submit when the next one lands, so rapid-fire
    // messages drop sets; that is pre-existing turn behavior, not this
    // issue's defect). Multi-set pastes are one set per line.
    await say(page, 'Bench Press 225 x 5 @2\nBench Press 215 x 6 @2\nBack Squat 315 x 3 @2');
    await expectLoggedCount(page, 3);
    record('P3', 'entire finished workout entered in one burst on the cold app');
    const visible = await page.evaluate(() => window.getSessionLog().map(r => `${String(r.canonical || r.exercise).toLowerCase()}|${r.weight}|${r.reps}`));
    await saveSession(page);
    const st = await srv.state();
    const appended = rowsFor(st, 'Log_Cleaned');
    expect(appended).toHaveLength(3);
    expect(loggedKey(appended)).toEqual(visible.sort());
    record('P3', 'burst saved: Log_Cleaned rows match the 3 logged sets exactly');
  } finally {
    srv.stop();
  }
});

test('P5: no phantom resume — a finished session does not resurrect after a restart', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  const port = fixedPort(testInfo.project.name);
  let srv = await bootSandbox(port);
  try {
    await openApp(page, srv.base);
    await logThreeSets(page);
    await saveSession(page);
    await expectLoggedCount(page, 0);
    // The save landed in the (process-local) workbook BEFORE the restart —
    // the rebooted sandbox starts with a fresh in-memory workbook, so the
    // saved rows are asserted here, not after the reboot.
    expect(rowsFor(await srv.state(), 'Log_Cleaned')).toHaveLength(3);
    record('P5', 'session saved; buffer cleared, snapshot cleared, 3 rows in the workbook');

    await srv.kill();
    srv = await rebootSandbox(port);
    await page.reload();
    await page.waitForLoadState('networkidle');
    // No resume banner, no resurrected sets — the finished session stays finished.
    await expect(page.locator('#session-resume-notice')).toBeHidden({ timeout: 15000 });
    await expect.poll(() => page.evaluate(() => window.getSessionLog().length), { timeout: 15000 }).toBe(0);
    record('P5', 'reopened after restart: no resume banner, no sets resurrected');
  } finally {
    srv.stop();
  }
});
