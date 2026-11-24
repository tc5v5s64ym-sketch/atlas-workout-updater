'use strict';

// #1124 — Coach_Response must capture the FINAL deterministic message rendered to
// the athlete. Failing-first proving probes for the bounded final-render event:
//
//   A. Model response shown unchanged — final render equals the server response,
//      one correlated record, no duplicate.
//   B. Model skipped / deliberate server silence, deterministic client line shown —
//      server stage stays deliberate_silence; final rendered text is durably stored;
//      the record marks that client deterministic output became visible.
//   C. Model generated then validator suppressed, deterministic client fallback
//      shown — validator suppression stays truthful; final screen text is stored.
//   D. True silence — no visible text at server or client; no divergent record.
//   E. Retry / re-render — repeated reports for the same turn do not create
//      conflicting duplicate truth; a stale render cannot overwrite a newer turn.
//   F. Privacy and bounds — no prompts/bodies/secrets; message length bounded;
//      source/kind allowlisted; turn_id shape enforced.
//
// Design (one concern, observability only): a bounded authenticated final-render
// append event correlated by turn_id — new append-only `Coach_Render` tab
// (server-stage Coach_Response evidence is never replaced or erased), a new
// POST /api/coach/final-render under the existing /api API-key gate + rate limit,
// and a client report fired only when the rendered outcome DIVERGES from the
// server-stage record (so agreement cases A/D keep exactly one correlated record).
// The client decision lives in src/app/finalRenderReport.js (pure, ESM).

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const finalRender = require('../services/coachFinalRender');

function sampleParams(overrides = {}) {
  return Object.assign({
    recordedAt: '2026-07-21T20:00:00.000Z',
    turnId: 'turn:2026-07-21T20:00:00.000Z_1_abc123',
    sessionId: '20260721-PM-01',
    route: '/api/coach/message',
    finalMessage: 'New ground: Seated Row 200x10 at RIR 2 clears your prior 195. Hold it next time and prove it again.',
    finalSource: 'voice_primary_line',
    finalKind: 'block',
    replacedServerVisible: true,
    serverVisiblePresent: false,
    appVersion: 'v145',
  }, overrides);
}

