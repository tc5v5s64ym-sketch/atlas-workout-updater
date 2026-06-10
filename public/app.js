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

/* ===== Tabs ===== */

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'dashboard') loadDashboard();
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
    for (const id of ['weekly-summary', 'recent-history', 'recent-prs', 'stalls']) {
      document.getElementById(id).innerHTML = '<span class="muted">Set your API key in Settings to load data.</span>';
    }
    return;
  }

  loadWeeklySummary();
  loadRecentHistory();
  loadRecentPrs();
  loadStalls();
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
    box.appendChild(renderTable(
      ['Lift', 'Sessions stalled', 'Last best weight', 'Since'],
      stalls.map(s => [s.liftCode, s.sessions_stalled, s.last_best_weight, s.first_session_date])
    ));
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
    recBox.appendChild(el('p', { text: data.recommendation || '' }));
    recBox.appendChild(el('p', { class: 'muted', text: data.reasoning || '' }));
  } catch (err) {
    recBox.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
  }
});

/* ===== Workout logger (approve-before-save) ===== */

const setsTableBody = document.querySelector('#sets-table tbody');
const previewPanel = document.getElementById('preview-panel');
const previewContent = document.getElementById('preview-content');
const loggerStatus = document.getElementById('logger-status');

// Pending approval state. Set only after a successful dry-run preview;
// cleared whenever the form changes so stale previews can never be approved.
let pendingWrite = null;

function addSetRow(values = {}) {
  const row = el('tr', {}, [
    el('td', {}, el('input', { type: 'text', class: 'set-exercise', value: values.exercise || '', placeholder: 'Bench Press' })),
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
}

document.getElementById('add-set-btn').addEventListener('click', () => addSetRow());

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
}

document.getElementById('logger-form').addEventListener('input', invalidatePreview);

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
  const logRows = collectLogRows(sessionId, date);

  if (!logRows.length) {
    setStatus(loggerStatus, 'Add at least one set with an exercise name.', 'error');
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
      pendingWrite = { mode: 'manual', payload };
      renderLogWorkoutPreview(result, effortRow);
    }
    previewPanel.hidden = false;
  } catch (err) {
    setStatus(loggerStatus, `Preview failed: ${err.message}`, 'error');
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = 'Preview (dry-run)';
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

function renderLogWorkoutPreview(result, effortRow) {
  const data = result.data || {};
  previewContent.innerHTML = '';
  previewContent.appendChild(el('div', { class: 'preview-ok', text: `Dry-run confirmed: nothing was written (sheet_write: ${data.sheet_write}).` }));
  previewContent.appendChild(renderWarnings(data.warnings));
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
  previewContent.appendChild(el('div', {
    class: 'preview-ok',
    text: `Dry-run confirmed: test_mode=${data.test_mode}, sheet_written=${data.sheet_written}, no_write_confirmed=${data.no_write_confirmed}.`
  }));
  previewContent.appendChild(renderWarnings(outer.warnings));

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
  approveBtn.textContent = 'Saving…';

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
    addSetRow();
    setDefaultDate();
    setStatus(loggerStatus, 'Workout saved. ✓', 'ok');
    loadDashboard();
  } catch (err) {
    setStatus(loggerStatus, `Save failed: ${err.message}`, 'error');
  } finally {
    approveBtn.disabled = false;
    approveBtn.textContent = 'Approve & Save';
  }
});

/* ===== Init ===== */

function setDefaultDate() {
  document.getElementById('log-date').value = new Date().toISOString().slice(0, 10);
}

addSetRow();
setDefaultDate();
checkConnection();
loadDashboard();
