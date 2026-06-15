const test = require('node:test');
const assert = require('node:assert/strict');
const { resetIdempotencyStore } = require('../services/idempotency');

const originalConsoleLog = console.log;

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
// These smoke tests fire many requests against shared, IP-keyed rate limiters
// (the whole suite runs as one client within a single window). They exercise
// endpoint behaviour, not throttling — rate-limiter coverage lives in
// security.test.js with its own limiter instance — so lift the production caps
// out of the way. Must be set before require('../index'), which reads them at load.
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
// Not a real key. sheets.js is fully stubbed in these tests (see require.cache
// injection below), so this value is never parsed — it only needs to be present
// so config validation does not trip. Kept free of a literal PEM header so the
// changed-file secret scan (scripts/check-changed-files-for-secrets.js) does not
// flag this throwaway stub.
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';

const logRows = [
  ['2026-06-01', 'SESSION-OLD', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '205', '5', '3', 'old bench'],
  ['2026-06-10', 'SESSION-NEW', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '225', '5', '2', 'top set'],
  ['2026-06-10', 'SESSION-NEW', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '2', '215', '6', '2', 'backoff'],
  ['2026-06-10', 'SESSION-NEW', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '1', '315', '3', '2', '']
];

const exerciseCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench press|bench'],
  ['Back Squat', 'Legs', 'SQ01', 'Back Squat', 'squat|squats']
];

const fakeSheetsState = {
  appendCalls: [],
  // Set to true only inside tests that intentionally exercise the live-write branch.
  // Default false ensures dry-run tests trip the throw guard if appendRows fires unexpectedly.
  allowAppend: false,
  deleteCalls: [],
  // Per-tab getSheetRows call counts (read-path cache tests reset and inspect these).
  reads: {},
  // Duplicate-protection reads, tracked to prove they are never served from the cache.
  safetyReadCalls: { effortSessionIds: 0, logCompositeKeys: 0 },
  // Rows returned by the stubbed getRecentRows for the Effort tab, in sheet
  // order (oldest first). Tests that need effort history set this and restore [].
  effortRecentRows: [],
  // When set to a tab name, appendRows throws for that tab AFTER recording the
  // call — simulates a partial-write failure between the two live appends.
  failAppendForTab: null,
  // Rows returned by getSheetRows for Coaching_Notes. Tests may set this.
  coachingNotesRows: [],
  // Existing Effort session_ids returned by getEffortSessionIds. Tests set this
  // to exercise the duplicate-session guard; default empty (no duplicates).
  effortSessionIds: [],
  // Rows returned by getSheetRows for Constraints. Tests may set this.
  constraintsRows: []
};

function getLocalDateString(dateTime = new Date()) {
  const year = dateTime.getFullYear();
  const month = String(dateTime.getMonth() + 1).padStart(2, '0');
  const day = String(dateTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const fakeSheets = {
  appendRows: async (tabName, rows) => {
    fakeSheetsState.appendCalls.push({ tabName, rows });
    if (!fakeSheetsState.allowAppend) {
      throw new Error('appendRows should not be called by endpoint smoke tests');
    }
    if (fakeSheetsState.failAppendForTab === tabName) {
      throw new Error(`Simulated append failure for "${tabName}"`);
    }
    return { data: { updates: { updatedRange: `${tabName}!A100:K100`, updatedRows: rows.length } } };
  },
  deleteRowsByRange: async (tabName, startIndex, endIndex) => {
    fakeSheetsState.deleteCalls.push({ tabName, startIndex, endIndex });
  },
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => {
    fakeSheetsState.safetyReadCalls.effortSessionIds += 1;
    return [...fakeSheetsState.effortSessionIds];
  },
  getLogCompositeKeys: async () => {
    fakeSheetsState.safetyReadCalls.logCompositeKeys += 1;
    return [];
  },
  getRecentRows: async (tabName, maxRows = 100) => {
    if (tabName === 'Log_Cleaned') return logRows;
    // Mirror the real client: return the LAST maxRows in sheet order.
    if (tabName === 'Effort') return fakeSheetsState.effortRecentRows.slice(-maxRows);
    return [];
  },
  getSheetRows: async tabName => {
    fakeSheetsState.reads[tabName] = (fakeSheetsState.reads[tabName] || 0) + 1;
    if (tabName === 'Log_Cleaned') return logRows;
    if (tabName === 'Effort') return [];
    if (tabName === 'Coaching_Notes') return fakeSheetsState.coachingNotesRows || [];
    if (tabName === 'Constraints') return fakeSheetsState.constraintsRows || [];
    return [];
  },
  getSpreadsheetTabs: async () => ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary', 'Bodyweight', 'Coaching_Notes', 'Constraints'],
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort'
};

const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = {
  id: sheetsPath,
  filename: sheetsPath,
  loaded: true,
  exports: fakeSheets
};

let fakeVisionParsedMetrics = {
  date: null,
  duration: '00:42:00',
  activeCalories: 410,
  totalCalories: 520,
  averageHR: 148,
  peakHR: 171,
  workoutType: 'Traditional Strength Training'
};

let fakeVisionCalls = 0;

const fakeVision = {
  parseWorkoutScreenshot: async () => {
    fakeVisionCalls += 1;
    return { parsed_metrics: { ...fakeVisionParsedMetrics } };
  }
};

const visionPath = require.resolve('../services/vision');
require.cache[visionPath] = {
  id: visionPath,
  filename: visionPath,
  loaded: true,
  exports: fakeVision
};

// Coach (Gemini) stub — no real network call ever fires in tests. Tests flip
// `configured` / `message` / `throwError` to exercise each branch.
const fakeCoachState = {
  configured: false,
  message: 'Strong work.\n\n* 225 × 5 @2\n\nNext: 235 × 5.',
  planMessage: "You're carrying a lot of fatigue, so today is about blood flow, not load.",
  chatMessage: 'Your bench has been flat for a few sessions — try 5×5 at 225 this week.',
  chatEditProposal: null, // set to an edit object in tests that exercise the edit path
  chatNoteProposal: null, // set to a note object in tests that exercise the note path
  chatConstraintProposal: null, // set to a constraint object in tests that exercise the constraint path
  throwError: null
};
const fakeCoach = {
  isConfigured: () => fakeCoachState.configured,
  coachModel: () => 'gemini-2.5-flash-lite',
  generateCoachMessage: async () => {
    if (fakeCoachState.throwError) throw new Error(fakeCoachState.throwError);
    return fakeCoachState.message;
  },
  generatePlanMessage: async () => {
    if (fakeCoachState.throwError) throw new Error(fakeCoachState.throwError);
    return fakeCoachState.planMessage;
  },
  generateChatReply: async () => {
    if (fakeCoachState.throwError) throw new Error(fakeCoachState.throwError);
    return { reply: fakeCoachState.chatMessage, propose_edit: fakeCoachState.chatEditProposal, propose_note: fakeCoachState.chatNoteProposal, propose_constraint: fakeCoachState.chatConstraintProposal };
  },
  buildCoachSystemPrompt: () => 'stub-system',
  buildCoachUserPrompt: () => 'stub-user',
  sanitizeFacts: facts => facts
};
const coachPath = require.resolve('../services/coach');
require.cache[coachPath] = {
  id: coachPath,
  filename: coachPath,
  loaded: true,
  exports: fakeCoach
};

const { app } = require('../index');

let server;
let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  try {
    if (!server) return;
    await new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  } finally {
    console.log = originalConsoleLog;
  }
});

test.beforeEach(() => {
  resetIdempotencyStore();
});

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(path.startsWith('/api') ? { 'x-atlas-api-key': process.env.ATLAS_API_KEY } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  return { response, body };
}

async function requestMultipart(path, formData) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    body: formData,
    headers: path.startsWith('/api') ? { 'x-atlas-api-key': process.env.ATLAS_API_KEY } : {}
  });
  const body = await response.json();
  return { response, body };
}

async function withMutedConsoleLog(fn) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

test('api smoke: health returns service status', async () => {
  const { response, body } = await requestJson('/health');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.data.service, 'atlas-workout-updater');
});

test('api smoke: routes include key endpoints and write metadata', async () => {
  const { response, body } = await requestJson('/routes');
  const routes = body.data.routes;
  const paths = routes.map(route => route.path);
  const routeByPath = new Map(routes.map(route => [route.path, route]));

  assert.equal(response.status, 200);
  assert.ok(paths.includes('/api/exercises/last-session'));
  assert.ok(paths.includes('/api/parse-workout-text'));
  assert.ok(paths.includes('/api/progress/summary'));
  assert.ok(paths.includes('/api/log-workout'));
  assert.ok(paths.includes('/api/complete-workout'));
  assert.equal(routeByPath.get('/api/parse-workout-text').readOnly, true);
  assert.equal(routeByPath.get('/api/parse-workout-text').writeCapable, false);
  assert.equal(routeByPath.get('/api/progress/summary').readOnly, true);
  assert.equal(routeByPath.get('/api/progress/summary').writeCapable, false);
  assert.equal(routeByPath.get('/api/log-workout').readOnly, false);
  assert.equal(routeByPath.get('/api/log-workout').writeCapable, true);
  assert.equal(routeByPath.get('/api/complete-workout').readOnly, false);
  assert.equal(routeByPath.get('/api/complete-workout').writeCapable, true);
});

