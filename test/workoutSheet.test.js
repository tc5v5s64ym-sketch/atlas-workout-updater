'use strict';

// Workout Sheet (PR-1) — pure physics + card-classification helpers. The gesture,
// detents, snap, dim, and DOM render are exercised in the browser (Playwright); these
// pin the DOM-free logic the module exports.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let WS, SEL;
// F10 — buildSheetCards now consumes per-slot statuses from the ONE authoritative
// selector (planSlotStatuses), keyed on plan_item_id + slot position, instead of a
// remaining-name set. Derive `statuses` from a plan + logged completions the same way
// the DOM wiring does, so the sheet cards prove the real integration.
const statusesFor = (planned, completed) => SEL.planSlotStatuses({ exercises: planned }, completed);

describe('workoutSheet pure helpers', () => {
  it('loads the ES module (DOM wiring is a no-op in Node)', async () => {
    WS = await import('../src/app/workoutSheet.js');
    SEL = await import('../src/app/planSlotStatuses.js');
    assert.ok(WS.detentsFor && WS.snapTarget && WS.buildSheetCards);
  });

  // ── detents ──
  it('detentsFor: closed 0, center ~58%, full ~92% of the viewport', () => {
    assert.deepEqual(WS.detentsFor(1000), { closed: 0, center: 580, full: 920 });
    assert.deepEqual(WS.detentsFor(0), { closed: 0, center: 0, full: 0 });
    assert.deepEqual(WS.detentsFor(-5), { closed: 0, center: 0, full: 0 }); // bad input → zeros
  });

  // ── snap ──
  const D = { closed: 0, center: 580, full: 920 };
  it('snapTarget: a slow release snaps to the NEAREST detent', () => {
    assert.equal(WS.snapTarget(120, 0, D), 0, 'near the top → closed');
    assert.equal(WS.snapTarget(520, 0, D), 580, 'past midpoint → center');
    assert.equal(WS.snapTarget(900, 0, D), 920, 'near the bottom → full');
  });
  it('snapTarget: a downward flick jumps to the NEXT higher stop', () => {
    assert.equal(WS.snapTarget(50, 1.0, D), 580, 'flick down from closed → center');
    assert.equal(WS.snapTarget(600, 1.0, D), 920, 'flick down from center → full');
    assert.equal(WS.snapTarget(910, 1.0, D), 920, 'flick down at full → stays full');
  });
  it('snapTarget: an upward flick jumps to the NEXT lower stop (closes from center)', () => {
    assert.equal(WS.snapTarget(560, -1.0, D), 0, 'flick up from center → closed');
    assert.equal(WS.snapTarget(900, -1.0, D), 580, 'flick up from full → center');
    assert.equal(WS.snapTarget(10, -1.0, D), 0, 'flick up at closed → stays closed');
  });
  it('snapTarget: below the flick threshold is treated as a slow release (nearest)', () => {
    assert.equal(WS.snapTarget(600, 0.2, D), 580, 'gentle drift → nearest, not a flick jump');
  });

  // ── rubber band ──
  it('rubberBand: clamps at 0 and resists past full at 0.25', () => {
    assert.equal(WS.rubberBand(-30, 920), 0);
    assert.equal(WS.rubberBand(400, 920), 400, 'within range → identity');
    assert.equal(WS.rubberBand(1000, 920), 920 + 80 * 0.25, 'past full → 0.25 resistance');
  });

  // ── card classification ──
  const PLAN = [
    { name: 'Bench Press', canonicalName: 'Bench Press', weight: 225, reps: 5, sets: 4, rir: 2 },
    { name: 'Incline DB Press', canonicalName: 'Incline DB Press', weight: 70, reps: 8, sets: 3, rir: 2 },
    { name: 'Overhead Press', canonicalName: 'Overhead Press', weight: 115, reps: 6, sets: 3, rir: 2 },
    { name: 'Cable Fly', canonicalName: 'Cable Fly', weight: 42.5, reps: 12, sets: 3, rir: 1 },
  ];
  it('buildSheetCards: done (completed slot) / current (first pending) / pending, in plan order', () => {
    const cards = WS.buildSheetCards({
      planned: PLAN,
      statuses: statusesFor(PLAN, ['Bench Press']),
      log: [{ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2 }, { exercise: 'Bench Press', weight: 225, reps: 5, rir: 2 }],
    });
    assert.deepEqual(cards.map(c => c.status), ['done', 'current', 'pending', 'pending']);
    assert.deepEqual(cards.map(c => c.slot), [1, 2, 3, 4]);
    assert.equal(cards[0].name, 'Bench Press');
    assert.equal(cards[0].logged.count, 2, 'done card carries its logged set count');
  });
  it('buildSheetCards: F10 — duplicate-named slots stay independent (one log marks ONE card done)', () => {
    // The Workout Sheet duplicate-name identity finding: two "Lat Pulldown" slots must
    // NOT both flip to done on one logged set — each is its own plan_item_id.
    const dup = [
      { name: 'Lat Pulldown', canonicalName: 'Lat Pulldown', plan_item_id: 'pi_1', weight: 120, reps: 10, sets: 3, rir: 2 },
      { name: 'Cable Row', canonicalName: 'Cable Row', plan_item_id: 'pi_2', weight: 100, reps: 10, sets: 3, rir: 2 },
      { name: 'Lat Pulldown', canonicalName: 'Lat Pulldown', plan_item_id: 'pi_3', weight: 120, reps: 10, sets: 3, rir: 2 },
    ];
    const cards = WS.buildSheetCards({
      planned: dup,
      statuses: statusesFor(dup, ['Lat Pulldown']),
      log: [{ exercise: 'Lat Pulldown', weight: 120, reps: 10, rir: 2 }],
    });
    assert.deepEqual(cards.map(c => c.status), ['done', 'current', 'pending'],
      'first Lat Pulldown done; the second stays pending, not swept done');
  });
  it('buildSheetCards: an all-complete plan has no current (every slot resolved)', () => {
    const one = PLAN.slice(0, 1);
    const cards = WS.buildSheetCards({ planned: one, statuses: statusesFor(one, ['Bench Press']), log: [] });
    assert.equal(cards[0].status, 'done');
  });
  it('buildSheetCards: empty / bad input → []', () => {
    assert.deepEqual(WS.buildSheetCards({}), []);
    assert.deepEqual(WS.buildSheetCards(), []);
    assert.deepEqual(WS.buildSheetCards({ planned: [{ name: '' }], statuses: [] }), [], 'blank names dropped');
  });

  // ── detail text (no invented numbers) ──
  it('cardDetailText: done shows the logged top set; current shows the set counter + next; pending shows the prescription', () => {
    const threePlan = PLAN.slice(0, 3);
    const [bench, incline, ohp] = WS.buildSheetCards({
      planned: threePlan,
      statuses: statusesFor(threePlan, ['Bench Press']),
      log: [{ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2 }, { exercise: 'Incline DB Press', weight: 70, reps: 8, rir: 2 }],
    });
    assert.match(WS.cardDetailText(bench), /1 set · top 225×5 @2/); // one bench set in the fixture
    assert.match(WS.cardDetailText(incline), /set 2\/3 · next 70×8 @2/); // one set logged → next is set 2
    assert.match(WS.cardDetailText(ohp), /3 sets · 115×6 @2/);
    // Over-logged (more sets than prescribed) clamps the counter to the target — never "set 5/3".
    const overPlan = [{ name: 'Incline DB Press', canonicalName: 'Incline DB Press', weight: 70, reps: 8, sets: 3, rir: 2 }];
    const [over] = WS.buildSheetCards({
      planned: overPlan,
      statuses: statusesFor(overPlan, []),
      log: [0, 1, 2, 3].map(() => ({ exercise: 'Incline DB Press', weight: 70, reps: 8, rir: 2 })), // 4 logged vs sets:3
    });
    assert.match(WS.cardDetailText(over), /set 3\/3 · next 70×8 @2/, 'counter clamps at the target, not set 5/3');

    // Never invents a number the inputs don't carry.
    for (const c of [bench, incline, ohp]) {
      for (const n of (WS.cardDetailText(c).match(/\d+(\.\d+)?/g) || [])) {
        assert.ok(/225|5|2|70|8|3|115|6|1/.test(n), `every number is from the fixture: ${n}`);
      }
    }
  });
});
