'use strict';
/*
 * F10D acceptance boundary (owner canary finding, 2026-07-18) — a DISPLAYED
 * recommendation is never an active plan. Logging from an unaccepted plan surface
 * blocks with ONE action ("Start this plan to track planned versus actual.") that
 * invokes the EXISTING acceptance workflow, then the held set continues into the
 * logger; freeform logging never gates; reload-restored accepted plans never
 * re-ask; repeated taps can never mint a second plan version.
 *
 * Runs in the LEDGER SANDBOX posture (both dry-run flags ON, in-memory tabs) so
 * acceptance capture AND the Session_Plan_Sets checkpoint are proven live-shaped
 * with nothing real reachable. The production flag stays OFF in production —
 * this file cannot touch anything outside the in-process stub.
 */

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { sessionPlansColumns, sessionPlanSetsColumns } = require('../../../config/columns');

const GATE_KEY = 'playwright-gate-key';
const EVENT_TYPE_IDX = sessionPlansColumns.indexOf('event_type');
const SP_PLAN_VERSION_IDX = sessionPlansColumns.indexOf('plan_version');
const LEDGER_PLAN_VERSION_IDX = sessionPlanSetsColumns.indexOf('plan_version');
const SEAL_IDX = sessionPlanSetsColumns.indexOf('closeout_write_id');

let artDir = null;
const transcript = [];
function record(step, note) { transcript.push({ at: new Date().toISOString(), step, note }); }

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, testInfo) => {
  artDir = process.env.ATLAS_GATE_ARTIFACT_DIR
    ? path.join(process.env.ATLAS_GATE_ARTIFACT_DIR, testInfo.project.name)
    : path.join(__dirname, '..', '..', '..', 'test-results', 'f10d-acceptance-boundary', testInfo.project.name);
  fs.mkdirSync(artDir, { recursive: true });
});

test.afterAll(async () => {
  if (artDir) {
    fs.writeFileSync(path.join(artDir, 'transcript.json'), JSON.stringify(transcript, null, 2));
    const md = ['# F10D acceptance-boundary transcript', '', ...transcript.map(t => `- \`${t.at}\` **${t.step}** — ${t.note}`)];
    fs.writeFileSync(path.join(artDir, 'TRANSCRIPT.md'), md.join('\n'));
  }
});

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
  record('say', text);
}

async function loggedCount(page) {
  return page.evaluate(() => window.getSessionLog().length);
}

function rowsFor(state, tab) {
  return state.appends.filter(a => a.tabName === tab).flatMap(a => a.rows);
}
function acceptedEvents(state) {
  return rowsFor(state, 'Session_Plans').filter(r => String(r[EVENT_TYPE_IDX]) === 'plan_accepted');
}

async function snap(page, name) {
  await page.screenshot({ path: path.join(artDir, name), fullPage: true });
}

const BLOCK_TEXT = 'Start this plan to track planned versus actual.';