test('api smoke: coach/message + health/gemini are registered read-only', async () => {
  const { body } = await requestJson('/routes');
  const routeByPath = new Map(body.data.routes.map(route => [route.path, route]));
  assert.ok(routeByPath.has('/api/coach/message'), 'coach route must be in the manifest');
  assert.equal(routeByPath.get('/api/coach/message').writeCapable, false, 'coach endpoint must never be write-capable');
  assert.equal(routeByPath.get('/api/coach/message').readOnly, true);
  assert.ok(routeByPath.has('/api/health/gemini'));
});

test('api smoke: coach/message requires a facts object', async () => {
  const { response, body } = await requestJson('/api/coach/message', {
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.equal(response.status, 400);
  assert.equal(body.status, 'error');
});

test('api smoke: coach/message returns null message when Gemini is unconfigured (templated fallback)', async () => {
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/message', {
    method: 'POST',
    body: JSON.stringify({ facts: { exerciseName: 'Bench Press', todaySets: [{ weight: 225, reps: 5, rir: 2 }] } })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.configured, false);
  assert.equal(body.data.message, null, 'unconfigured must hand back null so the client uses its template');
});

test('api smoke: coach/message returns Gemini prose when configured', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  fakeCoachState.message = 'Strong work.\n\n* 225 × 5 @2\n\nNext: 235 × 5.';
  try {
    const { response, body } = await requestJson('/api/coach/message', {
      method: 'POST',
      body: JSON.stringify({ facts: { exerciseName: 'Bench Press', todaySets: [{ weight: 225, reps: 5, rir: 2 }] } })
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.configured, true);
    assert.equal(body.data.source, 'gemini');
    assert.equal(body.data.message, 'Strong work.\n\n* 225 × 5 @2\n\nNext: 235 × 5.');
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/message degrades to null when Gemini throws — never an error to the chat', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.throwError = 'Gemini request failed (503)';
  try {
    const { response, body } = await requestJson('/api/coach/message', {
      method: 'POST',
      body: JSON.stringify({ facts: { exerciseName: 'Bench Press', todaySets: [{ weight: 225, reps: 5, rir: 2 }] } })
    });
    assert.equal(response.status, 200, 'a model failure must not surface as an HTTP error');
    assert.equal(body.data.message, null);
    assert.match(body.data.error, /503/);
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.throwError = null;
  }
});

test('api smoke: coach/message never appends to a sheet', async () => {
  const before = fakeSheetsState.appendCalls.length;
  fakeCoachState.configured = true;
  try {
    await requestJson('/api/coach/message', {
      method: 'POST',
      body: JSON.stringify({ facts: { exerciseName: 'Bench Press', todaySets: [{ weight: 225, reps: 5, rir: 2 }] } })
    });
  } finally {
    fakeCoachState.configured = false;
  }
  assert.equal(fakeSheetsState.appendCalls.length, before, 'coach endpoint must not write any rows');
});

test('api smoke: health/gemini reflects configured state', async () => {
  fakeCoachState.configured = true;
  try {
    const { response, body } = await requestJson('/api/health/gemini');
    assert.equal(response.status, 200);
    assert.equal(body.data.configured, true);
    assert.equal(body.data.model, 'gemini-2.5-flash-lite');
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/message kind=plan returns the plan voice when configured', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  try {
    const { response, body } = await requestJson('/api/coach/message', {
      method: 'POST',
      body: JSON.stringify({ kind: 'plan', facts: { label: 'Recovery / Pump', why_today: ['high volume'] } })
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.configured, true);
    assert.equal(body.data.kind, 'plan');
    assert.equal(body.data.message, fakeCoachState.planMessage);
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/message kind=plan falls back to null when unconfigured', async () => {
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/message', {
    method: 'POST',
    body: JSON.stringify({ kind: 'plan', facts: { label: 'Push' } })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.configured, false);
  assert.equal(body.data.message, null);
});

test('api smoke: coach/chat is registered read-only and never write-capable', async () => {
  const { body } = await requestJson('/routes');
  const routeByPath = new Map(body.data.routes.map(route => [route.path, route]));
  assert.ok(routeByPath.has('/api/coach/chat'), 'coach chat route must be in the manifest');
  assert.equal(routeByPath.get('/api/coach/chat').writeCapable, false, 'chat endpoint must never be write-capable');
  assert.equal(routeByPath.get('/api/coach/chat').readOnly, true);
});

test('api smoke: coach/chat requires a non-empty message', async () => {
  const blank = await requestJson('/api/coach/chat', { method: 'POST', body: JSON.stringify({ message: '   ' }) });
  assert.equal(blank.response.status, 400);
  assert.equal(blank.body.status, 'error');
  const missing = await requestJson('/api/coach/chat', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missing.response.status, 400);
});

test('api smoke: coach/chat returns null when Gemini is unconfigured (client falls back)', async () => {
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'how is my bench trending?' })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.configured, false);
  assert.equal(body.data.message, null, 'unconfigured hands back null so the client uses its fallback');
});

test('api smoke: coach/chat returns Gemini prose when configured', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'how is my bench trending?', history: [{ role: 'user', text: 'hi' }] })
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.configured, true);
    assert.equal(body.data.source, 'gemini');
    assert.equal(body.data.message, fakeCoachState.chatMessage);
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/chat degrades to null when the coach throws — never an error bubble', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.throwError = 'gemini exploded';
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'what should I do today?' })
    });
    assert.equal(response.status, 200, 'a coach failure must not surface as an HTTP error');
    assert.equal(body.data.message, null);
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.throwError = null;
  }
});

test('api smoke: coach/chat never appends to a sheet', async () => {
  const before = fakeSheetsState.appendCalls.length;
  fakeCoachState.configured = true;
  try {
    await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'should I deload?' })
    });
  } finally {
    fakeCoachState.configured = false;
  }
  assert.equal(fakeSheetsState.appendCalls.length, before, 'chat endpoint must not write any rows');
});

test('api smoke: coach/chat passes propose_edit through to the client', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.chatEditProposal = { action: 'update_set', index: 0, weight: 235, reps: 5 };
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'change set 1 to 235×5' })
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.message, fakeCoachState.chatMessage, 'prose reply unchanged');
    assert.deepEqual(body.data.propose_edit, { action: 'update_set', index: 0, weight: 235, reps: 5 });
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.chatEditProposal = null;
  }
});

test('api smoke: coach/chat returns null propose_edit when none proposed', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.chatEditProposal = null;
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'how is my bench trending?' })
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.propose_edit, null);
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: last-session reaches literal handler', async () => {
  const { response, body } = await requestJson('/api/exercises/last-session?exercise=Bench%20Press');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.message, 'Last session sets');
  assert.equal(body.data.exercise, 'Bench Press');
  assert.equal(body.data.session_id, 'SESSION-NEW');
  assert.equal(body.data.date, '2026-06-10');
  assert.deepEqual(body.data.sets.map(set => [set.set_number, set.weight, set.reps, set.rir]), [
    ['1', '225', '5', '2'],
    ['2', '215', '6', '2']
  ]);
});

test('api smoke: session summary returns the per-set detail History expands', async () => {
  const { response, body } = await requestJson('/api/session/SESSION-NEW/summary');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.data.sets), 'summary must carry a sets array');
  assert.equal(body.data.sets.length, 3, 'SESSION-NEW has three logged sets');
  const first = body.data.sets[0];
  assert.equal(Number(first.weight), 225);
  assert.equal(Number(first.reps), 5);
  assert.equal(first.exercise || first.canonical_exercise, 'Bench Press');
});

