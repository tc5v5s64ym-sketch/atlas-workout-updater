'use strict';
// Atlas frontend — settingsHealth module (PR-09b mechanical extraction from app.js).
import { api } from './api.js';

export async function checkConnection() {
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

export function setBoxSpan(box, className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  box.replaceChildren(span);
}

export async function runHealthCheck(endpoint, label, resultBox) {
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
