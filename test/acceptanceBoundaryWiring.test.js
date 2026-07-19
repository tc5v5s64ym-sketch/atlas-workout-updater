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

test('boundary wiring: the gate holds the commit at the top of the mid-session branch and nothing writes', () => {
  const branch = appSrc.slice(
    appSrc.indexOf('const gateRec = unacceptedPlanGateRec(logRows);'),
    appSrc.indexOf('const gateRec = unacceptedPlanGateRec(logRows);') + 700
  );
  assert.match(branch, /atlas:acceptance-required/, 'the gate raises the acceptance-required event');
  assert.match(branch, /lastParsedWorkoutText = '';/, 'the reparse memo resets so the RESUMED identical text re-parses');
  assert.match(branch, /return;/, 'the gate returns without committing');
  assert.doesNotMatch(branch, /emitSetLogged/, 'nothing commits on the blocked path');
  // The gate sits INSIDE the mid-session commit branch — before classification.
  const mid = appSrc.indexOf('if (logRows.length && !file && !manualEffort && !sessionCompiledAwaitingPreview && !screenshotConvertedCloseout)');
  const gate = appSrc.indexOf('const gateRec = unacceptedPlanGateRec(logRows);');
  const classify = appSrc.indexOf('Substitution classification:');
  assert.ok(mid !== -1 && mid < gate && gate < classify, 'gate placement: mid-session branch top, before classification');
});

test('boundary wiring: ONE acceptance path — the card calls window.atlasAcceptPlan and resumes via atlasResumeBlockedLog', () => {
  const listener = coachSrc.slice(
    coachSrc.indexOf("addEventListener('atlas:acceptance-required'"),
    coachSrc.indexOf("addEventListener('atlas:acceptance-required'") + 2600
  );
  assert.match(listener, /Start this plan to track planned versus actual\./, 'the exact owner-directed block copy');
  assert.match(listener, /window\.atlasAcceptPlan\(rec\)/, 'invokes the EXISTING acceptance boundary — never a second path');
  assert.match(listener, /window\.atlasResumeBlockedLog/, 'releases the held message after acceptance');
  assert.match(listener, /btn\.disabled = true;/, 'DOM-level double-tap guard');
  assert.match(listener, /\.acceptance-required:not\(\.done\)/, 're-uses the one live card — never stacks');
  assert.doesNotMatch(listener, /api\(|fetch\(/, 'the card itself performs no network call — acceptance stays in app.js');
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
