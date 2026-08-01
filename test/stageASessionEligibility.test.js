'use strict';

// Stage-A SESSION eligibility — the false-counting bite tests.
//
// The canary bite tests (test/stageACanaryScorecard.test.js) prove the scorecard refuses a run
// that ran badly. These prove something different and, for the owner's acceptance streak, more
// dangerous: that a run which cannot honestly count is never PUBLISHED as count-eligible.
//
// The failure mode being defended against is not a broken product. It is a green transcript,
// a plausible artifact, and a streak that advances on evidence it should not have.
//
// Offline by construction: no credentials, no network, no Sheets, no browser, no git, no real
// write. Every case starts from one fully-passing Stage A observation set and breaks exactly
// one thing, so a failure names the rule that stopped biting.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  scoreStageARun, renderMarkdown, CONDITION_IDS,
} = require('../tests/e2e/gate/stage-a-canary-scorecard');
const {
  CANARY, STAGE_A_SESSION, STAGE_A_STREAK_LENGTH,
  mintIdentities, identityRefusal, parseCanonicalStageACount, evaluateStageAPreflight,
  normalizePurpose, isStageASessionNumber,
} = require('../tests/e2e/gate/stage-a-run-purpose');

const SHA = 'ce2825c7cacf6d24270d8137d04f03fcb1858f9f';
const SESSION = 'STAGEA-S1-20260801T120000-AB12CD';
const TURN = 'turn:2026-08-01T12:00:00.000Z_1_abc123';

const LOG_IDX = { exercise: 2, weight: 7, reps: 8, rir: 9, set_number: 6 };
const EFF_IDX = { duration: 2, active_calories: 3, total_calories: 4, average_hr: 5, peak_hr: 6 };

const SETS = [
  { exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 },
  { exercise: 'Back Squat', set_number: 2, weight: 225, reps: 5, rir: 2 },
  { exercise: 'Bench Press', set_number: 1, weight: 185, reps: 8, rir: 3 },
  { exercise: 'Bench Press', set_number: 2, weight: 185, reps: 7, rir: 2 },
];

function logRow(s) {
  const r = [];
  r[1] = SESSION;
  r[LOG_IDX.exercise] = s.exercise;
  r[LOG_IDX.set_number] = String(s.set_number);
  r[LOG_IDX.weight] = String(s.weight);
  r[LOG_IDX.reps] = String(s.reps);
  r[LOG_IDX.rir] = String(s.rir);
  return r;
}

