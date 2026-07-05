'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SANDBOX_SHEET_ID,
  validateSimulationConfig,
  validateScenarioEndpoint,
  isBlockedEndpoint,
  runSimulation,
  markdownReport,
} = require('../scripts/sim/harness');

test('simulation harness defaults to read-only mode', () => {
  const config = validateSimulationConfig({});
  assert.equal(config.mode, 'read-only');
  assert.equal(config.writeEnabled, false);
  assert.equal(config.sheetId, null);
  assert.equal(config.retryAttempts, 5);
  assert.equal(config.retryDelayMs, 65000);
});

test('simulation harness refuses non-sandbox sheet writes', () => {
  const rejectedSheetId = 'not-the-sandbox-sheet';
  assert.throws(
    () => validateSimulationConfig({ mode: 'write', sheetId: rejectedSheetId }),
    (error) => {
      assert.match(error.message, /known sandbox sheet ID/);
      assert.doesNotMatch(error.message, new RegExp(rejectedSheetId));
      return true;
    }
  );
});

test('simulation harness refuses write mode without sandbox sheet ID', () => {
  assert.throws(
    () => validateSimulationConfig({ mode: 'write' }),
    /provide the sandbox sheet ID explicitly/
  );
});

test('simulation harness allows sandbox writes only when explicitly enabled', () => {
  const readOnly = validateSimulationConfig({ sheetId: SANDBOX_SHEET_ID });
  assert.equal(readOnly.writeEnabled, false);

  const write = validateSimulationConfig({ mode: 'write', sheetId: SANDBOX_SHEET_ID, enableWriteScenarios: true });
  assert.equal(write.writeEnabled, true);
  assert.equal(write.sheetId, SANDBOX_SHEET_ID);
});

test('simulation harness refuses write mode without explicit write scenario flag', () => {
  assert.throws(
    () => validateSimulationConfig({ mode: 'write', sheetId: SANDBOX_SHEET_ID }),
    /--enable-write-scenarios/
  );
});

test('blocked endpoints cannot be called in read-only mode', () => {
  assert.equal(isBlockedEndpoint('/api/log-workout'), true);
  assert.throws(
    () => validateScenarioEndpoint({ method: 'POST', endpoint: '/api/log-workout', prompt: 'write this' }, { mode: 'read-only' }),
    /Read-only simulation refused blocked endpoint/
  );
});

test('safe read endpoints are accepted by the v1 allowlist', () => {
  assert.deepEqual(
    validateScenarioEndpoint({ method: 'GET', endpoint: '/api/recommend/next/BEN01', prompt: 'bench' }, { mode: 'read-only' }),
    { method: 'GET', endpoint: '/api/recommend/next/BEN01' }
  );
  assert.deepEqual(
    validateScenarioEndpoint({ method: 'POST', endpoint: '/api/coach/chat', prompt: 'hello' }, { mode: 'read-only' }),
    { method: 'POST', endpoint: '/api/coach/chat' }
  );
});