describe('coachFinalRender service', () => {
  beforeEach(() => finalRender._resetForTesting());

  it('owns a stable 11-column Coach_Render contract that does NOT collide with Coach_Response', () => {
    assert.equal(finalRender.RENDER_TAB, 'Coach_Render');
    assert.deepEqual(finalRender.RENDER_HEADERS, [
      'recorded_at', 'turn_id', 'session_id', 'route', 'final_message_present',
      'final_message', 'final_source', 'final_kind', 'replaced_server_visible',
      'server_visible_present', 'app_version',
    ]);
  });

  it('builds one row in exact header order storing the FINAL rendered text (case C)', () => {
    const row = finalRender.buildRow(sampleParams());
    assert.equal(row.length, 11);
    assert.deepEqual(row.slice(0, 9), [
      '2026-07-21T20:00:00.000Z',
      'turn:2026-07-21T20:00:00.000Z_1_abc123',
      '20260721-PM-01',
      '/api/coach/message',
      'TRUE',
      'New ground: Seated Row 200x10 at RIR 2 clears your prior 195. Hold it next time and prove it again.',
      'voice_primary_line',
      'block',
      'TRUE', // replaced_server_visible — the client line replaced a suppressed server message
    ]);
    assert.equal(row[9], 'FALSE'); // server_visible_present
    assert.equal(row[10], 'v145'); // app_version
  });

  it('stores the deterministic wrap line for deliberate silence (case B)', () => {
    const row = finalRender.buildRow(sampleParams({
      finalMessage: 'On plan — RIR 2 across 3 sets, right where I called it.',
      finalSource: 'deterministic_wrap',
    }));
    assert.equal(row[4], 'TRUE');
    assert.equal(row[5], 'On plan — RIR 2 across 3 sets, right where I called it.');
    assert.equal(row[6], 'deterministic_wrap');
    assert.equal(row[8], 'TRUE'); // replaced_server_visible
    assert.equal(row[9], 'FALSE'); // server_visible_present
  });

  it('stores an explicit no-visible-message render (client dropped a visible server line)', () => {
    const row = finalRender.buildRow(sampleParams({
      finalMessage: '',
      finalSource: 'none',
      replacedServerVisible: false,
      serverVisiblePresent: true,
    }));
    assert.equal(row[4], 'FALSE');
    assert.equal(row[5], '');
    assert.equal(row[6], 'none');
    assert.equal(row[8], 'FALSE');
    assert.equal(row[9], 'TRUE');
  });

  it('rejects a malformed turn_id (never mints an unrelated render ID)', () => {
    assert.equal(finalRender.buildRow(sampleParams({ turnId: 'not-a-turn' })), null);
    assert.equal(finalRender.buildRow(sampleParams({ turnId: '' })), null);
    assert.equal(finalRender.buildRow(sampleParams({ turnId: null })), null);
  });

  it('rejects a non-allowlisted final_source / final_kind (case F)', () => {
    assert.equal(finalRender.buildRow(sampleParams({ finalSource: 'free text; DROP TABLE' })), null);
    assert.equal(finalRender.buildRow(sampleParams({ finalSource: 'gemini' })), null); // 'gemini' is a model, not a render source
    assert.equal(finalRender.buildRow(sampleParams({ finalKind: 'write' })), null);
  });

  it('bounds the stored message at 4000 chars and short fields at 256 (case F)', () => {
    const row = finalRender.buildRow(sampleParams({
      finalMessage: 'x'.repeat(5000),
      sessionId: 's'.repeat(300),
    }));
    assert.equal(row[5].length, 4000);
    assert.equal(row[2].length, 256);
  });

  it('dedupes by turn_id: a retry/re-render appends once (case E)', async () => {
    const appended = [];
    finalRender._resetForTesting({
      ensure: async () => {},
      getHeader: async () => finalRender.RENDER_HEADERS.slice(),
      append: async (tab, rows) => { for (const r of rows) appended.push(r); },
    });
    const first = finalRender.persist(sampleParams());
    const second = finalRender.persist(sampleParams());
    assert.ok(first);
    assert.equal(second, null);
    await finalRender._flushForTesting();
    assert.equal(appended.length, 1);
    assert.equal(appended[0][1], 'turn:2026-07-21T20:00:00.000Z_1_abc123');
  });

  it('a stale render for an older turn cannot overwrite a newer turn (case E)', async () => {
    const appended = [];
    finalRender._resetForTesting({
      ensure: async () => {},
      getHeader: async () => finalRender.RENDER_HEADERS.slice(),
      append: async (tab, rows) => { for (const r of rows) appended.push(r); },
    });
    finalRender.persist(sampleParams({ turnId: 'turn:2026-07-21T20:00:00.000Z_2_newer' }));
    finalRender.persist(sampleParams({ turnId: 'turn:2026-07-21T20:00:00.000Z_1_abc123' }));
    await finalRender._flushForTesting();
    assert.equal(appended.length, 2);
    assert.notEqual(appended[0][1], appended[1][1]);
  });

  it('never persists a synthetic turn (owner ruling 2026-07-31 containment)', async () => {
    const appended = [];
    finalRender._resetForTesting({
      ensure: async () => {},
      getHeader: async () => finalRender.RENDER_HEADERS.slice(),
      append: async (tab, rows) => { for (const r of rows) appended.push(r); },
    });
    assert.equal(finalRender.persist(sampleParams({ synthetic: true })), null);
    await finalRender._flushForTesting();
    assert.equal(appended.length, 0);
  });

  it('fails closed on a header mismatch: no row lands under the wrong labels', async () => {
    const appended = [];
    finalRender._resetForTesting({
      ensure: async () => {},
      getHeader: async () => ['wrong', 'header'],
      append: async (tab, rows) => { for (const r of rows) appended.push(r); },
    });
    finalRender.persist(sampleParams());
    await finalRender._flushForTesting();
    assert.equal(appended.length, 0);
  });

  it('returns the row in test mode without touching sheets', () => {
    const row = finalRender.persist(sampleParams());
    assert.ok(Array.isArray(row));
    assert.equal(row[1], 'turn:2026-07-21T20:00:00.000Z_1_abc123');
  });
});