// A fully-passing, count-eligible Stage A session 1. Every mutation below starts here.
function goodStageA() {
  return {
    run: {
      run_id: 'stage-a-s1-20260801T120000-AB12CD',
      purpose: STAGE_A_SESSION,
      stage_a_session_number: 1,
      mode: 'model-up',
      session_id: SESSION,
      athlete_id: 'stage-a-athlete-AB12CD',
    },
    source: {
      branch: 'main', clean: true, head_sha: SHA, origin_head_sha: SHA, prior_stage_a_count: 0,
    },
    expected: {
      sets: SETS.map(s => ({ ...s })),
      effort: { duration: '44:30', active_calories: 366, total_calories: 488, average_hr: 124, peak_hr: 159 },
    },
    server: {
      model_posture: 'model-up', provider_key_present: true, provider_reachable: true,
      coach_model: 'gemini-2.5-flash-lite', coach_scripted: false,
      sandbox_live: true, sandbox_last6: 'H3CeXE', sheets_stubbed_in_memory: false,
      sandbox_preflight: { ok: true, checks: [{ name: 'resolved_workbook_is_declared_sandbox', ok: true }] },
      refusals: [],
      appends: [{ tabName: 'Log_Cleaned', rows: [] }, { tabName: 'Effort', rows: [] }],
      ensure_tab_calls: [], deletes: [], updates: [],
      ledger_write_flags_off: true, telemetry_persistence_off: true,
    },
    env: {
      declared_sandbox_last6: 'H3CeXE', child_sheet_id_last6: 'H3CeXE',
      ambient_sheet_id_last6: 'DuDcA0', inherited_ambient: false,
    },
    provenance: { request_origin: 'playwright', evidence_class: 'synthetic', evidence_eligible: false },
    ui: {
      identity_confirmed: true, initial_logged_sets: 0, durable_rows_before_run: 0,
      plan_established: true, plan_exercises: ['Back Squat', 'Bench Press'], plan_remaining_visible: true,
      grounded_question: { asked: true, reply_text: 'Bench Press today: 185 lbs.', grounded_in_session: true },
      model_turn: {
        asked: true, reply_text: 'Two lifts left.',
        source: 'live_model', provider_called: true, source_ambiguous: false,
      },
      logged_sets: 4, exercises_logged: ['Back Squat', 'Bench Press'],
      durable_rows_before_approval: 0, appends_before_approval: 0,
      preview_rendered: true, preview_proof_present: true,
      preview_sets: SETS.map(s => ({ exercise: s.exercise, weight: s.weight, reps: s.reps, rir: s.rir })),
      approval_clicked: true, approval_control: '.review:not(.done) .rv-save',
      write_trigger: '#approve-btn', direct_write_route_used: false,
      second_approval_attempted: true,
      closeout_rendered: true, closeout_approved: true,
      sealed_state_valid: true, sealed_state_label: '✓ Saved to your sheet',
    },
    durable: {
      log_rows: SETS.map(logRow),
      effort_rows: [(() => {
        const r = [];
        r[1] = SESSION;
        r[EFF_IDX.duration] = '44:30'; r[EFF_IDX.active_calories] = '366';
        r[EFF_IDX.total_calories] = '488'; r[EFF_IDX.average_hr] = '124'; r[EFF_IDX.peak_hr] = '159';
        return r;
      })()],
      log_column_index: LOG_IDX, effort_column_index: EFF_IDX,
      foreign_identity_rows: 0, other_session_rows_delta: 0, rows_added_by_second_approval: 0,
    },
    trace: { records: [{ turn_id: TURN, valid: true, stages: [{ stage: 'intent', status: 'ok' }], source: 'coach_chat' }] },
    write_proof: {
      records: [
        { turn_id: TURN, session_id: SESSION, route: '/api/log-workout',
          pairing: { established_at_preview: true, write_attempt: 0 },
          proof: { test_mode: true, sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true },
          withheld_evidence: [] },
        { turn_id: TURN, session_id: SESSION, route: '/api/log-workout',
          pairing: { established_at_preview: true, write_attempt: 1, payload_bound: true },
          proof: { test_mode: false, sheet_write: 'success', duplicate_write: false,
            log_rows_written: 4, effort_rows_written: 1, idempotency_status: 'completed' },
          withheld_evidence: [] },
      ],
    },
    privacy: { violations: [], artifacts_scanned: 9, artifact_bytes: 40000, artifact_bytes_limit: 2000000 },
  };
}

function statusOf(card, id) {
  const hit = card.conditions.find(c => c.id === id);
  assert.ok(hit, `condition ${id} is missing from the scorecard`);
  return hit.status;
}

// The single assertion that matters for every case below: the run did NOT publish
// count-eligibility, and the named condition is the one that stopped it.
function assertNotEligible(label, conditionId, wantStatus, mutate) {
  const obs = goodStageA();
  mutate(obs);
  const card = scoreStageARun(obs);
  assert.strictEqual(card.stage_a_eligible, false,
    `${label}: the scorecard published stage_a_eligible=true`);
  if (conditionId) {
    assert.strictEqual(statusOf(card, conditionId), wantStatus,
      `${label}: expected ${conditionId} to be ${wantStatus}, got ${statusOf(card, conditionId)}`);
  }
}

