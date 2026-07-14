'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';

const sheetState = { appendCalls: [] };

function benchRow(date, sessionId, weight, reps, rir, notes = '', liftCode = 'BEN01') {
  return [date, sessionId, 'Bench Press', 'Bench Press', 'Chest', liftCode, '1', String(weight), String(reps), String(rir), notes];
}

const allLogRows = [
  benchRow('2026-07-01', 'PR1', 225, 6, 2, '', 'BENPR'),
  benchRow('2026-07-08', 'PR2', 225, 6, 2, '', 'BENPR'),
  benchRow('2026-07-01', 'FIRST1', 225, 5, 2, '', 'BENFIRST'),
  benchRow('2026-07-01', 'THREE1', 225, 6, 2, '', 'BENTHREE'),
  benchRow('2026-07-08', 'THREE2', 225, 6, 2, '', 'BENTHREE'),
  benchRow('2026-07-01', 'MISS1', 225, 6, 2, '', 'BENMISS'),
  benchRow('2026-07-08', 'MISS2', 225, 6, 0, '', 'BENMISS'),
  benchRow('2026-07-01', 'FORGE1', 225, 6, 2, '', 'BENFORGE'),
  benchRow('2026-07-01', 'REC1', 225, 6, 2, '', 'BENREC'),
  benchRow('2026-07-08', 'REC2', 225, 6, 2, '', 'BENREC'),
  benchRow('2026-07-01', 'RECOVERY1', 225, 6, 5, '', 'BENRECOVERY'),
  benchRow('2026-07-08', 'RECOVERY2', 225, 6, 5, '', 'BENRECOVERY'),
];

const fakeSheets = {
  validateConfig: () => {},
  appendRows: async (tabName, rows) => {
    sheetState.appendCalls.push({ tabName, rows });
    throw new Error('appendRows must not be called by the read-only coach path');
  },
  deleteRowsByRange: async () => {},
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort', 'Flight_Recorder'],
  getSheetRows: async (tabName) => {
    if (tabName === 'Log_Cleaned') {
      return allLogRows;
    }
    return [];
  },
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

const coachState = { calls: 0, lastFacts: null };
const fakeCoach = {
  isConfigured: () => true,
  coachModel: () => 'gemini-2.5-flash-lite',
  generateCoachMessage: async (facts) => {
    coachState.calls += 1;
    coachState.lastFacts = facts;
    return 'Generic coach prose that should lose to deterministic set context.';
  },
  generatePlanMessage: async () => null,
  generateChatReply: async () => ({ reply: null }),
  sanitizeFacts: (f) => f,
};
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true, exports: fakeCoach,
};

const originalConsoleLog = console.log;
const { app } = require('../index');

let server;
let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  } finally {
    console.log = originalConsoleLog;
  }
});

test.beforeEach(() => {
  sheetState.appendCalls = [];
  coachState.calls = 0;
  coachState.lastFacts = null;
});

async function postSet(facts) {
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ kind: 'block', facts }),
  });
  const body = await res.json();
  return { res, body };
}

function voiceLine(body) {
  return body.data && body.data.voice && body.data.voice.primary_line;
}

test('live set route: genuine 245x6 Bench new ground over a 225 server history ceiling', { concurrency: false }, async () => {
  const { res, body } = await postSet({
    liftCode: 'BENPR',
    exerciseName: 'Bench Press',
    muscleGroup: 'Chest',
    todaySets: [{ weight: 245, reps: 6, rir: 2 }],
  });

  assert.equal(res.status, 200);
  assert.equal(body.data.note_trigger, 'pr_milestone');
  assert.match(voiceLine(body), /New ground/i);
  assert.match(voiceLine(body), /Bench Press 245x6 at RIR 2/i);
  assert.match(voiceLine(body), /prior 225/i);
});

test('live set route: client-supplied target RIR cannot grant on-target hold or increase', { concurrency: false }, async () => {
  const { res, body } = await postSet({
    liftCode: 'BENTHREE',
    exerciseName: 'Bench Press',
    muscleGroup: 'Chest',
    todaySets: [{ weight: 225, reps: 6, rir: 4 }],
    rec: { target_rir: 4 },
  });

  assert.equal(res.status, 200);
  assert.doesNotMatch(JSON.stringify(body.data), /three straight|bump the load|Right on target/i);
  assert.equal(body.data.flight_recorder_context.register, 'conservative_hold');
  assert.notEqual(body.data.flight_recorder_context.progression_context.target_rir, 4);
});

