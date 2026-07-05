/*
 * Atlas Flight Recorder — client capture (docs/FLIGHT_RECORDER_SPEC.md, PR-FR3).
 *
 * Captures the USER-VISIBLE events the server can't see — user actions, composer input,
 * screen/card/coach renders, and session-state changes — buffers them, and flushes a
 * BATCH to POST /api/flight/ingest so a developer can replay a real session.
 *
 * SELF-CONTAINED BY DESIGN: it attaches its OWN listeners (clicks, submits, the existing
 * `atlas:*` CustomEvents, visibility) and reads the DOM directly, so it needs NO change to
 * the restricted public/app.js or the preview→approve→write trust loop.
 *
 * HARD CONTRACT (mirrors the server lanes):
 *   * Fully INERT unless the server flag is on: on load it asks GET /api/flight/recent
 *     whether ATLAS_FLIGHT_RECORDER is enabled; if not (or no API key, or the check fails)
 *     it attaches nothing, buffers nothing, sends nothing. Byte-identical app when off.
 *   * TOTAL: every capture path is wrapped and can never throw into app code.
 *   * Best-effort: a failed flush is swallowed; it never blocks the UI or surfaces an error.
 *   * Batches flush at 25 events, every 10s, and immediately on error / bug_marker / pagehide.
 *   * Owner/debug telemetry — never a workout write; the server owns all Sheets access.
 */
