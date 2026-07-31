'use strict';

// Browser write blockade for the live-retest harness.
//
// WHY THIS EXISTS. "The harness never clicks Save" is not sufficient. The APP initiates
// writes on its own: once a plan is displayed or engaged, clicking PREVIEW trips
// `unacceptedPlanGateRec` (`src/app/app.js`), which silently calls `acceptDisplayedPlan`
// → `POST /api/session-plans/accept` + `POST /api/session-plan-sets/accept`. This is not
// theoretical — on 2026-07-31 an authenticated production run (Actions run 30596164330)
// hit exactly that path, and the blockade below aborted it live, along with three
// `/api/flight/ingest` posts.
//
// THE RULE is the invariant Atlas already states — `test_mode` absent means LIVE WRITE —
// applied per ROUTE rather than per payload:
//
//   • a route that is not write-capable                     → allowed
//   • a write-capable route that HONORS test_mode, carrying
//     an explicit test_mode dry-run                         → allowed (the preview flow)
//   • a write-capable route that IGNORES test_mode          → ABORTED unconditionally
//   • a write-capable route with no test_mode               → ABORTED, and recorded
//   • anything undeterminable                               → ABORTED (fails closed)
//
// SCOPE OF THE CLAIM. This blocks WORKOUT AND STATE MUTATION — the plan ledger, the
// workout log, closeout, revision, seal, and the flight recorder. It is NOT a claim of
// zero Sheet writes: with `ATLAS_INTERACTION_TRACE=shadow` enabled, read-only coach
// routes still append synthetic telemetry to Intent_Shadow and Brain_Shadow, correctly
// tagged `evidence_class=synthetic, evidence_eligible=false, request_origin=playwright`.
// Coach_Shadow and Coach_Response are separately contained server-side (they carry no
// provenance columns) — see services/coachShadowSheet.js.
//
// PURITY. No fs, no network, no browser. The runner owns the browser and calls in.

const { routeDefinitions } = require('../config/routes');

// --- The write blockade (Codex #1207 P1) --------------------------------------
// A beat having no executor is NOT sufficient. The app itself can reach a
// write-capable endpoint on its own: once a plan is displayed or engaged (the
// fixture's first beat asks for exactly that), logging a set through the PREVIEW
// button trips `unacceptedPlanGateRec` in `src/app/app.js`, which silently calls
// `acceptDisplayedPlan` → `POST /api/session-plans/accept` +
// `POST /api/session-plan-sets/accept`. Both are `writeCapable: true` in
// `config/routes.js`. So a "read-only" walk could have created ledger rows through
// a path no beat asked for.
//
// The fix is a transport-layer blockade over the whole browser context, enforcing
// the invariant Atlas already states: `test_mode` absent means LIVE WRITE. It is
// derived from `config/routes.js` — the canonical manifest — so it can never drift
// from the real route set, and it is not a hand-kept second list.
//
//   • a route that is not write-capable                    → allowed
//   • a write-capable route that HONORS test_mode, carrying
//     an explicit test_mode dry-run                        → allowed (the preview flow)
//   • a write-capable route that IGNORES test_mode         → ABORTED unconditionally
//   • a write-capable route with no test_mode              → ABORTED, and recorded
//   • anything undeterminable                              → ABORTED (fails closed)
//
// This enforces the harness's standing contract rather than changing it: a request
// it aborts is one that would have violated "never writes".
const WRITE_CAPABLE_ROUTES = Object.freeze(
  routeDefinitions
    .filter(r => r && r.writeCapable === true)
    .map(r => Object.freeze({ path: r.path, methods: Object.freeze([...(r.methods || [])]) }))
);

// Match a concrete request path against a manifest path, honoring `:param`
// segments so the matcher stays correct if the manifest grows one.
function pathMatches(pattern, pathname) {
  const p = String(pattern).split('/').filter(Boolean);
  const a = String(pathname).split('/').filter(Boolean);
  if (p.length !== a.length) return false;
  return p.every((seg, i) => seg.startsWith(':') || seg.toLowerCase() === a[i].toLowerCase());
}

