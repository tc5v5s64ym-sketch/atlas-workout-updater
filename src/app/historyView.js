'use strict';
// Atlas frontend — historyView module (PR-09b mechanical extraction from app.js).
import { getHistoryLoaded, setHistoryLoaded } from './store.js';
import { api } from './api.js';
import { formatSetLoad, getLocalDateString } from './app.js';
import { buildQualityRow, el } from './dom.js';

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

export async function loadSessions() {
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

export function loadHistory() {
  if (getHistoryLoaded()) return;
  setHistoryLoaded(true);
  loadSessions();
}
