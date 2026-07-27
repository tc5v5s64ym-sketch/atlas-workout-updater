'use strict';

// Guard-bite coverage for services/turnWriteArtifact.js.
//
// Rule 8: a guard is only real if it bites. A mutation sweep over the consumer — delete each
// production check in turn, run the focused suite — found that 52 of its 91 checks were proven by
// existing tests and 39 were not. A second, differential pass classified those 39: for each, does a
// CONSTRUCTIBLE input exist whose artifact output changes when the guard is removed? Where the
// answer is yes, the check is load-bearing and untested, and the case belongs here.
//
// The production logic was right throughout — every guard already behaved as its comment claimed.
// What was missing was the proof, and an unproven guard is what lets a later "simplification"
// delete a real check silently.
//
// Each test asserts the behavior that DIFFERS when its guard is removed, and carries the positive
// producer control beside it, so it fails for the intended reason rather than by coincidence.
//
// A note on how the first differential corpus was wrong, because it is the same defect this file
// exists to prevent: it varied many fields per record, so a probe aimed at (say) the sheet_write
// vocabulary was usually rejected for an unrelated malformed field before ever reaching that check,
// and 19 load-bearing guards read as redundant. Every probe below varies EXACTLY ONE field from a
// valid producer shape.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildTurnWriteArtifact } = require('../services/turnWriteArtifact');
const { MAX_WRITES_PER_PAIRING } = require('../services/turnCorrelation');

const TURN = 'turn:2026-07-27T09:00:00.000Z_1_aaaaaa';
const SESSION = 'session-2026-07-27-a';

function trace(overrides = {}) {
  return {
    turn_id: TURN,
    started_at: '2026-07-27T09:00:00.000Z',
    valid: true,
    intent_type: 'set',
    source: 'coach_message',
    stages: [
      { stage: 'intent', status: 'ok' },
      { stage: 'session_snapshot', status: 'ok' },
      { stage: 'engine_decision', status: 'ok' },
      { stage: 'coaching_strategy', status: 'ok' },
      { stage: 'model_response', status: 'ok' },
      { stage: 'validator_result', status: 'ok' },
      { stage: 'rendered_output', status: 'ok' },
    ],
    missing: ['parser', 'knowledge_retrieval', 'write_proof'],
    ...overrides,
  };
}

// A live /api/log-workout success: the shape the route actually emits.
function proofRecord(overrides = {}, proofOverrides = {}) {
  const record = {
    schema_version: 1,
    turn_id: TURN,
    session_id: SESSION,
    route: '/api/log-workout',
    recorded_at: '2026-07-27T09:00:02.000Z',
    pairing: {
      established_at_preview: true,
      write_attempt: 1,
      previewed_write_id_match: null,
      payload_bound: true,
      effort_transition: false,
    },
    proof: {
      test_mode: false,
      sheet_write: 'success',
      duplicate_write: false,
      idempotency_status: 'completed',
      logAppendedRange: 'Log_Cleaned!A2:L4',
      log_rows_written: 3,
      effort_rows_written: 0,
      ...proofOverrides,
    },
    withheld_evidence: [],
    ...overrides,
  };
  for (const [key, value] of Object.entries(proofOverrides)) {
    if (value === undefined) delete record.proof[key];
  }
  return record;
}

// The all-rows-duplicate branch, which index.js correlates only when a seal or closeout envelope
// exists (index.js:3276).
const SEAL_REPLAY = {
  ledger_seal_sealed_ok: true,
  ledger_seal_sheet_written: false,
  ledger_seal_no_write_confirmed: true,
  ledger_seal_sealed: 0,
  ledger_seal_already_sealed: 4,
  ledger_seal_reason: 'all_sealed',
};
const CLOSEOUT_SKIPPED = {
  session_plans_closeout_status: 'skipped',
  session_plans_closeout_captured: true,
  session_plans_closeout_written: 0,
  session_plans_closeout_skipped: 1,
  session_plans_closeout_plan_version: 'pv_11111111-2222-3333-4444-555555555555',
};
// A genuine fresh stamp and the finalized closeout capture that always accompanies it.
const SEAL_STAMPED_FRESH = {
  ledger_seal_sealed_ok: true,
  ledger_seal_sheet_written: true,
  ledger_seal_no_write_confirmed: false,
  ledger_seal_sealed: 3,
  ledger_seal_already_sealed: 0,
};
const CLOSEOUT_WRITTEN_FRESH = {
  session_plans_closeout_status: 'written',
  session_plans_closeout_captured: true,
  session_plans_closeout_written: 1,
  session_plans_closeout_skipped: 0,
  session_plans_closeout_plan_version: 'pv_11111111-2222-3333-4444-555555555555',
};
const DUPLICATE_SCALARS = {
  test_mode: false,
  sheet_write: 'skipped_duplicate',
  sheet_written: false,
  duplicate_write: true,
  log_rows_written: 0,
  skipped_duplicates: 3,
  idempotency_status: 'completed',
  closeout_fully_verified: true,
  logAppendedRange: undefined,
  effort_rows_written: undefined,
};

function duplicateRecord(proofOverrides = {}, overrides = {}) {
  return proofRecord(overrides, { ...DUPLICATE_SCALARS, ...proofOverrides });
}

function lines(...records) {
  return records
    .map((record) => (typeof record === 'string'
      ? record
      : `2026-07-27T09:00:05Z ${record.schema_version === undefined ? '[interaction-trace]' : '[turn-write-proof]'} ${JSON.stringify(record)}`))
    .join('\n');
}

const build = (...records) => buildTurnWriteArtifact(lines(...records));
const firstWrite = (artifact) => artifact.turns[0].writes[0];
const previewArtifactOf = (artifact) => artifact.turns[0].previews[0];

// A record the consumer rejected outright never becomes a write, and the turn reports the loss.
function assertRejected(artifact, why) {
  assert.equal(artifact.summary.rejected_records, 1, why);
  assert.equal(artifact.turns[0].writes.length, 0, why);
  assert.ok(artifact.turns[0].issues.includes('rejected_write_record'), why);
  assert.equal(artifact.status, 'partial', why);
}

// Every rejection test needs this beside it: the same record, unmutated, must survive.
function assertControlAccepted(artifact) {
  assert.equal(artifact.summary.rejected_records, 0, 'control record must not be rejected');
  assert.equal(artifact.turns[0].writes.length, 1, 'control record must produce a write');
  assert.equal(firstWrite(artifact).proof_state, 'write_confirmed');
  assert.equal(artifact.status, 'complete');
}

