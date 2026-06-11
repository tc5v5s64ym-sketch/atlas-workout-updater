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
  });
});

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
});

document.getElementById('clear-key-btn').addEventListener('click', () => {
  localStorage.removeItem(API_KEY_STORAGE);
  setStatus(document.getElementById('settings-status'), 'API key cleared.', 'ok');
});

/* ===== Dashboard (read-only) ===== */

async function loadDashboard() {
  if (!getApiKey()) {
    for (const id of ['todays-plan', 'coaching', 'weekly-summary', 'recent-history', 'recent-prs', 'stalls']) {
      document.getElementById(id).innerHTML = '<span class="muted">Set your API key in Settings to load data.</span>';
    }
    return;
  }

  loadTodaysPlan();
  loadCoaching();
  loadWeeklySummary();
  loadRecentHistory();
  loadRecentPrs();
  loadStalls();
}

async function loadTodaysPlan() {
  const box = document.getElementById('todays-plan');
  try {
    const res = await api('/api/plan/today');
    const recs = res.data?.recommendations || [];
    box.innerHTML = '';

    if (!recs.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No training history found — log your first workout to see a plan here.' }));
      return;
    }

    const grid = el('div', { class: 'plan-grid' });
    for (const r of recs) {
      const t = r.next_target;
      const confidenceClass = r.confidence === 'high' ? 'plan-card-high' : r.confidence === 'medium' ? 'plan-card-medium' : 'plan-card-low';
      const card = el('div', { class: `plan-card ${confidenceClass}` }, [
        el('div', { class: 'plan-card-lift' }, [
          el('a', { class: 'lift-link', href: '#', 'data-lift': r.liftCode, text: r.liftCode })
        ]),
        el('div', { class: 'plan-card-target', text: `${t.weight} × ${t.reps}` }),
        el('div', { class: 'plan-card-sets', text: `${t.sets} sets` }),
        el('div', { class: 'plan-card-rec', text: r.recommendation })
      ]);
      grid.appendChild(card);
    }
    box.appendChild(grid);
  } catch (err) {
    box.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
  }
}

