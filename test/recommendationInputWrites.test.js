'use strict';

// C4 — WHAT CAN CHANGE A RECOMMENDATION.
//
// `GET /api/recommend/next/{code}` answers from three tabs — Log_Cleaned, Deload_State and
// Constraints — plus the query it was given (lift code, intentId, and the just-logged
// w/reps/rir). The captured manifest shows the client asking the SAME question twice for
// every lift, 1.9–12 s apart, with identical parameters:
//
//     GET /api/recommend/next/SQ01?intentId=work_day&w=225&reps=5&rir=2  @ 8.2 s and @ 10.1 s
//     …and the same for OHP01, RDL01, IDB01, SR01, BC01.
//
// The client may only reuse the first answer if it can PROVE nothing that feeds it changed.
// The query is in the URL, so the open question is the three tabs — and this file answers it
// from the session itself rather than from a hand-written list: it replays the whole captured
// manifest against the real app and records, per HTTP request, every tab that was actually
// written.
//
// The result is the client's invalidation contract. A route that starts writing one of the
// three tabs, or a new route added to the session that writes one, fails this test — which
// is what stops the client's reuse rule from silently going stale.

const test = require('node:test');
const assert = require('node:assert/strict');

const BUDGET_TEST_ENV = {
  ATLAS_API_KEY: 'test-api-key',
  GOOGLE_SHEETS_ID: 'test-spreadsheet-id',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'svc@example.iam.gserviceaccount.com',
  GOOGLE_PRIVATE_KEY: 'KEYLINE1\\nKEYLINE2\\n',
  ATLAS_INTENT_ROUTER: 'shadow',
  ATLAS_COACH_ENGINE: 'hybrid',
  ATLAS_API_RATE_LIMIT_MAX: '1000000',
  ATLAS_WRITE_RATE_LIMIT_MAX: '1000000',
  ATLAS_SESSION_PLANS_WRITE: '1',
  SESSION_PLAN_SETS_WRITE_ENABLED: '1',
};
Object.assign(process.env, BUDGET_TEST_ENV);
process.env.ATLAS_IDEMPOTENCY_FILE = require('node:path').join(
  require('node:os').tmpdir(), 'atlas-recommendation-input-writes-idempotency.json');

const {
  logCleanedColumns, effortColumns, deloadStateColumns,
  sessionPlansColumns, sessionPlanSetsColumns, constraintsColumns,
} = require('../config/columns');

const { LIFTS, liveSessionSequence } = require('./helpers/liveSessionHarness');

// The tabs a recommendation surface reads. `GET /api/recommend/next/{code}` reads three of
// them — the batch it issues is exactly Log_Cleaned, Deload_State, Constraints — and Effort
// is included because `/api/plan/intent-recommendation`, the other prescription surface,
// reads it too. A deliberately conservative superset: a tab listed here that a
// recommendation does not actually read only makes this audit stricter.
const RECOMMENDATION_INPUT_TABS = ['Log_Cleaned', 'Effort', 'Deload_State', 'Constraints'];

const CATALOG = [
  ['Exercise', 'Canonical_Name', 'Muscle_Group', 'Lift_Code'],
  ...LIFTS.map(l => [l.name, l.name, 'x', l.code]),
];

let SHEET;
function resetSheet() {
  SHEET = {
    Log_Cleaned: [[...logCleanedColumns]],
    Effort: [[...effortColumns]],
    Deload_State: [[...deloadStateColumns], ['2026-08-01T00:00:00.000Z', 'NORMAL', '', '', '', '', '']],
    Session_Plans: [[...sessionPlansColumns]],
    Session_Plan_Sets: [[...sessionPlanSetsColumns]],
    Exercise_Catalog: CATALOG,
    Constraints: [[...constraintsColumns]],
    Coaching_Notes: [['date', 'note']],
  };
}
resetSheet();

