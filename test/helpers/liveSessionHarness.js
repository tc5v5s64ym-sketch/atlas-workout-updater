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

/**
 * Bodies for the manifest's POSTs.
 *
 * The manifest records methods, paths, query strings and timing — never bodies, so no
 * owner data is stored. The bodies are reconstructed here from the session's own shape.
 * `index` is that path's occurrence number (0-based), so a route whose body legitimately
 * changes across the session (the Saves) gets the right one.
 */
function bodyFor(pathname, index, runId) {
  switch (pathname) {
    case '/api/debug/intent-observe':
      return { message: `${LIFTS[index % LIFTS.length].name} set logged`, request_origin: 'athlete_ui', app_version: 'live-manifest' };

    case '/api/parse-workout-text':
      return { text: `${LIFTS[index % LIFTS.length].w} ${LIFTS[index % LIFTS.length].reps}/2`, test_mode: true };

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
      const lift = LIFTS[index % LIFTS.length];
      return {
        kind: 'set',
        facts: { exercise: lift.name, lift_code: lift.code, weight: lift.w, reps: lift.reps, rir: 2, set_number: 1 },
      };
    }

    case '/api/coach/chat':
      return { message: 'how am I tracking today?' };
    case '/api/coach/ask':
      return { message: 'should I add weight?' };

    case '/api/suggest-substitute':
      return { exercise: 'RDL', reason: 'equipment' };

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

/**
 * The manifest as a driveable sequence: [method, url, body] in the captured order, with
 * placeholders substituted. Repeated requests are NOT compressed and no request is
 * dropped — that compression is exactly what made the previous harness wrong.
 */
function liveSessionSequence({ runId = 'r1', appendedRange = 'Log_Cleaned!A2:L13' } = {}) {
  const occurrence = new Map();
  return MANIFEST.requests.map((entry) => {
    const n = occurrence.get(entry.path) || 0;
    occurrence.set(entry.path, n + 1);
    const query = entry.query
      ? entry.query
        .replace('{SESSION_ID}', encodeURIComponent(SESSION_ID))
        .replace('{APPENDED_RANGE}', encodeURIComponent(appendedRange))
      : null;
    return [
      entry.method,
      entry.path + (query ? `?${query}` : ''),
      entry.method === 'POST' ? bodyFor(entry.path, n, runId) : undefined,
      { path: entry.path, occurrence: n, expectedStatus: entry.status },
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
  SAVE_INDEXES,
};
