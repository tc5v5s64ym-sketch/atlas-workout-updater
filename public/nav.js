/* Atlas shell navigation — decoupled surface router.
 *
 * Design: app.js owns the underlying tab engine (.tab-btn → #tab-*). This file
 * layers the two-surface model (Coach | Progress) on top WITHOUT touching app.js.
 * It navigates by clicking the existing .tab-btn controls and reflects whatever
 * tab becomes active — including app.js's own programmatic switches (startLift,
 * back-to-session) — via a MutationObserver. The trust loop is never touched.
 */

(function () {
  'use strict';

  // Which surface each underlying tab belongs to.
  const TAB_SURFACE = {
    logger: 'coach',
    dashboard: 'progress',
    progress: 'progress',
    history: 'progress',
    body: 'progress',
    settings: 'progress'
  };

  const body = document.body;
  const surfaceButtons = Array.from(document.querySelectorAll('.surface-btn'));
  const subnav = document.getElementById('subnav');

  function tabButton(tab) {
    return document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  }

  function activeTab() {
    const section = document.querySelector('.tab.active');
    if (!section || !section.id) return null;
    return section.id.replace(/^tab-/, '');
  }

  function activateTab(tab) {
    const btn = tabButton(tab);
    if (btn) btn.click();           // routes through app.js's tab engine
  }

  // Reflect the active tab into the surface chrome (segmented control + subnav).
  function sync() {
    const tab = activeTab();
    const surface = TAB_SURFACE[tab] || 'coach';
    body.setAttribute('data-surface', surface);

    for (const btn of surfaceButtons) {
      btn.setAttribute('aria-selected', String(btn.dataset.surface === surface));
    }

    if (subnav) {
      for (const pill of subnav.querySelectorAll('.tab-btn')) {
        if (pill.hasAttribute('hidden')) continue;
        pill.classList.toggle('active', pill.dataset.tab === tab);
      }
    }
  }

  // Segmented control: Coach → logger; Progress → last progress tab or Today.
  for (const btn of surfaceButtons) {
    btn.addEventListener('click', () => {
      const surface = btn.dataset.surface;
      if (surface === 'coach') {
        activateTab('logger');
      } else {
        const current = activeTab();
        if (TAB_SURFACE[current] !== 'progress') activateTab('dashboard');
      }
      sync();
    });
  }

  // Settings gear.
  document.getElementById('open-settings')?.addEventListener('click', () => {
    activateTab('settings');
    sync();
  });

  // Observe class changes on tab sections so app.js's programmatic switches
  // (e.g. startLift → logger, back-to-session → dashboard) update the chrome.
  const observer = new MutationObserver(sync);
  for (const section of document.querySelectorAll('.tab')) {
    observer.observe(section, { attributes: true, attributeFilter: ['class'] });
  }

  /* ===== Suggestion chips ===== */

  const workoutText = document.getElementById('workout-text');

  function go(tab, then) {
    activateTab(tab);
    sync();
    if (typeof then === 'function') requestAnimationFrame(then);
  }

  document.getElementById('suggestion-chips')?.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    switch (chip.dataset.chip) {
      case 'example':
        if (workoutText) {
          workoutText.value = chip.textContent.trim();
          workoutText.focus();
          workoutText.dispatchEvent(new Event('input', { bubbles: true }));
        }
        break;
      case 'train':
        chipAnswerTrain();
        break;
      case 'last':
        chipAnswerLast();
        break;
      case 'report':
        chipAnswerReport();
        break;
    }
  });

  /* ===== Chip answer cards — render Atlas replies inline in #thread-messages ===== */

  function atlasReply(content) {
    const thread = document.getElementById('thread-messages');
    if (!thread) return null;
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-bubble-atlas';
    bubble.appendChild(content);
    thread.appendChild(bubble);
    requestAnimationFrame(() => bubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    return bubble;
  }

  function chipAnswerTrain() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<span class="chip-loading">Loading today’s pick…</span>';
    const bubble = atlasReply(wrap);
    if (!bubble) { go('dashboard', () => document.getElementById('intent-grid-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); return; }

    api('/api/plan/intent-recommendation').then(res => {
      const data = res.data || {};
      const todaysRead = data.todays_read || {};
      const patterns = todaysRead.patterns || [];
      wrap.innerHTML = '';

      const titleEl = document.createElement('div');
      titleEl.className = 'chip-reply-title';
      titleEl.textContent = todaysRead.recommended_label
        ? `Today: ${todaysRead.recommended_label}`
        : 'No pick yet — log a few sessions.';
      wrap.appendChild(titleEl);

      if (todaysRead.recommended_reason) {
        const reason = document.createElement('div');
        reason.className = 'chip-reply-sub';
        reason.textContent = todaysRead.recommended_reason;
        wrap.appendChild(reason);
      }

      if (patterns.length) {
        const dots = document.createElement('div');
        dots.className = 'chip-dots';
        for (const p of patterns) {
          const dot = document.createElement('span');
          dot.className = `chip-dot pattern-dot-${p.status || 'unknown'}`;
          const label = FRIENDLY_PATTERN_LABELS[p.label || p.pattern] || p.label || p.pattern;
          dot.title = `${label}: ${FRIENDLY_STATUS_WORDS[p.status || 'unknown'] || p.status || '—'}`;
          dots.appendChild(dot);
          const lbl = document.createElement('span');
          lbl.className = 'chip-dot-label';
          lbl.textContent = label;
          dots.appendChild(lbl);
        }
        wrap.appendChild(dots);
      }

      const more = document.createElement('a');
      more.href = '#';
      more.className = 'chip-reply-more';
      more.textContent = 'See full Today tab →';
      more.addEventListener('click', ev => {
        ev.preventDefault();
        go('dashboard', () => document.getElementById('intent-grid-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      });
      wrap.appendChild(more);
    }).catch(err => {
      wrap.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
    });
  }

  function chipAnswerLast() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<span class="chip-loading">Loading last session…</span>';
    const bubble = atlasReply(wrap);
    if (!bubble) { go('history', () => document.getElementById('load-sessions-btn')?.click()); return; }

    api('/api/history/recent?limit=5&exclude_test=true').then(res => {
      const sets = res.data?.recent_sets || [];
      wrap.innerHTML = '';

      if (!sets.length) {
        wrap.innerHTML = '<span class="muted">No sessions logged yet.</span>';
        return;
      }

      const firstDate = sets[0].date_clean || '';
      const firstSession = sets[0].session_id || '';
      const titleEl = document.createElement('div');
      titleEl.className = 'chip-reply-title';
      titleEl.textContent = `Last session · ${firstDate}${firstSession ? ' · ' + firstSession : ''}`;
      wrap.appendChild(titleEl);

      const sessionSets = firstSession
        ? sets.filter(s => s.session_id === firstSession)
        : sets;

      // Group by exercise
      const byEx = [];
      const seen = new Map();
      for (const s of sessionSets) {
        if (!seen.has(s.exercise)) { seen.set(s.exercise, []); byEx.push(s.exercise); }
        seen.get(s.exercise).push(s);
      }
      for (const ex of byEx) {
        const exSets = seen.get(ex);
        const row = document.createElement('div');
        row.className = 'chip-reply-row';
        const setBits = exSets.map(s => `${s.weight}×${s.reps}${s.rir != null ? '/' + s.rir : ''}`).join(', ');
        row.textContent = `${ex}: ${setBits}`;
        wrap.appendChild(row);
      }

      const more = document.createElement('a');
      more.href = '#';
      more.className = 'chip-reply-more';
      more.textContent = 'Full history →';
      more.addEventListener('click', ev => {
        ev.preventDefault();
        go('history', () => document.getElementById('load-sessions-btn')?.click());
      });
      wrap.appendChild(more);
    }).catch(err => {
      wrap.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
    });
  }

  function chipAnswerReport() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<span class="chip-loading">Loading weekly report…</span>';
    const bubble = atlasReply(wrap);
    if (!bubble) { go('progress', () => document.getElementById('weekly-report-btn')?.click()); return; }

    api('/api/summary/weekly').then(res => {
      const data = res.data || {};
      const highlights = data.highlights || [];
      wrap.innerHTML = '';

      const titleEl = document.createElement('div');
      titleEl.className = 'chip-reply-title';
      titleEl.textContent = 'This week';
      wrap.appendChild(titleEl);

      if (!highlights.length) {
        wrap.innerHTML += '<span class="muted">No training logged in the last 7 days.</span>';
      } else {
        const ul = document.createElement('ul');
        ul.className = 'chip-reply-list';
        for (const h of highlights) {
          const li = document.createElement('li');
          li.textContent = h;
          ul.appendChild(li);
        }
        wrap.appendChild(ul);
      }

      const more = document.createElement('a');
      more.href = '#';
      more.className = 'chip-reply-more';
      more.textContent = 'Full report →';
      more.addEventListener('click', ev => {
        ev.preventDefault();
        go('progress', () => document.getElementById('weekly-report-btn')?.click());
      });
      wrap.appendChild(more);
    }).catch(err => {
      wrap.innerHTML = `<span class="muted">Could not load: ${err.message}</span>`;
    });
  }

  /* ===== Composer "+" attachment menu ===== */

  const attachBtn = document.getElementById('composer-attach');
  const attachMenu = document.getElementById('attach-menu');

  function closeAttachMenu() {
    if (!attachMenu) return;
    attachMenu.hidden = true;
    attachBtn?.setAttribute('aria-expanded', 'false');
  }

  attachBtn?.addEventListener('click', e => {
    e.stopPropagation();
    if (!attachMenu) return;
    const open = attachMenu.hidden;
    attachMenu.hidden = !open;
    attachBtn.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', e => {
    if (attachMenu && !attachMenu.hidden && !attachMenu.contains(e.target) && e.target !== attachBtn) {
      closeAttachMenu();
    }
  });

  function setEffortMode(mode) {
    const radio = document.querySelector(`input[name="effort-mode"][value="${mode}"]`);
    if (radio && !radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Reveal the effort block (hidden by CSS, not by the hidden attribute) and
    // open the <details> so the fields are visible.
    const details = document.getElementById('effort-details');
    if (details) {
      details.classList.add('effort-open');
      details.open = true;
    }
  }

  // "+" → Apple Watch screenshot: flips the existing effort flow to screenshot
  // mode and opens the native file picker. Manual entry: focuses the duration.
  document.getElementById('attach-screenshot')?.addEventListener('click', () => {
    closeAttachMenu();
    setEffortMode('screenshot');
    document.getElementById('effort-image')?.click();
  });

  document.getElementById('attach-manual')?.addEventListener('click', () => {
    closeAttachMenu();
    setEffortMode('manual');
    document.getElementById('effort-details')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('effort-duration')?.focus();
  });

  // "+" → Fix a past session: un-hide #logger-details, open the load-session
  // <details>, scroll to it, and focus the session ID input.
  document.getElementById('attach-fix-session')?.addEventListener('click', () => {
    closeAttachMenu();
    const loggerDetails = document.getElementById('logger-details');
    if (loggerDetails) {
      loggerDetails.hidden = false;
      const loadSessionDetails = loggerDetails.querySelector('.load-session-details');
      if (loadSessionDetails) {
        loadSessionDetails.open = true;
        requestAnimationFrame(() => {
          loadSessionDetails.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          document.getElementById('load-session-id')?.focus();
        });
      }
    }
  });

  // Chat-first screenshot: picking a file is the "send" gesture. The moment a
  // screenshot is chosen we fire the existing preview flow automatically — no
  // separate Preview tap. app.js still owns the dry-run + approval gate.
  const effortImage = document.getElementById('effort-image');
  effortImage?.addEventListener('change', () => {
    if (!effortImage.files || !effortImage.files.length) return;
    const screenshotMode = document.querySelector('input[name="effort-mode"]:checked')?.value === 'screenshot';
    if (!screenshotMode) return;
    closeAttachMenu();
    // rAF so chat.js can paint the attachment bubble before the request fires.
    requestAnimationFrame(() => {
      document.getElementById('logger-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  });

  /* ===== "Edited since preview" nudge ===== */
  // When the user edits the textarea while the preview panel is visible, remind
  // them to re-preview before approving. A single <p> in #logger-status carries
  // the message; it is removed as soon as the form is submitted (new preview).
  // app.js's approval gating is not changed — this is purely informational.

  const EDITED_MSG_ID = 'edited-since-preview-msg';

  function showEditedNudge() {
    const loggerStatus = document.getElementById('logger-status');
    const previewPanel = document.getElementById('preview-panel');
    if (!loggerStatus || !previewPanel || previewPanel.hidden) return;
    if (document.getElementById(EDITED_MSG_ID)) return;    // already shown
    const p = document.createElement('p');
    p.id = EDITED_MSG_ID;
    p.className = 'edited-since-preview';
    p.textContent = 'Edited since preview — preview again to save.';
    loggerStatus.prepend(p);
  }

  function clearEditedNudge() {
    document.getElementById(EDITED_MSG_ID)?.remove();
  }

  document.getElementById('workout-text')?.addEventListener('input', showEditedNudge);

  // Remove the nudge on form submit (new preview wipes the old state)
  document.getElementById('logger-form')?.addEventListener('submit', clearEditedNudge);

  /* ===== Time-of-day greeting ===== */

  const greeting = document.getElementById('coach-greeting');
  if (greeting) {
    const h = new Date().getHours();
    const part = h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
    greeting.textContent = `${part}. Ready when you are.`;
  }

  // Initial chrome sync.
  sync();
})();
