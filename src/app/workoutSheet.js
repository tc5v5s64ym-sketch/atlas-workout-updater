/* Workout Sheet — a pull-down, snap-in-place view of the current workout.
 *
 * PR-1 (display-only): the pull gesture, three detents (closed / center ~58% /
 * full ~92%), snap physics (nearest / flick), rubber-band overpull, a dim layer
 * (tap or flick-up to close), and a READ-ONLY card list (done / current / pending)
 * rendered from the EXISTING canonical ActiveSession selectors.
 *
 * PR-2 (drag-to-reorder): PENDING cards carry a ≡ grip (pointer drag) and ▲/▼ controls
 * (the non-drag / reduced-motion fallback). Both dispatch the ONE deterministic plan
 * mutation — window.reorderPlannedExercise (app.js) — so the sheet still holds ZERO plan
 * logic: it computes only WHICH slots move. done/current slots are pinned (not draggable,
 * no controls). Still no Sheets / write / write_id / engine / GATE-A calls — a reorder is
 * an in-memory plan change, never a data write.
 *
 * Its own module, like drawer.js. app.js only mounts it (the sheet DOM in index.html
 * + the session pin as the pull handle) and exposes the read-only selectors it reads
 * (getActivePlannedSession / remainingPlannedExercises / getSessionLog) plus the single
 * reorder wrapper. Scoped to workout mode: no active plan → the pin is hidden → no sheet.
 *
 * CSP-safe: every transform/opacity is a CSSOM write (el.style.transform = …), never
 * an inline style="" attribute — the same pattern drawer.js uses. Reduced-motion safe:
 * the spring settle is a CSS transition disabled under prefers-reduced-motion.
 */

import { planSlotStatuses } from './planSlotStatuses.js';

// ── Pure helpers (exported for Node tests; DOM-free) ──────────────────────────

// Three detents as pixel offsets from the top, for a given viewport height.
export function detentsFor(height) {
  const h = Number(height) > 0 ? Number(height) : 0;
  return { closed: 0, center: Math.round(h * 0.58), full: Math.round(h * 0.92) };
}

// Release velocity (px/ms, + = downward / opening) above which a flick jumps to the
// next stop in the flick direction instead of snapping to the nearest.
export const FLICK_VELOCITY = 0.45;

// The detent to settle to on release. Pure. A flick jumps one stop in its direction;
// otherwise snap to the nearest stop.
export function snapTarget(pos, velocity, detents) {
  const stops = [detents.closed, detents.center, detents.full];
  if (Math.abs(velocity) > FLICK_VELOCITY) {
    if (velocity > 0) {                                 // downward → next higher stop
      const higher = stops.filter(s => s > pos + 1);
      return higher.length ? higher[0] : detents.full;
    }
    const lower = stops.filter(s => s < pos - 1);       // upward → next lower stop
    return lower.length ? lower[lower.length - 1] : detents.closed;
  }
  return stops.reduce((a, b) => (Math.abs(b - pos) < Math.abs(a - pos) ? b : a));
}

// Clamp a raw finger position with a rubber-band past the full detent (0.25 drag). Pure.
export function rubberBand(raw, full) {
  if (!(raw > 0)) return 0;
  if (raw > full) return full + (raw - full) * 0.25;
  return raw;
}