// ── the baseline the mutations are measured against ────────────────────────────

test('a complete, honest model-up Stage A session 1 is count-eligible', () => {
  const card = scoreStageARun(goodStageA());
  const notPassing = card.conditions.filter(c => c.status !== 'PASS' && c.status !== 'NOT_APPLICABLE');
  assert.deepStrictEqual(notPassing.map(c => `${c.id}=${c.status}: ${c.detail}`), []);
  assert.strictEqual(card.overall, 'PASS');
  assert.strictEqual(card.stage_a_eligible, true);
  assert.strictEqual(card.counts.FAIL, 0);
  assert.strictEqual(card.counts.ERROR, 0);
  assert.strictEqual(card.counts.NOT_APPLICABLE, 1);
});

// ── requirement: canary evidence cannot count ──────────────────────────────────

test('canary evidence can never count, however perfect the run', () => {
  // A canary run that satisfies every product condition still publishes false. This is the
  // rule that keeps the two already-passing readiness canaries at 0 sessions.
  const obs = goodStageA();
  obs.run.purpose = CANARY;
  obs.run.stage_a_session_number = null;
  obs.run.session_id = 'CANARY-20260801T120000-AB12CD';
  obs.durable.log_rows = SETS.map(s => {
    const r = logRow(s);
    r[1] = 'CANARY-20260801T120000-AB12CD';
    return r;
  });
  obs.write_proof.records.forEach(r => { r.session_id = 'CANARY-20260801T120000-AB12CD'; });
  obs.durable.effort_rows[0][1] = 'CANARY-20260801T120000-AB12CD';
  const card = scoreStageARun(obs);
  assert.strictEqual(card.overall, 'PASS', 'the canary run itself should still be a valid canary');
  assert.strictEqual(card.stage_a_eligible, false, 'a CANARY purpose may never be count-eligible');
  assert.strictEqual(card.run.stage_a_session_number, null);
});

test('a canary identity relabelled as a Stage A session is refused', () => {
  // Relabelling is the cheapest possible false count: keep the canary artifact, change the
  // word. The identity family is what makes that mechanically impossible.
  assertNotEligible('canary id under a Stage A purpose', 'run_purpose_declared', 'FAIL', o => {
    o.run.session_id = 'CANARY-20260801T120000-AB12CD';
  });
  assertNotEligible('a bare unmarked id', 'run_purpose_declared', 'FAIL', o => {
    o.run.session_id = '20260801-PM-01';
  });
  assertNotEligible('the wrong session number in the id', 'run_purpose_declared', 'FAIL', o => {
    o.run.session_id = 'STAGEA-S3-20260801T120000-AB12CD';
  });
});

test('an undeclared run purpose is ERROR, never a default', () => {
  assertNotEligible('no purpose at all', 'run_purpose_declared', 'ERROR', o => { delete o.run.purpose; });
  assertNotEligible('an invented purpose', 'run_purpose_declared', 'ERROR', o => { o.run.purpose = 'REAL_SESSION'; });
});

// ── requirement: Stage A refuses model-down and an unproven provider ────────────

test('Stage A refuses model-down', () => {
  assertNotEligible('declared model-down', 'run_purpose_declared', 'FAIL', o => {
    o.run.mode = 'model-down';
    o.server.model_posture = 'model-down';
    o.server.provider_key_present = false;
    o.server.provider_reachable = false;
    o.server.coach_model = null;
    o.ui.model_turn.provider_called = false;
    o.ui.model_turn.source = 'deterministic';
  });
});

test('Stage A refuses an unproven provider or a deterministic fallback', () => {
  assertNotEligible('configured but unreachable', 'model_posture_proven', 'FAIL', o => {
    o.server.provider_reachable = false;
  });
  assertNotEligible('eligible turn fell back to the engine', 'model_source_marker', 'FAIL', o => {
    o.ui.model_turn.provider_called = false;
    o.ui.model_turn.source = 'engine';
  });
  assertNotEligible('provider claimed but unnamed', 'model_source_marker', 'ERROR', o => {
    o.ui.model_turn.source_ambiguous = true;
  });
});

