const { test, expect } = require('@playwright/test');

// F09 / SESS-1 + SESS-3 — coach narration must describe the CURRENT store-owned
// session, driven against the REAL built client at /app/ with mocked /api. The coach
// reaction path (handleSetLogged) runs after up to two ~9s coach-LLM awaits, so it
// must re-derive next-up / plan-completeness from the live canonical store — never the
// emit-time snapshot — and the one-shot closeout guard must re-arm when a completed
// plan is reopened. Both fail before the fix, pass after.

const TEST_KEY = 'playwright-test-key';
function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

async function openApp(page) {
  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  // Every /api call degrades to an empty success — the coach note falls back to its
  // deterministic opener (never null), so handleSetLogged still reaches the announce.
  await page.route('**/api/**', route => route.fulfill(json({ status: 'success', data: {} })));
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');
  await page.waitForLoadState('networkidle');
}

const BENCH = { name: 'Bench Press', liftCode: 'BPR01', weight: 225, reps: 5, sets: 3, rir: 2 };
const OHP = { name: 'Overhead Press', liftCode: 'OHP01', weight: 115, reps: 6, sets: 3, rir: 2 };

// Log a lift through the REAL emitter — it marks completion in the store AND dispatches
// atlas:set-logged, exactly as the live logging flow does.
async function logLift(page, name, weight, reps) {
  await page.evaluate(({ name, weight, reps }) => {
    window.emitSetLogged([{ exercise: name, weight, reps, rir: 2, notes: '' }], `${name} ${weight} ${reps}/2`);
  }, { name, weight, reps });
}

test('SESS-3: reopening a closed-out plan re-arms the closeout — the second completion prompts again', async ({ page }) => {
  await openApp(page);
  // A one-lift plan, so logging it completes the plan.
  await page.evaluate(bench => window.startPlannedSession({ label: 'Push', id: 'push', exercises: [bench] }), BENCH);

  // Complete the plan → closeout fires exactly once.
  await logLift(page, 'Bench Press', 225, 5);
  await expect(page.locator('.session-closeout')).toHaveCount(1);

  // Reopen: add an exercise to the active plan and announce the mutation (the real
  // add_exercises path fires atlas:plan-mutated after pushing the slot).
  await page.evaluate(ohp => {
    window.getActivePlannedSession().exercises.push(ohp);
    document.dispatchEvent(new CustomEvent('atlas:plan-mutated', { detail: { summary: 'Added Overhead Press.', current: 'Overhead Press' } }));
  }, OHP);

  // Complete the reopened plan → the closeout must fire a SECOND time.
  // Before the fix the guard stayed set through the reopen, so this stayed at 1.
  await logLift(page, 'Overhead Press', 115, 6);
  await expect(page.locator('.session-closeout')).toHaveCount(2);
});

test('SESS-1: an out-of-order set-logged snapshot never re-announces an already-logged next-up', async ({ page }) => {
  await openApp(page);
  await page.evaluate(({ bench, ohp }) => window.startPlannedSession({ label: 'Push', id: 'push', exercises: [bench, ohp] }), { bench: BENCH, ohp: OHP });

  // Log Bench → remaining is [Overhead Press] → one handoff "next up: Overhead Press".
  await logLift(page, 'Bench Press', 225, 5);
  await expect(page.locator('.next-exercise-handoff')).toHaveCount(1);
  // Log Overhead Press → plan complete → closeout; no new handoff.
  await logLift(page, 'Overhead Press', 115, 6);
  await expect(page.locator('.session-closeout')).toHaveCount(1);
  await expect(page.locator('.next-exercise-handoff')).toHaveCount(1);

  // A STALE Bench handler (a slow duplicate whose awaits resolved late) fires now,
  // carrying an emit-time snapshot from BEFORE Overhead Press was logged: it claims
  // Overhead Press is still next and the plan is not complete. Re-deriving from the
  // LIVE store (both lifts done) must ignore that stale snapshot — no second
  // "next up: Overhead Press" handoff. Before the fix this snapshot won and a second
  // handoff appeared.
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('atlas:set-logged', {
      detail: {
        exercises: [{ exercise: 'Bench Press', sets: [{ weight: 225, reps: 5, rir: 2 }] }],
        text: 'bench 225 5/2',
        planIsComplete: false,
        nextPlanned: 'Overhead Press',
        completed: ['Bench Press'],
        plannedOrder: ['Bench Press', 'Overhead Press'],
      },
    }));
  });
  // Give the stale handler time to run its awaits and (wrongly, pre-fix) render.
  await page.waitForTimeout(400);
  await expect(page.locator('.next-exercise-handoff')).toHaveCount(1);
});
