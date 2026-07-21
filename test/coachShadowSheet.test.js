'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const shadowSheet = require('../services/coachShadowSheet');

beforeEach(() => shadowSheet._resetForTesting());

function sampleParams() {
  return {
    recordedAt: '2026-07-21T20:00:00.000Z',
    trace: {
      trace: {
        turn_id: 'turn:2026-07-21T20:00:00.000Z_1_abc123',
        stages: [
          { stage: 'intent', status: 'ok', ref: null },
          { stage: 'rendered_output', status: 'ok', ref: null },
        ],
      },
      valid: true,
      errors: [],
      intent_type: 'block',
      source: 'coach_message',
      missing: ['parser', 'knowledge_retrieval', 'write_proof'],
    },
    assembled: {
      packet: {
        turn_id: 'turn:2026-07-21T20:00:00.000Z_1_abc123',
        athlete: { profile_goal: 'strength' },
        session: null,
        exercises: [],
        decision: null,
        safety: null,
        closeout: null,
      },
      valid: true,
      errors: [],
    },
    visible: {
      message_present: true,
      source: 'gemini',
      kind: 'block',
      error_present: false,
    },
  };
}

describe('coachShadowSheet', () => {
  it('owns the exact 19-column Coach_Shadow contract', () => {
    assert.deepEqual(shadowSheet.SHADOW_HEADERS, [
      'recorded_at', 'turn_id', 'intent_type', 'source', 'packet_valid', 'packet_errors',
      'athlete_profile_goal', 'session', 'exercises', 'decision', 'safety', 'closeout',
      'trace_valid', 'trace_stages', 'trace_missing', 'visible_message_present',
      'visible_source', 'visible_kind', 'visible_error',
    ]);
  });

  it('builds one bounded row in the exact header order', () => {
    const row = shadowSheet.buildRow(sampleParams());
    assert.equal(row.length, 19);
    assert.deepEqual(row.slice(0, 7), [
      '2026-07-21T20:00:00.000Z',
      'turn:2026-07-21T20:00:00.000Z_1_abc123',
      'block',
      'coach_message',
      'TRUE',
      '[]',
      'strength',
    ]);
    assert.equal(row[8], '[]');
    assert.equal(row[12], 'TRUE');
    assert.equal(row[15], 'TRUE');
    assert.equal(row[16], 'gemini');
    assert.equal(row[17], 'block');
    assert.equal(row[18], 'FALSE');
    assert.deepEqual(JSON.parse(row[13]), [
      { stage: 'intent', status: 'ok' },
      { stage: 'rendered_output', status: 'ok' },
    ]);
  });

  it('ensures the tab/header once and appends every queued turn in order', async () => {
    const calls = [];
    shadowSheet._resetForTesting({
      ensure: async (tab, headers) => { calls.push(['ensure', tab, headers.length]); },
      append: async (tab, rows) => { calls.push(['append', tab, rows[0][1]]); },
    });

    const first = sampleParams();
    const second = sampleParams();
    second.assembled.packet.turn_id = 'turn:second';
    second.trace.trace.turn_id = 'turn:second';

    shadowSheet.persist(first);
    shadowSheet.persist(second);
    await shadowSheet._flushForTesting();

    assert.deepEqual(calls, [
      ['ensure', 'Coach_Shadow', 19],
      ['append', 'Coach_Shadow', 'turn:2026-07-21T20:00:00.000Z_1_abc123'],
      ['append', 'Coach_Shadow', 'turn:second'],
    ]);
  });
});
