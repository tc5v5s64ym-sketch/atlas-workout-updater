'use strict';
// Atlas frontend — api module (PR-09b mechanical extraction from app.js).
import { setAtlasLastError } from './store.js';
import { BUG_REPORT_RECENT_API_LIMIT, atlasRecentApiRequests, recordAtlasError, snapshotBugBody } from './bugReport.js';

export const API_KEY_STORAGE = 'atlas_api_key';

// Server-authoritative auth state (F04C redesign). The client MUST NOT guess whether
// its HttpOnly `atlas_session` cookie is valid — only the server can. There is NO
// persistent localStorage "connected" flag: a flag is a client-side guess, and a guess
// is exactly what produced split-brain auth (Settings said connected while Coach said
// "set your key"). This single module value is the one truth both Settings and every
// protected read derive from, and it is written EXCLUSIVELY by real server responses:
//   • a protected api() call returns 2xx, or login succeeds        → 'authenticated'
//   • a protected api() call returns 401, logout, or a sessions-enabled
//     /api/session/status reporting authenticated:false            → 'unauthenticated'
//   • /api/session/status reporting authenticated:true             → 'authenticated'
// A transport failure, timeout, or aborted status request NEVER changes it — a cookie
// not sent on one navigation, or a cold-start drop, is not proof of anything. It stays
// at its last server-confirmed value, or 'unknown' before any round-trip.
let serverAuthState = 'unknown'; // 'unknown' | 'authenticated' | 'unauthenticated'
let sessionsEnabled = false;

function setAuthenticated() { serverAuthState = 'authenticated'; }
function setUnauthenticated() { serverAuthState = 'unauthenticated'; }

export function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

// The raw server-confirmed verdict, for surfaces (Settings) that must reflect the
// three states distinctly rather than collapse to a boolean.
export function authState() { return serverAuthState; }

// OPTIMISTIC connection gate. Returns false ONLY when the server has actually told us
// this browser is unauthenticated (a real 401, or a sessions-enabled status reporting
// authenticated:false). 'unknown' (startup, before any round-trip) and 'authenticated'
// both return true, so a cookie-only owner is NEVER pre-blocked on a synchronous guess:
// the protected request carries the cookie and the SERVER decides. Surfaces that render
// a "Connect Atlas" prompt do so from an actual 401 on the attempt (or this gate once
// the server has already confirmed the negative), never from a client flag.
export function isConnected() {
  return serverAuthState !== 'unauthenticated';
}

export function sessionsFeatureEnabled() {
  return sessionsEnabled;
}

// Ask the server whether durable sessions are enabled and whether this browser is
// currently authenticated by its cookie. Best-effort; never throws.
export async function refreshSessionStatus() {
  // Bounded so a slow/cold server can never block app startup — on timeout the caller
  // proceeds and isConnected() stays optimistic ('unknown'), so the first protected
  // response settles the truth rather than a client guess.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 4000) : null;
  try {
    const res = await fetch('/api/session/status', {
      credentials: 'same-origin',
      signal: controller ? controller.signal : undefined
    });
    const json = await res.json().catch(() => null);
    const data = (json && json.data) || {};
    sessionsEnabled = Boolean(data.sessions_enabled);
    if (data.authenticated) {
      setAuthenticated();
    } else if (data.sessions_enabled) {
      // Sessions ARE enabled and the server says this browser's cookie is not valid —
      // a real, server-confirmed negative (morally a 401 for the reads).
      setUnauthenticated();
    }
    // else: sessions disabled (no secret provisioned) — auth is via the legacy key
    // header. Leave the state optimistic and let a protected api() call carrying that
    // header confirm it, rather than guessing from a local key string.
    return data;
  } catch (_) {
    // Timeout / abort / transport: leave serverAuthState untouched. A network hiccup on
    // the status probe must never flip the owner to "disconnected".
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Exchange the owner key for a session cookie. Login success is itself a server
// confirmation, so it marks us authenticated; a rejected key (401) marks us
// unauthenticated. Returns { ok, status, json }.
export async function sessionLogin(key) {
  try {
    const res = await fetch('/api/session/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key })
    });
    const json = await res.json().catch(() => null);
    if (res.ok) setAuthenticated();
    else if (res.status === 401) setUnauthenticated();
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: err };
  }
}