// ── requirement: Stage A refuses a dirty, non-main, or stale source tree ───────

test('Stage A refuses a dirty, non-main, or stale source tree', () => {
  assertNotEligible('feature branch', 'stage_a_source_tree_verified', 'FAIL', o => {
    o.source.branch = 'claude/some-feature';
  });
  assertNotEligible('dirty worktree', 'stage_a_source_tree_verified', 'FAIL', o => {
    o.source.clean = false;
  });
  assertNotEligible('stale HEAD', 'stage_a_source_tree_verified', 'FAIL', o => {
    o.source.origin_head_sha = '0123456789abcdef0123456789abcdef01234567';
  });
  assertNotEligible('no source facts recorded', 'stage_a_source_tree_verified', 'ERROR', o => {
    delete o.source;
  });
  assertNotEligible('no clean determination', 'stage_a_source_tree_verified', 'ERROR', o => {
    delete o.source.clean;
  });
});

// ── requirement: Stage A refuses an incorrect session number ───────────────────

test('Stage A refuses a missing, fractional, or out-of-range session number', () => {
  assertNotEligible('no session number', 'run_purpose_declared', 'FAIL', o => {
    delete o.run.stage_a_session_number;
  });
  assertNotEligible('zero', 'run_purpose_declared', 'FAIL', o => { o.run.stage_a_session_number = 0; });
  assertNotEligible('past the streak', 'run_purpose_declared', 'FAIL', o => {
    o.run.stage_a_session_number = STAGE_A_STREAK_LENGTH + 1;
  });
  assertNotEligible('fractional', 'run_purpose_declared', 'FAIL', o => { o.run.stage_a_session_number = 1.5; });
  assertNotEligible('a numeric string', 'run_purpose_declared', 'FAIL', o => { o.run.stage_a_session_number = '1'; });
});

// ── requirement: Stage A refuses when the canonical prior count is not N-1 ─────

test('Stage A refuses when the canonical prior count does not admit this session number', () => {
  // Session 1 is legal only at 0/5. This is what stops a failed session being repaired and
  // re-run as though it never happened, and what stops a skipped or repeated number.
  assertNotEligible('session 1 while the plan records 1/5', 'stage_a_source_tree_verified', 'FAIL', o => {
    o.source.prior_stage_a_count = 1;
  });
  assertNotEligible('session 1 while the plan records 4/5', 'stage_a_source_tree_verified', 'FAIL', o => {
    o.source.prior_stage_a_count = 4;
  });
  assertNotEligible('no canonical count recorded', 'stage_a_source_tree_verified', 'ERROR', o => {
    delete o.source.prior_stage_a_count;
  });
  // And the correct pairing for a later session passes, so the rule is a relation and not a
  // hard-coded "session 1 only".
  const s3 = goodStageA();
  s3.run.stage_a_session_number = 3;
  s3.run.session_id = 'STAGEA-S3-20260801T120000-AB12CD';
  s3.source.prior_stage_a_count = 2;
  s3.durable.log_rows.forEach(r => { r[1] = s3.run.session_id; });
  s3.durable.effort_rows[0][1] = s3.run.session_id;
  s3.write_proof.records.forEach(r => { r.session_id = s3.run.session_id; });
  assert.strictEqual(scoreStageARun(s3).stage_a_eligible, true);
});

// ── requirement: evidence carries its source SHA and purpose ───────────────────

test('Stage A evidence carries its source sha, purpose, and session number', () => {
  const card = scoreStageARun(goodStageA());
  assert.strictEqual(card.run.purpose, STAGE_A_SESSION);
  assert.strictEqual(card.run.stage_a_session_number, 1);
  assert.strictEqual(card.run.source_sha, SHA);
  const md = renderMarkdown(card);
  assert.ok(md.includes('**stage_a_eligible: true**'));
  assert.ok(md.includes(SHA), 'the rendered card must name the exact source commit');
  assert.ok(md.includes('STAGE_A_SESSION'));
});

