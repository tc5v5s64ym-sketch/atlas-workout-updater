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
    // End BEFORE the acceptance-boundary helpers (they window-assign, which an
    // eval harness cannot execute) — this harness needs only the context builder.
    appSrc.indexOf('function displayedRecommendation()')
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

test('F10D wiring: EVERY end trigger attaches closeout_context to the ONE payload (dry-run + approved write)', () => {
  // Codex P1 (PR #1069): typed manual effort with buffered rows is the submit's
  // OTHER end-of-session trigger and must enter the confirmation/seal path too.
  assert.match(appSrc, /const isSessionCloseout = sessionCompiledAwaitingPreview === true[\s\S]*?\|\| closeoutPreviewStaged === true[\s\S]*?\|\| \(logRows\.length > 0 && Boolean\(manualEffort\)\)[\s\S]*?\|\| screenshotConvertedCloseout;/,
    'the closeout marker covers the compiled path, the re-preview latch (#1123), manual-effort-with-rows, AND the converted screenshot-with-rows lane');
  assert.match(appSrc, /payload\.closeout_context = \{\s*\n\s*plan_version: \(getActivePlannedSession\(\) && getActivePlannedSession\(\)\.accepted === true\s*\n\s*&& getActivePlannedSession\(\)\.plan_version\) \|\| '',\s*\n\s*items: closeoutContextItems\(\),\s*\n\s*\};/,
    'the context carries the accepted plan pv_ token so the SERVER records the finalized event with proof');
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

test('F10D wiring: approval-scoped finalization — no client-side finalized emission remains on the save path', () => {
  const finishLine = appSrc.slice(appSrc.indexOf("getElementById('finish-session-btn')"), appSrc.indexOf("getElementById('finish-session-btn')") + 200);
  assert.doesNotMatch(finishLine, /emitPlanCloseout/, 'tapping Finish only OPENS the confirmation — rejection writes nothing');
  // Codex P1 (PR #1069): the SERVER records the finalized event inside the one
  // approved write, with proof — the approve handler carries NO fire-and-forget
  // emission at all (only the non-save affordances keep their click-time emits).
  const approveBlock = appSrc.slice(
    appSrc.indexOf("getElementById('approve-btn').addEventListener"),
    appSrc.indexOf("getElementById('load-session-btn')")
  );
  assert.doesNotMatch(approveBlock, /emitPlanCloseout\('finalized'\)/,
    'the approved path never fire-and-forgets the finalized event');
});

test('F10D wiring: an unverified closeout keeps the retry REACHABLE and is never a clean success', () => {
  assert.match(appSrc, /writeData\.closeout_fully_verified === false/, 'the approve handler reads the verification verdict');
  assert.match(appSrc, /plan-ledger record could not be verified\. Your sets are safe; tap Save again to re-verify \(no rows will duplicate\)\./,
    'the honest partial copy exists');
  // Codex P2 (PR #1069): the staged write stays ALIVE — fresh write_id (a reused
  // id would replay the recorded failure), effort row dropped (never a duplicate-
  // session 409), Save re-enabled — and the early return SKIPS the teardown.
  const retryAnchor = "if (closeoutSealUnverified === 'retry') {";
  const retryBlock = appSrc.slice(appSrc.indexOf(retryAnchor), appSrc.indexOf(retryAnchor) + 900);
  assert.match(retryBlock, /pendingWrite\.payload\.write_id = generateWriteId\(\)/, 'the retry mints a fresh write_id');
  assert.match(retryBlock, /delete pendingWrite\.payload\.effort_row/, 'the already-written effort row never rides the retry');
  assert.match(retryBlock, /approveBtn\.disabled = false/, 'Save is re-enabled for the retry');
  assert.match(retryBlock, /return;/, 'the unverified path returns BEFORE the preview teardown');
  const retryIdx = appSrc.indexOf(retryAnchor);
  const teardownIdx = appSrc.indexOf('invalidatePreview();\n    setHistoryLoaded(false);');
  assert.ok(retryIdx > -1 && teardownIdx > -1 && retryIdx < teardownIdx, 'the retry staging precedes the teardown');
});

// F-SB1 (Stage B workout 1, 2026-08-01). `closeout_fully_verified:false` is not one
// outcome. A seal that SUCCEEDED with nothing to seal can never be cleared by tapping
// Save again, so it must not be offered as a retry — but it is still a negative verdict
// and must still be reported.
test('F-SB1 wiring: a no-ledger closeout is reported, is NOT offered a retry, and still tears the session down', () => {
  // The split is driven by the server's own envelope, and mirrors closeoutVerification():
  // a failed Session_Plans event independently disqualifies, so it cannot ride in behind
  // a clean seal and be silenced.
  const pred = appSrc.slice(appSrc.indexOf('function closeoutSealIsRetryable'),
    appSrc.indexOf('const CLOSEOUT_RETRY_MSG'));
  assert.match(pred, /seal\.no_ledger === true && seal\.sealed_ok === true && eventOk/,
    'only a SUCCEEDED seal with nothing to seal is non-retryable');
  assert.match(pred, /ev\.captured === true \|\| ev\.status === 'disabled' \|\| ev\.status === 'no_plan'/,
    'a failed closeout event stays retryable — it never rides in behind the seal envelope');
  assert.match(appSrc, /closeoutSealUnverified = closeoutSealIsRetryable\(writeData\) \? 'retry' : 'no_ledger'/,
    'the verdict is classified, never discarded');

  // The no-ledger case takes NO early return: the sets are committed and no second call
  // can bind rows that were never written, so holding the session open would only cost the
  // owner his next workout to a duplicate-session collision.
  const retryAnchor = "if (closeoutSealUnverified === 'retry') {";
  const retryBlock = appSrc.slice(appSrc.indexOf(retryAnchor), appSrc.indexOf(retryAnchor) + 900);
  assert.doesNotMatch(retryBlock, /no_ledger/, 'the no-ledger case never enters the retry staging block');

  // …but it is reported, as a persistent note under the completed save.
  assert.match(appSrc, /Plan tracking incomplete — this session had no plan-ledger rows to seal\. Your sets are saved; there is nothing to retry\./,
    'the non-retryable partial copy exists');
  const noticeIdx = appSrc.indexOf("if (closeoutSealUnverified === 'no_ledger')");
  const teardownIdx = appSrc.indexOf('invalidatePreview();\n    setHistoryLoaded(false);');
  assert.ok(noticeIdx > teardownIdx, 'the notice is appended AFTER the teardown, not instead of it');
  assert.match(appSrc.slice(noticeIdx, noticeIdx + 200), /appendNoLedgerNotice\(loggerStatus\)/,
    'the notice is appended to the status area rather than replacing the success message');
  assert.match(appSrc.slice(appSrc.indexOf('function appendNoLedgerNotice'), noticeIdx),
    /statusEl\.appendChild\(el\('div', \{ class: 'parser-status', text: CLOSEOUT_NO_LEDGER_MSG \}\)\)/,
    'the notice really renders the non-retryable copy');
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
      planned_name: 'Back Squat',
    }],
  });
  const text = allText(warned);
  assert.match(text, /plan ledger couldn't be read/, 'the read-failure warning shows');
  assert.match(text, /plan history for this session is inconsistent/i, 'the malformed warning shows');
  // The owner contract: the ORIGINAL plan stays visible — a substitution names
  // what it stood in for, by name (the F10D proving pack caught the bare-code form).
  assert.match(text, /\(substituted — in for Back Squat\)/, 'the substitution names the original lift');

  // Without a resolvable name the tag still renders, falling back to the code —
  // never silently untagged.
  const codeOnly = build({
    ...SUMMARY,
    items: [{ ...SUMMARY.items[0], outcome: 'substituted', performed_lift_code: 'FSQ01', revised: false, planned_name: null }],
  });
  assert.match(allText(codeOnly), /\(substituted — in for DIP01\)/, 'code fallback when no name resolves');
});

