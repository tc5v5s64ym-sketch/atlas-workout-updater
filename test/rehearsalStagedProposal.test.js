'use strict';

// F-SB4B staged-proposal observation bites (TEMPORARY; sunset: F-SB4C).
//
// The observation in tests/e2e/gate/rehearsal-staged-proposal.js is now the SOLE
// authority for the replacement's identity, its retained source slot, and the
// engine's prescribed set count. An authority that accepts an incomplete record is
// worse than the inference it replaced, because a blank field would read as an
// answer. These tests prove it fails CLOSED on every missing or contradictory field,
// and that a complete record projects exactly the identity and prescription its two
// consumers read.
//
// The browser half — that the observer actually records this at staging time, on the
// real constraint lane, before any mutation — is proven by
// tests/e2e/staged-proposal-observation.spec.js against the real built shell.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  assertObservationComplete, observationToIdentity, observationToPrescription,
  latestStagedObservation, stagedProposalObserverScript, STAGED_PROPOSALS_KEY,
} = require('../tests/e2e/gate/rehearsal-staged-proposal');

const REHEARSAL_SPEC = path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'rehearsal.spec.js');
const rehearsalSrc = fs.readFileSync(REHEARSAL_SPEC, 'utf8');

// A complete observation of Session 1's staged proposal: Bench Press → Incline
// Dumbbell Press, with the engine's three-set prescription.
const COMPLETE = Object.freeze({
  seq: 1,
  proposal_id: 'repl:BENCHPRESS->INCLINEDUMBBELLPRESS@SQ|OHP|RDL|BENCHPRESS|SR|BC',
  status: 'pending',
  plan_fingerprint: 'SQ|OHP|RDL|BENCHPRESS|SR|BC',
  position: 3,
  source_name: 'Bench Press',
  source_lift_code: 'BEN01',
  source_plan_item_id: 'pi_bench_0001',
  source_slot_name: 'Bench Press',
  source_accepted_set_count: 2,
  replacement_name: 'Incline Dumbbell Press',
  replacement_lift_code: 'IDB01',
  weight: 90,
  reps: 10,
  rir: 2,
  sets: 3,
  load_state: 'resolved',
  plan_names_at_staging: ['Back Squat', 'Overhead Press', 'Romanian Deadlift', 'Bench Press', 'Seated Row', 'Bicep Curl'],
  plan_index_at_staging: 3,
});

const withField = (patch) => ({ ...COMPLETE, ...patch });

describe('assertObservationComplete — fails closed on missing evidence', () => {
  it('accepts the complete Session 1 observation', () => {
    const r = assertObservationComplete(COMPLETE);
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  });

  it('NO observation is a failure, never "nothing was staged"', () => {
    for (const absent of [null, undefined, 0, '', []]) {
      const r = assertObservationComplete(absent);
      assert.equal(r.ok, false);
      assert.match(r.problems.join(' '), /no staged-proposal observation was captured/);
    }
  });

  // The exact defect this authority replaces: the phase-window inference produced a
  // BLANK lift code, and a blank must never be usable as an identity.
  it('a blank replacement lift code fails — the defect A shape', () => {
    for (const blank of ['', null, undefined, '   ']) {
      const r = assertObservationComplete(withField({ replacement_lift_code: blank }));
      assert.equal(r.ok, false, `lift code ${JSON.stringify(blank)} must not be an identity`);
      assert.match(r.problems.join(' '), /no replacement lift code/);
    }
  });

  it('a missing source plan_item_id fails — the outcome binding has nothing to be checked against', () => {
    const r = assertObservationComplete(withField({ source_plan_item_id: '' }));
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /no source plan_item_id from the live plan/);
  });

  it('a missing prescribed weight or reps fails', () => {
    assert.equal(assertObservationComplete(withField({ weight: null })).ok, false);
    assert.equal(assertObservationComplete(withField({ reps: null })).ok, false);
    assert.match(assertObservationComplete(withField({ weight: null })).problems.join(' '), /no prescribed weight/);
  });

  // `sets` is genuinely optional (a proposal may carry none), but "absent" must be an
  // EXPLICIT null so a consumer's fallback is a decision rather than an accident.
  it('an explicit null set count is accepted; any other non-count is refused', () => {
    assert.equal(assertObservationComplete(withField({ sets: null })).ok, true);
    for (const bad of [0, -1, 2.5, '3', undefined, NaN]) {
      assert.equal(assertObservationComplete(withField({ sets: bad })).ok, false,
        `sets=${JSON.stringify(bad)} must be refused, never silently defaulted`);
    }
  });

  it('a replacement equal to the source is not a replacement', () => {
    const r = assertObservationComplete(withField({ replacement_lift_code: 'BEN01' }));
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /equals the source lift/);
  });

  // "Captured before the mutation" is CHECKED, not asserted. A record taken after the
  // swap applied would show the source gone and the replacement present.
  it('an observation taken AFTER the mutation fails', () => {
    const after = withField({
      plan_names_at_staging: ['Back Squat', 'Overhead Press', 'Romanian Deadlift', 'Incline Dumbbell Press', 'Seated Row', 'Bicep Curl'],
      source_slot_name: 'Incline Dumbbell Press',
    });
    const r = assertObservationComplete(after);
    assert.equal(r.ok, false);
    const joined = r.problems.join(' ');
    assert.match(joined, /source Bench Press was already gone/);
    assert.match(joined, /replacement Incline Dumbbell Press was already in the plan/);
  });

  it('a proposal that resolved no live slot fails, and one that resolved the WRONG slot fails', () => {
    assert.match(assertObservationComplete(withField({ source_slot_name: '' })).problems.join(' '),
      /resolved no live plan slot/);
    assert.match(assertObservationComplete(withField({ source_slot_name: 'Seated Row' })).problems.join(' '),
      /resolved slot held "Seated Row", not the source "Bench Press"/);
  });

  it('an observation with no recorded plan state cannot claim "before the mutation"', () => {
    const r = assertObservationComplete(withField({ plan_names_at_staging: null }));
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /records no plan state/);
  });
});

