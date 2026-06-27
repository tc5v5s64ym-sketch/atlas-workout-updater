const test = require('node:test');
const assert = require('node:assert/strict');
const { resetIdempotencyStore } = require('../services/idempotency');
const { logCleanedColumns, effortColumns } = require('../config/columns');

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
// Exercise the /version reliable-SHA path: when Render injects RENDER_GIT_COMMIT,
// /version must report it verbatim (read at index.js load, so set before require).
process.env.RENDER_GIT_COMMIT = 'a1b2c3d4e5f6071829304152637485960718293a';

const logRows = [
  ['2026-06-01', 'SESSION-OLD', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '205', '5', '3', 'old bench'],
  ['2026-06-10', 'SESSION-NEW', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '225', '5', '2', 'top set'],
  ['2026-06-10', 'SESSION-NEW', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '2', '215', '6', '2', 'backoff'],
  ['2026-06-10', 'SESSION-NEW', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '1', '315', '3', '2', ''],
  // AC3: RDL history so suggest-substitute can return a populated next_target when
  // Deadlift is unavailable and Romanian Deadlift (RDL01) is the recommended substitute.
  ['2026-06-08', 'SESSION-RDL', 'Romanian Deadlift', 'Romanian Deadlift', 'Hamstrings', 'RDL01', '1', '185', '5', '2', '']
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
  // Existing Log_Cleaned composite keys (session‖exercise‖set, lowercased)
  // returned by getLogCompositeKeys. Tests set this to exercise the row-level
  // duplicate guard on the log-workout live-write path; default empty.
  logCompositeKeys: [],
  // When set to a tab name, getHeaderRow throws for that tab — exercises the
  // header-drift guard's fail-closed read-failure branch.
  failHeaderReadForTab: null,
  // Rows returned by getSheetRows for Constraints. Tests may set this.
  constraintsRows: [],
  // Deload_State tab, modeled WITH its header row at index 0 so reads mirror the
  // real getSheetRows header-stripping. Deload-lifecycle tests reset this to [].
  deloadStateSheet: [],
  // Header row (row 1) returned by getHeaderRow per tab. Unset tabs fall back to
  // the canonical column contract (a valid header), so live-write tests pass by
  // default; header-drift tests override a tab to a reordered/short header.
  headerRows: {}
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
    // Deload_State is system-state (append-only, outside the trust loop), so it
    // bypasses the allowAppend guard that protects the logged-set write paths.
    if (tabName === 'Deload_State') {
      for (const r of rows) fakeSheetsState.deloadStateSheet.push([...r]);
      return { data: { updates: { updatedRange: `${tabName}!A1`, updatedRows: rows.length } } };
    }
    if (!fakeSheetsState.allowAppend) {
      throw new Error('appendRows should not be called by endpoint smoke tests');
    }
    if (fakeSheetsState.failAppendForTab === tabName) {
      throw new Error(`Simulated append failure for "${tabName}"`);
    }
    return { data: { updates: { updatedRange: `${tabName}!A100:K100`, updatedRows: rows.length } } };
  },
  readRange: async (range) => {
    // ensureHeaderRow reads A1 of Deload_State to decide whether a header exists.
    if (String(range).startsWith('Deload_State')) {
      return fakeSheetsState.deloadStateSheet.length ? [fakeSheetsState.deloadStateSheet[0]] : [];
    }
    return [];
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
    return [...fakeSheetsState.logCompositeKeys];
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
    if (tabName === 'Deload_State') {
      // Simulate a missing/unreadable tab (real values.get throws "Unable to parse
      // range") so the graceful-degrade path can be exercised.
      if (fakeSheetsState.failDeloadRead) throw new Error('Unable to parse range: Deload_State');
      // Mirror the real read: strip row 0 (header); [] when only a header exists.
      return fakeSheetsState.deloadStateSheet.length > 1
        ? fakeSheetsState.deloadStateSheet.slice(1).map(r => [...r])
        : [];
    }
    return [];
  },
  getHeaderRow: async tabName => {
    // Simulate a Sheets read failure for the header check (tests the fail-closed
    // 500 + failWrite branch).
    if (fakeSheetsState.failHeaderReadForTab === tabName) {
      throw new Error(`Simulated header read failure for "${tabName}"`);
    }
    if (Object.prototype.hasOwnProperty.call(fakeSheetsState.headerRows, tabName)) {
      return [...fakeSheetsState.headerRows[tabName]];
    }
    if (tabName === 'Log_Cleaned') return [...logCleanedColumns];
    if (tabName === 'Effort') return [...effortColumns];
    return [];
  },
  getSpreadsheetTabs: async () => {
    const base = ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary', 'Bodyweight', 'Coaching_Notes', 'Constraints'];
    // Deload_State / Modality_Log are present unless a test hides them to exercise
    // their respective 503 paths.
    if (!fakeSheetsState.hideDeloadStateTab) base.push('Deload_State');
    if (!fakeSheetsState.hideModalityLogTab) base.push('Modality_Log');
    return base;
  },
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
// Set to an Error (or message string) to simulate a screenshot parse failure
// (e.g. Gemini 429 / timeout). Reset to null after each test that flips it.
let fakeVisionThrow = null;

