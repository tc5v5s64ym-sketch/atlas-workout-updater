'use strict';

// ── The Coach's Pick lane must never silently drop a submitted turn ───────────
//
// THE FAILURE THIS PINS. F-SB4 rehearsal Session 2 (run
// fsb4b-s2-20261029T013544-B83515) died on its teardown opener, "what should I
// train today?". The composer submit handler routes a session request FIRST to
// the in-thread Coach's Pick and returns. The pick entry point
// (window.atlasOpenCoachPick) is registered by coach-conversation.js, the last
// import of the second module graph, so it can be absent at submit time — the
// module failed, or is still loading. The claim site reached the lane through a
// typeof-guarded helper with no fallback, so the athlete's message vanished:
// no reply, no error, no coach request. The diagnosis reproduction (route-abort
// **/coach-conversation.js, submit the opener) showed only the intent-observe
// POST reaching the server, zero coach requests, zero bubbles in 90s.
//
// THE CONTRACT. The pick lane may claim a submitted turn only when its entry
// point actually exists. When it is absent, the turn falls through to the
// ordinary conversational handling — the same lanes a non-session-request
// message takes from the same handler — and the athlete still gets a coach
// answer, with a console.warn tripwire marking the fallback. When the entry
// point is present, the lane runs exactly as before: recommendation fetch,
// pick bubble, no ordinary-lane dispatch.
//
// HOW THE ABSENCE IS MADE HERE. The real built coach-conversation.js is
// served with exactly one statement removed — the atlasOpenCoachPick
// registration — so the module graph and every other behaviour are the
// production ones; only the pick global is missing, which is precisely the
// condition the claim site faces when the module has not registered it.
//
// Credential-free and write-free: every API route is mocked by the shared
// coach-lane harness; the chat lane is read-only by construction.

const { test, expect } = require('@playwright/test');
const { installCoachLaneMocks, submit } = require('./support/coach-lane-harness');

const PICK_ASSIGNMENT = 'window.atlasOpenCoachPick = typeSuggestedWorkout;';
// The failed session's exact opener.
const SESSION_REQUEST = 'what should I train today?';
// The pick lane's canonical typed entry (the harness's own acceptance ask).
const PICK_ASK = 'What are we doing today?';
// A plain coaching question: never a session request, in either posture.
const ORDINARY_QUESTION = 'any tips for keeping my lower back safe on the remaining lifts?';
const CHAT_REPLY = 'Pull day — rows and a hinge, taken at a conversational pace.';
const TRIPWIRE = 'Coach pick entry point unavailable';

const FIXTURE = {
  plan: {
    label: 'Pull', focus: 'Row + hinge',
    exercises: [{ name: 'Barbell Row', lift_code: 'BBROW', sets: 3, reps: 8, weight: 135 }],
  },
  catalog: [{ canonical_name: 'Barbell Row', lift_code: 'BBROW' }],
  substitute: null,
  parses: [],
  chatMessage: CHAT_REPLY,
};

// Open the real built shell with the mocks installed and the api key seeded,
// exactly as openCoachLane does — split out so a spec can interpose on the
// coach-conversation.js response before navigation.
async function openShell(page, capture) {
  await installCoachLaneMocks(page, capture, FIXTURE);
  await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), 'playwright-test-key');
  await page.goto('/app/');
}

// The pick global is ABSENT while the rest of coach-conversation.js runs:
// the greeting (a synchronous evaluation side effect of that module) proves
// the module evaluated, and the global was still never registered.
async function openWithPickAbsent(page, capture) {
  const warnings = [];
  page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
  await page.route('**/coach-conversation.js', async route => {
    const res = await route.fetch();
    const body = await res.text();
    expect(body, 'the built module must carry the pick registration this spec removes')
      .toContain(PICK_ASSIGNMENT);
    await route.fulfill({
      response: res,
      body: body.replace(PICK_ASSIGNMENT, '/* pick registration removed by this spec */'),
    });
  });
  await openShell(page, capture);
  await expect.poll(() => page.evaluate(() => ({
    greeting: (document.getElementById('coach-greeting') || {}).textContent || '',
    pick: typeof window.atlasOpenCoachPick,
  })), { timeout: 15000 }).toEqual({ greeting: expect.stringContaining('Dale'), pick: 'undefined' });
  return { warnings };
}