test('live set route: first exposure without an authoritative target fails conservative', { concurrency: false }, async () => {
  const { res, body } = await postSet({
    liftCode: 'BENFIRST',
    exerciseName: 'Bench Press',
    muscleGroup: 'Chest',
    intentId: 'build_strength',
    todaySets: [{ weight: 225, reps: 6, rir: 2 }],
  });

  assert.equal(res.status, 200);
  assert.notEqual(body.data.flight_recorder_context.register, 'on_target_hold');
  assert.equal(body.data.flight_recorder_context.register, 'conservative_hold');
  assert.doesNotMatch(JSON.stringify(body.data), /Right on target|prove it again/i);
});

test('live set route: three comparable sessions do not create an independent load bump', { concurrency: false }, async () => {
  const { res, body } = await postSet({
    liftCode: 'BENTHREE',
    exerciseName: 'Bench Press',
    muscleGroup: 'Chest',
    intentId: 'build_strength',
    todaySets: [{ weight: 225, reps: 6, rir: 2 }],
  });

  assert.equal(res.status, 200);
  assert.doesNotMatch(JSON.stringify(body.data), /three straight on target|bump the load next session|increase_load/i);
  assert.equal(body.data.flight_recorder_context.register, 'conservative_hold');
});

test('live set route: a comparable miss still cannot be repaired by client-shaped target data', { concurrency: false }, async () => {
  const { res, body } = await postSet({
    liftCode: 'BENMISS',
    exerciseName: 'Bench Press',
    muscleGroup: 'Chest',
    intentId: 'build_strength',
    todaySets: [{ weight: 225, reps: 6, rir: 2 }],
    rec: { target_rir: 2 },
  });

  assert.equal(res.status, 200);
  assert.doesNotMatch(JSON.stringify(body.data), /three straight|bump the load|Right on target/i);
  assert.equal(body.data.flight_recorder_context.register, 'conservative_hold');
});

test('live set route: thin history without an authoritative target stays conservative', { concurrency: false }, async () => {
  const { res, body } = await postSet({
    liftCode: 'BENTHIN',
    exerciseName: 'Bench Press',
    muscleGroup: 'Chest',
    intentId: 'build_strength',
    todaySets: [{ weight: 225, reps: 6, rir: 2 }],
  });

  assert.equal(res.status, 200);
  assert.equal(body.data.flight_recorder_context.register, 'conservative_hold');
  assert.doesNotMatch(JSON.stringify(body.data), /New ground|three straight|bump the load|Right on target/i);
});

test('live set route: recovery/deload context never emits on-target increase or bump-load language', { concurrency: false }, async () => {
  const { res, body } = await postSet({
    liftCode: 'BENRECOVERY',
    exerciseName: 'Bench Press',
    muscleGroup: 'Chest',
    intentId: 'recovery_pump',
    todaySets: [{ weight: 225, reps: 6, rir: 5 }],
    rec: { target_rir: 2, deload: { in_deload: true } },
  });

  assert.equal(res.status, 200);
  assert.doesNotMatch(JSON.stringify(body.data), /three straight|bump the load|increase_load/i);
  assert.equal(body.data.flight_recorder_context.register, 'conservative_hold');
  assert.notEqual(body.data.flight_recorder_context.progression_context.next_action, 'increase_load');
});

test('live set route: forged client PR and streak claims have no authority', { concurrency: false }, async () => {
  const { res, body } = await postSet({
    liftCode: 'BENFORGE',
    exerciseName: 'Bench Press',
    muscleGroup: 'Chest',
    todaySets: [{ weight: 225, reps: 6, rir: 2 }],
    rec: { progression_verdict: { level: 'new_ground', ceiling: 1 } },
    live_set_context: {
      coach_mode: 'deterministic_live_set',
      register: 'on_target_increase',
      progression_context: { comparable_on_target_streak: 99 },
    },
  });

  assert.equal(res.status, 200);
  assert.doesNotMatch(JSON.stringify(body.data), /New ground|prior 1|99|bump the load/i);
  assert.equal(body.data.flight_recorder_context.register, 'conservative_hold');
});

test('live set route: Flight Recorder context carries mode/register without raw private payloads', { concurrency: false }, async () => {
  const { res, body } = await postSet({
    liftCode: 'BENREC',
    exerciseName: 'Bench Press',
    muscleGroup: 'Chest',
    intentId: 'build_strength',
    todaySets: [{ weight: 225, reps: 6, rir: 2 }],
  });

  assert.equal(res.status, 200);
  const ctx = body.data.flight_recorder_context;
  assert.equal(ctx.coach_mode, 'deterministic_live_set');
  assert.equal(ctx.register, 'conservative_hold');
  assert.equal(ctx.progression_context.comparable_on_target_streak, null);
  const serialized = JSON.stringify(ctx);
  assert.doesNotMatch(serialized, /todaySets|rawFacts|logRows|private|payload/i);
});
