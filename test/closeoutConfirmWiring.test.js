'use strict';

// F10D slice 2 — the client confirmation surface + approval-scoped verification.
// One approval governs the complete closeout: the compiled session save carries
// closeout_context on BOTH the dry-run and the approved write; the in-thread
// review card renders the server's single-confirmation summary; the approve
// handler reports an unverified seal honestly and records the finalized closeout
// event ONLY on approval (rejection writes nothing). Slices the REAL built
// bundle; structural pins guard the wiring, behavioral cases drive the renderer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const coachSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');

// ── closeoutContextItems — behavioral (real selector, real slice) ───────────────

function loadContextHarness() {
  const slicePEE = appSrc.slice(
    appSrc.indexOf('function plannedExerciseEntries()'),
    appSrc.indexOf('function isPlanCloseoutAwaitingSave()')
  );
  const sliceCtx = appSrc.slice(
    appSrc.indexOf('function closeoutContextItems()'),
    appSrc.indexOf('function emitCoachPreview(')
  );
  assert.ok(sliceCtx.includes('function closeoutContextItems()'), 'slice must contain closeoutContextItems');
  const { planSlotStatuses, remainingSlotNames, firstUnloggedSlot, variantSatisfies } = require('../src/app/planSlotStatuses.js');
  const factory = new Function(
    'planSlotStatuses', 'remainingSlotNames', 'firstUnloggedSlot', 'variantSatisfies',
    `${STORE_SHIM}
     let lastIntentData = null;
     ${slicePEE}
     ${sliceCtx}
     return {
       setActiveSession: s => { activePlannedSession = s; },
       setLog: rows => { sessionLog = rows.slice(); },
       setCompleted: arr => { sessionCompleted = arr.slice(); },
       closeoutContextItems,
     };`
  );
  return factory(planSlotStatuses, remainingSlotNames, firstUnloggedSlot, variantSatisfies);
}

const row = (exercise, canonical) => ({ exercise, canonical: canonical || exercise, weight: 100, reps: 5, rir: 2 });

test('F10D ctx: substituted slot sends performed_lift_code and leaves planned_lift_code to the ledger', () => {
  const h = loadContextHarness();
  h.setActiveSession({ accepted: true, session_id: 'S1', index: 0, exercises: [
    { name: 'Front Squat', canonicalName: 'Front Squat', liftCode: 'FSQ01', plan_item_id: 'pi_bsq', sets: 3, reason: 'substituted' },
    { name: 'Overhead Press', canonicalName: 'Overhead Press', liftCode: 'OHP01', plan_item_id: 'pi_ohp', sets: 3 },
  ] });
  h.setLog([row('Front Squat'), row('Front Squat'), row('Front Squat')]);
  h.setCompleted(['Front Squat']);
  const items = h.closeoutContextItems();
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    plan_item_id: 'pi_bsq', planned_lift_code: '', performed_lift_code: 'FSQ01',
    name: 'Front Squat', outcome: 'substituted',
  });
  assert.equal(items[1].outcome, 'skipped', 'zero performed sets at closeout labels skipped');
  assert.equal(items[1].planned_lift_code, 'OHP01');
  assert.equal('performed_lift_code' in items[1], false);
});

