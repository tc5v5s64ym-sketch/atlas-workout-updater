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

  /* ===== Set readback + next-prescription (in-workout coaching, no Save) ===== */

  function elc(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function exerciseNameFromRows(rows, code) {
    const r = (rows || []).find(row => String(row[5] || '').toUpperCase() === String(code).toUpperCase());
    return r ? (r[3] || r[2] || null) : null;
  }

  // "135×12 RIR 4 · 185×10 RIR 2 · 225×5 RIR 0" — RIR always in ember; RIR 0 /
  // failure gets the brighter "max" treatment. Appends into `target`.
  function appendSetReadout(target, sets) {
    sets.forEach((s, i) => {
      if (i) target.appendChild(document.createTextNode(' · '));
      target.appendChild(document.createTextNode(`${s.weight}×${s.reps} `));
      if (s.rir != null && Number.isFinite(Number(s.rir))) {
        const failure = Number(s.rir) <= 0;
        const rir = elc('span', failure ? 'rir rir-max' : 'rir', `RIR ${s.rir}`);
        target.appendChild(rir);
      }
    });
  }

  function buildReadback(name, sets) {
    const rb = elc('div', 'readback');
    const h = elc('div', 'rb-h');
    h.appendChild(elc('span', 'rb-ck', '✓'));
    h.appendChild(document.createTextNode(' ' + name));
    rb.appendChild(h);
    const s = elc('div', 'rb-s');
    appendSetReadout(s, sets);
    rb.appendChild(s);
    return rb;
  }

  function buildNextPrescription(rec) {
    const wrap = elc('div', 'nextp');
    wrap.appendChild(elc('div', 'nextp-h', '→ Next'));
    wrap.appendChild(elc('div', 'nextp-s', rec.recommendation));
    return wrap;
  }

  /* ===== End-of-session review card (reskins the existing approve/write/undo) ===== */

  let currentReview = null;
  const approveBtn = document.getElementById('approve-btn');
  const loggerStatusEl = document.getElementById('logger-status');

  // The approval gate lives in app.js: #approve-btn is only enabled once a
  // dry-run preview has proven no-write safety. Mirror its disabled state onto
  // the review card's Save so it can never write before the gate allows it.
  if (approveBtn) {
    new MutationObserver(() => {
      if (currentReview && !currentReview.done) currentReview.saveBtn.disabled = approveBtn.disabled;
    }).observe(approveBtn, { attributes: true, attributeFilter: ['disabled'] });
  }

  // Group consecutive identical sets — "225 × 10 · RIR 2  ×3".
  function buildReviewSetLine(sets) {
    const span = elc('span', 'rv-es');
    const groups = [];
    for (const s of sets) {
      const key = `${s.weight}|${s.reps}|${s.rir}`;
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.count += 1;
      else groups.push({ key, set: s, count: 1 });
    }
    groups.forEach((g, i) => {
      if (i) span.appendChild(document.createTextNode('  '));
      span.appendChild(document.createTextNode(`${g.set.weight} × ${g.set.reps} `));
      if (g.set.rir != null && Number.isFinite(Number(g.set.rir))) {
        span.appendChild(elc('span', Number(g.set.rir) <= 0 ? 'rir rir-max' : 'rir', `RIR ${g.set.rir}`));
      }
      if (g.count > 1) span.appendChild(document.createTextNode(` ×${g.count}`));
    });
    return span;
  }

  function buildReviewCard(rows, liftCodes, effortOnly) {
    const card = elc('div', 'review');

    const head = elc('div', 'rv-h');
    head.appendChild(elc('span', 'rv-t', "Today’s workout"));
    head.appendChild(elc('span', 'rv-d', (rows[0] && rows[0][0]) ? String(rows[0][0]) : ''));
    card.appendChild(head);

    let exCount = 0, setCount = 0, volume = 0;
    for (const code of liftCodes) {
      const sets = (typeof previewSetsForLift === 'function') ? previewSetsForLift(rows, code) : [];
      if (!sets.length) continue;
      exCount += 1;
      setCount += sets.length;
      volume += sets.reduce((a, s) => a + (Number(s.weight) || 0) * (Number(s.reps) || 0), 0);
      const ex = elc('div', 'rv-ex');
      ex.appendChild(elc('span', 'rv-en', exerciseNameFromRows(rows, code) || code));
      ex.appendChild(buildReviewSetLine(sets));
      card.appendChild(ex);
    }

    const tot = elc('div', 'rv-tot');
    tot.appendChild(elc('span', null, `${exCount} exercise${exCount === 1 ? '' : 's'} · ${setCount} sets`));
    tot.appendChild(elc('b', null, `${Math.round(volume).toLocaleString()} lb`));
    card.appendChild(tot);

    card.appendChild(elc('div', 'rv-eff', effortOnly
      ? 'Apple Watch effort attached'
      : '+ add Apple Watch effort (duration, cals, HR)'));

    const act = elc('div', 'rv-act');
    const saveBtn = elc('button', 'btn rv-save', 'Save workout');
    saveBtn.type = 'button';
    saveBtn.disabled = approveBtn ? approveBtn.disabled : true;
    saveBtn.addEventListener('click', () => {
      if (!approveBtn || approveBtn.disabled) return;
      approveBtn.click();              // reuse the existing, unchanged write path
      saveBtn.textContent = 'Saving…';
      saveBtn.disabled = true;
    });
    const editBtn = elc('button', 'btn rv-edit', 'Edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => {
      const editor = document.getElementById('parsed-rows-editor');
      if (editor) {
        editor.hidden = false;
        editor.open = true;
        requestAnimationFrame(() => editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      }
    });
    act.appendChild(saveBtn);
    act.appendChild(editBtn);
    card.appendChild(act);

    card.appendChild(elc('div', 'rv-note', 'Nothing’s saved yet · this is the only save'));

    const saved = elc('div', 'rv-saved');
    saved.appendChild(elc('span', 'rv-saved-txt', '✓ Saved to your sheet'));
    const undo = elc('a', 'rv-undo', 'Undo');
    undo.href = '#';
    undo.addEventListener('click', e => {
      e.preventDefault();
      if (typeof window.atlasUndoLastWrite === 'function') {
        window.atlasUndoLastWrite();   // reuse the existing /api/log-workout/undo-last path
        undo.textContent = 'Undoing…';
      }
    });
    saved.appendChild(undo);
    card.appendChild(saved);

    currentReview = { card, saveBtn, done: false };
    return card;
  }

  function markReviewSaved() {
    if (!currentReview || currentReview.done) return;
    currentReview.done = true;
    currentReview.card.classList.add('done');
  }

  function markReviewUndone() {
    if (!currentReview) return;
    const txt = currentReview.card.querySelector('.rv-saved-txt');
    if (txt) txt.textContent = '↩ Undone · nothing saved';
    const undo = currentReview.card.querySelector('.rv-undo');
    if (undo) undo.remove();
  }

  // app.js writes the result into #logger-status: `.status-msg.ok` on a write or
  // an undo (text "undone"), `.status-msg.error` on failure. Reflect that onto
  // the review card — no change to the approve/undo handlers.
  if (loggerStatusEl) {
    new MutationObserver(() => {
      if (!currentReview) return;
      const ok = loggerStatusEl.querySelector('.status-msg.ok');
      const err = loggerStatusEl.querySelector('.status-msg.error');
      if (ok && /undone/i.test(ok.textContent || '')) {
        markReviewUndone();
      } else if (ok && !currentReview.done) {
        markReviewSaved();
      } else if (err && !currentReview.done) {
        currentReview.saveBtn.textContent = 'Save workout';
        currentReview.saveBtn.disabled = approveBtn ? approveBtn.disabled : false;
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

  // Format one suggested-workout set as "{weight}lbs {reps}/{rir}". RIR is NEVER
  // silently dropped: when the engine gave no RIR we render "/?", never a bare
  // "{weight}lbs {reps}". Pure (no DOM, no closure deps) so it is unit-testable.
  function formatPlanSetLine(ex) {
    const rir = (ex.rir != null && Number.isFinite(Number(ex.rir))) ? `${ex.rir}` : '?';
    return `${ex.weight}lbs ${ex.reps}/${rir}`;
  }

  // The exercise list + closing line as plain text — used only for the
  // no-structured-plan fallbacks (bootstrap / no history). The main path renders
  // the structured block via appendWorkoutPlan() so names can be bold.
  function suggestedExercisesBlock(rec) {
    const exercises = (rec && rec.exercises) || [];
    const lines = [];
    let any = false;
    for (const raw of exercises) {
      const ex = (typeof normalizePlanExercise === 'function') ? normalizePlanExercise(raw) : raw;
      if (!ex || !ex.name) continue;
      // Blank line before first exercise (header gap) and between exercises
      lines.push('');
      any = true;
      lines.push(ex.name);
      if (ex.weight != null && ex.reps != null) {
        const count = (ex.sets != null && ex.sets > 1) ? ex.sets : 1;
        for (let i = 0; i < count; i++) {
          lines.push(formatPlanSetLine(ex));
        }
      }
    }
    if (any) {
      lines.push('');
      lines.push("Log your first sets when you're ready and I'll react as you go.");
    }
    return lines;
  }

  // Render the recommended workout as a STRUCTURED block so exercise names are
  // bold and set lines are RIR-safe — markdown "**" would not render in the
  // pre-wrap typed bubble. No bullets; one visual gap between exercises (CSS).
  // Returns the count of exercises rendered.
  function appendWorkoutPlan(container, rec) {
    const exercises = (rec && rec.exercises) || [];
    const plan = document.createElement('div');
    plan.className = 'workout-plan';
    let rendered = 0;
    for (const raw of exercises) {
      const ex = (typeof normalizePlanExercise === 'function') ? normalizePlanExercise(raw) : raw;
      if (!ex || !ex.name) continue;
      const exEl = document.createElement('div');
      exEl.className = 'workout-plan-ex';
      const name = document.createElement('strong');
      name.className = 'workout-plan-name';
      name.textContent = ex.name;
      exEl.appendChild(name);
      if (ex.weight != null && ex.reps != null) {
        const count = (ex.sets != null && ex.sets > 1) ? ex.sets : 1;
        for (let i = 0; i < count; i++) {
          const set = document.createElement('div');
          set.className = 'workout-plan-set';
          set.textContent = formatPlanSetLine(ex);
          exEl.appendChild(set);
        }
      }
      plan.appendChild(exEl);
      rendered++;
    }
    if (rendered) container.appendChild(plan);
    return rendered;
  }

  // The "why" prose lines (headline · focus · why-today bullets) — everything
  // above the workout block. Shared by the text fallback and the structured path.
  function suggestedWorkoutProseLines(data) {
    const read = (data && data.todays_read) || {};
    const rec = recommendedIntent(data);
    const label = read.recommended_label || (rec && rec.label) || null;

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

    const lines = suggestedWorkoutProseLines(data);
    if (exercises.length) {
      for (const line of suggestedExercisesBlock(rec)) lines.push(line);
    }
    return lines.join('\n');
  }

  // Build "Bench 185×6" placeholder from the first (current) plan exercise only.
  function buildWorkoutPlaceholder(exercises) {
    if (!exercises || !exercises.length) return null;
    const items = exercises.slice(0, 1).map(raw => {
      const ex = (typeof normalizePlanExercise === 'function') ? normalizePlanExercise(raw) : raw;
      if (!ex || !ex.name || ex.weight == null || ex.reps == null) return null;
      const name = ex.name.split(' ').slice(0, 2).join(' ');
      return `${name} ${ex.weight}×${ex.reps}`;
    }).filter(Boolean);
    return items.length ? items[0] : null;
  }

  // Extract placeholder from a typed Atlas reply that contains exercise prescriptions.
  // Handles two formats: the templated block ("Bench Press\n185lbs 6 x4") and
  // LLM bullet format ("Bench Press: 185 lb × 6").  Returns null when no exercises found.
  function extractPlaceholderFromText(text) {
    if (!text) return null;
    const items = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length - 1 && !items.length; i++) {
      const line = lines[i].trim();
      const next = lines[i + 1].trim();
      const m = /^(\d+)lbs\s+(\d+)/.exec(next);
      if (m && line && !/^\d/.test(line) && !/lbs|×|Why|Log|today|read/i.test(line)) {
        const name = line.replace(/^[*•\-]\s*/, '').split(' ').slice(0, 2).join(' ');
        items.push(`${name} ${m[1]}×${m[2]}`);
      }
    }
    if (!items.length) {
      const re = /([A-Z][a-zA-Z\s]{2,25}?):\s*(\d+)\s*(?:lb[s]?\s*)?[×xX]\s*(\d+)/;
      const m = re.exec(text);
      if (m) items.push(`${m[1].trim().split(' ').slice(0, 2).join(' ')} ${m[2]}×${m[3]}`);
    }
    return items.length ? items[0] : null;
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

  // The Gemini "why" prose lines (headline + voiced reasoning) — everything
  // above the workout block.
  function composeLlmPlanProseLines(whyProse, data) {
    const read = (data && data.todays_read) || {};
    const rec = recommendedIntent(data);
    const label = read.recommended_label || (rec && rec.label) || null;
    const lines = [label ? `Today's read: ${label}.` : "Here's a solid session for today."];
    if (whyProse && whyProse.trim()) { lines.push(''); lines.push(whyProse.trim()); }
    return lines;
  }

  // Compose the Gemini "why" prose into the full suggested-workout note: the
  // headline and the exercise list stay deterministic; only the reasoning is voiced.
  function composeLlmPlanMessage(whyProse, data) {
    const rec = recommendedIntent(data);
    const lines = composeLlmPlanProseLines(whyProse, data);
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
      const rec = recommendedIntent(data) || {};
      const exercises = rec.exercises || [];
      // Prefer Gemini's voiced "why"; fall back to the templated note on
      // no-key / slow / error so the tile always answers.
      const whyProse = await getLlmPlanMessage(data).catch(() => null);
      body.textContent = '';

      if (exercises.length) {
        // Type the "why" prose, then render the workout as a STRUCTURED block so
        // exercise names are bold and RIR is never dropped from a set line.
        const proseLines = (whyProse && whyProse.trim())
          ? composeLlmPlanProseLines(whyProse, data)
          : suggestedWorkoutProseLines(data);
        await typeOut(body, proseLines.join('\n'));
        appendWorkoutPlan(body, rec);
        const closing = document.createElement('div');
        closing.className = 'workout-plan-closing';
        closing.textContent = "Log your first sets when you're ready and I'll react as you go.";
        body.appendChild(closing);
        softScroll(body);
      } else {
        // No structured plan (new user / no history) — type the all-text guidance.
        const message = (whyProse && whyProse.trim())
          ? composeLlmPlanMessage(whyProse, data)
          : getSuggestedWorkoutMessage(data);
        await typeOut(body, message);
      }
      setWorkoutPlaceholder(buildWorkoutPlaceholder(exercises));
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

  // In-workout note: conversational prose only. The structured readback already
  // shows the sets and the .nextp card shows the prescription, so the templated
  // fallback is just the one-line reaction (no set/next repetition).
  async function getInWorkoutNote(facts) {
    const llm = await getLlmCoachingMessage(facts).catch(() => null);
    return (llm && llm.trim()) ? llm : coachOpener(facts.todaySets || [], facts.rec);
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

  // Resolve a lift code from the catalog datalist (value=name, label=code) so
  // the next-prescription can be fetched without any dry-run/preview request.
  function liftCodeForExercise(name) {
    const dl = document.getElementById('exercise-catalog');
    if (!dl || !name) return null;
    const opt = Array.from(dl.options || []).find(o => (o.value || '').toLowerCase() === String(name).toLowerCase());
    return opt ? (opt.label || null) : null;
  }

  // In-workout: a logged set → readback (RIR in ember) + coach note + adjusted-
  // next prescription. NO Save/preview/approve — the only Save is the end-of-
  // session review card below. Rendered purely from the client-parsed sets; the
  // set text is recorded so the end-of-session compile can reconstruct the
  // full workout.
  async function handleSetLogged(detail) {
    const { exercises = [], text = '' } = detail || {};
    if (!exercises.length) return;
    if (text) chatTurns.push({ role: 'user', text });

    const handle = appendAtlasBubble();
    if (!handle) return;
    const { bubble, body } = handle;

    for (const ex of exercises) {
      bubble.insertBefore(buildReadback(ex.exercise, ex.sets), body);
    }

    const primary = exercises[0];
    const code = liftCodeForExercise(primary.exercise);
    let rec = null;
    if (code) {
      try { if (typeof fetchReaction === 'function') rec = await fetchReaction(code); } catch { /* best effort */ }
    }

    const note = await getInWorkoutNote({
      liftCode: code,
      exerciseName: primary.exercise,
      todaySets: primary.sets,
      rec
    });
    await typeOut(body, note);
    chatTurns.push({ role: 'atlas', text: note });

    if (rec && rec.recommendation) {
      bubble.appendChild(buildNextPrescription(rec));
    }
  }

  // End-of-session review: the ONE Save. atlas:preview-ready now fires only on an
  // explicit end trigger (done/"log it", screenshot, or manual effort) — never
  // from logging a set — so this renders the single review card. Its Save / Edit
  // / Undo delegate to the existing #approve-btn / #parsed-rows-editor /
  // window.atlasUndoLastWrite — the write path itself is unchanged.
  async function handlePreviewReady(detail) {
    const { rows = [], liftCodes = [], effortOnly } = detail || {};
    if (!effortOnly && !liftCodes.length) return;       // nothing to review

    const handle = appendAtlasBubble();
    if (!handle) return;
    const { bubble, body } = handle;
    await typeOut(body, effortOnly
      ? "Here's your effort for today — give it a look before it goes to your sheet:"
      : "Solid session. Here's everything from our conversation — give it a look before it goes to your sheet:");
    bubble.appendChild(buildReviewCard(rows, liftCodes, effortOnly));
  }

  /* ===== Coach-nav wiring (avatar → Settings) =====
     The hamburger (#coach-menu-btn) is owned by drawer.js, which opens the
     side panel; navigation there routes through the existing tab controls. */

  document.querySelector('.coach-avatar')?.addEventListener('click', () => {
    document.getElementById('open-settings')?.click();
  });

  /* ===== Tiles + listeners ===== */

  // Freestyle: the user wants to log their own way. Hiding the home hero would
  // leave a blank screen (no greeting, no tiles, empty thread), so drop a short
  // Atlas bubble to ground the conversation and seed an example placeholder.
  //
  // We deliberately do NOT focus the composer here. Focusing pops the mobile
  // soft keyboard, which on the position:fixed coach surface shoves the pinned
  // composer up and compresses it — the box appears to shrink and move. The
  // composer's shape, size, and position must stay put when Freestyle is
  // tapped, so the lifter taps the box themselves when ready to type.
  async function startFreestyle() {
    hideHomeEmpty();
    setWorkoutPlaceholder('Bench 135 10/4, 225 5/2 x3');
    const handle = appendAtlasBubble();
    if (handle) {
      await typeOut(handle.body, "Freestyle it — log a set or ask anything, and I'll react as you go.");
    }
  }

  document.getElementById('suggested-tiles')?.addEventListener('click', e => {
    const tile = e.target.closest('.suggest-tile');
    if (!tile) return;
    if (tile.dataset.suggest === 'freestyle') {
      startFreestyle();
    } else {
      hideHomeEmpty();
      typeSuggestedWorkout();
    }
  });

  (function setGreeting() {
    const el = document.getElementById('coach-greeting');
    if (!el) return;
    const h = new Date().getHours();
    const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
    el.textContent = `Good ${part}, Dale.`;
  })();

  document.addEventListener('atlas:preview-ready', e => { handlePreviewReady(e.detail).catch(() => {}); });
  document.addEventListener('atlas:set-logged', e => { handleSetLogged(e.detail).catch(() => {}); });

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

    // SME first: a training-knowledge question gets a deterministic, LLM-free answer
    // from /api/coach/ask. Anything it has no card for (depth log_only / no answer) —
    // including data questions about the lifter's own history — falls through to the
    // Gemini coach below. READ-ONLY either way; a slow/failed SME never blocks the chat.
    try {
      const sme = await Promise.race([
        api('/api/coach/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('sme-timeout')), 4000))
      ]);
      const data = sme && sme.data;
      if (data && data.depth && data.depth !== 'log_only' && data.answer) {
        const cards = Array.isArray(data.cards) ? data.cards : [];
        const provenance = cards.length
          ? `\n\nBased on: ${cards.map(c => String(c).replace(/_/g, ' ')).join(', ')}`
          : '';
        return { message: data.answer + provenance, propose_edit: null, propose_note: null };
      }
    } catch { /* fall through to the Gemini coach */ }

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
