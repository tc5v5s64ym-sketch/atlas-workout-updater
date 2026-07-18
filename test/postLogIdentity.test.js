'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const { STORE_SHIM } = require('./helpers/storeShim');
const { analyzeSetSequence, assessNextMoveConflict } = require('../services/setEffortSignals');
const { rerouteNote } = require('../services/setEffortCopy');

// Post-log UI state consistency (follow-up to PR #479). Extract the real app.js
// identity/remaining helpers and the coach-conversation lift-code resolver and
// drive them with the exact live-test plan + aliases, so every post-log surface
// (sessionCompleted, plannedQueue, nextPlanned, reroute, confirmation card)
// resolves a logged alias to the SAME planned lift.

// --- harness: app.js plan identity + remaining-queue helpers -----------------
function loadIdentityHarness() {
  const src = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const slice1 = src.slice(
    src.indexOf('function plannedExerciseEntries()'),
    src.indexOf('function firstUnloggedPlannedLift()')
  );
  const slice2 = src.slice(
    src.indexOf('function resolveCompletedIdentity(rawName, enrichmentRow)'),
    src.indexOf('function emitSetLogged(')
  );
  assert.ok(slice1 && slice2, 'identity helpers must be found in app.js');
  // F10: the sliced helpers now route completion through the authoritative selector —
  // resolveCompletedIdentity uses variantSatisfies, remainingPlannedExercises uses
  // remainingSlotNames. Inject the real (pure) implementations so the harness exercises
  // the SAME logic app.js imports from planSlotStatuses.js.
  const { remainingSlotNames, variantSatisfies } = require('../src/app/planSlotStatuses.js');
  const factory = new Function('remainingSlotNames', 'variantSatisfies', `
    ${STORE_SHIM}
    let lastIntentData = null;
    ${slice1}
    ${slice2}
    return {
      setActiveSession: s => { activePlannedSession = s; },
      // Setting a coach-suggested plan in the harness models the ENGAGED Coach's
      // Pick flow (the lifter tapped the pick), so engagement rides with it. A
      // merely-displayed-but-unengaged suggestion is exercised via setEngaged(false).
      setIntentData: d => { lastIntentData = d; coachSuggestionEngaged = !!d; },
      setEngaged: v => { coachSuggestionEngaged = !!v; },
      logCompleted: (raw, enr) => { sessionCompleted.push(resolveCompletedIdentity(raw, enr)); },
      getCompleted: () => sessionCompleted.slice(),
      plannedExerciseOrder,
      remainingPlannedExercises,
      resolveCompletedIdentity,
    };
  `);
  return factory(remainingSlotNames, variantSatisfies);
}

// --- harness: coach-conversation.js liftCodeForExercise ----------------------
function loadLiftCodeResolver(options) {
  const src = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  const fnSrc = src.slice(
    src.indexOf('function liftCodeForExercise(name)'),
    src.indexOf('async function getNextExerciseInPlan')
  );
  assert.ok(fnSrc, 'liftCodeForExercise must be found');
  const fakeDoc = { getElementById: () => ({ options }) };
  return new Function('document', `${fnSrc}; return liftCodeForExercise;`)(fakeDoc);
}

// The live-test plan, as a coach-suggested intent (activePlannedSession === null —
// the flow that previously dropped completion identity).
const SUGGESTED_PLAN = {
  intents: [{
    recommended: true,
    exercises: [
      { exercise: 'Bench Press', canonical_exercise: 'Bench Press', lift_code: 'BEN01' },
      { exercise: 'Seated Row', canonical_exercise: 'Seated Row', lift_code: 'ROW01' },
      { exercise: 'Weighted Dip', canonical_exercise: 'Weighted Dip', lift_code: 'DIP01' },
      { exercise: 'Lat Pulldown', canonical_exercise: 'Lat Pulldown', lift_code: 'LAT01' },
      { exercise: 'Incline DB Press', canonical_exercise: 'Incline DB Press', lift_code: 'INC01' },
      { exercise: 'Face Pull', canonical_exercise: 'Face Pull', lift_code: 'FAC01' },
    ],
  }],
};

