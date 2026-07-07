/* eslint-disable no-implicit-globals -- browser script; top-level function declarations are intentional global exports; converted to ES modules in Phase 1 PR-08/09 */
/* Atlas frontend — read-only views + approve-before-save workout logger.
 * Golden rule: AI/backend can parse, prepare, and preview. The owner approves.
 * Only then does Atlas write. Preview always runs with test_mode=true.
 */

const API_KEY_STORAGE = 'atlas_api_key';

// Shell build tag baked INTO this bundle (mirrors the service-worker cache name in
// public/sw.js). The Settings badge shows it next to the server /version: if the
// server reports a newer build but this tag is stale/absent, the browser is running
// a cached service-worker shell — i.e. a "fix didn't take" is a stale shell, not a
// code bug. Bump this whenever the SW cache version bumps (a test pins them equal).
const ATLAS_SHELL_BUILD = 'v115';
const BUG_REPORT_STORAGE_KEY_RE = /(?:api[_-]?key|authorization|auth|bearer|cookie|credential|jwt|password|private[_-]?key|secret|token)/i;
const BUG_REPORT_SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Z0-9_]*)\s*=\s*["']?[^"',\s]+["']?/g
];
const BUG_REPORT_REDACTED = '[REDACTED]';
const BUG_REPORT_RECENT_API_LIMIT = 20;
// Bug-report diagnostics: so one tap on "Report Bug" captures enough to root-cause
// without the owner typing anything. All of this rides inside the existing Payload JSON
// column (no Bug_Reports schema change) and is bounded + redacted before it leaves.
const BUG_REPORT_ERROR_LIMIT = 12;   // ring buffer of recent errors (api + client JS)
const BUG_REPORT_ACTION_LIMIT = 30;  // ring buffer of UI breadcrumbs (taps, nav)
const BUG_REPORT_BODY_MAX = 1000;    // per-call request/response body cap (chars)
const BUG_REPORT_SIZE_BUDGET = 44000; // keep the whole report under the Sheets per-cell limit
const atlasRecentApiRequests = [];
const atlasRecentErrors = [];        // last N errors, so a cascade shows AS a cascade
const atlasActionLog = [];           // last N UI actions, e.g. "tap restore" → nothing
let atlasLastError = null;
let atlasServerVersion = null;

// Truncated + redacted snapshot of a request/response body. Multipart uploads
// (screenshots) are summarised by field name, never dumped.
function snapshotBugBody(body) {
  if (body == null) return null;
  try {
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const keys = [];
      for (const k of body.keys()) keys.push(k);
      return `[multipart: ${keys.join(', ')}]`;
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const safe = redactBugReportString(text);
    return safe.length > BUG_REPORT_BODY_MAX ? `${safe.slice(0, BUG_REPORT_BODY_MAX)}...[truncated]` : safe;
  } catch {
    return '[unserializable]';
  }
}

// Error/action capture must NEVER throw — diagnostics can't be the thing that breaks logging.
function recordAtlasError(entry) {
  try {
    atlasRecentErrors.push({ at: new Date().toISOString(), ...entry });
    while (atlasRecentErrors.length > BUG_REPORT_ERROR_LIMIT) atlasRecentErrors.shift();
  } catch { /* best-effort */ }
}

function recordAtlasAction(action, detail) {
  try {
    atlasActionLog.push({
      at: new Date().toISOString(),
      action,
      ...(detail ? { detail: String(detail).slice(0, 120) } : {})
    });
    while (atlasActionLog.length > BUG_REPORT_ACTION_LIMIT) atlasActionLog.shift();
  } catch { /* best-effort */ }
}

// Unhandled JS errors / promise rejections never reach api(), so a UI lockup or a silent
// "tapped X, nothing happened" would otherwise leave no trace. Capture them, and leave a
// breadcrumb for every tap (capture phase, so a stopPropagation handler still logs).
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => recordAtlasError({
    source: 'window.onerror',
    message: (e && e.message) || String(e),
    where: e ? [e.filename, e.lineno, e.colno].filter(v => v != null).join(':') || null : null
  }));
  window.addEventListener('unhandledrejection', (e) => recordAtlasError({
    source: 'unhandledrejection',
    message: (e && e.reason && (e.reason.message || String(e.reason))) || 'unhandled rejection'
  }));
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest && e.target.closest('button, .tab, [role="button"], a');
    if (!t) return;
    recordAtlasAction('tap', (t.id || t.getAttribute('aria-label') || t.textContent || '').trim().slice(0, 60));
  }, true);
}

function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

// Transport-level fetch failures surface as cryptic browser strings ("Load failed",
// "Failed to fetch", "The network connection was lost"). When one survives the
// retry above, translate it into an honest, actionable line — the usual cause is
// the server cold-starting after idle (diagnosed live 2026-07-02: first request
// ~36s wall-clock while the instance wakes). Returns null for real HTTP errors so
// the server's own message always wins.
function friendlyTransportMessage(err) {
  if (!err || err.status) return null;
  const m = err.message ? String(err.message) : '';
  if (/load failed|failed to fetch|networkerror|network error|network connection was lost|connection appears to be offline/i.test(m)) {
    return 'the connection dropped — the server was likely waking up. Give it a few seconds and tap Preview again; nothing was saved.';
  }
  return null;
}

async function api(path, options = {}) {
  // Flight Recorder session-linkage headers (additive, and {} unless the recorder is
  // active) so server-side api_response telemetry links to this client session. Never
  // affects request/response semantics or the write path.
  const flightHeaders = (typeof window !== 'undefined' && window.atlasFlightRecorder && typeof window.atlasFlightRecorder.requestHeaders === 'function')
    ? window.atlasFlightRecorder.requestHeaders() : {};
  const headers = { 'x-atlas-api-key': getApiKey(), ...flightHeaders, ...(options.headers || {}) };
  const method = options.method || 'GET';
  const startedAt = Date.now();
  let res = null;
  let json = null;
  try {
    res = await fetch(path, { ...options, headers });
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
    atlasLastError = {
      message: err && err.message ? err.message : String(err),
      status: err && err.status,
      endpoint: path,
      at: new Date().toISOString()
    };
    // Keep a HISTORY, not just the latest: a poison cascade (e.g. one bad set 400ing
    // every save attempt) only makes sense when you can see all of them in order.
    recordAtlasError({
      source: 'api',
      endpoint: path,
      method,
      status: atlasLastError.status,
      message: atlasLastError.message,
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

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function renderTable(headers, rows) {
  const thead = el('thead', {}, el('tr', {}, headers.map(h => el('th', { text: h }))));
  const tbody = el('tbody', {}, rows.map(row =>
    el('tr', {}, row.map(cell => el('td', { text: cell === null || cell === undefined ? '' : String(cell) })))
  ));
  return el('table', {}, [thead, tbody]);
}

function setStatus(container, message, kind) {
  container.innerHTML = '';
  if (message) container.appendChild(el('div', { class: `status-msg ${kind}`, text: message }));
}

// "Session quality: X / 100" with a tappable circled-i that reveals the
// weighted breakdown. Each criterion shows earned / max points and a
// session-specific description (e.g. "14 sets — solid session").
function buildQualityRow(score, breakdown) {
  const wrap = el('div', { class: 'session-quality' });
  wrap.appendChild(el('span', { text: `Session quality: ${score} / 100` }));

  const criteria = Array.isArray(breakdown) ? breakdown : [];
  if (!criteria.length) return wrap;

  const info = el('button', {
    class: 'quality-info-btn',
    type: 'button',
    'aria-label': 'How was this score calculated?',
    'aria-expanded': 'false',
    text: 'i'
  });

  const pop = el('div', { class: 'quality-popover', role: 'dialog', 'aria-label': 'Quality score breakdown' });
  pop.appendChild(el('div', { class: 'quality-popover-title', text: 'How we scored this' }));
  for (const c of criteria) {
    const tier = c.points === c.maxPoints ? 'full' : c.points > 0 ? 'partial' : 'zero';
    pop.appendChild(el('div', { class: `quality-criterion ${tier}` }, [
      el('span', { class: 'quality-criterion-label', text: c.label }),
      el('span', { class: 'quality-criterion-pts', text: `${c.points} / ${c.maxPoints}` }),
      el('span', { class: 'quality-criterion-desc', text: c.description || '' })
    ]));
  }

  const anchor = el('span', { class: 'quality-info-anchor' }, [info, pop]);

  let open = false;
  function close() {
    if (!open) return;
    open = false;
    anchor.classList.remove('open');
    info.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeydown, true);
  }
  function onDocClick(e) {
    if (!anchor.contains(e.target)) close();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }
  info.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open) { close(); return; }
    open = true;
    anchor.classList.add('open');
    info.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeydown, true);
  });

  wrap.appendChild(anchor);
  return wrap;
}

/* ===== Inline SVG charts (no dependencies) ===== */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function svgLineChart(points, { width = 420, height = 140, color = '#2563eb', label = '' } = {}) {
  // points: [{ x: label, y: number }]
  const pad = { top: 12, right: 12, bottom: 24, left: 44 };
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': label });
  const ys = points.map(p => p.y).filter(Number.isFinite);
  if (points.length < 2 || !ys.length) {
    return el('p', { class: 'muted', text: 'Not enough data to chart.' });
  }

  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const ySpan = yMax - yMin || 1;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xStep = plotW / (points.length - 1);
  const toX = i => pad.left + i * xStep;
  const toY = v => pad.top + plotH - ((v - yMin) / ySpan) * plotH;

  // y-axis min/max labels and gridlines
  for (const v of [yMin, yMax]) {
    const y = toY(v);
    svg.appendChild(svgEl('line', { x1: pad.left, y1: y, x2: width - pad.right, y2: y, stroke: '#dbe2ea', 'stroke-width': 1 }));
    const text = svgEl('text', { x: pad.left - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#66788d' });
    text.textContent = String(Math.round(v));
    svg.appendChild(text);
  }

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(p.y).toFixed(1)}`).join(' ');
  svg.appendChild(svgEl('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2 }));
  points.forEach((p, i) => {
    svg.appendChild(svgEl('circle', { cx: toX(i), cy: toY(p.y), r: 3, fill: color }));
  });

  // first/last x labels
  const firstLabel = svgEl('text', { x: pad.left, y: height - 8, 'font-size': 10, fill: '#66788d' });
  firstLabel.textContent = points[0].x;
  const lastLabel = svgEl('text', { x: width - pad.right, y: height - 8, 'text-anchor': 'end', 'font-size': 10, fill: '#66788d' });
  lastLabel.textContent = points[points.length - 1].x;
  svg.appendChild(firstLabel);
  svg.appendChild(lastLabel);
  return svg;
}

function svgBarChart(entries, { width = 420, barHeight = 20, gap = 6, color = '#2563eb', label = '' } = {}) {
  // entries: [{ name, value }]
  if (!entries.length) return el('p', { class: 'muted', text: 'No data to chart.' });
  const labelW = 110;
  const valueW = 56;
  const maxValue = Math.max(...entries.map(e => e.value)) || 1;
  const plotW = width - labelW - valueW;
  const height = entries.length * (barHeight + gap);
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': label });

  entries.forEach((entry, i) => {
    const y = i * (barHeight + gap);
    const name = svgEl('text', { x: labelW - 8, y: y + barHeight * 0.7, 'text-anchor': 'end', 'font-size': 11, fill: '#1c2733' });
    name.textContent = entry.name;
    svg.appendChild(name);
    svg.appendChild(svgEl('rect', {
      x: labelW, y, height: barHeight,
      width: Math.max(2, (entry.value / maxValue) * plotW),
      fill: color, rx: 3
    }));
    const value = svgEl('text', { x: labelW + Math.max(2, (entry.value / maxValue) * plotW) + 6, y: y + barHeight * 0.7, 'font-size': 11, fill: '#66788d' });
    value.textContent = String(Math.round(entry.value));
    svg.appendChild(value);
  });

  return svg;
}

/* ===== Exercise catalog datalist (typeahead) ===== */

async function loadExerciseDatalist() {
  if (!getApiKey()) return;
  try {
    const res = await api('/api/catalog/exercises');
    const exercises = (res.data?.exercises || []);
    if (!exercises.length) return;
    let dl = document.getElementById('exercise-catalog');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'exercise-catalog';
      document.body.appendChild(dl);
    }
    dl.innerHTML = '';
    // Canonical names AND catalog variants ("RDL", "Squat") both land in the
    // datalist, each labeled with the lift code — so liftCodeFromCatalog can
    // bridge a logged alias to its code CLIENT-SIDE (owner live find
    // 2026-07-03: "Rdl" logged against a chat-created plan could not reach
    // "Romanian Deadlift", so the plan never advanced). Dedup by lowercase
    // value; canonical first so it wins any collision.
    const seenNames = new Set();
    for (const ex of exercises) {
      for (const name of [ex.canonical_name, ...(Array.isArray(ex.variants) ? ex.variants : [])]) {
        const key = String(name || '').toLowerCase();
        if (!key || seenNames.has(key)) continue;
        seenNames.add(key);
        const opt = document.createElement('option');
        opt.value = name;
        if (ex.lift_code) opt.label = ex.lift_code;
        dl.appendChild(opt);
      }
    }
  } catch {
    // typeahead is optional enhancement — fail silently
  }
}

/* ===== Tabs ===== */

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'dashboard') loadDashboard();
    if (btn.dataset.tab === 'body') loadBodyTab();
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'progress') loadProgressLiftList();
    if (btn.dataset.tab === 'settings') loadPendingExercises();
  });
});

/* ===== History tab ===== */

// 'YYYY-MM-DD' → "Today" / "Yesterday" / "Mon, Jun 9", parsed in local time.
// eslint-disable-next-line no-unused-vars -- global export; consumed by other browser scripts or inline HTML; Phase 1 PR-08/09
function formatSessionDate(dateStr) {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return dateStr || '';
  const dt = new Date(parts[0], parts[1] - 1, parts[2]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - dt) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// "20260613-AM-01" → "AM" / "PM" / ''.
function sessionTimeTag(sessionId) {
  const m = String(sessionId || '').match(/-(AM|PM)\b/i);
  return m ? m[1].toUpperCase() : '';
}

function summarizeExercises(exercises, max = 3) {
  const ex = (exercises || []).filter(Boolean);
  if (!ex.length) return 'No exercises recorded';
  if (ex.length <= max) return ex.join(', ');
  return `${ex.slice(0, max).join(', ')} +${ex.length - max} more`;
}

const HIST_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HIST_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseLocalDate(dateStr) {
  return new Date(`${dateStr}T00:00:00`);
}

// Monday-start week containing `date`, as a local midnight Date.
function mondayStart(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

// "Fri, Jun 12 · PM" — weekday + date, with the AM/PM tag from the session id.
function sessionWhenLabel(s) {
  const d = parseLocalDate(s.date || '');
  const tag = sessionTimeTag(s.session_id);
  const base = (s.date && !Number.isNaN(d.getTime()))
    ? `${HIST_WD[d.getDay()]}, ${HIST_MON[d.getMonth()]} ${d.getDate()}`
    : (s.date || '');
  return tag ? `${base} · ${tag}` : base;
}

function weekRangeLabel(weekStart) {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  if (weekStart.getMonth() === end.getMonth()) {
    return `${HIST_MON[weekStart.getMonth()]} ${weekStart.getDate()}–${end.getDate()}`;
  }
  return `${HIST_MON[weekStart.getMonth()]} ${weekStart.getDate()} – ${HIST_MON[end.getMonth()]} ${end.getDate()}`;
}

function weekHeaderLabel(weekStart, currentWeekStart) {
  const diff = Math.round((currentWeekStart.getTime() - weekStart.getTime()) / (7 * 86400000));
  if (diff <= 0) return 'This week';
  if (diff === 1) return 'Last week';
  return weekRangeLabel(weekStart);
}

// One clean, tappable session card: when + stats on top, exercises beneath.
// Full set/effort detail lazy-loads on first expand (unchanged).
function renderSessionCard(s) {
  const details = el('details', { class: 'session-item' });
  const sum = el('summary', { class: 'session-summary' }, [
    el('div', { class: 'session-head' }, [
      el('span', { class: 'session-when', text: sessionWhenLabel(s) }),
      el('span', { class: 'session-stats', text: `${s.sets_count} sets · ${Number(s.total_volume || 0).toLocaleString()} lb` })
    ]),
    el('div', { class: 'session-exercises', text: summarizeExercises(s.exercises) })
  ]);
  details.appendChild(sum);

  // Effort + per-set detail both render inside the expanded detail slot (below),
  // so the card itself stays to two clean lines.
  const detailSlot = el('div', { class: 'session-detail-slot' });
  details.appendChild(detailSlot);
  let detailLoaded = false;
  details.addEventListener('toggle', () => {
    if (!details.open || detailLoaded) return;
    detailLoaded = true;
    loadSessionDetail(s.session_id, detailSlot);
  });
  return details;
}

// Cadence strip — sessions per week over the recent window, current week ember.
function renderCadenceStrip(summary) {
  const byWeek = Array.isArray(summary && summary.sessions_by_week) ? summary.sessions_by_week.slice(-8) : [];
  if (!byWeek.length) return null;
  const avg = summary.average_sessions_per_week != null
    ? Math.round(summary.average_sessions_per_week)
    : Math.round(byWeek.reduce((a, w) => a + (Number(w.sessions) || 0), 0) / byWeek.length);
  const max = Math.max(1, ...byWeek.map(w => Number(w.sessions) || 0));

  const bars = el('div', { class: 'cadence-bars' });
  byWeek.forEach((w, i) => {
    const bar = el('i', { class: i === byWeek.length - 1 ? 'cadence-bar cur' : 'cadence-bar' });
    bar.style.height = `${Math.max(8, Math.round(((Number(w.sessions) || 0) / max) * 100))}%`;
    bars.appendChild(bar);
  });

  return el('div', { class: 'cadence' }, [
    el('div', { class: 'cadence-top' }, [
      el('div', { class: 'cadence-big' }, [document.createTextNode(`${avg}×`), el('small', { text: '/ week' })]),
      el('div', { class: 'cadence-sub', text: `LAST ${byWeek.length} WEEKS` })
    ]),
    bars
  ]);
}

async function loadSessions() {
  const result = document.getElementById('sessions-result');
  result.textContent = 'Loading…';
  try {
    const [sessRes, sumRes] = await Promise.allSettled([
      api('/api/sessions/recent'),
      api('/api/progress/summary')
    ]);
    const sessions = (sessRes.status === 'fulfilled' && sessRes.value && sessRes.value.data && sessRes.value.data.sessions) || [];
    const summary = (sumRes.status === 'fulfilled' && sumRes.value && (sumRes.value.data || sumRes.value)) || {};

    // Drop phantom 0-set rows — logging artifacts, not real sessions.
    const real = sessions.filter(s => Number(s.sets_count) > 0);

    result.innerHTML = '';
    const cadence = renderCadenceStrip(summary);
    if (cadence) result.appendChild(cadence);

    if (!real.length) {
      result.appendChild(el('p', { class: 'muted', text: 'No sessions logged yet.' }));
      return;
    }

    // Group by Monday-week with per-week totals; most-recent week first.
    const currentWeekStart = mondayStart(new Date());
    const groupMap = new Map();
    const groups = [];
    for (const s of real) {
      const ws = mondayStart(parseLocalDate(s.date || getLocalDateString()));
      const key = ws.getTime();
      let g = groupMap.get(key);
      if (!g) { g = { weekStart: ws, sessions: [], volume: 0 }; groupMap.set(key, g); groups.push(g); }
      g.sessions.push(s);
      g.volume += Number(s.total_volume || 0);
    }
    groups.sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime());

    for (const g of groups) {
      result.appendChild(el('div', { class: 'session-week-header' }, [
        el('h2', { text: weekHeaderLabel(g.weekStart, currentWeekStart) }),
        el('span', { class: 'week-tot', text: `${g.sessions.length} session${g.sessions.length === 1 ? '' : 's'} · ${Math.round(g.volume).toLocaleString()} lb` })
      ]));
      for (const s of g.sessions) result.appendChild(renderSessionCard(s));
    }
  } catch (err) {
    result.textContent = err.message || 'Failed to load sessions.';
  }
}

async function loadSessionDetail(sessionId, slot) {
  slot.innerHTML = '<span class="muted">Loading…</span>';
  try {
    const res = await api(`/api/session/${encodeURIComponent(sessionId)}/summary`);
    const d = res.data || {};
    slot.innerHTML = '';

    // Exactly what was logged, grouped by exercise — each set on its own line in
    // the same "weight × reps @rir" shorthand the coach uses, instead of a
    // cramped 6-column table.
    const sets = d.sets || d.rows || [];
    if (sets.length) {
      const order = [];
      const byExercise = new Map();
      for (const r of sets) {
        const name = r.exercise || r.canonical_exercise || 'Exercise';
        if (!byExercise.has(name)) { byExercise.set(name, []); order.push(name); }
        byExercise.get(name).push(r);
      }
      for (const name of order) {
        const exSets = byExercise.get(name);
        const vol = exSets.reduce((sum, r) => sum + (Number(r.volume) || (Number(r.weight) || 0) * (Number(r.reps) || 0)), 0);
        const block = el('div', { class: 'session-ex' });
        block.appendChild(el('div', { class: 'session-ex-head' }, [
          el('span', { class: 'session-ex-name', text: name }),
          el('span', { class: 'session-ex-vol', text: `${exSets.length} ${exSets.length === 1 ? 'set' : 'sets'} · ${Math.round(vol).toLocaleString()} lb` })
        ]));
        for (const r of exSets) {
          const rir = (r.rir === '' || r.rir == null) ? '' : ` @${r.rir}`;
          const note = r.notes ? ` · ${r.notes}` : '';
          block.appendChild(el('div', { class: 'session-ex-set', text: `${formatSetLoad(r.weight, r.reps)}${rir}${note}` }));
        }
        slot.appendChild(block);
      }
    } else {
      slot.appendChild(el('p', { class: 'muted', text: 'No set detail recorded for this session.' }));
    }

    if (d.effort) {
      const e = d.effort;
      const parts = [
        e.duration,
        e.active_calories != null && `${e.active_calories} active cal`,
        e.average_hr != null && `avg HR ${e.average_hr}`,
        e.peak_hr != null && `peak HR ${e.peak_hr}`
      ].filter(Boolean);
      if (parts.length) slot.appendChild(el('div', { class: 'session-effort-detail', text: parts.join(' · ') }));
    }

    if (d.quality_score != null) {
      slot.appendChild(buildQualityRow(d.quality_score, d.quality_breakdown));
    }
  } catch (err) {
    slot.textContent = '';
    slot.appendChild(el('span', { class: 'muted', text: `Could not load detail: ${err.message}` }));
  }
}

let historyLoaded = false;
function loadHistory() {
  if (historyLoaded) return;
  historyLoaded = true;
  loadSessions();
}

// The list auto-loads on first History visit (loadHistory above). nav.js calls
// this to force a fresh fetch when jumping here from a chat reply.
window.atlasRefreshSessions = () => {
  historyLoaded = true;
  loadSessions();
};

/* ===== Connection check ===== */

async function checkConnection() {
  const status = document.getElementById('conn-status');
  try {
    await fetch('/health').then(r => { if (!r.ok) throw new Error(); });
    status.classList.add('ok');
    status.classList.remove('fail');
    status.title = 'Backend reachable';
  } catch {
    status.classList.add('fail');
    status.classList.remove('ok');
    status.title = 'Backend unreachable';
  }
}

/* ===== Settings ===== */

document.getElementById('settings-form').addEventListener('submit', e => {
  e.preventDefault();
  const key = document.getElementById('api-key-input').value.trim();
  const statusBox = document.getElementById('settings-status');
  if (!key) {
    setStatus(statusBox, 'Enter an API key first.', 'error');
    return;
  }
  localStorage.setItem(API_KEY_STORAGE, key);
  document.getElementById('api-key-input').value = '';
  setStatus(statusBox, 'API key saved to this browser.', 'ok');
  loadDashboard();
  loadCoachPlan();
  loadWeeklyCoach();
});

document.getElementById('clear-key-btn').addEventListener('click', () => {
  localStorage.removeItem(API_KEY_STORAGE);
  setStatus(document.getElementById('settings-status'), 'API key cleared.', 'ok');
});

/* ===== Backend health / debug ===== */

function setBoxSpan(box, className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  box.replaceChildren(span);
}

async function runHealthCheck(endpoint, label, resultBox) {
  setBoxSpan(resultBox, 'muted', `Checking ${label}…`);
  try {
    const res = await api(endpoint);
    const data = res.data || res;
    const status = data.status || (res.status === 'ok' ? 'ok' : 'unknown');
    const ok = ['ok', 'connected', 'healthy'].includes(String(status).toLowerCase());
    const msg = data.message || data.detail || JSON.stringify(data);
    setBoxSpan(resultBox, ok ? 'status-ok' : 'status-warn', `${label}: ${msg || status}`);
  } catch (err) {
    setBoxSpan(resultBox, 'status-error', `${label}: ${err.message}`);
  }
}

document.getElementById('check-sheets-btn')?.addEventListener('click', () => {
  runHealthCheck('/api/health/sheets', 'Google Sheets', document.getElementById('health-result'));
});

document.getElementById('check-openai-btn')?.addEventListener('click', () => {
  runHealthCheck('/api/health/openai', 'OpenAI', document.getElementById('health-result'));
});

document.getElementById('load-version-btn')?.addEventListener('click', async () => {
  const box = document.getElementById('debug-result');
  setBoxSpan(box, 'muted', 'Loading…');
  try {
    const res = await fetch('/version');
    const data = await res.json().catch(() => null);
    const pre = document.createElement('pre');
    pre.className = 'debug-pre';
    pre.textContent = JSON.stringify(data, null, 2);
    box.replaceChildren(pre);
  } catch (err) {
    setBoxSpan(box, 'muted', `Could not load: ${err.message}`);
  }
});

// Diagnostic: probe the coach LLM (Gemini) so a "Coach is unavailable" / robotic
// templated reply can be explained — shows configured/model/ok and the exact reason
// (missing key, 401/403 bad key, 404 bad model, 429 quota, timeout). Read-only.
document.getElementById('test-coach-btn')?.addEventListener('click', async () => {
  const box = document.getElementById('debug-result');
  setBoxSpan(box, 'muted', 'Testing coach connection…');
  try {
    const res = await api('/api/coach/health');
    const d = (res && res.data) || {};
    const pre = document.createElement('pre');
    pre.className = 'debug-pre';
    pre.textContent = [
      `configured: ${d.configured}`,
      `model:      ${d.model}`,
      `ok:         ${d.ok}`,
      d.ok ? 'The coach LLM is reachable — replies should be intelligent, not templated.' : `reason:     ${d.reason || 'unknown'}`,
    ].join('\n');
    box.replaceChildren(pre);
  } catch (err) {
    setBoxSpan(box, 'muted', `Could not run coach test: ${err.message}`);
  }
});

// Diagnostic: dump the LIVE in-session plan/completion state — so a wrong "next up"
// or a stale composer placeholder can be diagnosed from the actual runtime values
// (sessionCompleted, remaining, nextPlanned), which the static code can't always
// explain after a mid-session swap. Read-only; no writes, no effect on the workout.
// Tap it right after a wrong handoff and screenshot it.
document.getElementById('load-session-state-btn')?.addEventListener('click', () => {
  const box = document.getElementById('debug-result');
  try {
    const liteEx = arr => (Array.isArray(arr) ? arr.map(e => ({
      name: e.canonicalName || e.canonical_exercise || e.name || e.exercise || '',
      liftCode: e.liftCode || e.lift_code || ''
    })) : []);
    const recommended = ((lastIntentData && lastIntentData.intents) || []).find(i => i.recommended);
    const state = {
      shell: ATLAS_SHELL_BUILD,
      activePlannedSession: activePlannedSession
        ? { index: activePlannedSession.index, exercises: liteEx(activePlannedSession.exercises) }
        : null,
      suggestedPlan: recommended ? liteEx(recommended.exercises) : null,
      plannedExerciseOrder: plannedExerciseOrder(),
      sessionCompleted: [...sessionCompleted],
      remainingPlannedExercises: remainingPlannedExercises(),
      firstUnloggedPlannedLift: firstUnloggedPlannedLift()
    };
    const pre = document.createElement('pre');
    pre.className = 'debug-pre';
    pre.textContent = JSON.stringify(state, null, 2);
    box.replaceChildren(pre);
  } catch (err) {
    setBoxSpan(box, 'muted', `Could not read session state: ${err.message}`);
  }
});

// Glanceable build badge in Settings: always-visible deployed commit + boot time,
// so "is the live app current?" is a glance, not a Debug-JSON dig. /version is
// public (no auth), so a plain fetch works; failures degrade quietly.
(async function populateBuildInfo() {
  // The running-shell tag is baked into THIS bundle — set it first and
  // unconditionally (its own prominent line) so it shows even if /version is
  // unreachable. This is the truth about which JS is actually loaded; the server
  // build line below can read "current" while the browser runs a cached shell.
  const shellEl = document.getElementById('shell-version');
  if (shellEl) shellEl.textContent = ATLAS_SHELL_BUILD;
  const el = document.getElementById('build-version');
  if (!el) return;
  try {
    const res = await fetch('/version');
    const body = await res.json().catch(() => null);
    const v = (body && body.data) || body || {};
    atlasServerVersion = v;
    const raw = String(v.version || 'unknown');
    const short = /^[0-9a-f]{7,40}(-dirty)?$/i.test(raw) ? raw.slice(0, 7) : raw;
    // Lead with the PR number when the build captured it — "PR #461" is something
    // you can compare to the last PR merged; the SHA stays for precision.
    const id = (v.pr != null) ? `PR #${v.pr} · ${short}` : short;
    let when = '';
    if (v.deployed_at) {
      const d = new Date(v.deployed_at);
      if (!Number.isNaN(d.getTime())) when = `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
    }
    el.textContent = when ? `${id} · deployed ${when}` : id;
  } catch (_) {
    el.textContent = 'unavailable';
  }
})();

document.getElementById('load-debug-config-btn')?.addEventListener('click', async () => {
  const box = document.getElementById('debug-result');
  setBoxSpan(box, 'muted', 'Loading…');
  try {
    const res = await api('/api/debug/config');
    const pre = document.createElement('pre');
    pre.className = 'debug-pre';
    pre.textContent = JSON.stringify(res.data || res, null, 2);
    box.replaceChildren(pre);
  } catch (err) {
    setBoxSpan(box, 'muted', `Could not load: ${err.message}`);
  }
});

// Diagnostic: verify the hybrid coaching engine end-to-end from the app. Calls the
// read-only recommendation endpoint for a fixed lift (BEN01) and dumps the raw JSON,
// so you can confirm at a glance that `recommendation.brian` is attached (proving
// ATLAS_COACH_ENGINE=hybrid is live) while the existing `next_target` still appears.
// Read-only: same endpoint the app already uses; no writes, no trust-loop touch.
document.getElementById('test-brian-btn')?.addEventListener('click', async () => {
  const box = document.getElementById('debug-result');
  setBoxSpan(box, 'muted', 'Testing Brian (BEN01)…');
  try {
    const res = await api('/api/recommend/next/BEN01');
    const pre = document.createElement('pre');
    pre.className = 'debug-pre';
    pre.textContent = JSON.stringify(res.data || res, null, 2);
    box.replaceChildren(pre);
  } catch (err) {
    setBoxSpan(box, 'muted', `Could not run Brian test: ${err.message}`);
  }
});

/* ===== Hybrid Coach Compare v1 (dev-only) =====
 * Developer-only evaluation UI: fetches one lift's /api/recommend/next response and,
 * only when hybridCompare.shouldShowCompareCard() confirms hybrid mode + a validated
 * Brian decision, renders Legacy vs Brian side by side with a preference button row.
 * Read-only — the fetch is the same production endpoint; a preference selection only
 * appends a feedback entry to localStorage (services/pure helpers in hybridCompare.js).
 * No write path, no trust-loop, no effect on the recommendation itself. */

let hybridCompareState = null;

function renderHybridCompareSummary(container, summary) {
  const lines = Object.entries(summary || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => el('p', { text: `${k}: ${v}` }));
  container.replaceChildren(...(lines.length ? lines : [el('p', { class: 'muted', text: 'No data' })]));
}

document.getElementById('hybrid-compare-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const liftCode = (document.getElementById('hybrid-compare-liftcode').value || '').trim();
  const statusEl = document.getElementById('hybrid-compare-status');
  const cardEl = document.getElementById('hybrid-compare-card');
  const savedEl = document.getElementById('hybrid-compare-saved');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  cardEl.hidden = true;
  savedEl.textContent = '';
  hybridCompareState = null;
  if (!liftCode) {
    setBoxSpan(statusEl, 'muted', 'Enter a lift code.');
    return;
  }
  setBoxSpan(statusEl, 'muted', `Comparing ${liftCode}…`);
  // Disabled for the duration of the fetch so a second Compare click can't
  // race this one — without this, a slower response for an earlier lift code
  // could resolve after a later one and silently overwrite its result.
  if (submitBtn) submitBtn.disabled = true;
  try {
    const recRes = await api(`/api/recommend/next/${encodeURIComponent(liftCode)}`);
    const recommendation = recRes.data || recRes;
    if (!window.hybridCompare.shouldShowCompareCard(recommendation)) {
      setBoxSpan(statusEl, 'muted', `Not available — no validated Brian decision was attached for ${liftCode} (requires ATLAS_COACH_ENGINE=hybrid; see "Show config" above).`);
      return;
    }
    hybridCompareState = { liftCode, recommendation };
    renderHybridCompareSummary(document.getElementById('hybrid-compare-legacy'), window.hybridCompare.summarizeLegacy(recommendation));
    renderHybridCompareSummary(document.getElementById('hybrid-compare-brian'), window.hybridCompare.summarizeBrian(recommendation));
    setBoxSpan(statusEl, 'status-ok', `Comparing ${liftCode} — hybrid mode confirmed.`);
    cardEl.hidden = false;
  } catch (err) {
    setBoxSpan(statusEl, 'status-error', `Could not compare: ${err.message}`);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

function saveHybridComparePreference(preference) {
  const savedEl = document.getElementById('hybrid-compare-saved');
  if (!hybridCompareState) {
    setBoxSpan(savedEl, 'muted', 'Run Compare first.');
    return;
  }
  try {
    const noteEl = document.getElementById('hybrid-compare-note');
    const entry = window.hybridCompare.buildComparisonEntry({
      timestamp: new Date().toISOString(),
      liftCode: hybridCompareState.liftCode,
      preference,
      note: noteEl ? noteEl.value : '',
      recommendation: hybridCompareState.recommendation
    });
    const list = window.hybridCompare.saveComparisonEntry(localStorage, entry);
    setBoxSpan(savedEl, 'status-ok', `Saved: ${preference} (${hybridCompareState.liftCode}) — ${list.length} saved locally.`);
  } catch (err) {
    setBoxSpan(savedEl, 'status-error', `Could not save: ${err.message}`);
  }
}

document.getElementById('hybrid-compare-prefer-legacy')?.addEventListener('click', () => saveHybridComparePreference('legacy'));
document.getElementById('hybrid-compare-prefer-brian')?.addEventListener('click', () => saveHybridComparePreference('brian'));
document.getElementById('hybrid-compare-prefer-neither')?.addEventListener('click', () => saveHybridComparePreference('neither'));

function bugReportId(now = new Date()) {
  const stamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-');
  return `BUG-${stamp}`;
}

function redactBugReportString(value) {
  let out = value;
  for (const pattern of BUG_REPORT_SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (match, keyName) => {
      if (typeof keyName === 'string' && keyName) return `${keyName}=${BUG_REPORT_REDACTED}`;
      return BUG_REPORT_REDACTED;
    });
  }
  return out;
}

function redactBugReportValue(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') {
    const safeValue = redactBugReportString(value);
    return safeValue.length > 12000 ? `${safeValue.slice(0, 12000)}...[truncated]` : safeValue;
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactBugReportValue(item, seen));
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key] = BUG_REPORT_STORAGE_KEY_RE.test(key) ? BUG_REPORT_REDACTED : redactBugReportValue(raw, seen);
  }
  return out;
}

function collectAtlasStorage(storage) {
  const out = {};
  if (!storage) return out;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !/^atlas/i.test(key)) continue;
      out[key] = BUG_REPORT_STORAGE_KEY_RE.test(key) ? BUG_REPORT_REDACTED : storage.getItem(key);
    }
  } catch (err) {
    out.storage_error = err.message;
  }
  return out;
}

// Bodyweight sets (weight null/''/0) read as reps, never "0×N" — one rule for
// every renderer of LOGGED set data in this file (owner live find 2026-07-03;
// coach-conversation.js and nav.js carry their own copies inside their IIFEs).
// Engine TARGETS keep their own rendering — this is for history only.
function formatSetLoad(weight, reps, sep = ' × ') {
  const loaded = weight != null && weight !== '' && Number(weight) !== 0;
  return loaded ? `${weight}${sep}${reps}` : `${reps} reps`;
}

function currentRouteForBugReport() {
  const activeSurface = document.body.getAttribute('data-surface') || null;
  const activeTab = document.querySelector('.tab.active')?.id || null;
  return [location.pathname + location.search + location.hash, activeSurface, activeTab].filter(Boolean).join(' | ');
}

function visibleMessagesForBugReport() {
  return Array.from(document.querySelectorAll('#thread-messages .chat-bubble'))
    .slice(-6)
    .map(node => ({
      role: node.classList.contains('chat-bubble-user') ? 'user' : 'assistant',
      text: node.textContent.trim().slice(0, 2000)
    }));
}

function pendingRowsForBugReport() {
  const rows = [];
  for (const tr of Array.from(setsTableBody?.children || [])) {
    rows.push({
      exercise: tr.querySelector('.set-exercise')?.value || '',
      set_number: tr.querySelector('.set-number')?.value || '',
      weight: tr.querySelector('.set-weight')?.value || '',
      reps: tr.querySelector('.set-reps')?.value || '',
      rir: tr.querySelector('.set-rir')?.value || '',
      notes: tr.querySelector('.set-notes')?.value || ''
    });
  }
  return rows;
}

function currentSheetForBugReport() {
  return {
    session_id: document.getElementById('log-session-id')?.value || pendingWrite?.sessionId || pendingWrite?.payload?.session_id || '',
    date: document.getElementById('log-date')?.value || pendingWrite?.date || pendingWrite?.payload?.date || ''
  };
}

// Disabled/hidden state of the controls behind the trust-loop bugs: "Save greyed out"
// and "composer won't let me type" are ABOUT a stuck state — capture it directly instead
// of inferring it from pending_write.
function uiStateForBugReport() {
  const prop = (id, name) => {
    const node = document.getElementById(id);
    return node ? !!node[name] : null;
  };
  return {
    composer_disabled: prop('workout-text', 'disabled'),
    preview_btn_disabled: prop('preview-btn', 'disabled'),
    approve_btn_disabled: prop('approve-btn', 'disabled'),
    parsed_rows_hidden: prop('parsed-rows-editor', 'hidden'),
    preview_panel_hidden: prop('preview-panel', 'hidden'),
    resume_notice_hidden: prop('session-resume-notice', 'hidden')
  };
}

// Service-worker / cache state — "a fix didn't take" is usually a stale shell, not a code
// bug. A waiting SW or an old cache key makes that diagnosable in one glance. Async, so
// it's merged in by the async save path rather than the sync payload builder.
async function serviceWorkerStateForBugReport() {
  const out = { supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator };
  try {
    if (navigator.serviceWorker) {
      out.controller = !!navigator.serviceWorker.controller;
      const reg = navigator.serviceWorker.getRegistration ? await navigator.serviceWorker.getRegistration() : null;
      if (reg) {
        out.active = !!reg.active;
        out.waiting = !!reg.waiting;       // update downloaded but not yet applied = stale shell
        out.installing = !!reg.installing;
      }
    }
    if (typeof caches !== 'undefined' && caches.keys) {
      out.cache_keys = (await caches.keys()).filter(k => /atlas/i.test(k));
    }
  } catch (err) {
    out.error = err && err.message ? err.message : String(err);
  }
  return out;
}

function buildAtlasBugReportPayload(note, options = {}) {
  const now = options.now || new Date();
  const payload = {
    bug_id: options.bugId || bugReportId(now),
    timestamp: now.toISOString(),
    note: note || '',
    route: currentRouteForBugReport(),
    composer_text: workoutTextInput?.value || '',
    visible_messages: visibleMessagesForBugReport(),
    active_session_object: typeof getCanonicalSession === 'function' ? getCanonicalSession() : null,
    active_planned_session: activePlannedSession || null,
    pending_exercises: pendingRowsForBugReport(),
    parsed_rows: pendingRowsForBugReport(),
    pending_preview: previewContent ? previewContent.textContent.trim().slice(0, 4000) : '',
    pending_write: pendingWrite || null,
    write_id: pendingWrite?.writeId || pendingWrite?.payload?.write_id || '',
    last_error: atlasLastError,
    recent_errors: atlasRecentErrors.slice(-BUG_REPORT_ERROR_LIMIT),
    action_log: atlasActionLog.slice(-BUG_REPORT_ACTION_LIMIT),
    ui_state: uiStateForBugReport(),
    current_sheet: currentSheetForBugReport(),
    storage: {
      localStorage: collectAtlasStorage(window.localStorage),
      sessionStorage: collectAtlasStorage(window.sessionStorage)
    },
    app_version: {
      shell: ATLAS_SHELL_BUILD,
      version: atlasServerVersion?.version || null,
      deployed_at: atlasServerVersion?.deployed_at || null,
      pr: atlasServerVersion?.pr || null,
      git_sha: atlasServerVersion?.version || null,
      build_timestamp: atlasServerVersion?.deployed_at || null
    },
    browser: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      online: navigator.onLine,
      // The server only sees UTC; the session-id / date bugs (AM/PM boundary) are
      // local-clock-sensitive, so capture the device clock and connection quality.
      local_time: now.toString(),
      timezone_offset_min: now.getTimezoneOffset(),
      timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })(),
      connection: (navigator.connection && {
        effective_type: navigator.connection.effectiveType || null,
        downlink: navigator.connection.downlink ?? null,
        rtt: navigator.connection.rtt ?? null
      }) || null
    },
    recent_api_requests: atlasRecentApiRequests.slice(-BUG_REPORT_RECENT_API_LIMIT).map(r => ({ ...r }))
  };
  // The report rides in one Google Sheets cell (~50k char limit). Request/response bodies
  // are the elastic part, so if we're over budget shed them oldest-first until we fit —
  // the notes, errors, session state, and breadcrumbs (the diagnosis) always survive.
  let trim = 0;
  while (JSON.stringify(payload).length > BUG_REPORT_SIZE_BUDGET && trim < payload.recent_api_requests.length) {
    delete payload.recent_api_requests[trim].request_body;
    delete payload.recent_api_requests[trim].response_body;
    trim += 1;
  }
  return redactBugReportValue(payload);
}

async function exposeBugReportJson(payload, targetBox) {
  const json = JSON.stringify(payload, null, 2);
  try { await navigator.clipboard?.writeText(json); } catch { /* clipboard unavailable */ }
  const pre = document.createElement('pre');
  pre.className = 'debug-pre';
  pre.textContent = json;
  if (targetBox) targetBox.appendChild(pre);
}

async function saveAtlasBugReport(note, options = {}) {
  const payload = buildAtlasBugReportPayload(note, options);
  // Service-worker / cache state is async, so it's merged after the sync build. Values are
  // booleans + cache names (no secrets), so they're safe to attach post-redaction.
  try { payload.service_worker = await serviceWorkerStateForBugReport(); } catch { /* best-effort */ }
  const statusTarget = options.statusTarget || loggerStatus || document.getElementById('debug-result');
  try {
    const res = await api('/api/bug-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const bugId = res?.data?.bug_id || payload.bug_id;
    setStatus(statusTarget, `Bug report saved â€” ${bugId}`, 'ok');
    return { ok: true, bugId, payload };
  } catch (err) {
    payload.recent_api_requests = atlasRecentApiRequests.slice(-BUG_REPORT_RECENT_API_LIMIT);
    setStatus(statusTarget, 'Bug report could not be saved. Copy report JSON?', 'error');
    await exposeBugReportJson(payload, statusTarget);
    return { ok: false, error: err, payload };
  }
}

function parseBugCommand(text) {
  const match = String(text || '').match(/^\/bug(?:\s+([\s\S]*))?$/i);
  return match ? (match[1] || '').trim() : null;
}

document.getElementById('report-bug-btn')?.addEventListener('click', () => {
  const box = document.getElementById('debug-result');
  box.innerHTML = '';
  const note = window.prompt ? window.prompt('Bug note?') : '';
  saveAtlasBugReport(note || '', { statusTarget: box });
});

/* ===== Dashboard (read-only) ===== */

function startLift(exercise, liftCode, targetWeight, targetReps, targetSets) {
  // Switch to Log Workout tab
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const logBtn = document.querySelector('[data-tab="logger"]');
  if (logBtn) logBtn.classList.add('active');
  const logTab = document.getElementById('tab-logger');
  if (logTab) logTab.classList.add('active');

  // Show coaching panel with known data immediately
  const panel = document.getElementById('coach-panel');
  if (panel) {
    panel.hidden = false;
    panel.className = 'coach-panel';
    panel.innerHTML = '';
    const buildPanelContent = (lastText, reasoning) => {
      const nodes = [
        el('p', { class: 'coach-panel-exercise', text: `Ok, ${exercise} time.` }),
        lastText ? el('p', { class: 'coach-panel-last', text: `Last session: ${lastText}.` }) : null,
        el('p', { class: 'coach-panel-target', text: `Today: aim for ${targetWeight} × ${targetReps} for ${targetSets} sets.` }),
        reasoning ? el('p', { class: 'coach-panel-reason', text: reasoning }) : null
      ].filter(Boolean);
      const row = el('div', { class: 'coach-panel-btn-row' });
      const dismissBtn = el('button', { type: 'button', class: 'secondary small', text: 'Dismiss' });
      dismissBtn.addEventListener('click', () => { panel.hidden = true; });
      const backBtn = el('button', { type: 'button', class: 'coach-back-btn', text: '← Back to session' });
      backBtn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelector('[data-tab="dashboard"]').classList.add('active');
        document.getElementById('tab-dashboard').classList.add('active');
        document.getElementById('intent-grid-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      row.appendChild(backBtn);
      row.appendChild(dismissBtn);
      return [...nodes, row];
    };

    panel.innerHTML = '';
    panel.appendChild(el('div', {}, buildPanelContent(null, 'Loading last session…')));
    // Enhance async with last working set
    if (getApiKey()) {
      fetchReaction(liftCode).then(rec => {
        if (!rec || !panel || panel.hidden) return;
        const last = rec.last_working_sets?.[rec.last_working_sets.length - 1];
        const lastText = last
          ? (last.rir != null ? `${formatSetLoad(last.weight, last.reps)} @${last.rir}` : formatSetLoad(last.weight, last.reps))
          : null;
        panel.innerHTML = '';
        panel.appendChild(el('div', {}, buildPanelContent(lastText, rec.reasoning || null)));
      }).catch(() => {});
    }
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Pre-fill workout textarea if empty
  const textarea = document.getElementById('workout-text');
  if (textarea && !textarea.value.trim()) {
    textarea.value = `${exercise} ${targetWeight} ${targetReps} x${targetSets}`;
  }
}

async function loadDashboard() {
  if (!getApiKey()) {
    const pickBox = document.getElementById('todays-pick');
    if (pickBox) pickBox.innerHTML = '<span class="muted">Set your API key in Settings to see today\'s plan.</span>';
    for (const id of ['progress-snapshot', 'intent-grid', 'coaching', 'weekly-summary', 'recent-history', 'recent-prs', 'stalls']) {
      const target = document.getElementById(id);
      if (target) target.innerHTML = '<span class="muted">Set your API key in Settings to load data.</span>';
    }
    return;
  }

  // Fire intent-recommendation + progress/summary first — they feed the above-fold region.
  const [intentResult, summaryResult] = await Promise.allSettled([
    api('/api/plan/intent-recommendation'),
    api('/api/progress/summary')
  ]);

  const intentData = intentResult.status === 'fulfilled' ? (intentResult.value.data || {}) : null;
  const summaryData = summaryResult.status === 'fulfilled' ? (summaryResult.value.data || {}) : null;

  if (intentData) lastIntentData = intentData;

  if (intentData) {
    renderTodaysRead(intentData);
    renderCoachReadStrip(intentData, summaryData);
    renderTodaysPick(intentData);
    renderIntentGrid(intentData);
    renderPatternBoard(intentData);
    setOtherTrainingHint(intentData);
  } else {
    const pickBox = document.getElementById('todays-pick');
    if (pickBox) pickBox.innerHTML = '<span class="muted">Could not load today\'s pick.</span>';
  }

  if (summaryData) {
    renderConsistencyLine(summaryData);
    renderProgressSnapshot(summaryData);
    setGlanceHint('this-week-hint', buildConsistencyText(summaryData));
  } else {
    const line = document.getElementById('consistency-line');
    if (line) line.innerHTML = '<span class="muted">Could not load.</span>';
  }

  wireStartSessionBtn(intentData);

  // Coach-first home opener (owner 2026-07-03, PR-1): hand the coach hero a
  // deterministic, engine-grounded coaching DECISION built from the SAME startup
  // fetch — no second network call, no LLM. coach-conversation.js paints it into
  // the guide box; it degrades to the default tagline when the engine named no
  // session (cold start / offline / no key).
  emitGlanceReady(intentData);

  // Below-fold sources load independently; each fills its own glance card.
  loadCoaching();
  loadWeeklySummary();
  loadRecentHistory();
  loadRecentPrs();
  loadStalls();
}

// Coach-first home opener (owner 2026-07-03, PR-1): the hero speaks a coaching
// DECISION, not a dashboard. Deterministic + LLM-free — every word is the
// engine's. The recommended session's own focus states today's call; its own
// why_today sentence (worded verbatim) gives the one-line reason; a fixed
// conversational invitation opens the door. Removed on purpose — the dashboard
// tells the owner named: the "{Weekday}. Today's read: {label}." announcement,
// the stacked consistency + freshest-pattern facts wall, and any days-since.
// TODAY-ONLY: focus and why_today are single-session engine output — nothing
// here forecasts a future session or invents a posture the engine did not pick.
// Returns '' (→ nothing dispatched) when the engine named no session, so the
// default tagline stands.
function buildCoachOpener(intentData) {
  const todaysRead = (intentData && intentData.todays_read) || {};
  const intents = (intentData && Array.isArray(intentData.intents)) ? intentData.intents : [];
  const rec = intents.find(i => i && i.recommended) ||
              intents.find(i => i && i.id && i.id === todaysRead.recommended_intent_id) ||
              null;
  // The decision is the recommended session's focus — a short phrase in the
  // engine (recommended_reason === top.focus) and the fixtures alike. Fall back
  // through the read's own fields; with nothing named, there is no opener.
  const decision = ((rec && rec.focus) || todaysRead.recommended_reason ||
                    todaysRead.recommended_label || '').toString().trim();
  if (!decision) return '';
  // The reason is the engine's OWN why_today sentence, worded verbatim — never
  // invented, never a forecast (why_today is single-session). Dropped when it's a
  // near-duplicate of the call (the low-data default why_today can mirror the focus,
  // e.g. 'Good time for heavy compound work' vs 'Heavy compound work') so the opener
  // never restates itself.
  const why = (rec && Array.isArray(rec.why_today) && rec.why_today.length)
    ? (rec.why_today[0] || '').toString().trim() : '';
  const reason = (why && !isNearDuplicateReason(why, decision)) ? `${endSentence(why)} ` : '';
  return `${reason}Today, let's make it ${lowerLead(decision)}. Ready when you are — or tell me to change the plan.`;
}

// End a borrowed clause as its own sentence (strip any trailing terminal
// punctuation — . ; : , ! ? — and connectors, then add a single period, so a
// why_today ending in '!'/'?' never double-punctuates to 'Ready?.').
function endSentence(s) {
  const t = s.toString().trim().replace(/[\s.;:,!?—–-]+$/, '');
  return t ? `${t}.` : '';
}

// Lowercase only a plain leading capital so a label reads mid-sentence; leave
// acronyms (OHP, RIR) and already-lowercase text untouched.
function lowerLead(s) {
  const t = s.toString().trim();
  return /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

// Near-duplicate guard: the engine's low-data default why_today can restate the
// focus ('Good time for heavy compound work' vs 'Heavy compound work'). Word-
// boundary containment (either phrase wholly inside the other, punctuation-
// insensitive) → the opener drops the reason clause rather than echo the call.
// Whole-word bounded so a shared stem ('push' vs 'pushing patterns are fresh')
// is NOT treated as a duplicate.
function isNearDuplicateReason(why, decision) {
  const norm = s => s.toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const w = norm(why), d = norm(decision);
  if (!w || !d) return false;
  const wp = ` ${w} `, dp = ` ${d} `;
  return wp.includes(dp) || dp.includes(wp);
}

// Resolve the recommended intent's focus (the "call") — shared by the compressed
// opener and its signature.
function recommendedFrom(intentData) {
  const todaysRead = (intentData && intentData.todays_read) || {};
  const intents = (intentData && Array.isArray(intentData.intents)) ? intentData.intents : [];
  const rec = intents.find(i => i && i.recommended) ||
              intents.find(i => i && i.id && i.id === todaysRead.recommended_intent_id) || null;
  const decision = ((rec && rec.focus) || todaysRead.recommended_reason ||
                    todaysRead.recommended_label || '').toString().trim();
  return { todaysRead, rec, decision };
}

// Anti-repetition (PR-2, display-only): a same-day reopen with UNCHANGED engine
// state should not re-brief the full paragraph. The compressed continuation is a
// short, floored line (never blank) that words the SAME decision the engine
// already made — it invents nothing. openerSignature identifies "this engine read
// today" from the engine's own output; the ledger (coach-conversation.js) uses it
// to choose full-vs-compressed. Deliberately NOT here: varying the ANGLE and
// withdrawing advice ignored twice are coaching decisions and stay owner-gated for
// the engine (North-Star opener endpoint) — the frontend only de-dups an identical
// render, never decides what to coach.
function compressedOpener(intentData) {
  const { decision } = recommendedFrom(intentData);
  if (!decision) return '';
  return `Still here. ${decision} whenever you're ready.`;
}
function openerDayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;  // local calendar day
}
function openerSignature(intentData) {
  const { todaysRead } = recommendedFrom(intentData);
  const id = todaysRead.recommended_intent_id;
  if (!id) return '';  // no read → no signature → never compresses
  const gap = todaysRead.days_since_last_session ?? '';
  return `${openerDayKey()}|${id}|${gap}`;
}

// Dispatch the deterministic coach opener for the hero (coach-conversation.js
// paints it) — built from loadDashboard's own fetch, no second call, no LLM.
// Dispatches nothing when the engine named no session, so the default hero
// stands (degradation = doing nothing). Carries a same-day de-dup signature + a
// compressed continuation so a repeat reopen doesn't re-brief.
function emitGlanceReady(intentData) {
  if (typeof document === 'undefined') return;
  const opener = buildCoachOpener(intentData);
  if (!opener) return;  // nothing meaningful → the default hero stands
  document.dispatchEvent(new CustomEvent('atlas:glance-ready', {
    detail: {
      opener,
      compressed: compressedOpener(intentData),
      signature: openerSignature(intentData),
      day: openerDayKey()
    }
  }));
}

/* ===== Coach plan card (read-only, Coach surface) =====
 * Surfaces today's focus, the lift to pick back up, its last working set, and
 * the next-set suggestion — all from existing read endpoints. It never writes.
 * A missing API key or a failed/empty fetch leaves the card hidden so the
 * logger is never blocked. */
async function loadCoachPlan() {
  const card = document.getElementById('coach-plan-card');
  if (!card) return;
  if (!getApiKey()) { card.hidden = true; return; }

  const [intentResult, planResult] = await Promise.allSettled([
    api('/api/plan/intent-recommendation'),
    api('/api/plan/today')
  ]);

  const todaysRead = intentResult.status === 'fulfilled'
    ? (intentResult.value.data?.todays_read || {})
    : {};
  const recs = planResult.status === 'fulfilled'
    ? (planResult.value.data?.recommendations || [])
    : [];

  const focusReason = todaysRead.recommended_reason || '';
  const topRec = recs[0] || null;

  // The focus headline already shows in the read-strip above, so this card adds
  // only the supporting reason + the actionable next-lift detail. Nothing to
  // add → stay quiet rather than render an empty shell.
  if (!focusReason && !topRec) { card.hidden = true; return; }

  renderCoachPlan(card, { focusReason, topRec });
  card.hidden = false;
}

function renderCoachPlan(card, { focusReason, topRec }) {
  card.innerHTML = '';
  card.appendChild(el('div', { class: 'coach-plan-kicker', text: 'Today’s plan' }));

  // 1) Supporting reason for today's focus (the label itself lives in the
  //    read-strip above, so it isn't repeated here).
  if (focusReason) {
    card.appendChild(el('div', { class: 'coach-plan-reason', text: focusReason }));
  }

  if (topRec) {
    const name = topRec.exercise_name || topRec.liftCode;
    card.appendChild(el('div', { class: 'coach-plan-lift', text: name }));

    // 2) Last relevant session context.
    const sets = topRec.last_working_sets || [];
    const last = sets.length ? sets[sets.length - 1] : null;
    if (last && (last.weight != null || last.reps != null)) {
      const rir = last.rir == null ? '' : ` @ RIR ${last.rir}`;
      const when = last.date_clean ? `Last (${last.date_clean})` : 'Last';
      card.appendChild(el('div', { class: 'coach-plan-last', text: `${when}: ${formatSetLoad(last.weight, last.reps)}${rir}` }));
    }

    // 3) Recommended next lift / weight / reps.
    const t = topRec.next_target;
    if (t && (t.weight != null || t.reps != null)) {
      card.appendChild(el('div', { class: 'coach-plan-target', text: `Next: ${t.weight} × ${t.reps} · ${t.sets} sets` }));
    }

    // 4) Short plain-English coaching sentence.
    if (topRec.recommendation) {
      card.appendChild(el('p', { class: 'coach-plan-suggestion', text: topRec.recommendation }));
    }
  }
}

/* ===== Weekly coach check-in card (read-only, Coach surface) =====
 * A short "how's this week going" summary: sessions, volume trend, which lifts
 * are progressing vs steady, and one nudge. Read-only; a missing key or a failed
 * core fetch leaves the card hidden so the logger is never blocked. */
async function loadWeeklyCoach() {
  const card = document.getElementById('weekly-coach-card');
  if (!card) return;
  if (!getApiKey()) { card.hidden = true; return; }

  const [reportResult, insightsResult] = await Promise.allSettled([
    api('/api/report/weekly'),
    api('/api/coaching/insights')
  ]);

  // report/weekly is the core source — without it there's nothing to show.
  if (reportResult.status !== 'fulfilled') { card.hidden = true; return; }
  const report = reportResult.value.data || {};
  const fatigue = insightsResult.status === 'fulfilled'
    ? (insightsResult.value.data?.fatigue || {})
    : {};

  renderWeeklyCoach(card, report, fatigue);
  card.hidden = false;
}

function renderWeeklyCoach(card, report, fatigue) {
  card.innerHTML = '';
  card.appendChild(el('div', { class: 'coach-plan-kicker', text: 'This week' }));

  const sessions = Number(report.sessions_count || 0);
  if (!sessions) {
    card.appendChild(el('div', { class: 'weekly-coach-summary', text: 'No training logged in the last 7 days yet.' }));
    card.appendChild(el('p', { class: 'weekly-coach-nudge', text: 'Nudge: a short session restarts your momentum.' }));
    return;
  }

  const clauses = [`${sessions} session${sessions === 1 ? '' : 's'}`];

  // Volume trend vs recent average (fatigue ratio), expressed as a percentage.
  if (fatigue && Number.isFinite(fatigue.ratio)) {
    const pct = Math.round((fatigue.ratio - 1) * 100);
    if (pct >= 3) clauses.push(`volume up ${pct}%`);
    else if (pct <= -3) clauses.push(`volume down ${-pct}%`);
    else clauses.push('volume steady');
  }

  const progressing = (report.prs || []).map(p => p.exercise || p.lift_code).filter(Boolean).slice(0, 2);
  if (progressing.length) clauses.push(`${progressing.join(' & ')} progressing`);

  const steady = (report.stalls_or_watchouts || []).map(s => s.exercise || s.liftCode).filter(Boolean).slice(0, 2);
  if (steady.length) clauses.push(`${steady.join(' & ')} steady`);

  card.appendChild(el('div', { class: 'weekly-coach-summary', text: `${clauses.join(', ')}.` }));

  const nudge = pickWeeklyNudge(report);
  if (nudge) card.appendChild(el('p', { class: 'weekly-coach-nudge', text: `Nudge: ${nudge}` }));
}

// Prefer a recommendation for a lift flagged as steady/stalled (where a nudge
// helps most); otherwise fall back to the top lift's recommendation.
function pickWeeklyNudge(report) {
  const recs = (report.recommendations || []).filter(r => r.recommendation);
  if (!recs.length) return '';
  const watchoutCodes = new Set((report.stalls_or_watchouts || []).map(s => String(s.liftCode || '').toUpperCase()));
  const watch = recs.find(r => watchoutCodes.has(String(r.lift_code || '').toUpperCase()));
  return (watch || recs[0]).recommendation;
}

/* ===== Training Snapshot (read-only — rendered from loadDashboard's progress/summary fetch) ===== */

function renderProgressSnapshot(s) {
  const box = document.getElementById('progress-snapshot');
  if (!box) return;
  box.innerHTML = '';

  const target = Number(s.streak_target_per_week || 3);
  const grid = el('div', { class: 'metric-grid' });
  const metrics = [
    [s.total_sessions, 'Total sessions'],
    [s.average_sessions_per_week, 'Avg / week'],
    [s.total_sets, 'Total sets'],
    [`${s.current_week_sessions ?? 0}/${target}`, 'This week']
  ];
  for (const [value, label] of metrics) {
    grid.appendChild(el('div', { class: 'metric-tile' }, [
      el('div', { class: 'metric-value', text: String(value ?? '—') }),
      el('div', { class: 'metric-label', text: label })
    ]));
  }
  box.appendChild(grid);

  // Consistency streak — fire is for showing up, not overtraining.
  const streak = Number(s.weekly_streak || 0);
  if (streak > 0) {
    box.appendChild(el('div', { class: 'streak-line streak-active', text: `\u{1F525} ${streak}-week streak` }));
    box.appendChild(el('p', { class: 'streak-sub', text: `You've hit ${target}+ sessions/week for ${streak} week${streak === 1 ? '' : 's'} in a row.` }));
  } else {
    const remaining = Math.max(0, target - Number(s.current_week_sessions || 0));
    box.appendChild(el('div', { class: 'streak-line streak-paused', text: 'Streak paused' }));
    box.appendChild(el('p', { class: 'streak-sub', text: `Log ${remaining} more session${remaining === 1 ? '' : 's'} this week to restart your ${target}x/week streak.` }));
  }

  // 12-week consistency strip
  const weeks = s.sessions_by_week || [];
  if (weeks.length) {
    const strip = el('div', { class: 'consistency-strip' });
    const max = Math.max(target, ...weeks.map(w => Number(w.sessions) || 0));
    for (const w of weeks) {
      const sessions = Number(w.sessions) || 0;
      const cls = sessions === 0 ? 'week-bar week-bar-zero' : sessions >= target ? 'week-bar week-bar-hit' : 'week-bar';
      const bar = el('div', { class: cls });
      bar.style.height = `${Math.max(6, Math.round((sessions / max) * 38))}px`;
      bar.title = `Week of ${w.week_start}: ${sessions} session${sessions === 1 ? '' : 's'}`;
      strip.appendChild(bar);
    }
    box.appendChild(strip);
    box.appendChild(el('p', { class: 'muted small', text: `Each bar = 1 week · ${target}+ sessions lights a streak week · last ${weeks.length} weeks` }));
  }
}

/* ===== Intent Dashboard — rendering handled by loadDashboard ===== */

// Plain-language overrides so the glance layer never needs gym jargon.
const FRIENDLY_PATTERN_LABELS = { Hinge: 'Hips & back', Pressing: 'Push', Pulling: 'Pull', 'Lower body': 'Legs' };
const FRIENDLY_STATUS_WORDS = { fatigued: 'Worked', recovering: 'Recovering', ready: 'Ready', fresh: 'Fresh', unknown: '—' };

// One-line readiness tooltip: when last trained, how recovered, how hard that session was.
function readinessTitle(p) {
  const parts = [p.detail || p.status || ''];
  if (p.recovery != null) parts.push(`${Math.round(p.recovery * 100)}% recovered`);
  if (p.effortIntensity != null) parts.push(`last effort ${Math.round(p.effortIntensity * 100)}%`);
  return parts.filter(Boolean).join(' · ');
}

function renderTodaysRead(data) {
  const box = document.getElementById('todays-read');
  if (!box) return;
  const todaysRead = data.todays_read || {};
  const patterns = todaysRead.patterns || [];

  box.innerHTML = '';

  const dotRow = el('div', { class: 'pattern-dots' });
  for (const p of patterns) {
    const status = p.status || 'unknown';
    const rawLabel = p.label || p.pattern;
    const pct = p.recovery == null ? 0 : Math.round(p.recovery * 100);
    const recoveryFill = el('div', { class: `pattern-recovery-fill pattern-dot-${status}` });
    recoveryFill.style.setProperty('--fill', `${pct}%`);
    const recoveryBar = el('div', { class: 'pattern-recovery', title: readinessTitle(p) }, [recoveryFill]);
    const wrap = el('div', { class: 'pattern-dot-wrap' }, [
      el('div', { class: `pattern-dot pattern-dot-${status}`, title: readinessTitle(p) }),
      el('div', { class: 'pattern-dot-label', text: FRIENDLY_PATTERN_LABELS[rawLabel] || rawLabel }),
      el('div', { class: `pattern-dot-status pattern-status-${status}`, text: FRIENDLY_STATUS_WORDS[status] || status }),
      recoveryBar
    ]);
    dotRow.appendChild(wrap);
  }
  box.appendChild(dotRow);

  // recommended_label and reason now live in #todays-pick via renderTodaysPick
  if (!patterns.length) box.hidden = true;
  else box.hidden = false;
}

// Composer-first Phase A — the glance line. One row of passive awareness above
// the hero (the design review's deliberate "know without asking" affordance):
// streak · per-pattern readiness dots · today's context. Upgraded IN PLACE from
// the shipped read-strip rather than adding a rival element (Invariant I1).
// Read-only; every value verbatim from the two dashboard fetches that already
// run at startup — the streak from /api/progress/summary, dots and today-label
// from /api/plan/intent-recommendation. Renders whatever subset exists.
function renderCoachReadStrip(data, summary) {
  const strip = document.getElementById('coach-read-strip');
  if (!strip) return;
  const todaysRead = data.todays_read || {};
  const patterns = todaysRead.patterns || [];
  const streak = summary ? Number(summary.weekly_streak || 0) : 0;
  if (!patterns.length && !(streak > 0)) return;
  // Composer-first Phase B3: the glance line is the tap-to-expand affordance —
  // cache what it shows so the expansion artifact words the same facts.
  lastGlanceData = { patterns, streak, summary: summary || null, todaysRead };
  strip.setAttribute('role', 'button');
  strip.tabIndex = 0;
  strip.setAttribute('aria-label', 'Where you stand — tap for details');
  strip.title = 'Tap for details';
  strip.innerHTML = '';
  if (streak > 0) {
    strip.appendChild(el('span', { class: 'strip-streak', text: `\u{1F525} ${streak}-wk streak` }));
  }
  const dots = el('div', { class: 'strip-dots' });
  for (const p of patterns) {
    const status = p.status || 'unknown';
    const rawLabel = p.label || p.pattern;
    const friendly = `${FRIENDLY_PATTERN_LABELS[rawLabel] || rawLabel}: ${FRIENDLY_STATUS_WORDS[status] || status}`;
    const recovery = p.recovery == null ? '' : ` (${Math.round(p.recovery * 100)}% recovered)`;
    dots.appendChild(el('span', {
      class: `strip-dot pattern-dot-${status}`,
      title: `${friendly}${recovery}`
    }));
  }
  strip.appendChild(dots);
  if (todaysRead.recommended_label) {
    strip.appendChild(el('span', { class: 'strip-rec', text: `Today: ${todaysRead.recommended_label}` }));
  }
}

/* ===== Glance expansion (composer-first Phase B3) =====
 * Tapping the glance line expands it into an in-thread status artifact — the
 * "1 row, tap→artifact" affordance of the adopted design. READ-ONLY and
 * deterministic: it words only the facts the strip already holds (cached at
 * render time — no fetch, no LLM, no write). The Progress tab keeps the full
 * detail; this is its glance-expansion demotion, evidence-first. */
let lastGlanceData = null;

function renderGlanceArtifact() {
  if (!lastGlanceData) return;
  const thread = document.getElementById('thread-messages');
  if (!thread) return;
  const { patterns, streak, summary, todaysRead } = lastGlanceData;

  const wrap = el('div', { class: 'glance-artifact' });
  wrap.appendChild(el('div', { class: 'chip-reply-title', text: 'Where you stand' }));

  if (summary) {
    wrap.appendChild(el('div', { class: 'chip-reply-row', text: buildConsistencyText(summary) }));
  } else if (streak > 0) {
    wrap.appendChild(el('div', { class: 'chip-reply-row', text: `\u{1F525} ${streak}-week streak` }));
  }

  for (const p of patterns) {
    const status = p.status || 'unknown';
    const rawLabel = p.label || p.pattern;
    const label = FRIENDLY_PATTERN_LABELS[rawLabel] || rawLabel;
    const word = FRIENDLY_STATUS_WORDS[status] || status;
    const recovery = p.recovery == null ? '' : ` · ${Math.round(p.recovery * 100)}% recovered`;
    const days = p.daysSince == null ? '' : ` · last trained ${p.daysSince}d ago`;
    wrap.appendChild(el('div', { class: `chip-reply-row glance-row-${status}`, text: `${label}: ${word}${recovery}${days}` }));
  }

  if (todaysRead.recommended_label) {
    wrap.appendChild(el('div', { class: 'chip-reply-row', text: `Today: ${todaysRead.recommended_label}` }));
  }

  const more = el('a', { href: '#', class: 'chip-reply-more', text: 'Full progress →' });
  more.addEventListener('click', ev => {
    ev.preventDefault();
    // Phase D: the surface toggle is gone — land on Today via the tab engine
    // (same route the drawer's Progress row uses).
    document.querySelector('.tab-btn[data-tab="dashboard"]')?.click();
  });
  wrap.appendChild(more);

  const bubble = el('div', { class: 'chat-bubble chat-bubble-atlas' });
  bubble.appendChild(wrap);
  // Re-tap refreshes rather than clutters (review #808): if the newest thread
  // message is already a glance artifact, replace it in place; only append
  // when the conversation has moved on since the last expansion.
  const last = thread.lastElementChild;
  if (last && last.querySelector && last.querySelector('.glance-artifact')) {
    last.replaceWith(bubble);
  } else {
    thread.appendChild(bubble);
  }
  requestAnimationFrame(() => bubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}

// One listener at startup; the strip only becomes tappable (role/tabindex set
// in renderCoachReadStrip) once it has content, and the guard above makes an
// early tap a no-op.
document.getElementById('coach-read-strip')?.addEventListener('click', renderGlanceArtifact);
document.getElementById('coach-read-strip')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renderGlanceArtifact(); }
});

function renderIntentGrid(data) {
  const box = document.getElementById('intent-grid');
  if (!box) return;
  box.innerHTML = '';
  const intents = data.intents || [];
  const grid = el('div', { class: 'intent-grid' });
  for (const intent of intents) {
    const tileClass = `intent-tile${intent.recommended ? ' intent-tile-recommended' : ''}`;
    const tile = el('button', { type: 'button', class: tileClass });
    if (intent.recommended) {
      tile.appendChild(el('span', { class: 'intent-star', text: '★ ' }));
    }
    tile.appendChild(el('span', { class: 'intent-tile-label', text: intent.label }));
    if (intent.focus) {
      tile.appendChild(el('span', { class: 'intent-tile-focus', text: intent.focus }));
    }
    tile.addEventListener('click', () => openIntentDrawer(intent));
    grid.appendChild(tile);
  }
  box.appendChild(grid);
  box.appendChild(el('p', { class: 'muted hint', text: 'Tap any tile to see the coaching brief and start a session.' }));
}

// Per-movement-pattern recovery board. The backend already returns `patterns`
// (Pressing / Pulling / Lower body / Hinge / Core) on the intent-recommendation
// response, each with a readiness status and a plain-language detail line. This
// surfaces them as tiles sorted so the most-recovered / overdue patterns lead —
// a glance at what's ready to train and what's still resting. Tapping a tile
// asks the coach for a session focused on that pattern (read-only — no write).
const PATTERN_STATUS_META = {
  fresh:      { label: 'Fresh',      rank: 0 },
  ready:      { label: 'Ready',      rank: 1 },
  recovering: { label: 'Recovering', rank: 2 },
  fatigued:   { label: 'Fatigued',   rank: 3 },
  unknown:    { label: 'No data',    rank: 4 }
};

function renderPatternBoard(data) {
  const box = document.getElementById('pattern-board');
  if (!box) return;
  box.innerHTML = '';
  const patterns = ((data.todays_read && data.todays_read.patterns) || []).filter(p => p && p.label);
  if (!patterns.length) {
    box.appendChild(el('p', { class: 'muted', text: 'Log a few sessions and Atlas can track recovery per movement.' }));
    setGlanceHint('pattern-board-hint', '');
    return;
  }

  // Overdue / most-recovered first; never-trained patterns sink to the bottom.
  const sorted = [...patterns].sort((a, b) => {
    const ra = PATTERN_STATUS_META[a.status]?.rank ?? 9;
    const rb = PATTERN_STATUS_META[b.status]?.rank ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.daysSince ?? -1) - (a.daysSince ?? -1);
  });

  const grid = el('div', { class: 'pattern-board' });
  for (const p of sorted) {
    const status = PATTERN_STATUS_META[p.status] ? p.status : 'unknown';
    const meta = PATTERN_STATUS_META[status];
    // Rotation-overdue flag: a fully recovered pattern untouched for a while is
    // the clearest coverage gap — mirror the intent engine's "fresh" rotation cue.
    const overdue = (status === 'fresh' || status === 'unknown') && (p.daysSince == null || p.daysSince >= 5);

    const tile = el('button', { type: 'button', class: `pattern-tile pattern-${status}` });
    const top = el('div', { class: 'pattern-tile-top' }, [
      el('span', { class: 'pattern-tile-label', text: p.label }),
      el('span', { class: `pattern-pill pattern-pill-${status}`, text: meta.label })
    ]);
    if (overdue) top.appendChild(el('span', { class: 'pattern-overdue', text: 'overdue' }));
    tile.appendChild(top);
    if (p.detail) tile.appendChild(el('span', { class: 'pattern-tile-detail', text: p.detail }));
    tile.addEventListener('click', () => {
      // The board lives on the Today surface but the coach reply lands in the
      // Coach thread — switch there first so the answer is visible, not orphaned.
      document.querySelector('.tab-btn[data-tab="logger"]')?.click();
      routeMessageToCoach(`What should I train for ${p.label.toLowerCase()} today?`);
    });
    grid.appendChild(tile);
  }
  box.appendChild(grid);
  box.appendChild(el('p', { class: 'muted hint', text: 'Tap a movement to ask Atlas for a session focused on it.' }));

  const ready = patterns.filter(p => p.status === 'fresh' || p.status === 'ready').length;
  const resting = patterns.filter(p => p.status === 'fatigued').length;
  const parts = [];
  if (ready) parts.push(`${ready} ready`);
  if (resting) parts.push(`${resting} resting`);
  setGlanceHint('pattern-board-hint', parts.join(' · ') || 'Recovery tracked');
}

/* ===== Today — hero card, consistency line, start-session wiring ===== */

function renderTodaysPick(data) {
  const box = document.getElementById('todays-pick');
  if (!box) return;
  box.innerHTML = '';
  const todaysRead = data.todays_read || {};
  const intents = data.intents || [];
  const recommended = intents.find(i => i.recommended);

  if (!todaysRead.recommended_label) {
    box.appendChild(el('p', { class: 'muted', text: 'Log a few sessions and Atlas can start suggesting what to train.' }));
    return;
  }

  box.appendChild(el('div', { class: 'today-pick-headline', text: `Today: ${todaysRead.recommended_label}` }));

  const whyLines = recommended?.why_today?.slice(0, 2) || [];
  const reason = whyLines.length
    ? whyLines[0]
    : todaysRead.recommended_reason || recommended?.focus || '';
  if (reason) {
    box.appendChild(el('p', { class: 'today-pick-reason', text: reason }));
  }
  if (whyLines.length > 1) {
    box.appendChild(el('p', { class: 'today-pick-reason muted', text: whyLines[1] }));
  }

  // Composer-first Phase B: the card is a LINK into the canonical in-thread
  // Coach's Pick, not a second recommendation home of its own.
  const link = el('button', { type: 'button', class: 'today-pick-link', text: 'Open with your coach →' });
  link.addEventListener('click', openCoachPickInThread);
  box.appendChild(link);
}

// Composer-first Phase B — the ONE canonical recommendation. Every "today's
// recommendation" entry point (pick card, START SESSION, nav's session link,
// a typed "what are we doing today?") lands here: switch to the coach surface
// and render the same in-thread Coach's Pick (window.atlasOpenCoachPick, which
// engages the suggestion). The intent DRAWER remains only for the
// non-recommended "Other training options" grid.
function openCoachPickInThread() {
  // Land on the coach surface via the tab engine (the Phase D header has no
  // surface toggle; the hidden logger tab-btn is the programmatic route).
  document.querySelector('.tab-btn[data-tab="logger"]')?.click();
  if (typeof window.atlasOpenCoachPick === 'function') window.atlasOpenCoachPick();
}

function buildConsistencyText(s) {
  const target = Number(s.streak_target_per_week || 3);
  const streak = Number(s.weekly_streak || 0);
  const current = Number(s.current_week_sessions || 0);
  if (streak > 0) {
    return `\u{1F525} ${streak}-week streak · ${current}/${target} this week`;
  }
  const remaining = Math.max(0, target - current);
  return `${current}/${target} sessions this week · ${remaining} more to restart your streak`;
}

function renderConsistencyLine(s) {
  const box = document.getElementById('consistency-line');
  if (!box) return;
  box.textContent = buildConsistencyText(s);
}

function setOtherTrainingHint(data) {
  const intents = data.intents || [];
  const others = intents.filter(i => !i.recommended);
  setGlanceHint('other-training-hint', others.length ? `${others.length} other option${others.length === 1 ? '' : 's'}` : 'See all options');
}

function wireStartSessionBtn(data) {
  const btn = document.getElementById('start-session-btn');
  if (!btn) return;
  if (!data) { btn.hidden = true; return; }
  const recommended = (data.intents || []).find(i => i.recommended);

  // Composer-first Phase B: the recommendation's action routes to the ONE
  // canonical in-thread Coach's Pick (typeSuggestedWorkout handles both the
  // structured-plan and no-exercises cases), never a second drawer home.
  if (recommended) {
    btn.textContent = 'START SESSION';
    btn.hidden = false;
    btn.onclick = openCoachPickInThread;
  } else {
    btn.hidden = true;
  }
}

// Normalize an intent's exercise entry to one shape. Intents emit
// { exercise, lift_code, target_weight, target_reps, target_sets, reason };
// also tolerate a next_target shape just in case. `rir` is carried through so
// the suggested-workout display can show it (and never silently drop it).
function normalizePlanExercise(raw) {
  if (!raw) return { name: '', canonicalName: '', liftCode: '', weight: null, reps: null, sets: null, rir: null, reason: '' };
  const t = raw.next_target || {};
  const pick = (a, b) => (a != null ? a : (b != null ? b : null));
  return {
    name: raw.exercise || raw.exercise_name || raw.lift_code || raw.liftCode || '',
    // canonicalName mirrors currentPlanForChat's preference (canonical_exercise first)
    // so resolveCompletedIdentity and current_plan[].name always agree.
    canonicalName: raw.canonical_exercise || raw.canonicalExercise || '',
    liftCode: raw.lift_code || raw.liftCode || '',
    weight: pick(raw.target_weight, t.weight),
    reps: pick(raw.target_reps, t.reps),
    sets: pick(raw.target_sets, t.sets),
    rir: pick(raw.target_rir, t.rir),
    reason: raw.reason || ''
  };
}

/* ===== Active planned session (in-memory, Start Session) =====
 * Slice 1: track the recommended workout as a queue with a cursor, show a
 * banner with the current step, and open each item in the logger via startLift.
 * No persistence; logging/preview/save stays exactly as it was. */
let activePlannedSession = null;
// Owner directive (2026-07-03): in-workout chrome collapses to the pin row —
// the plan card (Next exercise / End session) is a tap-to-expand dropdown.
let sessionChromeExpanded = false;

// Whether the lifter has ENGAGED today's coach suggestion (tapped Coach's Pick),
// as opposed to merely having the dashboard open. `loadDashboard()` always loads
// `lastIntentData` to render the home-screen pick, but a *displayed* suggestion is
// not an *active plan* — so plannedExerciseEntries() must only treat lastIntentData
// as the plan once the lifter actually engages it. Without this gate, a cold
// direct-composer log was narrated as if mid-plan ("Moving on — next up: …") and
// the composer was pre-filled with the next suggested lift. Set true by Coach's
// Pick (typeSuggestedWorkout), false by Freestyle; an active planned session takes
// precedence regardless. Defaults false on every load (no persistence).
let coachSuggestionEngaged = false;

// Step 373b: when the lifter declares a swap for the current step ("Lat bar is
// taken, I'll do seated rows instead"), we record the prescribed (swapped-out)
// lift here. The NEXT logged exercise is treated as the substitute and replaces
// that slot in the live session. Gated on an explicit swap declaration so it
// never misfires on ordinary added work.
let pendingSubstitution = null;

// Read-only accessor for coach-conversation.js (coach layer must never mutate
// the session directly — only app.js advances/ends it via advancePlannedSession
// and endPlannedSession).
// eslint-disable-next-line no-unused-vars -- global export consumed by other browser scripts; Phase 1 PR-08/09
function getActivePlannedSession() { return activePlannedSession; }
// eslint-disable-next-line no-unused-vars -- global export consumed by other browser scripts; Phase 1 PR-08/09
function getSessionCompleted() { return sessionCompleted; }

// The active training intent id (e.g. 'recovery_pump', 'deload_reset'). A started
// session carries it on activePlannedSession; but an ENGAGED Coach's Pick that the
// lifter logs against WITHOUT a mutation never materializes one (activePlannedSession
// stays null — see ensureActivePlannedSession), so fall back to the engaged
// suggestion's recommended intent. Without this, a Recovery/Pump session logged
// straight from Coach's Pick lost its intent and got an "add load" nudge
// (BUG-20260629-204817). Returns null in freestyle / when nothing is engaged.
function getActiveIntentId() {
  if (activePlannedSession && activePlannedSession.intentId) return activePlannedSession.intentId;
  if (coachSuggestionEngaged && lastIntentData) {
    const rec = ((lastIntentData.intents) || []).find(i => i && i.recommended);
    if (rec && rec.id) return rec.id;
  }
  return null;
}

// P0 Active Workout State Unification — the ONE canonical view of the in-progress
// workout, derived from the authoritative store (the planned order from
// plannedExerciseEntries() + the logged set sessionCompleted[]) through the shared
// public/activeSession.js model. Every consumer (composer prefill, next-up router,
// recap, preview/save) derives from THIS in the read-consolidation slice, so they
// can never disagree about identity / completion / order again. Built fresh on each
// call from the store, so there is no second copy to keep in sync. Returns null
// when no plan is active. (Sub-PR 1 establishes it; Sub-PR 2 wires the readers.)
function getCanonicalSession() {
  const AS = (typeof window !== 'undefined' && window.activeSession) || (typeof activeSession !== 'undefined' ? activeSession : null);
  if (!AS) return null;
  const entries = plannedExerciseEntries();
  if (!entries.length && !(Array.isArray(sessionCompleted) && sessionCompleted.length)) return null;
  let s = AS.createActiveSession({
    exercises: entries.map(e => ({ name: e.canonical || e.name, liftCode: e.liftCode || '' }))
  });
  // Replay logged completions onto the canonical session. A logged name that
  // matches a planned slot marks it done; one that doesn't is an off-plan insert
  // (Hammer Curls / Knee Raises) so it is represented, not dropped.
  for (const name of (Array.isArray(sessionCompleted) ? sessionCompleted : [])) {
    const after = AS.markCompleted(s, name);
    s = after !== s ? after : AS.markCompleted(AS.insertExercise(s, { name }), name);
  }
  return s;
}

// Map a canonical ActiveSession to the `plan_exercises` save payload (B2 — the
// save surface derives from the SAME canonical model the confirmation card, coach
// context, mid-session sub-payload, and preview read, so it can never drift from
// the visible session). PURE — no globals, no I/O — so the Node tests run the
// identical logic. Planned-origin only: an off-plan insert (Hammer Curls / Knee
// Raises) is logged work but never a PRESCRIBED source, so it must not enter the
// substitution inference (inferPrescribedPairs) as a planned lift. Completed and
// pending planned slots are BOTH kept: a fulfilled planned lift must stay so its
// logged row is exact-matched and claimed (preventing a false broad-region pair),
// and a still-pending planned lift is the legitimate substitution source.
function planExercisesFromCanonical(session) {
  if (!session || !Array.isArray(session.exercises)) return [];
  return session.exercises
    .filter(e => e && e.source !== 'inserted')
    .map(e => ({ name: e.name, ...(e.liftCode ? { lift_code: e.liftCode } : {}) }))
    .filter(p => p.name);
}

// Coach-suggestion engagement flag accessors for the coach layer (coach-conversation.js).
// markCoachSuggestionEngaged() fires when the lifter taps Coach's Pick; clear on Freestyle.
// eslint-disable-next-line no-unused-vars -- global export consumed by coach-conversation.js; Phase 1 PR-08/09
function getCoachSuggestionEngaged() { return coachSuggestionEngaged; }
// eslint-disable-next-line no-unused-vars -- global export consumed by coach-conversation.js; Phase 1 PR-08/09
function setCoachSuggestionEngaged(v) { coachSuggestionEngaged = !!v; }

// Step 373b: replace a prescribed slot in the LIVE planned session with the
// actually-logged substitute, so the swapped-out lift leaves remaining and the
// substitute is what gets marked done. Inline mirror of applySubstitution in
// services/sessionPlanExecutor.js (the browser can't require() the service).
// keep in sync with applySubstitution in services/sessionPlanExecutor.js
// Returns true when the live plan actually changed (a slot was swapped or a
// duplicate slot removed), false on any no-op/early-return — so the caller only
// announces a swap that really happened (PR-570 cosmetic note).
function applySessionSubstitution(prescribedName, subName, subLiftCode, prescription) {
  if (!activePlannedSession || !Array.isArray(activePlannedSession.exercises)) return false;
  if (!prescribedName || !subName) return false;
  const exs = activePlannedSession.exercises;
  const prescKey = String(prescribedName).toLowerCase();
  const subKey = String(subName).toLowerCase();
  if (subKey === prescKey) return false; // nothing to swap
  const idx = exs.findIndex(e =>
    (e.canonicalName || e.name || '').toLowerCase() === prescKey ||
    (e.name || '').toLowerCase() === prescKey);
  if (idx === -1) return false;
  const subCode = String(subLiftCode || '').toLowerCase();
  // Dedupe: if the substitute is already a slot elsewhere, drop the prescribed
  // slot instead of duplicating it (one logged set must not close two slots).
  const dupElsewhere = exs.some((e, i) => i !== idx && (
    (e.canonicalName || e.name || '').toLowerCase() === subKey ||
    (subCode && (e.liftCode || '').toLowerCase() === subCode)
  ));
  if (dupElsewhere) {
    exs.splice(idx, 1);
    // Cursor must follow the removed slot, clamped so it never points past the
    // end (removing the current+last slot would otherwise crash the banner).
    // keep in sync with clampCursorAfterRemoval in services/sessionPlanExecutor.js
    let next = activePlannedSession.index;
    if (next > idx) next -= 1;
    if (next >= exs.length) next = Math.max(0, exs.length - 1);
    activePlannedSession.index = Math.max(0, next);
  } else {
    // AC3: use the prescription from the substitute-check API when available so the
    // replacement slot carries the correct weight/reps/sets instead of null.
    const p = prescription && typeof prescription === 'object' ? prescription : {};
    exs[idx] = {
      name: subName, canonicalName: subName, liftCode: subLiftCode || '',
      weight: p.weight != null ? p.weight : null,
      reps: p.reps != null ? p.reps : null,
      sets: p.sets != null ? p.sets : null,
      rir: p.rir != null ? p.rir : null,
      reason: 'substituted'
    };
  }
  renderActiveSessionBanner();
  return true;
}

function startPlannedSession(intent) {
  const exercises = (intent.exercises || []).map(normalizePlanExercise).filter(ex => ex.name);
  if (!exercises.length) return;
  // Lifecycle symmetry (Step 373b): a new session never inherits a stale swap.
  pendingSubstitution = null;
  activePlannedSession = {
    label: intent.label || 'Recommended session',
    // The plan intent id (e.g. 'deload_reset') rides along so the in-workout
    // reaction can flip on a deload day — see fetchReaction.
    intentId: intent.id || null,
    exercises,
    index: 0
  };
  // Hide the home-screen hero so the active-session banner and coach panel
  // are the only things visible. hideHomeEmpty() in coach-conversation.js does
  // the same op but is private to that IIFE.
  document.getElementById('coach-empty')?.setAttribute('hidden', '');
  renderActiveSessionBanner();
  // Step 385: begin the deload state machine when a deload_reset session starts.
  // Fire-and-forget — never block the session UI. 409 = already in deload, fine.
  if (intent.id === 'deload_reset') {
    api('/api/deload/begin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ focus: 'strength', reason: 'owner started deload session' })
    }).catch(() => {});
  }
  saveSessionSnapshot();   // persist the started plan for resume safety
  const first = exercises[0];
  startLift(first.name, first.liftCode, first.weight, first.reps, first.sets || 3);
}

// ── P0 Sub-PR 2a: deterministic plan mutation from explicit user intent ────────
// A swap/skip the lifter STATES ("skip deadlifts and do squats") mutates the
// canonical session IMMEDIATELY — the app state owns the change, not LLM prose.

// Resolve a free-text exercise phrase to a catalog canonical name + lift code, so
// a swapped-in slot carries the canonical identity a later log will match.
// Singularization is conservative: it drops a trailing plural "s" ONLY when it
// follows a non-"s" character ("squats"→"squat", "curls"→"curl") so genuine
// "ss" endings are preserved ("press" stays "press", "leg press" stays intact) —
// the loose every-word strip mis-bound lifts (PR-570 review). Falls back to the raw phrase.
function resolveCatalogExercise(phrase) {
  const raw = String(phrase == null ? '' : phrase).trim();
  if (!raw || typeof document === 'undefined') return { name: raw, liftCode: '' };
  const dl = document.getElementById('exercise-catalog');
  const opts = dl ? Array.from(dl.options || []) : [];
  const singular = s => { const t = String(s || '').toLowerCase().trim(); return /[^s]s$/.test(t) ? t.slice(0, -1) : t; };
  const key = raw.toLowerCase();
  const skey = singular(raw);
  // Refuse to guess on ambiguity (mirrors findMatchIndex, PR-570 review): exact name
  // → UNIQUE singular-equal → UNIQUE substring. If >1 (or 0) match, leave the slot as
  // the raw phrase rather than arbitrarily binding by catalog order; a later log
  // re-resolves identity through the trust loop anyway.
  let opt = opts.find(o => (o.value || '').toLowerCase() === key);
  if (!opt) {
    const eq = opts.filter(o => singular(o.value) === skey);
    if (eq.length === 1) opt = eq[0];
  }
  if (!opt) {
    const sub = opts.filter(o => { const v = singular(o.value); return v && (v.includes(skey) || skey.includes(v)); });
    if (sub.length === 1) opt = sub[0];
  }
  // `matched` is true ONLY when a catalog option was found (not an echoed raw
  // phrase) — callers that must not act on an unknown phrase gate on it.
  return opt ? { name: opt.value, liftCode: opt.label || '', matched: true } : { name: raw, liftCode: '', matched: false };
}

// Skip a planned exercise: SPLICE it out of the live queue (it stops showing as
// current/remaining) and clamp the cursor. Note this differs from
// activeSession.skipExercise, which RETAINS the slot as status:'skipped' — here the
// live activePlannedSession store has no skipped state, so we remove the slot
// (consistent with the existing applySessionSubstitution dedupe path). Representing
// a skipped slot as skipped (vs absent) in the canonical recap is deferred to 2b
// (see BACKLOG.md).
function skipPlannedExercise(name) {
  if (!activePlannedSession || !Array.isArray(activePlannedSession.exercises)) return false;
  const key = String(name || '').toLowerCase();
  const idx = activePlannedSession.exercises.findIndex(e =>
    (e.canonicalName || e.name || '').toLowerCase() === key || (e.name || '').toLowerCase() === key);
  if (idx === -1) return false;
  activePlannedSession.exercises.splice(idx, 1);
  let next = activePlannedSession.index;
  if (next > idx) next -= 1;
  if (next >= activePlannedSession.exercises.length) next = Math.max(0, activePlannedSession.exercises.length - 1);
  activePlannedSession.index = Math.max(0, next);
  renderActiveSessionBanner();
  return true;
}

// Tell the coach layer a mutation happened so it can confirm it + re-point the
// composer to the new current exercise (composer ownership stays in coach-conversation).
function announcePlanMutation(summary, currentName) {
  renderActiveSessionBanner();
  document.dispatchEvent(new CustomEvent('atlas:plan-mutated', {
    detail: { summary: summary || '', current: currentName || null }
  }));
}

// Materialize a mutable active session from an ENGAGED Coach's Pick suggestion.
// A typed Coach's Pick (typeSuggestedWorkout) sets coachSuggestionEngaged + leaves
// the plan in lastIntentData WITHOUT a started activePlannedSession — so an explicit
// swap/skip had nothing mutable to act on and fell through to the coach (live-gym
// v48: "let's do rdls instead of deadlifts" hit the coach-down fallback instead of
// swapping). On the first mutation, promote the suggestion to a live session
// (carrying its prescription) so the deterministic swap/skip works in BOTH states.
// Returns true when an active session exists (or was just materialized).
function ensureActivePlannedSession() {
  if (activePlannedSession && Array.isArray(activePlannedSession.exercises) && activePlannedSession.exercises.length) return true;
  if (!coachSuggestionEngaged || !lastIntentData) return false;
  const intents = (lastIntentData && lastIntentData.intents) || [];
  const rec = intents.find(i => i.recommended);
  const exercises = (rec && Array.isArray(rec.exercises) ? rec.exercises : [])
    .map(normalizePlanExercise).filter(ex => ex.name);
  if (!exercises.length) return false;
  activePlannedSession = {
    label: (rec && rec.label) || 'Recommended session',
    intentId: (rec && rec.id) || null,
    exercises,
    index: 0
  };
  renderActiveSessionBanner();
  return true;
}

// Classify an explicit swap/skip and apply it to the canonical session. Returns
// true when handled (caller then skips the substitute/coach routing). A non-mutation
// message, or no active plan (freestyle), or a target not in the plan → false (fall
// through). Materializes an engaged suggestion into a live session ONLY for a genuine
// mutation, so freestyle/no-plan logging stays untouched.
function tryApplyPlanMutation(text) {
  const PM = (typeof window !== 'undefined' && window.planMutationIntent) || null;
  if (!PM) return false;
  const intent = PM.classifyMutationIntent(text);
  if (!intent) return false;                  // classify FIRST — never materialize on non-mutations
  if (!ensureActivePlannedSession()) return false; // no plan at all (freestyle) → fall through
  // Resolve the (possibly compound, e.g. "deadlifts/rdls") target to PENDING plan
  // slots via the canonical session — singular-aware (matches "Romanian Deadlift")
  // and never matching a completed/skipped slot (no re-opening finished work).
  const canon = getCanonicalSession();
  const planEntries = canon && Array.isArray(canon.exercises) && canon.exercises.length
    ? canon.exercises
    : activePlannedSession.exercises.map(e => ({ name: e.canonicalName || e.name, status: 'pending' }));
  const targetNames = PM.resolvePlanTargets(intent.target, planEntries);
  if (!targetNames.length) return false; // not a (pending) planned lift → let the coach handle it
  const curName = () => {
    // After a mutation (splice/replace), firstUnloggedPlannedLift gives the correct
    // new current exercise — the stale cursor may not have advanced yet.
    const unlogged = firstUnloggedPlannedLift();
    if (unlogged) return unlogged;
    const cur = activePlannedSession.exercises[activePlannedSession.index];
    return cur ? (cur.canonicalName || cur.name) : null;
  };

  if (intent.action === 'skip') {
    // Skip ALL matched slots only for a GENUINELY COMPOUND target ("skip
    // deadlifts/rdls"). A single token that fuzzily over-matched several slots
    // ("skip press" → Bench Press + Overhead Press) skips only the first — it must
    // not remove planned work the lifter never named (mirrors the replace path).
    const toSkip = PM.splitTargets(intent.target).length > 1 ? targetNames : targetNames.slice(0, 1);
    toSkip.forEach(skipPlannedExercise);
    announcePlanMutation(`Skipped ${toSkip.join(', ')}.`, curName());
    return true;
  }
  // Replace: swap the first matched target with the substitute. Only skip the OTHER
  // matched slots when the user named a GENUINELY COMPOUND target ("skip
  // deadlifts/rdls and do squats" removes both). A single token that fuzzily
  // over-matched several slots (e.g. "curls" → Bicep Curl + Leg Curl) replaces only
  // the first — it must never silently drop un-named planned work.
  const resolved = resolveCatalogExercise(intent.substitute);
  const swapped = applySessionSubstitution(targetNames[0], resolved.name, resolved.liftCode);
  const extraSkipped = PM.splitTargets(intent.target).length > 1
    ? targetNames.slice(1).filter(skipPlannedExercise)
    : [];
  // Only announce a change that actually happened — a no-op swap (the resolved
  // substitute collapsed to the target, applySessionSubstitution early-returned)
  // with no extra slots skipped must not narrate a phantom "Swapped X → Y"
  // (PR-570 cosmetic note).
  if (!swapped && !extraSkipped.length) return false;  // nothing changed → fall through
  // Narrate what ACTUALLY happened: a real swap (optionally noting extra compound
  // slots skipped), or — when the first slot no-op'd but later compound slots were
  // skipped — a skip-only outcome. Never announce a swap that didn't occur (PR-571
  // review). Re-point to the ACTUAL current lift (the cursor) — swapping a LATER
  // slot must not yank the composer off the lift in progress.
  const summary = swapped
    ? `Swapped ${targetNames[0]} → ${resolved.name}.${extraSkipped.length ? ` Skipped ${extraSkipped.join(', ')}.` : ''}`
    : `Skipped ${extraSkipped.join(', ')}.`;
  announcePlanMutation(summary, curName() || (swapped ? resolved.name : null));
  return true;
}

// ── P0 PR 4: deterministic exercise-identity correction (AC7) ──────────────────
// "sorry that was squats" relabels the JUST-LOGGED lift in the session buffers, so
// the card/recap/write rows agree — deterministically, even when the coach LLM is
// down (the exact live-gym failure). The app state owns the relabel; the coach only
// confirms it.

// Small edit distance for the correction lane's typo tier — inputs are single
// words, so the O(len²) DP is trivial.
function correctionEditDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Typo-tolerant word equality (owner live find 2026-07-03: 'prep' must meet
// 'press'): exact, singular-equal, or a near-miss — both words ≥4 chars, a shared
// ≥3-char prefix, edit distance ≤2. The prefix anchor keeps short real-word
// neighbors apart ('pull' never meets 'push'; 3-letter words must match exactly,
// so 'leg' never meets 'lat').
function correctionWordEq(a, b) {
  if (a === b) return true;
  const sg = w => (/[^s]s$/.test(w) ? w.slice(0, -1) : w);
  const x = sg(a), y = sg(b);
  if (x === y) return true;
  if (x.length < 4 || y.length < 4) return false;
  if (x.slice(0, 3) !== y.slice(0, 3)) return false;
  return correctionEditDistance(x, y) <= 2;
}

// Word list for the subset tier: lowercase, hyphens/slashes → spaces, deduped
// (mirrors planMutationIntent's wordSet; singularization lives in correctionWordEq).
function correctionWords(s) {
  return [...new Set(String(s == null ? '' : s).toLowerCase()
    .replace(/[-/]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean))];
}

// Resolve a correction's TO side when the catalog tiers (exact/singular/unique-
// substring) miss — the ≥2-word word-subset/typo tier against PLAN names first,
// then catalog names: "single leg seated leg prep" (typo'd) must still reach
// "Single-Leg Seated Leg Press". Refuses on ambiguity at each source (mirrors
// resolveCatalogExercise, PR-570) — a phrase matching two names relabels nothing.
function resolveCorrectionTargetName(phrase) {
  const words = correctionWords(phrase);
  if (words.length < 2) return null; // ≥2-word minimum — a lone word never typo-guesses
  const matches = names => {
    const hits = [];
    for (const n of names) {
      const nw = correctionWords(n);
      if (words.every(w => nw.some(cw => correctionWordEq(w, cw))) && !hits.includes(n)) hits.push(n);
    }
    return hits;
  };
  const plan = matches(plannedExerciseEntries().map(e => e.name));
  if (plan.length) return plan.length === 1 ? plan[0] : null;
  const dl = typeof document !== 'undefined' ? document.getElementById('exercise-catalog') : null;
  const cat = matches(Array.from((dl && dl.options) || []).map(o => o.value).filter(Boolean));
  return cat.length === 1 ? cat[0] : null;
}

// Resolve a correction's FROM side ("sorry SLSLP is …") against the DISTINCT
// buffered lift names, newest first — the mis-typed name is usually the latest
// group, and is often catalog-UNKNOWN, which is exactly why it needs correcting.
// Tiers: exact → singular-equal → substring → word-subset/typo (single-word
// phrases get the typo tier only against single-word names).
function resolveBufferedLiftName(phrase) {
  const raw = String(phrase == null ? '' : phrase).trim().toLowerCase();
  if (!raw) return null;
  const names = [];
  for (let i = sessionLog.length - 1; i >= 0; i--) {
    const n = sessionLog[i].exercise;
    if (n && !names.includes(n)) names.push(n);
  }
  const sg = s => { const t = String(s || '').toLowerCase().trim(); return /[^s]s$/.test(t) ? t.slice(0, -1) : t; };
  const sraw = sg(raw);
  let hit = names.find(n => n.toLowerCase() === raw);
  if (!hit) hit = names.find(n => sg(n) === sraw);
  if (!hit) hit = names.find(n => { const v = sg(n); return v && (v.includes(sraw) || sraw.includes(v)); });
  if (!hit) {
    const pw = correctionWords(raw);
    hit = names.find(n => {
      const nw = correctionWords(n);
      if (pw.length >= 2) return pw.every(w => nw.some(cw => correctionWordEq(w, cw)));
      return pw.length === 1 && nw.length === 1 && correctionWordEq(pw[0], nw[0]);
    });
  }
  return hit || null;
}

function tryApplyIdentityCorrection(text) {
  const IC = (typeof window !== 'undefined' && window.identityCorrection) || null;
  if (!IC || !Array.isArray(sessionLog) || !sessionLog.length) return false; // nothing logged to correct
  const intent = IC.classifyIdentityCorrection(text);
  if (!intent) return false;
  // The lift being corrected: the "X is Y" form names it — resolve X against the
  // BUFFERED lift names, typo-tolerantly (owner live find 2026-07-03: "Sorry slslp
  // is single leg seated leg prep" must relabel the buffered Slslp group). The
  // legacy that-was form corrects the most-recently-logged lift, as before. An
  // "X is Y" whose X is not a buffered lift is NOT an identity correction — fall
  // through to the coach untouched.
  const oldName = intent.from
    ? resolveBufferedLiftName(intent.from)
    : sessionLog[sessionLog.length - 1].exercise;
  if (!oldName) return false;
  const resolved = resolveCatalogExercise(intent.to);
  // Only relabel to a phrase that resolves to a KNOWN name. Catalog tiers first
  // (exact/singular/unique-substring — an ordinary remark like "actually that was
  // tough" never names a real lift, PR-574 review); then the ≥2-word word-subset/
  // typo tier against plan + catalog names, so a typo'd correction still lands.
  const newName = (resolved.matched && resolved.name) || resolveCorrectionTargetName(intent.to);
  if (!newName) return false;
  if (oldName.toLowerCase() === newName.toLowerCase()) return false;
  if (intent.from) {
    // A name correction applies to the WHOLE mis-labeled group, wherever its sets
    // sit in the log — later sets of another lift don't shield it.
    for (let i = 0; i < sessionLog.length; i++) {
      if (sessionLog[i].exercise === oldName) sessionLog[i] = { ...sessionLog[i], exercise: newName };
    }
  } else {
    // The lift being corrected is the most-recently-logged one — relabel its
    // TRAILING contiguous run of sets (an earlier, separately-logged occurrence is
    // untouched).
    for (let i = sessionLog.length - 1; i >= 0 && sessionLog[i].exercise === oldName; i--) {
      sessionLog[i] = { ...sessionLog[i], exercise: newName };
    }
  }
  // Reconcile completion identity: drop the old resolved name iff no remaining set
  // still backs it, and ensure the new resolved name is present (in log order).
  const oldResolved = resolveCompletedIdentity(oldName);
  const newResolved = resolveCompletedIdentity(newName);
  const oldStillBacked = sessionLog.some(s => resolveCompletedIdentity(s.exercise) === oldResolved);
  if (!oldStillBacked) {
    const idx = sessionCompleted.indexOf(oldResolved);
    if (idx !== -1) sessionCompleted.splice(idx, 1);
  }
  if (!sessionCompleted.includes(newResolved)) sessionCompleted.push(newResolved);
  announceIdentityCorrection(oldName, newName);
  return true;
}

// Tell the coach layer a correction happened so it can confirm it (read-only
// narration; the engine owns the relabel). Mirrors announcePlanMutation.
function announceIdentityCorrection(fromName, toName) {
  renderActiveSessionBanner();
  document.dispatchEvent(new CustomEvent('atlas:identity-corrected', {
    detail: { from: fromName || '', to: toName || '' }
  }));
}

function renderActiveSessionBanner() {
  const banner = document.getElementById('active-session-banner');
  if (!banner) return;
  banner.innerHTML = '';
  if (!activePlannedSession) {
    banner.hidden = true;
    sessionChromeExpanded = false;
    document.body.classList.remove('session-active');
    return;
  }
  syncPlannedIndexToCanonical();
  const { label, exercises, index } = activePlannedSession;
  const current = exercises[index];
  if (!current) {
    banner.hidden = true;
    sessionChromeExpanded = false;
    document.body.classList.remove('session-active');
    return;
  }
  banner.appendChild(el('div', { class: 'active-session-title', text: `▶ ${label}` }));
  banner.appendChild(el('div', { class: 'active-session-step', text: `Step ${index + 1} of ${exercises.length}: ${current.name}` }));
  const row = el('div', { class: 'active-session-actions' });
  if (index < exercises.length - 1) {
    const nextBtn = el('button', { type: 'button', class: 'secondary', text: 'Next exercise →' });
    nextBtn.addEventListener('click', advancePlannedSession);
    row.appendChild(nextBtn);
  }
  const endBtn = el('button', { type: 'button', class: 'secondary', text: 'End session' });
  endBtn.addEventListener('click', endPlannedSession);
  row.appendChild(endBtn);
  banner.appendChild(row);
  // Collapsed by default (owner directive 2026-07-03): the card takes space
  // from the thread — the session pin is the always-visible row, and tapping
  // it expands this card. The glance strip steps aside for the session.
  document.body.classList.add('session-active');
  banner.hidden = !sessionChromeExpanded;
  // Plan engagement/mutation/restore all route through this render — the
  // session pin re-derives from the same canonical state at each of those
  // moments (composer-first Phase A).
  renderSessionPin();
}

// B2 canonical state — the plan-card banner renders its "current step" from
// activePlannedSession.index, but a logged set advances only the canonical session
// (sessionCompleted); the index cursor lags until "Next exercise →" is tapped. So
// the plan card would show a just-logged lift as still-current while the composer,
// next-up router, and save payload have already moved on. Reconcile the index
// forward to the canonical current (first unlogged planned lift) so the plan card
// derives from the SAME canonical session as every other surface. Forward-only —
// it never rewinds, so a deliberate swap-advance (Step 379) is never undone — and
// it never mutates the exercise list. No-op when the activeSession model is
// unavailable (the banner then falls back to the raw index cursor).
function syncPlannedIndexToCanonical() {
  if (!activePlannedSession || !Array.isArray(activePlannedSession.exercises)) return;
  const AS = (typeof window !== 'undefined' && window.activeSession) ||
             (typeof activeSession !== 'undefined' ? activeSession : null);
  if (!AS) return;
  const canon = getCanonicalSession();
  const cur = canon && AS.currentExercise(canon);
  if (!cur) return; // nothing pending (all logged/skipped) — leave the cursor as-is
  const key = String(cur.name || '').toLowerCase();
  const target = activePlannedSession.exercises.findIndex(
    e => (e.canonicalName || e.name || '').toLowerCase() === key
  );
  if (target > activePlannedSession.index) activePlannedSession.index = target;
}

function advancePlannedSession() {
  if (!activePlannedSession) return;
  pendingSubstitution = null;
  // Advance past the banner's current exercise. Two cases:
  // • Already logged (in sessionCompleted): just increment the cursor so the banner
  //   moves to the next slot. The canonical session already shows the next exercise
  //   because it derives "current" from the first-unlogged entry.
  // • Not logged (user clicked "Next" without logging): treat as skipped (absent) —
  //   splice it so the canonical session stays in sync with the banner position.
  const bannerCur = activePlannedSession.exercises[activePlannedSession.index];
  if (bannerCur) {
    const completedSet = new Set((sessionCompleted || []).map(c => String(c).toLowerCase()));
    const bannerKey = (bannerCur.canonicalName || bannerCur.name || '').toLowerCase();
    if (bannerKey && !completedSet.has(bannerKey)) {
      if (!skipPlannedExercise(bannerCur.canonicalName || bannerCur.name)) {
        if (activePlannedSession.index >= activePlannedSession.exercises.length - 1) { endPlannedSession(); return; }
        activePlannedSession.index += 1;
        renderActiveSessionBanner();
      }
      // skipPlannedExercise already called renderActiveSessionBanner if it spliced.
    } else {
      if (activePlannedSession.index >= activePlannedSession.exercises.length - 1) { endPlannedSession(); return; }
      activePlannedSession.index += 1;
      renderActiveSessionBanner();
    }
  }
  // Start the next exercise from the canonical session (first still-pending lift)
  // so the composer and plan queue are always derived from the same source.
  const next = currentPlannedExercise();
  if (!next) { endPlannedSession(); return; }
  startLift(next.canonicalName || next.name, next.liftCode, next.weight, next.reps, next.sets || 3);
}

function endPlannedSession() {
  // Step 385: advance the deload machine exactly once per session (not per write).
  // The deloadWritten flag is set in the approve handler on the first confirmed
  // live write; firing here instead of per-write keeps the session-count correct.
  if (activePlannedSession?.intentId === 'deload_reset' && activePlannedSession?.deloadWritten) {
    api('/api/deload/advance', { method: 'POST' })
      .then(r => {
        const state = r?.data?.state;
        if (state?.training_state === 'POST_DELOAD_EVALUATION') {
          api('/api/deload/resolve', { method: 'POST' }).catch(() => {});
        }
      })
      .catch(() => {});
  }
  activePlannedSession = null;
  pendingSubstitution = null;
  renderActiveSessionBanner();
}

function normalizePlanEditExercise(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return normalizePlanExercise({ exercise: raw });
  const ex = normalizePlanExercise({
    exercise: raw.name || raw.exercise,
    canonical_exercise: raw.canonicalName || raw.canonical_exercise || raw.name || raw.exercise,
    lift_code: raw.liftCode || raw.lift_code,
    target_weight: raw.weight,
    target_reps: raw.reps,
    target_sets: raw.sets,
    target_rir: raw.rir,
    reason: raw.rationale || raw.reason || ''
  });
  return ex && ex.name ? ex : null;
}

function matchesPlanEditName(ex, wanted) {
  const key = String(wanted || '').toLowerCase().trim();
  if (!key) return false;
  const names = [ex && ex.name, ex && ex.canonicalName].map(n => String(n || '').toLowerCase().trim()).filter(Boolean);
  return names.some(n => n === key || n.includes(key) || key.includes(n));
}

function clampActivePlanIndex() {
  if (!activePlannedSession || !Array.isArray(activePlannedSession.exercises)) return;
  if (!activePlannedSession.exercises.length) {
    endPlannedSession();
    return;
  }
  const max = activePlannedSession.exercises.length - 1;
  activePlannedSession.index = Math.max(0, Math.min(Number(activePlannedSession.index) || 0, max));
}

function ensureChatPlannedSession() {
  if (activePlannedSession && Array.isArray(activePlannedSession.exercises)) return activePlannedSession;
  activePlannedSession = {
    label: 'Coach plan',
    intentId: null,
    exercises: [],
    index: 0
  };
  pendingSubstitution = null;
  return activePlannedSession;
}

function applyProposedPlanEdit(edit) {
  if (!edit || typeof edit !== 'object' || !Array.isArray(edit.exercises)) return false;
  const action = edit.action;
  const exercises = edit.exercises.map(normalizePlanEditExercise).filter(ex => ex && ex.name);
  if (!exercises.length) return false;

  if (action === 'replace_plan') {
    activePlannedSession = {
      label: edit.label || 'Coach plan',
      intentId: null,
      exercises,
      index: 0
    };
    pendingSubstitution = null;
    sessionCompleted = [];
    renderActiveSessionBanner();
    return true;
  }

  if (action === 'add_exercises') {
    const session = ensureChatPlannedSession();
    const existing = new Set(session.exercises.map(ex => String(ex.canonicalName || ex.name || '').toLowerCase()));
    let changed = false;
    for (const ex of exercises) {
      const key = String(ex.canonicalName || ex.name || '').toLowerCase();
      if (!key || existing.has(key)) continue;
      session.exercises.push(ex);
      existing.add(key);
      changed = true;
    }
    if (changed) {
      clampActivePlanIndex();
      renderActiveSessionBanner();
    }
    return changed;
  }

  if (action === 'remove_exercises') {
    if (!activePlannedSession || !Array.isArray(activePlannedSession.exercises)) return false;
    const wanted = exercises.map(ex => ex.name).filter(Boolean);
    const before = activePlannedSession.exercises.length;
    activePlannedSession.exercises = activePlannedSession.exercises.filter(ex =>
      !wanted.some(name => matchesPlanEditName(ex, name))
    );
    const removed = activePlannedSession.exercises.length !== before;
    if (removed) {
      sessionCompleted = sessionCompleted.filter(done =>
        !wanted.some(name => {
          const key = String(name || '').toLowerCase();
          const d = String(done || '').toLowerCase();
          return key && (d === key || d.includes(key) || key.includes(d));
        })
      );
      clampActivePlanIndex();
      renderActiveSessionBanner();
    }
    return removed;
  }

  return false;
}

document.addEventListener('atlas:plan-edit-proposed', e => {
  const applied = applyProposedPlanEdit(e.detail && e.detail.edit);
  if (applied) {
    // Owner live find (2026-07-03): a chat-applied swap must follow through to
    // the composer exactly like the deterministic mutation lane — same signal,
    // EMPTY summary (the chat reply already narrates; no extra bubble), so the
    // placeholder re-points to the new current exercise.
    announcePlanMutation('', firstUnloggedPlannedLift());
  }
  if (e.detail && e.detail.result && typeof e.detail.result === 'object') e.detail.result.applied = applied;
  try {
    document.dispatchEvent(new CustomEvent('atlas:plan-edit-applied', {
      detail: { applied, edit: e.detail && e.detail.edit }
    }));
  } catch { /* diagnostic event is optional */ }
});

// Open the recommended workout — Composer-first Phase B: routes to the ONE
// canonical in-thread Coach's Pick (which does its own read-only fetch and
// degrades gracefully), no longer a second drawer rendering of the same pick.
// eslint-disable-next-line no-unused-vars -- global export consumed by other browser scripts; Phase 1 PR-08/09
function openTodaySessionPlan() {
  openCoachPickInThread();
}

// Phrases that ask for the recommended workout rather than logging a set.
// Workout shorthand always carries numbers, so any digit rules a phrase out —
// this keeps "Bench 225 5/2 x3" on the normal parse/preview path.
function looksLikeSessionRequest(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || /\d/.test(t)) return false;
  return /\b(recommended (workout|session)|what should i train|what are we doing|today'?s plan|what'?s the plan|what (workout|session) (would|do|should|can) you (suggest|recommend)|(suggest|recommend) (a |an |me |today'?s )?(\w+ )?(workout|session)|do (my|the|your) (workout|session)|let'?s (do|start|run) (it|this|the workout|my workout|the session|your recommended workout))\b/.test(t);
}

// Composer-first Phase B2: phrases that ask to SEE a stored artifact — the
// last session or the weekly report. These render the existing read-only
// in-thread artifact (nav.js renderers) deterministically instead of falling
// through to the LLM chat. Any digit rules a phrase out, so workout shorthand
// ("Bench 225 5/2") can never be swallowed by an artifact render. Returns the
// artifact kind ('last_session' | 'weekly_report') or false.
function looksLikeArtifactRequest(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || /\d/.test(t)) return false;
  if (/\b(show|see|pull up|open|view)\b[^?.!]*\blast (session|workout)\b/.test(t) ||
      /\bwhat did i do\b[^?.!]*\blast (time|session|workout)\b/.test(t) ||
      /^\s*(my )?last (session|workout)\??\s*$/.test(t)) {
    return 'last_session';
  }
  if (/\b(weekly (report|summary)|(show|see|view)\b[^?.!]*\b(my|this) week|this week'?s (report|summary|training)|how (was|did) (my|the) week)\b/.test(t)) {
    return 'weekly_report';
  }
  return false;
}

function looksLikeCorrection(text) {
  const t = String(text || '').trim().toLowerCase();
  return /\b(actually[,. ]|i was wrong|that'?s wrong|correction[,: ]|meant to (say|log|write|do)\b|should have been|that was wrong|i meant\b|wrong (weight|reps|sets|exercise)|oops[,. ]|my mistake|i made a mistake)\b/.test(t);
}

// End-of-session compilation trigger: the lifter has been logging sets
// conversationally and now wants Atlas to compile them into one preview.
function looksLikeLogIt(text) {
  // Accept straight or curly apostrophes — mobile keyboards autocorrect to curly.
  // An OPTIONAL leading closeout-acknowledgment ("done," / "ok" / "that's it" /
  // "finished") may precede the core phrase, so natural combined commands like
  // "Done, log it." / "that's it, log it" / "ok done log it" still close out (live-gym
  // v49: "Done, log it." was wrongly routed to the coach). The whole string must still
  // match end-to-end and must not end in "?" — a question ("should I log it?") never
  // closes out.
  const t = String(text || '');
  if (/\?\s*$/.test(t)) return false;
  return /^\s*(?:(?:ok(?:ay)?|alright|cool|great|sweet|nice|yep|yeah|done|finished|that['’]?s\s+(?:it|all)|we['’]?re?\s+done)[,.\s]+){0,2}(log\s+it|log\s+that|log\s+the\s+session|log\s+this\s+session|log\s+this\s+workout|save\s+the\s+session|save\s+it|ok\s+log\s+it|alright\s+log\s+it|compile\s+(the\s+)?session|that['’]?s?\s+all|that['’]?s\s+it(\s+for\s+(today|now))?|we['’]?re?\s+done(\s+logging)?|done(\s+for\s+today)?|finish(\s+session)?|end\s+(the\s+)?session)\s*[.!]?\s*$/i.test(t);
}

function showCorrectionPrompt(capturedText) {
  const thread = document.getElementById('thread-messages');
  if (!thread) return;

  const bubble = el('div', { class: 'chat-bubble chat-bubble-atlas correction-prompt' });
  bubble.appendChild(el('div', { text: "Looks like you’re correcting the last saved session. What would you like to do?" }));

  const actions = el('div', { class: 'correction-actions' });

  const replaceBtn = el('button', { class: 'approve correction-replace-btn', type: 'button', text: 'Replace last saved session' });
  replaceBtn.addEventListener('click', async () => {
    bubble.remove();
    await handleUndoLastWrite();
    workoutTextInput.value = capturedText;
    workoutTextInput.focus();
  });

  const newBtn = el('button', { class: 'secondary correction-new-btn', type: 'button', text: 'Log as new session' });
  newBtn.addEventListener('click', () => {
    bubble.remove();
    lastWrite = null;
    workoutTextInput.value = capturedText;
    document.getElementById('logger-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  const cancelBtn = el('button', { class: 'secondary correction-cancel-btn', type: 'button', text: 'Cancel' });
  cancelBtn.addEventListener('click', () => bubble.remove());

  actions.appendChild(replaceBtn);
  actions.appendChild(newBtn);
  actions.appendChild(cancelBtn);
  bubble.appendChild(actions);
  thread.appendChild(bubble);
  bubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function openIntentDrawer(intent) {
  const drawer = document.getElementById('intent-drawer');
  const content = document.getElementById('intent-drawer-content');
  if (!drawer || !content) return;

  content.innerHTML = '';

  content.appendChild(el('h2', { class: 'drawer-title', text: intent.label }));
  if (intent.recommended) {
    content.appendChild(el('span', { class: 'drawer-recommended-badge', text: 'Recommended for today' }));
  }

  // Glance layer: at most two plain "why" lines, then the workout itself.
  if (intent.why_today && intent.why_today.length) {
    content.appendChild(el('h3', { class: 'drawer-section-title', text: 'Why today' }));
    content.appendChild(el('ul', { class: 'drawer-list' }, intent.why_today.slice(0, 2).map(w => el('li', { text: w }))));
  }

  // Everything analytical folds behind one tap — the data is all still there.
  const moreSections = [];
  if (intent.why_today && intent.why_today.length > 2) {
    moreSections.push(['More reasons', intent.why_today.slice(2)]);
  }
  if (intent.data_points && intent.data_points.length) moreSections.push(['The numbers behind this', intent.data_points]);
  if (intent.what_it_protects && intent.what_it_protects.length) moreSections.push(['What it protects', intent.what_it_protects]);
  if (intent.watch_for && intent.watch_for.length) moreSections.push(['Watch for', intent.watch_for]);
  if (intent.pivot_logic && intent.pivot_logic.length) moreSections.push(['If something feels off', intent.pivot_logic]);
  if (moreSections.length) {
    const fold = el('details', { class: 'drawer-more' });
    fold.appendChild(el('summary', { text: 'More detail' }));
    for (const [title, items] of moreSections) {
      fold.appendChild(el('h3', { class: 'drawer-section-title', text: title }));
      fold.appendChild(el('ul', { class: 'drawer-list' }, items.map(item => el('li', { text: item }))));
    }
    content.appendChild(fold);
  }

  if (intent.exercises && intent.exercises.length) {
    content.appendChild(el('h3', { class: 'drawer-section-title', text: 'Exercises' }));
    const exList = el('div', { class: 'drawer-exercises' });
    for (const raw of intent.exercises) {
      const ex = normalizePlanExercise(raw);
      const nameEl = el('span', { class: 'drawer-exercise-name', text: ex.name });
      const targetEl = ex.weight != null
        ? el('span', { class: 'drawer-exercise-target', text: `${ex.weight} × ${ex.reps}${ex.sets ? ` × ${ex.sets}` : ''}` })
        : el('span', { class: 'drawer-exercise-target muted', text: 'best effort' });
      exList.appendChild(el('div', { class: 'drawer-exercise-row' }, [nameEl, targetEl]));
      if (ex.reason) exList.appendChild(el('div', { class: 'drawer-exercise-reason', text: ex.reason }));
      // P0 AC12: surface the barbell loadability note (server-snapped target) so the
      // lifter sees why the weight was nudged to a loadable plate total.
      if (raw && raw.loadability_note) exList.appendChild(el('div', { class: 'drawer-exercise-reason muted', text: raw.loadability_note }));
    }
    content.appendChild(exList);

    const firstEx = normalizePlanExercise(intent.exercises[0]);
    if (firstEx.name) {
      const actionRow = el('div', { class: 'drawer-action-row' });
      // Start Session begins the guided in-memory session; Modify Plan just
      // drops into the logger on the first lift (via startLift), editable.
      const startBtn = el('button', { type: 'button', class: 'approve intent-start-btn', text: 'Start Session' });
      startBtn.addEventListener('click', () => {
        closeIntentDrawer();
        startPlannedSession(intent);
      });
      const modifyBtn = el('button', { type: 'button', class: 'secondary intent-modify-btn', text: 'Modify Plan' });
      modifyBtn.addEventListener('click', () => {
        closeIntentDrawer();
        startLift(firstEx.name, firstEx.liftCode, firstEx.weight, firstEx.reps, firstEx.sets || 3);
      });
      actionRow.appendChild(startBtn);
      actionRow.appendChild(modifyBtn);
      content.appendChild(actionRow);
    }
  }

  drawer.hidden = false;
  const panel = drawer.querySelector('.intent-drawer-panel');
  if (panel) panel.scrollTop = 0;
}

function closeIntentDrawer() {
  const drawer = document.getElementById('intent-drawer');
  if (drawer) drawer.hidden = true;
}

// eslint-disable-next-line no-unused-vars -- global export consumed by other browser scripts; Phase 1 PR-08/09
async function loadTodaysPlan() {
  const box = document.getElementById('todays-plan');
  try {
    const res = await api('/api/plan/today');
    const recs = res.data?.recommendations || [];
    box.innerHTML = '';

    box.appendChild(el('p', { class: 'muted small mb-8', text: 'Tap any card to start that lift. These are progression targets, not a required order.' }));

    if (!recs.length) {
      box.appendChild(el('p', { class: 'muted', text: 'Log a few sessions and Atlas can start giving better suggestions.' }));
      return;
    }

    const grid = el('div', { class: 'plan-grid' });
    for (const r of recs) {
      const t = r.next_target;
      const confidenceClass = r.confidence === 'high' ? 'plan-card-high' : r.confidence === 'medium' ? 'plan-card-medium' : 'plan-card-low';
      const exerciseName = r.exercise_name || r.liftCode;
      const card = el('div', { class: `plan-card ${confidenceClass} plan-card-startable` }, [
        el('div', { class: 'plan-card-lift' }, [
          el('span', { class: 'plan-card-lift-name', text: exerciseName })
        ]),
        el('div', { class: 'plan-card-target', text: `${t.weight} × ${t.reps}` }),
        el('div', { class: 'plan-card-sets', text: `${t.sets} sets` }),
        el('div', { class: 'plan-card-rec', text: r.recommendation }),
        el('div', { class: 'plan-card-footer' }, [
          el('span', { class: 'plan-card-tap-hint', text: 'Tap to start' }),
          el('a', { class: 'lift-link plan-card-progress-link', href: '#', 'data-lift': r.liftCode, text: 'View progress' })
        ])
      ]);
      card.addEventListener('click', e => {
        if (e.target.closest('.lift-link')) return;
        startLift(exerciseName, r.liftCode, t.weight, t.reps, t.sets);
      });
      grid.appendChild(card);
    }
    box.appendChild(grid);
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

// One friendly line in the glance row so the data is digestible without opening.
function setGlanceHint(id, text) {
  const hint = document.getElementById(id);
  if (hint) hint.textContent = text || '';
}

async function loadCoaching() {
  const box = document.getElementById('coaching');
  try {
    const res = await api('/api/coaching/insights');
    const data = res.data || {};
    box.innerHTML = '';

    const fatigue = data.fatigue || {};
    setGlanceHint('coaching-hint', fatigue.status === 'high' ? 'Ease off a touch this week' : 'On track ✓');
    const fatigueClass = fatigue.status === 'high' ? 'preview-warnings' : 'preview-ok';
    box.appendChild(el('div', { class: fatigueClass }, [
      el('strong', { text: `Fatigue: ${fatigue.status || 'unknown'}` }),
      el('span', { text: fatigue.ratio !== null && fatigue.ratio !== undefined ? ` (this week is ${fatigue.ratio}× your recent weekly average)` : '' }),
      el('p', { text: fatigue.guidance || '' })
    ]));

    const deloads = data.deload_suggestions || [];
    if (deloads.length) {
      box.appendChild(el('h3', { text: 'Deload suggestions' }));
      box.appendChild(el('ul', {}, deloads.map(d => {
        // Show the exercise name to the lifter; the lift code stays in data-lift
        // purely as the click-through target (it's for data sorting, not display).
        // Exception: code-less log rows group under the synthetic 'UNKNOWN' code,
        // whose progress view is empty — keep the code visible there rather than
        // label it with a name the link can't actually navigate to.
        const label = (d.liftCode === 'UNKNOWN') ? d.liftCode : (d.exercise || d.liftCode);
        const li = el('li', {}, [
          el('a', { class: 'lift-link', href: '#', 'data-lift': d.liftCode, text: label }),
          document.createTextNode(`: ${d.suggestion}`)
        ]);
        return li;
      })));
    } else {
      box.appendChild(el('p', { class: 'muted', text: 'No deloads needed — no lift has been stalled 4+ sessions.' }));
    }
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

async function loadWeeklySummary() {
  const box = document.getElementById('weekly-summary');
  try {
    const res = await api('/api/summary/weekly');
    const data = res.data || {};
    box.innerHTML = '';
    const highlights = data.highlights || [];
    setGlanceHint('weekly-summary-hint', highlights.length ? highlights[0] : 'No sessions yet this week');
    if (!highlights.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No training logged in the last 7 days.' }));
      return;
    }
    box.appendChild(el('ul', {}, highlights.map(h => el('li', { text: h }))));

    const breakdown = Object.entries(data.muscleGroupBreakdown || {})
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    if (breakdown.length) {
      box.appendChild(el('h3', { text: 'Volume by muscle group' }));
      box.appendChild(svgBarChart(breakdown, { label: 'Weekly volume by muscle group' }));
    }
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

async function loadRecentHistory() {
  const box = document.getElementById('recent-history');
  try {
    const res = await api('/api/history/recent?limit=10');
    const sets = res.data?.recent_sets || [];
    box.innerHTML = '';
    setGlanceHint('recent-history-hint', sets.length ? `Last: ${sets[0].exercise} · ${sets[0].date_clean}` : 'Nothing logged yet');
    if (!sets.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No recent sets.' }));
      return;
    }
    box.appendChild(renderTable(
      ['Exercise', 'Set', 'Weight', 'Reps', 'RIR'],
      sets.map(s => [s.exercise, s.set_number, s.weight, s.reps, s.rir])
    ));
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

async function loadRecentPrs() {
  const box = document.getElementById('recent-prs');
  try {
    const res = await api('/api/prs/recent');
    const prs = res.data?.prs || [];
    box.innerHTML = '';
    setGlanceHint('recent-prs-hint', prs.length ? `${prs.length} personal best${prs.length === 1 ? '' : 's'} 🎉` : 'Your bests will land here');
    if (!prs.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No PRs recorded yet.' }));
      return;
    }
    box.appendChild(renderTable(
      ['Lift', 'Best weight', 'Best reps', 'Best est. 1RM'],
      prs.map(pr => [
        pr.exercise || pr.liftCode,
        pr.bestWeightSet ? `${formatSetLoad(pr.bestWeightSet.weight, pr.bestWeightSet.reps)} (${pr.bestWeightSet.date_clean})` : '—',
        pr.bestRepSet ? `${formatSetLoad(pr.bestRepSet.weight, pr.bestRepSet.reps)} (${pr.bestRepSet.date_clean})` : '—',
        pr.bestEstimated1RMSet ? `${pr.bestEstimated1RMSet.estimated_1rm} (${pr.bestEstimated1RMSet.date_clean})` : '—'
      ])
    ));
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

async function loadStalls() {
  const box = document.getElementById('stalls');
  try {
    const res = await api('/api/stalls?minSessions=3');
    const stalls = res.data?.stalls || [];
    box.innerHTML = '';
    setGlanceHint('stalls-hint', stalls.length ? `${stalls.length} lift${stalls.length === 1 ? '' : 's'} could use a change` : 'All clear ✓');
    if (!stalls.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No stalled lifts — keep it up.' }));
      return;
    }
    const table = el('table', {});
    const thead = el('thead', {}, el('tr', {}, ['Lift', 'Sessions stalled', 'Last best weight', 'Since'].map(h => el('th', { text: h }))));
    const tbody = el('tbody', {}, stalls.map(s => el('tr', {}, [
      el('td', {}, el('a', { class: 'lift-link', href: '#', 'data-lift': s.liftCode, text: s.exercise || s.liftCode })),
      el('td', { text: String(s.sessions_stalled) }),
      el('td', { text: String(s.last_best_weight) }),
      el('td', { text: String(s.first_session_date) })
    ])));
    table.appendChild(thead);
    table.appendChild(tbody);
    box.appendChild(table);
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

/* ===== Progress ===== */

document.getElementById('progress-form').addEventListener('submit', async e => {
  e.preventDefault();
  const liftCode = document.getElementById('progress-lift-code').value.trim();
  const resultBox = document.getElementById('progress-result');
  const recBox = document.getElementById('recommendation-result');
  resultBox.innerHTML = '<span class="muted">Loading…</span>';
  recBox.innerHTML = '<span class="muted">Loading…</span>';

  try {
    const res = await api(`/api/exercises/${encodeURIComponent(liftCode)}/progress`);
    const data = res.data || {};
    resultBox.innerHTML = '';

    const trendPill = el('span', { class: `pill ${data.recent_trend}`, text: `trend: ${data.recent_trend}` });
    resultBox.appendChild(el('p', {}, [`${data.sessions?.length || 0} sessions for ${data.liftCode}`, trendPill]));

    const weights = data.best_weight_over_time || [];
    if (weights.length) {
      const oneRms = data.estimated_1rm_over_time || [];
      const volumes = data.volume_over_time || [];

      resultBox.appendChild(el('h3', { text: 'Best weight over time' }));
      resultBox.appendChild(svgLineChart(
        weights.map(w => ({ x: w.date, y: w.best_weight })),
        { label: 'Best weight over time' }
      ));
      resultBox.appendChild(el('h3', { text: 'Estimated 1RM over time' }));
      resultBox.appendChild(svgLineChart(
        oneRms.map(r => ({ x: r.date, y: r.estimated_1rm })),
        { color: '#16a34a', label: 'Estimated 1RM over time' }
      ));

      resultBox.appendChild(el('h3', { text: 'Session detail' }));
      resultBox.appendChild(renderTable(
        ['Date', 'Session', 'Best weight', 'Est. 1RM', 'Volume'],
        weights.map((w, i) => [w.date, w.session_id, w.best_weight, oneRms[i]?.estimated_1rm ?? '', volumes[i]?.volume ?? ''])
      ));
    } else {
      resultBox.appendChild(el('span', { class: 'muted', text: 'No working sets found for this lift code.' }));
    }
  } catch (err) {
    resultBox.textContent = '';
    resultBox.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }

  try {
    const res = await api(`/api/recommend/next/${encodeURIComponent(liftCode)}`);
    const data = res.data || {};
    recBox.innerHTML = '';

    if (data.next_target) {
      const t = data.next_target;
      const confidenceClass = data.confidence === 'high' ? 'ok' : data.confidence === 'medium' ? 'warn' : 'muted';
      recBox.appendChild(el('div', { class: 'next-target-card' }, [
        el('div', { class: 'next-target-weight', text: `${t.weight}` }),
        el('div', { class: 'next-target-meta', text: `× ${t.reps} reps · ${t.sets} sets` })
      ]));
      recBox.appendChild(el('p', { text: data.recommendation }));
      recBox.appendChild(el('p', { class: 'muted', text: data.reasoning }));
      const meta = [
        data.sessions_analyzed ? `${data.sessions_analyzed} sessions analyzed` : '',
        data.e1rm_trend ? `e1RM trend: ${data.e1rm_trend}` : '',
        data.confidence ? `confidence: ${data.confidence}` : ''
      ].filter(Boolean).join('  ·  ');
      if (meta) recBox.appendChild(el('p', { class: `muted small ${confidenceClass}`, text: meta }));
    } else {
      recBox.appendChild(el('p', { text: data.recommendation || '' }));
      recBox.appendChild(el('p', { class: 'muted', text: data.reasoning || '' }));
    }

    const rd = data.rule_decision;
    if (rd && rd.decision !== 'no_data' && rd.reasoning) {
      recBox.appendChild(el('p', { class: 'small muted', text: rd.reasoning }));
    }
  } catch (err) {
    recBox.textContent = '';
    recBox.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
});

/* ===== Progress lift list (name-based) ===== */

// Cache the lift list so repeated tab visits don't re-fetch until a new session.
let liftListCache = null;
// Trends: per-lift dated e1RM/best-weight series + the selected timeframe. The
// Week/Month/YTD/All selector recomputes %/sparkline/counts from this cache —
// switching periods never re-fetches, and there is no new API.
let trendsLiftData = null;
let trendsFrame = 'all';

const TREND_FRAME_CAP = { week: 'vs last week', month: 'vs last month', ytd: 'year to date', all: 'vs all time' };

function trendFrameStartTs(frame) {
  const now = new Date();
  if (frame === 'week') return now.getTime() - 7 * 86400000;
  if (frame === 'month') return now.getTime() - 30 * 86400000;
  if (frame === 'ytd') return new Date(now.getFullYear(), 0, 1).getTime();
  return -Infinity; // all time
}

// Zip the two dated arrays from /api/exercises/:liftCode/progress into one
// chronological series of { date, e1rm, weight } per session.
function buildLiftSeries(rec, prog) {
  const byKey = new Map();
  for (const p of (prog.estimated_1rm_over_time || [])) {
    byKey.set(`${p.date}|${p.session_id}`, { date: p.date, e1rm: Number(p.estimated_1rm) || 0, weight: 0 });
  }
  for (const p of (prog.best_weight_over_time || [])) {
    const k = `${p.date}|${p.session_id}`;
    const entry = byKey.get(k) || { date: p.date, e1rm: 0, weight: 0 };
    entry.weight = Number(p.best_weight) || 0;
    byKey.set(k, entry);
  }
  const series = Array.from(byKey.values())
    .filter(p => p.e1rm > 0 || p.weight > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { liftCode: rec.liftCode, name: rec.exercise_name || rec.liftCode, series };
}

// Real per-period stats: baseline is the value entering the period (the last
// session before the period start, else the first ever), so % is honest even
// when only one session falls inside the window.
function trendStats(series, frame) {
  if (!series.length) return null;
  const latest = series[series.length - 1];
  const startTs = trendFrameStartTs(frame);
  let baselineIdx = 0;
  for (let i = 0; i < series.length; i++) {
    if (Date.parse(series[i].date) < startTs) baselineIdx = i;
    else break;
  }
  const baseline = series[baselineIdx];
  const baseVal = baseline.e1rm || baseline.weight || 0;
  const lastVal = latest.e1rm || latest.weight || 0;
  const pct = baseVal > 0 ? Math.round(((lastVal - baseVal) / baseVal) * 100) : 0;
  const status = pct >= 2 ? 'up' : (pct <= -1 ? 'stall' : 'hold');
  const periodSlice = series.slice(baselineIdx).map(p => p.e1rm || p.weight || 0);
  const sparkVals = periodSlice.length >= 2
    ? periodSlice.slice(-10)
    : series.slice(-Math.min(8, series.length)).map(p => p.e1rm || p.weight || 0);
  return { weight: latest.weight, e1rm: Math.round(lastVal), pct, status, sparkVals };
}

function trendSparklineSvg(values, status) {
  const w = 68, h = 22, pad = 3;
  if (!values || !values.length) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const range = (max - min) || 1;
  const n = values.length;
  const xy = values.map((v, i) => {
    const x = n === 1 ? (w - pad) : (pad + i * (w - 2 * pad) / (n - 1));
    const y = h - pad - ((v - min) / range) * (h - 2 * pad);
    return [x, y];
  });
  const pts = xy.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const last = xy[xy.length - 1];
  return `<svg class="spark spark-${status}" width="68" height="22" viewBox="0 0 68 22" aria-hidden="true">`
    + `<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="currentColor"/></svg>`;
}

function trendPctText(pct) {
  if (pct > 0) return `▲${pct}%`;
  if (pct < 0) return `▼${Math.abs(pct)}%`;
  return 'even';
}

function fmtLiftWeight(weight) {
  return weight > 0 ? `${Math.round(weight)} lb` : '—';
}

function buildTrendRow(lift, st) {
  const read = el('span', { class: 'trend-read' }, [
    el('b', { text: fmtLiftWeight(st.weight) }),
    document.createTextNode(' · '),
    document.createTextNode(`e1RM ${st.e1rm}`),
    document.createTextNode(' · '),
    el('span', { class: `trend-pct trend-${st.status}`, text: trendPctText(st.pct) })
  ]);
  const spark = el('span', { class: 'trend-spark' });
  spark.innerHTML = trendSparklineSvg(st.sparkVals, st.status);
  const row = el('button', { type: 'button', class: 'trend-row' }, [
    el('span', { class: 'trend-name', text: lift.name }),
    el('span', { class: 'trend-l2' }, [read, spark])
  ]);
  row.addEventListener('click', () => openLiftDrillDown(lift.name, lift.liftCode));
  return row;
}

function trendGlanceItem(kind, n, label) {
  return el('div', { class: 'trend-glance-item' }, [
    el('span', { class: `trend-pip trend-pip-${kind}` }),
    el('b', { text: String(n) }),
    document.createTextNode(` ${label}`)
  ]);
}

function renderTrends(frame) {
  trendsFrame = frame;
  const box = document.getElementById('lift-list-result');
  const glance = document.getElementById('trends-glance');
  const cap = document.getElementById('trends-cap');
  const frameEl = document.getElementById('trends-frame');
  if (!box) return;
  if (cap) cap.textContent = TREND_FRAME_CAP[frame] || '';
  if (frameEl) {
    for (const b of frameEl.children) {
      const on = b.dataset.frame === frame;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
  }

  box.innerHTML = '';
  if (glance) glance.innerHTML = '';
  if (!trendsLiftData || !trendsLiftData.length) {
    box.appendChild(el('p', { class: 'muted', text: 'Log a few sessions and Atlas will list your lifts here.' }));
    return;
  }

  let up = 0, hold = 0, stall = 0;
  const list = el('div', { class: 'trend-list' });
  for (const lift of trendsLiftData) {
    const st = trendStats(lift.series, frame);
    if (!st) continue;
    if (st.status === 'up') up++; else if (st.status === 'hold') hold++; else stall++;
    list.appendChild(buildTrendRow(lift, st));
  }
  if (glance) {
    glance.appendChild(trendGlanceItem('up', up, 'climbing'));
    glance.appendChild(trendGlanceItem('hold', hold, 'holding'));
    glance.appendChild(trendGlanceItem('stall', stall, 'to fix'));
  }
  box.appendChild(list);
}

async function loadProgressLiftList() {
  const card = document.getElementById('lift-list-card');
  const resultBox = document.getElementById('lift-list-result');
  if (!card) return;

  // Show the lift list, hide the drill-down.
  card.hidden = false;
  const drillCard = document.getElementById('lift-drilldown-card');
  if (drillCard) drillCard.hidden = true;

  if (!getApiKey()) {
    resultBox.innerHTML = '<span class="muted">Set your API key in Settings to see your lifts.</span>';
    return;
  }

  // Re-render from cache (within the same page load); period switches never re-fetch.
  if (trendsLiftData) {
    renderTrends(trendsFrame);
    return;
  }

  resultBox.innerHTML = '<span class="muted">Loading your lifts…</span>';
  try {
    const res = await api('/api/plan/today');
    const recs = res.data?.recommendations || [];
    liftListCache = recs; // kept for the .lift-link name lookup
    if (!recs.length) {
      trendsLiftData = [];
      renderTrends(trendsFrame);
      return;
    }
    // Fan out: the dated e1RM / best-weight series per lift (existing read endpoint).
    const settled = await Promise.allSettled(
      recs.map(r => api(`/api/exercises/${encodeURIComponent(r.liftCode)}/progress`)
        .then(pr => ({ rec: r, prog: pr.data || {} })))
    );
    trendsLiftData = settled
      .filter(s => s.status === 'fulfilled')
      .map(s => buildLiftSeries(s.value.rec, s.value.prog))
      .filter(l => l.series.length);
    renderTrends(trendsFrame);
  } catch (err) {
    resultBox.textContent = '';
    resultBox.appendChild(el('span', { class: 'muted', text: `Could not load lifts: ${err.message}` }));
  }
}

// Timeframe selector — recomputes from cache, no re-fetch.
document.getElementById('trends-frame')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-frame]');
  if (btn) renderTrends(btn.dataset.frame);
});

async function openLiftDrillDown(exerciseName, liftCode) {
  const listCard = document.getElementById('lift-list-card');
  const drillCard = document.getElementById('lift-drilldown-card');
  const titleEl = document.getElementById('lift-drilldown-title');
  const contentEl = document.getElementById('lift-drilldown-content');
  if (!drillCard || !contentEl) return;

  // Switch cards
  if (listCard) listCard.hidden = true;
  drillCard.hidden = false;
  if (titleEl) titleEl.textContent = exerciseName;
  contentEl.innerHTML = '<span class="muted">Loading…</span>';

  // Fire all three endpoints in parallel.
  const [progressResult, detailResult, recResult] = await Promise.allSettled([
    api(`/api/exercises/${encodeURIComponent(liftCode)}/progress`),
    api(`/api/exercises/${encodeURIComponent(liftCode)}/detail`),
    api(`/api/recommend/next/${encodeURIComponent(liftCode)}`)
  ]);

  contentEl.innerHTML = '';

  // ── Recommendation (next target) ──
  if (recResult.status === 'fulfilled') {
    const rec = recResult.value.data || {};
    if (rec.next_target) {
      const t = rec.next_target;
      contentEl.appendChild(el('div', { class: 'next-target-card' }, [
        el('div', { class: 'next-target-weight', text: `${t.weight}` }),
        el('div', { class: 'next-target-meta', text: `× ${t.reps} reps · ${t.sets} sets` })
      ]));
      contentEl.appendChild(el('p', { text: rec.recommendation || '' }));
      contentEl.appendChild(el('p', { class: 'muted', text: rec.reasoning || '' }));
      const rd = rec.rule_decision;
      if (rd && rd.decision !== 'no_data' && rd.reasoning) {
        contentEl.appendChild(el('p', { class: 'small muted', text: rd.reasoning }));
      }
    } else if (rec.recommendation) {
      contentEl.appendChild(el('p', { text: rec.recommendation }));
      contentEl.appendChild(el('p', { class: 'muted', text: rec.reasoning || '' }));
    }
  } else {
    contentEl.appendChild(el('p', { class: 'muted small', text: 'Could not load recommendation.' }));
  }

  // ── Progress chart first (so you see the trend before the raw numbers) ──
  if (progressResult.status === 'fulfilled') {
    const p = progressResult.value.data || {};
    const weights = p.best_weight_over_time || [];
    if (weights.length >= 2) {
      const oneRms = p.estimated_1rm_over_time || [];
      contentEl.appendChild(el('h3', { text: 'Best weight over time' }));
      contentEl.appendChild(svgLineChart(
        weights.map(w => ({ x: w.date, y: w.best_weight })),
        { label: 'Best weight over time' }
      ));
      if (oneRms.length >= 2) {
        contentEl.appendChild(el('h3', { text: 'Estimated 1RM over time' }));
        contentEl.appendChild(svgLineChart(
          oneRms.map(r => ({ x: r.date, y: r.estimated_1rm })),
          { color: '#16a34a', label: 'Estimated 1RM over time' }
        ));
      }
    }
  }

  // ── Detail (last sessions table below the chart for context) ──
  if (detailResult.status === 'fulfilled') {
    const d = detailResult.value.data || {};
    if (d.sessions_count) {
      if (d.best_recent_set) {
        const s = d.best_recent_set;
        const setText = s.rir != null ? `${formatSetLoad(s.weight, s.reps)} @${s.rir}` : formatSetLoad(s.weight, s.reps);
        contentEl.appendChild(el('p', { class: 'small muted', text: `Best recent set (30 days): ${setText} on ${s.date}` }));
      }
      if (d.last_sessions && d.last_sessions.length) {
        contentEl.appendChild(el('h3', { text: 'Last sessions' }));
        contentEl.appendChild(renderTable(
          ['Date', 'Best weight', 'Est. 1RM', 'Sets'],
          d.last_sessions.map(s => [s.date, s.best_weight ?? '—', s.estimated_1rm ?? '—', s.sets])
        ));
      }
    }
  }

  if (!contentEl.children.length) {
    contentEl.appendChild(el('p', { class: 'muted', text: 'No data found for this lift yet.' }));
  }
}

document.getElementById('lift-drilldown-back')?.addEventListener('click', () => {
  const drillCard = document.getElementById('lift-drilldown-card');
  if (drillCard) drillCard.hidden = true;
  // loadProgressLiftList shows the list card and populates it (uses cache if available).
  loadProgressLiftList();
});

/* ===== Weekly Report ===== */

document.getElementById('weekly-report-btn').addEventListener('click', async () => {
  const box = document.getElementById('weekly-report-result');
  const btn = document.getElementById('weekly-report-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  box.innerHTML = '<span class="muted">Loading…</span>';
  try {
    const res = await api('/api/report/weekly');
    const data = res.data || {};
    box.innerHTML = '';
    if (data.summary_markdown) {
      box.appendChild(el('pre', { class: 'summary-pre' }, [data.summary_markdown]));
    }
    if (data.prs && data.prs.length) {
      box.appendChild(el('h3', { text: 'Improvements this week' }));
      box.appendChild(renderTable(
        ['Lift', 'Prior best', 'This week'],
        data.prs.map(p => [p.exercise || p.lift_code, `${p.prev_best} lb`, `${p.this_week_best} lb`])
      ));
    }
    if (data.stalls_or_watchouts && data.stalls_or_watchouts.length) {
      box.appendChild(el('h3', { text: 'Watchouts' }));
      box.appendChild(renderTable(
        ['Lift', 'Sessions stalled', 'Last best'],
        data.stalls_or_watchouts.map(s => [s.exercise || s.liftCode, s.sessions_stalled, `${s.last_best_weight} lb`])
      ));
    }
    if (!data.sessions_count) {
      box.appendChild(el('p', { class: 'muted', text: 'No training data logged in this period.' }));
    }
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load weekly report';
  }
});

/* ===== Lift-link navigation (dashboard → progress) ===== */

document.addEventListener('click', e => {
  const link = e.target.closest('.lift-link');
  if (!link) return;
  e.preventDefault();
  const liftCode = link.dataset.lift;
  if (!liftCode) return;
  // Switch to Progress tab (surface switch if needed)
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const progressBtn = document.querySelector('[data-tab="progress"]');
  if (progressBtn) progressBtn.classList.add('active');
  const progressTab = document.getElementById('tab-progress');
  if (progressTab) progressTab.classList.add('active');
  // Pre-fill the hidden legacy form (keeps existing event handler bindings
  // working if anything dispatches submit directly on it).
  const liftInput = document.getElementById('progress-lift-code');
  if (liftInput) liftInput.value = liftCode;
  // Determine exercise name for the drill-down title.
  // Try the lift-list cache first, then fall back to liftCode itself.
  const cached = (liftListCache || []).find(r => r.liftCode === liftCode);
  const exerciseName = cached?.exercise_name || link.dataset.exerciseName || liftCode;
  openLiftDrillDown(exerciseName, liftCode);
});

/* ===== Catalog search ===== */

document.getElementById('catalog-search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = document.getElementById('catalog-search-q').value.trim();
  const box = document.getElementById('catalog-search-result');
  if (!q) return;
  box.innerHTML = '<span class="muted">Searching…</span>';
  try {
    const res = await api(`/api/catalog/search?q=${encodeURIComponent(q)}`);
    const results = res.data?.results || [];
    box.innerHTML = '';
    if (!results.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No matching exercises.' }));
      return;
    }
    box.appendChild(renderTable(
      ['Canonical name', 'Muscle group', 'Lift code', 'Variants'],
      results.map(r => [r.canonical_name, r.muscle_group, r.lift_code, (r.variants || []).join(', ')])
    ));
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Search failed: ${err.message}` }));
  }
});

/* ===== Exercise Detail ===== */

document.getElementById('detail-form').addEventListener('submit', async e => {
  e.preventDefault();
  const liftCode = document.getElementById('detail-lift-code').value.trim();
  const box = document.getElementById('detail-result');
  if (!liftCode) return;
  box.innerHTML = '<span class="muted">Loading…</span>';
  try {
    const res = await api(`/api/exercises/${encodeURIComponent(liftCode)}/detail`);
    const data = res.data || {};
    box.innerHTML = '';

    if (!data.sessions_count) {
      box.appendChild(el('p', { class: 'muted', text: `No data found for lift code "${liftCode}".` }));
      return;
    }

    // Summary line: name · code · N sessions · trend pill
    const trendPill = el('span', { class: `pill ${data.volume_trend}`, text: `trend: ${data.volume_trend}` });
    const nameStr = data.exercise_names.length ? data.exercise_names.join(' / ') : data.lift_code;
    const summaryLine = el('p', {}, [`${nameStr} · ${data.lift_code} · ${data.sessions_count} sessions `, trendPill]);
    box.appendChild(summaryLine);

    // Best recent set
    if (data.best_recent_set) {
      const s = data.best_recent_set;
      const setText = s.rir != null ? `${formatSetLoad(s.weight, s.reps)} @${s.rir}` : formatSetLoad(s.weight, s.reps);
      box.appendChild(el('p', { class: 'small muted', text: `Best recent set (30 days): ${setText} on ${s.date}` }));
    }

    // Last sessions table
    if (data.last_sessions.length) {
      box.appendChild(el('h3', { text: 'Last sessions' }));
      box.appendChild(renderTable(
        ['Date', 'Best weight', 'Est. 1RM', 'Volume', 'Sets'],
        data.last_sessions.map(s => [s.date, s.best_weight ?? '—', s.estimated_1rm ?? '—', s.volume ?? '—', s.sets])
      ));
    }

    // Recommendation
    if (data.recommendation) {
      const r = data.recommendation;
      box.appendChild(el('p', { class: 'muted', text: r.recommendation }));
      if (r.next_target) {
        const t = r.next_target;
        box.appendChild(el('p', { class: 'small muted', text: `Next target: ${t.weight} × ${t.reps} × ${t.sets} sets · confidence: ${r.confidence}` }));
      }
    }
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
});

/* ===== Session search ===== */

document.getElementById('session-search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const params = new URLSearchParams();
  const liftCode = document.getElementById('ss-lift-code').value.trim();
  const exercise = document.getElementById('ss-exercise').value.trim();
  const muscleGroup = document.getElementById('ss-muscle-group').value.trim();
  const dateFrom = document.getElementById('ss-date-from').value;
  const dateTo = document.getElementById('ss-date-to').value;
  if (liftCode) params.set('liftCode', liftCode);
  if (exercise) params.set('exercise', exercise);
  if (muscleGroup) params.set('muscleGroup', muscleGroup);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);

  const box = document.getElementById('session-search-result');
  box.innerHTML = '<span class="muted">Searching…</span>';
  try {
    const res = await api(`/api/search/sessions?${params.toString()}`);
    const data = res.data || {};
    const sets = data.rows || [];
    const sessionCount = data.session_ids?.length ?? 0;
    box.innerHTML = '';
    box.appendChild(el('p', { class: 'muted', text: `${sets.length} set(s) found across ${sessionCount} session(s).` }));
    if (!sets.length) return;
    box.appendChild(renderTable(
      ['Date', 'Session', 'Exercise', 'Set', 'Weight', 'Reps', 'RIR', 'Notes'],
      sets.slice(0, 100).map(s => [s.date_clean, s.session_id, s.canonical_exercise || s.exercise, s.set_number, s.weight, s.reps, s.rir, s.notes])
    ));
    if (sets.length > 100) {
      box.appendChild(el('p', { class: 'muted', text: `Showing first 100 of ${sets.length} rows.` }));
    }
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Search failed: ${err.message}` }));
  }
});

/* ===== Workout logger (approve-before-save) ===== */

const setsTableBody = document.querySelector('#sets-table tbody');
const previewPanel = document.getElementById('preview-panel');
const previewContent = document.getElementById('preview-content');
const loggerStatus = document.getElementById('logger-status');
const workoutTextInput = document.getElementById('workout-text');
const parsedRowsEditor = document.getElementById('parsed-rows-editor');

// Pending approval state. Set only after a successful dry-run preview;
// cleared whenever the form changes so stale previews can never be approved.
let pendingWrite = null;

// In-thread effort cards mirror the global approve button. When a preview is
// replaced or invalidated, an older card no longer matches the live pendingWrite,
// so its Save must be permanently neutralised — otherwise clicking a stale card
// would fire the newest preview's write. Each card registers a cleanup here;
// invalidatePreview() runs them all.
const effortCardCleanups = [];
// eslint-disable-next-line no-unused-vars -- global export consumed by other browser scripts; Phase 1 PR-08/09
function registerEffortCardCleanup(fn) { effortCardCleanups.push(fn); }
function runEffortCardCleanups() {
  while (effortCardCleanups.length) {
    const fn = effortCardCleanups.pop();
    try { fn(); } catch { /* card already removed from the DOM */ }
  }
}
let lastParsedWorkoutText = '';
let lastParserStatus = null;
let activeExercise = null;
let lastPrescribed = null;
// Card/advisory consistency (owner 07-02): the exercise name the unknown-lift
// advisory flagged on the LAST parse (null when the lift resolved). Threaded into
// the atlas:set-logged detail so the ✓ confirmation card marks the name instead of
// contradicting the advisory with full confidence.
let lastUnverifiedExercise = null;
// Cached when the Today dashboard loads so routeMessageToCoach can include
// the current plan order in coach context (for "why in this order?" questions).
let lastIntentData = null;

// Set by handleLogIt() before re-submitting the form with compiled workout
// text. When true, the submit handler skips the "route to coach" branch and
// runs the parse → preview path so the lifter sees the final session preview.
// Cleared immediately after being read — single-use gate.
let sessionCompiledAwaitingPreview = false;

// Populated after a successful manual write. Cleared only after undo or when
// the user explicitly picks "Log as new" in the correction dialog. NOT cleared
// by invalidatePreview so the correction guard can fire even after the user
// starts typing a correction in the same textarea.
let lastWrite = null;

// True while a live write request is in-flight. Guards against double-submit
// from rapid clicks before the button's disabled state is processed by the browser.
let writeInFlight = false;

// Cache last-time lookups to avoid redundant API calls within a session.
const lastTimeCache = new Map();

// Cache the per-lift recommendations (keyed by canonical exercise name) so the
// live "Next" hint costs at most one /api/plan/today fetch per session.
let planTodayByNameCache = null;

// Drop the live-hint caches after a write so the next "Last"/"Next" hint
// reflects the freshly logged sets rather than pre-write data.
function clearLiveHintCaches() {
  lastTimeCache.clear();
  planTodayByNameCache = null;
}

async function getPlanTodayByName() {
  if (planTodayByNameCache) return planTodayByNameCache;
  const map = new Map();
  try {
    const res = await api('/api/plan/today');
    for (const r of (res.data?.recommendations || [])) {
      if (r.exercise_name) map.set(String(r.exercise_name).toLowerCase(), r);
    }
  } catch {
    // best-effort — leave the map empty so the Next hint just doesn't show
  }
  planTodayByNameCache = map;
  return map;
}

// Resolve a recommendation for a typed exercise name: exact canonical match
// first, then a loose contains match ("bench" ↔ "Bench Press").
async function lookupNextTarget(name) {
  const map = await getPlanTodayByName();
  const key = name.toLowerCase();
  if (map.has(key)) return map.get(key);
  for (const [exName, rec] of map) {
    if (exName.includes(key) || key.includes(exName)) return rec;
  }
  return null;
}

async function showLastTimeHint(exerciseInput, hintEl) {
  const exercise = exerciseInput.value.trim();
  if (!exercise || !getApiKey()) { hintEl.textContent = ''; return; }
  const stillCurrent = () => exerciseInput.value.trim().toLowerCase() === exercise.toLowerCase();

  let data = lastTimeCache.get(exercise.toLowerCase());
  if (!data) {
    try {
      const res = await api(`/api/exercises/last-session?exercise=${encodeURIComponent(exercise)}`);
      data = res.data || {};
      lastTimeCache.set(exercise.toLowerCase(), data);
    } catch {
      hintEl.textContent = '';
      return;
    }
  }

  if (!stillCurrent()) return;
  hintEl.textContent = '';
  if (data.sets && data.sets.length) {
    const summary = data.sets.map(s => formatSetLoad(s.weight, s.reps, '×')).join('  ');
    hintEl.appendChild(el('div', { text: `Last (${data.date}): ${summary}` }));
  }

  // Live next-set coaching: the recommended target/cue for this lift, if any.
  const rec = await lookupNextTarget(exercise);
  if (!stillCurrent()) return;
  if (rec && rec.next_target) {
    const t = rec.next_target;
    const tip = rec.recommendation || `${t.weight} × ${t.reps}`;
    hintEl.appendChild(el('div', { class: 'next-target-hint', text: `Next: ${tip}` }));
  }
}

function addSetRow(values = {}) {
  const exerciseInput = el('input', { type: 'text', class: 'set-exercise', value: values.exercise || '', placeholder: 'Bench Press', list: 'exercise-catalog' });
  const hintEl = el('div', { class: 'last-time-hint' });
  exerciseInput.addEventListener('blur', () => showLastTimeHint(exerciseInput, hintEl));
  if (values.exercise) showLastTimeHint(exerciseInput, hintEl);

  const row = el('tr', {}, [
    el('td', {}, [exerciseInput, hintEl]),
    el('td', {}, el('input', { type: 'number', class: 'set-number', value: values.set_number || String(setsTableBody.children.length + 1), min: '1' })),
    el('td', {}, el('input', { type: 'number', class: 'set-weight', value: values.weight ?? '', min: '0', step: 'any' })),
    el('td', {}, el('input', { type: 'number', class: 'set-reps', value: values.reps ?? '', min: '0' })),
    el('td', {}, el('input', { type: 'number', class: 'set-rir', value: values.rir ?? '', min: '0', max: '10' })),
    el('td', {}, el('input', { type: 'text', class: 'set-notes', value: values.notes || '' })),
    el('td', {}, el('button', { type: 'button', class: 'remove-set', text: '✕' }))
  ]);
  row.querySelector('.remove-set').addEventListener('click', () => {
    row.remove();
    invalidatePreview();
  });
  setsTableBody.appendChild(row);
  parsedRowsEditor.hidden = false;
}

document.getElementById('add-set-btn').addEventListener('click', () => addSetRow());

document.getElementById('copy-last-session-btn').addEventListener('click', async () => {
  const statusBox = document.getElementById('copy-last-session-status');
  setStatus(statusBox, 'Loading last session…', 'ok');
  try {
    const res = await api('/api/history/recent?limit=100');
    const sets = res.data?.recent_sets || [];
    if (!sets.length) {
      setStatus(statusBox, 'No prior sessions found.', 'error');
      return;
    }
    // Find the most recent session (last session_id in the list)
    const lastSessionId = sets[sets.length - 1].session_id;
    const sessionSets = sets.filter(s => s.session_id === lastSessionId);
    setsTableBody.innerHTML = '';
    parsedRowsEditor.hidden = false;
    for (const s of sessionSets) {
      addSetRow({ exercise: s.canonical_exercise || s.exercise, set_number: s.set_number });
    }
    lastParsedWorkoutText = workoutTextInput.value.trim();
    invalidatePreview();
    setStatus(statusBox, `Copied ${sessionSets.length} exercise slots from session ${lastSessionId}. Fill in weights and reps.`, 'ok');
  } catch (err) {
    setStatus(statusBox, `Could not load: ${err.message}`, 'error');
  }
});

function generateSessionId(dateValue) {
  const compact = String(dateValue || '').replace(/[^0-9]/g, '');
  const suffix = new Date().getHours() < 12 ? 'AM' : 'PM';
  return `${compact}-${suffix}-01`;
}

function getLocalDateString(dateTime = new Date()) {
  const year = dateTime.getFullYear();
  const month = String(dateTime.getMonth() + 1).padStart(2, '0');
  const day = String(dateTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function collectLogRows(sessionId, date) {
  const rows = [];
  for (const tr of setsTableBody.children) {
    const exercise = tr.querySelector('.set-exercise').value.trim();
    if (!exercise) continue;
    rows.push({
      date_clean: date,
      session_id: sessionId,
      exercise,
      set_number: tr.querySelector('.set-number').value,
      weight: tr.querySelector('.set-weight').value,
      reps: tr.querySelector('.set-reps').value,
      rir: tr.querySelector('.set-rir').value,
      notes: tr.querySelector('.set-notes').value
    });
  }
  return rows;
}

function splitWorkoutLine(line) {
  const match = line.match(/^(.+?)\s+(\d+(?:\.\d+)?(?:\s|x|×).*)$/i);
  if (!match) return null;
  return { exercise: match[1].trim(), setText: match[2].trim() };
}

function parseSetSegment(segment) {
  const repeatMatch = segment.match(/\b(?:x|×)\s*(\d+)\s*$/i);
  const repeat = repeatMatch ? Number(repeatMatch[1]) : 1;
  const cleaned = repeatMatch ? segment.slice(0, repeatMatch.index).trim() : segment.trim();
  const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*(?:x|×|for)?\s*(\d+)(?:\s*\/\s*(\d+(?:\.\d+)?)|\s*(?:rir|@)\s*(\d+(?:\.\d+)?))?$/i);
  if (!match) return null;
  return {
    weight: match[1],
    reps: match[2],
    rir: match[3] || match[4] || '',
    repeat: Number.isFinite(repeat) && repeat > 0 ? repeat : 1
  };
}

function parseWorkoutText(text) {
  const rows = [];
  const errors = [];
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (const rawLine of lines) {
    // Added-load bodyweight ("Dips +25 8/2"): mirror the backend slash parser
    // (services/workoutTextParser.js, PR 486 slice 2b/#526) so the OFFLINE local
    // fallback recognizes it too — otherwise splitWorkoutLine can't find the load
    // and the set silently routes to the coach instead of buffering. A token-LEADING
    // "+" (start / after a space) is dropped so the external load reads as Weight;
    // a "+" wedged between digits ("225+25") is left intact. No bodyweight auto-add.
    const line = rawLine.replace(/(^|\s)\+(\d)/g, '$1$2');
    const parsedLine = splitWorkoutLine(line);
    if (!parsedLine) {
      errors.push(`Could not parse line: ${line}`);
      continue;
    }

    const segments = parsedLine.setText
      .split(/[,;]/)
      .map(segment => segment.trim())
      .filter(Boolean);
    if (!segments.length) {
      errors.push(`No sets found for: ${parsedLine.exercise}`);
      continue;
    }

    let setNumber = 1;
    for (const segment of segments) {
      const parsedSet = parseSetSegment(segment);
      if (!parsedSet) {
        errors.push(`Could not parse set "${segment}" for ${parsedLine.exercise}`);
        continue;
      }
      for (let i = 0; i < parsedSet.repeat; i += 1) {
        rows.push({
          exercise: parsedLine.exercise,
          set_number: String(setNumber),
          weight: parsedSet.weight,
          reps: parsedSet.reps,
          rir: parsedSet.rir,
          notes: ''
        });
        setNumber += 1;
      }
    }
  }

  return { rows, errors };
}

// Atlas writes this token into a log row's `notes` to mark a warm-up set. It MUST
// stay in sync with services/warmupTag.js (WARMUP_NOTE_TOKEN / isWarmupNote) — the
// server-side reader that keeps tagged warm-ups OUT of the weight-bump decision
// while they still count in volume. A unit test cross-checks that what we write
// here is recognized by isWarmupNote.
const WARMUP_LOG_NOTE = 'warm-up';

// Build editable set-rows directly from a display-block paste the normalizer has
// already parsed (exercise-name headers + per-line sets — the live composer/app
// export format like "135lbs 10 · warm-up" / "245lbs 6/2"). Warm-up sets are tagged
// in `notes` (logged + counted in volume, excluded only from the bump decision per
// the owner rule) — never dropped, never given a fabricated RIR. The exercise NAME
// is passed through; canonical/lift_code/muscle are resolved server-side on write
// (enrichAndFormatLogRows), exactly as for any other parsed row.
function rowsFromDisplayBlocks(blocks) {
  const rows = [];
  for (const block of blocks) {
    let setNumber = 1;
    for (const s of block.sets) {
      rows.push({
        exercise: block.name,
        set_number: String(setNumber),
        weight: s.weight == null ? '0' : String(s.weight),
        reps: s.reps == null ? '' : String(s.reps),
        rir: s.rir == null ? '' : String(s.rir),
        notes: s.warmup ? WARMUP_LOG_NOTE : ''
      });
      setNumber += 1;
    }
  }
  return rows;
}

function parserStatusNode(status) {
  if (!status) return null;
  const label = status.source === 'backend' ? 'Parsed by backend parser' : 'Parsed locally';
  return el('div', { class: 'parser-status', text: label });
}

function rowsFromBackendParsedWorkout(parsed) {
  // Multi-exercise log (several lifts in one message, split + parsed server-side):
  // flatten every exercise's sets into rows so they all land in the one preview →
  // approve → write card, exactly like a single-exercise log. Same row shape as
  // the single-exercise branch below; the server already resolved each exercise.
  if (parsed && parsed.intent === 'log_sets_multi' && Array.isArray(parsed.exercises)) {
    const rows = [];
    for (const ex of parsed.exercises) {
      const name = ex.canonical_name || ex.exercise || ex.raw_name || '';
      if (!name || !Array.isArray(ex.sets)) continue;
      ex.sets.forEach((set, index) => rows.push({
        exercise: name,
        set_number: String(index + 1),
        weight: set.weight == null ? '0' : String(set.weight),
        reps: set.reps == null ? '' : String(set.reps),
        rir: set.rir == null ? '' : String(set.rir),
        notes: set.load_note ? set.load_note : ''
      }));
    }
    if (rows.length) return rows;
    // No rows resolved → fall through to the clarification error below.
  }

  if (!parsed || parsed.intent !== 'log_sets' || !Array.isArray(parsed.sets)) {
    let message = parsed?.message || parsed?.warnings?.join(' | ') || 'Parser needs clarification.';
    if (parsed?.intent === 'finish_session') {
      message = 'That looks like a finish/save command. Enter or review workout rows first, then run Preview before approving a write.';
    } else if (parsed?.intent === 'effort_capture') {
      message = 'That looks like watch/effort data. Enter it in the Effort fields below.';
    }
    const err = new Error(message);
    err.noFallback = true;
    err.displayMessage = message;
    // Carry the parser's verdict so the caller can tell a FAILED LOG ATTEMPT (a
    // recognized exercise whose sets didn't resolve) apart from a question/chat.
    // This lets a malformed set surface a format hint instead of silently becoming
    // a coach message (the live-audit "looks logged but wasn't" trust gap).
    err.parsedIntent = parsed?.intent || null;
    err.recognizedExercise = (parsed?.partial && parsed.partial.exercise) || null;
    // Multi-line partial-log (owner 2026-07-02): when NO line resolved, the parser
    // still returns per-line specifics — carry them so the caller can surface the
    // first specific ask ("Which row — seated, bent-over…?") instead of routing a
    // paste full of sets to the coach.
    err.unresolvedLines = Array.isArray(parsed?.unresolved) ? parsed.unresolved : null;
    // True when the backend BLOCKED a multi-exercise blob. Lets the caller route a
    // newline-separated, one-exercise-per-line message to the line-based local parser
    // (each line is unambiguous) instead of dropping it to the coach. Same-line mixing
    // (no newline) stays blocked — see rowsFromWorkoutInput.
    err.multipleExercises = Array.isArray(parsed?.warnings) && parsed.warnings.includes('multiple_exercises_in_input');
    throw err;
  }

  const exercise = parsed.canonical_name || parsed.exercise || parsed.raw_name || '';
  if (!exercise) throw new Error('Parser did not return an exercise.');

  return parsed.sets.map((set, index) => ({
    exercise,
    set_number: String(index + 1),
    weight: set.weight == null ? '0' : String(set.weight),
    reps: set.reps == null ? '' : String(set.reps),
    rir: set.rir == null ? '' : String(set.rir),
    notes: set.load_note ? set.load_note : ''
  }));
}

async function parseWorkoutTextWithBackend(workoutText) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let result;
  try {
    result = await api('/api/parse-workout-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: workoutText,
        context: {
          // When the lifter names no exercise, a bare set sequence attaches to the
          // active lift; if none is active yet but a planned workout is open, fall
          // back to the first unlogged planned lift (the composer's "next up") so
          // "140 15 230 4/2…" lands on Bench instead of dead-ending at "Which
          // exercise is this for?". Still test_mode dry-run — preview/approval
          // rules are unchanged; with no plan context it keeps asking to clarify.
          activeExercise: activeExercise || firstUnloggedPlannedLift(),
          activeSessionType: null,
          todayPlan: null
        },
        test_mode: true
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = result?.data || {};
  if (data.test_mode !== true || data.sheet_written !== false || data.no_write_confirmed !== true) {
    // A flaky/partial response that can't prove its own no-write safety is
    // untrustworthy, so we DISCARD it entirely and let the caller re-parse
    // locally. This is fallback-eligible (no noFallback): the local parser is
    // pure client-side and never writes, the missing proof was the backend's
    // problem with a response we're throwing away, and the real write still
    // goes through preview→approve→write. Dropping a clearly-typed set into
    // chat on flaky signal is the worse failure.
    throw new Error('Backend parser did not prove no-write safety.');
  }

  const parsed = data.parsed;
  const intent = parsed?.intent;

  if (intent === 'delete_last_set') {
    return { intent: 'delete_last_set', rows: null, warnings: data.warnings || [] };
  }
  if (intent === 'update_last_set') {
    return { intent: 'update_last_set', rows: null, update: parsed.update, warnings: data.warnings || [] };
  }

  const rows = rowsFromBackendParsedWorkout(parsed);
  if (!rows.length) {
    // A log_sets response with no actual sets is a partial/garbled response —
    // fallback-eligible (no noFallback) so the local parser can recover a
    // clearly-typed set on flaky signal instead of dropping it into chat.
    throw new Error('Backend parser did not produce any set rows.');
  }
  return {
    intent: 'log_sets',
    rows,
    warnings: data.warnings || [],
    prescribed: Array.isArray(parsed.prescribed) ? parsed.prescribed : null,
    kbIdentity: data.kb_identity || null,
    // Multi-line partial-log (owner 2026-07-02): lines the parser could not resolve,
    // each with its own specific ask — surfaced by rowsFromWorkoutInput so a clean
    // paste never silently drops its one ambiguous line.
    unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved : null
  };
}

function populateSetRows(rows) {
  setsTableBody.innerHTML = '';
  for (const row of rows) addSetRow(row);
  parsedRowsEditor.hidden = rows.length === 0;
}

function deleteLastSetRow() {
  const rows = Array.from(setsTableBody.children);
  if (!rows.length) return;
  rows[rows.length - 1].remove();
  if (!setsTableBody.children.length) parsedRowsEditor.hidden = true;
}

function applyUpdateToLastRow(update) {
  if (!update) return;
  const rows = Array.from(setsTableBody.children);
  if (!rows.length) return;
  const lastRow = rows[rows.length - 1];
  if (update.weight != null) lastRow.querySelector('.set-weight').value = String(update.weight);
  if (update.reps != null) lastRow.querySelector('.set-reps').value = String(update.reps);
  if (update.rir != null) lastRow.querySelector('.set-rir').value = String(update.rir);
}

// When a conversational log names a lift the parser can't resolve ("Lat pull",
// "Incline") but the lead clearly refers to the current pending PLANNED lift,
// re-parse with the planned lift's full name substituted so the sets attach to it
// instead of dead-ending in chat ("Noted — keep logging…"). Returns rows or null.
// Frontend-only: it calls the SAME backend parser with a resolved name — no parser
// grammar change. Gated tightly — only fires when the lead (the words before the
// first number) alias-matches the pending planned lift, so an unrelated new lift
// never mis-attaches; with no plan / no match it returns null and the normal
// chat-clarify fallback runs.
async function rowsFromUnresolvedPlannedLead(workoutText) {
  const planned = firstUnloggedPlannedLift();
  if (!planned) return null;
  const tokens = String(workoutText || '').trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && !/\d/.test(tokens[i])) i += 1;
  if (i === 0 || i >= tokens.length) return null; // no lead name, or no set tokens
  const lead = tokens.slice(0, i).join(' ').toLowerCase();
  const p = String(planned).toLowerCase();
  if (!(lead === p || p.includes(lead) || lead.includes(p))) return null;
  const rebuilt = `${planned} ${tokens.slice(i).join(' ')}`;
  try {
    const retry = await parseWorkoutTextWithBackend(rebuilt);
    return retry && retry.intent === 'log_sets' ? retry.rows : null;
  } catch {
    return null;
  }
}

// Normalize an exercise phrase to singular-word tokens for family matching.
function bareLeadTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

// Plan-aware disambiguation of a BARE/generic leading exercise term. When the lifter
// types a short generic name ("rows", "bench", "curls") whose words are a subset of a
// planned exercise's name, and the plan has EXACTLY ONE such exercise, rewrite the
// lead to that planned name so it logs as the specific movement — the session plan is
// the highest-confidence reference after the lifter's own words ("seated row is the
// only row planned, so 'rows' means seated row"). Pure and conservative:
//   • only the leading name (the words before the first set number) is considered;
//   • fires only on a UNIQUE family match — zero or multiple planned matches → text
//     unchanged, so the existing alias/ask/default behavior stands;
//   • a lead that is already as specific as (or more specific than) the plan entry is
//     left alone (its tokens wouldn't be a strict subset needing a rewrite).
function rewriteBareLeadAgainstPlan(text, plannedNames) {
  const raw = String(text == null ? '' : text);
  const m = raw.match(/^(\s*)([A-Za-z][A-Za-z' -]*?)\s+(\d[\s\S]*)$/);
  if (!m) return text;
  const leadTokens = bareLeadTokens(m[2]);
  if (!leadTokens.length) return text;
  const names = Array.isArray(plannedNames) ? plannedNames.filter(Boolean) : [];
  const matches = [];
  for (const name of names) {
    const nameTokens = bareLeadTokens(name);
    const nameSet = new Set(nameTokens);
    // Generic match: every lead word appears in the plan name, and the lead is not
    // MORE specific than the plan entry (lead tokens ⊆ plan tokens).
    if (leadTokens.length <= nameTokens.length && leadTokens.every(t => nameSet.has(t))) {
      if (!matches.includes(name)) matches.push(name);
    }
  }
  if (matches.length !== 1) return text;                 // ambiguous or no match → leave it
  if (bareLeadTokens(matches[0]).join(' ') === leadTokens.join(' ')) return text; // already specific
  return `${m[1]}${matches[0]} ${m[3]}`;
}

// Planned exercise names for bare-lead disambiguation — still-unlogged first (the one
// the lifter is on), then the full plan; deduped, order-preserving.
function planNamesForDisambiguation() {
  const remaining = typeof remainingPlannedExercises === 'function' ? remainingPlannedExercises() : [];
  const planned = typeof plannedExerciseOrder === 'function' ? plannedExerciseOrder() : [];
  const seen = new Set();
  const out = [];
  for (const n of [...remaining, ...planned]) {
    const key = String(n || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

async function rowsFromWorkoutInput() {
  let workoutText = workoutTextInput.value.trim();
  // Plan-aware disambiguation: a bare generic lead ("rows", "bench", "curls") means
  // the plan's unique exercise of that family. Rewrite it to that planned name BEFORE
  // parsing so it logs as the specific movement; with no plan (or an ambiguous /
  // absent match) it is byte-identical and the existing alias/ask/default stands.
  workoutText = rewriteBareLeadAgainstPlan(workoutText, planNamesForDisambiguation());
  if (!workoutText || workoutText === lastParsedWorkoutText) return;

  // Multi-exercise display-block paste — the live composer / app-export format:
  // bare exercise-name headers with per-line sets ("135lbs 10 · warm-up" warm-ups,
  // "245lbs 6/2" working sets), several exercises stacked. The proven single-line
  // parser can't read it (name and sets are on separate lines), so it dropped to the
  // coach ("Noted — keep logging") and lost every set. Detect it deterministically
  // and build the rows here; warm-ups are tagged, and the rows flow through the SAME
  // preview → approve → write loop, unchanged. Conservative: the normalizer returns
  // isDisplayBlock:false for single-line / slash / ambiguous input, so existing
  // parsing is untouched.
  if (typeof displayBlockNormalizer !== 'undefined' && displayBlockNormalizer &&
      typeof displayBlockNormalizer.normalizeDisplayBlocks === 'function') {
    const blocked = displayBlockNormalizer.normalizeDisplayBlocks(workoutText);
    if (blocked.isDisplayBlock && blocked.blocks.length) {
      // kg gate: Atlas logs in pounds. Never silently log kg as lb — ask the lifter
      // to convert rather than corrupt the weight. `handled` keeps the catch from
      // routing this to the coach.
      const hasKg = blocked.blocks.some(b => b.sets.some(s => s.unit === 'kg'));
      if (hasKg) {
        lastParsedWorkoutText = workoutText;
        const e = new Error('Atlas logs in pounds — convert the kg values and paste again.');
        e.displayMessage = e.message;
        e.handled = true;
        throw e;
      }
      const blockRows = rowsFromDisplayBlocks(blocked.blocks);
      if (blockRows.length) {
        populateSetRows(blockRows);
        lastParserStatus = { source: 'display-block' };
        activeExercise = blockRows[blockRows.length - 1].exercise || null;
        parsedRowsEditor.hidden = true;
        lastParsedWorkoutText = workoutText;
        lastPrescribed = null;
        return;
      }
    }
  }

  let parsed;
  try {
    parsed = await parseWorkoutTextWithBackend(workoutText);
  } catch (backendError) {
    // Re-parse a shorthand-named lift that refers to the pending planned lift, so
    // "Lat pull"/"Incline" attach to "Lat Pulldown"/"Incline DB Press" instead of
    // routing to chat. ONLY when the backend actually responded but couldn't resolve
    // rows (noFallback) — for network/5xx we skip it and go straight to the local
    // fallback (which already gets firstUnloggedPlannedLift as activeExercise),
    // avoiding a wasted ~8s re-parse timeout when offline at the gym.
    const replanned = !shouldUseLocalFallback(backendError)
      ? await rowsFromUnresolvedPlannedLead(workoutText)
      : null;
    if (replanned && replanned.length) {
      populateSetRows(replanned);
      lastParserStatus = { source: 'backend-replanned' };
      activeExercise = replanned[0]?.exercise || null;
      parsedRowsEditor.hidden = true;
      lastParsedWorkoutText = workoutText;
      lastPrescribed = null;
      return;
    }
    // Multi-line, one-exercise-per-line strength logging (Fix A). The backend
    // INTENTIONALLY blocks a multi-exercise blob (ambiguous same-line mixing), but
    // newline-separated lines are each unambiguous, so route them to the line-based
    // local parser — which the noFallback block would otherwise bypass — so ALL lines
    // log instead of dropping to the coach (the "looks logged but wasn't" trust gap).
    // Guards: only when the backend flagged multiple_exercises_in_input AND the input
    // actually spans newlines (so same-line mixing stays blocked), AND the local parse
    // is CLEAN (no per-line errors) — an uncertain line is never silently logged.
    if (backendError.multipleExercises && /\n/.test(workoutText)) {
      const multi = parseWorkoutText(workoutText, { activeExercise: activeExercise || firstUnloggedPlannedLift() });
      if (!multi.errors.length && multi.rows.length) {
        populateSetRows(multi.rows);
        lastParserStatus = { source: 'local-multiline' };
        activeExercise = multi.rows[0]?.exercise || null;
        parsedRowsEditor.hidden = true;
        lastParsedWorkoutText = workoutText;
        lastPrescribed = null;
        return;
      }
      // Ambiguous/partial multi-line → fall through to the existing path (never log
      // uncertain rows). Same-line mixing (no newline) never reaches here.
    }
    if (!shouldUseLocalFallback(backendError)) throw backendError;
    console.warn('[atlas] parse-workout-text unavailable, using local fallback:', backendError.message);
    const localResult = parseWorkoutText(workoutText, { activeExercise: activeExercise || firstUnloggedPlannedLift() });
    if (localResult.errors.length > 0) throw new Error(localResult.errors.join(' | '));
    if (!localResult.rows.length) throw new Error('Workout text did not produce any set rows.');
    populateSetRows(localResult.rows);
    lastParserStatus = { source: 'local' };
    parsedRowsEditor.hidden = true;
    lastParsedWorkoutText = workoutText;
    lastPrescribed = null;
    return;
  }

  if (parsed.intent === 'delete_last_set') {
    deleteLastSetRow();
    setStatus(loggerStatus, 'Last set removed.', 'ok');
    lastParsedWorkoutText = workoutText;
    return;
  }

  if (parsed.intent === 'update_last_set') {
    applyUpdateToLastRow(parsed.update);
    setStatus(loggerStatus, 'Last set updated.', 'ok');
    lastParsedWorkoutText = workoutText;
    return;
  }

  populateSetRows(parsed.rows);
  lastParserStatus = { source: 'backend' };
  activeExercise = parsed.rows[0]?.exercise || null;
  parsedRowsEditor.hidden = true;
  lastParsedWorkoutText = workoutText;
  lastPrescribed = parsed.prescribed || null;

  // The parser couldn't confidently resolve a lift name and echoed the typed
  // text instead of guessing a real lift. Surface it so the wrong history isn't
  // saved — the exercise field is editable, so a tap fixes it before approval.
  // But the parser's internal alias map is NARROWER than the exercise catalog: a
  // real lift like "Cable Fly" is `unknown_exercise` to the parser yet known to
  // the catalog. Only warn when it's truly unresolved — unknown to the catalog
  // too — so a successfully-parsed, catalog-known lift never gets "didn't catch
  // that" on top of its confirmation card.
  lastUnverifiedExercise = null;
  // Card/advisory consistency (owner 07-02) — per ROW, not just rows[0], and
  // computed BEFORE the unresolved-lines early return (QA sweep 2026-07-03):
  // a multi-line paste can carry an unknown name on ANY line, and a paste with
  // BOTH an unresolved line and an unknown name used to return early on the
  // ask and let the unknown sail to the sheet with a full-confidence ✓ card —
  // the exact Curls bug class. Every truly-unresolved name now feeds the
  // card's "check name" chip regardless of which status line wins below.
  // kbIdentity is the server's identity for the PRIMARY lift, so it only
  // vouches for row 0.
  const unverifiedNames = [];
  {
    const seenNames = new Set();
    (parsed.rows || []).forEach((row, i) => {
      const name = row && row.exercise;
      if (!name || seenNames.has(name)) return;
      seenNames.add(name);
      if (shouldWarnUnknownLift(parsed.warnings, name, liftCodeFromCatalog, i === 0 ? parsed.kbIdentity : null)) {
        unverifiedNames.push(name);
      }
    });
  }
  if (unverifiedNames.length) {
    lastUnverifiedExercise = unverifiedNames.length === 1 ? unverifiedNames[0] : unverifiedNames;
  }

  // Multi-line partial-log (owner 2026-07-02): the clean lines are captured above;
  // each unresolved line gets its OWN specific ask so it can be re-typed — never
  // silently dropped, never the generic "keep logging" fallback. Its composer
  // status takes precedence over the unknown-lift advisory below (a re-typed line
  // re-runs both checks); the check-name chips still render either way, because
  // lastUnverifiedExercise was set above this return.
  if (Array.isArray(parsed.unresolved) && parsed.unresolved.length) {
    parsedRowsEditor.hidden = false;
    const first = parsed.unresolved[0];
    const extra = parsed.unresolved.length > 1 ? ` (+${parsed.unresolved.length - 1} more like it)` : '';
    setStatus(loggerStatus,
      `Captured the rest — one line needs a check: "${first.line}"${extra} — ${first.message} Re-type that line and I'll add it.`,
      'warn');
    return;
  }

  if (unverifiedNames.length) {
    // B2 — the composer status and the chat confirmation card must agree about the
    // same input. The set IS captured: these rows flow to the very same confirmation
    // card / preview as any other log (emitSetLogged buffers them, then closeout
    // saves them), so the composer must NOT contradict that with a failure message
    // implying the lift was dropped. Surface one consistent name-review advisory
    // instead — gated by the identical shouldWarnUnknownLift check as before
    // (KB/catalog-known lifts still get no advisory). No write-path/trust-loop
    // change; the unresolved names are still flagged for the lifter to correct.
    parsedRowsEditor.hidden = false;
    if (unverifiedNames.length === 1) {
      setStatus(loggerStatus, `I don't recognize "${unverifiedNames[0]}" — check the exercise name before it's saved.`, 'warn');
    } else {
      setStatus(loggerStatus, `I don't recognize ${unverifiedNames.map(n => `"${n}"`).join(', ')} — check those exercise names before they're saved.`, 'warn');
    }
  }
}

// Whether to warn that a lift wasn't caught. True only when the parser flagged
// `unknown_exercise` AND the catalog doesn't recognize the resolved name either —
// i.e. the parser truly failed to resolve a real lift. A catalog hit (the parser
// map is just narrower than the catalog) means it's a real lift; no warning.
function shouldWarnUnknownLift(warnings, exerciseName, catalogLookup, kbIdentity) {
  if (!(Array.isArray(warnings) && warnings.includes('unknown_exercise'))) return false;
  // The server attaches a KB identity when the exercise resolver recognizes the
  // lift (e.g. Cable Fly) even though the parser's narrower catalog flagged it
  // unknown. That is the SAME identity source the card/voice trust — so honor it
  // here too and don't split-brain a real lift into a "didn't catch that" warning.
  if (kbIdentity && kbIdentity.exercise_id) return false;
  const known = typeof catalogLookup === 'function' && exerciseName && catalogLookup(exerciseName);
  return !known;
}

function shouldUseLocalFallback(err) {
  return err.noFallback !== true &&
    (err.status === undefined || err.status >= 500);
}

function effortMode() {
  return document.querySelector('input[name="effort-mode"]:checked').value;
}

document.querySelectorAll('input[name="effort-mode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    document.getElementById('effort-manual').hidden = effortMode() !== 'manual';
    document.getElementById('effort-screenshot').hidden = effortMode() !== 'screenshot';
    invalidatePreview();
  });
});

// The effort panel's own submit affordance. Manual effort (and the device-screenshot
// sub-mode) live inside the logger form, but the only control that submitted them was
// the composer's ↑ button — so after typing effort there was no obvious next step and
// it "just sat there" (owner live-test gap, 2026-06-28). This button dispatches the
// SAME logger-form submit the ↑ does, so manual effort + the buffered session flow
// into one preview through the identical preview→approve→write path. It opens NO new
// write path and changes no trust-loop semantics — it is purely a more discoverable
// trigger for the existing submit handler (the same dispatch runCloseout already uses).
document.getElementById('effort-preview-btn')?.addEventListener('click', () => {
  document.getElementById('logger-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
});

// Explicit "Finish session" affordance for freestyle logging — so closing out a
// session no longer depends on knowing the "done"/"log it" chat keyword. It is a
// contextual control: shown once a set is logged this session, hidden on reset/save.
// Clicking it runs the SAME closeout as "log it" (handleLogIt → runCloseout →
// preview → review card), so it opens no new write path and the preview→approve→write
// trust loop is unchanged — nothing is saved until the lifter approves the review card.
function setFinishSessionVisible(visible) {
  const btn = typeof document !== 'undefined' ? document.getElementById('finish-session-btn') : null;
  if (btn) btn.hidden = !visible;
}
document.getElementById('finish-session-btn')?.addEventListener('click', () => { handleLogIt(); });
document.addEventListener('atlas:set-logged', () => setFinishSessionVisible(true));
document.addEventListener('atlas:session-reset', () => setFinishSessionVisible(false));
// The pin re-derives (and hides) on every session reset — same signal that
// clears the finish button, so the two can never disagree about "in progress".
document.addEventListener('atlas:session-reset', renderSessionPin);

function collectManualEffort(sessionId, date, location, notes) {
  const duration = document.getElementById('effort-duration').value.trim();
  const activeCal = document.getElementById('effort-active-cal').value;
  const totalCal = document.getElementById('effort-total-cal').value;
  const avgHr = document.getElementById('effort-avg-hr').value;
  const peakHr = document.getElementById('effort-peak-hr').value;

  const anyFilled = duration || activeCal || totalCal || avgHr || peakHr;
  if (!anyFilled) return null;
  if (!duration || !activeCal || !totalCal || !avgHr || !peakHr) {
    throw new Error('Effort needs duration, active calories, total calories, average HR, and peak HR (or leave all blank).');
  }

  return {
    date,
    session_id: sessionId,
    duration,
    active_calories: Number(activeCal),
    total_calories: Number(totalCal),
    average_hr: Number(avgHr),
    peak_hr: Number(peakHr),
    location: location || '',
    notes: notes || ''
  };
}

function extractLiftCodes(logRowsPreview) {
  const seen = new Set();
  const codes = [];
  for (const row of (logRowsPreview || [])) {
    const code = String(row[5] || '').trim();
    if (code && !seen.has(code)) { seen.add(code); codes.push(code); }
  }
  return codes;
}

// Hand the just-previewed sets to the conversation layer (coach-conversation.js)
// so it can type a coaching note with an inline Save. Read-only narration: it
// never writes — Save just clicks #approve-btn, which stays gated by the dry-run
// proof. Best-effort; a missing listener is a no-op.
function emitCoachPreview(rows, liftCodes, effortOnly, effort, substitutions, dateInfo) {
  try {
    document.dispatchEvent(new CustomEvent('atlas:preview-ready', {
      detail: {
        rows: rows || [],
        liftCodes: liftCodes || [],
        effortOnly: Boolean(effortOnly),
        effort: effort || null,
        substitutions: Array.isArray(substitutions) ? substitutions : [],
        // B5: the resolved workout date + its source (manual | screenshot |
        // today_fallback) so the in-thread review card can show — and let the owner
        // correct — the date before approving. null source = nothing to show.
        dateInfo: (dateInfo && dateInfo.date) ? dateInfo : null,
        // P0 wiring 2b: the recap's completed/remaining view derives from the ONE
        // canonical session (identity reconciled against the mutated plan), so it
        // can't disagree with what was logged. null when nothing was logged.
        recap: canonicalSessionRecap()
      }
    }));
  } catch { /* narration is optional */ }
}

// P0 wiring 2b: derive the end-of-session recap from the canonical ActiveSession,
// so "what you did / what's still on the plan" reconciles each logged lift's
// identity against the (possibly swapped/skipped) plan through the shared model —
// never the divergent raw-string remaining. Returns null when there is no session
// OR when nothing was actually logged (hasLoggedWork()=false), so an all-skipped /
// empty session is never narrated as a completed workout. Read-only: it informs
// narration only and never changes which rows are written (the written sets still
// come from sessionLog — the canonical model carries identity, not set data).
function canonicalSessionRecap() {
  const AS = (typeof window !== 'undefined' && window.activeSession) || (typeof activeSession !== 'undefined' ? activeSession : null);
  const s = AS ? getCanonicalSession() : null;
  if (!AS || !s || !AS.hasLoggedWork(s)) return null;
  return {
    completed: AS.completedExercises(s).map(e => e.name).filter(Boolean),
    remaining: AS.remaining(s).map(e => e.name).filter(Boolean)
  };
}

// In-workout: hand a just-LOGGED (not previewed) set to the conversation layer
// for a readback + adjusted-next coaching reaction. No write, no preview, no
// Save — purely narration off the client-parsed rows. The set text rides along
// so the end-of-session compile can reconstruct the full workout.
// Structured client-side buffer of every set logged this session. The end-of-
// session save (done / effort / screenshot) is built from THIS — never from a
// Gemini compile or a re-parse — so it's reliable and identical across triggers.
let sessionLog = [];
// Unique exercise names logged this session. Sent in chat context as
// plan_completed so the server can compute which planned exercises remain.
// Cleared alongside sessionLog at save and on startOver.
let sessionCompleted = [];
// DISPLAY-ONLY ledger of exercises already SAVED during this workout. A save
// concludes the session (sessionLog is cleared, and the next set auto-increments
// to a new session_id), so without this a later closeout in the same gym session
// showed only the post-save sets — earlier, already-saved exercises looked
// "missing" from the confirm/review card even though they're safely on the sheet.
// This is NEVER part of any write payload (the write comes from the server-
// previewed buffer / edit table); it is reset only on a deliberate fresh start
// (startOver / discard restored), NOT on save.
let sessionSavedLog = [];
// A closeout screenshot is optional evidence, not workout text. When the plan is
// already complete, choosing a file under the composer must not auto-route to
// /api/complete-workout; "done" still saves the buffered session rows.
let closeoutScreenshotFile = null;
let closeoutScreenshotEffort = null;
// RC2: the date source resolved for a closeout screenshot save
// (manual | screenshot | today_fallback). Drives a preview banner so the chosen
// workout date is visible — and correctable — before the owner approves.
let closeoutScreenshotDateSource = null;
// RC2: whether the owner EXPLICITLY typed a workout date. A closeout screenshot's
// own date only wins when this is false. setDefaultDate() sets #log-date's value
// programmatically (no input event), so the default-today never trips this.
let logDateManuallyEntered = false;

/* ===== Mobile PWA session persistence/resume safety =====
 * Live gym testing on a phone home-screen icon can lose the in-memory session to a
 * reload, force-quit, or accidental swipe. We snapshot ONLY the in-progress session
 * buffers — sessionLog (the set data), sessionCompleted (resolved identities), and
 * activePlannedSession (the live plan/cursor) — to localStorage, and restore them on
 * load so the lifter resumes mid-session. This is persistence/resume ONLY: it never
 * changes coaching, parsing, or the preview→approve→write trust loop — the snapshot
 * is the SAME data the buffers already hold, written/read defensively. The snapshot
 * is cleared on a successful save and on Start Over. Recency-gated so a stale snapshot
 * (>12h) is ignored rather than resurrecting yesterday's half-session. */
const SESSION_SNAPSHOT_KEY = 'atlas_session_snapshot_v1';
const SESSION_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function saveSessionSnapshot() {
  try {
    if (typeof localStorage === 'undefined') return;
    // Nothing in progress → don't keep a stale snapshot around.
    if (!(Array.isArray(sessionLog) && sessionLog.length) && !activePlannedSession) {
      localStorage.removeItem(SESSION_SNAPSHOT_KEY);
      return;
    }
    // Persist the stable session_id so a re-preview after restore reuses the SAME id,
    // allowing the server's row-level dedup to catch duplicate rows even if the
    // write_id is regenerated (which it always is across page loads).
    const sessionIdEl = typeof document !== 'undefined' ? document.getElementById('log-session-id') : null;
    const sessionId = sessionIdEl ? sessionIdEl.value.trim() : '';
    localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify({
      v: 1,
      ts: Date.now(),
      sessionLog,
      sessionCompleted,
      activePlannedSession,
      ...(sessionId ? { sessionId } : {}),
    }));
  } catch { /* storage full / disabled — persistence is best-effort, never fatal */ }
}

function clearSessionSnapshot() {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(SESSION_SNAPSHOT_KEY); } catch { /* ignore */ }
  // Also hide the resume notice so it doesn't linger after a save or Start Over.
  try {
    const notice = typeof document !== 'undefined' ? document.getElementById('session-resume-notice') : null;
    if (notice) notice.hidden = true;
  } catch { /* ignore */ }
}

// Discard a restored in-progress session entirely — buffer, plan (deload-aware via
// endPlannedSession), closeout state, the session_id, and the snapshot — so a fresh
// workout starts clean. Triggered by the restore banner's swipe-to-trash action.
function discardRestoredSession() {
  sessionLog = [];
  sessionCompleted = [];
  sessionSavedLog = [];     // discarding the restored workout also clears its saved recap
  endPlannedSession();
  closeoutScreenshotFile = null;
  closeoutScreenshotEffort = null;
  closeoutScreenshotDateSource = null;
  const sidEl = typeof document !== 'undefined' ? document.getElementById('log-session-id') : null;
  if (sidEl) sidEl.value = '';
  clearSessionSnapshot();   // removes the persisted snapshot AND hides the notice
  document.dispatchEvent(new CustomEvent('atlas:session-reset'));
}

// Tap the restore banner → bring the recovered workout into view: populate the editable
// rows from the buffer and reveal them, so the restored sets are visible and saveable
// (the session stays buffered — this only un-hides what was silently restored).
function restoreSessionToView() {
  if (!Array.isArray(sessionLog) || !sessionLog.length) return;
  populateSetRows(buildRowsFromSessionLog());
  if (parsedRowsEditor) {
    parsedRowsEditor.hidden = false;
    // The rows editor is a <details> — revealing it (hidden=false) only shows the
    // collapsed "Edit rows" summary. Open it so "tap to view" actually surfaces the
    // restored sets instead of an empty-looking disclosure (BUG-20260629-054925).
    parsedRowsEditor.open = true;
    if (parsedRowsEditor.scrollIntoView) parsedRowsEditor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const notice = typeof document !== 'undefined' ? document.getElementById('session-resume-notice') : null;
  if (notice) notice.hidden = true;
  // A restored session has logged work — surface the explicit finish affordance too.
  setFinishSessionVisible(true);
}

// iOS-style swipe-to-reveal-trash + tap-to-restore on the resume banner. Horizontal
// drags slide the content left to expose the trash; a tap (no real drag) restores.
function wireResumeNoticeGestures(content) {
  const REVEAL = 64, OPEN_AT = 36;
  let startX = 0, startY = 0, dx = 0, revealed = false, dragging = false, horizontal = false;
  const place = x => { content.style.transform = `translateX(${x}px)`; };
  content.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    dx = 0; dragging = true; horizontal = false; content.style.transition = 'none';
  }, { passive: true });
  content.addEventListener('touchmove', e => {
    if (!dragging) return;
    dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!horizontal && Math.abs(dx) < Math.abs(dy)) { dragging = false; place(revealed ? -REVEAL : 0); return; }
    horizontal = true;
    place(Math.max(-REVEAL, Math.min(0, (revealed ? -REVEAL : 0) + dx)));
  }, { passive: true });
  content.addEventListener('touchend', () => {
    if (dragging) content.style.transition = '';
    dragging = false;
    // Only an actual HORIZONTAL swipe toggles the trash. A vertical-aborted gesture
    // (horizontal stays false) leaves dx at the aborting frame, so without this gate a
    // steep diagonal scroll could still reveal the trash — snap back to the current state.
    if (horizontal && dx < -OPEN_AT) { revealed = true; place(-REVEAL); }
    else if (horizontal && dx > OPEN_AT) { revealed = false; place(0); }
    else place(revealed ? -REVEAL : 0);   // a tap falls through to the click handler
  }, { passive: true });
  // Tap (no meaningful drag) restores; a closed-state click with the trash hidden also
  // restores. A swipe leaves |dx| large, so suppress the synthetic click it fires.
  content.addEventListener('click', () => {
    if (horizontal && Math.abs(dx) > 8) { dx = 0; return; }
    if (revealed) { revealed = false; place(0); return; }
    restoreSessionToView();
  });
}

// Show a banner when the previous session is restored. The owner can TAP it to bring the
// recovered workout into view, or SWIPE it to reveal a trash can and discard the session.
// (A saved workout never reaches here — see the post-write reset; restore is only for an
// unsaved, lost in-progress session.) Auto-hidden when clearSessionSnapshot fires.
function renderResumeNotice(setCount, sets) {
  const notice = typeof document !== 'undefined' ? document.getElementById('session-resume-notice') : null;
  if (!notice || !setCount) return;
  const exercises = [...new Set((sets || []).map(s => s.exercise).filter(Boolean))];
  let msg = `Session restored — ${setCount} set${setCount === 1 ? '' : 's'} logged`;
  if (exercises.length) {
    const preview = exercises.slice(0, 3).join(', ') + (exercises.length > 3 ? ', …' : '');
    msg += ` (${preview})`;
  }
  notice.innerHTML = '';
  // Trash layer sits behind the content; swiping the content left exposes it.
  const trash = el('button', { type: 'button', class: 'resume-trash', title: 'Discard restored session', 'aria-label': 'Discard restored session', text: '🗑' });
  trash.addEventListener('click', discardRestoredSession);
  notice.appendChild(trash);
  // Content layer (slides). Tap to view the recovered workout.
  const content = el('div', { class: 'resume-content' }, [
    el('span', { class: 'resume-notice-text', text: msg }),
    el('span', { class: 'resume-hint', text: 'tap to view · swipe to discard' })
  ]);
  notice.appendChild(content);
  wireResumeNoticeGestures(content);
  notice.hidden = false;
}

// Restore a recent in-progress session on load. Defensive: a malformed/old snapshot
// is ignored (and cleared), never partially applied. Returns true when a session was
// resumed (caller re-renders the banner). Read-only restore — no network, no writes.
function restoreSessionSnapshot() {
  try {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(SESSION_SNAPSHOT_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    if (!snap || snap.v !== 1 || typeof snap.ts !== 'number' || (Date.now() - snap.ts) > SESSION_SNAPSHOT_MAX_AGE_MS) {
      clearSessionSnapshot();
      return false;
    }
    if (!Array.isArray(snap.sessionLog) || !Array.isArray(snap.sessionCompleted)) { clearSessionSnapshot(); return false; }
    // Only resume when there is genuinely LOGGED work to protect. A snapshot that
    // carries ONLY an engaged plan (no logged sets) must NOT silently reactivate
    // guided mode on the next app open — that hijacks a fresh freestyle log with a
    // phantom "1 of N / next up" from a plan the lifter never re-engaged, and with
    // zero logged sets renderResumeNotice stays hidden, so the resume is invisible
    // (owner live find 2026-07-03). The snapshot exists to protect unsaved SETS; an
    // empty plan has no work to lose and is one tap from re-opening. This also keeps
    // freestyle logging clean after any app reopen (the "freestyle must not
    // auto-guide" principle). Sessions WITH logged sets resume exactly as before.
    if (!snap.sessionLog.length) { clearSessionSnapshot(); return false; }
    sessionLog = snap.sessionLog;
    sessionCompleted = snap.sessionCompleted;
    activePlannedSession = (snap.activePlannedSession && Array.isArray(snap.activePlannedSession.exercises))
      ? snap.activePlannedSession : null;
    // Restore the stable session_id so re-preview after resume uses the same id.
    if (snap.sessionId) {
      const sessionIdEl = typeof document !== 'undefined' ? document.getElementById('log-session-id') : null;
      if (sessionIdEl) sessionIdEl.value = snap.sessionId;
    }
    renderResumeNotice(sessionLog.length, sessionLog);
    if (activePlannedSession) { coachSuggestionEngaged = true; renderActiveSessionBanner(); }
    return true;
  } catch { clearSessionSnapshot(); return false; }
}

// Warn before a refresh/close ONLY when there are logged sets not yet saved — so an
// accidental swipe/reload during a session can't silently drop unsaved work. No
// warning when nothing is logged (a fresh app or a just-saved session). Standard
// beforeunload contract: setting returnValue triggers the browser's native prompt.
function hasUnsavedSessionState() {
  return Array.isArray(sessionLog) && sessionLog.length > 0;
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', e => {
    saveSessionSnapshot();                 // persist first so even "Leave" resumes
    if (hasUnsavedSessionState()) { e.preventDefault(); e.returnValue = ''; }
  });
  // Backgrounding the PWA (app switch / lock) is the common loss point on iOS —
  // snapshot on hide so a later force-quit still resumes.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSessionSnapshot(); });
}

// The planned exercises the lifter is working through, in the VISIBLE plan order,
// WITH their identity fields (name + canonical + liftCode). Source: a formally-
// started planned session if one exists, else the cached coach-suggested plan
// (lastIntentData's recommended intent). This is the single source of truth for
// post-log identity so every surface (sessionCompleted, plannedQueue, nextPlanned,
// handoff, composer, set-effort reroute) resolves a logged lift to the SAME
// planned name — whether or not the lifter tapped "Start Session".
function plannedExerciseEntries() {
  if (activePlannedSession && activePlannedSession.exercises.length) {
    return activePlannedSession.exercises.map(ex => ({
      name: ex.canonicalName || ex.name,
      canonical: ex.canonicalName || ex.name,
      liftCode: ex.liftCode || ''
    })).filter(e => e.name);
  }
  // A displayed home-screen suggestion is NOT an active plan: only treat
  // lastIntentData as the plan once the lifter has ENGAGED Coach's Pick. Without
  // this gate, a cold direct-composer log (no session started, no pick tapped) was
  // narrated as if mid-plan — "Moving on — next up: <suggested lift>" + composer
  // pre-fill + a phantom next_move_advisory. Freestyle / ad-hoc logging stays clean.
  if (!coachSuggestionEngaged) return [];
  const intents = (lastIntentData && lastIntentData.intents) || [];
  const recommended = intents.find(i => i.recommended);
  const exs = recommended && Array.isArray(recommended.exercises) ? recommended.exercises : [];
  return exs.map(ex => ({
    name: ex.canonical_exercise || ex.exercise,
    canonical: ex.canonical_exercise || ex.exercise,
    liftCode: ex.lift_code || ex.liftCode || ''
  })).filter(e => e.name);
}

// The ordered exercise names (visible plan order). Unchanged contract — the names
// are exactly what currentPlanForChat / resolveCompletedIdentity emit.
function plannedExerciseOrder() {
  return plannedExerciseEntries().map(e => e.name);
}

// The planned exercises (visible order) NOT yet completed this session — the ONE
// shared "remaining after this log" source for nextPlanned, the bare-set attach
// target, and the set-effort reroute queue, so they can never disagree. Completion
// identity is normalized by resolveCompletedIdentity, so a logged alias
// ("Dips (Weighted)" / "Lat pull") is matched to its planned name
// ("Weighted Dip" / "Lat Pulldown") and correctly excluded.
function remainingPlannedExercises() {
  const completed = new Set(sessionCompleted.map(c => String(c).toLowerCase()));
  return plannedExerciseOrder().filter(name => {
    const n = String(name || '').toLowerCase();
    return n && !completed.has(n);
  });
}

function isPlanCloseoutAwaitingSave() {
  return sessionLog.length > 0 &&
    plannedExerciseOrder().length > 0 &&
    remainingPlannedExercises().length === 0;
}

// RC2 (FB closeout date): the vision parser returns a screenshot date ONLY when it
// is visible and unambiguous (strict YYYY-MM-DD), else null — so a present, valid ISO
// date is a "confident" signal. Anything else is treated as absent (→ today fallback).
function isConfidentScreenshotDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const d = new Date(`${value.trim()}T00:00:00`);
  if (Number.isNaN(d.getTime()) || getLocalDateString(d) !== value.trim()) return false;
  // Plausibility window (live incident 07-02: the vision model weekday-matched a
  // yearless "June 28" header to 2020 — a valid-looking date with an invented year).
  // Mirrors the server guard: ≤2 days ahead, ≤400 days back; outside → not confident
  // → today-fallback + the visible warning, never silently used.
  const today = new Date(`${getLocalDateString()}T00:00:00`);
  const diffDays = (d.getTime() - today.getTime()) / 86400000;
  return diffDays <= 2 && diffDays >= -400;
}

// Resolve the workout date for a closeout SAVE carrying an Apple Watch screenshot.
// Priority: an EXPLICITLY-entered manual date wins; else a confidently-parsed
// screenshot date wins; else fall back to today (flagged so the preview warns). The
// chosen date is authoritative for the log rows, session_id, effort row, and preview
// copy so they can never disagree (the "July 27 screenshot saved as today" bug).
// Returns { date, source } with source ∈ manual | screenshot | today_fallback.
function resolveCloseoutWorkoutDate({ manualDate, manualEntered, screenshotDate, today }) {
  if (manualEntered && typeof manualDate === 'string' && manualDate.trim()) {
    return { date: manualDate.trim(), source: 'manual' };
  }
  if (isConfidentScreenshotDate(screenshotDate)) {
    return { date: screenshotDate.trim(), source: 'screenshot' };
  }
  return { date: today, source: 'today_fallback' };
}

// Shared date-source notice for the save preview (used by both the log-workout and
// complete-workout previews) — keeps the copy identical wherever a date is resolved.
function renderDateSourceNotice(source, date) {
  if (!date) return null;
  if (source === 'today_fallback') {
    const warn = el('div', { class: 'preview-warnings preview-date-warning' }, [
      '⚠️ Date not found in screenshot — saving as ',
      el('strong', { text: date }),
      ' (today). If this workout is from a different day, change the date field above and preview again.'
    ]);
    return warn;
  }
  if (source === 'screenshot') {
    return el('div', { class: 'preview-ok preview-date-source', text: `Date from screenshot: ${date}` });
  }
  if (source === 'manual') {
    return el('div', { class: 'preview-ok preview-date-source', text: `Date (manual): ${date}` });
  }
  return null;
}

function effortRowFromParsedEffort(effort, sessionId, date, location, notes) {
  if (!effort) return null;
  return {
    date,
    session_id: sessionId,
    duration: effort.duration,
    active_calories: effort.activeCalories,
    total_calories: effort.totalCalories,
    average_hr: effort.averageHR,
    peak_hr: effort.peakHR,
    location: location || '',
    notes: notes || ''
  };
}

// Resolve a lift_code for an exercise NAME from the loaded catalog datalist
// (option value = canonical_name, label = lift_code). This lets completion bridge
// a logged catalog canonical ("Dips (Weighted)") to a planned lift BY CODE without
// any network call — so conversational logging issues NO preview request (the
// mid-session no-write guardrail stays intact). Empty string when unresolved.
function liftCodeFromCatalog(name) {
  if (!name || typeof document === 'undefined') return '';
  const dl = document.getElementById('exercise-catalog');
  if (!dl) return '';
  const key = String(name).toLowerCase();
  const opt = Array.from(dl.options || []).find(o => (o.value || '').toLowerCase() === key);
  return opt ? (opt.label || '') : '';
}

// The first planned exercise (visible order) not yet logged this session — the
// lift a bare set sequence ("140 15 190 10 230 4/2…") should attach to when the
// lifter names no exercise, and the next-up handoff target. Null when there's no
// plan (started OR suggested) or it's complete. Shared by emitSetLogged's next-up
// and the parse context. Read-only — never changes what gets written or how.
function firstUnloggedPlannedLift() {
  return remainingPlannedExercises()[0] || null;
}

// Composer-first Phase A — the session header pin: the ONE persistent piece of
// in-workout UI (current lift · sets done · next up). Derived from the SAME
// canonical selectors the plan card and handoff read (firstUnloggedPlannedLift /
// remainingPlannedExercises / the sessionLog buffer), so it can never disagree
// with them. Display-only. Guided sessions show the next planned lift; freestyle
// deliberately omits "next" (B9 — the Next UI stays quiet during freestyle):
// the pin then shows only the last logged lift and the running set count.
// Hidden whenever nothing is in progress; the atlas:session-reset listener and
// the emitSetLogged/banner hooks keep it in lockstep with the session state.
function renderSessionPin() {
  const pin = document.getElementById('session-pin');
  if (!pin) return;
  const setsDone = sessionLog.length;
  const planned = plannedExerciseOrder();
  const guided = planned.length > 0;
  if (!setsDone && !guided) { pin.hidden = true; pin.textContent = ''; return; }
  const remaining = guided ? remainingPlannedExercises() : [];
  const current = guided
    ? (remaining[0] || planned[planned.length - 1])
    : (setsDone ? sessionLog[sessionLog.length - 1].exercise : null);
  const next = guided && remaining.length > 1 ? remaining[1] : null;
  pin.textContent = '';
  if (current) pin.appendChild(el('span', { class: 'pin-lift', text: String(current) }));
  pin.appendChild(el('span', { class: 'pin-sets', text: `${setsDone} set${setsDone === 1 ? '' : 's'} in` }));
  if (next) pin.appendChild(el('span', { class: 'pin-next', text: `next: ${next}` }));
  // The pin is the tap target for the collapsed plan card (dropdown) whenever a
  // live session exists. Wired once — the element persists across re-renders.
  const expandable = Boolean(activePlannedSession);
  if (expandable) {
    pin.appendChild(el('span', { class: 'pin-chevron', text: sessionChromeExpanded ? '\u25B4' : '\u25BE' }));
    pin.setAttribute('role', 'button');
    pin.tabIndex = 0;
    pin.setAttribute('aria-expanded', String(sessionChromeExpanded));
    pin.setAttribute('aria-controls', 'active-session-banner');
    pin.title = 'Session controls';
    if (!pin.dataset.chromeWired) {
      pin.dataset.chromeWired = '1';
      const toggle = () => {
        if (!activePlannedSession) return;
        sessionChromeExpanded = !sessionChromeExpanded;
        renderActiveSessionBanner();
      };
      pin.addEventListener('click', toggle);
      pin.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
  } else {
    pin.removeAttribute('role');
    pin.removeAttribute('aria-expanded');
    pin.tabIndex = -1;
  }
  pin.hidden = false;
}

// Returns the currently-active planned exercise (first unlogged) with prescription
// details. Uses the canonical session to determine which exercise is current so
// the stale `activePlannedSession.index` cursor (which lags after a logged set
// until "Next exercise →" is clicked) never drives a substitute check or plan-step
// payload. Falls back to the index-based entry when activeSession is unavailable.
// (P0 PR 2 — docs/ACTIVE_SESSION_STATE_DIAGNOSIS.md)
function currentPlannedExercise() {
  if (!activePlannedSession || !Array.isArray(activePlannedSession.exercises)) return null;
  const AS = (typeof window !== 'undefined' && window.activeSession) ||
             (typeof activeSession !== 'undefined' ? activeSession : null);
  if (!AS) {
    // activeSession module unavailable — fall back to index-based entry so
    // advancePlannedSession() doesn't silently end the session.
    return activePlannedSession.exercises[activePlannedSession.index] || null;
  }
  const canon = getCanonicalSession();
  const cur = canon && AS.currentExercise(canon);
  if (!cur) return null; // all exercises logged — caller (advancePlannedSession) ends session correctly

  // Step 379 guard: if the lifter declared a swap for this exact exercise
  // (pendingSubstitution is set and the prescribed name matches the canonical current),
  // the swap hasn't been applied yet (emitSetLogged applies it at log time), so
  // sessionCompleted still excludes the swapped-out lift — meaning the canonical session
  // would keep returning it as "current" on every subsequent message. Skip it here and
  // peek at the next unswapped remaining exercise instead, so substitute checks and the
  // plan payload always send the actual next-up lift, not the declared-taken one.
  let name = cur.name;
  if (pendingSubstitution) {
    const prescKey = (pendingSubstitution.prescribed || '').toLowerCase();
    if (prescKey && name.toLowerCase() === prescKey) {
      const nextName = remainingPlannedExercises().find(n => n.toLowerCase() !== prescKey);
      if (!nextName) return null;
      name = nextName;
    }
  }

  const key = name.toLowerCase();
  return activePlannedSession.exercises.find(
    ex => (ex.canonicalName || ex.name || '').toLowerCase() === key
  ) || { name, liftCode: cur.liftCode || '', canonicalName: name };
}

// Editor-ready rows from the buffer, numbering sets per exercise.
function buildRowsFromSessionLog() {
  const counts = new Map();
  return sessionLog.map(s => {
    const n = (counts.get(s.exercise) || 0) + 1;
    counts.set(s.exercise, n);
    return { exercise: s.exercise, set_number: String(n), weight: s.weight, reps: s.reps, rir: s.rir, notes: s.notes || '' };
  });
}

// Ordered, de-duplicated exercise names from a set-buffer ([{exercise,…}]). Pure —
// preserves first-seen order, drops blanks/dupes. Used to recap what was logged.
function orderedUniqueExercises(rows) {
  const seen = new Set();
  const out = [];
  for (const s of (Array.isArray(rows) ? rows : [])) {
    const name = s && s.exercise != null ? String(s.exercise).trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// A read-only "already saved this session" recap for the confirm/review card, so a
// closeout after a mid-workout save still shows the earlier, already-saved
// exercises. Returns null when nothing was saved yet this workout. DISPLAY ONLY —
// these names never enter a write payload; the write is the previewed buffer.
function renderSavedThisSessionRecap() {
  const names = orderedUniqueExercises(sessionSavedLog);
  if (!names.length) return null;
  return el('div', { class: 'saved-this-session muted small' }, [
    el('span', { text: `Already saved this session: ${names.join(', ')} ✓` })
  ]);
}

// Resolve the best stable identity for plan_completed tracking against the ACTIVE
// plan source (a started session OR the coach-suggested plan — plannedExerciseEntries),
// so completion is recognized in BOTH flows. Returns the planned name exactly as
// plannedExerciseOrder / currentPlanForChat emit it, so the server's name-based
// computePlanState and the client's remaining-queue filter both match.
// Priority:
//   1. lift_code match (authoritative catalog identity from the enrichment row)
//   2. canonical_exercise exact match → planned canonical/display name
//   3. raw-name alias/contains match (mirrors planStepFor / getNextExerciseInPlan)
//      so "Lat pull" → "Lat Pulldown" and "Weighted dips" → "Weighted Dip" resolve
//   4. fall back to the raw logged exercise name
function resolveCompletedIdentity(rawName, enrichmentRow) {
  const entries = plannedExerciseEntries();
  if (entries.length) {
    // lift_code is the reliable bridge across naming differences ("Dips (Weighted)"
    // vs planned "Weighted Dip"). Prefer the enrichment's code (started flow);
    // otherwise resolve it from the catalog datalist by the logged canonical / raw
    // name — no network call, so conversational logging issues no preview request.
    const loggedCode = (enrichmentRow && enrichmentRow.lift_code)
      || liftCodeFromCatalog(enrichmentRow && enrichmentRow.canonical_exercise)
      || liftCodeFromCatalog(rawName)
      || '';
    if (loggedCode) {
      const codeKey = String(loggedCode).toLowerCase();
      // TWO-SIDED code bridge (owner live find 2026-07-03): a chat-created plan
      // carries no lift codes, so resolve the ENTRY's code from the catalog too
      // — "Rdl" (RDL01 via the variant-aware datalist) must reach the plan slot
      // "Romanian Deadlift" (RDL01 via its canonical name) even when the
      // best-effort enrichment call never returned.
      const match = entries.find(e => {
        const entryCode = e.liftCode || liftCodeFromCatalog(e.canonical) || liftCodeFromCatalog(e.name) || '';
        return entryCode && entryCode.toLowerCase() === codeKey;
      });
      if (match) return match.name;
    }
    const canonical = (enrichmentRow && enrichmentRow.canonical_exercise) || '';
    if (canonical) {
      const key = canonical.toLowerCase();
      const match = entries.find(e => e.canonical.toLowerCase() === key || e.name.toLowerCase() === key);
      if (match) return match.name;
    }
    const rk = String(rawName || '').toLowerCase();
    if (rk) {
      const match = entries.find(e => {
        const n = e.name.toLowerCase();
        return n === rk || n.includes(rk) || rk.includes(n);
      });
      if (match) return match.name;
      // Word-subset tier (mirrors planMutationIntent's resolver): every word of
      // the logged name present in the slot name, two-word minimum — bridges
      // "single leg press" → "Single-Leg Seated Leg Press" without codes.
      const words = s => new Set(String(s).toLowerCase().replace(/[-/]+/g, ' ').split(/\s+/)
        .map(w => (/[^s]s$/.test(w) ? w.slice(0, -1) : w)).filter(Boolean));
      const rawWords = [...words(rk)];
      if (rawWords.length >= 2) {
        const sub = entries.find(e => {
          const ew = words(e.name);
          return rawWords.every(w => ew.has(w));
        });
        if (sub) return sub.name;
      }
    }
  }
  return rawName;
}

function emitSetLogged(logObjs, text, substitutions, enrichment) {
  const byExercise = [];
  const seen = new Map();
  // Build a lookup from raw exercise name → enrichment row for identity resolution.
  const enrichMap = new Map();
  if (Array.isArray(enrichment)) {
    for (const e of enrichment) { if (e && e.exercise) enrichMap.set(e.exercise, e); }
  }
  // Step 373b: if a swap was declared for the current step, the first logged
  // exercise is the substitute — apply it to the live session BEFORE resolving
  // completed identities, so the substitute (not the swapped-out lift) is what
  // gets marked done and what leaves remaining.
  if (pendingSubstitution && activePlannedSession && Array.isArray(logObjs) && logObjs.length && logObjs[0].exercise) {
    const primaryRaw = logObjs[0].exercise;
    const enr = enrichMap.get(primaryRaw) || {};
    applySessionSubstitution(pendingSubstitution.prescribed, enr.canonical_exercise || primaryRaw, enr.lift_code || '', pendingSubstitution.prescription || null);
    pendingSubstitution = null;
  }
  for (const o of (logObjs || [])) {
    if (!o.exercise) continue;
    if (!seen.has(o.exercise)) { const g = { exercise: o.exercise, sets: [] }; seen.set(o.exercise, g); byExercise.push(g); }
    seen.get(o.exercise).sets.push({
      weight: o.weight,
      reps: o.reps,
      rir: (o.rir === '' || o.rir == null) ? null : Number(o.rir)
    });
    // Accumulate the raw set into the session buffer for the end-of-session save.
    sessionLog.push({ exercise: o.exercise, weight: o.weight, reps: o.reps, rir: o.rir, notes: o.notes || '' });
    // Track the best available planned identity for plan_completed wiring so the
    // server's name-based computePlanState can mark the exercise as done even
    // when the logged canonical name differs from the plan entry name.
    const completedName = resolveCompletedIdentity(o.exercise, enrichMap.get(o.exercise));
    if (!sessionCompleted.includes(completedName)) sessionCompleted.push(completedName);
  }
  if (byExercise.length) {
    try {
      // nextPlanned (the handoff/composer target) and plannedQueue (the set-effort
      // reroute queue) derive from the SAME remaining-after-this-log source, so the
      // handoff, composer placeholder, and reroute can never disagree — and a lift
      // just completed (under any alias) is never re-offered or deferred.
      // Read-only narration; suggestion-only — it never reorders or mutates the plan.
      const remaining = remainingPlannedExercises();
      const nextPlanned = remaining[0] || null;
      const plannedQueue = remaining;
      // Plan complete = a plan exists (started OR coach-suggested) and nothing
      // remains. Derive it from the SAME remaining state as nextPlanned so the two
      // can't disagree. The old check only consulted activePlannedSession, so in the
      // coach-suggestion flow (activePlannedSession === null) it was ALWAYS false —
      // after the last logged lift the closeout never fired and the handoff fell
      // through to the divergent getNextExerciseInPlan fallback, resurrecting an
      // already-completed lift (the live "wanted weighted dips again" bug).
      // keep in sync with computeCloseout in services/sessionCloseout.js
      const planIsComplete = plannedExerciseOrder().length > 0 && remaining.length === 0;
      document.dispatchEvent(new CustomEvent('atlas:set-logged', {
        detail: {
          exercises: byExercise,
          text: text || '',
          planIsComplete,
          nextPlanned,
          // The completed-lift names this session, so the handoff's /api/plan/today
          // fallback can reject a next-up that's already done (its order can diverge
          // from what was actually logged — the source of the resurrected lift).
          completed: [...sessionCompleted],
          // The engaged plan's exercise order (active session OR engaged Coach's Pick;
          // empty when freestyling). The handoff uses it to reject a fallback next-up
          // that isn't part of today's session — so the /api/plan/today lookup can't
          // surface a stored-program lift the lifter isn't following (the live
          // "next up: Hammer Curls" that wasn't in the plan, and the off-plan lift that
          // overrode the closeout once the engaged plan was already complete).
          plannedOrder: plannedExerciseOrder(),
          ...(plannedQueue.length ? { plannedQueue } : {}),
          ...(Array.isArray(substitutions) && substitutions.length ? { substitutions } : {}),
          // Card/advisory consistency (owner 07-02): the parser-unrecognized name (if
          // any) so the confirmation card marks it "check name" instead of a bare ✓.
          ...(lastUnverifiedExercise ? { unverified: lastUnverifiedExercise } : {})
        }
      }));
    } catch { /* narration is optional */ }
  }
  // The session lives in the buffer (sessionLog) above, not the parsed-rows
  // editor — clear the transient rows so the end-of-session save rebuilds the
  // FULL session from the buffer.
  if (setsTableBody) setsTableBody.innerHTML = '';
  if (parsedRowsEditor) parsedRowsEditor.hidden = true;
  // Every logged set refreshes the session pin (current lift · sets in · next).
  renderSessionPin();
  lastParsedWorkoutText = '';
  invalidatePreview();
  // B2 canonical state — a logged set advanced the canonical session, so refresh the
  // plan card to the new current step (syncPlannedIndexToCanonical) instead of leaving
  // it stuck on the just-logged lift. Guarded for the emit test harness.
  if (typeof renderActiveSessionBanner === 'function') renderActiveSessionBanner();
  // persist the just-logged set for resume safety (guarded for the emit test harness)
  if (typeof saveSessionSnapshot === 'function') saveSessionSnapshot();
}

// `justLoggedSet` (optional) anchors the recommendation on the set the lifter
// just logged — under session-level save it isn't in the sheet yet, so without
// it the recommendation reflects the PREVIOUS session. Other callers (preview,
// post-write) omit it and get the history-only recommendation, unchanged.
async function fetchReaction(liftCode, justLoggedSet) {
  if (!liftCode || !getApiKey()) return null;
  try {
    const params = new URLSearchParams();
    // Thread the active plan intent (e.g. 'recovery_pump' / 'deload_reset') so the
    // engine's reaction AND the next-set prescription flip on a recovery day — an
    // easy/high-RIR set reads on-plan, not "add weight". Sourced via getActiveIntentId
    // so an engaged-but-unmaterialized Coach's Pick still carries its intent
    // (BUG-20260629-204817).
    const intentId = getActiveIntentId();
    if (intentId) params.set('intentId', intentId);
    if (justLoggedSet && justLoggedSet.weight != null && justLoggedSet.reps != null) {
      params.set('w', String(justLoggedSet.weight));
      params.set('reps', String(justLoggedSet.reps));
      if (justLoggedSet.rir != null && justLoggedSet.rir !== '') params.set('rir', String(justLoggedSet.rir));
    }
    const qs = params.toString();
    const path = `/api/recommend/next/${encodeURIComponent(liftCode)}${qs ? `?${qs}` : ''}`;
    const res = await api(path);
    return res.data || null;
  } catch {
    return null;
  }
}

// Constraint detection: call the substitute endpoint and dispatch the result.
// Returns true when a recommendation card was dispatched, false otherwise.
// Callers use the return value to decide whether to fall back to the coach route
// — the coach is suppressed only when a card was actually rendered, so an
// exercise not in the ~14-entry catalog still gets a coach reply.
async function checkAndSuggestSubstitute(text) {
  if (!text || !activePlannedSession || !activePlannedSession.exercises.length) return false;
  // Use canonical session to find the current exercise — exercises[index] lags after
  // a logged set until "Next exercise →" is clicked, causing stale substitute checks.
  const currentEx = currentPlannedExercise();
  if (!currentEx || !currentEx.name || !getApiKey()) return false;
  try {
    const res = await api('/api/suggest-substitute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, current_exercise: currentEx.name })
    });
    const rec = res && res.data && res.data.recommendation;
    if (rec) {
      // Step 373b: the lifter declared a swap for the current step. Record the
      // prescribed (swapped-out) lift so the NEXT logged exercise replaces this
      // slot in the live session (applied in emitSetLogged).
      // AC3: also store the prescription (weight/reps/sets) from the API response so
      // applySessionSubstitution can populate the replacement slot instead of null.
      pendingSubstitution = { prescribed: currentEx.canonicalName || currentEx.name,
        prescription: rec.next_target || null };
      // Step 379: advance the authoritative session cursor past the taken/swapped
      // exercise. Otherwise the cursor stays on the lift the lifter just moved off,
      // and a subsequent conversational message would send that stale name as
      // current_exercise to /api/suggest-substitute (and the banner would keep
      // showing the taken exercise). The deferred swap is applied by NAME in
      // emitSetLogged, so it is unaffected by this cursor move. We deliberately do
      // NOT call advancePlannedSession(): that clears pendingSubstitution and
      // restarts the logger input mid-conversation. Clamp so we never overrun the
      // plan (no premature session-end on the last slot).
      if (activePlannedSession.index < activePlannedSession.exercises.length - 1) {
        activePlannedSession.index += 1;
        renderActiveSessionBanner();
      }
      document.dispatchEvent(new CustomEvent('atlas:substitute-suggested', {
        detail: { prescribed: currentEx.name, ...rec }
      }));
      return true;
    }
  } catch { /* best-effort */ }
  return false;
}

// Did the just-saved session set a PR for this lift? Reads the fresh PR list
// (which already includes the rows we just wrote) and matches each best set's
// session_id to the session we saved. Read-only and best-effort — any failure
// just yields no PR label.
async function fetchSessionPrLabel(liftCode, sessionId) {
  if (!liftCode || !sessionId || !getApiKey()) return '';
  try {
    const res = await api('/api/prs/recent');
    const prs = res.data?.prs || [];
    const code = String(liftCode).toUpperCase();
    const pr = prs.find(p => String(p.liftCode || '').toUpperCase() === code);
    if (!pr) return '';
    if (pr.bestWeightSet?.session_id === sessionId) return `weight PR at ${pr.bestWeightSet.weight} lb`;
    if (pr.bestEstimated1RMSet?.session_id === sessionId) return 'estimated 1RM PR';
    if (pr.bestRepSet?.session_id === sessionId) return `rep PR — ${pr.bestRepSet.reps} @ ${pr.bestRepSet.weight} lb`;
    return '';
  } catch {
    return '';
  }
}

// Is this lift currently flagged as stalled? Read-only and best-effort.
async function fetchStall(liftCode) {
  if (!liftCode || !getApiKey()) return null;
  try {
    const res = await api('/api/stalls');
    const stalls = res.data?.stalls || [];
    const code = String(liftCode).toUpperCase();
    return stalls.find(s => String(s.liftCode || '').toUpperCase() === code) || null;
  } catch {
    return null;
  }
}

// Attach best-effort PR + stall context to a recommendation so buildVerdict can
// rank them above the trend signals. Read-only; any failure simply leaves the
// fields empty and the verdict falls back to the trend/fallback lines.
async function attachVerdictContext(rec, liftCode, sessionId) {
  const [prLabel, stall] = await Promise.all([
    fetchSessionPrLabel(liftCode, sessionId),
    fetchStall(liftCode)
  ]);
  rec.prLabel = prLabel;
  rec.stall = stall;
  return rec;
}

async function verifyWrittenRange(range, sessionId, expectedRows) {
  if (!range || !sessionId || !getApiKey()) return false;
  try {
    const params = new URLSearchParams({ range, session_id: sessionId });
    if (expectedRows) params.set('expected_rows', String(expectedRows));
    const res = await api(`/api/log-workout/verify-range?${params}`);
    return res?.data?.verified === true;
  } catch {
    return false;
  }
}

function renderAtlasSuggestion(rec) {
  if (!rec || !rec.next_target || !rec.last_working_sets || !rec.last_working_sets.length) return null;
  const lastSet = rec.last_working_sets[rec.last_working_sets.length - 1];
  const target = rec.next_target;
  const lastLabel = lastSet.rir != null ? `${formatSetLoad(lastSet.weight, lastSet.reps)} @${lastSet.rir}` : formatSetLoad(lastSet.weight, lastSet.reps);
  const targetLabel = `${target.weight} × ${target.reps} × ${target.sets}`;
  const rows = [
    ['Last', lastLabel],
    ['Target', targetLabel],
  ];
  if (rec.reasoning) rows.push(['Why', rec.reasoning]);
  const sessionNote = rec.sessions_analyzed ? ` · ${rec.sessions_analyzed} sessions` : '';
  return el('div', { class: 'atlas-suggestion' }, [
    el('div', { class: 'suggestion-header', text: `Atlas — ${rec.liftCode}${sessionNote}` }),
    ...rows.map(([label, value]) => el('div', { class: 'suggestion-row' }, [
      el('span', { class: 'suggestion-label', text: label }),
      el('span', { text: value }),
    ])),
  ]);
}

// Pull the previewed sets for one lift code out of the 12-column preview rows.
// Columns: 5 lift_code · 7 weight · 8 reps · 9 rir.
function previewSetsForLift(rows, liftCode) {
  const code = String(liftCode).toUpperCase();
  return (rows || [])
    .filter(r => String(r[5] || '').toUpperCase() === code)
    .map(r => ({
      weight: Number(r[7]),
      reps: Number(r[8]),
      rir: r[9] === '' || r[9] == null ? null : Number(r[9])
    }));
}

// Deterministic "are these previewed sets progress?" hint, comparing today's
// top set to last session's top set and the recommended next target.
function previewProgressHint(todayTopWeight, lastSet, target) {
  if (!lastSet || !Number.isFinite(lastSet.weight)) {
    return 'first time logging this — sets your baseline';
  }
  if (!Number.isFinite(todayTopWeight) || todayTopWeight <= 0) return null;
  const diff = Math.round((todayTopWeight - lastSet.weight) * 10) / 10;
  if (diff > 0) return `above last session (+${diff} lb)`;
  if (diff === 0) {
    return target && Number.isFinite(target.weight) && target.weight > todayTopWeight
      ? 'matching last top set — clear your reps/RIR to earn the next jump'
      : 'matching last top set';
  }
  return `below last top set (${lastSet.weight} lb)`;
}

// One compact per-exercise coaching card for the preview: last session's top
// set and a plain-English coaching hint. Read-only.
function renderPreviewCoachCard(rec, liftCode, todaySets) {
  if (!todaySets || !todaySets.length) return null;
  const name = (rec && rec.exercise_name) || liftCode;
  const lastSets = (rec && rec.last_working_sets) || [];
  const lastSet = lastSets.length ? lastSets[lastSets.length - 1] : null;
  const target = rec && rec.next_target;
  const todayTop = Math.max(0, ...todaySets.map(s => (Number.isFinite(s.weight) ? s.weight : 0)));

  const rows = [];
  if (lastSet && Number.isFinite(lastSet.weight)) {
    const rir = lastSet.rir != null ? ` @ RIR${lastSet.rir}` : '';
    rows.push(['Last', `${formatSetLoad(lastSet.weight, lastSet.reps)}${rir}`]);
  }
  // Hint prefers the plain-English recommendation; falls back to the progress
  // comparison so a card always carries a usable cue.
  const hint = (rec && rec.recommendation) || previewProgressHint(todayTop, lastSet, target);
  if (hint) rows.push(['Hint', hint]);

  if (!rows.length) return null;
  return el('div', { class: 'atlas-suggestion' }, [
    el('div', { class: 'suggestion-header', text: name }),
    ...rows.map(([label, value]) => el('div', { class: 'suggestion-row' }, [
      el('span', { class: 'suggestion-label', text: label }),
      el('span', { text: value }),
    ])),
  ]);
}

// Deterministic post-write coach verdict. Priority: PR in the just-saved
// session, then a stall/watchout, then the e1RM/top-set trend, then a plain
// fallback. PR + stall context ride on the rec object (rec.prLabel / rec.stall)
// so the call site stays a single buildVerdict(rec).
function buildVerdict(rec) {
  if (!rec || !rec.last_working_sets || !rec.last_working_sets.length) return null;

  // PR in the session we just saved takes top billing.
  if (rec.prLabel) return rec.prLabel;

  // Stall / watchout: this lift hasn't progressed in N sessions.
  if (rec.stall && rec.stall.sessions_stalled) {
    return `no progression in ${rec.stall.sessions_stalled} sessions — consider a deload`;
  }

  const rule = rec.rule_decision;

  // holdUntilClean: criterion met → load
  if (rule?.decision === 'load') {
    return rule.criterion_progress
      ? `${rule.criterion_progress} — ready to load`
      : 'standard met — ready to load';
  }

  // holdUntilClean: hold → show progress
  if (rule?.decision === 'hold' && rule.criterion_progress) {
    return rule.criterion_progress;
  }

  // e1RM trending down — flag it
  if (rec.e1rm_trend === 'down') {
    return 'e1RM trending down';
  }

  // Weight increase vs any of the last 5 sets (recent-best, not all-time)
  const allSets = rec.last_working_sets;
  const lastSet = allSets[allSets.length - 1];
  const prevWeights = allSets.slice(0, -1).map(s => s.weight || 0).filter(w => w > 0);
  if (prevWeights.length > 0 && lastSet.weight > Math.max(...prevWeights)) {
    return `weight up to ${lastSet.weight} lb`;
  }

  // e1RM trending up
  if (rec.e1rm_trend === 'up') {
    return 'e1RM trending up';
  }

  // Fallback — nothing notable, but acknowledge the save.
  return 'no major trend change detected yet';
}

function invalidatePreview() {
  pendingWrite = null;
  runEffortCardCleanups();
  lastParserStatus = null;
  previewPanel.hidden = true;
  previewContent.innerHTML = '';
  const btn = document.getElementById('approve-btn');
  btn.disabled = true;
  btn.textContent = 'Write to Google Sheets';
  const note = document.getElementById('preview-gate-note');
  if (note) note.textContent = 'Run a preview above to enable this button.';
}

document.getElementById('logger-form').addEventListener('input', invalidatePreview);

function startOverWorkout() {
  workoutTextInput.value = '';
  lastParsedWorkoutText = '';
  sessionLog = [];
  sessionCompleted = [];
  sessionSavedLog = [];     // deliberate fresh start — forget this workout's saved recap
  clearSessionSnapshot();   // a deliberate reset must not resume the old session
  document.dispatchEvent(new CustomEvent('atlas:session-reset'));
  closeoutScreenshotFile = null;
  closeoutScreenshotEffort = null;
  closeoutScreenshotDateSource = null;
  setsTableBody.innerHTML = '';
  parsedRowsEditor.hidden = true;
  const effortDetails = document.getElementById('effort-details');
  if (effortDetails) {
    effortDetails.hidden = true;
    effortDetails.open = false;
    ['effort-duration', 'effort-active-cal', 'effort-total-cal', 'effort-avg-hr', 'effort-peak-hr'].forEach(id => {
      const inp = document.getElementById(id);
      if (inp) inp.value = '';
    });
    const fileInp = document.getElementById('effort-image');
    if (fileInp) fileInp.value = '';
    const manualRadio = document.querySelector('input[name="effort-mode"][value="manual"]');
    if (manualRadio) manualRadio.checked = true;
  }
  invalidatePreview();
  workoutTextInput.focus();
}

document.getElementById('start-over-btn')?.addEventListener('click', startOverWorkout);

// End-of-session compilation: take the in-memory chat history, ask the server
// to extract the workout sets the lifter logged conversationally, then populate
// the composer and trigger a normal parse → preview → approve flow.
async function handleLogIt() {
  // P0 closeout trust: NEVER return silently. Every path below either drives the
  // preview or sets a visible status; this wrapper guarantees a visible message even
  // if an unexpected throw occurs (the "log it disappeared" bug must be impossible).
  try {
    await runCloseout();
  } catch (err) {
    setStatus(loggerStatus, `Couldn't close out the session: ${err && err.message ? err.message : 'unexpected error'}. Nothing was saved — try again.`, 'error');
  }
}

async function runCloseout() {
  // CANONICAL SOURCE OF TRUTH: build the closeout rows from the structured set
  // buffer (sessionLog) — the same source getCanonicalSession() derives from. No
  // Gemini, no re-parse. This is what the visible logged cards were rendered from,
  // so if cards exist, this finds them.
  if (sessionLog.length) {
    // Only repopulate from the buffer if the table is empty. If the user already
    // ran closeout and then edited or deleted rows (e.g. to fix a bad-RIR row),
    // preserve their edits — don't overwrite with the original bad rows again.
    if (!setsTableBody.children.length) {
      populateSetRows(buildRowsFromSessionLog());
    }
    sessionCompiledAwaitingPreview = true;
    document.getElementById('logger-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return;
  }

  // Live-audit Bug #2: after a save the buffer is reset. With an EMPTY buffer AND a
  // prior save this session (lastWrite set), "log it" has nothing new — say so
  // plainly instead of recompiling the already-saved chat history, which both
  // implied a fresh save ("session logged / great work") and risked re-writing the
  // sets already on the sheet. New sets logged after a save DO buffer (sessionLog
  // non-empty → the branch above), so this only fires when there is genuinely
  // nothing new to log.
  if (lastWrite) {
    setStatus(loggerStatus, 'Nothing new to log since your last save — log some sets first.', 'warn');
    return;
  }

  const turns = typeof window.getChatHistory === 'function' ? window.getChatHistory() : [];

  // The buffer is empty AND nothing was saved. Before the LLM compile, check the
  // canonical session: if it shows completed work (e.g. after a reload the plan +
  // completions survived but the raw set buffer didn't), the set details aren't in
  // memory to rebuild — say so honestly and route to manual entry, NEVER the false
  // "no sets" while the lifter can see logged cards (P0 closeout trust).
  const canon = typeof getCanonicalSession === 'function' ? getCanonicalSession() : null;
  const AS = (typeof window !== 'undefined' && window.activeSession) || null;
  const canonHasWork = !!(canon && AS && typeof AS.hasLoggedWork === 'function' && AS.hasLoggedWork(canon));

  if (!turns.length) {
    setStatus(loggerStatus, canonHasWork
      ? "I can see your logged exercises, but their set details aren't in memory to compile (the app may have reloaded). Re-enter the sets in the composer and tap Save — nothing was lost on your sheet."
      : "No conversation yet — log some sets in the chat first, then say 'log it'.", 'error');
    return;
  }

  setStatus(loggerStatus, 'Compiling session from conversation…', 'ok');

  let workoutText;
  try {
    const res = await api('/api/session/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: turns })
    });
    workoutText = res.data?.workout_text || null;
  } catch (err) {
    // Compile is the LLM fallback; when it's down, do NOT claim "no sets". Say the
    // compile is unavailable and route to manual entry.
    setStatus(loggerStatus, `Couldn't compile the session right now (the coach may be offline). Type your sets in the composer and tap Save — nothing was saved yet.`, 'error');
    return;
  }

  if (!workoutText) {
    // Distinguish a genuine empty conversation from "the compiler found nothing but
    // the lifter clearly logged work" — never a flat false "no sets" when canonical
    // state shows completed exercises.
    setStatus(loggerStatus, canonHasWork
      ? "I couldn't recompile your sets from the conversation, but I can see you logged exercises. Re-enter them in the composer and tap Save — nothing was saved yet."
      : "Couldn't find any sets in the conversation — did you log any exercises? You can type them in the composer directly.", 'error');
    return;
  }

  setStatus(loggerStatus, '', 'ok');
  workoutTextInput.value = workoutText;
  invalidatePreview();
  // Signal the submit handler to run parse → preview instead of routing to coach.
  sessionCompiledAwaitingPreview = true;
  document.getElementById('logger-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

// One write_id per previewed workout: if the live write is retried (double
// tap, network blip), the backend recognises the id and refuses to append
// twice, returning proof the original write completed instead.
function generateWriteId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `w-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function hasLogWorkoutNoWriteProof(result) {
  const data = result?.data || {};
  return data.test_mode === true &&
    data.sheet_write === 'skipped' &&
    data.sheet_written === false &&
    data.no_write_confirmed === true;
}

function hasCompleteWorkoutNoWriteProof(result) {
  const data = result?.data?.data || {};
  return data.test_mode === true &&
    data.sheet_write === 'skipped' &&
    data.sheet_written === false &&
    data.no_write_confirmed === true;
}

// Modality (cardio / circuit / timed-hold) dry-run no-write proof. The
// /api/log-modality dry-run returns its proof at result.data (like the manual
// log-workout path), NOT nested under data.data.
function hasLogModalityNoWriteProof(result) {
  const data = result?.data || {};
  return data.test_mode === true &&
    data.sheet_write === 'skipped' &&
    data.sheet_written === false &&
    data.no_write_confirmed === true;
}

function previewProofFromResult(result, mode) {
  const data = (mode === 'manual' || mode === 'modality') ? (result?.data || {}) : (result?.data?.data || {});
  return {
    mode,
    test_mode: data.test_mode,
    sheet_write: data.sheet_write,
    sheet_written: data.sheet_written,
    no_write_confirmed: data.no_write_confirmed,
    created_at_ms: Date.now()
  };
}

function pendingWriteHasPreviewProof(write) {
  if (!write || !write.previewProof) return false;
  const proof = write.previewProof;
  if (proof.test_mode !== true || proof.sheet_written !== false || proof.no_write_confirmed !== true) return false;
  if (proof.mode === 'manual' && proof.sheet_write !== 'skipped') return false;
  if (proof.mode === 'modality' && proof.sheet_write !== 'skipped') return false;
  if ((proof.mode === 'screenshot' || proof.mode === 'effort-only') && proof.sheet_write !== 'skipped') return false;
  return true;
}

// PR 486 frontend wiring — the modality (cardio / interval / circuit / timed-hold)
// trust loop. MIRRORS the slash trust loop and never alters it: a dry-run preview
// proves no-write, the existing #approve-btn is the only write trigger, and the
// real write goes through /api/log-modality only on explicit approval.
const MODALITY_LOG_LABELS = ['Date', 'Session', 'Modality', 'Exercise', 'Duration (s)', 'Distance (m)', 'Rounds', 'Rest (s)', 'Level', 'RPE', 'Avg HR', 'Notes'];
// Human label for the preview heading, keyed by the parser's modality value
// (services/multiModalityParser.js). Falls back to a generic heading so a hold
// never reads "Cardio".
const MODALITY_HEADINGS = {
  cardio_steady: 'Cardio',
  cardio_interval: 'Intervals',
  circuit: 'Circuit / conditioning',
  timed_hold: 'Timed hold'
};

function renderModalityPreview(preview) {
  previewContent.innerHTML = '';
  const label = MODALITY_HEADINGS[preview.modality] || 'Conditioning';
  previewContent.appendChild(el('h3', { text: `${label} to write (Modality_Log)` }));
  const row = Array.isArray(preview.row) ? preview.row : [];
  // Key/value list of exactly what will be written — blanks omitted for clarity.
  const pairs = MODALITY_LOG_LABELS
    .map((label, i) => [label, row[i]])
    .filter(([, v]) => v !== '' && v !== null && v !== undefined);
  previewContent.appendChild(renderTable(['Field', 'Value'], pairs));
  previewContent.appendChild(el('div', { class: 'muted small', text: 'Writes one row to the Modality_Log tab. Strength sets are unaffected.' }));
  previewPanel.hidden = false;
  previewPanel.open = true;
}

// Question-shaped input must reach the coach, not a write preview. The modality
// recognizer is name+quantity based, so "how was my 5km run?" carries a cardio word
// and a distance and would otherwise stage a (garbage-exercise) write preview. We
// suppress only CLEAR questions — a trailing "?" or an interrogative lead word —
// and deliberately omit log-ambiguous verbs (did/do/does/ran) so a real entry like
// "Did 5k run 30:00" is never blocked. Fail-open toward the coach: a suppressed
// input simply routes to chat, never to a write.
function looksLikeModalityQuestion(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  return /^(how|hows|what|whats|why|when|where|who|which|whose|should|was|were|is|are|can|could|would|will)\b/.test(t);
}

// Try to stage a modality input as a previewed-but-unwritten approval. Returns
// true when it owned the input (a recognized modality was previewed, OR a friendly
// fail-closed message was shown); false when the input is NOT a modality (the
// caller then falls through to the coach). Read-only: only a test_mode dry-run runs
// here — the actual write happens solely in the #approve-btn handler.
async function tryPreviewModality(text, sessionId, date) {
  if (!text || !date) return false;
  // A question about training is for the coach — never stage it as a write preview.
  if (looksLikeModalityQuestion(text)) return false;
  let result;
  try {
    result = await api('/api/log-modality', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, session_id: sessionId, date, test_mode: true })
    });
  } catch (err) {
    // 422 = not a recognized modality → let the caller route to the coach.
    // Any other failure → we can't trust a preview, so we never stage a write.
    return false;
  }
  const data = result?.data || {};
  if (!data.modality || !Array.isArray(data.modality_row_preview)) return false;
  // Fail closed: never enable approval without the dry-run no-write proof.
  if (!hasLogModalityNoWriteProof(result)) {
    setStatus(loggerStatus, "Couldn't safely preview that cardio/conditioning entry — nothing was staged to write.", 'error');
    return true;
  }
  pendingWrite = {
    mode: 'modality',
    text,
    sessionId,
    date,
    writeId: generateWriteId(),
    previewProof: previewProofFromResult(result, 'modality')
  };
  renderModalityPreview({ modality: data.modality, row: data.modality_row_preview });
  document.getElementById('approve-btn').disabled = !pendingWriteHasPreviewProof(pendingWrite);
  setStatus(loggerStatus, `Previewed ${String(data.modality).replace(/_/g, ' ')} — review and approve to write.`, 'ok');
  return true;
}

// True when the lifter has attached effort (a screenshot, or any manual effort
// field) — used to tell a genuine effort/log attempt apart from a plain chat
// message so we only route to the coach when there's nothing to log.
function hasAnyEffortInput() {
  if (effortMode() === 'screenshot') {
    return Boolean(document.getElementById('effort-image').files[0]);
  }
  return ['effort-duration', 'effort-active-cal', 'effort-total-cal', 'effort-avg-hr', 'effort-peak-hr']
    .some(id => (document.getElementById(id).value || '').trim());
}

// The sets currently in the preview editor (unsaved), passed to the coach as
// read-only context so "is this a good set?" can be answered. Empty when nothing
// is in the editor. Never includes anything not already on screen.
function currentPreviewRowsForChat() {
  const rows = [];
  for (const tr of Array.from(setsTableBody.children)) {
    const weight = tr.querySelector('.set-weight')?.value;
    const reps = tr.querySelector('.set-reps')?.value;
    const rir = tr.querySelector('.set-rir')?.value;
    if (!weight && !reps) continue;
    rows.push({
      exercise: activeExercise || null,
      weight: weight === '' || weight == null ? null : Number(weight),
      reps: reps === '' || reps == null ? null : Number(reps),
      rir: rir === '' || rir == null ? null : Number(rir)
    });
  }
  return rows;
}

// Returns today's plan exercises as {name, rationale} objects for the coach
// context, so the model can answer "why in this order?" and "what's left?"
// without claiming it lacks the sequence.
//
// AUTHORITATIVE SOURCE (Roadmap Step 373): when a planned session is live, the
// coach must see the SAME plan the lifter is actually running — including any
// accepted substitutions and the live cursor — not a separately re-fetched
// recommendation. The name key is `canonicalName || name`, matching exactly what
// resolveCompletedIdentity writes into sessionCompleted, so the server's
// name-based computePlanState reconciles completed↔remaining instead of drifting.
// Only when no session is active do we fall back to the cached recommendation.
function currentPlanForChat() {
  if (activePlannedSession && Array.isArray(activePlannedSession.exercises) && activePlannedSession.exercises.length) {
    return activePlannedSession.exercises.slice(0, 10).map(ex => ({
      name: ex.canonicalName || ex.name || null,
      rationale: ex.reason || null,
      weight: ex.weight ?? null,
      reps: ex.reps ?? null,
      sets: ex.sets ?? null,
      rir: ex.rir ?? null
    })).filter(e => e.name);
  }
  // Fallback: the cached recommended intent (no active session yet).
  if (!lastIntentData) return [];
  const intents = lastIntentData.intents || [];
  const recommended = intents.find(i => i.recommended);
  const exercises = recommended && Array.isArray(recommended.exercises) ? recommended.exercises : [];
  return exercises.slice(0, 10).map(ex => ({
    name: ex.canonical_exercise || ex.exercise || null,
    rationale: ex.focus || ex.reason || null,
    weight: ex.target_weight ?? ex.weight ?? null,
    reps: ex.target_reps ?? ex.reps ?? null,
    sets: ex.target_sets ?? ex.sets ?? null,
    rir: ex.target_rir ?? ex.rir ?? null
  })).filter(e => e.name);
}

// Hand a non-loggable message to the coach. Read-only narration: app.js only
// dispatches; coach-conversation.js does the /api/coach/chat round-trip and
// types the reply. This NEVER touches the trust loop or the write path.
function routeMessageToCoach(text) {
  const preview = currentPreviewRowsForChat();
  const plan = currentPlanForChat();
  const context = {};
  if (preview.length) context.current_preview = preview;
  if (plan.length) context.current_plan = plan;
  // Step 375 + composer plan edits: send plan_completed whenever the client has
  // an authoritative visible plan (started OR chat/suggested) — even when it's
  // still empty ([]). Gating only on activePlannedSession left chat-rendered plans
  // without plan_state, so later composer edits were based on a non-authoritative
  // transcript instead of the same plan state debug/composer use.
  if (plannedExerciseOrder().length > 0) context.plan_completed = [...sessionCompleted];
  // Defer one tick so chat.js's submit listener paints the user bubble first —
  // without this, the Atlas "Thinking…" bubble appends before the user bubble.
  setTimeout(() => {
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: { text, context }
    }));
  }, 0);
  setTimeout(() => { workoutTextInput.value = ''; }, 0);
  invalidatePreview();
}

// Intent-router SHADOW observation (Phase C2, widened 2026-07-03). The composer
// submit handler below fans a typed message into ~8 deterministic lanes that each
// return before any /api/coach/chat call (set logs, session/artifact asks, log-it,
// plan mutations + identity corrections that never touch the network at all), so
// the old server-side observation at /api/coach/chat only ever saw the residue —
// the shadow log missed most typed messages. Observing here, at the ONE chokepoint
// every composer submission passes through, captures them all exactly once.
// OBSERVE-ONLY: fire-and-forget, never awaited, never blocks or alters the submit /
// reply / write path; the server no-ops when ATLAS_INTENT_ROUTER != shadow.
function observeComposerText(text) {
  const message = (text || '').trim();
  if (!message) return;
  // A BARE fetch, not api() (review #838): api() records every failure into
  // atlasLastError / the request history that bug reports capture, so a dropped
  // observation (e.g. a Render cold-start blip) would leave a diagnostic trace —
  // contradicting "observation must never surface." A bare authenticated fetch
  // with a swallowed rejection makes a dropped observation truly invisible.
  try {
    fetch('/api/debug/intent-observe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': getApiKey() },
      // app_version stamps the Intent_Shadow diagnostics row with the running shell
      // build, so the owner can tell which build produced an observation.
      body: JSON.stringify({ message, app_version: ATLAS_SHELL_BUILD })
    }).catch(() => { /* observation must never surface to the lifter */ });
  } catch { /* nor throw into the submit path */ }
}

document.getElementById('logger-form').addEventListener('submit', async e => {
  e.preventDefault();

  // Paint the user's message bubble FIRST — before any routing, coach reply,
  // preview card, or logged-set reaction can append an Atlas bubble. Doing this
  // synchronously at the top of the handler guarantees the pasted workout shows
  // ABOVE its response (the owner-reported inversion where a multi-exercise paste's
  // ✓ confirmation rendered above the paste bubble). chat.js's addUserBubble
  // dedupes a repeated consecutive bubble, so this never double-paints.
  const submittedText = (workoutTextInput.value || '').trim();
  if (submittedText && typeof window.atlasAddUserBubble === 'function') {
    window.atlasAddUserBubble(submittedText);
  }

  // Shadow observation, BEFORE any deterministic lane can claim + return: this is
  // the one chokepoint every free-text composer submission passes through, so the
  // intent-router shadow lane sees them all (owner find 2026-07-03). Fire-and-forget.
  observeComposerText(submittedText);

  const bugNote = parseBugCommand(submittedText);
  if (bugNote !== null) {
    await saveAtlasBugReport(bugNote);
    setTimeout(() => { workoutTextInput.value = ''; }, 0);
    return;
  }

  // Training-plan questions ("what are we doing today", "what should I train")
  // route to the ONE canonical in-thread Coach's Pick (Phase B) — the same
  // structured, engagement-carrying render every other recommendation entry
  // point uses. With the home tiles retired (owner directive 2026-07-03), the
  // typed sentence IS the pick's entry; a chat-prose answer here would be a
  // second recommendation voice.
  if (looksLikeSessionRequest(workoutTextInput.value)) {
    setTimeout(() => { workoutTextInput.value = ''; }, 0);
    openCoachPickInThread();
    return;
  }

  // Composer-first Phase B2: deterministic artifact asks ("show my last
  // session", "weekly report") render the existing read-only artifact INLINE
  // in the thread — a deterministic read stays deterministic, no LLM between
  // the lifter and their own numbers. If a renderer is unavailable the ask
  // falls through to the coach chat below (never silence).
  const artifactKind = looksLikeArtifactRequest(workoutTextInput.value);
  if (artifactKind) {
    const renderer = artifactKind === 'last_session'
      ? window.atlasChipAnswerLast
      : window.atlasChipAnswerReport;
    if (typeof renderer === 'function') {
      setTimeout(() => { workoutTextInput.value = ''; }, 0);
      renderer();
      return;
    }
  }

  // "Log it" / "done" — compile the full conversational session from chat
  // history and run the normal parse → preview → approve flow on the result.
  if (looksLikeLogIt(workoutTextInput.value)) {
    workoutTextInput.value = '';
    await handleLogIt();
    return;
  }

  // After a successful save, correction language triggers a "Replace / Log as
  // new / Cancel" prompt rather than silently appending a second workout.
  if (lastWrite) {
    const correctionText = workoutTextInput.value.trim();
    if (correctionText && looksLikeCorrection(correctionText)) {
      setTimeout(() => { workoutTextInput.value = ''; }, 0);
      showCorrectionPrompt(correctionText);
      return;
    }
  }

  // Capture text before the async clear fires — the catch block needs it to
  // decide whether to route to the coach.
  const pendingChatText = workoutTextInput.value.trim();

  // Clear the composer immediately — chat.js already captured it for the user
  // bubble, so this just empties the box while Atlas thinks.
  setTimeout(() => { workoutTextInput.value = ''; }, 0);

  setStatus(loggerStatus, '', 'ok');
  invalidatePreview();
  // RC2: a FRESH submit starts with no date-source banner. The closeout branch below
  // re-sets it when a screenshot drives the save. Gating on sessionCompiledAwaitingPreview
  // preserves it across the closeout RE-ENTRY (which skips that branch but must still
  // render the banner). This stops a stale "Date from screenshot" label from leaking onto
  // a later normal preview if a closeout preview was abandoned without Start Over.
  if (!sessionCompiledAwaitingPreview) closeoutScreenshotDateSource = null;

  const mode = effortMode();
  const date = document.getElementById('log-date').value.trim();
  if (!date && mode !== 'screenshot') {
    setStatus(loggerStatus, 'Date is required.', 'error');
    return;
  }
  const sessionIdInput = document.getElementById('log-session-id');
  const sessionId = sessionIdInput.value.trim() || (date ? generateSessionId(date) : '');
  const location = document.getElementById('log-location').value.trim();
  const notes = document.getElementById('log-notes').value.trim();
  let file = null;
  if (mode === 'screenshot') {
    const imageInput = document.getElementById('effort-image');
    file = imageInput.files[0] || null;
  }

  if (file && !pendingChatText && !sessionCompiledAwaitingPreview && isPlanCloseoutAwaitingSave()) {
    closeoutScreenshotFile = file;
    closeoutScreenshotEffort = null;
    setStatus(loggerStatus, 'Reading screenshot effort...', 'ok');
    try {
      closeoutScreenshotEffort = await parseWorkoutImage(file);
      setStatus(loggerStatus, 'Effort read from screenshot — opening your preview to save.', 'ok');
    } catch {
      setStatus(loggerStatus, "I couldn't read effort from the screenshot. I can still save the workout without effort data.", 'warn');
    }
    // RC2: the screenshot's own date is authoritative for this save unless the owner
    // explicitly typed a date. Resolve it and apply to BOTH #log-date and the session_id
    // BEFORE handleLogIt re-submits, so the rebuilt log rows, session_id, effort row,
    // pendingWrite payload, and preview banner all share the chosen date — never silently
    // today. An absent/ambiguous screenshot date falls back to today (and the preview warns).
    const resolvedCloseout = resolveCloseoutWorkoutDate({
      manualDate: date,
      manualEntered: logDateManuallyEntered,
      screenshotDate: closeoutScreenshotEffort && closeoutScreenshotEffort.date,
      today: getLocalDateString()
    });
    closeoutScreenshotDateSource = resolvedCloseout.source;
    document.getElementById('log-date').value = resolvedCloseout.date;
    sessionIdInput.value = generateSessionId(resolvedCloseout.date);
    // FB: the screenshot upload IS the completion signal at closeout — drive the
    // EXISTING closeout (handleLogIt → runCloseout → preview → approve → write) directly
    // instead of staging the effort and waiting for a separate "done". On re-entry the
    // closeoutAttachmentOnly path (below) folds the parsed effort into the normal
    // log-workout preview. Approve-before-write is preserved — this never writes
    // directly; it opens the same preview "done" would, so write_id idempotency and the
    // lastWrite "nothing new" guard still backstop any later "done".
    await handleLogIt();
    return;
  }

  let logRows = [];
  try {
    await rowsFromWorkoutInput();
    logRows = collectLogRows(sessionId, date);
  } catch (err) {
    // An already-handled, user-facing condition (e.g. the kg gate) shows its own
    // message and must NOT fall through to the coach/parse-error routing.
    if (err && err.handled) {
      setStatus(loggerStatus, err.displayMessage || err.message, 'warn');
      activeExercise = null;
      return;
    }
    // Text that isn't a loggable workout, with no effort attached, is treated as
    // a question for the coach rather than a parse error — so "was that a good
    // session?" or just "Bench" gets a conversation instead of a red dead-end.
    // For constraint messages during an active session, try the substitute endpoint
    // first. If a card was dispatched, skip the coach route (one response per message).
    // If no recommendation exists in the catalog, fall through to the coach as normal.
    if (pendingChatText && !hasAnyEffortInput()) {
      // Trust gap (live-audit PR 2): a MALFORMED SET must not silently become a coach
      // message — the coach's confident readback then "looks logged" but never wrote.
      // Fire only on an unambiguous failed slash-log: the parser recognized an
      // exercise (recognizedExercise), returned needs_clarification, AND the input
      // carried slash-set notation. Surface the format hint instead of routing to the
      // coach. Questions (no recognized exercise / no slash) and bare partials like
      // "Bench 225" (no slash → coach still asks conversationally) are unaffected.
      if (err.parsedIntent === 'needs_clarification' && err.recognizedExercise && /\d+\s*\/\s*\d+/.test(pendingChatText)) {
        setStatus(loggerStatus, `${err.displayMessage} Check the format, e.g. "Bench 225 5/2".`, 'warn');
        activeExercise = null;
        return;
      }
      // Multi-line partial-log (owner 2026-07-02): a paste where NO line resolved
      // still carries per-line specifics — surface the first ask instead of letting
      // set notation sink into the coach (the fluent-readback-over-empty-buffer gap).
      if (err.parsedIntent === 'needs_clarification' && Array.isArray(err.unresolvedLines) &&
          err.unresolvedLines.length && /\d+\s*\/\s*\d+/.test(pendingChatText)) {
        setStatus(loggerStatus, `${err.displayMessage} Re-type that line and I'll add it.`, 'warn');
        activeExercise = null;
        return;
      }
      // A cardio / interval / circuit / timed-hold input isn't a slash workout, so
      // the slash parser threw above. Try the modality trust loop (dry-run preview
      // → approve → /api/log-modality) before treating it as a coach question. On a
      // 422 / non-modality this returns false and we fall through to the coach.
      if (await tryPreviewModality(pendingChatText, sessionId, date)) {
        activeExercise = null;
        return;
      }
      // P0 Sub-PR 2a: an EXPLICIT swap/skip ("skip deadlift, do squats") mutates
      // the canonical session deterministically — before the suggest/coach routes,
      // so the change lands in app state, not just chat prose.
      if (tryApplyPlanMutation(pendingChatText)) {
        activeExercise = null;
        return;
      }
      // P0 PR 4: an EXPLICIT identity correction ("sorry that was squats") relabels
      // the just-logged lift deterministically — before the suggest/coach routes, so
      // it lands in app state even when the coach LLM is down.
      if (tryApplyIdentityCorrection(pendingChatText)) {
        activeExercise = null;
        return;
      }
      const suggested = await checkAndSuggestSubstitute(pendingChatText);
      if (!suggested) routeMessageToCoach(pendingChatText);
      // Clear the stale active-exercise context so the next bare shorthand input
      // (e.g. "15 12/2 x3" after "leg extension is taken, doing laterals first")
      // cannot silently attach to the wrong exercise. The parser will ask
      // "Which exercise is this for?" instead of inheriting the prior lift.
      activeExercise = null;
      return;
    }
    setStatus(loggerStatus, err.displayMessage || `Could not parse workout text: ${err.message}`, 'error');
    return;
  }

  let manualEffort = null;
  try {
    if (mode === 'manual') {
      manualEffort = collectManualEffort(sessionId, date, location, notes);
    }
  } catch (err) {
    setStatus(loggerStatus, err.message, 'error');
    return;
  }

  const closeoutAttachmentOnly = file && closeoutScreenshotFile === file && sessionCompiledAwaitingPreview;
  if (closeoutAttachmentOnly) file = null;
  if (closeoutAttachmentOnly && closeoutScreenshotEffort) {
    manualEffort = effortRowFromParsedEffort(closeoutScreenshotEffort, sessionId, date, location, notes);
  }

  // Screenshot upload and manual effort form are end-of-session triggers.
  // If the lifter logged sets conversationally (the editor is empty because each
  // set went to the buffer), rebuild the FULL session so one preview covers both
  // the workout rows AND the effort data. Prefer the structured buffer; fall back
  // to the conversational compile only when the buffer is empty.
  if (!logRows.length && (file || manualEffort) && sessionLog.length) {
    const compileDate = mode === 'screenshot' ? '' : (date || getLocalDateString());
    const compileSessionId = mode === 'screenshot' ? '' : (sessionId || generateSessionId(date || getLocalDateString()));
    populateSetRows(buildRowsFromSessionLog());
    logRows = collectLogRows(compileSessionId, compileDate);
  }
  if (!logRows.length && (file || manualEffort)) {
    const turns = typeof window.getChatHistory === 'function' ? window.getChatHistory() : [];
    if (turns.length) {
      setStatus(loggerStatus, 'Compiling session…', 'ok');
      try {
        const compileRes = await api('/api/session/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history: turns })
        });
        const compiledText = compileRes.data?.workout_text;
        if (compiledText) {
          // Screenshot mode: leave date_clean and session_id blank so the
          // server can stamp them with the screenshot-resolved date/session_id
          // (normalizeLogRowObject falls back to topLevelDate/topLevelSessionId
          // when the row fields are falsy). Manual effort uses the form date.
          const compileDate = mode === 'screenshot' ? '' : (date || getLocalDateString());
          const compileSessionId = mode === 'screenshot' ? '' : (sessionId || generateSessionId(compileDate));
          workoutTextInput.value = compiledText;
          try {
            await rowsFromWorkoutInput();
            logRows = collectLogRows(compileSessionId, compileDate);
          } finally {
            workoutTextInput.value = '';
            lastParsedWorkoutText = '';
          }
        }
      } catch {
        // Compilation failed or Gemini unavailable — fall through to effort-only preview
      }
      setStatus(loggerStatus, '', 'ok');
    }
  }

  const effortOnly = !logRows.length && Boolean(file || manualEffort);
  if (!logRows.length && !effortOnly) {
    // Pure text with nothing to log → route to the coach (same as the parse
    // fallback above). Empty input still shows the gentle hint.
    const chatText = workoutTextInput.value.trim();
    if (chatText) {
      routeMessageToCoach(chatText);
      return;
    }
    setStatus(loggerStatus, 'Enter workout text first, then preview. You can edit parsed rows after preview.', 'error');
    return;
  }

  // In-workout coaching (session-level save): a logged set is coached in-thread
  // — readback + adjusted-next prescription — and is NEVER previewed or written.
  // The single review + write happens only on an explicit END trigger:
  // "done"/"log it" (which sets sessionCompiledAwaitingPreview), an Apple Watch
  // screenshot, or manual effort. This makes "no mid-workout Save" a STRUCTURAL
  // invariant — the preview/approve/write surface is unreachable from logging a
  // set, by construction (not just hidden by styling).
  if (logRows.length && !file && !manualEffort && !sessionCompiledAwaitingPreview) {
    // Substitution classification: if the parser extracted a skip-notation pair
    // ("Deadlift skipped - platform busy"), classify it here where lastPrescribed
    // and the log rows are already assembled, then pass the engine's verdict into
    // the event so coach-conversation.js only words it — never calls a write path.
    // Best-effort: any failure is silent and never blocks the mid-session set note.
    let midSessionSubstitutions = [];
    let midSessionEnrichment = null;
    const hasPrescribed = Array.isArray(lastPrescribed) && lastPrescribed.length > 0;
    const hasPlan = activePlannedSession && activePlannedSession.exercises.length > 0;
    if (hasPrescribed || hasPlan) {
      try {
        const loggedExercise = logRows[0] ? logRows[0].exercise || '' : '';
        const subPayload = {
          session_id: sessionId,
          date,
          test_mode: 'true',
          prescribed: hasPrescribed ? lastPrescribed.map(p => ({
            exercise: p.exercise,
            logged_exercise: loggedExercise,
            ...(p.reason ? { reason: p.reason } : {})
          })) : [],
          log_rows: logRows
        };
        if (hasPlan) {
          // Send only the current plan step, not the full plan. Use canonical session
          // so a stale cursor (after logging without clicking "Next") never reports the
          // already-logged exercise as the active plan step.
          const currentEx = currentPlannedExercise();
          if (currentEx) {
            subPayload.plan_exercises = [{
              name: currentEx.canonicalName || currentEx.name,
              ...(currentEx.liftCode ? { lift_code: currentEx.liftCode } : {})
            }];
          }
        }
        const subResult = await api('/api/log-workout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subPayload)
        }).catch(() => null);
        midSessionSubstitutions = subResult?.data?.substitutions || [];
        // Enrichment gives us canonical_exercise + lift_code per row so that
        // resolveCompletedIdentity can map the logged name back to the planned
        // exercise name (e.g. "Barbell Row" → "Rows" via matching lift_code).
        midSessionEnrichment = subResult?.data?.enrichment || null;
      } catch { /* best-effort — classification never blocks the set note */ }
    }
    emitSetLogged(logRows, pendingChatText, midSessionSubstitutions, midSessionEnrichment);
    return;
  }
  sessionCompiledAwaitingPreview = false;

  const previewBtn = document.getElementById('preview-btn');
  previewBtn.disabled = true;
  previewBtn.textContent = 'Previewing…';

  // Multiple sessions per day: a fresh effort-only upload (a later run/ride after the
  // gym session was already saved) must NOT be forced to …-01 and collide with the
  // earlier session. When the owner hasn't explicitly tagged a session_id, send it BLANK
  // for effort-only uploads so the server auto-increments (…-02, …-03 via
  // nextAvailableSessionId). A concluded save clears #log-session-id, so the next upload
  // starts blank = "a new session". Uploads that carry workout rows keep the resolved id
  // so Log_Cleaned and Effort never disagree on session_id (BACKLOG: multi-session for
  // screenshot-with-sets).
  const explicitSessionId = sessionIdInput.value.trim();
  const completeWorkoutSessionId = effortOnly ? explicitSessionId : sessionId;

  try {
    if (mode === 'screenshot' && file) {
      if (!file) throw new Error('Choose a screenshot file, or switch to manual effort entry.');

      // B5 (owner live bug 07-02): #log-date is auto-filled with today, so sending it
      // unconditionally stamped every screenshot save with an owner-"typed" date — and
      // a manual date beats the screenshot date server-side, so the screenshot's own
      // date could NEVER win and date_source read 'manual', suppressing even the
      // today-fallback warning. Send the date ONLY when the owner actually entered one
      // (logDateManuallyEntered — a real input event, same flag RC2 uses); blank lets
      // the server resolve screenshot-date → today-fallback and report an honest
      // date_source. Mirrors the RC5 blank-session_id pattern. Preview ↔ write parity
      // holds: pendingWrite.date below captures the server-RESOLVED date, which the
      // approve step re-sends, so what was previewed is exactly what is written.
      const screenshotDateField = logDateManuallyEntered ? date : '';
      const result = await submitCompleteWorkout({ file, logRows, sessionId: completeWorkoutSessionId, date: screenshotDateField, location, notes, testMode: true });
      if (!hasCompleteWorkoutNoWriteProof(result)) {
        throw new Error('Preview did not prove no-write safety. Nothing can be written.');
      }
      const resolvedData = result?.data?.data || {};
      const resolvedDate = resolvedData.date || date || getLocalDateString();
      const resolvedSessionId = resolvedData.session_id || sessionId || generateSessionId(resolvedDate);
      document.getElementById('log-date').value = resolvedDate;
      sessionIdInput.value = resolvedSessionId;
      pendingWrite = {
        mode: 'screenshot',
        file,
        logRows,
        sessionId: resolvedSessionId,
        date: resolvedDate,
        location,
        notes,
        effortOnly,
        writeId: generateWriteId(),
        // The effort metrics the owner is reviewing. On approval we write THESE,
        // not a second vision parse of the same image — so what gets saved is
        // exactly what was shown. See the approve handler's screenshot branch.
        parsedEffort: resolvedData.parsed_effort || null,
        // Already-saved session (re-used dated screenshot): the dry-run flags it; the
        // live write would refuse it, so gate approve off rather than send the owner
        // into a "Duplicate session" error on tap.
        duplicateSession: Boolean(resolvedData.duplicate_check && resolvedData.duplicate_check.duplicate_session),
        previewProof: previewProofFromResult(result, 'screenshot')
      };
      renderCompleteWorkoutPreview(result);
    } else if (effortOnly) {
      const result = await submitCompleteWorkout({ logRows, sessionId: completeWorkoutSessionId, date, location, notes, manualEffort, testMode: true });
      if (!hasCompleteWorkoutNoWriteProof(result)) {
        throw new Error('Preview did not prove no-write safety. Nothing can be written.');
      }
      // Capture the server-resolved session_id (auto-incremented when we sent it blank) so
      // the live write reuses the SAME id the preview computed, and the field/summary show
      // the real …-02 instead of a forced …-01. Mirrors the screenshot branch above.
      const resolvedEffortData = result?.data?.data || {};
      const resolvedEffortSessionId = resolvedEffortData.session_id || completeWorkoutSessionId || sessionId;
      sessionIdInput.value = resolvedEffortSessionId;
      pendingWrite = { mode: 'effort-only', logRows, sessionId: resolvedEffortSessionId, date, location, notes, manualEffort, effortOnly: true, writeId: generateWriteId(),
        // Mirror the screenshot path: an already-saved session disables approve so the
        // graceful "already saved" preview note doesn't lead to a live 409 on tap.
        duplicateSession: Boolean(result?.data?.data?.duplicate_check?.duplicate_session),
        previewProof: previewProofFromResult(result, 'effort-only') };
      renderCompleteWorkoutPreview(result);
    } else {
      const effortRow = manualEffort;

      const payload = { session_id: sessionId, date, log_rows: logRows, test_mode: 'true', write_id: generateWriteId() };
      if (effortRow) payload.effort_row = effortRow;
      if (lastPrescribed && lastPrescribed.length > 0 && logRows.length > 0) {
        const loggedExercise = logRows[0].exercise || '';
        payload.prescribed = lastPrescribed.map(p => ({ exercise: p.exercise, logged_exercise: loggedExercise, ...(p.reason ? { reason: p.reason } : {}) }));
      }
      if (activePlannedSession && activePlannedSession.exercises.length > 0) {
        // B2: derive the closeout plan_exercises from the canonical active session
        // (the same model the card / coach / preview / mid-session sub-payload read),
        // not the raw activePlannedSession holder — so the save payload can never
        // disagree with the visible session. Off-plan inserts are excluded so a
        // logged accessory is never mis-attributed as a prescribed substitution
        // source. Falls back to the raw plan only when the canonical model is
        // unavailable, so this never regresses a session that has no canonical view.
        const canon = getCanonicalSession();
        const canonicalPlan = canon ? planExercisesFromCanonical(canon) : [];
        payload.plan_exercises = canonicalPlan.length
          ? canonicalPlan
          : activePlannedSession.exercises.map(ex => ({
              name: ex.name,
              ...(ex.liftCode ? { lift_code: ex.liftCode } : {})
            }));
      }

      const result = await api('/api/log-workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // Cold-start resilience: this is the test_mode DRY-RUN preview (idempotent,
        // proof-field-guarded, no write) — safe to retry once on a transport failure.
        // The live write at the approve handler never sets this.
        retryTransport: true
      });
      if (!hasLogWorkoutNoWriteProof(result)) {
        throw new Error('Preview did not prove no-write safety. Nothing can be written.');
      }
      pendingWrite = { mode: 'manual', payload, previewProof: previewProofFromResult(result, 'manual') };
      renderLogWorkoutPreview(result, effortRow);
    }
    // Session-level save: the in-thread review card (atlas:preview-ready) is the
    // single review surface, so the legacy #preview-panel stays hidden. Its
    // #approve-btn remains the gated write trigger that the review card's Save
    // clicks — enabled here only once the dry-run proved no-write safety.
    previewPanel.hidden = true;
    parsedRowsEditor.hidden = false;
    // An already-saved session has nothing new to write and the live write would 409,
    // so gate approve off and say so — no dead-end "Duplicate session" on tap.
    const alreadySaved = Boolean(pendingWrite && pendingWrite.duplicateSession);
    document.getElementById('approve-btn').disabled = alreadySaved || !pendingWriteHasPreviewProof(pendingWrite);
    const gateNote = document.getElementById('preview-gate-note');
    if (gateNote) gateNote.textContent = alreadySaved
      ? 'This workout is already saved — nothing new to write.'
      : effortOnly
        ? 'Review the dry-run above, then click to write Effort only.'
        : 'Review the dry-run above, then click to write.';
  } catch (err) {
    // Surface the server's INNER cause when present (api() carries the response body
    // on err.body; standardError puts the detail at body.details.error). The generic
    // "Failed to complete workout ingestion" hid WHY the screenshot/effort preview
    // 500'd — show the cause so it's diagnosable from the gym (live-gym v49).
    const d = err && err.body && err.body.details;
    const detail = d && (typeof d === 'string' ? d : (d.error || null));
    // A transport-level failure (post-retry) gets the honest cold-start line
    // instead of Safari's cryptic "Load failed"; HTTP errors keep the server copy.
    const friendly = friendlyTransportMessage(err);
    const fullMsg = friendly
      ? `Preview failed: ${friendly}`
      : `Preview failed: ${err.message}${detail ? ` — ${detail}` : ''}`;
    // Highlight any rows the server named in the error (e.g. "row 2: rir must be 0–10").
    const badRowNums = [...fullMsg.matchAll(/\brow\s+(\d+)\b/gi)].map(m => Number(m[1]) - 1);
    if (badRowNums.length && setsTableBody) {
      Array.from(setsTableBody.children).forEach((tr, idx) => {
        tr.classList.toggle('row-error', badRowNums.includes(idx));
      });
      setStatus(loggerStatus, fullMsg + ' — Fix or delete the highlighted row(s), then Preview again.', 'error');
    } else {
      setStatus(loggerStatus, fullMsg, 'error');
    }
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = 'Preview — no data saved';
  }
});

// Pre-fill the manual effort form fields with parsed values so the user can
// correct them (e.g. add a missing peak HR) and re-preview.
function prefillEffortForm(effort) {
  if (!effort) return;
  const dur = document.getElementById('effort-duration');
  const cal = document.getElementById('effort-active-cal');
  const tot = document.getElementById('effort-total-cal');
  const avg = document.getElementById('effort-avg-hr');
  const peak = document.getElementById('effort-peak-hr');
  const radio = document.querySelector('input[name="effort-mode"][value="manual"]');
  const details = document.getElementById('effort-details');

  if (dur && effort.duration != null) dur.value = effort.duration;
  if (cal && effort.activeCalories != null) cal.value = effort.activeCalories;
  if (tot && effort.totalCalories != null) tot.value = effort.totalCalories;
  if (avg && effort.averageHR != null) avg.value = effort.averageHR;
  if (peak && effort.peakHR != null) peak.value = effort.peakHR;
  if (radio && !radio.checked) {
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (details) { details.hidden = false; details.open = true; }
  document.getElementById('effort-details')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (peak && effort.peakHR == null) peak.focus();
}

// Map the previewed/normalized effort metrics back to the effort_json shape the
// backend's manual-effort path accepts (normalizeManualEffortMetrics). A missing
// peak HR is preserved as-is (null/'' is optional and survives the round trip).
function effortJsonFromParsedEffort(effort) {
  if (!effort) return null;
  return {
    duration: effort.duration,
    activeCalories: effort.activeCalories,
    totalCalories: effort.totalCalories,
    averageHR: effort.averageHR,
    peakHR: effort.peakHR,
    workoutType: effort.workoutType
  };
}

async function submitCompleteWorkout({ file, logRows, sessionId, date, location, notes, manualEffort, testMode, writeId }) {
  const form = new FormData();
  if (file) form.append('image', file);
  form.append('log_rows_json', JSON.stringify(logRows || []));
  if (sessionId) form.append('session_id', sessionId);
  if (date) form.append('date', date);
  if (location) form.append('location', location);
  if (notes) form.append('notes', notes);
  if (manualEffort) form.append('effort_json', JSON.stringify(manualEffort));
  if (testMode) form.append('test_mode', 'true');
  // Only the live write carries the write_id; the server uses it to refuse a
  // retried append. Dry-run previews never consume idempotency state.
  if (writeId && !testMode) form.append('write_id', writeId);
  // Cold-start resilience: DRY-RUN previews may retry once on a transport-level
  // failure (idempotent, no write). The live write never sets this.
  return api('/api/complete-workout', { method: 'POST', body: form, ...(testMode ? { retryTransport: true } : {}) });
}

async function parseWorkoutImage(file) {
  const form = new FormData();
  form.append('image', file);
  const result = await api('/api/parse-workout-image', { method: 'POST', body: form });
  const parsed = result?.data?.parsed || null;
  if (!parsed) throw new Error('No effort metrics returned from screenshot.');
  return parsed;
}

// Compact one-line confirmation of what the write will contain. The full
// per-set detail is already editable in the "Edit parsed rows" table, so the
// preview only needs the count + exercises + session for a final sanity check.
function renderRowsSummary(rows) {
  if (!rows || !rows.length) {
    return el('div', { class: 'preview-rows-summary', text: 'No workout sets to write.' });
  }
  const counts = new Map();
  for (const r of rows) {
    const name = r[2] || 'Unknown';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const exercises = [...counts.entries()].map(([name, n]) => `${name} ×${n}`).join(', ');
  const date = rows[0][0] || '';
  const sessionId = rows[0][1] || '';
  return el('div', { class: 'preview-rows-summary' }, [
    el('strong', { text: `${rows.length} set${rows.length === 1 ? '' : 's'} to write` }),
    el('span', { text: ` — ${exercises}` }),
    el('span', { class: 'preview-rows-meta', text: [date, sessionId].filter(Boolean).join(' · ') })
  ]);
}

function renderWarnings(warnings) {
  if (!warnings || !warnings.length) {
    return el('div', { class: 'preview-ok', text: 'No warnings. All exercises matched the catalog.' });
  }
  return el('div', { class: 'preview-warnings' }, [
    el('strong', { text: 'Warnings — review before approving:' }),
    el('ul', {}, warnings.map(w => el('li', { text: w })))
  ]);
}

function renderAutoMatches(autoMatches) {
  if (!autoMatches || !autoMatches.length) return null;
  return el('div', { class: 'preview-auto-match' }, [
    el('strong', { text: 'Auto-matched — verify these are correct:' }),
    el('ul', {}, autoMatches.map(m => el('li', { text: m })))
  ]);
}

function renderRuleFlags(ruleFlags) {
  if (!ruleFlags || !ruleFlags.length) return null;
  const severityClass = ruleFlags.some(f => f.severity === 'error')
    ? 'preview-warnings'
    : ruleFlags.some(f => f.severity === 'warning') ? 'preview-warnings' : 'preview-auto-match';
  return el('div', { class: severityClass }, [
    el('strong', { text: 'Coach flags:' }),
    el('ul', {}, ruleFlags.map(f => el('li', { text: f.reasoning })))
  ]);
}

function renderUnknownExerciseSuggestions(pendingExercises) {
  if (!pendingExercises || !pendingExercises.length) return null;
  const items = pendingExercises.map(pe => {
    const matches = pe.closest_matches || [];
    const hint = matches.length
      ? `Did you mean: ${matches.map(m => `${m.canonical_exercise}${m.lift_code ? ` (${m.lift_code})` : ''}`).join(', ')}`
      : 'No close catalog matches found — add this exercise to Exercise_Catalog.';
    return el('li', {}, [
      el('strong', { text: `"${pe.exercise}" — ` }),
      document.createTextNode(hint)
    ]);
  });
  return el('div', { class: 'preview-warnings' }, [
    el('strong', { text: 'Unknown exercises — catalog suggestions:' }),
    el('ul', {}, items)
  ]);
}

function renderLogWorkoutPreview(result, effortRow) {
  const data = result.data || {};
  previewContent.innerHTML = '';
  const parseStatus = parserStatusNode(lastParserStatus);
  if (parseStatus) previewContent.appendChild(parseStatus);
  const logAutoMatches = renderAutoMatches(data.auto_matches);
  if (logAutoMatches) previewContent.appendChild(logAutoMatches);
  previewContent.appendChild(renderWarnings(data.warnings));
  const logRuleFlags = renderRuleFlags(data.rule_flags);
  if (logRuleFlags) previewContent.appendChild(logRuleFlags);
  const logSuggestions = renderUnknownExerciseSuggestions(data.pending_exercises);
  if (logSuggestions) previewContent.appendChild(logSuggestions);
  // RC2: when this save came from a closeout screenshot, show the chosen workout date
  // and its source so the owner sees (and can correct) it before approving. The date
  // shown is exactly the one in the write payload, so preview ↔ saved date can't drift.
  if (closeoutScreenshotDateSource) {
    const dsDate = (pendingWrite && pendingWrite.payload && pendingWrite.payload.date)
      || document.getElementById('log-date').value || '';
    const dsNotice = renderDateSourceNotice(closeoutScreenshotDateSource, dsDate);
    if (dsNotice) previewContent.appendChild(dsNotice);
  }
  previewContent.appendChild(renderRowsSummary(data.log_rows_preview || []));
  // Show exercises already saved earlier in this same workout (display only) so the
  // confirm card reflects the FULL session, not just the post-save buffer. Additive:
  // it never affects data.log_rows_preview or the write payload.
  const savedRecap = renderSavedThisSessionRecap();
  if (savedRecap) previewContent.appendChild(savedRecap);
  if (effortRow) {
    previewContent.appendChild(el('h3', { text: 'Effort row to write' }));
    previewContent.appendChild(renderTable(
      ['Date', 'Session', 'Duration', 'Active cal', 'Total cal', 'Avg HR', 'Peak HR', 'Location', 'Notes'],
      [data.effort_row_preview || Object.values(effortRow)]
    ));
  }
  const liftCodes = extractLiftCodes(data.log_rows_preview);
  if (pendingWrite) pendingWrite.liftCodes = liftCodes;
  if (liftCodes.length && getApiKey()) {
    // Per-exercise in-preview coaching: each lift's last set + a coaching hint.
    // Read-only and best-effort — a failed lookup for one lift just drops its
    // card and never blocks the preview or the save.
    const coachBox = el('div', {}, [el('div', { class: 'muted small', text: 'Coaching' })]);
    previewContent.appendChild(coachBox);
    for (const code of liftCodes) {
      const slot = el('div', {});
      coachBox.appendChild(slot);
      const todaySets = previewSetsForLift(data.log_rows_preview, code);
      fetchReaction(code).then(rec => {
        const node = renderPreviewCoachCard(rec, code, todaySets);
        if (node) slot.replaceWith(node);
      }).catch(() => {});
    }
  }
  // Manual effort + sets writes via /api/log-workout; surface its metrics in the
  // single review card too (normalize the snake_case effort_row to the grid shape).
  const reviewEffort = effortRow ? {
    duration: effortRow.duration,
    activeCalories: effortRow.active_calories,
    totalCalories: effortRow.total_calories,
    averageHR: effortRow.average_hr,
    peakHR: effortRow.peak_hr
  } : null;
  // B5: the log-workout preview's date is the write-payload date; the source is the
  // closeout-screenshot resolution when one ran (RC2), else 'manual' only when the
  // owner actually typed a date. A plain default-today set log passes source null,
  // so ordinary set logging renders no date notice — unchanged look.
  const logDateInfo = {
    date: (pendingWrite && pendingWrite.payload && pendingWrite.payload.date)
      || document.getElementById('log-date').value || '',
    source: closeoutScreenshotDateSource || (logDateManuallyEntered ? 'manual' : null)
  };
  emitCoachPreview(data.log_rows_preview, liftCodes, false, reviewEffort, data.substitutions,
    logDateInfo.source ? logDateInfo : null);
}

function renderCompleteWorkoutPreview(result) {
  // complete-workout nests its body one level deeper than log-workout
  const outer = result.data || {};
  const data = outer.data || {};
  const effortOnly = data.effort_only === true;
  previewContent.innerHTML = '';
  const parseStatus = parserStatusNode(lastParserStatus);
  if (parseStatus) previewContent.appendChild(parseStatus);
  const completeAutoMatches = renderAutoMatches(outer.auto_matches);
  if (completeAutoMatches) previewContent.appendChild(completeAutoMatches);
  previewContent.appendChild(renderWarnings(outer.warnings));
  const completeSuggestions = renderUnknownExerciseSuggestions(outer.pending_exercises);
  if (completeSuggestions) previewContent.appendChild(completeSuggestions);

  // B5: surface the resolved workout date and its source so the owner can catch
  // a mismatch (e.g. a June 12 screenshot imported on June 26 defaulting to today).
  // When the date fell back to today — because the screenshot date wasn't visible
  // or extractable — show a warning and prompt correction BEFORE the approve step.
  const completeDateNotice = renderDateSourceNotice(data.date_source, data.date || '');
  if (completeDateNotice) previewContent.appendChild(completeDateNotice);

  const dup = data.duplicate_check || {};
  if (dup.duplicate_session) {
    // The effort session is already on the sheet (e.g. re-importing the same dated
    // screenshot). The dry-run surfaces this gracefully instead of a hard "Duplicate
    // session" error; the live write still refuses to double-save (approve is disabled
    // below). Word it as "already saved", never as a failure.
    const sess = data.session_id ? ` (session ${data.session_id})` : '';
    previewContent.appendChild(el('div', { class: 'preview-warnings preview-date-warning',
      text: `✓ This workout is already saved${sess}. Nothing new will be written — you don't need to save it again.` }));
  }
  if (dup.duplicate_log_rows > 0) {
    previewContent.appendChild(el('div', { class: 'preview-warnings', text: `${dup.duplicate_log_rows} row(s) will be skipped as duplicates.` }));
  }

  if (effortOnly) {
    previewContent.appendChild(el('div', { class: 'preview-ok', text: 'Effort-only preview — no workout sets will be written.' }));
  } else {
    previewContent.appendChild(renderRowsSummary(data.rows_to_write || []));
  }
  const completeLiftCodes = extractLiftCodes(data.rows_to_write);
  if (pendingWrite) pendingWrite.liftCodes = completeLiftCodes;
  // B5: the server resolved this preview's date (manual > screenshot > today) and
  // reports the source — hand both to the review card so the owner SEES the date
  // (and the today-fallback warning) on the conversation surface, not just in the
  // hidden legacy panel above.
  emitCoachPreview(data.rows_to_write, completeLiftCodes, effortOnly, data.parsed_effort || null, null,
    data.date ? {
      date: data.date,
      source: data.date_source || null,
      // The implausible screenshot date the server refused (e.g. a weekday-matched
      // wrong year) — the card words the fallback honestly and offers the picker.
      ...(data.screenshot_date_rejected ? { rejected: data.screenshot_date_rejected } : {})
    } : null);
  if (completeLiftCodes.length && getApiKey()) {
    const suggestionSlot = el('div', {});
    previewContent.appendChild(suggestionSlot);
    fetchReaction(completeLiftCodes[0]).then(rec => {
      const node = renderAtlasSuggestion(rec);
      if (node) suggestionSlot.replaceWith(node);
    }).catch(() => {});
  }

  // Effort details collapse behind "Review technical details" — the in-thread
  // .review card (with the watch metrics) is the primary view for screenshots.
  const effort = data.parsed_effort || {};
  const peakHrCell = effort.peakHR == null ? 'not visible in screenshot' : effort.peakHR;
  const effortDetailsInner = el('div', {}, [
    el('h3', { text: data.effort_source === 'manual'
      ? 'Parsed effort (manual entry)'
      : (data.effort_source === 'screenshot_unreadable' || data.screenshot_unreadable)
        ? "Effort couldn't be read from the screenshot"
        : 'Parsed effort (from screenshot)' }),
    renderTable(
      ['Duration', 'Active cal', 'Total cal', 'Avg HR', 'Peak HR', 'Type'],
      [[effort.duration, effort.activeCalories, effort.totalCalories, effort.averageHR, peakHrCell, effort.workoutType]]
    )
  ]);
  if (effort.peakHR == null) {
    const chip = el('div', { class: 'effort-missing-chip' });
    chip.innerHTML = '&#9888;&#65039; Peak HR not captured — ';
    const fixLink = el('a', { href: '#', class: 'effort-fix-link', text: 'enter it manually' });
    fixLink.addEventListener('click', ev => { ev.preventDefault(); prefillEffortForm(effort); });
    chip.appendChild(fixLink);
    effortDetailsInner.appendChild(chip);
  } else {
    const editLink = el('a', { href: '#', class: 'effort-fix-link', text: 'Edit effort values' });
    editLink.addEventListener('click', ev => { ev.preventDefault(); prefillEffortForm(effort); });
    effortDetailsInner.appendChild(editLink);
  }
  effortDetailsInner.appendChild(el('p', { class: 'muted', text: `Session quality score: ${data.quality_score ?? '—'} / 100` }));
  previewContent.appendChild(el('details', { class: 'preview-technical-details' }, [
    el('summary', { text: 'Review technical details' }),
    effortDetailsInner
  ]));
  const approveBtn = document.getElementById('approve-btn');
  approveBtn.textContent = effortOnly ? 'Write Effort to Google Sheets' : 'Write to Google Sheets';
}

document.getElementById('cancel-preview-btn').addEventListener('click', invalidatePreview);

async function handleUndoLastWrite(expected) {
  if (!lastWrite) return;
  // CLIENT-1 guard (audit 2026-07-07): a saved review card binds the identity of
  // the write it represents (its log_appended_range) at save time. If that no
  // longer matches the current lastWrite, a NEWER write has since happened — refuse,
  // so an older card's Undo can never delete the newer write. `expected` is null for
  // the direct "Undo last write" button and for effort-only cards (which target the
  // latest write by definition); the appended range uniquely identifies the rows, so
  // it is the sole discriminator (session_id is server-minted and only forwarded).
  if (expected && expected.log_appended_range
      && expected.log_appended_range !== lastWrite.log_appended_range) {
    setStatus(loggerStatus, 'That workout is no longer your most recent save — Undo only affects your latest write.', 'error');
    return;
  }
  const { log_appended_range, session_id, log_rows_written } = lastWrite;
  const undoBtn = loggerStatus.querySelector('.undo-write-btn');
  if (undoBtn) {
    undoBtn.disabled = true;
    undoBtn.textContent = 'Undoing…';
  }
  try {
    await api('/api/log-workout/undo-last', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        log_appended_range,
        session_id,
        rows_to_delete: log_rows_written,
        confirm_delete: true
      })
    });
    lastWrite = null;
    historyLoaded = false; // sheet changed — History re-fetches on next visit
    setStatus(loggerStatus, 'Last write undone.', 'ok');
  } catch (err) {
    setStatus(loggerStatus, `Undo failed: ${err.message}`, 'error');
    if (undoBtn) {
      undoBtn.disabled = false;
      undoBtn.textContent = 'Undo last write';
      loggerStatus.appendChild(undoBtn);
    }
  }
}

// The end-of-session review card's "Undo" reuses this exact backend path —
// no reimplementation of the undo/delete logic. A card may pass its bound write
// identity so the guard above can refuse a stale card (CLIENT-1).
window.atlasUndoLastWrite = handleUndoLastWrite;

// CLIENT-1: review cards bind their write identity at save time so their Undo can
// be refused once a newer write supersedes it. Returns a snapshot copy (never the
// live ref) of the current write's identity, or null when there is no undoable write.
window.atlasCurrentWriteIdentity = () => (lastWrite && lastWrite.log_appended_range)
  ? { log_appended_range: lastWrite.log_appended_range, session_id: lastWrite.session_id }
  : null;

document.getElementById('approve-btn').addEventListener('click', async () => {
  if (writeInFlight) return;
  if (!pendingWriteHasPreviewProof(pendingWrite)) {
    setStatus(loggerStatus, 'No previewed workout to approve. Run a preview first.', 'error');
    invalidatePreview();
    return;
  }

  writeInFlight = true;
  const approveBtn = document.getElementById('approve-btn');
  approveBtn.disabled = true;
  approveBtn.textContent = 'Writing to Sheets…';

  const reactionLiftCodes = pendingWrite.liftCodes || [];
  // Captured up front — the preview teardown below nulls pendingWrite, and
  // the success message still needs to know which kind of write this was.
  const wasEffortOnly = pendingWrite.effortOnly === true;
  const wasModality = pendingWrite.mode === 'modality';
  let pendingLastWrite = null;
  let duplicateBlocked = false;
  try {
    if (pendingWrite.mode === 'screenshot' || pendingWrite.mode === 'effort-only') {
      const writeArgs = { ...pendingWrite, testMode: false };
      // Write the previewed metrics, not a re-parse: send effort_json, drop the image.
      if (pendingWrite.mode === 'screenshot' && pendingWrite.parsedEffort) {
        writeArgs.file = null;
        writeArgs.manualEffort = effortJsonFromParsedEffort(pendingWrite.parsedEffort);
      }
      const writeResult = await submitCompleteWorkout(writeArgs);
      const writeData = writeResult?.data?.data || {};
      // Server-side idempotency: a retried write_id is refused with proof the
      // original write completed. Strict — accept only when the original itself
      // confirmed a sheet write.
      duplicateBlocked = writeData.duplicate_write === true &&
        writeData.sheet_write === 'skipped_duplicate' &&
        writeData.original_sheet_written === true;
      if (!duplicateBlocked) {
        if (writeData.effort_only === true) {
          if (writeData.effort_written !== true || writeData.sheet_written !== true) {
            throw new Error('Effort-only write did not confirm an Effort sheet write. Verify Sheets before approving again.');
          }
        } else {
          const rowsWritten = writeData.log_rows_written;
          if (!rowsWritten || rowsWritten === 0) {
            throw new Error(`Write completed but log_rows_written=${rowsWritten ?? 'missing'}. Verify Sheets before approving again.`);
          }
        }
      }
    } else if (pendingWrite.mode === 'modality') {
      // Live modality write — mirrors the slash approve branch: omit test_mode so
      // the server performs the real append, carry the write_id from the dry-run
      // for idempotency, and require an explicit success proof before declaring it
      // saved. Writes only to Modality_Log; never touches Log_Cleaned/Effort.
      const writeResult = await api('/api/log-modality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: pendingWrite.text,
          session_id: pendingWrite.sessionId,
          date: pendingWrite.date,
          write_id: pendingWrite.writeId
        })
      });
      const writeData = writeResult?.data || {};
      // Idempotent replay: a duplicate write_id is echoed back with sheet_written
      // false; the original row is already on the sheet, so treat it as blocked.
      duplicateBlocked = writeData.duplicate_write === true && writeData.sheet_written === false;
      if (!duplicateBlocked) {
        if (writeData.sheet_write !== 'success' || writeData.sheet_written !== true) {
          throw new Error(`Modality write did not confirm success (sheet_write=${writeData.sheet_write ?? 'missing'}). Check Sheets.`);
        }
      }
    } else {
      const realPayload = { ...pendingWrite.payload };
      delete realPayload.test_mode;
      const writeResult = await api('/api/log-workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(realPayload)
      });
      const writeData = writeResult?.data || {};
      // Server-side idempotency: a retried write_id is refused with proof the
      // original write completed. Strict — all three fields must agree, and
      // the original must itself have been a confirmed success.
      duplicateBlocked = writeData.duplicate_write === true &&
        writeData.sheet_write === 'skipped_duplicate' &&
        writeData.original_sheet_write === 'success';
      if (!duplicateBlocked) {
        if (writeData.sheet_write !== 'success') {
          throw new Error(`Write response did not confirm success (sheet_write=${writeData.sheet_write ?? 'missing'}). Check Sheets.`);
        }
        const logRowsWritten = Number(writeData.log_rows_written || 0);
        const effortRowsWritten = Number(writeData.effort_rows_written || 0);
        if (!(logRowsWritten > 0 || effortRowsWritten > 0)) {
          throw new Error(`Write confirmed but log_rows_written=${writeData.log_rows_written ?? 'missing'} and effort_rows_written=${writeData.effort_rows_written ?? 'missing'}. Verify Sheets before approving again.`);
        }
      }
      // Capture undo details in a local — invalidatePreview() (called below) clears lastWrite.
      // On a blocked duplicate the original response is echoed back, so the
      // same undo details still point at the rows the first write appended.
      if (writeData.logAppendedRange) {
        pendingLastWrite = {
          log_appended_range: writeData.logAppendedRange,
          session_id: realPayload.session_id,
          log_rows_written: writeData.log_rows_written
        };
      }
      // Step 385: mark that this deload session had a confirmed live write so
      // endPlannedSession knows to advance the state machine exactly once.
      if (activePlannedSession?.intentId === 'deload_reset' && !duplicateBlocked) {
        activePlannedSession.deloadWritten = true;
      }
    }
    invalidatePreview();
    historyLoaded = false; clearLiveHintCaches(); // sheet changed
    document.getElementById('logger-form').reset();
    setsTableBody.innerHTML = '';
    parsedRowsEditor.hidden = true;
    lastParsedWorkoutText = '';
    lastParserStatus = null;
    activeExercise = null;
    lastPrescribed = null;
    setDefaultDate();
    setStatus(
      loggerStatus,
      duplicateBlocked
        ? 'Duplicate tap blocked — this workout was already written. ✓'
        : wasModality ? 'Cardio / conditioning written to Google Sheets. ✓'
          : wasEffortOnly ? 'Effort written to Google Sheets. ✓' : 'Workout written to Google Sheets. ✓',
      'ok'
    );
    // Always reflect the write that just happened. Screenshot / effort-only
    // writes produce no undoable log range (pendingLastWrite stays null), so
    // this clears any stale manual range — otherwise a correction after an
    // effort save would Replace-via-undo the wrong (older) rows.
    lastWrite = pendingLastWrite;
    // Remember the exercises this save wrote (DISPLAY ONLY) before the buffer is
    // cleared below, so a later closeout in the SAME workout still shows them in the
    // confirm/review card — a save concludes the session and the next set starts a
    // new session_id, so without this ledger the earlier work looked "missing."
    // Gated on a real log write (pendingLastWrite); effort-only / screenshot saves
    // append no Log_Cleaned rows and are skipped. Never re-written.
    if (pendingLastWrite && Array.isArray(sessionLog) && sessionLog.length) {
      for (const s of sessionLog) sessionSavedLog.push({ exercise: s.exercise });
    }
    // RC4: reset the session on ANY confirmed save — NOT gated on pendingLastWrite (undo
    // state, null for screenshot/effort-only saves). Gating it left a saved session in
    // memory that re-snapshotted and restored as a ghost. endPlannedSession() (not a bare
    // null) keeps Step 385's deload teardown firing before the plan is cleared.
    sessionLog = [];
    sessionCompleted = [];
    endPlannedSession();
    closeoutScreenshotFile = null;
    closeoutScreenshotEffort = null;
    // Multiple sessions per day: a saved session is concluded, so clear its session_id from
    // the field. The next upload then starts blank and the server auto-increments it to a
    // NEW session (…-02) instead of re-sending the just-written id and colliding.
    const savedSessionIdField = document.getElementById('log-session-id');
    if (savedSessionIdField) savedSessionIdField.value = '';
    closeoutScreenshotDateSource = null;
    clearSessionSnapshot();   // saved — don't resume this (now-written) session
    document.dispatchEvent(new CustomEvent('atlas:session-reset'));

    if (pendingLastWrite) {
      const undoBtn = el('button', { class: 'secondary undo-write-btn', text: 'Undo last write' });
      // No bound identity — this button always targets the just-completed write.
      // Wrap so the click Event is not passed as the CLIENT-1 expected-identity arg.
      undoBtn.addEventListener('click', () => handleUndoLastWrite());
      loggerStatus.appendChild(undoBtn);
    }
    if (pendingLastWrite?.log_appended_range) {
      verifyWrittenRange(
        pendingLastWrite.log_appended_range,
        pendingLastWrite.session_id,
        pendingLastWrite.log_rows_written
      ).then(ok => {
        loggerStatus.appendChild(el('div', { class: 'parser-status', text: ok
          ? 'Verified in Sheet ✓'
          : 'Write succeeded, but readback verification unavailable' }));
      });
    }
    if (reactionLiftCodes.length) {
      fetchReaction(reactionLiftCodes[0]).then(async rec => {
        if (!rec) return;
        await attachVerdictContext(rec, reactionLiftCodes[0], pendingLastWrite?.session_id);
        const verdict = buildVerdict(rec);
        const lines = [];
        if (verdict) {
          lines.push(el('div', { class: 'suggestion-row' }, [
            el('span', { class: 'suggestion-label', text: 'Logged' }),
            el('span', { text: verdict }),
          ]));
        }
        if (rec.recommendation && rec.next_target) {
          lines.push(el('div', { class: 'suggestion-row' }, [
            el('span', { class: 'suggestion-label', text: 'Next' }),
            el('span', { text: rec.recommendation }),
          ]));
        }
        if (!lines.length) return;
        loggerStatus.appendChild(el('div', { class: 'atlas-suggestion' }, lines));
      }).catch(() => {});
    }
    loadDashboard();
    approveBtn.textContent = 'Written ✓';
  } catch (err) {
    setStatus(loggerStatus, `Write failed: ${err.message}`, 'error');
    approveBtn.disabled = false;
    approveBtn.textContent = 'Write to Google Sheets';
  } finally {
    writeInFlight = false;
  }
});

/* ===== Session loader (correct an existing session) ===== */

document.getElementById('load-session-btn').addEventListener('click', async () => {
  const sessionId = document.getElementById('load-session-id').value.trim();
  const statusBox = document.getElementById('load-session-status');
  if (!sessionId) {
    setStatus(statusBox, 'Enter a session ID first.', 'error');
    return;
  }
  try {
    const res = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const data = res.data || {};
    document.getElementById('log-date').value = data.date || '';
    document.getElementById('log-session-id').value = data.session_id || '';
    setsTableBody.innerHTML = '';
    parsedRowsEditor.hidden = false;
    for (const row of (data.rows || [])) {
      addSetRow({
        exercise: row.exercise,
        set_number: row.set_number,
        weight: row.weight,
        reps: row.reps,
        rir: row.rir,
        notes: row.notes
      });
    }
    lastParsedWorkoutText = workoutTextInput.value.trim();
    invalidatePreview();
    setStatus(statusBox, `Loaded ${data.set_count} sets from session ${sessionId}. Edit what needs fixing, then preview.`, 'ok');
  } catch (err) {
    setStatus(statusBox, `Could not load session: ${err.message}`, 'error');
  }
});

/* ===== Body tab — Bodyweight ===== */

let pendingBwWrite = null;

function hasBodyweightNoWriteProof(result) {
  const data = result?.data || {};
  return data.test_mode === true &&
    data.sheet_write === 'skipped' &&
    data.sheet_written === false &&
    data.no_write_confirmed === true;
}

function pendingBodyweightHasPreviewProof(write) {
  return write?.previewProof?.test_mode === true &&
    write.previewProof.sheet_write === 'skipped' &&
    write.previewProof.sheet_written === false &&
    write.previewProof.no_write_confirmed === true;
}

function hasBodyweightWriteProof(result) {
  const data = result?.data || {};
  const duplicateBlocked = data.duplicate_write === true &&
    data.sheet_write === 'skipped_duplicate' &&
    data.original_sheet_write === 'success';
  return duplicateBlocked || (data.sheet_write === 'success' && data.sheet_written === true);
}

function bwInvalidate() {
  pendingBwWrite = null;
  document.getElementById('bw-preview-panel').hidden = true;
  document.getElementById('bw-preview-content').innerHTML = '';
  const btn = document.getElementById('bw-approve-btn');
  btn.disabled = true;
  btn.textContent = 'Write to Google Sheets';
  const note = document.getElementById('bw-gate-note');
  if (note) note.textContent = 'Run a preview above to enable this button.';
}

document.getElementById('bw-form').addEventListener('input', bwInvalidate);

document.getElementById('bw-form').addEventListener('submit', async e => {
  e.preventDefault();
  bwInvalidate();
  const bwStatus = document.getElementById('bw-status');
  setStatus(bwStatus, '', 'ok');

  const date = document.getElementById('bw-date').value;
  const weight = document.getElementById('bw-weight').value;
  const notes = document.getElementById('bw-notes').value.trim();

  const previewBtn = document.getElementById('bw-preview-btn');
  previewBtn.disabled = true;
  previewBtn.textContent = 'Previewing…';

  try {
    const result = await api('/api/bodyweight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, weight: Number(weight), notes, test_mode: 'true' })
    });
    const data = result.data || {};
    if (!hasBodyweightNoWriteProof(result)) {
      throw new Error('Preview did not prove no-write safety. Nothing can be written.');
    }
    const content = document.getElementById('bw-preview-content');
    content.innerHTML = '';
    const entry = data.entry_preview || {};
    content.appendChild(renderTable(
      ['Date', 'Weight', 'Notes'],
      [[entry.date, entry.weight, entry.notes]]
    ));

    pendingBwWrite = {
      date,
      weight: Number(weight),
      notes,
      write_id: generateWriteId(),
      previewProof: {
        test_mode: data.test_mode,
        sheet_write: data.sheet_write,
        sheet_written: data.sheet_written,
        no_write_confirmed: data.no_write_confirmed
      }
    };
    document.getElementById('bw-preview-panel').hidden = false;
    document.getElementById('bw-approve-btn').disabled = !pendingBodyweightHasPreviewProof(pendingBwWrite);
    const gateNote = document.getElementById('bw-gate-note');
    if (gateNote) gateNote.textContent = 'Review above, then click to write.';
  } catch (err) {
    // Surface the server's inner cause when present (parity with the logger preview
    // catch — PR-581 review note 2), so a bodyweight 500 is diagnosable too.
    const bd = err && err.body && err.body.details;
    const bdetail = bd && (typeof bd === 'string' ? bd : (bd.error || null));
    const bwFriendly = friendlyTransportMessage(err);
    setStatus(bwStatus, bwFriendly ? `Preview failed: ${bwFriendly}` : `Preview failed: ${err.message}${bdetail ? ` — ${bdetail}` : ''}`, 'error');
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = 'Preview — no data saved';
  }
});

document.getElementById('bw-cancel-btn').addEventListener('click', bwInvalidate);

document.getElementById('bw-approve-btn').addEventListener('click', async () => {
  if (!pendingBodyweightHasPreviewProof(pendingBwWrite)) {
    bwInvalidate();
    return;
  }
  const approveBtn = document.getElementById('bw-approve-btn');
  const bwStatus = document.getElementById('bw-status');
  approveBtn.disabled = true;
  approveBtn.textContent = 'Writing to Sheets…';
  try {
    const result = await api('/api/bodyweight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: pendingBwWrite.date,
        weight: pendingBwWrite.weight,
        notes: pendingBwWrite.notes,
        write_id: pendingBwWrite.write_id
      })
    });
    if (!hasBodyweightWriteProof(result)) {
      throw new Error('Bodyweight write did not return success proof. Verify Sheets before approving again.');
    }
    bwInvalidate();
    document.getElementById('bw-form').reset();
    document.getElementById('bw-date').value = getLocalDateString();
    setStatus(bwStatus, 'Bodyweight written to Google Sheets. ✓', 'ok');
    loadBwHistory();
  } catch (err) {
    setStatus(bwStatus, `Write failed: ${err.message}`, 'error');
    approveBtn.disabled = false;
    approveBtn.textContent = 'Write to Google Sheets';
  }
});

// Trend-first body view: a big current weight + 30-day change + a line of the
// last 90 days. Bodyweight direction isn't inherently good or bad (down is the
// goal on a cut), so the delta stays a neutral readout — no green/red judgment.
function renderBwGlance(glance, data, entries) {
  if (!glance) return;
  glance.innerHTML = '';
  if (!entries.length) {
    glance.appendChild(el('p', { class: 'muted', text: 'Log your weight to start a trend.' }));
    return;
  }
  const last = entries[entries.length - 1];
  const latest = (data.latest && data.latest.weight != null) ? Number(data.latest.weight) : Number(last.weight);
  const latestDate = (data.latest && data.latest.date) || last.date;
  const unit = data.unit ? ` ${data.unit}` : '';

  // 30-day change: compare to the entry nearest 30 days before the latest.
  const cutoff = Date.parse(latestDate) - 30 * 86400000;
  let baseline = entries[0];
  for (const e of entries) { if (Date.parse(e.date) <= cutoff) baseline = e; else break; }
  const delta = latest - Number(baseline.weight);
  const arrow = delta < 0 ? '▼' : (delta > 0 ? '▲' : '·');

  glance.appendChild(el('div', { class: 'bw-now' }, [
    el('div', { class: 'bw-w' }, [document.createTextNode(String(latest)), el('small', { text: unit })]),
    el('div', { class: 'bw-delta' }, [
      el('b', { text: `${arrow} ${Math.abs(delta).toFixed(1)}` }),
      el('span', { text: 'LAST 30 DAYS' })
    ])
  ]));
  glance.appendChild(el('div', { class: 'bw-chart' }, [
    svgLineChart(entries.map(e => ({ x: e.date, y: Number(e.weight) })),
      { color: '#E8772E', label: 'Bodyweight over time', height: 120 })
  ]));
}

async function loadBwHistory() {
  const glance = document.getElementById('bw-glance');
  const box = document.getElementById('bw-history');
  const hint = document.getElementById('bw-history-hint');
  if (!getApiKey()) {
    if (glance) glance.innerHTML = '<span class="muted">Set your API key in Settings.</span>';
    if (box) box.innerHTML = '<span class="muted">Set your API key in Settings.</span>';
    return;
  }
  try {
    const res = await api('/api/bodyweight/history?days=90');
    const data = res.data || {};
    const entries = data.entries || [];
    renderBwGlance(glance, data, entries);
    if (box) {
      box.innerHTML = '';
      if (!entries.length) {
        box.appendChild(el('span', { class: 'muted', text: 'No bodyweight entries in the last 90 days.' }));
      } else {
        box.appendChild(renderTable(
          ['Date', 'Weight', 'Notes'],
          entries.slice().reverse().slice(0, 20).map(e => [e.date, e.weight, e.notes])
        ));
      }
    }
    if (hint) hint.textContent = entries.length ? `${entries.length} entries` : '';
  } catch (err) {
    if (glance) {
      glance.textContent = '';
      glance.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
    }
  }
}

async function loadPendingExercises() {
  const box = document.getElementById('pending-exercises');
  if (!getApiKey()) {
    box.innerHTML = '<span class="muted">Set your API key in Settings.</span>';
    return;
  }
  try {
    const res = await api('/api/pending-exercises');
    const items = res.data?.pending_exercises || [];
    box.innerHTML = '';
    if (!items.length) {
      box.appendChild(el('span', { class: 'muted', text: 'All exercises in recent sessions matched the catalog.' }));
      return;
    }
    box.appendChild(renderTable(
      ['Exercise (as typed)', 'Closest catalog match', 'Lift code'],
      items.map(item => {
        const best = item.closest_matches?.[0];
        return [item.exercise, best?.canonical_exercise ?? '—', best?.lift_code ?? '—'];
      })
    ));
    box.appendChild(el('p', { class: 'muted', text: `${items.length} exercise(s) need catalog entries. Add them to Exercise_Catalog with the canonical name and a variant matching what you type.` }));
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

async function loadBodyTab() {
  // Pending/unrecognised exercises moved to Settings → Data; Body is trend-first.
  await loadBwHistory();
}

/* ===== Temporary app.js → satellite bridge (PR-09) =====
 * app.js is now an ES module (was a classic global script). The still-unconverted
 * satellite modules (coach-conversation.js, drawer.js) call these app.js functions
 * as BARE globals — which resolved for free while app.js was classic. As a module,
 * app.js's top-level declarations are module-scoped, so we re-expose exactly the
 * symbols the satellites reference on `window` (bare identifiers in a module resolve
 * to global-object properties). This block is assigned at module load, before any
 * satellite handler can fire. It SHRINKS to nothing once the satellites import these
 * directly (PR-10/PR-11). The `window.atlas*` hooks below/elsewhere are unchanged. */
window.api = api;
window.fetchReaction = fetchReaction;
window.getApiKey = getApiKey;
window.addSetRow = addSetRow;
window.emitSetLogged = emitSetLogged;
window.getActiveIntentId = getActiveIntentId;
window.getActivePlannedSession = getActivePlannedSession;
window.getSessionCompleted = getSessionCompleted;
window.invalidatePreview = invalidatePreview;
window.normalizePlanExercise = normalizePlanExercise;
window.previewSetsForLift = previewSetsForLift;
window.setCoachSuggestionEngaged = setCoachSuggestionEngaged;
// app.js top-level VALUES the satellites read bare (data tables + the preview table
// DOM ref) — same transitional bridge, resolved once at load.
window.FRIENDLY_PATTERN_LABELS = FRIENDLY_PATTERN_LABELS;
window.FRIENDLY_STATUS_WORDS = FRIENDLY_STATUS_WORDS;
window.setsTableBody = setsTableBody;
// e2e test-support: the Playwright suite drives these planned-session helpers via
// page.evaluate (they were reachable as classic-script globals). Exposing this small
// subset is strictly less than the old "every function is global" surface. Removed
// when the e2e suite drives them through real UI actions (test-hardening follow-up).
window.startPlannedSession = startPlannedSession;
window.firstUnloggedPlannedLift = firstUnloggedPlannedLift;
window.plannedExerciseOrder = plannedExerciseOrder;
window.remainingPlannedExercises = remainingPlannedExercises;

/* ===== Init ===== */

function setDefaultDate() {
  const today = getLocalDateString();
  document.getElementById('log-date').value = today;
  document.getElementById('bw-date').value = today;
  // RC2: returning the field to the default today is NOT an explicit owner choice, so
  // clear the manual-entry latch. Without this, a one-time manual date edit would stay
  // "manual" for the PWA's lifetime — and after a post-save reset (which calls this) a
  // later closeout screenshot would be forced under today, re-introducing the RC2 bug.
  logDateManuallyEntered = false;
}

// RC2: a real keystroke/picker change on the date field marks it as an EXPLICIT
// manual entry, so a closeout screenshot's own date won't override the owner's choice.
// Programmatic setDefaultDate()/value assignments don't fire 'input', so they never
// trip this — only genuine owner input does.
document.getElementById('log-date')?.addEventListener('input', () => { logDateManuallyEntered = true; });

setDefaultDate();
checkConnection();
// Mobile resume safety: if a recent in-progress session was snapshotted before a
// reload/force-quit/background, restore it so the lifter picks up mid-session.
restoreSessionSnapshot();
loadDashboard();
loadCoachPlan();
loadWeeklyCoach();
loadExerciseDatalist();

document.getElementById('intent-drawer-backdrop')?.addEventListener('click', closeIntentDrawer);
document.getElementById('intent-drawer-close')?.addEventListener('click', closeIntentDrawer);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    // offline shell is an optional enhancement — the app works without it
  });
}
