'use strict';

// PR-3 — per-exercise BLOCK coach note wired into the read-only /api/coach/message
// path. Proves the trust-critical contract the owner required:
//   - a routine block is acknowledgment-only (tier ack_only): no prose, LLM NOT called
//   - an interesting block produces a note (LLM prose, or the deterministic
//     engine line when the engine suppresses the prose / the LLM is down)
//   - an LLM failure degrades to 200 (never a 5xx) and never affects logging
//   - the endpoint never writes — the write path / trust loop are untouched
//
// Harness mirrors test/coach-ask-endpoint.test.js (require-cache stub injection).
// batchNoteFacts / coachNoteTier / setEffortSignals stay REAL — only the Gemini
// voice module is stubbed, so the tier classification under test is the real one.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
// Plain stub — sheets.js is fully require-cache stubbed below, so the value is
// never used for real auth. Deliberately NOT a PEM block (the changed-file secret
// scanner flags a literal private-key header even in a test stub).
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';

const sheetState = { appendCalls: [], deleteCalls: [], throwOnRead: false };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async (tabName, rows) => {
    sheetState.appendCalls.push({ tabName, rows });
    throw new Error('appendRows must not be called by the read-only coach path');
  },
  deleteRowsByRange: async (tabName, s, e) => { sheetState.deleteCalls.push({ tabName, s, e }); },
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  // Stable reference (index.js injects it into the route at load) — toggle throwOnRead
  // to simulate a Sheets read failure for a single test.
  getSheetRows: async () => { if (sheetState.throwOnRead) throw new Error('sheets down'); return []; },
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

// Controllable coach voice: track call count + toggle configured/message/throw.
const coachState = { configured: true, message: 'Nice work on that block.', throwError: null, calls: 0, lastFacts: null };
const fakeCoach = {
  isConfigured: () => coachState.configured,
  coachModel: () => 'gemini-2.5-flash-lite',
  generateCoachMessage: async (facts) => {
    coachState.calls += 1;
    coachState.lastFacts = facts; // capture the exact facts the route hands the LLM
    if (coachState.throwError) throw new Error(coachState.throwError);
    return coachState.message;
  },
  generatePlanMessage: async () => null,
  generateChatReply: async () => ({ reply: null }),
  sanitizeFacts: (f) => f,
};
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true, exports: fakeCoach,
};

const originalConsoleLog = console.log;
// The exercise catalog reads Supabase (OWNER CORRECTION 2026-08-13). Stubbed here so
// the suite never opens a database connection; it delegates to the sheets fixture above.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();

// The workout authority is Supabase since the S4 cutover, so stubbing `sheets.js`

// no longer controls the logged sets, the Effort row, the plan ledgers or the write

// receipts. `sheetsFallback` seeds this suite's existing fixture into the double, so

// no test's data changes — only where the route reads it from.

require('./helpers/stubWorkoutAuthority').installWorkoutAuthorityStub({ sheetsFallback: true });
const { app } = require('../index');

let server;
let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  try { if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))); }
  finally { console.log = originalConsoleLog; }
});

function resetCoach({ configured = true, message = 'Nice work on that block.', throwError = null } = {}) {
  coachState.configured = configured;
  coachState.message = message;
  coachState.throwError = throwError;
  coachState.calls = 0;
  coachState.lastFacts = null;
}

async function postBlock(facts) {
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ kind: 'block', facts }),
  });
  const body = await res.json();
  return { res, body };
}

// A routine block: two clean working sets at the target RIR, an accessory lift,
// no rec → no verdicts. The real classifier returns ack_only.
const ROUTINE_BLOCK = { exerciseName: 'Bicep Curl', muscleGroup: 'Arms', todaySets: [{ weight: 40, reps: 10, rir: 2 }, { weight: 40, reps: 10, rir: 2 }] };
// An interesting block: a heavy compound taken to RIR 0 (redline) → the real
// classifier returns extended / form_safety, and the engine emits an effort_note.
const REDLINE_BLOCK = { exerciseName: 'Bench Press', muscleGroup: 'Chest', todaySets: [{ weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 3, rir: 0 }] };

test('routine block → ack_only, no prose, and the LLM is never called', async () => {
  resetCoach();
  const { res, body } = await postBlock(ROUTINE_BLOCK);
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, 'ack_only');
  assert.equal(body.data.message, null, 'routine block must carry no coaching prose');
  assert.equal(body.data.effort_note, null, 'routine block must carry no deterministic effort line');
  assert.equal(coachState.calls, 0, 'a routine block must not call the LLM');
});

