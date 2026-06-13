/* Atlas Coach — conversation layer.
 *
 * Turns the Coach home into a chat: the "Suggested Workout" tile makes Atlas
 * type out today's session, and each logged exercise gets a typed coaching note
 * with an inline "Save to Sheets" confirm.
 *
 * THE TRUST LOOP IS NEVER TOUCHED. This file only narrates. It never writes:
 *   - "Save to Sheets" just clicks the existing #approve-btn (app.js owns the
 *     dry-run preview + approval gate + write, unchanged).
 *   - It reacts to the read-only atlas:preview-ready event app.js dispatches
 *       atlas:preview-ready  { rows, liftCodes, effortOnly }   (after a preview)
 *     and mirrors #logger-status (the post-write card) onto the inline Save btn.
 *
 * Coaching voice seam: getCoachingMessage(facts) turns Atlas's deterministic
 * *facts* into the coach's *voice* via /api/coach/message (Gemini), falling back
 * to a deterministic templated note whenever the LLM is unconfigured, slow, or
 * errors. The engine owns the numbers; the voice only words them.
 *
 * Reuses app.js globals (top-level fns): api, getApiKey, fetchReaction,
 * previewSetsForLift, normalizePlanExercise.
 * Reuses nav.js: window.atlasChipAnswerLast.
 */

