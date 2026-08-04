'use strict';

// F-SB4B scorecard bites (TEMPORARY; sunset: F-SB4C). Proves the frozen
// 25-condition scorecard in tests/e2e/gate/rehearsal-scorecard.js is a REAL
// gate: it fails closed on missing evidence (ERROR, never PASS), it turns a
// single planted violation into ineligibility, and — the F-SB4B point — a
// pre-seeded workout identity or a leaky session filter can never score
// rehearsal_eligible. A scorecard that passes an empty run would let the
// streak advance on nothing.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CONDITIONS, scoreRehearsalRun, renderMarkdown, compareLedgerToDeclaration, classifyRepeatApprovalProbe,
  classifySettlement, isSettled,
  deriveExpectedRemaining, compareRemainingToExpectation, replyMatchesExpectation,
  detectUnsupportedMutationWording, compareReplacementIdentity,
  pinMatchesExpectation, explicitNextUpClaim,
  classifyCoachResponseCapture, detectUnsupportedWriteClaim,
  PASS, FAIL, ERROR,
} = require('../tests/e2e/gate/rehearsal-scorecard');
const { sessionPlanSetsColumns } = require('../config/columns');
// The bubble-lifecycle collector is its own module: the page reports its text changes
// and Node stamps them on receipt, so a timestamp cannot be assigned by a later sweep.
const {
  ingestLiveObservation, reconcileSweep, recordsToMessages,
} = require('../tests/e2e/gate/rehearsal-bubble-observer');

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

// A fully-green Session-1-shaped observation set. Each bite below clones it and
// plants exactly one violation.
function greenObservations() {
  return {
    session_number: 1,
    run_purpose: 'REHEARSAL_SESSION',
    run_id: 'fsb4b-s1-20260803T000000-AA11BB',
    athlete_id: 'fsb4b-athlete-AA11BB',
    workout_session_id: '20260803-AM-01',
    workout_id_preseeded: false,
    source: {
      branch: 'main', clean: true, head_sha: HEAD, origin_head_sha: HEAD,
      prior_rehearsal_count: 0, prior_count_reason: null,
    },
    model: { posture: 'model-up', provider_reachable: true, coach_model: 'gemini-test', live_provider_turn_observed: true },
    sandbox: {
      rehearsal_live: true, sandbox_last6: 'ABC123', declared_last6: 'ABC123',
      preflight_ok: true, preflight_checks: [{ name: 'sandbox_reachable', ok: true }],
      child_carried_workbook_id: false,
    },
    ui: { real_browser: true, shell_build: 'build-test' },
    provenance: { request_origin: 'playwright', real_index_js: true },
    scenario: {
      id: 'session-1-full-flow',
      beats: [{ id: 'plan-accepted', ok: true }, { id: 'no-preseeded-identity', ok: true }],
      expected: {
        session_plans_events: { plan_accepted: 6, item_outcome: 1, session_closeout: 1 },
        plan_set_rows: 14,
        log_rows: 12,
        effort_supplied: true,
        closeout_fully_verified: true,
      },
    },
    claims: { unsupported_mutation_wording: false, unsupported_write_claim: false },
    state_agreement: [{ id: 'bench-current', ok: true }],
    durable: {
      session_plans: { event_counts: [{ event: 'plan_accepted', count: 6 }, { event: 'item_outcome', count: 1 }, { event: 'session_closeout', count: 1 }] },
      session_plan_sets: { row_count: 14, distinct_seals: 1, blank_seals: 0, accepted_grain_ok: true, declared_multiset_ok: true, multiset_detail: '' },
      log_cleaned: { row_count: 12, rows_match_declaration: true },
      effort: { row_count: 1 },
      foreign_rows: 0,
      foreign_id_probe_status: 403,
    },
    write: {
      preview_seen: true, preview_no_write_confirmed: true, preview_before_write: true,
      approvals_clicked: 1, write_success: true,
      repeat_attempted: true, repeat_outcome: 'refused-disabled-control', duplicate_rows: 0,
    },
    closeout: { fully_verified: true, ui_stuck_saving: false, final_state_ok: true },
    trace: { join_ok: true, turn_id: 'turn-live-write' },
    review: { found_exact_session: true, all_unknown: false, failed_criteria: [] },
    weekly: { status: 200, valid_body: true },
    artifacts: { swept: true, leaks: [], files: [{ name: 'scorecard.json', sha256: 'b'.repeat(64) }] },
    guard: { ensure_tab_calls: 0, refusals: 0, seal_updates: 1 },
  };
}

function condition(card, id) {
  const c = card.conditions.find((x) => x.id === id);
  assert.ok(c, `condition ${id} must be emitted`);
  return c;
}

describe('the frozen condition list', () => {
  it('holds exactly 25 conditions with unique ids, always all emitted', () => {
    assert.equal(CONDITIONS.length, 25);
    assert.equal(new Set(CONDITIONS.map((c) => c.id)).size, 25);
    const card = scoreRehearsalRun({});
    assert.equal(card.conditions.length, 25);
    assert.equal(Object.isFrozen(CONDITIONS), true);
  });
});

describe('fail-closed on missing evidence', () => {
  it('scores a completely empty run as ERROR-dominated and ineligible — never PASS', () => {
    const card = scoreRehearsalRun({});
    assert.equal(card.rehearsal_eligible, false);
    assert.equal(card.overall, ERROR);
    assert.equal(card.counts.PASS, 0);
    for (const c of card.conditions) {
      assert.notEqual(c.status, PASS, `${c.id} must not PASS on no evidence`);
    }
  });

  it('a single deleted evidence branch turns its condition ERROR, not PASS or FAIL', () => {
    const obs = greenObservations();
    delete obs.write;
    const card = scoreRehearsalRun(obs);
    assert.equal(condition(card, 'preview_before_write').status, ERROR);
    assert.equal(condition(card, 'browser_approval').status, ERROR);
    assert.equal(card.rehearsal_eligible, false);
  });

  it('a throwing evaluator degrades to ERROR rather than crashing the card', () => {
    const obs = greenObservations();
    obs.scenario = { get beats() { throw new Error('boom'); } };
    const card = scoreRehearsalRun(obs);
    assert.equal(condition(card, 'declared_conversation_observed').status, ERROR);
    assert.equal(card.rehearsal_eligible, false);
  });
});

describe('the fully-green run', () => {
  it('scores PASS on all 25 conditions and is rehearsal-eligible', () => {
    const card = scoreRehearsalRun(greenObservations());
    const notPass = card.conditions.filter((c) => c.status !== PASS);
    assert.deepEqual(notPass, [], JSON.stringify(notPass, null, 2));
    assert.equal(card.overall, PASS);
    assert.equal(card.rehearsal_eligible, true);
    assert.match(card.rehearsal_note, /qualifies as rehearsal session 1/);
  });
});

describe('identity-isolation bites (the F-SB4B point)', () => {
  it('a pre-seeded workout id carrying the runner family marker FAILS fresh_identities', () => {
    const obs = greenObservations();
    obs.workout_session_id = 'fsb4b-s1-20260803T000000-AA11BB';
    const card = scoreRehearsalRun(obs);
    const c = condition(card, 'fresh_identities');
    assert.equal(c.status, FAIL);
    assert.match(c.detail, /pre-seeded identity bypasses the server allocator/);
    assert.equal(card.rehearsal_eligible, false);
  });

  it('a workout id present BEFORE acceptance FAILS even when server-shaped', () => {
    const obs = greenObservations();
    obs.workout_id_preseeded = true;
    const card = scoreRehearsalRun(obs);
    assert.equal(condition(card, 'fresh_identities').status, FAIL);
    assert.equal(card.rehearsal_eligible, false);
  });

  it('a run id from another session ERRORs fresh_identities — stale artifacts cannot qualify', () => {
    const obs = greenObservations();
    obs.run_id = 'fsb4b-s2-20260803T000000-AA11BB';
    const card = scoreRehearsalRun(obs);
    assert.equal(condition(card, 'fresh_identities').status, ERROR);
    assert.equal(card.rehearsal_eligible, false);
  });

  it('a verifier that serves a foreign identity (non-403) FAILS no_cross_session_rows', () => {
    const obs = greenObservations();
    obs.durable.foreign_id_probe_status = 200;
    const card = scoreRehearsalRun(obs);
    const c = condition(card, 'no_cross_session_rows');
    assert.equal(c.status, FAIL);
    assert.match(c.detail, /expected 403/);
    assert.equal(card.rehearsal_eligible, false);
  });

  it('any foreign row riding along FAILS no_cross_session_rows', () => {
    const obs = greenObservations();
    obs.durable.foreign_rows = 2;
    const card = scoreRehearsalRun(obs);
    assert.equal(condition(card, 'no_cross_session_rows').status, FAIL);
  });
});