describe('getInWorkoutNote final_source mapping (source pin)', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  // The six getInWorkoutNote return paths each name the producer of the final
  // rendered text. The source is telemetry metadata on the Coach_Render row, so
  // a mislabel silently corrupts the record — pin the mapping at the source
  // (the function lives inside an IIFE, so the repo's source-text pattern is
  // the way to test it; see test/unit.test.js 'routine ack').
  it('names the headline producer on every return path', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'app', 'coach-conversation.js'), 'utf8');
    const block = src.slice(
      src.indexOf('async function getInWorkoutNote('),
      src.indexOf('async function getLlmCoachingMessage('));
    assert.ok(block.length > 0, 'getInWorkoutNote block must be found');

    const count = (re) => (block.match(re) || []).length;

    // ack_only wrap line (case B): the deterministic wrap.
    assert.equal(count(/final_source: 'deterministic_wrap'/g), 1);
    // Recovery-advisory headline (bump+recovery override AND LLM-down recovery
    // path): the templated fallback. The bump branch MUST NOT claim
    // voice_primary_line — the primary line is deliberately dropped there.
    assert.equal(
      count(/joinLines\(recoveryLine, nextMoveLine\)\), effort_note, reroute, voice, turn_id: turnId, server_message: serverMessage, final_source: 'templated_fallback'/g),
      2);
    assert.equal(count(/final_source: 'voice_primary_line'/g), 1); // suppressed-prose headline (the fallback opener names it via a ternary, pinned below)
    assert.ok(
      /joinLines\(voice\.primary_line, nextMoveLine, recoveryLine\)\), effort_note, reroute, voice, turn_id: turnId, server_message: serverMessage, final_source: 'voice_primary_line'/.test(block),
      'the suppressed-prose headline is the voice primary line');
    assert.ok(
      /\(voice && voice\.primary_line\) \? 'voice_primary_line' : 'templated_opener'/.test(block),
      'the fallback opener names its producer');
    // LLM prose shown verbatim.
    assert.equal(count(/note: llm, effort_note, reroute, voice, turn_id: turnId, server_message: serverMessage, final_source: 'llm'/g), 1);
    // Every return carries the correlation fields.
    assert.equal(count(/turn_id: turnId, server_message: serverMessage, final_source: /g), 6);
  });
});

describe('finalRenderReport client decision', () => {
  let decide;
  const test = require('node:test');
  test.before(async () => {
    ({ decideFinalRenderReport: decide } = await import('../src/app/finalRenderReport.js'));
  });

  it('case A: agreement (server message shown unchanged) reports nothing', () => {
    assert.equal(decide({
      serverMessage: 'Solid work — that top set moved well.',
      renderedNote: 'Solid work — that top set moved well.',
    }), null);
  });

  it('case D: true silence (nothing at server or client) reports nothing', () => {
    assert.equal(decide({ serverMessage: null, renderedNote: null }), null);
    assert.equal(decide({ serverMessage: '   ', renderedNote: '' }), null);
  });

  it('case B/C: client rendered a line the server did not show — report it', () => {
    const report = decide({
      serverMessage: null,
      renderedNote: 'New ground: Seated Row 200x10 at RIR 2 clears your prior 195. Hold it next time and prove it again.',
    });
    assert.equal(report.finalMessage, 'New ground: Seated Row 200x10 at RIR 2 clears your prior 195. Hold it next time and prove it again.');
    assert.equal(report.replacedServerVisible, true);
    assert.equal(report.serverVisiblePresent, false);
  });

  it('client rendered nothing while the server message was visible — report the drop', () => {
    const report = decide({
      serverMessage: 'Solid work — that top set moved well.',
      renderedNote: null,
    });
    assert.equal(report.finalMessage, '');
    assert.equal(report.replacedServerVisible, false);
    assert.equal(report.serverVisiblePresent, true);
  });

  it('client extended the server message (advisory lines appended) — report the exact final text', () => {
    const report = decide({
      serverMessage: 'Solid work — that top set moved well.',
      renderedNote: 'Solid work — that top set moved well.\n\nNext time: add 5 lb.',
    });
    assert.equal(report.finalMessage, 'Solid work — that top set moved well.\n\nNext time: add 5 lb.');
    assert.equal(report.replacedServerVisible, false);
    assert.equal(report.serverVisiblePresent, true);
  });

  it('bounds the reported message (case F)', () => {
    const report = decide({ serverMessage: null, renderedNote: 'y'.repeat(5000) });
    assert.equal(report.finalMessage.length, 4000);
  });
});

// --- Route: POST /api/coach/final-render (live app harness, mirrors
// test/coachResponseRoute.test.js require-cache stub injection) ---