test('simulation report shape is stable', async () => {
  let callCount = 0;
  const report = await runSimulation({
    mode: 'read-only',
    baseUrl: 'http://127.0.0.1:3000',
    scenarios: [
      { name: 'chat', prompt: 'Should I deload?', method: 'POST', endpoint: '/api/coach/ask' },
    ],
    fetchImpl: async (url) => {
      callCount += 1;
      if (new URL(url).pathname === '/api/debug/config') {
        return {
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            data: {
              sheetVerification: {
                canVerify: true,
                idLast6: 'H3CeXE',
                isSandboxSheet: true,
                isProductionSheet: false,
              },
            },
          }),
        };
      }
      return {
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          data: {
            answer: 'Use a deload when performance and recovery signals say to reduce stress.',
            source: 'training_sme',
          },
        }),
      };
    },
  });

  assert.equal(callCount, 2);
  assert.deepEqual(Object.keys(report), [
    'schema_version',
    'generated_at',
    'mode',
    'sheet_id',
    'server_sheet_verification',
    'warnings',
    'base_url',
    'scenario_count',
    'write_scenario_count',
    'runs_requested',
    'delay_ms',
    'retry_attempts',
    'retry_delay_ms',
    'run_summary',
    'variation_summary',
    'results',
    'write_scenarios',
    'pass',
  ]);
  assert.equal(report.schema_version, 1);
  assert.equal(report.mode, 'read-only');
  assert.equal(report.sheet_id, null);
  assert.equal(report.server_sheet_verification.isSandboxSheet, true);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.scenario_count, 1);
  assert.equal(report.write_scenario_count, 0);
  assert.equal(report.runs_requested, 0);
  assert.equal(report.retry_attempts, 5);
  assert.equal(report.retry_delay_ms, 65000);
  assert.deepEqual(Object.keys(report.run_summary), [
    'runs_requested',
    'runs_completed',
    'runs_passed',
    'runs_failed',
    'rows_written',
    'brain_shadow_entries',
    'retry_attempts_used',
    'errors',
    'flagged_odd_results',
    'variation_summary',
  ]);
  assert.equal(report.results.length, 1);

  const result = report.results[0];
  assert.deepEqual(Object.keys(result), [
    'scenario_name',
    'prompt',
    'endpoint',
    'http_status',
    'user_visible_response_summary',
    'brian_shadow_summary',
    'brain_shadow_rows_generated',
    'errors',
    'duration_ms',
  ]);
  assert.equal(result.scenario_name, 'chat');
  assert.equal(result.http_status, 200);
  assert.match(result.user_visible_response_summary, /deload/);
  assert.equal(result.brain_shadow_rows_generated, 0);
  assert.deepEqual(result.errors, []);
});

test('markdown report includes the stable summary table', () => {
  const markdown = markdownReport({
    schema_version: 1,
    mode: 'read-only',
    sheet_id: null,
    base_url: 'http://127.0.0.1:3000',
    scenario_count: 1,
    results: [{
      scenario_name: 'bench_next',
      endpoint: '/api/recommend/next/BEN01',
      http_status: 200,
      duration_ms: 12,
      user_visible_response_summary: 'Increase to 230 x 5.',
      errors: [],
    }],
  });

  assert.match(markdown, /# Atlas Simulation Report/);
  assert.match(markdown, /\| Scenario \| Endpoint \| Status \| Duration \| Summary \| Errors \|/);
  assert.match(markdown, /bench_next/);
});

test('harness allows read-only when server sheet verification is unavailable but warns', async () => {
  const report = await runSimulation({
    mode: 'read-only',
    baseUrl: 'http://127.0.0.1:3000',
    scenarios: [
      { name: 'train_today', prompt: 'What should I train today?', method: 'GET', endpoint: '/api/plan/intent-recommendation' },
    ],
    fetchImpl: async (url) => {
      if (new URL(url).pathname === '/api/debug/config') {
        return { status: 404, text: async () => JSON.stringify({ ok: false }) };
      }
      return { status: 200, text: async () => JSON.stringify({ ok: true, data: { intents: [{ name: 'upper' }] } }) };
    },
  });

  assert.equal(report.server_sheet_verification, null);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /verification unavailable/i);
  assert.equal(report.results[0].http_status, 200);
});

test('harness refuses write mode when server sheet is production', async () => {
  await assert.rejects(
    () => runSimulation({
      mode: 'write',
      sheetId: SANDBOX_SHEET_ID,
      enableWriteScenarios: true,
      baseUrl: 'http://127.0.0.1:3000',
      scenarios: [],
      fetchImpl: async () => ({
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          data: {
            sheetVerification: {
              canVerify: true,
              idLast6: 'uDcA0',
              isSandboxSheet: false,
              isProductionSheet: true,
            },
          },
        }),
      }),
    }),
    /production Atlas MASTER sheet/
  );
});