describe('write-safety and posture bites', () => {
  const bites = [
    ['two approval clicks', (o) => { o.write.approvals_clicked = 2; }, 'browser_approval'],
    ['a duplicate row after the repeat probe', (o) => { o.write.duplicate_rows = 1; }, 'approval_at_most_once'],
    ['a skipped repeat probe is ERROR-not-PASS', (o) => { o.write.repeat_attempted = false; }, 'approval_at_most_once'],
    ['a disabled/no-op repeat click with no affirmative evidence', (o) => { o.write.repeat_outcome = 'no-op-unproven'; }, 'approval_at_most_once'],
    ['a repeat probe with no recorded outcome at all', (o) => { delete o.write.repeat_outcome; }, 'approval_at_most_once'],
    ['a ledger that fails the declared multiset comparison', (o) => { o.durable.session_plan_sets.declared_multiset_ok = false; o.durable.session_plan_sets.multiset_detail = 'revision set 1 is attached to item pi_wrong'; }, 'session_plan_sets_binding_and_seal'],
    ['a preview without the no-write proof', (o) => { o.write.preview_no_write_confirmed = false; }, 'preview_before_write'],
    ['no live-provider turn observed', (o) => { o.model.live_provider_turn_observed = false; }, 'model_posture_proven'],
    ['a served workbook that is not the declared sandbox', (o) => { o.sandbox.sandbox_last6 = 'ZZZZZZ'; }, 'sandbox_posture_proven'],
    ['an inherited ambient workbook id', (o) => { o.sandbox.child_carried_workbook_id = true; }, 'ambient_sheet_not_inherited'],
    ['a second closeout seal', (o) => { o.durable.session_plan_sets.distinct_seals = 2; }, 'session_plan_sets_binding_and_seal'],
    ['an unsealed ledger row', (o) => { o.durable.session_plan_sets.blank_seals = 1; }, 'session_plan_sets_binding_and_seal'],
    ['a missing Session_Plans event', (o) => { o.durable.session_plans.event_counts = [{ event: 'plan_accepted', count: 5 }]; }, 'session_plans_events_exact'],
    ['an unexpected extra durable event', (o) => { o.durable.session_plans.event_counts.push({ event: 'plan_revised', count: 1 }); }, 'session_plans_events_exact'],
    ['a wrong Log_Cleaned row count', (o) => { o.durable.log_cleaned.row_count = 11; }, 'durable_log_rows_exact'],
    ['an Effort row when none was supplied', (o) => { o.scenario.expected.effort_supplied = false; }, 'effort_behavior_matches'],
    ['a guard refusal during the run', (o) => { o.guard.refusals = 1; }, 'schema_and_guard_clean'],
    ['an attempted schema mutation', (o) => { o.guard.ensure_tab_calls = 1; }, 'schema_and_guard_clean'],
    ['unsupported completed-mutation wording', (o) => { o.claims.unsupported_mutation_wording = true; }, 'no_unsupported_claims'],
    ['a failed declared beat', (o) => { o.scenario.beats[0] = { id: 'plan-accepted', ok: false, detail: 'never shown' }; }, 'declared_conversation_observed'],
    ['a closeout stuck on Saving…', (o) => { o.closeout.ui_stuck_saving = true; }, 'closeout_state_correct'],
    ['a broken trace/write-proof join', (o) => { o.trace.join_ok = false; }, 'trace_write_join'],
    ['an all-UNKNOWN review verdict', (o) => { o.review.all_unknown = true; }, 'review_tool_adjudicates'],
    ['a 500 from the weekly summary', (o) => { o.weekly.status = 500; }, 'weekly_summary_succeeds'],
    ['a leaked full workbook id in artifacts', (o) => { o.artifacts.leaks = ['full workbook id in scorecard.json']; }, 'artifacts_privacy_safe'],
    ['an unhashed artifact', (o) => { o.artifacts.files = [{ name: 'x.json', sha256: 'nope' }]; }, 'artifacts_hashed'],
  ];

  for (const [name, plant, conditionId] of bites) {
    it(`bites on ${name}`, () => {
      const obs = greenObservations();
      plant(obs);
      const card = scoreRehearsalRun(obs);
      const c = condition(card, conditionId);
      assert.notEqual(c.status, PASS, `${conditionId} must not PASS: ${c.detail}`);
      assert.equal(card.rehearsal_eligible, false, name);
    });
  }
});

describe('rendering', () => {
  it('renders every condition and the eligibility verdict', () => {
    const card = scoreRehearsalRun(greenObservations());
    const md = renderMarkdown(card);
    assert.match(md, /rehearsal_eligible: true/);
    for (const c of card.conditions) assert.ok(md.includes(c.id), c.id);
  });
});

// ── the repeat-approval classification — a DOM dispatch is not evidence ─────────
// Owner contract review (PR #1254): the probe's own listener firing proves only
// that a DOM event dispatched. A neutralized application handler, or an enabled
// no-op control, leaves the dispatch observable while no save request occurs —
// that must classify no-op-unproven, and no-op-unproven can never PASS.
describe('classifyRepeatApprovalProbe', () => {
  const base = { control_present: true, disabled_at_click: false, dispatched: true, live_saves_before: 1, live_saves_after: 1 };

  it('an observed second live save request is handler-invoked', () => {
    assert.equal(classifyRepeatApprovalProbe({ ...base, live_saves_after: 2 }), 'handler-invoked');
  });

  it('a disabled control with proven no-dispatch and no request is refused-disabled-control', () => {
    assert.equal(classifyRepeatApprovalProbe({ ...base, disabled_at_click: true, dispatched: false }), 'refused-disabled-control');
  });

  it('an ENABLED control whose click dispatched but produced NO request is no-op-unproven (neutralized handler)', () => {
    assert.equal(classifyRepeatApprovalProbe(base), 'no-op-unproven');
  });

  it('a dispatch on a disabled-reported control is no-op-unproven (contradictory evidence)', () => {
    assert.equal(classifyRepeatApprovalProbe({ ...base, disabled_at_click: true, dispatched: true }), 'no-op-unproven');
  });

  it('a missing control and unknown request counts are no-op-unproven', () => {
    assert.equal(classifyRepeatApprovalProbe({ control_present: false, dispatched: false }), 'no-op-unproven');
    assert.equal(classifyRepeatApprovalProbe({}), 'no-op-unproven');
  });

  it('a neutralized-handler probe can never score approval_at_most_once PASS end-to-end', () => {
    const obs = greenObservations();
    obs.write.repeat_outcome = classifyRepeatApprovalProbe(base); // enabled, dispatched, no request
    obs.write.repeat_attempted = obs.write.repeat_outcome !== 'no-op-unproven';
    const card = scoreRehearsalRun(obs);
    const c = card.conditions.find(x => x.id === 'approval_at_most_once');
    assert.notEqual(c.status, PASS);
    assert.equal(card.rehearsal_eligible, false);
  });
});

