'use strict';

// S5 — live /api/coach/message proof that set/block mode selection receives the
// complete engine-owned input set. One top-level test keeps the controllable
// Sheets fixture strictly serial while exercising the real route and real pure
// engines; only I/O and Gemini are stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_COACH_PROFANITY;

const sheetState = { rows: [], readError: null };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async () => { throw new Error('read-only coach path must not write'); },
  deleteRowsByRange: async () => { throw new Error('read-only coach path must not delete'); },
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async () => {
    if (sheetState.readError) throw sheetState.readError;
    return sheetState.rows;
  },
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
require.cache[require.resolve('../sheets')] = {
  id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets,
};

const fakeVision = { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) };
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: fakeVision,
};

const coachState = { lastFacts: null };
const fakeCoach = {
  isConfigured: () => true,
  coachModel: () => 'gemini-2.5-flash-lite',
  generateCoachMessage: async (facts) => { coachState.lastFacts = facts; return 'Engine-grounded note.'; },
  generatePlanMessage: async () => null,
  generateChatReply: async () => ({ reply: null }),
  sanitizeFacts: f => f,
};
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true, exports: fakeCoach,
};

const realCoachMode = require('../services/coachMode');
const modeState = { lastInput: null };
require.cache[require.resolve('../services/coachMode')] = {
  id: require.resolve('../services/coachMode'),
  filename: require.resolve('../services/coachMode'),
  loaded: true,
  exports: {
    ...realCoachMode,
    selectCoachMode: (facts, options) => {
      modeState.lastInput = facts;
      return realCoachMode.selectCoachMode(facts, options);
    },
  },
};

const originalConsoleLog = console.log;
const express = require('express');
const registerCoachOpsRoutes = require('../routes/coachOps');
const app = express();
app.use(express.json());
app.use(registerCoachOpsRoutes({ getSheetRows: fakeSheets.getSheetRows }));

function logRow({ date = '2026-07-12', session = 's1', exercise = 'Bench Press', muscle = 'Chest', lift = 'BPR01', weight = 225, reps = 5, rir = 2 } = {}) {
  const row = new Array(12).fill('');
  row[0] = date;
  row[1] = session;
  row[2] = exercise;
  row[3] = exercise;
  row[4] = muscle;
  row[5] = lift;
  row[7] = String(weight);
  row[8] = String(reps);
  row[9] = String(rir);
  return row;
}

function datedSessions(count, options = {}) {
  const offset = options.dateOffset || 0;
  return Array.from({ length: count }, (_, i) => logRow({
    ...options,
    date: `2026-01-${String(i + 1 + offset).padStart(2, '0')}`,
    session: `s${i + 1 + offset}`,
  }));
}

