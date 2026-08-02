'use strict';

// P0 (#1123) — Closeout preview must never replay buffered sets back into sessionLog.
//
// Production incident (session 20260721-PM-01, build 7bad200): a Back Squat block of
// FIVE buffered sets became TEN pending sets and was written to permanent history
// twice. Cause: after the first closeout dry-run, the single-use
// `sessionCompiledAwaitingPreview` flag reset while the buffered rows stayed in the
// editor; a later plain preview-btn submit then satisfied the ordinary mid-workout log
// branch and called emitSetLogged again, appending the same five rows back into
// sessionLog (5 → 10).
//
// This drives the REAL emitSetLogged (sliced from the built bundle) and the REAL
// mid-workout branch CONDITION (extracted verbatim from the built bundle), so the
// 5→10 reproduction and its fix are proven against shipped code, not a re-implementation.
// The latch/reset wiring is additionally pinned by source-introspection below.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

class FakeCustomEvent {
  constructor(type, init) { this.type = type; this.detail = (init && init.detail) || {}; }
}

// ── Real emitSetLogged, sliced from the built bundle (the append point) ──────────
function buildEmitHarness() {
  const slice = appSrc.slice(
    appSrc.indexOf('function emitSetLogged('),
    appSrc.indexOf('async function fetchReaction(')
  );
  assert.ok(slice.includes('getSessionLog().push('), 'slice must contain the real sessionLog append');

  const events = [];
  const fakeDoc = { dispatchEvent: (e) => { events.push(e); return true; } };

  const factory = new Function('document', 'CustomEvent', `
    ${STORE_SHIM}
    let lastParsedWorkoutText = '';
    let lastUnverifiedExercise = null;
    let setsTableBody = { innerHTML: '', children: [] };
    let parsedRowsEditor = { hidden: false };
    function resolveCompletedIdentity(name){ return name; }
    function applySessionSubstitution(){}
    function bindLoggedSubstituteToProposal(){ return false; }   // F-SB3 — no proposal in these fixtures
    function emitImplicitRecommendation(){}
    function isOffPlanLoggedExercise(){ return false; }
    function remainingPlannedExercises(){ return []; }
    function plannedExerciseOrder(){ return []; }
    function reconcileSessionLogFromTable(){}
    function renderSessionPin(){}
    function invalidatePreview(){}
    ${slice}
    return {
      setSessionLog: (v) => setSessionLog(v.map(r => Object.assign({}, r))),
      getSessionLog: () => getSessionLog(),
      emitSetLogged,
    };
  `);
  const api = factory(fakeDoc, FakeCustomEvent);
  return {
    setSessionLog: api.setSessionLog,
    sessionLogLength: () => api.getSessionLog().length,
    emitSetLogged: api.emitSetLogged,
    setLoggedEvents: () => events.filter(e => e.type === 'atlas:set-logged'),
  };
}

// ── Real mid-workout branch CONDITION, extracted verbatim ────────────────────────
function extractMidWorkoutCondition(src) {
  const marker = 'if (logRows.length && !file && !manualEffort';
  const start = src.indexOf(marker);
  assert.ok(start !== -1, 'the mid-workout branch must exist');
  const brace = src.indexOf(') {', start);
  return src.slice(start + 'if ('.length, brace); // the boolean expression, no wrapping parens
}
const CONDITION = extractMidWorkoutCondition(appSrc);
const midWorkoutFires = new Function(
  'logRows', 'file', 'manualEffort', 'sessionCompiledAwaitingPreview', 'screenshotConvertedCloseout', 'isCloseoutRePreview',
  `return (${CONDITION});`);