(function () {
  'use strict';

  /* ===== Typewriter ===== */

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Reveal `text` word-by-word into `target` with a blinking cursor. Newlines
  // and "* " bullets survive because the chat bubble is white-space: pre-wrap.
  // Resolves when done. Reduced-motion renders instantly.
  function typeOut(target, text, { speed = 22 } = {}) {
    return new Promise(resolve => {
      target.textContent = '';
      if (!text) { resolve(); return; }
      if (prefersReducedMotion()) { target.textContent = text; softScroll(target); resolve(); return; }

      const cursor = document.createElement('span');
      cursor.className = 'typing-cursor';
      cursor.setAttribute('aria-hidden', 'true');
      target.appendChild(cursor);

      const tokens = text.match(/\S+\s*/g) || [text];
      let i = 0;
      function step() {
        cursor.insertAdjacentText('beforebegin', tokens[i]);
        i += 1;
        if (i % 4 === 0) softScroll(target);
        if (i < tokens.length) {
          setTimeout(step, speed);
        } else {
          cursor.remove();
          softScroll(target);
          resolve();
        }
      }
      step();
    });
  }

  function softScroll(node) {
    try { node.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch { /* noop */ }
  }

  /* ===== Bubbles + empty state ===== */

  function hideHomeEmpty() {
    document.getElementById('coach-empty')?.setAttribute('hidden', '');
    document.getElementById('suggested-tiles')?.setAttribute('hidden', '');
  }

  // Append an empty Atlas bubble and return { bubble, body } so the caller can
  // type into `body` and still attach controls (Save button) to `bubble`.
  function appendAtlasBubble() {
    const thread = document.getElementById('thread-messages');
    if (!thread) return null;
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-bubble-atlas';
    const body = document.createElement('div');
    body.className = 'coach-msg';
    bubble.appendChild(body);
    thread.appendChild(bubble);
    hideHomeEmpty();
    requestAnimationFrame(() => softScroll(bubble));
    return { bubble, body };
  }

  /* ===== Inline "Save to Sheets" (mirrors the existing #approve-btn) ===== */

  let currentSaveBtn = null;
  const approveBtn = document.getElementById('approve-btn');

  // The approval gate lives in app.js: #approve-btn is only enabled once a
  // dry-run preview has proven no-write safety. Mirror its disabled state onto
  // the inline button so Save can never write before the gate allows it.
  if (approveBtn) {
    new MutationObserver(() => {
      if (currentSaveBtn && !currentSaveBtn.dataset.done) currentSaveBtn.disabled = approveBtn.disabled;
    }).observe(approveBtn, { attributes: true, attributeFilter: ['disabled'] });
  }

  function appendInlineSave(bubble) {
    const note = document.createElement('div');
    note.className = 'atlas-reply-gate';
    note.textContent = 'Nothing saved yet — this only writes to Google Sheets when you tap Save.';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'save-inline-btn';
    btn.textContent = 'Save to Sheets';
    btn.disabled = approveBtn ? approveBtn.disabled : true;
    btn.addEventListener('click', () => {
      if (!approveBtn || approveBtn.disabled) return;
      approveBtn.click();               // reuse the existing, unchanged write path
      btn.textContent = 'Saving…';
      btn.disabled = true;
    });

    currentSaveBtn = btn;
    bubble.appendChild(note);
    bubble.appendChild(btn);
  }

  function markSaved() {
    if (!currentSaveBtn) return;
    currentSaveBtn.textContent = 'Saved ✓';
    currentSaveBtn.disabled = true;
    currentSaveBtn.dataset.done = '1';
    currentSaveBtn = null;
  }

  function resetSaveAfterError() {
    if (!currentSaveBtn || currentSaveBtn.dataset.done) return;
    currentSaveBtn.textContent = 'Save to Sheets';
    currentSaveBtn.disabled = approveBtn ? approveBtn.disabled : false;
  }

  // app.js writes the result into #logger-status: a `.status-msg.ok` card on a
  // successful write, `.status-msg.error` on failure. Mirror that onto the
  // inline Save button — no event plumbing, no change to the approve handler.
  const loggerStatusEl = document.getElementById('logger-status');
  if (loggerStatusEl) {
    new MutationObserver(() => {
      if (!currentSaveBtn || currentSaveBtn.dataset.done) return;
      if (loggerStatusEl.querySelector('.status-msg.ok')) markSaved();
      else if (loggerStatusEl.querySelector('.status-msg.error')) resetSaveAfterError();
    }).observe(loggerStatusEl, { childList: true, subtree: true });
  }

  /* ===== Suggested-workout message (templated) ===== */

  function getSuggestedWorkoutMessage(data) {
    const read = (data && data.todays_read) || {};
    const intents = (data && data.intents) || [];
    const rec = intents.find(i => i.recommended) || intents[0] || null;
    const label = read.recommended_label || (rec && rec.label) || null;
    const exercises = (rec && rec.exercises) || [];

    // New user / no history yet — bootstrap with a safe baseline message rather
    // than inventing numbers. (The LLM onboarding layer is a later PR.)
    if (!label && !exercises.length) {
      return [
        "I don't have enough history yet to tailor your session.",
        '',
        "Start light and establish baselines — something like:",
        '* Squat or Leg Press — 3 × 8–10 @ RIR 3',
        '* Bench Press — 3 × 8–10 @ RIR 3',
        '* Row — 3 × 10–12 @ RIR 2–3',
        '* Lat Pulldown — 2–3 × 10–12 @ RIR 2–3',
        '',
        "Log a few sessions and I'll start calling the shots from your own numbers."
      ].join('\n');
    }

    const lines = [];
    lines.push(label ? `Today's read: ${label}.` : "Here's a solid session for today.");
    const reason = read.recommended_reason || (rec && rec.why_today && rec.why_today[0]) || (rec && rec.focus);
    if (reason) lines.push(reason);

    if (exercises.length) {
      lines.push('');
      for (const raw of exercises) {
        const ex = (typeof normalizePlanExercise === 'function') ? normalizePlanExercise(raw) : raw;
        if (!ex || !ex.name) continue;
        const hasTarget = ex.weight != null && ex.reps != null;
        const target = hasTarget ? ` — ${ex.weight} × ${ex.reps}${ex.sets ? ` × ${ex.sets}` : ''}` : '';
        lines.push(`* ${ex.name}${target}`);
      }
      lines.push('');
      lines.push("Log your first sets when you're ready and I'll react as you go.");
    }
    return lines.join('\n');
  }

  async function typeSuggestedWorkout() {
    hideHomeEmpty();
    const handle = appendAtlasBubble();
    if (!handle) return;
    const { body } = handle;

    if (typeof getApiKey === 'function' && !getApiKey()) {
      await typeOut(body, "Set your API key in Settings and I'll suggest today's session.");
      return;
    }
    body.textContent = 'Reading your recent training…';
    try {
      const res = await api('/api/plan/intent-recommendation');
      body.textContent = '';
      await typeOut(body, getSuggestedWorkoutMessage(res.data || {}));
    } catch {
      body.textContent = '';
      await typeOut(body, "I couldn't pull a suggestion just now — but start logging and I'll react as you go.");
    }
  }

  /* ===== Coaching voice — the swappable seam ===== */

  // facts = {
  //   liftCode, exerciseName,
  //   todaySets: [{ weight, reps, rir }],   // what was just previewed
  //   rec,                                   // /api/recommend/next payload (or null)
  // }
  //
  // ── SEAM ──────────────────────────────────────────────────────────────────
  // Atlas's engine produced the facts above (logged sets + the deterministic
  // next-set recommendation). This function turns facts into the coach's voice.
  //
  // Primary path: POST the facts to /api/coach/message, which asks Gemini to
  // phrase them. The engine still owns every number; the LLM only words them,
  // and the endpoint never writes. If Gemini is unconfigured, slow, or errors,
  // the endpoint returns message:null (or we time out / throw) and we fall back
  // to the deterministic templated note — the conversation is never blocked.
  //
  // Contract: input = facts; output = a plain string (newlines + "* " bullets
  // render as-is in the pre-wrap bubble).
  const COACH_LLM_TIMEOUT_MS = 9000;

  async function getCoachingMessage(facts) {
    const llm = await getLlmCoachingMessage(facts).catch(() => null);
    return (llm && llm.trim()) ? llm : buildTemplatedCoaching(facts);
  }

  async function getLlmCoachingMessage(facts) {
    if (typeof api !== 'function' || (typeof getApiKey === 'function' && !getApiKey())) return null;
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), COACH_LLM_TIMEOUT_MS));
    const request = api('/api/coach/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facts })
    }).then(res => (res && res.data && res.data.message) || null);
    return Promise.race([request, timeout]);
  }

  function buildTemplatedCoaching(facts) {
    const { exerciseName, todaySets = [], rec } = facts;
    const lines = [];
    lines.push(coachOpener(todaySets, rec));
    lines.push('');
    lines.push(exerciseName);
    for (const s of todaySets) {
      const rir = (s.rir != null && Number.isFinite(s.rir)) ? ` @${s.rir}` : '';
      lines.push(`* ${s.weight} × ${s.reps}${rir}`);
    }
    const next = coachNext(rec);
    if (next) { lines.push(''); lines.push(next); }
    return lines.join('\n');
  }

  function coachOpener(todaySets, rec) {
    const rirs = todaySets.map(s => s.rir).filter(v => v != null && Number.isFinite(v));
    const hitFailure = rirs.some(v => v <= 0);
    const topWeight = Math.max(0, ...todaySets.map(s => Number(s.weight) || 0));
    const lastSets = (rec && rec.last_working_sets) || [];
    const lastTop = lastSets.length ? Math.max(0, ...lastSets.map(s => Number(s.weight) || 0)) : null;

    if (hitFailure) return 'Strong work — but that got spicy at the end. You left nothing in the tank on the last set.';
    if (lastTop != null && topWeight > lastTop) return `Nice — that's a step up on your last session (top set was ${lastTop} lb).`;
    if (lastTop != null && topWeight === lastTop) return 'Solid — you matched your last top set. Clean reps bank the next jump.';
    if (lastTop == null) return "Logged. That sets your baseline — I'll track your progress from here.";
    return 'Logged. Steady work.';
  }

  function coachNext(rec) {
    if (rec && rec.recommendation) return `Next: ${rec.recommendation}`;
    return '';
  }

  /* ===== Event wiring (read-only narration of app.js's trust loop) ===== */

  async function handlePreviewReady(detail) {
    const { rows = [], liftCodes = [], effortOnly } = detail || {};
    if (effortOnly || !liftCodes.length) return;       // effort-only previews have no sets to coach
    const code = liftCodes[0];
    const todaySets = (typeof previewSetsForLift === 'function') ? previewSetsForLift(rows, code) : [];
    if (!todaySets.length) return;

    const handle = appendAtlasBubble();
    if (!handle) return;
    const { bubble, body } = handle;

    let rec = null;
    try { if (typeof fetchReaction === 'function') rec = await fetchReaction(code); } catch { /* best effort */ }

    const facts = {
      liftCode: code,
      exerciseName: (rec && rec.exercise_name) || code,
      todaySets,
      rec
    };
    await typeOut(body, await getCoachingMessage(facts));
    appendInlineSave(bubble);
  }

  /* ===== Tiles + listeners ===== */

  document.getElementById('suggested-tiles')?.addEventListener('click', e => {
    const tile = e.target.closest('.suggest-tile');
    if (!tile) return;
    hideHomeEmpty();
    if (tile.dataset.suggest === 'last' && typeof window.atlasChipAnswerLast === 'function') {
      window.atlasChipAnswerLast();
    } else {
      typeSuggestedWorkout();
    }
  });

  document.addEventListener('atlas:preview-ready', e => { handlePreviewReady(e.detail).catch(() => {}); });

  // Logging directly (without tapping a tile) also leaves the empty home: the
  // first message of any kind collapses the hero + tiles.
  const thread = document.getElementById('thread-messages');
  if (thread) {
    new MutationObserver(() => { if (thread.children.length) hideHomeEmpty(); })
      .observe(thread, { childList: true });
  }
})();