test('a Stage A run with no source sha, or a sha that is not a commit, is refused', () => {
  assertNotEligible('sha absent', 'run_purpose_declared', 'ERROR', o => { o.source.head_sha = ''; });
  assertNotEligible('sha is a branch name', 'run_purpose_declared', 'FAIL', o => {
    o.source.head_sha = 'main';
    o.source.origin_head_sha = 'main';
  });
});

// ── requirement: removing or inverting the eligibility assertion fails a test ──

test('MUTATION — eligibility cannot be supplied, only derived', () => {
  // The observation set is caller-controlled. If `stage_a_eligible` could be read from it,
  // any runner could hand itself credit. It is derived, so a supplied value is ignored.
  const obs = goodStageA();
  obs.stage_a_eligible = true;
  obs.run.stage_a_eligible = true;
  obs.run.purpose = CANARY;
  obs.run.stage_a_session_number = null;
  obs.run.session_id = 'CANARY-20260801T120000-AB12CD';
  obs.durable.log_rows.forEach(r => { r[1] = obs.run.session_id; });
  obs.durable.effort_rows[0][1] = obs.run.session_id;
  obs.write_proof.records.forEach(r => { r.session_id = obs.run.session_id; });
  assert.strictEqual(scoreStageARun(obs).stage_a_eligible, false,
    'a supplied stage_a_eligible was honored — eligibility must be derived');
});

test('MUTATION — a failing product condition can never be eligible', () => {
  // Eligibility is not a separate lane that could go green while the run went red. Break the
  // decisive product conditions one at a time; each must take eligibility with it.
  for (const [label, mutate] of [
    ['no durable rows', o => { o.durable.log_rows = []; }],
    ['write before approval', o => { o.ui.durable_rows_before_approval = 2; }],
    ['no browser approval', o => { o.ui.approval_clicked = false; }],
    ['no preview', o => { o.ui.preview_rendered = false; }],
    ['unsealed', o => { o.ui.sealed_state_valid = false; }],
    ['trace and write proof do not join', o => { o.trace.records[0].turn_id = 'turn:other_9_zzzzzz'; }],
    ['guard refusal', o => { o.server.refusals = [{ operation: 'appendRows', tabName: 'Brain_Shadow' }]; }],
    ['privacy violation', o => { o.privacy.violations = [{ kind: 'workbook_id' }]; }],
    ['duplicate write on retry', o => { o.durable.rows_added_by_second_approval = 1; }],
    ['evidence marked owner-eligible', o => { o.provenance.evidence_eligible = true; }],
  ]) {
    assertNotEligible(label, null, null, mutate);
  }
});

test('MUTATION — deleting an evidence branch cannot make a run eligible', () => {
  // The frozen-list property, restated for eligibility: an unobserved condition is ERROR, and
  // ERROR is never eligible. Supplying LESS evidence must never buy a greener verdict.
  for (const branch of ['durable', 'ui', 'server', 'write_proof', 'trace', 'privacy', 'source', 'run']) {
    const obs = goodStageA();
    delete obs[branch];
    const card = scoreStageARun(obs);
    assert.strictEqual(card.stage_a_eligible, false, `deleting "${branch}" produced an eligible run`);
  }
  assert.strictEqual(scoreStageARun({}).stage_a_eligible, false);
});

