'use strict';

// F10S2 — substitution BINDING (owner card, 2026-07-18 smoke gate): a recognized
// "Front Squat … instead of Back Squat" must satisfy the original Back Squat
// plan_item_id everywhere — the slot binds (id retained), Back Squat does not remain
// current, next-up advances consistently, and the performed exercise stays Front
// Squat in the actuals. The parser entry (F10S6c, merged) carries
// `substitution.for`; the client arms the EXISTING deferred-swap lane (Step 373b)
// with it at the chat-lane commit. This harness composes the REAL
// applySessionSubstitution + the REAL emitSetLogged from the built bundle (the
// binding is proven through the live lane, not a reimplementation).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

function loadBindingHarness() {
  // Real applySessionSubstitution (+ the F10B/F10C emitters it drives).
  const sliceApply = appSrc.slice(
    appSrc.indexOf('function applySessionSubstitution('),
    appSrc.indexOf('function reorderPlannedExercise(')
  );
  // Real emitSetLogged + the identity/remaining helpers (same span the post-log
  // identity harness proves).
  const sliceEmit = appSrc.slice(
    appSrc.indexOf('function plannedExerciseEntries()'),
    appSrc.indexOf('async function fetchReaction(')
  );
  assert.ok(sliceApply.includes('function applySessionSubstitution('), 'must contain applySessionSubstitution');
  assert.ok(sliceEmit.includes('function emitSetLogged('), 'must contain emitSetLogged');

  const events = [];
  const outcomes = [];
  const ledger = require('../src/app/sessionLedger.js');
  const { planSlotStatuses, remainingSlotNames, variantSatisfies } = require('../src/app/planSlotStatuses.js');
  const fakeDoc = { dispatchEvent: e => { events.push(e); return true; }, getElementById: () => null };
  function FakeCustomEvent(type, init) { return { type, detail: init && init.detail }; }

  const factory = new Function(
    'document', 'CustomEvent', 'setsTableBody', 'parsedRowsEditor', 'invalidatePreview',
    'planSlotStatuses', 'remainingSlotNames', 'variantSatisfies',
    'buildFutureRevisions', 'appendRevisions', 'ledgerPerformedSetCount', 'outcomes',
    `${STORE_SHIM}
     let lastIntentData = null;
     let lastParsedWorkoutText = '';
     let lastUnverifiedExercise = null;
     function renderActiveSessionBanner() {}
     function saveSessionSnapshot() {}
     function api() { return Promise.resolve({}); }
     function emitPlanItemOutcome(o) { outcomes.push(o); }
     ${sliceApply}
     ${sliceEmit}
     return {
       setActiveSession: s => { activePlannedSession = s; },
       setPendingSub: v => { setPendingSubstitution(v); },
       getPlan: () => activePlannedSession,
       getCompleted: () => sessionCompleted.slice(),
       getLog: () => sessionLog.slice(),
       remainingPlannedExercises,
       applySessionSubstitution,
       emitSetLogged,
     };`
  );
  const api = factory(fakeDoc, FakeCustomEvent, { innerHTML: '' }, { hidden: false }, () => {},
    planSlotStatuses, remainingSlotNames, variantSatisfies,
    ledger.buildFutureRevisions, ledger.appendRevisions, ledger.performedSetCount, outcomes);
  return { api, events, outcomes };
}

const PLAN = () => ({
  accepted: true, session_id: 'S1', session_date: '2026-07-18', plan_version: 'pv_x', index: 0,
  exercises: [
    { name: 'Back Squat', canonicalName: 'Back Squat', liftCode: 'BSQ01', plan_item_id: 'pi_bsq', weight: 225, reps: 5, sets: 3, rir: 2 },
    { name: 'Overhead Press', canonicalName: 'Overhead Press', liftCode: 'OHP01', plan_item_id: 'pi_ohp', weight: 115, reps: 6, sets: 3, rir: 2 },
  ],
  items: [
    { plan_item_id: 'pi_bsq', planned_lift_code: 'BSQ01', outcome: 'planned' },
    { plan_item_id: 'pi_ohp', planned_lift_code: 'OHP01', outcome: 'planned' },
  ],
});
const FS_ROW = { exercise: 'Front Squat', weight: 185, reps: 7, rir: 2, notes: '' };

