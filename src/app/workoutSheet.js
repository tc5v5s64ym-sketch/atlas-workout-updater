/* Workout Sheet — a pull-down, snap-in-place view of the current workout.
 *
 * PR-1 (display-only): the pull gesture, three detents (closed / center ~58% /
 * full ~92%), snap physics (nearest / flick), rubber-band overpull, a dim layer
 * (tap or flick-up to close), and a READ-ONLY card list (done / current / pending)
 * rendered from the EXISTING canonical ActiveSession selectors. No reorder, no plan
 * mutation, no Sheets / write / engine / GATE-A calls — it renders state, never computes.
 *
 * Its own module, like drawer.js. app.js only mounts it (the sheet DOM in index.html
 * + the session pin as the pull handle) and exposes the read-only selectors it reads
 * (getActivePlannedSession / remainingPlannedExercises / getSessionLog). Scoped to
 * workout mode: no active plan → the pin is hidden → there is nothing to pull.
 *
 * CSP-safe: every transform/opacity is a CSSOM write (el.style.transform = …), never
 * an inline style="" attribute — the same pattern drawer.js uses. Reduced-motion safe:
 * the spring settle is a CSS transition disabled under prefers-reduced-motion.
 */

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
function logSummary(logRows, name) {
  const key = normName(name);
  const sets = (Array.isArray(logRows) ? logRows : []).filter(r => r && normName(r.exercise) === key);
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
//   remaining: remainingPlannedExercises() — pending names in order (canonical match).
//   log:       getSessionLog() — logged sets [{ exercise, weight, reps, rir }].
// current = the first remaining; done = a plan item not in remaining; pending = the rest.
export function buildSheetCards({ planned, remaining, log } = {}) {
  const plan = Array.isArray(planned) ? planned : [];
  const rem = new Set((Array.isArray(remaining) ? remaining : []).map(normName));
  const currentKey = (Array.isArray(remaining) && remaining.length) ? normName(remaining[0]) : null;
  return plan
    .map((ex, i) => {
      const name = String((ex && (ex.canonicalName || ex.name)) || '').trim();
      if (!name) return null;
      const key = normName(name);
      const prescription = {
        weight: numOr(ex && ex.weight), reps: numOr(ex && ex.reps),
        sets: numOr(ex && ex.sets), rir: numOr(ex && ex.rir),
      };
      let status;
      if (!rem.has(key)) status = 'done';
      else if (key === currentKey) status = 'current';
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
    const remaining = call('remainingPlannedExercises') || [];
    const log = call('getSessionLog') || [];
    const cards = buildSheetCards({ planned, remaining, log });

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
      const st = el('span', 'ws-st', c.status === 'done' ? '✓' : (c.status === 'current' ? '●' : String(c.slot)));
      const tx = el('span', 'ws-tx');
      tx.appendChild(el('span', 'ws-nm', c.name));
      tx.appendChild(el('span', 'ws-dt', cardDetailText(c)));
      card.appendChild(st);
      card.appendChild(tx);
      planEl.appendChild(card);
    }
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