// 1 — a logged alias resolves to the planned lift (by lift_code AND by alias/contains).
test('post-log identity: "Dips (Weighted)" / "Weighted dips" / "Lat pull" resolve to planned lifts', () => {
  const h = loadIdentityHarness();
  h.setIntentData(SUGGESTED_PLAN);
  // lift_code is authoritative even when the display canonical differs.
  assert.equal(h.resolveCompletedIdentity('Weighted dips', { lift_code: 'DIP01', canonical_exercise: 'Dips (Weighted)' }), 'Weighted Dip');
  // No code: alias/contains still maps the shorthand to the planned name.
  assert.equal(h.resolveCompletedIdentity('Weighted dips', { canonical_exercise: 'Dips (Weighted)' }), 'Weighted Dip');
  assert.equal(h.resolveCompletedIdentity('Lat pull', {}), 'Lat Pulldown');
  // Unrelated input is left as-is (no false plan match).
  assert.equal(h.resolveCompletedIdentity('Bicep Curl', {}), 'Bicep Curl');
});

// 1b — parity in the STARTED-session flow (activePlannedSession set).
test('post-log identity: started-session flow resolves the same way', () => {
  const h = loadIdentityHarness();
  h.setActiveSession({ exercises: [
    { name: 'Weighted Dip', canonicalName: 'Weighted Dip', liftCode: 'DIP01' },
    { name: 'Lat Pulldown', canonicalName: 'Lat Pulldown', liftCode: 'LAT01' },
  ] });
  assert.equal(h.resolveCompletedIdentity('Weighted dips', { lift_code: 'DIP01' }), 'Weighted Dip');
  assert.equal(h.resolveCompletedIdentity('Lat pull', {}), 'Lat Pulldown');
});

// 2 — plannedQueue (remaining) excludes the just-completed Weighted Dip.
test('post-log identity: remaining queue excludes a completed lift logged under an alias', () => {
  const h = loadIdentityHarness();
  h.setIntentData(SUGGESTED_PLAN);
  h.logCompleted('Bench Press', { lift_code: 'BEN01' });
  h.logCompleted('Seated Row', { lift_code: 'ROW01' });
  h.logCompleted('Weighted dips', { lift_code: 'DIP01', canonical_exercise: 'Dips (Weighted)' });
  const remaining = h.remainingPlannedExercises();
  assert.ok(!remaining.includes('Weighted Dip'), 'completed Weighted Dip must not remain');
  assert.deepEqual(remaining, ['Lat Pulldown', 'Incline DB Press', 'Face Pull']);
});

// 2b — the engagement gate: a DISPLAYED-but-unengaged suggestion is not a plan.
// loadDashboard() always loads lastIntentData to render the home-screen pick, but a
// cold direct-composer log (Coach's Pick never tapped) must see an EMPTY plan — no
// nextPlanned / handoff / composer pre-fill. Engaging the pick turns it into a plan.
test('coach-pick gate: lastIntentData is NOT a plan until Coach\'s Pick is engaged', () => {
  const h = loadIdentityHarness();
  h.setIntentData(SUGGESTED_PLAN);
  h.setEngaged(false); // suggestion shown on the dashboard, but not engaged
  assert.deepEqual(h.plannedExerciseOrder(), [], 'an unengaged suggestion is not an active plan');
  assert.deepEqual(h.remainingPlannedExercises(), [], 'no next-up is offered for a cold direct-composer log');
  h.setEngaged(true); // lifter taps Coach's Pick → now it is the plan
  assert.equal(h.plannedExerciseOrder()[0], 'Bench Press', 'engaging the pick activates the plan');
});