test('harness refuses write mode when server sheet is unknown', async () => {
  await assert.rejects(
    () => runSimulation({
      mode: 'write',
      sheetId: SANDBOX_SHEET_ID,
      enableWriteScenarios: true,
      baseUrl: 'http://127.0.0.1:3000',
      scenarios: [],
      fetchImpl: async () => ({
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          data: { sheetVerification: { canVerify: false, isSandboxSheet: false, isProductionSheet: false } },
        }),
      }),
    }),
    /did not confirm the active server sheet/
  );
});

test('harness allows write mode only when server confirms sandbox and runs fake workout write', async () => {
  const recommendationReplies = ['Hold 225 x 5.', 'Repeat 135 x 5 until the simulation row is reviewed.'];
  const logPayloads = [];
  const report = await runSimulation({
    mode: 'write',
    sheetId: SANDBOX_SHEET_ID,
    enableWriteScenarios: true,
    baseUrl: 'http://127.0.0.1:3000',
    scenarios: [],
    runs: 1,
    now: new Date('2026-07-05T12:34:56.000Z'),
    fetchImpl: async (url, requestOptions = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/debug/config') {
        return {
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            data: {
              sheetVerification: {
                canVerify: true,
                idLast6: 'H3CeXE',
                isSandboxSheet: true,
                isProductionSheet: false,
              },
            },
          }),
        };
      }
      if (parsed.pathname === '/api/recommend/next/BEN01') {
        const recommendation = recommendationReplies.shift();
        return { status: 200, text: async () => JSON.stringify({ ok: true, data: { recommendation } }) };
      }
      if (parsed.pathname === '/api/log-workout') {
        const payload = JSON.parse(requestOptions.body);
        logPayloads.push(payload);
        return {
          status: 200,
          text: async () => JSON.stringify({
              ok: true,
              data: {
                sheet_write: 'success',
                log_rows_written: payload.log_rows.length,
                effort_rows_written: 0,
                logAppendedRange: 'Log_Cleaned!A42:L44',
              },
            }),
        };
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(report.mode, 'write');
  assert.equal(report.server_sheet_verification.isSandboxSheet, true);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.results.length, 0);
  assert.equal(report.write_scenarios.length, 1);
  assert.equal(report.run_summary.runs_completed, 1);
  assert.equal(report.run_summary.runs_passed, 1);
  assert.equal(report.run_summary.runs_failed, 0);
  assert.equal(report.run_summary.rows_written, 8);
  assert.equal(report.run_summary.flagged_odd_results.length, 0);
  assert.equal(report.variation_summary.unique_exercises, 3);
  assert.equal(report.variation_summary.unique_muscle_groups, 3);
  const writeScenario = report.write_scenarios[0];
  assert.deepEqual(Object.keys(writeScenario), [
    'name',
    'run',
    'prompt',
    'recommendation_endpoint',
    'write_endpoint',
    'session_id',
    'write_id',
    'sandbox_confirmed',
    'session_type',
    'exercise_names',
    'muscle_groups',
    'movement_patterns',
    'set_outcome',
    'expected_rows',
    'fake_sets',
    'first_recommendation_received',
    'second_recommendation_received',
    'fake_result_logged',
    'rows_written',
    'brain_shadow_entries',
    'retry_attempts_used',
    'pass',
    'errors',
    'duration_ms',
    'first_recommendation_status',
    'write_status',
    'second_recommendation_status',
  ]);
  assert.equal(writeScenario.pass, true);
  assert.equal(writeScenario.run, 1);
  assert.equal(writeScenario.sandbox_confirmed, true);
  assert.equal(writeScenario.session_type, 'push');
  assert.deepEqual(writeScenario.exercise_names, ['Bench Press', 'Overhead Press', 'Triceps Pushdown']);
  assert.deepEqual(writeScenario.muscle_groups, ['Chest', 'Shoulders', 'Triceps']);
  assert.deepEqual(writeScenario.movement_patterns, ['press', 'accessory']);
  assert.equal(writeScenario.expected_rows, 8);
  assert.equal(writeScenario.fake_sets.length, 8);
  assert.equal(writeScenario.first_recommendation_received, 'Hold 225 x 5.');
  assert.equal(writeScenario.second_recommendation_received, 'Repeat 135 x 5 until the simulation row is reviewed.');
  assert.equal(writeScenario.fake_result_logged, true);
  assert.equal(writeScenario.rows_written, 8);
  assert.equal(writeScenario.retry_attempts_used, 0);
  assert.equal(logPayloads.length, 1);
  assert.equal(logPayloads[0].session_id, 'SIM-WORKOUT-20260705123456-001');
  assert.equal(logPayloads[0].write_id, 'sim-workout-20260705123456-001');
  assert.equal(logPayloads[0].log_rows.length, 8);
  assert.deepEqual(new Set(logPayloads[0].log_rows.map(row => row.exercise)), new Set(['Bench Press', 'Overhead Press', 'Triceps Pushdown']));
  assert.ok(logPayloads[0].log_rows.every(row => /^SIMULATION ONLY/.test(row.notes)));
  assert.equal(recommendationReplies.length, 0);
});

