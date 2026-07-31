'use strict';
/*
 * S12-GROUNDING — the real-browser regression for the Soul Corpus V2 Session 12
 * fabricated-completion defect, on the ACTUAL response path.
 *
 * Conducting the corpus through the real client produced, after the athlete's goodbye:
 *   "Overhead Press: 0 x 8 @ RIR 2, 0 x 8 @ RIR 2, 0 x 8 @ RIR 2. Romanian Deadlift:
 *    0 x 10 @ RIR 2 … Plank: 0 x 30 @ RIR 0 … You have completed the workout."
 * Three prescribed-but-unperformed slots rendered as actual zero-load sets, and a
 * completion declared while the deterministic plan state said otherwise.
 *
 * The deterministic integration proof lives in test/coachCompletionGrounding.test.js.
 * THIS spec proves the guard is wired into the path the athlete actually uses: real
 * built client → real server (index.js via gate-server.js) → real route → real
 * grounding → rendered thread. The model is a SCRIPTED adversary
 * (ATLAS_GATE_COACH_SCRIPT=1) returning the verbatim fabrication; nothing outbound is
 * called and no provider key exists, so this is not a model-up run.
 *
 * Write safety: sheets are the in-memory stub, #approve-btn is never clicked, and the
 * harness's own write evidence (GET /__gate/state) is asserted empty.
 */

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');

const GATE_KEY = 'playwright-gate-key';

// The exact prose the corpus run produced.
const FABRICATION = 'Overhead Press: 0 x 8 @ RIR 2, 0 x 8 @ RIR 2, 0 x 8 @ RIR 2. Romanian Deadlift: 0 x 10 @ RIR 2, 0 x 10 @ RIR 2, 0 x 10 @ RIR 2. Plank: 0 x 30 @ RIR 0, 0 x 30 @ RIR 0, 0 x 30 @ RIR 0. You have completed the workout.';
const GOODBYE = "Ok. That's... actually the first workout plan that doesn't stress me out. Later.";

let child = null;
let base = null;
let stateBase = null;

