'use strict';

// Per-request Sheets range declarations — the wiring half of the F-SB4B session read
// budget. The transport half lives in `sheets.js` (`runWithReadContext`,
// `prefetchRanges`, `readValues`).
//
// WHY THIS EXISTS. Qualifying session 1 (2026-08-05) issued 78 Sheets reads inside one
// rolling minute against a 60/minute quota and starved itself mid-session. The
// reconstruction in `test/allSheets429.test.js` shows why: a complete
// owner-pattern session is dozens of SEPARATE `values.get` calls, many of them ranges
// that one HTTP request needs together. `spreadsheets.values.batchGet` carries N such
// ranges for ONE quota unit, so the fix is to name, per route, what that route needs.
//
// WHAT A DECLARATION IS, AND IS NOT.
//   • It is a TRANSPORT hint. It changes how many API calls carry a range, never how
//     old the values are: the batch is created and discarded inside one HTTP request.
//     Log_Cleaned dedup keys, Effort session ids, Deload_State, header rows and the
//     Session_Plans / Session_Plan_Sets ledger are all still read fresh on every request
//     that consumes them. There is no cross-request snapshot of write-sensitive evidence.
//   • It is NOT authority. Nothing here parses a range. Each existing helper still
//     interprets its own range exactly as before.
//   • It is ALLOWED to be wrong in one direction. A declared range the request never
//     reads costs nothing — it rides in the same single batch. A range the request reads
//     but does not declare still works: it falls through to the individual read it used
//     to make. So drift degrades the BUDGET, never correctness, and
//     `test/sessionReadBudget.test.js` is what fails when it drifts.
//
// Exercise_Catalog is deliberately absent from every declaration. It is the one approved
// cross-request cache and `sheets.getExerciseCatalog` owns it; batching it per request
// would defeat that cache.
//
// KNOWN LIMIT, stated rather than hidden: `values.batchGet` rejects the WHOLE batch when
// any range names a tab the spreadsheet does not have. Deload_State, Constraints,
// Coaching_Notes and the two ledger tabs are optional by contract, so on a spreadsheet
// missing one of them the batch fails as `range_unresolved` and every range in it falls
// back to an individual read — today's behaviour exactly, never worse, but the budget is
// not achieved on such a sheet. The measured acceptance runs against the contractual tab
// set, which is what the owner's spreadsheet has.

const LOG = process.env.LOG_SHEET_NAME || 'Log_Cleaned';
const EFFORT = process.env.EFFORT_SHEET_NAME || 'Effort';

// The ranges each tab is read at. Naming them once keeps a declaration readable and
// keeps a typo from silently producing a range nothing ever asks for.
const LOG_ROWS = `${LOG}!A:Z`;          // getSheetRows — full history
const LOG_KEYS = `${LOG}!B:G`;          // getLogCompositeKeys — row-level dedup
const LOG_HEADER = `${LOG}!1:1`;        // header-drift guard
const EFFORT_ROWS = `${EFFORT}!A:Z`;
const EFFORT_HEADER = `${EFFORT}!1:1`;
const EFFORT_SESSION_IDS = `${EFFORT}!B:B`;
const DELOAD_ROWS = 'Deload_State!A:Z';
const CONSTRAINTS_ROWS = 'Constraints!A:Z';
const COACHING_NOTES_ROWS = 'Coaching_Notes!A:Z';
const PLANS_ROWS = 'Session_Plans!A:Z';
const PLANS_HEADER_PROBE = 'Session_Plans!A1:A1';
const PLANS_HEADER = 'Session_Plans!A1:M1';
const PLAN_SETS_ROWS = 'Session_Plan_Sets!A:Z';
const PLAN_SETS_HEADER_PROBE = 'Session_Plan_Sets!A1:A1';
const PLAN_SETS_HEADER = 'Session_Plan_Sets!A1:P1';