describe('turnWriteArtifact guards — interaction trace validation', () => {
  it('rejects a trace whose started_at is not an ISO timestamp', () => {
    const artifact = build(trace({ started_at: 'yesterday' }), proofRecord());
    assert.equal(artifact.turns[0].join_status, 'proof_only');
    assert.ok(artifact.turns[0].issues.includes('trace_missing'));
    assert.notEqual(artifact.status, 'complete');

    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a timestamp naming a calendar day that does not exist', () => {
    // Date.parse NORMALIZES an out-of-range day inside a valid month rather than refusing it:
    // 2026-02-30 silently becomes 2026-03-02. A regex-plus-parse pair therefore accepts a record
    // whose timestamp names a day no calendar has, and then reports a different day than the one
    // written. Month 13 and hour 25 already parse to NaN; the day of month was the gap.
    for (const stamp of ['2026-02-30T09:00:00.000Z', '2026-04-31T09:00:00.000Z', '2026-02-29T09:00:00.000Z']) {
      const onTrace = build(trace({ started_at: stamp }), proofRecord());
      assert.equal(onTrace.turns[0].join_status, 'proof_only', `trace started_at ${stamp}`);
      assertRejected(build(trace(), proofRecord({ recorded_at: stamp })), `proof recorded_at ${stamp}`);
    }

    // CONTROL — a real leap day, and the no-millisecond form the trace contract accepts, must both
    // survive. Rejecting either would be a false negative, which on this consumer discards the
    // record together with any committed write proof it carried.
    const leapDay = build(trace({ started_at: '2024-02-29T09:00:00.000Z' }), proofRecord());
    assert.equal(leapDay.turns[0].join_status, 'joined');
    assert.equal(leapDay.status, 'complete');

    const noMillis = build(trace({ started_at: '2026-07-27T09:00:00Z' }), proofRecord({ recorded_at: '2026-07-27T09:00:02Z' }));
    assert.equal(noMillis.turns[0].join_status, 'joined');
    assert.equal(noMillis.status, 'complete');

    // CONTROL — a century non-leap year is genuinely invalid, a 400-year leap year is not.
    assert.equal(build(trace({ started_at: '2100-02-29T09:00:00.000Z' }), proofRecord()).turns[0].join_status, 'proof_only');
    assert.equal(build(trace({ started_at: '2000-02-29T09:00:00.000Z' }), proofRecord()).turns[0].join_status, 'joined');
  });

  it('rejects a trace whose valid flag is not a boolean', () => {
    const artifact = build(trace({ valid: 'yes' }), proofRecord());
    assert.equal(artifact.turns[0].join_status, 'proof_only');
    assert.ok(artifact.turns[0].issues.includes('trace_missing'));
  });

  it('rejects a trace whose stages are out of canonical order or repeated', () => {
    const ordered = trace().stages;
    const reversed = build(trace({ stages: ordered.slice().reverse() }), proofRecord());
    assert.equal(reversed.turns[0].join_status, 'proof_only', 'reversed stages are not a producible trace');

    const repeated = build(
      trace({ stages: [...ordered, { stage: 'intent', status: 'ok' }] }),
      proofRecord(),
    );
    assert.equal(repeated.turns[0].join_status, 'proof_only', 'a repeated stage is not producible');

    // CONTROL — the real emitter's ascending, unique stage list.
    assert.equal(build(trace(), proofRecord()).turns[0].join_status, 'joined');
  });

  it('flags a trace the producer marked invalid rather than reporting it reviewable', () => {
    const artifact = build(trace({ valid: false }), proofRecord());
    assert.ok(artifact.turns[0].issues.includes('trace_invalid'));
    assert.equal(artifact.turns[0].reviewable, false);
    assert.notEqual(artifact.status, 'complete');

    assertControlAccepted(build(trace(), proofRecord()));
  });
});

describe('turnWriteArtifact guards — write-proof record validation', () => {
  it('rejects a proof record whose schema_version is not 1', () => {
    assertRejected(build(trace(), proofRecord({ schema_version: 2 })), 'schema_version 2 is not this contract');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a proof record whose route is not a known write route', () => {
    assertRejected(build(trace(), proofRecord({ route: '/api/undo' })), 'undo is not a correlated write route');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a proof record whose recorded_at is not an ISO timestamp', () => {
    assertRejected(build(trace(), proofRecord({ recorded_at: 'just now' })), 'recorded_at must be ISO 8601');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a session_id longer than the bounded producer contract', () => {
    assertRejected(build(trace(), proofRecord({ session_id: 'x'.repeat(200) })), 'session_id is bounded');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a write_attempt above the cap the producer refuses to exceed', () => {
    // turnCorrelation.js:836 REFUSES a further attempt, so an attempt beyond the cap is a shape no
    // producer can emit — unlike the preview history, where the registry merely evicts.
    assertRejected(
      build(trace(), proofRecord({
        pairing: { ...proofRecord().pairing, write_attempt: MAX_WRITES_PER_PAIRING + 4 },
      })),
      'a write attempt past the cap is producer-impossible',
    );

    // CONTROL — the highest attempt the producer CAN emit is still accepted.
    const atCap = build(trace(), proofRecord({
      pairing: { ...proofRecord().pairing, write_attempt: MAX_WRITES_PER_PAIRING },
    }));
    assert.equal(atCap.summary.rejected_records, 0);
    assert.equal(atCap.turns[0].writes.length, 1);
  });

  it('rejects a pairing whose boolean fields are not booleans', () => {
    assertRejected(
      build(trace(), proofRecord({ pairing: { ...proofRecord().pairing, payload_bound: 'true' } })),
      'payload_bound is a boolean in every emitted pairing',
    );
    assertRejected(
      build(trace(), proofRecord({ pairing: { ...proofRecord().pairing, effort_transition: 2 } })),
      'effort_transition is a boolean in every emitted pairing',
    );
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a proof whose boolean field carries a non-boolean', () => {
    assertRejected(build(trace(), proofRecord({}, { test_mode: 'false' })), 'a string is not the W2 flag');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a sheet_write state outside the emitted vocabulary', () => {
    assertRejected(build(trace(), proofRecord({}, { sheet_write: 'committed' })), 'committed is not an emitted state');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects an idempotency_status outside the emitted vocabulary', () => {
    assertRejected(build(trace(), proofRecord({}, { idempotency_status: 'done' })), 'done is not an emitted status');
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a closeout status outside the emitted vocabulary', () => {
    assertRejected(
      build(trace(), proofRecord({}, { ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, session_plans_closeout_status: 'ok' })),
      'ok is not a closeout status any producer emits',
    );

    // CONTROL — the same record with the real status is accepted and reviewed.
    const control = build(trace(), proofRecord({}, {
      ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, closeout_fully_verified: true,
    }));
    assert.equal(control.summary.rejected_records, 0);
    assert.equal(control.turns[0].writes.length, 1);
  });

  it('rejects a plan_version that is not the producer identity shape', () => {
    assertRejected(
      build(trace(), proofRecord({}, {
        ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, session_plans_closeout_plan_version: 'Log_Cleaned!A2:L4',
      })),
      'a Sheet range is not a plan version',
    );

    const control = build(trace(), proofRecord({}, {
      ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, closeout_fully_verified: true,
    }));
    assert.equal(control.summary.rejected_records, 0);
  });
});

