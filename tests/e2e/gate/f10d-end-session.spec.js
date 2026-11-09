'use strict';
/*
 * #1689 — one timing rule for `finalized`: emit on approved save, nowhere else.
 *
 * The banner End-session button used to emit the `finalized` closeout the moment
 * it was clicked (before any save), while the Finish-session flow records it only
 * when the owner approves the save. One click could assert a completed workout
 * with zero Log rows — and that durable `finalized` then blocks undo-last.
 *
 * Proving pack (gate harness, real server + in-memory sheets):
 *   E0 — End session with nothing logged: NO finalized event, no review, and
 *        the session stays active ("No conversation yet" status, like Finish).
 *   E1 — End session, then walk away from the save: NO finalized event in
 *        Session_Plans, and undo-last is NOT finality-blocked.
 *   E2 — End session, then approve the save: EXACTLY ONE finalized event, and
 *        undo-last IS finality-blocked (the single-owner rule, other side).
 *
 * Failing-first: on the pre-fix code E0 fails (the click already emitted
 * finalized for zero Log rows), E1 fails (the click already emitted
 * finalized; the review never opens) and E2 fails (the review never opens, and
 * the click's finalized plus the approval's would double-record).
 */

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { sessionPlansColumns } = require('../../../config/columns');

const GATE_KEY = 'playwright-gate-key';
const EVENT_TYPE_IDX = sessionPlansColumns.indexOf('event_type');
const CLOSEOUT_STATUS_IDX = sessionPlansColumns.indexOf('closeout_status');
const SESSION_ID_IDX = 1; // session_id is column 1 in Session_Plan_Sets rows

let artDir = null;
const transcript = [];

function record(step, note) {
  transcript.push({ at: new Date().toISOString(), step, note });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, testInfo) => {
  artDir = process.env.ATLAS_GATE_ARTIFACT_DIR
    ? path.join(process.env.ATLAS_GATE_ARTIFACT_DIR, testInfo.project.name)
    : path.join(__dirname, '..', '..', '..', 'test-results', 'f10d-end-session', testInfo.project.name);
  fs.mkdirSync(artDir, { recursive: true });
});

test.afterAll(async () => {
  if (artDir) {
    fs.writeFileSync(path.join(artDir, 'transcript.json'), JSON.stringify(transcript, null, 2));
    const md = ['# #1689 End-session finalized-timing proving-pack transcript', '', ...transcript.map(t => `- \`${t.at}\` **${t.step}** — ${t.note}`)];
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
    stateBase: `http://127.0.0.1:${ports.state}`,
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

async function expectLoggedCount(page, n) {
  await expect.poll(() => page.evaluate(() => window.getSessionLog().length), { timeout: 15000 }).toBe(n);
}

async function acceptPlan(page, exercises) {
  const started = await page.evaluate(exs => window.atlasAcceptPlan({
    id: 'work_day', label: 'Work', why_today: '#1689 End-session proving pack.', exercises: exs
  }), exercises);
  expect(started && started.started).toBeTruthy();
}

async function waitForCheckpoint(srv, expectedRows) {
  await expect.poll(async () => (await srv.state()).plan_set_rows.length, { timeout: 15000 })
    .toBe(expectedRows);
}

// End session via the banner — the button under test. Expands the banner through
// the pin first (collapsed by default), then taps End session.
async function tapEndSession(page) {
  await page.locator('#session-pin').click();
  await expect(page.locator('#active-session-banner')).toBeVisible();
  await page.locator('#active-session-banner').getByText('End session', { exact: true }).click();
  record('end-session', 'banner End session tapped');
}

// The closeout review the End-session tap must now open (same as Finish).
async function expectCloseoutReview(page) {
  await expect(page.locator('.closeout-confirm')).toHaveCount(1, { timeout: 25000 });
  await expect(page.locator('.review:not(.done) .rv-save')).toBeVisible();
  record('review', 'closeout review rendered; Save NOT tapped');
}

function rowsFor(state, tab) {
  return state.appends.filter(a => a.tabName === tab).flatMap(a => a.rows);
}

function finalizedEvents(state) {
  return rowsFor(state, 'Session_Plans').filter(r =>
    String(r[EVENT_TYPE_IDX]) === 'session_closeout' && String(r[CLOSEOUT_STATUS_IDX]) === 'finalized');
}

// The server-allocated session identity, read off the accept checkpoint rows.
function sessionIdFromState(state) {
  const rows = rowsFor(state, 'Session_Plan_Sets');
  expect(rows.length).toBeGreaterThan(0);
  return String(rows[0][SESSION_ID_IDX]);
}

// Call undo-last directly. The range is well-formed but need not point at real
// rows: the finality check runs BEFORE the read-back, so the response proves
// exactly the finality verdict — 409/finalized_workout_undo_not_supported iff a
// durable finalized exists, anything else iff it does not.
async function callUndoLast(page, base, sessionId) {
  return page.evaluate(async ({ base, sessionId }) => {
    const key = localStorage.getItem('atlas_api_key');
    const res = await fetch(`${base}/api/log-workout/undo-last`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-atlas-api-key': key || '',
        'x-atlas-request-origin': 'playwright',
      },
      body: JSON.stringify({
        log_appended_range: 'Log_Cleaned!A2:A2',
        session_id: sessionId,
        rows_to_delete: 1,
        confirm_delete: true,
        write_id: `test-undo-${Date.now()}`,
      }),
    });
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-JSON body */ }
    return { status: res.status, body };
  }, { base, sessionId });
}

