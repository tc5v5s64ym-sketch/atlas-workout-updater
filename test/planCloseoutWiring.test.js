'use strict';

// PR-H — structural wiring guards for explicit session-closeout capture, read
// against the built shell (public/). Complements the pure planCloseout.test.js:
// pins that closeout is emitted ONLY at the explicit Start-over/discard
// affordances (`abandoned`), gated on an accepted plan, and NEVER from the
// implicit endPlannedSession cleanup paths or "Next" auto-advance. #1689:
// `finalized` has NO client-side emit site at all — End session routes through
// the same save flow as Finish, and the approve handler is the only emitter,
// server-side under the approved write_id.

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

test('End session routes through the same closeout as Finish; NO client-side finalized emission remains (#1689)', () => {
  assert.match(app, /endBtn\.addEventListener\('click', \(\) => \{ handleLogIt\(\); \}\)/,
    'the banner "End session" button opens the closeout review WITHOUT emitting');
  // F10D — one approval governs the complete closeout: tapping Finish only OPENS
  // the confirmation; the finalized event is recorded by the SERVER inside the
  // approved /api/log-workout write (with the capture proof envelope), so a
  // rejected confirmation writes nothing — including this event. #1689 extends
  // that rule to End session: no client-side finalized emission remains anywhere.
  assert.match(app, /finish-session-btn'\)\?\.addEventListener\('click', \(\) => \{ handleLogIt\(\); \}\)/,
    'the "Finish session" affordance opens the closeout WITHOUT emitting');
  assert.doesNotMatch(app, /emitPlanCloseout\('finalized'\)/,
    'no client-side finalized emission remains — the approved save records it server-side with proof');
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

test('exactly the two explicit closeout emit sites exist, both abandoned (finalized is server-recorded — #1689)', () => {
  const finalized = app.split("emitPlanCloseout('finalized')").length - 1;
  const abandoned = app.split("emitPlanCloseout('abandoned')").length - 1;
  assert.equal(finalized, 0, 'finalized: no client-side emit site — the approved save records it server-side with proof');
  assert.equal(abandoned, 2, 'abandoned: Start over + discard-restored');
});

test('the module is precached and the shell cache is bumped', () => {
  assert.match(sw, /\/app\/planCloseout\.js/, 'planCloseout.js is in SHELL_ASSETS');
  assert.match(sw, /atlas-shell-v146/, 'SW cache version bumped');
});