// A faithful submit-decision driver over the REAL mid-workout condition. `newParse`
// models whether this submit introduced new workout input (a real parse advances
// lastParsedWorkoutText); the app derives `isCloseoutRePreview = closeoutPreviewStaged &&
// !newParse` — so a plain re-preview (no new parse) is blocked from the append lane while
// a genuinely new set still logs. When the condition fires it calls the REAL emitSetLogged
// (the append); otherwise it takes the closeout path and latches the stage (mirroring
// `if (isSessionCloseout) closeoutPreviewStaged = true;`, pinned below). `fires` is
// injected so the same driver can run the shipped (guarded) condition OR the pre-fix one.
function runSubmit(h, tableRows, state, opts = {}) {
  const newParse = opts.newParse === true;
  const fires = opts.fires || midWorkoutFires;
  const isCloseoutRePreview = state.closeoutPreviewStaged && !newParse;
  if (fires(tableRows, state.file, state.manualEffort, state.sessionCompiledAwaitingPreview, state.screenshotConvertedCloseout, isCloseoutRePreview)) {
    h.emitSetLogged(tableRows, '', [], null);
    return 'mid-workout-append';
  }
  const isSessionCloseout = state.sessionCompiledAwaitingPreview === true
    || state.closeoutPreviewStaged === true
    || (tableRows.length > 0 && Boolean(state.manualEffort))
    || state.screenshotConvertedCloseout;
  state.sessionCompiledAwaitingPreview = false;
  if (isSessionCloseout) state.closeoutPreviewStaged = true;
  return 'closeout-preview';
}

const SQUAT_BLOCK = () => [
  { exercise: 'Back Squat', weight: 135, reps: 10, rir: 5 },
  { exercise: 'Back Squat', weight: 185, reps: 10, rir: 2 },
  { exercise: 'Back Squat', weight: 225, reps: 6, rir: 2 },
  { exercise: 'Back Squat', weight: 225, reps: 6, rir: 2 },
  { exercise: 'Back Squat', weight: 225, reps: 6, rir: 2 },
];
const freshState = (over = {}) => Object.assign(
  { sessionCompiledAwaitingPreview: false, closeoutPreviewStaged: false, file: null, manualEffort: null, screenshotConvertedCloseout: false },
  over);

// ── FAILING-FIRST reproduction: the exact production 5 → 10 without the guard ─────

test('REPRO (#1123): without the closeout-stage guard, a re-preview replays the 5 squat sets into sessionLog (5 → 10)', () => {
  // The pre-fix condition is the shipped one with the new guard token removed — proving
  // it is precisely `!isCloseoutRePreview` that stops the replay.
  const preFixCondition = CONDITION.replace(/\s*&&\s*!isCloseoutRePreview/, '');
  assert.notEqual(preFixCondition, CONDITION, 'the shipped condition must carry the !isCloseoutRePreview guard');
  const preFixFires = new Function(
    'logRows', 'file', 'manualEffort', 'sessionCompiledAwaitingPreview', 'screenshotConvertedCloseout', 'isCloseoutRePreview',
    `return (${preFixCondition});`);

  const h = buildEmitHarness();
  h.setSessionLog(SQUAT_BLOCK());
  const tableRows = SQUAT_BLOCK();          // the editor still holds the buffered rows
  const state = freshState({ sessionCompiledAwaitingPreview: true });

  // 1. Finish session: the compiled flag routes to closeout — no append.
  assert.equal(runSubmit(h, tableRows, state, { fires: preFixFires }), 'closeout-preview');
  assert.equal(h.sessionLogLength(), 5);

  // 2. Re-preview (preview-btn) with the buffered rows still staged. WITHOUT the guard,
  //    the ordinary mid-workout branch fires and re-appends the block.
  assert.equal(runSubmit(h, tableRows, state, { fires: preFixFires }), 'mid-workout-append');
  assert.equal(h.sessionLogLength(), 10, 'the production defect: the squat block is written into sessionLog twice');
  assert.equal(h.setLoggedEvents().length, 1, 'and a DUPLICATE coach block event was emitted');
});

// ── FIXED behavior: the shipped guard keeps the buffer at five ───────────────────