test('F10D confirm card: null load is NOT bodyweight — loadless targets render as reps; true BW (0) renders BW', () => {
  const build = loadConfirmHarness();
  const card = build({
    ...SUMMARY,
    items: [{
      ...SUMMARY.items[0], revised: false, outcome: 'completed',
      target_vs_actual: [
        // A load-omitted target (reps/RIR known, weight null) — e.g. Face Pull.
        { set_index: 1, target_weight: null, target_reps: 15, target_rir: 2, actual_weight: null, actual_reps: 15, actual_rir: 2 },
        // True bodyweight (weight === 0) — the Log_Cleaned convention.
        { set_index: 2, target_weight: 0, target_reps: 12, target_rir: 2, actual_weight: 0, actual_reps: 12, actual_rir: 1 },
      ],
    }],
    unplanned: [],
  });
  const text = allText(card);
  assert.match(text, /15 reps@2 → did 15 reps@2/, 'absent load renders loadless — never conflated with bodyweight');
  assert.match(text, /BW×12@2 → did BW×12@1/, 'weight 0 IS bodyweight and renders BW');
  assert.doesNotMatch(text, /BW×15/, 'the loadless target never shows as BW');
});

test('F10D confirm card: a re-preview replaces the stale confirmation (never stacked)', () => {
  // Codex P2 (PR #1069): the existing-card update path must drop the prior
  // .closeout-confirm sibling before appending the rebuilt one.
  assert.match(coachSrc, /const staleConfirm = existingBubble && existingBubble\.querySelector\('\.closeout-confirm'\);\s*\n\s*if \(staleConfirm\) staleConfirm\.remove\(\);/,
    'the stale closeout summary is removed in the existing-card branch');
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

// The owner-facing first-live-write procedure quotes the production tab header
// row verbatim — the one line Dale copies to CREATE the tab. It must equal the
// authoritative code order exactly (Codex P1 on PR #1071: a hand-typed draft
// swapped supersedes_key/confidence; the capture layer would have rejected the
// mis-created tab fail-closed, but the template itself must never drift).
test('F10D readiness doc: the quoted production header row IS sessionPlanSetsColumns, verbatim and in order', () => {
  const { sessionPlanSetsColumns } = require('../config/columns');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'F10D_PRODUCTION_READINESS.md'), 'utf8');
  const expected = sessionPlanSetsColumns.join(' | ');
  assert.ok(doc.includes(expected), 'the doc quotes the exact 16-column header order from config/columns.js');
  // And no OTHER 16-column pipe-joined line contradicts it: every doc line that
  // mentions idempotency_key alongside recorded_at must be the exact order.
  const headerLines = doc.split('\n').filter(l => l.includes('idempotency_key') && l.includes('recorded_at'));
  assert.ok(headerLines.length >= 1, 'the header line exists');
  for (const l of headerLines) {
    assert.ok(l.trim() === expected, `header listing matches the code order exactly: "${l.trim()}"`);
  }
});

// Codex P1 (readiness PR): the converted screenshot closeout's PAYLOAD carries the
// RESOLVED identity — the same one its re-stamped rows and effort row carry — so
// the server's summary, seal, and finalized event address the session the appends
// are stamped with, never the stale pre-parse lexicals.
test('F10D screenshot conversion: the closeout payload uses the screenshot-resolved identity', () => {
  assert.match(appSrc, /session_id: screenshotResolvedSessionId \|\| sessionId,/,
    'the payload session_id prefers the screenshot-resolved id');
  assert.match(appSrc, /date: screenshotResolvedDate \|\| date,/,
    'the payload date prefers the screenshot-resolved date');
  assert.match(appSrc, /screenshotResolvedSessionId = resolvedShotSessionId;\s*\n\s*screenshotResolvedDate = resolvedShot\.date;/,
    'the conversion records the resolved identity for the payload');
});