// ── the declared ledger multiset — mutation proofs (owner P1, 2026-08-03) ───────
// A valid Session-1-shaped 14-row ledger, mirroring the REAL durable rows the
// harness wrote (accepted v1 grain + two live_revision rows superseding the same-set
// accepted Bench rows, one seal). Each bite plants exactly one corruption that
// PRESERVES the row/item/seal counts the old check relied on.
describe('compareLedgerToDeclaration', () => {
  const SEAL = 'wr_20260803_0001';
  const COL = (name) => sessionPlanSetsColumns.indexOf(name);

  function row(over = {}) {
    const base = {
      idempotency_key: 'k', session_id: '20260803-AM-09', session_date: '2026-08-03',
      plan_version: '1', plan_item_id: 'pi_x', planned_lift_code: 'SQ01', set_index: '1',
      target_set_count: '2', target_weight: '225', target_reps: '5', target_rir: '2',
      recommendation_source: 'accepted', supersedes_key: '', confidence: 'reliable',
      closeout_write_id: SEAL, recorded_at: '2026-08-03T18:00:00.000Z',
    };
    const rec = { ...base, ...over };
    return sessionPlanSetsColumns.map((c) => (rec[c] == null ? '' : String(rec[c])));
  }

  const ITEMS = [
    { item: 'pi_sq', lift: 'SQ01', weight: 225, reps: 5, rir: 2 },
    { item: 'pi_ohp', lift: 'OHP01', weight: 110, reps: 6, rir: 2 },
    { item: 'pi_rdl', lift: 'RDL01', weight: 235, reps: 5, rir: 2 },
    { item: 'pi_ben', lift: 'BEN01', weight: 215, reps: 5, rir: 2 },
    { item: 'pi_sr', lift: 'SR01', weight: 205, reps: 10, rir: 2 },
    { item: 'pi_bc', lift: 'BC01', weight: 35, reps: 15, rir: 2 },
  ];

  function validLedger() {
    const rows = [];
    for (const it of ITEMS) {
      for (const set of [1, 2]) {
        rows.push(row({
          idempotency_key: `k_${it.item}_${set}`, plan_item_id: it.item, planned_lift_code: it.lift,
          set_index: String(set), target_weight: String(it.weight), target_reps: String(it.reps), target_rir: String(it.rir),
        }));
      }
    }
    for (const set of [1, 2]) {
      rows.push(row({
        idempotency_key: `k_rev_${set}`, plan_item_id: 'pi_ben', planned_lift_code: 'IDB01',
        set_index: String(set), plan_version: '2', recommendation_source: 'live_revision',
        supersedes_key: `k_pi_ben_${set}`, target_weight: '55', target_reps: '8', target_rir: '',
      }));
    }
    return rows;
  }

  const declaration = () => ({
    accepted: ITEMS.map((it) => ({ lift: it.lift, set_count: 2, weight: it.weight, reps: it.reps, rir: it.rir })),
    revisions: {
      source_lift: 'BEN01', replacement_lift: 'IDB01', rows: 2, set_indexes: [1, 2],
      source: 'live_revision', plan_version: 2, weight: 55, reps: 8, rir: null,
    },
    confidence: 'reliable',
  });

  it('accepts the exact declared multiset (the real Session-1 durable shape)', () => {
    const r = compareLedgerToDeclaration(validLedger(), declaration());
    assert.deepEqual(r, { ok: true, problems: [] });
  });

  const bites = [
    ['a revision attached to the wrong plan_item_id', (rows) => {
      rows[12][COL('plan_item_id')] = 'pi_sq';
    }, /attached to item pi_sq|supersession/],
    ['a duplicate accepted row standing in for a revision row', (rows) => {
      rows[13] = row({ idempotency_key: 'k_dup', plan_item_id: 'pi_ben', planned_lift_code: 'BEN01', set_index: '2' });
    }, /set indexes|revision/],
    ['a wrong revision set index', (rows) => {
      rows[13][COL('set_index')] = '3';
    }, /set indexes/],
    ['a missing revision row', (rows) => {
      rows.pop();
    }, /expected 2 revision row/],
    ['an unexpected extra revision row', (rows) => {
      rows.push(row({ idempotency_key: 'k_rev_3', plan_item_id: 'pi_ben', planned_lift_code: 'IDB01', set_index: '1', plan_version: '3', recommendation_source: 'live_revision', supersedes_key: 'k_rev_1', target_weight: '55', target_reps: '8', target_rir: '' }));
    }, /expected 2 revision row|total rows/],
    ['a broken supersession chain (revision superseding the wrong-set accepted row)', (rows) => {
      rows[12][COL('supersedes_key')] = 'k_pi_ben_2';
    }, /broken supersession/],
    ['a dangling supersession key the engine itself refuses', (rows) => {
      rows[12][COL('supersedes_key')] = 'k_never_existed';
    }, /broken supersession|malformed_chain/],
    ['a mismatched seal on one row', (rows) => {
      rows[5][COL('closeout_write_id')] = 'wr_other_seal';
    }, /different closeout seals|mismatched seal/],
    ['an unsealed row', (rows) => {
      rows[5][COL('closeout_write_id')] = '';
    }, /no closeout seal/],
    ['a wrong accepted weight (counts all still match)', (rows) => {
      rows[0][COL('target_weight')] = '135';
    }, /weight 135, declared 225/],
    ['a wrong replacement lift on a revision', (rows) => {
      rows[12][COL('planned_lift_code')] = 'BEN01';
      rows[13][COL('planned_lift_code')] = 'BEN01';
    }, /expected the replacement IDB01/],
    ['a foreign session identity riding along', (rows) => {
      rows[3][COL('session_id')] = '20260803-PM-99';
    }, /session identities/],
    ['an inflated revision target_set_count beyond the immutable accepted grain (owner P1, #1254)', (rows) => {
      rows[12][COL('target_set_count')] = '99';
      rows[13][COL('target_set_count')] = '99';
    }, /differs from the immutable accepted grain 2/],
    ['a revision carrying no_reliable_target confidence', (rows) => {
      rows[12][COL('confidence')] = 'no_reliable_target';
    }, /confidence "no_reliable_target", declared "reliable"/],
    ['an accepted row carrying the wrong confidence', (rows) => {
      rows[0][COL('confidence')] = 'no_reliable_target';
    }, /accepted SQ01 set 1: confidence/],
  ];

  for (const [name, corrupt, re] of bites) {
    it(`bites on ${name}`, () => {
      const rows = validLedger();
      corrupt(rows);
      const r = compareLedgerToDeclaration(rows, declaration());
      assert.equal(r.ok, false, name);
      assert.ok(r.problems.some((p) => re.test(p)), `${name}: ${JSON.stringify(r.problems)}`);
    });
  }

  it('fails closed on zero rows and on a declaration with no revisions but revision rows present', () => {
    assert.equal(compareLedgerToDeclaration([], declaration()).ok, false);
    const d = declaration();
    d.revisions = null;
    const r = compareLedgerToDeclaration(validLedger(), d);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /declares no revisions/.test(p)));
  });
});


// ── DEBUG versus QUALIFYING purpose (owner instruction 2026-08-03) ─────────────
// The claims this must prove, end to end on the REAL fully-green fixture:
//   1. a debug Session 2 at count 0/5 can score every condition PASS,
//   2. and is still ineligible,
//   3. while a qualifying Session 2 at count 0/5 fails,
//   4. and no debug result can advance the count.

