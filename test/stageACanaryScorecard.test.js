'use strict';

// Stage-A canary scorecard — the bite tests.
//
// These prove the SCORECARD refuses a run that should not pass. They are offline by
// construction: no credentials, no network, no Sheets, no browser, no real write. Every
// case starts from one fully-passing observation set and breaks exactly one thing, so a
// failure names the condition that stopped biting.
//
// Requirements 1–24 from the canary directive are each pinned below and labelled.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  scoreStageARun, renderMarkdown, CONDITION_IDS, NA_CONDITION_ID, NA_REQUIRED_REASON,
} = require('../tests/e2e/gate/stage-a-canary-scorecard');

const SESSION = 'CANARY-20260801T120000-AB12CD';
const TURN = 'turn:2026-08-01T12:00:00.000Z_1_abc123';

// Column indices matching the real contracts closely enough to exercise the comparisons.
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

// A fully-passing run. Every mutation below starts here.
function goodObservations() {
  return {
    run: {
      run_id: 'canary-1', purpose: 'CANARY', mode: 'model-down',
      session_id: SESSION, athlete_id: 'canary-athlete-x',
    },
    expected: {
      sets: SETS.map(s => ({ ...s })),
      effort: { duration: '44:30', active_calories: 366, total_calories: 488, average_hr: 124, peak_hr: 159 },
    },
    server: {
      model_posture: 'model-down', provider_key_present: false, provider_reachable: false,
      coach_model: null, coach_scripted: false,
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
      // Grounding is proven by the ENGINE-answered turn (deterministic lanes run before
      // Gemini, so this grounds in both postures).
      grounded_question: {
        asked: true, reply_text: 'Bench Press today: 185 lbs.', grounded_in_session: true,
      },
      // Provider use is proven by the OPEN turn, which is a different turn.
      model_turn: {
        asked: true, reply_text: 'Keep going.',
        source: 'deterministic', provider_called: false, source_ambiguous: false,
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
      effort_rows: [(() => { const r = []; r[1] = SESSION; r[EFF_IDX.duration] = '44:30'; r[EFF_IDX.active_calories] = '366'; r[EFF_IDX.total_calories] = '488'; r[EFF_IDX.average_hr] = '124'; r[EFF_IDX.peak_hr] = '159'; return r; })()],
      log_column_index: LOG_IDX, effort_column_index: EFF_IDX,
      foreign_identity_rows: 0, other_session_rows_delta: 0, rows_added_by_second_approval: 0,
    },
    trace: { records: [{ turn_id: TURN, valid: true, stages: [{ stage: 'intent', status: 'ok' }], source: 'deterministic' }] },
    // The REAL two-record shape a canary run produces: the dry-run preview, then the
    // authoritative live write on the same turn. Copied from a genuine sandbox run's
    // evidence.json, not invented — an invented shape is how the first version of this
    // condition came to check a field the live envelope never carries.
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

// `mutate` receives the good observations and breaks one thing.
function scoreWith(mutate) {
  const obs = goodObservations();
  mutate(obs);
  return scoreStageARun(obs);
}

// Assert the run does NOT pass, and that the named condition is the one that stopped it.
function assertBites(label, conditionId, wantStatus, mutate) {
  const card = scoreWith(mutate);
  assert.notStrictEqual(card.overall, 'PASS', `${label}: the scorecard still reported PASS`);
  assert.strictEqual(statusOf(card, conditionId), wantStatus,
    `${label}: expected ${conditionId} to be ${wantStatus}, got ${statusOf(card, conditionId)}`);
}

// ── the baseline the mutations are measured against ────────────────────────────

test('a complete, honest model-down run passes with exactly one authorized N/A', () => {
  const card = scoreStageARun(goodObservations());
  const notPassing = card.conditions.filter(c => c.status !== 'PASS' && c.status !== 'NOT_APPLICABLE');
  assert.deepStrictEqual(notPassing.map(c => `${c.id}=${c.status}: ${c.detail}`), []);
  assert.strictEqual(card.overall, 'PASS');
  assert.strictEqual(card.counts.NOT_APPLICABLE, 1);
  assert.strictEqual(statusOf(card, NA_CONDITION_ID), 'NOT_APPLICABLE');
  assert.strictEqual(card.conditions.find(c => c.id === NA_CONDITION_ID).detail, NA_REQUIRED_REASON);
});

test('a passing model-up run requires a positive live-provider marker, not the absence of one', () => {
  const obs = goodObservations();
  obs.run.mode = 'model-up';
  obs.server.model_posture = 'model-up';
  obs.server.provider_key_present = true;
  obs.server.provider_reachable = true;
  obs.server.coach_model = 'gemini-2.5-flash-lite';
  obs.ui.model_turn.provider_called = true;
  obs.ui.model_turn.source = 'live_model';
  const card = scoreStageARun(obs);
  assert.strictEqual(card.overall, 'PASS');
});

test('the canary never claims Stage A credit', () => {
  const card = scoreStageARun(goodObservations());
  assert.strictEqual(card.stage_a_eligible, false);
  assert.strictEqual(card.run.purpose, 'CANARY');
  assert.strictEqual(card.run.stage_a_session_number, null);
  assert.match(card.stage_a_note, /does not count toward the Stage A/i);
  assert.match(card.stage_a_note, /not owner evidence/i);
});

// ── 1-6: sandbox / workbook posture ────────────────────────────────────────────

test('1. an inherited ambient workbook id is refused', () => {
  assertBites('ambient inherited', 'ambient_sheet_not_inherited', 'FAIL', o => {
    o.env.inherited_ambient = true;
    o.env.child_sheet_id_last6 = 'DuDcA0';
  });
});

test('2. an explicitly supplied production workbook is refused', () => {
  assertBites('production supplied', 'ambient_sheet_not_inherited', 'FAIL', o => {
    o.env.child_sheet_id_last6 = 'PR0DXX';
  });
});

test('3. a missing workbook id is ERROR, never a pass', () => {
  assertBites('missing sheet id', 'ambient_sheet_not_inherited', 'ERROR', o => {
    o.env.child_sheet_id_last6 = '';
  });
});

test('4. missing or malformed safe-spreadsheet verification is refused', () => {
  assertBites('preflight absent', 'sandbox_posture_proven', 'ERROR', o => {
    delete o.server.sandbox_preflight;
  });
  assertBites('preflight incomplete', 'sandbox_posture_proven', 'FAIL', o => {
    o.server.sandbox_preflight.ok = false;
  });
});

test('5. a failed required-tab preflight check is refused', () => {
  assertBites('tab absent', 'sandbox_posture_proven', 'FAIL', o => {
    o.server.sandbox_preflight.checks.push({ name: 'tab_present_Effort', ok: false });
  });
});

test('6. fake Sheets active while sandbox-live is claimed is refused', () => {
  assertBites('fake sheets', 'sandbox_posture_proven', 'FAIL', o => {
    o.server.sheets_stubbed_in_memory = true;
  });
  assertBites('not sandbox-live at all', 'sandbox_posture_proven', 'FAIL', o => {
    o.server.sandbox_live = false;
  });
});

// ── 7-9: model posture ─────────────────────────────────────────────────────────

test('7. a model-down server serving a run that claims model-up is refused', () => {
  assertBites('posture mismatch', 'model_posture_proven', 'FAIL', o => {
    o.run.mode = 'model-up';
    // The server is still model-down.
  });
});

test('8. a configured but unreachable provider cannot satisfy model-up', () => {
  assertBites('configured not reachable', 'model_posture_proven', 'FAIL', o => {
    o.run.mode = 'model-up';
    o.server.model_posture = 'model-up';
    o.server.provider_key_present = true;
    o.server.provider_reachable = false;   // "configured: true" alone is not proof
    o.server.coach_model = 'gemini-2.5-flash-lite';
  });
});

test('9. a model-up turn that falls back to the deterministic engine is refused', () => {
  assertBites('model-up fallback', 'model_source_marker', 'FAIL', o => {
    o.run.mode = 'model-up';
    o.server.model_posture = 'model-up';
    o.server.provider_key_present = true;
    o.server.provider_reachable = true;
    o.server.coach_model = 'gemini-2.5-flash-lite';
    o.ui.model_turn.provider_called = false;
    o.ui.model_turn.source = 'deterministic';
  });
});

test('9b. a model-up run with an ambiguous or missing source marker is ERROR', () => {
  const upgrade = o => {
    o.run.mode = 'model-up';
    o.server.model_posture = 'model-up';
    o.server.provider_key_present = true;
    o.server.provider_reachable = true;
    o.server.coach_model = 'gemini-2.5-flash-lite';
    o.ui.model_turn.provider_called = true;
    o.ui.model_turn.source = 'live_model';
  };
  assertBites('ambiguous source', 'model_source_marker', 'ERROR', o => { upgrade(o); o.ui.model_turn.source_ambiguous = true; });
  assertBites('missing source', 'model_source_marker', 'ERROR', o => { upgrade(o); o.ui.model_turn.source = ''; });
});

test('9c. an unexpected model in a model-up run is refused', () => {
  assertBites('wrong model', 'model_posture_proven', 'FAIL', o => {
    o.run.mode = 'model-up';
    o.run.expected_model = 'gemini-2.5-flash-lite';
    o.server.model_posture = 'model-up';
    o.server.provider_key_present = true;
    o.server.provider_reachable = true;
    o.server.coach_model = 'some-other-model';
    o.ui.model_turn.provider_called = true;
    o.ui.model_turn.source = 'live_model';
  });
});

// ── 10-12: the approval loop ───────────────────────────────────────────────────

test('10. a run in which browser approval was never clicked is refused', () => {
  assertBites('no approval', 'browser_approval', 'FAIL', o => { o.ui.approval_clicked = false; });
});

test('11. using a direct write route instead of UI approval is refused', () => {
  assertBites('direct route', 'browser_approval', 'FAIL', o => { o.ui.direct_write_route_used = true; });
  assertBites('wrong control', 'browser_approval', 'FAIL', o => { o.ui.approval_control = 'fetch(/api/log-workout)'; });
  // The first canary attempt clicked the never-visible #approve-btn directly. A run may not
  // record that as the browser gesture, because no athlete could have performed it.
  assertBites('clicked the invisible trigger as the gesture', 'browser_approval', 'FAIL', o => {
    o.ui.approval_control = '#approve-btn';
  });
  assertBites('no write trigger recorded', 'browser_approval', 'FAIL', o => { delete o.ui.write_trigger; });
});

test('12. a write occurring before approval is refused', () => {
  assertBites('durable row pre-approval', 'no_write_before_approval', 'FAIL', o => {
    o.ui.durable_rows_before_approval = 1;
  });
  assertBites('append pre-approval', 'no_write_before_approval', 'FAIL', o => {
    o.ui.appends_before_approval = 1;
  });
});

// ── 13-16: durable rows ────────────────────────────────────────────────────────

test('13. no durable row written is refused', () => {
  assertBites('nothing written', 'durable_log_rows_exact', 'FAIL', o => { o.durable.log_rows = []; });
});

test('14. duplicate durable rows are refused', () => {
  assertBites('duplicate rows', 'durable_log_rows_exact', 'FAIL', o => {
    o.durable.log_rows = o.durable.log_rows.concat([logRow(SETS[0])]);
  });
  assertBites('retry duplicated', 'approval_is_at_most_once', 'FAIL', o => {
    o.durable.rows_added_by_second_approval = 2;
  });
});

test('15. rows for the wrong session or a non-synthetic athlete are refused', () => {
  assertBites('foreign identity', 'no_contamination', 'FAIL', o => { o.durable.foreign_identity_rows = 1; });
  assertBites('cross-session', 'no_contamination', 'FAIL', o => { o.durable.other_session_rows_delta = 3; });
});

test('16. durable values differing from the expected workout are refused', () => {
  assertBites('wrong load', 'durable_log_rows_exact', 'FAIL', o => {
    o.durable.log_rows[0][LOG_IDX.weight] = '235';
  });
  assertBites('wrong reps', 'durable_log_rows_exact', 'FAIL', o => {
    o.durable.log_rows[2][LOG_IDX.reps] = '9';
  });
  assertBites('wrong RIR', 'durable_log_rows_exact', 'FAIL', o => {
    o.durable.log_rows[1][LOG_IDX.rir] = '0';
  });
  assertBites('wrong effort', 'durable_effort_row_exact', 'FAIL', o => {
    o.durable.effort_rows[0][EFF_IDX.peak_hr] = '201';
  });
  assertBites('missing effort row', 'durable_effort_row_exact', 'FAIL', o => {
    o.durable.effort_rows = [];
  });
});

test('16b. an empty durable cell never satisfies an expected value', () => {
  assertBites('blank cell', 'durable_log_rows_exact', 'FAIL', o => {
    o.durable.log_rows[0][LOG_IDX.weight] = '';
  });
});

// ── 17-21: trace, write proof, provenance ──────────────────────────────────────

test('17. a missing InteractionTrace is refused', () => {
  assertBites('no trace records', 'interaction_trace_present', 'FAIL', o => { o.trace.records = []; });
  assertBites('trace absent entirely', 'interaction_trace_present', 'ERROR', o => { delete o.trace.records; });
  assertBites('invalid trace', 'interaction_trace_present', 'FAIL', o => { o.trace.records[0].valid = false; });
});

test('18. a missing turn-write proof is refused', () => {
  assertBites('no write proof', 'turn_write_proof_present', 'FAIL', o => { o.write_proof.records = []; });
  assertBites('only a dry-run record, no live write', 'turn_write_proof_present', 'FAIL', o => {
    o.write_proof.records = [o.write_proof.records[0]];
  });
  assertBites('write proof for another session', 'turn_write_proof_present', 'FAIL', o => {
    o.write_proof.records.forEach(r => { r.session_id = 'CANARY-SOMEONE-ELSE'; });
  });
  // sheet_written belongs to the DRY-RUN envelope and is false there. A record claiming a
  // live write with only that field, and no authoritative sheet_write/row evidence, is not proof.
  assertBites('sheet_written is not live-write proof', 'turn_write_proof_present', 'FAIL', o => {
    o.write_proof.records[1].proof = { sheet_written: true, log_rows_appended: 4 };
  });
  assertBites('success with zero rows is not proof', 'turn_write_proof_present', 'FAIL', o => {
    o.write_proof.records[1].proof.log_rows_written = 0;
  });
  // A published proof must not contradict the run it describes. Positive-but-wrong counts
  // used to pass while the durable readback separately found all five rows.
  assertBites('proof claims fewer log rows than were written', 'turn_write_proof_present', 'FAIL', o => {
    o.write_proof.records[1].proof.log_rows_written = 1;
  });
  assertBites('proof omits the effort row', 'turn_write_proof_present', 'FAIL', o => {
    delete o.write_proof.records[1].proof.effort_rows_written;
  });
  assertBites('proof zeroes the effort row', 'turn_write_proof_present', 'FAIL', o => {
    o.write_proof.records[1].proof.effort_rows_written = 0;
  });
  // The preview must sit on the LIVE WRITE's own turn. A dry run from another turn in the
  // same session used to stand in for it, so a broken correlation could still pass.
  assertBites('preview is on a different turn', 'turn_write_proof_present', 'FAIL', o => {
    o.write_proof.records[0].turn_id = 'turn:2026-08-01T09:00:00.000Z_2_stale0';
  });
  assertBites('a live write still in test_mode is not proof', 'turn_write_proof_present', 'FAIL', o => {
    o.write_proof.records[1].proof.test_mode = true;
  });
  assertBites('two live writes for one approval', 'turn_write_proof_present', 'FAIL', o => {
    o.write_proof.records.push(JSON.parse(JSON.stringify(o.write_proof.records[1])));
  });
  assertBites('a live write with no preview record', 'turn_write_proof_present', 'FAIL', o => {
    o.write_proof.records = [o.write_proof.records[1]];
  });
  assertBites('a live write not established at preview', 'turn_write_proof_present', 'FAIL', o => {
    o.write_proof.records[1].pairing.established_at_preview = false;
  });
  assertBites('a duplicate write', 'turn_write_proof_present', 'FAIL', o => {
    o.write_proof.records[1].proof.duplicate_write = true;
  });
});

test('19. a trace and write proof carrying different turn_ids do not join', () => {
  assertBites('turn id mismatch', 'trace_write_join', 'FAIL', o => {
    o.write_proof.records.forEach(r => { r.turn_id = 'turn:2026-08-01T13:00:00.000Z_9_zzzzzz'; });
  });
  // The trace must join the LIVE WRITE's turn, not merely some write-proof turn. A trace
  // covering only the dry-run turn leaves the actual write uncorrelated.
  assertBites('trace covers only the dry-run turn', 'trace_write_join', 'FAIL', o => {
    o.write_proof.records[1].turn_id = 'turn:2026-08-01T09:30:00.000Z_7_liveee';
  });
});

test('19b. withheld evidence must be distinguishable from absent evidence', () => {
  assertBites('no withheld list', 'evidence_withholding_honest', 'ERROR', o => {
    delete o.write_proof.records[0].withheld_evidence;
  });
});

test('20. missing synthetic provenance is refused', () => {
  assertBites('origin absent', 'synthetic_provenance', 'ERROR', o => { o.provenance.request_origin = ''; });
  assertBites('unrecognized origin', 'synthetic_provenance', 'FAIL', o => { o.provenance.request_origin = 'mystery'; });
  assertBites('session id unmarked', 'synthetic_provenance', 'FAIL', o => { o.run.session_id = '20260801-PM-01'; });
});

test('20b. a canary carrying a Stage A identity is refused', () => {
  // The mirror of the rule that stops canary evidence counting: readiness proof may not
  // dress itself in a counted session's identity either.
  assertBites('canary wearing a Stage A id', 'run_purpose_declared', 'FAIL', o => {
    o.run.session_id = 'STAGEA-S1-20260801T120000-AB12CD';
  });
});

test('21. synthetic evidence labelled as owner evidence is refused', () => {
  assertBites('athlete_ui claim', 'synthetic_provenance', 'FAIL', o => { o.provenance.request_origin = 'athlete_ui'; });
  assertBites('evidence eligible', 'synthetic_provenance', 'FAIL', o => { o.provenance.evidence_eligible = true; });
  assertBites('classified athlete', 'synthetic_provenance', 'FAIL', o => { o.provenance.evidence_class = 'athlete_ui'; });
});

// ── 22: closeout / seal ────────────────────────────────────────────────────────

test('22. a missing closeout or an unsealed state is refused', () => {
  assertBites('no closeout', 'closeout_and_seal', 'FAIL', o => { o.ui.closeout_rendered = false; });
  assertBites('not approved', 'closeout_and_seal', 'FAIL', o => { o.ui.closeout_approved = false; });
  assertBites('not sealed', 'closeout_and_seal', 'FAIL', o => { o.ui.sealed_state_valid = false; });
});

// ── 23-24: the scorecard's own honesty ─────────────────────────────────────────

test('23. a required condition silently downgraded to N/A is refused', () => {
  // Simulate the downgrade by making a decisive condition return N/A. The scorer must
  // convert an unauthorized N/A into ERROR rather than excluding it from the required set.
  const { CONDITIONS } = require('../tests/e2e/gate/stage-a-canary-scorecard');
  const durable = CONDITIONS.find(c => c.id === 'durable_log_rows_exact');
  const original = durable.evaluate;
  try {
    Object.defineProperty(durable, 'evaluate', {
      value: () => ({ status: 'NOT_APPLICABLE', detail: 'not relevant today' }),
      configurable: true, writable: true,
    });
    const card = scoreStageARun(goodObservations());
    assert.strictEqual(statusOf(card, 'durable_log_rows_exact'), 'ERROR',
      'an unauthorized N/A must become ERROR');
    assert.notStrictEqual(card.overall, 'PASS');
    assert.match(card.conditions.find(c => c.id === 'durable_log_rows_exact').detail,
      /NOT_APPLICABLE is not authorized/);
  } finally {
    Object.defineProperty(durable, 'evaluate', { value: original, configurable: true, writable: true });
  }
});

test('23b. the authorized N/A requires the owner ruling\'s exact reason', () => {
  const { CONDITIONS } = require('../tests/e2e/gate/stage-a-canary-scorecard');
  const na = CONDITIONS.find(c => c.id === NA_CONDITION_ID);
  const original = na.evaluate;
  try {
    Object.defineProperty(na, 'evaluate', {
      value: () => ({ status: 'NOT_APPLICABLE', detail: 'not applicable' }),
      configurable: true, writable: true,
    });
    const card = scoreStageARun(goodObservations());
    assert.strictEqual(statusOf(card, NA_CONDITION_ID), 'ERROR');
    assert.notStrictEqual(card.overall, 'PASS');
  } finally {
    Object.defineProperty(na, 'evaluate', { value: original, configurable: true, writable: true });
  }
});

test('23c. an attempted plan-ledger write turns the N/A into ERROR for owner review', () => {
  // The owner ruling is conditional. If the exercised path DOES attempt a plan-ledger
  // write, N/A stops being honest — the result is ERROR and the run stops.
  assertBites('plan write attempted', NA_CONDITION_ID, 'ERROR', o => {
    o.server.appends.push({ tabName: 'Session_Plans', rows: [] });
  });
  assertBites('plan write refused', NA_CONDITION_ID, 'ERROR', o => {
    o.server.refusals.push({ operation: 'appendRows', tabName: 'Session_Plan_Sets', reason: 'outside write set' });
  });
  assertBites('ledger flag on', NA_CONDITION_ID, 'ERROR', o => {
    o.server.ledger_write_flags_off = false;
  });
});

test('24. MUTATION — removing a decisive assertion cannot make a bad run green', () => {
  // The ablation the directive requires: take a run that must FAIL (no durable rows),
  // then delete the observation branch that proves it. A scorecard that only checked what
  // it was handed would go green; this one must stay red because the condition is frozen.
  const bad = goodObservations();
  bad.durable.log_rows = [];
  assert.notStrictEqual(scoreStageARun(bad).overall, 'PASS');

  const ablated = goodObservations();
  delete ablated.durable;          // the whole evidence branch removed
  const card = scoreStageARun(ablated);
  assert.notStrictEqual(card.overall, 'PASS', 'deleting the durable evidence made the run pass');
  assert.strictEqual(statusOf(card, 'durable_log_rows_exact'), 'ERROR');
  assert.strictEqual(statusOf(card, 'durable_effort_row_exact'), 'ERROR');
  assert.strictEqual(statusOf(card, 'no_contamination'), 'ERROR');

  // And an entirely empty observation set is ERROR across the board — never a pass.
  const empty = scoreStageARun({});
  assert.notStrictEqual(empty.overall, 'PASS');
  assert.strictEqual(empty.counts.PASS, 0);
});

test('24b. MUTATION — inverting a decisive assertion is caught by its own bite test', () => {
  // Inversion is proven by construction: every assertBites case above asserts the
  // scorecard reports NOT-PASS for a broken run. This case pins the property those
  // depend on — that the frozen list is emitted in full on every score, so a condition
  // cannot be dropped from the report to avoid its verdict.
  const card = scoreStageARun(goodObservations());
  assert.deepStrictEqual(card.conditions.map(c => c.id), [...CONDITION_IDS]);
  assert.strictEqual(card.conditions.length, CONDITION_IDS.length);
  const badCard = scoreStageARun({ run: { mode: 'model-down' } });
  assert.deepStrictEqual(badCard.conditions.map(c => c.id), [...CONDITION_IDS],
    'a failing run must still report every frozen condition');
});

test('a run where every condition is N/A is never an overall pass', () => {
  const { CONDITIONS } = require('../tests/e2e/gate/stage-a-canary-scorecard');
  const saved = CONDITIONS.map(c => c.evaluate);
  try {
    for (const c of CONDITIONS) {
      Object.defineProperty(c, 'evaluate', {
        value: () => ({ status: 'NOT_APPLICABLE', detail: NA_REQUIRED_REASON }),
        configurable: true, writable: true,
      });
    }
    const card = scoreStageARun(goodObservations());
    assert.notStrictEqual(card.overall, 'PASS');
  } finally {
    CONDITIONS.forEach((c, i) => Object.defineProperty(c, 'evaluate', { value: saved[i], configurable: true, writable: true }));
  }
});

// ── regressions for the three defects Codex found on 89b29bc ───────────────────

test('REGRESSION: durable rows are matched on the contract FIELD name, never the display label', () => {
  // `config/columns.js` holds `session_id`; the workbook header holds "Session ID". Looking up
  // the label returns -1, `row[-1]` is undefined, and the verifier reports an empty workbook for
  // a session that was just written — so the canary would time out after a successful write.
  const { logCleanedColumns, effortColumns } = require('../config/columns');
  assert.ok(logCleanedColumns.indexOf('session_id') >= 0, 'Log_Cleaned contract lost session_id');
  assert.ok(effortColumns.indexOf('session_id') >= 0, 'Effort contract lost session_id');
  assert.strictEqual(logCleanedColumns.indexOf('Session ID'), -1,
    'the display label must NOT resolve — this is the trap the verifier fell into');

  // And the scorecard must reject the resulting empty readback rather than pass it.
  assertBites('label lookup returned nothing', 'durable_log_rows_exact', 'FAIL', o => {
    o.durable.log_rows = [];
  });
});

test('REGRESSION: an eligible turn is judged by its OWN responses, not the whole session', () => {
  // A real model-up run observed six coach responses across the session: an /api/coach/ask
  // log-only pre-check (training_sme), the eligible /api/coach/chat answer (gemini), and four
  // set-logging /api/coach/message turns. Judging the eligible turn by all six called a
  // correct run ambiguous. Scoping must not become leniency, so both directions are pinned.
  const up = o => {
    o.run.mode = 'model-up';
    o.server.model_posture = 'model-up';
    o.server.provider_key_present = true;
    o.server.provider_reachable = true;
    o.server.coach_model = 'gemini-2.5-flash-lite';
  };
  // The eligible turn answered by the live model passes, even though other turns did not.
  const good = goodObservations();
  up(good);
  good.ui.model_turn.provider_called = true;
  good.ui.model_turn.source = 'live_model';
  good.ui.model_turn.source_ambiguous = false;
  assert.strictEqual(statusOf(scoreStageARun(good), 'model_source_marker'), 'PASS');

  // But an eligible turn that produced NO live-provider response still fails — scoping did
  // not make "any gemini anywhere" sufficient.
  assertBites('eligible turn never reached the provider', 'model_source_marker', 'FAIL', o => {
    up(o);
    o.ui.model_turn.provider_called = false;
    o.ui.model_turn.source = 'training_sme';
  });
  // And a live-provider claim that cannot name the model is ambiguous, not a pass.
  assertBites('gemini with no model named', 'model_source_marker', 'ERROR', o => {
    up(o);
    o.ui.model_turn.provider_called = true;
    o.ui.model_turn.source = 'live_model';
    o.ui.model_turn.source_ambiguous = true;
  });
});

test('REGRESSION: model-up proof requires source "gemini", not a route name or the SME path', () => {
  const upgrade = o => {
    o.run.mode = 'model-up';
    o.server.model_posture = 'model-up';
    o.server.provider_key_present = true;
    o.server.provider_reachable = true;
    o.server.coach_model = 'gemini-2.5-flash-lite';
  };
  // The InteractionTrace `source` names the ROUTE (`coach_chat` / `coach_message`) and can never
  // carry a provider name. Treating a route name as a provider marker is a category error.
  for (const routeName of ['coach_chat', 'coach_message', 'coach_ask']) {
    assertBites(`route name ${routeName} is not provider proof`, 'model_source_marker', 'FAIL', o => {
      upgrade(o);
      o.ui.model_turn.provider_called = false;
      o.ui.model_turn.source = routeName;
    });
  }
  // `training_sme` is the SME path, and the directive names it explicitly as not model-up proof.
  assertBites('training_sme is not model-up proof', 'model_source_marker', 'FAIL', o => {
    upgrade(o);
    o.ui.model_turn.provider_called = false;
    o.ui.model_turn.source = 'training_sme';
  });
  // `engine` is the deterministic fallback.
  assertBites('engine is not model-up proof', 'model_source_marker', 'FAIL', o => {
    upgrade(o);
    o.ui.model_turn.provider_called = false;
    o.ui.model_turn.source = 'engine';
  });
  // Only a positive live-provider marker passes.
  const good = goodObservations();
  upgrade(good);
  good.ui.model_turn.provider_called = true;
  good.ui.model_turn.source = 'live_model';
  assert.strictEqual(statusOf(scoreStageARun(good), 'model_source_marker'), 'PASS');
});

test('REGRESSION: a violation found in a screenshot fails the privacy condition', () => {
  // The scan must cover every persisted artifact, not only the JSON the spec authored.
  assertBites('leak in a screenshot', 'artifacts_privacy_safe', 'FAIL', o => {
    o.privacy.violations = [{ kind: 'workbook_id', file: '05-preview-before-write.png' }];
  });
  // Screenshot bytes count toward the stated bound, so a run cannot bypass it by measuring
  // only the JSON.
  assertBites('screenshots push past the byte bound', 'artifacts_privacy_safe', 'FAIL', o => {
    o.privacy.artifact_bytes = o.privacy.artifact_bytes_limit + 1;
  });
});

// ── privacy + schema ───────────────────────────────────────────────────────────

test('privacy violations and unbounded artifacts are refused', () => {
  assertBites('leaked value', 'artifacts_privacy_safe', 'FAIL', o => {
    o.privacy.violations = [{ kind: 'workbook_id' }];
  });
  assertBites('nothing scanned', 'artifacts_privacy_safe', 'ERROR', o => {
    o.privacy.artifacts_scanned = 0;
  });
  assertBites('unbounded artifacts', 'artifacts_privacy_safe', 'FAIL', o => {
    o.privacy.artifact_bytes = 9_000_000;
  });
});

test('any schema mutation attempt is refused', () => {
  assertBites('ensureSheetTab', 'no_schema_mutation', 'FAIL', o => { o.server.ensure_tab_calls = ['Session_Plan_Sets']; });
  assertBites('row deletion', 'no_schema_mutation', 'FAIL', o => { o.server.deletes = [['Log_Cleaned', 2, 3]]; });
  assertBites('cell rewrite', 'no_schema_mutation', 'FAIL', o => { o.server.updates = [{ tabName: 'Log_Cleaned' }]; });
});

test('any guard refusal fails the canary rather than passing quietly', () => {
  assertBites('guard tripped', 'production_non_contact', 'FAIL', o => {
    o.server.refusals = [{ operation: 'appendRows', tabName: 'Brain_Shadow', reason: 'outside write set' }];
  });
  assertBites('off-tab append', 'production_non_contact', 'FAIL', o => {
    o.server.appends.push({ tabName: 'Flight_Recorder', rows: [] });
  });
  assertBites('telemetry persistence on', 'production_non_contact', 'FAIL', o => {
    o.server.telemetry_persistence_off = false;
  });
});

// ── scenario completeness ──────────────────────────────────────────────────────

test('an incomplete scenario cannot pass', () => {
  assertBites('one exercise only', 'genuine_workout_logged', 'FAIL', o => {
    o.ui.exercises_logged = ['Back Squat'];
  });
  assertBites('too few sets', 'genuine_workout_logged', 'FAIL', o => { o.ui.logged_sets = 2; });
  assertBites('no plan', 'plan_established', 'FAIL', o => { o.ui.plan_established = false; });
  assertBites('plan not visible', 'plan_established', 'FAIL', o => { o.ui.plan_remaining_visible = false; });
  assertBites('ungrounded reply', 'grounded_question_answered', 'FAIL', o => {
    o.ui.grounded_question.grounded_in_session = false;
  });
  assertBites('no reply at all', 'grounded_question_answered', 'FAIL', o => {
    o.ui.grounded_question.reply_text = '';
  });
  assertBites('dirty initial state', 'isolated_initial_state', 'FAIL', o => { o.ui.initial_logged_sets = 3; });
  assertBites('session id already used', 'isolated_initial_state', 'FAIL', o => { o.ui.durable_rows_before_run = 4; });
  assertBites('preview shows extra sets', 'preview_before_write', 'FAIL', o => {
    o.ui.preview_sets.push({ exercise: 'Deadlift', weight: 405, reps: 1, rir: 0 });
  });
  assertBites('no preview', 'preview_before_write', 'FAIL', o => { o.ui.preview_rendered = false; });
});

// ── rendering ──────────────────────────────────────────────────────────────────

test('the markdown scorecard renders every condition and never leaks a workbook id', () => {
  const md = renderMarkdown(scoreStageARun(goodObservations()));
  for (const id of CONDITION_IDS) {
    const title = require('../tests/e2e/gate/stage-a-canary-scorecard').CONDITIONS.find(c => c.id === id).title;
    assert.ok(md.includes(title), `markdown is missing condition ${id}`);
  }
  assert.ok(md.includes('**Overall: PASS**'));
  assert.ok(md.includes('**stage_a_eligible: false**'), 'a canary scorecard must state its ineligibility in the rendered card');
  assert.ok(md.includes('does not count toward the Stage A'));
  assert.ok(!/1UuprDIBoV2Y9jEraOkKaqdX1PHE6ESiF9ZLFJH3CeXE/.test(md), 'the markdown leaked the full workbook id');
});
