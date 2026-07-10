'use strict';

// PR-G2 — structural wiring guards for the explicit "Done with this exercise"
// completed boundary, read against the built shell (public/). Complements the pure
// planOutcome.test.js completed cases: pins that the button is the ONLY authoritative
// completed trigger (a logged set / "Next" / chat never emit completed), it is gated
// on evidence + not-already-completed, and the handler marks completion locally
// (no re-complete), persists, emits completed by plan_item_id, and advances —
// regardless of the sidecar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const bannerBlock = app.slice(app.indexOf('function renderActiveSessionBanner('), app.indexOf('function completeCurrentPlanItem('));
const completeBlock = app.slice(app.indexOf('function completeCurrentPlanItem('), app.indexOf('function currentItemHasPerformedSet('));
const evidenceBlock = app.slice(app.indexOf('function currentItemHasPerformedSet('), app.indexOf('function currentItemHasPerformedSet(') + 400);

test('the "Done with this exercise" button is rendered on the current-exercise banner, gated on evidence + not-completed', () => {
  assert.match(bannerBlock, /'Done with this exercise'/, 'the banner shows the explicit completed affordance');
  assert.match(bannerBlock, /activePlan\.accepted === true && current\.plan_item_id/, 'only for an accepted item with identity');
  assert.match(bannerBlock, /item\.outcome !== 'completed' && currentItemHasPerformedSet\(current\)/,
    'shown only when NOT already completed AND there is evidence of a performed set');
  // the click is guarded against double-taps
  assert.match(bannerBlock, /if \(doneBtn\.disabled\) return; doneBtn\.disabled = true; completeCurrentPlanItem\(\)/,
    'the click disables the button (double-tap guard) and calls the completion handler');
});

test('completeCurrentPlanItem is the ONLY authoritative completed emitter: no re-complete, marks local, persists, advances', () => {
  assert.match(completeBlock, /if \(!item \|\| item\.outcome === 'completed'\) return;/, 'no re-complete / double-tap guard');
  assert.match(completeBlock, /item\.outcome = 'completed';/, 'marks the item completed locally');
  // marks BEFORE emit (so a re-render/reload cannot re-complete)
  assert.ok(completeBlock.indexOf("item.outcome = 'completed'") < completeBlock.indexOf('emitPlanItemOutcome'), 'marked before emit');
  assert.match(completeBlock, /saveSessionSnapshot\(\);/, 'persists so completion survives reload');
  assert.match(completeBlock, /emitPlanItemOutcome\(\{ plan_item_id: item\.plan_item_id, outcome: 'completed' \}\)/,
    'emits completed for the exact plan_item_id');
  assert.match(completeBlock, /advancePlannedSession\(\);/, 'advances normally regardless of the sidecar');
});

test('the completed evidence gate reads the derived completion buffer (enable-only), never auto-completes', () => {
  assert.match(evidenceBlock, /getSessionCompleted\(\)/, 'evidence = a performed set for the current item');
});

test("completed is emitted ONLY by the explicit button — not by logging a set, Next, or chat", () => {
  // The single `outcome: 'completed'` literal lives in completeCurrentPlanItem.
  const occurrences = app.split("outcome: 'completed'").length - 1;
  assert.equal(occurrences, 1, "exactly one completed emit site (the explicit Done button)");
  // emitSetLogged / advancePlannedSession must not emit completed.
  const emitSet = app.slice(app.indexOf('function emitSetLogged('), app.indexOf('function emitSetLogged(') + 3000);
  assert.doesNotMatch(emitSet, /outcome: 'completed'/, 'logging a set never emits completed');
  const advance = app.slice(app.indexOf('function advancePlannedSession('), app.indexOf('function advancePlannedSession(') + 1400);
  assert.doesNotMatch(advance, /outcome: 'completed'/, '"Next" never emits completed');
});