describe('run purpose — a debug sweep is possible from exact main, and never counts', () => {
  // Session 2 at canonical count 0/5: the exact shape that was impossible before.
  function sessionTwoAtCountZero(purpose) {
    const obs = greenObservations();
    obs.session_number = 2;
    obs.run_purpose = purpose;
    obs.run_id = 'fsb4b-s2-20260803T000000-AA11BB';
    obs.source.prior_rehearsal_count = 0;   // NOT 1 — the count has not advanced
    return obs;
  }

  it('a DEBUG session 2 at count 0/5 scores every condition PASS', () => {
    const card = scoreRehearsalRun(sessionTwoAtCountZero('REHEARSAL_DEBUG'));
    const notPassing = card.conditions.filter(c => c.status !== PASS);
    assert.deepEqual(notPassing.map(c => `${c.id}=${c.status}: ${c.detail}`), [],
      'a clean diagnostic run must be able to score 25/25 — that is the whole point of the purpose');
    assert.equal(card.overall, PASS);
    assert.equal(card.counts.PASS, CONDITIONS.length);
  });

  it('…and is STILL ineligible, with the reason stated', () => {
    const card = scoreRehearsalRun(sessionTwoAtCountZero('REHEARSAL_DEBUG'));
    assert.equal(card.overall, PASS, 'precondition: it really did score clean');
    assert.equal(card.rehearsal_eligible, false, 'a full score must not make a diagnostic run eligible');
    assert.equal(card.diagnostic, true);
    assert.match(card.rehearsal_note, /never advance or authorize the rehearsal count/);
  });

  it('a QUALIFYING session 2 at count 0/5 REFUSES on the count', () => {
    const card = scoreRehearsalRun(sessionTwoAtCountZero('REHEARSAL_SESSION'));
    const source = card.conditions.find(c => c.id === 'source_tree_verified');
    assert.equal(source.status, FAIL, `expected a count FAIL; got ${source.status}: ${source.detail}`);
    assert.match(source.detail, /legal only at count 1\/5/);
    assert.equal(card.rehearsal_eligible, false);
  });

  it('the same qualifying session 2 PASSES once the count really is 1/5', () => {
    const obs = sessionTwoAtCountZero('REHEARSAL_SESSION');
    obs.source.prior_rehearsal_count = 1;
    const card = scoreRehearsalRun(obs);
    assert.equal(card.overall, PASS, card.conditions.filter(c => c.status !== PASS).map(c => `${c.id}: ${c.detail}`).join('; '));
    assert.equal(card.rehearsal_eligible, true, 'a legal, clean qualifying run is the ONE case that may advance the streak');
  });

  it('no debug result can advance the count, at any session number or count', () => {
    for (let n = 1; n <= 5; n += 1) {
      for (let prior = 0; prior <= 5; prior += 1) {
        const obs = greenObservations();
        obs.session_number = n;
        obs.run_purpose = 'REHEARSAL_DEBUG';
        obs.run_id = `fsb4b-s${n}-20260803T000000-AA11BB`;
        obs.source.prior_rehearsal_count = prior;
        const card = scoreRehearsalRun(obs);
        assert.equal(card.rehearsal_eligible, false,
          `debug session ${n} at count ${prior}/5 must never be eligible`);
      }
    }
  });

  it('the source condition still bites a debug run on a genuinely bad tree', () => {
    for (const [label, patch] of [
      ['off-main', s => { s.branch = 'feature/x'; }],
      ['dirty', s => { s.clean = false; }],
      ['stale head', s => { s.origin_head_sha = 'b'.repeat(40); }],
      ['unreadable count', s => { s.prior_rehearsal_count = null; s.prior_count_reason = 'no marker'; }],
    ]) {
      const obs = sessionTwoAtCountZero('REHEARSAL_DEBUG');
      patch(obs.source);
      const card = scoreRehearsalRun(obs);
      const source = card.conditions.find(c => c.id === 'source_tree_verified');
      assert.notEqual(source.status, PASS, `a debug run must still fail on ${label}`);
      assert.equal(card.rehearsal_eligible, false);
    }
  });
});


// ── reply settlement: a partial fragment can never satisfy it ─────────────────
// The deterministic race bite for the Session 2 failure. The observer accepted the
// trailing fragment "ve." while the server had served the complete reply
// (message_len 167 and 321 in the coach-turn shadow). No browser and no timing are
// involved here: the decision is pure, so the race is reproduced as data.

describe('classifySettlement — completion, not brief quiet', () => {
  const FULL = 'Go with 185 lb for 5 reps at RIR 2 on the incline dumbbell press, and keep the same tempo.';

  it('REFUSES the exact Session 2 fragment, no matter how long it has been quiet', () => {
    for (const quietMs of [750, 5000, 60000, Number.MAX_SAFE_INTEGER]) {
      const outcome = classifySettlement({ text: 've.', servedMessages: [FULL], stableForMs: quietMs });
      assert.equal(outcome, 'partial-render', `a fragment quiet for ${quietMs}ms must not settle`);
      assert.equal(isSettled(outcome), false);
    }
  });

  it('refuses ANY strict prefix, suffix, or middle slice of the served reply', () => {
    const slices = [
      FULL.slice(0, 1), FULL.slice(0, 20), FULL.slice(0, FULL.length - 1),
      FULL.slice(5), FULL.slice(-3), FULL.slice(10, 40),
    ];
    for (const partial of slices) {
      const outcome = classifySettlement({ text: partial, servedMessages: [FULL], stableForMs: 10000 });
      assert.equal(isSettled(outcome), false, `partial "${partial.slice(0, 24)}…" must not settle`);
    }
  });

  it('settles only once the WHOLE served reply is on screen — immediately, without waiting', () => {
    const outcome = classifySettlement({ text: FULL, servedMessages: [FULL], stableForMs: 0 });
    assert.equal(outcome, 'served-complete');
    assert.equal(isSettled(outcome), true);
  });

  it('tolerates DOM re-wrapping, which changes whitespace but not content', () => {
    const rewrapped = `  ${FULL.replace(/ /g, '\n  ')}  `;
    assert.equal(classifySettlement({ text: rewrapped, servedMessages: [FULL], stableForMs: 0 }), 'served-complete');
  });

  it('settles a decorated bubble that CONTAINS the served reply plus client chrome', () => {
    const decorated = `${FULL} Undo`;
    assert.equal(classifySettlement({ text: decorated, servedMessages: [FULL], stableForMs: 0 }), 'served-complete');
  });

  it('never settles while the Thinking placeholder is showing, however quiet', () => {
    const outcome = classifySettlement({ text: 'Thinking…', servedMessages: [FULL], stableForMs: 999999 });
    assert.equal(outcome, 'thinking');
    assert.equal(isSettled(outcome), false);
  });

  it('never settles an empty bubble', () => {
    for (const text of ['', '   ', '\n\n']) {
      assert.equal(classifySettlement({ text, servedMessages: [], stableForMs: 999999 }), 'empty');
    }
  });

  it('falls back to stability ONLY when no message was served — and not before the threshold', () => {
    assert.equal(classifySettlement({ text: 'Noted.', servedMessages: [], stableForMs: 749 }), 'growing');
    assert.equal(classifySettlement({ text: 'Noted.', servedMessages: [], stableForMs: 750 }), 'stable-no-served-message');
    assert.equal(isSettled('stable-no-served-message'), true);
  });

  it('picks the right reply when several were served in the window', () => {
    const other = 'A different reply from an earlier turn in this window.';
    assert.equal(classifySettlement({ text: FULL, servedMessages: [other, FULL], stableForMs: 0 }), 'served-complete');
    // …and a fragment of one while another is complete is still a partial render.
    assert.equal(classifySettlement({ text: 've.', servedMessages: [other, FULL], stableForMs: 10000 }), 'partial-render');
  });

  it('fails closed on malformed observations rather than settling', () => {
    for (const bad of [undefined, null, {}, { text: null }, { text: 'x', servedMessages: 'not-an-array' }]) {
      const outcome = classifySettlement(bad);
      assert.equal(typeof outcome, 'string');
      if (outcome === 'stable-no-served-message') {
        assert.ok(bad && bad.text, 'only a real, quiet, unserved text may settle');
      }
    }
  });
});


// ── remaining work: the declaration owns the expectation ─────────────────────
// The Session 3 defect: the proof read client state and passed when the reply
// repeated it, so a WRONG state and a FAITHFUL reply agreed and both were wrong.