// 3 — reroute must never defer the lift that was just completed.
test('post-log identity: reroute does not defer the just-completed Weighted Dip', () => {
  const h = loadIdentityHarness();
  h.setIntentData(SUGGESTED_PLAN);
  h.logCompleted('Bench Press', { lift_code: 'BEN01' });
  h.logCompleted('Seated Row', { lift_code: 'ROW01' });
  h.logCompleted('Weighted dips', { lift_code: 'DIP01', canonical_exercise: 'Dips (Weighted)' });
  const remaining = h.remainingPlannedExercises(); // the plannedQueue sent to the engine
  const analysis = analyzeSetSequence([[50, 11, 0], [50, 10, 1], [50, 10, 0]], { exerciseName: 'Weighted Dip' });
  assert.equal(analysis.signals.pressing_readiness_yellow, true); // pressing went yellow
  const line = rerouteNote(assessNextMoveConflict(analysis, remaining));
  // Next planned is Lat Pulldown (a pull) → no same-prime-mover conflict, and in no
  // case may a reroute point back at the lift that was just logged.
  assert.ok(!line || !line.includes('Weighted Dip'), 'reroute must never defer the completed lift');
});

// 5 — after Lat Pulldown (logged as "Lat pull"), next remaining is Incline DB Press.
test('post-log identity: after Lat Pulldown the next remaining is Incline DB Press', () => {
  const h = loadIdentityHarness();
  h.setIntentData(SUGGESTED_PLAN);
  for (const [raw, enr] of [
    ['Bench Press', { lift_code: 'BEN01' }],
    ['Seated Row', { lift_code: 'ROW01' }],
    ['Weighted dips', { lift_code: 'DIP01' }],
    ['Lat pull', {}], // shorthand, no code → resolved by alias
  ]) h.logCompleted(raw, enr);
  const remaining = h.remainingPlannedExercises();
  assert.equal(remaining[0], 'Incline DB Press');
  assert.deepEqual(remaining, ['Incline DB Press', 'Face Pull']);
});

// 4 — the confirmation/next-prescription card resolves for shorthand-logged lifts.
test('post-log identity: liftCodeForExercise resolves shorthand via alias fallback', () => {
  const resolve = loadLiftCodeResolver([
    { value: 'Lat Pulldown', label: 'LAT01' },
    { value: 'Bench Press', label: 'BEN01' },
  ]);
  assert.equal(resolve('Bench Press'), 'BEN01');  // exact
  assert.equal(resolve('Lat pull'), 'LAT01');      // alias/contains fallback
  assert.equal(resolve('Nonexistent Lift'), null); // no false match
});

// 6 / 8 — source: handoff, composer, and reroute queue use one shared remaining
// source; the post-log identity path touches no write path.
test('post-log identity: emitSetLogged derives nextPlanned + plannedQueue from one source; no write path', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const block = src.slice(src.indexOf('function emitSetLogged('), src.indexOf('// The session lives in the buffer'));
  assert.match(block, /const remaining = remainingPlannedExercises\(\);/);
  assert.match(block, /const nextPlanned = remaining\[0\] \|\| null;/);
  assert.match(block, /const plannedQueue = remaining;/);
  // Read-only narration — emitSetLogged must not touch any write path.
  assert.doesNotMatch(block, /\/api\/log-workout|\/api\/complete-workout|appendRows/);
});

// --- INTEGRATION: drive the real emitSetLogged → atlas:set-logged event --------
// This is the path the #480 helper-only tests missed: in the live coach-suggestion
// flow the logged row is the catalog canonical ("Dips (Weighted)") and completion
// must be bridged to the planned lift ("Weighted Dip") by the enrichment lift_code.
function loadEmitHarness(catalogOptions) {
  const src = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const slice = src.slice(
    src.indexOf('function plannedExerciseEntries()'),
    src.indexOf('async function fetchReaction(')
  );
  assert.ok(slice, 'emitSetLogged + identity helpers must be found');
  const events = [];
  const fakeDoc = {
    dispatchEvent: e => { events.push(e); return true; },
    // The loaded exercise catalog datalist (value = canonical_name, label = code).
    getElementById: id => (id === 'exercise-catalog' && catalogOptions) ? { options: catalogOptions } : null,
  };
  function FakeCustomEvent(type, init) { return { type, detail: init && init.detail }; }
  // F10: emitSetLogged → remainingPlannedExercises → remainingSlotNames, and
  // resolveCompletedIdentity → variantSatisfies. Inject the real pure implementations.
  const { remainingSlotNames, variantSatisfies } = require('../src/app/planSlotStatuses.js');
  const factory = new Function(
    'document', 'CustomEvent', 'setsTableBody', 'parsedRowsEditor', 'invalidatePreview',
    'remainingSlotNames', 'variantSatisfies',
    `${STORE_SHIM}
     let lastIntentData = null;
     let lastParsedWorkoutText = '';
     let lastUnverifiedExercise = null;
     function applySessionSubstitution() {}
     ${slice}
     return {
       // setIntentData models the ENGAGED Coach's Pick flow (see loadIdentityHarness).
       setIntentData: d => { lastIntentData = d; coachSuggestionEngaged = !!d; },
       setEngaged: v => { coachSuggestionEngaged = !!v; },
       // setActiveSession models a STARTED/chat-created live session (e.g. an
       // applied PROPOSE_PLAN_EDIT — names only, no lift codes).
       setActiveSession: s => { activePlannedSession = s; },
       getCompleted: () => sessionCompleted.slice(),
       emitSetLogged,
     };`
  );
  const api = factory(fakeDoc, FakeCustomEvent, { innerHTML: '' }, { hidden: false }, () => {}, remainingSlotNames, variantSatisfies);
  return { api, events };
}

