'use strict';

// PR-12 — Workout Plan Presentation & Rendering Consistency.
//
// Live validation (Flight Recorder + screenshots) surfaced four presentation
// bugs in the chat "build me a workout" flow (coach-conversation.js
// handleChatMessage → the propose_plan_edit branch):
//
//   Bug 1 — the workout is rendered TWICE: the coach's prose reply enumerates
//           the plan AND a structured block re-renders it underneath.
//   Bug 2 — the structured block LOSES prescription: an accessory with reps/sets/
//           RIR but no weight (e.g. "Face Pull  60×15, 3 sets, RIR 2") rendered
//           as just "Face Pull" because the set-line guard required a weight.
//   Bug 3 — multiple presentation MODELS: the block re-mapped edit.exercises
//           independently of the normalized model app.js stored in
//           activePlannedSession, so the two could drift.
//   Bug 4 — surfaces must render from the SAME workout model.
//
// Root causes:
//   - Bug 1: the chat system prompt contradicts itself — one rule says "give each
//     exercise on its own line" (prose enumeration), another says "do NOT enumerate
//     the plan in prose — the app renders the structured block." The prose
//     enumeration is the duplicate. Fix: the prose commits the plan through the
//     structured PROPOSE_PLAN_EDIT block only.
//   - Bug 2: appendWorkoutPlan / formatPlanSetLine only rendered a set line when
//     BOTH weight and reps were present. Fix: render whenever reps is known;
//     format a load-less set as "{reps} reps/{rir}" (RIR still never dropped).
//   - Bug 3: the block now renders the SAME normalized exercises app.js applied to
//     the store (returned via the plan-edit event result), not a second re-mapping.
//
// This is a presentation/rendering PR: no parser, logging, save-path, workout
// engine, or state-store change.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const repoRoot = path.join(__dirname, '..');
const readPublic = (f) => fs.readFileSync(path.join(repoRoot, 'public', f), 'utf8');
const readSvc = (f) => fs.readFileSync(path.join(repoRoot, 'services', f), 'utf8');

// ── minimal fake DOM so appendWorkoutPlan can be exercised in isolation ──────────
function makeEl() {
  const el = {
    className: '', tagName: null, _text: null, children: [],
    appendChild(c) { this.children.push(c); return c; },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return this._text; },
    set(v) { this._text = String(v); },
  });
  return el;
}
function fakeDocument() {
  return { createElement: (t) => { const e = makeEl(); e.tagName = t; return e; } };
}
function collect(el, acc = []) {
  if (!el) return acc;
  if (el._text != null) acc.push({ cls: el.className, text: el._text });
  (el.children || []).forEach((c) => collect(c, acc));
  return acc;
}

// Extract the plan-render cluster (formatPlanSetLine … appendWorkoutPlan) from the
// coach-conversation IIFE. normalizePlanExercise is an app.js global, absent here,
// so appendWorkoutPlan uses the already-normalized entries verbatim (the exact
// shape the store hands it under the Bug-3 fix).
function loadPlanRenderer() {
  const cc = readPublic('coach-conversation.js');
  const src = cc.slice(
    cc.indexOf('function formatPlanSetLine(ex)'),
    cc.indexOf('function suggestedWorkoutProseLines(data)')
  );
  return new Function('document', `${src}; return { appendWorkoutPlan, formatPlanSetLine };`)(fakeDocument());
}

// Extract app.js's plan-edit apply path with the store shim + DOM stubs.
function loadApplyPlanEdit() {
  const app = readPublic('app.js');
  const norm = app.slice(
    app.indexOf('function normalizePlanExercise(raw)'),
    app.indexOf('/* ===== Active planned session')
  );
  const editBlock = app.slice(
    app.indexOf('function normalizePlanEditExercise(raw)'),
    app.indexOf("document.addEventListener('atlas:plan-edit-proposed'")
  );
  const stubs = `
    function renderActiveSessionBanner(){}
    function endPlannedSession(){ setActivePlannedSession(null); }
  `;
  return new Function(
    `${STORE_SHIM}\n${stubs}\n${norm}\n${editBlock}\n; ` +
    'return { applyProposedPlanEdit, getActivePlannedSession, setActivePlannedSession, getSessionCompleted, setSessionCompleted };'
  )();
}