test('api smoke: parse-workout-text dry-run proves no write', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/parse-workout-text', {
    method: 'POST',
    body: JSON.stringify({
      text: 'Bench 225 5/2',
      test_mode: true
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.parsed.intent, 'log_sets');
  assert.deepEqual(body.data.parsed.sets.map(set => [set.weight, set.reps, set.rir]), [[225, 5, 2]]);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: parse-workout-image is parse-only — auto_write=true performs no write', async () => {
  fakeSheetsState.appendCalls.length = 0;
  // allowAppend stays false: if the removed auto_write branch ever wrote, the
  // append stub would throw and this test would fail loudly.
  const form = new FormData();
  form.append('image', new Blob(['watch'], { type: 'image/png' }), 'watch.png');
  form.append('auto_write', 'true');

  const { response, body } = await requestMultipart('/api/parse-workout-image', form);

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'ok');
  assert.equal(body.data.sheet_write, 'skipped', 'parse-workout-image must never write');
  assert.ok(body.data.parsed, 'still returns parsed effort metrics');
  assert.ok(Array.isArray(body.data.effort_row), 'still returns a preview effort_row');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: parse-workout-text clarification does not create rows', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/parse-workout-text', {
    method: 'POST',
    body: JSON.stringify({
      text: 'Press 135 8/2',
      test_mode: true
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.parsed.intent, 'needs_clarification');
  assert.match(body.data.parsed.message, /Which press/i);
  assert.equal(body.data.parsed.sets, undefined);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: parse-workout-text refuses excessive Dale repeat', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/parse-workout-text', {
    method: 'POST',
    body: JSON.stringify({
      text: 'Lats 170 8/2 x99',
      test_mode: true
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.parsed.intent, 'needs_clarification');
  assert.ok((body.data.parsed.sets?.length || 0) <= 10);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: log-workout test_mode returns dry-run proof without append', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-DRY-RUN',
      date: '2026-06-11',
      test_mode: true,
      log_rows: [
        {
          exercise: 'Bench Press',
          set_number: 1,
          weight: 225,
          reps: 5,
          rir: 2,
          notes: 'endpoint smoke dry-run'
        }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_write, 'skipped');
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.log_rows_preview[0][3], 'Bench Press');
  assert.equal(body.data.log_rows_preview[0][5], 'BEN01');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: complete-workout allows effort-only screenshot preview with empty log rows', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeVisionParsedMetrics = {
    date: null,
    duration: '00:42:00',
    activeCalories: 410,
    totalCalories: 520,
    averageHR: 148,
    peakHR: 171,
    workoutType: 'Traditional Strength Training'
  };
  const form = new FormData();
  form.append('session_id', 'EFFORT-SHOT-ONLY-01');
  form.append('date', '2026-06-11');
  form.append('log_rows_json', JSON.stringify([]));
  form.append('test_mode', 'true');
  form.append('image', new Blob(['watch'], { type: 'image/png' }), 'watch.png');

  const { response, body } = await requestMultipart('/api/complete-workout', form);
  const data = body.data.data;

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'ok');
  assert.equal(data.test_mode, true);
  assert.equal(data.no_write_confirmed, true);
  assert.equal(data.sheet_written, false);
  assert.equal(data.effort_only, true);
  assert.equal(data.effort_source, 'screenshot');
  assert.deepEqual(data.log_rows_preview, []);
  assert.deepEqual(data.rows_to_write, []);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: complete-workout screenshot preview uses parsed screenshot date when form date is omitted', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeVisionParsedMetrics = {
    date: '2026-06-09',
    duration: '00:42:00',
    activeCalories: 410,
    totalCalories: 520,
    averageHR: 148,
    peakHR: 171,
    workoutType: 'Traditional Strength Training'
  };
  const form = new FormData();
  form.append('log_rows_json', JSON.stringify([]));
  form.append('test_mode', 'true');
  form.append('image', new Blob(['watch'], { type: 'image/png' }), 'watch.png');

  const { response, body } = await requestMultipart('/api/complete-workout', form);
  const data = body.data.data;

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(data.date, '2026-06-09');
  assert.equal(data.effort_row[0], '2026-06-09');
  assert.match(data.session_id, /^20260609-(AM|PM)-01$/);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: complete-workout screenshot preview falls back to local today when no date is provided anywhere', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeVisionParsedMetrics = {
    date: null,
    duration: '00:42:00',
    activeCalories: 410,
    totalCalories: 520,
    averageHR: 148,
    peakHR: 171,
    workoutType: 'Traditional Strength Training'
  };
  const form = new FormData();
  form.append('log_rows_json', JSON.stringify([]));
  form.append('test_mode', 'true');
  form.append('image', new Blob(['watch'], { type: 'image/png' }), 'watch.png');

  const { response, body } = await requestMultipart('/api/complete-workout', form);
  const data = body.data.data;
  const today = getLocalDateString();

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(data.date, today);
  assert.equal(data.effort_row[0], today);
  assert.match(data.session_id, new RegExp(`^${today.replace(/-/g, '')}-(AM|PM)-01$`));
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: complete-workout manual date overrides parsed screenshot date', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeVisionParsedMetrics = {
    date: '2026-06-09',
    duration: '00:42:00',
    activeCalories: 410,
    totalCalories: 520,
    averageHR: 148,
    peakHR: 171,
    workoutType: 'Traditional Strength Training'
  };
  const form = new FormData();
  form.append('date', '2026-06-11');
  form.append('log_rows_json', JSON.stringify([]));
  form.append('test_mode', 'true');
  form.append('image', new Blob(['watch'], { type: 'image/png' }), 'watch.png');

  const { response, body } = await requestMultipart('/api/complete-workout', form);
  const data = body.data.data;

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(data.date, '2026-06-11');
  assert.equal(data.effort_row[0], '2026-06-11');
  assert.match(data.session_id, /^20260611-(AM|PM)-01$/);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: complete-workout effort-only live write appends only Effort rows', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;

  try {
    await withMutedConsoleLog(async () => {
      const form = new FormData();
      form.append('session_id', 'EFFORT-MANUAL-ONLY-01');
      form.append('date', '2026-06-11');
      form.append('log_rows_json', JSON.stringify([]));
      form.append('write_id', 'complete-effort-only-live-01');
      form.append('effort_json', JSON.stringify({
        duration: '42',
        activeCalories: 410,
        totalCalories: 520,
        averageHR: 148,
        peakHR: 171,
        workoutType: 'Traditional Strength Training'
      }));

      const { response, body } = await requestMultipart('/api/complete-workout', form);
      const data = body.data.data;

      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.status, 'ok');
      assert.equal(data.effort_only, true);
      assert.equal(data.sheet_written, true);
      assert.equal(data.sheet_write, 'success');
      assert.equal(data.effort_written, true);
      assert.equal(data.log_rows_written, 0);
      assert.equal(fakeSheetsState.appendCalls.length, 1);
      assert.equal(fakeSheetsState.appendCalls[0].tabName, 'Effort');
      assert.equal(fakeSheetsState.appendCalls[0].rows.length, 1);
    });
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: live complete-workout with write_id appends once and skips duplicate retry', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;

  const buildForm = () => {
    const form = new FormData();
    form.append('session_id', 'COMPLETE-IDEMPOTENT-01');
    form.append('date', '2026-06-11');
    form.append('log_rows_json', JSON.stringify([]));
    form.append('write_id', 'complete-write-idem-01');
    form.append('effort_json', JSON.stringify({
      duration: '42', activeCalories: 410, totalCalories: 520,
      averageHR: 148, peakHR: 171, workoutType: 'Traditional Strength Training'
    }));
    return form;
  };

  try {
    await withMutedConsoleLog(async () => {
      const first = await requestMultipart('/api/complete-workout', buildForm());
      const firstData = first.body.data.data;
      assert.equal(first.response.status, 200, JSON.stringify(first.body));
      assert.equal(firstData.sheet_written, true);
      assert.equal(firstData.sheet_write, 'success');
      assert.equal(firstData.effort_written, true);
      assert.equal(firstData.duplicate_write, false);
      assert.equal(firstData.write_id, 'complete-write-idem-01');
      assert.equal(firstData.idempotency_status, 'completed');
      assert.equal(fakeSheetsState.appendCalls.length, 1);

      const duplicate = await requestMultipart('/api/complete-workout', buildForm());
      const dupData = duplicate.body.data.data;
      assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.body));
      assert.equal(dupData.duplicate_write, true);
      assert.equal(dupData.write_id, 'complete-write-idem-01');
      assert.equal(dupData.sheet_write, 'skipped_duplicate');
      assert.equal(dupData.sheet_written, false);
      assert.equal(dupData.original_sheet_written, true);
      // Crucially, no second append fired.
      assert.equal(fakeSheetsState.appendCalls.length, 1);
    });
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

