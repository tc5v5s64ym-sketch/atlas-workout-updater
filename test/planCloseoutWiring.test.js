'use strict';

// PR-H — structural wiring guards for explicit session-closeout capture, read
// against the built shell (public/). Complements the pure planCloseout.test.js:
// pins that closeout is emitted ONLY at the explicit Finish/End-session and
// Start-over/discard affordances, gated on an accepted plan, and NEVER from the
// implicit endPlannedSession cleanup paths or "Next" auto-advance.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

const emitBlock = app.slice(app.indexOf('function emitPlanCloseout('), app.indexOf('function emitPlanCloseout(') + 700);
// endPlannedSession body — must NOT emit closeout (it is an implicit cleanup path).
const epStart = app.indexOf('function endPlannedSession(');
const epBody = app.slice(epStart, app.indexOf('\nfunction ', epStart + 10));
// advancePlannedSession body — "Next" auto-advance/auto-end must NOT emit closeout.
const advStart = app.indexOf('function advancePlannedSession(');
const advBody = app.slice(advStart, app.indexOf('\nfunction ', advStart + 10));

test('app.js imports the pure closeout orchestrator (aliased to avoid the existing save-flow runCloseout)', () => {
  assert.match(app, /import \{ runCloseout as runPlanCloseout \} from '\.\/planCloseout\.js';/);
});

test('emitPlanCloseout is a non-blocking sidecar POST to /closeout, gated on an accepted plan', () => {
  assert.match(emitBlock, /plan\.accepted !== true\) return;/, 'only accepted sessions emit closeout');
  assert.match(emitBlock, /\/api\/session-plans\/closeout/, 'posts to the closeout endpoint');
  assert.match(emitBlock, /runPlanCloseout\(/, 'delegates to the pure orchestrator');
  assert.match(emitBlock, /\.catch\(/, 'fire-and-forget — never blocks the close/discard');
});

test('finalized is emitted from End-session at click; the SAVE path records it server-side on approval (F10D)', () => {
  assert.match(app, /endBtn\.addEventListener\('click', \(\) => \{ emitPlanCloseout\('finalized'\); endPlannedSession\(\); \}\)/,
    'the banner "End session" button (no save flow) still emits finalized at the click');
  // F10D — one approval governs the complete closeout: tapping Finish only OPENS
  // the confirmation; the finalized event is recorded by the SERVER inside the
  // approved /api/log-workout write (with the capture proof envelope), so a
  // rejected confirmation writes nothing — including this event. No client-side
  // finalized emission remains anywhere on the save path.
  assert.match(app, /finish-session-btn'\)\?\.addEventListener\('click', \(\) => \{ handleLogIt\(\); \}\)/,
    'the "Finish session" affordance opens the closeout WITHOUT emitting');
  const idx = app.indexOf("emitPlanCloseout('finalized')");
  const endBtnIdx = app.indexOf("endBtn.addEventListener");
  assert.ok(idx > -1 && app.indexOf("emitPlanCloseout('finalized')", idx + 1) === -1,
    'exactly ONE finalized emission remains (the non-save End-session affordance)');
  assert.ok(Math.abs(idx - endBtnIdx) < 200, 'and it is the End-session click site');
});

test('abandoned is emitted from the explicit Start-over and discard-restored affordances', () => {
  assert.match(app, /start-over-btn'\)\?\.addEventListener\('click', \(\) => \{ emitPlanCloseout\('abandoned'\); startOverWorkout\(\); \}\)/,
    'the "Start over" button emits abandoned before clearing');
  // The restore-banner trash emits abandoned at the explicit click site (keeping
  // discardRestoredSession itself pure for its eval-harness tests).
  assert.match(app, /trash\.addEventListener\('click', \(\) => \{ emitPlanCloseout\('abandoned'\); discardRestoredSession\(\); \}\)/,
    'the trash discard emits abandoned before discarding');
});

test('the implicit cleanup paths never emit closeout (no inference)', () => {
  assert.doesNotMatch(epBody, /emitPlanCloseout/, 'endPlannedSession (implicit auto-end / post-save reset) must not emit closeout');
  assert.doesNotMatch(advBody, /emitPlanCloseout/, '"Next" auto-advance/auto-end must not emit closeout');
});

test('exactly the three explicit closeout emit sites exist (the save path is server-recorded — F10D)', () => {
  const finalized = app.split("emitPlanCloseout('finalized')").length - 1;
  const abandoned = app.split("emitPlanCloseout('abandoned')").length - 1;
  assert.equal(finalized, 1, 'finalized: End session only — the approved save records it server-side with proof');
  assert.equal(abandoned, 2, 'abandoned: Start over + discard-restored');
});

test('the module is precached and the shell cache is bumped', () => {
  assert.match(sw, /\/app\/planCloseout\.js/, 'planCloseout.js is in SHELL_ASSETS');
  assert.match(sw, /atlas-shell-v146/, 'SW cache version bumped');
});
