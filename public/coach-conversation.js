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
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    try { node.scrollIntoView({ behavior, block: 'nearest' }); } catch { /* noop */ }
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
    const bubble = currentSaveBtn.parentElement; // the coaching bubble
    currentSaveBtn.textContent = 'Saved ✓';
    currentSaveBtn.disabled = true;
    currentSaveBtn.dataset.done = '1';
    currentSaveBtn = null;
    // "Saved ✓" is the single post-write confirmation — no verdict bubble, no
    // verbose written/verified card, no Undo button. The stale "nothing saved
    // yet" gate note is dropped. (Undoing a write is a future chat/LLM action.)
    bubble?.querySelector('.atlas-reply-gate')?.remove();
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
      if (loggerStatusEl.querySelector('.status-msg.ok')) {
        markSaved();             // flips inline Save → "Saved ✓" + adds Undo link
      } else if (loggerStatusEl.querySelector('.status-msg.error')) {
        resetSaveAfterError();
      }
    }).observe(loggerStatusEl, { childList: true, subtree: true });
  }

  /* ===== Suggested-workout message (templated) ===== */

  function recommendedIntent(data) {
    const intents = (data && data.intents) || [];
    return intents.find(i => i.recommended) || intents[0] || null;
  }

  // Format one set as "{weight}lbs {reps}/{rir}", omitting "/{rir}" when null.
  function formatSetLine(s) {
    const weight = s.weight != null ? `${s.weight}lbs` : '?lbs';
    const reps = s.reps != null ? `${s.reps}` : '?';
    const rir = (s.rir != null && Number.isFinite(Number(s.rir))) ? `/${s.rir}` : '';
    return `${weight} ${reps}${rir}`;
  }

  // Group consecutive identical set lines — e.g. three "225lbs 5/2" → "225lbs 5/2 x3".
  function groupSets(sets) {
    const groups = [];
    for (const s of sets) {
      const line = formatSetLine(s);
      const last = groups[groups.length - 1];
      if (last && last.line === line) { last.count += 1; } else { groups.push({ line, count: 1 }); }
    }
    return groups.map(g => g.count > 1 ? `${g.line} x${g.count}` : g.line);
  }

  // The exercise list + closing line, shared by the templated and LLM-voiced
  // suggested-workout messages (the app always shows the exercises; only the
  // "why" prose above them changes).
  function suggestedExercisesBlock(rec) {
    const exercises = (rec && rec.exercises) || [];
    const lines = [];
    let any = false;
    for (const raw of exercises) {
      const ex = (typeof normalizePlanExercise === 'function') ? normalizePlanExercise(raw) : raw;
      if (!ex || !ex.name) continue;
      if (!any) { lines.push(''); any = true; }
      lines.push(ex.name);
      if (ex.weight != null && ex.reps != null) {
        const setStr = (ex.sets > 1) ? ` x${ex.sets}` : '';
        lines.push(`${ex.weight}lbs ${ex.reps}${setStr}`);
      }
    }
    if (any) {
      lines.push('');
      lines.push("Log your first sets when you're ready and I'll react as you go.");
    }
    return lines;
  }

  function getSuggestedWorkoutMessage(data) {
    const read = (data && data.todays_read) || {};
    const rec = recommendedIntent(data);
    const label = read.recommended_label || (rec && rec.label) || null;
    const exercises = (rec && rec.exercises) || [];

    // New user / no history yet — bootstrap with a safe baseline message rather
    // than inventing numbers. (The LLM onboarding layer is a later PR.)
    if (!label && !exercises.length) {
      return [
        "I don't have enough history yet to tailor your session.",
        '',
        "Start light and establish baselines — something like:",
        'Squat or Leg Press',
        '3 × 8–10 @ RIR 3',
        '',
        'Bench Press',
        '3 × 8–10 @ RIR 3',
        '',
        'Row',
        '3 × 10–12 @ RIR 2–3',
        '',
        'Lat Pulldown',
        '2–3 × 10–12 @ RIR 2–3',
        '',
        "Log a few sessions and I'll start calling the shots from your own numbers."
      ].join('\n');
    }

    const lines = [];
    lines.push(label ? `Today's read: ${label}.` : "Here's a solid session for today.");
    const focus = read.recommended_reason || (rec && rec.focus);
    if (focus) lines.push(focus);

    // Why today — surface the engine's deterministic reasoning behind the pick:
    // the plain-language reasons, current movement-pattern readiness, and the
    // numbers that drove it. (When Gemini is connected this same data can be
    // phrased more conversationally; the substance is already here.)
    const whyReasons = (rec && Array.isArray(rec.why_today) ? rec.why_today : [])
      .filter(Boolean)
      .filter(w => w !== focus)
      .slice(0, 2);
    const readiness = patternReadinessLine(read.patterns);
    const numbers = dataPointLines(rec && rec.data_points);
    if (whyReasons.length || readiness || numbers.length) {
      lines.push('');
      lines.push('Why today:');
      for (const w of whyReasons) lines.push(`* ${w}`);
      if (readiness) lines.push(`* ${readiness}`);
      for (const n of numbers) lines.push(`* ${n}`);
    }

    if (exercises.length) {
      for (const line of suggestedExercisesBlock(rec)) lines.push(line);
    }
    return lines.join('\n');
  }

  // Build "Bench 185×6, Row 155×8…" placeholder from structured plan exercises.
  function buildWorkoutPlaceholder(exercises) {
    if (!exercises || !exercises.length) return null;
    const items = exercises.slice(0, 4).map(raw => {
      const ex = (typeof normalizePlanExercise === 'function') ? normalizePlanExercise(raw) : raw;
      if (!ex || !ex.name || ex.weight == null || ex.reps == null) return null;
      const name = ex.name.split(' ').slice(0, 2).join(' ');
      return `${name} ${ex.weight}×${ex.reps}`;
    }).filter(Boolean);
    return items.length ? items.join(', ') : null;
  }

  // Extract placeholder from a typed Atlas reply that contains exercise prescriptions.
  // Handles two formats: the templated block ("Bench Press\n185lbs 6 x4") and
  // LLM bullet format ("Bench Press: 185 lb × 6").  Returns null when no exercises found.
  function extractPlaceholderFromText(text) {
    if (!text) return null;
    const items = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length - 1 && items.length < 4; i++) {
      const line = lines[i].trim();
      const next = lines[i + 1].trim();
      const m = /^(\d+)lbs\s+(\d+)/.exec(next);
      if (m && line && !/^\d/.test(line) && !/lbs|×|Why|Log|today|read/i.test(line)) {
        const name = line.replace(/^[*•\-]\s*/, '').split(' ').slice(0, 2).join(' ');
        items.push(`${name} ${m[1]}×${m[2]}`);
      }
    }
    if (!items.length) {
      const re = /([A-Z][a-zA-Z\s]{2,25}?):\s*(\d+)\s*(?:lb[s]?\s*)?[×xX]\s*(\d+)/g;
      let m;
      while ((m = re.exec(text)) !== null && items.length < 4) {
        const name = m[1].trim().split(' ').slice(0, 2).join(' ');
        items.push(`${name} ${m[2]}×${m[3]}`);
      }
    }
    return items.length ? items.join(', ') : null;
  }

  function setWorkoutPlaceholder(text) {
    const ta = document.getElementById('workout-text');
    if (ta && text) ta.placeholder = text;
  }

  // LLM path: send the deterministic plan facts to /api/coach/message (kind:plan)
  // and compose the reply as headline + Gemini "why" prose + the exercise list.
  // Returns null on no-key / empty facts / timeout / failure so the caller falls
  // back to the templated getSuggestedWorkoutMessage. Never blocks the tile.
  function buildPlanFacts(data) {
    const read = (data && data.todays_read) || {};
    const rec = recommendedIntent(data);
    const labels = (typeof FRIENDLY_PATTERN_LABELS !== 'undefined') ? FRIENDLY_PATTERN_LABELS : {};
    const words = (typeof FRIENDLY_STATUS_WORDS !== 'undefined') ? FRIENDLY_STATUS_WORDS : {};
    const readiness = (read.patterns || []).map(p => ({
      pattern: labels[p.label || p.pattern] || p.label || p.pattern,
      status: words[p.status] || p.status
    })).filter(r => r.pattern && r.status && r.status !== '—');
    return {
      label: read.recommended_label || (rec && rec.label) || null,
      focus: read.recommended_reason || (rec && rec.focus) || null,
      why_today: (rec && rec.why_today) || [],
      readiness,
      data_points: (rec && rec.data_points) || []
    };
  }

  async function getLlmPlanMessage(data) {
    if (typeof api !== 'function' || (typeof getApiKey === 'function' && !getApiKey())) return null;
    const facts = buildPlanFacts(data);
    if (!facts.label && !facts.why_today.length) return null; // nothing to explain (new user)
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), COACH_LLM_TIMEOUT_MS));
    const request = api('/api/coach/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facts, kind: 'plan' })
    }).then(res => (res && res.data && res.data.message) || null);
    return Promise.race([request, timeout]);
  }

  // Compose the Gemini "why" prose into the full suggested-workout note: the
  // headline and the exercise list stay deterministic; only the reasoning is voiced.
  function composeLlmPlanMessage(whyProse, data) {
    const read = (data && data.todays_read) || {};
    const rec = recommendedIntent(data);
    const label = read.recommended_label || (rec && rec.label) || null;
    const lines = [label ? `Today's read: ${label}.` : "Here's a solid session for today."];
    if (whyProse && whyProse.trim()) { lines.push(''); lines.push(whyProse.trim()); }
    for (const line of suggestedExercisesBlock(rec)) lines.push(line);
    return lines.join('\n');
  }

  // "Readiness: Push fresh · Legs recovering · Pull ready" from todays_read
  // patterns, using app.js's friendly label/status maps when available.
  function patternReadinessLine(patterns) {
    if (!Array.isArray(patterns) || !patterns.length) return '';
    const labels = (typeof FRIENDLY_PATTERN_LABELS !== 'undefined') ? FRIENDLY_PATTERN_LABELS : {};
    const words = (typeof FRIENDLY_STATUS_WORDS !== 'undefined') ? FRIENDLY_STATUS_WORDS : {};
    const parts = patterns.map(p => {
      const label = labels[p.label || p.pattern] || p.label || p.pattern;
      const status = words[p.status] || p.status;
      return (label && status && status !== '—') ? `${label} ${String(status).toLowerCase()}` : null;
    }).filter(Boolean);
    return parts.length ? `Readiness: ${parts.join(' · ')}` : '';
  }

  // 1–2 "Weekly load: 1.4× baseline (high)" lines from the intent's data_points.
  function dataPointLines(dataPoints) {
    if (!Array.isArray(dataPoints) || !dataPoints.length) return [];
    return dataPoints.slice(0, 2).map(d => {
      if (!d || d.label == null || d.value == null) return null;
      const ctx = d.context ? ` (${d.context})` : '';
      return `${d.label}: ${d.value}${ctx}`;
    }).filter(Boolean);
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
      const data = res.data || {};
      // Prefer Gemini's voiced "why"; fall back to the templated note on
      // no-key / slow / error so the tile always answers.
      const whyProse = await getLlmPlanMessage(data).catch(() => null);
      body.textContent = '';
      const message = (whyProse && whyProse.trim())
        ? composeLlmPlanMessage(whyProse, data)
        : getSuggestedWorkoutMessage(data);
      await typeOut(body, message);
      setWorkoutPlaceholder(buildWorkoutPlaceholder((recommendedIntent(data) || {}).exercises));
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
    for (const line of groupSets(todaySets)) lines.push(line);
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

  /* ===== Free-form chat (atlas:chat-message → /api/coach/chat) ===== */

  // In-session conversation memory only — resets on reload (no persistence, per
  // Atlas's no-database rule). We send the last few turns for context.
  const chatTurns = []; // [{ role: 'user' | 'atlas', text }]

  // Bounds mirror rules/validationRules.js — validated here before touching the DOM.
  const EDIT_BOUNDS = { weight: [0, 1500], reps: [1, 100], rir: [0, 10] };

  function validateProposedEdit(edit, rowCount) {
    if (!edit || typeof edit !== 'object') return false;
    const { action } = edit;
    if (!['update_set', 'delete_set', 'add_set'].includes(action)) return false;
    if ((action === 'update_set' || action === 'delete_set') &&
        (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= rowCount)) return false;
    for (const [field, [min, max]] of Object.entries(EDIT_BOUNDS)) {
      const v = edit[field];
      if (v != null) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < min || n > max) return false;
      }
    }
    return true;
  }

  // Apply a coach-proposed edit to the visible preview rows. Returns true when
  // applied, false when the edit fails validation. Always calls invalidatePreview
  // so the lifter must re-preview before the approve button re-enables — the
  // trust loop (preview → approve → write) is never skipped.
  function applyProposedEdit(edit) {
    const table = (typeof setsTableBody !== 'undefined') ? setsTableBody : null;
    if (!table) return false;
    const allRows = Array.from(table.children);
    // The model's index is relative to the same filtered rows currentPreviewRowsForChat
    // sent as context — rows where weight or reps has a value. Blank placeholder rows
    // are excluded from both the snapshot and the edit target, so the indices align.
    const rows = allRows.filter(tr => {
      const w = tr.querySelector('.set-weight')?.value;
      const r = tr.querySelector('.set-reps')?.value;
      return w || r;
    });
    if (!validateProposedEdit(edit, rows.length)) return false;

    if (edit.action === 'delete_set') {
      rows[edit.index].remove();
      if (!table.children.length) {
        const editor = document.getElementById('parsed-rows-editor');
        if (editor) editor.hidden = true;
      }
    } else if (edit.action === 'update_set') {
      const row = rows[edit.index];
      if (edit.weight != null) row.querySelector('.set-weight').value = String(edit.weight);
      if (edit.reps != null) row.querySelector('.set-reps').value = String(edit.reps);
      if (edit.rir != null) row.querySelector('.set-rir').value = String(edit.rir);
    } else if (edit.action === 'add_set') {
      if (typeof addSetRow !== 'function') return false;
      const lastRow = allRows[allRows.length - 1];
      const exercise = lastRow ? (lastRow.querySelector('.set-exercise')?.value || null) : null;
      addSetRow({ exercise, weight: edit.weight, reps: edit.reps, rir: edit.rir });
    }

    // Force re-preview: the edited rows are unreviewed until the lifter runs a
    // new dry-run preview, which re-enables the approve button.
    if (typeof invalidatePreview === 'function') invalidatePreview();
    return true;
  }

  // `history` is the PRIOR turns only — the current message is sent separately as
  // `message`, so the caller must not have appended it to chatTurns yet (else the
  // backend would see the current turn twice).
  async function getChatReply(message, history, context) {
    if (typeof api !== 'function' || (typeof getApiKey === 'function' && !getApiKey())) return { message: null, propose_edit: null, propose_note: null };
    const timeout = new Promise(resolve => setTimeout(() => resolve({ message: null, propose_edit: null, propose_note: null }), COACH_LLM_TIMEOUT_MS));
    const request = api('/api/coach/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: history.slice(-8), context: context || {} })
    }).then(res => ({
      message: (res && res.data && res.data.message) || null,
      propose_edit: (res && res.data && res.data.propose_edit) || null,
      propose_note: (res && res.data && res.data.propose_note) || null
    }));
    return Promise.race([request, timeout]);
  }

  // Show a "Save this note?" prompt under Atlas's bubble. Calls POST /api/coaching-notes
  // on approval; disappears on skip. Never blocks the conversation.
  function showSaveNotePrompt(bubble, noteText) {
    const wrap = document.createElement('div');
    wrap.className = 'propose-note-wrap';

    const label = document.createElement('p');
    label.className = 'propose-note-label';
    label.textContent = `Save note: "${noteText}"`;

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'propose-note-save-btn';
    saveBtn.textContent = 'Save note';

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'propose-note-skip-btn';
    skipBtn.textContent = 'Skip';

    wrap.appendChild(label);
    wrap.appendChild(saveBtn);
    wrap.appendChild(skipBtn);
    bubble.appendChild(wrap);
    softScroll(wrap);

    skipBtn.addEventListener('click', () => { wrap.remove(); });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      skipBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const writeId = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await api('/api/coaching-notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: noteText, write_id: writeId })
        });
        label.textContent = 'Note saved.';
        saveBtn.remove();
        skipBtn.remove();
      } catch {
        saveBtn.textContent = 'Save note';
        saveBtn.disabled = false;
        skipBtn.disabled = false;
      }
    });
  }

  // Deterministic fallback when the coach voice is unconfigured, slow, or errors
  // — the chat is never a dead end, and we never claim anything was saved.
  function chatFallback(message) {
    const t = String(message || '').toLowerCase();
    if (/^\s*(hi|hey|hello|yo|sup|good (morning|evening))\b/.test(t)) {
      return "Hey — ready when you are. Log your sets and say \"log it\" when you're done.";
    }
    // Looks like workout notation (has numbers) — don't suggest format correction
    if (/\d/.test(t)) {
      return "Noted — I'm having trouble connecting right now. Keep logging and say \"log it\" when you're done; I'll compile everything then.";
    }
    return "I'm having trouble connecting right now — try again in a moment.";
  }

  async function handleChatMessage(detail) {
    const text = (detail && detail.text || '').trim();
    if (!text) return;
    // chat.js already painted the lifter's bubble on submit; we add Atlas's reply.
    // Capture prior turns, then record THIS turn immediately — so a second message
    // submitted while this request is still in flight sees it in context and turns
    // stay in submission order. Only priorTurns goes to getChatReply (the current
    // message is sent separately as `message`), which avoids the double-send.
    const priorTurns = chatTurns.slice(-8);
    chatTurns.push({ role: 'user', text });

    const handle = appendAtlasBubble();
    if (!handle) return;
    const { bubble, body } = handle;
    body.textContent = 'Thinking…';

    let chatResult = { message: null, propose_edit: null, propose_note: null };
    try { chatResult = await getChatReply(text, priorTurns, detail && detail.context); } catch { /* stays null */ }

    let reply = chatResult.message;
    if (!reply || !reply.trim()) reply = chatFallback(text);

    body.textContent = '';
    await typeOut(body, reply);
    setWorkoutPlaceholder(extractPlaceholderFromText(reply));

    // Apply the structured edit (if any) after prose is typed — the lifter sees
    // the explanation first, then the preview updates. The trust loop is intact:
    // invalidatePreview() forces a new dry-run before approve re-enables.
    if (chatResult.propose_edit) {
      const applied = applyProposedEdit(chatResult.propose_edit);
      if (applied) {
        const note = document.createElement('div');
        note.className = 'edit-applied-note';
        note.textContent = 'Preview updated — review and tap Save when ready.';
        bubble.appendChild(note);
      }
    }

    // Show "Save this note?" prompt if Atlas proposed a coaching note. Requires
    // explicit lifter approval — never saves silently.
    if (chatResult.propose_note && chatResult.propose_note.note) {
      showSaveNotePrompt(bubble, chatResult.propose_note.note);
    }

    chatTurns.push({ role: 'atlas', text: reply });
  }

  document.addEventListener('atlas:chat-message', e => { handleChatMessage(e.detail).catch(() => {}); });

  // Logging directly (without tapping a tile) also leaves the empty home: the
  // first message of any kind collapses the hero + tiles.
  const thread = document.getElementById('thread-messages');
  if (thread) {
    new MutationObserver(() => { if (thread.children.length) hideHomeEmpty(); })
      .observe(thread, { childList: true });
  }

  // Expose chat history so app.js can compile the session when "log it" fires.
  // Returns a snapshot array — the IIFE retains the live reference.
  window.getChatHistory = () => chatTurns.slice();
})();
