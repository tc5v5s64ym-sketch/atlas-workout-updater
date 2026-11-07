const { test, expect } = require('@playwright/test');

// G3 (issue #1566) — the two "next" notions must agree.
//
// SYMPTOM 1. The engine advisory's next_exercise comes from the planned_queue
// the client sends to /api/coach/message — which handleSetLogged builds from the
// EMIT-TIME detail snapshot (detail.plannedQueue) — while the plan-order handoff
// ("Moving on — next up: X") is re-derived from the LIVE store (SESS-1). When
// the snapshot and the live store diverge, the advisory line and the handoff
// name DIFFERENT lifts on screen at the same time: the live "Next pointed to
// Face Pull when the queued lift was Weighted Dips" repro.
//
// This probe dispatches a STALE set-logged event (the SESS-1 shape) whose
// snapshot queue still names Face Pull next, while the live store has already
// advanced past Face Pull to Weighted Dips. The mocked /api/coach/message
// mirrors the real server rule (routes/coachOps.js: advisory.next_exercise =
// nextExerciseName(planned_queue[0])) so the advisory it returns names
// whatever queue the client sent. The probe asserts the LAST advisory line
// and the LAST handoff name the SAME lift.
//
// Pre-fix this FAILS (advisory: Face Pull, handoff: Weighted Dips). The fix
// re-derives the planned_queue live at coach-message call time, the way the
// handoff already re-derives remaining — then the stale handler's advisory
// names the live next lift and the two agree.

const TEST_KEY = 'playwright-test-key';
function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

async function openApp(page) {
  // One catch-all: /api/coach/message answers with an advisory derived from the
  // request's own planned_queue (the server rule, mirrored); everything else
  // degrades to an empty success.
  await page.route('**/api/**', async route => {
    const url = route.request().url();
    if (url.includes('/api/coach/message')) {
      let queue = [];
      try {
        const body = route.request().postDataJSON();
        const facts = (body && body.facts) || {};
        if (Array.isArray(facts.planned_queue)) queue = facts.planned_queue;
      } catch { /* no queue → no advisory */ }
      const nextName = queue.length
        ? (typeof queue[0] === 'string' ? queue[0] : (queue[0].name || queue[0].canonicalName || ''))
        : '';
      const data = nextName
        ? { message: null, next_move_advisory: { action: 'reduce', reason: 'probe fatigue', target: null, next_exercise: nextName, next_modality: 'resistance' } }
        : { message: null, next_move_advisory: null };
      await route.fulfill(json({ status: 'success', data }));
      return;
    }
    await route.fulfill(json({ status: 'success', data: {} }));
  });
  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));
  await page.addInitScript(key => { localStorage.setItem('atlas_api_key', key); }, TEST_KEY);
  await page.goto('/app/');
  await page.waitForLoadState('networkidle');
}

const BENCH = { name: 'Bench Press', liftCode: 'BPR01', weight: 225, reps: 5, sets: 3, rir: 2 };
const FACE_PULL = { name: 'Face Pull', liftCode: 'FPL01', weight: 45, reps: 15, sets: 3, rir: 2 };
const DIPS = { name: 'Weighted Dips', liftCode: 'WDP01', weight: 25, reps: 8, sets: 3, rir: 2 };

async function logLift(page, name, weight, reps) {
  await page.evaluate(({ name, weight, reps }) => {
    window.emitSetLogged([{ exercise: name, weight, reps, rir: 2, notes: '' }], `${name} ${weight} ${reps}/2`);
  }, { name, weight, reps });
}

async function logFullLift(page, name, weight, reps, sets = 3) {
  for (let i = 0; i < sets; i += 1) await logLift(page, name, weight, reps);
}

