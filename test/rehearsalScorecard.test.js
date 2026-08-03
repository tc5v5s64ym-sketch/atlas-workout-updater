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
  CONDITIONS, scoreRehearsalRun, renderMarkdown, PASS, FAIL, ERROR,
} = require('../tests/e2e/gate/rehearsal-scorecard');

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
      session_plan_sets: { row_count: 14, distinct_seals: 1, blank_seals: 0, accepted_grain_ok: true },
      log_cleaned: { row_count: 12, rows_match_declaration: true },
      effort: { row_count: 1 },
      foreign_rows: 0,
      foreign_id_probe_status: 403,
    },
    write: {
      preview_seen: true, preview_no_write_confirmed: true, preview_before_write: true,
      approvals_clicked: 1, write_success: true, repeat_attempted: true, duplicate_rows: 0,
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
