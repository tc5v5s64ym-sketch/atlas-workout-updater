'use strict';

// ── Persona fact checks (persona test rig, design §3.4 — Slice 2b) ────────────
// The persona-new deterministic checks, kept OUT of the frozen 25-condition
// rehearsal scorecard: that card judges the harness/product path every run
// shares, while these judge the PERSONA's declared facts — the sets this
// athlete was declared to log, the correction end-states its script promises,
// and the plan-state its fixture declares. A persona run's evidence carries
// BOTH verdicts; neither substitutes for the other.
//
// Pure and fail-closed: no clock, network, filesystem, or environment access.
// The spec MEASURES (durable rows through the session-filtered verifier, the
// client's retained buffer, the client's remaining-work list); this module
// DECIDES what the measurements prove. A missing measurement is a failed
// check with the absence named — never a pass, never a skip.
//
// The expectations are the RUN's, computed by the spec from the persona
// fixture's beat templates and the run's recorded variation draw (design
// §3.3) — never copied from the corpus script's numbers and never read back
// from the product's own output.

const { logCleanedColumns } = require('../../../config/columns');
const { deriveExpectedRemaining } = require('./rehearsal-scorecard');

const nameKey = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[-\s]+/g, ' ');
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

// One comparable set shape across every surface: the declaration the spec
// computes, the client's retained buffer, and the durable rows.
//   { key, exercise, lift_code, weight, reps, rir }
function declaredSet(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    key: nameKey(o.exercise),
    exercise: String(o.exercise || ''),
    lift_code: String(o.lift_code || '').trim().toUpperCase(),
    weight: num(o.weight),
    reps: num(o.reps),
    rir: num(o.rir),
  };
}

function durableRowSet(row) {
  const r = Array.isArray(row) ? row : [];
  const at = (name) => r[logCleanedColumns.indexOf(name)];
  return {
    key: nameKey(at('canonical_exercise') || at('exercise')),
    exercise: String(at('canonical_exercise') || at('exercise') || ''),
    lift_code: String(at('lift_code') || '').trim().toUpperCase(),
    weight: num(at('weight')),
    reps: num(at('reps')),
    rir: num(at('rir')),
  };
}

const setTuple = (s) => `${s.key}|${s.lift_code}|${s.weight}|${s.reps}|${s.rir}`;
const setLabel = (s) => `${s.exercise || s.key} ${s.weight}x${s.reps}@${s.rir}`;

// Multiset comparison with named differences — counts alone cannot prove the
// declared workout (the same rule the scorecard's durable comparison lives by).
function compareSetMultisets(observed, expected) {
  const remaining = (Array.isArray(expected) ? expected : []).map(setTuple);
  const unmatched = [];
  for (const s of (Array.isArray(observed) ? observed : [])) {
    const t = setTuple(s);
    const i = remaining.indexOf(t);
    if (i >= 0) remaining.splice(i, 1);
    else unmatched.push(setLabel(s));
  }
  const missing = [];
  const pool = (Array.isArray(expected) ? expected : []).map((s) => ({ s, t: setTuple(s) }));
  for (const t of remaining) {
    const hit = pool.find((p) => p.t === t);
    if (hit) { missing.push(setLabel(hit.s)); pool.splice(pool.indexOf(hit), 1); }
  }
  return { ok: unmatched.length === 0 && missing.length === 0, unmatched, missing };
}

