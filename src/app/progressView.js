'use strict';
// Atlas frontend — progressView module (PR-09b mechanical extraction from app.js).
import { api, getApiKey } from './api.js';
import { formatSetLoad } from './app.js';
import { el, renderTable, svgLineChart } from './dom.js';

// Cache the lift list so repeated tab visits don't re-fetch until a new session.
export let liftListCache = null;

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

export function renderTrends(frame) {
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

export async function loadProgressLiftList() {
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

export async function openLiftDrillDown(exerciseName, liftCode) {
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