test('harness retries transient sandbox write backpressure without weakening safety checks', async () => {
  let writeCalls = 0;
  let sleepCalls = 0;
  const report = await runSimulation({
    mode: 'write',
    sheetId: SANDBOX_SHEET_ID,
    enableWriteScenarios: true,
    retryAttempts: 1,
    retryDelayMs: 0,
    runs: 1,
    baseUrl: 'http://127.0.0.1:3000',
    scenarios: [],
    now: new Date('2026-07-05T12:34:56.000Z'),
    sleepImpl: async () => { sleepCalls += 1; },
    fetchImpl: async (url, requestOptions = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/debug/config') {
        return {
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            data: {
              sheetVerification: {
                canVerify: true,
                idLast6: 'H3CeXE',
                isSandboxSheet: true,
                isProductionSheet: false,
              },
            },
          }),
        };
      }
      if (parsed.pathname === '/api/recommend/next/BEN01') {
        return { status: 200, text: async () => JSON.stringify({ ok: true, data: { recommendation: 'Mock rec' } }) };
      }
      if (parsed.pathname === '/api/log-workout') {
        writeCalls += 1;
        const payload = JSON.parse(requestOptions.body);
        if (writeCalls === 1) {
          return {
            status: 429,
            text: async () => JSON.stringify({ ok: false, message: 'Too many requests' }),
          };
        }
        return {
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            data: {
              sheet_write: 'success',
              log_rows_written: payload.log_rows.length,
              effort_rows_written: 0,
            },
          }),
        };
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(writeCalls, 2);
  assert.equal(sleepCalls, 1);
  assert.equal(report.server_sheet_verification.isSandboxSheet, true);
  assert.equal(report.run_summary.runs_passed, 1);
  assert.equal(report.run_summary.retry_attempts_used, 1);
  assert.equal(report.write_scenarios[0].retry_attempts_used, 1);
  assert.equal(report.pass, true);
});