test('#1123 FIX: a closeout re-preview never appends the staged rows back into sessionLog (stays 5)', () => {
  const h = buildEmitHarness();
  h.setSessionLog(SQUAT_BLOCK());
  const tableRows = SQUAT_BLOCK();
  const state = freshState({ sessionCompiledAwaitingPreview: true });

  // 1. Finish session → closeout dry-run staged; latch set.
  assert.equal(runSubmit(h, tableRows, state), 'closeout-preview');
  assert.equal(h.sessionLogLength(), 5);
  assert.equal(state.closeoutPreviewStaged, true, 'the closeout stage is latched');

  // 2. Re-preview → treated as a closeout re-preview, NOT a mid-workout log.
  assert.equal(runSubmit(h, tableRows, state), 'closeout-preview');
  assert.equal(h.sessionLogLength(), 5, 'sessionLog remains 5 after re-preview');

  // Repeated re-previews stay protected.
  for (let i = 0; i < 5; i++) runSubmit(h, tableRows, state);
  assert.equal(h.sessionLogLength(), 5, 'repeated re-preview never grows the buffer');
  assert.equal(h.setLoggedEvents().length, 0, 'no duplicate coach block event is emitted during closeout');
});

// ── Codex #1125: "log one more set after Finish" must APPEND, never lose the buffer ──

test('#1125 (Codex P1): a NEW set typed after a staged closeout appends to the buffer (never staged as a one-row closeout that drops history)', () => {
  const h = buildEmitHarness();
  h.setSessionLog(SQUAT_BLOCK());
  const state = freshState({ sessionCompiledAwaitingPreview: true });
  // 1. Finish → closeout staged (latched).
  assert.equal(runSubmit(h, SQUAT_BLOCK(), state), 'closeout-preview');
  assert.equal(h.sessionLogLength(), 5);
  // 2. Athlete types ONE MORE set. This submit parses NEW input (newParse), so it is NOT a
  //    re-preview — it must log through the ordinary append lane, growing the buffer to 6.
  //    (Before this refinement it was routed to a one-row closeout, dropping the 5 on save.)
  const oneMore = [{ exercise: 'Back Squat', weight: 225, reps: 6, rir: 1 }];
  assert.equal(runSubmit(h, oneMore, state, { newParse: true }), 'mid-workout-append');
  assert.equal(h.sessionLogLength(), 6, 'the five buffered sets are preserved AND the new set is logged');
});

// ── Coverage across every closeout trigger + edit/delete/cancel/double-tap ────────

const TRIGGERS = [
  ['finish button / typed "log it" (compiled flag)', { sessionCompiledAwaitingPreview: true }],
  ['manual-effort closeout', { manualEffort: { duration: 42 } }],
  ['screenshot closeout', { screenshotConvertedCloseout: true }],
];

for (const [label, triggerOver] of TRIGGERS) {
  test(`#1123 FIX: re-preview after ${label} stays 5 (never appends)`, () => {
    const h = buildEmitHarness();
    h.setSessionLog(SQUAT_BLOCK());
    const tableRows = SQUAT_BLOCK();
    const state = freshState(triggerOver);

    assert.equal(runSubmit(h, tableRows, state), 'closeout-preview', 'the trigger stages the closeout');
    assert.equal(state.closeoutPreviewStaged, true);
    // A plain re-preview afterwards (trigger flags cleared) must stay a closeout.
    const rePreview = freshState({ closeoutPreviewStaged: true });
    assert.equal(runSubmit(h, tableRows, rePreview), 'closeout-preview');
    assert.equal(h.sessionLogLength(), 5, `${label}: buffer unchanged`);
  });
}

test('#1123 FIX: re-preview after EDITING a row replaces the staged preview, buffer stays 5', () => {
  const h = buildEmitHarness();
  h.setSessionLog(SQUAT_BLOCK());
  const state = freshState({ sessionCompiledAwaitingPreview: true });
  assert.equal(runSubmit(h, SQUAT_BLOCK(), state), 'closeout-preview');
  // Edit one row in the editor (fix a bad RIR), then re-preview from the EDITED table.
  const edited = SQUAT_BLOCK(); edited[0] = { ...edited[0], rir: 4 };
  assert.equal(runSubmit(h, edited, state), 'closeout-preview', 'the edited re-preview is still a closeout');
  assert.equal(h.sessionLogLength(), 5, 'edit → replacement, not append');
});