function valuesForRange(range) {
  const text = String(range || '');
  const bang = text.indexOf('!');
  const tab = bang === -1 ? text : text.slice(0, bang);
  const spec = bang === -1 ? '' : text.slice(bang + 1);
  const rows = SHEET[tab];
  if (!rows) return { error: new Error(`Unable to parse range: ${text}`) };
  if (/^1:1$/.test(spec)) return { values: [rows[0]] };
  const a1 = /^([A-Z]+)(\d*):([A-Z]+)(\d*)$/.exec(spec);
  if (!a1) return { values: rows };
  const col = (letters) => letters.split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
  const [, c1, r1, c2, r2] = a1;
  const first = r1 ? Number(r1) - 1 : 0;
  const last = r2 ? Number(r2) : rows.length;
  return { values: rows.slice(first, last).map(row => row.slice(col(c1), col(c2) + 1)) };
}

// The tab every write touched, attributed to the HTTP request that CAUSED it.
//
// Attribution comes from the request-scoped async context, not from a "which request is in
// flight right now" global. Several of these writes are fire-and-forget shadow appends that
// land after their response has been sent, and a global would credit them to whichever
// request happened to be running when they finished. That is exactly the
// next-completed-request heuristic that produced the wrong per-endpoint figures earlier in
// this corrective, and it is not repeated here.
const writesByRequest = new Map();
function recordWrite(tab) {
  const identity = sheets.currentRequestIdentity();
  if (!identity) return;
  const key = `${identity.method} ${identity.path}`;
  if (!writesByRequest.has(key)) writesByRequest.set(key, new Set());
  writesByRequest.get(key).add(String(tab));
}

const fake = {
  spreadsheets: {
    get: async () => ({ data: { sheets: Object.keys(SHEET).map(title => ({ properties: { title, sheetId: 1 } })) } }),
    batchUpdate: async () => ({ data: {} }),
    values: {
      get: async ({ range }) => {
        const out = valuesForRange(range);
        if (out.error) throw out.error;
        return { data: { values: out.values } };
      },
      batchGet: async ({ ranges }) => {
        const valueRanges = [];
        for (const range of ranges) {
          const out = valuesForRange(range);
          if (out.error) throw out.error;
          valueRanges.push({ range, values: out.values });
        }
        return { data: { valueRanges } };
      },
      append: async ({ range, requestBody }) => {
        const tab = String(range).split('!')[0];
        recordWrite(tab);
        if (!SHEET[tab]) SHEET[tab] = [];
        for (const row of requestBody.values) SHEET[tab].push(row.map(v => (v == null ? '' : String(v))));
        const n = requestBody.values.length;
        const last = SHEET[tab].length;
        return { data: { updates: { updatedRows: n, updatedRange: `${tab}!A${last - n + 1}:L${last}` } } };
      },
      update: async ({ range }) => { recordWrite(String(range).split('!')[0]); return { data: {} }; },
      batchUpdate: async ({ requestBody }) => {
        let totalUpdatedCells = 0;
        for (const entry of requestBody?.data || []) {
          const [tab, spec] = String(entry.range).split('!');
          recordWrite(tab);
          const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(spec || '');
          const rows = SHEET[tab];
          if (!m || !rows) continue;
          const col = m[1].split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
          const firstRow = Number(m[2]);
          (entry.values || []).forEach((rowValues, i) => {
            const sheetRow = rows[firstRow - 1 + i];
            if (!sheetRow) return;
            rowValues.forEach((value, j) => { sheetRow[col + j] = String(value == null ? '' : value); });
            totalUpdatedCells += rowValues.length;
          });
        }
        return { data: { totalUpdatedCells } };
      },
    },
  },
};

const googleapisPath = require.resolve('googleapis');
require.cache[googleapisPath] = {
  id: googleapisPath, filename: googleapisPath, loaded: true,
  exports: { google: { auth: { GoogleAuth: class { async getClient() { return {}; } } }, sheets: () => fake } },
};
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true,
  exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) },
};

const sheets = require('../sheets');
const { resetIdempotencyStore } = require('../services/idempotency');
const { app } = require('../index');

