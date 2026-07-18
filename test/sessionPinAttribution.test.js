'use strict';

// F10S4 — session pin set attribution (owner card, 2026-07-18 smoke gate): the pin
// must show sets completed for the CURRENT PLANNED ITEM only, not total session sets.
// The smoke failure: "Back Squat · 4 sets in" after one RDL set plus three Front
// Squat sets — the pin counted the whole session log against the current lift.
// Slices the REAL renderSessionPin from the built bundle and drives it with the real
// selector + store shim + a fake DOM that records the rendered spans.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function loadPinHarness() {
  const slicePEE = appSrc.slice(
    appSrc.indexOf('function plannedExerciseEntries()'),
    appSrc.indexOf('function isPlanCloseoutAwaitingSave()')
  );
  const slicePin = appSrc.slice(
    appSrc.indexOf('function renderSessionPin()'),
    appSrc.indexOf('function currentPlannedExercise(')
  );
  assert.ok(slicePin.includes('function renderSessionPin()'), 'slice must contain renderSessionPin');

  const pinEl = {
    hidden: true, children: [], dataset: {}, attrs: {}, _tc: '',
    // Real DOM semantics: assigning textContent = '' removes all children.
    get textContent() { return this._tc; },
    set textContent(v) { this._tc = v; if (v === '') this.children.length = 0; },
    appendChild(c) { this.children.push(c); },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {},
  };
  const fakeDoc = { getElementById: id => (id === 'session-pin' ? pinEl : null) };
  const { planSlotStatuses, remainingSlotNames, firstUnloggedSlot, variantSatisfies } = require('../src/app/planSlotStatuses.js');

  const factory = new Function(
    'document', 'planSlotStatuses', 'remainingSlotNames', 'firstUnloggedSlot', 'variantSatisfies',
    `${STORE_SHIM}
     let lastIntentData = null;
     function el(tag, opts) { return { tag, class: opts && opts.class, text: opts && opts.text }; }
     function renderActiveSessionBanner() {}
     ${slicePEE}
     ${slicePin}
     return {
       setActiveSession: s => { activePlannedSession = s; },
       setLog: rows => { sessionLog = rows.slice(); },
       setCompleted: arr => { sessionCompleted = arr.slice(); },
       renderSessionPin,
     };`
  );
  const api = factory(fakeDoc, planSlotStatuses, remainingSlotNames, firstUnloggedSlot, variantSatisfies);
  const spans = () => pinEl.children.map(c => [c.class, c.text]);
  const spanText = cls => (pinEl.children.find(c => c.class === cls) || {}).text;
  return { api, pinEl, spans, spanText };
}

const PLAN = {
  accepted: true, session_id: 'S1', plan_version: 'pv_x', index: 0,
  exercises: [
    { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01', plan_item_id: 'pi_rdl', sets: 3 },
    { name: 'Overhead Press', canonicalName: 'Overhead Press', liftCode: 'OHP01', plan_item_id: 'pi_ohp', sets: 3 },
  ],
};
const row = (exercise, canonical) => ({ exercise, canonical: canonical || exercise, weight: 100, reps: 5, rir: 2 });

test('SMOKE REPRODUCE: the pin counts the CURRENT item\'s sets, never the whole session', () => {
  const { api, spanText } = loadPinHarness();
  api.setActiveSession(JSON.parse(JSON.stringify(PLAN)));
  // 1 RDL set + 3 off-plan sets = 4 total session sets — the old pin showed
  // "<current> · 4 sets in". The current RDL slot has performed exactly 1 of 3.
  api.setLog([row('Romanian Deadlift'), row('Hammer Curl'), row('Hammer Curl'), row('Hammer Curl')]);
  api.setCompleted(['Romanian Deadlift', 'Hammer Curl']);
  api.renderSessionPin();
  assert.equal(spanText('pin-lift'), 'Romanian Deadlift', 'the in-progress slot is current');
  assert.equal(spanText('pin-sets'), '1 of 3 sets', 'the count is the CURRENT ITEM\'s 1/3 — not the session total 4');
});

test('the pin advances with the item: 2 of 3, then moves to the next slot at 3/3', () => {
  const { api, spanText } = loadPinHarness();
  api.setActiveSession(JSON.parse(JSON.stringify(PLAN)));
  api.setLog([row('Romanian Deadlift'), row('Romanian Deadlift')]);
  api.setCompleted(['Romanian Deadlift']);
  api.renderSessionPin();
  assert.equal(spanText('pin-sets'), '2 of 3 sets');
  api.setLog([row('Romanian Deadlift'), row('Romanian Deadlift'), row('Romanian Deadlift')]);
  api.renderSessionPin();
  assert.equal(spanText('pin-lift'), 'Overhead Press', 'at 3/3 the pin moves to the next slot');
  assert.equal(spanText('pin-sets'), '0 of 3 sets', 'the fresh slot starts at zero');
});

test('freestyle (no plan) keeps the session-total count and the last logged lift (unchanged)', () => {
  const { api, spanText } = loadPinHarness();
  api.setActiveSession(null);
  api.setLog([row('Bench Press'), row('Bench Press')]);
  api.setCompleted(['Bench Press']);
  api.renderSessionPin();
  assert.equal(spanText('pin-lift'), 'Bench Press');
  assert.equal(spanText('pin-sets'), '2 sets in', 'freestyle has no planned item — the session total stands');
});

test('a slot with no known set count shows its own performed count, not the session total', () => {
  const { api, spanText } = loadPinHarness();
  api.setActiveSession({ accepted: true, session_id: 'S1', index: 0, exercises: [
    { name: 'Cable Row', canonicalName: 'Cable Row', liftCode: '', plan_item_id: 'pi_cr' },
    { name: 'Face Pull', canonicalName: 'Face Pull', liftCode: '', plan_item_id: 'pi_fp' },
  ] });
  api.setLog([row('Hammer Curl'), row('Hammer Curl')]); // off-plan noise only
  api.setCompleted(['Hammer Curl']);
  api.renderSessionPin();
  assert.equal(spanText('pin-lift'), 'Cable Row');
  assert.equal(spanText('pin-sets'), '0 sets in', 'no sets performed on the current item — never the off-plan total');
});