test('post-log live path: emitSetLogged with enrichment bridges "Dips (Weighted)" → "Weighted Dip"', () => {
  const { api, events } = loadEmitHarness();
  api.setIntentData(SUGGESTED_PLAN); // coach-suggested flow (no Start Session)
  // Log Bench, Seated Row, then the dip logged as its catalog canonical, each with
  // the enrichment row the new suggestion-flow fetch now provides (lift_code).
  api.emitSetLogged([{ exercise: 'Bench Press', weight: 230, reps: 5, rir: 2 }], '', [],
    [{ exercise: 'Bench Press', canonical_exercise: 'Bench Press', lift_code: 'BEN01' }]);
  api.emitSetLogged([{ exercise: 'Seated Row', weight: 180, reps: 8, rir: 4 }], '', [],
    [{ exercise: 'Seated Row', canonical_exercise: 'Seated Row', lift_code: 'ROW01' }]);
  api.emitSetLogged(
    [{ exercise: 'Dips (Weighted)', weight: 50, reps: 11, rir: 0 }], '', [],
    [{ exercise: 'Dips (Weighted)', canonical_exercise: 'Dips (Weighted)', lift_code: 'DIP01' }]
  );
  // The completed dip is recognized as the planned lift, so it leaves the queue.
  assert.ok(api.getCompleted().includes('Weighted Dip'), 'completion resolves to the planned name');
  const detail = events[events.length - 1].detail;
  assert.ok(!detail.plannedQueue.includes('Weighted Dip'), 'plannedQueue must drop the completed dip');
  assert.equal(detail.nextPlanned, 'Lat Pulldown', 'composer/handoff advance to Lat Pulldown');
});

test('post-log live path: the catalog datalist bridges the alias with NO enrichment / network call', () => {
  // The live fix: lift_code comes from the loaded catalog datalist (canonical_name →
  // code), so the dip resolves WITHOUT the per-set /api/log-workout preview call that
  // broke the mid-session no-write guardrail (E2E previewRequests must stay 0).
  const catalog = [{ value: 'Dips (Weighted)', label: 'DIP01' }];
  const { api, events } = loadEmitHarness(catalog);
  api.setIntentData(SUGGESTED_PLAN);
  api.emitSetLogged([{ exercise: 'Bench Press', weight: 230, reps: 5, rir: 2 }], '', [],
    [{ exercise: 'Bench Press', lift_code: 'BEN01' }]);
  api.emitSetLogged([{ exercise: 'Seated Row', weight: 180, reps: 8, rir: 4 }], '', [],
    [{ exercise: 'Seated Row', lift_code: 'ROW01' }]);
  api.emitSetLogged([{ exercise: 'Dips (Weighted)', weight: 50, reps: 11, rir: 0 }], '', [], null);
  assert.ok(api.getCompleted().includes('Weighted Dip'), 'datalist code bridges canonical → planned name');
  const detail = events[events.length - 1].detail;
  assert.ok(!detail.plannedQueue.includes('Weighted Dip'));
  assert.equal(detail.nextPlanned, 'Lat Pulldown');
});