// Clear the server session cookie. Best-effort; always resolves.
export async function sessionLogout() {
  try {
    await fetch('/api/session/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) { /* best-effort — the cookie clears on the server response */ }
  setUnauthenticated();
}

// Transport-level fetch failures surface as cryptic browser strings ("Load failed",
// "Failed to fetch", "The network connection was lost"). When one survives the
// retry above, translate it into an honest, actionable line — the usual cause is
// the server cold-starting after idle (diagnosed live 2026-07-02: first request
// ~36s wall-clock while the instance wakes). Returns null for real HTTP errors so
// the server's own message always wins.
export function friendlyTransportMessage(err) {
  if (!err || err.status) return null;
  const m = err.message ? String(err.message) : '';
  if (/load failed|failed to fetch|networkerror|network error|network connection was lost|connection appears to be offline/i.test(m)) {
    return 'the connection dropped — the server was likely waking up. Give it a few seconds and tap Preview again; nothing was saved.';
  }
  return null;
}

// ── Coalesced reads ─────────────────────────────────────────────────────────
//
// The app opens by fanning out across several cards, and more than one card needs the SAME
// read. `loadDashboard` and `loadCoachPlan` both want /api/plan/intent-recommendation;
// `loadDashboard` and `loadWeeklyCoach` both want /api/coaching/insights; after a Save the
// dashboard refresh and the verdict strip both want /api/prs/recent. The 2026-08-05
// qualifying session's request manifest shows each of those pairs issued 0.4–0.9 s apart,
// against a 60-read-per-minute quota.
//
// This coalesces only requests that OVERLAP IN TIME: a second caller joins a request that
// is still in flight. It is not a cache. Nothing is remembered after the response arrives,
// so a later call always goes to the server, and no response is ever served past the
// instant it was fetched.
//
// WHY THAT IS SAFE ACROSS A WRITE. Any non-GET request clears the in-flight map when it
// settles (see below), so a read STARTED after a write completed can never attach to a read
// that started before it — it issues its own request and sees the post-write state. A read
// that was already in flight when the write began could equally have raced it without this,
// so nothing new is suppressed. Legitimate calls after newly written sets keep going to the
// server; only genuinely simultaneous, identical requests share one.
//
// Each caller gets its OWN copy of the body, so one card cannot mutate another's data.
const inflightReads = new Map();

export function coalescedGet(path) {
  const existing = inflightReads.get(path);
  if (existing) return existing.then(body => copyOf(body));
  const request = api(path).finally(() => {
    if (inflightReads.get(path) === request) inflightReads.delete(path);
  });
  inflightReads.set(path, request);
  return request.then(body => copyOf(body));
}

/** Forget every in-flight read. Called whenever a write settles. */
export function dropCoalescedReads() {
  inflightReads.clear();
}

function copyOf(body) {
  try {
    return typeof structuredClone === 'function' ? structuredClone(body) : JSON.parse(JSON.stringify(body));
  } catch (_) {
    return body;   // a body that cannot be copied is still better than no body
  }
}

export async function api(path, options = {}) {
  // Internal, header-only response seam used by the bounded turn-correlation protocol.
  // Strip it before fetch so it can never become a wire option or enter response bodies,
  // request history, bug reports, or traces. The callback receives the native Headers
  // object only; callers extract the two closed correlation header names themselves.
  const { responseHeaders, ...fetchOptions } = options;
  // Flight Recorder session-linkage headers (additive, and {} unless the recorder is
  // active) so server-side api_response telemetry links to this client session. Never
  // affects request/response semantics or the write path.
  const flightHeaders = (typeof window !== 'undefined' && window.atlasFlightRecorder && typeof window.atlasFlightRecorder.requestHeaders === 'function')
    ? window.atlasFlightRecorder.requestHeaders() : {};
  // PR-GATEA1 — first-party UI provenance marker (GATE A evidence eligibility).
  // Under browser automation (Playwright/WebDriver) send a bounded SYNTHETIC marker,
  // never athlete_ui, so an automated run driving the real UI is excluded up front.
  // The marker is only a client claim — the server ALSO verifies same-origin browser
  // fetch metadata (Sec-Fetch-Site + host-matched Origin/Referer) and fails closed on
  // a non-production runtime / test / sim / direct-API request. Telemetry only; never
  // affects request/response semantics or the write path.
  const uiOrigin = (typeof navigator !== 'undefined' && navigator.webdriver === true) ? 'playwright' : 'athlete_ui';
  // Send the legacy key header ONLY when a key is still stored (machine/legacy /
  // pre-migration path). Once migrated to a session cookie, getApiKey() is '' and
  // the same-origin cookie authenticates instead — no empty header is sent.
  const headers = { 'x-atlas-request-origin': uiOrigin, ...flightHeaders, ...(fetchOptions.headers || {}) };
  const key = getApiKey();
  if (key) headers['x-atlas-api-key'] = key;
  const method = fetchOptions.method || 'GET';
  const startedAt = Date.now();
  let res = null;
  let json = null;
  try {
    // same-origin so the HttpOnly session cookie is attached on /api calls.
    res = await fetch(path, { credentials: 'same-origin', ...fetchOptions, headers });
    json = await res.json().catch(() => null);
    if (!res.ok) {
      const message = json?.message || json?.error || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    // A 2xx from a protected endpoint is the server confirming this browser is
    // authenticated (its cookie or legacy key was accepted). This is the authoritative
    // signal that keeps Settings and every read agreeing without a client-side flag.
    if (typeof responseHeaders === 'function') {
      try { responseHeaders(res.headers); } catch (_) { /* metadata must never affect the request */ }
    }
    setAuthenticated();
    return json;
  } catch (err) {
    // A real 401 is the ONLY error that flips us to unauthenticated (→ surfaces show
    // "Connect Atlas in Settings"). A transport failure / abort / any other status must
    // NOT — leaving the last server-confirmed state means a cold-start drop never logs
    // the owner out on a false negative.
    if (err && err.status === 401) setUnauthenticated();
    const lastError = {
      message: err && err.message ? err.message : String(err),
      status: err && err.status,
      endpoint: path,
      at: new Date().toISOString()
    };
    setAtlasLastError(lastError);
    // Keep a HISTORY, not just the latest: a poison cascade (e.g. one bad set 400ing
    // every save attempt) only makes sense when you can see all of them in order.
    recordAtlasError({
      source: 'api',
      endpoint: path,
      method,
      status: lastError.status,
      message: lastError.message,
      response_body: snapshotBugBody(json)
    });
    // Cold-start resilience (composer-first Phase 0b). Diagnosed live 2026-07-02:
    // the first request after idle can take ~36s while the Render instance wakes,
    // and mobile Safari kills the hanging fetch with a TRANSPORT-level failure
    // ("Load failed" — no HTTP status). Retry exactly once, and ONLY when it is
    // safe to repeat the request: a transport failure (never an HTTP error, never
    // a caller abort) on a GET (read-only by the route contract) or a call the
    // caller explicitly marked retryTransport (the test_mode DRY-RUN previews —
    // idempotent, proof-field-guarded, no write). The live write path is NEVER
    // retried here — write_id idempotency notwithstanding, retries of real writes
    // stay a deliberate human action. Both attempts land in the request history.
    const transportFailure = err && !err.status && err.name !== 'AbortError';
    const retryable = transportFailure && !options._retriedTransport &&
      (method === 'GET' || options.retryTransport === true) &&
      !(options.signal && options.signal.aborted);
    if (retryable) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      return api(path, { ...options, _retriedTransport: true });
    }
    throw err;
  } finally {
    // A write may change what any read would answer, so no read started AFTER this write
    // settles may attach to one that started before it. Doing it here — rather than at each
    // write site — means a new write route cannot forget to. See coalescedGet above.
    if (method !== 'GET') dropCoalescedReads();
    atlasRecentApiRequests.push({
      at: new Date().toISOString(),
      method,
      endpoint: path,
      status: res ? res.status : null,
      ok: res ? res.ok : false,
      duration_ms: Date.now() - startedAt,
      failed: res ? !res.ok : true,
      // Bodies (redacted + truncated) so a bad parse/write is diagnosable from the report
      // itself instead of inferred from downstream state — e.g. exactly what
      // /api/parse-workout-text returned for "Push ups 40 40 40".
      request_body: snapshotBugBody(options.body),
      response_body: snapshotBugBody(json)
    });
    while (atlasRecentApiRequests.length > BUG_REPORT_RECENT_API_LIMIT) atlasRecentApiRequests.shift();
  }
}
