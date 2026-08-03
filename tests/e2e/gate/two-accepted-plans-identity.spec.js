'use strict';
/*
 * TWO ACCEPTED PLANS IN ONE PERIOD — current-state proof (owner instruction, 2026-08-03).
 *
 * PR #1245 gave session-ID allocation ONE authority: the server allocator, reading the
 * durable union (Effort ∪ Log_Cleaned). It left one mint unexamined — `acceptDisplayedPlan`
 * still derives an id for a plan accepted when no session identity exists yet. If that mint
 * hardcodes the first slot the way the client's old `generateSessionId` did, then a SECOND
 * plan accepted in the same AM/PM period re-uses the first plan's identity, and the merge
 * this campaign just closed reappears one layer up — in Session_Plans and Session_Plan_Sets
 * rather than in Log_Cleaned.
 *
 * This drives the REAL accepted-plan path end to end, twice, through the browser:
 * displayed recommendation → silent auto-accept by logging a set → effort → "done" →
 * approve → seal. No identity is injected: the spec only types into the composer, fills the
 * real effort fields, and clicks the real Save. `page.evaluate` is used ONLY to read state.
 *
 * The assertion is coherence, not merely distinctness: each accepted session must own its
 * own identity AND every tab that records it — Session_Plans, Session_Plan_Sets,
 * Log_Cleaned, Effort, the finalized closeout event and the seal — must agree on it.
 *
 * Runs in the LEDGER SANDBOX posture (in-memory tabs, no credentials), exactly as the
 * neighbouring F10D gate specs do. Nothing real is reachable.
 */

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { sessionPlansColumns, sessionPlanSetsColumns, logCleanedColumns, effortColumns } = require('../../../config/columns');

const GATE_KEY = 'playwright-gate-key';
const SP_SESSION_IDX = sessionPlansColumns.indexOf('session_id');
const SP_EVENT_IDX = sessionPlansColumns.indexOf('event_type');
const SP_CLOSEOUT_IDX = sessionPlansColumns.indexOf('closeout_status');
const SPS_SESSION_IDX = sessionPlanSetsColumns.indexOf('session_id');
const SPS_SEAL_IDX = sessionPlanSetsColumns.indexOf('closeout_write_id');
const LOG_SESSION_IDX = logCleanedColumns.indexOf('session_id');
const EFFORT_SESSION_IDX = effortColumns.indexOf('session_id');

let artDir = null;
const transcript = [];
function record(step, note) { transcript.push({ at: new Date().toISOString(), step, note }); }

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, testInfo) => {
  artDir = path.join(__dirname, '..', '..', '..', 'test-results', 'two-accepted-plans-identity', testInfo.project.name);
  fs.mkdirSync(artDir, { recursive: true });
});

