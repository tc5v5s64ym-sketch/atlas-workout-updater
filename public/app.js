/* Atlas frontend — read-only views + approve-before-save workout logger.
 * Golden rule: AI/backend can parse, prepare, and preview. The owner approves.
 * Only then does Atlas write. Preview always runs with test_mode=true.
 */

const API_KEY_STORAGE = 'atlas_api_key';

function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

async function api(path, options = {}) {
  const headers = { 'x-atlas-api-key': getApiKey(), ...(options.headers || {}) };
  const res = await fetch(path, { ...options, headers });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = json?.message || json?.error || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
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
    for (const ex of exercises) {
      const opt = document.createElement('option');
      opt.value = ex.canonical_name;
      if (ex.lift_code) opt.label = ex.lift_code;
      dl.appendChild(opt);
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
          block.appendChild(el('div', { class: 'session-ex-set', text: `${r.weight} × ${r.reps}${rir}${note}` }));
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
    slot.innerHTML = `<span class="muted">Could not load detail: ${err.message}</span>`;
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
          ? (last.rir != null ? `${last.weight} × ${last.reps} @${last.rir}` : `${last.weight} × ${last.reps}`)
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
    renderCoachReadStrip(intentData);
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

  // Below-fold sources load independently; each fills its own glance card.
  loadCoaching();
  loadWeeklySummary();
  loadRecentHistory();
  loadRecentPrs();
  loadStalls();
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
      card.appendChild(el('div', { class: 'coach-plan-last', text: `${when}: ${last.weight} × ${last.reps}${rir}` }));
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

function renderCoachReadStrip(data) {
  const strip = document.getElementById('coach-read-strip');
  if (!strip) return;
  const todaysRead = data.todays_read || {};
  const patterns = todaysRead.patterns || [];
  if (!patterns.length) return;
  strip.innerHTML = '';
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
      document.getElementById('surface-coach')?.click();
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
  const firstEx = recommended ? normalizePlanExercise(recommended.exercises?.[0]) : null;

  if (firstEx && firstEx.name) {
    btn.textContent = 'START SESSION';
    btn.hidden = false;
    btn.onclick = () => openIntentDrawer(recommended);
  } else if (recommended) {
    btn.textContent = 'See options';
    btn.hidden = false;
    btn.onclick = () => openIntentDrawer(recommended);
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

// Read-only accessor for coach-conversation.js (coach layer must never mutate
// the session directly — only app.js advances/ends it via advancePlannedSession
// and endPlannedSession).
function getActivePlannedSession() { return activePlannedSession; }

function startPlannedSession(intent) {
  const exercises = (intent.exercises || []).map(normalizePlanExercise).filter(ex => ex.name);
  if (!exercises.length) return;
  activePlannedSession = {
    label: intent.label || 'Recommended session',
    // The plan intent id (e.g. 'deload_reset') rides along so the in-workout
    // reaction can flip on a deload day — see fetchReaction.
    intentId: intent.id || null,
    exercises,
    index: 0
  };
  renderActiveSessionBanner();
  const first = exercises[0];
  startLift(first.name, first.liftCode, first.weight, first.reps, first.sets || 3);
}

function renderActiveSessionBanner() {
  const banner = document.getElementById('active-session-banner');
  if (!banner) return;
  banner.innerHTML = '';
  if (!activePlannedSession) { banner.hidden = true; return; }
  const { label, exercises, index } = activePlannedSession;
  const current = exercises[index];
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
  banner.hidden = false;
}

function advancePlannedSession() {
  if (!activePlannedSession) return;
  if (activePlannedSession.index >= activePlannedSession.exercises.length - 1) { endPlannedSession(); return; }
  activePlannedSession.index += 1;
  renderActiveSessionBanner();
  const ex = activePlannedSession.exercises[activePlannedSession.index];
  startLift(ex.name, ex.liftCode, ex.weight, ex.reps, ex.sets || 3);
}

function endPlannedSession() {
  activePlannedSession = null;
  renderActiveSessionBanner();
}

// Open the recommended workout as a Today Session Plan (reuses the intent
// drawer). Read-only fetch; failure is silent so logging is never blocked.
async function openTodaySessionPlan() {
  if (!getApiKey()) return;
  try {
    const res = await api('/api/plan/intent-recommendation');
    const intents = res.data?.intents || [];
    const recommended = intents.find(i => i.recommended) || intents.find(i => i.id !== 'custom') || intents[0];
    if (recommended) openIntentDrawer(recommended);
  } catch {
    // best-effort — never block the logger
  }
}

// Phrases that ask for the recommended workout rather than logging a set.
// Workout shorthand always carries numbers, so any digit rules a phrase out —
// this keeps "Bench 225 5/2 x3" on the normal parse/preview path.
function looksLikeSessionRequest(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || /\d/.test(t)) return false;
  return /\b(recommended (workout|session)|what should i train|what are we doing|today'?s plan|what'?s the plan|do (my|the|your) (workout|session)|let'?s (do|start|run) (it|this|the workout|my workout|the session|your recommended workout))\b/.test(t);
}

function looksLikeCorrection(text) {
  const t = String(text || '').trim().toLowerCase();
  return /\b(actually[,. ]|i was wrong|that'?s wrong|correction[,: ]|meant to (say|log|write|do)\b|should have been|that was wrong|i meant\b|wrong (weight|reps|sets|exercise)|oops[,. ]|my mistake|i made a mistake)\b/.test(t);
}

// End-of-session compilation trigger: the lifter has been logging sets
// conversationally and now wants Atlas to compile them into one preview.
function looksLikeLogIt(text) {
  // Accept straight or curly apostrophes — mobile keyboards autocorrect to curly.
  return /^\s*(log\s+it|log\s+that|log\s+the\s+session|log\s+this\s+session|log\s+this\s+workout|save\s+the\s+session|save\s+it|ok\s+log\s+it|alright\s+log\s+it|compile\s+(the\s+)?session|that['’]?s?\s+all|that['’]?s\s+it(\s+for\s+(today|now))?|we['’]?re?\s+done(\s+logging)?|done(\s+for\s+today)?|finish(\s+session)?|end\s+(the\s+)?session)\s*[.!]?\s*$/i.test(String(text || ''));
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
    box.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
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
    box.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
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
    box.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
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
    box.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
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
        pr.bestWeightSet ? `${pr.bestWeightSet.weight} × ${pr.bestWeightSet.reps} (${pr.bestWeightSet.date_clean})` : '—',
        pr.bestRepSet ? `${pr.bestRepSet.weight} × ${pr.bestRepSet.reps} (${pr.bestRepSet.date_clean})` : '—',
        pr.bestEstimated1RMSet ? `${pr.bestEstimated1RMSet.estimated_1rm} (${pr.bestEstimated1RMSet.date_clean})` : '—'
      ])
    ));
  } catch (err) {
    box.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
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
    box.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
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
    resultBox.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
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
    recBox.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
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
    resultBox.innerHTML = `<span class="muted">Could not load lifts: ${err.message}</span>`;
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
        const setText = s.rir != null ? `${s.weight} × ${s.reps} @${s.rir}` : `${s.weight} × ${s.reps}`;
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
    box.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
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
    box.innerHTML = `<span class="muted">Search failed: ${err.message}</span>`;
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
      const setText = s.rir != null ? `${s.weight} × ${s.reps} @${s.rir}` : `${s.weight} × ${s.reps}`;
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
    box.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
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
    box.innerHTML = `<span class="muted">Search failed: ${err.message}</span>`;
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
    const summary = data.sets.map(s => `${s.weight}×${s.reps}`).join('  ');
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

  for (const line of lines) {
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

function parserStatusNode(status) {
  if (!status) return null;
  const label = status.source === 'backend' ? 'Parsed by backend parser' : 'Parsed locally';
  return el('div', { class: 'parser-status', text: label });
}

function rowsFromBackendParsedWorkout(parsed) {
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
          activeExercise,
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
    const err = new Error('Backend parser did not prove no-write safety.');
    err.noFallback = true;
    throw err;
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
    const err = new Error('Backend parser did not produce any set rows.');
    err.noFallback = true;
    throw err;
  }
  return { intent: 'log_sets', rows, warnings: data.warnings || [], prescribed: Array.isArray(parsed.prescribed) ? parsed.prescribed : null };
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

async function rowsFromWorkoutInput() {
  const workoutText = workoutTextInput.value.trim();
  if (!workoutText || workoutText === lastParsedWorkoutText) return;

  let parsed;
  try {
    parsed = await parseWorkoutTextWithBackend(workoutText);
  } catch (backendError) {
    if (!shouldUseLocalFallback(backendError)) throw backendError;
    console.warn('[atlas] parse-workout-text unavailable, using local fallback:', backendError.message);
    const localResult = parseWorkoutText(workoutText);
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

  // The parser couldn't confidently resolve the lift name and echoed the typed
  // text instead of guessing a real lift. Surface it so the wrong history isn't
  // saved — the exercise field is editable, so a tap fixes it before approval.
  if ((parsed.warnings || []).includes('unknown_exercise')) {
    parsedRowsEditor.hidden = false;
    setStatus(loggerStatus, "Didn't catch that lift — check the exercise name before saving.", 'warn');
  }
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
function emitCoachPreview(rows, liftCodes, effortOnly, effort, substitutions) {
  try {
    document.dispatchEvent(new CustomEvent('atlas:preview-ready', {
      detail: {
        rows: rows || [],
        liftCodes: liftCodes || [],
        effortOnly: Boolean(effortOnly),
        effort: effort || null,
        substitutions: Array.isArray(substitutions) ? substitutions : []
      }
    }));
  } catch { /* narration is optional */ }
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

// Editor-ready rows from the buffer, numbering sets per exercise.
function buildRowsFromSessionLog() {
  const counts = new Map();
  return sessionLog.map(s => {
    const n = (counts.get(s.exercise) || 0) + 1;
    counts.set(s.exercise, n);
    return { exercise: s.exercise, set_number: String(n), weight: s.weight, reps: s.reps, rir: s.rir, notes: s.notes || '' };
  });
}

// Resolve the best stable identity for plan_completed tracking. When both the
// server enrichment and the active planned session are present, prefer the
// PLANNED exercise name so the server's name-based computePlanState can match
// it against current_plan[].name (e.g. "Barbell Row" logged for planned "Rows").
//
// Returns the same string that currentPlanForChat emits for the matched plan
// entry: canonicalName (canonical_exercise) if present, else name (exercise).
// Priority:
//   1. lift_code match against planned session → planned canonical/display name
//   2. canonical_exercise exact match → planned canonical/display name
//   3. fall back to raw logged exercise name
function resolveCompletedIdentity(rawName, enrichmentRow, plannedSession) {
  if (plannedSession) {
    const planName = m => m.canonicalName || m.name;
    const loggedCode = enrichmentRow && enrichmentRow.lift_code;
    if (loggedCode) {
      const match = plannedSession.exercises.find(e => e.liftCode && e.liftCode.toLowerCase() === loggedCode.toLowerCase());
      if (match) return planName(match);
    }
    const canonical = (enrichmentRow && enrichmentRow.canonical_exercise) || '';
    if (canonical) {
      const key = canonical.toLowerCase();
      const match = plannedSession.exercises.find(e => (e.name || '').toLowerCase() === key);
      if (match) return planName(match);
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
    const completedName = resolveCompletedIdentity(o.exercise, enrichMap.get(o.exercise), activePlannedSession);
    if (!sessionCompleted.includes(completedName)) sessionCompleted.push(completedName);
  }
  if (byExercise.length) {
    try {
      document.dispatchEvent(new CustomEvent('atlas:set-logged', {
        detail: {
          exercises: byExercise,
          text: text || '',
          ...(Array.isArray(substitutions) && substitutions.length ? { substitutions } : {})
        }
      }));
    } catch { /* narration is optional */ }
  }
  // The session lives in the buffer (sessionLog) above, not the parsed-rows
  // editor — clear the transient rows so the end-of-session save rebuilds the
  // FULL session from the buffer.
  if (setsTableBody) setsTableBody.innerHTML = '';
  if (parsedRowsEditor) parsedRowsEditor.hidden = true;
  lastParsedWorkoutText = '';
  invalidatePreview();
}

// `justLoggedSet` (optional) anchors the recommendation on the set the lifter
// just logged — under session-level save it isn't in the sheet yet, so without
// it the recommendation reflects the PREVIOUS session. Other callers (preview,
// post-write) omit it and get the history-only recommendation, unchanged.
async function fetchReaction(liftCode, justLoggedSet) {
  if (!liftCode || !getApiKey()) return null;
  try {
    const params = new URLSearchParams();
    // Thread the active plan intent (e.g. 'deload_reset') so the engine's reaction
    // flips on a deload day — an easy/high-RIR set reads on-plan, not "add weight".
    const intentId = activePlannedSession && activePlannedSession.intentId;
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
  const currentEx = activePlannedSession.exercises[activePlannedSession.index];
  if (!currentEx || !currentEx.name || !getApiKey()) return false;
  try {
    const res = await api('/api/suggest-substitute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, current_exercise: currentEx.name })
    });
    const rec = res && res.data && res.data.recommendation;
    if (rec) {
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
  const lastLabel = lastSet.rir != null ? `${lastSet.weight} × ${lastSet.reps} @${lastSet.rir}` : `${lastSet.weight} × ${lastSet.reps}`;
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
    rows.push(['Last', `${lastSet.weight} × ${lastSet.reps}${rir}`]);
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
  // Prefer the structured session buffer — no Gemini, no re-parse. The
  // conversational compile below is only a fallback (e.g. after a page reload
  // when the buffer is empty but the chat history survived).
  if (sessionLog.length) {
    populateSetRows(buildRowsFromSessionLog());
    sessionCompiledAwaitingPreview = true;
    document.getElementById('logger-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return;
  }

  const turns = typeof window.getChatHistory === 'function' ? window.getChatHistory() : [];

  if (!turns.length) {
    setStatus(loggerStatus, "No conversation yet — log some sets in the chat first, then say 'log it'.", 'error');
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
    setStatus(loggerStatus, `Could not compile session: ${err.message}`, 'error');
    return;
  }

  if (!workoutText) {
    setStatus(loggerStatus, "Couldn't find any sets in the conversation — did you log any exercises? You can type them in the composer directly.", 'error');
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

function previewProofFromResult(result, mode) {
  const data = mode === 'manual' ? (result?.data || {}) : (result?.data?.data || {});
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
  if ((proof.mode === 'screenshot' || proof.mode === 'effort-only') && proof.sheet_write !== 'skipped') return false;
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

// Returns today's recommended exercises as {name, rationale} objects for the
// coach context, so the model can answer "why in this order?" without claiming
// it lacks the sequence. Falls back to [] when no plan has loaded.
function currentPlanForChat() {
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
  if (sessionCompleted.length) context.plan_completed = [...sessionCompleted];
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

document.getElementById('logger-form').addEventListener('submit', async e => {
  e.preventDefault();

  // Training-plan questions ("what should I train", "today's plan") are routed
  // to the coach chat so Atlas replies naturally in the thread — no modal first.
  if (looksLikeSessionRequest(workoutTextInput.value)) {
    const planText = workoutTextInput.value.trim();
    setTimeout(() => { workoutTextInput.value = ''; }, 0);
    routeMessageToCoach(planText);
    return;
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
  let logRows = [];
  try {
    await rowsFromWorkoutInput();
    logRows = collectLogRows(sessionId, date);
  } catch (err) {
    // Text that isn't a loggable workout, with no effort attached, is treated as
    // a question for the coach rather than a parse error — so "was that a good
    // session?" or just "Bench" gets a conversation instead of a red dead-end.
    // For constraint messages during an active session, try the substitute endpoint
    // first. If a card was dispatched, skip the coach route (one response per message).
    // If no recommendation exists in the catalog, fall through to the coach as normal.
    if (pendingChatText && !hasAnyEffortInput()) {
      const suggested = await checkAndSuggestSubstitute(pendingChatText);
      if (!suggested) routeMessageToCoach(pendingChatText);
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

  let file = null;
  if (mode === 'screenshot') {
    const imageInput = document.getElementById('effort-image');
    file = imageInput.files[0] || null;
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
          // Send only the current plan step, not the full plan. Sending all
          // exercises with a single logged set causes the broad-region fallback
          // to claim the wrong planned lift when plan order differs from the
          // substituted exercise (e.g. Deadlift before Squat when Leg Press is logged).
          const currentEx = activePlannedSession.exercises[activePlannedSession.index];
          if (currentEx) {
            subPayload.plan_exercises = [{
              name: currentEx.name,
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

  try {
    if (mode === 'screenshot') {
      if (!file) throw new Error('Choose a screenshot file, or switch to manual effort entry.');

      const result = await submitCompleteWorkout({ file, logRows, sessionId, date, location, notes, testMode: true });
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
        previewProof: previewProofFromResult(result, 'screenshot')
      };
      renderCompleteWorkoutPreview(result);
    } else if (effortOnly) {
      const result = await submitCompleteWorkout({ logRows, sessionId, date, location, notes, manualEffort, testMode: true });
      if (!hasCompleteWorkoutNoWriteProof(result)) {
        throw new Error('Preview did not prove no-write safety. Nothing can be written.');
      }
      pendingWrite = { mode: 'effort-only', logRows, sessionId, date, location, notes, manualEffort, effortOnly: true, writeId: generateWriteId(), previewProof: previewProofFromResult(result, 'effort-only') };
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
        // Sends the full plan (contrast: mid-session path above sends only exercises[index]).
        // On a partial log, inferPrescribedPairs sees all planned lifts competing for
        // fewer logged exercises; the broad-region fallback can attribute to the wrong lift.
        // Dry-run only — no data risk. Fix deferred (see BACKLOG.md).
        payload.plan_exercises = activePlannedSession.exercises.map(ex => ({
          name: ex.name,
          ...(ex.liftCode ? { lift_code: ex.liftCode } : {})
        }));
      }

      const result = await api('/api/log-workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
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
    document.getElementById('approve-btn').disabled = !pendingWriteHasPreviewProof(pendingWrite);
    const gateNote = document.getElementById('preview-gate-note');
    if (gateNote) gateNote.textContent = effortOnly
      ? 'Review the dry-run above, then click to write Effort only.'
      : 'Review the dry-run above, then click to write.';
  } catch (err) {
    setStatus(loggerStatus, `Preview failed: ${err.message}`, 'error');
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
  return api('/api/complete-workout', { method: 'POST', body: form });
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
  previewContent.appendChild(renderRowsSummary(data.log_rows_preview || []));
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
  emitCoachPreview(data.log_rows_preview, liftCodes, false, reviewEffort, data.substitutions);
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

  const dup = data.duplicate_check || {};
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
  emitCoachPreview(data.rows_to_write, completeLiftCodes, effortOnly, data.parsed_effort || null);
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
    el('h3', { text: data.effort_source === 'manual' ? 'Parsed effort (manual entry)' : 'Parsed effort (from screenshot)' }),
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

async function handleUndoLastWrite() {
  if (!lastWrite) return;
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
// no reimplementation of the undo/delete logic.
window.atlasUndoLastWrite = handleUndoLastWrite;

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
        if (!(Number(writeData.log_rows_written || 0) > 0)) {
          throw new Error(`Write confirmed but log_rows_written=${writeData.log_rows_written ?? 'missing'}. Verify Sheets before approving again.`);
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
        : wasEffortOnly ? 'Effort written to Google Sheets. ✓' : 'Workout written to Google Sheets. ✓',
      'ok'
    );
    // Always reflect the write that just happened. Screenshot / effort-only
    // writes produce no undoable log range (pendingLastWrite stays null), so
    // this clears any stale manual range — otherwise a correction after an
    // effort save would Replace-via-undo the wrong (older) rows.
    lastWrite = pendingLastWrite;
    // The session is saved — start the next session's buffer fresh.
    if (pendingLastWrite) sessionLog = [];
    if (pendingLastWrite) sessionCompleted = [];
    if (pendingLastWrite) {
      const undoBtn = el('button', { class: 'secondary undo-write-btn', text: 'Undo last write' });
      undoBtn.addEventListener('click', handleUndoLastWrite);
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
    setStatus(bwStatus, `Preview failed: ${err.message}`, 'error');
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
    if (glance) glance.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
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
    box.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
  }
}

async function loadBodyTab() {
  // Pending/unrecognised exercises moved to Settings → Data; Body is trend-first.
  await loadBwHistory();
}

/* ===== Init ===== */

function setDefaultDate() {
  const today = getLocalDateString();
  document.getElementById('log-date').value = today;
  document.getElementById('bw-date').value = today;
}

setDefaultDate();
checkConnection();
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
