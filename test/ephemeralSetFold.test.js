'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const { foldJustLoggedSet, EPHEMERAL_SESSION_ID } = require('../services/ephemeralSetFold');
const { lastWorkingSet } = require('../services/liftPrescription');
const { buildIntentEnvelope } = require('../services/intentEnvelope');
const { assembleState } = require('../services/stateAssembly');
const { orchestrate } = require('../services/coachOrchestrator');
const { validateCoachingDecision } = require('../services/coachingDecision');
const { buildRunners } = require('../services/coachRunners');
const { planBrianOverride, applyBrianOverride } = require('../services/coachEnginePromotion');
const manifest = require('../services/capabilityManifest');

before(() => manifest._resetForTesting());

const ASOF = '2026-06-30T14:00:00Z';

// Five recent improving bench sessions ending 2026-06-26 at 200×5@2; the
// lifter is now mid-workout on 2026-06-30 and just logged an UNSAVED 205×5@3.
// The sheet knows 200; only the fold knows 205 — so the two prescriptions
// differ visibly and consumption is provable.
const SHEET_ROWS = (() => {
  const dates = ['2026-06-10', '2026-06-14', '2026-06-18', '2026-06-22', '2026-06-26'];
  let w = 180; const rows = [];
  for (let i = 0; i < 5; i++) { rows.push([dates[i], 's' + i, 'Bench Press', 'Bench Press', 'chest', 'BEN01', 1, w, 5, 2, '', w * 5]); w += 5; }
  return rows;
})();
const FRESH_SET = { weight: 205, reps: 5, rir: 3 };

describe('foldJustLoggedSet — the synthetic row', () => {
  it('appends one 12-col row carrying the lift identity and the fresh numbers', () => {
    const out = foldJustLoggedSet(SHEET_ROWS, 'BEN01', FRESH_SET, ASOF);
    assert.equal(out.length, SHEET_ROWS.length + 1);
    const row = out[out.length - 1];
    assert.equal(row[0], '2026-06-30');                    // asOf date
    assert.equal(row[1], EPHEMERAL_SESSION_ID);
    assert.equal(row[3], 'Bench Press');                   // identity copied from the sheet
    assert.equal(row[4], 'chest');
    assert.equal(row[5], 'BEN01');
    assert.equal(row[7], 205);
    assert.equal(row[8], 5);
    assert.equal(row[9], 3);
    assert.equal(row[11], 1025);                           // volume = w × r
    // Never mutates the input.
    assert.equal(SHEET_ROWS.length, 5);
  });

  it('the folded set becomes the chronological last working set (date, then the ~ session tie-break)', () => {
    const sameDay = [...SHEET_ROWS,
      ['2026-06-30', '20260630-AM-01', 'Bench Press', 'Bench Press', 'chest', 'BEN01', 1, 200, 5, 2, '', 1000]];
    const out = foldJustLoggedSet(sameDay, 'BEN01', FRESH_SET, ASOF);
    const last = lastWorkingSet(out, 'BEN01', ASOF);
    assert.equal(last.currentWeight, 205, 'the ephemeral row must outrank a saved same-day session');
    assert.equal(last.currentRIR, 3);
  });

  it('a brand-new lift (no sheet history) degrades identity to the lift code', () => {
    const out = foldJustLoggedSet([], 'NEW01', FRESH_SET, ASOF);
    assert.equal(out.length, 1);
    assert.equal(out[0][3], 'NEW01', 'canonical_exercise must be non-empty for downstream normRow filters');
  });

  it('an unfoldable set (missing numbers / date / code) returns the rows unchanged', () => {
    assert.equal(foldJustLoggedSet(SHEET_ROWS, 'BEN01', { weight: NaN, reps: 5 }, ASOF).length, SHEET_ROWS.length);
    assert.equal(foldJustLoggedSet(SHEET_ROWS, 'BEN01', FRESH_SET, null).length, SHEET_ROWS.length);
    assert.equal(foldJustLoggedSet(SHEET_ROWS, '', FRESH_SET, ASOF).length, SHEET_ROWS.length);
    assert.equal(foldJustLoggedSet(SHEET_ROWS, 'BEN01', null, ASOF).length, SHEET_ROWS.length);
  });
});

describe('ephemeral fold — end-to-end: the decision consumes the fresh set and may drive the reaction', () => {
  function readers(rows) {
    return {
      getLogRows: async () => rows,
      readDeloadState: async () => null,
      getProfile: async () => ({ profile_goal: 'powerlifting', training_level: 'intermediate', population: 'general' }),
    };
  }

  async function decide(rows) {
    const envelope = buildIntentEnvelope({ type: 'progression_review', constraints: { target_lift: 'BEN01' }, source: 'api', asOf: ASOF });
    const snapshot = await assembleState({ readers: readers(rows), asOf: ASOF });
    const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
    return { brian, validation: validateCoachingDecision(brian) };
  }

  it('folded rows → Brian prescribes FROM the ephemeral 205, unfolded from the sheet 200 — consumption is provable', async () => {
    const unfolded = await decide(SHEET_ROWS);
    assert.equal(unfolded.brian.status, 'answered');
    assert.equal(unfolded.brian.payload.target_weight, 200, 'sheet-only: the engine anchors at the saved 200');

    const folded = foldJustLoggedSet(SHEET_ROWS, 'BEN01', FRESH_SET, ASOF);
    const { brian, validation } = await decide(folded);
    assert.equal(validation.valid, true, `errors: ${validation.errors.join(' | ')}`);
    assert.equal(brian.status, 'answered');
    assert.equal(brian.payload.target_weight, 205,
      'folded: the prescription anchors on the unsaved 205 set — the decision consumed the fresh set');
    assert.equal(brian.payload.target_reps, 6, 'on_target at RIR 3 → add a rep on the fresh load');

    const rec = { recommendation: 'legacy', reasoning: 'legacy', next_target: { weight: 205, reps: 5, sets: 3 } };
    const plan = planBrianOverride(rec, brian, validation, null, { justLoggedSet: FRESH_SET, ephemeralSetFolded: true });
    assert.equal(plan.eligible, true, `got reason=${plan.reason}`);
    applyBrianOverride(rec, plan);
    assert.equal(rec.next_target.weight, brian.payload.target_weight, 'Brian numbers verbatim');
    assert.equal(rec.next_target.reps, 6);
  });

  it('without the fold flag the anchor still wins — the guard only lifts where the fold happened', async () => {
    const { brian, validation } = await decide(SHEET_ROWS);
    const rec = { recommendation: 'legacy', reasoning: 'legacy', next_target: { weight: 205, reps: 5, sets: 3 } };
    const plan = planBrianOverride(rec, brian, validation, null, { justLoggedSet: FRESH_SET });
    assert.equal(plan.eligible, false);
    assert.equal(plan.reason, 'just_logged_anchor');
  });
});
