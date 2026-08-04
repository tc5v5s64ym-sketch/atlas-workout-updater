'use strict';

// ── ONE credential-free browser harness for the coach / substitution lane ──────
//
// `substitution-truth.spec.js` and `staged-proposal-observation.spec.js` drive the
// SAME product path: open the real built shell, accept a plan through the real
// acceptance boundary, log real sets, and take the constraint lane to a staged
// proposal. Each spec previously carried its own copy of the route table, so a
// third spec meant a third bespoke mock and three places for the accepted-session
// shape to drift apart.
//
// The route table lives here ONCE and is driven by a FIXTURE. A spec supplies the
// plan, the catalog, the deterministic substitute recommendation, and how the
// parser reads its shorthand; it supplies no routing logic. Every route is
// read-only or a dry-run preview: nothing here can reach a workbook, a provider,
// or a credential, and no route claims a write.
//
// Captured traffic is EVIDENCE, not decoration. `capture.posts` holds the ledger
// sidecar payloads (accept / outcome / revision) a spec compares its expectation
// against, and `capture.chatCalls` proves a deterministic lane never leaked to the
// model.

function json(body, status = 200) {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

const dryRunEnvelope = {
  test_mode: true, sheet_written: false, no_write_confirmed: true, warnings: [],
};

// Install the route table for `fixture` on `page`, recording traffic into `capture`.
//
// fixture:
//   plan            { label, focus, recommended_label, recommended_reason, exercises: [...] }
//   catalog         [{ canonical_name, lift_code }]
//   substitute      the /api/suggest-substitute `recommendation` object (or null → no
//                   recommendation, so the constraint lane legitimately falls through)
//   parses          [{ match: RegExp, parsed }] — first match wins; no match →
//                   needs_clarification (the parser found no sets)
//   logPreview      optional log_rows_preview rows for the dry-run /api/log-workout
//   chatMessage     the message the coach lane WOULD serve if it were ever reached
//   recommendNext   optional (liftCode) => data for GET /api/recommend/next/<code>
async function installCoachLaneMocks(page, capture, fixture) {
  const f = fixture && typeof fixture === 'object' ? fixture : {};
  capture.posts = [];
  capture.chatCalls = [];
  capture.substituteCalls = [];
  capture.recommendNextCalls = [];
  capture.planRequests = 0;

  await page.route('**/health', route => route.fulfill(json({ status: 'ok' })));

  await page.route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const body = method === 'POST' && req.postData() ? req.postDataJSON() : null;

    if (path.startsWith('/api/session-plans/')) {
      capture.posts.push({ path, body });
      // /accept reports the identity the acceptance was written under — the server
      // allocates one when the client (correctly) sends none, and the client adopts it.
      const data = { session_plans: { captured: true, status: 'written' } };
      if (path === '/api/session-plans/accept') data.session_id = (body && body.session_id) || '20260612-PM-01';
      return route.fulfill(json({ status: 'ok', data }));
    }
    if (path.startsWith('/api/session-plan-sets/')) {
      capture.posts.push({ path, body });
      return route.fulfill(json({ status: 'ok', data: {} }));
    }

    if (path === '/api/plan/intent-recommendation') {
      capture.planRequests += 1;
      const p = f.plan || {};
      return route.fulfill(json({ status: 'success', data: {
        todays_read: {
          recommended_label: p.recommended_label || p.label || 'Push',
          recommended_reason: p.recommended_reason || 'Press focus today.',
        },
        intents: [{
          label: p.label || 'Push', focus: p.focus || 'Press + row', recommended: true,
          why_today: ['Fresh'], exercises: p.exercises || [],
        }],
      } }));
    }

    if (path === '/api/catalog/exercises') {
      return route.fulfill(json({ status: 'success', data: { exercises: f.catalog || [] } }));
    }

    // The DETERMINISTIC substitute recommender (read-only). It owns the substitute AND
    // its prescription — the model owns neither.
    if (path === '/api/suggest-substitute') {
      capture.substituteCalls.push(body);
      return route.fulfill(json({ status: 'success', data: { recommendation: f.substitute || null } }));
    }

    // The read-only prescription route. It is recorded whether or not the fixture
    // answers it, because WHEN it is called is itself the evidence a proposal-identity
    // claim built on it would have to stand on.
    const rn = /^\/api\/recommend\/next\/([^/?#]+)/.exec(path);
    if (rn) {
      const liftCode = decodeURIComponent(rn[1]).toUpperCase();
      capture.recommendNextCalls.push({ lift_code: liftCode, at: Date.now() });
      if (typeof f.recommendNext === 'function') {
        return route.fulfill(json({ status: 'success', data: f.recommendNext(liftCode) || {} }));
      }
      return route.fulfill(json({ status: 'success', data: {} }));
    }

    if (path === '/api/parse-workout-text') {
      const text = (body && (body.text || body.workout_text)) || '';
      for (const p of (f.parses || [])) {
        if (p && p.match && p.match.test(text)) {
          return route.fulfill(json({ status: 'success', data: { ...dryRunEnvelope, parsed: p.parsed } }));
        }
      }
      return route.fulfill(json({ status: 'success', data: {
        ...dryRunEnvelope, parsed: { intent: 'needs_clarification', message: 'no sets' } } }));
    }

    if (path === '/api/log-workout' && method === 'POST') {
      capture.posts.push({ path, body });
      return route.fulfill(json({ status: 'success', data: {
        ...dryRunEnvelope, sheet_write: 'skipped',
        auto_matches: [], pending_exercises: [], rule_flags: [],
        log_rows_preview: f.logPreview || [],
      } }));
    }

    // The coach chat lane must NEVER be reached for a deterministic substitution or its
    // follow-ups — record any call so a spec can prove the swap never leaked to the model.
    if (path === '/api/coach/chat') {
      capture.chatCalls.push(body);
      return route.fulfill(json({ status: 'success', data: {
        message: f.chatMessage || 'Keep going.', configured: true } }));
    }
    if (path === '/api/coach/message') {
      return route.fulfill(json({ status: 'success', data: { message: null, configured: false } }));
    }
    return route.fulfill(json({ status: 'success', data: {} }));
  });
}

// Open the real built shell with the mocks installed. `initScripts` are added BEFORE
// any application script runs, so an observer can be in place for the very first turn.
async function openCoachLane(page, capture, fixture, initScripts = []) {
  await installCoachLaneMocks(page, capture, fixture);
  await page.addInitScript(k => localStorage.setItem('atlas_api_key', k), 'playwright-test-key');
  for (const s of initScripts) await page.addInitScript(s.fn, s.arg);
  await page.goto('/app/');
}

async function submit(page, text) {
  await page.locator('#workout-text').fill(text);
  await page.locator('#preview-btn').click();
}

// Accept the plan the same way production does — by logging the first lift from the
// displayed pick, which mints the plan identity (pv_/pi_) the ledger addresses.
// Returns the /api/session-plans/accept payload so a spec can read the immutable
// plan_item_id of any slot it cares about.
async function acceptPlanByLogging(page, capture, { ask, firstLiftName, firstSetText }) {
  const { expect } = require('@playwright/test');
  await submit(page, ask || 'What are we doing today?');
  await expect(page.locator('#thread-messages .chat-bubble-atlas').first()
    .locator('.workout-plan-name').first()).toHaveText(firstLiftName);
  await submit(page, firstSetText);
  await expect.poll(() => capture.posts.filter(p => p.path === '/api/session-plans/accept').length)
    .toBeGreaterThan(0);
  return capture.posts.find(p => p.path === '/api/session-plans/accept').body;
}

// The ledger sidecar payloads, by kind — the durable surfaces in payload form.
const acceptPosts = capture => capture.posts.filter(p => p.path === '/api/session-plans/accept');
const outcomePosts = capture => capture.posts.filter(p => p.path === '/api/session-plans/outcome');
const revisionPosts = capture => capture.posts.filter(p => p.path === '/api/session-plan-sets/revision');

module.exports = {
  json,
  installCoachLaneMocks,
  openCoachLane,
  submit,
  acceptPlanByLogging,
  acceptPosts,
  outcomePosts,
  revisionPosts,
};
