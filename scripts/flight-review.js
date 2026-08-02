#!/usr/bin/env node
/**
 * Atlas test-evidence extractor — "Flight Review" (READ-ONLY).
 *
 * Exports accumulated real-world test data from Google Sheets into a reviewable
 * debugging report, grouped by `flight_session_id`. It reads the Flight Recorder
 * transcript plus the shadow lanes and workout log, correlates them per session,
 * flags obvious anomalies, and writes:
 *
 *   outputs/flight-review/<timestamp>.json
 *   outputs/flight-review/<timestamp>.md
 *
 * This is EVIDENCE EXTRACTION AND PLANNING ONLY. It:
 *   - reads with the Sheets READ-ONLY scope (cannot write even if it tried),
 *   - never mutates any tab, never touches the trust/write path,
 *   - never changes runtime behavior, and proposes no fixes.
 *
 * Tabs consumed (each optional — a missing tab is skipped, never fatal):
 *   Flight_Recorder | Brain_Shadow | Intent_Shadow | Log_Cleaned | Bug_Reports
 *
 * Usage:
 *   node scripts/flight-review.js
 *   node scripts/flight-review.js --sheet=<spreadsheetId>
 *   node scripts/flight-review.js --window-mins=5
 *   node scripts/flight-review.js --from-dir=backups/<ts>   # offline, from a backup export
 *   node scripts/flight-review.js --out=outputs/flight-review
 *
 * Sheet selection precedence: --sheet=<id>  >  FLIGHT_REVIEW_SHEET_ID env
 *   >  GOOGLE_SHEETS_ID env. No sheet id is embedded in this file (matching the
 *   sibling scripts/export-sheets-backup.js, which is env-only) — pass the target
 *   explicitly via --sheet or one of those env vars.
 * Requires the server env vars for the live path: GOOGLE_SERVICE_ACCOUNT_EMAIL,
 * GOOGLE_PRIVATE_KEY (and a sheet id from one of the sources above).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TABS = ['Flight_Recorder', 'Brain_Shadow', 'Intent_Shadow', 'Log_Cleaned', 'Bug_Reports'];

// Known column contracts (config/columns.js + the shadow-lane persist rows +
// services/bugReport.js). Used to name columns positionally when a tab carries no
// header row; when a header row IS present it wins, so column-order drift on the
// sheet never silently misaligns the report.
const KNOWN_COLUMNS = {
  Flight_Recorder: [
    'captured_at', 'flight_session_id', 'seq', 'app_version', 'device_id',
    'route', 'event_type', 'user_input', 'user_action', 'ui_snapshot_json',
    'session_state_json', 'api_endpoint', 'request_summary', 'response_summary',
    'decision_summary_json', 'shadow_refs_json', 'error', 'latency_ms'
  ],
  Brain_Shadow: [
    'captured_at', 'route', 'lift_code', 'mode', 'ok', 'reason', 'decision_type',
    'status', 'confidence_tier', 'skipped_json', 'comparable', 'diverged',
    'weight_delta', 'reps_delta', 'ms', 'app_version'
  ],
  Intent_Shadow: [
    'captured_at', 'message_preview', 'intent_type', 'confidence',
    'constraint_keys_json', 'dropped_keys_json', 'ok', 'latency_ms', 'source',
    'route', 'app_version', 'review_status', 'review_notes'
  ],
  Log_Cleaned: [
    'date_clean', 'session_id', 'exercise', 'canonical_exercise', 'muscle_group',
    'lift_code', 'set_number', 'weight', 'reps', 'rir', 'notes', 'volume_calc'
  ],
  Bug_Reports: [
    'created_at', 'bug_id', 'note', 'route', 'session_id', 'last_error',
    'app_version', 'user_agent', 'payload_json', 'error_count',
    'last_failed_endpoint', 'last_action', 'stale_shell', 'ui_blocked'
  ]
};

const SESSION_ID_RE = /\b\d{8}-(?:AM|PM)-\d{2}\b/g; // services/sessionId.js format
const DEFAULT_WINDOW_MINS = 5;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests — no network, no filesystem)
// ---------------------------------------------------------------------------

function norm(name) {
  return String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, '_');
}

// Display-header aliases → the canonical (snake_case) column name. Real sheets label
// columns for humans ("Set #", "Date_Clean", "Session ID", "Lift Code", "Canonical
// Name"), which don't all normalize to the contract names — most importantly
// `norm("Set #")` is "set_#", not "set_number", which silently blanked the set column
// (and its dup/set anomalies) until a manual patch. An alias only ever SNAPS a header
// to a canonical column that the tab actually has (see canonicalizeHeaderName), so it
// can never mis-map a column a tab doesn't declare; unknown extras pass through as-is.
const HEADER_ALIASES = {
  'set_#': 'set_number', 'set#': 'set_number', set: 'set_number', set_no: 'set_number',
  setno: 'set_number', 'set_no.': 'set_number', set_num: 'set_number', set_number: 'set_number',
  date: 'date_clean', dateclean: 'date_clean', date_clean: 'date_clean',
  session: 'session_id', sessionid: 'session_id', 'session_#': 'session_id',
  canonical: 'canonical_exercise', canonical_name: 'canonical_exercise', canonicalexercise: 'canonical_exercise',
  muscle: 'muscle_group', musclegroup: 'muscle_group',
  lift: 'lift_code', liftcode: 'lift_code', code: 'lift_code',
  volume: 'volume_calc', volumecalc: 'volume_calc',
  rep: 'reps', rirs: 'rir', note: 'notes',
  bug: 'bug_id', bugid: 'bug_id', created: 'created_at', createdat: 'created_at'
};

// Resolve one header cell to its canonical column name for a given tab. A normalized
// header that already IS a known column wins; otherwise an alias is applied ONLY when
// it maps to a column the tab declares; otherwise the normalized name passes through
// (so genuine extra columns — e1RM_Calc, Week, … — are preserved, never dropped).
function canonicalizeHeaderName(cell, knownSet) {
  const n = norm(cell);
  if (knownSet.has(n)) return n;
  const aliased = HEADER_ALIASES[n];
  if (aliased && knownSet.has(aliased)) return aliased;
  return n;
}

// True when the first row looks like a header (contains a majority of the known
// column names, alias-aware) rather than data.
function looksLikeHeader(firstRow, knownColumns) {
  if (!Array.isArray(firstRow) || !firstRow.length) return false;
  const knownSet = new Set(knownColumns.map(norm));
  const hits = firstRow.filter(cell => knownSet.has(canonicalizeHeaderName(cell, knownSet))).length;
  return hits >= Math.max(2, Math.ceil(knownColumns.length / 2));
}

// Turn raw A:Z rows into an array of { <column>: value } records. Uses the sheet's
// own header row when present (alias-aware, so display headers like "Set #" map to
// the contract name); otherwise falls back to the known column contract (positional).
function rowsToRecords(rows, knownColumns) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const knownSet = new Set(knownColumns.map(norm));
  let header;
  let dataRows;
  if (looksLikeHeader(rows[0], knownColumns)) {
    header = rows[0].map(cell => canonicalizeHeaderName(cell, knownSet));
    dataRows = rows.slice(1);
  } else {
    header = knownColumns.map(norm);
    dataRows = rows;
  }
  return dataRows.map((row, idx) => {
    const rec = { _row: idx };
    for (let i = 0; i < header.length; i += 1) {
      rec[header[i]] = row[i] === undefined ? '' : row[i];
    }
    // Preserve any trailing cells beyond the header so nothing is silently dropped.
    if (Array.isArray(row) && row.length > header.length) {
      rec._extra = row.slice(header.length);
    }
    return rec;
  });
}

function safeParseJson(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function parseTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

// Extract an HTTP status code (100–599) from a free-text status/summary/error.
function extractStatusCode(text) {
  if (text == null) return null;
  const str = String(text);
  const m = str.match(/\b([1-5]\d{2})\b/);
  if (!m) return null;
  const code = Number(m[1]);
  return code >= 100 && code <= 599 ? code : null;
}

function statusClass(code) {
  if (!Number.isFinite(code)) return null;
  if (code >= 500) return '5xx';
  if (code >= 400) return '4xx';
  if (code >= 300) return '3xx';
  if (code >= 200) return '2xx';
  return '1xx';
}

// Walk any parsed JSON value collecting values under a session-id-shaped key,
// excluding the flight_session_id itself.
function deepCollectSessionIds(value, excludeId, out, depth) {
  if (value == null || depth > 6) return out;
  if (typeof value === 'string') {
    const matches = value.match(SESSION_ID_RE);
    if (matches) for (const m of matches) if (m !== excludeId) out.add(m);
    return out;
  }
  if (typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) deepCollectSessionIds(item, excludeId, out, depth + 1);
    return out;
  }
  for (const [key, v] of Object.entries(value)) {
    if (/session_?id/i.test(key) && typeof v === 'string' && v && v !== excludeId) {
      out.add(v);
    } else {
      deepCollectSessionIds(v, excludeId, out, depth + 1);
    }
  }
  return out;
}

// Pull the coach message a flight event painted, checking the known snapshot /
// decision shapes. Returns '' when the event carries none.
function extractCoachMessage(event) {
  const candidates = [];
  const ui = safeParseJson(event.ui_snapshot_json);
  const dec = safeParseJson(event.decision_summary_json);
  for (const obj of [ui, dec]) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of [
      'primary_coach_message', 'primaryCoachMessage', 'coach_message',
      'coachMessage', 'coach', 'message', 'reply', 'text'
    ]) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) candidates.push(v.trim());
    }
  }
  return candidates.length ? candidates[0] : '';
}

function isQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  return /^(who|what|when|where|why|how|which|should|can|could|would|will|do|does|did|is|are|am|was|were|have|has)\b/i.test(t);
}

const IDLE_COACH_RE = /(what'?s next|ready when you|standing by|let me know|tap a|nothing to|no active|idle|waiting)/i;

// ---------------------------------------------------------------------------
// Grouping + correlation
// ---------------------------------------------------------------------------

function groupBySession(flightRecords) {
  const byId = new Map();
  const noSession = [];
  for (const rec of flightRecords) {
    const id = String(rec.flight_session_id || '').trim();
    if (!id) { noSession.push(rec); continue; }
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(rec);
  }
  const sessions = [];
  for (const [id, events] of byId) {
    // Order by seq when present, else by captured_at, else by original row order.
    events.sort((a, b) => {
      const sa = Number(a.seq); const sb = Number(b.seq);
      if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
      const ta = parseTimestamp(a.captured_at); const tb = parseTimestamp(b.captured_at);
      if (ta != null && tb != null && ta !== tb) return ta - tb;
      return (a._row || 0) - (b._row || 0);
    });
    const times = events.map(e => parseTimestamp(e.captured_at)).filter(t => t != null);
    sessions.push({
      flight_session_id: id,
      events,
      first_at_ms: times.length ? Math.min(...times) : null,
      last_at_ms: times.length ? Math.max(...times) : null
    });
  }
  sessions.sort((a, b) => (a.first_at_ms || 0) - (b.first_at_ms || 0));
  return { sessions, noSession };
}

// True when two route/endpoint strings name the same surface. Matches on exact
// equality or a shared whole path segment — NOT bare substring containment, which
// would over-tag: an api_endpoint like "GET /" normalizes to the hint "/", and a
// naive `route.includes(hint)` would then mark every slash-bearing route as a strong
// route+time match. Degenerate hints (empty, or a lone separator with no real segment)
// therefore match nothing.
const GENERIC_ROUTE_SEGMENTS = new Set(['api']); // prefixes nearly every endpoint — not a "same surface" signal
function routeOverlaps(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const segs = s => new Set(
    String(s).split(/[/\s]+/).filter(seg => seg.length >= 2 && !GENERIC_ROUTE_SEGMENTS.has(seg))
  );
  const aSet = segs(a);
  for (const seg of segs(b)) if (aSet.has(seg)) return true;
  return false;
}

// Shadow entries (Brain/Intent) near a session's time window. Each is tagged by how
// tightly it correlates: `route+time` when the entry's route also matches a route or
// endpoint the flight session actually touched (a strong join — the lane fired on the
// same surface at the same time), else `time` (window only, weaker). Route matches are
// surfaced first, then by time proximity to the session, so the strongest evidence
// leads. `routeHints` is the set of routes/endpoints seen in the session's events.
function correlateByTime(session, records, windowMs, routeHints) {
  if (session.first_at_ms == null) return [];
  const lo = session.first_at_ms - windowMs;
  const hi = (session.last_at_ms == null ? session.first_at_ms : session.last_at_ms) + windowMs;
  const mid = (lo + hi) / 2;
  const hints = routeHints instanceof Set ? routeHints : new Set();
  return records
    .map(rec => ({ rec, t: parseTimestamp(rec.captured_at) }))
    .filter(x => x.t != null && x.t >= lo && x.t <= hi)
    .map(x => {
      const route = String(x.rec.route || '').trim().toLowerCase();
      const routeMatch = route !== '' && (hints.has(route) || [...hints].some(h => routeOverlaps(route, h)));
      return { rec: x.rec, t: x.t, match: routeMatch ? 'route+time' : 'time' };
    })
    .sort((a, b) => (a.match === b.match ? Math.abs(a.t - mid) - Math.abs(b.t - mid) : (a.match === 'route+time' ? -1 : 1)))
    .map(x => ({ rec: x.rec, match: x.match }));
}

// Log rows correlated to a session. Strong: rows whose session_id was discovered in
// the flight transcript. Weak fallback: rows on a date in the session's window — but
// ONLY when NO session_id could be tied to this flight session, so a precisely
// resolved session no longer also vacuums up every unrelated same-day row (the
// over-attach called out in the extractor's own backlog). Each row keeps its match tag.
function correlateLogs(session, logRecords, workoutSessionIds, dateSet) {
  const idSet = new Set(Array.from(workoutSessionIds).map(s => s.toLowerCase()));
  const byId = [];
  const byDate = [];
  for (const row of logRecords) {
    const sid = String(row.session_id || '').trim();
    if (sid && idSet.has(sid.toLowerCase())) { byId.push({ row, match: 'session_id' }); continue; }
    const date = String(row.date_clean || '').trim();
    if (date && dateSet.has(date)) byDate.push({ row, match: 'date_window' });
  }
  return byId.length ? byId : byDate;
}

// The set of LOCAL dates that can intersect a session's UTC evidence window
// (YYYY-MM-DD), for the date-window log fallback (Log_Cleaned carries a local
// date, not a timestamp).
//
// The window timestamps are UTC; the rows are stamped in the athlete's LOCAL
// date. Those two disagree whenever the local offset pushes the workout across
// midnight, so the set must reach BOTH WAYS. This used to walk forward only
// (`lo` → `hi + 1 day`), which silently broke every evening session west of
// UTC: a 17:34 Pacific workout is captured at `2026-08-02T00:34Z` while its
// rows are correctly dated `2026-08-01`, so the set was
// `{2026-08-02, 2026-08-03}` and matched nothing — zero correlated rows and an
// all-UNKNOWN verdict for a session that wrote and sealed correctly.
//
// Real UTC offsets span −12h…+14h, so a local date can differ from the UTC date
// by at most one day in either direction. Padding the window by a full day on
// each side therefore covers every zone exactly, with no timezone configuration
// to get wrong. Widening the candidate set widens over-attach risk in exchange,
// which is why the date fallback is now ambiguity-checked (see
// `dateFallbackAmbiguity`) and refused outright when it cannot name one workout.
const LOCAL_DATE_PAD_MS = 86400000; // one day each side — covers UTC−12…UTC+14
function sessionDateSet(session, windowMs) {
  const set = new Set();
  if (session.first_at_ms == null) return set;
  const lo = session.first_at_ms - windowMs - LOCAL_DATE_PAD_MS;
  const hi = (session.last_at_ms == null ? session.first_at_ms : session.last_at_ms)
    + windowMs + LOCAL_DATE_PAD_MS;
  for (let t = lo; t <= hi; t += 86400000) {
    set.add(new Date(t).toISOString().slice(0, 10));
  }
  set.add(new Date(hi).toISOString().slice(0, 10));
  return set;
}

// Whether a set of DATE-matched rows can be attributed to exactly one workout.
//
// The date fallback exists only because the recorder stores request field NAMES
// and never their values, so a workout `session_id` is often undiscoverable in
// the transcript. It is a weak join: every row sharing a candidate date matches.
// With the window now reaching both ways, a neighbouring session's rows can sit
// on a candidate date too — so before trusting the fallback the tool checks that
// the matched rows name at most ONE workout. Two or more distinct workout
// identities means the tool cannot tell which workout is the reviewed one, and
// guessing would silently attribute another session's rows. That fails closed
// instead, carrying the exact reason.
//
// Rows that carry no session_id at all are not ambiguous on their own — they
// name no competing workout.
function dateFallbackAmbiguity(rows) {
  const ids = new Set();
  for (const r of rows || []) {
    const row = r && r.row ? r.row : (r && r.rec ? r.rec : r);
    const sid = String((row && row.session_id) || '').trim();
    if (sid) ids.add(sid.toLowerCase());
  }
  const distinct = Array.from(ids).sort();
  return {
    ambiguous: distinct.length > 1,
    distinct_session_ids: distinct,
    reason: distinct.length > 1
      ? `date-window correlation matched rows from ${distinct.length} distinct workout sessions (${distinct.join(', ')}) — cannot attribute them to one session`
      : ''
  };
}

// ---------------------------------------------------------------------------
// Per-session evidence assembly
// ---------------------------------------------------------------------------

function buildSessionEvidence(session, corpora, options) {
  const windowMs = options.windowMs;
  const events = session.events;

  // An explicitly supplied workout identity ALWAYS WINS. When the operator names
  // the workout session, correlation is exact and the weak date fallback is never
  // consulted, so the tool cannot drift onto a neighbouring session's rows.
  //
  // "Wins" must mean REPLACES, not "is added to". Seeding the discovery set with
  // the explicit id and then letting the transcript scan add its own would let a
  // stale or neighbouring identity correlate alongside the named one, while the
  // join still called itself exact. `workoutSessionIds` therefore stays purely
  // the DISCOVERED set (it is reported as such), and correlation reads
  // `correlationIds` below, which the explicit ids replace outright.
  const explicitIds = (options.explicitWorkoutSessionIds || [])
    .map(s => String(s || '').trim()).filter(Boolean);
  const workoutSessionIds = new Set();
  const userInputs = [];
  const coachMessages = [];
  const apiCalls = [];
  const bugMarkers = [];
  const errors = [];

  for (const e of events) {
    const type = String(e.event_type || '').trim();

    // Discover workout session ids referenced anywhere in the transcript.
    for (const field of ['session_state_json', 'decision_summary_json', 'ui_snapshot_json', 'shadow_refs_json']) {
      deepCollectSessionIds(safeParseJson(e[field]), session.flight_session_id, workoutSessionIds, 0);
    }
    for (const field of ['user_input', 'request_summary', 'response_summary', 'api_endpoint']) {
      const txt = String(e[field] || '');
      const m = txt.match(SESSION_ID_RE);
      if (m) for (const id of m) if (id !== session.flight_session_id) workoutSessionIds.add(id);
    }

    if (e.user_input && String(e.user_input).trim()) {
      userInputs.push({ at: e.captured_at, seq: e.seq, route: e.route, text: String(e.user_input).trim(), event_type: type });
    }

    const coachMsg = extractCoachMessage(e);
    if (type === 'coach_message_rendered' || coachMsg) {
      if (coachMsg) coachMessages.push({ at: e.captured_at, seq: e.seq, route: e.route, text: coachMsg });
    }

    if (type === 'api_request' || type === 'api_response' || e.api_endpoint) {
      const status = extractStatusCode(e.response_summary) || extractStatusCode(e.error);
      apiCalls.push({
        at: e.captured_at,
        seq: e.seq,
        event_type: type,
        endpoint: String(e.api_endpoint || '').trim(),
        request_summary: String(e.request_summary || '').trim(),
        response_summary: String(e.response_summary || '').trim(),
        status,
        status_class: statusClass(status),
        latency_ms: e.latency_ms,
        error: String(e.error || '').trim()
      });
    }

    if (type === 'bug_marker') {
      bugMarkers.push({ at: e.captured_at, seq: e.seq, route: e.route, note: String(e.user_input || e.user_action || '').trim() });
    }

    if ((type === 'error' || (e.error && String(e.error).trim())) && type !== 'api_response') {
      errors.push({ at: e.captured_at, seq: e.seq, route: e.route, endpoint: String(e.api_endpoint || '').trim(), error: String(e.error || '').trim() });
    }
  }

  // Routes + endpoints the session actually touched — the hints that let a shadow
  // entry correlate by route as well as time (a tighter join than time alone).
  const routeHints = new Set();
  for (const e of events) {
    const r = String(e.route || '').trim().toLowerCase();
    if (r) routeHints.add(r);
    const ep = String(e.api_endpoint || '').trim().toLowerCase();
    if (ep) routeHints.add(ep.replace(/^[a-z]+\s+/, '')); // drop leading method ("post ")
  }

  // Exact identity beats the date heuristic. An explicit id REPLACES transcript
  // discovery, and with either one present the date fallback is switched off.
  const correlationIds = explicitIds.length ? new Set(explicitIds) : workoutSessionIds;
  const dateFallbackAllowed = explicitIds.length === 0;
  const dateSet = dateFallbackAllowed ? sessionDateSet(session, windowMs) : new Set();
  let logRows = correlateLogs(session, corpora.Log_Cleaned, correlationIds, dateSet);

  // Grade the join, and refuse a date fallback that cannot name one workout.
  const usedDateFallback = logRows.length > 0 && logRows.every(x => x.match === 'date_window');
  const ambiguity = usedDateFallback ? dateFallbackAmbiguity(logRows) : { ambiguous: false, distinct_session_ids: [], reason: '' };
  if (ambiguity.ambiguous) logRows = [];

  // When the date fallback DID name exactly one workout, that identity is now
  // ESTABLISHED and every sidecar tab is joined against it. Without this the
  // sidecars would still be matched on date alone, so an `Effort` or
  // `Session_Plans` row carrying a DIFFERENT workout id could be attributed to
  // this verdict — two workouts' evidence reported as one session's PASS.
  const establishedIds = new Set(correlationIds);
  if (!ambiguity.ambiguous) for (const id of ambiguity.distinct_session_ids) establishedIds.add(id);

  const logCorrelation = {
    basis: explicitIds.length ? 'explicit_session_id'
      : (logRows.length && !usedDateFallback ? 'session_id'
        : (usedDateFallback ? 'date_window' : 'none')),
    date_fallback_allowed: dateFallbackAllowed,
    dates_considered: Array.from(dateSet).sort(),
    established_session_ids: Array.from(establishedIds).map(s => String(s).toLowerCase()).sort(),
    ambiguous: ambiguity.ambiguous,
    distinct_session_ids: ambiguity.distinct_session_ids,
    reason: ambiguity.reason
  };
  const brain = correlateByTime(session, corpora.Brain_Shadow, windowMs, routeHints);
  const intent = correlateByTime(session, corpora.Intent_Shadow, windowMs, routeHints);

  // Bug reports: by matching session id (flight or workout), else within the window.
  const idMatchSet = new Set([session.flight_session_id, ...workoutSessionIds].map(s => String(s).toLowerCase()));
  const bugReports = [];
  for (const b of corpora.Bug_Reports) {
    const sid = String(b.session_id || '').trim().toLowerCase();
    const t = parseTimestamp(b.created_at);
    const inWindow = t != null && session.first_at_ms != null &&
      t >= session.first_at_ms - windowMs &&
      t <= (session.last_at_ms == null ? session.first_at_ms : session.last_at_ms) + windowMs;
    if ((sid && idMatchSet.has(sid)) || inWindow) {
      bugReports.push({ rec: b, match: sid && idMatchSet.has(sid) ? 'session_id' : 'time_window' });
    }
  }

  const evidence = {
    flight_session_id: session.flight_session_id,
    first_at: session.first_at_ms != null ? new Date(session.first_at_ms).toISOString() : null,
    last_at: session.last_at_ms != null ? new Date(session.last_at_ms).toISOString() : null,
    event_count: events.length,
    event_type_counts: countBy(events, e => String(e.event_type || 'unknown')),
    routes: unique(events.map(e => String(e.route || '').trim()).filter(Boolean)),
    workout_session_ids: Array.from(workoutSessionIds),
    user_inputs: userInputs,
    coach_messages: coachMessages,
    api_calls: apiCalls,
    bug_markers: bugMarkers,
    errors,
    workout_rows_written: logRows.map(x => ({ match: x.match, ...pickLogRow(x.row) })),
    log_correlation: logCorrelation,
    brain_shadow_near: brain.map(x => ({ match: x.match, ...pickBrainRow(x.rec) })),
    intent_shadow_near: intent.map(x => ({ match: x.match, ...pickIntentRow(x.rec) })),
    bug_reports: bugReports.map(x => ({ match: x.match, ...pickBugRow(x.rec) }))
  };
  evidence.anomalies = detectAnomalies(evidence);
  return evidence;
}

function pickLogRow(row) {
  return {
    date_clean: row.date_clean, session_id: row.session_id, exercise: row.exercise,
    set_number: row.set_number, weight: row.weight, reps: row.reps, rir: row.rir,
    notes: row.notes, volume_calc: row.volume_calc
  };
}
function pickBrainRow(row) {
  return {
    captured_at: row.captured_at, route: row.route, lift_code: row.lift_code, mode: row.mode,
    ok: row.ok, reason: row.reason, decision_type: row.decision_type, status: row.status,
    confidence_tier: row.confidence_tier, diverged: row.diverged, ms: row.ms
  };
}
function pickIntentRow(row) {
  return {
    captured_at: row.captured_at, message_preview: row.message_preview, intent_type: row.intent_type,
    confidence: row.confidence, ok: row.ok, latency_ms: row.latency_ms, route: row.route,
    review_status: row.review_status
  };
}
function pickBugRow(row) {
  return {
    created_at: row.created_at, bug_id: row.bug_id, note: row.note, route: row.route,
    session_id: row.session_id, last_error: row.last_error, last_failed_endpoint: row.last_failed_endpoint,
    error_count: row.error_count, ui_blocked: row.ui_blocked, stale_shell: row.stale_shell
  };
}

// ---------------------------------------------------------------------------
// Anomaly detection (heuristic — every finding carries its evidence so a human
// can confirm; the report is for triage/planning, not automated action)
// ---------------------------------------------------------------------------

function detectAnomalies(ev) {
  const found = [];

  // 1. Repeated idle coach messages — the same coach text painted >= 2x, or an
  //    idle-shaped coach message painted more than once.
  const coachCounts = countBy(ev.coach_messages, c => c.text);
  for (const [text, count] of Object.entries(coachCounts)) {
    if (count >= 2 && (IDLE_COACH_RE.test(text) || count >= 3)) {
      found.push({
        type: 'repeated_idle_coach_messages',
        severity: IDLE_COACH_RE.test(text) ? 'warn' : 'info',
        count,
        detail: `Coach message painted ${count}×: "${truncate(text, 140)}"`
      });
    }
  }

  // 2. 4xx/5xx responses.
  for (const call of ev.api_calls) {
    if (call.status_class === '4xx' || call.status_class === '5xx') {
      found.push({
        type: 'http_error_response',
        severity: call.status_class === '5xx' ? 'error' : 'warn',
        at: call.at,
        detail: `${call.endpoint || '(endpoint?)'} → ${call.status}${call.error ? ` (${truncate(call.error, 80)})` : ''}`
      });
    }
  }

  // 3. Missing session IDs — workout writes with no resolvable workout session id.
  const WRITE_RE = /log-?workout|complete-?workout|save|append/i;
  const hasWorkoutId = ev.workout_session_ids.length > 0;
  for (const call of ev.api_calls) {
    if (call.event_type === 'api_response' && WRITE_RE.test(call.endpoint) && !hasWorkoutId) {
      found.push({
        type: 'missing_session_id',
        severity: 'warn',
        at: call.at,
        detail: `Write-path call ${call.endpoint} with no workout session_id discoverable in the transcript`
      });
    }
  }
  for (const row of ev.workout_rows_written) {
    if (!String(row.session_id || '').trim()) {
      found.push({
        type: 'missing_session_id',
        severity: 'warn',
        detail: `Correlated Log_Cleaned row (${row.exercise || '?'} / ${row.date_clean || '?'}) has an empty session_id`
      });
    }
  }

  // 4. Repeated completed exercises — a duplicate (session_id, exercise, set_number)
  //    among the logged rows, or a "complete exercise" action fired twice for the
  //    same exercise.
  const setKeys = countBy(
    ev.workout_rows_written,
    r => `${norm(r.session_id)}||${norm(r.exercise)}||${norm(r.set_number)}`
  );
  for (const [key, count] of Object.entries(setKeys)) {
    if (count >= 2 && !key.startsWith('||||')) {
      found.push({
        type: 'repeated_completed_exercise',
        severity: 'warn',
        count,
        detail: `Duplicate logged set (session||exercise||set = ${key}) appears ${count}×`
      });
    }
  }

  // 5. Session confirm mismatch — a confirmation message claims N sets/exercises
  //    that the correlated log rows don't back up (or claims completion with zero
  //    logged rows).
  const loggedRows = ev.workout_rows_written.length;
  const loggedExercises = unique(ev.workout_rows_written.map(r => norm(r.exercise)).filter(Boolean)).length;
  for (const c of ev.coach_messages) {
    const claim = parseConfirmClaim(c.text);
    if (!claim) continue;
    if (claim.kind === 'sets' && loggedRows > 0 && claim.n !== loggedRows) {
      found.push({ type: 'session_confirm_mismatch', severity: 'warn', detail: `Confirm claims ${claim.n} set(s) but ${loggedRows} log row(s) correlate: "${truncate(c.text, 120)}"` });
    } else if (claim.kind === 'exercises' && loggedExercises > 0 && claim.n !== loggedExercises) {
      found.push({ type: 'session_confirm_mismatch', severity: 'warn', detail: `Confirm claims ${claim.n} exercise(s) but ${loggedExercises} correlate: "${truncate(c.text, 120)}"` });
    } else if (claim.kind === 'complete' && loggedRows === 0) {
      found.push({ type: 'session_confirm_mismatch', severity: 'info', detail: `Confirm/complete message but no correlated log rows: "${truncate(c.text, 120)}"` });
    }
  }

  // 6. Coach not answering a user question — a user question whose next coach
  //    message (before the next user input) is idle-shaped, empty, or absent.
  const timeline = buildQaTimeline(ev);
  for (const q of timeline) {
    if (!q.isQuestion) continue;
    if (q.answer == null) {
      found.push({ type: 'coach_not_answering', severity: 'warn', detail: `No coach reply followed the question: "${truncate(q.text, 120)}"` });
    } else if (IDLE_COACH_RE.test(q.answer)) {
      found.push({ type: 'coach_not_answering', severity: 'warn', detail: `Question got an idle reply. Q: "${truncate(q.text, 90)}" → A: "${truncate(q.answer, 90)}"` });
    }
  }

  return found;
}

// Parse a confirm-style claim out of a coach message. Recognizes "logged 5 sets",
// "3 exercises", "session complete/saved". Returns null when nothing matches.
function parseConfirmClaim(text) {
  const t = String(text || '');
  let m = t.match(/(\d+)\s+sets?\b/i);
  if (m && /log|save|record|confirm|done|complete/i.test(t)) return { kind: 'sets', n: Number(m[1]) };
  m = t.match(/(\d+)\s+exercises?\b/i);
  if (m && /log|save|record|confirm|done|complete/i.test(t)) return { kind: 'exercises', n: Number(m[1]) };
  if (/session\s+(complete|saved|logged|done)|workout\s+(saved|logged|complete)/i.test(t)) return { kind: 'complete', n: null };
  return null;
}

// Interleave user inputs and coach messages by (seq, then time); each question is
// paired with the coach message that follows it before the next user input.
function buildQaTimeline(ev) {
  const items = [];
  for (const u of ev.user_inputs) items.push({ kind: 'user', text: u.text, seq: num(u.seq), at: parseTimestamp(u.at) });
  for (const c of ev.coach_messages) items.push({ kind: 'coach', text: c.text, seq: num(c.seq), at: parseTimestamp(c.at) });
  items.sort((a, b) => cmpSeqTime(a, b));
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].kind !== 'user') continue;
    let answer = null;
    for (let j = i + 1; j < items.length; j += 1) {
      if (items[j].kind === 'user') break;
      if (items[j].kind === 'coach') { answer = items[j].text; break; }
    }
    out.push({ text: items[i].text, isQuestion: isQuestion(items[i].text), answer });
  }
  return out;
}

function cmpSeqTime(a, b) {
  if (a.seq != null && b.seq != null && a.seq !== b.seq) return a.seq - b.seq;
  if (a.at != null && b.at != null && a.at !== b.at) return a.at - b.at;
  return 0;
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ---------------------------------------------------------------------------
// Report assembly + rendering
// ---------------------------------------------------------------------------

function buildReport(corpora, options) {
  const flight = corpora.Flight_Recorder;
  const { sessions, noSession } = groupBySession(flight);
  const sessionEvidence = sessions.map(s => buildSessionEvidence(s, corpora, options));

  const anomalyTotals = {};
  for (const s of sessionEvidence) {
    for (const a of s.anomalies) anomalyTotals[a.type] = (anomalyTotals[a.type] || 0) + 1;
  }
  if (noSession.length) anomalyTotals.missing_session_id = (anomalyTotals.missing_session_id || 0) + 1;

  return {
    generated_at: options.now,
    source: options.source,
    spreadsheet_id: options.spreadsheetId || null,
    window_minutes: options.windowMs / 60000,
    read_only: true,
    disclaimer: 'Read-only evidence extraction. No sheets were modified; no runtime behavior changed; no fixes proposed. Correlation across tabs is heuristic (shadow lanes by time window; logs by workout session_id then date). Anomalies are triage candidates, not confirmed defects.',
    tab_row_counts: options.rowCounts,
    session_count: sessionEvidence.length,
    events_without_session_id: noSession.length,
    anomaly_totals: anomalyTotals,
    sessions: sessionEvidence,
    orphan_flight_events: noSession.slice(0, 50).map(e => ({
      captured_at: e.captured_at, event_type: e.event_type, route: e.route,
      api_endpoint: e.api_endpoint, user_input: truncate(String(e.user_input || ''), 80)
    }))
  };
}

function renderMarkdown(report) {
  const L = [];
  L.push('# Atlas Flight Review — Test Evidence Extract');
  L.push('');
  L.push(`- **Generated:** ${report.generated_at}`);
  L.push(`- **Source:** ${report.source}${report.spreadsheet_id ? ` (\`${report.spreadsheet_id}\`)` : ''}`);
  L.push(`- **Correlation window:** ±${report.window_minutes} min`);
  L.push(`- **Sessions:** ${report.session_count}   **Orphan events (no flight_session_id):** ${report.events_without_session_id}`);
  L.push('');
  L.push(`> ${report.disclaimer}`);
  L.push('');

  L.push('## Tab row counts');
  L.push('');
  L.push('| Tab | Data rows |');
  L.push('| --- | --- |');
  for (const tab of TABS) L.push(`| ${tab} | ${report.tab_row_counts[tab] == null ? '_absent_' : report.tab_row_counts[tab]} |`);
  L.push('');

  L.push('## Anomaly totals');
  L.push('');
  const totals = Object.entries(report.anomaly_totals);
  if (!totals.length) {
    L.push('_No anomalies detected._');
  } else {
    L.push('| Anomaly | Sessions affected |');
    L.push('| --- | --- |');
    for (const [type, n] of totals.sort((a, b) => b[1] - a[1])) L.push(`| ${type} | ${n} |`);
  }
  L.push('');

  for (const s of report.sessions) {
    L.push('---');
    L.push('');
    L.push(`## Session \`${s.flight_session_id}\``);
    L.push('');
    L.push(`- **Window:** ${s.first_at || '?'} → ${s.last_at || '?'}`);
    L.push(`- **Events:** ${s.event_count}  ·  **Routes:** ${s.routes.join(', ') || '—'}`);
    L.push(`- **Workout session ids seen:** ${s.workout_session_ids.map(x => `\`${x}\``).join(', ') || '—'}`);
    L.push('');

    if (s.anomalies.length) {
      L.push('### ⚠️ Anomalies');
      L.push('');
      for (const a of s.anomalies) L.push(`- **[${a.severity}] ${a.type}** — ${a.detail}`);
      L.push('');
    }

    L.push(`### User inputs (${s.user_inputs.length})`);
    for (const u of s.user_inputs) L.push(`- \`${short(u.at)}\` ${u.route ? `(${u.route}) ` : ''}${truncate(u.text, 200)}`);
    if (!s.user_inputs.length) L.push('- _none_');
    L.push('');

    L.push(`### Coach messages (${s.coach_messages.length})`);
    for (const c of s.coach_messages) L.push(`- \`${short(c.at)}\` ${truncate(c.text, 200)}`);
    if (!s.coach_messages.length) L.push('- _none_');
    L.push('');

    L.push(`### API calls (${s.api_calls.length})`);
    if (s.api_calls.length) {
      L.push('| time | type | endpoint | status | latency | error |');
      L.push('| --- | --- | --- | --- | --- | --- |');
      for (const c of s.api_calls) {
        L.push(`| ${short(c.at)} | ${cell(c.event_type)} | ${cell(c.endpoint) || '—'} | ${cell(c.status)} | ${cell(c.latency_ms)} | ${cell(truncate(c.error, 40))} |`);
      }
    } else L.push('- _none_');
    L.push('');

    L.push(`### Workout rows written (${s.workout_rows_written.length})`);
    if (s.workout_rows_written.length) {
      L.push('| match | session_id | exercise | set | weight | reps | rir |');
      L.push('| --- | --- | --- | --- | --- | --- | --- |');
      for (const r of s.workout_rows_written) {
        L.push(`| ${cell(r.match)} | ${cell(r.session_id)} | ${cell(r.exercise)} | ${cell(r.set_number)} | ${cell(r.weight)} | ${cell(r.reps)} | ${cell(r.rir)} |`);
      }
    } else L.push('- _none correlated_');
    L.push('');

    L.push(`### Brain_Shadow near session (${s.brain_shadow_near.length})`);
    for (const b of s.brain_shadow_near) L.push(`- \`${short(b.captured_at)}\` (${b.match}) ${b.route || ''} ${b.lift_code || ''} mode=${b.mode} ok=${b.ok} reason=${b.reason || ''} ${b.decision_type || ''}/${b.status || ''}`);
    if (!s.brain_shadow_near.length) L.push('- _none_');
    L.push('');

    L.push(`### Intent_Shadow near session (${s.intent_shadow_near.length})`);
    for (const i of s.intent_shadow_near) L.push(`- \`${short(i.captured_at)}\` (${i.match}) ${i.intent_type || ''} conf=${i.confidence || ''} ok=${i.ok} — ${truncate(i.message_preview, 80)}`);
    if (!s.intent_shadow_near.length) L.push('- _none_');
    L.push('');

    if (s.bug_markers.length) {
      L.push(`### Bug markers (${s.bug_markers.length})`);
      for (const m of s.bug_markers) L.push(`- \`${short(m.at)}\` ${truncate(m.note, 200) || '(no note)'}`);
      L.push('');
    }

    if (s.bug_reports.length) {
      L.push(`### Bug_Reports (${s.bug_reports.length})`);
      for (const b of s.bug_reports) L.push(`- \`${short(b.created_at)}\` (${b.match}) ${b.bug_id || ''} — ${truncate(b.note, 120)}${b.last_failed_endpoint ? ` [last fail: ${b.last_failed_endpoint}]` : ''}`);
      L.push('');
    }
  }

  if (report.orphan_flight_events.length) {
    L.push('---');
    L.push('');
    L.push(`## Orphan flight events (no flight_session_id) — first ${report.orphan_flight_events.length}`);
    L.push('');
    for (const e of report.orphan_flight_events) L.push(`- \`${short(e.captured_at)}\` ${e.event_type || ''} ${e.route || ''} ${e.api_endpoint || ''} ${e.user_input || ''}`);
    L.push('');
  }

  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function countBy(arr, keyFn) {
  const out = {};
  for (const item of arr) { const k = keyFn(item); if (k == null || k === '') continue; out[k] = (out[k] || 0) + 1; }
  return out;
}
function unique(arr) { return Array.from(new Set(arr)); }
// Truncate for a single-line context (bullets, table cells). Line breaks are
// flattened to a space first so a value with a newline can't split a bullet or a
// table row; the char budget then reflects the visible one-line content.
function truncate(s, n) { const str = String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' '); return str.length > n ? `${str.slice(0, n)}…` : str; }
// Escape a value for a Markdown table cell: `|` breaks column alignment and a
// newline breaks the row, so neutralize both. Cell values come from sheet data
// (endpoints, exercise names, error strings) that can contain either.
function cell(v) { return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' '); }
function short(ts) { const t = parseTimestamp(ts); return t == null ? String(ts || '') : new Date(t).toISOString().replace('T', ' ').slice(0, 19); }

// ---------------------------------------------------------------------------
// IO shell (live Sheets or local backup dir) — kept thin; nothing above touches IO
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { windowMins: DEFAULT_WINDOW_MINS };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'sheet') opts.sheet = val;
    else if (key === 'window-mins') opts.windowMins = Number(val) || DEFAULT_WINDOW_MINS;
    else if (key === 'from-dir') opts.fromDir = val;
    else if (key === 'out') opts.out = val;
  }
  return opts;
}

async function createReadOnlySheetsClient() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      type: 'service_account'
    },
    // READ-ONLY scope: this script cannot write even if it tried. It never uses the
    // write-capable sheets.js helpers.
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function loadFromSheets(spreadsheetId) {
  const sheets = await createReadOnlySheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const present = new Set((meta.data.sheets || []).map(s => String(s.properties.title || '')));
  const raw = {};
  for (const tab of TABS) {
    if (!present.has(tab)) { raw[tab] = null; continue; }
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A:Z` });
    raw[tab] = resp.data.values || [];
    console.log(`Read ${tab}: ${(raw[tab].length)} row(s)`);
  }
  return raw;
}

function loadFromDir(dir) {
  const raw = {};
  for (const tab of TABS) {
    const file = path.join(dir, `${tab}.json`);
    if (!fs.existsSync(file)) { raw[tab] = null; continue; }
    try {
      raw[tab] = JSON.parse(fs.readFileSync(file, 'utf8'));
      console.log(`Read ${tab}: ${raw[tab].length} row(s) (from ${file})`);
    } catch (e) {
      console.warn(`Skipping ${file}: ${e.message}`);
      raw[tab] = null;
    }
  }
  return raw;
}

// Turn the raw per-tab row arrays into parsed record corpora + row counts.
function toCorpora(raw) {
  const corpora = {};
  const rowCounts = {};
  for (const tab of TABS) {
    if (!raw[tab]) { corpora[tab] = []; rowCounts[tab] = null; continue; }
    const records = rowsToRecords(raw[tab], KNOWN_COLUMNS[tab]);
    corpora[tab] = records;
    rowCounts[tab] = records.length;
  }
  return { corpora, rowCounts };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const windowMs = Math.max(0, opts.windowMins) * 60000;
  const now = new Date().toISOString();
  const stamp = now.replace(/[:.]/g, '-');
  const outDir = opts.out || path.join('outputs', 'flight-review');

  let raw;
  let source;
  let spreadsheetId = null;

  if (opts.fromDir) {
    source = `local-dir:${opts.fromDir}`;
    raw = loadFromDir(opts.fromDir);
  } else {
    try { require('dotenv').config(); } catch { /* dotenv optional */ }
    spreadsheetId = opts.sheet || process.env.FLIGHT_REVIEW_SHEET_ID || process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      console.error('Missing live-sheet config. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY, and a sheet id via --sheet / FLIGHT_REVIEW_SHEET_ID / GOOGLE_SHEETS_ID.');
      console.error('Or run offline against a backup export: node scripts/flight-review.js --from-dir=backups/<timestamp>');
      process.exit(1);
    }
    source = 'google-sheets';
    console.log(`Reading (read-only) spreadsheet ${spreadsheetId}`);
    raw = await loadFromSheets(spreadsheetId);
  }

  const { corpora, rowCounts } = toCorpora(raw);
  const report = buildReport(corpora, { now, source, spreadsheetId, windowMs, rowCounts });

  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${stamp}.json`);
  const mdPath = path.join(outDir, `${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(report));

  console.log('');
  console.log(`Sessions: ${report.session_count}  ·  Orphan events: ${report.events_without_session_id}`);
  console.log(`Anomaly totals: ${JSON.stringify(report.anomaly_totals)}`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`flight-review failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  TABS,
  KNOWN_COLUMNS,
  norm,
  canonicalizeHeaderName,
  looksLikeHeader,
  rowsToRecords,
  safeParseJson,
  parseTimestamp,
  extractStatusCode,
  statusClass,
  deepCollectSessionIds,
  extractCoachMessage,
  isQuestion,
  groupBySession,
  routeOverlaps,
  correlateByTime,
  correlateLogs,
  sessionDateSet,
  dateFallbackAmbiguity,
  buildSessionEvidence,
  detectAnomalies,
  parseConfirmClaim,
  buildQaTimeline,
  buildReport,
  renderMarkdown,
  toCorpora
};