describe('deriveExpectedRemaining — independent of client state and reply', () => {
  const PLAN = [
    { exercise: 'Back Squat', target_sets: 2 },
    { exercise: 'Overhead Press', target_sets: 2 },
    { exercise: 'Romanian Deadlift', target_sets: 2 },
    { exercise: 'Bench Press', target_sets: 2 },
    { exercise: 'Seated Row', target_sets: 2 },
    { exercise: 'Bicep Curl', target_sets: 2 },
  ];
  const SWAP = { sourceName: 'Bench Press', replacementName: 'Incline Dumbbell Press' };
  const logged = (...names) => names;

  it('an untouched plan leaves every lift remaining, in order', () => {
    const e = deriveExpectedRemaining({ plan: PLAN, loggedNames: [], replacement: null });
    assert.deepEqual(e.remaining, PLAN.map(p => p.exercise));
    assert.equal(e.nextUp, 'Back Squat');
    assert.deepEqual(e.complete, []);
  });

  it('a lift is complete only when its FULL declared set count is logged', () => {
    const one = deriveExpectedRemaining({ plan: PLAN, loggedNames: logged('back squat'), replacement: null });
    assert.equal(one.nextUp, 'Back Squat', 'one of two sets does not complete a lift');
    const two = deriveExpectedRemaining({ plan: PLAN, loggedNames: logged('back squat', 'back squat'), replacement: null });
    assert.equal(two.nextUp, 'Overhead Press');
    assert.deepEqual(two.complete, ['Back Squat']);
  });

  it('an accepted substitution takes the source slot and POSITION, and retires the source', () => {
    const e = deriveExpectedRemaining({ plan: PLAN, loggedNames: [], replacement: SWAP });
    assert.deepEqual(e.remaining, ['Back Squat', 'Overhead Press', 'Romanian Deadlift', 'Incline Dumbbell Press', 'Seated Row', 'Bicep Curl'],
      'the replacement must occupy the source position, not be appended');
    assert.deepEqual(e.retired, ['Bench Press']);
  });

  // THE BITE the owner asked for: client state and the reply AGREE with each other and
  // disagree with the declaration. Both must fail, on their own grounds.
  it('BITE — a corrupt client state and a reply that faithfully repeats it BOTH fail', () => {
    const e = deriveExpectedRemaining({
      plan: PLAN,
      loggedNames: logged('back squat', 'back squat', 'overhead press', 'overhead press',
        'romanian deadlift', 'romanian deadlift', 'incline dumbbell press', 'incline dumbbell press'),
      replacement: SWAP,
    });
    assert.deepEqual(e.remaining, ['Seated Row', 'Bicep Curl']);

    // The corruption: the substituted-away Bench Press is still listed as remaining.
    const corruptState = ['Bench Press', 'Seated Row', 'Bicep Curl'];
    const stateCmp = compareRemainingToExpectation(corruptState, e);
    assert.equal(stateCmp.ok, false, 'a wrong client state must fail against the declaration');

    // The reply agrees with that wrong state — the exact false green being removed.
    const faithfulReply = 'You still have Bench Press, Seated Row and Bicep Curl left.';
    const replyCmp = replyMatchesExpectation(faithfulReply, e);
    assert.equal(replyCmp.ok, false, 'a reply repeating a wrong state must fail against the declaration');
    assert.match(replyCmp.problems.join(' '), /accepted substitution removed from the plan/);
  });

  // F-SB4B corrective 3. The substitute's set count belongs to the ENGINE, not to the
  // scenario freeze: `applySessionSubstitution` puts the proposal's prescribed count on
  // the slot. Session 1 declared 2 and the engine prescribed 3, so the expectation
  // called the substitute complete after two sets while the product correctly still
  // listed it — a harness defect scored against a correct product on two runs.
  it('the substitute\'s set count comes from the STAGED prescription, not the declared plan', () => {
    const loggedNames = logged('back squat', 'back squat', 'overhead press', 'overhead press',
      'romanian deadlift', 'romanian deadlift', 'incline dumbbell press', 'incline dumbbell press');
    // Declared 2 (the defect): two logged sets "complete" the substitute.
    const declared = deriveExpectedRemaining({ plan: PLAN, loggedNames, replacement: SWAP });
    assert.deepEqual(declared.remaining, ['Seated Row', 'Bicep Curl']);
    // Staged 3 (the truth): two of three sets leave it outstanding, in its own position.
    const staged = deriveExpectedRemaining({
      plan: PLAN, loggedNames, replacement: { ...SWAP, sets: 3 },
    });
    assert.deepEqual(staged.remaining, ['Incline Dumbbell Press', 'Seated Row', 'Bicep Curl']);
    assert.equal(staged.nextUp, 'Incline Dumbbell Press');
    assert.ok(!staged.complete.includes('Incline Dumbbell Press'));
  });

  it('a staged set count applies ONLY to the substituted slot', () => {
    const e = deriveExpectedRemaining({
      plan: PLAN,
      loggedNames: logged('back squat', 'back squat', 'incline dumbbell press', 'incline dumbbell press', 'incline dumbbell press'),
      replacement: { ...SWAP, sets: 3 },
    });
    assert.deepEqual(e.complete, ['Back Squat', 'Incline Dumbbell Press'],
      'the substitute completes at its own prescribed count; every other slot keeps the declared one');
    assert.deepEqual(e.remaining, ['Overhead Press', 'Romanian Deadlift', 'Seated Row', 'Bicep Curl']);
  });

  it('an absent or unusable staged set count falls back to the source\'s declared count', () => {
    const loggedNames = logged('incline dumbbell press', 'incline dumbbell press');
    for (const sets of [null, undefined, 0, -1, 2.5, '3']) {
      const e = deriveExpectedRemaining({ plan: PLAN, loggedNames, replacement: { ...SWAP, sets } });
      assert.ok(e.complete.includes('Incline Dumbbell Press'),
        `sets=${JSON.stringify(sets)} must fall back to the declared 2, never be treated as a real count`);
    }
  });

  it('order matters — the same set of lifts in the wrong order fails', () => {
    const e = deriveExpectedRemaining({ plan: PLAN, loggedNames: [], replacement: null });
    assert.equal(compareRemainingToExpectation(e.remaining.slice().reverse(), e).ok, false);
    assert.equal(compareRemainingToExpectation(e.remaining, e).ok, true);
  });

  it('a reply omitting a genuinely remaining lift fails', () => {
    const e = deriveExpectedRemaining({ plan: PLAN, loggedNames: [], replacement: null });
    assert.equal(replyMatchesExpectation('You have Back Squat left.', e).ok, false);
  });

  it('a reply naming an already-complete lift fails', () => {
    const e = deriveExpectedRemaining({
      plan: PLAN, loggedNames: logged('back squat', 'back squat'), replacement: null,
    });
    assert.equal(replyMatchesExpectation(`Left: ${e.remaining.join(', ')}, and Back Squat.`, e).ok, false);
  });

  it('does not treat a shared first word as a match — "Bench" is not "Bench Press"', () => {
    const e = { remaining: ['Bench Press'], complete: [], retired: [] };
    assert.equal(replyMatchesExpectation('Next up: Bench.', e).ok, false,
      'a partial name must not satisfy a full-name expectation');
    assert.equal(replyMatchesExpectation('Next up: Bench Press.', e).ok, true);
  });

  it('fails closed on a missing or malformed observation', () => {
    const e = deriveExpectedRemaining({ plan: PLAN, loggedNames: [], replacement: null });
    for (const bad of [null, undefined, 'not-an-array', 42]) {
      assert.equal(compareRemainingToExpectation(bad, e).ok, false);
    }
    assert.equal(compareRemainingToExpectation(['x'], null).ok, false);
  });
});

// ── the claim sweep: no constant may stand in for evidence ───────────────────

describe('detectUnsupportedMutationWording — derived, phase-bounded, fails closed', () => {
  const claim = 'Done — I\'ve noted the substitution for you.';

  it('BITE — completed-mutation wording BEFORE the mutation fails condition 9', () => {
    const sweep = detectUnsupportedMutationWording({
      messages: [{ text: claim, atMs: 100, phase: 'substitution_ask' }],
      mutationAtMs: 500,
    });
    assert.equal(sweep.unsupported, true);
    assert.match(sweep.detail, /before the mutation/);

    // …and the scorecard condition it feeds actually turns red.
    const obs = greenObservations();
    obs.claims = { unsupported_mutation_wording: sweep.unsupported, unsupported_write_claim: false, detail: sweep.detail };
    const card = scoreRehearsalRun(obs);
    const cond = card.conditions.find(c => c.id === 'no_unsupported_claims');
    assert.equal(cond.status, FAIL, 'condition 9 must fail on unsupported completed-mutation wording');
    assert.equal(card.rehearsal_eligible, false);
  });

  it('the SAME wording after the mutation is honest and passes', () => {
    const sweep = detectUnsupportedMutationWording({
      messages: [{ text: claim, atMs: 900, phase: 'replacement' }],
      mutationAtMs: 500,
    });
    assert.equal(sweep.unsupported, false);
  });

  it('a completed-mutation claim in a run where NO mutation happened is unsupported', () => {
    const sweep = detectUnsupportedMutationWording({
      messages: [{ text: 'Bench Press has been replaced.', atMs: 10, phase: 'x' }],
      mutationAtMs: null,
    });
    assert.equal(sweep.unsupported, true);
    assert.match(sweep.detail, /no mutation occurred/);
  });

  it('a clean thread — including the engine\'s own pre-acceptance wording — passes', () => {
    const sweep = detectUnsupportedMutationWording({
      messages: [
        { text: 'Replace Bench Press with Incline Dumbbell Press — 185 lb 5 reps @ 2 RIR x 2 sets.', atMs: 10, phase: 'substitution_ask' },
        { text: 'Approve the swap and I will set it.', atMs: 20, phase: 'prescription_question' },
      ],
      mutationAtMs: null,
    });
    assert.equal(sweep.unsupported, false, sweep.detail);
  });

  it('fails CLOSED when no messages were captured — a constant false is what this replaces', () => {
    for (const messages of [null, undefined, 'nope']) {
      assert.equal(detectUnsupportedMutationWording({ messages, mutationAtMs: 500 }).unsupported, true);
    }
  });

  it('fails CLOSED when a claim carries no timestamp', () => {
    const sweep = detectUnsupportedMutationWording({
      messages: [{ text: claim, atMs: null, phase: 'x' }], mutationAtMs: 500,
    });
    assert.equal(sweep.unsupported, true);
    assert.match(sweep.detail, /cannot be shown to be earned/);
  });

  it('records the phase of every unsupported claim so a failure names where it happened', () => {
    const sweep = detectUnsupportedMutationWording({
      messages: [{ text: claim, atMs: 1, phase: 'prescription_question' }], mutationAtMs: 500,
    });
    assert.equal(sweep.matches[0].phase, 'prescription_question');
  });
});


