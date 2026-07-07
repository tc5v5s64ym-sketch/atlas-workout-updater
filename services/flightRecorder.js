'use strict';

// Atlas Flight Recorder — the real-world observation lane (docs/FLIGHT_RECORDER_SPEC.md).
// An optional, feature-flagged, append-only session transcript that records the
// USER-VISIBLE app experience and decision trail during real sessions, so a developer
// can REPLAY what happened instead of debugging by screenshots and pasted JSON. It
// answers: "what did the user do, what did Atlas think, what did Atlas decide, and what
// exactly did Atlas show?".
//
// This is PR-FR1: the PURE core only — the flag check, the event taxonomy, the capped
// in-memory ring, secret redaction, and the deterministic row builder. It is UNWIRED:
// nothing here appends to Sheets, opens a route, or touches any runtime path yet. The
// batched ingest route (POST /api/flight/ingest), the read route, and the frontend
// capture come in PR-FR2/FR3.
//
// HARD CONTRACT (matches the shadow lanes in services/brainShadow.js / intentShadow.js):
//   * Every public function is wrapped so it can NEVER throw at a call site.
//   * ATLAS_FLIGHT_RECORDER unset (default) → inert. isFlightRecorderEnabled() is false;
//     callers no-op. Legacy app behavior is byte-identical.
//   * These are owner/debug TELEMETRY rows, NOT logged sets: no write_id, no trust loop,
//     and (once wired) they touch ONLY the optional Flight_Recorder tab — never
//     Log_Cleaned / Effort / Modality_Log or any trust-contract tab.
//   * Payloads are REDACTED (secrets stripped) and TRUNCATED before they become a row.
//
// The ring is in-memory ON PURPOSE (Atlas has no database; Sheets is the permanent record
// for TRAINING data, and flight telemetry is not training data — it resets on
// deploy/restart, the right lifetime for a debug transcript). The Flight_Recorder tab is
// the durable, aggregatable copy for offline replay.

const { redactBugPayload } = require('./bugReport');
// eslint-disable-next-line no-unused-vars -- imported for schema reference; header validation wired in Phase 0 PR-05
const { flightRecorderColumns } = require('../config/columns');

// Optional diagnostics tab (declared in config/sheetContract.js). NOT a trust-contract
// tab and NOT training data — an owner/debug replay surface, append-only. Column order is
// the single source of truth in config/columns.js (flightRecorderColumns); buildRow maps
// to it position-by-position and a test pins length parity.
const FLIGHT_RECORDER_TAB = 'Flight_Recorder';

// The event taxonomy (docs/FLIGHT_RECORDER_SPEC.md §2). Stored verbatim in the
// `event_type` column. Unknown strings are NOT dropped (never lose signal) — isKnownEventType
// only reports whether an event matches the taxonomy, for callers/tests that care.
const EVENT_TYPES = Object.freeze([
  'screen_rendered',
  'user_input',
  'user_action',
  'api_request',
  'api_response',
  'coach_message_rendered',
  'card_rendered',
  'session_state_changed',
  'error',
  'bug_marker'
]);
const _EVENT_TYPE_SET = new Set(EVENT_TYPES);

const RING_MAX = 100;          // capped in-memory transcript for the read endpoint
const MAX_CELL_CHARS = 20000;  // per-cell cap — well under the ~50k Sheets per-cell limit
const MAX_TEXT_CHARS = 2000;   // scalar text fields (user_input, summaries, error, …)

let _ring = [];                // newest first
let _append = null;            // injectable Sheets appendRows; lazy-required otherwise

// Server-side per-flight-session monotonic seq for api_response events. The client owns
// its own seq for the events IT emits; server events (which the client can't number) get an
// independent per-session counter here so they stay orderable within a session. Capped +
// in-memory (diagnostics reset on restart, the right lifetime).
const _seqBySession = new Map(); // flight_session_id -> last seq
const SEQ_SESSIONS_MAX = 500;
function _nextSeq(flightSessionId) {
  if (!flightSessionId) return '';
  const n = (_seqBySession.get(flightSessionId) || 0) + 1;
  _seqBySession.set(flightSessionId, n);
  if (_seqBySession.size > SEQ_SESSIONS_MAX) {
    const oldest = _seqBySession.keys().next().value;
    _seqBySession.delete(oldest);
  }
  return n;
}

function isFlightRecorderEnabled() {
  const v = process.env.ATLAS_FLIGHT_RECORDER;
  return v === '1' || v === 'true' || v === 'on';
}

function isKnownEventType(type) {
  return _EVENT_TYPE_SET.has(type);
}

function _isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

// A short, safe scalar string: coerce, then cap. null/undefined → ''.
function _text(value, max = MAX_TEXT_CHARS) {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s.length > max ? `${s.slice(0, max)}...[truncated]` : s;
}

