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
        go('dashboard', () => document.getElementById('intent-grid-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        break;
      case 'last':
        go('history', () => document.getElementById('load-sessions-btn')?.click());
        break;
      case 'report':
        go('progress', () => document.getElementById('weekly-report-btn')?.click());
        break;
    }
  });

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
    const details = document.getElementById('effort-details');
    if (details) details.open = true;
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