// ── replacement identity: the durable rows may not define their own expectation ──
// The circularity removed: the spec derived the expected lift code FROM the
// substitute's Log_Cleaned rows, then checked the outcome and the ledger against that
// derived code. A consistently wrong code across all three satisfied every check.

describe('compareReplacementIdentity — captured before the durable read', () => {
  const IDENTITY = { replacementLiftCode: 'INCDB01', sourceLiftCode: 'BEN01', sourcePlanItemId: 'item-bench-4' };
  // The full durable surface, including the slot ids the captured identity is now
  // measured against (P1-2 from the exact-head review of 3893c1d).
  const honest = () => ({
    logLiftCodes: ['INCDB01', 'INCDB01'],
    outcomePerformedLiftCode: 'INCDB01',
    outcomePlannedLiftCode: 'BEN01',
    outcomePlanItemId: 'item-bench-4',
    acceptedSourcePlanItemIds: ['item-bench-4'],
    ledgerRevisionLiftCodes: ['INCDB01', 'INCDB01'],
    ledgerRevisionPlanItemIds: ['item-bench-4'],
  });

  it('passes when every durable surface agrees with the captured proposal', () => {
    assert.deepEqual(compareReplacementIdentity(IDENTITY, honest()), { ok: true, problems: [] });
  });

  // THE BITE the owner asked for.
  it('BITE — every durable surface carrying the SAME wrong lift code still fails', () => {
    const wrong = {
      ...honest(),
      logLiftCodes: ['WRONG9', 'WRONG9'],
      outcomePerformedLiftCode: 'WRONG9',
      ledgerRevisionLiftCodes: ['WRONG9', 'WRONG9'],
    };
    const cmp = compareReplacementIdentity(IDENTITY, wrong);
    assert.equal(cmp.ok, false, 'self-consistent durable rows must not satisfy an independent identity');
    // All three surfaces are named, so the failure cannot be mistaken for one bad row.
    assert.equal(cmp.problems.length, 3, cmp.problems.join('; '));
    assert.ok(cmp.problems.some(p => /Log_Cleaned carries WRONG9/.test(p)));
    assert.ok(cmp.problems.some(p => /item_outcome performed WRONG9/.test(p)));
    assert.ok(cmp.problems.some(p => /ledger revisions carry WRONG9/.test(p)));
  });

  it('fails CLOSED when no identity was captured — the rows may not supply one', () => {
    for (const missing of [{}, { replacementLiftCode: '' }, { replacementLiftCode: null }]) {
      const cmp = compareReplacementIdentity(missing, honest());
      assert.equal(cmp.ok, false);
      assert.match(cmp.problems.join(' '), /may not supply one/);
    }
  });

  it('catches each surface diverging on its own', () => {
    for (const [label, patch] of [
      ['log', { logLiftCodes: ['OTHER1'] }],
      ['outcome performed', { outcomePerformedLiftCode: 'OTHER1' }],
      ['ledger revisions', { ledgerRevisionLiftCodes: ['OTHER1'] }],
      ['outcome planned (wrong source)', { outcomePlannedLiftCode: 'SQ01' }],
      ['outcome bound to the wrong slot', { outcomePlanItemId: 'item-squat-1' }],
    ]) {
      const cmp = compareReplacementIdentity(IDENTITY, { ...honest(), ...patch });
      assert.equal(cmp.ok, false, `${label} divergence must fail`);
    }
  });

  it('refuses a replacement that collapses to the source — that is not a replacement', () => {
    const cmp = compareReplacementIdentity(
      { replacementLiftCode: 'BEN01', sourceLiftCode: 'BEN01', sourcePlanItemId: 'item-bench-4' },
      { ...honest(), logLiftCodes: ['BEN01'], outcomePerformedLiftCode: 'BEN01', ledgerRevisionLiftCodes: ['BEN01'] },
    );
    assert.equal(cmp.ok, false);
    assert.match(cmp.problems.join(' '), /not a replacement/);
  });

  it('refuses split or missing evidence on any surface', () => {
    assert.equal(compareReplacementIdentity(IDENTITY, { ...honest(), logLiftCodes: [] }).ok, false);
    assert.equal(compareReplacementIdentity(IDENTITY, { ...honest(), logLiftCodes: ['INCDB01', 'OTHER1'] }).ok, false);
    assert.equal(compareReplacementIdentity(IDENTITY, { ...honest(), ledgerRevisionLiftCodes: [] }).ok, false);
    assert.equal(compareReplacementIdentity(IDENTITY, { ...honest(), outcomePerformedLiftCode: '' }).ok, false);
  });

  it('normalizes case and padding but nothing else', () => {
    assert.equal(compareReplacementIdentity(IDENTITY, {
      ...honest(), logLiftCodes: [' incdb01 '], outcomePerformedLiftCode: 'incdb01',
      ledgerRevisionLiftCodes: ['IncDb01'],
    }).ok, true);
  });
});


// ── P1 corrections from the exact-head review of 3893c1d ──────────────────────

describe('P1-1 — the reply must be right about ORDER and about what is next', () => {
  const EXP = { remaining: ['Seated Row', 'Bicep Curl'], complete: ['Back Squat'], retired: ['Bench Press'], nextUp: 'Seated Row' };

  it('BITE — every correct lift named in the WRONG order fails', () => {
    const cmp = replyMatchesExpectation('You have Bicep Curl and then Seated Row left.', EXP);
    assert.equal(cmp.ok, false, 'naming the right lifts in the wrong order must not pass');
    assert.match(cmp.problems.join(' '), /declaration order/);
  });

  it('BITE — an explicit WRONG next-up claim fails even when the real next-up is mentioned', () => {
    const cmp = replyMatchesExpectation('Next up is Bicep Curl. Seated Row is still on the list too.', EXP);
    assert.equal(cmp.ok, false);
    assert.match(cmp.problems.join(' '), /claims "Bicep Curl" is next/);
  });

  it('accepts the correct order and the correct explicit next-up', () => {
    assert.equal(replyMatchesExpectation('Next up is Seated Row, then Bicep Curl.', EXP).ok, true);
  });

  it('makes no next-up demand of a reply that claims none', () => {
    assert.equal(replyMatchesExpectation('Left to do: Seated Row, Bicep Curl.', EXP).ok, true);
  });

  it('recognizes the explicit-claim phrasings and ignores prose that makes no claim', () => {
    assert.equal(explicitNextUpClaim('Next up is Seated Row.'), 'Seated Row');
    assert.equal(explicitNextUpClaim('You are on Seated Row next'), 'Seated Row');
    assert.equal(explicitNextUpClaim('Up next: Seated Row'), 'Seated Row');
    assert.equal(explicitNextUpClaim('You still have Seated Row and Bicep Curl.'), null);
  });

  it('BITE — a BLANK pin fails, and so does a pin naming the wrong lift', () => {
    assert.equal(pinMatchesExpectation('', EXP).ok, false);
    assert.equal(pinMatchesExpectation('   ', EXP).ok, false);
    const wrong = pinMatchesExpectation('Current: Bicep Curl · 35x15', EXP);
    assert.equal(wrong.ok, false, 'a non-retired but WRONG pin must fail');
    assert.match(wrong.problems.join(' '), /does not name the expected current lift/);
  });

  it('a pin naming a retired or completed lift fails; the correct pin passes', () => {
    assert.equal(pinMatchesExpectation('Current: Bench Press', EXP).ok, false);
    assert.equal(pinMatchesExpectation('Seated Row · Back Squat done', EXP).ok, false);
    assert.equal(pinMatchesExpectation('Current: Seated Row · 205x10 @2', EXP).ok, true);
  });
});