test('MUTATION — inverting the two purpose conditions is caught', () => {
  // Direct ablation of the two conditions that gate counting: force each to report PASS on a
  // run that must not count, and the derived clauses must still refuse.
  const { CONDITIONS } = require('../tests/e2e/gate/stage-a-canary-scorecard');
  for (const id of ['run_purpose_declared', 'stage_a_source_tree_verified']) {
    const condition = CONDITIONS.find(c => c.id === id);
    const original = condition.evaluate;
    try {
      Object.defineProperty(condition, 'evaluate', {
        value: () => ({ status: 'PASS', detail: 'forced' }), configurable: true, writable: true,
      });
      // A canary run with both gates forced green is still not eligible, because the derived
      // rule also requires the declared purpose and posture.
      const obs = goodStageA();
      obs.run.purpose = CANARY;
      obs.run.stage_a_session_number = null;
      assert.strictEqual(scoreStageARun(obs).stage_a_eligible, false,
        `forcing ${id} to PASS made a canary count`);
      const down = goodStageA();
      down.run.mode = 'model-down';
      assert.strictEqual(scoreStageARun(down).stage_a_eligible, false,
        `forcing ${id} to PASS made a model-down run count`);
    } finally {
      Object.defineProperty(condition, 'evaluate', { value: original, configurable: true, writable: true });
    }
  }
});

test('the two counting conditions are in the frozen list and always reported', () => {
  assert.ok(CONDITION_IDS.includes('run_purpose_declared'));
  assert.ok(CONDITION_IDS.includes('stage_a_source_tree_verified'));
  // Even a run with nothing observed reports them, so a condition cannot be dropped from the
  // report to avoid its verdict.
  const empty = scoreStageARun({});
  assert.deepStrictEqual(empty.conditions.map(c => c.id), [...CONDITION_IDS]);
});

// ── the pure identity / count / preflight rules ────────────────────────────────

test('minted identities are disjoint between the two purposes', () => {
  const canary = mintIdentities({ purpose: CANARY, stamp: '20260801T120000', nonce: 'AB12CD' });
  const stageA = mintIdentities({ purpose: STAGE_A_SESSION, sessionNumber: 1, stamp: '20260801T120000', nonce: 'AB12CD' });
  assert.match(canary.session_id, /^CANARY-/);
  assert.match(stageA.session_id, /^STAGEA-S1-/);
  assert.ok(!/STAGEA/i.test(canary.session_id));
  assert.ok(!/CANARY/i.test(stageA.session_id));
  assert.match(stageA.run_id, /^stage-a-s1-/);
  assert.match(stageA.athlete_id, /^stage-a-athlete-/);
  // Owner identifiers are never minted here: every part is either a literal, the stamp, or
  // the nonce this run generated.
  assert.ok(!/dale/i.test(`${stageA.run_id}${stageA.session_id}${stageA.athlete_id}`));
  assert.throws(() => mintIdentities({ purpose: STAGE_A_SESSION, sessionNumber: 0, stamp: 's', nonce: 'n' }));
  assert.throws(() => mintIdentities({ purpose: 'SOMETHING', stamp: 's', nonce: 'n' }));
});

test('identityRefusal names the exact cross-family violation', () => {
  assert.strictEqual(identityRefusal({ purpose: CANARY, sessionId: 'CANARY-x-y' }), null);
  assert.strictEqual(identityRefusal({ purpose: STAGE_A_SESSION, sessionNumber: 2, sessionId: 'STAGEA-S2-x-y' }), null);
  assert.match(identityRefusal({ purpose: STAGE_A_SESSION, sessionNumber: 1, sessionId: 'CANARY-x-y' }), /CANARY marker/);
  assert.match(identityRefusal({ purpose: CANARY, sessionId: 'STAGEA-S1-x-y' }), /Stage A marker/);
  assert.match(identityRefusal({ purpose: STAGE_A_SESSION, sessionNumber: 1, sessionId: 'STAGEA-S2-x-y' }), /session-1 marker/);
  assert.match(identityRefusal({ purpose: 'nonsense', sessionId: 'x' }), /no recognized purpose/);
  assert.match(identityRefusal({ purpose: CANARY, sessionId: '' }), /no synthetic session id/);
});