// =================================================================================
test('AB-1: a set from an unaccepted displayed plan BLOCKS with the one Start action; repeated taps mint exactly one acceptance; the held set resumes', async ({ page }) => {
  test.setTimeout(150000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await say(page, 'What should I do today?');
    await expect(page.locator('#thread-messages .chat-bubble-atlas').first()).toContainText("Today's read", { timeout: 30000 });
    record('AB-1', 'recommendation displayed in-thread; NOT accepted (no Start pressed)');

    await say(page, 'Overhead Press 110 x 7 @2');
    const card = page.locator('.acceptance-required:not(.done)');
    await expect(card).toHaveCount(1, { timeout: 20000 });
    await expect(card).toContainText(BLOCK_TEXT);
    await expect(card.locator('.start-this-plan-btn')).toBeVisible();
    // Blocked means NOTHING moved: no committed set, no acceptance rows, no
    // ledger checkpoint — the displayed plan was never silently treated as active.
    expect(await loggedCount(page)).toBe(0);
    let st = await srv.state();
    expect(acceptedEvents(st)).toHaveLength(0);
    expect(st.plan_set_rows).toHaveLength(0);
    record('AB-1', 'set held at the boundary: zero committed sets, zero plan_accepted rows, zero ledger rows; the one Start action offered');
    await snap(page, 'AB-1-01-blocked-with-start-action.png');

    // A second blocked attempt re-uses the ONE live card (never stacks) and the
    // stash keeps the newest message.
    await say(page, 'Overhead Press 110 x 7 @2');
    await expect(page.locator('.acceptance-required')).toHaveCount(1);
    expect(await loggedCount(page)).toBe(0);

    // Repeated rapid taps: the DOM guard + _acceptInFlight + server idempotency
    // must yield exactly ONE accepted plan version. Fired as a synchronous DOM
    // double-click (a Playwright click would WAIT on the just-disabled button):
    // the first tap disables the button in its own handler; the second lands on
    // the disabled control and is swallowed — the guard under test.
    await page.evaluate(() => {
      const b = document.querySelector('.acceptance-required:not(.done) .start-this-plan-btn');
      b.click();
      b.click();
    });
    await expect(page.locator('.acceptance-required.done')).toHaveCount(1, { timeout: 25000 });

    // Acceptance captured through the EXISTING boundary…
    await expect.poll(async () => acceptedEvents(await srv.state()).length, { timeout: 20000 }).toBeGreaterThan(0);
    st = await srv.state();
    const accepted = acceptedEvents(st);
    const versions = [...new Set(accepted.map(r => String(r[SP_PLAN_VERSION_IDX])))];
    expect(versions).toHaveLength(1);
    // …and the Session_Plan_Sets checkpoint landed at acceptance (sandbox flag on),
    // exactly once, all rows on the same single plan version.
    await expect.poll(async () => (await srv.state()).plan_set_rows.length, { timeout: 20000 }).toBeGreaterThan(0);
    st = await srv.state();
    const ledgerVersions = [...new Set(st.plan_set_rows.map(r => String(r[LEDGER_PLAN_VERSION_IDX])))];
    expect(ledgerVersions).toEqual(['1']);
    const ledgerKeys = st.plan_set_rows.map(r => String(r[0]));
    expect(new Set(ledgerKeys).size).toBe(ledgerKeys.length);   // no duplicate checkpoint rows

    // The held set continued into the logger against the now-accepted plan.
    await expect.poll(() => loggedCount(page), { timeout: 20000 }).toBe(1);
    const acceptedFlag = await page.evaluate(() => { const s = window.getActivePlannedSession(); return Boolean(s && s.accepted === true); });
    expect(acceptedFlag).toBe(true);
    record('AB-1', `one Start (with a rapid second tap absorbed): 1 accepted plan version (${versions[0].slice(0, 12)}…), ${st.plan_set_rows.length} v1 ledger rows exactly once, held set committed into the accepted plan`);
    await snap(page, 'AB-1-02-accepted-and-resumed.png');
  } finally { srv.stop(); }
});

// =================================================================================
test('AB-2: gate → Start → log → closeout: Log, Effort, Session_Plans, and Session_Plan_Sets share one session identity and one seal', async ({ page }) => {
  test.setTimeout(180000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await say(page, 'What should I do today?');
    await expect(page.locator('#thread-messages .chat-bubble-atlas').first()).toContainText("Today's read", { timeout: 30000 });
    await say(page, 'Overhead Press 110 x 7 @2');
    await expect(page.locator('.acceptance-required:not(.done)')).toHaveCount(1, { timeout: 20000 });
    await page.locator('.acceptance-required:not(.done) .start-this-plan-btn').click();
    await expect(page.locator('.acceptance-required.done')).toHaveCount(1, { timeout: 25000 });
    await expect.poll(() => loggedCount(page), { timeout: 20000 }).toBe(1);
    await expect.poll(async () => (await srv.state()).plan_set_rows.length, { timeout: 20000 }).toBeGreaterThan(0);

    await page.evaluate(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('effort-duration', '41:05');
      set('effort-active-cal', '355');
      set('effort-total-cal', '470');
      set('effort-avg-hr', '124');
      set('effort-peak-hr', '158');
    });
    await say(page, 'done');
    await expect(page.locator('.closeout-confirm')).toHaveCount(1, { timeout: 25000 });
    await snap(page, 'AB-2-01-closeout-confirmation.png');
    await page.locator('.review:not(.done) .rv-save').click();
    await expect(page.locator('.review.done')).toBeVisible({ timeout: 25000 });

    const st = await srv.state();
    const log = rowsFor(st, 'Log_Cleaned');
    const effort = rowsFor(st, 'Effort');
    expect(log).toHaveLength(1);
    expect(effort).toHaveLength(1);
    const sid = String(log[0][1]);
    expect(String(effort[0][1])).toBe(sid);
    expect(st.plan_set_rows.length).toBeGreaterThan(0);
    expect(st.plan_set_rows.every(r => String(r[1]) === sid)).toBe(true);   // ledger shares the session identity
    const sealIds = [...new Set(st.plan_set_rows.map(r => String(r[SEAL_IDX])))];
    expect(sealIds).toHaveLength(1);
    expect(sealIds[0]).not.toBe('');                                        // every row sealed under the ONE write id
    const finalized = rowsFor(st, 'Session_Plans').filter(r =>
      String(r[EVENT_TYPE_IDX]) === 'session_closeout' && String(r[sessionPlansColumns.indexOf('closeout_status')]) === 'finalized');
    expect(finalized).toHaveLength(1);
    expect(String(finalized[0][1])).toBe(sid);
    record('AB-2', `closeout after the gated acceptance: Log(1) + Effort(1) + ${st.plan_set_rows.length} ledger rows + finalized event all under session ${sid}; one seal id ${sealIds[0].slice(0, 12)}…`);
    await snap(page, 'AB-2-02-sealed-with-shared-identity.png');
  } finally { srv.stop(); }
});