// The ledger tabs are read as a set by anything that binds a plan to a performed set:
// the rows, the header-existence probe and the header itself.
const PLANS_LEDGER = [PLANS_ROWS, PLANS_HEADER_PROBE, PLANS_HEADER];
const PLAN_SETS_LEDGER = [PLAN_SETS_ROWS, PLAN_SETS_HEADER_PROBE, PLAN_SETS_HEADER];

// method + path pattern → the ranges that path's handler chain reads.
//
// Each entry is derived from BOTH the handler code and the measured session log, so it
// records observed demand rather than a guess. Paths carrying parameters are matched by
// regex on the pathname only; the query string never affects which ranges are needed.
const DECLARATIONS = [
  // Deload_State is here, not in a cache: the recommendation must see the state a
  // begin/advance/resolve wrote, so it is read fresh — and simply travels in this
  // request's batch alongside the log and constraint rows it is needed with.
  { method: 'GET', pattern: /^\/api\/recommend\/next\/[^/]+$/, ranges: [LOG_ROWS, DELOAD_ROWS, CONSTRAINTS_ROWS] },
  { method: 'GET', pattern: /^\/api\/recommendation\/preview$/, ranges: [LOG_ROWS, DELOAD_ROWS, CONSTRAINTS_ROWS] },
  { method: 'GET', pattern: /^\/api\/plan\/intent-recommendation$/, ranges: [LOG_ROWS, EFFORT_ROWS, DELOAD_ROWS, CONSTRAINTS_ROWS] },
  { method: 'GET', pattern: /^\/api\/plan\/today$/, ranges: [LOG_ROWS, DELOAD_ROWS, CONSTRAINTS_ROWS] },

  // The Save path. Dedup evidence and header guards travel together; the ledger ranges
  // ride along because a save that binds to an accepted plan reads them in the same turn.
  // The closeout arrives on this route, so the FULL ledger set rides along: the closeout
  // event and the set-ledger seal read both tabs' rows, header-existence probes and
  // headers. Declaring only the rows left five of those as separate requests.
  {
    method: 'POST', pattern: /^\/api\/log-workout$/,
    ranges: [LOG_KEYS, LOG_HEADER, EFFORT_SESSION_IDS, EFFORT_HEADER, ...PLANS_LEDGER, ...PLAN_SETS_LEDGER]
  },
  {
    method: 'POST', pattern: /^\/api\/complete-workout$/,
    ranges: [LOG_KEYS, LOG_HEADER, EFFORT_SESSION_IDS, EFFORT_HEADER, ...PLANS_LEDGER, ...PLAN_SETS_LEDGER]
  },

  { method: 'POST', pattern: /^\/api\/coach\/message$/, ranges: [LOG_ROWS, LOG_KEYS, DELOAD_ROWS] },
  { method: 'POST', pattern: /^\/api\/coach\/chat$/, ranges: [COACHING_NOTES_ROWS, CONSTRAINTS_ROWS, LOG_ROWS] },

  { method: 'POST', pattern: /^\/api\/session-plans\/accept$/, ranges: PLANS_LEDGER },
  { method: 'POST', pattern: /^\/api\/session-plans\/outcome$/, ranges: PLANS_LEDGER },
  { method: 'POST', pattern: /^\/api\/session-plan-sets\/accept$/, ranges: PLAN_SETS_LEDGER },
  { method: 'POST', pattern: /^\/api\/session-plan-sets\/revision$/, ranges: PLAN_SETS_LEDGER },

  // NO DECLARATION for /api/debug/intent-observe, deliberately.
  //
  // PR #1271 declared eight ranges here on the belief that the route "reads the widest
  // set". It does not read at all: the handler builds evidence provenance (no network)
  // and hands off to `observeChatMessage`, which classifies and APPENDS. Exact
  // request-scoped attribution confirms zero reads from this route. The twenty reads
  // previously attributed to it came from the reconstruction tool's
  // next-completed-request heuristic and belonged to concurrent requests.
  //
  // The declaration was therefore not merely dead — it was latent amplification. A
  // declaration only fires on a route's FIRST read, so the day any code added one read
  // here, that single read would have pulled an eight-range batch onto an observe-only
  // route. `test/liveSessionReadBudget.test.js` pins the zero-read contract instead.

  // The app-open fan-out. Each of these reads one or two whole tabs; declaring them
  // costs nothing extra and stops the opening burst from spending a request each.
  { method: 'GET', pattern: /^\/api\/prs\/recent$/, ranges: [LOG_ROWS] },
  { method: 'GET', pattern: /^\/api\/summary\/weekly$/, ranges: [EFFORT_ROWS] },
  // Reads Effort as well as the log; declaring only the log left BOTH as separate
  // requests, because a single declared range is a plain get rather than a batch.
  { method: 'GET', pattern: /^\/api\/history\/recent$/, ranges: [LOG_ROWS, EFFORT_ROWS] },
  { method: 'GET', pattern: /^\/api\/report\/weekly$/, ranges: [LOG_ROWS, EFFORT_ROWS] },
  { method: 'GET', pattern: /^\/api\/progress\/summary$/, ranges: [LOG_ROWS, EFFORT_ROWS] },
  { method: 'GET', pattern: /^\/api\/stalls$/, ranges: [LOG_ROWS] },
  { method: 'GET', pattern: /^\/api\/coaching\/insights$/, ranges: [LOG_ROWS, EFFORT_ROWS, CONSTRAINTS_ROWS] },
  { method: 'GET', pattern: /^\/api\/exercises\/last-session$/, ranges: [LOG_ROWS] },
  { method: 'GET', pattern: /^\/api\/session\/[^/]+$/, ranges: [LOG_ROWS, EFFORT_ROWS] },
  { method: 'GET', pattern: /^\/api\/session\/[^/]+\/summary$/, ranges: [LOG_ROWS, EFFORT_ROWS] },
];