function matchesWriteCapableRoute(method, pathname) {
  const m = String(method || '').toUpperCase();
  return WRITE_CAPABLE_ROUTES.some(r => r.methods.includes(m) && pathMatches(r.path, pathname));
}

// Routes that GENUINELY implement dry-run semantics — verified as the only
// write-capable handlers that call `isTestModeEnabled(...)`:
//   • /api/log-workout        (index.js)
//   • /api/complete-workout   (index.js)
//   • /api/log-modality       (index.js)
//   • /api/bodyweight         (index.js)
//
// This list exists because keying the bypass on the PRESENCE of a `test_mode` field
// was a fail-open (Codex #1207 P1, second pass). `routes/sessionPlans.js` contains no
// `test_mode` reference at all: `POST /api/session-plans/accept` ignores the field and
// calls `captureAccept` regardless, so a payload that merely CARRIES `test_mode: true`
// would have sailed through the blockade and could still have appended rows. A field in
// the request proves nothing; only the handler honoring it does.
//
// So the dry-run bypass is now granted per ROUTE, not per payload. Everything else
// write-capable is aborted unconditionally, `test_mode` present or not.
// `test/live-retest-golden-session.test.js` re-derives this set from `index.js` and
// fails if it ever drifts.
const TEST_MODE_HONORING_ROUTES = Object.freeze([
  '/api/log-workout',
  '/api/complete-workout',
  '/api/log-modality',
  '/api/bodyweight'
]);

function honorsTestMode(pathname) {
  return TEST_MODE_HONORING_ROUTES.some(p => pathMatches(p, pathname));
}

// Is this request body an explicit `test_mode` dry-run? Handles the three shapes the
// app actually sends: JSON boolean `true`, JSON string `'true'`, and a multipart
// form field. Anything it cannot read confidently returns false, so the caller
// blocks — an unreadable body is never assumed safe.
function isTestModeDryRun(body) {
  if (body === undefined || body === null || body === '') return false;
  const raw = String(body);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed.test_mode === true || parsed.test_mode === 'true';
    }
  } catch { /* not JSON — fall through to the form-encoded shapes */ }
  if (/name="test_mode"[\s\S]{0,80}?\btrue\b/i.test(raw)) return true;
  if (/(^|[&?])test_mode=true(&|$)/i.test(raw)) return true;
  return false;
}

// Classify one outbound browser request. Pure — the runner supplies method/url/body.
function classifyOutboundRequest({ method, url, body } = {}) {
  let pathname;
  try {
    pathname = new URL(String(url)).pathname;
  } catch {
    // An unparseable URL cannot be proven read-only. Fail closed.
    return { writeCapable: true, dryRun: false, allowed: false, reason: 'unparseable_url' };
  }
  if (!matchesWriteCapableRoute(method, pathname)) {
    return { writeCapable: false, dryRun: false, allowed: true, reason: 'not_write_capable', pathname };
  }
  // A route that does not implement dry-run semantics is aborted unconditionally —
  // carrying a `test_mode` field cannot make a handler that ignores it safe.
  if (!honorsTestMode(pathname)) {
    return { writeCapable: true, dryRun: false, allowed: false, reason: 'write_capable_route_ignores_test_mode', pathname };
  }
  if (isTestModeDryRun(body)) {
    return { writeCapable: true, dryRun: true, allowed: true, reason: 'test_mode_dry_run', pathname };
  }
  return { writeCapable: true, dryRun: false, allowed: false, reason: 'write_capable_without_test_mode', pathname };
}

module.exports = {
  WRITE_CAPABLE_ROUTES, TEST_MODE_HONORING_ROUTES,
  pathMatches, matchesWriteCapableRoute, honorsTestMode,
  isTestModeDryRun, classifyOutboundRequest
};
