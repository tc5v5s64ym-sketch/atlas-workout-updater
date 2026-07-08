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
const _exports = (function (root) {
  'use strict';

  // ---- tunables (exported for tests) ----
  let FLUSH_AT = 25;              // flush when the buffer reaches this many events
  let FLUSH_INTERVAL_MS = 10000;  // …or every 10 seconds
  let RING_MAX = 100;             // capped in-memory transcript
  let INPUT_MAX = 2000;           // per-field text cap (client-side; server re-caps)

  let API_KEY_STORAGE = 'atlas_api_key';
  let DEVICE_ID_STORAGE = 'atlas_flight_device';

  let _active = null; // the live capture session once activated (null = inert/off)

  // Secret-shaped VALUE scrubbing — defense in depth; the server re-redacts every event.
  let SECRET_VALUE_PATTERNS = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g,
    /\bAIza[A-Za-z0-9_-]{8,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi
  ];

  function redactString(value) {
    if (value == null) return '';
    let out = String(value);
    for (let i = 0; i < SECRET_VALUE_PATTERNS.length; i++) {
      out = out.replace(SECRET_VALUE_PATTERNS[i], '[REDACTED]');
    }
    return out;
  }

  function truncate(value, max) {
    let cap = max || INPUT_MAX;
    let s = value == null ? '' : String(value);
    return s.length > cap ? s.slice(0, cap) + '...[truncated]' : s;
  }

  function safeText(value, max) {
    return truncate(redactString(value), max);
  }

  // The 10 event types → the ones a client can produce (screen_rendered is emitted on
  // load; api_* are the server's job).
  let ATLAS_EVENT_MAP = {
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
    let f = fields || {};
    let c = ctx || {};
    let when = c.now || new Date();
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
    let hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';
    if (!hasDom) return;

    let apiKey = '';
    try { apiKey = window.localStorage.getItem(API_KEY_STORAGE) || ''; } catch (e) { apiKey = ''; }
    if (!apiKey) return; // no key → cannot auth the enabled-check or the flush; stay inert

    let state = {
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
        let enabled = json && json.data && json.data.enabled === true;
        if (enabled) activate(state);
      })
      .catch(function () { /* inert on any failure */ });
  }

  function activate(state) {
    if (state.active) return;
    state.active = true;
    _active = state;         // expose the live session to the Debug UX (markIssue / session id)
    updateDebugStatus();

    // user_action — capture-phase click on interactive elements.
    document.addEventListener('click', function (e) {
      try {
        let t = e.target && e.target.closest && e.target.closest('button, .tab, [role="button"], a, [data-tab]');
        if (!t) return;
        let label = (t.id || t.getAttribute('aria-label') || (t.textContent || '')).trim().slice(0, 80);
        record(state, 'user_action', { user_action: label, route: currentRoute(), ui_snapshot: snapshotUiState() });
      } catch (e2) { /* TOTAL */ }
    }, true);

    // user_input — composer submit.
    document.addEventListener('submit', function (e) {
      try {
        let form = e.target;
        if (!form || form.id !== 'logger-form') return;
        let box = document.getElementById('workout-text');
        let text = box && box.value ? box.value : '';
        record(state, 'user_input', { user_input: text, route: currentRoute(), ui_snapshot: snapshotUiState() });
      } catch (e2) { /* TOTAL */ }
    }, true);

    // The existing atlas:* CustomEvents → the matching Flight Recorder event types.
    // They are dispatched on `document` with the default bubbles:false (see the dispatch
    // sites in app.js / coach-conversation.js, and every existing consumer in nav.js /
    // coach-conversation.js), so we MUST subscribe on `document` — a non-bubbling event
    // targeted at document never reaches a window listener.
    Object.keys(ATLAS_EVENT_MAP).forEach(function (name) {
      document.addEventListener(name, function () {
        try {
          record(state, ATLAS_EVENT_MAP[name], { route: currentRoute(), ui_snapshot: snapshotUiState(), session_state: snapshotSessionState() });
        } catch (e2) { /* TOTAL */ }
      });
    });

    // JS errors / unhandled rejections → an `error` event (which flushes promptly). These
    // are exactly the silent-lockup traces the owner currently can't see in a screenshot.
    window.addEventListener('error', function (e) {
      try {
        let msg = (e && e.message) || String(e);
        let where = e ? [e.filename, e.lineno, e.colno].filter(function (v) { return v != null; }).join(':') : '';
        record(state, 'error', { error: where ? (msg + ' @ ' + where) : msg, route: currentRoute() });
      } catch (e2) { /* TOTAL */ }
    });
    window.addEventListener('unhandledrejection', function (e) {
      try {
        let reason = (e && e.reason && (e.reason.message || String(e.reason))) || 'unhandled rejection';
        record(state, 'error', { error: reason, route: currentRoute() });
      } catch (e2) { /* TOTAL */ }
    });

    // Flush the tail on the way out (fetch keepalive works during unload and, unlike
    // sendBeacon, still carries the auth header).
    let flushOut = function () { try { flush(state, true); } catch (e2) {} };
    window.addEventListener('pagehide', flushOut);
    // visibilitychange is a `document` event — subscribe there, not on window.
    document.addEventListener('visibilitychange', function () {
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
      let event = buildClientEvent(type, fields, {
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
      let events = state.buffer.splice(0, state.buffer.length);
      let body = {
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
    let opts = { method: method, headers: { 'x-atlas-api-key': apiKey } };
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
    let rand = Math.random().toString(36).slice(2, 10);
    let stamp;
    try { stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); } catch (e) { stamp = 'x'; }
    return 'FR-' + stamp + '-' + rand;
  }

  function readDeviceId() {
    try {
      let id = window.localStorage.getItem(DEVICE_ID_STORAGE);
      if (!id) {
        id = 'dev-' + Math.random().toString(36).slice(2, 12);
        window.localStorage.setItem(DEVICE_ID_STORAGE, id);
      }
      return id;
    } catch (e) { return ''; }
  }

  function readAppVersion() {
    try {
      let el = document.getElementById('shell-version') || document.querySelector('[data-shell-version]');
      if (el) return (el.getAttribute('data-shell-version') || el.textContent || '').trim();
    } catch (e) {}
    return '';
  }

  function currentRoute() {
    try {
      let active = document.querySelector('.tab-content:not([hidden]), [data-tab].active, main [aria-current="page"]');
      if (active && active.id) return active.id;
      if (window.location && window.location.hash) return window.location.hash.replace(/^#/, '');
    } catch (e) {}
    return 'app';
  }

  function prop(id, name) {
    try { let n = document.getElementById(id); return n ? !!n[name] : null; } catch (e) { return null; }
  }

  // The coach's visible message = the MOST RECENT rendered reply bubble, which is a
  // `.coach-msg` inside a `.chat-bubble-atlas` (readbacks, chat answers, plan edits).
  // Only when the conversation hasn't started yet (the `#coach-empty` hero is still
  // visible) does the home opener `#coach-opening` count. The old selector was
  // `.coach-guide-box, #coach-opening, .coach-message`: `.coach-message` doesn't exist,
  // and `.coach-guide-box` is the home hero WRAPPER (index.html, before `#coach-opening`
  // in tree order), so querySelector always returned the persistent hero box's text —
  // the stale idle greeting — and never a reply bubble, making every snapshot look
  // "stuck" no matter what the coach actually said. Reads the live DOM only; never
  // changes any coach copy.
  function latestCoachMessage() {
    try {
      let bubbles = document.querySelectorAll('.chat-bubble-atlas .coach-msg');
      if (bubbles && bubbles.length) {
        // Preserve the last VALID coach message (PR-11 Bug 4 / addendum #7): the last
        // .coach-msg can be transiently EMPTY — a receipt-only (ack) block, a
        // suppressed message, or a bubble mid-typewriter — so walk back to the most
        // recent non-empty bubble instead of reporting a blank coach_message.
        for (let i = bubbles.length - 1; i >= 0; i--) {
          const t = (bubbles[i].textContent || '').trim();
          if (t) return truncate(t, 400);
        }
      }
      let hero = document.getElementById('coach-empty');
      let opening = document.getElementById('coach-opening');
      if (opening && (!hero || !hero.hasAttribute('hidden'))) {
        const t = (opening.textContent || '').trim();
        if (t) return truncate(t, 400);
      }
      return null;
    } catch (e) { return null; }
  }

  function snapshotUiState() {
    try {
      let modal = document.querySelector('.modal:not([hidden]), [role="dialog"]:not([hidden])');
      let toast = document.querySelector('.toast:not([hidden]), .banner:not([hidden]), [role="status"]:not([hidden])');
      return {
        composer_disabled: prop('workout-text', 'disabled'),
        preview_btn_disabled: prop('preview-btn', 'disabled'),
        approve_btn_disabled: prop('approve-btn', 'disabled'),
        preview_panel_hidden: prop('preview-panel', 'hidden'),
        modal: modal ? (modal.id || modal.className || 'modal') : null,
        toast: toast ? truncate((toast.textContent || '').trim(), 200) : null,
        coach_message: latestCoachMessage()
      };
    } catch (e) { return {}; }
  }

  function snapshotSessionState() {
    // The client cannot see the server's authoritative plan object; capture the visible
    // session pin/next-up chrome instead (server has the rest via the API-flow lane).
    try {
      let pin = document.querySelector('#session-pin, .session-pin, #session-resume-notice');
      return { pin: pin ? truncate((pin.textContent || '').trim(), 200) : null };
    } catch (e) { return {}; }
  }

  // Headers that link an app API call to this client session, so the server-side
  // api_response events (FR2 middleware) can be stitched into the same transcript. Empty
  // when the recorder is inactive → those requests are byte-identical. app.js's api()
  // spreads these into every /api call.
  function requestHeaders() {
    if (!_active) return {};
    return { 'x-atlas-flight-session': _active.flightSessionId, 'x-atlas-device-id': _active.deviceId };
  }

  // ------------------------------------------------------------------ FR4: Debug UX
  // The current live session id (or null when the recorder is inert/off).
  function getSessionId() { return _active ? _active.flightSessionId : null; }

  // Drop a bug_marker pin into the transcript — the owner taps "mark issue here" the
  // moment something looks wrong, and the marker flushes promptly (shouldFlush) so replay
  // lands exactly there. No-op with a reason when the recorder is off (flag not enabled).
  function markIssue(note) {
    try {
      if (!_active) return { ok: false, reason: 'inactive' };
      record(_active, 'bug_marker', {
        user_action: 'bug_marker',
        user_input: note || '',
        route: currentRoute(),
        ui_snapshot: snapshotUiState(),
        session_state: snapshotSessionState()
      });
      return { ok: true, flight_session_id: _active.flightSessionId };
    } catch (e) { return { ok: false }; }
  }

  function _setText(id, text) {
    try { let el = document.getElementById(id); if (el) el.textContent = text; } catch (e) {}
  }

  function updateDebugStatus() {
    _setText('flight-enabled', _active ? 'ON' : 'OFF');
    _setText('flight-session-id', getSessionId() || '—');
  }

  // Wire the Settings → Flight Recorder (debug) card. Runs regardless of the flag so the
  // owner can always SEE the state; the buttons hit the read endpoint (last-20 events),
  // copy the transcript, or drop a bug_marker. Best-effort throughout.
  function wireDebugUi() {
    if (typeof document === 'undefined') return;
    let apiKeyOf = function () { try { return window.localStorage.getItem(API_KEY_STORAGE) || ''; } catch (e) { return ''; } };
    let resultEl = document.getElementById('flight-result');

    function render(log) {
      _setText('flight-enabled', log && log.enabled ? 'ON' : 'OFF');
      _setText('flight-session-id', getSessionId() || (log && log.entries && log.entries[0] && log.entries[0].flight_session_id) || '—');
      if (!resultEl) return;
      let entries = (log && Array.isArray(log.entries)) ? log.entries.slice(0, 20) : [];
      if (!entries.length) {
        resultEl.textContent = (log && log.enabled) ? 'No events yet — interact with the app, then Refresh.'
          : 'Flight Recorder is OFF (set ATLAS_FLIGHT_RECORDER=1 on the server).';
        return;
      }
      let lines = entries.map(function (e) {
        return [e.captured_at, e.event_type, e.route || '',
          e.api_endpoint || e.user_action || e.user_input || '',
          (e.latency_ms != null && e.latency_ms !== '' ? e.latency_ms + 'ms' : ''),
          e.error || ''].filter(Boolean).join('  ·  ');
      });
      let pre = document.createElement('pre');
      pre.className = 'debug-pre';
      pre.textContent = lines.join('\n');
      resultEl.innerHTML = '';
      resultEl.appendChild(pre);
    }

    function refresh() {
      return fetchJson('GET', '/api/flight/recent', null, apiKeyOf())
        .then(function (json) { render(json && json.data ? json.data : null); })
        .catch(function () { if (resultEl) resultEl.textContent = 'Could not load the Flight Recorder log.'; });
    }

    let refreshBtn = document.getElementById('flight-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', refresh);

    let copyBtn = document.getElementById('flight-copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      fetchJson('GET', '/api/flight/recent', null, apiKeyOf()).then(function (json) {
        let text = JSON.stringify(json && json.data ? json.data : json, null, 2);
        try { if (navigator.clipboard) navigator.clipboard.writeText(text); } catch (e) {}
        if (resultEl) { let pre = document.createElement('pre'); pre.className = 'debug-pre'; pre.textContent = text; resultEl.innerHTML = ''; resultEl.appendChild(pre); }
      }).catch(function () {});
    });

    let markForm = document.getElementById('flight-mark-form');
    let markNote = document.getElementById('flight-mark-note');
    if (markForm) markForm.addEventListener('submit', function (ev) {
      try { ev.preventDefault(); } catch (e) {}
      let r = markIssue(markNote && markNote.value ? markNote.value : '');
      if (resultEl) resultEl.textContent = (r && r.ok)
        ? ('Issue marked in session ' + (r.flight_session_id || '') + '. Refreshing…')
        : 'Flight Recorder is OFF — enable ATLAS_FLIGHT_RECORDER on the server to mark issues.';
      if (markNote) markNote.value = '';
      if (r && r.ok) window.setTimeout(refresh, 300);
    });

    updateDebugStatus();
    if (resultEl && !resultEl.textContent) resultEl.textContent = 'Tap "Refresh events" to load the recent transcript.';
  }

  // ---- exports / auto-init ----
  let exported = {
    FLUSH_AT: FLUSH_AT,
    FLUSH_INTERVAL_MS: FLUSH_INTERVAL_MS,
    RING_MAX: RING_MAX,
    ATLAS_EVENT_MAP: ATLAS_EVENT_MAP,
    redactString: redactString,
    truncate: truncate,
    buildClientEvent: buildClientEvent,
    shouldFlush: shouldFlush,
    markIssue: markIssue,
    getSessionId: getSessionId,
    requestHeaders: requestHeaders,
    latestCoachMessage: latestCoachMessage
  };

  // Browser side-effect: expose the API for the (still-classic) app.js consumer
  // (window.atlasFlightRecorder) and self-init. `root` is globalThis === window
  // here. In Node (tests) document is undefined, so nothing attaches — the module
  // is import-only and byte-inert, exactly as the old UMD Node branch was.
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    root.atlasFlightRecorder = exported;
    let boot = function () { initBrowser(); wireDebugUi(); };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  return exported;
}(typeof globalThis !== 'undefined' ? globalThis : this));

export const {
  FLUSH_AT,
  FLUSH_INTERVAL_MS,
  RING_MAX,
  ATLAS_EVENT_MAP,
  redactString,
  truncate,
  buildClientEvent,
  shouldFlush,
  markIssue,
  getSessionId,
  requestHeaders,
  latestCoachMessage
} = _exports;
