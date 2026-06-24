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
 * Coaching voice seam: getInWorkoutNote(facts) turns Atlas's deterministic
 * *facts* into the coach's *voice* via /api/coach/message (Gemini), falling back
 * to a deterministic one-line reaction whenever the LLM is unconfigured, slow,
 * or errors. The engine owns the numbers; the voice only words them. It returns
 * { note, effort_note, reroute } — `note` is the prose; `effort_note` and
 * `reroute` are the deterministic, engine-backed set-effort extras (PR 477).
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

  function buildReadback(name, sets, planStep) {
    const rb = elc('div', 'readback');
    const h = elc('div', 'rb-h');
    h.appendChild(elc('span', 'rb-ck', '✓'));
    h.appendChild(document.createTextNode(' ' + name));
    if (planStep) h.appendChild(elc('span', 'rb-step', planStep));
    rb.appendChild(h);
    const s = elc('div', 'rb-s');
    appendSetReadout(s, sets);
    rb.appendChild(s);
    return rb;
  }

  // Case-insensitive plan-step lookup: returns "X of N" when exerciseName matches
  // any entry in the active session's exercises list, null otherwise.
  function planStepFor(exerciseName, session) {
    if (!session) return null;
    const { exercises } = session;
    const key = String(exerciseName).toLowerCase();
    let idx = exercises.findIndex(e => String(e.name || '').toLowerCase() === key);
    if (idx === -1) {
      idx = exercises.findIndex(e => {
        const n = String(e.name || '').toLowerCase();
        return n.includes(key) || key.includes(n);
      });
    }
    return idx !== -1 ? `${idx + 1} of ${exercises.length}` : null;
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

  // Apple Watch metrics grid for the effort/screenshot review.
  function buildEffortGrid(effort) {
    const grid = elc('div', 'rv-effort');
    const items = [
      ['Duration', effort.duration],
      ['Active cal', effort.activeCalories],
      ['Total cal', effort.totalCalories],
      ['Avg HR', effort.averageHR != null ? `${effort.averageHR} bpm` : null],
      ['Peak HR', effort.peakHR != null ? `${effort.peakHR} bpm` : 'not in screenshot']
    ].filter(([, v]) => v != null && v !== '');
    for (const [label, value] of items) {
      grid.appendChild(elc('span', 'rv-effort-label', label));
      grid.appendChild(elc('span', 'rv-effort-value', String(value)));
    }
    return grid;
  }

  function buildReviewCard(rows, liftCodes, effortOnly, effort) {
    const card = elc('div', 'review');

    const head = elc('div', 'rv-h');
    head.appendChild(elc('span', 'rv-t', "Today’s workout"));
    head.appendChild(elc('span', 'rv-d', (rows[0] && rows[0][0]) ? String(rows[0][0]) : ''));
    card.appendChild(head);

    // Watch metrics first, then the workout summary, then one Save.
    if (effort) card.appendChild(buildEffortGrid(effort));

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

    if (exCount) {
      const tot = elc('div', 'rv-tot');
      tot.appendChild(elc('span', null, `${exCount} exercise${exCount === 1 ? '' : 's'} · ${setCount} sets`));
      tot.appendChild(elc('b', null, `${Math.round(volume).toLocaleString()} lb`));
      card.appendChild(tot);
    } else if (effortOnly) {
      card.appendChild(elc('div', 'rv-tot', 'Effort only — no sets logged this session'));
    }

    // The "+ add effort" hint only on the workout-only ("done") path.
    if (!effort && !effortOnly) {
      card.appendChild(elc('div', 'rv-eff', '+ add Apple Watch effort (duration, cals, HR)'));
    }

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

  // Format one suggested-workout set as "{weight}lbs {reps}/{rir}". RIR is NEVER
  // silently dropped: when the engine gave no RIR we render "/?", never a bare
  // "{weight}lbs {reps}". Pure (no DOM, no closure deps) so it is unit-testable.
  function formatPlanSetLine(ex) {
    const rir = (ex.rir != null && Number.isFinite(Number(ex.rir))) ? `${ex.rir}` : '?';
    return `${ex.weight}lbs ${ex.reps}/${rir}`;
  }

  // Format one engine-owned warm-up (priming) set as "{weight}lbs {reps} · warm-up".
  // These are the lead compound's ramp into its working weight (the engine's
  // warmup_sets, SESSION_DESIGN.md "Set progression"). They are PLANNED priming
  // sets — never working sets, never save-ready — so they carry no RIR and are
  // visually marked "warm-up" to keep planned warm-ups distinct from logged work.
  function formatWarmupSetLine(s) {
    return `${s.weight}lbs ${s.reps} · warm-up`;
  }

  // The engine attaches warmup_sets only to a session's lead compound; everything
  // else (later compounds, accessories) has none and stays flat. Read off the raw
  // intent exercise (normalizePlanExercise intentionally drops warmup_sets).
  function warmupSetsFor(raw) {
    return (raw && Array.isArray(raw.warmup_sets)) ? raw.warmup_sets : [];
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
      // Warm-up ramp first (main compounds only) — climb into the working sets.
      for (const w of warmupSetsFor(raw)) lines.push(formatWarmupSetLine(w));
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
      // Warm-up ramp first (main compounds only). Marked with its own class so the
      // planned priming sets read as a build-up, visually distinct from the
      // working sets below — they are never loggable / save-ready rows.
      for (const w of warmupSetsFor(raw)) {
        const warm = document.createElement('div');
        warm.className = 'workout-plan-set workout-plan-warmup';
        warm.textContent = formatWarmupSetLine(w);
        exEl.appendChild(warm);
      }
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

  // Compact, parse-safe lift aliases for the composer placeholder (to save space).
  // Each alias round-trips through the parser's canonicalizer back to the SAME lift
  // (verified in test/coachConversation.test.js), so a hint never resolves to the
  // wrong exercise if the lifter types it. Ambiguous shorts ("Row", "LatPD",
  // "Incline") are deliberately omitted — they don't canonicalize cleanly — so
  // those lifts keep their full canonical name (which also parses). Full names are
  // unchanged in the workout DISPLAY; this only compacts the composer hint.
  const COMPOSER_ALIASES = [
    [/^bench press$/i, 'Bench'],
    [/^back squat$/i, 'Squat'],
    [/^(conventional |sumo )?deadlift$/i, 'DL'],
    [/^romanian deadlift$|^rdl$/i, 'RDL'],
    [/^overhead press$/i, 'OHP'],
    [/^dips?(\s*\(weighted\))?$/i, 'Dip'],
  ];
  function composerLiftAlias(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) return '';
    for (const [re, alias] of COMPOSER_ALIASES) if (re.test(n)) return alias;
    return n; // full canonical name — also parses cleanly
  }

  // Build the compact composer hint for ONE planned lift: short alias, the engine's
  // warm-up ramp marked "wu", then the working-set target in Atlas shorthand with
  // repeated sets collapsed as "xN" — e.g. "Bench 140x15wu 190x10wu 230 5/2 x3".
  // Warm-ups are DISPLAY-ONLY: they carry no RIR, are tagged "wu", and the parser
  // ignores a "{w}x{r}wu" token (it isn't a valid set), so a submitted hint logs
  // only the working sets — never a save-ready warm-up. Reads warmup_sets off the
  // RAW intent exercise (normalizePlanExercise drops them). Returns null when no
  // working target is known (caller falls back to its previous behaviour).
  function compactPrescription(raw) {
    const ex = (typeof normalizePlanExercise === 'function') ? normalizePlanExercise(raw) : raw;
    if (!ex || !ex.name || ex.weight == null || ex.reps == null) return null;
    const parts = [composerLiftAlias(ex.name)];
    for (const w of warmupSetsFor(raw)) {
      if (w && w.weight != null && w.reps != null) parts.push(`${w.weight}x${w.reps}wu`);
    }
    let sets = Number(ex.sets);
    if (!Number.isFinite(sets) || sets < 1) sets = 1;
    sets = Math.min(sets, 10);
    if (ex.rir == null || ex.rir === '') {
      // No RIR → a "{weight} {reps} xN" hint does NOT round-trip (bare-reps lists
      // mis-parse), so emit a single clean "{weight} {reps}" token instead of a
      // collapsed set. Mirrors formatNextPlaceholder; plan entries carry a
      // target_rir in production, so this is a defensive fallback.
      parts.push(`${ex.weight} ${ex.reps}`);
    } else {
      const working = `${ex.weight} ${ex.reps}/${ex.rir}`;
      parts.push(sets > 1 ? `${working} x${sets}` : working);
    }
    return parts.join(' ');
  }

  // Build the composer placeholder from the first (current) plan exercise — the
  // compact full prescription (warm-ups + working sets), not just the lead set.
  function buildWorkoutPlaceholder(exercises) {
    if (!exercises || !exercises.length) return null;
    return compactPrescription(exercises[0]);
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
    if (ta && text) {
      ta.placeholder = text;
      // Step 382 (#402B): once coach-conversation owns the composer placeholder
      // (a suggested workout, freestyle hint, or plan-complete prompt), the generic
      // home placeholder rotation in nav.js must yield. Otherwise it overwrites this
      // every few seconds with rotating hints like "Say 'log it' to save your
      // session" — putting save-ready pressure on a screen where nothing has been
      // performed or logged yet.
      document.dispatchEvent(new CustomEvent('atlas:placeholder-owned'));
    }
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

  /* ===== Coaching voice — the live seam ===== */

  // facts = {
  //   liftCode, exerciseName,
  //   todaySets: [{ weight, reps, rir }],   // what was just previewed
  //   rec,                                   // /api/recommend/next payload (or null)
  // }
  const COACH_LLM_TIMEOUT_MS = 9000;

  // In-workout note: conversational prose only. The structured readback already
  // shows the sets and the .nextp card shows the prescription, so the templated
  // fallback is just the one-line reaction (no set/next repetition).
  // When a substitution is present, it is passed in facts so the LLM addresses
  // it in one integrated response. The fallback appends the templated line after
  // the opener so no separate substitution box is needed.
  // Returns { note, effort_note, reroute }. `note` is the conversational prose
  // (LLM if available, else the templated opener). `effort_note` and `reroute`
  // are the deterministic, engine-backed set-effort extras the server computes
  // (PR 477 wiring) — present whether or not Gemini answered, and rendered as
  // their own short line so the engine's read is never lost to an LLM outage.
  async function getInWorkoutNote(facts) {
    const data = await getLlmCoachingMessage(facts).catch(() => null);
    const llm = data && typeof data.message === 'string' ? data.message : null;
    const effort_note = data && typeof data.effort_note === 'string' && data.effort_note.trim()
      ? data.effort_note.trim() : null;
    const reroute = data && data.reroute && typeof data.reroute === 'object' ? data.reroute : null;
    const voice = data && data.voice && typeof data.voice === 'object' ? data.voice : null;
    const subVoice = data && data.sub_voice && typeof data.sub_voice === 'object' ? data.sub_voice : null;
    // Substitution acknowledgement (slice 2): the deterministic pivot line from the
    // renderer wins over the templated classification copy; for a non-pivot swap the
    // template still words it. Computed once so every return path below can append it.
    const sub = facts.substitution;
    const subLine = (subVoice && subVoice.primary_line)
      || (sub && sub.classification ? coachVoiceTemplates.templatedSubstitutionLine(sub) : null);
    const withSub = base => (subLine ? base + '\n\n' + subLine : base);
    // PR 484 — deterministic LLM-down voicing of the training-intelligence advisories.
    // When Gemini is down the engine's next-move heads-up (Fatigue Router) and recovery
    // read (Recovery/Deload Selection) still ride in `data` but go unworded; surface
    // them so the engine's intelligence is never lost to an outage. When the LLM
    // answered, it already worded them (coach prompt rules), so these are appended on
    // the DETERMINISTIC paths ONLY — never on the LLM-prose path (which would duplicate).
    const nextMoveLine = data ? coachVoiceTemplates.templatedNextMoveAdvisoryLine(data.next_move_advisory) : null;
    const recoveryLine = data ? coachVoiceTemplates.templatedRecoveryAdvisoryLine(data.recovery_advisory) : null;
    const joinLines = (...lines) => lines.filter(Boolean).join('\n\n');
    // Deterministic Coach Voice Renderer wins. When a non-neutral set-effort signal
    // (redline / rep-drop / pressing-yellow / underdose / isolation caution) owns
    // the reaction, render its primary_line and NEVER the generic/LLM prose — the
    // server has already nulled contradictory prose; this is the visual backstop.
    if (voice && voice.suppress_generic_prose && voice.primary_line) {
      // A recovery read OVERRIDES a `bump` set line. `bump` ("more left in the tank —
      // add weight") is the one suppressed-prose severity that is itself a progression
      // invite, so pairing it with a back-off recovery read would be the exact
      // "add load + back off" contradiction this slice prevents (the two are computed
      // independently server-side, so they CAN co-occur). Every other suppressed
      // severity (block / caution / on_target) is consistent with backing off and keeps
      // the headline; the advisories then follow as complementary lines.
      if (recoveryLine && voice.severity === 'bump') {
        return { note: withSub(joinLines(recoveryLine, nextMoveLine)), effort_note, reroute, voice };
      }
      return { note: withSub(joinLines(voice.primary_line, nextMoveLine, recoveryLine)), effort_note, reroute, voice };
    }
    // LLM prose present means the server did NOT suppress it (no good-pivot lecture);
    // it already addresses the swap AND the advisories in one integrated voice — trust as-is.
    if (llm && llm.trim()) return { note: llm, effort_note, reroute, voice };
    // LLM down: conclusion-first. A recovery read is the headline and OVERRIDES a
    // progression-invite opener so the fallback never pairs "add load" with "back off".
    if (recoveryLine) {
      return { note: withSub(joinLines(recoveryLine, nextMoveLine)), effort_note, reroute, voice };
    }
    // LLM down / suppressed (incl. a good pivot): prefer the engine's correct-effort
    // line (on-target praise) when offered, else the templated opener, then the
    // next-move heads-up, then the swap.
    const opener = (voice && voice.primary_line) || coachOpener(facts.todaySets || [], facts.rec);
    return { note: withSub(joinLines(opener, nextMoveLine)), effort_note, reroute, voice };
  }

  // Returns the full /api/coach/message data object ({ message, effort_note,
  // reroute }) or null — the caller pulls the prose and the engine extras from it.
  async function getLlmCoachingMessage(facts) {
    if (typeof api !== 'function' || (typeof getApiKey === 'function' && !getApiKey())) return null;
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), COACH_LLM_TIMEOUT_MS));
    const request = api('/api/coach/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facts })
    }).then(res => (res && res.data) || null);
    return Promise.race([request, timeout]);
  }

  // De-templating: several phrasings per verdict level so the SAME verdict never
  // produces an identical note twice in a session. Numbers stay locked — only the
  // prose varies. `far_easy` reads as under-effort ("add weight"), never as a
  // praised on-target set. "add load or reps" stays in the easy copy on purpose.
  const VERDICT_VARIANTS = {
    failure: [
      'That last set went to the well — you hit failure. Back off the load and bank clean reps before pushing again.',
      'You buried that one — that set hit failure. Drop the weight a touch and rebuild with clean reps.',
      'Nothing left in the tank there — that was failure. Ease off the load and groove a few crisp sets before loading back up.'
    ],
    far_easy: [
      'Way too light — you left a stack of reps in reserve, well under your target effort. Add real weight next time.',
      'That barely registered — far below the effort you were aiming for. Put meaningfully more on the bar next set.',
      "Too easy to count as a working set — that's under-effort, not on-target. Bump the load up next time."
    ],
    easy: [
      'Plenty left in reserve on that one — it was well within target. Room to add load or reps next time.',
      'Comfortable — you stayed inside your target. A little more load or an extra rep next time.',
      'That had room to spare, just inside target. Nudge the load or chase a rep next time.'
    ],
    hard: [
      'Tough set — right up against your target effort. Strong stimulus.',
      'A grinder — right at your target. Quality work.',
      'Right at the edge of target — hard, productive set.'
    ],
    on_target: [
      'Dialled in — that landed right on your target effort.',
      'Bang on target — that effort was exactly where you want it.',
      'Right on the money — that set hit your target effort.'
    ]
  };
  // Per-level rotation index, lives for the page session, so two failure sets (or
  // two of any level) in one session never read back the identical sentence.
  const verdictRotation = {};
  function pickVerdictLine(level) {
    const variants = VERDICT_VARIANTS[level];
    if (!variants || !variants.length) return null;
    const i = (verdictRotation[level] || 0) % variants.length;
    verdictRotation[level] = (verdictRotation[level] || 0) + 1;
    return variants[i];
  }

  function coachOpener(todaySets, rec) {
    // The engine's effort verdict (logged RIR vs target) is authoritative — lead
    // with it so the note reflects what actually happened, not canned praise.
    // Phrasing rotates per verdict level (see pickVerdictLine) to de-template.
    const verdict = rec && rec.effort_verdict;
    if (verdict && verdict.level) {
      const line = pickVerdictLine(verdict.level);
      if (line) return line;
    }

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

  /* ===== Event wiring (read-only narration of app.js's trust loop) ===== */

  // Resolve a lift code from the catalog datalist (value=name, label=code) so
  // the next-prescription can be fetched without any dry-run/preview request.
  function liftCodeForExercise(name) {
    const dl = document.getElementById('exercise-catalog');
    if (!dl || !name) return null;
    const key = String(name).toLowerCase();
    const opts = Array.from(dl.options || []);
    // Exact name first; then an alias/contains fallback (mirrors planStepFor /
    // getNextExerciseInPlan) so a shorthand like "Lat pull" still resolves to the
    // "Lat Pulldown" code — without it the post-log next-prescription card silently
    // doesn't render for shorthand-logged lifts.
    let opt = opts.find(o => (o.value || '').toLowerCase() === key);
    if (!opt) {
      opt = opts.find(o => {
        const v = (o.value || '').toLowerCase();
        return v && (v.includes(key) || key.includes(v));
      });
    }
    return opt ? (opt.label || null) : null;
  }

  // Given an exercise name just logged, look up the next exercise in the
  // ordered plan. Primary: API plan from getPlanTodayByName (canonical names +
  // full prescription). Fallback: activePlannedSession exercises — handles API
  // failures and name mismatches (e.g. "Bench" vs "Barbell Bench Press").
  // Returns the display name of the N+1 entry, or null. Best-effort, never throws.
  async function getNextExerciseInPlan(exerciseName) {
    const key = String(exerciseName).toLowerCase();
    if (typeof getPlanTodayByName === 'function') {
      let map;
      try { map = await getPlanTodayByName(); } catch { map = null; }
      // keep in sync with nextExerciseFromPlan in services/sessionPlanExecutor.js
      if (map && map.size) {
        const keys = Array.from(map.keys());
        let idx = keys.indexOf(key);
        if (idx === -1) idx = keys.findIndex(k => k.includes(key) || key.includes(k));
        if (idx !== -1) {
          // Found in the API plan — it is authoritative. Last entry → no handoff.
          if (idx >= keys.length - 1) return null;
          const nextRec = map.get(keys[idx + 1]);
          return (nextRec && (nextRec.exercise_name || nextRec.exercise)) || null;
        }
      }
    }
    // Fallback: use the in-memory active planned session only when the API plan
    // is unavailable or the logged name doesn't match any API plan entry.
    const session = typeof getActivePlannedSession === 'function' ? getActivePlannedSession() : null;
    if (session) {
      const { exercises } = session;
      let idx = exercises.findIndex(e => String(e.name || '').toLowerCase() === key);
      if (idx === -1) {
        idx = exercises.findIndex(e => {
          const n = String(e.name || '').toLowerCase();
          return n.includes(key) || key.includes(n);
        });
      }
      if (idx !== -1 && idx < exercises.length - 1) return exercises[idx + 1].name || null;
    }
    return null;
  }

  // Build the composer placeholder for the next plan exercise: the prescription
  // written out, ONE "{reps}/{rir}" token per prescribed set, bare weight (no
  // "lbs"), no "xN" — e.g. "Face Pull 45 15/4 15/4 15/4". Reads the /api/plan/today
  // shape (next_target.{weight,reps,sets} + target_rir), falling back to flat
  // target_* fields. Returns the name alone when weight/reps are missing. The
  // numbers come straight from the engine's plan — nothing is invented here.
  function formatNextPlaceholder(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const name = rec.exercise_name || rec.exercise || '';
    const t = rec.next_target && typeof rec.next_target === 'object' ? rec.next_target : {};
    const weight = t.weight != null ? t.weight : rec.target_weight;
    const reps = t.reps != null ? t.reps : rec.target_reps;
    const rir = rec.target_rir;
    let sets = Number(t.sets != null ? t.sets : rec.target_sets);
    if (!Number.isFinite(sets) || sets < 1) sets = 1;
    sets = Math.min(sets, 10);
    if (!name || weight == null || reps == null) return name || null;
    // With an RIR, write each set out ("45 15/4 15/4 15/4") — that parses back
    // cleanly into N sets. WITHOUT one, a repeated bare-reps list ("50 15 15 15")
    // does NOT round-trip (the parser reads it as a single set), and inventing an
    // RIR is off-limits — so emit a single "{weight} {reps}" token that parses
    // cleanly. Plan entries carry a target_rir in production, so the RIR-less path
    // is a defensive fallback.
    if (rir == null || rir === '') return `${name} ${weight} ${reps}`;
    return `${name} ${weight} ${Array(sets).fill(`${reps}/${rir}`).join(' ')}`;
  }

  // In-workout: a logged set → readback (RIR in ember) + coach note + adjusted-
  // next prescription + next-exercise handoff. NO Save/preview/approve — the only
  // Save is the end-of-session review card below. Rendered purely from the
  // client-parsed sets; the set text is recorded so the end-of-session compile
  // can reconstruct the full workout.
  async function handleSetLogged(detail) {
    const { exercises = [], text = '', substitutions = [] } = detail || {};
    if (!exercises.length) return;
    if (text) chatTurns.push({ role: 'user', text });

    const handle = appendAtlasBubble();
    if (!handle) return;
    const { bubble, body } = handle;

    const activeSession = typeof getActivePlannedSession === 'function' ? getActivePlannedSession() : null;
    for (const ex of exercises) {
      bubble.insertBefore(buildReadback(ex.exercise, ex.sets, planStepFor(ex.exercise, activeSession)), body);
    }

    const primary = exercises[0];
    const code = liftCodeForExercise(primary.exercise);
    let rec = null;
    if (code) {
      // Anchor the recommendation on the set just logged (the last of this
      // exercise) — under session-level save it isn't in the sheet yet, so
      // without it the "Next" would reflect the previous session.
      const justLogged = primary.sets && primary.sets.length ? primary.sets[primary.sets.length - 1] : null;
      try { if (typeof fetchReaction === 'function') rec = await fetchReaction(code, justLogged); } catch { /* best effort */ }
    }

    // Pass the first substitution (if any) into the facts so the main LLM call
    // addresses it in one integrated response — no separate sub-note box needed.
    // Additional substitutions beyond the first are appended as inline text.
    const primarySub = substitutions.length ? substitutions[0] : undefined;

    const loggedName = primarySub && primarySub.logged && typeof primarySub.logged.name === 'string'
      ? primarySub.logged.name : '';
    const rawPrescribed = primarySub && primarySub.prescribed;
    const prescribedName = rawPrescribed && typeof rawPrescribed === 'object'
      ? (typeof rawPrescribed.name === 'string' ? rawPrescribed.name : '')
      : (typeof rawPrescribed === 'string' ? rawPrescribed : '');
    const suggestMatch = lastSuggestion
      && typeof lastSuggestion.recommendation === 'string'
      && typeof lastSuggestion.prescribed === 'string'
      && loggedName !== ''
      && prescribedName !== ''
      && loggedName.toLowerCase() === lastSuggestion.recommendation.toLowerCase()
      && prescribedName.toLowerCase() === lastSuggestion.prescribed.toLowerCase();
    if (suggestMatch) lastSuggestion = null;

    const reaction = await getInWorkoutNote({
      liftCode: code,
      exerciseName: primary.exercise,
      todaySets: primary.sets,
      rec,
      planned_queue: Array.isArray(detail.plannedQueue) ? detail.plannedQueue : [],
      substitution: suggestMatch ? undefined : primarySub
    });
    const note = reaction.note;
    await typeOut(body, note);
    chatTurns.push({ role: 'atlas', text: note });

    if (suggestMatch && loggedName) {
      const ack = document.createElement('div');
      ack.className = 'coach-msg';
      const ackText = (primarySub && primarySub.classification === 'preserved')
        ? `Good call — you went with ${loggedName}. Intent preserved.`
        : `You went with ${loggedName}.`;
      await typeOut(ack, ackText);
      bubble.appendChild(ack);
    }

    // Deterministic, engine-backed set-effort line (PR 477). One short line only —
    // it never expands into a full-session recap. When the Coach Voice Renderer is
    // suppressing generic prose, the note ABOVE already IS the deterministic
    // reaction (voice.primary_line incorporates this observation), so skip the
    // separate line to avoid saying it twice.
    if (reaction.effort_note && !(reaction.voice && reaction.voice.suppress_generic_prose)) {
      const eff = document.createElement('div');
      eff.className = 'coach-msg effort-note';
      await typeOut(eff, reaction.effort_note);
      bubble.appendChild(eff);
    }

    if (rec && rec.recommendation) {
      bubble.appendChild(buildNextPrescription(rec));
    }

    // If the input had more than one substitution (unusual), append each extra
    // inline below the prescription — still no separate box.
    for (const sub of substitutions.slice(1)) {
      if (!sub || !sub.classification) continue;
      const extra = document.createElement('div');
      extra.className = 'coach-msg';
      await typeOut(extra, coachVoiceTemplates.templatedSubstitutionLine(sub));
      bubble.appendChild(extra);
    }

    // Closeout wins when all planned exercises are done — check BEFORE calling
    // getNextExerciseInPlan so out-of-order completions don’t produce a spurious
    // “next up: C” when C was already logged earlier in the session.
    // detail.planIsComplete is computed in emitSetLogged (public/app.js);
    // keep in sync with services/sessionCloseout.js.
    // Next-up first: prefer the authoritative `detail.nextPlanned` (the first
    // planned lift not yet completed, deterministic). Only when there's none do we
    // fall back to the /api/plan/today lookup — and that fallback must NOT resurrect
    // an already-completed lift (its order can diverge from what was logged; that
    // was the "wanted weighted dips again" bug). A genuine next-up wins over the
    // closeout; closeout fires only when the plan is complete AND nothing is next.
    const lastLogged = exercises[exercises.length - 1];
    let nextEx = detail.nextPlanned || await getNextExerciseInPlan(lastLogged.exercise);
    if (nextEx && !detail.nextPlanned) {
      const done = (detail.completed || []).some(c => String(c).toLowerCase() === String(nextEx).toLowerCase());
      if (done) nextEx = null;
    }
    if (!nextEx && detail.planIsComplete) {
      const session = typeof getActivePlannedSession === 'function' ? getActivePlannedSession() : null;
      const count = session ? session.exercises.length : null;
      const closeout = document.createElement('div');
      closeout.className = 'session-closeout';
      closeout.textContent = count
        ? `That's your plan done — ${count} exercise${count !== 1 ? 's' : ''} complete. Say "done" or take a screenshot to save.`
        : 'Plan complete. Say "done" or take a screenshot to save.';
      bubble.appendChild(closeout);
      setWorkoutPlaceholder('Say "done" to save your session');
    } else {
      if (nextEx) {
        const handoff = document.createElement('div');
        handoff.className = 'next-exercise-handoff';
        // When the engine flags a same-prime-mover conflict, word its reroute
        // suggestion instead of the plain next-up. Suggestion-only — the plan,
        // cursor, and composer placeholder below are unchanged.
        handoff.textContent = (reaction.reroute && reaction.reroute.line)
          ? reaction.reroute.line
          : `Moving on — next up: ${nextEx}.`;
        bubble.appendChild(handoff);
        // Advance the composer placeholder to the next exercise’s FULL prescription
        // (each set written out) so the lifter can log it without scrolling back to
        // the plan. Falls back to the bare name if the plan entry has no numbers.
        let placeholder = nextEx;
        try {
          const map = (typeof getPlanTodayByName === 'function') ? await getPlanTodayByName() : null;
          const nextRec = map ? map.get(String(nextEx).toLowerCase()) : null;
          placeholder = formatNextPlaceholder(nextRec) || nextEx;
        } catch { /* best effort — fall back to the name */ }
        setWorkoutPlaceholder(placeholder);
      }
    }
  }

  // End-of-session review: the ONE Save. atlas:preview-ready now fires only on an
  // explicit end trigger (done/"log it", screenshot, or manual effort) — never
  // from logging a set — so this renders the single review card. Its Save / Edit
  // / Undo delegate to the existing #approve-btn / #parsed-rows-editor /
  // window.atlasUndoLastWrite — the write path itself is unchanged.
  async function handlePreviewReady(detail) {
    const { rows = [], liftCodes = [], effortOnly, effort, substitutions = [] } = detail || {};
    if (!effortOnly && !liftCodes.length) return;       // nothing to review

    const handle = appendAtlasBubble();
    if (!handle) return;
    const { bubble, body } = handle;
    let intro = effort
      ? "Here's your effort and the full session — give it a look before it goes to your sheet:"
      : "Solid session. Here's everything from our conversation — give it a look before it goes to your sheet:";
    // Fold substitution verdicts into the intro paragraph so the coach reads as
    // one voice — no stacked diagnostic boxes below the review card.
    const subLines = (substitutions || [])
      .filter(s => s && s.classification)
      .map(s => coachVoiceTemplates.templatedSubstitutionLine(s));
    if (subLines.length) intro += '\n\n' + subLines.join('\n');
    await typeOut(body, intro);
    bubble.appendChild(buildReviewCard(rows, liftCodes, effortOnly, effort));
  }

  // Tracks the last substitute suggestion so handleSetLogged can acknowledge it
  // rather than re-voice the same quality rationale through the LLM.
  // Consumed on first match — one acknowledgment per suggestion per session.
  let lastSuggestion = null;

  /* ===== Proactive substitute recommendation (atlas:substitute-suggested) ===== */

  // Renders a coach-voice Atlas bubble when a constraint message is detected
  // during an active planned session. No LLM — all text is derived from the
  // recommendation engine's quality tier and reason string via formatSubstituteCoachLine.
  async function handleSubstituteSuggested(detail) {
    const text = coachVoiceTemplates.formatSubstituteCoachLine(detail || {});
    if (!text) return;
    const handle = appendAtlasBubble();
    if (!handle) return;
    await typeOut(handle.body, text);
    const { prescribed, recommendation } = detail || {};
    if (prescribed && typeof recommendation === 'string') {
      lastSuggestion = { prescribed, recommendation };
    }
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
  document.addEventListener('atlas:substitute-suggested', e => { handleSubstituteSuggested(e.detail).catch(() => {}); });

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

    // P0 — Active Session Context Integrity: during an active workout, short
    // workout-state questions ("RIR?", "reps?", "how much", "what next") must be
    // answered from the live session prescription, not intercepted by the generic
    // training-knowledge SME. When an active session/plan/preview exists AND the
    // message is session-shaped, skip the SME and go straight to the session-aware
    // coach below. Education ("what does RIR mean?") and anything ambiguous are NOT
    // session-shaped, so they keep the existing SME-first routing untouched.
    const ctx = context || {};
    // An active workout is signalled by a started plan, a live preview, or a
    // started planned session (plan_completed present). But a *free-form coaching
    // conversation* — the lifter chatting with the coach mid-workout without having
    // started a planned session or run a dry-run preview — carries none of those
    // client flags, even though the server-side coach has full training context.
    // Live testing (2026-06-20) showed "RIR?" leaking to SME education in exactly
    // that state. Treat an in-progress conversation (prior turns exist) as active
    // context too, so session shorthand still routes to the session-aware coach.
    const inCoachingConversation = Array.isArray(history) && history.length > 0;
    const hasActiveWorkout =
      (Array.isArray(ctx.current_plan) && ctx.current_plan.length > 0) ||
      (Array.isArray(ctx.current_preview) && ctx.current_preview.length > 0) ||
      Array.isArray(ctx.plan_completed) || // present whenever an activePlannedSession exists
      inCoachingConversation;
    const sessionShaped = typeof sessionQuestion !== 'undefined'
      && sessionQuestion.isSessionStateQuestion(message);
    // Named-lift value questions ("what's the RIR for bench?") aren't matched by the
    // bare-shape classifier, so they leaked to the SME and got generic education.
    // When the named lift is in the live plan/preview, treat it as session-shaped so
    // it routes to the session-aware coach (which answers from the current plan).
    const planLiftNames = [
      ...(Array.isArray(ctx.current_plan) ? ctx.current_plan.map(p => p && (p.name || p.exercise)) : []),
      ...(Array.isArray(ctx.current_preview) ? ctx.current_preview.map(p => p && p.exercise) : []),
    ].filter(Boolean);
    const plannedLiftValue = typeof sessionQuestion !== 'undefined'
      && typeof sessionQuestion.isPlannedLiftQuestion === 'function'
      && sessionQuestion.isPlannedLiftQuestion(message, planLiftNames);
    const skipSme = hasActiveWorkout && (sessionShaped || plannedLiftValue);

    // SME first: a training-knowledge question gets a deterministic, LLM-free answer
    // from /api/coach/ask. Anything it has no card for (depth log_only / no answer) —
    // including data questions about the lifter's own history — falls through to the
    // Gemini coach below. READ-ONLY either way; a slow/failed SME never blocks the chat.
    if (!skipSme) try {
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

    // The chat round-trip is heavier than a set reaction (4 Sheets reads + context
    // build + up to an 8s Gemini call) AND, when Gemini is down, the server returns
    // a deterministic engine answer only after that attempt. Give it more room than
    // the 9s reaction budget so that fallback actually reaches the lifter instead of
    // the generic "Coach is unavailable" line firing first.
    const CHAT_REPLY_TIMEOUT_MS = 15000;
    const timeout = new Promise(resolve => setTimeout(() => resolve({ message: null, propose_edit: null, propose_note: null }), CHAT_REPLY_TIMEOUT_MS));
    const request = api('/api/coach/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: history.slice(-8), context: context || {} })
    }).then(res => ({
      message: (res && res.data && res.data.message) || null,
      propose_edit: (res && res.data && res.data.propose_edit) || null,
      propose_note: (res && res.data && res.data.propose_note) || null,
      propose_constraint: (res && res.data && res.data.propose_constraint) || null
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

  // Show a "Save this constraint?" prompt under Atlas's bubble. Calls POST
  // /api/constraints on approval; disappears on skip. Same trust loop as notes —
  // never saves silently. constraint is { kind, target, rule, note }.
  function showSaveConstraintPrompt(bubble, constraint) {
    const wrap = document.createElement('div');
    wrap.className = 'propose-note-wrap';

    const ruleVerb = { avoid: 'avoid', limit: 'limit', substitute: 'substitute' }[constraint.rule] || constraint.rule;
    const summary = `${ruleVerb} ${constraint.target} (${constraint.kind})`;

    const label = document.createElement('p');
    label.className = 'propose-note-label';
    label.textContent = `Save constraint: ${summary}`;

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'propose-note-save-btn';
    saveBtn.textContent = 'Save constraint';

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
        const writeId = `constraint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await api('/api/constraints', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: constraint.kind,
            target: constraint.target,
            rule: constraint.rule,
            note: constraint.note || '',
            write_id: writeId
          })
        });
        label.textContent = 'Constraint saved.';
        saveBtn.remove();
        skipBtn.remove();
      } catch {
        saveBtn.textContent = 'Save constraint';
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
    // Skip + workout notation: user noted a substitution — acknowledge the skip without
    // claiming it was classified or logged.
    if (/\bskipp?ed?\b/.test(t) && /\d/.test(t)) {
      return "Noted the skip. Keep logging and say \"log it\" when you're done — I'll review the full session then.";
    }
    // Looks like workout notation (has numbers) — don't suggest format correction
    if (/\d/.test(t)) {
      return "Noted — keep logging and say \"log it\" when you're done; I'll compile everything then.";
    }
    return "Coach is unavailable right now — try again in a moment.";
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

    let chatResult = { message: null, propose_edit: null, propose_note: null, propose_constraint: null };
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

    // Show "Save this constraint?" prompt if Atlas proposed a structured constraint.
    // Same explicit-approval trust loop as notes — at most one proposal per reply.
    if (chatResult.propose_constraint && chatResult.propose_constraint.target) {
      showSaveConstraintPrompt(bubble, chatResult.propose_constraint);
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