// A finite number, else '' (blank cell) — never NaN/Infinity into a sheet.
function _num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : '';
}

// A JSON cell built from an object: '' for empty/absent, else stringify + cap. The value
// is already redacted upstream (redactFlightEvent), so this only shapes and truncates.
function _jsonCell(value) {
  if (value == null) return '';
  if (_isObj(value) && Object.keys(value).length === 0) return '';
  if (Array.isArray(value) && value.length === 0) return '';
  let s;
  try { s = JSON.stringify(value); } catch { return '[unserializable]'; }
  if (s == null) return '';
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}...[truncated]` : s;
}

// Redact one raw event (defense in depth — the client redacts too, but the server must
// never trust that). Reuses the proven Bug_Reports redactor: strips secret-shaped KEYS,
// scrubs secret-shaped VALUES (sk-…, AIza…, Bearer …, PRIVATE KEY blocks), drops circular
// refs, and truncates. TOTAL: any failure yields a safe empty object, never a throw.
function redactFlightEvent(event) {
  try {
    return redactBugPayload(_isObj(event) ? event : {});
  } catch (_) {
    return {};
  }
}

// Build the append-only Flight_Recorder row from ONE event. Deterministic and pure
// (no clock, no I/O) — the caller supplies captured_at. Redacts first, then maps to the
// column contract position-by-position. Missing fields become blank cells, never a crash.
function buildFlightRow(event) {
  const e = redactFlightEvent(event);
  return [
    _text(e.captured_at, 40),         // captured_at
    _text(e.flight_session_id, 120),  // flight_session_id
    _num(e.seq),                      // seq
    _text(e.app_version, 120),        // app_version
    _text(e.device_id, 120),          // device_id
    _text(e.route, 200),              // route
    _text(e.event_type, 60),          // event_type
    _text(e.user_input),              // user_input
    _text(e.user_action, 200),        // user_action
    _jsonCell(e.ui_snapshot),         // ui_snapshot_json
    _jsonCell(e.session_state),       // session_state_json
    _text(e.api_endpoint, 200),       // api_endpoint
    _text(e.request_summary),         // request_summary
    _text(e.response_summary),        // response_summary
    _jsonCell(e.decision_summary),    // decision_summary_json
    _jsonCell(e.shadow_refs),         // shadow_refs_json
    _text(e.error),                   // error
    _num(e.latency_ms)                // latency_ms
  ];
}

// Build rows for a batch of events, preserving order. Non-object entries are skipped
// (never a throw). Used by the future ingest route; pure and network-free here.
function buildFlightRows(events) {
  const list = Array.isArray(events) ? events : [];
  const rows = [];
  for (const ev of list) {
    if (!_isObj(ev)) continue;
    rows.push(buildFlightRow(ev));
  }
  return rows;
}

// Record ONE event into the capped in-memory ring (newest first) for the read endpoint.
// TOTAL: swallows every error so telemetry can never surface to, or fail, a caller.
// Returns the stored (redacted) event, or undefined on a no-op/failure. Does NOT touch
// Sheets — durable persistence is the ingest route's job (PR-FR2).
function recordEvent(event) {
  try {
    if (!_isObj(event)) return undefined;
    const stored = redactFlightEvent(event);
    _ring.unshift(stored);
    if (_ring.length > RING_MAX) _ring.length = RING_MAX;
    return stored;
  } catch (_) {
    return undefined;
  }
}

// ── FR2: server-side API-flow recording ──────────────────────────────────────────
//
// The simulation harness (scripts/sim/harness.js) is an HTTP CLIENT that drives a
// running Atlas server; it has no separate append path. So recording API flows
// SERVER-SIDE captures BOTH real app traffic and simulation traffic in one place, and
// — because it appends via the standard sheets.appendRows, which targets the server's
// own GOOGLE_SHEETS_ID — it AUTOMATICALLY writes to the sandbox Flight_Recorder when the
// server is the sandbox sheet and the production Flight_Recorder when it is production.
// (Sim WRITE mode already hard-refuses any server not confirmed as the sandbox sheet;
// see verifyServerSheet.)
//
// Isolation guard (belt-and-suspenders): a request the harness marks as simulation
// (x-atlas-simulation header) is NEVER persisted to a non-sandbox sheet — so even a
// read-only sim pointed at a production server can never write sim noise into the
// production Flight_Recorder tab. It is still kept in the in-memory ring (no sheet write).

// Batched, best-effort persistence of Flight Recorder rows.
//
// LIVE INCIDENT 2026-07-07: appending ONE row per event exhausted Google Sheets'
// "Write requests per minute per user" quota (60/min) during an active session — a
// gym session fires dozens of API calls a minute, and each Flight_Recorder append is
// a separate write request. That starved the real Log_Cleaned append and a workout
// Save 500'd (`Quota exceeded ... sheets.googleapis.com`). Telemetry must NEVER be
// able to knock out the trust path. So events are now BUFFERED and flushed in ONE
// appendRows call per window (a burst of N events → 1 write request, not N), keeping
// the flight recorder's quota footprint tiny and leaving headroom for real writes.
//
// Still TOTAL and self-swallowing: a missing tab, absent creds, or a transient error
// is silently ignored so no caller can be blocked or failed by telemetry persistence.
// Touches only Flight_Recorder — never a workout/trust tab or the write path.
const FLIGHT_FLUSH_INTERVAL_MS = 2000;   // coalesce bursts; ≤~30 flushes/min worst case
const FLIGHT_MAX_PENDING_ROWS = 100;     // hard-flush cap (bounds memory + write latency)
let _pendingRows = [];
let _pendingAppend = null;
let _flushTimer = null;

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => { _flushTimer = null; flushFlightRecorder(); }, FLIGHT_FLUSH_INTERVAL_MS);
  // Never keep the process alive just to flush best-effort telemetry.
  if (_flushTimer && typeof _flushTimer.unref === 'function') _flushTimer.unref();
}

function _persistRows(rows, appendImpl) {
  if (!Array.isArray(rows) || !rows.length) return;
  // Remember an injected append (tests / DI); the default resolves at flush time.
  if (appendImpl) _pendingAppend = appendImpl;
  for (const row of rows) _pendingRows.push(row);
  if (_pendingRows.length >= FLIGHT_MAX_PENDING_ROWS) { flushFlightRecorder(); return; }
  _scheduleFlush();
}

// Flush all buffered Flight Recorder rows in ONE best-effort appendRows call. Exposed
// for graceful shutdown and tests. TOTAL / self-swallowing — a failure never surfaces.
function flushFlightRecorder(appendImpl) {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (!_pendingRows.length) return;
  const rows = _pendingRows;
  _pendingRows = [];
  const append = appendImpl || _pendingAppend || _append || require('../sheets').appendRows;
  _pendingAppend = null;
  Promise.resolve()
    .then(() => append(FLIGHT_RECORDER_TAB, rows))
    .catch(() => { /* best-effort: persistence failure must never surface */ });
}

// SHAPE summary of a request body — top-level keys + size only, NEVER raw field VALUES.
// This honors the owner's data-volume guardrail ("prefer summaries for large JSON") and
// deliberately keeps workout CONTENT (notes, weights, free text in /api/log-workout et al.)
// out of the debug tab: redactBugPayload scrubs secret-shaped values but not workout data,
// so the safe design is to never emit values here at all. Records enough to replay the
// request SHAPE (which endpoint, which fields, how big) without its contents. Secret-shaped
// value patterns in a key name are still scrubbed downstream by redactFlightEvent.
function _shapeSummary(body) {
  if (body == null) return '';
  try {
    if (Array.isArray(body)) return `[array length ${body.length}]`;
    if (typeof body !== 'object') return `[${typeof body}]`;
    const keys = Object.keys(body);
    let size = 0;
    try { size = JSON.stringify(body).length; } catch { size = 0; }
    const shown = keys.slice(0, 40).join(', ');
    return _text(`{${shown}${keys.length > 40 ? ', …' : ''}} (${size} chars)`);
  } catch {
    return '[unsummarizable]';
  }
}

// Record ONE served API request/response as an `api_response` Flight Recorder event.
// TOTAL and flag-gated: a no-op (returns undefined) unless ATLAS_FLIGHT_RECORDER is on, so
// legacy traffic is byte-identical. Pushes to the in-memory ring and BEST-EFFORT appends
// one row — EXCEPT simulation traffic against a non-sandbox sheet, which is ring-only (the
// isolation guard). Returns the stored (redacted) event, or undefined on no-op/failure.
//
// info: { method, path, route, status/response_summary, latency_ms, request_body,
//         flight_session_id, device_id, app_version, seq, error, is_simulation }
// opts: { sheetIsSandbox, append }  — sheetIsSandbox from getSafeSpreadsheetConfig().
function recordApiFlow(info, opts) {
  try {
    if (!isFlightRecorderEnabled()) return undefined;
    const i = _isObj(info) ? info : {};
    const o = _isObj(opts) ? opts : {};
    const isSim = i.is_simulation === true;
    const method = i.method ? String(i.method).toUpperCase() : '';
    const path = i.path || i.route || '';
    const event = {
      captured_at: new Date().toISOString(),
      flight_session_id: i.flight_session_id || '',
      // Link to the client session: an explicit seq wins; otherwise derive a server-side
      // per-session seq from the client's flight_session_id (blank when unlinked).
      seq: typeof i.seq === 'number' ? i.seq : _nextSeq(i.flight_session_id || ''),
      app_version: i.app_version || '',
      device_id: i.device_id || '',
      route: i.route || path || '',
      event_type: 'api_response',
      user_input: '',
      user_action: '',
      api_endpoint: method && path ? `${method} ${path}` : (path || ''),
      request_summary: i.request_summary != null ? _text(i.request_summary) : _shapeSummary(i.request_body),
      response_summary: i.response_summary != null ? String(i.response_summary) : '',
      decision_summary: i.decision_summary,
      shadow_refs: i.shadow_refs,
      error: i.error || '',
      latency_ms: typeof i.latency_ms === 'number' ? i.latency_ms : '',
      is_simulation: isSim
    };
    const stored = recordEvent(event);
    // Isolation: simulation traffic is never persisted to a non-sandbox sheet.
    if (isSim && o.sheetIsSandbox !== true) return stored;
    _persistRows([buildFlightRow(event)], o.append);
    return stored;
  } catch (_) {
    return undefined;
  }
}

// ── FR3: client batch ingest ─────────────────────────────────────────────────────
//
// The frontend (public/flightRecorder.js) captures the UI-only events the server can't
// see — screen_rendered / user_action / user_input / ui_snapshot / coach_message_rendered
// / card_rendered / session_state_changed / bug_marker — buffers them, and flushes a BATCH
// to POST /api/flight/ingest. This handler redacts + builds all rows and appends them in ONE
// best-effort call. Same guarantees as the server-side lane: flag-gated, TOTAL, writes only
// Flight_Recorder on the server's own sheet, and never persists sim-marked traffic to a
// non-sandbox sheet.

const MAX_INGEST_EVENTS = 200; // per-batch cap (defense; the client batches ~25)

// Ingest one client batch: { flight_session_id, device_id, app_version, events:[...] }.
// TOTAL and flag-gated. Returns { enabled, written } (never throws). Best-effort append of
// the whole batch in a single appendRows call.
// opts: { sheetIsSandbox, isSimulation, append }
function recordClientBatch(payload, opts) {
  try {
    if (!isFlightRecorderEnabled()) return { enabled: false, written: 0 };
    const o = _isObj(opts) ? opts : {};
    const p = _isObj(payload) ? payload : {};
    const events = Array.isArray(p.events) ? p.events.slice(0, MAX_INGEST_EVENTS) : [];
    if (!events.length) return { enabled: true, written: 0 };

    // Batch-level session fields are authoritative for every row.
    const session = {
      flight_session_id: p.flight_session_id || '',
      device_id: p.device_id || '',
      app_version: p.app_version || ''
    };

    const rows = [];
    for (const ev of events) {
      if (!_isObj(ev)) continue;
      const event = { ...ev, ...session };
      recordEvent(event);              // in-memory ring (redacted)
      rows.push(buildFlightRow(event));
    }
    if (!rows.length) return { enabled: true, written: 0 };

    // Isolation: a sim-marked client batch never persists to a non-sandbox sheet.
    if (o.isSimulation === true && o.sheetIsSandbox !== true) {
      return { enabled: true, written: 0, isolated: true };
    }
    _persistRows(rows, o.append);      // ONE append for the whole batch
    return { enabled: true, written: rows.length };
  } catch (_) {
    return { enabled: isFlightRecorderEnabled(), written: 0 };
  }
}

// Read-only snapshot for the future GET /api/flight/recent (and the Settings → Debug
// surface): the ring newest-first plus basic aggregate counts.
function getFlightRecorderLog() {
  const entries = _ring.slice();
  const byType = {};
  let errors = 0;
  for (const e of entries) {
    if (e && e.event_type) byType[e.event_type] = (byType[e.event_type] || 0) + 1;
    if (e && (e.event_type === 'error' || (e.error && String(e.error).length))) errors += 1;
  }
  return {
    enabled: isFlightRecorderEnabled(),
    ring_max: RING_MAX,
    count: entries.length,
    aggregates: { total: entries.length, errors, by_type: byType },
    entries
  };
}

// Clear the ring (ops/tests).
function clearFlightRecorderLog() { _ring = []; }

function _resetForTesting({ append } = {}) {
  _ring = [];
  _append = typeof append === 'function' ? append : null;
  _seqBySession.clear();
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _pendingRows = [];
  _pendingAppend = null;
}

module.exports = {
  FLIGHT_RECORDER_TAB,
  EVENT_TYPES,
  RING_MAX,
  MAX_CELL_CHARS,
  isFlightRecorderEnabled,
  isKnownEventType,
  redactFlightEvent,
  buildFlightRow,
  buildFlightRows,
  recordEvent,
  recordApiFlow,
  recordClientBatch,
  flushFlightRecorder,
  MAX_INGEST_EVENTS,
  getFlightRecorderLog,
  clearFlightRecorderLog,
  _resetForTesting
};
