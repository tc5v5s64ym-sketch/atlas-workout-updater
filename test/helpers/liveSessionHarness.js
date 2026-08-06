'use strict';

// The live-session read-budget harness.
//
// THE AUTHORITY THIS REPLACES. PR #1271 budgeted the session against a hand-authored
// `ownerPatternSequence` and measured 46 reads. The authorized non-counting debug run then
// measured 116 observable reads with a rolling-60s peak of 87 and threw 429s. The
// hand-authored sequence was the defect: it was a plausible reconstruction of the session,
// not the session. This harness replays `test/fixtures/liveSessionManifest.json` — the
// exact client request manifest captured from that failed run — in order, with its real
// multiplicity, and nothing about the sequence is invented here.
//
// WHAT THE MANIFEST CORRECTED, beyond the totals:
//   • the client makes THIRTEEN `test_mode` previews and ONE live write of all twelve rows
//     at closeout (`verify-range?expected_rows=12`), not twelve separate live Saves;
//   • after the closeout it fires a DASHBOARD REFRESH BURST — eleven requests in six
//     seconds, several of them exact duplicates (`prs/recent`, `stalls`, `summary/weekly`
//     twice each). That burst lands inside the peak window and the old sequence had none
//     of it;
//   • it issues both `recommend/next/{code}?intentId=work_day` (bare) and the same path
//     with `w/reps/rir` — different state, not duplicates — plus a six-lift bare sweep
//     immediately before closeout.
//
// Only `googleapis` is faked. The real `sheets.js`, the real Express app and every real
// handler run, and reads are counted at the API boundary, so nothing above it can
// under-report.

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'liveSessionManifest.json'), 'utf8')
);

const SESSION_DATE = '2026-08-06';
const SESSION_ID = '20260806-AM-01';
const PLAN_VERSION = 'pv_live_manifest';

const LIFTS = [
  { name: 'Back Squat', code: 'SQ01', w: 225, reps: 5 },
  { name: 'Overhead Press', code: 'OHP01', w: 110, reps: 6 },
  { name: 'RDL', code: 'RDL01', w: 235, reps: 5 },
  { name: 'Incline DB Press', code: 'IDB01', w: 55, reps: 8 },
  { name: 'Seated Row', code: 'SR01', w: 205, reps: 10 },
  { name: 'Bicep Curl', code: 'BC01', w: 35, reps: 15 },
];

const planItems = LIFTS.map((lift, i) => ({
  plan_item_id: `pi_${lift.code.toLowerCase()}`,
  planned_lift_code: lift.code,
  planned_order: i + 1,
}));

/** The twelve logged sets, in the order the session logs them. */
const SET_ROWS = LIFTS.flatMap(lift => [1, 2].map(setNumber => ({
  exercise: lift.name, set_number: setNumber, weight: lift.w, reps: lift.reps, rir: 2,
})));

const CLOSEOUT_CONTEXT = {
  plan_version: PLAN_VERSION,
  items: LIFTS.map((lift, i) => ({
    plan_item_id: planItems[i].plan_item_id,
    planned_lift_code: lift.code,
    performed_lift_code: lift.code,
    outcome: 'completed',
  })),
};

const sessionRef = { session_id: SESSION_ID, session_date: SESSION_DATE, plan_version: PLAN_VERSION };