/* ══════════ Bug 2 — prescription details never disappear ══════════ */

test('bug2: a load-less accessory set still renders reps + RIR (never a bare name)', () => {
  const { formatPlanSetLine } = loadPlanRenderer();
  // weight present — unchanged legacy format.
  assert.equal(formatPlanSetLine({ weight: 60, reps: 15, rir: 2 }), '60lbs 15/2');
  // weight absent — reps + RIR survive, and no literal "null".
  const line = formatPlanSetLine({ weight: null, reps: 15, rir: 2 });
  assert.ok(!/null/i.test(line), `no "null" leaks into a load-less set line: "${line}"`);
  assert.match(line, /15/, 'reps preserved without a weight');
  assert.match(line, /\/2\b/, 'RIR preserved without a weight');
});

test('bug2: appendWorkoutPlan renders every prescription field for a load-less lift', () => {
  const { appendWorkoutPlan } = loadPlanRenderer();
  const container = makeEl();
  // The exact Face Pull case: reps/sets/RIR known, weight omitted by the directive.
  const rendered = appendWorkoutPlan(container, {
    exercises: [{ name: 'Face Pull', weight: null, reps: 15, sets: 3, rir: 2 }],
  });
  assert.equal(rendered, 1, 'exercise rendered');
  const nodes = collect(container);
  const nameNodes = nodes.filter((n) => n.cls === 'workout-plan-name');
  const setNodes = nodes.filter((n) => n.cls === 'workout-plan-set');
  assert.equal(nameNodes.length, 1, 'exactly one name element');
  assert.match(nameNodes[0].text, /Face Pull/);
  assert.equal(setNodes.length, 3, 'all 3 planned sets render even without a weight (was 0 — the bug)');
  for (const s of setNodes) {
    assert.match(s.text, /15/, 'reps present in every set line');
    assert.match(s.text, /2/, 'RIR present in every set line');
  }
});

test('bug2: a fully-prescribed lift still renders weight, reps, sets, and RIR', () => {
  const { appendWorkoutPlan } = loadPlanRenderer();
  const container = makeEl();
  appendWorkoutPlan(container, { exercises: [{ name: 'Bench Press', weight: 225, reps: 5, sets: 3, rir: 2 }] });
  const setNodes = collect(container).filter((n) => n.cls === 'workout-plan-set');
  assert.equal(setNodes.length, 3, 'three sets');
  for (const s of setNodes) assert.equal(s.text, '225lbs 5/2', 'faithful load × reps / RIR');
});

/* ══════════ F09E — complete, executable set structure ══════════ */

test('F09E: a bodyweight lift (weight 0) renders "BW — reps ×sets", never "0lbs" or the ambiguous "15/3"', () => {
  const { appendWorkoutPlan, formatPlanSetLine } = loadPlanRenderer();
  // formatPlanSetLine marks a zero-load (bodyweight) target as BW — never a meaningless "0lbs".
  const line = formatPlanSetLine({ weight: 0, reps: 15, rir: null });
  assert.match(line, /BW/, 'bodyweight is marked BW');
  assert.doesNotMatch(line, /0lbs/, 'never a meaningless 0lbs load');
  assert.doesNotMatch(line, /\b15\/3\b/, 'never the ambiguous 15/3 that reads like a set count');
  // appendWorkoutPlan groups identical bodyweight sets into ONE explicit "×N" line.
  const container = makeEl();
  const rendered = appendWorkoutPlan(container, { exercises: [{ name: 'Hanging Knee Raise', weight: 0, reps: 15, sets: 3, rir: null }] });
  assert.equal(rendered, 1);
  const setNodes = collect(container).filter((n) => n.cls === 'workout-plan-set');
  assert.equal(setNodes.length, 1, 'one grouped line for identical bodyweight sets');
  assert.match(setNodes[0].text, /BW — 15 reps ×3/, 'explicit BW + reps + set count');
  assert.doesNotMatch(setNodes[0].text, /0lbs/, 'no 0lbs leak');
});