test('recovery/deload block → high RIR stays ack_only and never calls the LLM', async () => {
  const cases = [
    { intentId: 'recovery_pump', todaySets: [[135, 12, 6]] },
    { rec: { deload: { in_deload: true } }, todaySets: [{ weight: 135, reps: 12, rir: 6 }] },
  ];
  for (const recovery of cases) {
    resetCoach();
    const { res, body } = await postBlock({
      exerciseName: 'Bench Press', muscleGroup: 'Chest', ...recovery,
    });
    assert.equal(res.status, 200);
    assert.equal(body.data.note_tier, 'ack_only');
    assert.equal(body.data.note_trigger, null);
    assert.equal(body.data.message, null);
    assert.equal(coachState.calls, 0, 'expected recovery work must not invoke the LLM');
  }
});

test('interesting block → extended tier and a note (deterministic line when prose is engine-owned)', async () => {
  resetCoach();
  const { res, body } = await postBlock(REDLINE_BLOCK);
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, 'extended');
  assert.equal(body.data.note_trigger, 'form_safety');
  // The frontend renders `message || effort_note`. For a redline the engine may
  // suppress the LLM prose, but a note must still be available via effort_note.
  const note = (typeof body.data.message === 'string' && body.data.message.trim())
    || (typeof body.data.effort_note === 'string' && body.data.effort_note.trim());
  assert.ok(note, 'an interesting block must produce a renderable note');
  assert.ok(coachState.calls >= 1, 'a non-routine block words via the coach voice');
});

// ── effort_verdict is ENGINE-RULE-BOUND on the set path (forged-verdict guard) ──
// The client echoes rec.effort_verdict from /api/recommend/next; the route must
// recompute it from the just-logged set it was HANDED (last todaySets entry) +
// rec.target_rir via the engine's own pure rule (justLoggedAnchor.effortVerdict)
// and ALWAYS overwrite — a forged "failure" on an RIR-3 set can never reach the
// prompt. Sibling of the progression_history / athlete_identity fail-closed
// overwrites (PR #989 pattern).

async function postSet(facts) {
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ kind: 'set', facts }),
  });
  const body = await res.json();
  return { res, body };
}

test('set path: a FORGED effort_verdict is overwritten by the engine rule (RIR 3 vs target 2 → on_target, never failure)', async () => {
  resetCoach();
  const { res } = await postSet({
    exerciseName: 'Bench Press',
    todaySets: [{ weight: 225, reps: 5, rir: 3 }],
    rec: { target_rir: 2, effort_verdict: { level: 'failure', headline: 'forged' } },
  });
  assert.equal(res.status, 200);
  assert.ok(coachState.lastFacts, 'the set path words via the coach voice');
  const v = coachState.lastFacts.rec && coachState.lastFacts.rec.effort_verdict;
  assert.equal(v && v.level, 'on_target', 'the engine rule applied to the claimed set wins — the forged level never reaches the prompt');
});

test('set path: a forged verdict with NO RIR on the just-logged set is nulled (nothing to read)', async () => {
  resetCoach();
  const { res } = await postSet({
    exerciseName: 'Bench Press',
    todaySets: [{ weight: 225, reps: 5 }],
    rec: { target_rir: 2, effort_verdict: { level: 'failure', headline: 'forged' } },
  });
  assert.equal(res.status, 200);
  assert.ok(coachState.lastFacts);
  assert.equal(coachState.lastFacts.rec.effort_verdict, null, 'no RIR on the set → no effort verdict, forged or otherwise');
});

test('set path: an HONEST echoed verdict passes through unchanged (recompute agrees)', async () => {
  resetCoach();
  const { res } = await postSet({
    exerciseName: 'Bench Press',
    todaySets: [{ weight: 225, reps: 5, rir: 0 }],
    rec: { target_rir: 2, effort_verdict: { level: 'failure', target_rir: 2, headline: 'That set was at or near failure.' } },
  });
  assert.equal(res.status, 200);
  assert.ok(coachState.lastFacts);
  const v = coachState.lastFacts.rec.effort_verdict;
  assert.equal(v && v.level, 'failure', 'RIR 0 genuinely reads failure — the honest echo is preserved by recomputation');
});

test('client-only PR claim via rec has no authority without server-confirmed lift history', async () => {
  resetCoach({ message: 'New working best — clean bar speed.' });
  const facts = {
    exerciseName: 'Back Squat', muscleGroup: 'Legs',
    todaySets: [{ weight: 275, reps: 3, rir: 2 }],
    rec: { progression_verdict: { level: 'new_ground' } },
  };
  const { res, body } = await postBlock(facts);
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, 'ack_only');
  assert.equal(body.data.note_trigger, null);
  assert.equal(body.data.message, null);
  assert.equal(coachState.calls, 0, 'client-only PR claims must not reach the LLM path');
});