// THE CLIENT BODY CONTRACT, and why this table exists.
//
// The captured manifest records methods, paths, query strings and timing — never bodies, so
// no owner data is stored. That privacy choice has a cost the exact-head review caught: a
// reconstructed body is a SECOND authority beside the manifest, and a wrong one silently
// measures the wrong branch. `/api/suggest-substitute` was reconstructed as
// `{ exercise, reason }` when the client sends `{ message, current_exercise }`, so the route
// early-returned "not a constraint message" instead of reading history — a cheaper request
// than the one the session really made.
//
// Every entry below names the EXACT client producer it is copied from, file and line, and
// `test/liveSessionManifestContract.test.js` reads those producers' source and fails when a
// body here stops matching the keys the client actually sends. The manifest plus these
// branch-defining inputs are the acceptance authority together; neither alone is.
// `keys` — every top-level field the client sends.
// `shape` — how the client builds it, which decides what can be checked and how:
//    'inline'     the body literal sits beside the `api(...)` call, so the declared keys are
//                 verifiable against the client's own source text;
//    'assembled'  the body is a variable built elsewhere (`pendingWrite.payload`, or a
//                 payload composed by a service), so a text check beside the call would
//                 find nothing. Those are verified instead by the branch-outcome assertion
//                 in test/liveSessionReadBudget.test.js, which fails if the request stops
//                 producing the response the real one produced — stronger evidence than a
//                 string match, and the reason this distinction is recorded rather than
//                 quietly exempted.
const CLIENT_BODY_PRODUCERS = {
  // src/app/app.js — the intent-observe fetch
  '/api/debug/intent-observe': { keys: ['message', 'app_version', 'request_origin'], shape: 'inline' },
  // src/app/app.js — parseWorkoutTextWithBackend
  '/api/parse-workout-text': { keys: ['text', 'context', 'test_mode'], shape: 'inline' },
  // src/app/app.js — approve handler; body is `pendingWrite.payload` with test_mode deleted
  '/api/log-workout': {
    keys: ['date', 'session_id', 'test_mode', 'log_rows', 'write_id', 'closeout_context'],
    shape: 'assembled',
  },
  // src/app/coach-conversation.js — getLlmCoachingMessage (kind 'block' in session)
  '/api/coach/message': { keys: ['facts', 'kind'], shape: 'inline' },
  // src/app/coach-conversation.js — getChatReply
  '/api/coach/chat': { keys: ['message', 'history', 'context'], shape: 'inline' },
  // src/app/coach-conversation.js — the SME lane
  '/api/coach/ask': { keys: ['message'], shape: 'inline' },
  // src/app/app.js — checkAndSuggestSubstitute
  '/api/suggest-substitute': { keys: ['message', 'current_exercise'], shape: 'inline' },
  // src/app/app.js — modality preview (previewPayload)
  '/api/log-modality': { keys: ['text', 'session_id', 'date', 'test_mode'], shape: 'assembled' },
  // src/app/app.js — postAccept / postLedgerCheckpoint / postOutcome; payloads composed by
  // runAcceptance and runOutcome, so only the revision body is a literal beside its call.
  '/api/session-plans/accept': { keys: ['session_id', 'session_date', 'plan_version', 'items'], shape: 'assembled' },
  '/api/session-plans/outcome': { keys: ['session_id', 'session_date', 'plan_version', 'item'], shape: 'assembled' },
  '/api/session-plan-sets/accept': { keys: ['session_id', 'session_date', 'plan_version', 'items'], shape: 'assembled' },
  '/api/session-plan-sets/revision': { keys: ['session_id', 'session_date', 'plan_version', 'revision'], shape: 'inline' },
};

/**
 * Bodies for the manifest's POSTs, each copied from the producer named above.
 *
 * `index` is that path's occurrence number (0-based), so a route whose body legitimately
 * changes across the session (the Saves) gets the right one.
 */