async function loadCoaching() {
  const box = document.getElementById('coaching');
  try {
    const res = await api('/api/coaching/insights');
    const data = res.data || {};
    box.innerHTML = '';

    const fatigue = data.fatigue || {};
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
        const li = el('li', {}, [
          el('a', { class: 'lift-link', href: '#', 'data-lift': d.liftCode, text: d.liftCode }),
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
    if (!sets.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No recent sets.' }));
      return;
    }
    box.appendChild(renderTable(
      ['Date', 'Session', 'Exercise', 'Set', 'Weight', 'Reps', 'RIR'],
      sets.map(s => [s.date_clean, s.session_id, s.exercise, s.set_number, s.weight, s.reps, s.rir])
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
    if (!prs.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No PRs recorded yet.' }));
      return;
    }
    box.appendChild(renderTable(
      ['Lift', 'Best weight', 'Best reps', 'Best est. 1RM'],
      prs.map(pr => [
        pr.liftCode,
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
    if (!stalls.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No stalled lifts — keep it up.' }));
      return;
    }
    const table = el('table', {});
    const thead = el('thead', {}, el('tr', {}, ['Lift', 'Sessions stalled', 'Last best weight', 'Since'].map(h => el('th', { text: h }))));
    const tbody = el('tbody', {}, stalls.map(s => el('tr', {}, [
      el('td', {}, el('a', { class: 'lift-link', href: '#', 'data-lift': s.liftCode, text: s.liftCode })),
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
  } catch (err) {
    recBox.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
  }
});

/* ===== Lift-link navigation (dashboard → progress) ===== */

document.addEventListener('click', e => {
  const link = e.target.closest('.lift-link');
  if (!link) return;
  e.preventDefault();
  const liftCode = link.dataset.lift;
  if (!liftCode) return;
  // Switch to Progress tab
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const progressBtn = document.querySelector('[data-tab="progress"]');
  progressBtn.classList.add('active');
  document.getElementById('tab-progress').classList.add('active');
  // Pre-fill and submit the progress form
  const liftInput = document.getElementById('progress-lift-code');
  liftInput.value = liftCode;
  document.getElementById('progress-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
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
let lastParsedWorkoutText = '';
let lastParserStatus = null;

// Cache last-time lookups to avoid redundant API calls within a session.
const lastTimeCache = new Map();

async function showLastTimeHint(exerciseInput, hintEl) {
  const exercise = exerciseInput.value.trim();
  if (!exercise || !getApiKey()) { hintEl.textContent = ''; return; }

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

  if (!data.sets || !data.sets.length) { hintEl.textContent = ''; return; }
  const summary = data.sets.map(s => `${s.weight}×${s.reps}`).join('  ');
  hintEl.textContent = `Last (${data.date}): ${summary}`;
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
  const label = status.source === 'backend'
    ? 'Parsed by backend parser'
    : 'Backend parser unavailable - local parser fallback used';
  return el('div', { class: 'parser-status', text: label });
}

function rowsFromBackendParsedWorkout(parsed) {
  if (!parsed || parsed.intent !== 'log_sets' || !Array.isArray(parsed.sets)) {
    const message = parsed?.message || parsed?.warnings?.join(' | ') || `Parser returned ${parsed?.intent || 'no'} intent.`;
    throw new Error(message);
  }

  const exercise = parsed.canonical_name || parsed.exercise || parsed.raw_name || '';
  if (!exercise) throw new Error('Parser did not return an exercise.');

  return parsed.sets.map((set, index) => ({
    exercise,
    set_number: String(index + 1),
    weight: set.weight == null ? '' : String(set.weight),
    reps: set.reps == null ? '' : String(set.reps),
    rir: set.rir == null ? '' : String(set.rir),
    notes: set.load_note ? set.load_note : ''
  }));
}

async function parseWorkoutTextWithBackend(workoutText) {
  const result = await api('/api/parse-workout-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: workoutText,
      context: {
        activeExercise: null,
        activeSessionType: null,
        todayPlan: null
      },
      test_mode: true
    })
  });

  const data = result?.data || {};
  if (data.test_mode !== true || data.sheet_written !== false || data.no_write_confirmed !== true) {
    throw new Error('Backend parser did not prove no-write safety.');
  }

  const rows = rowsFromBackendParsedWorkout(data.parsed);
  if (!rows.length) throw new Error('Backend parser did not produce any set rows.');
  return { rows, warnings: data.warnings || [] };
}

function populateSetRows(rows) {
  setsTableBody.innerHTML = '';
  for (const row of rows) addSetRow(row);
  parsedRowsEditor.hidden = rows.length === 0;
}

async function rowsFromWorkoutInput() {
  const workoutText = workoutTextInput.value.trim();
  if (workoutText && workoutText !== lastParsedWorkoutText) {
    try {
      const parsed = await parseWorkoutTextWithBackend(workoutText);
      populateSetRows(parsed.rows);
      lastParserStatus = { source: 'backend' };
    } catch (backendError) {
      setStatus(loggerStatus, 'Backend parser unavailable - using local parser fallback.', 'warn');
      const parsed = parseWorkoutText(workoutText);
      if (parsed.errors.length > 0) {
        throw new Error(parsed.errors.join(' | '));
      }
      if (!parsed.rows.length) {
        throw new Error('Workout text did not produce any set rows.');
      }
      populateSetRows(parsed.rows);
      lastParserStatus = { source: 'local' };
    }
    parsedRowsEditor.hidden = true;
    lastParsedWorkoutText = workoutText;
  }
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

function invalidatePreview() {
  pendingWrite = null;
  previewPanel.hidden = true;
  previewContent.innerHTML = '';
  const btn = document.getElementById('approve-btn');
  btn.disabled = true;
  btn.textContent = 'Write to Google Sheets';
  const note = document.getElementById('preview-gate-note');
  if (note) note.textContent = 'Run a preview above to enable this button.';
}

document.getElementById('logger-form').addEventListener('input', invalidatePreview);

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
    data.sheet_written === false &&
    data.no_write_confirmed === true;
}

document.getElementById('logger-form').addEventListener('submit', async e => {
  e.preventDefault();
  setStatus(loggerStatus, '', 'ok');
  invalidatePreview();

  const date = document.getElementById('log-date').value;
  if (!date) {
    setStatus(loggerStatus, 'Date is required.', 'error');
    return;
  }
  const sessionId = document.getElementById('log-session-id').value.trim() || generateSessionId(date);
  const location = document.getElementById('log-location').value.trim();
  const notes = document.getElementById('log-notes').value.trim();
  let logRows = [];
  try {
    await rowsFromWorkoutInput();
    logRows = collectLogRows(sessionId, date);
  } catch (err) {
    setStatus(loggerStatus, `Could not parse workout text: ${err.message}`, 'error');
    return;
  }

  if (!logRows.length) {
    setStatus(loggerStatus, 'Enter workout text first, then preview. You can edit parsed rows after preview.', 'error');
    return;
  }

  const previewBtn = document.getElementById('preview-btn');
  previewBtn.disabled = true;
  previewBtn.textContent = 'Previewing…';

  try {
    if (effortMode() === 'screenshot') {
      const imageInput = document.getElementById('effort-image');
      const file = imageInput.files[0];
      if (!file) throw new Error('Choose a screenshot file, or switch to manual effort entry.');

      const result = await submitCompleteWorkout({ file, logRows, sessionId, date, location, notes, testMode: true });
      if (!hasCompleteWorkoutNoWriteProof(result)) {
        throw new Error('Preview did not prove no-write safety. Nothing can be written.');
      }
      pendingWrite = { mode: 'screenshot', file, logRows, sessionId, date, location, notes };
      renderCompleteWorkoutPreview(result);
    } else {
      let effortRow = null;
      effortRow = collectManualEffort(sessionId, date, location, notes);

      const payload = { session_id: sessionId, date, log_rows: logRows, test_mode: 'true' };
      if (effortRow) payload.effort_row = effortRow;

      const result = await api('/api/log-workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!hasLogWorkoutNoWriteProof(result)) {
        throw new Error('Preview did not prove no-write safety. Nothing can be written.');
      }
      pendingWrite = { mode: 'manual', payload };
      renderLogWorkoutPreview(result, effortRow);
    }
    previewPanel.hidden = false;
    parsedRowsEditor.hidden = false;
    document.getElementById('approve-btn').disabled = !pendingWrite;
    const gateNote = document.getElementById('preview-gate-note');
    if (gateNote) gateNote.textContent = 'Review the dry-run above, then click to write.';
  } catch (err) {
    setStatus(loggerStatus, `Preview failed: ${err.message}`, 'error');
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = 'Preview — no data saved';
  }
});

async function submitCompleteWorkout({ file, logRows, sessionId, date, location, notes, testMode }) {
  const form = new FormData();
  form.append('image', file);
  form.append('log_rows_json', JSON.stringify(logRows));
  form.append('session_id', sessionId);
  form.append('date', date);
  if (location) form.append('location', location);
  if (notes) form.append('notes', notes);
  if (testMode) form.append('test_mode', 'true');
  return api('/api/complete-workout', { method: 'POST', body: form });
}

const LOG_PREVIEW_HEADERS = ['Date', 'Session', 'Exercise', 'Canonical', 'Muscle group', 'Lift code', 'Set', 'Weight', 'Reps', 'RIR', 'Notes', 'Volume'];

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
  const proof = el('div', { class: 'no-write-proof' }, [
    el('span', { class: 'proof-headline', text: 'DRY-RUN — NOTHING WAS WRITTEN' }),
    el('span', { class: 'proof-fields', text: `test_mode: ${data.test_mode}  ·  sheet_written: ${data.sheet_written}  ·  no_write_confirmed: ${data.no_write_confirmed}  ·  sheet_write: ${data.sheet_write}` })
  ]);
  previewContent.appendChild(proof);
  const logAutoMatches = renderAutoMatches(data.auto_matches);
  if (logAutoMatches) previewContent.appendChild(logAutoMatches);
  previewContent.appendChild(renderWarnings(data.warnings));
  const logSuggestions = renderUnknownExerciseSuggestions(data.pending_exercises);
  if (logSuggestions) previewContent.appendChild(logSuggestions);
  previewContent.appendChild(el('h3', { text: `Workout rows to write (${(data.log_rows_preview || []).length})` }));
  previewContent.appendChild(renderTable(LOG_PREVIEW_HEADERS, data.log_rows_preview || []));
  if (effortRow) {
    previewContent.appendChild(el('h3', { text: 'Effort row to write' }));
    previewContent.appendChild(renderTable(
      ['Date', 'Session', 'Duration', 'Active cal', 'Total cal', 'Avg HR', 'Peak HR', 'Location', 'Notes'],
      [data.effort_row_preview || Object.values(effortRow)]
    ));
  }
}

function renderCompleteWorkoutPreview(result) {
  // complete-workout nests its body one level deeper than log-workout
  const outer = result.data || {};
  const data = outer.data || {};
  previewContent.innerHTML = '';
  const parseStatus = parserStatusNode(lastParserStatus);
  if (parseStatus) previewContent.appendChild(parseStatus);
  const proof = el('div', { class: 'no-write-proof' }, [
    el('span', { class: 'proof-headline', text: 'DRY-RUN — NOTHING WAS WRITTEN' }),
    el('span', { class: 'proof-fields', text: `test_mode: ${data.test_mode}  ·  sheet_written: ${data.sheet_written}  ·  no_write_confirmed: ${data.no_write_confirmed}` })
  ]);
  previewContent.appendChild(proof);
  const completeAutoMatches = renderAutoMatches(outer.auto_matches);
  if (completeAutoMatches) previewContent.appendChild(completeAutoMatches);
  previewContent.appendChild(renderWarnings(outer.warnings));
  const completeSuggestions = renderUnknownExerciseSuggestions(outer.pending_exercises);
  if (completeSuggestions) previewContent.appendChild(completeSuggestions);

  const dup = data.duplicate_check || {};
  if (dup.duplicate_log_rows > 0) {
    previewContent.appendChild(el('div', { class: 'preview-warnings', text: `${dup.duplicate_log_rows} row(s) will be skipped as duplicates.` }));
  }

  previewContent.appendChild(el('h3', { text: `Workout rows to write (${(data.rows_to_write || []).length})` }));
  previewContent.appendChild(renderTable(LOG_PREVIEW_HEADERS, data.rows_to_write || []));

  previewContent.appendChild(el('h3', { text: 'Parsed effort (from screenshot)' }));
  const effort = data.parsed_effort || {};
  previewContent.appendChild(renderTable(
    ['Duration', 'Active cal', 'Total cal', 'Avg HR', 'Peak HR', 'Type'],
    [[effort.duration, effort.activeCalories, effort.totalCalories, effort.averageHR, effort.peakHR, effort.workoutType]]
  ));
  previewContent.appendChild(el('p', { class: 'muted', text: `Session quality score: ${data.quality_score ?? '—'} / 5` }));
}

document.getElementById('cancel-preview-btn').addEventListener('click', invalidatePreview);

document.getElementById('approve-btn').addEventListener('click', async () => {
  if (!pendingWrite) {
    setStatus(loggerStatus, 'No previewed workout to approve. Run a preview first.', 'error');
    return;
  }

  const approveBtn = document.getElementById('approve-btn');
  approveBtn.disabled = true;
  approveBtn.textContent = 'Writing to Sheets…';

  try {
    if (pendingWrite.mode === 'screenshot') {
      await submitCompleteWorkout({ ...pendingWrite, testMode: false });
    } else {
      const realPayload = { ...pendingWrite.payload };
      delete realPayload.test_mode;
      await api('/api/log-workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(realPayload)
      });
    }
    invalidatePreview();
    document.getElementById('logger-form').reset();
    setsTableBody.innerHTML = '';
    parsedRowsEditor.hidden = true;
    lastParsedWorkoutText = '';
    lastParserStatus = null;
    setDefaultDate();
    setStatus(loggerStatus, 'Workout written to Google Sheets. ✓', 'ok');
    loadDashboard();
  } catch (err) {
    setStatus(loggerStatus, `Write failed: ${err.message}`, 'error');
    approveBtn.disabled = false;
    approveBtn.textContent = 'Write to Google Sheets';
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
    const content = document.getElementById('bw-preview-content');
    content.innerHTML = '';
    content.appendChild(el('div', { class: 'no-write-proof' }, [
      el('span', { class: 'proof-headline', text: 'DRY-RUN — NOTHING WAS WRITTEN' }),
      el('span', { class: 'proof-fields', text: `test_mode: ${data.test_mode}  ·  sheet_written: ${data.sheet_written}  ·  no_write_confirmed: ${data.no_write_confirmed}` })
    ]));
    const entry = data.entry_preview || {};
    content.appendChild(renderTable(
      ['Date', 'Weight', 'Notes'],
      [[entry.date, entry.weight, entry.notes]]
    ));

    pendingBwWrite = { date, weight: Number(weight), notes };
    document.getElementById('bw-preview-panel').hidden = false;
    document.getElementById('bw-approve-btn').disabled = false;
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
  if (!pendingBwWrite) return;
  const approveBtn = document.getElementById('bw-approve-btn');
  const bwStatus = document.getElementById('bw-status');
  approveBtn.disabled = true;
  approveBtn.textContent = 'Writing to Sheets…';
  try {
    await api('/api/bodyweight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingBwWrite)
    });
    bwInvalidate();
    document.getElementById('bw-form').reset();
    document.getElementById('bw-date').value = new Date().toISOString().slice(0, 10);
    setStatus(bwStatus, 'Bodyweight written to Google Sheets. ✓', 'ok');
    loadBwHistory();
  } catch (err) {
    setStatus(bwStatus, `Write failed: ${err.message}`, 'error');
    approveBtn.disabled = false;
    approveBtn.textContent = 'Write to Google Sheets';
  }
});

async function loadBwHistory() {
  const box = document.getElementById('bw-history');
  if (!getApiKey()) {
    box.innerHTML = '<span class="muted">Set your API key in Settings.</span>';
    return;
  }
  try {
    const res = await api('/api/bodyweight/history?days=90');
    const data = res.data || {};
    box.innerHTML = '';
    const entries = data.entries || [];
    if (!entries.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No bodyweight entries in the last 90 days.' }));
      return;
    }
    const trendClass = data.trend === 'up' ? 'up' : data.trend === 'down' ? 'down' : '';
    const trendPill = el('span', { class: `pill ${trendClass}`, text: `trend: ${data.trend}` });
    const latest = data.latest;
    const summary = el('p', {}, [
      document.createTextNode(`Latest: ${latest?.weight ?? '—'}  ·  90-day avg: ${data.average ?? '—'}  `),
      trendPill
    ]);
    box.appendChild(summary);
    box.appendChild(svgLineChart(
      entries.map(e => ({ x: e.date, y: e.weight })),
      { color: '#16a34a', label: 'Bodyweight over time' }
    ));
    box.appendChild(renderTable(
      ['Date', 'Weight', 'Notes'],
      entries.slice().reverse().slice(0, 20).map(e => [e.date, e.weight, e.notes])
    ));
  } catch (err) {
    box.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
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
  await Promise.all([loadBwHistory(), loadPendingExercises()]);
}

/* ===== Init ===== */

function setDefaultDate() {
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('log-date').value = today;
  document.getElementById('bw-date').value = today;
}

setDefaultDate();
checkConnection();
loadDashboard();
loadExerciseDatalist();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    // offline shell is an optional enhancement — the app works without it
  });
}