test.afterAll(async () => {
  if (artDir) fs.writeFileSync(path.join(artDir, 'transcript.json'), JSON.stringify(transcript, null, 2));
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

const loggedCount = page => page.evaluate(() => window.getSessionLog().length);
const rowsFor = (state, tab) => state.appends.filter(a => a.tabName === tab).flatMap(a => a.rows);

// One complete owner session through the real path: displayed pick → a logged set (which
// silently auto-accepts the plan and mints its identity) → real effort fields → "done" →
// the real Save on the review card.
async function runOneAcceptedSession(page, srv, setText, effort, expectedLogRowsAfter, expectedDoneCards) {
  await say(page, 'What should I do today?');
  await expect(page.locator('#thread-messages .chat-bubble-atlas').last()).toContainText("Today's read", { timeout: 30000 });
  await say(page, setText);
  await expect(page.locator('.acceptance-required')).toHaveCount(0);
  await expect.poll(() => loggedCount(page), { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await srv.state()).plan_set_rows.length, { timeout: 20000 }).toBeGreaterThan(0);

  await page.evaluate(e => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('effort-duration', e.duration);
    set('effort-active-cal', e.active);
    set('effort-total-cal', e.total);
    set('effort-avg-hr', e.avg);
    set('effort-peak-hr', e.peak);
  }, effort);

  await say(page, 'done');
  // Session 2's card is a SECOND card in the same thread — session 1's saved card is still
  // sitting above it. Every assertion here has to be positional or count-based, or a stale
  // card satisfies it instantly and the run "passes" without the second save happening.
  await expect(page.locator('.closeout-confirm')).toHaveCount(expectedDoneCards, { timeout: 30000 });
  await page.locator('.review:not(.done) .rv-save').last().click();
  await expect(page.locator('.review.done')).toHaveCount(expectedDoneCards, { timeout: 30000 });
  await expect.poll(async () => rowsFor(await srv.state(), 'Log_Cleaned').length, { timeout: 25000 })
    .toBe(expectedLogRowsAfter);
}

// Every tab that records a session must name the SAME id. Returns the identity so the
// caller can compare the two sessions.
function coherentIdentityFor(state, logRowIndex) {
  const log = rowsFor(state, 'Log_Cleaned');
  const sid = String(log[logRowIndex][LOG_SESSION_IDX]);
  expect(sid, 'a written Log row must carry a session identity').not.toBe('');
  return sid;
}

test('two plans accepted in the same period receive distinct, internally coherent session identities', async ({ page }) => {
  test.setTimeout(300000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);

    // ---- Session 1 -------------------------------------------------------------
    await runOneAcceptedSession(page, srv, 'Overhead Press 110 x 7 @2',
      { duration: '41:05', active: '355', total: '470', avg: '124', peak: '158' }, 1, 1);
    const afterFirst = await srv.state();
    const sid1 = coherentIdentityFor(afterFirst, 0);
    record('session-1', `accepted and sealed under ${sid1}`);
    await page.screenshot({ path: path.join(artDir, '01-session-one-sealed.png'), fullPage: true });

    // ---- Session 2, SAME AM/PM period, same page, no reload --------------------
    // A concluded save resets session state and clears #log-session-id, so this is a
    // genuinely fresh session — exactly the owner's "trains twice in one afternoon".
    await runOneAcceptedSession(page, srv, 'Back Squat 225 x 5 @2',
      { duration: '38:20', active: '300', total: '415', avg: '119', peak: '151' }, 2, 2);
    const st = await srv.state();
    const sid2 = coherentIdentityFor(st, 1);
    record('session-2', `accepted and sealed under ${sid2}`);
    await page.screenshot({ path: path.join(artDir, '02-session-two-sealed.png'), fullPage: true });

    // ---- DISTINCT --------------------------------------------------------------
    expect(sid2, `both accepted plans landed on ONE identity (${sid1}) — the acceptDisplayedPlan `
      + 'mint re-used the first session, so Session_Plans and Session_Plan_Sets cannot tell the '
      + 'two workouts apart').not.toBe(sid1);

    // ---- COHERENT, per session -------------------------------------------------
    // Distinctness alone is not the property that matters: each identity must be the one
    // EVERY tab recorded for that session, or the workout is split rather than merged.
    for (const sid of [sid1, sid2]) {
      const log = rowsFor(st, 'Log_Cleaned').filter(r => String(r[LOG_SESSION_IDX]) === sid);
      const effort = rowsFor(st, 'Effort').filter(r => String(r[EFFORT_SESSION_IDX]) === sid);
      const plans = rowsFor(st, 'Session_Plans').filter(r => String(r[SP_SESSION_IDX]) === sid);
      const ledger = st.plan_set_rows.filter(r => String(r[SPS_SESSION_IDX]) === sid);

      expect(log.length, `${sid}: Log_Cleaned rows`).toBe(1);
      expect(effort.length, `${sid}: Effort row present and under this identity`).toBe(1);
      expect(ledger.length, `${sid}: Session_Plan_Sets checkpoint rows`).toBeGreaterThan(0);

      const accepted = plans.filter(r => String(r[SP_EVENT_IDX]) === 'plan_accepted');
      expect(accepted.length, `${sid}: exactly one acceptance recorded`).toBeGreaterThan(0);

      const finalized = plans.filter(r => String(r[SP_EVENT_IDX]) === 'session_closeout'
        && String(r[SP_CLOSEOUT_IDX]) === 'finalized');
      expect(finalized.length, `${sid}: exactly one finalized closeout`).toBe(1);

      const seals = [...new Set(ledger.map(r => String(r[SPS_SEAL_IDX])))];
      expect(seals.length, `${sid}: every ledger row sealed under ONE write id`).toBe(1);
      expect(seals[0], `${sid}: the seal is present, not blank`).not.toBe('');
    }

    // ---- NO CROSS-CONTAMINATION -------------------------------------------------
    // The two sessions must not share a seal: one seal spanning both would mean the
    // closeout of the second sealed the first one's rows too.
    const sealOf = sid => [...new Set(st.plan_set_rows
      .filter(r => String(r[SPS_SESSION_IDX]) === sid).map(r => String(r[SPS_SEAL_IDX])))][0];
    expect(sealOf(sid2), 'each session is sealed by its OWN closeout').not.toBe(sealOf(sid1));

    // And every ledger row belongs to one of the two — no orphan under a third identity.
    const ledgerIds = [...new Set(st.plan_set_rows.map(r => String(r[SPS_SESSION_IDX])))].sort();
    expect(ledgerIds).toEqual([sid1, sid2].sort());

    record('verdict', `DISTINCT and COHERENT: ${sid1} and ${sid2}; `
      + `${st.plan_set_rows.length} ledger rows partition cleanly, one seal each`);
    fs.writeFileSync(path.join(artDir, 'identities.json'), JSON.stringify({
      session_1: sid1, session_2: sid2, distinct: sid1 !== sid2,
      ledger_ids: ledgerIds, ledger_rows: st.plan_set_rows.length,
    }, null, 2));
  } finally { srv.stop(); }
});
