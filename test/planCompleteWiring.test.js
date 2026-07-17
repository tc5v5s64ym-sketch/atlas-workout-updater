'use strict';

// PR-I5 — structural wiring guards for the explicit "Done with <exercise>" completed
// boundary, read against the built shell (public/). Complements the pure
// planCompletion.test.js / planOutcome.test.js completed cases: pins that the button
// targets the MOST RECENTLY LOGGED still-unresolved accepted item (reachable mid-plan
// after the cursor advances), is the ONLY authoritative completed trigger (a logged
// set / "Next" / chat never emit completed), and the handler completes strictly by
// plan_item_id, marks completion locally (no re-complete), persists, emits, and
// re-renders — WITHOUT moving the cursor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

const bannerBlock = app.slice(app.indexOf('function renderActiveSessionBanner('), app.indexOf('function completePlanItemById('));
const completeBlock = app.slice(app.indexOf('function completePlanItemById('), app.indexOf('function completePlanItemById(') + 800);

test('app.js imports the pure mid-plan completion selector', () => {
  assert.match(app, /import \{ mostRecentCompletablePlanItem \} from '\.\/planCompletion\.js';/);
});

test('the banner offers "Done with <exercise>" for the most-recently-logged unresolved accepted item', () => {
  assert.match(bannerBlock, /mostRecentCompletablePlanItem\(activePlan, getSessionCompleted\(\)\)/,
    'the Done target is the most recently logged completable item (evidence = the completion buffer)');
  assert.match(bannerBlock, /activePlan\.accepted === true/, 'only for an accepted plan');
  assert.match(bannerBlock, /text: `Done with \$\{doneTarget\.name\}`/, 'the button names the performed exercise');
  // the click is guarded against double-taps and completes BY plan_item_id
  assert.match(bannerBlock, /if \(doneBtn\.disabled\) return; doneBtn\.disabled = true; completePlanItemById\(doneTarget\.plan_item_id\)/,
    'the click disables the button (double-tap guard) and completes by the immutable plan_item_id');
});

test('completePlanItemById is the ONLY authoritative completed emitter: by id, no re-complete, marks local, persists, no cursor move', () => {
  assert.match(completeBlock, /const item = \(plan\.items \|\| \[\]\)\.find\(it => it && it\.plan_item_id === planItemId\)/,
    'resolves the item strictly by plan_item_id — never by name / lift-code / position');
  assert.match(completeBlock, /if \(!item \|\| item\.outcome === 'completed'\) return;/, 'no re-complete / double-tap guard');
  assert.match(completeBlock, /item\.outcome = 'completed';/, 'marks the item completed locally');
  assert.ok(completeBlock.indexOf("item.outcome = 'completed'") < completeBlock.indexOf('emitPlanItemOutcome'), 'marked before emit');
  assert.match(completeBlock, /saveSessionSnapshot\(\);/, 'persists so completion survives reload');
  assert.match(completeBlock, /emitPlanItemOutcome\(\{ plan_item_id: item\.plan_item_id, outcome: 'completed' \}\)/,
    'emits completed for the exact plan_item_id');
  assert.match(completeBlock, /renderActiveSessionBanner\(\);/, 're-renders so the next eligible item surfaces');
  assert.doesNotMatch(completeBlock, /advancePlannedSession\(\)/, 'completion never moves the plan cursor');
});

test("completed is emitted ONLY by the explicit button — not by logging a set, Next, or chat", () => {
  // The single `outcome: 'completed'` literal lives in completePlanItemById.
  const occurrences = app.split("outcome: 'completed'").length - 1;
  assert.equal(occurrences, 1, "exactly one completed emit site (the explicit Done button)");
  const emitSet = app.slice(app.indexOf('function emitSetLogged('), app.indexOf('function emitSetLogged(') + 3000);
  assert.doesNotMatch(emitSet, /outcome: 'completed'/, 'logging a set never emits completed');
  const advance = app.slice(app.indexOf('function advancePlannedSession('), app.indexOf('function advancePlannedSession(') + 1400);
  assert.doesNotMatch(advance, /outcome: 'completed'/, '"Next" never emits completed');
});

test('the pure selector module is precached and the shell cache is bumped', () => {
  assert.match(sw, /\/app\/planCompletion\.js/, 'planCompletion.js is in SHELL_ASSETS');
  assert.match(sw, /atlas-shell-v144/, 'SW cache version bumped for the new asset');
});