// Partial-write guard parity with /api/log-workout: on a full session (log rows
// + effort) where the log append commits but the effort append throws, the
// write_id must be recorded as a partial completion — NOT released — so a retry
// replays the partial state instead of re-appending the log rows a second time.
test('api smoke: complete-workout effort failure after log append is partial, retry never re-appends', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.failAppendForTab = 'Effort';

  const buildForm = () => {
    const form = new FormData();
    form.append('session_id', 'COMPLETE-PARTIAL-01');
    form.append('date', '2026-06-12');
    form.append('write_id', 'complete-partial-retry-01');
    form.append('log_rows_json', JSON.stringify([
      { exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 5, notes: '' }
    ]));
    form.append('effort_json', JSON.stringify({
      duration: '42', activeCalories: 410, totalCalories: 520, averageHR: 148, peakHR: 171
    }));
    return form;
  };

  try {
    await withMutedConsoleLog(async () => {
      const first = await requestMultipart('/api/complete-workout', buildForm());
      // Log rows landed; effort append failed → honest partial 500, not a clean failure.
      assert.equal(first.response.status, 500, JSON.stringify(first.body));
      assert.equal(first.body.status, 'error');
      assert.equal(first.body.details.sheet_write, 'partial');
      assert.equal(first.body.details.sheet_written, true);
      assert.equal(first.body.details.log_rows_written, 1);
      assert.equal(first.body.details.effort_written, false);
      assert.equal(first.body.details.write_id, 'complete-partial-retry-01');
      // One log append + one failed effort attempt (the stub records before throwing).
      assert.equal(fakeSheetsState.appendCalls.length, 2);

      // Outage clears; the client retries the SAME write_id. The log rows must
      // not be appended a second time — the recorded partial result replays.
      fakeSheetsState.failAppendForTab = null;
      const retry = await requestMultipart('/api/complete-workout', buildForm());
      const dupData = retry.body.data.data;
      assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
      assert.equal(dupData.duplicate_write, true);
      assert.equal(dupData.sheet_write, 'skipped_duplicate');
      assert.equal(dupData.original_sheet_written, true);
      assert.equal(fakeSheetsState.appendCalls.length, 2, 'retry must not append again');
    });
  } finally {
    fakeSheetsState.allowAppend = false;
    fakeSheetsState.failAppendForTab = null;
  }
});

// PR-02: a screenshot approval re-sends the reviewed effort as effort_json with
// NO image, so what gets written is exactly what the owner saw — and the vision
// model is never run a second time. These tests pin that backend contract.
test('api smoke: complete-workout approval payload (effort_json, no image) writes the reviewed effort values and never calls vision', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeVisionCalls = 0;
  fakeSheetsState.allowAppend = true;

  try {
    await withMutedConsoleLog(async () => {
      const form = new FormData();
      form.append('session_id', 'APPROVE-PREVIEWED-01');
      form.append('date', '2026-06-11');
      form.append('write_id', 'approve-previewed-live-01');
      form.append('log_rows_json', JSON.stringify([
        { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2, notes: '' }
      ]));
      form.append('effort_json', JSON.stringify({
        duration: '00:42:00',
        activeCalories: 410,
        totalCalories: 520,
        averageHR: 148,
        peakHR: 171,
        workoutType: 'Traditional Strength Training'
      }));

      const { response, body } = await requestMultipart('/api/complete-workout', form);
      const data = body.data.data;

      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(data.effort_source, 'manual');
      assert.equal(data.sheet_written, true);
      assert.equal(data.log_rows_written, 1);

      // No image attached → the vision model must not run.
      assert.equal(fakeVisionCalls, 0);

      const effortAppend = fakeSheetsState.appendCalls.find(c => c.tabName === 'Effort');
      assert.ok(effortAppend, 'expected an Effort append');
      // Effort row: [date, session, duration, activeCal, totalCal, avgHR, peakHR, location, notes]
      const effortRow = effortAppend.rows[0];
      assert.equal(effortRow[1], 'APPROVE-PREVIEWED-01');
      assert.equal(effortRow[3], 410);
      assert.equal(effortRow[4], 520);
      assert.equal(effortRow[5], 148);
      assert.equal(effortRow[6], 171);
    });
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: complete-workout dry-run with write_id does not consume idempotency state', async () => {
  fakeSheetsState.appendCalls.length = 0;

  const effortJson = JSON.stringify({
    duration: '42', activeCalories: 410, totalCalories: 520,
    averageHR: 148, peakHR: 171, workoutType: 'Traditional Strength Training'
  });

  await withMutedConsoleLog(async () => {
    const previewForm = new FormData();
    previewForm.append('session_id', 'COMPLETE-IDEMPOTENT-02');
    previewForm.append('date', '2026-06-11');
    previewForm.append('log_rows_json', JSON.stringify([]));
    previewForm.append('write_id', 'complete-write-idem-02');
    previewForm.append('test_mode', 'true');
    previewForm.append('effort_json', effortJson);

    const preview = await requestMultipart('/api/complete-workout', previewForm);
    assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.data.data.test_mode, true);
    assert.equal(preview.body.data.data.sheet_written, false);
    assert.equal(preview.body.data.data.no_write_confirmed, true);
    assert.equal(fakeSheetsState.appendCalls.length, 0);
  });

  fakeSheetsState.allowAppend = true;
  try {
    await withMutedConsoleLog(async () => {
      // Same write_id is still spendable after a dry run — preview never consumed it.
      const liveForm = new FormData();
      liveForm.append('session_id', 'COMPLETE-IDEMPOTENT-02');
      liveForm.append('date', '2026-06-11');
      liveForm.append('log_rows_json', JSON.stringify([]));
      liveForm.append('write_id', 'complete-write-idem-02');
      liveForm.append('effort_json', effortJson);

      const live = await requestMultipart('/api/complete-workout', liveForm);
      assert.equal(live.response.status, 200, JSON.stringify(live.body));
      assert.equal(live.body.data.data.sheet_written, true);
      assert.equal(live.body.data.data.duplicate_write, false);
      assert.equal(fakeSheetsState.appendCalls.length, 1);
    });
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: complete-workout approval payload preserves a missing peak HR as an empty cell with a warning', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeVisionCalls = 0;
  fakeSheetsState.allowAppend = true;

  try {
    await withMutedConsoleLog(async () => {
      const form = new FormData();
      form.append('session_id', 'APPROVE-NO-PEAK-01');
      form.append('date', '2026-06-11');
      form.append('write_id', 'approve-no-peak-live-01');
      form.append('log_rows_json', JSON.stringify([]));
      form.append('effort_json', JSON.stringify({
        duration: '00:42:00',
        activeCalories: 410,
        totalCalories: 520,
        averageHR: 148,
        peakHR: '',
        workoutType: 'Traditional Strength Training'
      }));

      const { response, body } = await requestMultipart('/api/complete-workout', form);
      const data = body.data.data;

      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(data.effort_written, true);
      assert.equal(fakeVisionCalls, 0);
      // warnings sit on the response envelope (body.data), a sibling of body.data.data
      const warnings = body.data.warnings || [];
      assert.ok(
        warnings.some(w => /peakHR missing/i.test(w)),
        `expected a missing-peak warning, got ${JSON.stringify(warnings)}`
      );

      const effortAppend = fakeSheetsState.appendCalls.find(c => c.tabName === 'Effort');
      assert.ok(effortAppend, 'expected an Effort append');
      assert.equal(effortAppend.rows[0][6], '');
    });
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: complete-workout still blocks blank workout text when no effort data exists', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const form = new FormData();
  form.append('session_id', 'EFFORT-MISSING-01');
  form.append('date', '2026-06-11');
  form.append('log_rows_json', JSON.stringify([]));
  form.append('test_mode', 'true');

  const { response, body } = await requestMultipart('/api/complete-workout', form);

  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.status, 'error');
  assert.match(body.message, /image file or manual effort metrics are required/i);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: complete-workout still previews workout rows alongside screenshot effort', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeVisionParsedMetrics = {
    date: null,
    duration: '00:42:00',
    activeCalories: 410,
    totalCalories: 520,
    averageHR: 148,
    peakHR: 171,
    workoutType: 'Traditional Strength Training'
  };
  const form = new FormData();
  form.append('session_id', 'EFFORT-WITH-WORKOUT-01');
  form.append('date', '2026-06-11');
  form.append('log_rows_json', JSON.stringify([
    {
      exercise: 'Bench Press',
      set_number: 1,
      weight: 225,
      reps: 5,
      rir: 2,
      notes: ''
    }
  ]));
  form.append('test_mode', 'true');
  form.append('image', new Blob(['watch'], { type: 'image/png' }), 'watch.png');

  const { response, body } = await requestMultipart('/api/complete-workout', form);
  const data = body.data.data;

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(data.effort_only, false);
  assert.equal(data.effort_source, 'screenshot');
  assert.equal(data.no_write_confirmed, true);
  assert.equal(data.rows_to_write.length, 1);
  assert.equal(data.rows_to_write[0][3], 'Bench Press');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: log-workout invalid payload errors without append', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-INVALID',
      test_mode: true,
      log_rows: [
        {
          exercise: 'Bench Press',
          set_number: 1,
          weight: 225,
          reps: 5,
          rir: 2
        }
      ]
    })
  });

  assert.equal(response.status, 400);
  assert.equal(body.status, 'error');
  assert.match(body.message, /date is required/i);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: recommend-next returns stable read shape', async () => {
  const { response, body } = await requestJson('/api/recommend/next/BEN01');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.data.liftCode, 'BEN01');
  assert.ok(body.data.recommendation);
  assert.ok(body.data.rule_decision);
});

