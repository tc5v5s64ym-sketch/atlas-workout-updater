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
    'return { applyProposedPlanEdit, getActivePlannedSession, setActivePlannedSession };'
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