test('F09E: an exercise with no rep target asks for clarification, never a bare name or a misleading isolated number', () => {
  const { appendWorkoutPlan } = loadPlanRenderer();
  const container = makeEl();
  const rendered = appendWorkoutPlan(container, { exercises: [{ name: 'Cable Fly', weight: 40, reps: null, sets: 3, rir: 2 }] });
  assert.equal(rendered, 1, 'the exercise still renders (name + a clarify prompt)');
  const nodes = collect(container);
  assert.equal(nodes.filter((n) => n.cls === 'workout-plan-name').length, 1, 'name still shown');
  assert.equal(nodes.filter((n) => n.cls === 'workout-plan-set').length, 0, 'no misleading set line when reps are unknown');
  const clarify = nodes.filter((n) => n.cls && n.cls.includes('workout-plan-clarify'));
  assert.equal(clarify.length, 1, 'a clarification prompt is shown instead');
  assert.match(clarify[0].text, /confirm|reps|target/i, 'the prompt asks for the missing target');
});

test('F09E regression: weighted and load-omitted (non-zero) rendering is unchanged', () => {
  const { appendWorkoutPlan, formatPlanSetLine } = loadPlanRenderer();
  assert.equal(formatPlanSetLine({ weight: 60, reps: 15, rir: 2 }), '60lbs 15/2', 'weighted unchanged');
  assert.equal(formatPlanSetLine({ weight: null, reps: 15, rir: 2 }), '15 reps/2', 'load-omitted accessory unchanged (not BW)');
  const container = makeEl();
  appendWorkoutPlan(container, { exercises: [{ name: 'Bench Press', weight: 225, reps: 5, sets: 3, rir: 2 }] });
  const setNodes = collect(container).filter((n) => n.cls === 'workout-plan-set');
  assert.equal(setNodes.length, 3, 'weighted still renders one line per set');
  for (const s of setNodes) assert.equal(s.text, '225lbs 5/2');
});

/* ══════════ Bug 3 / Bug 4 — one workout model feeds every surface ══════════ */

test('bug3: applyProposedPlanEdit returns the applied exercises for a single-source render', () => {
  const { applyProposedPlanEdit, getActivePlannedSession } = loadApplyPlanEdit();
  const edit = {
    action: 'replace_plan',
    label: 'Pull day',
    exercises: [
      { name: 'Bench Press', weight: 225, reps: 5, sets: 3, rir: 2 },
      { name: 'Face Pull', reps: 15, sets: 3, rir: 2 }, // no weight
    ],
  };
  const out = applyProposedPlanEdit(edit);
  assert.ok(out && out.applied, 'edit applied');
  assert.ok(Array.isArray(out.exercises), 'returns the exercises to render');
  assert.equal(out.exercises.length, 2, 'every generated exercise is returned exactly once');

  const fp = out.exercises.find((e) => e.name === 'Face Pull');
  assert.ok(fp, 'Face Pull present');
  assert.equal(fp.reps, 15, 'reps preserved through the store');
  assert.equal(fp.sets, 3, 'sets preserved through the store');
  assert.equal(fp.rir, 2, 'RIR preserved through the store');
  assert.equal(fp.weight, null, 'no invented weight');

  // Bug 4: the block renders the SAME array the active session holds — one model.
  const active = getActivePlannedSession().exercises;
  assert.deepEqual(active.map((e) => e.name), ['Bench Press', 'Face Pull'], 'active session matches the generated workout');
  assert.strictEqual(active, out.exercises, 'the rendered block and the active session are the SAME model instance');
});