test('post-log live path: with NO code bridge at all (no enrichment, no catalog) the alias cannot resolve', () => {
  const { api, events } = loadEmitHarness(null);
  api.setIntentData(SUGGESTED_PLAN);
  api.emitSetLogged([{ exercise: 'Bench Press', weight: 230, reps: 5, rir: 2 }], '', [],
    [{ exercise: 'Bench Press', lift_code: 'BEN01' }]);
  api.emitSetLogged([{ exercise: 'Seated Row', weight: 180, reps: 8, rir: 4 }], '', [],
    [{ exercise: 'Seated Row', lift_code: 'ROW01' }]);
  api.emitSetLogged([{ exercise: 'Dips (Weighted)', weight: 50, reps: 11, rir: 0 }], '', [], null);
  const detail = events[events.length - 1].detail;
  assert.ok(detail.plannedQueue.includes('Weighted Dip'),
    'no code bridge → the canonical alias does not resolve (documents why the datalist/enrichment bridge is needed)');
});

// --- Owner live repro (2026-07-03, 11:23): "Rdl 240 8/3 ×3" against a CHAT-created
// plan (applied PROPOSE_PLAN_EDIT: names only, NO lift codes) said "next up:
// Romanian Deadlift" and kept the composer on it. Three stacked gaps: chat plans
// carry no codes, the datalist had no variants ("RDL"), and enrichment is
// best-effort (null on a slow dry-run). The fix bridges codes TWO-SIDED via the
// variant-aware datalist and adds a word-subset tier.

const CHAT_PLAN_SESSION = {
  label: 'Coach plan',
  intentId: null,
  index: 0,
  exercises: [
    { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: '', weight: 230, reps: 8, sets: 3, rir: 2 },
    { name: 'Back Squat', canonicalName: 'Back Squat', liftCode: '', weight: 225, reps: 8, sets: 3, rir: 2 },
    { name: 'Single-Leg Seated Leg Press', canonicalName: 'Single-Leg Seated Leg Press', liftCode: '', weight: 70, reps: 12, sets: 3, rir: 1 },
  ],
};
const VARIANT_CATALOG = [
  { value: 'Romanian Deadlift', label: 'RDL01' },
  { value: 'RDL', label: 'RDL01' },              // catalog variant, now in the datalist
  { value: 'RDLs', label: 'RDL01' },
  { value: 'Back Squat', label: 'SQ01' },
  { value: 'Squat', label: 'SQ01' },
];

test('owner repro: an alias log against a chat-created plan (no lift codes) advances the plan', () => {
  const { api, events } = loadEmitHarness(VARIANT_CATALOG);
  api.setActiveSession(JSON.parse(JSON.stringify(CHAT_PLAN_SESSION)));
  // No enrichment at all — the best-effort dry-run never returned (gym network).
  api.emitSetLogged([{ exercise: 'RDL', weight: 240, reps: 8, rir: 3 }], '', [], null);
  assert.ok(api.getCompleted().includes('Romanian Deadlift'),
    '"RDL" resolves to the planned "Romanian Deadlift" via the two-sided datalist code bridge');
  const detail = events[events.length - 1].detail;
  assert.equal(detail.nextPlanned, 'Back Squat', 'handoff/composer advance past the logged lift');
  assert.ok(!detail.plannedQueue.includes('Romanian Deadlift'), 'the done lift leaves the queue');
});

test('owner repro: the word-subset tier bridges multi-word aliases with no codes anywhere', () => {
  const h = loadIdentityHarness();
  h.setActiveSession(JSON.parse(JSON.stringify(CHAT_PLAN_SESSION)));
  assert.equal(h.resolveCompletedIdentity('single leg press', undefined), 'Single-Leg Seated Leg Press',
    'every-word-present (2+ words) reaches the hyphenated, longer plan name');
  assert.equal(h.resolveCompletedIdentity('seated curl', undefined), 'seated curl',
    'a phrase with a word NOT in any slot never matches (subset tier stays strict)');
  // (Single generic words like "leg" keep the PRE-EXISTING substring-tier
  // behavior — unchanged by this fix.)
});