test('api smoke: plan-today returns stable read shape', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/plan/today');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.ok(Array.isArray(body.data.recommendations));
  assert.ok(body.data.recommendations.some(item => item.liftCode === 'BEN01'));
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: progress-summary returns stable read shape', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/progress/summary');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.data.total_sessions, 'number');
  assert.equal(typeof body.data.average_sessions_per_week, 'number');
  assert.equal(typeof body.data.total_sets, 'number');
  assert.equal(typeof body.data.total_volume, 'number');
  assert.ok(Array.isArray(body.data.sessions_by_week));
  assert.ok(Array.isArray(body.data.volume_by_week));
  assert.ok(Array.isArray(body.data.top_exercises));
  assert.ok(Array.isArray(body.data.recent_prs));
  assert.ok(Array.isArray(body.data.watchouts));
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: sessions-recent returns stable read shape through read layer', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/sessions/recent?limit=5');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.ok(Array.isArray(body.data.sessions));
  assert.ok(body.data.sessions.length > 0);
  assert.equal(body.data.sessions[0].session_id, 'SESSION-NEW');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: weekly-report returns stable read shape through read layer', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/report/weekly?days=7');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.data.period_start, 'string');
  assert.equal(typeof body.data.period_end, 'string');
  assert.equal(typeof body.data.sessions_count, 'number');
  assert.equal(typeof body.data.total_sets, 'number');
  assert.ok(Array.isArray(body.data.top_exercises));
  assert.ok(Array.isArray(body.data.stalls_or_watchouts));
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: exercise-detail returns stable read shape through read layer', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/exercises/BEN01/detail');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.data.lift_code, 'BEN01');
  assert.ok(Array.isArray(body.data.last_sessions));
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

// Missing test_mode currently means live-write branch.
// This test pins the current behavior: absent test_mode = real append to Log_Cleaned.
// A future PR may add an explicit confirm_write gate, but this task does not change that contract.
test('api smoke: live log-workout without test_mode appends one row to Log_Cleaned', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;

  try {
    const { response, body } = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'LIVE-WRITE-SMOKE-01',
        date: '2026-06-11',
        write_id: 'live-write-smoke-01',
        // test_mode intentionally omitted — this exercises the live-write branch
        log_rows: [
          {
            exercise: 'Bench Press',
            set_number: 1,
            weight: 135,
            reps: 10,
            rir: 5,
            notes: ''
          }
        ]
      })
    });

    // Response must indicate success with confirmed write
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.data.sheet_write, 'success');
    assert.ok(body.data.log_rows_written > 0, `log_rows_written must be > 0, got ${body.data.log_rows_written}`);

    // Exactly one appendRows call — no effort row, so only the log append fires
    assert.equal(fakeSheetsState.appendCalls.length, 1);

    const call = fakeSheetsState.appendCalls[0];

    // Must target the log tab, not Effort
    assert.equal(call.tabName, 'Log_Cleaned');

    // Exactly one row appended
    assert.equal(call.rows.length, 1);

    const row = call.rows[0];

    // 12-column contract (logCleanedColumns order):
    // [0] date_clean  [1] session_id  [2] exercise  [3] canonical_exercise
    // [4] muscle_group  [5] lift_code  [6] set_number  [7] weight
    // [8] reps  [9] rir  [10] notes  [11] volume_calc
    assert.equal(row.length, 12);
    assert.equal(row[0], '2026-06-11');           // date
    assert.equal(row[1], 'LIVE-WRITE-SMOKE-01');  // session_id
    assert.equal(row[3], 'Bench Press');           // canonical_exercise
    assert.equal(row[4], 'Chest');                 // muscle_group
    assert.equal(row[5], 'BEN01');                 // lift_code
    assert.equal(Number(row[6]), 1);               // set_number
    assert.equal(Number(row[7]), 135);             // weight — Bench 135 10/5
    assert.equal(Number(row[8]), 10);              // reps  — Bench 135 10/5
    assert.equal(Number(row[9]), 5);               // rir   — Bench 135 10/5
    assert.equal(Number(row[11]), 1350);           // volume_calc = 135 * 10
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

// ── undo-last tests ─────────────────────────────────────────────────────────
// log-workout idempotency tests
test('api smoke: live log-workout with write_id appends once and skips duplicate retry', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;

  const payload = {
    session_id: 'LIVE-WRITE-IDEMPOTENT-01',
    date: '2026-06-11',
    write_id: 'write-live-idempotent-01',
    log_rows: [
      {
        exercise: 'Bench Press',
        set_number: 1,
        weight: 135,
        reps: 10,
        rir: 5,
        notes: ''
      }
    ]
  };

  try {
    const first = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.status, 'ok');
    assert.equal(first.body.data.sheet_write, 'success');
    assert.equal(first.body.data.write_id, 'write-live-idempotent-01');
    assert.equal(first.body.data.duplicate_write, false);
    assert.equal(first.body.data.idempotency_status, 'completed');
    assert.equal(fakeSheetsState.appendCalls.length, 1);

    const duplicate = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.status, 'ok');
    assert.equal(duplicate.body.data.duplicate_write, true);
    assert.equal(duplicate.body.data.write_id, 'write-live-idempotent-01');
    assert.equal(duplicate.body.data.sheet_write, 'skipped_duplicate');
    assert.equal(duplicate.body.data.sheet_written, false);
    assert.equal(duplicate.body.data.original_sheet_write, 'success');
    assert.equal(duplicate.body.data.logAppendedRange, first.body.data.logAppendedRange);
    assert.equal(fakeSheetsState.appendCalls.length, 1);
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: dry-run with write_id does not consume idempotency state', async () => {
  fakeSheetsState.appendCalls.length = 0;

  const payload = {
    session_id: 'DRY-RUN-IDEMPOTENT-01',
    date: '2026-06-11',
    write_id: 'write-dry-run-idempotent-01',
    test_mode: true,
    log_rows: [
      {
        exercise: 'Bench Press',
        set_number: 1,
        weight: 135,
        reps: 10,
        rir: 5,
        notes: ''
      }
    ]
  };

  const preview = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.data.test_mode, true);
  assert.equal(preview.body.data.sheet_written, false);
  assert.equal(preview.body.data.no_write_confirmed, true);
  assert.deepEqual(fakeSheetsState.appendCalls, []);

  fakeSheetsState.allowAppend = true;
  try {
    const livePayload = { ...payload };
    delete livePayload.test_mode;

    const live = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify(livePayload)
    });

    assert.equal(live.response.status, 200, JSON.stringify(live.body));
    assert.equal(live.body.data.sheet_write, 'success');
    assert.equal(live.body.data.duplicate_write, false);
    assert.equal(fakeSheetsState.appendCalls.length, 1);
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: different write_id values write normally', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;

  const basePayload = {
    session_id: 'LIVE-WRITE-IDEMPOTENT-02',
    date: '2026-06-11',
    log_rows: [
      {
        exercise: 'Bench Press',
        set_number: 1,
        weight: 135,
        reps: 10,
        rir: 5,
        notes: ''
      }
    ]
  };

  try {
    const first = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({ ...basePayload, write_id: 'write-live-idempotent-02a' })
    });
    const second = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({ ...basePayload, write_id: 'write-live-idempotent-02b' })
    });

    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(second.response.status, 200, JSON.stringify(second.body));
    assert.equal(first.body.data.duplicate_write, false);
    assert.equal(second.body.data.duplicate_write, false);
    assert.equal(fakeSheetsState.appendCalls.length, 2);
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

// undo-last tests
// All undo tests use the fake Sheets layer; no real Google Sheets access occurs.
// logRows fixture (sheet-row mapping, header is row 1):
//   sheet row 2 → logRows[0]: SESSION-OLD, Bench Press
//   sheet row 3 → logRows[1]: SESSION-NEW, Bench Press (top set)
//   sheet row 4 → logRows[2]: SESSION-NEW, Bench Press (backoff)
//   sheet row 5 → logRows[3]: SESSION-NEW, Back Squat

test('api smoke: undo-last rejects missing log_appended_range with 400', async () => {
  fakeSheetsState.deleteCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'SESSION-NEW',
      rows_to_delete: 1,
      confirm_delete: true
    })
  });

  assert.equal(response.status, 400);
  assert.equal(body.status, 'error');
  assert.deepEqual(fakeSheetsState.deleteCalls, []);
});

test('api smoke: undo-last rejects wrong tab with 400', async () => {
  fakeSheetsState.deleteCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      log_appended_range: 'Effort!A1:L1',
      session_id: 'SESSION-NEW',
      rows_to_delete: 1,
      confirm_delete: true
    })
  });

  assert.equal(response.status, 400);
  assert.equal(body.status, 'error');
  assert.match(body.message, /Log_Cleaned/);
  assert.deepEqual(fakeSheetsState.deleteCalls, []);
});

