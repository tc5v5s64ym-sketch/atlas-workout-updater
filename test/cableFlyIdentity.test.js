'use strict';

// Cable Fly live-identity path (Phase 1). The previous failure was split-brain: the
// confirmation card + isolation voice recognized Cable Fly, but the "didn't catch
// that lift" save-warning did not (it keyed only on the Sheets datalist, which the
// parser-unknown lift may be absent from). These tests exercise the REAL warning
// gate with the KB-identity fallback (no stubbed catalog pretending to know Cable
// Fly), plus prove the warning has a single source and the isolation voice is intact.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { resolveExercise } = require('../services/exerciseResolver');
const { renderSetVoice } = require('../services/coachVoiceRenderer');
const { analyzeSetSequence } = require('../services/setEffortSignals');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

function loadShouldWarn() {
  const fnSrc = appSrc.slice(
    appSrc.indexOf('function shouldWarnUnknownLift('),
    appSrc.indexOf('function shouldUseLocalFallback(')
  );
  return new Function(`${fnSrc}; return shouldWarnUnknownLift;`)();
}

test('cable_fly_resolves_to_known_catalog_or_kb_identity', () => {
  const r = resolveExercise('Cable Fly 30 12/0');
  assert.ok(r && r.exercise_id === 'cable_fly', 'KB must resolve Cable Fly to a known identity');
  assert.equal(r.confident, true);
});

test('cable_fly_no_didnt_catch_lift_warning', () => {
  const shouldWarn = loadShouldWarn();
  const kb = { exercise_id: 'cable_fly', name: 'Cable Fly', confidence: 1 };
  // The REAL split-brain case: parser flags unknown_exercise AND the lift is NOT in
  // the datalist (catalogLookup returns '') — but the KB identity is present. The
  // warning must be suppressed because the KB recognized it (same source as card/voice).
  assert.equal(shouldWarn(['unknown_exercise'], 'Cable Fly', () => '', kb), false,
    'KB identity must suppress the warning even when the datalist does not know the lift');
  // A genuinely unresolved lift (no datalist, no KB) still warns.
  assert.equal(shouldWarn(['unknown_exercise'], 'Zzqx Press', () => '', null), true);
  // The datalist path still works on its own.
  assert.equal(shouldWarn(['unknown_exercise'], 'Cable Fly', () => 'CABF01', null), false);
});

test('cable_fly_save_preview_no_unknown_lift_warning', () => {
  // There must be exactly ONE unknown-lift advisory surface, and it must be gated by
  // shouldWarnUnknownLift (which now honors the KB identity). No second, ungated
  // unknown-lift warning may exist on the save/preview path. The advisory wording is
  // a name-review note (B2 surface-consistency) — never a "didn't catch that lift"
  // failure message that would contradict the confirmation card for the same input.
  const matches = appSrc.match(/I don't recognize "/g) || [];
  assert.equal(matches.length, 1, 'exactly one unknown-lift advisory surface');
  assert.equal((appSrc.match(/Didn't catch that lift/g) || []).length, 0,
    'the contradictory "didn\'t catch that lift" failure message must be gone (B2)');
  assert.match(appSrc, /shouldWarnUnknownLift\(parsed\.warnings, parsed\.rows\[0\]\?\.exercise, liftCodeFromCatalog, parsed\.kbIdentity\)/,
    'the warning must be gated by shouldWarnUnknownLift including the KB identity');
  // The backend-parsed result carries the KB identity through to the gate.
  assert.match(appSrc, /kbIdentity: data\.kb_identity \|\| null/);
});

test('cable_fly_isolation_rir0_voice_still_caution_only', () => {
  // Cable Fly 30 12/0 → isolation taken to failure → caution, never a compound block.
  const analysis = analyzeSetSequence([[30, 12, 0]], { exerciseName: 'Cable Fly' });
  const v = renderSetVoice({ analysis });
  assert.equal(v.severity, 'caution');
  assert.match(v.primary_line, /isolation/i);
  assert.doesNotMatch(v.primary_line, /does not earn more weight|pressing is yellow|hold the load/i,
    'isolation caution must not borrow heavy-compound block language');
});

test('server attaches kb_identity only for confident resolutions (read-only enrichment)', () => {
  const idxSrc = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  const block = idxSrc.slice(
    idxSrc.indexOf("app.post('/api/parse-workout-text'"),
    idxSrc.indexOf("app.post('/api/parse-workout-image'")
  );
  assert.match(block, /resolveExercise\(/, 'route resolves identity via the KB');
  assert.match(block, /hit && hit\.confident/, 'only a confident KB hit is attached');
  assert.match(block, /responseBody\.kb_identity =/, 'identity is additive on the response');
  // Dry-run proof fields are untouched by the enrichment.
  assert.doesNotMatch(block, /sheet_written\s*=|no_write_confirmed\s*=|appendRows|completeWrite/);
});
