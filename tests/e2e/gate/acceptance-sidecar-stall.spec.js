'use strict';
/*
 * #1165 acceptance-boundary regression — the held set must survive ANY outcome of the
 * /api/session-plans/accept sidecar.
 *
 * The failure this pins (reproduced from the 2026-07-28 production capture): a set logged
 * from an unaccepted displayed plan is HELD in `blockedLogText` while app.js auto-accepts
 * the plan, and the ONLY thing that releases it is the `.then` on `acceptDisplayedPlan`.
 * runAcceptance awaits the /accept POST, and api() sets no timeout — so a sidecar that
 * never settled stranded the athlete's set forever: no /api/log-workout, nothing in the
 * session buffer, and a blank status line. The capture ended at the two accept POSTs.
 *
 * The fix bounds THAT ONE call (ACCEPT_SIDECAR_TIMEOUT_MS in app.js). These tests drive
 * the real client against the real routes and vary only the sidecar's behaviour: fast
 * success, hard failure, slow-but-within-bound, and never-settles. In every case the held
 * set must reach /api/log-workout exactly once, and a stall must degrade honestly — never
 * a persistence claim, never a workout write.
 *
 * Runs in the LEDGER SANDBOX posture (in-memory tabs) so nothing real is reachable.
 */

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { sessionPlansColumns } = require('../../../config/columns');

const GATE_KEY = 'playwright-gate-key';
const EVENT_TYPE_IDX = sessionPlansColumns.indexOf('event_type');

// The app's bound (app.js ACCEPT_SIDECAR_TIMEOUT_MS). SS-3 must resolve well inside it;
// SS-4 must cross it.
const APP_BOUND_MS = 10000;

// The athlete's held set — deliberately NOT what startLift pre-fills the composer with, so
// a resume that replayed the plan prefill instead of the stash would fail visibly.
const HELD_SET = 'Overhead Press 110 x 7 @2';

test.describe.configure({ mode: 'serial' });

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
    base: `http://127.0.0.1:${ports.app}`,
    stop: () => child.kill('SIGTERM'),
    state: async () => (await fetch(`http://127.0.0.1:${ports.state}/state`)).json(),
  };
}

// Drives the real gate: render a pick, arm the sidecar handler, then log a set FROM that
// displayed (still unaccepted) plan. Returns the observed traffic from the set onward.
async function logHeldSetWithSidecar(page, srv, acceptHandler) {
  const calls = [];
  const logWorkoutBodies = [];
  page.on('request', r => {
    if (!r.url().includes('/api/')) return;
    const route = new URL(r.url()).pathname;
    calls.push(`${r.method()} ${route}`);
    if (route === '/api/log-workout') logWorkoutBodies.push(r.postData() || '');
  });
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, GATE_KEY);
  await page.goto(`${srv.base}/app/`);
  await page.waitForLoadState('networkidle');

  await page.locator('#workout-text').fill('What should I do today?');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#thread-messages .chat-bubble-atlas').first())
    .toContainText("Today's read", { timeout: 30000 });

  await page.route('**/api/session-plans/accept', acceptHandler);
  calls.length = 0;                                   // measure from the held set onward
  logWorkoutBodies.length = 0;
  await page.locator('#workout-text').fill(HELD_SET);
  await page.locator('#preview-btn').click();
  return { calls, logWorkoutBodies };
}

const countOf = (calls, call) => calls.filter(c => c === call).length;
const acceptedEvents = state => state.appends
  .filter(a => a.tabName === 'Session_Plans')
  .flatMap(a => a.rows)
  .filter(r => String(r[EVENT_TYPE_IDX]) === 'plan_accepted');

// The held set is released by exactly one resume, which re-enters the ONE submit path.
// That second pass is observable as a second parse plus the mid-session /api/log-workout.
async function expectResumedExactlyOnce(page, calls) {
  await expect.poll(() => countOf(calls, 'POST /api/log-workout'), { timeout: 30000 }).toBe(1);
  await expect.poll(() => page.evaluate(() => window.getSessionLog().length), { timeout: 30000 }).toBe(1);
  // Exactly once: a duplicated release would re-parse and re-log the same set.
  expect(countOf(calls, 'POST /api/parse-workout-text')).toBe(2);   // held parse + resumed parse
  expect(countOf(calls, 'POST /api/log-workout')).toBe(1);
  // The ATHLETE'S set is what got logged — not the composer prefill startLift wrote.
  const logged = await page.evaluate(() => window.getSessionLog().map(e => String(e.exercise || '')));
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatch(/overhead press/i);
}

// =================================================================================
test('SS-1: the sidecar succeeds quickly — the held set resumes once and reaches /api/log-workout', async ({ page }) => {
  test.setTimeout(150000);
  const srv = await bootSandbox();
  try {
    const { calls } = await logHeldSetWithSidecar(page, srv, route => route.continue());
    await expectResumedExactlyOnce(page, calls);
    // The real acceptance landed, so the ledger has it and no degrade is claimed.
    await expect.poll(async () => acceptedEvents(await srv.state()).length, { timeout: 20000 }).toBeGreaterThan(0);
    await expect(page.locator('#logger-status')).not.toContainText("couldn't confirm the plan record");
  } finally { srv.stop(); }
});

