'use strict';

// What is allowed to cross into a Stage-A canary child process — declared ONCE.
//
// The canary builds child environments in two places (the operator command spawns
// Playwright; the spec spawns the gate server) and neither may spread `...process.env`:
// the ambient GOOGLE_SHEETS_ID here resolves to a NON-sandbox workbook, so a spread
// would point a write-enabled browser run at it. Everything crossing the boundary is
// therefore named explicitly.
//
// Two builders naming a list separately is a drift risk — one gets a variable the other
// does not, and the two children stop behaving alike. So the list lives here and both
// consume it.
//
// This list is NETWORK PLUMBING ONLY: proxy routing and CA trust. Some environments
// (including Atlas's remote execution container) route all outbound HTTPS through a
// proxy with its own certificate authority, and without these the sandbox connection
// fails TLS verification before it can reach Google. None of these names carries a
// workbook id, a credential, a feature flag, or a model posture — those are passed
// deliberately and individually by each builder, and are never swept in from here.
const NETWORK_PASSTHROUGH = Object.freeze([
  'HTTPS_PROXY', 'https_proxy',
  'HTTP_PROXY', 'http_proxy',
  'NO_PROXY', 'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'NIX_SSL_CERT_FILE',
]);

// Copy only the names above that are actually set. An unset variable is omitted rather
// than passed as undefined, so the child sees the same absence the parent had.
function pickNetworkPassthrough(source = process.env) {
  const out = {};
  for (const name of NETWORK_PASSTHROUGH) {
    if (source[name] !== undefined && source[name] !== '') out[name] = source[name];
  }
  return out;
}

// Fail-closed assertion both builders run before spawning: whatever else a child env
// carries, it must not carry a workbook id. Assignment of the sandbox id is the gate
// server's job, from config/sandboxSheet.js, so any id here would be a second source.
function assertNoWorkbookId(childEnv) {
  if (Object.prototype.hasOwnProperty.call(childEnv, 'GOOGLE_SHEETS_ID')) {
    throw new Error('Stage-A canary: refusing to spawn — the child environment carries a GOOGLE_SHEETS_ID.');
  }
}

// ── The startup budget, declared ONCE and consumed by both sides ────────────────
//
// The harness retries a Sheets read-quota rejection with backoff; the spec waits for the
// harness to publish a port. Those two numbers must agree, and when they were set
// independently they did not: the backoff reached 120s while the spec gave up at 60s, so
// the last two retries could never complete and the advertised quota recovery was dead
// code in the exact scenario it existed for.
//
// One declared budget removes the possibility of that drift. The harness bounds its total
// backoff to PREFLIGHT_QUOTA_BACKOFF_MS * attempts; the spec waits strictly longer.
const PREFLIGHT_QUOTA_ATTEMPTS = 4;
const PREFLIGHT_QUOTA_BACKOFF_MS = 20000;
// Worst case: three waits between four attempts, plus generous room for the requests
// themselves and for process startup.
const PREFLIGHT_WORST_CASE_MS = PREFLIGHT_QUOTA_BACKOFF_MS * (PREFLIGHT_QUOTA_ATTEMPTS - 1);
const GATE_STARTUP_TIMEOUT_MS = PREFLIGHT_WORST_CASE_MS + 120000;

module.exports = {
  NETWORK_PASSTHROUGH,
  pickNetworkPassthrough,
  assertNoWorkbookId,
  PREFLIGHT_QUOTA_ATTEMPTS,
  PREFLIGHT_QUOTA_BACKOFF_MS,
  GATE_STARTUP_TIMEOUT_MS,
};