function bodyFor(pathname, index, runId) {
  switch (pathname) {
    case '/api/debug/intent-observe':
      return { message: `${LIFTS[index % LIFTS.length].name} set logged`, request_origin: 'athlete_ui', app_version: 'live-manifest' };

    case '/api/parse-workout-text':
      // `context.activeExercise` is BRANCH-DEFINING: without it a bare set sequence has no
      // lift to attach to and the parser asks for clarification instead of parsing.
      return {
        text: `${LIFTS[index % LIFTS.length].w} ${LIFTS[index % LIFTS.length].reps}/2`,
        context: {
          activeExercise: LIFTS[index % LIFTS.length].name,
          activeSessionType: null,
          todayPlan: null,
        },
        test_mode: true,
      };

    case '/api/log-workout': {
      // THIRTEEN previews, then the ONE live closeout write of all twelve rows. This is
      // what the manifest shows the client doing; modelling it as twelve live Saves (as
      // PR #1271 did) both over-counted writes and under-counted the closeout.
      const isCloseout = index === LAST_SAVE_INDEX;
      if (isCloseout) {
        return {
          date: SESSION_DATE, session_id: SESSION_ID, write_id: `w_${runId}_closeout`,
          log_rows: SET_ROWS, closeout_context: CLOSEOUT_CONTEXT,
        };
      }
      const row = SET_ROWS[Math.min(index, SET_ROWS.length - 1)];
      return { date: SESSION_DATE, session_id: SESSION_ID, test_mode: true, log_rows: [row] };
    }

    case '/api/coach/message': {
      // kind 'block', not 'set'. The in-session per-exercise reaction is what this session
      // fired, and the kind selects the voice AND the coachNoteTier gate on the server.
      const lift = LIFTS[index % LIFTS.length];
      return {
        kind: 'block',
        facts: { exercise: lift.name, lift_code: lift.code, weight: lift.w, reps: lift.reps, rir: 2, set_number: 1 },
      };
    }

    case '/api/coach/chat':
      // `history` and `context` are branch-defining for the grounding the route assembles.
      return { message: 'how am I tracking today?', history: [], context: {} };
    case '/api/coach/ask':
      return { message: 'should I add weight?' };

    case '/api/suggest-substitute':
      // CORRECTED (exact-head review). Was `{ exercise, reason }` — field names the route
      // does not read, so `current_exercise` was undefined and it returned early without
      // ever reaching the history-reading recommendation branch. The client sends the
      // athlete's own words plus the lift they are on.
      //
      // WHICH BRANCH, and how that is chosen. The route has three outcomes, all HTTP 200:
      // no constraint keyword (no read), a constraint with no known substitute (no read),
      // and a constraint WITH a substitute — which then reads Log_Cleaned for the
      // replacement's prescription. The manifest records only the status, so it cannot
      // prove which the live call took. This drives the READING branch deliberately: it is
      // the most expensive of the three, so the simulation stresses the worst case the
      // session could have caused rather than a cheaper guess. Back Squat has a known
      // substitute (Leg Press); the RDL used before this correction has none, which is why
      // even the corrected field names still stopped one branch short.
      //
      // SO THIS VALUE IS A STRESS CHOICE, NOT TRACE-DERIVED EVIDENCE. The manifest fixes the
      // route, the method and the timing; it does not fix the lift, and the producer
      // contract test checks field NAMES against the client, not the values that selected
      // the live branch. This can therefore over-count relative to the live run — one more
      // reason the figures here are a compressed simulation and not a production verdict.
      return { message: 'squat rack is busy', current_exercise: LIFTS[0].name };

    case '/api/log-modality':
      return { text: '20 min bike intervals', session_id: SESSION_ID, date: SESSION_DATE, test_mode: true };

    case '/api/session-plans/accept':
      return { ...sessionRef, items: planItems };

    case '/api/session-plans/outcome':
      return {
        ...sessionRef,
        item: { plan_item_id: planItems[0].plan_item_id, outcome: 'completed', planned_lift_code: LIFTS[0].code },
      };

    case '/api/session-plan-sets/accept':
      return {
        ...sessionRef,
        items: planItems.map(item => ({
          ...item, target_set_count: 2, set_index: 1, set_number: 1,
          planned_weight: 100, planned_reps: 5, planned_rir: 2, source: 'accepted_plan',
        })),
      };

    case '/api/session-plan-sets/revision':
      return {
        ...sessionRef,
        revision: {
          plan_item_id: planItems[3].plan_item_id, target_set_count: 2, set_index: 2,
          set_number: 2, plan_version: 2, planned_lift_code: LIFTS[3].code,
          planned_weight: 60, planned_reps: 8, planned_rir: 2,
          recommendation_source: 'live_revision', endorsement: 'user_endorsed',
        },
      };

    default:
      return undefined;
  }
}

// The index of the ONE live Save, derived from the manifest rather than assumed: it is the
// last `/api/log-workout` occurrence, and the manifest's `verify-range?expected_rows=12`
// immediately after it is what identifies it as the twelve-row closeout write.
const SAVE_INDEXES = MANIFEST.requests
  .map((r, i) => ({ r, i }))
  .filter(({ r }) => r.path === '/api/log-workout')
  .map(({ i }) => i);
const LAST_SAVE_OCCURRENCE = SAVE_INDEXES.length - 1;
const LAST_SAVE_INDEX = LAST_SAVE_OCCURRENCE;

// The manifest index of the session's ONE live write: the last `/api/log-workout`. Every
// earlier occurrence is a `test_mode` preview, which writes nothing anywhere —
// `test/recommendationInputWrites.test.js` replays the whole session and proves it.
const LIVE_SAVE_MANIFEST_INDEX = MANIFEST.requests
  .map((entry, index) => ({ entry, index }))
  .filter(({ entry }) => entry.path === '/api/log-workout')
  .map(({ index }) => index)
  .pop();

/**
 * Manifest indexes of recommendation requests that repeat an EARLIER identical question with
 * nothing between them that could change the answer.
 *
 * Derived by rule rather than listed, so it cannot drift from the manifest and cannot be
 * quietly widened. "Identical" means the same path AND the same query — the lift code, the
 * plan intent and the just-logged w/reps/rir all live there, so a different set is a
 * different key. "Nothing between" means both asks fall before the session's one live write:
 * that write is the only thing in the whole session that touches a tab the engine reads.
 */