/** The ranges declared for a method + pathname, or [] when the route declares none. */
function rangesFor(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '').split('?')[0];
  for (const entry of DECLARATIONS) {
    if (entry.method === verb && entry.pattern.test(path)) return entry.ranges;
  }
  return [];
}

/**
 * Express middleware. Opens a read context for EVERY request — so even an undeclared
 * route stops paying twice for the same range — and records this route's declaration.
 *
 * Recording is synchronous and reaches nothing. The batch is issued later, by the first
 * read the handler actually performs, so a request that reads nothing still costs
 * nothing. That is what lets a declaration safely cover every branch of a route instead
 * of only the common one.
 */
function createSessionReadBatchMiddleware(sheets = require('../sheets')) {
  return function sessionReadBatchMiddleware(req, res, next) {
    // Degrade to a plain pass-through when the adapter in play does not provide the
    // batching surface. The test suite injects minimal `sheets.js` stubs through
    // `require.cache` — a pattern CLAUDE.md requires be preserved — and a stub that
    // implements only the helpers a test needs must not be turned into a 500. Batching is
    // an optimisation: without it every read simply happens the way it always did.
    if (typeof sheets.runWithReadContext !== 'function') return next();
    // The request identity travels with the context so every read attempt can name the
    // HTTP request that caused it. Read accounting only; nothing decides on it.
    const identity = {
      requestId: req.requestId || null,
      method: req.method,
      path: (req.originalUrl || req.url || '').split('?')[0],
    };
    sheets.runWithReadContext(() => {
      const ranges = rangesFor(req.method, req.originalUrl || req.url || '');
      if (ranges.length && typeof sheets.declareRequestRanges === 'function') {
        sheets.declareRequestRanges(ranges);
      }
      next();
    }, identity);
  };
}

module.exports = {
  createSessionReadBatchMiddleware,
  rangesFor,
  DECLARATIONS,
};