(function (root) {
  'use strict';

  // ---- tunables (exported for tests) ----
  var FLUSH_AT = 25;              // flush when the buffer reaches this many events
  var FLUSH_INTERVAL_MS = 10000;  // …or every 10 seconds
  var RING_MAX = 100;             // capped in-memory transcript
  var INPUT_MAX = 2000;           // per-field text cap (client-side; server re-caps)

  var API_KEY_STORAGE = 'atlas_api_key';
  var DEVICE_ID_STORAGE = 'atlas_flight_device';

  // Secret-shaped VALUE scrubbing — defense in depth; the server re-redacts every event.
  var SECRET_VALUE_PATTERNS = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g,
    /\bAIza[A-Za-z0-9_-]{8,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi
  ];

  function redactString(value) {
    if (value == null) return '';
    var out = String(value);
    for (var i = 0; i < SECRET_VALUE_PATTERNS.length; i++) {
      out = out.replace(SECRET_VALUE_PATTERNS[i], '[REDACTED]');
    }
    return out;
  }

  function truncate(value, max) {
    var cap = max || INPUT_MAX;
    var s = value == null ? '' : String(value);
    return s.length > cap ? s.slice(0, cap) + '...[truncated]' : s;
  }

  function safeText(value, max) {
    return truncate(redactString(value), max);
  }

  // The 10 event types → the ones a client can produce (screen_rendered is emitted on
  // load; api_* are the server's job).
  var ATLAS_EVENT_MAP = {
    'atlas:preview-ready': 'card_rendered',
    'atlas:chat-message': 'coach_message_rendered',
    'atlas:substitute-suggested': 'coach_message_rendered',
    'atlas:glance-ready': 'screen_rendered',
    'atlas:placeholder-owned': 'screen_rendered',
    'atlas:set-logged': 'session_state_changed',
    'atlas:plan-mutated': 'session_state_changed',
    'atlas:plan-edit-applied': 'session_state_changed',
    'atlas:plan-edit-proposed': 'session_state_changed',
    'atlas:session-reset': 'session_state_changed',
    'atlas:identity-corrected': 'session_state_changed'
  };

  // Build one event from a type + fields + per-session context. Pure (caller supplies
  // ctx.now for determinism in tests). Mirrors the columns buildFlightRow expects.
  function buildClientEvent(type, fields, ctx) {
    var f = fields || {};
    var c = ctx || {};
    var when = c.now || new Date();
    return {
      captured_at: when.toISOString(),
      flight_session_id: c.flightSessionId || '',
      seq: typeof c.seq === 'number' ? c.seq : '',
      app_version: c.appVersion || '',
      device_id: c.deviceId || '',
      route: f.route || '',
      event_type: type,
      user_input: f.user_input != null ? safeText(f.user_input) : '',
      user_action: f.user_action != null ? safeText(f.user_action, 200) : '',
      ui_snapshot: f.ui_snapshot != null ? f.ui_snapshot : undefined,
      session_state: f.session_state != null ? f.session_state : undefined,
      error: f.error != null ? safeText(f.error) : '',
      latency_ms: typeof f.latency_ms === 'number' ? f.latency_ms : ''
    };
  }

  // Flush trigger: buffer full, or an event that should not wait (error / bug_marker).
  function shouldFlush(bufferLength, eventType) {
    return bufferLength >= FLUSH_AT || eventType === 'error' || eventType === 'bug_marker';
  }

  // ------------------------------------------------------------------ browser runtime
  function initBrowser() {
    var hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';
    if (!hasDom) return;

    var apiKey = '';
    try { apiKey = window.localStorage.getItem(API_KEY_STORAGE) || ''; } catch (e) { apiKey = ''; }
    if (!apiKey) return; // no key → cannot auth the enabled-check or the flush; stay inert

    var state = {
      active: false,
      apiKey: apiKey,
      flightSessionId: mintSessionId(),
      deviceId: readDeviceId(),
      appVersion: readAppVersion(),
      seq: 0,
      ring: [],
      buffer: [],
      timer: null
    };

    // Ask the server whether the flag is on; only then wire anything up.
    fetchJson('GET', '/api/flight/recent', null, apiKey)
      .then(function (json) {
        var enabled = json && json.data && json.data.enabled === true;
        if (enabled) activate(state);
      })
      .catch(function () { /* inert on any failure */ });
  }

  function activate(state) {
    if (state.active) return;
    state.active = true;

    // user_action — capture-phase click on interactive elements.
    document.addEventListener('click', function (e) {
      try {
        var t = e.target && e.target.closest && e.target.closest('button, .tab, [role="button"], a, [data-tab]');
        if (!t) return;
        var label = (t.id || t.getAttribute('aria-label') || (t.textContent || '')).trim().slice(0, 80);
        record(state, 'user_action', { user_action: label, route: currentRoute(), ui_snapshot: snapshotUiState() });
      } catch (e2) { /* TOTAL */ }
    }, true);

    // user_input — composer submit.
    document.addEventListener('submit', function (e) {
      try {
        var form = e.target;
        if (!form || form.id !== 'logger-form') return;
        var box = document.getElementById('workout-text');
        var text = box && box.value ? box.value : '';
        record(state, 'user_input', { user_input: text, route: currentRoute(), ui_snapshot: snapshotUiState() });
      } catch (e2) { /* TOTAL */ }
    }, true);

    // The existing atlas:* CustomEvents → the matching Flight Recorder event types.
    Object.keys(ATLAS_EVENT_MAP).forEach(function (name) {
      window.addEventListener(name, function () {
        try {
          record(state, ATLAS_EVENT_MAP[name], { route: currentRoute(), ui_snapshot: snapshotUiState(), session_state: snapshotSessionState() });
        } catch (e2) { /* TOTAL */ }
      });
    });

    // Flush the tail on the way out (fetch keepalive works during unload and, unlike
    // sendBeacon, still carries the auth header).
    var flushOut = function () { try { flush(state, true); } catch (e2) {} };
    window.addEventListener('pagehide', flushOut);
    window.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushOut();
    });

    // Periodic flush.
    try { state.timer = window.setInterval(function () { flush(state, false); }, FLUSH_INTERVAL_MS); } catch (e2) {}

    // First frame.
    record(state, 'screen_rendered', { route: currentRoute(), ui_snapshot: snapshotUiState(), session_state: snapshotSessionState() });
  }

  function record(state, type, fields) {
    try {
      state.seq += 1;
      var event = buildClientEvent(type, fields, {
        flightSessionId: state.flightSessionId,
        deviceId: state.deviceId,
        appVersion: state.appVersion,
        seq: state.seq
      });
      state.ring.unshift(event);
      if (state.ring.length > RING_MAX) state.ring.length = RING_MAX;
      state.buffer.push(event);
      if (shouldFlush(state.buffer.length, type)) flush(state, false);
    } catch (e) { /* TOTAL */ }
  }

  function flush(state, unloading) {
    try {
      if (!state.buffer.length) return;
      var events = state.buffer.splice(0, state.buffer.length);
      var body = {
        flight_session_id: state.flightSessionId,
        device_id: state.deviceId,
        app_version: state.appVersion,
        events: events
      };
      fetchJson('POST', '/api/flight/ingest', body, state.apiKey, unloading === true)
        .catch(function () { /* best-effort: a dropped flush is fine */ });
    } catch (e) { /* TOTAL */ }
  }

  // ---- DOM/context helpers (all best-effort) ----
  function fetchJson(method, path, body, apiKey, keepalive) {
    var opts = { method: method, headers: { 'x-atlas-api-key': apiKey } };
    if (body != null) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (keepalive) opts.keepalive = true;
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return null; });
    });
  }

  function mintSessionId() {
    var rand = Math.random().toString(36).slice(2, 10);
    var stamp;
    try { stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); } catch (e) { stamp = 'x'; }
    return 'FR-' + stamp + '-' + rand;
  }

  function readDeviceId() {
    try {
      var id = window.localStorage.getItem(DEVICE_ID_STORAGE);
      if (!id) {
        id = 'dev-' + Math.random().toString(36).slice(2, 12);
        window.localStorage.setItem(DEVICE_ID_STORAGE, id);
      }
      return id;
    } catch (e) { return ''; }
  }

  function readAppVersion() {
    try {
      var el = document.getElementById('shell-version') || document.querySelector('[data-shell-version]');
      if (el) return (el.getAttribute('data-shell-version') || el.textContent || '').trim();
    } catch (e) {}
    return '';
  }

  function currentRoute() {
    try {
      var active = document.querySelector('.tab-content:not([hidden]), [data-tab].active, main [aria-current="page"]');
      if (active && active.id) return active.id;
      if (window.location && window.location.hash) return window.location.hash.replace(/^#/, '');
    } catch (e) {}
    return 'app';
  }

  function prop(id, name) {
    try { var n = document.getElementById(id); return n ? !!n[name] : null; } catch (e) { return null; }
  }

  function snapshotUiState() {
    try {
      var modal = document.querySelector('.modal:not([hidden]), [role="dialog"]:not([hidden])');
      var toast = document.querySelector('.toast:not([hidden]), .banner:not([hidden]), [role="status"]:not([hidden])');
      var coach = document.querySelector('.coach-guide-box, #coach-opening, .coach-message');
      return {
        composer_disabled: prop('workout-text', 'disabled'),
        preview_btn_disabled: prop('preview-btn', 'disabled'),
        approve_btn_disabled: prop('approve-btn', 'disabled'),
        preview_panel_hidden: prop('preview-panel', 'hidden'),
        modal: modal ? (modal.id || modal.className || 'modal') : null,
        toast: toast ? truncate((toast.textContent || '').trim(), 200) : null,
        coach_message: coach ? truncate((coach.textContent || '').trim(), 400) : null
      };
    } catch (e) { return {}; }
  }

  function snapshotSessionState() {
    // The client cannot see the server's authoritative plan object; capture the visible
    // session pin/next-up chrome instead (server has the rest via the API-flow lane).
    try {
      var pin = document.querySelector('#session-pin, .session-pin, #session-resume-notice');
      return { pin: pin ? truncate((pin.textContent || '').trim(), 200) : null };
    } catch (e) { return {}; }
  }

  // ---- exports / auto-init ----
  var exported = {
    FLUSH_AT: FLUSH_AT,
    FLUSH_INTERVAL_MS: FLUSH_INTERVAL_MS,
    RING_MAX: RING_MAX,
    ATLAS_EVENT_MAP: ATLAS_EVENT_MAP,
    redactString: redactString,
    truncate: truncate,
    buildClientEvent: buildClientEvent,
    shouldFlush: shouldFlush
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.atlasFlightRecorder = exported;
    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initBrowser);
      } else {
        initBrowser();
      }
    }
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