// Normalize an exercise name for matching plan ↔ log ↔ remaining (lowercase, trimmed).
function normName(n) { return String(n == null ? '' : n).trim().toLowerCase(); }
function numOr(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Per-exercise summary from the logged sets: set count + heaviest logged set.
// F10S1: a row's RESOLVED identity (`canonical`, stamped at log time) counts too, so an
// alias-form raw row ("RDL") ticks the counter of its planned card ("Romanian Deadlift")
// — the same identity grain the completion selector counts with.
function logSummary(logRows, name) {
  const key = normName(name);
  const sets = (Array.isArray(logRows) ? logRows : [])
    .filter(r => r && (normName(r.exercise) === key || normName(r.canonical) === key));
  if (!sets.length) return { count: 0, top: null };
  const top = sets.reduce((best, s) => {
    const w = numOr(s.weight);
    return (w != null && (best == null || w > numOr(best.weight))) ? s : best;
  }, null);
  return {
    count: sets.length,
    top: top ? { weight: numOr(top.weight), reps: numOr(top.reps), rir: numOr(top.rir) } : null,
  };
}

// Build the ordered read-only card descriptors. Pure — DOM-free, no I/O.
//   planned:   getActivePlannedSession().exercises — ordered, with prescriptions.
//   statuses:  planSlotStatuses(plan, sessionCompleted) — the ONE authoritative
//              per-slot completion selector (F10), 1:1 with `planned` by position.
//   log:       getSessionLog() — logged sets [{ exercise, weight, reps, rir }].
// F10: the card's done/current/pending is decided BY SLOT (plan_item_id + position),
// never by name-set membership — so two same-named slots stay independent (one logged
// set no longer marks every same-named card done). current = the first still-pending
// slot; done = a completed/skipped slot; pending = the rest.
export function buildSheetCards({ planned, statuses, log } = {}) {
  const plan = Array.isArray(planned) ? planned : [];
  const st = Array.isArray(statuses) ? statuses : [];
  const byOrder = new Map(st.map(s => [s.order, s]));
  // The current slot = the first still-pending slot, by position.
  let currentOrder = null;
  for (let i = 0; i < plan.length; i++) {
    const s = byOrder.get(i);
    if (s && s.status === 'pending') { currentOrder = i; break; }
  }
  return plan
    .map((ex, i) => {
      const name = String((ex && (ex.canonicalName || ex.name)) || '').trim();
      if (!name) return null;
      const prescription = {
        weight: numOr(ex && ex.weight), reps: numOr(ex && ex.reps),
        sets: numOr(ex && ex.sets), rir: numOr(ex && ex.rir),
      };
      const slotStatus = byOrder.get(i) ? byOrder.get(i).status : 'pending';
      let status;
      if (slotStatus === 'completed' || slotStatus === 'skipped') status = 'done';
      else if (i === currentOrder) status = 'current';
      else status = 'pending';
      return { slot: i + 1, name, status, prescription, logged: logSummary(log, name) };
    })
    .filter(Boolean);
}

// The one-line detail string for a card. Pure — words a card descriptor, no numbers
// invented (every value comes from the prescription or the logged sets).
export function cardDetailText(card) {
  if (!card || typeof card !== 'object') return '';
  const p = card.prescription || {};
  const rir = p.rir != null ? ` @${p.rir}` : '';
  const set = (w, r) => (w != null && r != null ? `${w}×${r}` : (w != null ? `${w}` : ''));
  if (card.status === 'done') {
    const n = card.logged ? card.logged.count : 0;
    const top = card.logged && card.logged.top;
    const topStr = top && top.weight != null
      ? ` · top ${set(top.weight, top.reps)}${top.rir != null ? ` @${top.rir}` : ''}`
      : '';
    return n ? `${n} set${n === 1 ? '' : 's'}${topStr}` : 'logged';
  }
  if (card.status === 'current') {
    const done = card.logged ? card.logged.count : 0;
    const target = p.sets != null ? p.sets : null;
    // Clamp the counter to the target so an over-logged lift (more sets than
    // prescribed) never reads "set 5/3" — it caps at "set 3/3".
    const counter = target != null ? `set ${Math.min(done + 1, target)}/${target}` : `${done} set${done === 1 ? '' : 's'} in`;
    const next = set(p.weight, p.reps);
    return next ? `${counter} · next ${next}${rir}` : counter;
  }
  // pending
  const setsStr = p.sets != null ? `${p.sets} set${p.sets === 1 ? '' : 's'} · ` : '';
  const load = set(p.weight, p.reps);
  return load ? `${setsStr}${load}${rir}` : (p.sets != null ? `${p.sets} sets` : '');
}

// ── DOM wiring (side effect on import; skipped in Node / when the sheet DOM is absent) ──
(function initWorkoutSheet() {
  if (typeof document === 'undefined') return;
  const sheet = document.getElementById('workout-sheet');
  const dim = document.getElementById('workout-sheet-dim');
  const planEl = document.getElementById('ws-plan');
  const grabber = document.getElementById('ws-grabber');
  const pin = document.getElementById('session-pin');
  if (!sheet || !dim || !planEl || !pin) return;

  const titleEl = document.getElementById('ws-title');
  const progEl = document.getElementById('ws-prog');
  const barEl = document.getElementById('ws-progbar');

  const g = () => (typeof window !== 'undefined' ? window : {});
  const call = (name) => { const fn = g()[name]; return typeof fn === 'function' ? fn() : null; };
  const inWorkout = () => Array.isArray(call('plannedExerciseOrder')) && call('plannedExerciseOrder').length > 0;

  let pos = 0;                 // visible px of the sheet
  const viewportH = () => document.documentElement.clientHeight || g().innerHeight || 0;
  const detents = () => detentsFor(viewportH());

  // ── transform / dim (gesture frames) ────────────────────────────────────────
  function paint() {
    const h = sheet.offsetHeight || Math.round(viewportH() * 0.92);
    sheet.style.transform = `translateY(${Math.round(pos - h)}px)`;     // CSSOM, CSP-safe
    const full = detents().full || 1;
    dim.style.opacity = String(Math.min(pos / full, 1) * 0.55);
    const open = pos > 4;
    dim.classList.toggle('live', open);
    dim.hidden = !open;
    sheet.setAttribute('aria-hidden', open ? 'false' : 'true');
    sheet.classList.toggle('ws-open', open);
  }
  function settleTo(target) {
    sheet.classList.add('ws-settle');
    pos = target;
    paint();
    window.setTimeout(() => sheet.classList.remove('ws-settle'), 380);
  }
  function close() { settleTo(0); }

  // ── pull gesture (pin = threshold-gated so a tap still toggles the pin;
  //    grabber = immediate, it is a dedicated handle) ───────────────────────────
  const THRESHOLD = 6;        // px of downward travel before a pin drag engages
  let pull = null;            // { startY, startPos, lastY, lastT, v, engaged, gated }

  function begin(e, gated) {
    if (gated && !inWorkout()) return;      // no workout → the pin is a plain tap target
    renderCards();                          // fresh state each time the sheet is grabbed
    pull = { startY: e.clientY, startPos: pos, lastY: e.clientY, lastT: now(), v: 0, engaged: !gated, gated };
    sheet.classList.remove('ws-settle');
    if (!gated) capture(e);                 // grabber engages immediately
  }
  function move(e) {
    if (!pull) return;
    const dy = e.clientY - pull.startY;
    if (!pull.engaged) {
      if (dy > THRESHOLD) { pull.engaged = true; capture(e); } else return;
    }
    const t = now();
    const dt = Math.max(t - pull.lastT, 1);
    pull.v = (e.clientY - pull.lastY) / dt;   // px/ms, + downward
    pull.lastY = e.clientY; pull.lastT = t;
    pos = rubberBand(pull.startPos + dy, detents().full);
    paint();
  }
  function end() {
    if (!pull) return;
    const engaged = pull.engaged; const v = pull.v; pull = null;
    if (engaged) {
      // A real drag snaps AND must not also fire the pin's tap handler (which toggles
      // the session-chrome banner). Suppress the click that follows this pointerup;
      // clear the flag next tick so a later genuine tap is unaffected.
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 0);
      settleTo(snapTarget(pos, v, detents()));
    }
    // otherwise it was a tap — leave the pin's own click handler to run
  }
  let suppressClick = false;
  // Capture phase → runs before app.js's bubble-phase pin click (chrome toggle).
  pin.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
  function now() { return (g().performance && g().performance.now) ? g().performance.now() : Date.now(); }
  function capture(e) { try { e.currentTarget && e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* non-fatal */ } }

  pin.addEventListener('pointerdown', e => begin(e, true));
  pin.addEventListener('pointermove', move);
  pin.addEventListener('pointerup', end);
  pin.addEventListener('pointercancel', end);
  if (grabber) {
    grabber.addEventListener('pointerdown', e => begin(e, false));
    grabber.addEventListener('pointermove', move);
    grabber.addEventListener('pointerup', end);
    grabber.addEventListener('pointercancel', end);
  }
  dim.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pos > 4) close(); });

  // ── card list (read-only; from the canonical selectors) ─────────────────────
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  function renderCards() {
    const session = call('getActivePlannedSession');
    const planned = session && Array.isArray(session.exercises) ? session.exercises : [];
    const log = call('getSessionLog') || [];
    // F10 — decide each card's status from the ONE authoritative per-slot selector,
    // keyed on plan_item_id + position, so the sheet holds ZERO completion logic and
    // can never disagree with the pin/recap/closeout. Falls back to an empty status
    // list (all pending) when the selector or session is unavailable.
    const completed = call('getSessionCompleted') || [];
    // F10S1 — the per-set log engages the selector's multiplicity rule, so a slot
    // below its required set count renders as CURRENT (in progress), never done.
    const statuses = session ? planSlotStatuses(session, completed, log) : [];
    const cards = buildSheetCards({ planned, statuses, log });

    // Header: label + progress + the load-line signature bar.
    const label = (session && session.label ? String(session.label) : '').trim();
    if (titleEl) {
      titleEl.textContent = 'TODAY';
      if (label) { titleEl.appendChild(document.createTextNode(' · ')); titleEl.appendChild(el('em', null, label)); }
    }
    const total = cards.length;
    const done = cards.filter(c => c.status === 'done').length;
    const setsIn = Array.isArray(log) ? log.length : 0;
    if (progEl) progEl.textContent = total ? `${done} of ${total} · ${setsIn} set${setsIn === 1 ? '' : 's'} in` : '';
    if (barEl) barEl.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';   // CSSOM

    planEl.textContent = '';
    for (const c of cards) {
      const cls = c.status === 'done' ? 'done' : (c.status === 'current' ? 'now' : 'todo');
      const card = el('div', `ws-card ${cls}`);
      card.dataset.slot = String(c.slot);      // 1-based; slot−1 = index in the live plan
      card.dataset.status = c.status;
      const st = el('span', 'ws-st', c.status === 'done' ? '✓' : (c.status === 'current' ? '●' : String(c.slot)));
      const tx = el('span', 'ws-tx');
      tx.appendChild(el('span', 'ws-nm', c.name));
      tx.appendChild(el('span', 'ws-dt', cardDetailText(c)));
      card.appendChild(st);
      card.appendChild(tx);
      // Only PENDING cards reorder (done/current are pinned). Each carries a ≡ drag
      // handle AND up/down controls — the non-drag fallback that always works (keyboard
      // / reduced-motion). Both dispatch the SAME canonical mutation; the sheet holds
      // zero plan logic. data-slot lets the delegated handlers resolve the live index.
      if (c.status === 'pending') {
        const ctrls = el('span', 'ws-move');
        const up = el('button', 'ws-mv ws-up', '▲');
        up.type = 'button'; up.setAttribute('aria-label', `Move ${c.name} earlier`);
        const down = el('button', 'ws-mv ws-down', '▼');
        down.type = 'button'; down.setAttribute('aria-label', `Move ${c.name} later`);
        ctrls.appendChild(up); ctrls.appendChild(down);
        const grip = el('span', 'ws-grip', '≡');
        grip.setAttribute('aria-hidden', 'true');
        card.appendChild(ctrls);
        card.appendChild(grip);
      }
      planEl.appendChild(card);
    }
  }

  // ── drag-to-reorder (PENDING cards only; dispatches the canonical mutation) ──
  // The ≡ grip starts a pointer drag; the ▲/▼ controls are the non-drag fallback.
  // BOTH call window.reorderPlannedExercise(fromIndex, toIndex) — the ONE deterministic
  // plan mutation (app.js). The sheet computes only WHICH slots move, never the plan.
  // Listeners are delegated on planEl (which persists across renderCards rebuilds).
  const todoCards = () => Array.prototype.slice.call(planEl.querySelectorAll('.ws-card.todo'));
  const slotOf = c => (c && c.dataset ? Number(c.dataset.slot) : NaN);   // 1-based
  const nameOf = c => { const n = c && c.querySelector('.ws-nm'); return n ? n.textContent : ''; };

  function applyReorder(fromSlot, toSlot, movedName) {
    const fn = g().reorderPlannedExercise;
    if (typeof fn !== 'function') return false;
    const changed = fn(fromSlot - 1, toSlot - 1);   // slots are 1-based; the wrapper takes indices
    if (changed) showToast(movedName);              // the wrapper fires atlas:plan-mutated → sync() re-renders
    return changed;
  }

  // ▲/▼ fallback: move a pending card onto its previous / next PENDING neighbour.
  planEl.addEventListener('click', e => {
    const btn = e.target && e.target.closest && e.target.closest('.ws-up, .ws-down');
    if (!btn) return;
    const card = btn.closest('.ws-card');
    const list = todoCards();
    const i = list.indexOf(card);
    if (i === -1) return;
    const neighbour = btn.classList.contains('ws-up') ? list[i - 1] : list[i + 1];
    if (!neighbour) return;   // already at the edge of the pending run → no move
    applyReorder(slotOf(card), slotOf(neighbour), nameOf(card));
  });

  // ≡ grip: a pointer drag. Track the pending card under the finger; drop dispatches.
  let drag = null;   // { card, slot, name, targetSlot }
  function dropTargetAt(clientY, sourceCard) {
    let best = null;
    for (const card of todoCards()) {
      if (card === sourceCard) continue;
      const r = card.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return card;   // directly over a card
      const d = Math.min(Math.abs(clientY - r.top), Math.abs(clientY - r.bottom));
      if (!best || d < best.d) best = { card, d };
    }
    return best ? best.card : null;                                // else the nearest edge
  }
  planEl.addEventListener('pointerdown', e => {
    const grip = e.target && e.target.closest && e.target.closest('.ws-grip');
    if (!grip) return;
    const card = grip.closest('.ws-card');
    if (!card) return;
    e.preventDefault(); e.stopPropagation();
    drag = { card, slot: slotOf(card), name: nameOf(card), targetSlot: null };
    card.classList.add('ws-dragging');
    try { grip.setPointerCapture(e.pointerId); } catch (_) { /* non-fatal */ }
  });
  planEl.addEventListener('pointermove', e => {
    if (!drag) return;
    const target = dropTargetAt(e.clientY, drag.card);
    planEl.querySelectorAll('.ws-drop-target').forEach(n => n.classList.remove('ws-drop-target'));
    if (target) { target.classList.add('ws-drop-target'); drag.targetSlot = slotOf(target); }
    else drag.targetSlot = null;
  });
  function endDrag() {
    if (!drag) return;
    const d = drag; drag = null;
    d.card.classList.remove('ws-dragging');
    planEl.querySelectorAll('.ws-drop-target').forEach(n => n.classList.remove('ws-drop-target'));
    if (d.targetSlot != null && d.targetSlot !== d.slot) applyReorder(d.slot, d.targetSlot, d.name);
  }
  planEl.addEventListener('pointerup', endDrag);
  planEl.addEventListener('pointercancel', endDrag);

  // ── toast (lightweight confirmation; reduced-motion just skips the fade) ──────
  let toastTimer = 0;
  function showToast(name) {
    let t = sheet.querySelector('.ws-toast');
    if (!t) { t = el('div', 'ws-toast'); t.setAttribute('role', 'status'); sheet.appendChild(t); }
    t.textContent = `${name || 'Exercise'} moved · plan updated`;
    t.classList.add('live');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { t.classList.remove('live'); }, 1600);
  }

  // ── pin pull-affordance hint (self-owned; survives pin re-renders) ───────────
  let hinting = false;
  function ensureHint() {
    if (hinting) return;
    if (!inWorkout()) { pin.querySelector('.ws-pin-hint')?.remove(); return; }
    if (pin.querySelector('.ws-pin-hint')) return;
    hinting = true;
    const hint = el('span', 'ws-pin-hint');
    hint.appendChild(el('span', 'ws-pin-chev', '↓'));
    hint.appendChild(document.createTextNode(' pull · today\'s workout'));
    pin.appendChild(hint);
    hinting = false;
  }

  // ── react to session-state changes (the same events that re-render the pin) ──
  function sync() {
    if (!inWorkout()) { if (pos > 4) settleTo(0); pin.querySelector('.ws-pin-hint')?.remove(); return; }
    ensureHint();
    renderCards();
  }
  for (const evt of ['atlas:set-logged', 'atlas:plan-mutated', 'atlas:session-reset']) {
    document.addEventListener(evt, sync);
  }
  // The pin re-renders on its own (renderSessionPin) beyond those events; a light
  // observer keeps the hint present without app.js having to know about the sheet.
  try {
    new MutationObserver(() => { if (!hinting) ensureHint(); }).observe(pin, { childList: true });
  } catch (_) { /* MutationObserver always present in supported browsers */ }

  paint();
  sync();
})();