test('G3-1: a stale snapshot queue must not let the advisory name a different next lift than the live handoff', async ({ page }) => {
  await openApp(page);
  await page.evaluate(({ bench, facePull, dips }) => window.startPlannedSession({ label: 'Push', id: 'push', exercises: [bench, facePull, dips] }), { bench: BENCH, facePull: FACE_PULL, dips: DIPS });

  // Finish Bench → remaining [Face Pull, Weighted Dips]; handoff names Face Pull.
  await logFullLift(page, 'Bench Press', 225, 5);
  await expect(page.locator('.next-exercise-handoff')).toHaveCount(1);
  // Finish Face Pull → remaining [Weighted Dips]; handoff names Weighted Dips.
  await logFullLift(page, 'Face Pull', 45, 15);
  await expect(page.locator('.next-exercise-handoff')).toHaveCount(2);

  // A STALE Bench handler fires now, carrying an emit-time snapshot from BEFORE
  // Face Pull was logged: its plannedQueue still names Face Pull next.
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('atlas:set-logged', {
      detail: {
        exercises: [{ exercise: 'Bench Press', sets: [{ weight: 225, reps: 5, rir: 2 }] }],
        text: 'bench 225 5/2',
        planIsComplete: false,
        nextPlanned: 'Face Pull',
        completed: ['Bench Press'],
        plannedOrder: ['Bench Press', 'Face Pull', 'Weighted Dips'],
        plannedQueue: ['Face Pull', 'Weighted Dips'],
      },
    }));
  });
  // Give the stale handler time to run its awaits and render its advisory line.
  await page.waitForTimeout(1500);

  // The live handoff still names Weighted Dips (no re-announce of Face Pull).
  const handoffs = await page.locator('.next-exercise-handoff').allTextContents();
  const lastHandoff = handoffs[handoffs.length - 1] || '';
  const handoffNext = (lastHandoff.match(/next up:\s*(.+?)\.?$/) || [])[1] || '';
  expect(handoffNext).toBe('Weighted Dips');

  // The advisory lines the coach rendered, most recent last.
  const notes = await page.locator('.coach-msg').allTextContents();
  const advisories = notes.filter(t => /Heads up — ease off on .+ next/.test(t));
  expect(advisories.length).toBeGreaterThan(0);
  const lastAdvisory = advisories[advisories.length - 1];
  const advisoryNext = (lastAdvisory.match(/ease off on (.+?) next/) || [])[1] || '';
  // THE G3-1 ASSERTION: the advisory's next lift must be the live next lift.
  expect(advisoryNext).toBe(handoffNext);
});

// G3-2 GUARD (symptom 2, stale-snapshot mechanism): a stale snapshot that claims
// the plan is complete must never fire the "say done" closeout while the live
// store still has lifts queued. The closeout branch re-derives plan-completeness
// from the live store (SESS-1), so this is expected to PASS on current s3 — it
// rules OUT the stale snapshot as symptom 2's mechanism and pins the guard
// against regression. If it ever fails, the closeout is reading the snapshot.
test('G3-2: a stale complete-plan snapshot never fires the say-done closeout while lifts are still queued', async ({ page }) => {
  await openApp(page);
  await page.evaluate(({ bench, facePull, dips }) => window.startPlannedSession({ label: 'Push', id: 'push', exercises: [bench, facePull, dips] }), { bench: BENCH, facePull: FACE_PULL, dips: DIPS });

  // Finish Bench → Face Pull and Weighted Dips still queued.
  await logFullLift(page, 'Bench Press', 225, 5);
  await expect(page.locator('.session-closeout')).toHaveCount(0);

  // A STALE event claims the whole plan is complete (snapshot from a finished plan).
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('atlas:set-logged', {
      detail: {
        exercises: [{ exercise: 'Weighted Dips', sets: [{ weight: 25, reps: 8, rir: 2 }] }],
        text: 'weighted dips 25 8/2',
        planIsComplete: true,
        nextPlanned: null,
        completed: ['Bench Press', 'Face Pull', 'Weighted Dips'],
        plannedOrder: ['Bench Press', 'Face Pull', 'Weighted Dips'],
        plannedQueue: [],
      },
    }));
  });
  await page.waitForTimeout(1500);
  // Live remaining is [Face Pull, Weighted Dips] — no closeout may fire.
  await expect(page.locator('.session-closeout')).toHaveCount(0);

  // Genuine completion still fires the closeout exactly once.
  await logFullLift(page, 'Face Pull', 45, 15);
  await logFullLift(page, 'Weighted Dips', 25, 8);
  await expect(page.locator('.session-closeout')).toHaveCount(1);
});

// NOTE (symptom 2, no-prescribed-sets hypothesis — TESTED AND REFUTED as a bug,
// 2026-11-07 12:00 check): a G3-3 probe asserting "one set of a no-sets slot
// must not fire the closeout" FAILED the code but the code is RIGHT — the
// any-attributed-log-completes rule for unknown-count slots is the DESIGNED
// contract for coach-suggested plans (their entries carry no target_sets by
// design — see the SUGGESTED_PLAN fixture in test/postLogIdentity.test.js — and
// one set per lift is the completion signal). Flipping it to fail-closed broke
// 14 unit tests (canonical session, recap, plan-card cursor, insert wiring,
// post-log identity). The fix was reverted the same check. What remains of
// symptom 2 is the live repro's shape — plan exhausted while the lifter intends
// more work beyond the plan — which is the FB completion-flow slice, out of
// this item per the coordinator's claim scope (owner's FB decision pending).
// Do not re-try the unknown-count flip without that decision.
