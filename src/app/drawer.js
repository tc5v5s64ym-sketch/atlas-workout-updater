/* Atlas Coach side panel (drawer).
 *
 * Opened from #coach-menu-btn. A read-only navigation surface: a readiness
 * ticker, the Views list (Coach / Today / Trends / History / Body), and recent
 * sessions. It NEVER navigates by itself — every row clicks the existing
 * .tab-btn controls, so app.js's tab engine + nav.js's surface router stay the
 * single source of truth and the preview/approve/write trust loop is untouched.
 *
 * Reuses app.js globals: api, isConnected, FRIENDLY_PATTERN_LABELS,
 * FRIENDLY_STATUS_WORDS.
 */
(function () {
  'use strict';

  const menuBtn = document.getElementById('coach-menu-btn');
  const drawer = document.getElementById('coach-drawer');
  const backdrop = document.getElementById('coach-drawer-backdrop');
  if (!menuBtn || !drawer || !backdrop) return;

  const closeBtn = document.getElementById('coach-drawer-close');

  /* ===== Open / close ===== */

  let loaded = false;

  function open() {
    drawer.classList.add('on');
    backdrop.classList.add('on');
    drawer.setAttribute('aria-hidden', 'false');
    syncActiveRow();
    if (!loaded) { loaded = true; loadData(); }
  }

  function close() {
    drawer.classList.remove('on');
    backdrop.classList.remove('on');
    drawer.setAttribute('aria-hidden', 'true');
  }

  menuBtn.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drawer.classList.contains('on')) close();
  });

  /* ===== Navigation — delegate to the existing tab engine ===== */

  function activateTab(tab) {
    document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.click();
  }

  // Any element inside the drawer carrying data-tab navigates there and closes.
  drawer.addEventListener('click', e => {
    const target = e.target.closest('[data-tab]');
    if (!target || !drawer.contains(target)) return;
    const tab = target.dataset.tab;
    close();
    if (tab) requestAnimationFrame(() => activateTab(tab));
  });

  // Recent-session rows route to History (read-only).
  function recentRowTo() { return 'history'; }

  // Reflect the current active tab as the highlighted Views row.
  function activeTabName() {
    const section = document.querySelector('.tab.active');
    return section && section.id ? section.id.replace(/^tab-/, '') : null;
  }
  function syncActiveRow() {
    const active = activeTabName();
    for (const row of drawer.querySelectorAll('.drawer-nav-row')) {
      row.classList.toggle('active', row.dataset.tab === active);
    }
  }

  /* ===== Live data (read-only; reuses endpoints already in use) ===== */

  function labelFor(p) {
    const labels = (typeof FRIENDLY_PATTERN_LABELS !== 'undefined') ? FRIENDLY_PATTERN_LABELS : {};
    return labels[p.label || p.pattern] || p.label || p.pattern || '';
  }
  function statusWord(p) {
    const words = (typeof FRIENDLY_STATUS_WORDS !== 'undefined') ? FRIENDLY_STATUS_WORDS : {};
    return words[p.status] || p.status || '';
  }

  // Higher = more recovered / ready. Drives bar width + dot colour. Ember marks
  // the patterns that still need work; green marks the ready ones.
  const READINESS = {
    fresh:      { w: 100, ok: true },
    ready:      { w: 72,  ok: true },
    recovered:  { w: 84,  ok: true },
    recovering: { w: 50,  ok: false },
    fatigued:   { w: 38,  ok: false },
    unknown:    { w: 16,  ok: null }
  };

  function renderTicker(patterns) {
    const wrap = document.getElementById('drawer-pats');
    if (!wrap) return;
    wrap.textContent = '';
    const list = (patterns || []).slice(0, 5);
    if (!list.length) { wrap.innerHTML = '<span class="muted small">No readiness data yet.</span>'; return; }
    for (const p of list) {
      const meta = READINESS[p.status] || READINESS.unknown;
      const cls = meta.ok === true ? 'ok' : (meta.ok === false ? 'ember' : 'faint');
      const pat = document.createElement('span');
      pat.className = 'drawer-pat';

      const dot = document.createElement('span');
      dot.className = `drawer-pdot drawer-c-${cls}`;
      const lbl = document.createElement('span');
      lbl.className = 'drawer-pl';
      lbl.textContent = labelFor(p);
      const bar = document.createElement('span');
      bar.className = 'drawer-bar';
      const fill = document.createElement('i');
      fill.className = `drawer-c-${cls}`;
      fill.style.width = `${meta.w}%`;          // CSSOM, not inline style="" — CSP-safe
      bar.appendChild(fill);

      pat.title = `${labelFor(p)}: ${statusWord(p) || '—'}`;
      pat.appendChild(dot);
      pat.appendChild(lbl);
      pat.appendChild(bar);
      wrap.appendChild(pat);
    }
  }

  function setSub(tab, text) {
    if (!text) return;
    const row = drawer.querySelector(`.drawer-nav-row[data-tab="${tab}"] .drawer-nav-ht`);
    if (row) row.textContent = text;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return iso;
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    return `${months[Number(m[2]) - 1] || ''} ${Number(m[3])}`;
  }

  function renderRecent(sessions) {
    const box = document.getElementById('drawer-recent');
    if (!box) return;
    box.textContent = '';
    const list = (sessions || []).slice(0, 6);
    if (!list.length) { box.innerHTML = '<span class="muted small">No sessions logged yet.</span>'; return; }
    for (const s of list) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'drawer-rrow';
      row.dataset.tab = recentRowTo();
      const d = document.createElement('span');
      d.className = 'drawer-rd';
      d.textContent = fmtDate(s.date);
      const n = document.createElement('span');
      n.className = 'drawer-rn';
      const first = Array.isArray(s.exercises) && s.exercises.length ? s.exercises[0] : 'Session';
      const sets = s.sets_count != null ? ` · ${s.sets_count} sets` : '';
      n.textContent = `${first}${sets}`;
      row.appendChild(d);
      row.appendChild(n);
      box.appendChild(row);
    }
  }

  function withinLastWeek(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return false;
    return (Date.now() - t) <= 7 * 24 * 60 * 60 * 1000;
  }

  function loadData() {
    if (typeof api !== 'function' || (typeof isConnected === 'function' && !isConnected())) return;

    api('/api/plan/intent-recommendation').then(res => {
      const read = (res.data && res.data.todays_read) || {};
      renderTicker(read.patterns);
      if (read.recommended_label) {
        const status = read.recommended_reason ? '' : '';
        setSub('dashboard', status ? `${read.recommended_label} · ${status}` : read.recommended_label);
      }
    }).catch(() => {});

    api('/api/sessions/recent?limit=6').then(res => {
      const sessions = (res.data && res.data.sessions) || [];
      renderRecent(sessions);
      const thisWeek = sessions.filter(s => withinLastWeek(s.date)).length;
      if (thisWeek) setSub('history', `${thisWeek} session${thisWeek === 1 ? '' : 's'} this week`);
    }).catch(() => {});
  }
})();