test('api smoke: undo-last rejects rows_to_delete mismatch with 400', async () => {
  fakeSheetsState.deleteCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      log_appended_range: 'Log_Cleaned!A847:L847', // span = 1
      session_id: 'SESSION-NEW',
      rows_to_delete: 2,                           // mismatch
      confirm_delete: true
    })
  });

  assert.equal(response.status, 400);
  assert.equal(body.status, 'error');
  assert.match(body.message, /rows_to_delete/);
  assert.deepEqual(fakeSheetsState.deleteCalls, []);
});

test('api smoke: undo-last returns 409 and does not delete on session_id mismatch', async () => {
  fakeSheetsState.deleteCalls.length = 0;
  // Sheet row 2 → logRows[0] → SESSION-OLD; we claim SESSION-NEW → mismatch
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      log_appended_range: 'Log_Cleaned!A2:L2',
      session_id: 'SESSION-NEW',
      rows_to_delete: 1,
      confirm_delete: true
    })
  });

  assert.equal(response.status, 409);
  assert.equal(body.status, 'error');
  assert.match(body.message, /session_id mismatch/i);
  assert.deepEqual(fakeSheetsState.deleteCalls, []);
});

test('api smoke: undo-last returns 409 and does not delete when target row is missing', async () => {
  fakeSheetsState.deleteCalls.length = 0;
  // Sheet row 6 is beyond logRows (which only covers rows 2–5), so allRows[4] is undefined
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      log_appended_range: 'Log_Cleaned!A6:L6',
      session_id: 'SESSION-NEW',
      rows_to_delete: 1,
      confirm_delete: true
    })
  });

  assert.equal(response.status, 409);
  assert.equal(body.status, 'error');
  assert.match(body.message, /missing or empty/i);
  assert.deepEqual(fakeSheetsState.deleteCalls, []);
});

test('api smoke: undo-last happy path deletes one Log_Cleaned row and returns rows_deleted: 1', async () => {
  fakeSheetsState.deleteCalls.length = 0;
  // Sheet row 3 → logRows[1] → SESSION-NEW; ownership verified → delete proceeds
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      log_appended_range: 'Log_Cleaned!A3:L3',
      session_id: 'SESSION-NEW',
      rows_to_delete: 1,
      confirm_delete: true
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.data.rows_deleted, 1);
  assert.equal(body.data.deleted_range, 'Log_Cleaned!A3:L3');

  // Exactly one deleteRowsByRange call with correct 0-based indices
  // sheet row 3 → startIndex=2 (inclusive), endIndex=3 (exclusive)
  assert.equal(fakeSheetsState.deleteCalls.length, 1);
  const call = fakeSheetsState.deleteCalls[0];
  assert.equal(call.tabName, 'Log_Cleaned');
  assert.equal(call.startIndex, 2);
  assert.equal(call.endIndex, 3);
});

test('api smoke: undo-last with write_id deletes once and skips duplicate retry', async () => {
  fakeSheetsState.deleteCalls.length = 0;

  const payload = {
    log_appended_range: 'Log_Cleaned!A3:L3',
    session_id: 'SESSION-NEW',
    rows_to_delete: 1,
    confirm_delete: true,
    write_id: 'undo-write-idem-01'
  };

  const first = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.sheet_write, 'success');
  assert.equal(first.body.data.sheet_written, true);
  assert.equal(first.body.data.duplicate_write, false);
  assert.equal(fakeSheetsState.deleteCalls.length, 1);

  const duplicate = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.data.duplicate_write, true);
  assert.equal(duplicate.body.data.sheet_write, 'skipped_duplicate');
  assert.equal(duplicate.body.data.sheet_written, false);
  assert.equal(duplicate.body.data.rows_deleted, 0);
  assert.equal(duplicate.body.data.original_rows_deleted, 1);
  assert.equal(fakeSheetsState.deleteCalls.length, 1);
});

test('api smoke: bodyweight dry-run returns no-write proof', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/bodyweight', {
    method: 'POST',
    body: JSON.stringify({
      date: '2026-06-12',
      weight: 183.4,
      notes: 'morning',
      test_mode: true,
      write_id: 'bodyweight-dry-run-01'
    })
  });

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_write, 'skipped');
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(fakeSheetsState.appendCalls.length, 0);
});

test('api smoke: bodyweight live write with write_id appends once and skips duplicate retry', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  const payload = {
    date: '2026-06-12',
    weight: 183.4,
    notes: 'morning',
    write_id: 'bodyweight-write-idem-01'
  };

  try {
    const first = await requestJson('/api/bodyweight', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.sheet_write, 'success');
    assert.equal(first.body.data.sheet_written, true);
    assert.equal(first.body.data.duplicate_write, false);
    assert.equal(fakeSheetsState.appendCalls.length, 1);

    const duplicate = await requestJson('/api/bodyweight', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.data.duplicate_write, true);
    assert.equal(duplicate.body.data.sheet_write, 'skipped_duplicate');
    assert.equal(duplicate.body.data.sheet_written, false);
    assert.equal(duplicate.body.data.original_sheet_write, 'success');
    assert.equal(fakeSheetsState.appendCalls.length, 1);
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

// ── Step 1A (HI-1): a live write with no write_id has no dedup, so a lost-response
// retry would double-append. Every live write path must reject a missing write_id.
test('api smoke: live log-workout without write_id is rejected with 400 and never appends', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  try {
    const { response, body } = await withMutedConsoleLog(() => requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'NO-WRITE-ID-01',
        date: '2026-06-12',
        // test_mode omitted → live write, but write_id is missing.
        log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 5, notes: '' }]
      })
    }));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(body.status, 'error');
    assert.match(body.message, /write_id is required/i);
    assert.deepEqual(fakeSheetsState.appendCalls, [], 'a rejected write must not append');
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: live complete-workout without write_id is rejected with 400 and never appends', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  try {
    await withMutedConsoleLog(async () => {
      const form = new FormData();
      form.append('session_id', 'NO-WRITE-ID-COMPLETE-01');
      form.append('date', '2026-06-12');
      form.append('log_rows_json', JSON.stringify([]));
      // write_id intentionally omitted on a live (non-test_mode) write.
      form.append('effort_json', JSON.stringify({
        duration: '42', activeCalories: 410, totalCalories: 520, averageHR: 148, peakHR: 171
      }));
      const { response, body } = await requestMultipart('/api/complete-workout', form);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(body.status, 'error');
      assert.match(body.message, /write_id is required/i);
      assert.deepEqual(fakeSheetsState.appendCalls, [], 'a rejected write must not append');
    });
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: live bodyweight without write_id is rejected with 400 and never appends', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  try {
    const { response, body } = await withMutedConsoleLog(() => requestJson('/api/bodyweight', {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-12', weight: 183.4, notes: 'morning' })
    }));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(body.status, 'error');
    assert.match(body.message, /write_id is required/i);
    assert.deepEqual(fakeSheetsState.appendCalls, [], 'a rejected write must not append');
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

// ── Step 1A (CR-2): the Effort append must be guarded against a session_id that
// already has an effort row, so a re-sent session can never write a second Effort row.
test('api smoke: complete-workout with a duplicate session_id is rejected (409) and writes no Effort row', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.effortSessionIds = ['DUP-EFFORT-SESSION-01'];
  try {
    await withMutedConsoleLog(async () => {
      const form = new FormData();
      form.append('session_id', 'DUP-EFFORT-SESSION-01'); // already present in Effort
      form.append('date', '2026-06-12');
      form.append('log_rows_json', JSON.stringify([]));
      form.append('write_id', 'dup-effort-session-write-01');
      form.append('effort_json', JSON.stringify({
        duration: '42', activeCalories: 410, totalCalories: 520, averageHR: 148, peakHR: 171
      }));
      const { response, body } = await requestMultipart('/api/complete-workout', form);
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(body.status, 'error');
      assert.deepEqual(fakeSheetsState.appendCalls, [], 'a duplicate session must not append an Effort row');
    });
  } finally {
    fakeSheetsState.allowAppend = false;
    fakeSheetsState.effortSessionIds = [];
  }
});