test('bug3: add_exercises returns only the added exercises, carrying prescription', () => {
  const { applyProposedPlanEdit, setActivePlannedSession } = loadApplyPlanEdit();
  setActivePlannedSession({ label: 'Coach plan', intentId: null, index: 0, exercises: [
    { name: 'Bench Press', canonicalName: 'Bench Press', weight: 225, reps: 5, sets: 3, rir: 2 },
  ] });
  const out = applyProposedPlanEdit({ action: 'add_exercises', exercises: [
    { name: 'Hanging Knee Raises', sets: 3, reps: 15, rir: 2 },
  ] });
  assert.ok(out && out.applied, 'add applied');
  assert.equal(out.exercises.length, 1, 'only the added exercise renders');
  assert.equal(out.exercises[0].name, 'Hanging Knee Raises');
  assert.equal(out.exercises[0].reps, 15);
  assert.equal(out.exercises[0].sets, 3);
  assert.equal(out.exercises[0].rir, 2);
});

/* ══════════ Wrong-target guard — remove_exercises (sibling of PR #993) ══════════ */
// matchesPlanEditName falls back to bidirectional substring matching, and
// remove_exercises filter-removes EVERY match. So "remove Leg Press" on a plan
// holding both "Leg Press" and "Single-Leg Seated Leg Press" also swept out the
// single-leg slot the athlete never named — and the completed-evidence cleanup
// repeated the same substring sweep. An exact wanted name must remove only its
// exact slot; a name with no exact match keeps the substring fallback.

function legDayPlan() {
  return { label: 'Leg day', intentId: null, index: 0, exercises: [
    { name: 'Single-Leg Seated Leg Press', canonicalName: 'Single-Leg Seated Leg Press' },
    { name: 'Leg Extension', canonicalName: 'Leg Extension' },
    { name: 'Leg Press', canonicalName: 'Leg Press' },
  ] };
}

test('wrong-target guard: remove_exercises with an EXACT name removes only that slot', () => {
  const { applyProposedPlanEdit, getActivePlannedSession, setActivePlannedSession } = loadApplyPlanEdit();
  setActivePlannedSession(legDayPlan());
  const out = applyProposedPlanEdit({ action: 'remove_exercises', exercises: [{ name: 'Leg Press' }] });
  assert.ok(out && out.applied, 'remove applied');
  assert.deepEqual(getActivePlannedSession().exercises.map(e => e.name),
    ['Single-Leg Seated Leg Press', 'Leg Extension'],
    'only the exact "Leg Press" slot is removed; the un-named single-leg variant stays');
});

test('wrong-target guard: the completed-evidence cleanup follows the same exact-name precedence', () => {
  const { applyProposedPlanEdit, setActivePlannedSession, getSessionCompleted, setSessionCompleted } = loadApplyPlanEdit();
  setActivePlannedSession(legDayPlan());
  setSessionCompleted(['single-leg seated leg press', 'leg press']);
  applyProposedPlanEdit({ action: 'remove_exercises', exercises: [{ name: 'Leg Press' }] });
  assert.deepEqual(getSessionCompleted(), ['single-leg seated leg press'],
    'the exact removal clears only its own completed evidence — the single-leg log evidence survives');
});

test('wrong-target guard: a slot exact-matched via canonicalName clears its name-keyed evidence too', () => {
  // Review note on #994: evidence entries are stored under the slot's `name`
  // (resolveCompletedIdentity returns match.name), so an exact removal via the
  // slot's canonicalName must clear that name-keyed evidence — no stale done-mark.
  const { applyProposedPlanEdit, getActivePlannedSession, setActivePlannedSession, getSessionCompleted, setSessionCompleted } = loadApplyPlanEdit();
  setActivePlannedSession({ label: 'Push day', intentId: null, index: 0, exercises: [
    { name: 'Dips (Weighted)', canonicalName: 'Weighted Dip' },
    { name: 'Bench Press', canonicalName: 'Bench Press' },
  ] });
  setSessionCompleted(['dips (weighted)', 'bench press']);
  const out = applyProposedPlanEdit({ action: 'remove_exercises', exercises: [{ name: 'Weighted Dip' }] });
  assert.ok(out && out.applied, 'remove applied');
  assert.deepEqual(getActivePlannedSession().exercises.map(e => e.name), ['Bench Press'],
    'the slot exact-matched via canonicalName is removed');
  assert.deepEqual(getSessionCompleted(), ['bench press'],
    'its name-keyed completed evidence is cleared with it — Bench Press evidence untouched');
});