describe('turnWriteArtifact guards — withheld evidence', () => {
  it('rejects a withheld_evidence that is not an array', () => {
    // Without this the consumer iterates a non-iterable and throws, taking the whole run down.
    assertRejected(build(trace(), proofRecord({ withheld_evidence: 'ledger_seal_sealed' })), 'must be an array');
    assert.doesNotThrow(() => build(trace(), proofRecord({ withheld_evidence: 5 })));
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('rejects a withheld key outside the projection, and a repeated one', () => {
    assertRejected(build(trace(), proofRecord({ withheld_evidence: ['not_a_key'] })), 'not a projected key');
    assertRejected(
      build(trace(), proofRecord({ withheld_evidence: ['ledger_seal_sealed', 'ledger_seal_sealed'] })),
      'a key cannot be withheld twice',
    );

    // CONTROL — a single genuinely projected key is accepted and reported as withheld.
    const control = build(trace(), proofRecord({ withheld_evidence: ['ledger_seal_sealed'] }));
    assert.equal(control.summary.rejected_records, 0);
    assert.ok(firstWrite(control).issues.includes('evidence_withheld'));
  });

  it('rejects a key claimed both withheld and present', () => {
    assertRejected(
      build(trace(), proofRecord({ withheld_evidence: ['ledger_seal_sealed'] }, {
        ...SEAL_REPLAY, ledger_seal_sealed: 0,
      })),
      'evidence cannot be both withheld and supplied',
    );
  });
});

describe('turnWriteArtifact guards — seal presentation', () => {
  it('rejects a session id the producer could never have stored', () => {
    // `buildWriteProofRecord` stores the TRIMMED id and turns a whitespace-only value into `null`
    // (turnCorrelation.js:942), which this consumer reads as `absent` and reports via
    // `session_missing`. So a padded or blank id is producer-impossible — and a length-only check
    // accepted `'   '`, reported it as `present`, and produced a complete artifact with no issues,
    // bypassing the very issue the null case exists to raise.
    for (const bad of ['   ', ' session-a', 'session-a ', '\t']) {
      assertRejected(build(trace(), proofRecord({ session_id: bad })), `untrimmed id: ${JSON.stringify(bad)}`);
    }

    // CONTROL — a null id is genuinely producible and must be reported, not rejected.
    const missing = build(trace(), proofRecord({ session_id: null }));
    assert.equal(missing.summary.rejected_records, 0);
    assert.ok(missing.turns[0].issues.includes('session_missing'));

    // CONTROL — an ordinary trimmed id is accepted.
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('never publishes the session id, which no contract constrains', () => {
    // `OPAQUE_SESSION_ID` proves the value has no whitespace, `!` or `:` — it does NOT prove the
    // value is an identifier. The routes and client require only a bounded trimmed string
    // (index.js; src/app/turnCorrelation.js validSessionId), so compact workout text or a Sheet
    // identifier passes the character class and was emitted verbatim in a `complete` artifact —
    // exactly the prose this consumer claims has no output path.
    //
    // There is no shape that could prove opacity, because the producer imposes none. So the id is
    // never published at all: `session_identity` reports whether one was recorded, and the
    // canonical `turn_id` — which IS a validated bounded shape — is what locates the turn.
    for (const sessionId of ['BenchPress225x5RIR2', 'Log_Cleaned', SESSION]) {
      const artifact = build(trace(), proofRecord({ session_id: sessionId }));
      const serialized = JSON.stringify(artifact);
      assert.ok(!serialized.includes(sessionId), `session id must not appear: ${sessionId}`);
      assert.equal(firstWrite(artifact).session_id, undefined);
      assert.equal(firstWrite(artifact).session_identity, 'present');
    }

    // CONTROL — cross-session contamination is still detected, because the comparison happens on
    // the retained record rather than on anything published.
    const other = proofRecord({
      session_id: 'session-b',
      recorded_at: '2026-07-27T09:00:09.000Z',
      pairing: { ...proofRecord().pairing, write_attempt: 2 },
    });
    const mixed = build(trace(), proofRecord(), other);
    assert.ok(mixed.turns[0].issues.includes('conflicting_sessions'));
    assert.ok(!JSON.stringify(mixed).includes('session-b'));
  });

  it('constrains the idempotency and no-write fields to the bodies that emit them', () => {
    // `no_write_confirmed` is emitted only beside `sheet_write:'skipped'` (the four preview and
    // dry-run bodies: index.js:1367, 1975, 3129, 2750) and `'blocked_schema_drift'`
    // (index.js:457-458). A live success body never carries it.
    const onSuccess = build(trace(), proofRecord({}, { no_write_confirmed: false }));
    assert.ok(firstWrite(onSuccess).issues.includes('impossible_fields_for_route'));
    assert.equal(firstWrite(onSuccess).proof.no_write_confirmed, undefined);

    // `duplicate_write` and `idempotency_status` are set inside `if (idempotency.enabled)` on live
    // bodies only; a preview registers no write and carries neither.
    const preview = build(trace(), proofRecord({
      pairing: {
        established_at_preview: true,
        write_attempt: 0,
        previewed_write_id_match: null,
        payload_bound: false,
        effort_transition: false,
      },
    }, {
      test_mode: true,
      sheet_write: 'skipped',
      sheet_written: false,
      no_write_confirmed: true,
      duplicate_write: false,
      idempotency_status: 'completed',
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
    }), proofRecord());
    const previewArtifact = previewArtifactOf(preview);
    assert.ok(previewArtifact.issues.includes('impossible_fields_for_route'));
    assert.equal(previewArtifact.proof.duplicate_write, undefined);
    assert.equal(previewArtifact.proof.idempotency_status, undefined);

    // CONTROLS — each field on a body that genuinely emits it.
    assertControlAccepted(build(trace(), proofRecord()));
    const drift = build(trace(), proofRecord({}, {
      sheet_write: 'blocked_schema_drift',
      sheet_written: false,
      no_write_confirmed: true,
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
      duplicate_write: undefined,
      idempotency_status: undefined,
    }));
    assert.ok(!firstWrite(drift).issues.includes('impossible_fields_for_route'));
    assert.equal(firstWrite(drift).proof.no_write_confirmed, true);
  });

  it('rejects the preview tuple on a positive write attempt', () => {
    // `write_attempt` is `rec.writeIds.indexOf(writeId) + 1` (turnCorrelation.js:551), so a
    // positive attempt exists only where a LIVE write registered a write_id. The preview tuple is
    // emitted solely through `isPreview`, which yields attempt 0. A record carrying that exact
    // tuple at attempt > 0 is therefore impossible — and it was classified `no_write_confirmed`
    // with no issues and an overall `complete` status, i.e. a fabricated non-write presented as a
    // reviewable write.
    const artifact = build(trace(), proofRecord({}, {
      test_mode: true,
      sheet_write: 'skipped',
      sheet_written: false,
      no_write_confirmed: true,
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
      duplicate_write: undefined,
      idempotency_status: undefined,
    }));
    assertRejected(artifact, 'the preview tuple cannot occur on a live attempt');

    // CONTROL — the same tuple at attempt 0 is the genuine preview and stays reviewable.
    const preview = build(trace(), proofRecord({
      pairing: {
        established_at_preview: true,
        write_attempt: 0,
        previewed_write_id_match: null,
        payload_bound: false,
        effort_transition: false,
      },
    }, {
      test_mode: true,
      sheet_write: 'skipped',
      sheet_written: false,
      no_write_confirmed: true,
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
      duplicate_write: undefined,
      idempotency_status: undefined,
    }), proofRecord());
    assert.equal(preview.summary.rejected_records, 0);
    assert.equal(preview.turns[0].previews[0].proof_state, 'no_write_confirmed');
  });

  it('constrains fields by state and attempt, not only by route', () => {
    // `effortWritten` is emitted on `/api/log-workout`'s preview, partial and success bodies
    // (index.js:3130, 3363, 3418) — but NOT on the correlated all-rows-duplicate body
    // (index.js:3238-3247), which lists its fields exhaustively and has no such key.
    const onDuplicate = build(trace(), duplicateRecord({
      ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, effortWritten: true,
    }));
    assert.ok(firstWrite(onDuplicate).issues.includes('impossible_fields_for_route'));
    assert.equal(firstWrite(onDuplicate).proof.effortWritten, undefined);

    // Top-level `dry_run` has no production emitter at all: the real field is nested inside the
    // seal envelope and reaches the consumer as `ledger_seal_dry_run`. A second `rows_appended`.
    const dryRun = build(trace(), proofRecord({}, { dry_run: true }));
    assert.ok(firstWrite(dryRun).issues.includes('impossible_fields_for_route'));
    assert.equal(firstWrite(dryRun).proof.dry_run, undefined);

    // CONTROLS — `effortWritten` on the bodies that do emit it, and the projected seal dry-run flag.
    const onSuccess = build(trace(), proofRecord({}, { effortWritten: false }));
    assert.deepEqual(firstWrite(onSuccess).issues, []);

    const sealDryRun = build(trace(), proofRecord({}, {
      ledger_seal_sealed_ok: true,
      ledger_seal_sheet_written: false,
      ledger_seal_no_write_confirmed: true,
      ledger_seal_dry_run: true,
      ledger_seal_sealed: 0,
      ledger_seal_already_sealed: 0,
      ledger_seal_would_seal: 2,
      ledger_seal_reason: 'test_mode',
      ...CLOSEOUT_SKIPPED,
      closeout_fully_verified: true,
    }));
    assert.equal(firstWrite(sealDryRun).proof.ledger_seal_dry_run, true);
    assert.ok(!firstWrite(sealDryRun).issues.includes('impossible_fields_for_route'));
  });

  it('drops every proof field whose producer conjunction the record does not satisfy', () => {
    // Gating only the two per-tab counts left the rest of the whitelist publishable. Each of these
    // was verified against its emitters:
    //   rows_appended      — NO production emitter anywhere in the repository. It survives only in
    //                        the PROOF_KEYS whitelist (turnCorrelation.js:188), so any record
    //                        carrying it is fabricated by definition.
    //   skipped_duplicates — /api/log-workout only (index.js:3246 duplicate body, 3427 success).
    //   effortWritten      — /api/log-workout only (index.js:3130, 3363, 3418).
    //   sheet_written      — every body EXCEPT /api/log-workout's success (index.js:3413-3421).
    const cases = [
      { label: 'rows_appended on any route', route: '/api/bodyweight', over: { sheet_written: true, rows_appended: 999 }, dropped: 'rows_appended' },
      { label: 'rows_appended on log-workout', route: '/api/log-workout', over: { rows_appended: 999 }, dropped: 'rows_appended' },
      { label: 'skipped_duplicates on bodyweight', route: '/api/bodyweight', over: { sheet_written: true, skipped_duplicates: 888 }, dropped: 'skipped_duplicates' },
      { label: 'effortWritten on bodyweight', route: '/api/bodyweight', over: { sheet_written: true, effortWritten: true }, dropped: 'effortWritten' },
      { label: 'sheet_written on a log-workout success', route: '/api/log-workout', over: { sheet_written: true }, dropped: 'sheet_written' },
    ];
    for (const { label, route, over, dropped } of cases) {
      const base = route === '/api/log-workout'
        ? over
        : { ...over, logAppendedRange: undefined, log_rows_written: undefined, effort_rows_written: undefined };
      const artifact = build(trace(), proofRecord({ route }, base));
      const write = firstWrite(artifact);
      assert.ok(write.issues.includes('impossible_fields_for_route'), label);
      assert.equal(write.proof[dropped], undefined, `${label}: ${dropped} must not be republished`);
      assert.equal(artifact.turns[0].reviewable, false, label);
    }

    // CONTROLS — each field on the body that genuinely emits it.
    const logSuccess = build(trace(), proofRecord({}, { effortWritten: false, skipped_duplicates: 2 }));
    assert.deepEqual(firstWrite(logSuccess).issues, [], 'log-workout success emits both');
    assert.equal(logSuccess.status, 'complete');

    const genericSuccess = build(trace(), proofRecord({ route: '/api/bodyweight' }, {
      sheet_written: true,
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
    }));
    assert.deepEqual(firstWrite(genericSuccess).issues, [], 'bodyweight success emits sheet_written');
    assert.equal(genericSuccess.status, 'complete');
  });

  it('will not let a sidecar establish a confirmed write on an unsubstantiated duplicate', () => {
    // A positive seal is a positive write, and `positiveWrite` returned `write_confirmed` before
    // the duplicate tuple was ever checked. So a `skipped_duplicate` record that omitted
    // test_mode, sheet_written, duplicate_write, log_rows_written, skipped_duplicates and
    // idempotency_status still read as a complete, reviewable confirmed write on the strength of
    // its seal alone. The real all-rows-duplicate producer (index.js:3237-3267) always emits that
    // whole tuple.
    const artifact = build(trace(), proofRecord({}, {
      sheet_write: 'skipped_duplicate',
      sheet_written: undefined,
      test_mode: undefined,
      duplicate_write: undefined,
      idempotency_status: undefined,
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
      ...SEAL_STAMPED_FRESH,
      ...CLOSEOUT_WRITTEN_FRESH,
      closeout_fully_verified: true,
    }));
    assert.notEqual(firstWrite(artifact).proof_state, 'write_confirmed');
    assert.equal(artifact.turns[0].reviewable, false);

    // CONTROL — the real duplicate body carrying its whole tuple beside a FRESH stamp is the F10D
    // heal, and that genuinely is a confirmed sidecar write.
    const healed = build(trace(), duplicateRecord({
      ...SEAL_STAMPED_FRESH, ...CLOSEOUT_WRITTEN_FRESH,
    }));
    assert.equal(firstWrite(healed).proof_state, 'write_confirmed');
    assert.deepEqual(firstWrite(healed).issues, []);

    // CONTROL — the same tuple with a REPLAY seal stays the no-write duplicate classification.
    const replay = build(trace(), duplicateRecord({ ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED }));
    assert.equal(firstWrite(replay).proof_state, 'idempotent_no_write');
  });

  it('never publishes Log/Effort tab evidence from a route that does not touch those tabs', () => {
    // `/api/log-modality` appends to Modality_Log and `/api/bodyweight` to Bodyweight
    // (index.js:1405, 2022). Neither success body carries a row count of any kind
    // (index.js:1407-1423, 2024-2036). So a bodyweight proof claiming 999 Log rows is not a
    // producer shape at all — and it was being classified `write_confirmed` AND republished, so
    // the artifact reported writes to tabs that route never touched.
    for (const route of ['/api/log-modality', '/api/bodyweight']) {
      const artifact = build(trace(), proofRecord({ route }, {
        sheet_written: true,
        log_rows_written: 999,
        effort_rows_written: 7,
        logAppendedRange: 'Log_Cleaned!A2:L1000',
      }));
      const write = firstWrite(artifact);
      assert.ok(write.issues.includes('impossible_fields_for_route'), route);
      assert.equal(artifact.turns[0].reviewable, false, route);
      // The fabricated numbers must not be republished at all.
      assert.equal(write.proof.log_rows_written, undefined, route);
      assert.equal(write.proof.effort_rows_written, undefined, route);
    }

    // CONTROL — the real generic success body, which carries no counts, is untouched.
    for (const route of ['/api/log-modality', '/api/bodyweight']) {
      const plain = build(trace(), proofRecord({ route }, {
        sheet_written: true,
        logAppendedRange: undefined,
        log_rows_written: undefined,
        effort_rows_written: undefined,
      }));
      assert.deepEqual(firstWrite(plain).issues, [], route);
      assert.equal(plain.status, 'complete', route);
    }

    // CONTROL — the per-tab routes keep their counts, which are their whole W3 proof.
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('refuses sidecar evidence on states and attempts that cannot carry it', () => {
    // Route alone is not the whole producer condition. `/api/log-workout` attaches sidecars on
    // exactly two bodies: the normal success (index.js:3413-3426, `sheet_write:'success'`) and the
    // correlated all-rows-duplicate branch (index.js:3238-3264, `sheet_write:'skipped_duplicate'`).
    // Never on a preview, and never on `blocked_schema_drift`, which is raised by the shared
    // header-drift guard at index.js:456 long before any seal is attempted.
    const sidecar = { ...SEAL_STAMPED_FRESH, ...CLOSEOUT_WRITTEN_FRESH, closeout_fully_verified: true };

    const drift = build(trace(), proofRecord({}, {
      ...sidecar,
      sheet_write: 'blocked_schema_drift',
      sheet_written: false,
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
    }));
    assert.ok(firstWrite(drift).issues.includes('sidecar_evidence_impossible_for_state'));
    assert.equal(drift.turns[0].reviewable, false);
    assert.notEqual(drift.status, 'complete');
    // Deliberately NOT asserting the proof_state here. Classification and diagnosis are separate
    // (rule 4): `proof_state` reports what the evidence claims — and a fresh seal genuinely is a
    // positive write — while the ISSUE is what says the shape is impossible. An earlier version of
    // this control demanded the classification change too, which would have meant teaching the
    // classifier to second-guess its own inputs rather than reporting them and flagging the record.

    const preview = build(trace(), proofRecord({
      pairing: {
        established_at_preview: true,
        write_attempt: 0,
        previewed_write_id_match: null,
        payload_bound: false,
        effort_transition: false,
      },
    }, {
      ...sidecar,
      test_mode: true,
      sheet_write: 'skipped',
      sheet_written: false,
      no_write_confirmed: true,
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
      duplicate_write: undefined,
      idempotency_status: undefined,
    }), proofRecord());
    assert.ok(preview.turns[0].previews[0].issues.includes('sidecar_evidence_impossible_for_state'));

    // CONTROLS — the two bodies that genuinely carry sidecars.
    const onSuccess = build(trace(), proofRecord({}, sidecar));
    assert.deepEqual(firstWrite(onSuccess).issues, []);

    const onDuplicate = build(trace(), duplicateRecord({ ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED }));
    assert.deepEqual(firstWrite(onDuplicate).issues, []);
  });

  it('refuses a closeout verdict with no sidecar evidence to identify what was verified', () => {
    // `closeout_fully_verified` is attached only inside the sidecar blocks (index.js:3259, 3262,
    // 3425), so a plain success carrying the verdict alone is unreachable — and it claims closeout
    // verification while naming nothing that was verified.
    const verdictOnly = build(trace(), proofRecord({}, { closeout_fully_verified: true }));
    assert.ok(firstWrite(verdictOnly).issues.includes('closeout_verdict_unsupported'));
    assert.equal(verdictOnly.turns[0].reviewable, false);

    // CONTROL — the verdict beside the evidence it describes.
    const supported = build(trace(), proofRecord({}, {
      ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, closeout_fully_verified: true,
    }));
    assert.deepEqual(firstWrite(supported).issues, []);

    // CONTROL — a plain main write carries no verdict and needs none.
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('refuses sidecar evidence on the routes that cannot emit it', () => {
    // Requiring the two envelopes TOGETHER is not enough on its own. Both are emitted only by
    // `/api/log-workout` — `ledger_seal` at index.js:3258, 3261 and 3423, `session_plans_closeout`
    // at 3255 and 3424, and nowhere else. So a record from any other write route carrying a
    // well-formed seal and closeout pair satisfies the pairing rule while still being a shape no
    // producer emits, and it was reaching a complete artifact reporting `seal.state === 'sealed'`.
    const sidecar = {
      ...SEAL_REPLAY,
      ...CLOSEOUT_SKIPPED,
      closeout_fully_verified: true,
    };
    for (const route of ['/api/complete-workout', '/api/log-modality', '/api/bodyweight']) {
      const artifact = build(trace(), proofRecord({ route }, {
        ...sidecar,
        sheet_written: true,
        effort_rows_written: route === '/api/complete-workout' ? 1 : undefined,
        effortAppendedRange: route === '/api/complete-workout' ? 'Effort!A2:I2' : undefined,
      }));
      const write = firstWrite(artifact);
      assert.ok(write.issues.includes('sidecar_evidence_impossible_for_route'), route);
      assert.equal(artifact.turns[0].reviewable, false, route);
      assert.notEqual(artifact.status, 'complete', route);
    }

    // CONTROL — the same sidecar pair on the one route that does emit it stays reviewable.
    const real = build(trace(), proofRecord({}, sidecar));
    assert.deepEqual(firstWrite(real).issues, []);
    assert.equal(real.status, 'complete');

    // CONTROL — the other routes' ordinary bodies, with no sidecar evidence at all, are untouched.
    for (const route of ['/api/log-modality', '/api/bodyweight']) {
      const plain = build(trace(), proofRecord({ route }, {
        sheet_written: true,
        logAppendedRange: undefined,
        log_rows_written: undefined,
        effort_rows_written: undefined,
      }));
      assert.deepEqual(firstWrite(plain).issues, [], route);
      assert.equal(plain.status, 'complete', route);
    }
  });

  it('requires closeout evidence wherever seal evidence exists, and the reverse', () => {
    // The implication runs BOTH ways, because the producer runs both ways. `/api/log-workout` is
    // the only route that emits `ledger_seal` at all (index.js:3258, 3261, 3423), and at every one
    // of those sites `session_plans_closeout` was already assigned from `recordCloseoutEvent`,
    // which always returns an object — on the duplicate branch unconditionally before the try, and
    // on the success path inside the same `closeout_context` block. So a seal with no closeout
    // projection is lost producer evidence exactly as a closeout with no seal is.
    //
    // Only the closeout-implies-seal direction was enforced. That let a seal-only record — the
    // shape several older fixtures used — reach a complete, fully reviewable artifact.
    const sealOnly = build(trace(), proofRecord({}, { ...SEAL_REPLAY, closeout_fully_verified: true }));
    assert.ok(firstWrite(sealOnly).issues.includes('closeout_evidence_missing'));
    assert.equal(sealOnly.turns[0].reviewable, false);
    assert.notEqual(sealOnly.status, 'complete');

    const closeoutOnly = build(trace(), proofRecord({}, { ...CLOSEOUT_SKIPPED, closeout_fully_verified: true }));
    assert.ok(firstWrite(closeoutOnly).issues.includes('seal_evidence_missing'));
    assert.equal(closeoutOnly.turns[0].reviewable, false);

    // CONTROL — the shape the producer really emits carries both envelopes and is reviewable.
    const both = build(trace(), proofRecord({}, {
      ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, closeout_fully_verified: true,
    }));
    assert.deepEqual(firstWrite(both).issues, []);
    assert.equal(both.status, 'complete');

    // CONTROL — a plain main write carries neither envelope and needs neither.
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('never presents the producer&#39;s seal_proof_mismatch tuple as a successful seal', () => {
    // The ONE shape `sealCloseout` emits for a mismatch (sessionPlanSetsStore.js:329-335): the
    // update was attempted, so `sheet_written` is true, `sealed_ok` is false, `sealed` is 0, and
    // the expected/updated cell counts come along.
    //
    // This does NOT independently prove the explicit-reason branch, and the guard-bite table says
    // so. On this — the only reachable mismatch record — three arms agree: the explicit reason,
    // "any reason contradicts a positive stamp", and "sealed_ok:false with sheet_written:true".
    // Deleting the first still yields `seal_proof_mismatch`. An earlier version of this test used
    // `sealed_ok:true, sheet_written:false` to make the first arm decisive, which made it bite —
    // but that tuple is one no producer emits, so the bite was manufactured. A guard proven only
    // by an impossible record is not proven.
    const artifact = build(trace(), proofRecord({}, {
      ledger_seal_sheet_written: true,
      ledger_seal_sealed_ok: false,
      ledger_seal_sealed: 0,
      ledger_seal_already_sealed: 2,
      ledger_seal_reason: 'seal_proof_mismatch',
      ledger_seal_expected_cells: 3,
      ledger_seal_updated_cells: 1,
      closeout_fully_verified: true,
    }));
    const write = firstWrite(artifact);
    assert.equal(write.seal.state, 'seal_proof_mismatch');
    assert.equal(write.seal.successfully_sealed, false);
    assert.equal(write.seal.new_seal_write, false);
    assert.ok(write.issues.includes('seal_proof_mismatch'));
    assert.equal(artifact.turns[0].reviewable, false);

    // CONTROL — the same tuple without the mismatch reason is a genuine fresh stamp.
    const control = build(trace(), proofRecord({}, {
      ledger_seal_sealed_ok: true,
      ledger_seal_sheet_written: true,
      ledger_seal_no_write_confirmed: false,
      ledger_seal_sealed: 2,
      ledger_seal_already_sealed: 0,
      closeout_fully_verified: true,
    }));
    assert.equal(firstWrite(control).seal.state, 'sealed');
  });

  it('reports sealed_ok:false beside a positive seal write as a mismatch, not a plain failure', () => {
    const artifact = build(trace(), proofRecord({}, {
      ledger_seal_sealed_ok: false,
      ledger_seal_sheet_written: true,
      closeout_fully_verified: true,
    }));
    assert.equal(firstWrite(artifact).seal.state, 'seal_proof_mismatch');

    // CONTROL — a failure that claims no seal write is the milder `failed`.
    const control = build(trace(), proofRecord({}, {
      ledger_seal_sealed_ok: false,
      ledger_seal_sheet_written: false,
      closeout_fully_verified: true,
    }));
    assert.equal(firstWrite(control).seal.state, 'failed');
  });

  it('requires the no_ledger flag and its own reason before calling a seal verified_no_new_seal', () => {
    const withoutFlag = build(trace(), proofRecord({}, {
      ledger_seal_sealed_ok: true,
      ledger_seal_sheet_written: false,
      ledger_seal_no_write_confirmed: true,
      ledger_seal_sealed: 0,
      ledger_seal_already_sealed: 0,
      ledger_seal_reason: 'no_rows',
      closeout_fully_verified: true,
    }));
    assert.notEqual(firstWrite(withoutFlag).seal.state, 'verified_no_new_seal');

    const wrongReason = build(trace(), proofRecord({}, {
      ledger_seal_sealed_ok: true,
      ledger_seal_sheet_written: false,
      ledger_seal_no_write_confirmed: true,
      ledger_seal_sealed: 0,
      ledger_seal_already_sealed: 0,
      ledger_seal_no_ledger: true,
      ledger_seal_reason: 'write_disabled',
      closeout_fully_verified: true,
    }));
    assert.notEqual(firstWrite(wrongReason).seal.state, 'verified_no_new_seal');

    // CONTROL — both outcomes that genuinely reach it.
    for (const reason of ['tab_missing', 'no_rows']) {
      const control = build(trace(), proofRecord({}, {
        ledger_seal_sealed_ok: true,
        ledger_seal_sheet_written: false,
        ledger_seal_no_write_confirmed: true,
        ledger_seal_sealed: 0,
        ledger_seal_already_sealed: 0,
        ledger_seal_no_ledger: true,
        ledger_seal_reason: reason,
        closeout_fully_verified: true,
      }));
      assert.equal(firstWrite(control).seal.state, 'verified_no_new_seal', reason);
    }
  });
});

describe('turnWriteArtifact guards — write classification', () => {
  it('will not confirm a claimed live success whose test_mode flag is absent', () => {
    // All four success producers emit test_mode explicitly, so an absent flag is a lost tuple
    // member — not permission to assume the write was live.
    const artifact = build(trace(), proofRecord({}, { test_mode: undefined }));
    assert.equal(firstWrite(artifact).proof_state, 'insufficient');
    assert.notEqual(artifact.status, 'complete');

    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('requires the complete W1 tuple before reporting no_write_confirmed', () => {
    const artifact = build(trace(), proofRecord({}, {
      test_mode: true,
      no_write_confirmed: true,
      sheet_write: 'skipped',
      sheet_written: undefined,
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
      duplicate_write: undefined,
      idempotency_status: undefined,
    }));
    assert.notEqual(firstWrite(artifact).proof_state, 'no_write_confirmed');

    // CONTROL — the real dry-run tuple, which carries the explicit false write flag. It lives on a
    // PREVIEW record: emitted through `isPreview`, and write_attempt is non-zero only where a live
    // write registered a write_id (turnCorrelation.js:551).
    const control = build(trace(), proofRecord({
      pairing: {
        established_at_preview: true,
        write_attempt: 0,
        previewed_write_id_match: null,
        payload_bound: false,
        effort_transition: false,
      },
    }, {
      test_mode: true,
      no_write_confirmed: true,
      sheet_written: false,
      sheet_write: 'skipped',
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
      duplicate_write: undefined,
      idempotency_status: undefined,
    }));
    assert.equal(control.turns[0].previews[0].proof_state, 'no_write_confirmed');
  });

  it('requires the duplicate branch scalars before reporting idempotent_no_write', () => {
    const noSkippedCount = build(trace(), duplicateRecord({
      ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, skipped_duplicates: undefined,
    }));
    assert.equal(firstWrite(noSkippedCount).proof_state, 'insufficient');

    const zeroSkipped = build(trace(), duplicateRecord({
      ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED, skipped_duplicates: 0,
    }));
    assert.equal(firstWrite(zeroSkipped).proof_state, 'insufficient');

    // CONTROL — the real correlated duplicate.
    const control = build(trace(), duplicateRecord({ ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED }));
    assert.equal(firstWrite(control).proof_state, 'idempotent_no_write');
  });

  it('requires sidecar evidence before reporting idempotent_no_write', () => {
    // This is the case the previously-published test claimed to cover and did not: its negative
    // record was missing the idempotency status and the verdict as well, so it failed on those and
    // never reached the sidecar gate at all. With the whole scalar tuple present and only the
    // sidecar evidence absent, the gate is the only thing standing between this record and a
    // fully reviewable verdict.
    const noSidecar = build(trace(), duplicateRecord());
    assert.equal(firstWrite(noSidecar).proof_state, 'insufficient');
    assert.equal(noSidecar.turns[0].reviewable, false);

    // CONTROL — the real correlated duplicate carries BOTH envelopes, because the producer always
    // emits them together: index.js:3251-3264 assigns `session_plans_closeout` from
    // recordCloseoutEvent (which always returns an object carrying `status` and `captured`) and
    // then assigns `ledger_seal` on BOTH the try and the catch path (the catch emitting
    // `{sealed_ok:false, reason:'seal_error'}`), and the projection withholds invalid fields
    // INDIVIDUALLY rather than dropping a whole envelope. So neither a seal-only nor a
    // closeout-only duplicate record is a shape any producer emits.
    //
    // An earlier version of this test asserted that each envelope ALONE was accepted, to pin the
    // gate as an OR. That pinned two unreachable shapes — the exact defect this file exists to
    // catch. The gate stays an OR because it mirrors the producer's own condition at index.js:3276
    // rather than the strictest one that condition happens to satisfy (rule 9), but OR-versus-AND
    // is not distinguishable by any record the producer can emit, so nothing here asserts it.
    const control = build(trace(), duplicateRecord({ ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED }));
    assert.equal(firstWrite(control).proof_state, 'idempotent_no_write');
    assert.deepEqual(firstWrite(control).issues, []);
    assert.equal(control.status, 'complete');
  });

  it('flags a preview record that does not reach the no-write proof', () => {
    const preview = proofRecord({
      pairing: {
        established_at_preview: true,
        write_attempt: 0,
        previewed_write_id_match: null,
        payload_bound: false,
        effort_transition: false,
      },
    }, {
      test_mode: true,
      sheet_write: 'skipped',
      sheet_written: false,
      no_write_confirmed: true,
      logAppendedRange: undefined,
      log_rows_written: undefined,
      effort_rows_written: undefined,
      duplicate_write: undefined,
      idempotency_status: undefined,
    });

    // CONTROL — the real preview body is reviewable with no issues.
    const control = build(trace(), preview, proofRecord());
    assert.deepEqual(control.turns[0].previews[0].issues, []);
    assert.equal(control.turns[0].previews[0].proof_state, 'no_write_confirmed');

    // The negative case is NO LONGER CONSTRUCTIBLE from producible fields, and saying so is more
    // honest than manufacturing one. The attempt-zero gate in `_sanitizeProof` already rejects any
    // preview record that does not carry the exact W1 tuple, and the real preview body
    // (index.js:3125-3139) carries nothing that can raise a positive write signal: `effortWritten`
    // is response bookkeeping and deliberately excluded from the signal, `skipped_duplicates` is
    // not a write indicator, and `log_rows_preview` is not projected at all. So every preview that
    // survives sanitize reaches `no_write_confirmed`, and `preview_no_write_proof_missing` is
    // redundant with the gate rather than load-bearing.
    //
    // An earlier version of this case broke the tuple with `rows_appended: 2` — a field NO producer
    // emits anywhere. It bit, and the bite was manufactured: exactly the defect this file exists to
    // catch, in this file. The guard is now listed as unproven in the merge card instead.
    const stillReviewable = build(trace(), preview, proofRecord());
    assert.equal(stillReviewable.turns[0].previews[0].proof_state, 'no_write_confirmed');
    assert.equal(stillReviewable.turns[0].previews[0].reviewable, true);
  });
});

describe('turnWriteArtifact guards — turn assembly and parsing', () => {
  it('reports conflicting traces for the same turn', () => {
    const artifact = build(trace(), trace({ intent_type: 'plan' }), proofRecord());
    assert.ok(artifact.turns[0].issues.includes('conflicting_traces'));
    assert.equal(artifact.turns[0].reviewable, false);

    // CONTROL — a byte-identical repeat is deduplicated, not called conflicting.
    const repeated = build(trace(), trace(), proofRecord());
    assert.ok(!repeated.turns[0].issues.includes('conflicting_traces'));
    assert.equal(repeated.status, 'complete');
  });

  it('reports a turn with no write proof at all', () => {
    const artifact = build(trace());
    assert.ok(artifact.turns[0].issues.includes('write_proof_missing'));
    assert.equal(artifact.turns[0].join_status, 'trace_only');
    assert.equal(artifact.turns[0].reviewable, false);

    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('surfaces a rejected record against the turn it belonged to', () => {
    // Without this the turn shows only what survived, and evidence loss reads as absence.
    const artifact = build(trace(), proofRecord(), proofRecord({ recorded_at: 'nope' }));
    assert.ok(artifact.turns[0].issues.includes('rejected_write_record'));
    assert.equal(artifact.summary.rejected_records, 1);
    assert.equal(artifact.turns[0].reviewable, false);

    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('reports two records claiming the same write attempt', () => {
    // Byte-identical repeats are deduplicated, so the differentiating shape is two records that
    // claim the same attempt while differing elsewhere — one of them is not what the producer,
    // which issues each attempt once, can have emitted.
    const artifact = build(
      trace(),
      proofRecord(),
      proofRecord({ recorded_at: '2026-07-27T09:00:09.000Z' }),
    );
    assert.ok(artifact.turns[0].issues.includes('duplicate_write_attempt'));
    assert.equal(artifact.turns[0].reviewable, false);

    // CONTROL — distinct attempts on the same turn are an ordinary retry.
    //
    // The second attempt is NOT a second success. Two payload-bound attempts on one preview cannot
    // both append: attempt 1 writes the rows, so attempt 2 finds `rowsToWrite.length === 0` and
    // takes the all-rows-duplicate branch (index.js:3236), which emits `skipped_duplicate` — and
    // that branch is correlated only when it carried a closeout, which is exactly the F10D case
    // where a retry HEALS an unsealed closeout (index.js:3249-3264). An earlier version of this
    // control gave both attempts the same live-success body and the same append range, which is
    // doubly impossible: the second append could not land on the rows the first one already wrote.
    const retry = build(
      trace(),
      proofRecord(),
      duplicateRecord(
        { ...SEAL_REPLAY, ...CLOSEOUT_SKIPPED },
        { recorded_at: '2026-07-27T09:00:09.000Z', pairing: { ...proofRecord().pairing, write_attempt: 2 } },
      ),
    );
    assert.ok(!retry.turns[0].issues.includes('duplicate_write_attempt'));
    assert.equal(retry.turns[0].writes[0].proof_state, 'write_confirmed');
    assert.equal(retry.turns[0].writes[1].proof_state, 'idempotent_no_write');
    assert.equal(retry.status, 'complete');
  });

  it('stops accepting records at the bounded record limit', () => {
    const { MAX_RECORDS } = require('../services/turnWriteArtifact');
    const records = [];
    for (let i = 0; i <= MAX_RECORDS; i += 1) {
      const turnId = `turn:2026-07-27T09:00:00.000Z_${i}_aaaaaa`;
      records.push(proofRecord({ turn_id: turnId }));
    }
    const artifact = buildTurnWriteArtifact(lines(...records));
    assert.ok(artifact.summary.rejected_records > 0, 'the overflowing record is counted, not dropped silently');
    assert.ok(artifact.summary.proofs_seen <= MAX_RECORDS);

    // CONTROL — one under the limit is accepted whole with nothing rejected.
    const under = buildTurnWriteArtifact(lines(...records.slice(0, MAX_RECORDS)));
    assert.equal(under.summary.rejected_records, 0);
    assert.equal(under.summary.proofs_seen, MAX_RECORDS);
  });

  it('bounds the input by size before splitting it, and says when it truncated', () => {
    // A LINE cap does not bound memory: `text.split()` materializes every line before
    // MAX_INPUT_LINES is applied, so an oversized capture could exhaust memory or kill the process
    // before the advertised limit took effect — producing no artifact rather than the intended
    // partial one. The character bound runs BEFORE the split.
    const { MAX_INPUT_CHARS } = require('../services/turnWriteArtifact');
    const filler = 'x'.repeat(MAX_INPUT_CHARS + 1024);
    const artifact = buildTurnWriteArtifact(filler);
    assert.ok(artifact.summary.rejected_records > 0, 'truncation is reported, never silent');

    // Records BEFORE the cut are still parsed, and the truncation is still reported — a partial
    // artifact presented as partial.
    const head = lines(trace(), proofRecord());
    const padded = `${head}\n${'y'.repeat(MAX_INPUT_CHARS)}`;
    const partial = buildTurnWriteArtifact(padded);
    assert.equal(partial.turns[0].join_status, 'joined');
    assert.ok(partial.summary.rejected_records > 0);
    assert.notEqual(partial.status, 'complete');

    // CONTROL — an ordinary input is untouched by the bound.
    assertControlAccepted(build(trace(), proofRecord()));
  });

  it('stops reading at the bounded input line limit', () => {
    const { MAX_INPUT_LINES } = require('../services/turnWriteArtifact');
    const filler = new Array(MAX_INPUT_LINES).fill('unrelated deployment log line').join('\n');
    const artifact = buildTurnWriteArtifact(`${filler}\n${lines(trace(), proofRecord())}`);
    assert.ok(artifact.summary.rejected_records > 0, 'truncated input is reported, not silently complete');
    assert.notEqual(artifact.status, 'complete');

    // CONTROL — the same records inside the limit parse cleanly.
    assertControlAccepted(buildTurnWriteArtifact(lines(trace(), proofRecord())));
  });

  it('rejects a single log line carrying both markers', () => {
    const both = `2026-07-27T09:00:05Z [interaction-trace] [turn-write-proof] ${JSON.stringify(trace())}`;
    const artifact = buildTurnWriteArtifact(lines(trace(), proofRecord(), both));
    assert.equal(artifact.summary.rejected_records, 1, 'an ambiguous line is not silently skipped');
    assert.notEqual(artifact.status, 'complete');

    assertControlAccepted(build(trace(), proofRecord()));
  });
});