test('api smoke: bodyweight exercise with weight=0 passes log-workout dry-run', async () => {
  // Regression: "Knee raises 20/2 20/2 13/2" produces weight:null from the parser.
  // The frontend maps null → '0'. Backend must accept weight '0' (or 0) without
  // throwing "Missing required log row field: weight".
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'BW-SMOKE-DRY-RUN',
      date: '2026-06-12',
      test_mode: true,
      log_rows: [
        { exercise: 'Hanging Knee Raises', set_number: 1, weight: 0, reps: 20, rir: 2, notes: '' },
        { exercise: 'Hanging Knee Raises', set_number: 2, weight: 0, reps: 20, rir: 2, notes: '' },
        { exercise: 'Hanging Knee Raises', set_number: 3, weight: 0, reps: 13, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200, `expected 200, got ${response.status}: ${JSON.stringify(body)}`);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.log_rows_preview.length, 3);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

// ── Read-path TTL cache (PR-07) ───────────────────────────────────────────────
// A live effort write goes through complete-workout, which invalidates the cache.
async function liveEffortWrite(sessionId) {
  const form = new FormData();
  form.append('session_id', sessionId);
  form.append('date', '2026-06-11');
  form.append('log_rows_json', JSON.stringify([]));
  // Live writes require a write_id; derive a unique one per session so repeated
  // calls each write (and invalidate the cache) rather than dedup as duplicates.
  form.append('write_id', `live-effort-${sessionId}`);
  form.append('effort_json', JSON.stringify({
    duration: '42', activeCalories: 410, totalCalories: 520, averageHR: 148, peakHR: 171
  }));
  return requestMultipart('/api/complete-workout', form);
}

test('read-path cache: analytics reads are cached within the TTL and a live write invalidates them', async () => {
  fakeSheetsState.allowAppend = true;
  try {
    await withMutedConsoleLog(async () => {
      // Start from a known-empty cache: a live write clears anything earlier tests left.
      await liveEffortWrite('CACHE-RESET-01');

      // Both endpoints read Log_Cleaned through index.js's cached getSheetRows.
      fakeSheetsState.reads = {};
      await requestJson('/api/plan/today');            // cache miss → reads Log_Cleaned once
      await requestJson('/api/stalls?minSessions=3');  // cache hit  → no further read
      assert.equal(fakeSheetsState.reads['Log_Cleaned'], 1, 'second analytics read should be served from cache');

      // A live write must invalidate, so the next read hits the sheet again.
      await liveEffortWrite('CACHE-RESET-02');
      fakeSheetsState.reads = {};
      await requestJson('/api/plan/today');
      assert.equal(fakeSheetsState.reads['Log_Cleaned'], 1, 'read after a write must be fresh, not cached');
    });
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

test('read-path cache: duplicate-protection reads are never served from the cache', async () => {
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.safetyReadCalls.effortSessionIds = 0;
  try {
    await withMutedConsoleLog(async () => {
      await liveEffortWrite('CACHE-SAFETY-01');
      await liveEffortWrite('CACHE-SAFETY-02');
    });
    // Each write re-reads the effort session ids live — the row cache never covers it.
    assert.equal(fakeSheetsState.safetyReadCalls.effortSessionIds, 2);
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

test('history/recent: recent_effort returns the NEWEST effort rows, tail of the sheet window', async () => {
  // 7 effort rows in sheet order (oldest first). With limit=3 the endpoint
  // must return the last three (05, 06, 07) — not the head of the window.
  fakeSheetsState.effortRecentRows = ['01', '02', '03', '04', '05', '06', '07'].map(d => [
    `2026-06-${d}`, `EFFORT-${d}`, '00:45:00', '400', '500', '140', '165', 'Gym', ''
  ]);
  try {
    const { response, body } = await requestJson('/api/history/recent?limit=3');
    assert.equal(response.status, 200);
    const recentEffort = body.data.recent_effort;
    assert.equal(recentEffort.length, 3);
    assert.deepEqual(
      recentEffort.map(e => e.date),
      ['2026-06-05', '2026-06-06', '2026-06-07'],
      'recent_effort must be the newest rows in sheet order'
    );
    assert.equal(recentEffort[2].session_id, 'EFFORT-07');
  } finally {
    fakeSheetsState.effortRecentRows = [];
  }
});

test('api smoke: log-workout effort failure after log append is partial, retry never re-appends', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.failAppendForTab = 'Effort';

  const payload = {
    session_id: 'PARTIAL-WRITE-01',
    date: '2026-06-12',
    write_id: 'write-partial-retry-01',
    log_rows: [
      { exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 5, notes: '' }
    ],
    effort_row: {
      date: '2026-06-12',
      session_id: 'PARTIAL-WRITE-01',
      duration: '00:45:00',
      active_calories: 400,
      total_calories: 500,
      average_hr: 140,
      peak_hr: 165,
      location: 'Gym'
    }
  };

  try {
    const first = await withMutedConsoleLog(() => requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify(payload)
    }));

    // Log rows landed, effort append failed → honest partial error, not a clean 500.
    assert.equal(first.response.status, 500, JSON.stringify(first.body));
    assert.equal(first.body.status, 'error');
    assert.equal(first.body.details.sheet_write, 'partial');
    assert.equal(first.body.details.sheet_written, true);
    assert.equal(first.body.details.log_rows_written, 1);
    assert.ok(first.body.details.logAppendedRange, 'partial response must carry the appended range for undo');
    assert.equal(first.body.details.effortWritten, false);
    assert.equal(first.body.details.write_id, 'write-partial-retry-01');
    // One log append + one failed effort attempt.
    assert.equal(fakeSheetsState.appendCalls.length, 2);

    // Outage clears; the client retries the SAME write_id. The log rows must
    // not be appended a second time — the recorded partial result replays.
    fakeSheetsState.failAppendForTab = null;
    const retry = await withMutedConsoleLog(() => requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify(payload)
    }));

    assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.data.duplicate_write, true);
    assert.equal(retry.body.data.sheet_write, 'skipped_duplicate');
    assert.equal(retry.body.data.sheet_written, false);
    assert.equal(retry.body.data.original_sheet_write, 'partial');
    assert.equal(retry.body.data.logAppendedRange, first.body.details.logAppendedRange);
    assert.equal(fakeSheetsState.appendCalls.length, 2, 'retry must not append again');
  } finally {
    fakeSheetsState.allowAppend = false;
    fakeSheetsState.failAppendForTab = null;
  }
});

test('api smoke: log-workout log-append failure releases write_id so a clean retry can write', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.failAppendForTab = 'Log_Cleaned';

  const payload = {
    session_id: 'CLEAN-RETRY-01',
    date: '2026-06-12',
    write_id: 'write-clean-retry-01',
    log_rows: [
      { exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 5, notes: '' }
    ]
  };

  try {
    const first = await withMutedConsoleLog(() => requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify(payload)
    }));
    // Nothing was written — the write_id must be released, not poisoned.
    assert.equal(first.response.status, 500, JSON.stringify(first.body));
    assert.equal(fakeSheetsState.appendCalls.length, 1);

    fakeSheetsState.failAppendForTab = null;
    const retry = await withMutedConsoleLog(() => requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify(payload)
    }));

    assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.data.sheet_write, 'success');
    assert.equal(retry.body.data.duplicate_write, false);
    assert.equal(retry.body.data.log_rows_written, 1);
    assert.equal(fakeSheetsState.appendCalls.length, 2);
  } finally {
    fakeSheetsState.allowAppend = false;
    fakeSheetsState.failAppendForTab = null;
  }
});

test('api smoke: log-workout rejects implausible effort_row values (finding 13 — bounds unification)', async () => {
  const logRows = [{ exercise: 'Squat', set_number: 1, weight: 225, reps: 5, rir: 2, notes: '' }];

  const badCases = [
    { field: 'average_hr', value: 5000, desc: 'HR 5000' },
    { field: 'active_calories', value: 0, desc: 'active_calories 0 (below min)' },
    { field: 'total_calories', value: 99999, desc: 'total_calories 99999 (above max)' },
    { field: 'peak_hr', value: 10, desc: 'peak_hr 10 (below min)' }
  ];

  for (const { field, value, desc } of badCases) {
    const effort_row = {
      date: '2026-06-12',
      session_id: 'BOUNDS-TEST-01',
      duration: '00:45:00',
      active_calories: 400,
      total_calories: 500,
      average_hr: 140,
      peak_hr: 165,
      location: 'Gym'
    };
    effort_row[field] = value;
    const { response } = await withMutedConsoleLog(() => requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({ session_id: 'BOUNDS-TEST-01', date: '2026-06-12', test_mode: true, log_rows: logRows, effort_row })
    }));
    assert.equal(response.status, 400, `expected 400 for ${desc}`);
  }
});

// ── Coaching notes ────────────────────────────────────────────────────────────

test('api smoke: GET /api/coaching-notes returns empty array when tab has no rows', async () => {
  fakeSheetsState.coachingNotesRows = [];
  const { response, body } = await requestJson('/api/coaching-notes');
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.data.notes, []);
});

test('api smoke: GET /api/coaching-notes returns notes from the Coaching_Notes tab', async () => {
  fakeSheetsState.coachingNotesRows = [
    ['2026-06-01', 'Left shoulder impingement — avoid overhead pressing'],
    ['2026-06-10', 'Running a 4-day upper/lower split']
  ];
  const { response, body } = await requestJson('/api/coaching-notes');
  assert.equal(response.status, 200);
  assert.equal(body.data.notes.length, 2);
  assert.equal(body.data.notes[0].note, 'Left shoulder impingement — avoid overhead pressing');
  assert.equal(body.data.notes[1].date, '2026-06-10');
  fakeSheetsState.coachingNotesRows = [];
});

