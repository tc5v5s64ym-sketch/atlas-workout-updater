'use strict';

// #1627 — save authority: a saved claim may be shown ONLY when the receipt
// authority's verdict for that write is verified.
//
// Verified firsthand 2026-10-29 at deployed head e0cc82d8, and re-confirmed
// in code at s3-maintenance head b4d46c9c: POST /api/log-workout can return
// sheet_write: "success" with rows written alongside
// log_write_verification { verified: false, reason: "wrong_tab" }, and the
// approve handler still set "Workout written to Google Sheets. ✓" with the
// write-confirmed marker. reportWriteVerification ran afterwards and could
// only append an inconclusive note — it could not demote the claim — so the
// review card's observer (which keys "✓ Saved" to write-confirmed) flipped
// the card to Saved over a write the receipt authority had adjudicated as
// landing in the wrong tab.
//
// This is PR #1313's own card path in a scenario #1313 never covered: a
// fresh append with rows > 0 whose receipt adjudicates wrong_tab. (#1313
// covered duplicate verdicts and no-write cases.)
//
// The fix, bounded to the typed /api/log-workout lane — the only lane whose
// response carries log_write_verification (the screenshot/complete-workout
// lane and the modality lane carry no verdict to gate on):
//   * a present verdict with verified !== true blocks the saved claim;
//   * the handler returns early with a truthful not-saved status (kind
//     'error', state 'write-unverified') instead of the success status, so
//     neither the logger prose nor the review card can claim a save;
//   * the staged write is NOT torn down: no invalidatePreview, no session
//     clear, no saved-log push, no snapshot clear, and no QA-1 lastWrite
//     watermark — the athlete keeps the preview and can check Sheets or
//     retry with the same write_id (a same-id retry replays the original
//     verdict without re-appending; minting a fresh id here could append
//     a second copy to the wrong tab, so this PR deliberately does not do
//     that). Recording a watermark here would strand a later re-log: the
//     nothing-new guard would refuse work that was never proven saved;
//   * a missing verdict keeps the existing read-back fallback path, which
//     exists for deployments older than the verdict field — there is no
//     negative answer to gate on in that case, and the fallback is already
//     sunset-tracked (docs/ATLAS_SYSTEM_AUTHORITY.md, concept 11b).
// Repair of a partial/unverified write (retry keyed to missing components)
// is #1628 / the durable-receipt design, not this PR.
//
// The behaviour half is `saveClaimBlockedByVerdict`, sliced from the built
// bundle and RUN here (the duplicateEchoProvesRows idiom). The wiring halves
// are source pins on the built bundle. The end-to-end card behaviour is
// proven in tests/e2e/write-verification-authority.spec.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

// ── saveClaimBlockedByVerdict: the gate decision, run against real shapes ───
function loadGate(src) {
  const start = src.indexOf('function saveClaimBlockedByVerdict(');
  assert.ok(start !== -1, 'saveClaimBlockedByVerdict must exist in the built app bundle');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end !== -1, 'saveClaimBlockedByVerdict must be a closed function');
  const slice = src.slice(start, end + 3);
  return new Function(`${slice}; return saveClaimBlockedByVerdict;`)();
}

test('#1627: a wrong_tab verdict blocks the saved claim', () => {
  const blocked = loadGate(appSrc);
  assert.equal(blocked({
    verified: false, authority: 'append_receipt', reason: 'wrong_tab',
    range: 'Wrong_Tab!A200:L202', rows_written: 3, rows_submitted: 3,
  }), true);
});

test('#1627: any unverified verdict blocks the saved claim, not only wrong_tab', () => {
  const blocked = loadGate(appSrc);
  assert.equal(blocked({
    verified: false, authority: 'append_receipt', reason: 'row_count_disagrees_with_request',
    range: 'Log_Cleaned!A200:L202', rows_written: 3, rows_submitted: 1,
  }), true);
  assert.equal(blocked({ verified: false, reason: 'no_receipt' }), true);
});