test('harness --runs 100 loops without changing safety rules', async () => {
  let debugCalls = 0;
  let recommendationCalls = 0;
  let writeCalls = 0;
  const report = await runSimulation({
    mode: 'write',
    sheetId: SANDBOX_SHEET_ID,
    enableWriteScenarios: true,
    runs: 100,
    baseUrl: 'http://127.0.0.1:3000',
    scenarios: [],
    now: new Date('2026-07-05T12:34:56.000Z'),
    fetchImpl: async (url, requestOptions = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/debug/config') {
        debugCalls += 1;
        return {
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            data: {
              sheetVerification: {
                canVerify: true,
                idLast6: 'H3CeXE',
                isSandboxSheet: true,
                isProductionSheet: false,
              },
            },
          }),
        };
      }
      if (parsed.pathname === '/api/recommend/next/BEN01') {
        recommendationCalls += 1;
        return { status: 200, text: async () => JSON.stringify({ ok: true, data: { recommendation: `Mock rec ${recommendationCalls}` } }) };
      }
      if (parsed.pathname === '/api/log-workout') {
        writeCalls += 1;
        const payload = JSON.parse(requestOptions.body);
        assert.match(payload.session_id, /^SIM-WORKOUT-20260705123456-\d{3}$/);
        assert.ok(payload.log_rows.length >= 5);
        assert.ok(payload.log_rows.every(row => /^SIMULATION ONLY/.test(row.notes)));
        return {
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            data: {
              sheet_write: 'success',
              log_rows_written: payload.log_rows.length,
              effort_rows_written: 0,
            },
          }),
        };
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(debugCalls, 1);
  assert.equal(recommendationCalls, 200);
  assert.equal(writeCalls, 100);
  assert.equal(report.write_scenario_count, 100);
  assert.equal(report.run_summary.runs_completed, 100);
  assert.equal(report.run_summary.runs_passed, 100);
  assert.equal(report.run_summary.runs_failed, 0);
  assert.equal(report.run_summary.rows_written, 752);
  assert.equal(report.run_summary.retry_attempts_used, 0);
  assert.equal(report.run_summary.errors.length, 0);
  assert.equal(report.run_summary.flagged_odd_results.length, 0);
  assert.equal(report.pass, true);
  assert.equal(report.write_scenarios[0].set_outcome, 'completed');
  assert.equal(report.write_scenarios[4].set_outcome, 'failed_last_set');
});

test('100-run sandbox simulation produces meaningful exercise and muscle-group variation', async () => {
  const payloads = [];
  const report = await runSimulation({
    mode: 'write',
    sheetId: SANDBOX_SHEET_ID,
    enableWriteScenarios: true,
    runs: 100,
    baseUrl: 'http://127.0.0.1:3000',
    scenarios: [],
    now: new Date('2026-07-05T12:34:56.000Z'),
    fetchImpl: async (url, requestOptions = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/debug/config') {
        return {
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            data: {
              sheetVerification: {
                canVerify: true,
                idLast6: 'H3CeXE',
                isSandboxSheet: true,
                isProductionSheet: false,
              },
            },
          }),
        };
      }
      if (parsed.pathname === '/api/recommend/next/BEN01') {
        return { status: 200, text: async () => JSON.stringify({ ok: true, data: { recommendation: 'Mock recommendation' } }) };
      }
      if (parsed.pathname === '/api/log-workout') {
        const payload = JSON.parse(requestOptions.body);
        payloads.push(payload);
        return {
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            data: {
              sheet_write: 'success',
              log_rows_written: payload.log_rows.length,
              effort_rows_written: 0,
            },
          }),
        };
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const exercises = new Set(payloads.flatMap(payload => payload.log_rows.map(row => row.exercise)));
  assert.equal(payloads.length, 100);
  assert.ok(exercises.size > 1, '100 simulated runs must not write only one exercise');
  assert.ok(report.variation_summary.unique_exercises > 1, 'variation summary should count multiple exercises');
  assert.ok(report.variation_summary.unique_muscle_groups > 1, '100 simulated runs must not write only one muscle group');
  assert.deepEqual(
    new Set(report.variation_summary.session_types),
    new Set(['push', 'pull', 'legs', 'upper', 'full_body', 'cardio_recovery'])
  );
  for (const pattern of ['squat', 'hinge', 'press', 'row', 'pull', 'accessory', 'cardio']) {
    assert.ok(report.variation_summary.movement_patterns.includes(pattern), `missing ${pattern} movement pattern`);
  }
});