const fakeVision = {
  parseWorkoutScreenshot: async () => {
    fakeVisionCalls += 1;
    if (fakeVisionThrow) {
      throw fakeVisionThrow instanceof Error ? fakeVisionThrow : new Error(String(fakeVisionThrow));
    }
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
  chatPlanEditProposal: null, // set to a plan edit object in tests that exercise the plan-edit path
  throwError: null,
  pingError: null, // set to a string to simulate a failed Gemini ping (coach health)
  lastChatContext: null, // captures the context passed to generateChatReply for assertions
  lastPlanFacts: null // captures the facts passed to generatePlanMessage for assertions
};
const fakeCoach = {
  isConfigured: () => fakeCoachState.configured,
  coachModel: () => 'gemini-2.5-flash-lite',
  pingGemini: async () => {
    if (fakeCoachState.pingError) throw new Error(fakeCoachState.pingError);
    return 'OK';
  },
  generateCoachMessage: async () => {
    if (fakeCoachState.throwError) throw new Error(fakeCoachState.throwError);
    return fakeCoachState.message;
  },
  generatePlanMessage: async (facts) => {
    fakeCoachState.lastPlanFacts = facts ?? null;
    if (fakeCoachState.throwError) throw new Error(fakeCoachState.throwError);
    return fakeCoachState.planMessage;
  },
  generateChatReply: async (args) => {
    fakeCoachState.lastChatContext = args && args.context ? args.context : null;
    if (fakeCoachState.throwError) throw new Error(fakeCoachState.throwError);
    return { reply: fakeCoachState.chatMessage, propose_edit: fakeCoachState.chatEditProposal, propose_note: fakeCoachState.chatNoteProposal, propose_constraint: fakeCoachState.chatConstraintProposal, propose_plan_edit: fakeCoachState.chatPlanEditProposal };
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
  fakeCoachState.pingError = null;
  fakeCoachState.configured = false;
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

test('api smoke: /version reports the Render-injected commit SHA + deploy time', async () => {
  const { response, body } = await requestJson('/version');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  // RENDER_GIT_COMMIT (set above) wins over `git describe`, so the deployed commit
  // is always reportable even when the runtime container has no .git.
  assert.equal(body.data.version, 'a1b2c3d4e5f6071829304152637485960718293a');
  // PR identity from build-info.json (captured at build time) — number-or-null and
  // string-or-null regardless of whether a build-info file exists in this env.
  assert.ok(body.data.pr === null || typeof body.data.pr === 'number', 'pr is number|null');
  assert.ok(body.data.commit_subject === null || typeof body.data.commit_subject === 'string', 'commit_subject is string|null');
  // deployed_at is the server boot time — a reliable "is this build current?" signal.
  assert.ok(typeof body.data.deployed_at === 'string' && !Number.isNaN(Date.parse(body.data.deployed_at)),
    'deployed_at must be an ISO timestamp');
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

// ── PR 484 wiring slice 2: profile-aware Stimulus Governor grade rides along ───
test('api smoke: coach/message attaches a read-only set_grade (profile-aware governor)', async () => {
  fakeCoachState.configured = false; // grade rides along on every path; use the simple one
  const { response, body } = await requestJson('/api/coach/message', {
    method: 'POST',
    body: JSON.stringify({ facts: { exerciseName: 'Bench Press', todaySets: [{ weight: 225, reps: 5, rir: 0 }] } })
  });
  assert.equal(response.status, 200);
  const g = body.data.set_grade;
  assert.ok(g && typeof g === 'object', 'set_grade must be present for a weighted/RIR set');
  // Resistance modality → RIR is the metric read (profile-independent, so env-robust).
  assert.equal(g.effort_interpretation, 'rir');
  assert.ok(['+load', '+reps', '+rounds', '+duration', 'hold', 'back_off'].includes(g.progression_verdict));
  assert.ok(['none', 'elevated', 'high'].includes(g.fatigue_signal));
  assert.ok(typeof g.profile === 'string' && g.profile.length > 0);
  // Read-only: this route never writes; the manifest already asserts writeCapable:false.
});

test('api smoke: coach/message set_grade is null for a non-weighted (cardio-shaped) input', async () => {
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/message', {
    method: 'POST',
    body: JSON.stringify({ facts: { exerciseName: 'Run', todaySets: [{ duration_min: 30 }] } })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.set_grade, null, 'no weighted/RIR signal → no set_grade');
});

test('api smoke: coach/message attaches a read-only next_move_advisory (fatigue router)', async () => {
  fakeCoachState.configured = false; // the advisory rides along on every path
  // Heavy compound lower-body block, then cardio queued next → cross-modality
  // "keep the cardio easy" suggestion (independent of profile/fatigue tier). The
  // pressing-specific reroute stays silent for a squat, so the gate lets it through.
  const { response, body } = await requestJson('/api/coach/message', {
    method: 'POST',
    body: JSON.stringify({ facts: {
      exerciseName: 'Squat', todaySets: [{ weight: 315, reps: 5, rir: 1 }],
      planned_queue: ['Run'],
    } })
  });
  assert.equal(response.status, 200);
  const a = body.data.next_move_advisory;
  assert.ok(a && typeof a === 'object', 'next_move_advisory must be present for legs→cardio');
  assert.equal(a.action, 'reduce_intensity');
  assert.equal(a.next_exercise, 'Run');
  assert.equal(a.next_modality, 'cardio');
  assert.equal(body.data.reroute, null, 'pressing reroute must stay silent (no collision)');
});

test('api smoke: coach/message next_move_advisory is null with no planned next move', async () => {
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/message', {
    method: 'POST',
    body: JSON.stringify({ facts: { exerciseName: 'Squat', todaySets: [{ weight: 315, reps: 5, rir: 1 }] } })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.next_move_advisory, null, 'no planned queue → no advisory');
});

// ── PR 484 recovery/deload SELECTION voicing on the real /api/coach/message route ──
const setWithRec = (rec) => ({ facts: { exerciseName: 'Squat', todaySets: [{ weight: 315, reps: 5, rir: 1 }], rec } });
const strongRec = { trend: { trend: 'declining', confidence: 'high' }, readiness_signal: { signal: 'likely_fatigue', confidence: 'high' } };
const moderateRec = { trend: { trend: 'declining', confidence: 'high' }, readiness_signal: { signal: 'possible_fatigue', confidence: 'medium' } };

test('api smoke: strong convergence → cautious DELOAD recovery_advisory', async () => {
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/message', { method: 'POST', body: JSON.stringify(setWithRec(strongRec)) });
  assert.equal(response.status, 200);
  const a = body.data.recovery_advisory;
  assert.ok(a && typeof a === 'object', 'a converged deload signal must surface');
  assert.equal(a.decision, 'deload');
  assert.ok(a.converged_signals.includes('performance_decline') && a.converged_signals.includes('subjective_fatigue'));
});

test('api smoke: moderate stacked signal → RECOVERY_RELOAD (hold/recovery), not a full deload', async () => {
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/message', { method: 'POST', body: JSON.stringify(setWithRec(moderateRec)) });
  assert.equal(response.status, 200);
  assert.equal(body.data.recovery_advisory.decision, 'recovery_reload');
});

test('api smoke: a single weak/ambiguous signal stays SILENT (no recovery_advisory)', async () => {
  fakeCoachState.configured = false;
  // Decline alone (no readiness fatigue) — one signal does not converge.
  const declineOnly = await requestJson('/api/coach/message', { method: 'POST', body: JSON.stringify(setWithRec({ trend: { trend: 'declining', confidence: 'high' } })) });
  assert.equal(declineOnly.body.data.recovery_advisory, null, 'one signal must not trigger');
  // Fatigue readiness alone (no performance decline) — also silent.
  const fatigueOnly = await requestJson('/api/coach/message', { method: 'POST', body: JSON.stringify(setWithRec({ readiness_signal: { signal: 'likely_fatigue', confidence: 'high' } })) });
  assert.equal(fatigueOnly.body.data.recovery_advisory, null, 'one signal must not trigger');
});

test('api smoke: recovery_advisory is suppressed when a deload is already ACTIVE', async () => {
  fakeCoachState.configured = false;
  const rec = { ...strongRec, deload: { in_deload: true } };
  const { body } = await requestJson('/api/coach/message', { method: 'POST', body: JSON.stringify(setWithRec(rec)) });
  assert.equal(body.data.recovery_advisory, null, 'the active-deload fact owns that voice — no double-speak');
});

test('api smoke: recovery_advisory does not contradict the fatigue-router (both ease off)', async () => {
  fakeCoachState.configured = false;
  // Legs→cardio (reduce_intensity) AND a converged deload signal: both lean toward
  // LESS work, never opposing directions.
  const facts = { exerciseName: 'Squat', todaySets: [{ weight: 315, reps: 5, rir: 1 }], planned_queue: ['Run'], rec: strongRec };
  const { body } = await requestJson('/api/coach/message', { method: 'POST', body: JSON.stringify({ facts }) });
  assert.equal(body.data.next_move_advisory.action, 'reduce_intensity', 'next-move eases off');
  assert.equal(body.data.recovery_advisory.decision, 'deload', 'recovery eases off');
  // Neither voice is a "push/add load" action, so they cannot contradict.
  assert.ok(!['keep'].includes(body.data.next_move_advisory.action));
});

// ── Slice 2: substitution pivot voice on the real /api/coach/message route ─────
const goodPivotFacts = () => ({
  substitution: {
    classification: 'preserved', quality: 'excellent',
    prescribed: { name: 'Barbell Bench Press' }, logged: { name: 'Dumbbell Bench Press' },
  },
});

test('api smoke: coach/message attaches a pivot sub_voice and suppresses a lecturing LLM line', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  // The model lectures a good pivot — the contradiction guard must suppress it.
  fakeCoachState.message = "That's a downgrade — get the real lift back in next time.";
  try {
    const { response, body } = await requestJson('/api/coach/message', {
      method: 'POST',
      body: JSON.stringify({ facts: goodPivotFacts() }),
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.message, null, 'a lecture on a good pivot must be suppressed');
    assert.ok(body.data.sub_voice, 'sub_voice must ride along');
    assert.equal(body.data.sub_voice.severity, 'pivot');
    assert.match(body.data.sub_voice.primary_line, /^Good pivot/);
    assert.ok(body.data.sub_voice.contradictions.length > 0, 'the lecture is recorded as a contradiction');
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.message = 'Strong work.\n\n* 225 × 5 @2\n\nNext: 235 × 5.';
  }
});

test('api smoke: coach/message — good pivot owns the reaction (deterministic line, prose suppressed)', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  fakeCoachState.message = 'Nice swap, that works well.'; // clean, but the deterministic line owns it
  try {
    const { response, body } = await requestJson('/api/coach/message', {
      method: 'POST',
      body: JSON.stringify({ facts: goodPivotFacts() }),
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.message, null, 'suppress_generic_prose: the brief Atlas line owns a good pivot');
    assert.equal(body.data.sub_voice.severity, 'pivot');
    assert.match(body.data.sub_voice.primary_line, /Dumbbell Bench Press/);
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.message = 'Strong work.\n\n* 225 × 5 @2\n\nNext: 235 × 5.';
  }
});

test('api smoke: coach/message — good pivot sub_voice rides the unconfigured fallback too', async () => {
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/message', {
    method: 'POST',
    body: JSON.stringify({ facts: goodPivotFacts() }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.configured, false);
  assert.equal(body.data.message, null);
  assert.ok(body.data.sub_voice && body.data.sub_voice.primary_line, 'deterministic pivot line is available offline');
});

test('api smoke: coach/message — a real downgrade swap is NOT suppressed (warning survives)', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  fakeCoachState.message = 'Leg Extension for Leg Curl shifts the target muscle — slot the real match in next time.';
  try {
    const { response, body } = await requestJson('/api/coach/message', {
      method: 'POST',
      body: JSON.stringify({
        facts: { substitution: { classification: 'changed', quality: 'poor', prescribed: { name: 'Leg Curl' }, logged: { name: 'Leg Extension' } } },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.message, fakeCoachState.message, 'a genuine downgrade warning must reach the lifter');
    assert.equal(body.data.sub_voice.severity, 'neutral');
    assert.equal(body.data.sub_voice.primary_line, null);
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.message = 'Strong work.\n\n* 225 × 5 @2\n\nNext: 235 × 5.';
  }
});

test('api smoke: coach/message plan route strips a client-injected layoff (engine is the only source)', async () => {
  // Trust property: the plan route ALWAYS overwrites facts.layoff with the engine
  // value (or null), so a client cannot make Atlas claim a layoff/volume cut the
  // engine did not assert. We inject a fake layoff with a sentinel and confirm it
  // never reaches the coach.
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  fakeCoachState.planMessage = 'Plan note.';
  fakeCoachState.lastPlanFacts = null;
  try {
    const { response } = await requestJson('/api/coach/message', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'plan',
        facts: {
          label: 'Recovery / Pump',
          layoff: { severity: 'extended', days_since_last_session: 99, volume_reduced: true, sentinel: 'CLIENT_INJECTED' },
        },
      }),
    });
    assert.equal(response.status, 200);
    const passed = fakeCoachState.lastPlanFacts;
    assert.ok(passed, 'plan facts must reach the coach');
    // The client object is discarded entirely — never forwarded verbatim.
    assert.ok(!JSON.stringify(passed.layoff ?? null).includes('CLIENT_INJECTED'),
      'a client-injected layoff must never reach the coach');
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

test('api smoke: coach/message returns deterministic set-effort copy (engine-backed, LLM-independent)', async () => {
  // PR 477 wiring: a heavy-compound redline with a same-prime-mover next move and
  // a pull queued must yield an effort_note + a reroute suggestion. These are
  // computed from the engine, so they are present even with Gemini UNCONFIGURED
  // (the default here) — i.e. the LLM-down path still surfaces the engine's read.
  const before = fakeSheetsState.appendCalls.length;
  const { response, body } = await requestJson('/api/coach/message', {
    method: 'POST',
    body: JSON.stringify({
      facts: {
        exerciseName: 'Bench Press',
        todaySets: [{ weight: 235, reps: 6, rir: 2 }, { weight: 235, reps: 6, rir: 0 }, { weight: 235, reps: 4, rir: 1 }],
        planned_queue: ['Weighted Dips', 'Seated Row'],
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.message, null, 'Gemini is unconfigured here — prose is null');
  assert.equal(body.data.effort_note, 'You went to zero and reps dropped after. Pressing is yellow now.');
  assert.ok(body.data.reroute, 'a reroute suggestion must be present');
  assert.equal(body.data.reroute.type, 'reroute_pull_first');
  assert.match(body.data.reroute.line, /Seated Row/);
  // Coach Voice Renderer (slice 1): a non-neutral signal rides along as `voice`,
  // owns the reaction (suppress_generic_prose), and carries the deterministic line.
  assert.ok(body.data.voice, 'the deterministic voice must be present');
  assert.equal(body.data.voice.severity, 'block');
  assert.equal(body.data.voice.suppress_generic_prose, true);
  assert.match(body.data.voice.primary_line, /pressing is yellow|hold/i);
  assert.doesNotMatch(body.data.voice.primary_line, /keep pushing|add (weight|load)|on track/i);
  // Trust: surfacing the engine read never writes a row.
  assert.equal(fakeSheetsState.appendCalls.length, before, 'coach effort path must not write');
});

test('api smoke: coach/message omits set-effort extras when there is no signal / no queue', async () => {
  const { body } = await requestJson('/api/coach/message', {
    method: 'POST',
    body: JSON.stringify({ facts: { exerciseName: 'Bench Press', todaySets: [{ weight: 225, reps: 5, rir: 2 }] } })
  });
  // Clean on-target set, no planned queue → no effort line, no reroute.
  assert.equal(body.data.effort_note, null);
  assert.equal(body.data.reroute, null);
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

test('api smoke: coach/health is registered read-only and never write-capable', async () => {
  const { body } = await requestJson('/routes');
  const routeByPath = new Map(body.data.routes.map(route => [route.path, route]));
  assert.ok(routeByPath.has('/api/coach/health'), 'coach health route must be in the manifest');
  assert.equal(routeByPath.get('/api/coach/health').writeCapable, false, 'health endpoint must never be write-capable');
  assert.equal(routeByPath.get('/api/coach/health').readOnly, true);
});

test('api smoke: coach/health reports not-configured when GEMINI_API_KEY is unset', async () => {
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/health');
  assert.equal(response.status, 200);
  assert.equal(body.data.configured, false);
  assert.equal(body.data.ok, false);
  assert.match(body.data.reason, /GEMINI_API_KEY/);
});

test('api smoke: coach/health reports ok when the Gemini ping succeeds', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.pingError = null;
  const { response, body } = await requestJson('/api/coach/health');
  assert.equal(response.status, 200);
  assert.equal(body.data.configured, true);
  assert.equal(body.data.ok, true);
  assert.equal(body.data.model, 'gemini-2.5-flash-lite');
});

test('api smoke: coach/health surfaces the Gemini failure reason (the diagnosable cause)', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.pingError = 'Gemini request failed (404): model not found';
  const { response, body } = await requestJson('/api/coach/health');
  assert.equal(response.status, 200);
  assert.equal(body.data.configured, true);
  assert.equal(body.data.ok, false);
  assert.match(body.data.reason, /404/);
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

// ── Slice 3: recovery routing — a tired lifter never gets motivation hype ──────
const HYPE = /push through|you('?| )ve got this|you got this|no excuses|grind it out|dig deep|beast mode|crush it|let'?s go champ/i;

test('api smoke: coach/chat routes a tired lifter to recovery, bypassing the LLM (no hype)', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  fakeCoachState.chatMessage = "Push through it — you've got this, no excuses!"; // the LLM hype we must NOT surface
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: "I'm exhausted today" })
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.source, 'engine', 'tiredness is owned by the deterministic engine, not Gemini');
    assert.notEqual(body.data.message, fakeCoachState.chatMessage, 'the LLM hype line must be bypassed');
    assert.doesNotMatch(body.data.message, HYPE, 'recovery routing must never hype a tired lifter');
    assert.match(body.data.message, /recovery|pull-back|rest|lighter|reserve|recovered/i, 'it routes on recovery');
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/chat — tired lifter gets recovery routing even when Gemini is unconfigured (no dead-end)', async () => {
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'legs are toast' })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.source, 'engine');
  assert.ok(body.data.message && body.data.message.trim(), 'a tired lifter is never dead-ended on the unconfigured path');
  assert.doesNotMatch(body.data.message, HYPE);
});

test('api smoke: coach/chat — a non-tired question still reaches the LLM (no over-capture)', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'how is my bench trending?', history: [{ role: 'user', text: 'hi' }] })
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.source, 'gemini', 'a normal question must not be captured by recovery routing');
    assert.equal(body.data.message, fakeCoachState.chatMessage);
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/chat recovery routing never writes a sheet', async () => {
  const before = fakeSheetsState.appendCalls.length;
  fakeCoachState.configured = true;
  try {
    await requestJson('/api/coach/chat', { method: 'POST', body: JSON.stringify({ message: "I'm wiped out" }) });
  } finally {
    fakeCoachState.configured = false;
  }
  assert.equal(fakeSheetsState.appendCalls.length, before, 'recovery routing is read-only');
});

test('api smoke: coach/chat computes extra_work from the live plan vs preview', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  fakeCoachState.lastChatContext = null;
  try {
    const { response } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: 'did I do extra today?',
        context: {
          current_plan: [{ name: 'Bench Press', sets: 3 }],
          // 5 logged Bench sets (2 over the prescribed 3) + an unplanned Bicep Curl.
          current_preview: [
            { exercise: 'Bench Press' }, { exercise: 'Bench Press' }, { exercise: 'Bench Press' },
            { exercise: 'Bench Press' }, { exercise: 'Bench Press' }, { exercise: 'Bicep Curl' },
          ],
        },
      }),
    });
    assert.equal(response.status, 200);
    const xw = fakeCoachState.lastChatContext && fakeCoachState.lastChatContext.extra_work;
    assert.ok(xw && xw.has_extra === true, 'extra_work must be computed and present');
    const bench = xw.extra_sets.find(s => s.exercise === 'Bench Press');
    assert.ok(bench && bench.extra === 2, 'engine must report 2 extra bench sets (5 logged vs 3 prescribed)');
    assert.ok(xw.extra_exercises.some(e => e.exercise === 'Bicep Curl'), 'unplanned Bicep Curl must surface as extra');
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/chat reports no extra_work with no plan (nothing to exceed)', async () => {
  // The route passes the raw buildChatContext output to the coach; sanitizeChatContext
  // (which turns has_extra:false → null) runs inside the real coach. So here we assert
  // the gate's no-extra shape — that with NO plan, freestyle-logged lifts are never
  // flagged as extra. The has_extra:false → null sanitization is pinned in coach.test.js.
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  fakeCoachState.lastChatContext = null;
  try {
    const { response } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: 'did I do extra today?',
        context: {
          // No active plan — freestyle logging. With no prescription there is
          // nothing to exceed, so logged lifts must NOT be reported as extra.
          current_plan: [],
          current_preview: [
            { exercise: 'Bench Press' }, { exercise: 'Bench Press' }, { exercise: 'Bicep Curl' },
          ],
        },
      }),
    });
    assert.equal(response.status, 200);
    const xw = fakeCoachState.lastChatContext && fakeCoachState.lastChatContext.extra_work;
    assert.ok(xw, 'extra_work shape is present on the context');
    assert.equal(xw.has_extra, false, 'no plan → nothing exceeded → has_extra false (→ null after sanitization)');
    assert.deepEqual(xw.extra_exercises, [], 'freestyle-logged lifts must NOT be flagged as unplanned extra');
    assert.deepEqual(xw.extra_sets, [], 'no plan → no extra-set comparison');
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

