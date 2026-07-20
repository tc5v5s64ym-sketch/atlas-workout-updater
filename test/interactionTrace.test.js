'use strict';

// InteractionTrace contract — Phase 2 Work item 2 (docs/CANONICAL_CONTRACTS.md).
//
// One turn's end-to-end record: a single turn_id carried across the canonical
// stage spine. Pure builder + total validator + derived helpers. Read-only; not
// yet wired (Phase 3 assembles it in shadow).

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  buildInteractionTrace,
  validateInteractionTrace,
  findStage,
  missingStages,
  STAGES,
  STAGE_STATUSES,
  _resetForTesting,
} = require('../services/interactionTrace');

beforeEach(() => _resetForTesting());

const valid = () => ({
  schema_version: SCHEMA_VERSION,
  turn_id: 't_abc123',
  started_at: '2026-07-20T15:00:00Z',
  stages: [
    { stage: 'parser', status: 'ok', ref: 'fr_1' },
    { stage: 'intent', status: 'ok', ref: null },
    { stage: 'write_proof', status: 'skipped', ref: null },
  ],
});

describe('buildInteractionTrace', () => {
  it('stamps schema_version, defaults started_at null / stages [] and normalizes entries', () => {
    const t = buildInteractionTrace({ turn_id: 't1', stages: [{ stage: 'parser' }] });
    assert.equal(t.schema_version, SCHEMA_VERSION);
    assert.equal(t.turn_id, 't1');
    assert.equal(t.started_at, null);
    assert.deepEqual(t.stages[0], { stage: 'parser', status: 'ok', ref: null });
  });
  it('tolerates junk input without throwing', () => {
    assert.deepEqual(buildInteractionTrace(undefined).stages, []);
    assert.equal(buildInteractionTrace(null).turn_id, undefined);
  });
});

describe('validateInteractionTrace', () => {
  it('accepts a well-formed trace', () => {
    const r = validateInteractionTrace(valid());
    assert.equal(r.valid, true, r.errors.join(' | '));
  });
  it('accepts a trace with no stages yet (turn just opened)', () => {
    assert.equal(validateInteractionTrace(buildInteractionTrace({ turn_id: 't1' })).valid, true);
  });
  it('rejects a non-object, wrong schema_version, missing turn_id, non-array stages', () => {
    assert.equal(validateInteractionTrace(null).valid, false);
    assert.equal(validateInteractionTrace({ ...valid(), schema_version: 2 }).valid, false);
    assert.equal(validateInteractionTrace({ ...valid(), turn_id: '' }).valid, false);
    assert.equal(validateInteractionTrace({ ...valid(), stages: 'x' }).valid, false);
  });
  it('requires started_at present and a strict ISO-8601 date-time or null (Codex #1091)', () => {
    const noKey = { ...valid() }; delete noKey.started_at;
    assert.equal(validateInteractionTrace(noKey).valid, false);
    assert.equal(validateInteractionTrace({ ...valid(), started_at: null }).valid, true);
    assert.equal(validateInteractionTrace({ ...valid(), started_at: '' }).valid, false);
    // a non-empty but non-ISO / impossible timestamp is rejected
    assert.equal(validateInteractionTrace({ ...valid(), started_at: 'yesterday-ish' }).valid, false);
    assert.equal(validateInteractionTrace({ ...valid(), started_at: '2026-13-99T25:90:00Z' }).valid, false);
    assert.equal(validateInteractionTrace({ ...valid(), started_at: 'June 30 2026' }).valid, false);
    assert.equal(validateInteractionTrace({ ...valid(), started_at: '2026-07-20T14:00:00.250Z' }).valid, true);
  });

  it('rejects stages out of canonical order; allows in-order omissions (Codex #1091)', () => {
    const backwards = { ...valid(), stages: [{ stage: 'write_proof', status: 'ok', ref: null }, { stage: 'parser', status: 'ok', ref: null }] };
    assert.equal(validateInteractionTrace(backwards).valid, false);
    const inOrderWithGaps = { ...valid(), stages: [{ stage: 'parser', status: 'ok', ref: null }, { stage: 'model_response', status: 'ok', ref: null }, { stage: 'write_proof', status: 'ok', ref: null }] };
    assert.equal(validateInteractionTrace(inOrderWithGaps).valid, true);
  });
  it('validates stage names and statuses against the enums', () => {
    assert.equal(validateInteractionTrace({ ...valid(), stages: [{ stage: 'nope', status: 'ok', ref: null }] }).valid, false);
    assert.equal(validateInteractionTrace({ ...valid(), stages: [{ stage: 'parser', status: 'maybe', ref: null }] }).valid, false);
    for (const st of STAGES) assert.equal(validateInteractionTrace({ ...valid(), stages: [{ stage: st, status: 'ok', ref: null }] }).valid, true, `stage ${st}`);
    for (const s of STAGE_STATUSES) assert.equal(validateInteractionTrace({ ...valid(), stages: [{ stage: 'parser', status: s, ref: null }] }).valid, true, `status ${s}`);
  });
  it('rejects a duplicate stage entry (one per stage)', () => {
    const dup = { ...valid(), stages: [{ stage: 'parser', status: 'ok', ref: null }, { stage: 'parser', status: 'error', ref: null }] };
    assert.equal(validateInteractionTrace(dup).valid, false);
  });
  it('requires stage.ref present (explicit null)', () => {
    assert.equal(validateInteractionTrace({ ...valid(), stages: [{ stage: 'parser', status: 'ok' }] }).valid, false);
    assert.equal(validateInteractionTrace({ ...valid(), stages: [{ stage: 'parser', status: 'ok', ref: 42 }] }).valid, false);
  });
});

describe('derived helpers', () => {
  it('findStage returns the entry or null', () => {
    assert.equal(findStage(valid(), 'intent').stage, 'intent');
    assert.equal(findStage(valid(), 'model_response'), null);
  });
  it('missingStages lists the canonical stages absent from the trace, in order', () => {
    const missing = missingStages(valid());
    assert.ok(!missing.includes('parser') && !missing.includes('intent') && !missing.includes('write_proof'));
    assert.ok(missing.includes('model_response') && missing.includes('validator_result'));
    // a full trace has none missing
    const full = { ...valid(), stages: STAGES.map((s) => ({ stage: s, status: 'ok', ref: null })) };
    assert.deepEqual(missingStages(full), []);
  });
});