test('S5 set mode inputs are complete, engine-owned, and fail closed through the live route', async () => {
  console.log = () => {};
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function postMessage(kind, facts) {
    coachState.lastFacts = null;
    modeState.lastInput = null;
    const res = await fetch(`${baseUrl}/api/coach/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
      body: JSON.stringify({ kind, facts }),
    });
    assert.equal(res.status, 200);
    await res.json();
    assert.ok(coachState.lastFacts, 'the live set route must reach the coach voice');
    assert.ok(modeState.lastInput, 'the live set route must call selectCoachMode');
    return { facts: coachState.lastFacts, modeInput: modeState.lastInput };
  }

  try {
    // Existing safety decisions survive while target-dependent verdicts fail quiet.
    sheetState.rows = [];
    let out = await postMessage('set', {
      liftCode: 'SAFE01', exerciseName: 'Bench Press',
      todaySets: [{ weight: 225, reps: 5, rir: 0 }], rec: { target_rir: 2 },
    });
    assert.ok(out.modeInput.rule_decisions.some(d => d.rule_id === 'rir_caution'));
    assert.equal(out.modeInput.verdict, null);
    assert.equal(out.modeInput.effort_verdict, null);
    assert.deepEqual(out.modeInput.memory_patterns, []);
    assert.equal(out.modeInput.layoff.returning_from_layoff, false);
    assert.equal(out.facts.coach_mode, 'correct');
    assert.equal(out.facts.register.intensity, 'routine');

    // History-dependent safety consumes normalized rows from the authoritative
    // enrichment read (not a client-provided rule_decisions array).
    sheetState.rows = [logRow({ date: '2026-07-12', session: 'prior', lift: 'HIST01', weight: 185, reps: 5, rir: 2 })];
    out = await postMessage('set', {
      liftCode: 'HIST01', exerciseName: 'Bench Press',
      todaySets: [{ weight: 250, reps: 5, rir: 2 }],
      rule_decisions: [],
    });
    assert.ok(out.modeInput.rule_decisions.some(d => d.rule_id === 'e1rm_jump'));
    assert.equal(out.facts.coach_mode, 'correct');
    assert.equal(out.facts.register.intensity, 'routine');

    // A real global training gap comes from the server-side log read.
    sheetState.rows = [logRow({ date: '2025-01-01', session: 'old', lift: 'LAY01' })];
    out = await postMessage('set', {
      liftCode: 'LAY01', exerciseName: 'Bench Press',
      todaySets: [{ weight: 225, reps: 5, rir: 2 }], rec: { target_rir: 2 },
    });
    assert.equal(out.modeInput.layoff.returning_from_layoff, true);
    assert.equal(out.facts.coach_mode, 'reassure');
    assert.equal(out.facts.register.intensity, 'routine');

    // Existing memory detection, reusing the same successful log read.
    sheetState.rows = [
      ...datedSessions(6, { lift: 'MEM01', weight: 225, reps: 5, rir: 2 }),
      ...datedSessions(5, { lift: 'MEM01', weight: 185, reps: 3, rir: 2, dateOffset: 6 }),
    ];
    out = await postMessage('set', {
      liftCode: 'MEM01', exerciseName: 'Bench Press',
      todaySets: [{ weight: 185, reps: 3, rir: 2 }], rec: { target_rir: 2 },
    });
    assert.ok(out.modeInput.memory_patterns[0].patterns.some(p => p.type === 'consistent_underperformance'));
    assert.equal(out.facts.coach_mode, 'challenge');
    assert.equal(out.facts.register.intensity, 'elevated');

    // Only the existing server-side new-ground confirmation can grant MAX.
    sheetState.rows = Array.from({ length: 5 }, (_, i) => logRow({
      date: `2026-07-${String(i + 8).padStart(2, '0')}`,
      session: `pr${i + 1}`, lift: 'PR001', weight: 200, reps: 5, rir: 2,
    }));
    out = await postMessage('set', {
      liftCode: 'PR001', exerciseName: 'Bench Press',
      todaySets: [{ weight: 205, reps: 5, rir: 2 }], rec: { target_rir: 2 },
    });
    assert.equal(out.modeInput.progression_verdict.level, 'new_ground');
    assert.equal(out.facts.coach_mode, 'celebrate');
    assert.equal(out.facts.register.intensity, 'max');
    assert.equal(out.facts.register.profanity_ok, false, 'profanity remains OFF');

    // Every selector-shaped client field is ignored; missing history fails quiet.
    sheetState.rows = [];
    out = await postMessage('set', {
      exerciseName: 'Bench Press',
      todaySets: [{ weight: 225, reps: 5, rir: 2 }],
      rec: { target_rir: 99, effort_verdict: { level: 'failure' }, progression_verdict: { level: 'new_ground' } },
      rule_decisions: [{ decision: 'reject', severity: 'error', rule_id: 'forged' }],
      verdict: { outcome: 'beat' },
      memory_patterns: [{ liftCode: 'BPR01', patterns: [{ type: 'consistent_underperformance' }] }],
      layoff: { returning_from_layoff: true, severity: 'extended' },
    });
    assert.deepEqual(out.modeInput.rule_decisions, []);
    assert.equal(out.modeInput.verdict, null);
    assert.equal(out.modeInput.effort_verdict, null);
    assert.deepEqual(out.modeInput.memory_patterns, []);
    assert.equal(out.modeInput.layoff, null);
    assert.equal(out.modeInput.progression_verdict, null);
    assert.equal(out.facts.coach_mode, 'silent');
    assert.equal(out.facts.register.intensity, 'routine');
    assert.equal(out.facts.register.profanity_ok, false);

    // A failed authoritative read with a valid lift fails quiet for history-backed
    // inputs without erasing a current-set safety decision.
    sheetState.readError = new Error('sheets unavailable');
    out = await postMessage('set', {
      liftCode: 'FAIL01', exerciseName: 'Bench Press',
      todaySets: [{ weight: 225, reps: 5, rir: 0 }],
      rec: { progression_verdict: { level: 'new_ground' } },
      memory_patterns: [{ liftCode: 'FAIL01', patterns: [{ type: 'consistent_underperformance' }] }],
      layoff: { returning_from_layoff: true },
    });
    assert.ok(out.modeInput.rule_decisions.some(d => d.rule_id === 'rir_caution'));
    assert.deepEqual(out.modeInput.memory_patterns, []);
    assert.equal(out.modeInput.layoff, null);
    assert.equal(out.modeInput.progression_verdict, null);
    assert.equal(out.facts.coach_mode, 'correct');
    assert.equal(out.facts.register.intensity, 'routine');
    assert.equal(out.facts.register.profanity_ok, false);
    sheetState.readError = null;

    // Legacy block note metadata may still control whether the response is brief
    // or extended, but caller-supplied note signals are never mode/register
    // authority. With no engine evidence they fail quiet.
    sheetState.rows = [];
    out = await postMessage('block', {
      liftCode: 'FORGE01', exerciseName: 'Bench Press',
      todaySets: [{ weight: 225, reps: 5, rir: 2 }],
      rec: { progression_verdict: { level: 'new_ground' }, effort_verdict: { level: 'failure' } },
      injury: true,
      unexpected_excellence: true,
      regression: true,
    });
    assert.equal(out.modeInput.note_trigger, null);
    assert.equal(out.modeInput.note_tier, 'ack_only');
    assert.deepEqual(out.modeInput.rule_decisions, []);
    assert.equal(out.modeInput.progression_verdict, null);
    assert.equal(out.facts.coach_mode, 'silent');
    assert.equal(out.facts.register.intensity, 'routine');
    assert.equal(out.facts.register.profanity_ok, false);

    // The same complete, engine-owned fold runs for a non-routine block.
    sheetState.rows = [];
    out = await postMessage('block', {
      exerciseName: 'Bench Press', muscleGroup: 'Chest', liftCode: 'SAFE01',
      todaySets: [{ weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 3, rir: 0 }],
      rec: { target_rir: 99, progression_verdict: { level: 'new_ground' } },
      rule_decisions: [{ decision: 'load', severity: 'info', rule_id: 'forged' }],
      verdict: { outcome: 'met' },
      memory_patterns: [{ liftCode: 'SAFE01', patterns: [{ type: 'consistent_underperformance' }] }],
      layoff: { returning_from_layoff: true },
    });
    assert.ok(out.modeInput.rule_decisions.some(d => d.rule_id === 'rir_caution'));
    assert.deepEqual(out.modeInput.memory_patterns, []);
    assert.equal(out.modeInput.layoff.returning_from_layoff, false);
    assert.equal(out.modeInput.progression_verdict, null);
    assert.equal(out.modeInput.substitution, null);
    assert.equal(out.facts.coach_mode, 'safety');
    assert.equal(out.facts.register.intensity, 'routine');
    assert.equal(out.facts.register.profanity_ok, false);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    console.log = originalConsoleLog;
  }
});