test('post-log live path: a coach-suggested plan registers COMPLETE after the last lift (no resurrected next-up)', () => {
  // The live "wanted weighted dips again" bug: in the coach-suggestion flow
  // (activePlannedSession === null) planIsComplete was always false, so after the
  // last lift the closeout never fired and the handoff resurrected a done lift.
  const { api, events } = loadEmitHarness();
  api.setIntentData(SUGGESTED_PLAN);
  const logs = [
    ['Bench Press', 'BEN01'], ['Seated Row', 'ROW01'],
    ['Dips (Weighted)', 'DIP01'], ['Lat Pulldown', 'LAT01'],
    ['Incline DB Press', 'INC01'], ['Face Pull', 'FAC01'],
  ];
  for (const [name, code] of logs) {
    api.emitSetLogged([{ exercise: name, weight: 50, reps: 8, rir: 2 }], '', [], [{ exercise: name, lift_code: code }]);
  }
  // After the last lift: complete, nothing left, no resurrected next-up.
  const last = events[events.length - 1].detail;
  assert.equal(last.planIsComplete, true, 'suggestion-flow plan must register complete after the last lift');
  assert.equal(last.nextPlanned, null, 'no next-up may be resurrected at session end');
  // The engaged plan order is threaded so the handoff can reject an off-plan fallback
  // next-up (the live "next up: Hammer Curls" that wasn't part of today's plan).
  assert.ok(Array.isArray(last.plannedOrder) && last.plannedOrder.length > 0,
    'emitSetLogged threads the engaged plan order for the off-plan handoff guard');
  // Mid-session it must NOT prematurely flag complete, and next-up advances normally.
  const afterFirst = events[0].detail;
  assert.equal(afterFirst.planIsComplete, false);
  assert.equal(afterFirst.nextPlanned, 'Seated Row');
});

// --- Class B: shorthand-named lift re-parses against the pending planned lift ---
function loadReplanHelper(planned, parseStub) {
  const src = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const fnSrc = src.slice(
    src.indexOf('async function rowsFromUnresolvedPlannedLead'),
    src.indexOf('async function rowsFromWorkoutInput')
  );
  assert.ok(fnSrc, 'rowsFromUnresolvedPlannedLead must be found');
  return new Function('firstUnloggedPlannedLift', 'parseWorkoutTextWithBackend',
    `${fnSrc}; return rowsFromUnresolvedPlannedLead;`)(() => planned, parseStub);
}

test('post-log live path: "Lat pull"/"Incline" re-parse with the planned lift name substituted', async () => {
  for (const [planned, input, expectText] of [
    ['Lat Pulldown', 'Lat pull 175 8/2 8/2 8/2', 'Lat Pulldown 175 8/2 8/2 8/2'],
    ['Incline DB Press', 'Incline 70 8/5 8/5 8/4', 'Incline DB Press 70 8/5 8/5 8/4'],
  ]) {
    let seen = null;
    const stub = async (text) => { seen = text; return { intent: 'log_sets', rows: [{ exercise: planned }] }; };
    const fn = loadReplanHelper(planned, stub);
    const rows = await fn(input);
    assert.equal(seen, expectText, 'lead is replaced with the planned lift name, sets preserved');
    assert.ok(rows && rows.length, 'rows are produced');
  }
});

test('post-log live path: re-parse never mis-attaches an unrelated lift / no-plan / no-sets', async () => {
  let called = false;
  const stub = async () => { called = true; return { intent: 'log_sets', rows: [{}] }; };
  // Unrelated lead → no match → no re-parse.
  assert.equal(await loadReplanHelper('Lat Pulldown', stub)('Zercher Squat 95 8/2'), null);
  // No set tokens → null.
  assert.equal(await loadReplanHelper('Lat Pulldown', stub)('Lat pull'), null);
  // No pending plan → null.
  assert.equal(await loadReplanHelper(null, stub)('Lat pull 175 8/2'), null);
  assert.equal(called, false, 'the parser is never called for a non-matching / unattachable input');
});