test('routine silence: an on-target / in-pocket block WITH a rec → ack_only, LLM not called', async () => {
  // The live-test regression, through the route: a merely on-plan block (the
  // conversation reaction passes rec.effort_verdict) must be receipt-only now.
  resetCoach();
  const facts = {
    exerciseName: 'Cable Curl', muscleGroup: 'Arms',
    todaySets: [{ weight: 40, reps: 12, rir: 3 }, { weight: 40, reps: 12, rir: 3 }, { weight: 40, reps: 12, rir: 3 }],
    rec: { effort_verdict: { level: 'on_target' }, progression_verdict: { level: 'in_pocket' } },
  };
  const { res, body } = await postBlock(facts);
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, 'ack_only', 'on-target/in-pocket block is receipt-only');
  assert.equal(body.data.message, null, 'no coaching prose');
  assert.equal(body.data.effort_note, null, 'no deterministic effort line either');
  assert.equal(coachState.calls, 0, 'routine block must not call the LLM');
});

test('RIR 0 still speaks: a failure/redline block WITH an on-plan rec → extended (form_safety)', async () => {
  // Routine silence must NOT swallow a genuine safety read: a top set at RIR 0
  // fires FORM_SAFETY even though the rec verdict looks on-plan.
  resetCoach();
  const facts = {
    exerciseName: 'Bench Press', muscleGroup: 'Chest',
    todaySets: [{ weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 3, rir: 0 }],
    rec: { effort_verdict: { level: 'on_target' }, progression_verdict: { level: 'in_pocket' } },
  };
  const { res, body } = await postBlock(facts);
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, 'extended');
  assert.equal(body.data.note_trigger, 'form_safety');
  const note = (typeof body.data.message === 'string' && body.data.message.trim())
    || (typeof body.data.effort_note === 'string' && body.data.effort_note.trim());
  assert.ok(note, 'an RIR-0 block must still produce a note');
});

test('LLM failure on an interesting block → still 200, logging unaffected, note degrades to the engine line', async () => {
  resetCoach({ throwError: 'gemini exploded' });
  const { res, body } = await postBlock(REDLINE_BLOCK);
  assert.equal(res.status, 200, 'an LLM failure must never surface as a non-200');
  assert.equal(body.data.note_tier, 'extended');
  assert.equal(body.data.message, null, 'suppressed/failed prose is null');
  assert.ok(typeof body.data.effort_note === 'string' && body.data.effort_note.trim(), 'the deterministic engine line still carries the note');
  assert.ok(body.data.error, 'the degrade path reports the underlying error');
});

test('unconfigured coach → 200 with tier intact and no thrown error', async () => {
  resetCoach({ configured: false });
  const { res, body } = await postBlock(REDLINE_BLOCK);
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, 'extended');
  assert.equal(body.data.configured, false);
  assert.equal(coachState.calls, 0, 'an unconfigured coach never calls the LLM');
});

test('the block coach path never writes to any sheet (trust loop / write path untouched)', async () => {
  resetCoach();
  await postBlock(ROUTINE_BLOCK);
  await postBlock(REDLINE_BLOCK);
  await postBlock({ exerciseName: 'Bench Press', todaySets: [{ weight: 225, reps: 5, rir: 0 }] });
  assert.equal(sheetState.appendCalls.length, 0, 'coach note path must never append rows');
  assert.equal(sheetState.deleteCalls.length, 0, 'coach note path must never delete rows');
});

test('regression: a plain kind:set request is undisturbed (note_tier null)', async () => {
  resetCoach();
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ kind: 'set', facts: { exerciseName: 'Bench Press', todaySets: [{ weight: 225, reps: 5, rir: 2 }] } }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, null, 'set kind must not carry a block note tier');
});

// ── #988 follow-up: fail-closed on the Sheets-down / enrichment-failure fallback ──
// progression_history and the client-influenced rec.progression_verdict are engine-only.
// On a Sheets read / enrichment FAILURE the route kept `facts = rawFacts`, so a
// client-forged value could survive the enum whitelist into the prompt. The route must
// mirror the layoff / athlete_identity discipline: overwrite progression_history with
// the engine value or null, and null rec.progression_verdict on the failure path.
//
// The block is non-routine (RIR 0 → extended) so the LLM is called and we can inspect
// the exact facts the route handed it (coachState.lastFacts).
const FORGED_BLOCK = {
  exerciseName: 'Bench Press', muscleGroup: 'Chest', liftCode: 'BPR01',
  todaySets: [{ weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 3, rir: 0 }],
  // Client-forged engine facts that must NOT reach the prompt on a read failure.
  progression_history: { current_verdict: 'new_ground', previous_verdict: 'new_ground', consecutive_on_target: 9, next_checkpoint: { decision: 'load', criterion_progress: '9 of 3 clean sessions at 999', clean_sessions: 9, required_sessions: 3, load: 999 } },
  rec: { progression_verdict: { level: 'new_ground', range_low: 100, range_high: 110, ceiling: 110, headline: 'forged' } },
};