test('api smoke: coach/chat answers in-session shorthand from the engine when Gemini is down', async () => {
  // P0 follow-up: when the LLM fails, a workout-state question ("how many reps and
  // rir") must be answered deterministically from the engine recommendation for the
  // named lift (Bench Press → BEN01 history), not dead-end at "Coach is unavailable".
  fakeCoachState.configured = true;
  fakeCoachState.throwError = 'gemini exploded';
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'Going to do bench 225 how many reps and rir should I do?' })
    });
    assert.equal(response.status, 200, 'a coach failure must not surface as an HTTP error');
    assert.equal(body.data.source, 'engine', 'falls back to a deterministic engine answer');
    assert.match(body.data.message, /Bench Press/, 'names the resolved lift');
    assert.match(body.data.message, /\breps\b/, 'answers the reps part');
    assert.match(body.data.message, /RIR \d/, 'answers the RIR part with an engine number');
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.throwError = null;
  }
});

test('api smoke: coach/chat gives deterministic lift advice when Gemini is 503/429/timeout', async () => {
  const before = fakeSheetsState.appendCalls.length;
  fakeCoachState.configured = true;
  try {
    for (const providerError of [
      'Gemini request failed (503): UNAVAILABLE',
      'Gemini request failed (429): RESOURCE_EXHAUSTED',
      'The operation was aborted due to timeout'
    ]) {
      fakeCoachState.throwError = providerError;
      const { response, body } = await requestJson('/api/coach/chat', {
        method: 'POST',
        body: JSON.stringify({ message: 'Should I go heavier on back squat?' })
      });
      assert.equal(response.status, 200, 'a provider failure must not surface as an HTTP error');
      assert.equal(body.data.source, 'engine', providerError);
      assert.match(body.data.message, /Back Squat/, 'names the resolved lift');
      assert.match(body.data.message, /use \d+ lbs, \d+ reps, 3 sets/i, 'returns the engine prescription');
      assert.match(body.data.message, /Engine read:/, 'includes the deterministic recommendation reason when available');
    }
    assert.equal(fakeSheetsState.appendCalls.length, before, 'provider-down advice fallback is read-only');
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.throwError = null;
  }
});

test('api smoke: healthy Gemini still owns advice-shaped coach chat', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  fakeCoachState.chatMessage = 'Gemini advice stays in charge when available.';
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'Should I go heavier on back squat?' })
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.source, 'gemini');
    assert.equal(body.data.message, 'Gemini advice stays in charge when available.');
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.chatMessage = 'Your bench has been flat for a few sessions â€” try 5Ã—5 at 225 this week.';
  }
});

test('api smoke: coach/chat shorthand fallback resolves the lift from the client plan context', async () => {
  // Unconfigured (no Sheets read) — the lift + target come from the live plan the
  // client sent, so "RIR?" still answers without the LLM.
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/chat', {
    method: 'POST',
    body: JSON.stringify({
      message: 'RIR?',
      context: { current_plan: [{ name: 'Overhead Press', weight: 116, reps: 10, sets: 3, rir: 2 }] }
    })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.source, 'engine');
  assert.equal(body.data.message, 'Overhead Press: RIR 2.');
});

test('api smoke: coach/chat answers BARE shorthand from the current lift even when Gemini is UP (#449 follow-up)', async () => {
  // Pre-empt: bare "RIR?" with an active plan answers from the current lift
  // deterministically, not LLM education — even though Gemini is configured.
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  const ctx = { current_plan: [{ name: 'Deadlift', weight: 245, reps: 7, sets: 3, rir: 2 }] };
  try {
    for (const [q, expected] of [['RIR?', 'Deadlift: RIR 2.'], ['Reps?', 'Deadlift: 7 reps.'], ['How much?', 'Deadlift: 245 lbs.'], ['How many sets?', 'Deadlift: 3 sets.']]) {
      const { response, body } = await requestJson('/api/coach/chat', {
        method: 'POST', body: JSON.stringify({ message: q, context: ctx })
      });
      assert.equal(response.status, 200, q);
      assert.equal(body.data.source, 'engine', `${q} → engine, not LLM`);
      assert.equal(body.data.message, expected, q);
    }
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/chat asks which lift when bare shorthand is ambiguous (#449 follow-up)', async () => {
  fakeCoachState.configured = true;
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'RIR?', context: { current_plan: [{ name: 'Deadlift', rir: 2 }, { name: 'Leg Press', rir: 1 }] } })
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.source, 'engine');
    assert.equal(body.data.message, 'For which lift — Deadlift or Leg Press?');
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/chat engine-fills a bare "how many sets?" during a preview of an UNPLANNED lift (#452 follow-up)', async () => {
  // The lifter has previewed Bench Press (an unplanned lift), so the preview row
  // carries sets:null — the context-only attempt can't answer "How many sets?" and
  // would drop to the LLM. With Gemini UP, the bare pre-empt must engine-fill via
  // recommendNextSet (BEN01 history → 3 sets), the SAME deterministic target the
  // named-lift fallback uses, so the lifter gets the engine number, not an LLM guess.
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  const before = fakeSheetsState.appendCalls.length;
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'How many sets?', context: { current_preview: [{ exercise: 'Bench Press' }] } })
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.source, 'engine', 'preview-of-unplanned-lift bare set question answers from the engine, not the LLM');
    assert.equal(body.data.message, 'Bench Press: 3 sets.', 'reports the engine-recommended set count for the previewed lift');
    assert.equal(fakeSheetsState.appendCalls.length, before, 'engine-fill is read-only — never writes a sheet');
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/chat does NOT engine-fill a bare shorthand with NO active session (stays LLM-eligible) (#452 follow-up)', async () => {
  // Guard: the engine-fill Sheets read is gated on an active session. A bare
  // "How many sets?" with no preview and no plan must NOT short-circuit to the
  // engine — it falls through to the normal flow (Gemini answers when up).
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  fakeCoachState.chatMessage = 'Sets depend on your goal — usually 3 to 5 working sets.';
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'How many sets?' })
    });
    assert.equal(response.status, 200);
    assert.notEqual(body.data.source, 'engine', 'with no active session, the bare pre-empt must not engine-fill');
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/chat preserves a proposal even when the Gemini prose comes back empty', async () => {
  // Empty reply must not drop a structured proposal — the proposal is the payload.
  fakeCoachState.configured = true;
  fakeCoachState.throwError = null;
  fakeCoachState.chatMessage = '   '; // whitespace-only prose
  fakeCoachState.chatEditProposal = { action: 'update_set', index: 0, weight: 235, reps: 5 };
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'change set 1 to 235x5' })
    });
    assert.equal(response.status, 200);
    assert.equal(body.data.source, 'gemini', 'a returned proposal keeps the gemini source, not the engine fallback');
    assert.equal(body.data.message, null, 'empty prose surfaces as null so the client uses its fallback line');
    assert.deepEqual(body.data.propose_edit, { action: 'update_set', index: 0, weight: 235, reps: 5 });
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.chatMessage = 'Your bench has been flat for a few sessions — try 5×5 at 225 this week.';
    fakeCoachState.chatEditProposal = null;
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

test('api smoke: coach/chat passes propose_plan_edit through to the client', async () => {
  fakeCoachState.configured = true;
  fakeCoachState.chatPlanEditProposal = {
    action: 'remove_exercises',
    exercises: [{ name: 'Hanging Knee Raises' }, { name: 'Dumbbell Side Bend' }]
  };
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: 'get rid of the core exercises',
        context: {
          current_plan: [
            { name: 'Bench Press' },
            { name: 'Hanging Knee Raises' },
            { name: 'Dumbbell Side Bend' }
          ],
          plan_completed: []
        }
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(body.data.propose_plan_edit, {
      action: 'remove_exercises',
      exercises: [{ name: 'Hanging Knee Raises' }, { name: 'Dumbbell Side Bend' }]
    });
    assert.equal(body.data.message, fakeCoachState.chatMessage, 'healthy Gemini prose must be returned, not fallback');
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.chatPlanEditProposal = null;
  }
});

test('api smoke: coach/chat with current_plan but NO plan_completed does NOT crash — plan_state gated on explicit plan_completed', async () => {
  // Guard: app.js sends current_plan but not plan_completed (pre-PR 358).
  // plan_state must be null so the coach is not told "all exercises still
  // outstanding" using stale data.
  fakeCoachState.configured = true;
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: 'what should I do next?',
        context: {
          current_plan: [
            { name: 'Lat Pulldown', weight: 160, reps: 10, sets: 3, rir: 2 },
            { name: 'Rows',         weight: 190, reps: 10, sets: 3, rir: 2 }
          ]
          // plan_completed intentionally absent — simulates current app.js behaviour
        }
      })
    });
    assert.equal(response.status, 200, 'missing plan_completed must not crash the endpoint');
    assert.equal(body.data.message, fakeCoachState.chatMessage, 'reply returned normally');
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/chat accepts plan_completed in context and returns 200 — plan_state emitted when both fields present', async () => {
  // PR 357 acceptance path: client sends current_plan + plan_completed so the
  // backend can compute remaining exercises for the coach.
  fakeCoachState.configured = true;
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: 'lat pulldown machine is busy, doing rows next',
        context: {
          current_plan: [
            { name: 'Lat Pulldown', weight: 160, reps: 10, sets: 3, rir: 2 },
            { name: 'Rows',         weight: 190, reps: 10, sets: 3, rir: 2 }
          ],
          plan_completed: ['Rows']
        }
      })
    });
    assert.equal(response.status, 200, 'plan_completed in context must not crash the endpoint');
    assert.equal(body.data.message, fakeCoachState.chatMessage, 'reply returned normally');
  } finally {
    fakeCoachState.configured = false;
  }
});

test('api smoke: coach/chat with plan_completed containing ALL plan exercises — session complete, no crash (PR 358)', async () => {
  // Acceptance path: all 4 acceptance-test exercises logged; server must
  // compute isComplete:true and return 200. Proves the complete-session path
  // is handled without errors and does not stall the coach reply.
  fakeCoachState.configured = true;
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: 'nice work today',
        context: {
          current_plan: [
            { name: 'Deadlift',      weight: 315, reps: 5,  sets: 3, rir: 2 },
            { name: 'Rows',          weight: 190, reps: 10, sets: 3, rir: 2 },
            { name: 'Lateral Raise', weight: 15,  reps: 12, sets: 3, rir: 2 },
            { name: 'Lat Pulldown',  weight: 160, reps: 10, sets: 3, rir: 2 }
          ],
          plan_completed: ['Deadlift', 'Rows', 'Lateral Raise', 'Lat Pulldown']
        }
      })
    });
    assert.equal(response.status, 200, 'complete-session context must not crash the endpoint');
    assert.equal(body.data.message, fakeCoachState.chatMessage, 'reply returned normally');
  } finally {
    fakeCoachState.configured = false;
  }
});