async function openWithPickPresent(page, capture) {
  await openShell(page, capture);
  await expect.poll(() => page.evaluate(() => typeof window.atlasOpenCoachPick),
    { timeout: 15000 }).toBe('function');
}

async function atlasBubbleText(page) {
  const texts = await page.locator('#thread-messages .chat-bubble-atlas').allInnerTexts();
  return texts.join('\n');
}

// The shell fetches the recommendation once at boot (the Today surface's own
// read), before any turn exists. Traffic assertions are therefore turn
// deltas: wait for the boot fetch to settle, snapshot the counter, and let
// each spec assert what ITS turn added.
async function planRequestsBaseline(page, capture) {
  let last = -1;
  let stable = 0;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && stable < 3) {
    if (capture.planRequests === last) stable += 1;
    else { last = capture.planRequests; stable = 0; }
    await page.waitForTimeout(300);
  }
  return capture.planRequests;
}

test.describe('the pick lane never silently drops a submitted turn', () => {
  test('pick entry point absent: a session request falls through to the ordinary coach lane and is answered', async ({ page }) => {
    test.setTimeout(90000);
    const capture = {};
    const { warnings } = await openWithPickAbsent(page, capture);
    const planBefore = await planRequestsBaseline(page, capture);

    await submit(page, SESSION_REQUEST);

    // The turn reached the ordinary coach path: the free-form chat lane was
    // dispatched for it, and its served reply rendered as a bubble.
    await expect.poll(() => capture.chatCalls.length, { timeout: 20000 }).toBeGreaterThan(0);
    await expect.poll(() => atlasBubbleText(page), { timeout: 20000 }).toContain(CHAT_REPLY);
    // The pick lane itself never engaged for this turn — the turn added no
    // recommendation fetch over the boot baseline.
    expect(capture.planRequests).toBe(planBefore);
    // The fallback is not silent in the console stream: the tripwire fired.
    expect(warnings.some(w => w.includes(TRIPWIRE)),
      'the fallback must emit its console.warn tripwire').toBe(true);
  });

  test('pick entry point present: the pick lane runs exactly as before', async ({ page }) => {
    test.setTimeout(90000);
    const capture = {};
    await openWithPickPresent(page, capture);
    const planBefore = await planRequestsBaseline(page, capture);

    await submit(page, PICK_ASK);

    // The authoritative recommendation was fetched for this turn and the pick
    // rendered in the thread, naming the fixture plan's first lift.
    await expect.poll(() => capture.planRequests, { timeout: 20000 }).toBeGreaterThan(planBefore);
    await expect(page.locator('#thread-messages .chat-bubble-atlas').first()
      .locator('.workout-plan-name').first()).toHaveText('Barbell Row');
    // No ordinary-lane dispatch for this turn.
    expect(capture.chatCalls).toHaveLength(0);
  });

  test('non-session messages route unchanged, pick entry point absent', async ({ page }) => {
    test.setTimeout(90000);
    const capture = {};
    await openWithPickAbsent(page, capture);
    const planBefore = await planRequestsBaseline(page, capture);

    await submit(page, ORDINARY_QUESTION);

    await expect.poll(() => capture.chatCalls.length, { timeout: 20000 }).toBeGreaterThan(0);
    await expect.poll(() => atlasBubbleText(page), { timeout: 20000 }).toContain(CHAT_REPLY);
    expect(capture.planRequests).toBe(planBefore);
  });

  test('non-session messages route unchanged, pick entry point present', async ({ page }) => {
    test.setTimeout(90000);
    const capture = {};
    await openWithPickPresent(page, capture);
    const planBefore = await planRequestsBaseline(page, capture);

    await submit(page, ORDINARY_QUESTION);

    await expect.poll(() => capture.chatCalls.length, { timeout: 20000 }).toBeGreaterThan(0);
    await expect.poll(() => atlasBubbleText(page), { timeout: 20000 }).toContain(CHAT_REPLY);
    expect(capture.planRequests).toBe(planBefore);
  });
});
