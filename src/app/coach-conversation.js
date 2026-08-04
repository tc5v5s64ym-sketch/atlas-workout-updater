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
 * Reuses app.js globals (top-level fns): api, isConnected, fetchReaction,
 * previewSetsForLift, normalizePlanExercise.
 * Reuses nav.js: window.atlasChipAnswerLast.
 */

import * as coachVoiceTemplates from './coachVoiceTemplates.js';
import * as sessionQuestion from './sessionQuestion.js';
import {
  beginTurnResponse,
  cancelTurnResponse,
  completeTurnResponse,
  isTurnResponseAuthoritative,
  mayContinueTurnResponse,
} from './turnCorrelation.js';

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

  // Bodyweight sets carry no load (weight null/''/0) and must read as reps —
  // never "0×20" (owner live find, 2026-07-03: Hanging Knee Raises readback).
  // Shared by the readback tile, the review-card set line, and the opener.
  function hasLoad(weight) {
    return weight != null && weight !== '' && Number(weight) !== 0;
  }

  // Collapse consecutive identical sets into one group with a count — so logging the
  // same set three times summarizes ("225×5 RIR 2 ×3") instead of repeating itself
  // (PR-11 Bug 3). Only CONSECUTIVE identical sets merge; a warm-up climb stays listed.
  // ONE grouping source of truth, shared by the readback tile and the review-card line.
  function groupConsecutiveSets(sets) {
    const groups = [];
    for (const s of (Array.isArray(sets) ? sets : [])) {
      const key = `${s.weight}|${s.reps}|${s.rir}`;
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.count += 1;
      else groups.push({ key, set: s, count: 1 });
    }
    return groups;
  }

  // "135×12 RIR 4 · 185×10 RIR 2 · 225×5 RIR 0 ×3" — RIR always in ember; RIR 0 /
  // failure gets the brighter "max" treatment; identical sets carry a "×N" count.
  // Appends into `target`.
  function appendSetReadout(target, sets) {
    groupConsecutiveSets(sets).forEach((g, i) => {
      const s = g.set;
      if (i) target.appendChild(document.createTextNode(' · '));
      target.appendChild(document.createTextNode(hasLoad(s.weight) ? `${s.weight}×${s.reps} ` : `${s.reps} reps `));
      if (s.rir != null && Number.isFinite(Number(s.rir))) {
        const failure = Number(s.rir) <= 0;
        const rir = elc('span', failure ? 'rir rir-max' : 'rir', `RIR ${s.rir}`);
        target.appendChild(rir);
      }
      if (g.count > 1) target.appendChild(document.createTextNode(` ×${g.count}`));
    });
  }

  function buildReadback(name, sets, planStep, unverified) {
    const rb = elc('div', 'readback');
    const h = elc('div', 'rb-h');
    h.appendChild(elc('span', 'rb-ck', '✓'));
    h.appendChild(document.createTextNode(' ' + name));
    // Card/advisory consistency (owner 07-02): when the parser couldn't verify the
    // lift name (the "I don't recognize …" advisory fired), the card says so too —
    // the sets ARE captured, but the name is marked instead of shown with a bare ✓
    // that contradicts the advisory. Editable before save via Edit rows.
    if (unverified) h.appendChild(elc('span', 'rb-unverified', 'check name'));
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
    wrap.appendChild(elc('div', 'nextp-h', 'Next time:'));
    wrap.appendChild(elc('div', 'nextp-s', rec.recommendation));
    return wrap;
  }

  /* ===== End-of-session review card (reskins the existing approve/write/undo) ===== */

  let currentReview = null;

  // ── Two different facts, and a card may only claim the one it owns ────────────
  //
  // After a committed-rows / unverified-seal closeout there are THREE honest states
  // a review card can be in, and collapsing any two of them produces a false claim
  // about the owner's data:
  //
  //   1. rows-written          — the rows THIS card stages are the ones in the sheet.
  //   2. prior-rows-committed  — earlier rows from this session are in the sheet, but
  //                              the rows THIS card stages are not.
  //   3. (default)             — nothing from this session is in the sheet.
  //
  // Both wrong answers here were shipped and caught in review, one each way. Binding
  // the fact to the card instance let a rebuilt card fall back to (3) and say
  // "Nothing's saved yet" over committed rows. Binding it to the whole session let a
  // rebuilt card claim (1) — so editing 225 → 235 and re-previewing produced a card
  // for the 235 preview reading "Your sets are saved to the sheet" when only the 225
  // rows had landed. The second is the worse of the two: it invites the owner to walk
  // away from work that was never written.
  //
  // THE CONTRACT, stated rather than left to fall out of the code: only the card
  // instance that was live at the moment of the commit may claim (1). Every card
  // rebuilt afterwards gets (2) for as long as the session fact holds.
  //
  // This deliberately declines the weaker option of re-claiming (1) whenever the
  // rebuilt rows happen to match the committed ones. A re-preview stages a NEW write
  // in app.js regardless of what the rows say, so matching text would be describing
  // provenance it cannot establish — and (2) is true in that case anyway, so the
  // stricter rule costs nothing and can never overclaim.
  let priorRowsCommitted = false;
  const approveBtn = document.getElementById('approve-btn');
  const loggerStatusEl = document.getElementById('logger-status');

  // The approval gate lives in app.js: #approve-btn is only enabled once a
  // dry-run preview has proven no-write safety. Mirror its disabled state onto
  // the review card's Save so it can never write before the gate allows it.
  //
  // F-SB1-B (Stage B workout 1, 2026-08-01): mirror the RETRY LABEL too. After an
  // unverified closeout app.js re-enables the gate and relabels it 'Retry ledger seal',
  // but the owner never sees #approve-btn — he sees this card's Save, which its own click
  // handler left reading 'Saving…'. He was told to tap Save again while looking at a button
  // still claiming to save, and reported the session as lost. Scoped to that one label so
  // the error branch below keeps owning its own 'Save workout' reset.
  const RETRY_LABEL = 'Retry ledger seal';
  if (approveBtn) {
    new MutationObserver(() => {
      if (!currentReview || currentReview.done) return;
      currentReview.saveBtn.disabled = approveBtn.disabled;
      if (approveBtn.textContent === RETRY_LABEL) currentReview.saveBtn.textContent = RETRY_LABEL;
    }).observe(approveBtn, { attributes: true, attributeFilter: ['disabled'] });
  }

  // Group consecutive identical sets — "225 × 10 · RIR 2  ×3" — via the shared grouper.
  function buildReviewSetLine(sets) {
    const span = elc('span', 'rv-es');
    groupConsecutiveSets(sets).forEach((g, i) => {
      if (i) span.appendChild(document.createTextNode('  '));
      span.appendChild(document.createTextNode(hasLoad(g.set.weight) ? `${g.set.weight} × ${g.set.reps} ` : `${g.set.reps} reps `));
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
    // An HR that arrives as an empty string must not render as a bare "bpm" (owner
    // 07-02 screenshot) — treat empty exactly like null: Avg HR row drops, Peak HR
    // row says "not in screenshot".
    const hr = v => (v != null && v !== '' ? `${v} bpm` : null);
    const items = [
      ['Duration', effort.duration],
      ['Active cal', effort.activeCalories],
      ['Total cal', effort.totalCalories],
      ['Avg HR', hr(effort.averageHR)],
      ['Peak HR', hr(effort.peakHR) || 'not in screenshot']
    ].filter(([, v]) => v != null && v !== '');
    for (const [label, value] of items) {
      grid.appendChild(elc('span', 'rv-effort-label', label));
      grid.appendChild(elc('span', 'rv-effort-value', String(value)));
    }
    return grid;
  }

  // B5: the review card's date notice. The card is the single review surface on the
  // conversation UI (the legacy #preview-content panel is hidden), so the resolved
  // workout date and its source must be visible HERE before the owner approves.
  // 'screenshot' / 'manual' render a quiet confirmation line; 'today_fallback' warns
  // and offers an inline date correction that re-runs the SAME preview flow — setting
  // #log-date via a real input event (latching logDateManuallyEntered in app.js) and
  // re-dispatching the logger-form submit, so payload, session id, and this card all
  // re-resolve on the corrected date. Read-only: nothing here writes; the corrected
  // preview still goes through the unchanged approve gate.
  // The shared date-correction row: a date input + "Use this date" that re-runs the
  // SAME preview flow — setting #log-date via a real input event (latching
  // logDateManuallyEntered in app.js), clearing the stale session_id, and
  // re-dispatching the logger-form submit so payload, session id, and this card all
  // re-resolve together. Read-only: nothing here writes; the corrected preview still
  // goes through the unchanged approve gate.
  function buildDateFixRow(currentDate) {
    const row = elc('div', 'rv-date-fix');
    const input = document.createElement('input');
    input.type = 'date';
    input.value = currentDate;
    input.setAttribute('aria-label', 'Workout date');
    const applyBtn = elc('button', 'btn rv-date-apply', 'Use this date');
    applyBtn.type = 'button';
    applyBtn.addEventListener('click', () => {
      if (!input.value) return;
      const logDate = document.getElementById('log-date');
      const form = document.getElementById('logger-form');
      if (!logDate || !form) return;
      logDate.value = input.value;
      // A REAL input event — app.js listens for it to latch logDateManuallyEntered,
      // which makes the corrected date win the server-side resolution on re-preview.
      logDate.dispatchEvent(new Event('input', { bubbles: true }));
      // Drop the stale server-resolved session_id (app.js latched the OLD date's id
      // into the field on the first preview) so the re-preview re-derives the id from
      // the corrected date — otherwise the Effort/Log row's session_id encodes the
      // wrong date while the date column shows the corrected one. (Review PR #795.)
      const staleSid = document.getElementById('log-session-id');
      if (staleSid) staleSid.value = '';
      applyBtn.textContent = 'Re-previewing…';
      applyBtn.disabled = true;
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    row.appendChild(input);
    row.appendChild(applyBtn);
    return row;
  }

  function buildDateNotice(dateInfo) {
    if (!dateInfo || !dateInfo.date || !dateInfo.source) return null;
    const wrap = elc('div', 'rv-date');
    if (dateInfo.source === 'screenshot') {
      // The screenshot date passed the plausibility guard, but the model can still
      // read a wrong (plausible) year off a cropped or odd header — so the accepted
      // date is correctable here too, not just on the fallback path (07-02 incident:
      // an invented year was shown truthfully but couldn't be fixed on the card).
      wrap.appendChild(elc('div', 'rv-date-ok', `Date from screenshot: ${dateInfo.date}`));
      const fixLink = elc('a', 'rv-date-edit', 'Wrong date? Fix it');
      fixLink.href = '#';
      fixLink.addEventListener('click', e => {
        e.preventDefault();
        if (wrap.querySelector('.rv-date-fix')) return;
        wrap.appendChild(buildDateFixRow(dateInfo.date));
      });
      wrap.appendChild(fixLink);
      return wrap;
    }
    if (dateInfo.source === 'manual') {
      wrap.appendChild(elc('div', 'rv-date-ok', `Date: ${dateInfo.date}`));
      return wrap;
    }
    if (dateInfo.source !== 'today_fallback') return null;
    // Honest fallback copy: distinguish "no date seen" from "a date was seen but
    // rejected as implausible" (e.g. a weekday-matched wrong year like 2020-06-28).
    wrap.appendChild(elc('div', 'rv-date-warn', dateInfo.rejected
      ? `⚠️ The screenshot's date reads ${dateInfo.rejected}, which doesn't look right — saving as ${dateInfo.date} (today) unless you set the real date:`
      : `⚠️ No date found on the screenshot — saving as ${dateInfo.date} (today). Wrong? Set the real date:`));
    wrap.appendChild(buildDateFixRow(dateInfo.date));
    return wrap;
  }

  function buildReviewCard(rows, liftCodes, effortOnly, effort, dateInfo) {
    const card = elc('div', 'review');

    const head = elc('div', 'rv-h');
    head.appendChild(elc('span', 'rv-t', "Today’s workout"));
    // B5: an effort-only save has no rows to derive the date from — fall back to the
    // resolved dateInfo so the card is never dateless.
    head.appendChild(elc('span', 'rv-d', (rows[0] && rows[0][0])
      ? String(rows[0][0])
      : (dateInfo && dateInfo.date ? String(dateInfo.date) : '')));
    card.appendChild(head);

    // B5: date source (and today-fallback correction) directly under the header.
    const dateNotice = buildDateNotice(dateInfo);
    if (dateNotice) card.appendChild(dateNotice);

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
    // CLIENT-1: pass THIS card's bound write identity so the undo path refuses if a
    // newer write has since superseded it — an older card can never delete a newer
    // write. Identity is bound at markReviewSaved time (below); null before then.
    undo.addEventListener('click', e => {
      e.preventDefault();
      if (typeof window.atlasUndoLastWrite === 'function') {
        window.atlasUndoLastWrite(review.identity);   // reuse the existing /api/log-workout/undo-last path
        undo.textContent = 'Undoing…';
      }
    });
    saved.appendChild(undo);
    card.appendChild(saved);

    const review = { card, saveBtn, done: false, rowsWritten: false, priorRows: false, identity: null };
    currentReview = review;
    // A card built AFTER the commit stages rows that are not in the sheet, so it may
    // never claim they are — but it also may not fall back to "Nothing's saved yet",
    // because earlier rows from this session did land. It gets the middle state.
    if (priorRowsCommitted) applyPriorRowsCommittedState(review);
    return card;
  }

  // CLIENT-1: once a newer write confirms, strip the live Undo from every OTHER
  // already-saved card so only the newest save is undoable from the thread. (The
  // request-layer identity guard in app.js is the belt-and-suspenders backstop.)
  function stripStaleUndoLinks(keepCard) {
    const thread = document.getElementById('thread-messages');
    if (!thread) return;
    thread.querySelectorAll('.review.done .rv-undo').forEach(link => {
      if (!keepCard || !keepCard.contains(link)) link.remove();
    });
  }

  function markReviewSaved() {
    if (!currentReview || currentReview.done) return;
    currentReview.done = true;
    // The seal verified, so the committed-but-unverified fact stops being true and
    // must not be inherited by a later card.
    priorRowsCommitted = false;
    currentReview.card.classList.add('done');
    // Bind the identity of the write this card represents so its Undo can be
    // refused after a later write, then retire every older card's Undo affordance.
    currentReview.identity = (typeof window.atlasCurrentWriteIdentity === 'function')
      ? window.atlasCurrentWriteIdentity() : null;
    stripStaleUndoLinks(currentReview.card);
  }

  // The rows are committed to the sheet; only the plan-ledger seal is unverified.
  //
  // This state was previously invisible on the card. app.js emitted its `warn` and
  // re-enabled the gate, but the observer above matched only `.ok` and `.error`, so
  // the card kept its pre-save body — including the note "Nothing's saved yet · this
  // is the only save". That sentence was now FALSE, and it is the exact reading that
  // made a real session look lost: the owner saw a card saying nothing had been saved
  // and a button asking him to act, with nothing anywhere telling him his sets were
  // already safe. (F-SB1-B fixed the other half of that report — the button label —
  // by mirroring 'Retry ledger seal' from #approve-btn. The note was left behind.)
  //
  // The card must NOT go `done`: the retry is still available and still the right
  // next tap, so `.rv-act` has to stay visible and a later successful retry must
  // still be able to reach markReviewSaved().
  //
  // State (1) — claimable ONLY by the card that was live at the commit. Its own rows
  // are the ones in the sheet.
  const ROWS_WRITTEN_NOTE = '✓ Your sets are saved to the sheet · only the plan-ledger check needs a retry';
  function applyRowsWrittenState(review) {
    if (!review || review.done || review.rowsWritten) return;
    review.rowsWritten = true;
    review.card.classList.add('rows-written');
    const note = review.card.querySelector('.rv-note');
    if (note) note.textContent = ROWS_WRITTEN_NOTE;
  }

  // State (2) — for every card built after the commit. It separates the two subjects
  // the single note used to conflate: what THIS card would save, and what is already
  // in the sheet. Saying only the first ("Nothing's saved yet") hides committed rows;
  // saying only the second ("Your sets are saved") claims these rows landed when they
  // did not. Both were shipped, and both were caught in review.
  //
  // The wording is PROVENANCE-NEUTRAL, and that is load-bearing. An earlier version
  // read "These edited sets…" — but this state is applied to every rebuilt card,
  // including one whose rows are byte-identical to the committed ones, where nothing
  // was edited. The contract above deliberately refuses to compare payloads, so the
  // note may not assert a difference the code has chosen not to establish. It says
  // only what is true of every carrier of this state: this preview has not been
  // saved, and earlier rows from the session have.
  const PRIOR_ROWS_NOTE = 'This preview isn’t saved yet · earlier sets from this session are already in the sheet';
  function applyPriorRowsCommittedState(review) {
    if (!review || review.done || review.rowsWritten || review.priorRows) return;
    review.priorRows = true;
    review.card.classList.add('prior-rows-committed');
    const note = review.card.querySelector('.rv-note');
    if (note) note.textContent = PRIOR_ROWS_NOTE;
  }

  function markReviewRowsWrittenLedgerUnverified() {
    if (!currentReview) return;
    // Latch the SESSION fact first, so it survives this card being replaced — but as
    // the weaker claim (2). Only this card, the one whose rows actually landed, gets
    // to make claim (1).
    priorRowsCommitted = true;
    applyRowsWrittenState(currentReview);
  }

  function markReviewUndone() {
    if (!currentReview) return;
    // The rows were deleted, so nothing is committed any more.
    priorRowsCommitted = false;
    const txt = currentReview.card.querySelector('.rv-saved-txt');
    if (txt) txt.textContent = '↩ Undone · nothing saved';
    const undo = currentReview.card.querySelector('.rv-undo');
    if (undo) undo.remove();
  }

  // app.js writes the result into #logger-status: `.status-msg.ok` on a write or
  // an undo (text "undone"), `.status-msg.error` on failure, and — for the one
  // outcome where the ROWS COMMITTED but the plan-ledger seal did not verify — a
  // `.status-msg.warn` carrying `data-atlas-state="rows-written-ledger-unverified"`.
  // Reflect that onto the review card — no change to the approve/undo handlers.
  //
  // That third case is matched on the STATE ATTRIBUTE, never on the message text.
  // `warn` is also how app.js reports a parse failure, an unrecognized exercise, and
  // an unreadable screenshot — all of which happen BEFORE any write, where the card's
  // "Nothing's saved yet" note is true and must stay. Only the marked one means the
  // sets are already in the sheet.
  const ROWS_WRITTEN_STATE = '[data-atlas-state="rows-written-ledger-unverified"]';
  if (loggerStatusEl) {
    new MutationObserver(() => {
      if (!currentReview) return;
      const ok = loggerStatusEl.querySelector('.status-msg.ok');
      const err = loggerStatusEl.querySelector('.status-msg.error');
      const rowsWritten = loggerStatusEl.querySelector(`.status-msg.warn${ROWS_WRITTEN_STATE}`);
      if (ok && /undone/i.test(ok.textContent || '')) {
        markReviewUndone();
      } else if (ok && !currentReview.done) {
        markReviewSaved();
      } else if (rowsWritten && !currentReview.done) {
        markReviewRowsWrittenLedgerUnverified();
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
  // "{weight}lbs {reps}". A load-less lift (accessory/bodyweight with no snapshot
  // weight — e.g. Face Pull) renders "{reps} reps/{rir}" so reps and RIR survive
  // instead of leaking a "nulllbs" (PR-12 Bug 2). Pure (no DOM, no closure deps)
  // so it is unit-testable.
  function formatPlanSetLine(ex) {
    const rir = (ex.rir != null && Number.isFinite(Number(ex.rir))) ? `${ex.rir}` : '?';
    // Bodyweight: mark "BW — N reps", never a meaningless "0lbs" and never the ambiguous
    // "N/M" that reads like a set count (F09E). Target RIR is shown only when applicable.
    if (isBodyweightTarget(ex)) {
      return (ex.rir != null && Number.isFinite(Number(ex.rir)))
        ? `BW — ${ex.reps} reps · RIR ${ex.rir}`
        : `BW — ${ex.reps} reps`;
    }
    const hasWeight = ex.weight != null && ex.weight !== '' && Number.isFinite(Number(ex.weight)) && Number(ex.weight) !== 0;
    return hasWeight ? `${ex.weight}lbs ${ex.reps}/${rir}` : `${ex.reps} reps/${rir}`;
  }

  // F09E: a zero-load target is a BODYWEIGHT lift (the engine emits weight 0 for lifts with
  // no load to carry — services/analytics.js next_target). A load-OMITTED accessory (e.g.
  // Face Pull, weight null/absent) is NOT bodyweight and keeps the "reps/RIR" form. Declared
  // after formatPlanSetLine but hoisted, so both render paths (and the plan-render test slice
  // that starts at formatPlanSetLine) see it.
  function isBodyweightTarget(ex) {
    return ex && ex.weight != null && ex.weight !== '' && Number(ex.weight) === 0;
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
      // Render the working sets whenever reps are known — a load-less accessory
      // (no snapshot weight) still shows reps/sets/RIR; the prescription never
      // disappears (PR-12 Bug 2). formatPlanSetLine handles the absent weight.
      if (raw && raw.unresolved_load) {
        // Requirement 2026-07-22: a requested-first lift the engine can't load yet
        // surfaces an EXPLICIT unresolved-LOAD state (never a fabricated number and
        // never a silently omitted field). Show the engine's reason verbatim.
        lines.push(raw.reason || `I don't have enough history to set a working weight for ${ex.name} yet — log a set or tell me a starting weight and I'll anchor it.`);
      } else if (ex.reps != null) {
        const count = (ex.sets != null && ex.sets > 1) ? ex.sets : 1;
        if (isBodyweightTarget(ex)) {
          lines.push(count > 1 ? `${formatPlanSetLine(ex)} ×${count}` : formatPlanSetLine(ex));
        } else {
          for (let i = 0; i < count; i++) lines.push(formatPlanSetLine(ex));
        }
      } else {
        // F09E: no confident rep target → ask rather than render a bare name.
        lines.push('confirm reps and sets — I don’t have a target for this yet');
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
      // Working sets render whenever reps are known — a load-less accessory
      // (no snapshot weight) still shows its reps/sets/RIR rather than collapsing
      // to a bare name (PR-12 Bug 2). formatPlanSetLine renders the absent weight.
      if (raw && raw.unresolved_load) {
        // Requirement 2026-07-22: a requested-first lift the engine can't load yet
        // surfaces an EXPLICIT unresolved-LOAD state — the exercise stays visible and
        // leads the plan, but its own line says the load is unresolved (never a
        // fabricated weight, never a silently dropped field). Marked with its own class
        // so it reads as "needs a starting weight", distinct from the F09E rep-clarify.
        const unresolved = document.createElement('div');
        unresolved.className = 'workout-plan-set workout-plan-unresolved-load';
        unresolved.textContent = raw.reason || `I don't have enough history to set a working weight for ${ex.name} yet — log a set or tell me a starting weight and I'll anchor it.`;
        exEl.appendChild(unresolved);
      } else if (ex.reps != null) {
        const count = (ex.sets != null && ex.sets > 1) ? ex.sets : 1;
        if (isBodyweightTarget(ex)) {
          // F09E: group identical bodyweight sets into ONE explicit "×N" line
          // ("BW — 15 reps ×3") so the set count is unambiguous.
          const set = document.createElement('div');
          set.className = 'workout-plan-set';
          set.textContent = count > 1 ? `${formatPlanSetLine(ex)} ×${count}` : formatPlanSetLine(ex);
          exEl.appendChild(set);
        } else {
          for (let i = 0; i < count; i++) {
            const set = document.createElement('div');
            set.className = 'workout-plan-set';
            set.textContent = formatPlanSetLine(ex);
            exEl.appendChild(set);
          }
        }
      } else {
        // F09E: no confident rep target — ASK rather than show a bare name or a
        // misleading isolated number. The exercise stays visible with a clarify prompt.
        const clarify = document.createElement('div');
        clarify.className = 'workout-plan-set workout-plan-clarify';
        clarify.textContent = 'confirm reps and sets — I don’t have a target for this yet';
        exEl.appendChild(clarify);
      }
      plan.appendChild(exEl);
      rendered++;
    }
    if (rendered) container.appendChild(plan);
    return rendered;
  }

  // The plan-card "Start this plan" button was retired in the composer-chat
  // simplification (owner). Acceptance still runs through the SAME app.js path
  // (window.atlasAcceptPlan / acceptDisplayedPlan) — it now fires automatically
  // when the first set is logged against the displayed plan (the app.js gate),
  // minting identity + the Session_Plans acceptance + the ledger checkpoint before
  // the set commits. The plan card is display-only; logging is the acceptance.

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

  // Build the compact composer hint from an ALREADY-NORMALIZED plan entry
  // (one that has `name`/`weight`/`reps`/`rir`/`sets` from normalizePlanExercise).
  // compactPrescription() expects the raw API shape and re-normalizes, which
  // double-maps `name` → liftCode → null; this variant skips that step.
  function compactPrescriptionFromNormalized(entry) {
    const name = entry && (entry.canonicalName || entry.name);
    const weight = entry && entry.weight;
    const reps = entry && entry.reps;
    const rir = entry && entry.rir;
    if (!name || weight == null || reps == null) return null;
    const alias = composerLiftAlias(name);
    let sets = Number(entry.sets);
    if (!Number.isFinite(sets) || sets < 1) sets = 1;
    sets = Math.min(sets, 10);
    if (rir == null || rir === '') return `${alias} ${weight} ${reps}`;
    const working = `${weight} ${reps}/${rir}`;
    return sets > 1 ? `${alias} ${working} x${sets}` : `${alias} ${working}`;
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
    if (typeof api !== 'function' || (typeof isConnected === 'function' && !isConnected())) return null;
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

  // Turn the composer-extracted generation constraints (extractGenerationConstraints:
  // { firstExercise, focus }) into the authoritative recommendation query string. This
  // is the ONLY channel by which a "Plan me a workout but have it start with back squats"
  // request reaches the plan — the constraints become structured planning INPUTS to the
  // deterministic engine (services/planFirstExercise.applyFirstExercise + upperOnly),
  // never a model-written exercise list. Empty/absent constraints → no params → the
  // plain recommendation, exactly as before.
  function buildIntentRecommendationQuery(constraints) {
    const c = constraints && typeof constraints === 'object' ? constraints : {};
    const params = [];
    if (typeof c.firstExercise === 'string' && c.firstExercise.trim()) {
      params.push('firstExercise=' + encodeURIComponent(c.firstExercise.trim()));
    }
    if (typeof c.focus === 'string' && c.focus.trim()) {
      params.push('focus=' + encodeURIComponent(c.focus.trim()));
    }
    return params.length ? '?' + params.join('&') : '';
  }

  async function typeSuggestedWorkout(constraints) {
    hideHomeEmpty();
    // A fresh session re-announces its first next-up: clear any stale handoff memory
    // from a prior (possibly abandoned, no-closeout) session so the first handoff is
    // never wrongly suppressed by a name collision (PR-575 review).
    lastAnnouncedNextUp = null;
    // The lifter engaged Coach's Pick — only now does today's suggestion count as an
    // active plan (so the post-log handoff / composer / next_move advisory may follow
    // it). A merely-displayed pick must never drive those; see app.js plannedExerciseEntries.
    if (typeof setCoachSuggestionEngaged === 'function') setCoachSuggestionEngaged(true);
    const handle = appendAtlasBubble();
    if (!handle) return;
    const { body } = handle;

    // Server-authoritative: never pre-block on a synchronous guess. isConnected() is
    // false only once the SERVER has confirmed this browser is unauthenticated (a real
    // 401 / a sessions-enabled status saying so) — an optimistic 'unknown' still attempts
    // the read below and lets the server's 401, not a client flag, drive the prompt.
    if (typeof isConnected === 'function' && !isConnected()) {
      await typeOut(body, "Connect Atlas in Settings and I'll suggest today's session.");
      return;
    }
    body.textContent = 'Reading your recent training…';
    try {
      const res = await api('/api/plan/intent-recommendation' + buildIntentRecommendationQuery(constraints));
      const data = res.data || {};
      // Keep the acceptance gate's source aligned with the plan we're about to show:
      // logging the first set from this pick auto-accepts it (the retired button used
      // to carry the exact rec), and the gate reads the displayed plan from
      // lastIntentData — which this coach fetch, unlike loadDashboard, would otherwise
      // never refresh. See window.atlasSyncDisplayedIntent (app.js).
      if (typeof window !== 'undefined' && typeof window.atlasSyncDisplayedIntent === 'function') {
        window.atlasSyncDisplayedIntent(data);
      }
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
      const completedNow = typeof getSessionCompleted === 'function' ? getSessionCompleted() : [];
      const pendingExercises = completedNow.length
        ? exercises.filter(e => {
            const n = ((typeof normalizePlanExercise === 'function' ? normalizePlanExercise(e) : e).name || '').toLowerCase();
            return !completedNow.some(c => String(c || '').toLowerCase() === n);
          })
        : exercises;
      setWorkoutPlaceholder(buildWorkoutPlaceholder(pendingExercises.length ? pendingExercises : exercises));
    } catch (err) {
      body.textContent = '';
      if (err && err.status === 401) {
        // The server actually rejected the request — the owner is not connected on this
        // device. This is the ONLY path that prompts to connect (never a client flag).
        await typeOut(body, "Connect Atlas in Settings and I'll suggest today's session.");
      } else if (err && !err.status) {
        // Transport failure / cold-start drop — a connection problem, NOT a missing key.
        await typeOut(body, "The connection dropped — give the server a few seconds to wake up, then ask again.");
      } else {
        await typeOut(body, "I couldn't pull a suggestion just now — but start logging and I'll react as you go.");
      }
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
  async function getInWorkoutNote(facts, sessionId, responseTicket) {
    const data = await getLlmCoachingMessage(facts, sessionId, responseTicket).catch(() => null);
    // Soul Recovery (Issue #1073) + owner gate ruling (2026-07-20): a routine on-plan
    // block's voice is timed to the EXERCISE, not to every set. A COMPLETED on-plan
    // exercise (a batch of sets, or the finishing set — `facts.exercise_complete`) gets
    // ONE brief, data-grounded acknowledgement ("even if I'm on plan, let the coach say
    // that, grounded in the data … if there's context I wanna hear it"). An INTERMEDIATE
    // single set during per-set logging stays SILENT ("we don't want to be so chatty").
    // Either way the block stays MINIMAL — `ack_only:true` keeps the "Next time:" box and
    // the separate effort line suppressed. The retired "On plan — logged." receipt is gone
    // for good; this grounded wrap reflects the engine's read (matched top set, RIR
    // adherence, in-pocket, set count). A coach/network outage (data null) falls through to
    // the deterministic opener below unchanged.
    if (data && data.note_tier === 'ack_only') {
      const wrap = facts.exercise_complete
        ? coachVoiceTemplates.templatedOnPlanWrapLine(facts)
        : null;
      return { note: wrap, effort_note: null, reroute: null, voice: null, ack_only: true };
    }
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
    // PR-4 (composer-first Phase 0a) — tier-aware brevity on the deterministic
    // paths: a 'short'-tier block renders the headline ONLY, trimming the
    // supplementary lines (next-move heads-up, substitution ack). Per-set notes
    // carry no tier (null) → never brief → output byte-identical to before.
    // The recovery read below is deliberately NOT gated on `brief` — it is a
    // safety-class back-off signal and a brevity tier must never silence it.
    const brief = coachVoiceTemplates.isBriefTier(data && data.note_tier);
    const subLine = brief ? null : ((subVoice && subVoice.primary_line)
      || (sub && sub.classification ? coachVoiceTemplates.templatedSubstitutionLine(sub) : null));
    const withSub = base => (subLine ? base + '\n\n' + subLine : base);
    // PR 484 — deterministic LLM-down voicing of the training-intelligence advisories.
    // When Gemini is down the engine's next-move heads-up (Fatigue Router) and recovery
    // read (Recovery/Deload Selection) still ride in `data` but go unworded; surface
    // them so the engine's intelligence is never lost to an outage. When the LLM
    // answered, it already worded them (coach prompt rules), so these are appended on
    // the DETERMINISTIC paths ONLY — never on the LLM-prose path (which would duplicate).
    const nextMoveLine = (data && !brief) ? coachVoiceTemplates.templatedNextMoveAdvisoryLine(data.next_move_advisory) : null;
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
    const opener = (voice && voice.primary_line) || coachOpener(facts.todaySets || [], facts.rec, data && data.set_grade);
    return { note: withSub(joinLines(opener, nextMoveLine)), effort_note, reroute, voice };
  }

  // Returns the full /api/coach/message data object ({ message, effort_note,
  // reroute }) or null — the caller pulls the prose and the engine extras from it.
  async function getLlmCoachingMessage(facts, sessionId, responseTicket) {
    if (typeof api !== 'function' || (typeof isConnected === 'function' && !isConnected())) return null;
    const correlationSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    let selectedHeaders = null;
    const timeout = new Promise(resolve =>
      setTimeout(() => resolve({ selected: false, data: null }), COACH_LLM_TIMEOUT_MS));
    const request = api('/api/coach/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // kind:'block' routes the in-session per-exercise reaction through the
      // deterministic coachNoteTier gate so a routine block returns note_tier
      // ack_only (and the caller stays silent). Same wording pipeline as before
      // for non-routine blocks; the tier is never forwarded to the model.
      body: JSON.stringify({
        facts,
        kind: 'block',
        ...(correlationSessionId ? { session_id: correlationSessionId } : {}),
      }),
      ...(responseTicket ? {
        responseHeaders: responseHeaders => { selectedHeaders = responseHeaders; },
      } : {}),
    }).then(res => ({ selected: true, data: (res && res.data) || null }));
    const winner = await Promise.race([request, timeout]);
    if (responseTicket && typeof completeTurnResponse === 'function') {
      completeTurnResponse(responseTicket, selectedHeaders);
    }
    return winner.data;
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

  function coachOpener(todaySets, rec, grade) {
    // The engine's effort verdict (logged RIR vs target) is authoritative — lead
    // with it so the note reflects what actually happened, not canned praise.
    // Phrasing rotates per verdict level (see pickVerdictLine) to de-template.
    const verdict = rec && rec.effort_verdict;
    if (verdict && verdict.level) {
      // PR 484 (LLM-down stimulus_grade voicing): the raw effort verdict is profile-
      // BLIND. When it is a progression invite (`easy`/`far_easy` → "add load") but the
      // profile-aware governor grade wants to HOLD / back off (or flags fatigue), word
      // the governor's hold instead — so the offline opener never invites progression
      // the engine is holding (e.g. a general_fitness lifter already at goal effort).
      if (verdict.level === 'easy' || verdict.level === 'far_easy') {
        const holdLine = coachVoiceTemplates.governorOverridesProgressionInvite(grade)
          ? coachVoiceTemplates.templatedGovernorHoldLine(grade)
          : null;
        if (holdLine) return holdLine;
      }
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
        // F10 — exact key outranks substring; an AMBIGUOUS substring (>1 plan entry
        // matches) refuses to guess rather than silently pick the wrong slot's next-up.
        if (idx === -1) {
          const subs = keys.map((k, i) => ({ k, i })).filter(({ k }) => k.includes(key) || key.includes(k));
          if (subs.length === 1) idx = subs[0].i;
        }
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
        // F10 — only a UNIQUE substring match resolves the just-logged lift's slot;
        // an ambiguous overlap yields no handoff rather than advancing off the wrong slot.
        const subs = exercises
          .map((e, i) => ({ n: String(e.name || '').toLowerCase(), i }))
          .filter(({ n }) => n && (n.includes(key) || key.includes(n)));
        if (subs.length === 1) idx = subs[0].i;
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

  // The next-up lift last announced via a "Moving on — next up: X" handoff. Used to
  // suppress re-announcing the SAME next-up after every off-plan log (the live-gym
  // "Moving on — next up: Dumbbell Side Bend" broken-record). Reset at closeout.
  let lastAnnouncedNextUp = null;
  // Once the plan is exhausted, suppress the "Planned work done" closeout line from
  // re-firing on every subsequent off-plan set (the lifter may log extra work after
  // the plan finishes — the message should appear exactly once).
  let closeoutAnnounced = false;
  document.addEventListener('atlas:session-reset', () => {
    lastAnnouncedNextUp = null;
    closeoutAnnounced = false;
    // F10S5: a fresh session may legitimately repeat a substitution note.
    acknowledgedSubs.clear();
    // A new session has committed nothing yet. Carrying the previous session's
    // committed-rows fact forward would tell the owner rows from this session were
    // already in the sheet before he had saved anything.
    priorRowsCommitted = false;
  });

  // Build the composer placeholder for the next planned lift from the ACTIVE PLAN
  // entry's own prescription (it carries weight/reps/sets) — so a plan lift with no
  // training history (absent from /api/plan/today) still shows its full prescription
  // instead of falling back to the bare name. Returns null when not derivable.
  function nextUpPlaceholderFromPlan(nextEx) {
    const session = typeof getActivePlannedSession === 'function' ? getActivePlannedSession() : null;
    if (!session || !Array.isArray(session.exercises)) return null;
    const key = String(nextEx == null ? '' : nextEx).toLowerCase();
    const entry = session.exercises.find(e =>
      (e.canonicalName || e.name || '').toLowerCase() === key || (e.name || '').toLowerCase() === key);
    // entries in session.exercises are already normalized — use the normalized
    // variant to avoid double-normalization (which maps name → liftCode → null).
    return entry ? compactPrescriptionFromNormalized(entry) : null;
  }

  // In-workout: a logged set → readback (RIR in ember) + coach note + adjusted-
  // next prescription + next-exercise handoff. NO Save/preview/approve — the only
  // Save is the end-of-session review card below. Rendered purely from the
  // client-parsed sets; the set text is recorded so the end-of-session compile
  // can reconstruct the full workout.
  // The set-logged detail's `unverified` carries one name (string) or several
  // (array — a multi-line paste can have unknown names on multiple lines).
  function isUnverifiedName(unverified, name) {
    if (unverified == null || !name) return false;
    return Array.isArray(unverified) ? unverified.includes(name) : unverified === name;
  }

  // F10S5 (owner smoke 2026-07-18) — a substitution is acknowledged ONCE per session.
  // The server re-detects the same prescribed→logged pair on EVERY subsequent set of
  // the substitute, so without this gate the same commentary stacked once per
  // performed set (the July 18 closeout showed it three times). Keyed by the
  // case-insensitive pair; an unkeyable entry (missing names) passes through
  // untouched — never over-suppressed. Cleared on session reset.
  const acknowledgedSubs = new Set();
  function dedupeSubstitutions(subs) {
    const out = [];
    for (const s of (Array.isArray(subs) ? subs : [])) {
      const logged = s && s.logged && typeof s.logged.name === 'string' ? s.logged.name.trim() : '';
      const p = s && s.prescribed;
      const prescribed = p && typeof p === 'object'
        ? (typeof p.name === 'string' ? p.name.trim() : '')
        : (typeof p === 'string' ? p.trim() : '');
      if (!logged || !prescribed) { out.push(s); continue; }
      const key = `${prescribed.toLowerCase()}|${logged.toLowerCase()}`;
      if (acknowledgedSubs.has(key)) continue;
      acknowledgedSubs.add(key);
      out.push(s);
    }
    return out;
  }

  const setResponseTickets = new WeakMap();

  async function handleSetLogged(detail) {
    const responseTicket = detail && typeof detail === 'object'
      ? setResponseTickets.get(detail) || null
      : null;
    if (detail && typeof detail === 'object') setResponseTickets.delete(detail);
    const responseMayContinue = () => !responseTicket
      || (typeof mayContinueTurnResponse === 'function'
        && mayContinueTurnResponse(responseTicket));
    // Closeout is allowed to begin as soon as a valid response is selected, while its
    // already-selected prose may still be typing. Let only that selected prose finish;
    // every later side effect rechecks the stricter current-owner predicate above.
    const responseMayRenderSelectedProse = () => responseMayContinue()
      || (responseTicket && responseTicket.completed === true && responseTicket.accepted === true);
    const {
      exercises = [],
      text = '',
      sessionId = '',
      substitutions: rawSubstitutions = [],
      unverified = null,
    } = detail || {};
    // F10S5: acknowledge each substitution pair once per session (see above).
    const substitutions = dedupeSubstitutions(rawSubstitutions);
    if (!exercises.length) return;
    if (text) chatTurns.push({ role: 'user', text });

    const handle = appendAtlasBubble();
    if (!handle) return;
    const { bubble, body } = handle;

    const activeSession = typeof getActivePlannedSession === 'function' ? getActivePlannedSession() : null;
    // FA: render per lift as [card -> coaching -> Next] in order. Primary card before
    // `body` so a single-lift entry is byte-identical; additional lifts append their own
    // blocks (slice(1) loop). Session handoff runs once at the end. (docs/INVESTIGATION_2026-06-25b.md)
    const primary = exercises[0];
    bubble.insertBefore(buildReadback(primary.exercise, primary.sets, planStepFor(primary.exercise, activeSession),
      isUnverifiedName(unverified, primary.exercise)), body);
    const code = liftCodeForExercise(primary.exercise);
    let rec = null;
    if (code) {
      // Anchor the recommendation on the set just logged (the last of this
      // exercise) — under session-level save it isn't in the sheet yet, so
      // without it the "Next" would reflect the previous session.
      const justLogged = primary.sets && primary.sets.length ? primary.sets[primary.sets.length - 1] : null;
      try { if (typeof fetchReaction === 'function') rec = await fetchReaction(code, justLogged); } catch { /* best effort */ }
      if (!responseMayContinue()) return;
    }

    // Pass the first substitution (if any) into the facts so the main LLM call
    // addresses it in one integrated response — no separate sub-note box needed.
    // Additional substitutions beyond the first are appended as inline text.
    const primarySub = substitutions.length ? substitutions[0] : undefined;

    // Owner gate ruling (Issue #1073, 2026-07-20): the on-plan coaching line is timed to
    // the EXERCISE, not to every set — coach a block logged as a BATCH (all its sets in one
    // submission), and stay quiet on an intermediate single set during per-set logging so
    // the coach isn't chatty. A batch (two or more sets at once) is the reliable "the
    // exercise is done in this block" signal. NOTE (Codex P1): getSessionCompleted() marks
    // an exercise on its FIRST logged set (emitSetLogged, before dispatch), so it is eager
    // and cannot gate this — using it would make every per-set log "complete" and fire the
    // line repeatedly. Coaching the FINISHING set of a per-set-logged exercise in a guided
    // plan needs the canonical per-slot set count (planSlotStatuses) and is a follow-up.
    const exerciseIsComplete = (sets) => Array.isArray(sets) && sets.length >= 2;

    const reaction = await getInWorkoutNote({
      liftCode: code,
      exerciseName: primary.exercise,
      todaySets: primary.sets,
      rec,
      exercise_complete: exerciseIsComplete(primary.sets),
      // The active Coach's Pick intent drives the server's recovery read so a
      // recovery_pump / deload_reset session never gets an add-load nudge (BUG-204817).
      // Sourced via getActiveIntentId so an engaged-but-unmaterialized suggestion
      // (activePlannedSession still null) keeps its intent.
      intentId: (typeof getActiveIntentId === 'function' ? getActiveIntentId() : (activeSession && activeSession.intentId)) || null,
      planned_queue: Array.isArray(detail.plannedQueue) ? detail.plannedQueue : [],
      substitution: primarySub
    }, sessionId, exercises.length === 1 ? responseTicket : null);
    if (!responseMayRenderSelectedProse()) return;
    const note = reaction.note;
    // Soul Recovery (Issue #1073): a routine (ack_only) block returns a null note —
    // DELIBERATE SILENCE — so nothing is typed under the readback card and the logged
    // set stands on its own. A signal-carrying block returns its brief model/engine line.
    // `if (note)` guards both the routine-silence case and the genuinely-absent one.
    if (note) {
      await typeOut(body, note);
      if (!responseMayContinue()) return;
      chatTurns.push({ role: 'atlas', text: note });
    } else if (!responseMayContinue()) {
      return;
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
      if (!responseMayContinue()) return;
      bubble.appendChild(eff);
    }

    // A routine (ack_only) block stays minimal — deliberate silence is the whole
    // reaction; suppress the "Next time:" box (and the effort line above) too.
    if (!reaction.ack_only && rec && rec.recommendation) {
      bubble.appendChild(buildNextPrescription(rec));
    }

    // G2 + FA — coach EVERY logged lift, not just exercises[0], and render each as its
    // OWN block in order. The primary lift's [card -> coaching -> effort -> Next] is
    // rendered above; for each ADDITIONAL lift, append its own [card -> coaching note ->
    // next-set prescription] block so no logged lift goes un-coached and the blocks read
    // sequentially per exercise. The coaching prose is attributed by lift name. Single-
    // exercise entries have no additional lifts, so this loop is empty and their output
    // is byte-identical to before (session-level handoff/closeout below runs once, off
    // lastLogged).
    for (const ex of exercises.slice(1)) {
      // FA: each additional lift is its OWN block — its card first (appended in order,
      // after the primary block), then its coaching, then its Next.
      bubble.appendChild(buildReadback(ex.exercise, ex.sets, planStepFor(ex.exercise, activeSession),
        isUnverifiedName(unverified, ex.exercise)));
      const exCode = liftCodeForExercise(ex.exercise);
      let exRec = null;
      if (exCode) {
        const exJustLogged = ex.sets && ex.sets.length ? ex.sets[ex.sets.length - 1] : null;
        try { if (typeof fetchReaction === 'function') exRec = await fetchReaction(exCode, exJustLogged); } catch { /* best effort */ }
        if (!responseMayContinue()) return;
      }
      const exReaction = await getInWorkoutNote({
        liftCode: exCode,
        exerciseName: ex.exercise,
        todaySets: ex.sets,
        rec: exRec,
        exercise_complete: exerciseIsComplete(ex.sets),
        intentId: (typeof getActiveIntentId === 'function' ? getActiveIntentId() : (activeSession && activeSession.intentId)) || null,
        planned_queue: [],
        substitution: undefined
      }, sessionId, ex === exercises[exercises.length - 1] ? responseTicket : null);
      if (!responseMayRenderSelectedProse()) return;
      if (exReaction && exReaction.note) {
        const exMsg = document.createElement('div');
        exMsg.className = 'coach-msg';
        const exText = `${ex.exercise}: ${exReaction.note}`;
        await typeOut(exMsg, exText);
        if (!responseMayContinue()) return;
        bubble.appendChild(exMsg);
        chatTurns.push({ role: 'atlas', text: exText });
      } else if (!responseMayContinue()) {
        return;
      }
      // G2 follow-up (owner 2026-06-28): per-lift effort-line parity. Each additional
      // lift now renders its OWN deterministic, engine-backed effort line — the same
      // treatment the primary lift gets above — so a stacked entry surfaces every
      // lift's effort signal, not just the first. Same `suppress_generic_prose` guard
      // as the primary: when the voice renderer already folds the effort observation
      // into the prose note above, skip the separate line so it isn't said twice. Still
      // ONE line per LIFT, never one per set (the per-set contract is unchanged — a
      // lift's multiple sets collapse to a single effort line in the engine).
      if (exReaction && exReaction.effort_note && !(exReaction.voice && exReaction.voice.suppress_generic_prose)) {
        const exEff = document.createElement('div');
        exEff.className = 'coach-msg effort-note';
        await typeOut(exEff, exReaction.effort_note);
        if (!responseMayContinue()) return;
        bubble.appendChild(exEff);
      }
      if (!exReaction.ack_only && exRec && exRec.recommendation) {
        bubble.appendChild(buildNextPrescription(exRec));
      }
    }

    // If the input had more than one substitution (unusual), append each extra
    // inline below the prescription — still no separate box.
    for (const sub of substitutions.slice(1)) {
      if (!sub || !sub.classification) continue;
      const extra = document.createElement('div');
      extra.className = 'coach-msg';
      await typeOut(extra, coachVoiceTemplates.templatedSubstitutionLine(sub));
      if (!responseMayContinue()) return;
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
    // B4: only look up next-up when a plan is engaged (started session or accepted
    // Coach's Pick). Freestyle logging (empty plannedOrder) must parse, confirm,
    // coach, and stop — never auto-guide with "Moving on — next up: X".
    // SESS-1 (F09): this handoff/closeout runs AFTER up to two ~9s coach-LLM awaits
    // above (getInWorkoutNote), during which a CONCURRENT set-logged handler can
    // advance the canonical store. Re-derive next-up, the plan order, the completed
    // set, and plan-completeness from the LIVE store right here — never from the
    // emit-time `detail` snapshot — so a lift already logged by a later set is never
    // announced as "next up" and a superseded closeout never fires. Falls back to the
    // snapshot only when the bridged selectors are unavailable (source/eval harnesses).
    const liveRemaining = (typeof remainingPlannedExercises === 'function') ? remainingPlannedExercises() : null;
    const livePlannedOrder = (typeof plannedExerciseOrder === 'function') ? plannedExerciseOrder() : null;
    const liveCompleted = (typeof getSessionCompleted === 'function') ? getSessionCompleted() : null;
    const currentPlannedOrder = livePlannedOrder || detail.plannedOrder || [];
    const currentNextPlanned = liveRemaining ? (liveRemaining[0] || null) : detail.nextPlanned;
    const currentCompleted = liveCompleted || detail.completed || [];
    const currentPlanIsComplete = liveRemaining
      ? (currentPlannedOrder.length > 0 && liveRemaining.length === 0)
      : detail.planIsComplete;

    const hasEngagedPlan = currentPlannedOrder.length > 0;
    let nextEx = currentNextPlanned || (hasEngagedPlan ? await getNextExerciseInPlan(lastLogged.exercise) : null);
    if (!responseMayContinue()) return;
    if (nextEx && !currentNextPlanned) {
      const done = (currentCompleted || []).some(c => String(c).toLowerCase() === String(nextEx).toLowerCase());
      if (done) nextEx = null;
      // A fallback next-up must belong to the engaged plan — never a stored-program
      // lift the lifter isn't following (the live "next up: Hammer Curls" that wasn't
      // in the plan). Fuzzy match mirrors getNextExerciseInPlan.
      const plan = currentPlannedOrder.map(p => String(p || '').toLowerCase()).filter(Boolean);
      if (nextEx && plan.length) {
        const k = String(nextEx).toLowerCase();
        const inEngagedPlan = plan.some(p => p === k || p.includes(k) || k.includes(p));
        if (!inEngagedPlan) nextEx = null;
      }
    }
    if (!nextEx && currentPlanIsComplete) {
      if (!closeoutAnnounced) {
        const session = typeof getActivePlannedSession === 'function' ? getActivePlannedSession() : null;
        const count = session ? session.exercises.length : null;
        const closeout = document.createElement('div');
        closeout.className = 'session-closeout';
        // G3: the PLAN being exhausted does not mean the lifter is done — they may log
        // extra work beyond the plan. Word this as "planned work done, keep going or
        // save", never "session over", so Atlas doesn't surprise the lifter by declaring
        // them finished (the live "I'm not done, these are the first two" repro).
        closeout.textContent = count
          ? `That's your planned work done — ${count} exercise${count !== 1 ? 's' : ''} logged. Log anything else you do, or say "done" or upload a screenshot to save.`
          : 'Planned work done. Log anything else you do, or say "done" or upload a screenshot to save.';
        bubble.appendChild(closeout);
        setWorkoutPlaceholder('Log more, or say "done" to save');
        lastAnnouncedNextUp = null;   // plan done — a fresh session re-announces
        closeoutAnnounced = true;
      }
    } else {
      if (nextEx) {
        // Don't re-nag the SAME next-up after an off-plan log: announce a handoff
        // line only when the next-up actually changed since the last announcement
        // (a reroute suggestion always speaks — it's context-specific to this set).
        const isReroute = Boolean(reaction.reroute && reaction.reroute.line);
        const sameAsLast = lastAnnouncedNextUp
          && String(nextEx).toLowerCase() === String(lastAnnouncedNextUp).toLowerCase();
        // A slot still IN PROGRESS is not a handoff: never announce a lift that
        // already has logged sets this session while its slot is still the live
        // next-up verdict (remaining[0] — F10S1 keeps an under-count slot
        // remaining). Without this, a per-set handler deriving mid-slot found
        // remaining[0] = the slot the lifter is already on and announced it — the
        // wrong "Moving on — next up: Romanian Deadlift." card after set 1 of 3,
        // landing at a runner-speed-dependent moment. Both sides are store truth:
        // remaining[0] is the slot name and currentCompleted carries RESOLVED
        // canonical names, so an alias-form raw log ("RDL") cannot dodge the
        // guard. A genuine boundary still announces (the completed slot's
        // remaining[0] moves past the logged lift — including single-set slots),
        // an untouched next slot still announces after an off-plan log, and a
        // reroute always speaks. (A mid-slot off-plan log no longer re-announces
        // the in-progress slot — the pin already shows it.)
        const nextExKey = String(nextEx).toLowerCase();
        const stillOnLoggedSlot = Boolean(liveRemaining && liveRemaining[0]
          && String(liveRemaining[0]).toLowerCase() === nextExKey
          && (currentCompleted || []).some(c => String(c).toLowerCase() === nextExKey));
        if (isReroute || (!sameAsLast && !stillOnLoggedSlot)) {
          const handoff = document.createElement('div');
          handoff.className = 'next-exercise-handoff';
          // When the engine flags a same-prime-mover conflict, word its reroute
          // suggestion instead of the plain next-up. Suggestion-only — the plan,
          // cursor, and composer placeholder below are unchanged.
          handoff.textContent = isReroute
            ? reaction.reroute.line
            : `Moving on — next up: ${nextEx}.`;
          bubble.appendChild(handoff);
          if (!isReroute) lastAnnouncedNextUp = nextEx;
        }
        // Keep the composer pointed at the next exercise’s FULL prescription (each
        // set written out) so the lifter can log it without scrolling back to the
        // plan. Prefer the active PLAN entry's own numbers (a no-history plan lift
        // is absent from /api/plan/today); then the plan-today rec; then the name.
        let placeholder = nextUpPlaceholderFromPlan(nextEx);
        if (!placeholder) {
          try {
            const map = (typeof getPlanTodayByName === 'function') ? await getPlanTodayByName() : null;
            if (!responseMayContinue()) return;
            const nextRec = map ? map.get(String(nextEx).toLowerCase()) : null;
            placeholder = formatNextPlaceholder(nextRec) || nextEx;
          } catch { placeholder = nextEx; /* best effort — fall back to the name */ }
        }
        setWorkoutPlaceholder(placeholder);
      }
    }
  }

  // End-of-session review: the ONE Save. atlas:preview-ready now fires only on an
  // explicit end trigger (done/"log it", screenshot, or manual effort) — never
  // from logging a set — so this renders the single review card. Its Save / Edit
  // / Undo delegate to the existing #approve-btn / #parsed-rows-editor /
  // window.atlasUndoLastWrite — the write path itself is unchanged.
  // F10D — the single-confirmation session review (both truths, factually).
  // Renders the server-assembled closeout summary ABOVE the sets card: the
  // original accepted plan vs the final effective plan, per-set target-vs-actual,
  // substitutions/skips, no-reliable-target honesty, unplanned work, and exactly
  // what will be written and sealed. Numeric facts only — assessment wording is
  // F10E's. Warnings (unreadable ledger / inconsistent history) surface plainly.
  function buildCloseoutConfirm(s) {
    const wrap = document.createElement('div');
    wrap.className = 'closeout-confirm';
    const head = document.createElement('div');
    head.className = 'cc-head';
    head.textContent = `Session review${s.session_date ? ` — ${s.session_date}` : ''}`;
    wrap.appendChild(head);

    const line = (cls, text) => {
      const n = document.createElement('div');
      n.className = cls;
      n.textContent = text;
      wrap.appendChild(n);
    };

    if (s.ledger_read_failed) line('cc-warn', "Heads up: the plan ledger couldn't be read, so plan verification is unavailable for this save. Your sets still save normally.");
    if (s.malformed) line('cc-warn', 'Heads up: the stored plan history for this session is inconsistent — the plan ledger will not be sealed. Your sets still save normally.');

    // House convention (F09E): TRUE bodyweight is weight === 0 → "BW×reps"; an
    // ABSENT load (weight == null, e.g. a load-omitted accessory or a target with
    // reps but no reliable load) renders loadless "N reps" — never conflated with
    // bodyweight (Codex P2, PR #1069).
    const setTxt = (w, r, rir) => {
      const rirBit = rir != null ? `@${rir}` : '';
      const reps = r != null ? r : '?';
      if (w === 0) return `BW×${reps}${rirBit}`;
      if (w == null) return `${reps} reps${rirBit}`;
      return `${w}×${reps}${rirBit}`;
    };
    for (const item of (s.items || [])) {
      const name = item.name || item.planned_lift_code || 'Planned lift';
      const bits = [];
      for (const t of (item.target_vs_actual || [])) {
        const target = t.no_reliable_target ? 'no reliable target'
          : t.malformed ? 'target unavailable'
            : t.target_weight != null || t.target_reps != null ? setTxt(t.target_weight, t.target_reps, t.target_rir) : null;
        const actual = t.unperformed ? 'not performed'
          : t.actual_weight != null || t.actual_reps != null ? `did ${setTxt(t.actual_weight, t.actual_reps, t.actual_rir)}` : null;
        if (target && actual) bits.push(`${target} → ${actual}`);
        else if (target) bits.push(`${target} → not performed`);
        else if (actual) bits.push(`${t.extra ? 'extra: ' : ''}${actual}`);
      }
      // A substitution names what it stood in for — the ORIGINAL plan stays
      // visible on the card (owner contract), by name, never a bare code.
      const tag = item.outcome === 'substituted'
        ? ` (substituted — in for ${item.planned_name || item.planned_lift_code || 'planned lift'})`
        : item.outcome === 'skipped' ? ' (skipped)'
          : item.revised ? ' (revised mid-session)' : '';
      line('cc-item', `${name}${tag}: ${bits.join(' · ') || 'no sets'}`);
    }
    for (const up of (s.unplanned || [])) {
      const sets = (up.sets || []).map(x => setTxt(x.weight, x.reps, x.rir)).join(' · ');
      line('cc-unplanned', `${up.name || up.lift_code} (unplanned): ${sets}`);
    }

    const logCount = s.rows_to_write && Array.isArray(s.rows_to_write.log) ? s.rows_to_write.log.length : 0;
    const effortBit = s.rows_to_write && s.rows_to_write.effort ? ' + your effort row' : '';
    const sealBit = s.has_stored_plan && s.rows_to_seal && s.rows_to_seal.count
      ? `; ${s.rows_to_seal.count} plan-ledger row(s) will be sealed to this save` : '';
    line('cc-foot', `Approving writes ${logCount} set row(s)${effortBit}${sealBit}. Rejecting writes nothing.`);
    return wrap;
  }

  async function handlePreviewReady(detail) {
    const { rows = [], liftCodes = [], effortOnly, effort, substitutions = [], recap = null, dateInfo = null, closeoutSummary = null } = detail || {};
    if (!effortOnly && !liftCodes.length) return;       // nothing to review

    // If a review card already exists in the thread (e.g. the user added manual
    // effort after the initial workout preview), update that bubble in place instead
    // of appending a second one. Live tests require deployed code, but the pattern
    // is: first preview shows sets-only, "Add effort & preview" re-fires this
    // handler — we want one card, not two.
    const thread = document.getElementById('thread-messages');
    const existingCard = thread && thread.querySelector('.chat-bubble-atlas .review:not(.done)');
    let handle;
    if (existingCard) {
      const existingBubble = existingCard.closest('.chat-bubble-atlas');
      const existingBody = existingBubble && existingBubble.querySelector('.coach-msg');
      existingCard.remove();
      // F10D (Codex P2, PR #1069): a re-preview replaces the WHOLE confirmation —
      // drop the stale closeout summary too, so old write/seal counts can never
      // sit above the rebuilt Save card.
      const staleConfirm = existingBubble && existingBubble.querySelector('.closeout-confirm');
      if (staleConfirm) staleConfirm.remove();
      if (existingBody) existingBody.textContent = '';
      handle = existingBubble && existingBody ? { bubble: existingBubble, body: existingBody } : appendAtlasBubble();
    } else {
      handle = appendAtlasBubble();
    }
    if (!handle) return;
    const { bubble, body } = handle;
    // Honest intro (owner 07-02): an effort-only save must not promise "the full
    // session" — say plainly that no sets are in this save, so missing exercises
    // are noticed BEFORE approving, not after.
    let intro = effort
      ? (effortOnly
        ? "Here's your effort — heads up, no logged sets are in this save. Give it a look before it goes to your sheet:"
        : "Here's your effort and the full session — give it a look before it goes to your sheet:")
      : "Solid session. Here's everything from our conversation — give it a look before it goes to your sheet:";
    // Fold substitution verdicts into the intro paragraph so the coach reads as
    // one voice — no stacked diagnostic boxes below the review card.
    const subLines = (substitutions || [])
      .filter(s => s && s.classification)
      .map(s => coachVoiceTemplates.templatedSubstitutionLine(s));
    if (subLines.length) intro += '\n\n' + subLines.join('\n');
    // P0 wiring 2b: surface the canonical session's still-pending plan lifts (after
    // any swap/skip) so the recap reflects the ONE session state, not a stale plan.
    // recap is null unless work was actually logged (hasLoggedWork), so an
    // all-skipped/empty session never shows a "still on your plan" tail.
    const remaining = (recap && Array.isArray(recap.remaining)) ? recap.remaining.filter(Boolean) : [];
    if (remaining.length) intro += `\n\nStill on your plan: ${remaining.join(', ')}.`;
    await typeOut(body, intro);
    // F10D — the session-closeout confirmation sits ABOVE the sets card: the plan
    // review (both truths) first, then the exact rows the approval will write.
    if (closeoutSummary) bubble.appendChild(buildCloseoutConfirm(closeoutSummary));
    bubble.appendChild(buildReviewCard(rows, liftCodes, effortOnly, effort, dateInfo));
  }

  /* ===== Proactive substitute recommendation — RETIRED by F-SB3 (2026-08-02) =====
     A constraint-detected swap used to render its own coach-voice bubble here and park a
     `lastSuggestion` acknowledgment token. Both belonged to the losing substitution
     authority: the bubble announced a recommendation that no lane could accept, answer, or
     record. Every substitution recommendation is now the ONE gated proposal card
     (atlas:replacement-proposed), which carries the engine prescription and the Approve /
     Keep-it affordance, so this path had no producer left and is gone rather than left
     inert. See docs/ATLAS_SYSTEM_AUTHORITY.md §8b. */

  /* ===== Coach-nav wiring (avatar → Settings) =====
     The hamburger (#coach-menu-btn) is owned by drawer.js, which opens the
     side panel; navigation there routes through the existing tab controls. */

  document.querySelector('.coach-avatar')?.addEventListener('click', () => {
    document.getElementById('open-settings')?.click();
  });

  /* ===== The canonical pick lane + the coach-speaks-first opening ===== */

  // The home-screen quick-start tiles (Coach's Pick / Freestyle) were retired
  // by owner directive (2026-07-03) — the home screen is Atlas's guidance text
  // only. The pick stays reachable through the one composer lane (a typed
  // "what are we doing today?" routes here via looksLikeSessionRequest) and
  // through every Today-tab entry point; freestyle is simply logging a set
  // directly, which never engages the suggestion.

  // Composer-first Phase B — ONE canonical recommendation. Every "today's
  // recommendation" entry point outside this file (the Today tab's pick card,
  // its START SESSION button, nav.js's "Open today's session" link) routes to
  // this same in-thread Coach's Pick instead of a second drawer/card home, so
  // the pick renders once, in one place, with one engagement semantic.
  window.atlasOpenCoachPick = typeSuggestedWorkout;

  // Composer-first Phase A — the coach speaks first. The greeting renders
  // instantly and synchronously (deterministic — the hero is never blank).
  (function setGreeting() {
    const el = document.getElementById('coach-greeting');
    if (!el) return;
    const h = new Date().getHours();
    const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
    el.textContent = `Good ${part}, Dale.`;
  })();

  // Anti-repetition ledger (PR-2, display-only, no DB): a per-day ring buffer of
  // opener signatures in localStorage (modeled on the session-snapshot precedent).
  // If this exact engine read was already shown today, renderCoachOpening shows the
  // compressed continuation instead of re-briefing. Best-effort — any localStorage
  // failure (private mode / quota) degrades to always showing the full opener. It
  // only ever DE-DUPS an identical render; it never decides what to coach.
  const OPENER_LEDGER_KEY = 'atlas_opener_ledger_v1';
  const OPENER_LEDGER_CAP = 8;
  function openerAlreadyShownToday(signature, dayKey) {
    if (!signature || !dayKey) return false;
    try {
      const led = JSON.parse(localStorage.getItem(OPENER_LEDGER_KEY) || 'null');
      return !!(led && led.day === dayKey && Array.isArray(led.signatures) && led.signatures.includes(signature));
    } catch { return false; }
  }
  function recordOpenerShown(signature, dayKey) {
    if (!signature || !dayKey) return;
    try {
      let led = null;
      try { led = JSON.parse(localStorage.getItem(OPENER_LEDGER_KEY) || 'null'); } catch { led = null; }
      if (!led || led.day !== dayKey || !Array.isArray(led.signatures)) led = { day: dayKey, signatures: [] };
      if (!led.signatures.includes(signature)) {
        led.signatures.push(signature);
        if (led.signatures.length > OPENER_LEDGER_CAP) led.signatures = led.signatures.slice(-OPENER_LEDGER_CAP);
      }
      localStorage.setItem(OPENER_LEDGER_KEY, JSON.stringify(led));
    } catch { /* private mode / quota — degrade to no compression */ }
  }

  // Coach-first home opener (owner 2026-07-03, PR-1): paint the engine's spoken
  // DECISION into the hero and retire the dashboard chrome. app.js's loadDashboard
  // builds the opener deterministically from its own startup fetch (no second
  // call, no LLM) and hands it over via atlas:glance-ready; this upgrades
  // #coach-opening in place. The old "{Weekday}. Today's read: {label}." headline,
  // the stacked facts wall (streak + freshest patterns + days-since), and the
  // static tutorial guide are gone — the opener carries its own one-line
  // invitation. Guarded on the hero still showing; on any failure / empty history
  // / missing key / already-started conversation, nothing is dispatched and the
  // default tagline stands byte-identical (Contract voice invariant 7 — survives
  // an outage).
  function renderCoachOpening(detail) {
    const hero = document.getElementById('coach-empty');
    if (!hero || hero.hasAttribute('hidden')) return;  // conversation already started
    const d = detail || {};
    if (!d.opener) return;  // no engine read → the default tagline stands
    const line = document.getElementById('coach-opening');
    // Anti-repetition (PR-2, display-only): if this exact engine read was already
    // shown today, show the short continuation instead of re-briefing. Floored —
    // never blank; a new day or changed state gets a fresh full opener; any ledger
    // failure degrades to the full opener.
    let text = d.opener;
    if (d.compressed && openerAlreadyShownToday(d.signature, d.day)) {
      text = d.compressed;
    } else {
      recordOpenerShown(d.signature, d.day);
    }
    if (line) line.textContent = text;
    // The opener speaks the decision now, so retire the dashboard tells for good.
    const facts = document.getElementById('coach-facts');
    if (facts) facts.hidden = true;
    const guide = document.getElementById('coach-guide');
    if (guide) guide.hidden = true;
  }
  document.addEventListener('atlas:glance-ready', e => renderCoachOpening((e && e.detail) || {}));

  // The state-driven hero chips (renderCoachChips/emitChipSentence) were
  // retired with the tiles (owner directive, 2026-07-03) — the chip SENTENCES
  // live on in #coach-guide's copy, typed through the same one composer lane
  // the chips used.

  document.addEventListener('atlas:preview-ready', e => {
    handlePreviewReady(e.detail).catch(() => {
      // NEVER SILENT (P0 closeout trust): the dry-run preview succeeded server-side,
      // but rendering the in-thread review card threw. The composer was already
      // cleared by submit, so swallowing this left the lifter with no card, no save,
      // and no error (the live-gym "log it disappeared" bug). Surface it instead, and
      // point at the still-armed logger Save so the (no-write-proven) preview can be
      // approved manually — nothing was written.
      try {
        const node = appendAtlasBubble();
        if (node && node.body) {
          node.body.textContent = "I previewed your workout but couldn't render the review card here. Nothing was saved. Open the logger and tap Save to write it, or say \"done\" again.";
        }
      } catch { /* last-resort: never throw out of the listener */ }
    });
  });
  document.addEventListener('atlas:set-logged', e => {
    const detail = e.detail || {};
    const sessionId = typeof detail.sessionId === 'string' ? detail.sessionId.trim() : '';
    // Mint at logical set initiation, before recommendation/history awaits. Only the
    // final response for a multi-exercise batch receives this ticket because it is the
    // last Atlas turn displayed for the event.
    const responseTicket = sessionId
      && Array.isArray(detail.exercises) && detail.exercises.length
      && typeof beginTurnResponse === 'function'
      ? beginTurnResponse({ sessionId })
      : null;
    if (responseTicket && detail && typeof detail === 'object') {
      setResponseTickets.set(detail, responseTicket);
    }
    // Bound the whole set-response pipeline, including the recommendation read that
    // precedes /api/coach/message. Otherwise a stalled recommendation could keep an
    // immediate closeout waiting forever before the message timeout even starts.
    const settlementTimer = responseTicket
      ? setTimeout(() => cancelTurnResponse(responseTicket), COACH_LLM_TIMEOUT_MS)
      : null;
    handleSetLogged(detail).catch(() => {}).finally(() => {
      if (settlementTimer) clearTimeout(settlementTimer);
      // A rejected request or an early deterministic fallback must still release any
      // closeout waiting on this set. A successful selected response already completed
      // the ticket; the second call is an inert fail-closed no-op.
      if (responseTicket && typeof completeTurnResponse === 'function') {
        completeTurnResponse(responseTicket, null);
      }
    });
  });
  // F10D acceptance boundary — the boundary's DATA guarantee is intact (the app.js
  // gate still mints identity + the Session_Plans acceptance + the ledger
  // checkpoint before any set commits), but its in-thread "Start this plan to track
  // planned versus actual." card was retired in the composer-chat simplification.
  // A set logged from an unaccepted plan surface now auto-accepts SILENTLY in
  // app.js (the same window.atlasAcceptPlan path) and resumes through the one
  // submit path — so there is no blocking card here to render.
  // P0 Sub-PR 2a: a deterministic plan mutation (swap/skip applied to the canonical
  // session by app.js) — confirm it in the thread and re-point the composer to the
  // new current exercise. The engine OWNS the mutation; this only narrates it.
  document.addEventListener('atlas:plan-mutated', e => {
    const d = (e && e.detail) || {};
    // SESS-3 (F09): if the plan had already been closed out and this mutation REOPENS
    // it (adds work back so there's an unlogged lift again), re-arm the one-shot
    // closeout guard + the next-up suppressor so the NEXT completion gets its
    // session-close prompt and the new lift announces. Without this, adding exercises
    // after closeout suppressed the second "planned work done" line for the rest of
    // the session. Only fires when a closed-out plan actually has remaining work now.
    if (closeoutAnnounced) {
      const stillWork = (typeof remainingPlannedExercises === 'function')
        ? remainingPlannedExercises().length > 0
        : Boolean(d.current);
      if (stillWork) {
        closeoutAnnounced = false;
        lastAnnouncedNextUp = null;
      }
    }
    if (d.summary) {
      const node = appendAtlasBubble();
      if (node && node.body) node.body.textContent = d.current ? `${d.summary} Next up: ${d.current}.` : d.summary;
    }
    if (d.current) setWorkoutPlaceholder(buildWorkoutPlaceholder([{ name: d.current }]) || d.current);
  });

  // Active-session exercise REPLACEMENT proposal (production trust fix FR-20260723031748).
  // A direct "replace X with Y" is staged by app.js as ONE pending proposal — the plan is
  // NOT mutated yet. Render one coherent proposal with the complete proposed prescription and
  // an Approve / Reject affordance. Approval (a tap, or a conversational "yes"/"do bench")
  // is what applies it; the buttons only dispatch the decision and disable themselves so
  // repeated taps are idempotent (app.js's approve/reject are also no-ops once resolved).
  function renderReplacementProposalCard(d) {
    const proposal = d && d.proposal;
    if (!proposal) return;
    const node = appendAtlasBubble();
    if (!node || !node.body) return;
    node.body.appendChild(elc('div', 'replacement-proposal-line', d.line || 'Replace exercise?'));
    const actions = elc('div', 'replacement-proposal-actions');
    const approve = elc('button', 'replacement-approve-btn', 'Approve');
    const reject = elc('button', 'replacement-reject-btn', 'Keep it');
    approve.type = 'button'; reject.type = 'button';
    approve.setAttribute('data-proposal-id', proposal.proposal_id || '');
    let resolved = false;
    const decide = (decision) => {
      if (resolved) return;                 // idempotent — one decision per card
      resolved = true;
      approve.disabled = true; reject.disabled = true;
      document.dispatchEvent(new CustomEvent('atlas:replacement-decision', { detail: { decision, proposal } }));
    };
    approve.addEventListener('click', () => decide('approve'));
    reject.addEventListener('click', () => decide('reject'));
    actions.appendChild(approve);
    actions.appendChild(reject);
    node.body.appendChild(actions);
  }
  document.addEventListener('atlas:replacement-proposed', e => renderReplacementProposalCard((e && e.detail) || {}));

  // #1189 — the prescription-only SET-REVISION card. Atlas has proposed a load/rep change for a
  // movement that STAYS in the plan; the athlete decides explicitly.
  //
  // The card is a pure affordance: it renders the STORED proposal and dispatches a decision that
  // names it by `proposal_id`. It never applies a revision itself, never re-derives the numbers,
  // and never reads them out of Atlas's prose — so a stale or superseded card cannot act, because
  // the shell's lane refuses an id that is not the active proposal.
  //
  // Three affordances, because two would force a false choice:
  //   Approve       — an unambiguous yes; the tap IS the consent.
  //   Keep Original — decline; the plan is left exactly as it is.
  //   Ask Why       — neither. It asks Atlas to explain and deliberately KEEPS the proposal
  //                   active, so the athlete can still decide afterwards.
  function setRevisionLine(p) {
    const rx = (t) => {
      if (!t || typeof t !== 'object') return null;
      const parts = [];
      if (t.weight != null) parts.push(`${t.weight} lb`);
      if (t.reps != null) parts.push(`${t.reps} reps`);
      if (t.rir != null) parts.push(`@ ${t.rir} RIR`);
      return parts.length ? parts.join(' ') : null;
    };
    const name = (p && p.prescribed_name) || 'that lift';
    const to = rx(p && p.prescription);
    if (!to) return `Keep ${name} — I don't have an authoritative target for the rest of the sets.`;
    const from = rx(p && p.from);
    return from
      ? `Keep ${name} and take the rest of the sets to ${to} (from ${from}).`
      : `Keep ${name} and take the rest of the sets to ${to}.`;
  }

  function renderSetRevisionProposalCard(d) {
    const proposal = d && d.proposal;
    if (!proposal || !proposal.proposal_id) return;
    const node = appendAtlasBubble();
    if (!node || !node.body) return;
    node.body.appendChild(elc('div', 'set-revision-proposal-line', d.line || setRevisionLine(proposal)));
    const actions = elc('div', 'set-revision-proposal-actions');
    const approve = elc('button', 'set-revision-approve-btn', 'Approve');
    const keep = elc('button', 'set-revision-keep-btn', 'Keep Original');
    const why = elc('button', 'set-revision-why-btn', 'Ask Why');
    for (const b of [approve, keep, why]) b.type = 'button';
    approve.setAttribute('data-proposal-id', proposal.proposal_id);
    let resolved = false;
    const decide = (decision, endorsement) => {
      // Approve / Keep Original are terminal — one decision per card, so a double tap is inert.
      // Ask Why is NOT terminal: it leaves the card live because the proposal is still live.
      if (resolved) return;
      if (decision !== 'ask_why') {
        resolved = true;
        approve.disabled = true; keep.disabled = true;
      }
      document.dispatchEvent(new CustomEvent('atlas:set-revision-decision', {
        detail: { decision, proposal_id: proposal.proposal_id, ...(endorsement ? { endorsement } : {}) }
      }));
    };
    // The tap is the consent, so it carries an unambiguous affirmative rather than asking the
    // shell to infer one. The shell still validates it through the same endorsement test a typed
    // reply goes through — one consent rule, no card-only bypass.
    approve.addEventListener('click', () => decide('approve', 'yes'));
    keep.addEventListener('click', () => decide('reject'));
    why.addEventListener('click', () => decide('ask_why'));
    for (const b of [approve, keep, why]) actions.appendChild(b);
    node.body.appendChild(actions);
  }
  document.addEventListener('atlas:set-revision-proposed', e => renderSetRevisionProposalCard((e && e.detail) || {}));

  // The Ask Why answer, composed by the shell from the STORED proposal and narrated here. The
  // proposal is still active — this is an explanation, not a decision — so the card above keeps
  // its Approve / Keep Original buttons live.
  const narrateSetRevisionLine = e => {
    const d = (e && e.detail) || {};
    if (!d.line) return;
    const node = appendAtlasBubble();
    if (node && node.body) node.body.textContent = d.line;
  };
  document.addEventListener('atlas:set-revision-explained', narrateSetRevisionLine);
  // Phase 4 criterion 4 step (b): the same channel narrates the TYPED lane's deterministic replies
  // — the applied confirmation, the two-choice keep question, the set-scope question, the drop
  // dimension question. Identical rendering on purpose: natural language and the card are one state
  // machine, so they must not be two voices. Every line is composed by the shell from the STORED
  // proposal, so there is nothing here to re-derive.
  document.addEventListener('atlas:set-revision-reply', narrateSetRevisionLine);

  // P0 PR 4: a deterministic identity correction ("sorry that was squats") — app.js
  // already relabeled the logged lift in the session buffers; confirm it in the
  // thread. Read-only narration; the engine OWNS the relabel.
  document.addEventListener('atlas:identity-corrected', e => {
    const d = (e && e.detail) || {};
    if (!d.to) return;
    const node = appendAtlasBubble();
    // Name the corrected lift when we have it — the "X is Y" form can relabel a
    // group that is no longer the last-logged one, so "that" would under-specify.
    if (node && node.body) node.body.textContent = d.from
      ? `Got it — relabeled ${d.from} to ${d.to}.`
      : `Got it — relabeled that to ${d.to}.`;
  });

  // ADD-5: a correction whose target does NOT clearly refer to the last-logged lift
  // (a different exercise is in focus, or the target is already its own group). app.js
  // deliberately left the completed lift untouched; ask which lift was meant rather
  // than corrupting a finished record. Read-only narration — no state changed.
  document.addEventListener('atlas:identity-correction-ambiguous', e => {
    const d = (e && e.detail) || {};
    const node = appendAtlasBubble();
    if (node && node.body) {
      node.body.textContent = d.target
        ? `I left ${d.logged || 'your last lift'} as logged. Did you mean to correct it to ${d.target}? If so, tell me "${d.logged || 'that'} is ${d.target}".`
        : `I'm not sure which lift you meant to correct — I've left ${d.logged || 'your last lift'} as logged.`;
    }
  });

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
      // F06 / CLIENT-2: a coach-accepted correction is a preview edit too — mark each changed
      // field user-edited so it is folded back into the session buffer on a later reparse/log
      // (the programmatic .value set below fires no 'input' event, so mark it explicitly).
      const markEdit = (cls, value) => { const i = row.querySelector(cls); i.value = String(value); i.dataset.userEdited = '1'; };
      if (edit.weight != null) markEdit('.set-weight', edit.weight);
      if (edit.reps != null) markEdit('.set-reps', edit.reps);
      if (edit.rir != null) markEdit('.set-rir', edit.rir);
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
  async function getChatReply(message, history, context, responseTicket) {
    if (typeof api !== 'function' || (typeof isConnected === 'function' && !isConnected())) return { message: null, propose_edit: null, propose_note: null, propose_plan_edit: null };

    // P0 — Active Session Context Integrity: during an active workout, short
    // workout-state questions ("RIR?", "reps?", "how much", "what next") must be
    // answered from the live session prescription, not intercepted by the generic
    // training-knowledge SME. When an active session/plan/preview exists AND the
    // message is session-shaped, skip the SME and go straight to the session-aware
    // coach below. Education ("what does RIR mean?") and anything ambiguous are NOT
    // session-shaped, so they keep the existing SME-first routing untouched.
    const ctx = context || {};
    const correlationSessionId = typeof ctx.session_id === 'string' ? ctx.session_id.trim() : '';
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
    const sessionShaped = sessionQuestion.isSessionStateQuestion(message);
    // Named-lift value questions ("what's the RIR for bench?") aren't matched by the
    // bare-shape classifier, so they leaked to the SME and got generic education.
    // When the named lift is in the live plan/preview, treat it as session-shaped so
    // it routes to the session-aware coach (which answers from the current plan).
    const planLiftNames = [
      ...(Array.isArray(ctx.current_plan) ? ctx.current_plan.map(p => p && (p.name || p.exercise)) : []),
      ...(Array.isArray(ctx.current_preview) ? ctx.current_preview.map(p => p && p.exercise) : []),
    ].filter(Boolean);
    const plannedLiftValue = sessionQuestion.isPlannedLiftQuestion(message, planLiftNames);
    // Plan disputes/corrections ("that isn't what you planned", "you said 195",
    // "the workout says 200×10") are NOT session-state questions and often omit the
    // lift name (the active exercise supplies it), so the two classifiers above miss
    // them — the 2026-07-21 production failure where a Seated Row correction fell to
    // the SME and got generic warm-up advice. When an active workout exists, treat a
    // plan reference/correction as session-shaped so it reaches the session-aware
    // coach (which holds the current plan) instead of the generic SME. Routing here
    // does NOT accept the athlete's claim as fact — the coach still compares it to the
    // real plan and states the actual prescription. Education ("what is RIR?") names
    // no plan and stays on the SME.
    const planReference = sessionQuestion.isPlanReference(message);
    // Plan-MODIFICATION requests ("change it to 3x6", "can we change it to 3 sets of 6?",
    // "make that 8 reps", "could we lower it to 175?") ask to CHANGE the active plan.
    // A shorthand request often carries neither a lift name nor the word "plan", so the
    // three classifiers above all miss it and it leaked to the generic SME (the 2026-07-22
    // production failure — a change request got a warm-up card and never reached the
    // proposal → approval flow). When an active workout exists, route it to the
    // session-aware coach; #1126's server classifier then drives the model → proposal →
    // approval flow. Education ("how do I change my grip?", "can changing rep ranges build
    // muscle?") is not a modification request and stays on the SME. Read-only: chat never
    // writes; a plan edit still passes through preview → approve → write.
    const planModification = sessionQuestion.isPlanModificationRequest(message);
    const skipSme = hasActiveWorkout && (sessionShaped || plannedLiftValue || planReference || planModification);

    // SME first: a training-knowledge question gets a deterministic, LLM-free answer
    // from /api/coach/ask. Anything it has no card for (depth log_only / no answer) —
    // including data questions about the lifter's own history — falls through to the
    // Gemini coach below. READ-ONLY either way; a slow/failed SME never blocks the chat.
    if (!skipSme) try {
      let smeHeaders = null;
      const smeWinner = await Promise.race([
        api('/api/coach/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, ...(correlationSessionId ? { session_id: correlationSessionId } : {}) }),
          ...(responseTicket ? {
            responseHeaders: responseHeaders => { smeHeaders = responseHeaders; },
          } : {}),
        }).then(value => ({ selected: true, value })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('sme-timeout')), 4000)),
      ]);
      const sme = smeWinner.value;
      const data = sme && sme.data;
      if (data && data.depth && data.depth !== 'log_only' && data.answer) {
        if (responseTicket && typeof completeTurnResponse === 'function') {
          completeTurnResponse(responseTicket, smeHeaders);
        }
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
    let chatHeaders = null;
    const timeout = new Promise(resolve => setTimeout(() => resolve({
      selected: false,
      value: { message: null, propose_edit: null, propose_note: null, propose_plan_edit: null },
    }), CHAT_REPLY_TIMEOUT_MS));
    const request = api('/api/coach/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        history: history.slice(-8),
        context: context || {},
        ...(correlationSessionId ? { session_id: correlationSessionId } : {}),
      }),
      ...(responseTicket ? {
        responseHeaders: responseHeaders => { chatHeaders = responseHeaders; },
      } : {}),
    }).then(res => ({
      message: (res && res.data && res.data.message) || null,
      propose_edit: (res && res.data && res.data.propose_edit) || null,
      propose_note: (res && res.data && res.data.propose_note) || null,
      propose_constraint: (res && res.data && res.data.propose_constraint) || null,
      propose_plan_edit: (res && res.data && res.data.propose_plan_edit) || null
    })).then(value => ({ selected: true, value }));
    const winner = await Promise.race([request, timeout]);
    if (winner.selected && responseTicket && typeof completeTurnResponse === 'function') {
      completeTurnResponse(responseTicket, chatHeaders);
    }
    return winner.value;
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

  // Deterministic fallback when the coach voice is unconfigured, slow, or errors.
  // Owner directive: when the LLM is down the lifter must NEVER be told — there is no
  // "coach unavailable" / "couldn't reach" / "ask again" reveal. Instead we answer
  // naturally for the high-probability things said mid-session, always staying
  // productive and never claiming anything was saved or inventing a number (the
  // deterministic engine owns logging; this only voices conversational prose).
  function chatFallback(message) {
    const t = String(message || '').toLowerCase();
    // Greeting
    if (/^\s*(hi|hey|hello|yo|sup|good (morning|afternoon|evening))\b/.test(t)) {
      return "Hey — ready when you are. Log your sets and say \"log it\" when you're done.";
    }
    // Thanks / acknowledgment ("thanks", "got it", a bare "ok"/"cool")
    if (/\b(thanks|thank you|thx|ty|appreciate|got it|gotcha|sounds good|will do|cool|nice|perfect|awesome|sweet)\b/.test(t) || /^\s*(ok(ay)?|k|yep|yeah|yup|word)\s*[.!]?\s*$/.test(t)) {
      return "Anytime. Keep logging and say \"log it\" when you're done.";
    }
    // "You missed / that's wrong / didn't log it" — a set didn't make it in. Point the
    // lifter to re-enter it; a re-typed set lands in the preview deterministically.
    if (/\b(missed|missing|didn'?t (log|catch|get|add|count)|forgot|wrong|not right|that'?s not|isn'?t right)\b/.test(t)) {
      return "If a set didn't make it in, re-type it like \"seated row 95 10/2\" and I'll add it to the preview.";
    }
    // Skip + workout notation: user noted a substitution.
    if (/\bskipp?ed?\b/.test(t) && /\d/.test(t)) {
      return "Noted the skip. Keep logging and say \"log it\" when you're done — I'll review the full session then.";
    }
    // Looks like workout notation (has numbers).
    if (/\d/.test(t)) {
      return "Noted — keep logging and say \"log it\" when you're done; I'll compile everything then.";
    }
    // "How am I doing / was that good" — answer naturally without inventing a number
    // (if the engine could quantify it, it would have answered before this fallback).
    if (/\b(how'?s|how am|how are|how did|how is|how'?d|was that|that good|on track|progress)\b/.test(t)) {
      return "You're putting in the work. Keep logging your sets and say \"log it\" — I'll have the full read then.";
    }
    // Natural catch-all: a productive nudge, never a dead-end, never a hint the LLM is
    // down. Conversational prose the engine can't action still gets a real reply.
    return "Got it — keep logging your sets and say \"log it\" when you're done.";
  }

  // Defense in depth (2026-07-22, deployed 9f72ee5). A workout-GENERATION request
  // ("plan me a workout …") belongs on the AUTHORITATIVE recommendation pipeline
  // (Coach's Pick → /api/plan/intent-recommendation), reached via the composer gate
  // (looksLikeSessionRequest → sessionQuestion.isWorkoutGenerationRequest). If one still
  // slips past that gate into THIS free-form chat lane, a model-authored propose_plan_edit
  // would MATERIALIZE a local active plan (activePlannedSession / plan_order / remaining
  // lifts) out of prose that carries no plan_version and no canonical lift codes — the exact
  // production divergence (Lat Pulldown became first in plan_order while the visible prose
  // still led with Bench Press). FAIL CLOSED: strip the plan edit and answer with a retryable
  // planner line, so no plan state is ever created from model output on this lane. Only
  // GENERATION turns are affected — plan disputes/corrections/modifications and education are
  // not generation-shaped, so their propose_plan_edit still flows through preview → approve.
  const GENERATION_CHAT_FAILSAFE_MESSAGE =
    'Let me put that together as a proper plan — ask again (for example, “plan me a workout”) and I’ll pull up your recommended session.';

  function guardGenerationChatResult(text, chatResult) {
    const r = chatResult || {};
    if (r.propose_plan_edit && sessionQuestion.isWorkoutGenerationRequest(text)) {
      return { ...r, propose_plan_edit: null, message: GENERATION_CHAT_FAILSAFE_MESSAGE };
    }
    return r;
  }

  async function handleChatMessage(detail, responseTicket) {
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

    let chatResult = { message: null, propose_edit: null, propose_note: null, propose_constraint: null, propose_plan_edit: null };
    try { chatResult = await getChatReply(text, priorTurns, detail && detail.context, responseTicket); } catch { /* stays null */ }
    // Fail closed: a generation request that reached this lane must never materialize a
    // local active plan from the model's propose_plan_edit (see guardGenerationChatResult).
    chatResult = guardGenerationChatResult(text, chatResult);

    let reply = chatResult.message;
    if (!reply || !reply.trim()) reply = chatFallback(text);

    body.textContent = '';
    await typeOut(body, reply);

    // A response can win its network race and then lose authority while its prose is
    // rendering. Recheck immediately before every structured side effect so a newer
    // preview/response cannot be cleared, mutated, or left with a stale approval prompt.
    const mayApplyStructuredResult = () => Boolean(
      responseTicket
      && typeof isTurnResponseAuthoritative === 'function'
      && isTurnResponseAuthoritative(responseTicket)
    );
    if (mayApplyStructuredResult()) {
      setWorkoutPlaceholder(extractPlaceholderFromText(reply));
    }

    // Apply the structured edit (if any) after prose is typed — the lifter sees
    // the explanation first, then the preview updates. The trust loop is intact:
    // invalidatePreview() forces a new dry-run before approve re-enables.
    chatResult.propose_edit = mayApplyStructuredResult() ? chatResult.propose_edit : null;
    if (chatResult.propose_edit) {
      const applied = applyProposedEdit(chatResult.propose_edit);
      if (applied) {
        const note = document.createElement('div');
        note.className = 'edit-applied-note';
        note.textContent = 'Preview updated — review and tap Save when ready.';
        bubble.appendChild(note);
      }
    }

    chatResult.propose_plan_edit = mayApplyStructuredResult() ? chatResult.propose_plan_edit : null;
    if (chatResult.propose_plan_edit) {
      const result = { applied: false, exercises: [] };
      document.dispatchEvent(new CustomEvent('atlas:plan-edit-proposed', {
        detail: { edit: chatResult.propose_plan_edit, result }
      }));
      if (result.applied) {
        // Owner directive (2026-07-03): plans read STACKED, never as prose lines —
        // render the APPLIED edit through the same structured block the Coach's
        // Pick uses. PR-12 (Bug 3): render the SINGLE normalized model app.js just
        // stored on activePlannedSession (handed back on result.exercises), not a
        // second independent re-mapping of edit.exercises — so this block, the
        // active-session banner, and the store never drift. remove_exercises hands
        // back [] (nothing new to show); the note still confirms it.
        if (Array.isArray(result.exercises) && result.exercises.length) {
          appendWorkoutPlan(bubble, { exercises: result.exercises });
        }
        const note = document.createElement('div');
        note.className = 'edit-applied-note';
        note.textContent = 'Plan updated.';
        bubble.appendChild(note);
      }
    }

    // Show "Save this note?" prompt if Atlas proposed a coaching note. Requires
    // explicit lifter approval — never saves silently.
    chatResult.propose_note = mayApplyStructuredResult() ? chatResult.propose_note : null;
    if (chatResult.propose_note && chatResult.propose_note.note) {
      showSaveNotePrompt(bubble, chatResult.propose_note.note);
    }

    // Show "Save this constraint?" prompt if Atlas proposed a structured constraint.
    // Same explicit-approval trust loop as notes — at most one proposal per reply.
    chatResult.propose_constraint = mayApplyStructuredResult() ? chatResult.propose_constraint : null;
    if (chatResult.propose_constraint && chatResult.propose_constraint.target) {
      showSaveConstraintPrompt(bubble, chatResult.propose_constraint);
    }

    chatTurns.push({ role: 'atlas', text: reply });
  }

  document.addEventListener('atlas:chat-message', e => {
    const context = e.detail && e.detail.context;
    const sessionId = context && typeof context.session_id === 'string' ? context.session_id.trim() : '';
    // Mint at logical submission, before either /ask or its /chat fallthrough can await.
    const responseTicket = sessionId && typeof beginTurnResponse === 'function'
      ? beginTurnResponse({ sessionId })
      : null;
    handleChatMessage(e.detail, responseTicket).catch(() => {});
  });

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