test('api smoke: POST /api/coaching-notes requires note and write_id', async () => {
  const { response: r1 } = await requestJson('/api/coaching-notes', { method: 'POST', body: JSON.stringify({ write_id: 'test-1' }) });
  assert.equal(r1.status, 400, 'missing note → 400');

  const { response: r2 } = await requestJson('/api/coaching-notes', { method: 'POST', body: JSON.stringify({ note: 'A note' }) });
  assert.equal(r2.status, 400, 'missing write_id → 400');
});

test('api smoke: POST /api/coaching-notes writes to Coaching_Notes tab', async () => {
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.appendCalls = [];
  const { response, body } = await requestJson('/api/coaching-notes', {
    method: 'POST',
    body: JSON.stringify({ note: 'Goal: compete in a powerlifting meet by end of year', write_id: 'note-smoke-1' })
  });
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.data.sheet_written, true);
  assert.equal(body.data.note_written, true);
  assert.ok(fakeSheetsState.appendCalls.some(c => c.tabName === 'Coaching_Notes'), 'must append to Coaching_Notes tab');
  fakeSheetsState.allowAppend = false;
  fakeSheetsState.appendCalls = [];
});

test('api smoke: POST /api/coaching-notes is idempotent for repeated write_id', async () => {
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.appendCalls = [];
  const payload = JSON.stringify({ note: 'Idempotency note', write_id: 'note-idem-1' });
  await requestJson('/api/coaching-notes', { method: 'POST', body: payload });
  const { response: r2, body: b2 } = await requestJson('/api/coaching-notes', { method: 'POST', body: payload });
  assert.equal(r2.status, 200);
  assert.equal(b2.data.duplicate_write, true, 'second call must be marked duplicate');
  assert.equal(fakeSheetsState.appendCalls.filter(c => c.tabName === 'Coaching_Notes').length, 1, 'sheet must only be written once');
  fakeSheetsState.allowAppend = false;
  fakeSheetsState.appendCalls = [];
});

test('api smoke: coach/chat returns propose_note when coach proposes a note', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.chatNoteProposal = { note: 'Left shoulder impingement — avoid overhead pressing' };
  const { response, body } = await requestJson('/api/coach/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'My shoulder has been giving me trouble on pressing movements' })
  });
  assert.equal(response.status, 200);
  assert.ok(body.data.propose_note, 'propose_note must be in the response');
  assert.equal(body.data.propose_note.note, 'Left shoulder impingement — avoid overhead pressing');
  fakeCoachState.configured = false;
  fakeCoachState.chatNoteProposal = null;
});

test('api smoke: coaching-notes is registered in the route manifest with correct read/write flags', async () => {
  const { body } = await requestJson('/routes');
  const routes = body.data.routes;
  const noteRoutes = routes.filter(r => r.path === '/api/coaching-notes');
  const getRoute = noteRoutes.find(r => r.methods.includes('GET'));
  const postRoute = noteRoutes.find(r => r.methods.includes('POST'));
  assert.ok(getRoute, 'GET /api/coaching-notes must be registered');
  assert.equal(getRoute.readOnly, true, 'GET must be read-only');
  assert.equal(getRoute.writeCapable, false, 'GET must not be write-capable');
  assert.ok(postRoute, 'POST /api/coaching-notes must be registered');
  assert.equal(postRoute.writeCapable, true, 'POST must be write-capable');
});

// ── Structured constraints (P1 · 2.1) ─────────────────────────────────────────

test('api smoke: GET /api/constraints returns empty array when tab has no rows', async () => {
  fakeSheetsState.constraintsRows = [];
  const { response, body } = await requestJson('/api/constraints');
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.data.constraints, []);
});

test('api smoke: GET /api/constraints returns typed constraints from the Constraints tab', async () => {
  fakeSheetsState.constraintsRows = [
    ['2026-06-01', 'injury', 'overhead pressing', 'avoid', 'left shoulder impingement'],
    ['2026-06-10', 'equipment', 'barbell', 'substitute', '']
  ];
  const { response, body } = await requestJson('/api/constraints');
  assert.equal(response.status, 200);
  assert.equal(body.data.constraints.length, 2);
  assert.equal(body.data.constraints[0].kind, 'injury');
  assert.equal(body.data.constraints[0].target, 'overhead pressing');
  assert.equal(body.data.constraints[0].rule, 'avoid');
  assert.equal(body.data.constraints[1].kind, 'equipment');
  fakeSheetsState.constraintsRows = [];
});

test('api smoke: POST /api/constraints validates kind, rule, target, and write_id', async () => {
  const base = { kind: 'injury', target: 'overhead pressing', rule: 'avoid', write_id: 'c-1' };
  const { response: rKind } = await requestJson('/api/constraints', { method: 'POST', body: JSON.stringify({ ...base, kind: 'mood' }) });
  assert.equal(rKind.status, 400, 'bad kind → 400');
  const { response: rRule } = await requestJson('/api/constraints', { method: 'POST', body: JSON.stringify({ ...base, rule: 'destroy' }) });
  assert.equal(rRule.status, 400, 'bad rule → 400');
  const { response: rTarget } = await requestJson('/api/constraints', { method: 'POST', body: JSON.stringify({ ...base, target: '' }) });
  assert.equal(rTarget.status, 400, 'missing target → 400');
  const { response: rWid } = await requestJson('/api/constraints', { method: 'POST', body: JSON.stringify({ kind: 'injury', target: 'x', rule: 'avoid' }) });
  assert.equal(rWid.status, 400, 'missing write_id → 400');
});

test('api smoke: POST /api/constraints writes a typed row to the Constraints tab', async () => {
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.appendCalls = [];
  const { response, body } = await requestJson('/api/constraints', {
    method: 'POST',
    body: JSON.stringify({ kind: 'Injury', target: 'Overhead Pressing', rule: 'AVOID', note: 'left shoulder', write_id: 'c-smoke-1' })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.sheet_written, true);
  assert.equal(body.data.constraint_written, true);
  assert.equal(body.data.constraint.kind, 'injury', 'kind is normalized to lowercase');
  assert.equal(body.data.constraint.rule, 'avoid', 'rule is normalized to lowercase');
  const call = fakeSheetsState.appendCalls.find(c => c.tabName === 'Constraints');
  assert.ok(call, 'must append to Constraints tab');
  const row = call.rows[0];
  assert.match(row[0], /^\d{4}-\d{2}-\d{2}$/, 'column 0 is an ISO date');
  assert.deepEqual(row.slice(1), ['injury', 'Overhead Pressing', 'avoid', 'left shoulder'], 'columns are [kind, target, rule, note]');
  fakeSheetsState.allowAppend = false;
  fakeSheetsState.appendCalls = [];
});

test('api smoke: POST /api/constraints is idempotent for repeated write_id', async () => {
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.appendCalls = [];
  const payload = JSON.stringify({ kind: 'equipment', target: 'leg press', rule: 'substitute', write_id: 'c-idem-1' });
  await requestJson('/api/constraints', { method: 'POST', body: payload });
  const { response: r2, body: b2 } = await requestJson('/api/constraints', { method: 'POST', body: payload });
  assert.equal(r2.status, 200);
  assert.equal(b2.data.duplicate_write, true, 'second call must be marked duplicate');
  assert.equal(fakeSheetsState.appendCalls.filter(c => c.tabName === 'Constraints').length, 1, 'sheet must only be written once');
  fakeSheetsState.allowAppend = false;
  fakeSheetsState.appendCalls = [];
});

test('api smoke: coach/chat returns propose_constraint when coach proposes a constraint', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.chatConstraintProposal = { kind: 'injury', target: 'overhead pressing', rule: 'avoid', note: 'left shoulder' };
  const { response, body } = await requestJson('/api/coach/chat', {
    method: 'POST',
    body: JSON.stringify({ message: "My shoulder can't handle overhead work anymore" })
  });
  assert.equal(response.status, 200);
  assert.ok(body.data.propose_constraint, 'propose_constraint must be in the response');
  assert.equal(body.data.propose_constraint.kind, 'injury');
  assert.equal(body.data.propose_constraint.rule, 'avoid');
  fakeCoachState.configured = false;
  fakeCoachState.chatConstraintProposal = null;
});

test('api smoke: constraints is registered in the route manifest with correct read/write flags', async () => {
  const { body } = await requestJson('/routes');
  const routes = body.data.routes;
  const constraintRoutes = routes.filter(r => r.path === '/api/constraints');
  const getRoute = constraintRoutes.find(r => r.methods.includes('GET'));
  const postRoute = constraintRoutes.find(r => r.methods.includes('POST'));
  assert.ok(getRoute, 'GET /api/constraints must be registered');
  assert.equal(getRoute.readOnly, true, 'GET must be read-only');
  assert.equal(getRoute.writeCapable, false, 'GET must not be write-capable');
  assert.ok(postRoute, 'POST /api/constraints must be registered');
  assert.equal(postRoute.writeCapable, true, 'POST must be write-capable');
});