// =================================================================================
test('AB-3: freeform logging unrelated to the displayed recommendation never gates', async ({ page }) => {
  // The home dashboard always displays the engine's pick, so "completely
  // unplanned" means sets the displayed plan does not contain: the boundary keys
  // on the plan's OWN exercises and leaves everything else alone. (A set that IS
  // in the displayed pick gates — that is AB-1's proof, the canary's exact
  // shape.) The harness pick happens to span the entire five-lift seed catalog,
  // so the genuinely-unrelated lift here is a non-catalog one — in production
  // the catalog dwarfs any single day's pick.
  test.setTimeout(90000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await say(page, 'Barbell Curl 65 x 10 @2');
    await expect.poll(() => loggedCount(page), { timeout: 20000 }).toBe(1);
    await say(page, 'Barbell Curl 65 x 10 @2');
    await expect.poll(() => loggedCount(page), { timeout: 20000 }).toBe(2);
    await expect(page.locator('.acceptance-required')).toHaveCount(0);
    const st = await srv.state();
    expect(acceptedEvents(st)).toHaveLength(0);
    expect(st.plan_set_rows).toHaveLength(0);
    record('AB-3', 'freeform (sets not in the displayed pick): two sets committed immediately, no gate card, no acceptance rows, no ledger rows');
    await snap(page, 'AB-3-01-freeform-untouched.png');
  } finally { srv.stop(); }
});

// =================================================================================
test('AB-4: a reload-restored ACCEPTED plan never re-asks; no duplicate acceptance on the next set', async ({ page }) => {
  test.setTimeout(150000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await say(page, 'What should I do today?');
    await expect(page.locator('#thread-messages .chat-bubble-atlas').first()).toContainText("Today's read", { timeout: 30000 });
    await say(page, 'Overhead Press 110 x 7 @2');
    await expect(page.locator('.acceptance-required:not(.done)')).toHaveCount(1, { timeout: 20000 });
    await page.locator('.acceptance-required:not(.done) .start-this-plan-btn').click();
    await expect(page.locator('.acceptance-required.done')).toHaveCount(1, { timeout: 25000 });
    await expect.poll(() => loggedCount(page), { timeout: 20000 }).toBe(1);
    const before = await srv.state();
    const acceptedBefore = acceptedEvents(before).length;
    const ledgerBefore = before.plan_set_rows.length;
    expect(acceptedBefore).toBeGreaterThan(0);

    await page.reload();
    await page.waitForLoadState('networkidle');
    const restored = await page.evaluate(() => { const s = window.getActivePlannedSession(); return Boolean(s && s.accepted === true); });
    expect(restored).toBe(true);

    await say(page, 'Overhead Press 110 x 7 @2');
    await expect.poll(() => loggedCount(page), { timeout: 20000 }).toBe(2);
    await expect(page.locator('.acceptance-required:not(.done)')).toHaveCount(0);   // no re-acceptance ask
    const after = await srv.state();
    expect(acceptedEvents(after).length).toBe(acceptedBefore);   // no duplicate acceptance
    expect(after.plan_set_rows.length).toBe(ledgerBefore);       // no duplicate ledger rows
    record('AB-4', `reload restored the accepted plan (accepted=true); the next set committed with NO re-ask; acceptance rows ${acceptedBefore} and ledger rows ${ledgerBefore} unchanged`);
    await snap(page, 'AB-4-01-reload-no-reacceptance.png');
  } finally { srv.stop(); }
});
