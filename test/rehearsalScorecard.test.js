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
  classifySettlement, isSettled, PASS, FAIL, ERROR,
} = require('../tests/e2e/gate/rehearsal-scorecard');
const { sessionPlanSetsColumns } = require('../config/columns');

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