describe('POST /api/coach/final-render', () => {
  const test = require('node:test');
  let server;
  let baseUrl;
  let appended;
  let finalRenderSvc;

  test.before(async () => {
    process.env.ATLAS_API_KEY = 'test-final-render-key';
    process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
    process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
    delete process.env.ATLAS_INTERACTION_TRACE;
    process.env.ATLAS_PROFILE_GOAL = 'strength';

    const fakeSheets = {
      validateConfig: () => {},
      appendRows: async () => { throw new Error('appendRows must not be called by the final-render path directly'); },
      deleteRowsByRange: async () => {},
      getExerciseCatalog: async () => [],
      getEffortSessionIds: async () => [],
      getLogCompositeKeys: async () => [],
      getRecentRows: async () => [],
      getSheetRows: async () => [],
      getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
      logSheetName: 'Log_Cleaned',
      effortSheetName: 'Effort',
    };
    require.cache[require.resolve('../sheets')] = {
      id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets,
    };
    require.cache[require.resolve('../services/vision')] = {
      id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) },
    };
    require.cache[require.resolve('../services/coach')] = {
      id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
      exports: {
        isConfigured: () => true,
        coachModel: () => 'gemini-2.5-flash-lite',
        generateCoachMessage: async () => 'Solid work.',
        generatePlanMessage: async () => 'Solid work.',
        generateChatReply: async () => ({ reply: null }),
        sanitizeFacts: (f) => f,
      },
    };

    finalRenderSvc = require('../services/coachFinalRender');
    appended = [];
    finalRenderSvc._resetForTesting({
      ensure: async () => {},
      getHeader: async () => finalRenderSvc.RENDER_HEADERS.slice(),
      append: async (tab, rows) => {
        assert.equal(tab, 'Coach_Render');
        for (const r of rows) appended.push(r);
      },
    });

    const { app } = require('../index');
    const originalConsoleLog = console.log;
    console.log = () => {};
    server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    console.log = originalConsoleLog;
  });

  test.after(async () => {
    try { if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))); }
    finally {
      delete process.env.ATLAS_INTERACTION_TRACE;
      delete process.env.ATLAS_PROFILE_GOAL;
    }
  });

  async function postRender(body, { apiKey = 'test-final-render-key', origin = null } = {}) {
    appended.length = 0;
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers['x-atlas-api-key'] = apiKey;
    if (origin) headers['x-atlas-request-origin'] = origin;
    const res = await fetch(`${baseUrl}/api/coach/final-render`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* non-JSON error body */ }
    for (let i = 0; i < 50; i++) { await new Promise((r) => setImmediate(r)); if (appended.length) break; }
    await finalRenderSvc._flushForTesting();
    return { res, body: parsed, row: appended[appended.length - 1] || null, count: appended.length };
  }

  function validBody(overrides = {}) {
    // Unique turn per call unless the test pins one (dedup is process-lifetime).
    const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    return Object.assign({
      turn_id: `turn:2026-07-21T20:00:00.000Z_1_${stamp}`,
      session_id: '20260721-PM-01',
      route: '/api/coach/message',
      final_message: 'New ground: Seated Row 200x10 at RIR 2 clears your prior 195.',
      final_source: 'voice_primary_line',
      final_kind: 'block',
      replaced_server_visible: true,
      server_visible_present: false,
      app_version: 'v145',
    }, overrides);
  }

  it('persists exactly one Coach_Render row for a divergent render (case C)', async () => {
    const body = validBody();
    const { res, body: resBody, row, count } = await postRender(body);
    assert.equal(res.status, 200);
    assert.equal(resBody.status, 'ok');
    assert.equal(count, 1);
    assert.equal(row[1], body.turn_id);
    assert.equal(row[5], 'New ground: Seated Row 200x10 at RIR 2 clears your prior 195.');
    assert.equal(row[6], 'voice_primary_line');
    assert.equal(row[8], 'TRUE');
  });

  it('a repeat report for the same turn is idempotent — still one row (case E)', async () => {
    const body = validBody();
    const first = await postRender(body);
    assert.equal(first.count, 1);
    // Second identical report must not append a second row for the same turn.
    const second = await postRender(body);
    assert.equal(second.res.status, 200);
    assert.equal(second.count, 0);
  });

  it('rejects a malformed turn_id with 400 and persists nothing', async () => {
    const { res, count } = await postRender(validBody({ turn_id: 'bogus' }));
    assert.equal(res.status, 400);
    assert.equal(count, 0);
  });

  it('rejects a non-allowlisted source/kind with 400 and persists nothing (case F)', async () => {
    const badSource = await postRender(validBody({ final_source: 'free text' }));
    assert.equal(badSource.res.status, 400);
    assert.equal(badSource.count, 0);
    const badKind = await postRender(validBody({ final_kind: 'write' }));
    assert.equal(badKind.res.status, 400);
    assert.equal(badKind.count, 0);
  });

  it('rejects a non-string final_message with 400 and persists nothing', async () => {
    const { res, count } = await postRender(validBody({ final_message: 42 }));
    assert.equal(res.status, 400);
    assert.equal(count, 0);
  });

  it('requires the API key: no key → 401, no row', async () => {
    const { res, count } = await postRender(validBody(), { apiKey: null });
    assert.equal(res.status, 401);
    assert.equal(count, 0);
  });

  it('synthetic origin is contained: 200 but no row', async () => {
    const { res, count } = await postRender(validBody(), { origin: 'playwright' });
    assert.equal(res.status, 200);
    assert.equal(count, 0);
  });

  it('never writes to Coach_Response or a training tab', async () => {
    // The capture asserts tab === 'Coach_Render'; a write anywhere else throws.
    const { res, count } = await postRender(validBody());
    assert.equal(res.status, 200);
    assert.equal(count, 1);
  });
});
