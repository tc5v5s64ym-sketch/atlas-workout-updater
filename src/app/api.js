'use strict';
// Atlas frontend — api module (PR-09b mechanical extraction from app.js).
import { setAtlasLastError } from './store.js';
import { BUG_REPORT_RECENT_API_LIMIT, atlasRecentApiRequests, recordAtlasError, snapshotBugBody } from './bugReport.js';

export const API_KEY_STORAGE = 'atlas_api_key';
// Durable, cross-reload marker: once the owner has connected on this device (a
// session cookie was issued), this NON-SECRET flag persists in localStorage. It is
// what makes isConnected() true *synchronously on reopen* — the cookie is HttpOnly
// and the session-status round-trip is async (and can be slow/aborted), so a flag
// that survives the reload is the only thing that keeps a cookie-only owner from
// being falsely told "Set your API key" on the first render after a reopen. The
// cookie still does the real, server-enforced auth on every API call.
export const CONNECTED_FLAG = 'atlas_connected';

// Durable owner session (F04C). When the server has ATLAS_SESSION_SECRET set, the
// browser authenticates via a signed HttpOnly `atlas_session` cookie instead of a
// raw key in localStorage. These module-level flags cache the last known session
// state (refreshed via /api/session/status) within a single page load.
let sessionActive = false;
let sessionsEnabled = false;

function markConnected() {
  sessionActive = true;
  try { localStorage.setItem(CONNECTED_FLAG, '1'); } catch (_) { /* storage disabled */ }
}

function markDisconnected() {
  sessionActive = false;
  try { localStorage.removeItem(CONNECTED_FLAG); } catch (_) { /* storage disabled */ }
}

export function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

// "Connected" = this device has a live session (in-page flag), has connected before
// (persistent flag surviving reopens), OR still holds a legacy key. The persistent
// flag is essential: sessionActive resets to false on every reload and is only
// re-established after an async status check, so without the flag the connection
// gates flash "not connected" on reopen for a cookie-only owner.
export function isConnected() {
  if (sessionActive) return true;
  try { if (localStorage.getItem(CONNECTED_FLAG) === '1') return true; } catch (_) { /* storage disabled */ }
  return Boolean(getApiKey());
}

export function sessionsFeatureEnabled() {
  return sessionsEnabled;
}

// Ask the server whether durable sessions are enabled and whether this browser is
// currently authenticated by its cookie. Best-effort; never throws.
export async function refreshSessionStatus() {
  // Bounded so a slow/cold server can never block app startup — on timeout the
  // caller proceeds and isConnected() falls back to the localStorage key.
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
    // Only a CONFIRMED server verdict moves the persistent flag: authenticated →
    // set; sessions enabled but explicitly not authenticated (real expiry/invalid
    // cookie) → clear. A transient failure/timeout falls to catch and leaves the
    // flag untouched, so a cold-start blip never logs the owner out.
    if (data.authenticated) {
      markConnected();
    } else if (data.sessions_enabled) {
      markDisconnected();
    } else {
      sessionActive = false;
    }
    return data;
  } catch (_) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Exchange the owner key for a session cookie. On success the raw key is NOT
// persisted by the caller. Returns { ok, status, json }.
export async function sessionLogin(key) {
  try {
    const res = await fetch('/api/session/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key })
    });
    const json = await res.json().catch(() => null);
    if (res.ok) markConnected();
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
  markDisconnected();
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

export async function api(path, options = {}) {
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
  const headers = { 'x-atlas-request-origin': uiOrigin, ...flightHeaders, ...(options.headers || {}) };
  const key = getApiKey();
  if (key) headers['x-atlas-api-key'] = key;
  const method = options.method || 'GET';
  const startedAt = Date.now();
  let res = null;
  let json = null;
  try {
    // same-origin so the HttpOnly session cookie is attached on /api calls.
    res = await fetch(path, { credentials: 'same-origin', ...options, headers });
    json = await res.json().catch(() => null);
    if (!res.ok) {
      const message = json?.message || json?.error || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } catch (err) {
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