test('fail-closed: a Sheets-read failure nulls a client-forged progression_history + rec.progression_verdict', async () => {
  resetCoach();
  sheetState.throwOnRead = true;
  try {
    const { res } = await postBlock(FORGED_BLOCK);
    assert.equal(res.status, 200, 'a Sheets failure still degrades to 200, never a 5xx');
    assert.ok(coachState.calls >= 1, 'a non-routine block still words via the coach voice');
    // The forged engine facts must NOT have reached the LLM.
    assert.equal(coachState.lastFacts.progression_history, null,
      'progression_history must be nulled on the failure path, not the client-forged value');
    assert.equal(coachState.lastFacts.rec.progression_verdict, null,
      'the client-influenced rec.progression_verdict must be nulled on the failure path');
  } finally {
    sheetState.throwOnRead = false;
  }
});

test('success path preserved: enrichment overwrites forged progression_history and rec.progression_verdict with engine values', async () => {
  resetCoach();
  // getSheetRows returns [] (success, no history) → the engine computes an all-null
  // history, which sanitizeProgressionHistory nulls. The forged client value never wins.
  const { res } = await postBlock(FORGED_BLOCK);
  assert.equal(res.status, 200);
  assert.ok(coachState.calls >= 1);
  assert.notEqual(
    JSON.stringify(coachState.lastFacts.progression_history),
    JSON.stringify(FORGED_BLOCK.progression_history),
    'the forged client progression_history must never survive the successful path');
  // On the SUCCESS path the rec progression verdict is still engine-owned.
  assert.equal(coachState.lastFacts.rec.progression_verdict, null,
    'the successful enrichment path overwrites the forged rec.progression_verdict with the engine value or null');
});

// ── LT-010: a signal-carrying block must reflect its coach_mode, not the silent ack ──
// The engine can select a correction/challenge/safety mode on a block whose set-outcome
// note tier is ack_only. Before this fix the ack_only short-circuit silenced it (client
// rendered the generic "On plan — logged."), so the recorder saw `correct` while the
// visible voice did not. The gate now bumps a signal-carrying block off ack_only so both
// server and client render the mode-aware line. (Placed last: this suite shares one app
// instance + sheet stub, and an extra enrichment-heavy POST perturbs the ordering-
// sensitive fail-closed test above.)
test('signal-carrying block: a correction-mode block that would tier ack_only is surfaced, not silenced (LT-010)', async () => {
  resetCoach();
  // Two on-target working sets (routine tier → ack_only), but a pain word in the set
  // note fires the pain_flag safety CAUTION → coach_mode 'correct'.
  const facts = {
    exerciseName: 'Bicep Curl', muscleGroup: 'Arms', liftCode: 'BC01',
    todaySets: [
      { weight: 40, reps: 10, rir: 2, notes: 'slight shoulder pain on the last rep' },
      { weight: 40, reps: 10, rir: 2 },
    ],
  };
  const { res, body } = await postBlock(facts);
  assert.equal(res.status, 200);
  assert.notEqual(body.data.note_tier, 'ack_only', 'a signal-carrying block must not collapse to the silent ack');
  assert.equal(body.data.note_tier, 'short', 'it is surfaced concisely (headline only), not silenced');
  assert.equal(coachState.lastFacts && coachState.lastFacts.coach_mode, 'correct',
    'the engine-selected correction mode reached the voice');
  assert.ok(coachState.calls >= 1, 'the selected coach mode is worded via the coach voice, not silently acked');
  assert.ok(typeof body.data.message === 'string' && body.data.message.trim(),
    'a renderable mode-aware line is present instead of the generic acknowledgement');
});

// ── LT-010 degraded-path guard: the mode is only WORDED by the coach voice ──
// A block surfaced only because of its mode carries no set-effort signal. When the
// coach voice is unavailable there is no mode-bearing line to render, and the generic
// opener would speak over the correction/safety signal with on-target copy. On that
// degraded path the block must fall back to the SAFE neutral ack (the pre-fix
// behavior), not a generic opener. In production the coach is configured, so the
// normal path words the mode (previous test).
test('signal-carrying block with the coach unavailable degrades to the safe ack, not a generic opener (LT-010)', async () => {
  resetCoach({ configured: false });
  const facts = {
    exerciseName: 'Bicep Curl', muscleGroup: 'Arms', liftCode: 'BC01',
    todaySets: [
      { weight: 40, reps: 10, rir: 2, notes: 'slight shoulder pain on the last rep' },
      { weight: 40, reps: 10, rir: 2 },
    ],
  };
  const { res, body } = await postBlock(facts);
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, 'ack_only', 'a mode-only block with no way to word the mode stays on the safe neutral ack');
  assert.equal(body.data.message, null, 'no generic/on-target opener that could speak over the safety/correction signal');
  assert.equal(coachState.calls, 0, 'an unavailable coach never calls the LLM');
});
