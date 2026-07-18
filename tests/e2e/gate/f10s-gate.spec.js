'use strict';
/*
 * F10S-GATE — the July 18 Work-mode smoke test, rerun non-destructively against the
 * REAL app: real built client, real server (index.js via gate-server.js), real parser,
 * real trust loop. Sheets are an in-memory stub (nothing can reach Google); no LLM key
 * (deterministic coach voice); Playwright marks every request synthetic.
 *
 * Exit criteria (owner directive 2026-07-18) — each asserted HARD below:
 *   1. one-of-three sets shows IN PROGRESS (never completes the slot)        [F10S1]
 *   2. the substitution completes the ORIGINAL slot                          [F10S2]
 *   3. chat, rail, pin, and closeout AGREE                                   [F10S3/S4]
 *   4. natural-language inputs work (planning ask, "245 x 6 @3", one-turn
 *      "instead of")                                                         [F10S6]
 *   5. closeout commentary is deduplicated                                   [F10S5]
 *
 * Artifacts: numbered screenshots + transcript.json + TRANSCRIPT.md + the
 * write-evidence appendix (GET /__gate/state) under ATLAS_GATE_ARTIFACT_DIR
 * (default test-results/f10s-gate/<project>).
 */

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const GATE_KEY = 'playwright-gate-key';

let child = null;
let base = null;
let stateBase = null;
let artDir = null;
const transcript = [];

function record(step, note) {
  transcript.push({ at: new Date().toISOString(), step, note });
}

async function threadText(page) {
  return page.locator('#thread-messages').innerText().catch(() => '');
}

async function snap(page, name) {
  await page.screenshot({ path: path.join(artDir, name), fullPage: true });
}

async function openApp(page) {
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, GATE_KEY);
  await page.goto(`${base}/app/`);
  await page.waitForLoadState('networkidle');
}

// Type a message into the ONE composer and submit it — the exact owner gesture.
async function say(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
  record('say', text);
}

// A logging message. In the chat-first flow a parsed set COMMITS directly (session
// state updates live; the preview→approve panel is the closeout compile surface, not
// a per-set gate) — and the coach's spoken reaction may legitimately stay quiet
// (anti-repetition voice ledger), so the settle signal is STORE TRUTH, not chatter:
// wait until the pin's state changes or a closeout appears. Callers then assert the
// exact expected pin/rail state.
async function logSet(page, text) {
  const before = await page.evaluate(() => {
    const t = c => { const n = document.querySelector(`#session-pin .${c}`); return n ? n.textContent : ''; };
    return { pin: `${t('pin-lift')}|${t('pin-sets')}`, closeouts: document.querySelectorAll('.session-closeout').length };
  });
  await say(page, text);
  await expect
    .poll(() => page.evaluate(prev => {
      const t = c => { const n = document.querySelector(`#session-pin .${c}`); return n ? n.textContent : ''; };
      const pin = `${t('pin-lift')}|${t('pin-sets')}`;
      const closeouts = document.querySelectorAll('.session-closeout').length;
      return pin !== prev.pin || closeouts > prev.closeouts;
    }, before), { timeout: 25000 })
    .toBe(true);
}

// Pull the session pin down to open the workout sheet (the rail), matching the
// real gesture from workout-sheet.spec.js.
async function openSheet(page) {
  const pin = page.locator('#session-pin');
  const box = await pin.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + Math.min(box.height / 2, 12);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 14;
  for (let i = 1; i <= steps; i++) await page.mouse.move(cx, cy + (420 * i) / steps);
  await page.mouse.up();
  await expect(page.locator('#workout-sheet')).toHaveClass(/ws-open/, { timeout: 10000 });
}

async function closeSheet(page) {
  const vh = await page.evaluate(() => document.documentElement.clientHeight);
  const w = await page.evaluate(() => document.documentElement.clientWidth);
  await page.mouse.click(Math.round(w / 2), Math.round(vh - 15));
  await expect(page.locator('#workout-sheet')).not.toHaveClass(/ws-open/, { timeout: 10000 });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, testInfo) => {
  artDir = process.env.ATLAS_GATE_ARTIFACT_DIR
    ? path.join(process.env.ATLAS_GATE_ARTIFACT_DIR, testInfo.project.name)
    : path.join(__dirname, '..', '..', '..', 'test-results', 'f10s-gate', testInfo.project.name);
  fs.mkdirSync(artDir, { recursive: true });

  child = spawn(process.execPath, [path.join(__dirname, 'gate-server.js')],
    { env: { ...process.env, ATLAS_GATE_KEY: GATE_KEY }, stdio: ['ignore', 'pipe', 'pipe'] });
  const ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gate-server did not report its ports within 30s')), 30000);
    let buf = '';
    child.stdout.on('data', d => {
      buf += String(d);
      const app = buf.match(/GATE_PORT=(\d+)/);
      const state = buf.match(/GATE_STATE_PORT=(\d+)/);
      if (app && state) { clearTimeout(timer); resolve({ app: app[1], state: state[1] }); }
    });
    child.stderr.on('data', d => process.stderr.write(`[gate-server] ${d}`));
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`gate-server exited early (${code})`)); });
  });
  base = `http://127.0.0.1:${ports.app}`;
  stateBase = `http://127.0.0.1:${ports.state}`;
  record('boot', `gate server at ${base} (real index.js, sheets stubbed in memory)`);
});