test('wrong-target guard: a wanted name with NO exact match keeps the substring fallback', () => {
  const { applyProposedPlanEdit, getActivePlannedSession, setActivePlannedSession } = loadApplyPlanEdit();
  setActivePlannedSession(legDayPlan());
  // "Seated Leg Press" matches no slot exactly → the pre-existing bidirectional
  // substring behavior holds unchanged (it reaches the single-leg slot as a
  // substring of its name, and "Leg Press" as a substring of the wanted name) —
  // an LLM-echoed alias still resolves.
  const out = applyProposedPlanEdit({ action: 'remove_exercises', exercises: [{ name: 'Seated Leg Press' }] });
  assert.ok(out && out.applied);
  assert.deepEqual(getActivePlannedSession().exercises.map(e => e.name),
    ['Leg Extension'],
    'no exact slot named "Seated Leg Press" → the substring fallback behaves exactly as before');
});

test('bug3: the chat plan-edit render uses the applied model, not a second re-mapping', () => {
  const cc = readPublic('coach-conversation.js');
  const branch = cc.slice(cc.indexOf('if (chatResult.propose_plan_edit)'), cc.indexOf('// Show "Save this note?"'));
  assert.equal((branch.match(/appendWorkoutPlan\(/g) || []).length, 1, 'the plan renders exactly once — no duplicated block');
  assert.doesNotMatch(branch, /target_weight:\s*x\.weight/, 'must not independently re-map edit.exercises (that is the second model)');
  assert.match(branch, /result\.exercises/, 'renders the exercises the store applied (single source of truth)');
});

test('bug3: the plan-edit handler hands the applied exercises back on the event result', () => {
  const app = readPublic('app.js');
  const anchor = "document.addEventListener('atlas:plan-edit-proposed'";
  const handler = app.slice(app.indexOf(anchor), app.indexOf(anchor) + 900);
  assert.match(handler, /result\.exercises\s*=/, 'the handler returns the applied exercises for the single-source render');
});

/* ══════════ Bug 1 — the plan is presented once ══════════ */

test('bug1: the chat prompt no longer enumerates the plan in prose (one presentation)', () => {
  const coach = readSvc('coach.js');
  const chatPrompt = coach.slice(
    coach.indexOf('function buildChatSystemPrompt'),
    coach.indexOf('function parseEditFromReply')
  );
  assert.doesNotMatch(chatPrompt, /each exercise on its own line/i,
    'the prose must not enumerate the plan line-by-line — the structured block renders it');
  assert.match(chatPrompt, /Do NOT enumerate the plan exercise-by-exercise in your prose/,
    'the app owns the plan render; the model words the focus only');
});

test('bug1: the chat prompt keeps the structured plan edit complete (only weight is snapshot-gated)', () => {
  const coach = readSvc('coach.js');
  const chatPrompt = coach.slice(
    coach.indexOf('function buildChatSystemPrompt'),
    coach.indexOf('function parseEditFromReply')
  );
  // sets/reps/RIR are the coach's own prescription and must ride in the directive so
  // the structured block is faithful; only a WEIGHT may be omitted (no snapshot load).
  assert.match(chatPrompt, /include the sets, reps, and RIR/i,
    'the directive must carry sets/reps/RIR so the rendered block is faithful');
});