async function snap(page, name) {
  await page.screenshot({ path: path.join(artDir, name), fullPage: true });
}

// =================================================================================
test('E0: End session with nothing logged — no finalized event, session stays active', async ({ page }) => {
  test.setTimeout(120000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await acceptPlan(page, [
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 1, target_rir: 3 }
    ]);
    await waitForCheckpoint(srv, 1);
    const sid = sessionIdFromState(await srv.state());

    // The purest form of the reported defect: on the pre-fix code this click
    // alone emitted `finalized` for a workout with zero Log rows. Now it must
    // open no review and emit nothing — the "No conversation yet" status,
    // session still active, exactly like Finish with nothing logged.
    await tapEndSession(page);
    // No chat turns exist at all, so the closeout's compile fallback reports
    // "No conversation yet" — no review opens, nothing is written.
    await expect(page.locator('#logger-status')).toContainText('No conversation yet', { timeout: 25000 });
    await expect(page.locator('.review:not(.done)')).toHaveCount(0);
    await expect(page.locator('#session-pin')).toBeVisible();
    await snap(page, 'E0-01-nothing-logged.png');

    const st = await srv.state();
    expect(rowsFor(st, 'Log_Cleaned')).toHaveLength(0);
    expect(finalizedEvents(st)).toHaveLength(0);
    record('E0', 'nothing logged: ZERO Log rows, ZERO finalized events, session still active');

    // No durable finalized exists, so undo-last reaches the read-back (same
    // proof as E1) instead of the finalized refusal.
    const undo = await callUndoLast(page, srv.base, sid);
    const undoText = JSON.stringify(undo.body || '');
    expect(undoText).not.toContain('finalized_workout_undo_not_supported');
    expect(undoText.includes('missing or empty') || undoText.includes('session_id mismatch')).toBe(true);
  } finally { srv.stop(); }
});

// =================================================================================
test('E1: End session, then walk away from the save — no finalized event, undo-last not finality-blocked', async ({ page }) => {
  test.setTimeout(120000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await acceptPlan(page, [
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 1, target_rir: 3 }
    ]);
    await waitForCheckpoint(srv, 1);
    const sid = sessionIdFromState(await srv.state());
    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 1);

    await tapEndSession(page);
    await expectCloseoutReview(page);
    await snap(page, 'E1-01-review-opened.png');

    // Dismiss by walking away (F10D-R pattern): reload with the confirmation pending.
    await page.reload();
    await page.waitForLoadState('networkidle');
    const st = await srv.state();
    expect(rowsFor(st, 'Log_Cleaned')).toHaveLength(0);
    expect(finalizedEvents(st)).toHaveLength(0);
    // The session itself survived the dismissal — nothing was lost client-side.
    await expect(page.locator('#session-pin')).toBeVisible({ timeout: 30000 });
    expect(await page.evaluate(() => window.getSessionLog().length)).toBe(1);
    await snap(page, 'E1-02-after-dismiss-nothing-written.png');

    // Undo-last must NOT be finality-blocked. The fabricated range points at a
    // row that was never written by this session, so the call reaches the
    // read-back stage and must fail THERE (missing/empty row, or a session_id
    // mismatch against the sandbox's seeded row) — the finality gate runs
    // BEFORE the read-back, so reaching the read-back proves the verdict was
    // not-final. The assertion is therefore on the error_code, not the status:
    // a durable finalized would 409 with finalized_workout_undo_not_supported
    // before any read-back happened.
    const undo = await callUndoLast(page, srv.base, sid);
    const undoText = JSON.stringify(undo.body || '');
    expect(undoText).not.toContain('finalized_workout_undo_not_supported');
    expect(undoText.includes('missing or empty') || undoText.includes('session_id mismatch')).toBe(true);
    record('E1', `dismissed: ZERO Log rows, ZERO finalized events; undo-last reached the read-back (not the finalized refusal)`);
  } finally { srv.stop(); }
});

// =================================================================================
test('E2: End session, then approve the save — exactly one finalized event, undo-last IS finality-blocked', async ({ page }) => {
  test.setTimeout(120000);
  const srv = await bootSandbox();
  try {
    await openApp(page, srv.base);
    await acceptPlan(page, [
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 1, target_rir: 3 }
    ]);
    await waitForCheckpoint(srv, 1);
    const sid = sessionIdFromState(await srv.state());
    await logSet(page, 'Romanian Deadlift 245 x 6 @3');
    await expectLoggedCount(page, 1);

    await tapEndSession(page);
    await expectCloseoutReview(page);
    await page.locator('.review:not(.done) .rv-save').click();
    await expect(page.locator('.review.done')).toBeVisible({ timeout: 25000 });
    await snap(page, 'E2-01-saved.png');

    const st = await srv.state();
    expect(rowsFor(st, 'Log_Cleaned')).toHaveLength(1);
    expect(finalizedEvents(st)).toHaveLength(1);
    record('E2', 'approved once: 1 Log row, exactly 1 finalized event');

    // The single approved finalized now blocks undo — the other side of the rule.
    const undo = await callUndoLast(page, srv.base, sid);
    expect(undo.status).toBe(409);
    expect(JSON.stringify(undo.body || '')).toContain('finalized_workout_undo_not_supported');
    record('E2', 'undo-last refused 409 finalized_workout_undo_not_supported, as the approved closeout requires');
  } finally { srv.stop(); }
});