test('the canonical Stage A count is read from the plan and fails closed', () => {
  assert.deepStrictEqual(
    parseCanonicalStageACount('the ruling records **Stage A: 0/5. Stage B: not open.**'),
    { ok: true, count: 0, reason: null, occurrences: 1 });
  const two = parseCanonicalStageACount('Stage A: 2/5 here and Stage A: 2/5 there');
  assert.strictEqual(two.ok, true);
  assert.strictEqual(two.count, 2);
  // Disagreeing statements are ambiguous, not a majority vote.
  assert.strictEqual(parseCanonicalStageACount('Stage A: 0/5 and Stage A: 1/5').ok, false);
  assert.match(parseCanonicalStageACount('Stage A: 0/5 and Stage A: 1/5').reason, /conflicting/);
  assert.strictEqual(parseCanonicalStageACount('no count here').ok, false);
  assert.strictEqual(parseCanonicalStageACount('').ok, false);
  assert.strictEqual(parseCanonicalStageACount(null).ok, false);
  assert.strictEqual(parseCanonicalStageACount('Stage A: 9/5').ok, false);
});

test('the real execution plan states exactly one unambiguous Stage A count', () => {
  // The parser is only as good as the document. If the plan ever states two different counts,
  // the qualifying command must refuse — and this test is what tells us the plan drifted.
  const planText = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'ATLAS_V1_EXECUTION_PLAN.md'), 'utf8');
  const parsed = parseCanonicalStageACount(planText);
  assert.strictEqual(parsed.ok, true, `the execution plan's Stage A count is unreadable: ${parsed.reason}`);
  assert.ok(isStageASessionNumber(parsed.count) || parsed.count === 0);
});

test('the qualifying preflight refuses every disqualifying condition, and says why', () => {
  const good = {
    purpose: STAGE_A_SESSION,
    sessionNumber: 1,
    mode: 'model-up',
    sessionId: SESSION,
    git: { branch: 'main', clean: true, head: SHA, originHead: SHA },
    priorStageACount: 0,
    env: {
      childCarriesWorkbookId: false, sandboxLiveDeclared: true, declaredWorkbookIsSandbox: true,
      nodeEnvProduction: false, hasServiceAccountEmail: true, hasPrivateKey: true, hasProviderKey: true,
    },
  };
  assert.deepStrictEqual(evaluateStageAPreflight(good), { ok: true, refusals: [] });

  const cases = [
    ['model-down', { mode: 'model-down' }, /model-up only/],
    ['canary purpose', { purpose: CANARY }, /STAGE_A_SESSION runs only/],
    ['no session number', { sessionNumber: undefined }, /--session must be an integer/],
    ['session 2 at 0\/5', { sessionNumber: 2, sessionId: 'STAGEA-S2-x-y' }, /requires the canonical count to be 1/],
    ['session 1 at 1\/5', { priorStageACount: 1 }, /the plan records 1\/5/],
    ['unreadable count', { priorStageACount: null, priorCountReason: 'conflicting' }, /unreadable/],
    ['feature branch', { git: { ...good.git, branch: 'claude/x' } }, /must execute on main/],
    ['dirty tree', { git: { ...good.git, clean: false } }, /clean worktree/],
    ['stale head', { git: { ...good.git, originHead: '0'.repeat(40) } }, /stale/],
    ['inherited workbook id', { env: { ...good.env, childCarriesWorkbookId: true } }, /carries a GOOGLE_SHEETS_ID/],
    ['no sandbox posture', { env: { ...good.env, sandboxLiveDeclared: false } }, /sandbox-live posture/],
    ['not the sandbox workbook', { env: { ...good.env, declaredWorkbookIsSandbox: false } }, /repository-declared sandbox/],
    ['production fingerprint', { env: { ...good.env, nodeEnvProduction: true } }, /production NODE_ENV/],
    ['no provider key', { env: { ...good.env, hasProviderKey: false } }, /GEMINI_API_KEY/],
    ['no service account', { env: { ...good.env, hasServiceAccountEmail: false } }, /GOOGLE_SERVICE_ACCOUNT_EMAIL/],
    ['no private key', { env: { ...good.env, hasPrivateKey: false } }, /GOOGLE_PRIVATE_KEY/],
    ['canary identity', { sessionId: 'CANARY-x-y' }, /CANARY marker/],
  ];
  for (const [label, patch, expected] of cases) {
    const result = evaluateStageAPreflight({ ...good, ...patch });
    assert.strictEqual(result.ok, false, `${label}: the preflight allowed the run`);
    assert.ok(result.refusals.some(r => expected.test(r)),
      `${label}: no refusal matched ${expected}; got ${JSON.stringify(result.refusals)}`);
  }
  // Everything wrong at once reports everything, rather than one restart per fix.
  assert.ok(evaluateStageAPreflight({}).refusals.length > 5);
});