describe('the observation projects exactly what its two consumers read', () => {
  it('observationToIdentity supplies the three fields compareReplacementIdentity compares', () => {
    assert.deepEqual(observationToIdentity(COMPLETE), {
      replacementLiftCode: 'IDB01', sourceLiftCode: 'BEN01', sourcePlanItemId: 'pi_bench_0001',
    });
  });

  it('observationToPrescription carries the ENGINE\'s set count, and null when it prescribed none', () => {
    assert.deepEqual(observationToPrescription(COMPLETE), {
      name: 'Incline Dumbbell Press', liftCode: 'IDB01', weight: 90, reps: 10, rir: 2, sets: 3,
    });
    assert.equal(observationToPrescription(withField({ sets: null })).sets, null);
    assert.equal(observationToPrescription(withField({ sets: 0 })).sets, null,
      'a non-count never becomes a count');
  });

  it('both projections stay empty/null on an absent observation rather than inventing a value', () => {
    assert.deepEqual(observationToIdentity(null), { replacementLiftCode: '', sourceLiftCode: '', sourcePlanItemId: '' });
    assert.deepEqual(observationToPrescription(null), { name: '', liftCode: '', weight: null, reps: null, rir: null, sets: null });
  });

  it('latestStagedObservation takes the NEWEST record, and null when there is none', () => {
    assert.equal(latestStagedObservation([]), null);
    assert.equal(latestStagedObservation(null), null);
    assert.equal(latestStagedObservation([{ seq: 1 }, { seq: 2 }]).seq, 2);
  });
});

describe('the observer installer', () => {
  it('is a plain function serializable into the page, keyed by the shared store name', () => {
    assert.equal(typeof stagedProposalObserverScript, 'function');
    assert.equal(STAGED_PROPOSALS_KEY, '__atlasStagedProposals');
    const src = stagedProposalObserverScript.toString();
    // It listens for the app's own staging announcement and reads the proposal's own
    // resolved slot — it must never re-match the source by name (a second authority)
    // and must never read a durable row.
    assert.match(src, /atlas:replacement-proposed/);
    assert.match(src, /p\.position/);
    assert.ok(!/durable|session_plan_sets|log_cleaned/i.test(src),
      'the observer must never read a durable surface');
  });
});

// The rehearsal spec itself runs only under the operator command against the sandbox,
// so CI cannot execute it. These pin its WIRING to the one authority and, just as
// importantly, pin the two losing inference paths as DELETED — a re-added one would
// otherwise sit in the file unexercised until the next live sweep found it again.
describe('the rehearsal spec consumes the one authority and keeps the losers deleted', () => {
  it('installs the observer and reads the observation for identity and prescription', () => {
    assert.match(rehearsalSrc, /addInitScript\(stagedProposalObserverScript, STAGED_PROPOSALS_KEY\)/,
      'the observer must be installed before any application script');
    assert.match(rehearsalSrc, /latestStagedObservation\(await readStagedProposals\(page, STAGED_PROPOSALS_KEY\)\)/);
    assert.match(rehearsalSrc, /assertObservationComplete\(observation\)/,
      'the capture-time completeness assertion must run at the seam');
    assert.match(rehearsalSrc, /observationToIdentity\(observation\)/);
    assert.match(rehearsalSrc, /observationToPrescription\(observation\)/);
    assert.match(rehearsalSrc, /replacement: sub \? \{ sourceName: sub\.sourceName, replacementName: sub\.name, sets: sub\.sets \}/,
      'the expected remaining work must carry the staged set count');
  });

  it('DEFECT A stays deleted — no phase-window recommend/next identity inference', () => {
    assert.ok(!/proposedReplacementLiftCodes/.test(rehearsalSrc),
      'the phase-tagged recommend/next collector must be gone, not merely unused');
    assert.ok(!/recommend\/next\/\(\[\^\/\?#\]\+\)/.test(rehearsalSrc)
      && !/page\.on\('request'/.test(rehearsalSrc),
      'no request hook may reconstruct the replacement identity from the wire');
    assert.ok(!/phase === 'substitution_ask'/.test(rehearsalSrc),
      'no identity may be filtered out of a phase window');
  });

  it('DEFECT B stays deleted — no hardcoded per-item set count beside the declared plan', () => {
    assert.ok(!/per_item_sets/.test(rehearsalSrc),
      'the accepted grain is SC.plan\'s, per item — never a second literal');
  });

  it('the proposal LINE is no longer parsed for identity or prescription', () => {
    assert.ok(!/function parseProposalLine/.test(rehearsalSrc),
      'provenance may not be derived from visible prose');
  });
});