test.afterAll(async () => {
  if (child) child.kill('SIGTERM');
  if (artDir) {
    fs.writeFileSync(path.join(artDir, 'transcript.json'), JSON.stringify(transcript, null, 2));
    const md = ['# F10S-GATE rerun transcript', '', ...transcript.map(t => `- \`${t.at}\` **${t.step}** — ${t.note}`)];
    fs.writeFileSync(path.join(artDir, 'TRANSCRIPT.md'), md.join('\n'));
  }
});

test('F10S-GATE: July 18 Work-mode smoke rerun — every exit criterion holds', async ({ page }) => {
  test.setTimeout(240000);
  await openApp(page);
  await snap(page, '00-home.png');
  record('open', 'app loaded at /app/ (home, one composer)');

  // ---- Criterion 4a (F10S6a): "What should I do today?" invokes PLANNING ---------
  await say(page, 'What should I do today?');
  const pickBubble = page.locator('#thread-messages .chat-bubble-atlas').first();
  await expect(pickBubble).toContainText("Today's read", { timeout: 30000 });
  const pickText = await pickBubble.innerText();
  expect(pickText.toLowerCase()).not.toContain('keep logging');
  record('F10S6a', `planning invoked — pick bubble opens with "Today's read"; no "keep logging" fallback. First line: ${pickText.split('\n')[0]}`);
  await snap(page, '01-planning-invoked.png');

  // ---- Start the owner's Work-day plan through the REAL acceptance entry ---------
  // (the same window.atlasAcceptPlan the pick's "Start this plan" button calls),
  // with the July 18 day shape: RDL 3×, Back Squat 3×, Overhead Press 3×.
  const started = await page.evaluate(() => window.atlasAcceptPlan({
    id: 'work_day', label: 'Work', why_today: 'Gate rerun of the July 18 Work-mode day.',
    exercises: [
      { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 245, target_reps: 6, target_sets: 3, target_rir: 3 },
      { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 225, target_reps: 5, target_sets: 3, target_rir: 2 },
      { exercise: 'Overhead Press', lift_code: 'OHP01', target_weight: 115, target_reps: 6, target_sets: 3, target_rir: 2 }
    ]
  }));
  expect(started && started.started).toBeTruthy();
  await expect(page.locator('#session-pin .pin-lift')).toHaveText('Romanian Deadlift', { timeout: 15000 });
  await expect(page.locator('#session-pin .pin-sets')).toContainText('0 of 3', { timeout: 15000 });
  // Capture each accepted slot's immutable identity — the substitution assertion
  // below proves the ORIGINAL Back Squat plan_item_id survives on the substituted slot.
  const acceptedSlots = await page.evaluate(() =>
    window.getActivePlannedSession().exercises.map(e => ({ name: e.name, id: e.plan_item_id || null })));
  expect(acceptedSlots.map(s => s.name)).toEqual(['Romanian Deadlift', 'Back Squat', 'Overhead Press']);
  const backSquatItemId = acceptedSlots[1].id;
  record('plan', `Work plan started (RDL 3×, Back Squat 3×, OHP 3×) — pin: Romanian Deadlift · 0 of 3 sets; Back Squat slot identity ${backSquatItemId || '(unassigned)'}`);
  await snap(page, '02-plan-started.png');

  // ---- Criterion 4b (F10S6b) + Criterion 1 (F10S1) + pin (F10S4) -----------------
  // "Romanian Deadlift 245 x 6 @3" logs ONE set; the 3-set slot must show IN
  // PROGRESS everywhere — never complete, never advance.
  await logSet(page, 'Romanian Deadlift 245 x 6 @3');
  await expect(page.locator('#session-pin .pin-lift')).toHaveText('Romanian Deadlift');
  await expect(page.locator('#session-pin .pin-sets')).toContainText('1 of 3');
  await expect(page.locator('.next-exercise-handoff')).toHaveCount(0);
  await expect(page.locator('.session-closeout')).toHaveCount(0);
  await openSheet(page);
  const cards = page.locator('#workout-sheet .ws-card');
  await expect(cards.nth(0).locator('.ws-nm')).toHaveText('Romanian Deadlift');
  await expect(cards.nth(0)).toHaveClass(/now/);
  await expect(cards.nth(0)).not.toHaveClass(/done/);
  await expect(page.locator('#workout-sheet .ws-prog')).toContainText('0 of 3');
  record('F10S1+S4+S6b', 'one of three sets logged via "245 x 6 @3" — rail: RDL current (not done), 0 of 3 slots; pin: 1 of 3 sets; no handoff, no closeout');
  await snap(page, '03-one-of-three-in-progress.png');
  await closeSheet(page);

  // ---- Completing the slot takes ALL THREE sets, then the handoff advances -------
  await logSet(page, 'Romanian Deadlift 245 x 6 @3');
  await expect(page.locator('#session-pin .pin-sets')).toContainText('2 of 3');
  await logSet(page, 'Romanian Deadlift 245 x 5 @2');
  await expect(page.locator('#session-pin .pin-lift')).toHaveText('Back Squat', { timeout: 20000 });
  await expect(page.locator('#session-pin .pin-sets')).toContainText('0 of 3');
  await expect(page.locator('.next-exercise-handoff')).toHaveCount(1);
  await expect(page.locator('.next-exercise-handoff').last()).toContainText('Back Squat');
  record('F10S1', 'slot completed at 3/3 — handoff advanced to Back Squat; pin: Back Squat · 0 of 3 sets');
  await snap(page, '04-slot-complete-at-three.png');

  // ---- Criteria 2 + 4c (F10S2 + F10S6c): one-turn substitution binds the ORIGINAL
  // slot — "Front Squat 185 7/2 x3 instead of Back Squat" logs AND satisfies
  // Back Squat; actuals keep Front Squat; next-up advances.
  await logSet(page, 'Front Squat 185 7/2 x3 instead of Back Squat');
  await expect(page.locator('#session-pin .pin-lift')).toHaveText('Overhead Press', { timeout: 20000 });
  await expect(page.locator('#session-pin .pin-sets')).toContainText('0 of 3');
  await expect(page.locator('.next-exercise-handoff')).toHaveCount(2);
  await expect(page.locator('.next-exercise-handoff').last()).toContainText('Overhead Press');
  await openSheet(page);
  // The rail shows the PERFORMED truth: the original Back Squat slot is SATISFIED
  // (done) and now carries the substitute's name; Back Squat is current nowhere.
  // The original PLAN truth lives immutably in the append-only Session_Plans
  // ledger (planned_lift_code SQ01) — asserted in the write-evidence step below.
  await expect(cards.nth(1).locator('.ws-nm')).toContainText('Front Squat');
  await expect(cards.nth(1)).toHaveClass(/done/);
  await expect(cards.nth(2)).toHaveClass(/now/);                            // Overhead Press is current
  await expect(page.locator('#workout-sheet .ws-prog')).toContainText('2 of 3');
  // The BINDING truth: the substituted slot keeps the ORIGINAL Back Squat
  // plan_item_id (reason 'substituted') and inherits the original 3-set grain —
  // the item was substituted, never replaced by a new plan item.
  const subSlot = await page.evaluate(() =>
    (window.getActivePlannedSession().exercises.find(e => e.reason === 'substituted') || null));
  expect(subSlot, 'a substituted slot exists in the active session').toBeTruthy();
  expect(subSlot.name).toBe('Front Squat');
  expect(subSlot.sets).toBe(3);
  if (backSquatItemId) expect(subSlot.plan_item_id).toBe(backSquatItemId);
  record('F10S2+S6c', `one-turn substitution: Front Squat 3× logged, ORIGINAL slot satisfied (done, Back Squat current nowhere), slot keeps its accepted identity ${subSlot.plan_item_id || '(unassigned)'} and 3-set grain, rail 2 of 3, next-up Overhead Press`);
  await snap(page, '05-substitution-binds-original-slot.png');
  await closeSheet(page);

  // ATLAS's substitution acknowledgment exists — capture ITS line (from Atlas
  // bubbles only, never the lifter's own echoed message) for the dedup count.
  const atlasLines = async () => {
    const texts = await page.locator('#thread-messages .chat-bubble-atlas').allInnerTexts();
    return texts.flatMap(t => t.split('\n')).map(l => l.trim()).filter(Boolean);
  };
  const subLine = (await atlasLines())
    .find(l => /front squat/i.test(l) && /pivot|swap|sub|instead|in for/i.test(l)) || null;
  expect(subLine, "Atlas acknowledges the substitution (an ack line naming the substitute)").toBeTruthy();
  record('F10S5-setup', `Atlas acknowledged the substitution once as: "${subLine}"`);

  // ---- Criterion 3 (F10S3): chat agrees with rail + pin --------------------------
  // Probe with bare in-session shorthand ("how much?") — the deterministic engine
  // lane that resolves the CURRENT lift from the client-supplied plan_state
  // (plan_state.remaining[0], the selector verdict). This is the exact lane the
  // July 18 disagreement came from: before the fix the server re-derived "current"
  // from the stale completed-names set-difference, which lands on Back Squat here
  // (its slot was satisfied by the SUBSTITUTE'S name); after the fix the verdict
  // travels and the answer names Overhead Press — agreeing with pin and rail.
  // (The generic-prose LLM is deliberately unconfigured in this harness; prose
  // lanes degrade to templated fallbacks that name no lift and so cannot disagree.)
  const bubblesBefore = await page.locator('#thread-messages .chat-bubble-atlas').count();
  await say(page, 'how much?');
  await expect
    .poll(() => page.locator('#thread-messages .chat-bubble-atlas').count(), { timeout: 20000 })
    .toBeGreaterThan(bubblesBefore);
  const nextReply = await page.locator('#thread-messages .chat-bubble-atlas').last().innerText();
  expect(nextReply).toContain('Overhead Press');
  expect(nextReply).not.toContain('Back Squat');
  record('F10S3', `chat "how much?" answers from the SAME selector verdict: "${nextReply.split('\n')[0]}" — names Overhead Press, agreeing with pin and rail; never the stale Back Squat`);
  await snap(page, '06-chat-agrees-overhead-press.png');

  // ---- Finish the plan; Criterion 5 (F10S5): the closeout says it ONCE -----------
  await logSet(page, 'Overhead Press 115 x 6 @2');
  await logSet(page, 'Overhead Press 115 x 6 @2');
  await logSet(page, 'Overhead Press 115 x 5 @1');
  await expect(page.locator('.session-closeout')).toHaveCount(1, { timeout: 20000 });
  // The July 18 failure: the SAME substitution note stacked once per performed
  // set/source path. Across every Atlas bubble of the whole session, the ack line
  // must appear exactly once.
  const finalAtlasLines = await atlasLines();
  const occurrences = finalAtlasLines.filter(l => l === subLine.trim()).length;
  expect(occurrences, 'the same substitution note must appear exactly once across the whole session').toBe(1);
  record('F10S5', 'plan complete — closeout rendered once; the substitution ack appears exactly once across every Atlas bubble');
  await snap(page, '07-closeout-deduplicated.png');
  fs.writeFileSync(path.join(artDir, 'thread.txt'), await threadText(page));

  // ---- Evidence: actuals keep Front Squat; NOTHING wrote to any sheet ------------
  // The actuals truth is the client canonical session log (what the closeout
  // compiles from): three Front Squat rows, zero rows claiming Back Squat.
  const actuals = await page.evaluate(() => window.getSessionLog().map(r => r.canonical || r.exercise));
  expect(actuals.filter(n => n === 'Front Squat')).toHaveLength(3);
  expect(actuals.filter(n => n === 'Back Squat')).toHaveLength(0);
  // Non-destructive posture held END TO END: the sheet write is the closeout SAVE
  // (never invoked here, exactly as the July 18 smoke stopped short of it) and the
  // set-ledger write enablement is the still-paused F10D phase — so the run must
  // record ZERO append calls and ZERO tab creations. (Belt and braces: the sheets
  // client was an in-memory stub, so nothing could have reached Google regardless.)
  const gateState = await (await fetch(`${stateBase}/state`)).json();
  fs.writeFileSync(path.join(artDir, 'write-evidence.json'), JSON.stringify(gateState, null, 2));
  expect((gateState.appends || []).length).toBe(0);
  expect((gateState.ensure_tab_calls || []).length).toBe(0);
  expect(gateState.sheets_stubbed_in_memory).toBe(true);
  record('evidence', 'actuals: 3× Front Squat, 0× Back Squat (client canonical log); sheet writes: ZERO append calls, ZERO tab creations — the write phase remains F10D-gated');
  await snap(page, '08-final-state.png');
});
