/* Atlas shell navigation — decoupled surface router.
 *
 * Design: app.js owns the underlying tab engine (.tab-btn → #tab-*). This file
 * derives the two-surface model (coach | progress) from whichever tab is
 * active WITHOUT touching app.js — including app.js's own programmatic
 * switches (startLift, back-to-session) — via a MutationObserver, and writes
 * it to body[data-surface] for the chrome CSS. The Coach|Progress segmented
 * control was retired in Phase D (2026-07-03, owner-approved): the hamburger
 * drawer and the Progress subnav are the navigation. The trust loop is never
 * touched.
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

  // Reflect the active tab into the surface chrome (body[data-surface] + subnav).
  function sync() {
    const tab = activeTab();
    const surface = TAB_SURFACE[tab] || 'coach';
    body.setAttribute('data-surface', surface);

    if (subnav) {
      for (const pill of subnav.querySelectorAll('.tab-btn')) {
        if (pill.hasAttribute('hidden')) continue;
        const active = pill.dataset.tab === tab;
        pill.classList.toggle('active', active);
        pill.setAttribute('aria-selected', String(active));
        pill.tabIndex = active ? 0 : -1;           // roving tabindex
      }
    }
  }

  // Roving keyboard navigation for the Progress subnav tablist. Arrow / Home /
  // End move focus and activate via the existing click paths, so app.js's tab
  // engine and the surface router stay the single source of truth — this layer
  // only adds keyboard reach, it never writes.
  function wireTablistKeys(tabs) {
    tabs.forEach((tabEl, i) => {
      tabEl.addEventListener('keydown', e => {
        let next = -1;
        switch (e.key) {
          case 'ArrowRight': case 'ArrowDown': next = (i + 1) % tabs.length; break;
          case 'ArrowLeft':  case 'ArrowUp':   next = (i - 1 + tabs.length) % tabs.length; break;
          case 'Home': next = 0; break;
          case 'End':  next = tabs.length - 1; break;
          default: return;
        }
        e.preventDefault();
        const target = tabs[next];
        target.focus();
        target.click();   // route through the surface router / app.js tab engine
      });
    });
  }

  if (subnav) {
    wireTablistKeys(Array.from(subnav.querySelectorAll('.tab-btn')).filter(b => !b.hasAttribute('hidden')));
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

  // eslint-disable-next-line no-unused-vars -- DOM element captured; referenced via closure in sibling scripts; Phase 1 PR-08/09
  const workoutText = document.getElementById('workout-text');

  function go(tab, then) {
    activateTab(tab);
    sync();
    if (typeof then === 'function') requestAnimationFrame(then);
  }

  // The static #suggestion-chips strip was retired (composer-first Phase A,
  // 2026-07-02); the hero's learn chips and their chipAnswerAsk handler were
  // retired with the home-screen tiles (owner directive, 2026-07-03) — typed
  // questions reach the same SME layer through the composer's SME-first chat
  // route (coach-conversation.js getChatReply → /api/coach/ask). The surviving
  // handlers: chipAnswerLast + chipAnswerReport are the in-thread ARTIFACT
  // renderers (exported below; app.js's deterministic artifact route calls
  // them for "show my last session" / "weekly report" asks).

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

  function chipAnswerLast() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<span class="chip-loading">Loading last session…</span>';
    const bubble = atlasReply(wrap);
    if (!bubble) { go('history', () => window.atlasRefreshSessions?.()); return; }

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
        // Bodyweight sets (weight null/''/0) read as reps, never "0×20" — same
        // rule as coach-conversation.js hasLoad (owner live find 2026-07-03).
        const setBits = exSets.map(s => {
          const load = (s.weight != null && s.weight !== '' && Number(s.weight) !== 0) ? `${s.weight}×${s.reps}` : `${s.reps} reps`;
          return `${load}${s.rir != null ? '/' + s.rir : ''}`;
        }).join(', ');
        row.textContent = `${ex}: ${setBits}`;
        wrap.appendChild(row);
      }

      const more = document.createElement('a');
      more.href = '#';
      more.className = 'chip-reply-more';
      more.textContent = 'Full history →';
      more.addEventListener('click', ev => {
        ev.preventDefault();
        go('history', () => window.atlasRefreshSessions?.());
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

  // The in-thread artifact renderers (composer-first Phase B2). app.js's
  // deterministic artifact route calls these for digit-free "show me…" asks;
  // both are READ-ONLY renders of existing endpoints.
  window.atlasChipAnswerLast = chipAnswerLast;
  window.atlasChipAnswerReport = chipAnswerReport;

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

  function setEffortMode(mode, { reveal = true } = {}) {
    const radio = document.querySelector(`input[name="effort-mode"][value="${mode}"]`);
    if (radio && !radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (!reveal) return;
    const details = document.getElementById('effort-details');
    if (details) {
      details.hidden = false;
      details.open = true;
    }
  }

  // "+" → Apple Watch screenshot: flips the existing effort flow to screenshot
  // mode and opens the native file picker. Manual entry: focuses the duration.
  document.getElementById('attach-screenshot')?.addEventListener('click', () => {
    closeAttachMenu();
    setEffortMode('screenshot', { reveal: false });
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

  /* ===== Composer auto-grow ===== */
  // One line at rest; grows with content up to the CSS max-height (200px), then
  // scrolls. Height tracks scrollHeight (content), NOT flex distribution, so it
  // stays stable when the hero hides, a coaching message types, or the thread
  // fills — no shrink/grow twitch. style.height via CSSOM is CSP-safe.
  const COMPOSER_MAX_H = 200;
  const composerTextarea = document.getElementById('workout-text');

  function growComposer() {
    if (!composerTextarea) return;
    composerTextarea.style.height = 'auto';
    composerTextarea.style.height = Math.min(composerTextarea.scrollHeight, COMPOSER_MAX_H) + 'px';
  }

  if (composerTextarea) {
    // Covers typing and the chips' programmatic input dispatch.
    composerTextarea.addEventListener('input', growComposer);
    // The submit handler clears the value on a later tick; shrink back after it.
    document.getElementById('logger-form')?.addEventListener('submit', () => setTimeout(growComposer, 0));
    growComposer(); // initial one-line sizing
  }

  /* ===== Composer placeholder rotation ===== */
  // Cycle a few example prompts through the EMPTY composer to teach the input
  // formats (slash notation, "log it") and surface that you can just ask a
  // question. Purely the placeholder attribute — never the value, so it can't
  // affect parsing, height, or the trust loop. Pauses while the box is focused
  // or has text so it never shifts under the user, and honours reduced motion.
  if (composerTextarea) {
    const PLACEHOLDER_HINTS = [
      'Log a set or ask anything…',
      'Try: Bench 225 5/2 5/2',
      'Ask: what should I train today?',
      "Ask: how's my recovery?",
      'Say “log it” to save your session'
    ];
    composerTextarea.placeholder = PLACEHOLDER_HINTS[0];
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion) {
      let hintIndex = 0;
      let hintPaused = false;
      let sessionActive = false;
      composerTextarea.addEventListener('focus', () => { hintPaused = true; });
      composerTextarea.addEventListener('blur', () => { hintPaused = false; });
      // Once logging begins, stop cycling generic home hints so coach-conversation.js
      // can own the placeholder (pointing at the next exercise). Pre-session rotation
      // is unaffected — sessionActive starts false.
      document.addEventListener('atlas:set-logged', () => { sessionActive = true; });
      // Step 382 (#402B): a suggested workout — or any coach-owned placeholder —
      // also stops the generic rotation, so the save-ready "Say 'log it' to save
      // your session" hint never overwrites the suggestion placeholder before any
      // set has been performed. coach-conversation.js fires this from
      // setWorkoutPlaceholder.
      document.addEventListener('atlas:placeholder-owned', () => { sessionActive = true; });
      document.addEventListener('atlas:session-reset', () => {
        sessionActive = false;
        if (!hintPaused && !composerTextarea.value) {
          hintIndex = 0;
          composerTextarea.placeholder = PLACEHOLDER_HINTS[hintIndex];
        }
      });
      setInterval(() => {
        if (hintPaused || composerTextarea.value || sessionActive) return;
        hintIndex = (hintIndex + 1) % PLACEHOLDER_HINTS.length;
        composerTextarea.placeholder = PLACEHOLDER_HINTS[hintIndex];
      }, 4500);
    }
  }

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