const REPEATED_RECOMMENDATIONS = (() => {
  const firstAsk = new Map();
  const repeats = new Set();
  MANIFEST.requests.forEach((entry, index) => {
    if (!entry.path.startsWith('/api/recommend/next/')) return;
    const key = `${entry.path}?${entry.query || ''}`;
    const earlier = firstAsk.get(key);
    if (earlier === undefined) { firstAsk.set(key, index); return; }
    if (earlier < LIVE_SAVE_MANIFEST_INDEX && index < LIVE_SAVE_MANIFEST_INDEX) repeats.add(index);
  });
  return repeats;
})();

// CLIENT CORRECTIONS ─────────────────────────────────────────────────────────
//
// The manifest is the CAPTURED client: what the deployed app actually asked for on
// 2026-08-05. The corrective's whole point is that the real client must ASK FOR LESS, so
// the budget has to be measured against the CORRECTED client — and the corrected client's
// request list cannot be captured, because running another live debug session is not
// authorized.
//
// It is therefore DERIVED, one proven removal at a time. Each entry below removes requests
// from the captured manifest and must carry:
//   • the exact manifest requests it removes (never a route "that reads nothing anyway" —
//     that omission is forbidden, and `correctionLedger()` proves each removal matched);
//   • WHY the corrected client no longer issues them;
//   • the guard tests that prove the client change, independently of this file.
//
// Nothing here compresses repeats, substitutes a representative call, or drops a route for
// convenience. A correction with no matching request in the captured manifest fails
// `test/liveSessionReadBudget.test.js`.
//
// A correction matches on (entry, occurrence, index) — the occurrence number of that path in
// the FULL manifest, and the manifest index — so a duplicate can be named exactly. Removing
// "the second /api/coaching/insights" must never be expressible as "all of them".
const CLIENT_CORRECTIONS = [
  {
    id: 'C3-verify-range-retired',
    match: (entry) => entry.path === '/api/log-workout/verify-range',
    why: 'The append receipt adjudicated in the write response (log_write_verification) is '
      + 'now the write-verification authority, so the client no longer spends a metered '
      + 'read re-reading the range it was just told about.',
    guards: [
      // the server publishes an adjudicated receipt on a real Save
      'test/appendWriteProof.test.js',
      // the client takes exactly one verification path, and it is not this route
      'tests/e2e/write-verification-authority.spec.js',
    ],
  },

  // C2 — three reads the app asked for TWICE at the same moment, with nothing written
  // between them. Each pair is two cards wanting the same answer; the second now joins the
  // first while it is still in flight. Only the SECOND of each pair is removed: the first
  // is the real request, and the later post-Save fan-out is a new question at a new moment
  // and stays.
  {
    id: 'C2-intent-recommendation-duplicate',
    // occurrence 1 = the 2.6 s call, 0.4 s after loadDashboard's. loadCoachPlan's.
    match: (entry, occurrence) => entry.path === '/api/plan/intent-recommendation' && occurrence === 1,
    why: 'loadDashboard and loadCoachPlan both open with this read, 0.4 s apart with nothing '
      + 'written between; the second now joins the first in flight.',
    guards: ['tests/e2e/duplicate-read-coalescing.spec.js'],
  },
  {
    id: 'C2-coaching-insights-duplicate',
    // occurrence 1 = the 2.6 s call. loadCoaching's, after loadWeeklyCoach's at 1.7 s.
    match: (entry, occurrence) => entry.path === '/api/coaching/insights' && occurrence === 1,
    why: 'loadWeeklyCoach and loadCoaching both open with this read, 0.9 s apart; starting '
      + "loadDashboard's below-fold group in the same tick makes them share one request "
      + 'deterministically rather than by timing luck.',
    guards: ['tests/e2e/duplicate-read-coalescing.spec.js'],
  },
  {
    id: 'C2-prs-recent-duplicate',
    // occurrence 2 = the 66.5 s call. The verdict strip's, 0.8 s after the post-Save
    // dashboard refresh asked the same thing. Occurrence 0 (app open) and occurrence 1
    // (the refresh itself) are genuinely different moments and both stay.
    match: (entry, occurrence) => entry.path === '/api/prs/recent' && occurrence === 2,
    why: 'after a Save the dashboard refresh and the verdict strip both want the PR list, '
      + '0.8 s apart and after the same write; the second joins the first in flight.',
    guards: ['tests/e2e/duplicate-read-coalescing.spec.js'],
  },

  // C4 — the same recommendation asked twice per lift, because both sets of a pair were
  // logged at the same load. Only a repeat of an IDENTICAL question with provably unchanged
  // inputs is removed; the six-lift bare sweep before closeout and the post-Save ask are
  // different questions and stay.
  {
    id: 'C4-repeated-recommendation',
    match: (entry, occurrence, index) => REPEATED_RECOMMENDATIONS.has(index),
    why: 'the lift code, plan intent and just-logged w/reps/rir are all in the URL, and the '
      + 'only tabs the engine also reads are untouched between the two asks — the session\'s '
      + 'one live write comes later — so the second ask cannot have a different answer.',
    guards: [
      // the client asks once for the same set, and asks again for a different set or a Save
      'tests/e2e/recommendation-request-reuse.spec.js',
      // nothing else in the session writes a tab a recommendation reads
      'test/recommendationInputWrites.test.js',
    ],
  },
];