// =================================================================================
test('SS-2: the sidecar returns 500 — acceptance degrades, the held set still resumes once', async ({ page }) => {
  test.setTimeout(150000);
  const srv = await bootSandbox();
  try {
    const { calls } = await logHeldSetWithSidecar(page, srv, route => route.fulfill({
      status: 500, contentType: 'application/json', body: '{"status":"error","message":"sidecar down"}',
    }));
    await expectResumedExactlyOnce(page, calls);
    // A failed sidecar never unwinds the accepted snapshot — the set lands inside a live
    // accepted session, exactly as on the happy path.
    const accepted = await page.evaluate(() => {
      const s = window.getActivePlannedSession();
      return Boolean(s && s.accepted === true);
    });
    expect(accepted).toBe(true);
  } finally { srv.stop(); }
});

// =================================================================================
test('SS-3: the sidecar resolves slowly but WITHIN the bound — the real response wins, one resume', async ({ page }) => {
  test.setTimeout(180000);
  const srv = await bootSandbox();
  try {
    const { calls } = await logHeldSetWithSidecar(page, srv, async route => {
      await new Promise(r => setTimeout(r, Math.round(APP_BOUND_MS * 0.4)));
      await route.continue();
    });
    await expectResumedExactlyOnce(page, calls);
    // Resolved inside the bound ⇒ the genuine acceptance was captured, not a timeout.
    await expect.poll(async () => acceptedEvents(await srv.state()).length, { timeout: 20000 }).toBeGreaterThan(0);
    await expect(page.locator('#logger-status')).not.toContainText("couldn't confirm the plan record");
  } finally { srv.stop(); }
});

// =================================================================================
test('SS-4: the sidecar NEVER settles — the bound fires, the held set is never stranded', async ({ page }) => {
  test.setTimeout(180000);
  const srv = await bootSandbox();
  try {
    // Swallow the request: never fulfil, never abort — the exact production shape.
    const { calls, logWorkoutBodies } = await logHeldSetWithSidecar(page, srv, () => {});
    await expectResumedExactlyOnce(page, calls);

    // The UI is not blank: a short, honest, NONFATAL degrade…
    await expect(page.locator('#logger-status')).toContainText("couldn't confirm the plan record", { timeout: 20000 });
    // …that never claims the plan was persisted.
    const status = await page.locator('#logger-status').innerText();
    expect(status).not.toMatch(/captured|saved|persisted|written/i);

    // No unauthorized write: the single /api/log-workout is the mid-session test_mode
    // classification dry-run, and no closeout/live-write route was touched.
    expect(countOf(calls, 'POST /api/complete-workout')).toBe(0);
    expect(logWorkoutBodies).toHaveLength(1);
    expect(logWorkoutBodies[0]).toContain('"test_mode":"true"');

    // The stalled sidecar wrote no acceptance row — the degrade is honest in the ledger too.
    expect(acceptedEvents(await srv.state())).toHaveLength(0);
  } finally { srv.stop(); }
});

// =================================================================================
// Advisory P1 (PR #1179): a newer submit during the sidecar wait advances
// previewRequestSeq, so atlasResumeBlockedLog DELIBERATELY drops the stale stash —
// the newest message wins and commits itself. The timeout line must not then vouch
// for the dropped set: an athlete who reads "your set is still being logged" would
// trust a set that was never logged and never retype it.
test('SS-5: a superseded stash is dropped — the timeout line never vouches for a set that was not resumed', async ({ page }) => {
  test.setTimeout(180000);
  const srv = await bootSandbox();
  try {
    const calls = [];
    page.on('request', r => {
      if (r.url().includes('/api/')) calls.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, GATE_KEY);
    await page.goto(`${srv.base}/app/`);
    await page.waitForLoadState('networkidle');

    await page.locator('#workout-text').fill('What should I do today?');
    await page.locator('#preview-btn').click();
    await expect(page.locator('#thread-messages .chat-bubble-atlas').first())
      .toContainText("Today's read", { timeout: 30000 });

    await page.route('**/api/session-plans/accept', () => {});   // never settles
    calls.length = 0;
    await page.locator('#workout-text').fill(HELD_SET);
    await page.locator('#preview-btn').click();

    // While the bound is still running, the athlete sends a SECOND set. It passes the
    // now-accepted gate and commits itself, advancing previewRequestSeq past the stash.
    await expect.poll(() => calls.filter(c => c === 'POST /api/session-plans/accept').length,
      { timeout: 20000 }).toBe(1);
    await page.locator('#workout-text').fill('Overhead Press 115 x 6 @2');
    await page.locator('#preview-btn').click();
    await expect.poll(() => page.evaluate(() => window.getSessionLog().length), { timeout: 30000 }).toBe(1);

    // Let the bound fire and settle.
    await page.waitForTimeout(APP_BOUND_MS + 5000);

    // The newer set committed; the superseded stash was dropped by design (never a
    // duplicate) — and exactly one set is in the buffer, not two.
    expect(await page.evaluate(() => window.getSessionLog().length)).toBe(1);
    // The critical assertion: no line claims the dropped set is still being logged.
    const status = await page.locator('#logger-status').innerText().catch(() => '');
    expect(status).not.toMatch(/still being logged/i);
  } finally { srv.stop(); }
});