test('SMOKE REPRODUCE: the armed "instead of" directive binds Front Squat to the Back Squat slot through the REAL lanes', () => {
  const { api, outcomes } = loadBindingHarness();
  api.setActiveSession(PLAN());
  // The chat-lane commit armed the deferred-swap lane from parsed.substitution.for.
  api.setPendingSub({ prescribed: 'Back Squat', prescription: null });
  // One turn: "Front Squat 185 7/2 x3 instead of Back Squat" → three logged rows.
  api.emitSetLogged([{ ...FS_ROW }, { ...FS_ROW }, { ...FS_ROW }], 'Front Squat 185 7/2 x3 instead of Back Squat', [], null);

  const slot = api.getPlan().exercises[0];
  assert.equal(slot.name, 'Front Squat', 'the slot is now the substitute');
  assert.equal(slot.plan_item_id, 'pi_bsq', 'the ORIGINAL plan_item_id is retained (binds)');
  assert.equal(slot.sets, 3, 'the slot keeps the original 3-set prescription (no directive prescription)');
  assert.equal(slot.reason, 'substituted');
  // The explicit substituted outcome bound to the original item.
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].plan_item_id, 'pi_bsq');
  assert.equal(outcomes[0].outcome, 'substituted');
  // Back Squat does not remain current; next-up advances consistently (3/3 sets done).
  assert.deepEqual(api.remainingPlannedExercises(), ['Overhead Press']);
  // The performed exercise remains Front Squat in the actuals.
  assert.ok(api.getLog().every(r => r.exercise === 'Front Squat'));
  assert.ok(api.getCompleted().includes('Front Squat'));
  assert.ok(!api.getCompleted().includes('Back Squat'), 'Back Squat is not claimed as performed');
});

test('multiplicity holds through the binding: ONE substitute set leaves the bound slot in progress (current), never Back Squat', () => {
  const { api } = loadBindingHarness();
  api.setActiveSession(PLAN());
  api.setPendingSub({ prescribed: 'Back Squat', prescription: null });
  api.emitSetLogged([{ ...FS_ROW }], 'Front Squat 185 7/2 instead of Back Squat', [], null);

  const slot = api.getPlan().exercises[0];
  assert.equal(slot.name, 'Front Squat');
  assert.equal(slot.sets, 3, 'requiredSets survives the swap');
  const remaining = api.remainingPlannedExercises();
  assert.equal(remaining[0], 'Front Squat', 'next-up is the IN-PROGRESS substitute — Back Squat is gone');
  assert.ok(!remaining.includes('Back Squat'));
});

test('an explicit substitute prescription still wins over the inherited set count', () => {
  const { api } = loadBindingHarness();
  api.setActiveSession(PLAN());
  api.applySessionSubstitution('Back Squat', 'Front Squat', 'FSQ01', { weight: 185, reps: 7, sets: 4, rir: 2 });
  assert.equal(api.getPlan().exercises[0].sets, 4, 'the recommender-supplied set count is used when present');
});

test('the REAL parse pipeline forwards the directive end-to-end (server builder → parseWorkoutTextWithBackend) — Codex P1', async () => {
  // The backend wrapper REBUILDS its return object; a field it does not forward is
  // silently dead downstream (exactly how the directive was dropped on #1062's first
  // head). Drive the REAL parseWorkoutTextWithBackend with an api stub that returns
  // the REAL server dry-run response for the one-turn phrase, and pin the forwarding.
  const { buildWorkoutTextParseDryRunResponse } = require('../services/workoutTextParser.js');
  const serverBody = buildWorkoutTextParseDryRunResponse({
    text: 'Front Squat 185 7/2 x3 instead of Back Squat', test_mode: true,
  });
  const slice = appSrc.slice(
    appSrc.indexOf('function rowsFromBackendParsedWorkout('),
    appSrc.indexOf('function populateSetRows(')
  );
  assert.ok(slice.includes('async function parseWorkoutTextWithBackend('), 'slice must contain the backend wrapper');
  const factory = new Function('api', 'workoutTextInput', 'firstUnloggedPlannedLift', `
    let activeExercise = null;
    class AbortController { constructor() { this.signal = null; } abort() {} }
    ${slice}
    return { parseWorkoutTextWithBackend };
  `);
  const h = factory(async () => ({ data: serverBody }), { value: '' }, () => null);
  const out = await h.parseWorkoutTextWithBackend('Front Squat 185 7/2 x3 instead of Back Squat');
  assert.equal(out.intent, 'log_sets');
  assert.equal(out.rows.length, 3, 'the three sets survive');
  assert.deepEqual(out.substitution, { for: 'Back Squat' }, 'the directive survives the rebuilt response shape');
});

// ── structural: the client wiring exists and is one-shot ─────────────────────────

test('wiring: the parse consumer holds the directive one-shot and the chat commit arms Step 373b', () => {
  assert.match(appSrc, /lastParseSubstitution = \(parsed\.substitution && parsed\.substitution\.for\)/,
    'the backend-parse consumer captures parsed.substitution.for');
  assert.match(appSrc, /lastParseSubstitution = null; \/\/ F10S2: one-shot — every new parse starts clean/,
    'every new parse resets the directive');
  const commit = appSrc.slice(appSrc.indexOf('clearPendingClarification();'), appSrc.indexOf('clearPendingClarification();') + 900);
  assert.match(commit, /if \(lastParseSubstitution && getActivePlannedSession\(\)\)/,
    'the chat-lane commit arms the swap only with an active plan');
  assert.match(commit, /setPendingSubstitution\(\{ prescribed: lastParseSubstitution, prescription: null \}\)/,
    'the directive rides the EXISTING deferred-swap lane');
});