/**
 * The manifest as a driveable sequence: [method, url, body] in the captured order, with
 * placeholders substituted. Repeated requests are NOT compressed and no request is
 * dropped — that compression is exactly what made the previous harness wrong.
 *
 * `corrected: true` applies CLIENT_CORRECTIONS, giving the request list the corrected
 * client issues. Everything else — order, multiplicity, bodies — is identical.
 */
function liveSessionSequence({ runId = 'r1', appendedRange = 'Log_Cleaned!A2:L13', corrected = false } = {}) {
  // Occurrence numbers come from the FULL manifest, never from the filtered list, so a
  // correction that removes SOME occurrences of a path cannot silently renumber the rest
  // and hand a later request an earlier request's body.
  const occurrence = new Map();
  const numbered = MANIFEST.requests.map((entry, index) => {
    const n = occurrence.get(entry.path) || 0;
    occurrence.set(entry.path, n + 1);
    return { entry, n, index };
  });
  const requests = corrected
    ? numbered.filter(({ entry, n, index }) => !CLIENT_CORRECTIONS.some(c => c.match(entry, n, index)))
    : numbered;
  return requests.map(({ entry, n }) => {
    const query = entry.query
      ? entry.query
        .replace('{SESSION_ID}', encodeURIComponent(SESSION_ID))
        .replace('{APPENDED_RANGE}', encodeURIComponent(appendedRange))
      : null;
    return [
      entry.method,
      entry.path + (query ? `?${query}` : ''),
      entry.method === 'POST' ? bodyFor(entry.path, n, runId) : undefined,
      // `offsetMs` is the request's captured position in the live session, carried so a
      // caller can replay the ORIGINAL 70.9-second timing on a virtual clock instead of
      // driving everything back to back. Without it the 30-second row cache never expires
      // and every request falls inside one rolling minute — neither of which is the
      // session that was captured.
      { path: entry.path, occurrence: n, expectedStatus: entry.status, offsetMs: entry.offset_ms },
    ];
  });
}

/** Endpoint call counts the manifest requires — used to prove nothing was compressed. */
function manifestEndpointCounts() {
  const counts = new Map();
  for (const entry of MANIFEST.requests) {
    const key = `${entry.method} ${entry.path}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/** The manifest with each request's per-path occurrence number and manifest index attached. */
function numberManifest() {
  const seen = new Map();
  return MANIFEST.requests.map((entry, index) => {
    const n = seen.get(entry.path) || 0;
    seen.set(entry.path, n + 1);
    return { entry, n, index };
  });
}

/**
 * What each correction actually removed from the captured manifest. The budget test asserts
 * every correction removed at least one REAL captured request, so a correction can never be
 * a comment that quietly excuses an omission.
 */
function correctionLedger() {
  return CLIENT_CORRECTIONS.map(correction => ({
    id: correction.id,
    why: correction.why,
    guards: correction.guards,
    removed: numberManifest()
      .filter(({ entry, n, index }) => correction.match(entry, n, index))
      .map(({ entry, n }) => `${entry.method} ${entry.path} #${n}`),
  }));
}

module.exports = {
  MANIFEST,
  SESSION_DATE,
  SESSION_ID,
  PLAN_VERSION,
  LIFTS,
  SET_ROWS,
  planItems,
  sessionRef,
  CLOSEOUT_CONTEXT,
  liveSessionSequence,
  manifestEndpointCounts,
  CLIENT_BODY_PRODUCERS,
  bodyFor,
  correctionLedger,
  CLIENT_CORRECTIONS,
  SAVE_INDEXES,
};