test('#1627: a verified verdict does not block the saved claim', () => {
  const blocked = loadGate(appSrc);
  assert.equal(blocked({
    verified: true, authority: 'append_receipt', reason: null,
    range: 'Log_Cleaned!A200:L202', rows_written: 1, rows_submitted: 1,
  }), false);
});

test('#1627: no verdict means no gate — the read-back fallback path is untouched', () => {
  const blocked = loadGate(appSrc);
  assert.equal(blocked(null), false);
  assert.equal(blocked(undefined), false);
});

test('#1627: a malformed verdict fails closed — only verified:true passes', () => {
  const blocked = loadGate(appSrc);
  assert.equal(blocked({}), true);
  assert.equal(blocked({ verified: 'yes' }), true);
});

// ── Approve-handler wiring: the gate runs before any saved claim ────────────
function approveHandlerSlice(src) {
  const start = src.indexOf("getElementById('approve-btn').addEventListener('click'");
  assert.ok(start !== -1, 'the approve handler must exist in the built app bundle');
  const end = src.indexOf('/* ===== Session loader', start);
  assert.ok(end !== -1, 'the approve handler slice must terminate at the session loader');
  return src.slice(start, end);
}

test('#1627 wiring: the unverified outcome is a named state, beside the QA-3 states', () => {
  assert.match(appSrc, /const WRITE_UNVERIFIED_STATE = 'write-unverified';/);
});

test('#1627 wiring: the gate is checked in the approve handler, before the success claim', () => {
  const slice = approveHandlerSlice(appSrc);
  assert.match(slice, /saveClaimBlockedByVerdict\(/,
    'the approve handler must consult the verdict gate');
  const gateIdx = slice.indexOf('saveClaimBlockedByVerdict(');
  // The success prose carries a period after "Sheets"; the gate's own
  // comment quotes the closeout-retry message without it, so pin the exact
  // success string, not the substring.
  const savedIdx = slice.indexOf('Workout written to Google Sheets. ✓');
  assert.ok(savedIdx !== -1, 'the success claim must still exist for verified writes');
  assert.ok(gateIdx !== -1 && gateIdx < savedIdx,
    'the verdict gate must run before the success claim is emitted');
});

test('#1627 wiring: the gated path emits a not-saved status and returns without tearing down', () => {
  const slice = approveHandlerSlice(appSrc);
  const gateIdx = slice.indexOf('saveClaimBlockedByVerdict(');
  assert.ok(gateIdx !== -1, 'the gate must exist in the approve handler');
  const gatedBlock = slice.slice(gateIdx, gateIdx + 1200);
  assert.match(gatedBlock, /WRITE_UNVERIFIED_STATE/,
    'the gated path must carry the write-unverified state marker');
  assert.match(gatedBlock, /Not saved/,
    'the gated path must be worded as not saved, never as a save');
  assert.doesNotMatch(gatedBlock, /Workout written to Google Sheets/,
    'the gated path must not emit the saved prose');
  assert.match(gatedBlock, /return;/,
    'the gated path must return before the success teardown');
});

test('#1627 wiring: the verdict gate takes precedence over the closeout-seal retry', () => {
  // The closeout retry message claims "Workout written to Google Sheets ✓"
  // for rows whose ledger seal failed. If the receipt verdict itself is
  // unverified, that claim is equally false, so the verdict gate must run
  // first — a wrong_tab write must never reach the retry branch.
  const slice = approveHandlerSlice(appSrc);
  const gateIdx = slice.indexOf('saveClaimBlockedByVerdict(');
  const retryIdx = slice.indexOf("closeoutSealUnverified === 'retry'");
  assert.ok(gateIdx !== -1 && retryIdx !== -1, 'both the gate and the closeout retry must exist');
  assert.ok(gateIdx < retryIdx,
    'the verdict gate must run before the closeout-seal retry branch');
});