let server; let baseUrl;
test.before(async () => {
  server = await new Promise(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

// The other half of the reuse rule, proved on its own rather than inferred from the replay:
// a `test_mode` preview writes NOTHING, anywhere. That is what lets a recommendation survive
// across the previews that sit between the two identical asks.
test('a test_mode preview writes nothing at all', async () => {
  resetSheet();
  resetIdempotencyStore();
  writesByRequest.clear();

  const res = await fetch(`${baseUrl}/api/log-workout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify({
      date: '2026-08-06', session_id: 'PREVIEW-ONLY', test_mode: true,
      log_rows: [{ exercise: LIFTS[0].name, set_number: 1, weight: 225, reps: 5, rir: 2 }],
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  // The W1–W3 dry-run proof — the same two fields the client's epoch rule keys on.
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);

  await new Promise(resolve => setTimeout(resolve, 800));
  assert.deepEqual([...writesByRequest.entries()].map(([r, t]) => `${r} -> ${[...t].sort().join(',')}`), [],
    'a preview must not write any tab, not even an observation one');
});

test('only a live Save writes a tab a recommendation is computed from', async () => {
  resetSheet();
  resetIdempotencyStore();
  writesByRequest.clear();

  // Replay the CAPTURED manifest — the pre-correction client, so no route the session really
  // used is missing from this audit.
  for (const [method, url, body] of liveSessionSequence({ runId: 'inputs' })) {
    await fetch(`${baseUrl}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(r => r.json()).catch(() => null);
  }
  // Fire-and-forget shadow appends land after their response. Wait for quiet so they are
  // COUNTED — they are attributed correctly by async context regardless of when they land.
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Which requests wrote a recommendation input?
  const touched = [...writesByRequest.entries()]
    .filter(([, tabs]) => [...tabs].some(t => RECOMMENDATION_INPUT_TABS.includes(t)))
    .map(([request, tabs]) => `${request} -> ${[...tabs].filter(t => RECOMMENDATION_INPUT_TABS.includes(t)).sort().join(',')}`)
    .sort();

  assert.deepEqual(touched, ['POST /api/log-workout -> Log_Cleaned'],
    'exactly one request in the whole session writes a tab a recommendation reads.\n' +
    'Everything observed:\n  ' +
    [...writesByRequest.entries()].map(([r, t]) => `${r} -> ${[...t].sort().join(',')}`).sort().join('\n  '));

  // THE TWO ALLOWLISTED ROUTES. `src/app/api.js` exempts /api/coach/message and
  // /api/debug/intent-observe from stepping the inputs epoch — every other non-GET steps it
  // unless the response proves it wrote nothing. That exemption is only sound while neither
  // route writes a tab a recommendation reads, which is what this asserts.
  //
  // What they wrote in this run is recorded rather than required: intent-observe appended
  // its Intent_Shadow row, and coach/message wrote nothing at all here (its shadow sheets
  // need configuration this harness does not supply). Requiring a write would make this test
  // fail on a configuration change that is irrelevant to the rule.
  for (const request of ['POST /api/coach/message', 'POST /api/debug/intent-observe']) {
    for (const tab of writesByRequest.get(request) || []) {
      assert.ok(!RECOMMENDATION_INPUT_TABS.includes(tab),
        `${request} is allowlisted in src/app/api.js as observation-only, but it wrote ` +
        `${tab}, which a recommendation reads. The client's reuse rule in fetchReaction no ` +
        'longer holds: remove the allowlist entry, or the reuse.');
    }
  }

  // And the allowlist may not quietly grow: these are the only two names in it.
  const apiSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'app', 'api.js'), 'utf8');
  const allowlist = /const OBSERVATION_ONLY_WRITERS = new Set\(\[([^\]]*)\]\)/.exec(apiSource);
  assert.ok(allowlist, 'the observation-only allowlist must be findable in src/app/api.js');
  assert.deepEqual(
    allowlist[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean),
    ['/api/coach/message', '/api/debug/intent-observe'],
    'a route added to the allowlist must be audited here first'
  );
});
