'use strict';

// Durable capture of the FINAL visible coach response (the companion to Coach_Shadow's
// presence-flag mirror). These unit tests pin the contract, the bounded row mapping, the
// explicit silence-vs-suppression derivation (so silence/suppression is represented
// explicitly rather than appearing as missing data), and the best-effort persistence
// (ensure-once, ordered, deduped by turn_id, fail-closed on a header mismatch).

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const responseSheet = require('../services/coachResponseSheet');

beforeEach(() => responseSheet._resetForTesting());

function envelope({ message = 'Solid work — that top set moved well.', source = 'gemini', kind = 'set', error = false, configured = true } = {}) {
  return { status: 'ok', message: 'Coach message', data: { message, source, kind, configured, error: error ? 'boom' : undefined } };
}

function sampleParams(overrides = {}) {
  return Object.assign({
    recordedAt: '2026-07-21T20:00:00.000Z',
    turnId: 'turn:2026-07-21T20:00:00.000Z_1_abc123',
    sessionId: '20260721-PM-01',
    route: '/api/coach/message',
    intentType: 'set',
    visible: envelope(),
    modelStatus: 'ok',
    appVersion: 'v145',
  }, overrides);
}

describe('coachResponseSheet', () => {
  it('owns a stable 13-column Coach_Response contract that does NOT collide with Coach_Shadow', () => {
    assert.equal(responseSheet.RESPONSE_TAB, 'Coach_Response');
    assert.deepEqual(responseSheet.RESPONSE_HEADERS, [
      'recorded_at', 'turn_id', 'session_id', 'route', 'intent_type',
      'visible_source', 'visible_kind', 'visible_message_present', 'visible_message',
      'suppressed', 'suppression_reason', 'app_version', 'visible_error',
    ]);
  });

  it('builds one row in exact header order storing the FINAL visible text', () => {
    const row = responseSheet.buildRow(sampleParams());
    assert.equal(row.length, 13);
    assert.deepEqual(row.slice(0, 8), [
      '2026-07-21T20:00:00.000Z',
      'turn:2026-07-21T20:00:00.000Z_1_abc123',
      '20260721-PM-01',
      '/api/coach/message',
      'set',
      'gemini',
      'set',
      'TRUE',
    ]);
    assert.equal(row[8], 'Solid work — that top set moved well.'); // visible_message = final text
    assert.equal(row[9], 'FALSE');   // suppressed
    assert.equal(row[10], '');       // suppression_reason
    assert.equal(row[11], 'v145');   // app_version
    assert.equal(row[12], 'FALSE');  // visible_error
  });

  it('represents deliberate silence explicitly (model skipped, no message)', () => {
    const row = responseSheet.buildRow(sampleParams({
      visible: envelope({ message: null, source: null, kind: 'block' }),
      modelStatus: 'skipped',
    }));
    assert.equal(row[7], 'FALSE');            // visible_message_present
    assert.equal(row[8], '');                 // visible_message
    assert.equal(row[9], 'FALSE');            // suppressed — silence is NOT suppression
    assert.equal(row[10], 'deliberate_silence');
  });

  it('represents validator suppression explicitly (model ran, line nulled)', () => {
    const row = responseSheet.buildRow(sampleParams({
      visible: envelope({ message: null, kind: 'block' }),
      modelStatus: 'ok',
    }));
    assert.equal(row[7], 'FALSE');
    assert.equal(row[9], 'TRUE');             // suppressed
    assert.equal(row[10], 'validator_suppressed');
  });

  it('represents an LLM-outage fallback and an error fallback explicitly', () => {
    const outage = responseSheet.buildRow(sampleParams({
      visible: envelope({ message: null, source: null, configured: false }),
      modelStatus: 'skipped',
    }));
    assert.equal(outage[9], 'FALSE');        // not suppression
    assert.equal(outage[10], 'outage_fallback');

    const errored = responseSheet.buildRow(sampleParams({
      visible: envelope({ message: null, error: true }),
      modelStatus: 'error',
    }));
    assert.equal(errored[10], 'model_error_fallback');
    assert.equal(errored[12], 'TRUE'); // visible_error
  });

  it('bounds the stored visible text', () => {
    const long = 'x'.repeat(10000);
    const row = responseSheet.buildRow(sampleParams({ visible: envelope({ message: long }) }));
    assert.ok(row[8].length <= responseSheet.MAX_MESSAGE_CHARS, 'visible_message is bounded');
    assert.ok(row[8].length < long.length, 'a very long message is truncated');
  });

  it('ensures the tab/header once and appends every queued turn in order', async () => {
    const calls = [];
    responseSheet._resetForTesting({
      ensure: async (tab, headers) => { calls.push(['ensure', tab, headers.length]); },
      getHeader: async (tab) => { calls.push(['header', tab]); return responseSheet.RESPONSE_HEADERS.slice(); },
      append: async (tab, rows) => { calls.push(['append', tab, rows[0][1]]); },
    });

    responseSheet.persist(sampleParams({ turnId: 'turn:one' }));
    responseSheet.persist(sampleParams({ turnId: 'turn:two' }));
    await responseSheet._flushForTesting();

    assert.deepEqual(calls, [
      ['ensure', 'Coach_Response', 13],
      ['header', 'Coach_Response'],
      ['append', 'Coach_Response', 'turn:one'],
      ['append', 'Coach_Response', 'turn:two'],
    ]);
  });

  it('dedupes by turn_id so a retried/double-finished turn appends once', async () => {
    const appended = [];
    responseSheet._resetForTesting({
      ensure: async () => {},
      getHeader: async () => responseSheet.RESPONSE_HEADERS.slice(),
      append: async (tab, rows) => { appended.push(rows[0][1]); },
    });

    responseSheet.persist(sampleParams({ turnId: 'turn:dup' }));
    responseSheet.persist(sampleParams({ turnId: 'turn:dup' }));
    await responseSheet._flushForTesting();

    assert.deepEqual(appended, ['turn:dup'], 'the same turn_id is persisted exactly once');
  });

  it('fails closed and appends nothing when the existing header is mismatched', async () => {
    const calls = [];
    responseSheet._resetForTesting({
      ensure: async () => { calls.push('ensure'); },
      getHeader: async () => ['turn_id', 'recorded_at'],
      append: async () => { calls.push('append'); },
    });

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      responseSheet.persist(sampleParams());
      await responseSheet._flushForTesting();
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(calls, ['ensure']);
  });
});