test('F10D ctx: completed / in-progress labeling — full slot completed, partial slot sends NO outcome', () => {
  const h = loadContextHarness();
  h.setActiveSession({ accepted: true, session_id: 'S1', index: 0, exercises: [
    { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01', plan_item_id: 'pi_rdl', sets: 3 },
    { name: 'Back Squat', canonicalName: 'Back Squat', liftCode: 'SQ01', plan_item_id: 'pi_bsq', sets: 3 },
  ] });
  h.setLog([row('Romanian Deadlift'), row('Romanian Deadlift'), row('Romanian Deadlift'), row('Back Squat')]);
  h.setCompleted(['Romanian Deadlift', 'Back Squat']);
  const items = h.closeoutContextItems();
  assert.equal(items[0].outcome, 'completed', '3 of 3 → completed');
  assert.equal('outcome' in items[1], false, '1 of 3 is in progress — no outcome label; the per-set flags carry the truth');
});

test('F10D ctx: no active session (freestyle) → empty items; slots without plan_item_id are excluded', () => {
  const h = loadContextHarness();
  h.setActiveSession(null);
  assert.deepEqual(h.closeoutContextItems(), []);
  h.setActiveSession({ accepted: true, session_id: 'S1', index: 0, exercises: [
    { name: 'Cable Row', canonicalName: 'Cable Row', liftCode: 'CR01', sets: 3 }, // engaged pick, no id
  ] });
  h.setLog([]); h.setCompleted([]);
  assert.deepEqual(h.closeoutContextItems(), [], 'an unaccepted slot has no ledger identity to label');
});

// ── payload + event wiring — structural pins on the built bundle ────────────────

test('F10D wiring: the compiled closeout attaches closeout_context to the ONE payload (dry-run + approved write)', () => {
  assert.match(appSrc, /const isSessionCloseout = sessionCompiledAwaitingPreview === true;\s*\n\s*sessionCompiledAwaitingPreview = false;/,
    'the closeout marker is captured before the one-shot flag resets');
  assert.match(appSrc, /if \(isSessionCloseout\) payload\.closeout_context = \{ items: closeoutContextItems\(\) \};/,
    'the context rides the payload — the same object the approve handler re-sends live');
  assert.match(appSrc, /pendingWrite = \{ mode: 'manual', payload, sessionCloseout: isSessionCloseout,/,
    'the staged write remembers it is a session closeout');
});

test('F10D wiring: the dry-run summary travels to the review card through atlas:preview-ready', () => {
  assert.match(appSrc, /closeoutSummary: closeoutSummary \|\| null/, 'emitCoachPreview forwards the summary in the event detail');
  assert.match(appSrc, /data\.closeout_summary \|\| null\);/, 'renderLogWorkoutPreview passes the server summary through');
  assert.match(coachSrc, /closeoutSummary = null \} = detail \|\| \{\};/, 'handlePreviewReady destructures it');
  assert.match(coachSrc, /if \(closeoutSummary\) bubble\.appendChild\(buildCloseoutConfirm\(closeoutSummary\)\);\s*\n\s*bubble\.appendChild\(buildReviewCard\(/,
    'the confirmation renders ABOVE the sets card in the one review bubble');
});

test('F10D wiring: approval-scoped finalization — the finish button no longer emits; the approve handler does', () => {
  const finishLine = appSrc.slice(appSrc.indexOf("getElementById('finish-session-btn')"), appSrc.indexOf("getElementById('finish-session-btn')") + 200);
  assert.doesNotMatch(finishLine, /emitPlanCloseout/, 'tapping Finish only OPENS the confirmation — rejection writes nothing');
  assert.match(appSrc, /if \(wasSessionCloseout\) emitPlanCloseout\('finalized'\);/,
    'the finalized closeout event records on the APPROVED write only');
  const approveIdx = appSrc.indexOf("getElementById('approve-btn').addEventListener");
  const emitIdx = appSrc.indexOf("if (wasSessionCloseout) emitPlanCloseout('finalized');");
  assert.ok(emitIdx > approveIdx, 'the emission lives inside the approve handler');
});

test('F10D wiring: an unverified seal is reported honestly, never as a clean success', () => {
  assert.match(appSrc, /writeData\.closeout_fully_verified === false/, 'the approve handler reads the seal verdict');
  assert.match(appSrc, /plan-ledger seal could not be verified\. Your sets are safe; tap Save again to retry the seal \(no rows will duplicate\)\./,
    'the honest partial copy exists');
  const warnIdx = appSrc.indexOf('plan-ledger seal could not be verified');
  const okIdx = appSrc.indexOf("'Workout written to Google Sheets. ✓'");
  assert.ok(warnIdx > -1 && okIdx > -1 && warnIdx < okIdx, 'the seal-unverified branch is checked before the clean success copy');
});

// ── buildCloseoutConfirm — behavioral render (fake DOM) ─────────────────────────

function loadConfirmHarness() {
  const slice = coachSrc.slice(
    coachSrc.indexOf('function buildCloseoutConfirm('),
    coachSrc.indexOf('async function handlePreviewReady(')
  );
  assert.ok(slice.includes('function buildCloseoutConfirm('), 'slice must contain buildCloseoutConfirm');
  const makeNode = () => ({
    className: '', textContent: '', children: [],
    appendChild(c) { this.children.push(c); return c; },
  });
  const fakeDoc = { createElement: () => makeNode() };
  const factory = new Function('document', `${slice}; return buildCloseoutConfirm;`);
  return factory(fakeDoc);
}

const SUMMARY = {
  session_id: 'S1', session_date: '2026-07-18', has_stored_plan: true, malformed: false,
  items: [{
    plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', performed_lift_code: null, name: 'Weighted Dip',
    outcome: 'completed', source: 'accepted', revised: true, no_reliable_target: false, malformed: false,
    diagnostics_sets: [],
    original_sets: [{ set_index: 1, target_weight: 65, target_reps: 5, target_rir: 2 }],
    effective_sets: [{ set_index: 1, target_weight: 65, target_reps: 5, target_rir: 2, plan_version: 1 }],
    target_vs_actual: [
      { set_index: 1, target_weight: 65, target_reps: 5, target_rir: 2, actual_weight: 60, actual_reps: 5, actual_rir: 2, weight_delta: -5 },
      { set_index: 2, target_weight: 60, target_reps: 5, target_rir: 2, unperformed: true, actual_weight: null, actual_reps: null, actual_rir: null },
    ],
  }],
  unplanned: [{ lift_code: 'CURL01', name: 'Hammer Curl', sets: [{ set_number: 1, weight: 30, reps: 12, rir: 2 }] }],
  no_reliable_target_items: [],
  rows_to_write: { log: [['r1'], ['r2']], effort: ['e'] },
  rows_to_seal: { count: 5, already_sealed: 0 },
};

function allText(node) {
  return [node.textContent, ...(node.children || []).map(allText)].join('\n');
}

test('F10D confirm card: both truths, per-set target→actual facts, unplanned work, and the exact write/seal counts', () => {
  const build = loadConfirmHarness();
  const card = build(SUMMARY);
  const text = allText(card);
  assert.match(text, /Session review — 2026-07-18/);
  assert.match(text, /Weighted Dip \(revised mid-session\)/, 'a revised item is labeled');
  assert.match(text, /65×5@2 → did 60×5@2/, 'set 1: its OWN effective target vs the actual — facts only');
  assert.match(text, /60×5@2 → not performed/, 'an unperformed set says so — nothing invented');
  assert.match(text, /Hammer Curl \(unplanned\): 30×12@2/, 'unplanned work is shown with no target');
  assert.match(text, /Approving writes 2 set row\(s\) \+ your effort row; 5 plan-ledger row\(s\) will be sealed to this save\. Rejecting writes nothing\./);
});

test('F10D confirm card: warnings surface plainly (unreadable ledger / inconsistent history); substitution is tagged', () => {
  const build = loadConfirmHarness();
  const warned = build({
    ...SUMMARY, ledger_read_failed: true, malformed: true,
    items: [{
      ...SUMMARY.items[0], outcome: 'substituted', performed_lift_code: 'FSQ01', revised: false,
    }],
  });
  const text = allText(warned);
  assert.match(text, /plan ledger couldn't be read/, 'the read-failure warning shows');
  assert.match(text, /plan history for this session is inconsistent/i, 'the malformed warning shows');
  assert.match(text, /\(substituted — performed FSQ01\)/, 'the substitution is labeled with the performed lift');
});

test('F10D confirm card: a freestyle summary (no stored plan) still confirms the write, with no seal claim', () => {
  const build = loadConfirmHarness();
  const card = build({
    session_id: 'S1', session_date: '2026-07-18', has_stored_plan: false, malformed: false,
    items: [], unplanned: [{ lift_code: 'BEN01', name: 'Bench Press', sets: [{ set_number: 1, weight: 225, reps: 5, rir: 2 }] }],
    no_reliable_target_items: [], rows_to_write: { log: [['r1']], effort: null }, rows_to_seal: { count: 0, already_sealed: 0 },
  });
  const text = allText(card);
  assert.match(text, /Bench Press \(unplanned\): 225×5@2/);
  assert.match(text, /Approving writes 1 set row\(s\)\. Rejecting writes nothing\./, 'no effort bit, no seal bit');
});