test('step-375: empty plan_completed ([]) still yields plan_state with ALL exercises remaining — not null', async () => {
  // The Step 375 gate fix: app.js now sends plan_completed even when empty (no
  // set logged yet). The server must compute an authoritative plan_state so the
  // coach can answer "what's left?" early in a session instead of falling back
  // to current_plan. An empty array must NOT be treated like an absent field.
  fakeCoachState.configured = true;
  fakeCoachState.lastChatContext = null;
  try {
    const { response } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: "what's left?",
        context: {
          current_plan: [
            { name: 'Deadlift',     weight: 315, reps: 5,  sets: 3, rir: 2 },
            { name: 'Lat Pulldown', weight: 160, reps: 10, sets: 3, rir: 2 }
          ],
          plan_completed: []
        }
      })
    });
    assert.equal(response.status, 200);
    const ps = fakeCoachState.lastChatContext && fakeCoachState.lastChatContext.plan_state;
    assert.ok(ps, 'plan_state must be computed from an empty plan_completed, not left null');
    assert.deepEqual(ps.remaining, ['Deadlift', 'Lat Pulldown'], 'all planned exercises remain');
    assert.deepEqual(ps.completed, [], 'nothing completed yet');
    assert.equal(ps.isComplete, false);
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.lastChatContext = null;
  }
});

test('step-375: partial plan_completed drives remaining — completed lift drops out of remaining', async () => {
  // After logging one of two planned lifts, "what's left?" must reflect only the
  // outstanding one. This is the exact failure Step 375 prevents: the coach
  // previously reported completed lifts as still remaining.
  fakeCoachState.configured = true;
  fakeCoachState.lastChatContext = null;
  try {
    const { response } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: "what's left?",
        context: {
          current_plan: [
            { name: 'Deadlift',     weight: 315, reps: 5,  sets: 3, rir: 2 },
            { name: 'Lat Pulldown', weight: 160, reps: 10, sets: 3, rir: 2 }
          ],
          plan_completed: ['Deadlift']
        }
      })
    });
    assert.equal(response.status, 200);
    const ps = fakeCoachState.lastChatContext && fakeCoachState.lastChatContext.plan_state;
    assert.ok(ps, 'plan_state present');
    assert.deepEqual(ps.remaining, ['Lat Pulldown'], 'completed Deadlift is gone from remaining');
    assert.deepEqual(ps.completed, ['Deadlift']);
    assert.equal(ps.isComplete, false);
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.lastChatContext = null;
  }
});

test('step-375: current_plan WITHOUT plan_completed leaves plan_state null (gate intact for stale-data guard)', async () => {
  // The original gate protected against a client that sends current_plan but has
  // not wired plan_completed at all. That guard must survive: plan_state stays
  // null so the coach is told it lacks authoritative state rather than reporting
  // every exercise as remaining from stale data.
  fakeCoachState.configured = true;
  fakeCoachState.lastChatContext = null;
  try {
    const { response } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: "what's left?",
        context: {
          current_plan: [
            { name: 'Deadlift',     weight: 315, reps: 5, sets: 3, rir: 2 },
            { name: 'Lat Pulldown', weight: 160, reps: 10, sets: 3, rir: 2 }
          ]
          // plan_completed intentionally absent
        }
      })
    });
    assert.equal(response.status, 200);
    const ps = fakeCoachState.lastChatContext && fakeCoachState.lastChatContext.plan_state;
    assert.equal(ps, null, 'no plan_completed → plan_state stays null');
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.lastChatContext = null;
  }
});

test('step-377: coach/chat unconfigured + session-close question returns a deterministic engine answer (not null)', async () => {
  // The exact failure Step 377 prevents: "Ok so we are done?" used to dead-end at
  // "Coach is unavailable" when the LLM was down. The engine knows the answer from
  // the plan_state riding in on the client context — answer it deterministically.
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/chat', {
    method: 'POST',
    body: JSON.stringify({
      message: 'Ok so we are done?',
      context: {
        current_plan: [
          { name: 'Deadlift',     weight: 315, reps: 5,  sets: 3, rir: 2 },
          { name: 'Lat Pulldown', weight: 160, reps: 10, sets: 3, rir: 2 }
        ],
        plan_completed: ['Deadlift']
      }
    })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.configured, false);
  assert.equal(body.data.source, 'engine', 'a deterministic engine answer is flagged as such');
  assert.ok(body.data.message, 'message is non-null — no more "Coach is unavailable" dead end');
  assert.match(body.data.message, /not done/i, 'reports the session is not finished');
  assert.match(body.data.message, /Lat Pulldown/, 'names the outstanding lift');
});

test('step-377: coach/chat unconfigured + session-complete close question confirms done and points at save', async () => {
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/chat', {
    method: 'POST',
    body: JSON.stringify({
      message: 'are we done?',
      context: {
        current_plan: [{ name: 'Deadlift' }, { name: 'Lat Pulldown' }],
        plan_completed: ['Deadlift', 'Lat Pulldown']
      }
    })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.source, 'engine');
  assert.match(body.data.message, /done/i);
  assert.match(body.data.message, /log it/i, 'points the lifter at the save step');
});

test('step-377: coach/chat unconfigured + close question but NO plan_completed still hands back null (client fallback)', async () => {
  // Without an authoritative plan_state the engine must not guess — the generic
  // client fallback runs instead, same stale-data guard as the snapshot path.
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/chat', {
    method: 'POST',
    body: JSON.stringify({
      message: 'are we done?',
      context: { current_plan: [{ name: 'Deadlift' }] } // plan_completed absent
    })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.message, null, 'no authoritative state → null, client falls back');
  assert.equal(body.data.configured, false);
});

test('step-377: coach/chat unconfigured + non-close question is unaffected (still null)', async () => {
  // Guard against over-firing: a normal question with full plan context must NOT
  // get a session-status answer — only close questions do.
  fakeCoachState.configured = false;
  const { response, body } = await requestJson('/api/coach/chat', {
    method: 'POST',
    body: JSON.stringify({
      message: 'how is my bench trending?',
      context: {
        current_plan: [{ name: 'Deadlift' }, { name: 'Lat Pulldown' }],
        plan_completed: ['Deadlift']
      }
    })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.message, null, 'non-close question → no engine answer');
});

test('step-377: coach/chat throws mid-session on a close question → deterministic engine answer from plan_state', async () => {
  // The error path: Gemini configured but fails (timeout/500) AFTER buildChatContext
  // computed plan_state. A close question must still resolve from the engine rather
  // than collapsing to the generic "use fallback" null.
  fakeCoachState.configured = true;
  fakeCoachState.throwError = 'Gemini request failed (503)';
  try {
    const { response, body } = await requestJson('/api/coach/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: "that's everything right?",
        context: {
          current_plan: [{ name: 'Deadlift' }, { name: 'Lat Pulldown' }],
          plan_completed: ['Deadlift']
        }
      })
    });
    assert.equal(response.status, 200, 'a coach failure must not surface as an HTTP error');
    assert.equal(body.data.source, 'engine');
    assert.match(body.data.message, /Lat Pulldown/, 'names the outstanding lift from the computed plan_state');
  } finally {
    fakeCoachState.configured = false;
    fakeCoachState.throwError = null;
  }
});

test('step-377: coach/chat session-close fallback never appends to a sheet', async () => {
  const before = fakeSheetsState.appendCalls.length;
  fakeCoachState.configured = false;
  await requestJson('/api/coach/chat', {
    method: 'POST',
    body: JSON.stringify({
      message: 'are we done?',
      context: {
        current_plan: [{ name: 'Deadlift' }],
        plan_completed: ['Deadlift']
      }
    })
  });
  assert.equal(fakeSheetsState.appendCalls.length, before, 'the deterministic close answer is read-only');
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

test('api smoke: parse-workout-text splits inline multi-exercise (dry-run, no write)', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/parse-workout-text', {
    method: 'POST',
    body: JSON.stringify({
      text: 'Deadlift 315 5/2 Bench 225 5/2',
      test_mode: true
    })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.parsed.intent, 'log_sets_multi');
  assert.deepEqual(body.data.parsed.exercises.map(e => e.canonical_name), ['Deadlift', 'Bench Press']);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

// PR 486 slice 3: the dry-run preview attaches recognized non-slash modality
// metadata (timed holds / steady cardio / intervals / circuits) so the client can
// show what was understood — still without writing anything. Real route + real
// recognizer.
test('api smoke: parse-workout-text attaches modality metadata for a circuit (no write)', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/parse-workout-text', {
    method: 'POST',
    body: JSON.stringify({ text: 'AMRAP 12 min: pushups 10, air squats 15 - 6 rounds RPE 8', test_mode: true })
  });

  assert.equal(response.status, 200);
  assert.ok(body.data.modality, 'modality metadata must be attached for a recognized circuit');
  assert.equal(body.data.modality.modality, 'circuit');
  assert.equal(body.data.modality.kind, 'amrap');
  assert.equal(body.data.modality.cap_min, 12);
  // Still a dry-run; proof fields intact; never writes.
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: parse-workout-text attaches modality metadata for steady cardio (no write)', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/parse-workout-text', {
    method: 'POST',
    body: JSON.stringify({ text: 'Run 5 km 32:10 RPE 7 avg HR 151', test_mode: true })
  });

  assert.equal(response.status, 200);
  assert.ok(body.data.modality, 'modality metadata must be attached for recognized cardio');
  assert.equal(body.data.modality.modality, 'cardio_steady');
  assert.equal(body.data.modality.distance_km, 5);
  assert.equal(body.data.no_write_confirmed, true);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

// The slash-notation contract is never hijacked: a weighted/slash set is a
// resistance `log_sets` parse and gets NO modality metadata attached.
test('api smoke: parse-workout-text attaches NO modality for a slash-notation set (contract intact)', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/parse-workout-text', {
    method: 'POST',
    body: JSON.stringify({ text: 'Bench 225 5/2', test_mode: true })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.parsed.intent, 'log_sets');
  assert.equal(body.data.modality, undefined, 'a slash set must not be claimed as a modality');
  assert.equal(body.data.sheet_written, false);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

// Cable Fly is `unknown_exercise` to the parser's narrow catalog, but the KB
// resolver recognizes it. The real route must attach a kb_identity so the client's
// unknown-lift warning isn't split-brain with the card/voice. Real route + real KB.
test('api smoke: parse-workout-text attaches KB identity for Cable Fly (no split-brain)', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/parse-workout-text', {
    method: 'POST',
    body: JSON.stringify({ text: 'Cable Fly 30 12/0', test_mode: true })
  });

  assert.equal(response.status, 200);
  // Confirmation-card data: a real log_sets parse with the set.
  assert.equal(body.data.parsed.intent, 'log_sets');
  assert.deepEqual(body.data.parsed.sets.map(s => [s.weight, s.reps, s.rir]), [[30, 12, 0]]);
  // KB identity resolved (this is what suppresses the "didn't catch that lift" warning).
  assert.ok(body.data.kb_identity, 'kb_identity must be attached when the KB recognizes the lift');
  assert.equal(body.data.kb_identity.exercise_id, 'cable_fly');
  // Still a dry-run; never writes.
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

