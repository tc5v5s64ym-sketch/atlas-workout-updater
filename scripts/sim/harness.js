'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// One literal, declared in config/sandboxSheet.js. This module used to keep its own
// copy, so "is this the sandbox" had two deciders; it now has one.
const { SANDBOX_SPREADSHEET_ID: SANDBOX_SHEET_ID } = require('../../config/sandboxSheet');

// Marks every simulation request so the server-side Flight Recorder can identify sim
// traffic (docs/FLIGHT_RECORDER_SPEC.md). Its isolation guard NEVER persists a
// sim-marked request to a non-sandbox sheet — so a simulation can only ever write
// Flight Recorder rows into the sandbox Flight_Recorder tab, never production.
const SIMULATION_HEADERS = { 'x-atlas-simulation': '1' };

const DEFAULT_ALLOWED_ENDPOINTS = [
  { method: 'POST', pattern: /^\/api\/coach\/chat$/ },
  { method: 'POST', pattern: /^\/api\/coach\/ask$/ },
  { method: 'GET', pattern: /^\/api\/plan\/today$/ },
  { method: 'GET', pattern: /^\/api\/plan\/intent-recommendation$/ },
  { method: 'GET', pattern: /^\/api\/recommendation\/preview$/ },
  { method: 'GET', pattern: /^\/api\/recommend\/next\/[^/?#]+$/ },
];

const BLOCKED_ENDPOINT_PATTERNS = [
  /^\/api\/complete-workout(?:[/?#]|$)/,
  /^\/api\/log-workout(?:[/?#]|$)/,
  /^\/api\/log-modality(?:[/?#]|$)/,
  /^\/api\/bodyweight(?:[/?#]|$)/,
  /^\/api\/coaching-notes(?:[/?#]|$)/,
  /^\/api\/constraints(?:[/?#]|$)/,
  /^\/api\/bug-report(?:[/?#]|$)/,
  /^\/api\/deload\/(?:begin|advance|resolve)(?:[/?#]|$)/,
  /^\/api\/admin\/preview-test-rows(?:[/?#]|$)/,
  /^\/api\/parse-workout-(?:text|image)(?:[/?#]|$)/,
];

function normalizeMode(mode) {
  return mode === 'write' ? 'write' : 'read-only';
}

function normalizeEndpoint(endpoint) {
  const url = new URL(endpoint, 'http://atlas.local');
  return url.pathname;
}

function isBlockedEndpoint(endpoint) {
  const pathname = normalizeEndpoint(endpoint);
  return BLOCKED_ENDPOINT_PATTERNS.some((pattern) => pattern.test(pathname));
}

function isAllowedReadEndpoint(method, endpoint) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const pathname = normalizeEndpoint(endpoint);
  return DEFAULT_ALLOWED_ENDPOINTS.some((entry) => (
    entry.method === normalizedMethod && entry.pattern.test(pathname)
  ));
}

function validateSimulationConfig(options = {}) {
  const mode = normalizeMode(options.mode);
  const sheetId = options.sheetId ? String(options.sheetId).trim() : '';
  const writeScenariosEnabled = options.enableWriteScenarios === true;
  const shadowObservationEnabled = options.enableShadowObservation === true;
  const runs = normalizeRuns(options.runs);
  const delayMs = normalizeDelayMs(options.delayMs);
  const retryAttempts = normalizeRetryAttempts(options.retryAttempts);
  const retryDelayMs = normalizeRetryDelayMs(options.retryDelayMs);

  if (mode !== 'write') {
    if (shadowObservationEnabled) {
      throw new Error('Shadow observation refused: --enable-shadow-observation requires --mode write --sandbox so Intent_Shadow cannot be written outside the sandbox.');
    }
    return { mode, sheetId: sheetId || null, writeEnabled: false, writeScenariosEnabled: false, shadowObservationEnabled: false, runs, delayMs, retryAttempts, retryDelayMs };
  }

  if (!sheetId) {
    throw new Error('Simulation write mode refused: provide the sandbox sheet ID explicitly. Production data must never receive simulation writes.');
  }
  if (sheetId !== SANDBOX_SHEET_ID) {
    throw new Error('Simulation write mode refused: write scenarios require the known sandbox sheet ID. Production or unknown sheets must never receive simulation writes.');
  }
  if (!writeScenariosEnabled) {
    throw new Error('Simulation write mode refused: pass --enable-write-scenarios to run the sandbox mock session.');
  }

  return { mode, sheetId, writeEnabled: true, writeScenariosEnabled, shadowObservationEnabled, runs, delayMs, retryAttempts, retryDelayMs };
}

function normalizeRuns(value) {
  const raw = value == null ? 1 : value;
  const runs = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error('--runs must be a positive integer.');
  }
  if (runs > 100) {
    throw new Error('--runs is capped at 100 for Simulation Harness v1.2 batch mode.');
  }
  return runs;
}

function normalizeDelayMs(value) {
  const raw = value == null ? 0 : value;
  const delayMs = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error('--delay-ms must be a non-negative integer.');
  }
  return delayMs;
}

function normalizeRetryAttempts(value) {
  const raw = value == null ? 5 : value;
  const attempts = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new Error('--retry-attempts must be a non-negative integer.');
  }
  if (attempts > 5) {
    throw new Error('--retry-attempts is capped at 5 for Simulation Harness v1.2 batch mode.');
  }
  return attempts;
}

function normalizeRetryDelayMs(value) {
  const raw = value == null ? 65000 : value;
  const retryDelayMs = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('--retry-delay-ms must be a non-negative integer.');
  }
  return retryDelayMs;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function validateScenarioEndpoint(scenario, options = {}) {
  const method = String(scenario.method || 'POST').toUpperCase();
  const endpoint = scenario.endpoint || '/api/coach/chat';
  const readOnly = normalizeMode(options.mode) !== 'write';

  if (readOnly && isBlockedEndpoint(endpoint)) {
    throw new Error(`Read-only simulation refused blocked endpoint: ${method} ${endpoint}`);
  }

  if (!isAllowedReadEndpoint(method, endpoint)) {
    throw new Error(`Simulation endpoint is not on the v1 safe allowlist: ${method} ${endpoint}`);
  }

  return { method, endpoint };
}

function buildRequest(scenario) {
  const method = String(scenario.method || 'POST').toUpperCase();
  const endpoint = scenario.endpoint || '/api/coach/chat';
  const headers = { accept: 'application/json' };
  let body;

  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(scenario.body || { message: scenario.prompt, context: scenario.context || {} });
  }

  return { method, endpoint, headers, body };
}

function summarizeText(value, maxLength = 280) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function responseSummary(body) {
  const data = body && body.data ? body.data : body;
  if (!data || typeof data !== 'object') return summarizeText(body);
  return summarizeText(
    data.message ||
    data.answer ||
    data.coachExplanation ||
    data.summary_markdown ||
    data.recommendation ||
    data.recommendations ||
    data.intents ||
    data
  );
}

function brianShadowSummary(body) {
  const data = body && body.data ? body.data : body;
  if (!data || typeof data !== 'object') return null;
  return summarizeText(
    data.brian ||
    data.brian_summary ||
    data.shadow_summary ||
    data.brain_shadow ||
    data.Brain_Shadow ||
    null
  );
}

function brainShadowRows(body) {
  const data = body && body.data ? body.data : body;
  if (!data || typeof data !== 'object') return [];
  const rows = data.brain_shadow_rows || data.Brain_Shadow_rows || data.Brain_Shadow || [];
  return Array.isArray(rows) ? rows : [];
}

function makeMockSessionIds(now = new Date(), runIndex = 0) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const run = String(runIndex + 1).padStart(3, '0');
  return {
    sessionId: `SIM-WORKOUT-${stamp}-${run}`,
    writeId: `sim-workout-${stamp}-${run}`,
    date: now.toISOString().slice(0, 10)
  };
}

const SESSION_TEMPLATES = [
  {
    type: 'push',
    prompt: 'What should I bench next?',
    exercises: [
      { exercise: 'Bench Press', muscle_group: 'Chest', lift_code: 'BEN01', pattern: 'press', sets: 3, baseWeight: 135, reps: [5, 6], rir: [3, 2, 1] },
      { exercise: 'Overhead Press', muscle_group: 'Shoulders', lift_code: 'OHP01', pattern: 'press', sets: 3, baseWeight: 75, reps: [6, 8], rir: [3, 2, 2] },
      { exercise: 'Triceps Pushdown', muscle_group: 'Triceps', lift_code: 'TPD01', pattern: 'accessory', sets: 2, baseWeight: 45, reps: [10, 14], rir: [3, 2] },
    ],
  },
  {
    type: 'pull',
    prompt: 'What should I train today?',
    exercises: [
      { exercise: 'Seated Row', muscle_group: 'Back', lift_code: 'SR01', pattern: 'row', sets: 3, baseWeight: 120, reps: [8, 10], rir: [3, 2, 1] },
      { exercise: 'Lat Pulldown', muscle_group: 'Back', lift_code: 'LPD01', pattern: 'pull', sets: 3, baseWeight: 105, reps: [8, 12], rir: [3, 2, 2] },
      { exercise: 'Hammer Curls', muscle_group: 'Arms', lift_code: 'HC01', pattern: 'accessory', sets: 2, baseWeight: 25, reps: [10, 14], rir: [3, 2] },
    ],
  },
  {
    type: 'legs',
    prompt: 'What should I train today?',
    exercises: [
      { exercise: 'Back Squat', muscle_group: 'Quads', lift_code: 'SQ01', pattern: 'squat', sets: 3, baseWeight: 185, reps: [5, 6], rir: [3, 2, 1] },
      { exercise: 'Romanian Deadlift', muscle_group: 'Hamstrings', lift_code: 'RDL01', pattern: 'hinge', sets: 3, baseWeight: 155, reps: [6, 8], rir: [3, 2, 2] },
      { exercise: 'Leg Curl', muscle_group: 'Hamstrings', lift_code: 'LC01', pattern: 'accessory', sets: 2, baseWeight: 65, reps: [10, 14], rir: [3, 2] },
    ],
  },
  {
    type: 'upper',
    prompt: 'I only have 30 minutes.',
    exercises: [
      { exercise: 'Incline Dumbbell Press', muscle_group: 'Chest', lift_code: 'IDP01', pattern: 'press', sets: 2, baseWeight: 45, reps: [8, 10], rir: [3, 2] },
      { exercise: 'Bent-Over Row', muscle_group: 'Back', lift_code: 'BOR01', pattern: 'row', sets: 2, baseWeight: 115, reps: [8, 10], rir: [3, 2] },
      { exercise: 'Lateral Raises', muscle_group: 'Shoulders', lift_code: 'LAT01', pattern: 'accessory', sets: 2, baseWeight: 15, reps: [12, 16], rir: [3, 2] },
      { exercise: 'Dumbbell Curl', muscle_group: 'Biceps', lift_code: 'DC01', pattern: 'accessory', sets: 2, baseWeight: 25, reps: [10, 14], rir: [3, 2] },
    ],
  },
  {
    type: 'full_body',
    prompt: 'What should I train today?',
    exercises: [
      { exercise: 'Back Squat', muscle_group: 'Quads', lift_code: 'SQ01', pattern: 'squat', sets: 2, baseWeight: 175, reps: [5, 6], rir: [3, 2] },
      { exercise: 'Bench Press', muscle_group: 'Chest', lift_code: 'BEN01', pattern: 'press', sets: 2, baseWeight: 125, reps: [6, 8], rir: [3, 2] },
      { exercise: 'Romanian Deadlift', muscle_group: 'Hamstrings', lift_code: 'RDL01', pattern: 'hinge', sets: 2, baseWeight: 145, reps: [6, 8], rir: [3, 2] },
      { exercise: 'Seated Row', muscle_group: 'Back', lift_code: 'SR01', pattern: 'row', sets: 2, baseWeight: 110, reps: [8, 10], rir: [3, 2] },
    ],
  },
  {
    type: 'cardio_recovery',
    prompt: 'My shoulder is sore today.',
    exercises: [
      { exercise: 'Treadmill Run', muscle_group: 'Cardio', lift_code: 'CARDIO01', pattern: 'cardio', sets: 1, baseWeight: 0, reps: [20, 30], rir: [5] },
      { exercise: 'Face Pull', muscle_group: 'Rear Delts', lift_code: 'FP01', pattern: 'accessory', sets: 2, baseWeight: 30, reps: [12, 16], rir: [5, 4] },
      { exercise: 'Hanging Knee Raises', muscle_group: 'Core', lift_code: 'HNR01', pattern: 'accessory', sets: 2, baseWeight: 0, reps: [8, 12], rir: [4, 3] },
    ],
  },
];

function chooseSessionTemplate(runIndex = 0) {
  return SESSION_TEMPLATES[runIndex % SESSION_TEMPLATES.length];
}

function variedWeight(baseWeight, runIndex, exerciseIndex) {
  if (baseWeight === 0) return 0;
  const offset = ((runIndex + exerciseIndex) % 5) * 5;
  const wave = runIndex % 4 === 3 ? -5 : 0;
  return Math.max(5, baseWeight + offset + wave);
}

function variedReps(range, runIndex, exerciseIndex, setIndex, outcome) {
  const [min, max] = range;
  const span = Math.max(1, max - min + 1);
  const reps = min + ((runIndex + exerciseIndex + setIndex) % span);
  if (outcome === 'failed_last_set' && setIndex > 0) return Math.max(1, reps - 2);
  return reps;
}

function buildMockWorkoutProfile(runIndex = 0) {
  const template = chooseSessionTemplate(runIndex);
  const outcome = runIndex % 5 === 4 ? 'failed_last_set' : 'completed';
  const exercises = template.exercises.map((entry, exerciseIndex) => {
    const weight = variedWeight(entry.baseWeight, runIndex, exerciseIndex);
    return {
      ...entry,
      sets: Array.from({ length: entry.sets }, (_, setIndex) => ({
        set_number: setIndex + 1,
        weight,
        reps: variedReps(entry.reps, runIndex, exerciseIndex, setIndex, outcome),
        rir: outcome === 'failed_last_set' && setIndex === entry.sets - 1
          ? Math.max(0, (entry.rir[setIndex] ?? entry.rir.at(-1) ?? 2) - 2)
          : (entry.rir[setIndex] ?? entry.rir.at(-1) ?? 2),
      })),
    };
  });

  return {
    outcome,
    session_type: template.type,
    prompt: template.prompt,
    movement_patterns: [...new Set(exercises.map(exercise => exercise.pattern))],
    muscle_groups: [...new Set(exercises.map(exercise => exercise.muscle_group))],
    exercise_names: exercises.map(exercise => exercise.exercise),
    exercises,
  };
}

function buildMockWorkoutPayload(ids, runIndex = 0) {
  const profile = buildMockWorkoutProfile(runIndex);
  return {
    session_id: ids.sessionId,
    date: ids.date,
    write_id: ids.writeId,
    notes: `Atlas simulation harness v1.2 sandbox-only ${profile.session_type} mock session; outcome=${profile.outcome}.`,
    log_rows: profile.exercises.flatMap(exercise => exercise.sets.map(set => ({
        exercise: exercise.exercise,
        canonical_exercise: exercise.exercise,
        muscle_group: exercise.muscle_group,
        lift_code: exercise.lift_code,
        set_number: set.set_number,
        weight: set.weight,
        reps: set.reps,
        rir: set.rir,
        notes: `SIMULATION ONLY - fake sandbox ${profile.session_type} result - ${profile.outcome} - ${exercise.pattern}`
      })))
  };
}

// eslint-disable-next-line no-unused-vars -- sim helper; used by manual test runs outside the automated suite
function buildFakeBenchSets(runIndex = 0) {
  const profile = buildMockWorkoutProfile(runIndex);
  const bench = profile.exercises.find(exercise => exercise.exercise === 'Bench Press') || profile.exercises[0];
  return { outcome: profile.outcome, sets: bench.sets.map(({ weight, reps, rir }) => ({ weight, reps, rir })) };
}

function buildFakeBenchPayload(ids, runIndex = 0) {
  return buildMockWorkoutPayload(ids, runIndex);
}

function collectCounts(values) {
  return values.reduce((counts, value) => {
    if (!value) return counts;
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function summarizeSimulationVariation(results) {
  const exerciseNames = [];
  const muscleGroups = [];
  const sessionTypes = [];
  const movementPatterns = [];
  const setRepSchemes = [];

  for (const result of results) {
    if (result.session_type) sessionTypes.push(result.session_type);
    for (const exercise of result.exercise_names || []) exerciseNames.push(exercise);
    for (const muscleGroup of result.muscle_groups || []) muscleGroups.push(muscleGroup);
    for (const pattern of result.movement_patterns || []) movementPatterns.push(pattern);
    for (const set of result.fake_sets || []) {
      if (set.reps != null && set.rir != null) setRepSchemes.push(`${set.reps} reps @ RIR ${set.rir}`);
    }
  }

  return {
    unique_exercises: new Set(exerciseNames).size,
    unique_muscle_groups: new Set(muscleGroups).size,
    session_types: [...new Set(sessionTypes)],
    movement_patterns: [...new Set(movementPatterns)],
    set_rep_schemes: [...new Set(setRepSchemes)].slice(0, 20),
    exercise_counts: collectCounts(exerciseNames),
    muscle_group_counts: collectCounts(muscleGroups),
  };
}

function extractSheetVerification(body) {
  const data = body && body.data ? body.data : body;
  if (!data || typeof data !== 'object') return null;
  return data.sheetVerification || data.sheet_verification || null;
}

function extractDebugConfig(body) {
  const data = body && body.data ? body.data : body;
  return data && typeof data === 'object' ? data : {};
}

function serverVerificationWarning(verification) {
  if (!verification || verification.canVerify !== true) {
    return 'Server sheet verification unavailable; continuing only because simulation mode is read-only.';
  }
  if (verification.isProductionSheet === true) {
    return `Server appears pointed at the production Atlas MASTER sheet (last6=${verification.idLast6 || 'unknown'}); read-only simulation is allowed, but write scenarios must not run.`;
  }
  if (verification.isSandboxSheet !== true) {
    return `Server sheet is neither confirmed sandbox nor confirmed production (last6=${verification.idLast6 || 'unknown'}); read-only simulation is allowed only.`;
  }
  return null;
}

function assertWriteScenariosEnabled(config) {
  if (config.mode !== 'write' || config.writeEnabled !== true || config.sheetId !== SANDBOX_SHEET_ID) {
    throw new Error('Sandbox write scenarios require --mode write --sandbox.');
  }
  if (config.writeScenariosEnabled !== true) {
    throw new Error('Sandbox write scenarios require --enable-write-scenarios.');
  }
}

async function verifyServerSheet(options, config) {
  const url = new URL('/api/debug/config', options.baseUrl);
  let response;
  let body;

  try {
    response = await options.fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...SIMULATION_HEADERS,
        ...(options.apiKey ? { 'x-atlas-api-key': options.apiKey } : {}),
      },
    });
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    if (config.mode === 'write') {
      throw new Error(`Simulation write mode refused: could not verify server sheet via /api/debug/config (${error.message}).`);
    }
    return {
      sheetVerification: null,
      warnings: [`Server sheet verification unavailable; continuing only because simulation mode is read-only. Detail: ${error.message}`],
    };
  }

  const debugConfig = response.status === 200 ? extractDebugConfig(body) : {};
  const verification = response.status === 200 ? extractSheetVerification(body) : null;

  if (config.mode === 'write') {
    if (!verification || verification.canVerify !== true) {
      throw new Error(`Simulation write mode refused: /api/debug/config did not confirm the active server sheet (status ${response.status}).`);
    }
    if (verification.isSandboxSheet !== true) {
      const label = verification.isProductionSheet === true ? 'production Atlas MASTER sheet' : 'a non-sandbox or unknown sheet';
      throw new Error(`Simulation write mode refused: server is pointed at ${label} (last6=${verification.idLast6 || 'unknown'}), not the sandbox sheet.`);
    }
  }

  if (config.shadowObservationEnabled === true) {
    if (debugConfig.coachEngineMode !== 'hybrid') {
      throw new Error(`Shadow observation refused: /api/debug/config reported coachEngineMode=${debugConfig.coachEngineMode || 'unknown'}; expected hybrid.`);
    }
    if (debugConfig.brainShadowPersistEnabled !== true) {
      throw new Error('Shadow observation refused: /api/debug/config did not confirm brainShadowPersistEnabled=true.');
    }
    if (debugConfig.intentRouterMode !== 'shadow') {
      throw new Error(`Shadow observation refused: /api/debug/config reported intentRouterMode=${debugConfig.intentRouterMode || 'unknown'}; expected shadow.`);
    }
  }

  const warning = serverVerificationWarning(verification);
  return {
    sheetVerification: verification,
    debugConfig: {
      coachEngineMode: debugConfig.coachEngineMode || null,
      brainShadowPersistEnabled: debugConfig.brainShadowPersistEnabled === true,
      intentRouterMode: debugConfig.intentRouterMode || null,
    },
    warnings: warning ? [warning] : [],
  };
}

async function requestJson(options, endpoint, request = {}) {
  const url = new URL(endpoint, options.baseUrl);
  const maxRetries = Number.isInteger(options.retryAttempts) ? options.retryAttempts : 0;
  const retryDelayMs = Number.isInteger(options.retryDelayMs) ? options.retryDelayMs : 65000;
  const sleepImpl = options.sleepImpl || sleep;
  let lastResult = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await options.fetchImpl(url, {
      method: request.method || 'GET',
      headers: {
        accept: 'application/json',
        ...SIMULATION_HEADERS,
        ...(request.body ? { 'content-type': 'application/json' } : {}),
        ...(options.apiKey ? { 'x-atlas-api-key': options.apiKey } : {}),
        ...(request.headers || {}),
      },
      body: request.body ? JSON.stringify(request.body) : undefined,
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    lastResult = { response, body, attempts: attempt + 1, retried: attempt > 0 };

    if (!isTransientSimulationResponse(response.status, body) || attempt === maxRetries) {
      return lastResult;
    }

    await sleepImpl(retryDelayMs);
  }

  return lastResult;
}

function isTransientSimulationResponse(status, body) {
  const numericStatus = Number(status);
  if (![400, 429, 500, 502, 503, 504].includes(numericStatus)) return false;
  const summary = responseSummary(body) || '';
  return numericStatus === 429
    || /quota exceeded/i.test(summary)
    || /too many requests/i.test(summary)
    || /rate limit/i.test(summary)
    || (numericStatus >= 500
      && !/failed to validate sheet header contract/i.test(summary)
      && !/failed to validate duplicate log rows/i.test(summary));
}

function rowsWrittenFromLogResponse(body) {
  const data = body && body.data ? body.data : body;
  if (!data || typeof data !== 'object') return 0;
  return Number(data.log_rows_written || 0) + Number(data.effort_rows_written || 0);
}

function summarizeWriteScenarioBatch(results, shadowSummary = null, options = {}) {
  const errors = [];
  const flaggedOddResults = [];
  const variationSummary = summarizeSimulationVariation(results);
  let rowsWritten = 0;
  let brainShadowEntries = 0;
  let retryAttemptsUsed = 0;
  let passed = 0;

  for (const result of results) {
    rowsWritten += Number(result.rows_written || 0);
    brainShadowEntries += Number(result.brain_shadow_entries || 0);
    retryAttemptsUsed += Number(result.retry_attempts_used || 0);
    if (result.pass) passed += 1;
    for (const error of result.errors || []) errors.push({ run: result.run, error });
    if (!result.first_recommendation_received) flaggedOddResults.push({ run: result.run, reason: 'missing_first_recommendation' });
    if (!result.second_recommendation_received) flaggedOddResults.push({ run: result.run, reason: 'missing_second_recommendation' });
    if (Number(result.rows_written || 0) !== Number(result.expected_rows || 0)) {
      flaggedOddResults.push({
        run: result.run,
        reason: 'rows_written_mismatch',
        expected_rows: result.expected_rows,
        rows_written: result.rows_written
      });
    }
  }

  if (results.length >= 100 && variationSummary.unique_exercises <= 1) {
    flaggedOddResults.push({ reason: 'insufficient_exercise_variation', unique_exercises: variationSummary.unique_exercises });
  }
  if (results.length >= 100 && variationSummary.unique_muscle_groups <= 1) {
    flaggedOddResults.push({ reason: 'insufficient_muscle_group_variation', unique_muscle_groups: variationSummary.unique_muscle_groups });
  }

  const observedBrainEntries = shadowSummary && shadowSummary.brain && Number.isFinite(Number(shadowSummary.brain.count))
    ? Number(shadowSummary.brain.count)
    : 0;
  const observedIntentEntries = shadowSummary && shadowSummary.intent && Number.isFinite(Number(shadowSummary.intent.count))
    ? Number(shadowSummary.intent.count)
    : 0;
  const brainAggregates = shadowSummary && shadowSummary.brain && shadowSummary.brain.aggregates
    ? shadowSummary.brain.aggregates
    : {};
  const brainFailures = Number(brainAggregates.failed || 0);
  const brainDiverged = Number(brainAggregates.diverged || 0);

  if (options.requireShadowEntries === true) {
    if (observedBrainEntries <= 0) {
      flaggedOddResults.push({ reason: 'missing_brain_shadow_entries', channel: 'Brain_Shadow' });
    }
    if (observedIntentEntries <= 0) {
      flaggedOddResults.push({ reason: 'missing_intent_shadow_entries', channel: 'Intent_Shadow' });
    }
  }

  return {
    runs_requested: results.length,
    runs_completed: results.length,
    runs_passed: passed,
    runs_failed: results.length - passed,
    rows_written: rowsWritten,
    brain_shadow_entries: Math.max(brainShadowEntries, observedBrainEntries),
    brain_shadow_diverged: Number.isFinite(brainDiverged) ? brainDiverged : 0,
    brain_shadow_failures: Number.isFinite(brainFailures) ? brainFailures : 0,
    intent_shadow_entries: observedIntentEntries,
    retry_attempts_used: retryAttemptsUsed,
    errors,
    flagged_odd_results: flaggedOddResults,
    variation_summary: variationSummary
  };
}

async function observeIntentPrompt(options, prompt) {
  return requestJson(options, '/api/debug/intent-observe', {
    method: 'POST',
    body: {
      message: prompt,
      app_version: 'simulation-harness-v1.3',
    },
  });
}

async function runSandboxMockSession(options, config, runIndex = 0) {
  assertWriteScenariosEnabled(config);
  const ids = makeMockSessionIds(options.now || new Date(), runIndex);
  const fakePayload = buildMockWorkoutPayload(ids, runIndex);
  const runProfile = buildMockWorkoutProfile(runIndex);
  const started = Date.now();
  const summary = {
    name: 'sandbox_mock_session',
    run: runIndex + 1,
    prompt: runProfile.prompt,
    recommendation_endpoint: '/api/recommend/next/BEN01',
    write_endpoint: '/api/log-workout',
    session_id: ids.sessionId,
    write_id: ids.writeId,
    sandbox_confirmed: true,
    session_type: runProfile.session_type,
    exercise_names: runProfile.exercise_names,
    muscle_groups: runProfile.muscle_groups,
    movement_patterns: runProfile.movement_patterns,
    set_outcome: runProfile.outcome,
    expected_rows: fakePayload.log_rows.length,
    fake_sets: fakePayload.log_rows.map(row => ({
      exercise: row.exercise,
      muscle_group: row.muscle_group,
      set_number: row.set_number,
      weight: row.weight,
      reps: row.reps,
      rir: row.rir,
      outcome: runProfile.outcome
    })),
    first_recommendation_received: null,
    second_recommendation_received: null,
    fake_result_logged: false,
    rows_written: 0,
    brain_shadow_entries: 0,
    intent_observation_sent: false,
    intent_observation_status: null,
    retry_attempts_used: 0,
    pass: false,
    errors: [],
    duration_ms: 0
  };

  try {
    if (config.shadowObservationEnabled === true) {
      const observed = await observeIntentPrompt(options, runProfile.prompt);
      summary.retry_attempts_used += Math.max(0, Number(observed.attempts || 1) - 1);
      summary.intent_observation_status = observed.response.status;
      summary.intent_observation_sent = observed.response.status >= 200 && observed.response.status < 300;
      if (!summary.intent_observation_sent) {
        throw new Error(`Intent shadow observation failed with HTTP ${observed.response.status}: ${responseSummary(observed.body) || 'no response body'}`);
      }
    }

    const firstRecommendation = await requestJson(options, summary.recommendation_endpoint);
    summary.retry_attempts_used += Math.max(0, Number(firstRecommendation.attempts || 1) - 1);
    summary.first_recommendation_status = firstRecommendation.response.status;
    summary.first_recommendation_received = responseSummary(firstRecommendation.body);
    summary.brain_shadow_entries += brainShadowRows(firstRecommendation.body).length;
    if (firstRecommendation.response.status < 200 || firstRecommendation.response.status >= 300) {
      throw new Error(`First recommendation request failed with HTTP ${firstRecommendation.response.status}.`);
    }

    const write = await requestJson(options, summary.write_endpoint, {
      method: 'POST',
      body: fakePayload,
    });
    summary.retry_attempts_used += Math.max(0, Number(write.attempts || 1) - 1);
    summary.write_status = write.response.status;
    summary.fake_result_logged = write.response.status >= 200 && write.response.status < 300;
    summary.rows_written = rowsWrittenFromLogResponse(write.body);
    summary.brain_shadow_entries += brainShadowRows(write.body).length;
    if (!summary.fake_result_logged) {
      throw new Error(`Fake sandbox workout write failed with HTTP ${write.response.status}: ${responseSummary(write.body) || 'no response body'}`);
    }
    if (summary.rows_written !== summary.expected_rows) {
      throw new Error(`Fake sandbox workout write reported ${summary.rows_written} row(s) written; expected ${summary.expected_rows}.`);
    }

    const secondRecommendation = await requestJson(options, summary.recommendation_endpoint);
    summary.retry_attempts_used += Math.max(0, Number(secondRecommendation.attempts || 1) - 1);
    summary.second_recommendation_status = secondRecommendation.response.status;
    summary.second_recommendation_received = responseSummary(secondRecommendation.body);
    summary.brain_shadow_entries += brainShadowRows(secondRecommendation.body).length;
    if (secondRecommendation.response.status < 200 || secondRecommendation.response.status >= 300) {
      throw new Error(`Second recommendation request failed with HTTP ${secondRecommendation.response.status}.`);
    }
    summary.pass = true;
  } catch (error) {
    summary.errors.push(error.message);
  } finally {
    summary.duration_ms = Date.now() - started;
  }

  return summary;
}

function summarizeShadowEndpoint(status, body) {
  const data = body && body.data ? body.data : body;
  if (!data || typeof data !== 'object') {
    return { available: false, status, enabled: null, count: 0, mode: null, persist: null, aggregates: null };
  }
  return {
    available: status >= 200 && status < 300,
    status,
    enabled: Object.prototype.hasOwnProperty.call(data, 'enabled') ? data.enabled : null,
    count: Number(data.count || 0),
    mode: data.mode || null,
    persist: Object.prototype.hasOwnProperty.call(data, 'persist') ? data.persist : null,
    aggregates: data.aggregates || null,
  };
}

async function fetchShadowSummary(options) {
  const summary = {
    brain: { available: false, status: null, enabled: null, count: 0, mode: null, persist: null, aggregates: null },
    intent: { available: false, status: null, enabled: null, count: 0, mode: null, persist: null, aggregates: null },
  };

  try {
    const brain = await requestJson({ ...options, retryAttempts: 0 }, '/api/debug/brain-shadow');
    summary.brain = summarizeShadowEndpoint(brain.response.status, brain.body);
  } catch (error) {
    summary.brain.error = error.message;
  }

  try {
    const intent = await requestJson({ ...options, retryAttempts: 0 }, '/api/debug/intent-shadow');
    summary.intent = summarizeShadowEndpoint(intent.response.status, intent.body);
  } catch (error) {
    summary.intent.error = error.message;
  }

  return summary;
}

async function runScenario(scenario, options) {
  const started = Date.now();
  let status = null;
  let body = null;
  let error = null;

  try {
    const { method, endpoint } = validateScenarioEndpoint(scenario, options);
    const request = buildRequest({ ...scenario, method, endpoint });
    const url = new URL(request.endpoint, options.baseUrl);
    const response = await options.fetchImpl(url, {
      method: request.method,
      headers: {
        ...request.headers,
        ...SIMULATION_HEADERS,
        ...(options.apiKey ? { 'x-atlas-api-key': options.apiKey } : {}),
      },
      body: request.body,
    });
    status = response.status;
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    error = err.message;
  }

  return {
    scenario_name: scenario.name,
    prompt: scenario.prompt,
    endpoint: scenario.endpoint || '/api/coach/chat',
    http_status: status,
    user_visible_response_summary: responseSummary(body),
    brian_shadow_summary: brianShadowSummary(body),
    brain_shadow_rows_generated: brainShadowRows(body).length,
    errors: error ? [error] : [],
    duration_ms: Date.now() - started,
  };
}

async function runSimulation(options = {}) {
  const config = validateSimulationConfig(options);
  if (!options.baseUrl) {
    throw new Error('Simulation refused to run: provide --base-url or ATLAS_SIM_BASE_URL for a local Atlas server.');
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Simulation refused to run: fetch is unavailable in this Node runtime.');
  }

  const scenarios = config.writeScenariosEnabled && !Array.isArray(options.scenarios)
    ? []
    : Array.isArray(options.scenarios)
    ? options.scenarios
    : JSON.parse(await fs.readFile(options.scenarioFile, 'utf8'));
  const preflight = await verifyServerSheet({ ...options, fetchImpl }, config);

  const results = [];
  const writeScenarioResults = [];
  if (options.enableWriteScenarios === true) {
    for (let runIndex = 0; runIndex < config.runs; runIndex += 1) {
      writeScenarioResults.push(await runSandboxMockSession({ ...options, fetchImpl, retryAttempts: config.retryAttempts, retryDelayMs: config.retryDelayMs }, config, runIndex));
      if (config.delayMs > 0 && runIndex < config.runs - 1) {
        await (options.sleepImpl || sleep)(config.delayMs);
      }
    }
  }

  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, {
      ...config,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      fetchImpl,
    }));
  }

  const shadowSummary = config.writeScenariosEnabled
    ? await fetchShadowSummary({ ...options, fetchImpl, retryAttempts: 0, retryDelayMs: config.retryDelayMs })
    : null;
  const runSummary = summarizeWriteScenarioBatch(writeScenarioResults, shadowSummary, {
    requireShadowEntries: config.shadowObservationEnabled === true,
  });
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    mode: config.mode,
    sheet_id: config.sheetId,
    server_sheet_verification: preflight.sheetVerification,
    server_shadow_readiness: preflight.debugConfig,
    warnings: preflight.warnings,
    base_url: options.baseUrl,
    scenario_count: results.length,
    write_scenario_count: writeScenarioResults.length,
    runs_requested: config.writeScenariosEnabled ? config.runs : 0,
    delay_ms: config.delayMs,
    retry_attempts: config.retryAttempts,
    retry_delay_ms: config.retryDelayMs,
    run_summary: runSummary,
    shadow_summary: shadowSummary,
    variation_summary: runSummary.variation_summary,
    results,
    write_scenarios: writeScenarioResults,
    pass: writeScenarioResults.every(result => result.pass !== false)
      && results.every(result => result.errors.length === 0)
      && runSummary.flagged_odd_results.length === 0,
  };

  if (options.outputDir) {
    await writeReports(report, options.outputDir);
  }

  return report;
}

function markdownReport(report) {
  const lines = [
    '# Atlas Simulation Report',
    '',
    `- Schema version: ${report.schema_version}`,
    `- Mode: ${report.mode}`,
    `- Sheet ID: ${report.sheet_id || '(none)'}`,
    `- Server sheet: ${report.server_sheet_verification
      ? `sandbox=${report.server_sheet_verification.isSandboxSheet === true}, production=${report.server_sheet_verification.isProductionSheet === true}, last6=${report.server_sheet_verification.idLast6 || '(unknown)'}`
      : '(unverified)'}`,
    `- Base URL: ${report.base_url}`,
    `- Scenarios: ${report.scenario_count}`,
    `- Write scenarios: ${report.write_scenario_count || 0}`,
    `- Delay ms: ${report.delay_ms || 0}`,
    `- Retry attempts: ${report.retry_attempts || 0}`,
    `- Retry delay ms: ${report.retry_delay_ms || 0}`,
    `- Runs completed: ${report.run_summary ? report.run_summary.runs_completed : 0}`,
    `- Runs passed: ${report.run_summary ? report.run_summary.runs_passed : 0}`,
    `- Runs failed: ${report.run_summary ? report.run_summary.runs_failed : 0}`,
    `- Rows written: ${report.run_summary ? report.run_summary.rows_written : 0}`,
    `- Brain_Shadow entries: ${report.run_summary ? report.run_summary.brain_shadow_entries : 0}`,
    `- Brain_Shadow diverged: ${report.run_summary ? report.run_summary.brain_shadow_diverged || 0 : 0}`,
    `- Brain_Shadow failures: ${report.run_summary ? report.run_summary.brain_shadow_failures || 0 : 0}`,
    `- Intent_Shadow entries: ${report.run_summary ? report.run_summary.intent_shadow_entries || 0 : 0}`,
    `- Pass: ${report.pass === false ? 'false' : 'true'}`,
  ];

  if (report.variation_summary) {
    const variation = report.variation_summary;
    lines.push(
      `- Unique exercises: ${variation.unique_exercises || 0}`,
      `- Unique muscle groups: ${variation.unique_muscle_groups || 0}`,
      `- Session types: ${(variation.session_types || []).join(', ') || '(none)'}`,
      `- Movement patterns: ${(variation.movement_patterns || []).join(', ') || '(none)'}`,
    );
  }

  if (Array.isArray(report.warnings) && report.warnings.length) {
    lines.push('', '## Warnings', '');
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }

  lines.push(
    '',
    '| Scenario | Endpoint | Status | Duration | Summary | Errors |',
    '|---|---:|---:|---:|---|---|',
  );

  for (const result of report.results) {
    lines.push([
      result.scenario_name,
      result.endpoint,
      result.http_status == null ? '' : result.http_status,
      `${result.duration_ms} ms`,
      (result.user_visible_response_summary || '').replace(/\|/g, '\\|'),
      result.errors.join('; ').replace(/\|/g, '\\|'),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  if (Array.isArray(report.write_scenarios) && report.write_scenarios.length) {
    lines.push('', '## Write Scenarios', '');
    for (const result of report.write_scenarios) {
      lines.push(`- ${result.name} #${result.run}: pass=${result.pass}, sandbox_confirmed=${result.sandbox_confirmed === true}, session_type=${result.session_type || '(unknown)'}, exercises="${(result.exercise_names || []).join(', ')}", outcome=${result.set_outcome}, first_recommendation="${result.first_recommendation_received || ''}", fake_result_logged=${result.fake_result_logged}, rows_written=${result.rows_written}, second_recommendation="${result.second_recommendation_received || ''}", brain_shadow_entries=${result.brain_shadow_entries}, retries=${result.retry_attempts_used || 0}`);
      if (result.errors.length) lines.push(`  errors=${result.errors.join('; ')}`);
    }
  }

  if (report.variation_summary) {
    lines.push('', '## Variation Summary', '');
    const exerciseCounts = Object.entries(report.variation_summary.exercise_counts || {});
    const muscleCounts = Object.entries(report.variation_summary.muscle_group_counts || {});
    if (exerciseCounts.length) {
      lines.push('### Exercises', '');
      for (const [exercise, count] of exerciseCounts) lines.push(`- ${exercise}: ${count}`);
    }
    if (muscleCounts.length) {
      lines.push('', '### Muscle Groups', '');
      for (const [muscleGroup, count] of muscleCounts) lines.push(`- ${muscleGroup}: ${count}`);
    }
  }

  if (report.run_summary && Array.isArray(report.run_summary.flagged_odd_results) && report.run_summary.flagged_odd_results.length) {
    lines.push('', '## Flagged Odd Results', '');
    for (const item of report.run_summary.flagged_odd_results) {
      lines.push(`- run ${item.run}: ${item.reason}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function writeReports(report, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = report.generated_at.replace(/[:.]/g, '-');
  const jsonPath = path.join(outputDir, `atlas-sim-${stamp}.json`);
  const markdownPath = path.join(outputDir, `atlas-sim-${stamp}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(markdownPath, markdownReport(report));
  report.report_paths = { json: jsonPath, markdown: markdownPath };
  return report.report_paths;
}

module.exports = {
  SANDBOX_SHEET_ID,
  SIMULATION_HEADERS,
  BLOCKED_ENDPOINT_PATTERNS,
  DEFAULT_ALLOWED_ENDPOINTS,
  validateSimulationConfig,
  validateScenarioEndpoint,
  verifyServerSheet,
  extractSheetVerification,
  runSandboxMockSession,
  SESSION_TEMPLATES,
  buildMockWorkoutProfile,
  buildMockWorkoutPayload,
  buildFakeBenchPayload,
  summarizeSimulationVariation,
  isBlockedEndpoint,
  isAllowedReadEndpoint,
  runScenario,
  runSimulation,
  markdownReport,
  writeReports,
};