test('normalizePurpose accepts only the two declared purposes', () => {
  assert.strictEqual(normalizePurpose('canary'), CANARY);
  assert.strictEqual(normalizePurpose(' stage_a_session '), STAGE_A_SESSION);
  for (const bad of ['', null, undefined, 'STAGE_A', 'session', 42, {}]) {
    assert.strictEqual(normalizePurpose(bad), null, `normalizePurpose accepted ${JSON.stringify(bad)}`);
  }
});

// ── the default CI lane stays credential-free and write-free ───────────────────

test('the qualifying spec is excluded from the default Playwright lane', () => {
  // The one browser spec talks to a real sandbox workbook. Default CI — and a bare
  // `npx playwright test` — must never collect it, in either purpose.
  const configText = fs.readFileSync(path.join(__dirname, '..', 'playwright.config.js'), 'utf8');
  assert.ok(/testIgnore/.test(configText));
  assert.ok(/ATLAS_GATE_SANDBOX_LIVE/.test(configText));
  assert.ok(/stage-a-canary\.spec\.js/.test(configText));

  // Evaluated as SOURCE rather than by requiring the config, because the config pulls in
  // @playwright/test and this unit suite must stay runnable with nothing but node — that is
  // the same property the exclusion itself protects.
  const ignoreExpr = configText.match(/testIgnore:\s*(.+)/);
  assert.ok(ignoreExpr, 'playwright.config.js no longer declares testIgnore');
  const decide = new Function('process', `return (${ignoreExpr[1].replace(/,\s*$/, '')});`);
  assert.deepStrictEqual(
    decide({ env: {} }),
    ['**/stage-a-canary.spec.js'],
    'without the explicit posture the sandbox-live spec must be ignored');
  assert.deepStrictEqual(
    decide({ env: { ATLAS_GATE_SANDBOX_LIVE: '1' } }), [],
    'under the explicit posture the spec must be collected');
});

test('the qualifying command refuses --model-down and a missing --session at the CLI', () => {
  // The operator command's own argument gate, exercised end to end as a process. It exits
  // before spawning anything, so this needs no credentials, no browser, and no network.
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'scripts', 'atlas-stage-a-session.js');
  const run = (args) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });

  const down = run(['--session=1', '--model-down']);
  assert.strictEqual(down.status, 2);
  assert.match(down.stderr, /model-up only/);

  const noPosture = run(['--session=1']);
  assert.strictEqual(noPosture.status, 2);
  assert.match(noPosture.stderr, /name the posture explicitly/);

  const noSession = run(['--model-up']);
  assert.strictEqual(noSession.status, 2);
  assert.match(noSession.stderr, /--session=<n> is required/);

  const fractional = run(['--session=1.5', '--model-up']);
  assert.strictEqual(fractional.status, 2);

  const zero = run(['--session=0', '--model-up']);
  assert.strictEqual(zero.status, 2);
});
