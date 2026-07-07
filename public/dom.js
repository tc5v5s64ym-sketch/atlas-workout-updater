'use strict';
// Atlas frontend — dom module (PR-09b mechanical extraction from app.js).
import { api, getApiKey } from './api.js';

export function el(tag, attrs = {}, children = []) {
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

export function renderTable(headers, rows) {
  const thead = el('thead', {}, el('tr', {}, headers.map(h => el('th', { text: h }))));
  const tbody = el('tbody', {}, rows.map(row =>
    el('tr', {}, row.map(cell => el('td', { text: cell === null || cell === undefined ? '' : String(cell) })))
  ));
  return el('table', {}, [thead, tbody]);
}

export function setStatus(container, message, kind) {
  container.innerHTML = '';
  if (message) container.appendChild(el('div', { class: `status-msg ${kind}`, text: message }));
}

// "Session quality: X / 100" with a tappable circled-i that reveals the
// weighted breakdown. Each criterion shows earned / max points and a
// session-specific description (e.g. "14 sets — solid session").
export function buildQualityRow(score, breakdown) {
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

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

export function svgLineChart(points, { width = 420, height = 140, color = '#2563eb', label = '' } = {}) {
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

export function svgBarChart(entries, { width = 420, barHeight = 20, gap = 6, color = '#2563eb', label = '' } = {}) {
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

export async function loadExerciseDatalist() {
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