// The checks. Input:
//   fixture           — the loaded persona fixture (plan + facts declarations)
//   expectedSets      — the run's computed durable declaration (declaredSet inputs)
//   loggedNames       — one exercise name per set the driver logged this run
//   bufferSets        — the retained buffer's sets AFTER the correction beat
//                       (declaredSet inputs), or null when unmeasured
//   durableLogRows    — raw Log_Cleaned rows for THIS session only (arrays)
//   observedRemaining — the client's remaining-work names at the final probe,
//                       or null when unmeasured
function checkPersonaFacts(input) {
  const i = input && typeof input === 'object' ? input : {};
  const fixture = i.fixture && typeof i.fixture === 'object' ? i.fixture : {};
  const facts = fixture.facts && typeof fixture.facts === 'object' ? fixture.facts : {};
  const expected = (Array.isArray(i.expectedSets) ? i.expectedSets : []).map(declaredSet);
  const durable = (Array.isArray(i.durableLogRows) ? i.durableLogRows : []).map(durableRowSet);
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: ok === true, detail: detail || '' });

  // ── Parsed-set equality: the durable rows ARE the declared sets ────────────
  const eq = compareSetMultisets(durable, expected);
  add('persona-parsed-set-equality', eq.ok,
    eq.ok
      ? `${durable.length} durable Log_Cleaned rows equal the run's declared sets, one-for-one on exercise/weight/reps/RIR`
      : `undeclared durable rows: [${eq.unmatched.join('; ') || 'none'}]; declared sets with no durable row: [${eq.missing.join('; ') || 'none'}]`);

  // ── Correction end-states (the Slice-1 correction goldens, end-to-end) ─────
  // For each declared correction: the durable rows for that lift are EXACTLY
  // the corrected sets, and no row OF THAT LIFT carries the fat-fingered
  // weight. The scan is scoped to the lift, deliberately: another lift may
  // legitimately use the same number (Marcus's squat back-offs ARE 285 in
  // the unrevised draw — the same 285 that is forbidden on his RDL), and a
  // session-wide ban would fail a correct run on a coincidence.
  const corrections = Array.isArray(facts.correctionEndStates) ? facts.correctionEndStates : [];
  if (!corrections.length) {
    add('persona-correction-end-state', false,
      'the fixture declares no correctionEndStates — a persona with a correction beat must declare its end-state');
  }
  for (const c of corrections) {
    const lift = String(c.lift_code || '').trim().toUpperCase();
    const rows = durable.filter((s) => s.lift_code === lift);
    const want = { weight: num(c.weight), reps: num(c.reps), rir: num(c.rir) };
    const problems = [];
    if (rows.length !== num(c.sets)) problems.push(`${rows.length} durable ${lift} row(s), declared ${c.sets}`);
    const off = rows.filter((s) => s.weight !== want.weight || s.reps !== want.reps || s.rir !== want.rir);
    if (off.length) problems.push(`${off.length} ${lift} row(s) off the corrected end-state: ${off.map(setLabel).join('; ')}`);
    if (c.forbiddenWeight !== undefined && c.forbiddenWeight !== null) {
      const bad = rows.filter((s) => s.weight === num(c.forbiddenWeight));
      if (bad.length) problems.push(`the forbidden weight ${c.forbiddenWeight} survives in ${bad.length} durable ${lift} row(s): ${bad.map(setLabel).join('; ')}`);
    }
    add(`persona-correction-end-state:${lift}`, problems.length === 0,
      problems.length === 0
        ? `${lift} durable rows read ${want.weight}x${want.reps}@${want.rir} x${c.sets} — the corrected end-state, with no ${lift} row at ${c.forbiddenWeight}`
        : problems.join('; '));
  }

  // ── The retained buffer carries the correction BEFORE any save ─────────────
  // The durable rows could in principle be repaired at write time; the script's
  // promise is stronger — the athlete's own session state is corrected the
  // moment the correction is accepted. Measured from the client's session log
  // after the correction beat, compared against the same declaration.
  if (!Array.isArray(i.bufferSets)) {
    add('persona-retained-buffer-corrected', false,
      'no retained-buffer measurement was recorded — the correction\'s in-session end-state is unproven');
  } else {
    const buf = compareSetMultisets(i.bufferSets.map(declaredSet), expected);
    add('persona-retained-buffer-corrected', buf.ok,
      buf.ok
        ? 'the retained buffer after the correction equals the declared sets (corrected weight in place, every other lift untouched)'
        : `buffer sets not in the declaration: [${buf.unmatched.join('; ') || 'none'}]; declared sets missing from the buffer: [${buf.missing.join('; ') || 'none'}]`);
  }

  // ── Plan-state facts: the fixture's declared end-state of the plan ─────────
  // Three-way: the fixture's facts declaration, the expectation DERIVED from
  // the plan + the sets logged this run (the scorecard's own derivation), and
  // the client's observed remaining work. The declaration and the derivation
  // must agree (authoring consistency), and the client must agree with both
  // (product truth).
  const declared = facts.planState && typeof facts.planState === 'object' ? facts.planState : null;
  if (!declared || !Array.isArray(declared.remainingExercises)) {
    add('persona-plan-state-facts', false, 'the fixture declares no facts.planState.remainingExercises to judge against');
  } else if (!Array.isArray(i.observedRemaining)) {
    add('persona-plan-state-facts', false, 'no remaining-work observation was recorded — the plan end-state is unproven');
  } else {
    const derived = deriveExpectedRemaining({
      plan: Array.isArray(fixture.plan) ? fixture.plan : [],
      loggedNames: Array.isArray(i.loggedNames) ? i.loggedNames : [],
      replacement: null,
    });
    const problems = [];
    const sameList = (a, b) => a.length === b.length && a.every((v, ix) => nameKey(v) === nameKey(b[ix]));
    if (!sameList(derived.remaining.map(nameKey), declared.remainingExercises.map(nameKey))) {
      problems.push(`the derived remaining [${derived.remaining.join(', ')}] disagrees with the fixture's declared remaining [${declared.remainingExercises.join(', ')}]`);
    }
    if (!sameList(i.observedRemaining.map(nameKey), derived.remaining.map(nameKey))) {
      problems.push(`the client reports remaining [${i.observedRemaining.join(', ')}]; the declaration derives [${derived.remaining.join(', ')}]`);
    }
    if (Array.isArray(declared.completedExercises)) {
      if (!sameList(derived.complete.map(nameKey), declared.completedExercises.map(nameKey))) {
        problems.push(`the derived completed [${derived.complete.join(', ')}] disagrees with the fixture's declared completed [${declared.completedExercises.join(', ')}]`);
      }
    }
    add('persona-plan-state-facts', problems.length === 0,
      problems.length === 0
        ? `remaining work after the final turn is [${derived.remaining.join(', ') || 'none'}] — fixture declaration, derivation, and client state agree`
        : problems.join('; '));
  }

  return { ok: checks.every((c) => c.ok), checks };
}

module.exports = { checkPersonaFacts, compareSetMultisets, declaredSet, durableRowSet, nameKey };
