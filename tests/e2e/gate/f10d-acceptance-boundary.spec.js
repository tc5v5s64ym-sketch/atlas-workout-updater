'use strict';
/*
 * F10D acceptance boundary (owner canary finding, 2026-07-18) — a DISPLAYED
 * recommendation is never treated as an active, ledgered plan without acceptance.
 * After the composer-chat simplification the boundary keeps that DATA guarantee
 * but drops its UI card: logging from an unaccepted plan surface now SILENTLY
 * accepts the plan (the same acceptDisplayedPlan/atlasAcceptPlan path) — minting
 * identity + the Session_Plans acceptance + the Session_Plan_Sets checkpoint —
 * then the held set continues into the logger. Freeform logging never gates;
 * reload-restored accepted plans never re-accept; the set lands INSIDE the ledger,
 * never silently outside it (the canary's exact shape).
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

// =================================================================================
test('AB-1: a set from an unaccepted displayed plan SILENTLY auto-accepts (exactly one plan version) and the held set resumes — no card', async ({ page }) => {
  test.setTimeout(150000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await say(page, 'What should I do today?');
    await expect(page.locator('#thread-messages .chat-bubble-atlas').first()).toContainText("Today's read", { timeout: 30000 });
    // Nothing is accepted yet — the recommendation is merely displayed.
    let st = await srv.state();
    expect(acceptedEvents(st)).toHaveLength(0);
    expect(st.plan_set_rows).toHaveLength(0);
    record('AB-1', 'recommendation displayed in-thread; NOT yet accepted');

    // Logging a set from the displayed plan auto-accepts it behind the scenes —
    // no blocking "Start this plan" card ever renders.
    await say(page, 'Overhead Press 110 x 7 @2');
    await expect(page.locator('.acceptance-required')).toHaveCount(0);

    // Acceptance captured through the ONE existing boundary, exactly one version…
    await expect.poll(async () => acceptedEvents(await srv.state()).length, { timeout: 20000 }).toBeGreaterThan(0);
    st = await srv.state();
    const accepted = acceptedEvents(st);
    const versions = [...new Set(accepted.map(r => String(r[SP_PLAN_VERSION_IDX])))];
    expect(versions).toHaveLength(1);
    // …and the Session_Plan_Sets checkpoint landed at acceptance (sandbox flag on),
    // all rows on the same single plan version, no duplicates.
    await expect.poll(async () => (await srv.state()).plan_set_rows.length, { timeout: 20000 }).toBeGreaterThan(0);
    st = await srv.state();
    const ledgerVersions = [...new Set(st.plan_set_rows.map(r => String(r[LEDGER_PLAN_VERSION_IDX])))];
    expect(ledgerVersions).toEqual(['1']);
    const ledgerKeys = st.plan_set_rows.map(r => String(r[0]));
    expect(new Set(ledgerKeys).size).toBe(ledgerKeys.length);   // no duplicate checkpoint rows

    // The held set continued into the logger against the now-accepted plan: it
    // landed INSIDE the ledger (accepted flag true), never silently outside it.
    await expect.poll(() => loggedCount(page), { timeout: 20000 }).toBe(1);
    const acceptedFlag = await page.evaluate(() => { const s = window.getActivePlannedSession(); return Boolean(s && s.accepted === true); });
    expect(acceptedFlag).toBe(true);
    // No re-acceptance on a following set — the accepted session passes the gate.
    await say(page, 'Overhead Press 110 x 7 @2');
    await expect.poll(() => loggedCount(page), { timeout: 20000 }).toBe(2);
    await expect(page.locator('.acceptance-required')).toHaveCount(0);
    st = await srv.state();
    expect([...new Set(acceptedEvents(st).map(r => String(r[SP_PLAN_VERSION_IDX])))]).toHaveLength(1);
    record('AB-1', `silent auto-accept: 1 accepted plan version (${versions[0].slice(0, 12)}…), ${st.plan_set_rows.length} v1 ledger rows, held set committed into the accepted plan, no card`);
    await snap(page, 'AB-1-01-auto-accepted-and-resumed.png');
  } finally { srv.stop(); }
});

// =================================================================================
test('AB-2: auto-accept → log → closeout: Log, Effort, Session_Plans, and Session_Plan_Sets share one session identity and one seal', async ({ page }) => {
  test.setTimeout(180000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await say(page, 'What should I do today?');
    await expect(page.locator('#thread-messages .chat-bubble-atlas').first()).toContainText("Today's read", { timeout: 30000 });
    await say(page, 'Overhead Press 110 x 7 @2');
    // Silent auto-accept: the set lands with no card, on the now-accepted plan.
    await expect(page.locator('.acceptance-required')).toHaveCount(0);
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
    // Silent auto-accept commits the first set against the freshly-accepted plan.
    await expect(page.locator('.acceptance-required')).toHaveCount(0);
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
    await expect(page.locator('.acceptance-required')).toHaveCount(0);   // no re-acceptance card, ever
    const after = await srv.state();
    expect(acceptedEvents(after).length).toBe(acceptedBefore);   // no duplicate acceptance
    expect(after.plan_set_rows.length).toBe(ledgerBefore);       // no duplicate ledger rows
    record('AB-4', `reload restored the accepted plan (accepted=true); the next set committed with NO re-ask; acceptance rows ${acceptedBefore} and ledger rows ${ledgerBefore} unchanged`);
    await snap(page, 'AB-4-01-reload-no-reacceptance.png');
  } finally { srv.stop(); }
});
