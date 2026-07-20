'use strict';

// F10D acceptance boundary (owner canary corrective) — a DISPLAYED recommendation
// is never an active plan. Structural pins guard the gate's placement and the
// one-path invariants; a behavioral harness drives unacceptedPlanGateRec over the
// real source slice.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const coachSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');

test('boundary wiring: the gate SILENTLY auto-accepts and resumes the held set — nothing writes on the blocked path', () => {
  const gateStart = appSrc.indexOf('const gateRec = unacceptedPlanGateRec(logRows);');
  const branch = appSrc.slice(gateStart, appSrc.indexOf('Substitution classification:', gateStart));
  // The card was retired: the gate accepts through the SAME acceptDisplayedPlan
  // path the button used, then resumes the held set — no acceptance-required event.
  assert.match(branch, /acceptDisplayedPlan\(gateRec\)/, 'the gate auto-accepts the displayed plan via the one acceptance path');
  assert.match(branch, /atlasResumeBlockedLog/, 'a started acceptance resumes the held set through the one submit path');
  assert.doesNotMatch(branch, /atlas:acceptance-required/, 'the in-thread acceptance-required card event was retired');
  assert.match(branch, /lastParsedWorkoutText = '';/, 'the reparse memo resets so the RESUMED identical text re-parses');
  assert.match(branch, /return;/, 'the gate returns without committing on this path');
  assert.doesNotMatch(branch, /emitSetLogged/, 'nothing commits on the blocked path');
  // The gate sits INSIDE the mid-session commit branch — before classification.
  const mid = appSrc.indexOf('if (logRows.length && !file && !manualEffort && !sessionCompiledAwaitingPreview && !screenshotConvertedCloseout)');
  const gate = appSrc.indexOf('const gateRec = unacceptedPlanGateRec(logRows);');
  const classify = appSrc.indexOf('Substitution classification:');
  assert.ok(mid !== -1 && mid < gate && gate < classify, 'gate placement: mid-session branch top, before classification');
});

test('boundary wiring: the in-thread acceptance card was retired — one acceptance path (app.js atlasAcceptPlan) survives', () => {
  // No second acceptance workflow: the blocking card and its copy are gone.
  assert.doesNotMatch(coachSrc, /addEventListener\('atlas:acceptance-required'/, 'no in-thread acceptance-required card listener remains');
  assert.doesNotMatch(coachSrc, /Start this plan to track planned versus actual\./, 'the retired card copy is gone');
  // The single acceptance boundary the silent gate reuses is still exposed.
  assert.match(appSrc, /window\.atlasAcceptPlan = acceptDisplayedPlan;/, 'the one acceptance boundary (atlasAcceptPlan) is intact');
});

test('boundary wiring: the resume uses the REAL submit gesture (a bare synthetic submit event does not run the form)', () => {
  const resume = appSrc.slice(
    appSrc.indexOf('window.atlasResumeBlockedLog = ()'),
    appSrc.indexOf('window.atlasResumeBlockedLog = ()') + 1400
  );
  assert.match(resume, /previewBtn\.click\(\)/, 'clicks the submit button exactly as the athlete would');
  assert.match(resume, /blockedLogText = null;/, 'the stash is one-shot');
  // A newer in-flight submit self-commits after acceptance — replaying a stale
  // stash would DUPLICATE a set. The newest message always wins.
  assert.match(resume, /if \(previewRequestSeq !== blockedLogSeq\) return;/,
    'a superseded stash is dropped, never replayed into a duplicate');
});

// ── unacceptedPlanGateRec — behavioral over the real slice ──────────────────────

function loadGateHarness() {
  const slice = appSrc.slice(
    appSrc.indexOf('function displayedRecommendation()'),
    appSrc.indexOf('window.atlasResumeBlockedLog = ()')
  );
  assert.ok(slice.includes('function unacceptedPlanGateRec('), 'slice contains the gate');
  const factory = new Function(
    'liftCodeFromCatalog',
    `${STORE_SHIM}
     let lastIntentData = null;
     ${slice}
     return {
       setIntent: v => { lastIntentData = v; },
       setEngaged: v => setCoachSuggestionEngaged(v),
       setActiveSession: s => { activePlannedSession = s; },
       unacceptedPlanGateRec,
     };`
  );
  return factory(() => '');
}

const REC = { id: 'work_day', recommended: true, exercises: [{ exercise: 'Overhead Press', lift_code: 'OHP01' }, { exercise: 'Bench Press', lift_code: 'BEN01' }] };
const rowsOf = name => [{ exercise: name }];

test('gate: an ACCEPTED session never gates (including reload-restored)', () => {
  const h = loadGateHarness();
  h.setIntent({ intents: [REC] });
  h.setEngaged(true);
  h.setActiveSession({ accepted: true, exercises: [{ name: 'Overhead Press' }] });
  assert.equal(h.unacceptedPlanGateRec(rowsOf('Overhead Press')), null);
});

test('gate: nothing displayed → freeform passes through', () => {
  const h = loadGateHarness();
  h.setIntent(null);
  assert.equal(h.unacceptedPlanGateRec(rowsOf('Overhead Press')), null);
});

test('gate: an ENGAGED unaccepted pick gates ANY set (the plan surface acts plan-like without identity)', () => {
  const h = loadGateHarness();
  h.setIntent({ intents: [REC] });
  h.setEngaged(true);
  const rec = h.unacceptedPlanGateRec(rowsOf('Romanian Deadlift'));
  assert.ok(rec && rec.id === 'work_day');
});

test('gate: a materialized-but-unaccepted session gates', () => {
  const h = loadGateHarness();
  h.setIntent({ intents: [REC] });
  h.setEngaged(false);
  h.setActiveSession({ exercises: [{ name: 'Overhead Press' }] });   // no accepted:true
  assert.ok(h.unacceptedPlanGateRec(rowsOf('Romanian Deadlift')));
});

test('gate: merely displayed — a set FROM the plan gates; an unrelated set passes (freeform protected)', () => {
  const h = loadGateHarness();
  h.setIntent({ intents: [REC] });
  h.setEngaged(false);
  h.setActiveSession(null);
  assert.ok(h.unacceptedPlanGateRec(rowsOf('Bench Press')), 'a displayed-plan set gates');
  assert.ok(h.unacceptedPlanGateRec(rowsOf('bench press')), 'name matching is case-insensitive');
  assert.equal(h.unacceptedPlanGateRec(rowsOf('Barbell Curl')), null, 'an unrelated set never gates');
});

test('gate: a deload pick keeps its own owner-gated flow — never gated here', () => {
  const h = loadGateHarness();
  h.setIntent({ intents: [{ ...REC, id: 'deload_reset' }] });
  h.setEngaged(true);
  assert.equal(h.unacceptedPlanGateRec(rowsOf('Overhead Press')), null);
});