describe('P1-2 — the retained source slot is captured, not derived', () => {
  const ID = { replacementLiftCode: 'INCDB01', sourceLiftCode: 'BEN01', sourcePlanItemId: 'pi_bench_4' };
  const honest = () => ({
    logLiftCodes: ['INCDB01'], outcomePerformedLiftCode: 'INCDB01', outcomePlannedLiftCode: 'BEN01',
    outcomePlanItemId: 'pi_bench_4', acceptedSourcePlanItemIds: ['pi_bench_4'],
    ledgerRevisionLiftCodes: ['INCDB01'], ledgerRevisionPlanItemIds: ['pi_bench_4'],
  });

  it('passes when every surface agrees with the captured slot', () => {
    assert.deepEqual(compareReplacementIdentity(ID, honest()), { ok: true, problems: [] });
  });

  it('BITE — the SAME wrong plan_item_id on every durable surface still fails', () => {
    const wrong = {
      ...honest(), outcomePlanItemId: 'pi_WRONG', acceptedSourcePlanItemIds: ['pi_WRONG'], ledgerRevisionPlanItemIds: ['pi_WRONG'],
    };
    const cmp = compareReplacementIdentity(ID, wrong);
    assert.equal(cmp.ok, false, 'self-consistent slot ids must not satisfy a captured identity');
    assert.equal(cmp.problems.length, 3, cmp.problems.join('; '));
    assert.ok(cmp.problems.every(p => /pi_bench_4/.test(p)), cmp.problems.join('; '));
  });

  it('fails CLOSED when no source slot was captured before mutation', () => {
    for (const missing of [null, undefined, '', '   ']) {
      const cmp = compareReplacementIdentity({ ...ID, sourcePlanItemId: missing }, honest());
      assert.equal(cmp.ok, false);
      assert.match(cmp.problems.join(' '), /may not supply one/);
    }
  });

  it('catches each slot surface diverging alone', () => {
    for (const patch of [
      { outcomePlanItemId: 'pi_other' },
      { acceptedSourcePlanItemIds: ['pi_other'] },
      { acceptedSourcePlanItemIds: [] },
      { acceptedSourcePlanItemIds: ['pi_bench_4', 'pi_other'] },
      { ledgerRevisionPlanItemIds: ['pi_other'] },
    ]) {
      assert.equal(compareReplacementIdentity(ID, { ...honest(), ...patch }).ok, false, JSON.stringify(patch));
    }
  });
});

describe('P1-5 — failed capture is missing evidence, not a no-message path', () => {
  it('BITE — a partial bubble goes quiet while response capture FAILED: refused', () => {
    const outcome = classifySettlement({ text: 've.', servedMessages: [], stableForMs: 99999, captureFailed: true });
    assert.equal(outcome, 'capture-failed');
    assert.equal(isSettled(outcome), false, 'stability must not settle a turn whose served reply is unknown');
  });

  it('a genuine no-message path still settles on stability', () => {
    const outcome = classifySettlement({ text: 'Noted.', servedMessages: [], stableForMs: 99999, captureFailed: false });
    assert.equal(outcome, 'stable-no-served-message');
    assert.equal(isSettled(outcome), true);
  });

  it('a successful capture is unaffected by the flag', () => {
    const full = 'Go with 185 lb for 5 reps.';
    assert.equal(classifySettlement({ text: full, servedMessages: [full], stableForMs: 0, captureFailed: true }), 'served-complete');
  });
});


// ── P1 corrections from the final exact-head review of b3b5db1 ────────────────

describe('P1-A — a bubble frozen at Thinking… must not hide its final text', () => {
  // The exact sequence the review specifies: say() sweeps and sees the placeholder,
  // the SAME element later becomes unsupported wording, and condition 9 must fail.
  function replaySweeps() {
    const records = {};
    // 1. The bubble is created and first reported while it is still thinking.
    ingestLiveObservation(records, { index: 0, text: 'Thinking…' }, { phase: 'substitution_ask', nowMs: 100 });
    // 2. The SAME element resolves to a completed-mutation claim, before any mutation.
    ingestLiveObservation(records, { index: 0, text: "Done — I've noted the substitution." }, { phase: 'prescription_question', nowMs: 400 });
    return records;
  }

  it('the later sweep UPDATES the same index instead of skipping it', () => {
    const msgs = recordsToMessages(replaySweeps());
    assert.equal(msgs.length, 1, 'one bubble, one record');
    assert.match(msgs[0].text, /noted the substitution/, 'the final text must replace the placeholder');
    assert.equal(msgs[0].placeholder, false);
    assert.equal(msgs[0].atMs, 400, 'the timestamp must describe the final render, not the placeholder');
    assert.equal(msgs[0].phase, 'substitution_ask', 'the phase stays bound to the turn that created the bubble');
  });

  it('BITE — condition 9 FAILS on wording that only appeared after the first sweep', () => {
    const sweep = detectUnsupportedMutationWording({
      messages: recordsToMessages(replaySweeps()),
      mutationAtMs: 900,           // the mutation happens later — the claim is unearned
    });
    assert.equal(sweep.unsupported, true, sweep.detail);

    const obs = greenObservations();
    obs.claims = { unsupported_mutation_wording: sweep.unsupported, unsupported_write_claim: false, detail: sweep.detail };
    const card = scoreRehearsalRun(obs);
    assert.equal(card.conditions.find(c => c.id === 'no_unsupported_claims').status, FAIL);
    assert.equal(card.rehearsal_eligible, false);
  });

  it('a record still holding the placeholder at the end fails CLOSED', () => {
    const records = {};
    ingestLiveObservation(records, { index: 0, text: 'Thinking…' }, { phase: 'x', nowMs: 100 });
    const sweep = detectUnsupportedMutationWording({ messages: recordsToMessages(records), mutationAtMs: 900 });
    assert.equal(sweep.unsupported, true, 'an unfinished render means the evidence is incomplete');
    assert.match(sweep.detail, /still rendering/);
  });

  it('growing text across several sweeps keeps only the final state', () => {
    const records = {};
    ingestLiveObservation(records, { index: 0, text: 'Go with' }, { phase: 'p', nowMs: 10 });
    ingestLiveObservation(records, { index: 0, text: 'Go with 185 lb' }, { phase: 'p', nowMs: 20 });
    ingestLiveObservation(records, { index: 0, text: 'Go with 185 lb for 5 reps.' }, { phase: 'p', nowMs: 30 });
    const msgs = recordsToMessages(records);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'Go with 185 lb for 5 reps.');
    assert.equal(msgs[0].atMs, 30);
  });

  it('keeps one record per bubble as the thread grows, in DOM order', () => {
    const records = {};
    ingestLiveObservation(records, { index: 0, text: 'a' }, { phase: 'p1', nowMs: 10 });
    ingestLiveObservation(records, { index: 1, text: 'b' }, { phase: 'p2', nowMs: 20 });
    ingestLiveObservation(records, { index: 2, text: 'c' }, { phase: 'p3', nowMs: 30 });
    const msgs = recordsToMessages(records);
    assert.deepEqual(msgs.map(m => m.text), ['a', 'b', 'c']);
    assert.deepEqual(msgs.map(m => m.phase), ['p1', 'p2', 'p3'], 'each bubble keeps its originating phase');
  });
});