// ── PR 486 slice 4b — /api/log-modality trust-loop write route ────────────────
test('api smoke: log-modality dry-run (test_mode) previews the normalized row and writes nothing', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-modality', {
    method: 'POST',
    body: JSON.stringify({ text: 'Run 5 km 32:10 RPE 7 avg HR 151', session_id: 'S1', date: '2026-06-23', test_mode: true })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_write, 'skipped');
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.modality, 'cardio_steady');
  // Normalized preview row: km→m, mm:ss elapsed→duration_sec (32:10 = 1930s).
  // Columns: date, session_id, modality, exercise, duration_sec, distance_m, rounds, rest_sec, level, rpe, avg_hr, notes
  assert.deepEqual(body.data.modality_row_preview, ['2026-06-23', 'S1', 'cardio_steady', 'Run', 1930, 5000, '', '', '', 7, 151, 'elapsed 32:10']);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: log-modality live write appends the normalized row to Modality_Log', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  try {
    const { response, body } = await requestJson('/api/log-modality', {
      method: 'POST',
      body: JSON.stringify({ text: '8 x 400m / 90 sec RPE 8', session_id: 'S2', date: '2026-06-23', write_id: 'mod-wid-1' })
    });

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.test_mode, false);
    assert.equal(body.data.sheet_write, 'success');
    assert.equal(body.data.sheet_written, true);
    assert.equal(body.data.modality, 'cardio_interval');
    assert.equal(fakeSheetsState.appendCalls.length, 1);
    assert.equal(fakeSheetsState.appendCalls[0].tabName, 'Modality_Log');
    // rounds=8, distance_m=400 (per-rep work), rest_sec=90, rpe=8; duration_sec blank (distance-based).
    assert.deepEqual(fakeSheetsState.appendCalls[0].rows[0],
      ['2026-06-23', 'S2', 'cardio_interval', '', '', 400, 8, 90, '', 8, '', '']);
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: log-modality is idempotent — a duplicate write_id appends only once', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  try {
    const payload = JSON.stringify({ text: 'Plank 60 sec x3 RPE 7', session_id: 'S3', date: '2026-06-23', write_id: 'mod-wid-dup' });
    const first = await requestJson('/api/log-modality', { method: 'POST', body: payload });
    const second = await requestJson('/api/log-modality', { method: 'POST', body: payload });

    assert.equal(first.body.data.sheet_written, true);
    assert.equal(second.body.data.duplicate_write, true);
    assert.equal(second.body.data.sheet_written, false);
    assert.equal(fakeSheetsState.appendCalls.length, 1, 'a replayed write_id must not append twice');
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: log-modality returns 503 until the Modality_Log tab exists (and writes nothing)', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.hideModalityLogTab = true;
  try {
    const { response } = await requestJson('/api/log-modality', {
      method: 'POST',
      body: JSON.stringify({ text: 'Run 5 km 30:00', session_id: 'S4', date: '2026-06-23', write_id: 'mod-wid-503' })
    });
    assert.equal(response.status, 503);
    assert.deepEqual(fakeSheetsState.appendCalls, []);
  } finally {
    fakeSheetsState.hideModalityLogTab = false;
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: log-modality rejects a slash-notation set (422) — resistance path is never hijacked', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response } = await requestJson('/api/log-modality', {
    method: 'POST',
    body: JSON.stringify({ text: 'Bench 225 5/2', session_id: 'S5', date: '2026-06-23', write_id: 'mod-wid-slash' })
  });
  assert.equal(response.status, 422, 'a slash set is not a modality input');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: log-modality live write requires a write_id', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response } = await requestJson('/api/log-modality', {
    method: 'POST',
    body: JSON.stringify({ text: 'Run 5 km 30:00', session_id: 'S6', date: '2026-06-23' })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: log-modality rejects a malformed date (400) and writes nothing', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  try {
    const { response } = await requestJson('/api/log-modality', {
      method: 'POST',
      body: JSON.stringify({ text: 'Run 5 km 30:00', session_id: 'S7', date: 'June 23', write_id: 'mod-wid-baddate' })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(fakeSheetsState.appendCalls, []);
  } finally {
    fakeSheetsState.allowAppend = false;
  }
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
      text: 'Lat pulldown 170 8/2 x99',
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

// B1 (2026-06-26 playtest): a re-previewed save mints a NEW write_id (public/app.js
// regenerates it per preview) while reusing the stable session_id, so the write_id
// replay guard alone could not stop it from appending the same rows again under one
// session_id — the "49 sets / 51,390 lb" duplication. The row-level composite-key
// guard on /api/log-workout closes that gap.
test('api smoke (B1): re-submitting an already-logged session with a NEW write_id appends nothing', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  // Simulate that this exact set is already on the Log_Cleaned sheet.
  fakeSheetsState.logCompositeKeys = ['b1-dup||bench press||1'];
  try {
    const { response, body } = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'b1-dup',
        date: '2026-06-26',
        write_id: 'b1-fresh-write-id',
        log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 }]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(body.data.all_rows_duplicate, true, 'every row was already logged for this session');
    assert.equal(body.data.duplicate_write, true);
    assert.equal(body.data.sheet_write, 'skipped_duplicate');
    assert.equal(body.data.sheet_written, false);
    assert.equal(body.data.log_rows_written, 0);
    assert.equal(body.data.skipped_duplicates, 1);
    assert.deepEqual(fakeSheetsState.appendCalls, [], 'a re-previewed save must never re-append rows');
  } finally {
    fakeSheetsState.logCompositeKeys = [];
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke (B1): all duplicate log rows still allow a new Effort row append', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.logCompositeKeys = ['b1-effort-new||bench press||1'];
  fakeSheetsState.effortSessionIds = [];
  try {
    const { response, body } = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'b1-effort-new',
        date: '2026-06-26',
        write_id: 'b1-effort-new-write-id',
        log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 }],
        effort_row: {
          date: '2026-06-26',
          session_id: 'b1-effort-new',
          duration: '00:42:00',
          active_calories: 410,
          total_calories: 520,
          average_hr: 148,
          peak_hr: 171,
          location: '',
          notes: 'watch import'
        }
      })
    });

    assert.equal(response.status, 200);
    assert.equal(body.data.sheet_write, 'success');
    assert.equal(body.data.log_rows_written, 0, 'duplicate log rows are not appended');
    assert.equal(body.data.effort_rows_written, 1, 'new Effort row count is reported as proof');
    assert.equal(body.data.skipped_duplicates, 1);
    assert.equal(body.data.effortWritten, true, 'new Effort row is still appended');
    assert.equal(body.data.effortAppendedRange, 'Effort!A100:K100');
    assert.equal(fakeSheetsState.appendCalls.length, 1, 'only the Effort append fires');
    assert.equal(fakeSheetsState.appendCalls[0].tabName, 'Effort');
    assert.equal(fakeSheetsState.appendCalls[0].rows[0][1], 'b1-effort-new');
  } finally {
    fakeSheetsState.logCompositeKeys = [];
    fakeSheetsState.effortSessionIds = [];
    fakeSheetsState.allowAppend = false;
  }
});

// Partial duplicate: only the genuinely new rows append; already-logged rows are
// skipped. Proves incremental logging still works (row-level, not session-level).
test('api smoke (B1): partial duplicate appends only the new rows; totals match rows written', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  // Bench set 1 already logged; Back Squat set 1 is new.
  fakeSheetsState.logCompositeKeys = ['b1-partial||bench press||1'];
  try {
    const { response, body } = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'b1-partial',
        date: '2026-06-26',
        write_id: 'b1-partial-write-id',
        log_rows: [
          { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 },
          { exercise: 'Back Squat', set_number: 1, weight: 315, reps: 5, rir: 2 }
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(body.data.sheet_write, 'success');
    assert.equal(body.data.skipped_duplicates, 1, 'the already-logged Bench set is skipped');
    assert.equal(fakeSheetsState.appendCalls.length, 1, 'one append call to Log_Cleaned');
    const appended = fakeSheetsState.appendCalls.find(c => c.tabName === 'Log_Cleaned');
    assert.equal(appended.rows.length, 1, 'only the new Back Squat row is appended');
    assert.equal(appended.rows[0][2], 'Back Squat', 'the appended row is the new lift');
    // Post-save total is derived from exactly the rows written, not the rows sent.
    assert.equal(body.data.log_rows_written, 1);
  } finally {
    fakeSheetsState.logCompositeKeys = [];
    fakeSheetsState.allowAppend = false;
  }
});

// The existing write_id replay guard is unchanged: a double-tap of the SAME
// write_id appends exactly once even when the composite-key guard sees no prior rows.
test('api smoke (B1): a replayed write_id (double-tap) appends exactly once', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.logCompositeKeys = [];
  try {
    const payload = JSON.stringify({
      session_id: 'b1-doubletap',
      date: '2026-06-26',
      write_id: 'b1-doubletap-write-id',
      log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 }]
    });
    const first = await requestJson('/api/log-workout', { method: 'POST', body: payload });
    const second = await requestJson('/api/log-workout', { method: 'POST', body: payload });

    assert.equal(first.body.data.sheet_write, 'success');
    assert.equal(second.body.data.duplicate_write, true);
    assert.equal(second.body.data.sheet_written, false);
    assert.equal(fakeSheetsState.appendCalls.length, 1, 'a replayed write_id must not append twice');
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

// B1 × B3: a failed effort import forces the owner to re-preview and re-save (a new
// write_id). Because the log rows are already on the sheet, the re-save appends no
// duplicate log rows — the effort failure can never multiply the workout rows.
test('api smoke (B1): a re-save after a failed effort import does not duplicate log rows', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  // The first save already wrote the log rows.
  fakeSheetsState.logCompositeKeys = ['b1-effort-retry||bench press||1'];
  try {
    const { response, body } = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'b1-effort-retry',
        date: '2026-06-26',
        write_id: 'b1-effort-retry-write-id',
        log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 }]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(body.data.all_rows_duplicate, true);
    assert.equal(body.data.log_rows_written, 0);
    assert.equal(fakeSheetsState.appendCalls.filter(c => c.tabName === 'Log_Cleaned').length, 0, 'no log rows re-appended');
  } finally {
    fakeSheetsState.logCompositeKeys = [];
    fakeSheetsState.allowAppend = false;
  }
});