test('#1123 FIX: re-preview after DELETING a row stays a closeout, buffer never doubles', () => {
  const h = buildEmitHarness();
  h.setSessionLog(SQUAT_BLOCK());
  const state = freshState({ sessionCompiledAwaitingPreview: true });
  assert.equal(runSubmit(h, SQUAT_BLOCK(), state), 'closeout-preview');
  const afterDelete = SQUAT_BLOCK().slice(0, 4);   // athlete deleted a row in the editor
  assert.equal(runSubmit(h, afterDelete, state), 'closeout-preview');
  assert.equal(h.sessionLogLength(), 5, 'the buffer is preserved until an approved write (never appended)');
});

test('#1123 FIX: cancel/edit then re-preview, and a double-tap concurrent submit, never append', () => {
  const h = buildEmitHarness();
  h.setSessionLog(SQUAT_BLOCK());
  const state = freshState({ sessionCompiledAwaitingPreview: true });
  const rows = SQUAT_BLOCK();
  assert.equal(runSubmit(h, rows, state), 'closeout-preview');
  // Double-tap: two rapid submits after the stage is latched.
  assert.equal(runSubmit(h, rows, state), 'closeout-preview');
  assert.equal(runSubmit(h, rows, state), 'closeout-preview');
  assert.equal(h.sessionLogLength(), 5, 'concurrent/double submits never append');
});

// A genuine mid-workout set (BEFORE any closeout) must STILL log normally — the guard
// must not break the ordinary in-session logging lane.
test('#1123 regression: a normal mid-workout set (no closeout staged) still logs into sessionLog', () => {
  const h = buildEmitHarness();
  h.setSessionLog([]);                       // fresh session, nothing buffered yet
  const state = freshState();                // no closeout flags at all
  const newSet = [{ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2 }];
  assert.equal(runSubmit(h, newSet, state), 'mid-workout-append', 'ordinary logging is unaffected');
  assert.equal(h.sessionLogLength(), 1, 'the fresh set is buffered normally');
});

// ── Wiring pins (source-introspection) — the latch/reset plumbing can't regress ───

test('#1123 wiring: the closeout-stage latch and its reset are wired into the built bundle', () => {
  assert.match(appSrc, /let closeoutPreviewStaged = false;/, 'the latch flag is declared');
  assert.match(appSrc, /const parsedTextBeforeSubmit = lastParsedWorkoutText;/, 'the submit captures whether a new parse happened');
  assert.match(appSrc, /const isCloseoutRePreview = closeoutPreviewStaged && lastParsedWorkoutText === parsedTextBeforeSubmit;/,
    'a re-preview = staged AND no new parse (a new set still logs)');
  assert.match(appSrc, /&& !isCloseoutRePreview\)/, 'the mid-workout branch is guarded against a closeout re-preview only');
  assert.match(appSrc, /\|\|\s*closeoutPreviewStaged === true/, 'a re-preview stays a closeout via the latch');
  assert.match(appSrc, /if \(isSessionCloseout\) closeoutPreviewStaged = true;/, 'the stage latches when a closeout is detected');
  assert.match(appSrc, /addEventListener\('atlas:session-reset',\s*\(\)\s*=>\s*\{\s*closeoutPreviewStaged = false;\s*\}\)/,
    'the latch clears ONLY on a session reset (verified write / Start Over / discard)');
});

test('#1123 wiring: the finish button routes through the same handleLogIt closeout, and the dry-run stays test_mode', () => {
  assert.match(appSrc, /getElementById\('finish-session-btn'\)\?\.addEventListener\('click',\s*\(\)\s*=>\s*\{\s*handleLogIt\(\);\s*\}\)/,
    'the finish button click runs the same handleLogIt closeout as "log it"');
  // The closeout preview is a dry-run: test_mode with a write_id (idempotent retry).
  assert.match(appSrc, /log_rows: logRows, test_mode: 'true', write_id: generateWriteId\(\)/,
    'the closeout preview is a test_mode dry-run (no write), keyed by a write_id');
});