test.beforeAll(async () => {
  child = spawn(process.execPath, [path.join(__dirname, 'gate-server.js')], {
    env: { ...process.env, ATLAS_GATE_KEY: GATE_KEY, ATLAS_GATE_COACH_SCRIPT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gate-server did not report its ports within 30s')), 30000);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += String(d);
      const app = buf.match(/GATE_PORT=(\d+)/);
      const state = buf.match(/GATE_STATE_PORT=(\d+)/);
      if (app && state) { clearTimeout(timer); resolve({ app: app[1], state: state[1] }); }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[gate-server] ${d}`));
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`gate-server exited early (${code})`)); });
  });
  base = `http://127.0.0.1:${ports.app}`;
  stateBase = `http://127.0.0.1:${ports.state}`;
});

test.afterAll(async () => { if (child) child.kill('SIGTERM'); });

async function openApp(page) {
  await page.addInitScript((key) => { localStorage.setItem('atlas_api_key', key); }, GATE_KEY);
  await page.goto(`${base}/app/`);
  await page.waitForLoadState('networkidle');
}

async function say(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
}

test('S12: a fabricated completion never reaches the rendered thread', async ({ page }) => {
  test.setTimeout(180000);
  await openApp(page);

  // A six-slot plan, three logged and three still outstanding — the exact S12 shape.
  await page.evaluate(() => window.startPlannedSession({
    label: 'Full Body', id: 's12',
    exercises: [
      { name: 'Back Squat', liftCode: 'SQ01', weight: 45, reps: 8, sets: 3, rir: 2 },
      { name: 'Bench Press', liftCode: 'BEN01', weight: 45, reps: 8, sets: 3, rir: 2 },
      { name: 'Overhead Press', liftCode: 'OHP01', weight: 45, reps: 8, sets: 3, rir: 2 },
    ],
  }));
  // Log the first slot for real, through the real emitter, so completed work exists.
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate(() => window.emitSetLogged(
      [{ exercise: 'Back Squat', weight: 45, reps: 8, rir: 2, notes: '' }], 'Back Squat 45 8/2'));
  }

  // Arm the scripted model with the verbatim fabrication, then send the goodbye turn.
  const armed = await page.request.get(`${stateBase}/arm-coach-reply?reply=${encodeURIComponent(FABRICATION)}`);
  expect(armed.ok()).toBeTruthy();

  const before = await page.locator('#thread-messages').innerText().catch(() => '');
  await say(page, GOODBYE);
  await expect
    .poll(() => page.locator('#thread-messages').innerText().catch(() => ''), { timeout: 60000 })
    .not.toBe(before);
  // Let any late reaction land, then read the whole rendered conversation.
  await page.waitForTimeout(2000);
  const thread = await page.locator('#thread-messages').innerText();

  // PROOF 3 — no fabricated zero-load actual set is visible.
  expect(thread).not.toMatch(/\b0\s*(?:x|×)\s*\d+/);
  // PROOF 1/5/7 — no completion is declared while slots remain.
  expect(thread).not.toMatch(/completed the workout/i);
  expect(thread).not.toMatch(/workout (?:is )?complete/i);
  // PROOF 2 — the remaining slots are still remaining, and the athlete is told so.
  expect(thread).toMatch(/Still remaining/i);
  expect(thread).toMatch(/Overhead Press/);
  // PROOF 4 — genuinely completed work survives the replacement.
  expect(thread).toMatch(/Back Squat/);

  // PROOF 9 — no approve action occurred; the write gate was never armed by this turn.
  const approveEnabled = await page.evaluate(() => {
    const b = document.querySelector('#approve-btn');
    return Boolean(b && !b.disabled);
  });
  expect(approveEnabled).toBe(false);

  // PROOF 10 — the app attempted no Sheet write anywhere in this run.
  const stateRes = await page.request.get(`${stateBase}/`);
  const gate = await stateRes.json();
  expect(gate.appends).toEqual([]);
  expect(gate.deletes).toEqual([]);
  expect(gate.google_client_initialized).toBe(false);
});

test('S12: an honest reply on the same path is rendered unchanged', async ({ page }) => {
  test.setTimeout(180000);
  await openApp(page);
  await page.evaluate(() => window.startPlannedSession({
    label: 'Full Body', id: 's12b',
    exercises: [
      { name: 'Back Squat', liftCode: 'SQ01', weight: 45, reps: 8, sets: 3, rir: 2 },
      { name: 'Overhead Press', liftCode: 'OHP01', weight: 45, reps: 8, sets: 3, rir: 2 },
    ],
  }));
  // Log Back Squat for real — the reply below is only honest because this happened.
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate(() => window.emitSetLogged(
      [{ exercise: 'Back Squat', weight: 45, reps: 8, rir: 2, notes: '' }], 'Back Squat 45 8/2'));
  }

  const honest = 'Back Squat is logged. Overhead Press is still remaining.';
  const armed = await page.request.get(`${stateBase}/arm-coach-reply?reply=${encodeURIComponent(honest)}`);
  expect(armed.ok()).toBeTruthy();

  const before = await page.locator('#thread-messages').innerText().catch(() => '');
  await say(page, 'Where am I at?');
  await expect
    .poll(() => page.locator('#thread-messages').innerText().catch(() => ''), { timeout: 60000 })
    .not.toBe(before);
  await page.waitForTimeout(1500);
  const thread = await page.locator('#thread-messages').innerText();

  // The guard is a rejection lane, not a rewrite of every reply.
  expect(thread).toContain('Overhead Press is still remaining');

  const stateRes = await page.request.get(`${stateBase}/`);
  const gate = await stateRes.json();
  expect(gate.appends).toEqual([]);
});