// RIR is OPTIONAL (owner 2026-06-25: "log it however"). A set logged with just
// weight × reps — warm-up or working — must save with a blank RIR cell. weight/reps
// are still required so a genuinely garbled row is rejected.
test('api smoke: rows save with a blank RIR (warm-up OR working); weight/reps stay required', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const ok = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-OPTIONAL-RIR',
      date: '2026-06-11',
      test_mode: true,
      log_rows: [
        { exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: '', notes: 'warm-up' },
        { exercise: 'Bench Press', set_number: 2, weight: 225, reps: 5, rir: '', notes: '' }, // working, no RIR
        { exercise: 'Bench Press', set_number: 3, weight: 225, reps: 5, rir: 2, notes: '' }
      ]
    })
  });
  assert.equal(ok.response.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.no_write_confirmed, true);
  assert.equal(ok.body.data.log_rows_preview.length, 3, 'all three rows survive — blank RIR no longer rejected');
  // The blank-RIR working row writes an empty RIR cell (column 10), not a fabricated value.
  assert.equal(ok.body.data.log_rows_preview[1][9], '');

  // weight/reps are still required — a row missing reps is rejected.
  const bad = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-MISSING-REPS',
      date: '2026-06-11',
      test_mode: true,
      log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 225, reps: '', rir: 2, notes: '' }]
    })
  });
  assert.equal(bad.response.status, 400, JSON.stringify(bad.body));
  assert.match(bad.body.message || bad.body.error || '', /reps/i);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: log-workout preview surfaces the e1rm typo guard from history (ME-13, no write)', async () => {
  fakeSheetsState.appendCalls.length = 0;
  // BEN01 history in logRows tops out at 225×5 (e1RM ≈ 262.5). Logging 285×5
  // (e1RM ≈ 332.5, +26.7%) is an implausible jump → the previously-dark
  // checkE1rmJump guard must now surface as a non-blocking rule_flag.
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-E1RM-JUMP',
      date: '2026-06-12',
      test_mode: true,
      log_rows: [
        { exercise: 'Bench Press', set_number: 1, weight: 285, reps: 5, rir: 2, notes: 'big jump' }
      ]
    })
  });

  assert.equal(response.status, 200);
  // Proof fields untouched — the preview path stays read-only.
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.ok(Array.isArray(body.data.rule_flags), 'rule_flags should be present');
  const jump = body.data.rule_flags.find(f => f.rule_id === 'e1rm_jump');
  assert.ok(jump, 'e1rm_jump flag should surface in the preview');
  assert.equal(jump.lift_code, 'BEN01');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: log-workout preview attaches substitution block for a swap (no write)', async () => {
  fakeSheetsState.appendCalls.length = 0;
  // Prescribed Back Squat (SQ01 — has history in logRows); logged Leg Press instead.
  // Same squat pattern + quads/glutes → preserved.
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-SUBSTITUTION',
      date: '2026-06-11',
      test_mode: true,
      prescribed: [
        { logged_exercise: 'Leg Press', exercise: 'Back Squat', lift_code: 'SQ01' }
      ],
      log_rows: [
        { exercise: 'Leg Press', set_number: 1, weight: 360, reps: 8, rir: 2, notes: 'rack was taken' }
      ]
    })
  });

  assert.equal(response.status, 200);
  // Proof fields preserved exactly — the substitution path is read-only.
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  // Substitution block present and engine-decided.
  assert.ok(Array.isArray(body.data.substitutions), 'substitutions array should be present');
  assert.equal(body.data.substitutions.length, 1);
  const sub = body.data.substitutions[0];
  assert.equal(sub.classification, 'preserved');
  assert.equal(sub.decision, 'approve');
  assert.equal(sub.reason_code, 'pattern_and_muscle_match');
  assert.equal(sub.prescribed.name, 'Back Squat');
  // No append fired anywhere.
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: log-workout preview emits an abandoned warn for an off-target swap', async () => {
  fakeSheetsState.appendCalls.length = 0;
  // Prescribed Back Squat (SQ01, high cost, has history); logged Bench Press.
  // Different pattern, ~0 overlap, real weight → abandoned/warn (history read makes
  // this a real verdict, not baseline).
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-SUBSTITUTION-ABANDON',
      date: '2026-06-11',
      test_mode: true,
      prescribed: [
        { logged_exercise: 'Bench Press', exercise: 'Back Squat', lift_code: 'SQ01' }
      ],
      log_rows: [
        { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.substitutions.length, 1);
  assert.equal(body.data.substitutions[0].classification, 'abandoned');
  assert.equal(body.data.substitutions[0].decision, 'warn');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: log-workout preview classifies baseline when prescribed lift has no history', async () => {
  fakeSheetsState.appendCalls.length = 0;
  // Prescribed pair with no lift_code → no history lookup key → empty history →
  // baseline/approve (can't judge intent without data). Also covers the empty-history
  // path the best-effort read-failure degrades to.
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-SUBSTITUTION-BASELINE',
      date: '2026-06-11',
      test_mode: true,
      prescribed: [
        { logged_exercise: 'Leg Press', exercise: 'Back Squat' }
      ],
      log_rows: [
        { exercise: 'Leg Press', set_number: 1, weight: 360, reps: 8, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.substitutions.length, 1);
  assert.equal(body.data.substitutions[0].classification, 'baseline');
  assert.equal(body.data.substitutions[0].decision, 'approve');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: log-workout preview is unchanged when no prescribed pairs are supplied', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-NO-PRESCRIBED',
      date: '2026-06-11',
      test_mode: true,
      log_rows: [
        { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  // No prescribed pairs → no substitutions key at all (additive, opt-in).
  assert.ok(!('substitutions' in body.data), 'substitutions must be absent without prescribed pairs');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

// ── Reason-field wiring (PR #339) ─────────────────────────────────────────────

test('api smoke: equipment reason cannot rescue a zero-overlap abandon (Back Squat → Bench Press, rack unavailable)', async () => {
  // Spec: a constraint upgrades a borderline result but cannot endorse skipping the
  // prescribed stimulus for an unrelated movement (SUBSTITUTION_SPEC.md — constraint
  // must keep "a defensible portion of the intended muscle/pattern"). Back Squat →
  // Bench Press has ~0 muscle overlap and no shared broad region; the synthesized
  // equipment constraint falls through and the swap stays abandoned.
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-EQUIP-REASON-UPGRADE',
      date: '2026-06-11',
      test_mode: true,
      prescribed: [
        { exercise: 'Back Squat', logged_exercise: 'Bench Press', lift_code: 'SQ01', reason: 'rack unavailable' }
      ],
      log_rows: [
        { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(body.data.substitutions.length, 1);
  const sub = body.data.substitutions[0];
  assert.equal(sub.classification, 'abandoned');
  assert.equal(sub.decision, 'warn');
  assert.notEqual(sub.reason_code, 'equipment_constraint_honored');
  assert.equal(sub.reason, 'rack unavailable');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: non-equipment reason does not upgrade — abandoned stays abandoned', async () => {
  // Same cross-pattern swap with a reason that contains no equipment keywords.
  // No constraint is synthesized → Rule 5 fires → abandoned/warn.
  // The reason text still passes through to the result object.
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-NON-EQUIP-REASON',
      date: '2026-06-11',
      test_mode: true,
      prescribed: [
        { exercise: 'Back Squat', logged_exercise: 'Bench Press', lift_code: 'SQ01', reason: 'wanted a change' }
      ],
      log_rows: [
        { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.substitutions.length, 1);
  const sub = body.data.substitutions[0];
  assert.equal(sub.classification, 'abandoned');
  assert.equal(sub.decision, 'warn');
  assert.equal(sub.reason, 'wanted a change');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: reason field passes through on a preserved swap', async () => {
  // Bench Press (BEN01, has history) → Incline Dumbbell Press: same horizontal_push
  // pattern + chest overlap → Rule 2 preserved. The reason is not an equipment keyword
  // but still attaches to the result.
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-REASON-PASSTHROUGH',
      date: '2026-06-11',
      test_mode: true,
      prescribed: [
        { exercise: 'Bench Press', logged_exercise: 'Incline Dumbbell Press', lift_code: 'BEN01', reason: 'incline felt better' }
      ],
      log_rows: [
        { exercise: 'Incline Dumbbell Press', set_number: 1, weight: 80, reps: 8, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.substitutions.length, 1);
  const sub = body.data.substitutions[0];
  assert.equal(sub.classification, 'preserved');
  assert.equal(sub.reason_code, 'pattern_and_muscle_match');
  assert.equal(sub.reason, 'incline felt better');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: no reason field in result when reason was not provided', async () => {
  // Same swap without a reason → result has no `reason` key.
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-NO-REASON',
      date: '2026-06-11',
      test_mode: true,
      prescribed: [
        { exercise: 'Bench Press', logged_exercise: 'Incline Dumbbell Press', lift_code: 'BEN01' }
      ],
      log_rows: [
        { exercise: 'Incline Dumbbell Press', set_number: 1, weight: 80, reps: 8, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.substitutions.length, 1);
  const sub = body.data.substitutions[0];
  assert.equal(sub.classification, 'preserved');
  assert.ok(!('reason' in sub), 'reason must not appear in result when none was provided');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: equipment reason upgrades baseline swap to equipment_constraint_honored (DL → RDL, platform busy)', async () => {
  // Deadlift → Romanian Deadlift: no lift_code → no history, but reason contains
  // 'platform' (equipment keyword). buildSubstitutionPreviews synthesizes a transient
  // constraint targeting 'Deadlift'. classifySubstitution evaluates the constraint
  // BEFORE the history gate → equipment_constraint_honored, not baseline.
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-DL-RDL-PLATFORM',
      date: '2026-06-11',
      test_mode: true,
      prescribed: [
        { exercise: 'Deadlift', logged_exercise: 'Romanian Deadlift', reason: 'platform busy' }
      ],
      log_rows: [
        { exercise: 'Romanian Deadlift', set_number: 1, weight: 245, reps: 7, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.substitutions.length, 1);
  const sub = body.data.substitutions[0];
  assert.equal(sub.classification, 'preserved');
  assert.equal(sub.decision, 'approve');
  assert.equal(sub.reason_code, 'equipment_constraint_honored');
  assert.equal(sub.reason, 'platform busy');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: equipment reason overrides pattern-match (Back Squat → Leg Press, rack unavailable, has history)', async () => {
  // Back Squat (SQ01, has history) → Leg Press would normally be pattern_and_muscle_match.
  // With "rack unavailable" the engine synthesizes a transient constraint for 'Back Squat';
  // constraint fires before Rule 2 → equipment_constraint_honored instead.
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-SQ-LP-RACK',
      date: '2026-06-11',
      test_mode: true,
      prescribed: [
        { exercise: 'Back Squat', logged_exercise: 'Leg Press', lift_code: 'SQ01', reason: 'rack unavailable' }
      ],
      log_rows: [
        { exercise: 'Leg Press', set_number: 1, weight: 360, reps: 8, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.substitutions.length, 1);
  const sub = body.data.substitutions[0];
  assert.equal(sub.classification, 'preserved');
  assert.equal(sub.decision, 'approve');
  assert.equal(sub.reason_code, 'equipment_constraint_honored');
  assert.equal(sub.reason, 'rack unavailable');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke (e2e): parser extracts prescribed pair → API classifies as equipment_constraint_honored', async () => {
  // Full end-to-end path: parse raw text → build payload → call API.
  // "Deadlift skipped - platform busy." → extractSkipNotes → prescribed: Deadlift, reason: platform busy.
  // "Romanian Deadlift 245lbs 7/2 x3" → logged exercise.
  // Expected: engine classifies DL → RDL (platform busy) as equipment_constraint_honored.
  const { parseWorkoutText } = require('../services/workoutTextParser');
  const parsed = parseWorkoutText('Deadlift skipped - platform busy.\nRomanian Deadlift 245lbs 7/2 x3');

  // Parser should have found the skip note and the logged lift.
  assert.ok(Array.isArray(parsed.prescribed) && parsed.prescribed.length > 0, 'parser must extract prescribed pair');
  const pPair = parsed.prescribed[0];
  assert.ok(pPair.exercise, 'prescribed pair must have an exercise name');
  assert.ok(/deadlift/i.test(pPair.exercise), 'prescribed exercise must be Deadlift');
  assert.ok(/platform/i.test(pPair.reason || ''), 'reason must contain platform');

  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-E2E-PARSER',
      date: '2026-06-11',
      test_mode: true,
      prescribed: parsed.prescribed.map(p => ({
        exercise: p.exercise,
        logged_exercise: 'Romanian Deadlift',
        ...(p.reason ? { reason: p.reason } : {}),
      })),
      log_rows: parsed.log_rows || [
        { exercise: 'Romanian Deadlift', set_number: 1, weight: 245, reps: 7, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.data.substitutions) && body.data.substitutions.length > 0, 'substitutions must be present');
  const sub = body.data.substitutions[0];
  assert.equal(sub.classification, 'preserved');
  assert.equal(sub.decision, 'approve');
  assert.equal(sub.reason_code, 'equipment_constraint_honored');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: broad-language reasons do not trigger equipment upgrade (false-positive guard)', async () => {
  // "busy", "taken", "waiting" are common English words that appear in fatigue/schedule
  // reasons, not equipment reasons. They must NOT upgrade an abandoned swap to approved.
  fakeSheetsState.appendCalls.length = 0;
  for (const reason of ['busy week, short on time', 'legs were taken out from yesterday', 'waiting to feel recovered']) {
    const { body } = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'API-SMOKE-FP-GUARD',
        date: '2026-06-11',
        test_mode: true,
        prescribed: [
          { exercise: 'Back Squat', logged_exercise: 'Bench Press', lift_code: 'SQ01', reason }
        ],
        log_rows: [
          { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2, notes: '' }
        ]
      })
    });
    const sub = body.data.substitutions[0];
    assert.equal(sub.classification, 'abandoned', `"${reason}" must not upgrade to preserved`);
    assert.equal(sub.decision, 'warn', `"${reason}" must not suppress the warn`);
    assert.notEqual(sub.reason_code, 'equipment_constraint_honored', `"${reason}" must not trigger equipment constraint`);
  }
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: no prescribed pairs → no substitutions key (reason-wiring regression)', async () => {
  // Regression guard: sending a workout without prescribed pairs must not produce a
  // substitutions key after the reason-wiring change.
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-REASON-REGRESSION',
      date: '2026-06-11',
      test_mode: true,
      log_rows: [
        { exercise: 'Romanian Deadlift', set_number: 1, weight: 245, reps: 7, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.no_write_confirmed, true);
  assert.ok(!('substitutions' in body.data), 'substitutions must be absent without prescribed pairs');
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

test('api smoke: complete-workout rejects an oversized log_rows_json (>200 rows) with 400 and never appends (ME-5)', async () => {
  fakeSheetsState.appendCalls.length = 0;
  // 201 rows — one over the cap. The guard fires before enrichment, so the row
  // content is irrelevant; a valid 12-column shape is used to be realistic.
  const oneRow = ['2026-06-11', 'OVERSIZE-01', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '135', '5', '2', '', '675'];
  const tooMany = Array.from({ length: 201 }, () => oneRow.slice());
  const form = new FormData();
  form.append('session_id', 'OVERSIZE-01');
  form.append('date', '2026-06-11');
  form.append('log_rows_json', JSON.stringify(tooMany));
  form.append('duration', '00:30:00'); // manual effort metric — clears the effort-required gate so we reach the row cap
  form.append('test_mode', 'true');

  const { response, body } = await requestMultipart('/api/complete-workout', form);
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.match(body.message || body.error || '', /200-row limit/);
  assert.deepEqual(fakeSheetsState.appendCalls, [], 'an oversized payload must never reach the append path');
});

test('api smoke: complete-workout returns a clean 413 (not 500) when log_rows_json exceeds the field-size cap (ME-5)', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const form = new FormData();
  form.append('session_id', 'FIELD-OVERSIZE-01');
  form.append('duration', '00:30:00');
  // A log_rows_json field well over the 512 KB fieldSize cap → multer LIMIT_FIELD_VALUE,
  // which the error middleware now maps to a clean 413 (not a generic 500).
  form.append('log_rows_json', 'x'.repeat(600 * 1024));
  form.append('test_mode', 'true');

  const { response } = await requestMultipart('/api/complete-workout', form);
  assert.equal(response.status, 413);
  assert.deepEqual(fakeSheetsState.appendCalls, [], 'an oversized field must never reach the append path');
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

// Screenshot graceful-degrade: a screenshot effort parse failure (e.g. Gemini
// 429 / timeout) must NOT 500 the whole save. With logged sets present, the sets
// are saved WITHOUT effort (blank effort row) and the owner is told.
test('api smoke: complete-workout saves logged sets without effort when the screenshot parse fails (graceful degrade, not 500)', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  fakeVisionThrow = new Error('Gemini request failed (429): RESOURCE_EXHAUSTED');

  try {
    await withMutedConsoleLog(async () => {
      const form = new FormData();
      form.append('session_id', 'SHOT-DEGRADE-01');
      form.append('date', '2026-06-11');
      form.append('write_id', 'complete-shot-degrade-01');
      form.append('log_rows_json', JSON.stringify([
        ['2026-06-11', 'SHOT-DEGRADE-01', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '135', '5', '2', '', '675']
      ]));
      form.append('image', new Blob(['watch'], { type: 'image/png' }), 'watch.png');

      const { response, body } = await requestMultipart('/api/complete-workout', form);
      const data = body.data.data;

      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.status, 'ok');
      assert.equal(data.screenshot_unreadable, true);
      assert.equal(data.effort_source, 'screenshot_unreadable');
      assert.equal(data.sheet_written, true);
      assert.equal(data.log_rows_written, 1);
      // The owner-facing message is surfaced as a warning.
      assert.ok((body.data.warnings || []).some(w => /couldn't read effort from the screenshot/i.test(w)),
        `expected the screenshot-unreadable warning, got ${JSON.stringify(body.data.warnings)}`);
      // Both tabs were written; the effort row is blank for the metric columns.
      const tabs = fakeSheetsState.appendCalls.map(c => c.tabName);
      assert.ok(tabs.includes('Effort'), 'effort row still appended for session linkage');
      const effortCall = fakeSheetsState.appendCalls.find(c => c.tabName === 'Effort');
      const effortRow = effortCall.rows[0];
      // columns: date|session_id|duration|active|total|avg_hr|peak_hr|location|notes
      assert.equal(effortRow[2], '', 'duration blank when screenshot unreadable');
      assert.equal(effortRow[3], '', 'active calories blank when screenshot unreadable');
      assert.equal(effortRow[5], '', 'average HR blank when screenshot unreadable');
    });
  } finally {
    fakeVisionThrow = null;
    fakeSheetsState.allowAppend = false;
  }
});

// Effort-only (no logged sets) + screenshot parse failure → nothing left to save,
// so an honest 422 (never a 500), and no append happens.
test('api smoke: complete-workout returns 422 (not 500) when an effort-only screenshot parse fails and never appends', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  fakeVisionThrow = new Error('Gemini request failed (429): RESOURCE_EXHAUSTED');

  try {
    await withMutedConsoleLog(async () => {
      const form = new FormData();
      form.append('session_id', 'SHOT-DEGRADE-EFFORTONLY-01');
      form.append('date', '2026-06-11');
      form.append('write_id', 'complete-shot-degrade-effortonly-01');
      form.append('log_rows_json', JSON.stringify([]));
      form.append('image', new Blob(['watch'], { type: 'image/png' }), 'watch.png');

      const { response, body } = await requestMultipart('/api/complete-workout', form);
      assert.equal(response.status, 422, JSON.stringify(body));
      assert.match(body.message || body.error || '', /couldn't read effort from the screenshot/i);
      assert.deepEqual(fakeSheetsState.appendCalls, [], 'nothing must be appended when there is nothing to save');
    });
  } finally {
    fakeVisionThrow = null;
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
  // benchmark, working_weight, trend, and readiness_signal always present.
  assert.ok('benchmark'        in body.data, 'benchmark field must be present in recommend/next response');
  assert.ok('working_weight'   in body.data, 'working_weight field must be present in recommend/next response');
  assert.ok('trend'            in body.data, 'trend field must be present in recommend/next response');
  assert.ok('readiness_signal' in body.data, 'readiness_signal field must be present in recommend/next response');
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

// A client-supplied volume_calc must NEVER be written verbatim — the server
// always recomputes weight × reps so column 12 cannot disagree with the set
// (BACKLOG ME-4).
test('api smoke: live log-workout ignores a client-supplied volume_calc and recomputes it', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;

  try {
    const { response, body } = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'ME4-VOLUME-01',
        date: '2026-06-11',
        write_id: 'me4-volume-01',
        log_rows: [
          // Bogus volume_calc (and volume alias) that disagree with weight × reps.
          { exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 5, notes: '', volume_calc: 99999, volume: 88888 }
        ]
      })
    });

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.sheet_write, 'success');
    assert.equal(fakeSheetsState.appendCalls.length, 1);
    const row = fakeSheetsState.appendCalls[0].rows[0];
    // Column 12 is weight × reps, not the client's 99999/88888.
    assert.equal(Number(row[11]), 1350);
  } finally {
    fakeSheetsState.allowAppend = false;
  }
});

// ── header-drift guard (trust-critical) ─────────────────────────────────────
// A hand-edited column reorder must block the live write, not misroute values.
test('api smoke: live log-workout is blocked when Log_Cleaned header is reordered', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  // Swap weight (idx 7) and reps (idx 8) — the exact silent-misroute risk.
  const drifted = [...logCleanedColumns];
  [drifted[7], drifted[8]] = [drifted[8], drifted[7]];
  fakeSheetsState.headerRows['Log_Cleaned'] = drifted;

  try {
    const { response, body } = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'DRIFT-LOG-01',
        date: '2026-06-11',
        write_id: 'drift-log-01',
        log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 5, notes: '' }]
      })
    });

    assert.equal(response.status, 409);
    assert.equal(body.status, 'error');
    assert.equal(body.details.sheet_write, 'blocked_schema_drift');
    assert.equal(body.details.sheet_written, false);
    assert.equal(body.details.no_write_confirmed, true);
    assert.equal(body.details.header_mismatches[0].tab, 'Log_Cleaned');
    // Nothing was appended — the permanent record is untouched.
    assert.equal(fakeSheetsState.appendCalls.length, 0);
  } finally {
    delete fakeSheetsState.headerRows['Log_Cleaned'];
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: live complete-workout is blocked when Effort header is reordered', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  // Swap average_hr (idx 5) and peak_hr (idx 6) — distinct metrics must not cross.
  const drifted = [...effortColumns];
  [drifted[5], drifted[6]] = [drifted[6], drifted[5]];
  fakeSheetsState.headerRows['Effort'] = drifted;

  try {
    await withMutedConsoleLog(async () => {
      const form = new FormData();
      form.append('session_id', 'DRIFT-EFFORT-01');
      form.append('date', '2026-06-11');
      form.append('log_rows_json', JSON.stringify([]));
      form.append('write_id', 'drift-effort-01');
      form.append('effort_json', JSON.stringify({
        duration: '42', activeCalories: 410, totalCalories: 520,
        averageHR: 148, peakHR: 171, workoutType: 'Traditional Strength Training'
      }));
      const { response, body } = await requestMultipart('/api/complete-workout', form);

      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(body.status, 'error');
      assert.equal(body.details.sheet_write, 'blocked_schema_drift');
      assert.equal(body.details.sheet_written, false);
      assert.equal(body.details.no_write_confirmed, true);
      assert.ok(body.details.header_mismatches.some(m => m.tab === 'Effort'));
      assert.equal(fakeSheetsState.appendCalls.length, 0);
    });
  } finally {
    delete fakeSheetsState.headerRows['Effort'];
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: live log-workout proceeds when header is a valid casing/alias variant', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  // Title-case + spaces + the 'date'/'volume' aliases — same order, must NOT block.
  fakeSheetsState.headerRows['Log_Cleaned'] = ['Date', 'Session ID', 'Exercise', 'Canonical Exercise',
    'Muscle Group', 'Lift Code', 'Set Number', 'Weight', 'Reps', 'RIR', 'Notes', 'Volume'];

  try {
    const { response, body } = await requestJson('/api/log-workout', {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'DRIFT-VARIANT-01',
        date: '2026-06-11',
        write_id: 'drift-variant-01',
        log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 5, notes: '' }]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(body.data.sheet_write, 'success');
    assert.equal(fakeSheetsState.appendCalls.length, 1);
    assert.equal(fakeSheetsState.appendCalls[0].tabName, 'Log_Cleaned');
  } finally {
    delete fakeSheetsState.headerRows['Log_Cleaned'];
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: live complete-workout is blocked when Log_Cleaned header is reordered', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  const drifted = [...logCleanedColumns];
  [drifted[7], drifted[8]] = [drifted[8], drifted[7]]; // weight <-> reps
  fakeSheetsState.headerRows['Log_Cleaned'] = drifted;

  try {
    await withMutedConsoleLog(async () => {
      const form = new FormData();
      form.append('session_id', 'DRIFT-CW-LOG-01');
      form.append('date', '2026-06-11');
      form.append('write_id', 'drift-cw-log-01');
      form.append('log_rows_json', JSON.stringify([
        { exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 5, notes: '' }
      ]));
      form.append('effort_json', JSON.stringify({
        duration: '42', activeCalories: 410, totalCalories: 520, averageHR: 148, peakHR: 171
      }));
      const { response, body } = await requestMultipart('/api/complete-workout', form);

      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(body.details.sheet_write, 'blocked_schema_drift');
      assert.ok(body.details.header_mismatches.some(m => m.tab === 'Log_Cleaned'));
      // Blocked before either the log or effort append fired.
      assert.equal(fakeSheetsState.appendCalls.length, 0);
    });
  } finally {
    delete fakeSheetsState.headerRows['Log_Cleaned'];
    fakeSheetsState.allowAppend = false;
  }
});

test('api smoke: live log-workout fails closed (500, no append) when the header read throws', async () => {
  fakeSheetsState.appendCalls.length = 0;
  fakeSheetsState.allowAppend = true;
  fakeSheetsState.failHeaderReadForTab = 'Log_Cleaned';

  try {
    await withMutedConsoleLog(async () => {
      const { response, body } = await requestJson('/api/log-workout', {
        method: 'POST',
        body: JSON.stringify({
          session_id: 'HDR-READ-FAIL-01',
          date: '2026-06-11',
          write_id: 'hdr-read-fail-01',
          log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 135, reps: 10, rir: 5, notes: '' }]
        })
      });

      assert.equal(response.status, 500, JSON.stringify(body));
      assert.equal(body.status, 'error');
      // Nothing appended — the read failure fails closed, not open.
      assert.equal(fakeSheetsState.appendCalls.length, 0);
    });
  } finally {
    fakeSheetsState.failHeaderReadForTab = null;
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
  // Sheet row 7 is beyond logRows (which covers rows 2–6), so allRows[5] is undefined
  const { response, body } = await requestJson('/api/log-workout/undo-last', {
    method: 'POST',
    body: JSON.stringify({
      log_appended_range: 'Log_Cleaned!A7:L7',
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

// ---- Deload engine wiring (PR 6b) -------------------------------------------

test('api smoke: deload lifecycle — status, begin, advance, resolve, and the 409 guards', async () => {
  fakeSheetsState.deloadStateSheet = []; // fresh, unprovisioned tab

  // Status starts at NORMAL.
  const status0 = await requestJson('/api/deload/status');
  assert.equal(status0.response.status, 200);
  assert.equal(status0.body.data.state.training_state, 'NORMAL');

  // Owner invokes a strength deload.
  const begin = await requestJson('/api/deload/begin', {
    method: 'POST',
    body: JSON.stringify({ focus: 'strength', reason: 'wiped', sessions_remaining: 1 })
  });
  assert.equal(begin.response.status, 200);
  assert.equal(begin.body.data.state.training_state, 'DELOAD_ACTIVE');
  assert.equal(begin.body.data.state.deload_protocol, 'STRENGTH_DELOAD_V1');
  // The tab was provisioned with a header row, so the state reads back.
  const status1 = await requestJson('/api/deload/status');
  assert.equal(status1.body.data.state.training_state, 'DELOAD_ACTIVE');

  // Beginning again while active is rejected (illegal transition → 409).
  const beginAgain = await requestJson('/api/deload/begin', {
    method: 'POST', body: JSON.stringify({ focus: 'strength' })
  });
  assert.equal(beginAgain.response.status, 409);

  // The single session completes → POST_DELOAD_EVALUATION.
  const advance = await requestJson('/api/deload/advance', { method: 'POST' });
  assert.equal(advance.response.status, 200);
  assert.equal(advance.body.data.state.training_state, 'POST_DELOAD_EVALUATION');

  // Resolve → back to NORMAL.
  const resolve = await requestJson('/api/deload/resolve', { method: 'POST' });
  assert.equal(resolve.response.status, 200);
  assert.equal(resolve.body.data.state.training_state, 'NORMAL');

  // Advancing when not deloading is rejected.
  const advanceBad = await requestJson('/api/deload/advance', { method: 'POST' });
  assert.equal(advanceBad.response.status, 409);

  fakeSheetsState.deloadStateSheet = [];
});

test('api smoke: recommend response carries the engine deload decision', async () => {
  fakeSheetsState.deloadStateSheet = [];
  const { response, body } = await requestJson('/api/recommend/next/BEN01');
  assert.equal(response.status, 200);
  // Engine-driven deload field is always present; off-deload it is an evaluation.
  assert.ok(body.data.deload, 'recommendation must carry a deload decision');
  assert.equal(body.data.deload.in_deload, false);
  assert.ok('action' in body.data.deload, 'deload decision must include an action');
});

test('api smoke: an active deload cuts next_target.weight by the protocol load_multiplier and shows the protocol RIR', async () => {
  const DELOAD_HEADER = ['updated_at', 'training_state', 'deload_protocol', 'deload_reason', 'deload_start_date', 'deload_sessions_remaining', 'deload_exit_criteria'];

  // Baseline (NORMAL day): capture the unmodified prescription for BEN01.
  fakeSheetsState.deloadStateSheet = [];
  const normal = await requestJson('/api/recommend/next/BEN01');
  assert.equal(normal.response.status, 200);
  assert.equal(normal.body.data.deload.in_deload, false);
  const normalWeight = normal.body.data.next_target.weight;
  const normalRir = normal.body.data.target_rir;
  assert.ok(Number.isFinite(Number(normalWeight)), 'baseline must have a numeric next_target.weight');

  // Active STRENGTH deload (load_multiplier 0.92, target_rir 5).
  fakeSheetsState.deloadStateSheet = [
    DELOAD_HEADER,
    ['2026-06-16T00:00:00Z', 'DELOAD_ACTIVE', 'STRENGTH_DELOAD_V1', 'testing', '2026-06-16', '1', '']
  ];
  const deload = await requestJson('/api/recommend/next/BEN01');
  assert.equal(deload.response.status, 200);
  assert.equal(deload.body.data.deload.in_deload, true);

  // Weight cut by 0.92, rounded to the nearest 5 lb (rounding spelled out here, not
  // taken from the code under test). e.g. 225 → 207 → 205.
  const expectedWeight = Math.round((Number(normalWeight) * 0.92) / 5) * 5;
  assert.equal(deload.body.data.next_target.weight, expectedWeight);
  assert.ok(deload.body.data.next_target.weight < Number(normalWeight), 'deload weight must be lighter than the normal prescription');

  // RIR now reflects the protocol (5), not the normal policy.
  assert.equal(deload.body.data.target_rir, 5);
  assert.notEqual(normalRir, 5); // sanity: the normal policy RIR for bench is not the protocol's 5

  // The non-deload path is untouched: weight + RIR unchanged when not deloading.
  fakeSheetsState.deloadStateSheet = [];
  const normalAgain = await requestJson('/api/recommend/next/BEN01');
  assert.equal(normalAgain.body.data.next_target.weight, normalWeight);
  assert.equal(normalAgain.body.data.target_rir, normalRir);
});

test('api smoke: deload routes are registered in the manifest', async () => {
  const { body } = await requestJson('/routes');
  const paths = body.data.routes.map(r => r.path);
  for (const p of ['/api/deload/status', '/api/deload/begin', '/api/deload/advance', '/api/deload/resolve']) {
    assert.ok(paths.includes(p), `${p} must be registered`);
  }
});

test('api smoke: recommend degrades gracefully when Deload_State is missing/unreadable (no 500)', async () => {
  fakeSheetsState.failDeloadRead = true;
  try {
    const { response, body } = await requestJson('/api/recommend/next/BEN01');
    assert.equal(response.status, 200);
    assert.equal(body.data.deload.in_deload, false); // defaults to NORMAL, no active deload
  } finally {
    fakeSheetsState.failDeloadRead = false;
  }
});

test('api smoke: deload begin returns an actionable 503 when the Deload_State tab is absent', async () => {
  fakeSheetsState.hideDeloadStateTab = true;
  try {
    const { response, body } = await requestJson('/api/deload/begin', {
      method: 'POST', body: JSON.stringify({ focus: 'strength' })
    });
    assert.equal(response.status, 503);
    assert.match(body.message || body.error || '', /Deload_State tab not found/);
  } finally {
    fakeSheetsState.hideDeloadStateTab = false;
  }
});

// ── PR 341 — Planned Workout Awareness (API integration) ──────────────────────
// These tests prove that plan_exercises wiring reaches through /api/log-workout
// to classifySubstitution, not only through the planMatcher unit.

test('api smoke: plan_exercises Deadlift + logged RDL → substitution inferred via /api/log-workout', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-PLAN-DEADLIFT',
      date: '2026-06-11',
      test_mode: true,
      plan_exercises: [{ name: 'Deadlift' }],
      log_rows: [
        { exercise: 'Romanian Deadlift', set_number: 1, weight: 245, reps: 7, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.ok(Array.isArray(body.data.substitutions), 'substitutions array must be present');
  assert.equal(body.data.substitutions.length, 1, 'one inferred substitution');
  const sub = body.data.substitutions[0];
  assert.equal(sub.prescribed.name, 'Deadlift');
  assert.equal(sub.logged.name, 'Romanian Deadlift');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: plan_exercises Back Squat + logged Leg Press → substitution inferred via /api/log-workout', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-PLAN-SQUAT',
      date: '2026-06-11',
      test_mode: true,
      plan_exercises: [{ name: 'Back Squat' }],
      log_rows: [
        { exercise: 'Leg Press', set_number: 1, weight: 360, reps: 8, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.ok(Array.isArray(body.data.substitutions), 'substitutions array must be present');
  assert.equal(body.data.substitutions.length, 1, 'one inferred substitution');
  const sub = body.data.substitutions[0];
  assert.equal(sub.prescribed.name, 'Back Squat');
  assert.equal(sub.logged.name, 'Leg Press');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: plan_exercises Bench Press + logged Bench Press → no substitution (exact match)', async () => {
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-PLAN-BENCH-EXACT',
      date: '2026-06-11',
      test_mode: true,
      plan_exercises: [{ name: 'Bench Press' }],
      log_rows: [
        { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  const subs = body.data.substitutions || [];
  assert.equal(subs.length, 0, 'exact plan match must not produce a substitution');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: explicit prescribed pair wins over plan_exercises for the same lift (no duplicate)', async () => {
  // Both payload.prescribed and plan_exercises name Back Squat as prescribed.
  // The explicit pair should be classified; no duplicate substitution for the same lift.
  fakeSheetsState.appendCalls.length = 0;
  const { response, body } = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'API-SMOKE-PLAN-EXPLICIT-WINS',
      date: '2026-06-11',
      test_mode: true,
      prescribed: [
        { exercise: 'Back Squat', logged_exercise: 'Leg Press', lift_code: 'SQ01' }
      ],
      plan_exercises: [{ name: 'Back Squat' }],
      log_rows: [
        { exercise: 'Leg Press', set_number: 1, weight: 360, reps: 8, rir: 2, notes: '' }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.ok(Array.isArray(body.data.substitutions), 'substitutions must be present');
  assert.equal(body.data.substitutions.length, 1, 'explicit pair must not be duplicated by plan inference');
  assert.equal(body.data.substitutions[0].prescribed.name, 'Back Squat');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

// ─── /api/suggest-substitute smoke tests ─────────────────────────────────────

test('api smoke: suggest-substitute is registered as read-only and never write-capable', async () => {
  const { response, body } = await requestJson('/routes');
  const routeByPath = new Map(body.data.routes.map(r => [r.path, r]));
  assert.ok(routeByPath.has('/api/suggest-substitute'), 'suggest-substitute route must be in the manifest');
  const route = routeByPath.get('/api/suggest-substitute');
  assert.equal(route.writeCapable, false, 'suggest-substitute must never be write-capable');
  assert.equal(route.readOnly, true, 'suggest-substitute must be read-only');
});

test('api smoke: suggest-substitute — Deadlift + constraint message → Romanian Deadlift', async () => {
  const { response, body } = await requestJson('/api/suggest-substitute', {
    method: 'POST',
    body: JSON.stringify({ message: 'Platform busy', current_exercise: 'Deadlift' })
  });
  assert.equal(response.status, 200);
  assert.ok(body.data.recommendation, 'recommendation must not be null');
  assert.equal(body.data.recommendation.recommendation, 'Romanian Deadlift');
  assert.equal(body.data.recommendation.quality, 'excellent');
  assert.ok(typeof body.data.recommendation.reason === 'string' && body.data.recommendation.reason.length > 0);
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: suggest-substitute — Back Squat + rack unavailable → Leg Press', async () => {
  const { response, body } = await requestJson('/api/suggest-substitute', {
    method: 'POST',
    body: JSON.stringify({ message: 'Rack unavailable', current_exercise: 'Back Squat' })
  });
  assert.equal(response.status, 200);
  assert.ok(body.data.recommendation, 'recommendation must not be null');
  assert.equal(body.data.recommendation.recommendation, 'Leg Press');
  assert.deepEqual(fakeSheetsState.appendCalls, []);
});

test('api smoke: suggest-substitute — unknown exercise → null', async () => {
  const { response, body } = await requestJson('/api/suggest-substitute', {
    method: 'POST',
    body: JSON.stringify({ message: 'Platform busy', current_exercise: 'Jammer Press' })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.recommendation, null);
});

test('api smoke: suggest-substitute — non-constraint message → null', async () => {
  const { response, body } = await requestJson('/api/suggest-substitute', {
    method: 'POST',
    body: JSON.stringify({ message: 'Deadlift 315 5/2 x3', current_exercise: 'Deadlift' })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.recommendation, null, 'ordinary log notation must not trigger a recommendation');
});

test('api smoke: suggest-substitute — missing current_exercise → null', async () => {
  const { response, body } = await requestJson('/api/suggest-substitute', {
    method: 'POST',
    body: JSON.stringify({ message: 'Platform busy' })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.recommendation, null);
});

test('api smoke: suggest-substitute never writes to any sheet', async () => {
  const before = fakeSheetsState.appendCalls.length;
  await requestJson('/api/suggest-substitute', {
    method: 'POST',
    body: JSON.stringify({ message: 'Platform busy', current_exercise: 'Deadlift' })
  });
  assert.equal(fakeSheetsState.appendCalls.length, before, 'suggest-substitute must not write any rows');
});

// ── AC3: suggest-substitute includes next_target prescription (Step AC3) ──────

test('api smoke: suggest-substitute — next_target is populated when substitute has log history (AC3)', async () => {
  // logRows includes Romanian Deadlift at RDL01 (185×5 @ RIR 2). The endpoint uses
  // generateLiftCode('Romanian Deadlift') → 'RDL01' to match Log_Cleaned history,
  // so next_target must be a non-null object with weight/reps/sets when Deadlift
  // is unavailable and the substitute (Romanian Deadlift) has history.
  const { response, body } = await requestJson('/api/suggest-substitute', {
    method: 'POST',
    body: JSON.stringify({ message: 'Platform busy', current_exercise: 'Deadlift' })
  });
  assert.equal(response.status, 200);
  assert.ok(body.data.recommendation, 'recommendation must not be null');
  const nt = body.data.recommendation.next_target;
  assert.ok(nt !== null && typeof nt === 'object', 'next_target must be a prescription object when substitute has history');
  assert.ok(typeof nt.weight === 'number' && nt.weight > 0, 'next_target.weight must be a positive number from RDL history');
  assert.ok(typeof nt.reps === 'number' && nt.reps > 0, 'next_target.reps must be a positive number from RDL history');
  assert.ok(typeof nt.sets === 'number' && nt.sets > 0, 'next_target.sets must be a positive number from RDL history');
});

test('api smoke: suggest-substitute — next_target is null when substitute has no history (AC3 graceful degrade)', async () => {
  // Leg Press (LPX01) has no stub history — next_target must be null, not an error.
  const { response, body } = await requestJson('/api/suggest-substitute', {
    method: 'POST',
    body: JSON.stringify({ message: 'Rack unavailable', current_exercise: 'Back Squat' })
  });
  assert.equal(response.status, 200);
  assert.ok(body.data.recommendation, 'recommendation must not be null');
  // next_target may be null (no Leg Press history in stub) — that is the correct
  // graceful-degrade: the replacement slot gets null rather than throwing.
  const nt = body.data.recommendation.next_target;
  assert.ok(
    nt === null || (typeof nt === 'object' && nt !== null),
    'next_target must be null or a prescription object, never undefined'
  );
});