describe('P1-B — an object body with no usable message is a capture FAILURE', () => {
  // Drives the REAL listener classification, not a hand-set captureFailed flag.
  const shapes = [
    ['{ source, model } with no message', { source: 'gemini', model: 'x' }],
    ['message: null', { message: null }],
    ['message: ""', { message: '' }],
    ['message: "   "', { message: '   ' }],
    ['message: 123', { message: 123 }],
    ['nested data with no message', { data: { source: 'gemini' } }],
  ];

  for (const [label, body] of shapes) {
    it(`BITE — ${label} → capture-failed, and a quiet partial bubble does NOT settle`, () => {
      const capture = classifyCoachResponseCapture({ status: 200, body, parseFailed: false });
      assert.equal(capture.outcome, 'capture-failed', `${label} must be a capture failure: ${capture.reason}`);

      // The integration the review asked for: that classification feeds settlement.
      const outcome = classifySettlement({
        text: 've.',
        servedMessages: capture.outcome === 'served' ? [capture.message] : [],
        stableForMs: 99999,
        captureFailed: capture.outcome === 'capture-failed',
      });
      assert.equal(isSettled(outcome), false, `${label} must not permit stability-only settlement`);
      assert.equal(outcome, 'capture-failed');
    });
  }

  it('a real served message classifies as served and settles when wholly rendered', () => {
    const full = 'Go with 185 lb for 5 reps at RIR 2.';
    const capture = classifyCoachResponseCapture({ status: 200, body: { data: { message: full } }, parseFailed: false });
    assert.equal(capture.outcome, 'served');
    assert.equal(capture.message, full);
    assert.equal(classifySettlement({ text: full, servedMessages: [full], stableForMs: 0 }), 'served-complete');
  });

  it('a non-2xx coach response is the EXPLICIT no-message path — the client renders its own fallback', () => {
    for (const status of [500, 503, 429, 404]) {
      const capture = classifyCoachResponseCapture({ status, body: { error: 'x' }, parseFailed: false });
      assert.equal(capture.outcome, 'no-message-path', `HTTP ${status}`);
    }
    const outcome = classifySettlement({ text: 'Let us keep it simple today.', servedMessages: [], stableForMs: 99999, captureFailed: false });
    assert.equal(isSettled(outcome), true, 'the fallback lane may still settle on stability');
  });

  it('an unparseable body or an unreadable status fails closed', () => {
    assert.equal(classifyCoachResponseCapture({ status: 200, parseFailed: true }).outcome, 'capture-failed');
    assert.equal(classifyCoachResponseCapture({ body: { message: 'x' } }).outcome, 'capture-failed');
    assert.equal(classifyCoachResponseCapture(null).outcome, 'capture-failed');
  });
});

describe('P1-C — write claims are timed against the live write, not the word "done"', () => {
  // Session 4's shape: the athlete says "I'm done for today" BEFORE the save. The old
  // verdict sliced the thread at that literal and discarded everything after it.
  const SESSION_4 = () => ([
    { text: 'How is the session feeling so far?', atMs: 100, phase: 'eligible_question' },
    { text: "Understood — I'm done for today, then. Bicep Curl remains in the plan.", atMs: 200, phase: 'closeout' },
    // The unsupported claim: after the early-end phrase, BEFORE the live write.
    { text: 'All set — your workout is saved to your sheet.', atMs: 300, phase: 'closeout' },
  ]);

  it('BITE — an unsupported save claim after "done" but before the write FAILS', () => {
    const sweep = detectUnsupportedWriteClaim({ messages: SESSION_4(), liveWriteAtMs: 500 });
    assert.equal(sweep.unsupported, true, 'the claim landed before the live write and must fail');
    assert.match(sweep.detail, /before the live write succeeded/);

    const obs = greenObservations();
    obs.claims = { unsupported_mutation_wording: false, unsupported_write_claim: sweep.unsupported, detail: sweep.detail };
    const card = scoreRehearsalRun(obs);
    assert.equal(card.conditions.find(c => c.id === 'no_unsupported_claims').status, FAIL);
    assert.equal(card.rehearsal_eligible, false);
  });

  it('the old prose-clock would have missed it — the literal "done" appears before the claim', () => {
    const thread = SESSION_4().map(m => m.text).join('\n');
    const slicedAtDone = thread.slice(0, thread.indexOf('done'));
    assert.equal(/saved to (your|the) sheet/i.test(slicedAtDone), false,
      'this is exactly the false green being removed: the old scan could not see the claim');
    assert.equal(detectUnsupportedWriteClaim({ messages: SESSION_4(), liveWriteAtMs: 500 }).unsupported, true);
  });

  it('the same claim AFTER the live write is honest', () => {
    const sweep = detectUnsupportedWriteClaim({ messages: SESSION_4(), liveWriteAtMs: 250 });
    assert.equal(sweep.unsupported, false, sweep.detail);
  });

  it('a write claim with NO observed live write is unsupported', () => {
    assert.equal(detectUnsupportedWriteClaim({ messages: SESSION_4(), liveWriteAtMs: null }).unsupported, true);
  });

  it('fails closed on missing messages or an untimed claim', () => {
    assert.equal(detectUnsupportedWriteClaim({ messages: null, liveWriteAtMs: 500 }).unsupported, true);
    assert.equal(detectUnsupportedWriteClaim({
      messages: [{ text: 'saved to your sheet', atMs: null, phase: 'x' }], liveWriteAtMs: 500,
    }).unsupported, true);
  });

  it('a clean thread with no write claim passes', () => {
    assert.equal(detectUnsupportedWriteClaim({
      messages: [{ text: 'Nice work today.', atMs: 10, phase: 'closeout' }], liveWriteAtMs: 500,
    }).unsupported, false);
  });
});


// ── the sweep may never assign a timestamp retroactively ─────────────────────
// The gap the final review named: the fold fixed "index recorded once" but not "no
// observation occurred while the lifecycle changed". A later sweep must not be able to
// restamp a claim into the earned window, and a bubble the observer never saw must not
// be trusted for timing at all.

describe('reconcileSweep — a later look cannot rewrite when a claim became visible', () => {
  it('BITE — a live claim keeps its own timestamp when a later sweep sees the same text', () => {
    const records = {};
    ingestLiveObservation(records, { index: 0, text: 'saved to your sheet' }, { phase: 'closeout', nowMs: 300 });
    reconcileSweep(records, ['saved to your sheet'], { phase: 'teardown', nowMs: 900 });
    const m = recordsToMessages(records)[0];
    assert.equal(m.atMs, 300, 'the sweep must not restamp a live observation');
    assert.equal(m.retroactive, false);
    // The write happened at 500 — AFTER the claim was visible, so it is unsupported.
    assert.equal(detectUnsupportedWriteClaim({ messages: [m], liveWriteAtMs: 500 }).unsupported, true);
  });

  it('BITE — a bubble the observer never reported is retroactive and fails closed', () => {
    const records = {};
    reconcileSweep(records, ['saved to your sheet'], { phase: 'teardown', nowMs: 900 });
    const m = recordsToMessages(records)[0];
    assert.equal(m.retroactive, true);
    for (const sweep of [
      detectUnsupportedWriteClaim({ messages: [m], liveWriteAtMs: 100 }),
      detectUnsupportedMutationWording({ messages: [m], mutationAtMs: 100 }),
    ]) {
      assert.equal(sweep.unsupported, true, 'an inspection-time timestamp cannot place a claim');
      assert.match(sweep.detail, /only observed by a later sweep/);
    }
  });

  it('a sweep that finds text the observer never reported marks the record retroactive', () => {
    const records = {};
    ingestLiveObservation(records, { index: 0, text: 'Thinking…' }, { phase: 'closeout', nowMs: 100 });
    reconcileSweep(records, ['saved to your sheet'], { phase: 'teardown', nowMs: 900 });
    assert.equal(recordsToMessages(records)[0].retroactive, true,
      'the observer missed this transition, so its timing is not trustworthy');
  });

  it('a later LIVE report clears a retroactive mark', () => {
    const records = {};
    reconcileSweep(records, ['Thinking…'], { phase: 'x', nowMs: 100 });
    assert.equal(recordsToMessages(records)[0].retroactive, true);
    ingestLiveObservation(records, { index: 0, text: 'the real reply' }, { phase: 'x', nowMs: 200 });
    const m = recordsToMessages(records)[0];
    assert.equal(m.retroactive, false);
    assert.equal(m.atMs, 200);
  });

  it('ignores a malformed report rather than recording a bogus index', () => {
    const records = {};
    for (const bad of [null, {}, { index: -1, text: 'x' }, { index: 'a', text: 'x' }]) {
      ingestLiveObservation(records, bad, { phase: 'x', nowMs: 1 });
    }
    assert.deepEqual(recordsToMessages(records), []);
  });
});
